import { describe, expect, test } from "bun:test";
import type {
  Finding,
  PriorReviewState,
  RuntimeEvent,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TraceSink,
} from "../src/index.ts";
import { createStableFindingId, loadReviewFixture, runReview } from "../src/index.ts";

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

    // (b) body contains the transparency note
    expect(summary.body).toContain(
      "withheld: the code they cited could not be found in the changed files",
    );

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
});
