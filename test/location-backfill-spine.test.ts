import { describe, expect, test } from "bun:test";
import type {
  Finding,
  RuntimeEvent,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TraceSink,
} from "../src/index.ts";
import { loadReviewFixture, runReview } from "../src/index.ts";

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
// Spine integration test
// ---------------------------------------------------------------------------

describe("location backfill spine integration", () => {
  test("finding with quotedCode but no location gets location backfilled in the full run pipeline", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const traceSink = new RecordingTraceSink();

    // The auth-pr fixture patch is:
    //   @@ -20,6 +20,20 @@
    //   +  const accountId = req.query.accountId;
    //   +  return db.accounts.findById(accountId);
    //    }
    //
    // "return db.accounts.findById(accountId);" is at new-side line 21 (newStart=20,
    // first + line → 20, second + line → 21; the third line is context " }" → 22).
    //
    // Self-guard: the expected quote must be present in the fixture patch.
    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).toContain("return db.accounts.findById(accountId);");

    // A finding with quotedCode matching a real fixture diff line but NO location.
    const noLocationFinding: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "SQL injection risk in account lookup",
      body: "body",
      confidence: "high",
      evidence: ["uses request param directly in DB query"],
      recommendation: "parameterize the query",
      quotedCode: ["return db.accounts.findById(accountId);"],
      // intentionally no location property
    };

    fixture.fakeFindings = [noLocationFinding];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T01:00:00.000Z"),
      telemetrySink,
      traceSink,
    });

    const { summary } = result;

    // (a) The finding appears in the summary with a location populated.
    expect(summary.findings).toHaveLength(1);
    const locatedFinding = summary.findings[0];
    expect(locatedFinding?.title).toBe("SQL injection risk in account lookup");
    expect(locatedFinding?.location).toBeDefined();
    expect(locatedFinding?.location?.path).toBe("auth/accounts.ts");
    // Pin the exact absolute new-side line (21) so an off-by-one in the hunk parser is caught
    // end-to-end, not just in the synthetic unit tests (#87 review).
    expect(locatedFinding?.location?.line).toBe(21);
    expect(locatedFinding?.location?.side).toBe("RIGHT");

    // (b) A "location.backfill.applied" trace event was emitted with backfilledCount: 1.
    const backfillEvent = traceSink.events.find((e) => e.type === "location.backfill.applied");
    expect(backfillEvent).toBeDefined();
    expect(backfillEvent?.data?.backfilledCount).toBe(1);

    // (c) Telemetry run_metrics includes locationBackfill.backfilledCount (counts-only, M008).
    const metricsEvent = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(metricsEvent).toBeDefined();
    const locationBackfillData = metricsEvent?.data?.locationBackfill as
      | { backfilledCount: number }
      | undefined;
    expect(locationBackfillData?.backfilledCount).toBe(1);
  });

  test("backfill is a no-op when all findings already have a line — no trace event emitted", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const traceSink = new RecordingTraceSink();

    // The fixture's own fakeFindings have a location with a line — no backfill needed.
    // (Don't override fixture.fakeFindings — use the default fixture finding.)

    await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-11T01:01:00.000Z"),
      traceSink,
    });

    const backfillEvent = traceSink.events.find((e) => e.type === "location.backfill.applied");
    expect(backfillEvent).toBeUndefined();
  });
});
