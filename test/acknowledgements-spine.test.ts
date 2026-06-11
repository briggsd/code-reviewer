/**
 * Spine integration tests for acknowledgement apply (#60-P3b).
 *
 * Uses loadReviewFixture + runReview (no network, dummy runtime) to confirm
 * the full pipeline: acknowledged findings stay in summary.findings (annotated),
 * gate is recomputed excluding them, traces + telemetry emitted.
 */
import { describe, expect, test } from "bun:test";
import { loadReviewFixture, runReview } from "../src/index.ts";
import type {
  Finding,
  RuntimeEvent,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TraceSink,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Minimal in-test sinks (mirrors evidence-grounding-spine.test.ts pattern)
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
// Tests
// ---------------------------------------------------------------------------

describe("acknowledgements spine integration", () => {
  test("acknowledge ack on critical finding: kept+annotated, gate excludes it (decision+outcome drop), body note + trace + telemetry", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // The fixture has a critical security finding at auth/accounts.ts.
    // We add an acknowledge ack that matches it by path.
    fixture.config = {
      ...fixture.config,
      acknowledgements: [
        {
          path: "auth/**",
          mode: "acknowledge",
          reason: "tracked in TICKET-123; under remediation",
        },
      ],
    };

    // Use the fixture's own critical finding (fakeFindings[0])
    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T00:00:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (a) Finding is still surfaced (acknowledged, not hidden)
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]?.title).toBe("Account lookup misses authorization");

    // (b) Finding is annotated with .acknowledged
    expect(summary.findings[0]?.acknowledged).toEqual({ reason: "tracked in TICKET-123; under remediation" });

    // (c) Gate is recomputed without the acknowledged finding:
    //     no blocking findings remain → decision is "approved", outcome is "pass"
    expect(summary.decision).toBe("approved");
    expect(summary.outcome).toBe("pass");

    // (d) Body contains the acknowledgements note
    expect(summary.body).toContain("1 finding(s) acknowledged");
    expect(summary.body).toContain("by project acknowledgements");

    // (e) acknowledgements.applied trace event emitted
    const ackTrace = traceSink.events.find((e) => e.type === "acknowledgements.applied");
    expect(ackTrace).toBeDefined();
    expect(ackTrace?.data?.acknowledgedCount).toBe(1);
    expect(ackTrace?.data?.suppressedCount).toBe(0);

    // (f) run_metrics telemetry contains acknowledgements.acknowledgedCount
    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    expect((metrics?.data?.acknowledgements as { acknowledgedCount: number } | undefined)?.acknowledgedCount).toBe(1);
  });

  test("suppress ack on non-security finding: removed from summary.findings, suppressedCount in trace + telemetry", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // Override fakeFindings with a non-security finding so suppress is allowed
    const nonSecurityFinding: Finding = {
      reviewer: "code_quality",
      severity: "warning",
      category: "correctness",
      title: "Known style issue",
      body: "body",
      location: { path: "auth/accounts.ts", line: 25, side: "RIGHT" },
      confidence: "medium",
      evidence: ["evidence"],
      recommendation: "fix it",
    };
    fixture.fakeFindings = [nonSecurityFinding];

    fixture.config = {
      ...fixture.config,
      acknowledgements: [
        {
          path: "auth/**",
          mode: "suppress",
          reason: "not relevant to this PR",
        },
      ],
    };

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T00:01:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (a) Finding is removed
    expect(summary.findings).toHaveLength(0);

    // (b) Decision and outcome reflect no findings
    expect(summary.decision).toBe("approved");
    expect(summary.outcome).toBe("pass");

    // (c) Body contains the suppressed note
    expect(summary.body).toContain("1 suppressed");

    // (d) acknowledgements.applied trace with suppressedCount
    const ackTrace = traceSink.events.find((e) => e.type === "acknowledgements.applied");
    expect(ackTrace).toBeDefined();
    expect(ackTrace?.data?.suppressedCount).toBe(1);
    expect(ackTrace?.data?.acknowledgedCount).toBe(0);

    // (e) run_metrics telemetry
    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    expect((metrics?.data?.acknowledgements as { suppressedCount: number } | undefined)?.suppressedCount).toBe(1);
  });

  test("no acks in config → no acknowledgements.applied trace, no acknowledgements in telemetry", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // Default fixture has no acknowledgements
    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T00:02:00.000Z"),
      telemetrySink,
      traceSink,
    });

    expect(result.summary.findings).toHaveLength(1);
    expect(result.summary.findings[0]?.acknowledged).toBeUndefined();

    // No acknowledgements.applied trace event
    const ackTrace = traceSink.events.find((e) => e.type === "acknowledgements.applied");
    expect(ackTrace).toBeUndefined();

    // No acknowledgements field in telemetry
    const metrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metrics).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(metrics?.data, "acknowledgements")).toBe(false);
  });

  test("expired ack → inactive; finding unchanged, no acknowledgements.applied trace", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    fixture.config = {
      ...fixture.config,
      acknowledgements: [
        {
          path: "auth/**",
          mode: "acknowledge",
          reason: "expired ack",
          expires: "2025-01-01",  // well in the past
        },
      ],
    };

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T00:03:00.000Z"),
      telemetrySink,
      traceSink,
    });

    // Finding unchanged (critical, fails gate)
    expect(result.summary.decision).toBe("significant_concerns");
    expect(result.summary.outcome).toBe("fail");
    expect(result.summary.findings[0]?.acknowledged).toBeUndefined();

    const ackTrace = traceSink.events.find((e) => e.type === "acknowledgements.applied");
    expect(ackTrace).toBeUndefined();
  });

  test("suppress on one of two findings keeps the decision but refreshes the (now lower) title count", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    // Two findings; suppressing the suggestion leaves the security warning, which keeps the same
    // decision (approved_with_comments) — so the OLD code (recompute title only on decision change)
    // would have left a stale "2 findings" title. The title must reflect the 1 finding now shown.
    fixture.fakeFindings = [
      { reviewer: "security", severity: "warning", category: "auth", title: "Security warning",
        body: "b", location: { path: "auth/accounts.ts", line: 1, side: "RIGHT" },
        confidence: "high", evidence: ["e"], recommendation: "r" },
      { reviewer: "code_quality", severity: "suggestion", category: "style", title: "Style nit",
        body: "b", location: { path: "src/util.ts", line: 1, side: "RIGHT" },
        confidence: "low", evidence: ["e"], recommendation: "r" },
    ];
    fixture.config = {
      ...fixture.config,
      acknowledgements: [{ path: "src/**", mode: "suppress", reason: "intentional style choice" }],
    };

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T00:00:00.000Z"),
    });

    expect(result.summary.findings).toHaveLength(1);
    expect(result.summary.findings[0]?.title).toBe("Security warning");
    expect(result.summary.decision).toBe("approved_with_comments"); // unchanged
    expect(result.summary.title).toBe("AI review found 1 finding");  // refreshed, not stale "2 findings"
  });
});
