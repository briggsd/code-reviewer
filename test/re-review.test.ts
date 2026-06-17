import { describe, expect, test } from "bun:test";
import type {
  Finding,
  PriorFindingState,
  PriorReviewState,
  ReviewSummary,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
} from "../src/index.ts";
import {
  buildResolvedLog,
  classifyReReviewFindings,
  createPriorReviewStateFromMetadata,
  createPublishHiddenMetadata,
  createReReviewSummary,
  formatReviewSummaryMarkdown,
  isReReviewConverged,
  loadReviewFixture,
  parseResolvedLog,
  parseSummaryHiddenMetadata,
  runReview,
} from "../src/index.ts";

const recurringFinding: Finding = {
  id: "fnd_recurring",
  reviewer: "security",
  severity: "critical",
  category: "auth",
  title: "Account lookup misses authorization",
  body: "The endpoint still misses an ownership check.",
  location: {
    path: "auth/accounts.ts",
    line: 23,
    side: "RIGHT",
  },
  confidence: "high",
  evidence: ["The patch still returns account data without ownership verification."],
  recommendation: "Check account ownership before returning account data.",
};

const newFinding: Finding = {
  id: "fnd_new",
  reviewer: "code_quality",
  severity: "warning",
  category: "correctness",
  title: "Missing null handling",
  body: "The endpoint does not handle missing account IDs.",
  confidence: "medium",
  evidence: ["accountId is read without a presence check."],
  recommendation: "Return a validation error when accountId is missing.",
};

class RecordingTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];

  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<TelemetryFlushResult> {
    return { deliveredCount: this.events.length, failedCount: 0, droppedCount: 0, pendingCount: 0 };
  }

  async close(): Promise<TelemetryFlushResult> {
    return this.flush();
  }
}

const priorState: PriorReviewState = {
  previousRunId: "prior-run",
  previousHeadSha: "old-head",
  findings: [
    {
      stableId: "fnd_recurring",
      finding: recurringFinding,
      status: "open",
      lastSeenHeadSha: "old-head",
    },
    {
      stableId: "fnd_fixed",
      finding: {
        ...recurringFinding,
        id: "fnd_fixed",
        title: "Fixed prior issue",
      },
      status: "open",
      lastSeenHeadSha: "old-head",
    },
  ],
};

