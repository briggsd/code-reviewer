import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentRuntime,
  CoordinatorRunInput,
  CoordinatorRunResult,
  Finding,
  PriorReviewState,
  ReviewerRunInput,
  ReviewerRunResult,
  RuntimeEvent,
  RuntimeEventSubscription,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TraceSink,
} from "../src/index.ts";
import {
  createStableFindingId,
  formatReviewSummaryMarkdown,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";
import { summarizeReview } from "../src/runner/run-review.ts";

// ---------------------------------------------------------------------------
// Minimal in-test sinks (mirrors state.test.ts pattern)
// ---------------------------------------------------------------------------

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

class RecordingTraceSink implements TraceSink {
  readonly events: RuntimeEvent[] = [];

  async write(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
  }

  async close(): Promise<void> {}
}

function createIncrementingClock(startIso: string): () => Date {
  const startMs = Date.parse(startIso);
  let tick = 0;
  return () => {
    const date = new Date(startMs + tick * 10);
    tick += 1;
    return date;
  };
}

// ---------------------------------------------------------------------------
// Fixture-based spine test
// ---------------------------------------------------------------------------

describe("evidence grounding spine integration", () => {
  test("grounding drops fabricated-quotedCode finding, keeps grounded finding, emits trace + telemetry", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // The auth-pr fixture patch contains:
    //   +  const accountId = req.query.accountId;
    //   +  return db.accounts.findById(accountId);
    // So "return db.accounts.findById(accountId);" IS in the diff (grounded).
    // "return db.accounts.deleteEverything();" is NOT in the diff (fabricated → dropped).

    const grounded: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Grounded finding",
      body: "body",
      confidence: "high",
      evidence: ["some evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.findById(accountId);"],
    };

    const fabricated: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "auth",
      title: "Fabricated finding",
      body: "body",
      confidence: "high",
      evidence: ["fabricated evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"],
    };

    // Self-guard: the grounded quote MUST exist in the fixture patch (and the fabricated one must
    // not), else this test would silently assert nothing if the fixture changes.
    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).toContain("return db.accounts.findById(accountId);");
    expect(fixturePatches).not.toContain("deleteEverything");

    // Override fakeFindings so the dummy runtime returns our two findings
    fixture.fakeFindings = [grounded, fabricated];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T00:00:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (a) fabricated is excluded, grounded is included
    expect(summary.findings.map((f) => f.title)).not.toContain("Fabricated finding");
    expect(summary.findings.map((f) => f.title)).toContain("Grounded finding");

    // (b) body contains the transparency note (#207: down-weight framing)
    expect(summary.body).toContain("finding(s) shown at low confidence (kept, non-blocking)");

    // (c) decision/outcome reflect survivors only
    // Only the grounded "warning" finding remains → decision is not "significant_concerns"
    // (which would require "critical"); it should be "approved_with_comments" (1 warning)
    expect(summary.decision).not.toBe("significant_concerns");
    expect(summary.decision).toBe("approved_with_comments");
    // The fixture config has mode: "blocking" + failOn: ["critical"], and critical is dropped
    // so outcome should be "pass" (no blocking finding remaining)
    expect(summary.outcome).toBe("pass");

    // (d) RecordingTelemetrySink run_metrics has data.grounding.droppedFindingCount === 1
    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    expect(
      (metrics?.data?.grounding as { droppedFindingCount: number } | undefined)
        ?.droppedFindingCount,
    ).toBe(1);

    // (e) RecordingTraceSink has a grounding.applied event with droppedFindingCount: 1
    const groundingEvent = traceSink.events.find((e) => e.type === "grounding.applied");
    expect(groundingEvent).toBeDefined();
    expect(groundingEvent?.data?.droppedFindingCount).toBe(1);
  });

  test("#214 full changed-file content grounds unchanged-region quote without leaking to context artifacts or telemetry", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();
    const fullContentOnlySentinel =
      "const fullFileOnlyOwnerGuard214 = await requireOwner(accountId);";

    const promotedCritical: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "auth",
      title: "Full-content grounded critical",
      body: "body",
      confidence: "high",
      evidence: ["full content evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: [fullContentOnlySentinel],
    };
    const fabricatedWarning: Finding = {
      reviewer: "code_quality",
      severity: "warning",
      category: "correctness",
      title: "Fabricated paired warning",
      body: "body",
      confidence: "high",
      evidence: ["fabricated evidence"],
      recommendation: "fix it too",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"],
    };

    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).not.toContain(fullContentOnlySentinel);
    expect(fixturePatches).not.toContain("deleteEverything");

    fixture.fakeFindings = [promotedCritical, fabricatedWarning];
    fixture.changedFileContents = {
      "auth/accounts.ts": [
        "export async function getAccount(req) {",
        fullContentOnlySentinel,
        "  const accountId = req.query.accountId;",
        "  return db.accounts.findById(accountId);",
        "}",
      ].join("\n"),
    };

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-14T00:30:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;
    expect(summary.findings.map((f) => f.title)).toContain("Full-content grounded critical");
    expect(summary.findings.map((f) => f.title)).not.toContain("Fabricated paired warning");
    expect(summary.groundingWithheld?.map((f) => f.title)).toContain("Fabricated paired warning");
    expect(summary.decision).toBe("significant_concerns");
    expect(summary.outcome).toBe("fail");

    const fullContentTrace = traceSink.events.find(
      (e) => e.type === "grounding.full_content_corpus",
    );
    expect(fullContentTrace).toBeDefined();
    expect(fullContentTrace?.data?.fullContentAvailableCount).toBe(1);
    expect(fullContentTrace?.data?.includedCount).toBe(1);

    const changeContextPath = result.context.contextArtifacts?.changeContextPath;
    expect(changeContextPath).toBeDefined();
    const changeContext = await readFile(
      join(result.context.workingDirectory, changeContextPath ?? ""),
      "utf8",
    );
    expect(changeContext).not.toContain(fullContentOnlySentinel);
    expect(JSON.stringify(traceSink.events)).not.toContain(fullContentOnlySentinel);
    expect(JSON.stringify(telemetrySink.events)).not.toContain(fullContentOnlySentinel);
  });

  test("#239 full-file corpus grounds real out-of-hunk code and withholds fabricated quotes without leaking text", async () => {
    const fixture = await loadReviewFixture("evals/fixtures/full-file-grounding-precision.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();
    const fullContentOnlySentinel = "const ownerScope = await loadOwnedProjects(userId);";
    const fabricatedQuote = "await transferAllPayrollWithoutApproval();";

    const groundedCritical: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "access_control",
      title: "Grounded out-of-hunk ownership scope",
      body: "The changed lookup now relies on an owner-scoped collection; reviewers may need to cite the unchanged owner-scope line to explain the access-control boundary.",
      confidence: "high",
      evidence: ["The owner-scope collection is built before the changed lookup."],
      recommendation: "Keep the active/project ownership invariant explicit near the lookup.",
      location: { path: "src/reports/project-report.ts" },
      quotedCode: [fullContentOnlySentinel],
    };
    const fabricatedCritical: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "access_control",
      title: "Fabricated payroll transfer",
      body: "This quote does not exist in the patch or changed-file content.",
      confidence: "high",
      evidence: ["Fabricated quote must be down-weighted."],
      recommendation: "Do not block on invented evidence.",
      location: { path: "src/reports/project-report.ts" },
      quotedCode: [fabricatedQuote],
    };

    expect(fixture.fakeFindings).toHaveLength(0);
    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).not.toContain(fullContentOnlySentinel);
    expect(fixturePatches).not.toContain(fabricatedQuote);
    expect(fixture.changedFileContents?.["src/reports/project-report.ts"]).toContain(
      fullContentOnlySentinel,
    );
    expect(fixture.changedFileContents?.["src/reports/project-report.ts"]).not.toContain(
      fabricatedQuote,
    );

    fixture.fakeFindings = [groundedCritical, fabricatedCritical];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-15T00:00:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;
    expect(summary.findings.map((f) => f.title)).toContain("Grounded out-of-hunk ownership scope");
    expect(summary.findings.map((f) => f.title)).not.toContain("Fabricated payroll transfer");
    expect(summary.groundingWithheld).toHaveLength(1);
    expect(summary.groundingWithheld?.[0]?.title).toBe("Fabricated payroll transfer");
    expect(summary.groundingWithheld?.[0]?.confidence).toBe("low");
    expect(summary.decision).toBe("significant_concerns");
    expect(summary.outcome).toBe("fail");

    const groundingTrace = traceSink.events.find((e) => e.type === "grounding.applied");
    expect(groundingTrace).toBeDefined();
    expect(groundingTrace?.data?.droppedFindingCount).toBe(1);

    const fullContentTrace = traceSink.events.find(
      (e) => e.type === "grounding.full_content_corpus",
    );
    expect(fullContentTrace).toBeDefined();
    const fullContentBytes = Buffer.byteLength(
      fixture.changedFileContents?.["src/reports/project-report.ts"] ?? "",
      "utf8",
    );
    const fullContentTraceData = fullContentTrace?.data;
    if (fullContentTraceData === undefined) {
      throw new Error("expected grounding.full_content_corpus trace data");
    }
    expect(Object.keys(fullContentTraceData).sort()).toEqual([
      "budgetBytes",
      "fullContentAvailableCount",
      "includedBytes",
      "includedCount",
      "skippedByBudgetCount",
    ]);
    expect(fullContentTraceData.fullContentAvailableCount).toBe(1);
    expect(fullContentTraceData.includedCount).toBe(1);
    expect(fullContentTraceData.skippedByBudgetCount).toBe(0);
    expect(fullContentTraceData.includedBytes).toBe(fullContentBytes);
    const budgetBytes = fullContentTraceData.budgetBytes;
    if (typeof budgetBytes !== "number") {
      throw new Error("expected numeric full-content grounding budget");
    }
    expect(budgetBytes).toBeGreaterThan(fullContentBytes);

    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    expect(
      (metrics?.data?.grounding as { droppedFindingCount: number } | undefined)
        ?.droppedFindingCount,
    ).toBe(1);

    const changeContextPath = result.context.contextArtifacts?.changeContextPath;
    expect(changeContextPath).toBeDefined();
    const changeContext = await readFile(
      join(result.context.workingDirectory, changeContextPath ?? ""),
      "utf8",
    );
    expect(changeContext).not.toContain(fullContentOnlySentinel);
    expect(changeContext).not.toContain(fabricatedQuote);
    expect(JSON.stringify(traceSink.events)).not.toContain(fullContentOnlySentinel);
    expect(JSON.stringify(traceSink.events)).not.toContain(fabricatedQuote);
    expect(JSON.stringify(telemetrySink.events)).not.toContain(fullContentOnlySentinel);
    expect(JSON.stringify(telemetrySink.events)).not.toContain(fabricatedQuote);
  });

  test("grounding is a no-op when all findings have no quotedCode (existing data stays unchanged)", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // fakeFindings in the fixture have no quotedCode → grounding must keep them all
    // Don't touch fixture.fakeFindings — use the fixture's own finding

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T00:01:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // Original fixture has 1 finding (critical, no quotedCode) → must be kept
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]?.title).toBe("Account lookup misses authorization");
    expect(summary.decision).toBe("significant_concerns");
    expect(summary.outcome).toBe("fail");

    // No grounding.applied trace event (grounding was a no-op)
    const groundingEvent = traceSink.events.find((e) => e.type === "grounding.applied");
    expect(groundingEvent).toBeUndefined();

    // Telemetry must NOT contain grounding field (no drops)
    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    expect(Object.hasOwn(metrics?.data ?? {}, "grounding")).toBe(false);
  });

  test("grounding-dropped finding from prior state is classified as withheld, not fixed", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // This finding will be DROPPED by grounding (quotedCode is fabricated, not in the diff).
    // We build the prior-state entry with the SAME reviewer/category/location so
    // createStableFindingId produces the same id for both.
    const droppedFinding: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "data_exposure",
      title: "Dropped finding — fabricated quote",
      body: "body",
      confidence: "high",
      evidence: ["fabricated evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"],
    };
    const droppedStableId = createStableFindingId(droppedFinding);

    // A second finding that will be KEPT (no quotedCode → grounding passes it through).
    const groundedFinding: Finding = {
      reviewer: "code_quality",
      severity: "warning",
      category: "correctness",
      title: "Grounded finding — kept",
      body: "body",
      confidence: "medium",
      evidence: ["evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
    };

    fixture.fakeFindings = [droppedFinding, groundedFinding];

    // Prior state contains the to-be-dropped finding so re-review can compare
    const priorState: PriorReviewState = {
      previousRunId: "prior-run",
      previousHeadSha: "old-head",
      findings: [
        {
          stableId: droppedStableId,
          finding: { ...droppedFinding, id: droppedStableId },
          status: "open",
          lastSeenHeadSha: "old-head",
        },
      ],
    };

    const result = await runReview({
      fixture: { ...fixture, priorState },
      clock: createIncrementingClock("2026-06-11T00:02:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (a) grounding dropped the fabricated finding
    const groundingTrace = traceSink.events.find((e) => e.type === "grounding.applied");
    expect(groundingTrace).toBeDefined();
    expect(groundingTrace?.data?.droppedFindingCount).toBe(1);

    // (b) dropped finding's prior-state entry is withheld, not fixed
    expect(summary.reReview?.withheldFindingIds).toContain(droppedStableId);
    expect(summary.reReview?.fixedFindingIds).not.toContain(droppedStableId);

    // (c) coordinator.completed trace carries withheldFindingCount
    const coordinatorTrace = traceSink.events.find((e) => e.type === "coordinator.completed");
    expect(coordinatorTrace).toBeDefined();
    expect(coordinatorTrace?.data?.withheldFindingCount).toBe(1);

    // (d) telemetry run_metrics carries withheldFindingCount
    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    expect(
      (metrics?.data?.reReview as { withheldFindingCount: number } | undefined)
        ?.withheldFindingCount,
    ).toBe(1);
  });

  test("all-withheld: summary has findings.length===0, groundingWithheld populated, title/outcome reflect 0 survivors, and markdown has no bare 'No findings.' (#204)", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // Both findings have fabricated quotedCode → both are dropped by grounding.
    const fabricated1: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "auth",
      title: "Fabricated critical",
      body: "body",
      confidence: "high",
      evidence: ["fabricated evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"],
    };
    const fabricated2: Finding = {
      reviewer: "code_quality",
      severity: "warning",
      category: "correctness",
      title: "Fabricated warning",
      body: "body",
      confidence: "medium",
      evidence: ["more fabricated evidence"],
      recommendation: "fix it too",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["db.dropTable('users');"],
    };

    // Self-guard: neither fabricated quote must be in the diff
    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).not.toContain("deleteEverything");
    expect(fixturePatches).not.toContain("dropTable");

    fixture.fakeFindings = [fabricated1, fabricated2];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-14T00:00:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (a) No findings survived grounding
    expect(summary.findings).toHaveLength(0);

    // (b) groundingWithheld carries all dropped findings
    expect(summary.groundingWithheld).toBeDefined();
    expect(summary.groundingWithheld).toHaveLength(2);
    const withheldTitles = summary.groundingWithheld?.map((f) => f.title) ?? [];
    expect(withheldTitles).toContain("Fabricated critical");
    expect(withheldTitles).toContain("Fabricated warning");

    // (c) Title reflects 0 survivors (approved, no blocking findings)
    expect(summary.title).not.toContain("2");
    expect(summary.decision).toBe("approved");
    expect(summary.outcome).toBe("pass");

    // (d) Grounding trace emitted with 2 drops
    const groundingTrace = traceSink.events.find((e) => e.type === "grounding.applied");
    expect(groundingTrace).toBeDefined();
    expect(groundingTrace?.data?.droppedFindingCount).toBe(2);

    // (e) The rendered markdown must NOT have bare "No findings." on its own line —
    //     it must have the low-confidence block heading and the blocking-findings note.
    const markdown = formatReviewSummaryMarkdown(summary);
    expect(markdown).not.toMatch(/^No findings\.$/m);
    expect(markdown).toContain("No blocking findings (see low-confidence block below).");
    expect(markdown).toContain("### ⚠️ Low-confidence findings (kept, non-blocking)");
    expect(markdown).toContain("Fabricated critical");
    expect(markdown).toContain("Fabricated warning");
  });

  // -------------------------------------------------------------------------
  // #206: sentinel-body stub runtime tests — body trust channel
  // -------------------------------------------------------------------------

  /**
   * Stub AgentRuntime that returns a fixed coordinator result whose `summary.body`
   * contains a recognizable sentinel string. The stub's findings intentionally use
   * fabricated quotedCode so grounding withholds them — proving the sentinel prose
   * from the pre-grounding body is NOT carried into the authoritative summary body.
   */
  class SentinelBodyRuntime implements AgentRuntime {
    readonly name = "sentinel-body";

    constructor(private readonly findings: Finding[]) {}

    async runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult> {
      // Build a base summary from the coordinator's view (all findings, pre-grounding),
      // then override `body` with a sentinel to prove #206 strips it.
      const baseSummary = summarizeReview(input.context, this.findings);
      return {
        runId: input.runId,
        agentRunId: `${input.runId}:coordinator`,
        summary: {
          ...baseSummary,
          findings: this.findings,
          body: "SENTINEL_PROSE: the SQL-injection finding in auth.ts is critical",
        },
        reviewerResults: [],
        rawOutput: "{}",
      };
    }

    async runReviewer(input: ReviewerRunInput): Promise<ReviewerRunResult> {
      return {
        runId: input.runId,
        agentRunId: `${input.runId}:${input.role}`,
        role: input.role,
        findings: [],
        rawOutput: '{"findings":[]}',
      };
    }

    streamEvents(
      _runId: string,
      _onEvent: (event: RuntimeEvent) => void,
    ): RuntimeEventSubscription {
      return { unsubscribe: () => {} };
    }

    async cancel(_runId: string): Promise<void> {}
  }

  test("#206 all-withheld: body is deterministic (no sentinel prose), contains grounded markers and withheld note, #204 block preserved", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // Both findings use fabricated quotedCode → grounding withholds both.
    const fabricated1: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "auth",
      title: "Fabricated SQL injection",
      body: "body",
      confidence: "high",
      evidence: ["fabricated evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"],
    };
    const fabricated2: Finding = {
      reviewer: "code_quality",
      severity: "warning",
      category: "correctness",
      title: "Fabricated warning",
      body: "body",
      confidence: "medium",
      evidence: ["fabricated evidence 2"],
      recommendation: "fix it too",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["db.dropTable('users');"],
    };

    // Self-guard: fabricated quotes must NOT be in the fixture diff
    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).not.toContain("deleteEverything");
    expect(fixturePatches).not.toContain("dropTable");

    const runtime = new SentinelBodyRuntime([fabricated1, fabricated2]);
    const result = await runReview({
      fixture,
      runtime,
      clock: createIncrementingClock("2026-06-14T01:00:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (1) No findings survived grounding
    expect(summary.findings).toHaveLength(0);

    // (2) Core #206 assertion: sentinel prose is gone from the authoritative body
    expect(summary.body).not.toContain("SENTINEL_PROSE");

    // (3) Body is deterministic — contains the createSummaryBody markers
    expect(summary.body).toContain("Risk tier:");
    expect(summary.body).toContain("Findings: 0");

    // (4) Transparency note is still appended (#207: down-weight framing)
    expect(summary.body).toContain("finding(s) shown at low confidence (kept, non-blocking)");

    // (5) #204 block is preserved in rendered markdown (#207: low-confidence heading)
    const markdown = formatReviewSummaryMarkdown(summary);
    expect(markdown).toContain("### ⚠️ Low-confidence findings (kept, non-blocking)");
    expect(markdown).toContain("No blocking findings (see low-confidence block below).");
  });

  test("#206 partial-drop: surviving finding count correct, sentinel not in body, #204 block present", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // grounded: quotedCode IS in the auth-pr diff (passes grounding)
    const grounded: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Grounded partial-drop finding",
      body: "body",
      confidence: "high",
      evidence: ["some evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.findById(accountId);"],
    };
    // fabricated: quotedCode NOT in the diff (dropped by grounding)
    const fabricated: Finding = {
      reviewer: "code_quality",
      severity: "critical",
      category: "correctness",
      title: "Fabricated partial-drop finding",
      body: "body",
      confidence: "high",
      evidence: ["fabricated evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["db.dropTable('users');"],
    };

    // Self-guard
    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).toContain("return db.accounts.findById(accountId);");
    expect(fixturePatches).not.toContain("dropTable");

    const runtime = new SentinelBodyRuntime([grounded, fabricated]);
    const result = await runReview({
      fixture,
      runtime,
      clock: createIncrementingClock("2026-06-14T01:01:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (1) Exactly 1 finding survived (the grounded one)
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]?.title).toBe("Grounded partial-drop finding");

    // (2) Core #206 assertion: sentinel not in body
    expect(summary.body).not.toContain("SENTINEL_PROSE");

    // (3) Body reflects grounded count (1), not pre-grounding count (2)
    expect(summary.body).toContain("Findings: 1");

    // (4) Transparency note is still appended (#207: down-weight framing)
    expect(summary.body).toContain("finding(s) shown at low confidence (kept, non-blocking)");

    // (5) Rendered markdown shows surviving finding and #207 low-confidence block
    const markdown = formatReviewSummaryMarkdown(summary);
    expect(markdown).toContain("Grounded partial-drop finding");
    expect(markdown).toContain("### ⚠️ Low-confidence findings (kept, non-blocking)");
  });

  // -------------------------------------------------------------------------
  // #207: demoted findings carry confidence:"low"; body uses down-weight framing
  // -------------------------------------------------------------------------

  test("#207: demoted finding in groundingWithheld has confidence:'low'; body uses down-weight framing", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    const fabricated: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "auth",
      title: "Demoted fabricated finding",
      body: "body",
      confidence: "high", // original confidence; should be down-weighted to "low"
      evidence: ["fabricated evidence"],
      recommendation: "fix it",
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"], // not in diff
    };

    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).not.toContain("deleteEverything");

    fixture.fakeFindings = [fabricated];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-14T02:00:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (a) demoted finding is in groundingWithheld (not in main findings)
    expect(summary.findings).toHaveLength(0);
    expect(summary.groundingWithheld).toHaveLength(1);

    // (b) #207 core assertion: demoted finding carries confidence:"low"
    expect(summary.groundingWithheld?.[0]?.confidence).toBe("low");
    expect(summary.groundingWithheld?.[0]?.title).toBe("Demoted fabricated finding");

    // (c) body uses the down-weight framing (#207), not the old "withheld" wording
    expect(summary.body).toContain(
      "finding(s) shown at low confidence (kept, non-blocking): cited code was not found in the changed-file grounding corpus",
    );
    expect(summary.body).not.toContain("withheld: the code they cited could not be found");
  });
});

