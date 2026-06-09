import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  FileSystemReviewStateStore,
  JsonlTraceSink,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";
import type { PriorReviewState, ReviewRunRecord, ReviewSummary, RuntimeEvent } from "../src/index.ts";

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
        now: new Date("2026-06-09T00:00:00.000Z"),
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

      const runRecord = JSON.parse(
        await readFile(join(outputDirectory, "runs", runId, "run.json"), "utf8"),
      ) as ReviewRunRecord;
      const summary = JSON.parse(
        await readFile(join(outputDirectory, "runs", runId, "summary.json"), "utf8"),
      ) as ReviewSummary;
      const latestState = await stateStore.load(result.context.metadata) as PriorReviewState | undefined;

      expect(runRecord.tracePath).toBe(tracePath);
      expect(runRecord.summary?.decision).toBe("significant_concerns");
      expect(summary.findings).toHaveLength(1);
      expect(latestState?.previousRunId).toBe("fixture-auth-pr");
      expect(latestState?.findings[0]?.finding.title).toBe("Account lookup misses authorization");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
