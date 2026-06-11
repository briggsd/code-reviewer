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
  RedactingTraceSink,
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
  TraceSink,
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

  test("runner includes jobKind in run_metrics when option is set", async () => {
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
      jobKind: "dry-run",
    });

    expect(telemetrySink.events).toHaveLength(1);
    expect(telemetrySink.events[0]?.data?.jobKind).toBe("dry-run");
  });

  test("runner omits jobKind from run_metrics when option is absent", async () => {
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
    expect(Object.prototype.hasOwnProperty.call(telemetrySink.events[0]?.data, "jobKind")).toBe(false);
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

  test("runner includes jobKind in failed run_metrics when option is set", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const telemetrySink = new RecordingTelemetrySink();
    const runtime = new FailingRuntime();

    await expect(runReview({
      fixture,
      clock: createIncrementingClock("2026-06-09T00:00:00.000Z"),
      runtime,
      telemetrySink,
      jobKind: "dry-run",
    })).rejects.toThrow("synthetic runtime failure");

    expect(telemetrySink.events[0]).toMatchObject({
      type: "ai_review.run_metrics",
      data: {
        status: "failed",
        jobKind: "dry-run",
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

// ---------------------------------------------------------------------------
// Helpers for RedactingTraceSink tests
// ---------------------------------------------------------------------------

/**
 * Build a `RuntimeEvent` of type "runtime.event" whose inner `data.event`
 * is a Pi `message_start` event.
 *
 * Shape derived from `forwardPiEvent` in pi-agent-runtime.ts (~line 442) and
 * the Anthropic streaming API: the Pi process emits
 *   { type: "message_start", message: { role: "user", content: [...] } }
 * as a JSON line; `forwardPiEvent` wraps it in the RuntimeEvent envelope with
 * `data: { runtime: "pi", event: <sanitized Pi event> }`.
 */
function makeMessageStartEvent(): RuntimeEvent {
  return {
    type: "runtime.event",
    runId: "run-test",
    agentRunId: "agent-1",
    role: "security",
    timestamp: "2026-06-10T00:00:00.000Z",
    data: {
      runtime: "pi",
      event: {
        type: "message_start",
        message: {
          role: "user",
          content: [
            { type: "text", text: "You are a trusted reviewer. SYSTEM PROMPT TEXT HERE." },
          ],
        },
      },
    },
  };
}

/**
 * Build a `RuntimeEvent` wrapping a Pi `message_end` event.
 *
 * Shape derived from `extractFinalAssistantText` (~line 1467) and
 * `extractUsage` (~line 1499) in pi-agent-runtime.ts:
 *   { type: "message_end", message: { role: "assistant",
 *       content: [{ type: "text", text: "..." }],
 *       usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5,
 *                cost: { total: 0.002 } } } }
 */
function makeMessageEndEvent(): RuntimeEvent {
  return {
    type: "runtime.event",
    runId: "run-test",
    agentRunId: "agent-1",
    role: "security",
    timestamp: "2026-06-10T00:00:01.000Z",
    data: {
      runtime: "pi",
      event: {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ASSISTANT REPLY TEXT HERE." }],
          usage: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 5,
            cost: { total: 0.002 },
          },
        },
      },
    },
  };
}

/** Build a non-message runtime.event (agent.started) that must pass through unchanged. */
function makeAgentStartedEvent(): RuntimeEvent {
  return {
    type: "agent.started",
    runId: "run-test",
    agentRunId: "agent-1",
    role: "security",
    timestamp: "2026-06-10T00:00:00.000Z",
    data: { sensitiveKey: "should-not-be-touched" },
  };
}

describe("RedactingTraceSink", () => {
  test("redacts message_start content to marker while preserving envelope", async () => {
    const inner = new RecordingTraceSink();
    const sink = new RedactingTraceSink(inner);

    await sink.write(makeMessageStartEvent());

    expect(inner.events).toHaveLength(1);
    const written = inner.events[0];

    // Envelope preserved
    expect(written?.type).toBe("runtime.event");
    expect(written?.runId).toBe("run-test");
    expect(written?.agentRunId).toBe("agent-1");
    expect(written?.role).toBe("security");
    expect(written?.timestamp).toBe("2026-06-10T00:00:00.000Z");

    // data.runtime preserved
    expect(written?.data?.runtime).toBe("pi");

    // Inner Pi event type preserved
    const piEvent = written?.data?.event as Record<string, unknown>;
    expect(piEvent.type).toBe("message_start");

    // content is redacted
    const message = piEvent.message as Record<string, unknown>;
    expect(message.content).toBe("[redacted]");

    // role preserved inside message
    expect(message.role).toBe("user");
  });

  test("redacts message_end content to marker while preserving envelope and token-usage metadata", async () => {
    const inner = new RecordingTraceSink();
    const sink = new RedactingTraceSink(inner);

    await sink.write(makeMessageEndEvent());

    expect(inner.events).toHaveLength(1);
    const written = inner.events[0];

    // Envelope preserved
    expect(written?.type).toBe("runtime.event");
    expect(written?.runId).toBe("run-test");
    expect(written?.timestamp).toBe("2026-06-10T00:00:01.000Z");

    // Inner Pi event type preserved
    const piEvent = written?.data?.event as Record<string, unknown>;
    expect(piEvent.type).toBe("message_end");

    // content is redacted
    const message = piEvent.message as Record<string, unknown>;
    expect(message.content).toBe("[redacted]");

    // usage metadata preserved (numeric counts survive redaction)
    const usage = message.usage as Record<string, unknown>;
    expect(usage.input).toBe(100);
    expect(usage.output).toBe(50);
    expect(usage.cacheRead).toBe(10);
    expect(usage.cacheWrite).toBe(5);
    expect((usage.cost as Record<string, unknown>).total).toBe(0.002);

    // role preserved
    expect(message.role).toBe("assistant");
  });

  test("passes non-message events through unchanged", async () => {
    const inner = new RecordingTraceSink();
    const sink = new RedactingTraceSink(inner);
    const original = makeAgentStartedEvent();

    await sink.write(original);

    expect(inner.events).toHaveLength(1);
    expect(inner.events[0]).toEqual(original);
  });

  test("passes runtime.event with unrelated Pi event type through unchanged", async () => {
    const inner = new RecordingTraceSink();
    const sink = new RedactingTraceSink(inner);

    const agentStartPiEvent: RuntimeEvent = {
      type: "runtime.event",
      runId: "run-test",
      agentRunId: "agent-1",
      role: "security",
      timestamp: "2026-06-10T00:00:00.000Z",
      data: {
        runtime: "pi",
        event: { type: "agent_start" },
      },
    };

    await sink.write(agentStartPiEvent);

    expect(inner.events).toHaveLength(1);
    expect(inner.events[0]).toEqual(agentStartPiEvent);
  });

  test("without redaction, events reach inner sink byte-identical (passthrough by default)", async () => {
    const inner = new RecordingTraceSink();
    // Using inner sink directly without RedactingTraceSink
    const originalEnd = makeMessageEndEvent();
    await inner.write(originalEnd);

    const written = inner.events[0];
    const piEvent = written?.data?.event as Record<string, unknown>;
    const message = piEvent.message as Record<string, unknown>;
    // Content is untouched — the full assistant reply text is present
    expect(message.content).toEqual([{ type: "text", text: "ASSISTANT REPLY TEXT HERE." }]);
  });

  test("delegates close() to the inner sink", async () => {
    let closed = false;
    const inner: TraceSink = {
      async write(_event: RuntimeEvent): Promise<void> {},
      async close(): Promise<void> {
        closed = true;
      },
    };

    const sink = new RedactingTraceSink(inner);
    await sink.close();

    expect(closed).toBe(true);
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