// ---------------------------------------------------------------------------
// #261 residual-defect counts regression tests
// ---------------------------------------------------------------------------

describe("residual-defect counts (#261)", () => {
  /**
   * Regression test (acceptance criterion verbatim):
   * "a finding with no location that ships increments unlocatedShipped."
   * Also asserts noSuggestionShipped and offDiffCitationShipped.
   */
  test("unlocated, no-suggestion, and off-diff findings each increment their respective residualDefects count", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();

    // The auth-pr fixture has one changed file: auth/accounts.ts.
    // Self-guard: verify the fixture diff file is what we expect.
    const changedPaths = fixture.diff.files.map((f) => f.path);
    expect(changedPaths).toContain("auth/accounts.ts");

    // (1) unlocated: a finding with no location at all — after backfill, still no location
    const unlocatedFinding: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Unlocated shipped finding",
      body: "body",
      confidence: "high",
      evidence: ["evidence"],
      recommendation: "fix it",
      // no location field — ships through grounding scope-gate (no locationPath → always kept)
    };

    // (2) noSuggestion: a finding with an empty recommendation
    const noSuggestionFinding: Finding = {
      reviewer: "code_quality",
      severity: "warning",
      category: "correctness",
      title: "No-suggestion shipped finding",
      body: "body",
      confidence: "high",
      evidence: ["evidence"],
      recommendation: "   ", // whitespace-only → trimmed to "" → noSuggestionShipped
      location: { path: "auth/accounts.ts" },
    };

    // (3) offDiffCitation: a finding whose location.path is NOT a changed file
    const offDiffFinding: Finding = {
      reviewer: "code_quality",
      severity: "suggestion",
      category: "docs",
      title: "Off-diff citation shipped finding",
      body: "body",
      confidence: "medium",
      evidence: ["evidence"],
      recommendation: "update the docs",
      location: { path: "docs/auth.md" }, // not in the changed-file set
    };

    fixture.fakeFindings = [unlocatedFinding, noSuggestionFinding, offDiffFinding];

    await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-15T12:00:00.000Z"),
      telemetrySink,
    });

    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();

    const rd = metrics?.data?.residualDefects as
      | { unlocatedShipped: number; noSuggestionShipped: number; offDiffCitationShipped: number }
      | undefined;
    expect(rd).toBeDefined();
    expect(rd?.unlocatedShipped).toBe(1); // the finding with no location
    expect(rd?.noSuggestionShipped).toBe(1); // the finding with empty recommendation
    expect(rd?.offDiffCitationShipped).toBe(1); // the finding citing docs/auth.md
  });

  test("all findings with location on changed file and non-empty recommendation → residualDefects absent", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();

    // A clean finding: located on a changed file, has a recommendation
    const cleanFinding: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Clean finding",
      body: "body",
      confidence: "high",
      evidence: ["evidence"],
      recommendation: "fix it properly",
      location: { path: "auth/accounts.ts" },
    };

    fixture.fakeFindings = [cleanFinding];

    await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-15T13:00:00.000Z"),
      telemetrySink,
    });

    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    // No residualDefects block when all counts are 0
    expect(Object.hasOwn(metrics?.data ?? {}, "residualDefects")).toBe(false);
  });
});
