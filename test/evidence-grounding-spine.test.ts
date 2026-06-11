import { describe, expect, test } from "bun:test";
import { loadReviewFixture, runReview } from "../src/index.ts";
import type {
  CoordinatorRunInput,
  CoordinatorRunResult,
  Finding,
  AgentRuntime,
  ReviewerRunInput,
  ReviewerRunResult,
  RuntimeEvent,
  RuntimeEventSubscription,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TraceSink,
} from "../src/index.ts";

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
    expect(summary.body).toContain("withheld: the code they cited could not be found in the changed files");

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
    expect((metrics?.data?.grounding as { droppedFindingCount: number } | undefined)?.droppedFindingCount).toBe(1);

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
    expect(Object.prototype.hasOwnProperty.call(metrics?.data, "grounding")).toBe(false);
  });
});
