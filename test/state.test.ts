import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  DummyAgentRuntime,
  FileSystemReviewStateStore,
  createTelemetryFailureTraceLogger,
  JsonlTelemetryTransport,
  JsonlTraceSink,
  loadReviewFixture,
  NonBlockingTelemetrySink,
  runReview,
} from "../src/index.ts";
import type {
  AgentRuntime,
  CoordinatorRunInput,
  CoordinatorRunResult,
  PriorReviewState,
  ReviewerRunInput,
  ReviewerRunResult,
  ReviewRunRecord,
  ReviewSummary,
  RuntimeEvent,
  RuntimeEventSubscription,
  TelemetryDeliveryFailure,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TelemetryTransport,
} from "../src/index.ts";

class FailingRuntime implements AgentRuntime {
  readonly name = "failing";

  async runCoordinator(_input: CoordinatorRunInput): Promise<CoordinatorRunResult> {
    throw new Error("synthetic runtime failure");
  }

  async runReviewer(_input: ReviewerRunInput): Promise<ReviewerRunResult> {
    throw new Error("synthetic runtime failure");
  }

  streamEvents(_runId: string, _onEvent: (event: RuntimeEvent) => void): RuntimeEventSubscription {
    return {
      unsubscribe: () => {},
    };
  }

  async cancel(_runId: string): Promise<void> {}
}

