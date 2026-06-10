import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  DummyAgentRuntime,
  FileSystemReviewStateStore,
  JsonlTraceSink,
  loadReviewFixture,
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

function createIncrementingClock(startIso: string): () => Date {
  const startMs = Date.parse(startIso);
  let tick = 0;

  return () => {
    const date = new Date(startMs + tick * 10);
    tick += 1;
    return date;
  };
}