describe("re-review finding classification", () => {
  test("classifies current findings as new/recurring and prior missing findings as fixed", () => {
    const summary = createSummary([recurringFinding, newFinding]);
    const reReview = createReReviewSummary(summary, priorState);

    expect(reReview.newFindingIds).toEqual(["fnd_new"]);
    expect(reReview.recurringFindingIds).toEqual(["fnd_recurring"]);
    expect(reReview.fixedFindingIds).toEqual(["fnd_fixed"]);
    expect(reReview.convergence).toEqual({
      maxRecurrenceDepth: 2,
      flappingFindingCount: 0,
      currentFindingCount: 2,
      recurrenceDepths: {
        fnd_new: 1,
        fnd_recurring: 2,
      },
    });
    expect(reReview.classifications.map((classification) => classification.status)).toEqual([
      "new",
      "recurring",
      "fixed",
    ]);
    expect(
      reReview.classifications.find((classification) => classification.stableId === "fnd_recurring")
        ?.lastSeenHeadSha,
    ).toBe("old-head");
  });

  test("runner attaches re-review classification when prior state is present", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const currentFinding = fixture.fakeFindings?.[0];
    if (currentFinding === undefined) {
      throw new Error("expected fixture finding");
    }

    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    const secondRun = await runReview({
      fixture: {
        ...fixture,
        priorState: {
          previousRunId: "prior-run",
          previousHeadSha: "old-head",
          findings: [
            {
              stableId,
              finding: { ...currentFinding, id: stableId },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
            {
              stableId: "fnd_fixed_prior",
              finding: { ...currentFinding, id: "fnd_fixed_prior", title: "Prior fixed finding" },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
          ],
        },
      },
      now: new Date("2026-06-09T00:00:01.000Z"),
    });

    expect(secondRun.context.priorState?.previousRunId).toBe("prior-run");
    expect(secondRun.summary.reReview?.newFindingIds).toEqual([]);
    expect(secondRun.summary.reReview?.recurringFindingIds).toEqual([stableId]);
    expect(secondRun.summary.reReview?.fixedFindingIds).toEqual(["fnd_fixed_prior"]);
  });

  test("re-review fixture demonstrates recurring and fixed prior findings", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/re-review-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(result.context.priorState?.previousRunId).toBe("fixture-auth-pr");
    expect(result.summary.reReview?.newFindingIds).toEqual([]);
    expect(result.summary.reReview?.recurringFindingIds).toEqual(["fnd_fixture_recurring_auth"]);
    expect(result.summary.reReview?.fixedFindingIds).toEqual(["fnd_fixture_fixed_null_check"]);
  });

  test("recurrence depth increments from persisted metadata and legacy recurring findings fall back to depth 2", () => {
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, {
      ...priorState,
      findings: [
        {
          ...(priorState.findings[0] as PriorFindingState),
          recurrenceDepth: 3,
        },
      ],
    });

    if (reReview.convergence === undefined) {
      throw new Error("expected convergence metrics");
    }
    expect(reReview.convergence.maxRecurrenceDepth).toBe(4);
    expect(reReview.convergence.recurrenceDepths.fnd_recurring).toBe(4);

    const legacy = createReReviewSummary(summary, {
      ...priorState,
      findings: [priorState.findings[0] as PriorFindingState],
    });
    if (legacy.convergence === undefined) {
      throw new Error("expected legacy convergence metrics");
    }
    expect(legacy.convergence.recurrenceDepths.fnd_recurring).toBe(2);
  });

  test("3-round fixture counts a finding that resolves then reappears as flapping", async () => {
    const telemetrySink = new RecordingTelemetrySink();
    const round3 = await runReview({
      fixture: await loadReviewFixture("examples/fixtures/convergence-flap-pr.json"),
      now: new Date("2026-06-09T00:00:02.000Z"),
      telemetrySink,
    });

    expect(round3.summary.reReview?.newFindingIds).toEqual(["fnd_fixture_flapping_auth"]);
    expect(round3.summary.reReview?.convergence).toEqual({
      maxRecurrenceDepth: 1,
      flappingFindingCount: 1,
      currentFindingCount: 1,
      recurrenceDepths: {
        fnd_fixture_flapping_auth: 1,
      },
    });

    const metrics = telemetrySink.events.find((event) => event.type === "ai_review.run_metrics");
    const convergence = metrics?.data?.convergence as
      | {
          maxRecurrenceDepth: number;
          flappingFindingCount: number;
          currentFindingCount: number;
          recurrenceDepths?: unknown;
        }
      | undefined;
    expect(convergence).toEqual({
      maxRecurrenceDepth: 1,
      flappingFindingCount: 1,
      currentFindingCount: 1,
    });
    expect(convergence?.recurrenceDepths).toBeUndefined();
  });

  test("recurrence depths persist through hidden metadata across review rounds", () => {
    const round2Summary = {
      ...createSummary([recurringFinding]),
      reReview: createReReviewSummary(createSummary([recurringFinding]), {
        ...priorState,
        findings: [
          {
            ...(priorState.findings[0] as PriorFindingState),
            recurrenceDepth: 1,
          },
        ],
      }),
    };
    const metadata = createPublishHiddenMetadata(
      "round-2",
      {
        provider: "github",
        repository: {
          provider: "github",
          owner: "example",
          name: "payments-api",
          slug: "example/payments-api",
        },
        changeId: "17",
        headSha: "round-2-head",
        title: "Round 2",
        author: { username: "contributor" },
        labels: [],
      },
      round2Summary,
    );

    const parsed = parseSummaryHiddenMetadata(
      ["<!-- ai-code-review-factory", JSON.stringify(metadata), "-->"].join("\n"),
    );
    if (parsed === undefined) {
      throw new Error("expected metadata to parse");
    }
    expect(parsed.recurrenceDepths).toEqual({ fnd_recurring: 2 });

    const restored = createPriorReviewStateFromMetadata(parsed, {
      provider: "github",
      repository: {
        provider: "github",
        owner: "example",
        name: "payments-api",
        slug: "example/payments-api",
      },
      changeId: "17",
      headSha: "round-3-head",
    });
    expect(restored.findings[0]?.recurrenceDepth).toBe(2);
  });

  test("omits empty zero-count re-review state", () => {
    const summary = classifyReReviewFindings(createSummary([]), {
      previousRunId: "prior-empty-run",
      previousHeadSha: "old-head",
      findings: [],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(summary.reReview).toBeUndefined();
    expect(markdown).not.toContain("### Re-review status");
  });

  test("summary markdown renders re-review counts and fixed IDs", () => {
    const markdown = formatReviewSummaryMarkdown({
      ...createSummary([recurringFinding]),
      reReview: createReReviewSummary(createSummary([recurringFinding]), priorState),
    });

    expect(markdown).toContain("### Re-review status");
    expect(markdown).toContain("New findings: 0");
    expect(markdown).toContain("Recurring findings: 1");
    expect(markdown).toContain("Fixed this round: 1");
    // New readable format: title + 7-char sha (priorState.findings[1].title = "Fixed prior issue", sha = "old-head" → "old-hea")
    expect(markdown).toContain("✅ Fixed prior issue — last seen `old-hea`");
    // Old opaque ID format must NOT appear
    expect(markdown).not.toContain("Fixed IDs:");
  });

  test("summary markdown renders withheld counts and IDs (withheld finding surfaces, not silently absent)", () => {
    // fnd_fixed is withheld this run (not resolved) → it must show as withheld, not fixed,
    // and the count must render so the section isn't misleading (the finding-1 fix).
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, priorState, new Set(["fnd_fixed"]));
    const markdown = formatReviewSummaryMarkdown({ ...summary, reReview });

    expect(markdown).toContain("### Re-review status");
    expect(markdown).toContain("Fixed this round: 0");
    expect(markdown).toContain("Withheld this round: 1");
    // New readable format: title + 7-char sha
    expect(markdown).toContain("Fixed prior issue — withheld, last seen `old-hea`");
    // Old opaque ID format must NOT appear
    expect(markdown).not.toContain("Withheld IDs:");
  });

  test("withheld: prior finding in withheldStableIds goes to withheldFindingIds, not fixedFindingIds", () => {
    // fnd_fixed is absent from current summary; passing it as withheld should route it to withheld
    const summary = createSummary([recurringFinding]);
    const withheldStableIds = new Set(["fnd_fixed"]);
    const reReview = createReReviewSummary(summary, priorState, withheldStableIds);

    expect(reReview.withheldFindingIds).toEqual(["fnd_fixed"]);
    expect(reReview.fixedFindingIds).toEqual([]);
    const withheldClassification = reReview.classifications.find((c) => c.stableId === "fnd_fixed");
    expect(withheldClassification?.status).toBe("withheld");
    expect(withheldClassification?.priorFinding).toBeDefined();
    expect(withheldClassification?.lastSeenHeadSha).toBe("old-head");
  });

  test("withheld: prior finding absent from current AND absent from withheldStableIds stays in fixedFindingIds (regression guard)", () => {
    // fnd_fixed is absent from current summary; NOT in withheldStableIds → must still be fixed
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, priorState, new Set<string>());

    expect(reReview.fixedFindingIds).toEqual(["fnd_fixed"]);
    expect(reReview.withheldFindingIds).toEqual([]);
    const fixedClassification = reReview.classifications.find((c) => c.stableId === "fnd_fixed");
    expect(fixedClassification?.status).toBe("fixed");
  });

  test("withheld: no third arg → withheldFindingIds is empty and fixedFindingIds unchanged (back-compat)", () => {
    // Calling without the optional third parameter must behave exactly as before the change
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, priorState);

    expect(reReview.withheldFindingIds).toEqual([]);
    expect(reReview.fixedFindingIds).toEqual(["fnd_fixed"]);
  });

  test("withheld: hasVisibleReReviewState becomes true when only withheldFindingIds is non-empty", () => {
    // A summary with NO new/recurring/fixed but with withheld findings should still attach reReview
    const emptyPrior: PriorReviewState = {
      previousRunId: "prior-run",
      previousHeadSha: "old-head",
      findings: [
        {
          stableId: "fnd_withheld_only",
          finding: { ...recurringFinding, id: "fnd_withheld_only" },
          status: "open",
          lastSeenHeadSha: "old-head",
        },
      ],
    };
    // Current summary has NO findings → fnd_withheld_only absent from current
    // withheldStableIds contains it → should be withheld not fixed
    const summary = createSummary([]);
    const withheldStableIds = new Set(["fnd_withheld_only"]);
    const result = classifyReReviewFindings(summary, emptyPrior, withheldStableIds);

    expect(result.reReview).toBeDefined();
    expect(result.reReview?.withheldFindingIds).toEqual(["fnd_withheld_only"]);
    expect(result.reReview?.fixedFindingIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Convergence gate (#149 — Tier 1): runReview.converged detection
// ---------------------------------------------------------------------------
describe("convergence gate (#149)", () => {
  test("converged = true when re-review has 0 new + 0 fixed (stable finding set)", async () => {
    // Build a run where the sole finding already existed in prior state → it's recurring,
    // nothing is new or fixed → converged.
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    const secondRun = await runReview({
      fixture: {
        ...fixture,
        priorState: {
          previousRunId: "prior-run",
          previousHeadSha: "old-head",
          // Only the recurring finding in prior state — no fixed/new delta.
          findings: [
            {
              stableId,
              finding: { ...(firstRun.summary.findings[0] as Finding), id: stableId },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
          ],
        },
      },
      now: new Date("2026-06-09T00:00:01.000Z"),
    });

    expect(secondRun.summary.reReview?.newFindingIds).toEqual([]);
    expect(secondRun.summary.reReview?.fixedFindingIds).toEqual([]);
    expect(secondRun.summary.reReview?.recurringFindingIds).toEqual([stableId]);
    // THE key assertion: converged must be true when nothing changed.
    expect(secondRun.converged).toBe(true);
  });

  test("THE REGRESSION: new finding present → converged = false (new finding is NEVER suppressed)", async () => {
    // This is the completeness guard from the spec: a genuinely-new finding on a re-push
    // must NOT be converged, so the summary re-post still happens.
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    const secondRun = await runReview({
      fixture: {
        ...fixture,
        priorState: {
          previousRunId: "prior-run",
          previousHeadSha: "old-head",
          // Prior state has a DIFFERENT finding (not in current summary) → it will be
          // "fixed" in this run, making newFindingIds=[stableId], fixedFindingIds=["fnd_was_fixed"].
          findings: [
            {
              stableId: "fnd_was_fixed",
              finding: {
                ...(firstRun.summary.findings[0] as Finding),
                id: "fnd_was_fixed",
                title: "A prior finding that got fixed",
              },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
          ],
        },
      },
      now: new Date("2026-06-09T00:00:01.000Z"),
    });

    // stableId is new (not in prior), "fnd_was_fixed" is fixed (not in current).
    expect(secondRun.summary.reReview?.newFindingIds).toEqual([stableId]);
    expect(secondRun.summary.reReview?.fixedFindingIds).toEqual(["fnd_was_fixed"]);
    // THE core safety test: converged must be false when there are new/fixed findings.
    expect(secondRun.converged).toBe(false);
  });

  test("fixed-only change → converged = false (delta is non-empty)", async () => {
    // A prior finding that got fixed (no new ones): fixedFindingIds non-empty → not converged.
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    // Second run has same recurring finding + a prior finding that disappeared (fixed).
    const secondRun = await runReview({
      fixture: {
        ...fixture,
        priorState: {
          previousRunId: "prior-run",
          previousHeadSha: "old-head",
          findings: [
            {
              stableId,
              finding: { ...(firstRun.summary.findings[0] as Finding), id: stableId },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
            {
              stableId: "fnd_now_fixed",
              finding: {
                ...(firstRun.summary.findings[0] as Finding),
                id: "fnd_now_fixed",
                title: "About to be fixed",
              },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
          ],
        },
      },
      now: new Date("2026-06-09T00:00:01.000Z"),
    });

    expect(secondRun.summary.reReview?.newFindingIds).toEqual([]);
    expect(secondRun.summary.reReview?.fixedFindingIds).toEqual(["fnd_now_fixed"]);
    expect(secondRun.converged).toBe(false);
  });

  test("withheld-only change → converged = false (recurring→withheld changes the published summary)", async () => {
    // A re-review where 0 new + 0 fixed but ≥1 withheld (a prior recurring finding is
    // now withheld because evidence grounding dropped it). The published summary changes
    // (finding moves from Recurring block to Withheld block) so converged must be false.
    // This test uses withheldStableIds to simulate a grounding-drop: we pass the
    // recurring finding's stableId as withheld, so classifyReReviewFindings routes it to
    // withheldFindingIds instead of fixedFindingIds.
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    // Prior state with the recurring finding plus one extra prior finding that the current
    // run no longer produces. Routing that extra finding through withheldStableIds (the
    // grounding-drop mechanism) lands it in withheldFindingIds rather than fixedFindingIds.
    const priorStateWithExtra: PriorReviewState = {
      previousRunId: "prior-run",
      previousHeadSha: "old-head",
      findings: [
        {
          stableId,
          finding: { ...(firstRun.summary.findings[0] as Finding), id: stableId },
          status: "open",
          lastSeenHeadSha: "old-head",
        },
        {
          stableId: "fnd_prior_withheld",
          finding: {
            ...(firstRun.summary.findings[0] as Finding),
            id: "fnd_prior_withheld",
            title: "A prior finding now withheld by grounding",
          },
          status: "open",
          lastSeenHeadSha: "old-head",
        },
      ],
    };

    // WITH the withheld finding: 0 new, 0 fixed, 1 withheld → must NOT be converged
    // (the published summary changed — the finding moved to the Withheld block).
    const reReviewWithWithheld = createReReviewSummary(
      firstRun.summary,
      priorStateWithExtra,
      new Set(["fnd_prior_withheld"]),
    );
    expect(reReviewWithWithheld.newFindingIds).toEqual([]);
    expect(reReviewWithWithheld.fixedFindingIds).toEqual([]);
    expect(reReviewWithWithheld.withheldFindingIds).toEqual(["fnd_prior_withheld"]);
    // Assert against the REAL shared predicate (not an inline recompute) so a regression
    // that drops the withheld clause from isReReviewConverged is caught here.
    expect(isReReviewConverged(reReviewWithWithheld)).toBe(false);

    // Control: same prior set MINUS the withheld extra → 0 new, 0 fixed, 0 withheld →
    // converged. Proves the withheld clause is the load-bearing difference above.
    const priorStateRecurringOnly: PriorReviewState = {
      ...priorStateWithExtra,
      findings: [priorStateWithExtra.findings[0] as PriorFindingState],
    };
    const reReviewRecurringOnly = createReReviewSummary(firstRun.summary, priorStateRecurringOnly);
    expect(isReReviewConverged(reReviewRecurringOnly)).toBe(true);
  });

  test("first review (no prior state) → converged = false (never suppress the first post)", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    // No prior state → no reReview delta → not converged.
    expect(result.summary.reReview).toBeUndefined();
    expect(result.converged).toBe(false);
  });

  test("CI status path is independent of converged: same outcome regardless", async () => {
    // Verify that converged does NOT change the summary.decision / summary.outcome.
    // Both a converged run and a non-converged run must carry the same decision/outcome
    // (convergence only affects the re-post; CI status is driven by decideCiOutcome which reads
    // summary.findings, not summary.converged or result.converged).
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    const convergedRun = await runReview({
      fixture: {
        ...fixture,
        priorState: {
          previousRunId: "prior-run",
          previousHeadSha: "old-head",
          findings: [
            {
              stableId,
              finding: { ...(firstRun.summary.findings[0] as Finding), id: stableId },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
          ],
        },
      },
      now: new Date("2026-06-09T00:00:01.000Z"),
    });

    expect(convergedRun.converged).toBe(true);
    // The summary decision and outcome are the same regardless of convergence.
    expect(convergedRun.summary.decision).toBe(firstRun.summary.decision);
    expect(convergedRun.summary.outcome).toBe(firstRun.summary.outcome);
    // findings are still present — CI gate still sees them.
    expect(convergedRun.summary.findings).toHaveLength(firstRun.summary.findings.length);
  });
});

function createSummary(findings: Finding[]): ReviewSummary {
  return {
    decision: "significant_concerns",
    outcome: "fail",
    title: "AI review found issues",
    body: "Review body",
    findings,
    risk: {
      tier: "full",
      reason: "Sensitive auth change.",
      matchedRules: ["sensitive_paths"],
      sensitivePaths: ["auth/accounts.ts"],
      reviewedFileCount: 1,
      ignoredFileCount: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-round resolved-log accumulation (#279, M026 S02)
// ---------------------------------------------------------------------------

describe("resolvedLog accumulation — parseResolvedLog + buildResolvedLog", () => {
  // --- parseResolvedLog defensive parse ---

  test("parseResolvedLog: returns empty array for non-array input", () => {
    expect(parseResolvedLog(undefined)).toEqual([]);
    expect(parseResolvedLog(null)).toEqual([]);
    expect(parseResolvedLog("string")).toEqual([]);
    expect(parseResolvedLog(42)).toEqual([]);
    expect(parseResolvedLog({})).toEqual([]);
  });

  test("parseResolvedLog: accepts valid entries and drops malformed ones", () => {
    const raw = [
      // valid
      { stableId: "fnd_a", title: "Issue A", resolvedAtSha: "abc1234" },
      // missing stableId
      { title: "No id", resolvedAtSha: "abc1234" },
      // empty title
      { stableId: "fnd_b", title: "", resolvedAtSha: "abc1234" },
      // sha too long (> 64)
      { stableId: "fnd_c", title: "Issue C", resolvedAtSha: "x".repeat(65) },
      // null entry
      null,
      // non-object entry
      "string",
      // another valid
      { stableId: "fnd_d", title: "Issue D", resolvedAtSha: "def5678" },
    ];
    const result = parseResolvedLog(raw);
    expect(result).toEqual([
      { stableId: "fnd_a", title: "Issue A", resolvedAtSha: "abc1234" },
      { stableId: "fnd_d", title: "Issue D", resolvedAtSha: "def5678" },
    ]);
  });

  test("parseResolvedLog: drops entries with over-long fields", () => {
    const raw = [
      { stableId: "x".repeat(257), title: "t", resolvedAtSha: "abc1234" }, // stableId > 256
      { stableId: "fnd_x", title: "t".repeat(201), resolvedAtSha: "abc1234" }, // title > 200
    ];
    expect(parseResolvedLog(raw)).toEqual([]);
  });

  test("parseResolvedLog: never throws on adversarial input", () => {
    // These should all parse defensively without throwing
    expect(() =>
      parseResolvedLog([{ stableId: null, title: null, resolvedAtSha: null }]),
    ).not.toThrow();
    expect(() => parseResolvedLog([new Error("bad")])).not.toThrow();
    expect(() => parseResolvedLog([{ stableId: {}, title: [], resolvedAtSha: 42 }])).not.toThrow();
    expect(parseResolvedLog([{ stableId: null, title: null, resolvedAtSha: null }])).toEqual([]);
  });

  // --- buildResolvedLog accumulation ---

  test("buildResolvedLog: returns undefined when no prior log and no fixed classifications", () => {
    const result = buildResolvedLog(undefined, [], "abc1234");
    expect(result).toBeUndefined();
  });

  test("buildResolvedLog: newly-fixed classifications appear in log with current headSha", () => {
    const classifications = [
      {
        stableId: "fnd_fixed",
        status: "fixed" as const,
        priorFinding: {
          ...recurringFinding,
          id: "fnd_fixed",
          title: "Fixed issue",
        },
        lastSeenHeadSha: "old-head",
      },
    ];
    const result = buildResolvedLog(undefined, classifications, "abc1234");
    expect(result).toBeDefined();
    expect(result?.truncated).toBe(false);
    expect(result?.entries).toEqual([
      { stableId: "fnd_fixed", title: "Fixed issue", resolvedAtSha: "abc1234" },
    ]);
  });

  test("buildResolvedLog: prior log entries are preserved and merged with new", () => {
    const priorHiddenMetadata = {
      resolvedLog: [{ stableId: "fnd_old", title: "Old issue", resolvedAtSha: "oldhash" }],
    };
    const classifications = [
      {
        stableId: "fnd_new_fixed",
        status: "fixed" as const,
        priorFinding: {
          ...recurringFinding,
          id: "fnd_new_fixed",
          title: "Newly fixed issue",
        },
        lastSeenHeadSha: "old-head",
      },
    ];
    const result = buildResolvedLog(priorHiddenMetadata, classifications, "newsha7");
    expect(result?.truncated).toBe(false);
    expect(result?.entries).toEqual([
      // prior comes first
      { stableId: "fnd_old", title: "Old issue", resolvedAtSha: "oldhash" },
      // new resolution appended
      { stableId: "fnd_new_fixed", title: "Newly fixed issue", resolvedAtSha: "newsha7" },
    ]);
  });

  test("buildResolvedLog: dedup — first-resolution sha preserved when stableId already in prior log", () => {
    const priorHiddenMetadata = {
      resolvedLog: [{ stableId: "fnd_x", title: "Issue X", resolvedAtSha: "first_sha" }],
    };
    // Same stableId appears as newly-fixed again (e.g. reopened then fixed again)
    const classifications = [
      {
        stableId: "fnd_x",
        status: "fixed" as const,
        priorFinding: {
          ...recurringFinding,
          id: "fnd_x",
          title: "Issue X",
        },
        lastSeenHeadSha: "old-head",
      },
    ];
    const result = buildResolvedLog(priorHiddenMetadata, classifications, "second_sha");
    // Only one entry — first-resolution (oldhash) wins
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]?.resolvedAtSha).toBe("first_sha");
    expect(result?.truncated).toBe(false);
  });

  test("buildResolvedLog: caps at 50 entries — truncated=true, exactly-50 result", () => {
    // 49 prior entries + 2 newly-fixed = 51 → capped to last 50, truncated=true
    const priorLog = Array.from({ length: 49 }, (_, i) => ({
      stableId: `fnd_prior_${i}`,
      title: `Prior Issue ${i}`,
      resolvedAtSha: "oldhash",
    }));
    const classifications = [
      {
        stableId: "fnd_new_1",
        status: "fixed" as const,
        priorFinding: {
          ...recurringFinding,
          id: "fnd_new_1",
          title: "New Fixed 1",
        },
        lastSeenHeadSha: "old-head",
      },
      {
        stableId: "fnd_new_2",
        status: "fixed" as const,
        priorFinding: {
          ...recurringFinding,
          id: "fnd_new_2",
          title: "New Fixed 2",
        },
        lastSeenHeadSha: "old-head",
      },
    ];
    const result = buildResolvedLog({ resolvedLog: priorLog }, classifications, "newsha");
    expect(result?.entries).toHaveLength(50);
    expect(result?.truncated).toBe(true);
    // The cap keeps the last 50 — the first prior entry (fnd_prior_0) is dropped
    expect(result?.entries.find((e) => e.stableId === "fnd_prior_0")).toBeUndefined();
    // The newly-fixed entries are included (they're at the end)
    expect(result?.entries.find((e) => e.stableId === "fnd_new_1")).toBeDefined();
    expect(result?.entries.find((e) => e.stableId === "fnd_new_2")).toBeDefined();
  });

  test("buildResolvedLog: exactly 50 entries — truncated=false (not over cap)", () => {
    // 50 prior entries + 0 new = 50 → NOT truncated (merged.length === cap, not >)
    const priorLog = Array.from({ length: 50 }, (_, i) => ({
      stableId: `fnd_prior_${i}`,
      title: `Prior Issue ${i}`,
      resolvedAtSha: "oldhash",
    }));
    const result = buildResolvedLog({ resolvedLog: priorLog }, [], "newsha");
    expect(result?.entries).toHaveLength(50);
    expect(result?.truncated).toBe(false);
  });

  test("buildResolvedLog: malformed prior resolvedLog is safely dropped, new entries still accumulate", () => {
    // Simulate adversarial prior hidden metadata
    const priorHiddenMetadata = {
      resolvedLog: "not-an-array",
    };
    const classifications = [
      {
        stableId: "fnd_fixed",
        status: "fixed" as const,
        priorFinding: {
          ...recurringFinding,
          id: "fnd_fixed",
          title: "Fixed issue",
        },
        lastSeenHeadSha: "old-head",
      },
    ];
    const result = buildResolvedLog(priorHiddenMetadata, classifications, "abc1234");
    // Malformed prior dropped; new entry still accumulated
    expect(result?.truncated).toBe(false);
    expect(result?.entries).toEqual([
      { stableId: "fnd_fixed", title: "Fixed issue", resolvedAtSha: "abc1234" },
    ]);
  });

  // --- Integration: resolvedLog flows through runReview ---

  test("runReview accumulates resolvedLog when a prior finding is fixed", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    // Second run: prior state has a DIFFERENT finding that will be classified as "fixed"
    // (because it's not in the current summary). The prior hidden metadata has a resolvedLog
    // with an older resolution from a previous round.
    const secondRun = await runReview({
      fixture: {
        ...fixture,
        priorState: {
          previousRunId: "prior-run",
          previousHeadSha: "old-head",
          hiddenMetadata: {
            resolvedLog: [
              { stableId: "fnd_even_older", title: "Even older issue", resolvedAtSha: "aaa1111" },
            ],
          },
          findings: [
            {
              stableId: "fnd_prior_fixed",
              finding: {
                ...(firstRun.summary.findings[0] as Finding),
                id: "fnd_prior_fixed",
                title: "Prior finding that got fixed",
              },
              status: "open" as const,
              lastSeenHeadSha: "old-head",
            },
          ],
        },
      },
      now: new Date("2026-06-09T00:00:01.000Z"),
    });

    const log = secondRun.summary.resolvedLog;
    expect(log).toBeDefined();
    // Should contain the prior log entry (from hiddenMetadata) + the newly fixed one
    expect(log?.find((e) => e.stableId === "fnd_even_older")).toBeDefined();
    expect(log?.find((e) => e.stableId === "fnd_prior_fixed")).toBeDefined();
    // The newly-fixed one uses the current headSha (7-char short)
    const newEntry = log?.find((e) => e.stableId === "fnd_prior_fixed");
    expect(newEntry?.resolvedAtSha).toBe(fixture.metadata.headSha.slice(0, 7));
  });

  test("runReview: no resolvedLog when no prior state (first review)", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    // First review — no prior state → no resolvedLog
    expect(firstRun.summary.resolvedLog).toBeUndefined();
  });
});