describe("non-blocking telemetry sink", () => {
  test("delivers events asynchronously without making emit await transport completion", async () => {
    const transport = new DeferredTelemetryTransport();
    const failures: TelemetryDeliveryFailure[] = [];
    const sink = new NonBlockingTelemetrySink({
      transport,
      deliveryTimeoutMs: 1_000,
      onFailure: (failure) => failures.push(failure),
    });

    sink.emit(telemetryEvent("review.started"));

    expect(transport.startedCount).toBe(1);
    expect(failures).toHaveLength(0);

    transport.resolveNext();
    const result = await sink.flush();

    expect(result).toEqual({
      deliveredCount: 1,
      failedCount: 0,
      droppedCount: 0,
      pendingCount: 0,
    });
  });

  test("records delivery failures without rejecting flush", async () => {
    const failures: TelemetryDeliveryFailure[] = [];
    const sink = new NonBlockingTelemetrySink({
      transport: {
        async send(_event: TelemetryEvent): Promise<void> {
          throw new Error("telemetry backend unavailable");
        },
      },
      now: () => new Date("2026-06-09T01:00:00.000Z"),
      onFailure: (failure) => failures.push(failure),
    });

    sink.emit(telemetryEvent("review.completed"));
    const result = await sink.flush();

    expect(result.failedCount).toBe(1);
    expect(result.deliveredCount).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toBe("transport_error");
    expect(failures[0]?.error?.message).toBe("telemetry backend unavailable");
    expect(failures[0]?.timestamp).toBe("2026-06-09T01:00:00.000Z");
  });

  test("bounds queued telemetry and reports dropped events", async () => {
    const transport = new DeferredTelemetryTransport();
    const failures: TelemetryDeliveryFailure[] = [];
    const sink = new NonBlockingTelemetrySink({
      transport,
      capacity: 1,
      deliveryTimeoutMs: 1_000,
      onFailure: (failure) => failures.push(failure),
    });

    sink.emit(telemetryEvent("event.in_flight"));
    sink.emit(telemetryEvent("event.queued"));
    sink.emit(telemetryEvent("event.dropped"));

    expect(failures[0]?.reason).toBe("queue_full");
    expect(failures[0]?.event?.type).toBe("event.dropped");

    transport.resolveNext();
    await waitForTelemetryStarts(transport, 2);
    transport.resolveNext();
    const result = await sink.flush();

    expect(result).toEqual({
      deliveredCount: 2,
      failedCount: 0,
      droppedCount: 1,
      pendingCount: 0,
    });
  });

  test("can log telemetry delivery failures into the existing trace stream", async () => {
    const traceSink = new RecordingTraceSink();
    const sink = new NonBlockingTelemetrySink({
      transport: {
        async send(_event: TelemetryEvent): Promise<void> {
          throw new Error("telemetry backend unavailable");
        },
      },
      now: () => new Date("2026-06-09T01:00:00.000Z"),
      onFailure: createTelemetryFailureTraceLogger({ traceSink, runId: "run-1" }),
    });

    sink.emit(telemetryEvent("review.completed"));
    await sink.flush();

    expect(traceSink.events).toHaveLength(1);
    expect(traceSink.events[0]).toMatchObject({
      type: "runtime.event",
      runId: "run-1",
      timestamp: "2026-06-09T01:00:00.000Z",
      message: "Telemetry delivery transport_error",
      data: {
        event: "telemetry.delivery_failed",
        reason: "transport_error",
        telemetryEventType: "review.completed",
        errorMessage: "telemetry backend unavailable",
      },
    });
  });

  test("writes telemetry events as JSONL", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-telemetry-"));

    try {
      const telemetryPath = join(outputDirectory, "telemetry.jsonl");
      const transport = new JsonlTelemetryTransport(telemetryPath);
      await transport.send(telemetryEvent("review.completed"));
      await transport.close();

      const events = (await readFile(telemetryPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as TelemetryEvent);

      expect(events.map((event) => event.type)).toEqual(["review.completed"]);
      expect(events[0]?.runId).toBe("run-1");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("times out slow telemetry delivery without blocking later events", async () => {
    const failures: TelemetryDeliveryFailure[] = [];
    const delivered: string[] = [];
    const sink = new NonBlockingTelemetrySink({
      transport: {
        async send(event: TelemetryEvent): Promise<void> {
          if (event.type === "event.slow") {
            await new Promise(() => {});
            return;
          }
          delivered.push(event.type);
        },
      },
      deliveryTimeoutMs: 1,
      onFailure: (failure) => failures.push(failure),
    });

    sink.emit(telemetryEvent("event.slow"));
    sink.emit(telemetryEvent("event.fast"));
    const result = await sink.flush();

    expect(failures[0]?.reason).toBe("delivery_timeout");
    expect(delivered).toEqual(["event.fast"]);
    expect(result.failedCount).toBe(1);
    expect(result.deliveredCount).toBe(1);
  });
});

describe("JSONL trace and filesystem state", () => {
  test("runner writes trace, run, summary, and latest change state artifacts", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-state-"));

    try {
      const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
      const runId = fixture.runId ?? "fixture-auth-pr";
      const tracePath = join(outputDirectory, "runs", runId, "trace.jsonl");
      const traceSink = new JsonlTraceSink(tracePath);
      const stateStore = new FileSystemReviewStateStore(outputDirectory);

      const result = await runReview({
        fixture,
        clock: createIncrementingClock("2026-06-09T00:00:00.000Z"),
        stateStore,
        traceSink,
        tracePath,
      });
      await traceSink.close();

      const traceRaw = await readFile(tracePath, "utf8");
      const events = traceRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RuntimeEvent);

      expect(events.map((event) => event.type)).toEqual([
        "review.started",
        "context.built",
        "risk.assessed",
        "coordinator.completed",
        "review.completed",
      ]);
      expect(events[0]?.runId).toBe("fixture-auth-pr");
      expect(events[2]?.data?.tier).toBe("full");
      expect(new Set(events.map((event) => event.timestamp)).size).toBe(events.length);
      expect(events[1]?.data?.durationMs).toBeGreaterThan(0);
      expect(events[2]?.data?.durationMs).toBeGreaterThan(0);
      expect(events[3]?.data?.durationMs).toBeGreaterThan(0);
      expect(events[4]?.data?.durationMs).toBeGreaterThan(0);

      const runRecord = JSON.parse(
        await readFile(join(outputDirectory, "runs", runId, "run.json"), "utf8"),
      ) as ReviewRunRecord;
      const summary = JSON.parse(
        await readFile(join(outputDirectory, "runs", runId, "summary.json"), "utf8"),
      ) as ReviewSummary;
      const latestState = await stateStore.load(result.context.metadata) as PriorReviewState | undefined;

      expect(runRecord.tracePath).toBe(tracePath);
      expect(runRecord.completedAt).toBe(events[4]?.timestamp);
      expect(runRecord.metrics?.durationsMs.overallMs).toBeGreaterThan(0);
      expect(runRecord.metrics?.durationsMs.contextBuildMs).toBeGreaterThan(0);
      expect(runRecord.metrics?.context?.patchFileCount).toBe(1);
      expect(runRecord.metrics?.context?.artifactBytes).toBeGreaterThan(0);
      expect(runRecord.metrics?.context?.changeContextBytes).toBeGreaterThan(0);
      expect(runRecord.metrics?.context?.patchBytes).toBeGreaterThan(0);
      expect(runRecord.metrics?.durationsMs.riskAssessmentMs).toBeGreaterThan(0);
      expect(runRecord.metrics?.durationsMs.coordinatorMs).toBeGreaterThan(0);
      expect(runRecord.summary?.decision).toBe("significant_concerns");
      expect(summary.findings).toHaveLength(1);
      expect(latestState?.previousRunId).toBe("fixture-auth-pr");
      expect(latestState?.findings[0]?.finding.title).toBe("Account lookup misses authorization");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("runner routes versioned run metrics to telemetry", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const runtime = new DummyAgentRuntime({
      defaultFindings: fixture.fakeFindings ?? [],
    });
    const telemetrySink = new RecordingTelemetrySink();

    await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-09T00:00:00.000Z"),
      runtime,
      telemetrySink,
    });

    expect(telemetrySink.events).toHaveLength(1);
    expect(telemetrySink.events[0]).toMatchObject({
      type: "ai_review.run_metrics",
      runId: "fixture-auth-pr",
      data: {
        schemaVersion: "ai-review.run_metrics.v1",
        status: "completed",
        runtime: "dummy",
        provider: "github",
        repository: "example/payments-api",
        changeId: "17",
        riskTier: "full",
        decision: "significant_concerns",
        outcome: "fail",
        findingCount: 1,
        findingsBySeverity: {
          critical: 1,
        },
        tokens: {
          agentCount: 5,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        },
      },
    });
  });

  test("runner tags failed run metrics with runtime", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const runtime = new FailingRuntime();

    await expect(runReview({
      fixture,
      clock: createIncrementingClock("2026-06-09T00:00:00.000Z"),
      runtime,
      telemetrySink,
    })).rejects.toThrow("synthetic runtime failure");

    expect(telemetrySink.events).toHaveLength(1);
    expect(telemetrySink.events[0]).toMatchObject({
      type: "ai_review.run_metrics",
      runId: "fixture-auth-pr",
      data: {
        status: "failed",
        runtime: "failing",
      },
    });
  });

  test("runner logs telemetry emit failures without failing review", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const traceSink = new RecordingTraceSink();

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-09T00:00:00.000Z"),
      traceSink,
      telemetrySink: new ThrowingTelemetrySink(),
    });

    expect(result.summary.decision).toBe("significant_concerns");
    expect(traceSink.events.find((event) => event.data?.event === "telemetry.emit_failed")).toMatchObject({
      type: "runtime.event",
      runId: "fixture-auth-pr",
      message: "Telemetry emit failed",
      data: {
        event: "telemetry.emit_failed",
        telemetryEventType: "ai_review.run_metrics",
        errorMessage: "telemetry sink exploded",
      },
    });
  });

  test("runner aggregates per-agent token and cost metrics into run state", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-state-metrics-"));

    try {
      const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
      const runId = fixture.runId ?? "fixture-auth-pr";
      const stateStore = new FileSystemReviewStateStore(outputDirectory);
      const runtime = new DummyAgentRuntime({
        defaultFindings: fixture.fakeFindings ?? [],
      });

      await runReview({
        fixture,
        clock: createIncrementingClock("2026-06-09T00:00:00.000Z"),
        stateStore,
        runtime,
      });

      const runRecord = JSON.parse(
        await readFile(join(outputDirectory, "runs", runId, "run.json"), "utf8"),
      ) as ReviewRunRecord;

      expect(runRecord.metrics?.tokens).toEqual({
        agentCount: 5,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
      expect(runRecord.metrics?.agents).toHaveLength(5);
      expect(runRecord.metrics?.agents?.map((agent) => `${agent.kind}:${agent.role}`)).toContain("coordinator:coordinator");
      expect(runRecord.metrics?.agents?.map((agent) => `${agent.kind}:${agent.role}`)).toContain("reviewer:security");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("runner persists failure state and review.failed trace events for runtime errors", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-state-failure-"));

    try {
      const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
      const runId = fixture.runId ?? "fixture-auth-pr";
      const tracePath = join(outputDirectory, "runs", runId, "trace.jsonl");
      const traceSink = new JsonlTraceSink(tracePath);
      const stateStore = new FileSystemReviewStateStore(outputDirectory);

      await expect(runReview({
        fixture,
        clock: createIncrementingClock("2026-06-09T00:00:00.000Z"),
        stateStore,
        traceSink,
        tracePath,
        runtime: new FailingRuntime(),
      })).rejects.toThrow("synthetic runtime failure");
      await traceSink.close();

      const events = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RuntimeEvent);
      const runRecord = JSON.parse(
        await readFile(join(outputDirectory, "runs", runId, "run.json"), "utf8"),
      ) as ReviewRunRecord;

      expect(events.map((event) => event.type)).toContain("review.failed");
      expect(events.at(-1)?.type).toBe("review.failed");
      expect(events.at(-1)?.data?.phase).toBe("agent_runtime");
      expect(events.at(-1)?.data?.errorMessage).toBe("synthetic runtime failure");
      expect(events.at(-1)?.data?.errorCategory).toBe("unknown");
      expect(events.at(-1)?.data?.retryable).toBe(false);
      expect(runRecord.error).toBe("synthetic runtime failure");
      expect(runRecord.errorClassification).toEqual({
        category: "unknown",
        retryable: false,
        reason: "unclassified runtime failure",
      });
      expect(runRecord.metrics?.durationsMs.overallMs).toBeGreaterThan(0);
      expect(runRecord.metrics?.durationsMs.contextBuildMs).toBeGreaterThan(0);
      expect(runRecord.metrics?.durationsMs.riskAssessmentMs).toBeGreaterThan(0);
      expect(runRecord.tracePath).toBe(tracePath);
      expect(runRecord.summary).toBeUndefined();
      expect(runRecord.context.risk.tier).toBe("full");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});

function telemetryEvent(type: string): TelemetryEvent {
  return {
    type,
    runId: "run-1",
    timestamp: "2026-06-09T00:00:00.000Z",
  };
}

async function waitForTelemetryStarts(transport: DeferredTelemetryTransport, expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.startedCount >= expectedCount) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`Telemetry transport started ${transport.startedCount} events, expected ${expectedCount}`);
}

class RecordingTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];

  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }

  async flush(): Promise<TelemetryFlushResult> {
    return {
      deliveredCount: this.events.length,
      failedCount: 0,
      droppedCount: 0,
      pendingCount: 0,
    };
  }

  async close(): Promise<TelemetryFlushResult> {
    return this.flush();
  }
}

class ThrowingTelemetrySink implements TelemetrySink {
  emit(_event: TelemetryEvent): void {
    throw new Error("telemetry sink exploded");
  }

  async flush(): Promise<TelemetryFlushResult> {
    return {
      deliveredCount: 0,
      failedCount: 1,
      droppedCount: 0,
      pendingCount: 0,
    };
  }

  async close(): Promise<TelemetryFlushResult> {
    return this.flush();
  }
}

class RecordingTraceSink {
  readonly events: RuntimeEvent[] = [];

  async write(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
  }

  async close(): Promise<void> {}
}

class DeferredTelemetryTransport implements TelemetryTransport {
  readonly events: TelemetryEvent[] = [];
  private readonly resolvers: Array<() => void> = [];

  get startedCount(): number {
    return this.events.length;
  }

  async send(event: TelemetryEvent): Promise<void> {
    this.events.push(event);
    await new Promise<void>((resolve) => this.resolvers.push(resolve));
  }

  resolveNext(): void {
    const resolve = this.resolvers.shift();
    if (resolve !== undefined) {
      resolve();
    }
  }
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
