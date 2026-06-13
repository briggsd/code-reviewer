import { describe, expect, test } from "bun:test";
import type {
  RuntimeEvent,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TraceSink,
} from "../src/index.ts";
import { loadReviewFixture, runReviewFromChange } from "../src/index.ts";

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

// ---------------------------------------------------------------------------
// Break-glass override wiring tests
// ---------------------------------------------------------------------------

describe("break-glass override wiring", () => {
  test("emits run.override event when breakGlassOverride is provided", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    await runReviewFromChange({
      metadata: fixture.metadata,
      diff: fixture.diff,
      config: fixture.config,
      telemetrySink,
      traceSink,
      breakGlassOverride: { commentId: "c1", authorAssociation: "OWNER" },
    });

    const overrideEvents = telemetrySink.events.filter(
      (e) => e.type === "ai_review.run_event" && e.data?.event === "run.override",
    );

    expect(overrideEvents.length).toBe(1);
    const evt = overrideEvents[0];
    expect(evt).toBeDefined();
    expect(evt?.data?.event).toBe("run.override");
    expect(evt?.data?.overrideCommentId).toBe("c1");
  });

  test("does NOT emit run.override event when breakGlassOverride is absent", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    await runReviewFromChange({
      metadata: fixture.metadata,
      diff: fixture.diff,
      config: fixture.config,
      telemetrySink,
      traceSink,
      // no breakGlassOverride
    });

    const overrideEvents = telemetrySink.events.filter(
      (e) => e.type === "ai_review.run_event" && e.data?.event === "run.override",
    );

    expect(overrideEvents.length).toBe(0);
  });
});
