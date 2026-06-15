import { describe, expect, test } from "bun:test";
import type { Finding, PriorFindingState, PriorReviewState, ReviewSummary } from "../src/index.ts";
import {
  classifyReReviewFindings,
  createReReviewSummary,
  formatReviewSummaryMarkdown,
  isReReviewConverged,
  loadReviewFixture,
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
    expect(markdown).toContain("Fixed prior findings: 1");
    expect(markdown).toContain("`fnd_fixed`");
  });

  test("summary markdown renders withheld counts and IDs (withheld finding surfaces, not silently absent)", () => {
    // fnd_fixed is withheld this run (not resolved) → it must show as withheld, not fixed,
    // and the count must render so the section isn't misleading (the finding-1 fix).
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, priorState, new Set(["fnd_fixed"]));
    const markdown = formatReviewSummaryMarkdown({ ...summary, reReview });

    expect(markdown).toContain("### Re-review status");
    expect(markdown).toContain("Fixed prior findings: 0");
    expect(markdown).toContain("Withheld prior findings: 1");
    expect(markdown).toContain("Withheld IDs: `fnd_fixed`");
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
