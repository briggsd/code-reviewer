import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  DummyAgentRuntime,
  JsonlTraceSink,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";
import type { RuntimeEvent } from "../src/index.ts";

describe("DummyAgentRuntime", () => {
  test("runs coordinator and reviewers through the AgentRuntime boundary", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const runtime = new DummyAgentRuntime({
      defaultFindings: fixture.fakeFindings ?? [],
      timestamp: "2026-06-09T00:00:00.000Z",
    });
    const result = await runReview({
      fixture,
      now: new Date("2026-06-09T00:00:00.000Z"),
      runtime,
    });

    expect(result.coordinatorResult?.agentRunId).toBe("fixture-auth-pr:coordinator");
    expect(result.coordinatorResult?.reviewerResults.map((reviewer) => reviewer.role)).toEqual([
      "code_quality",
      "security",
      "documentation",
      "performance",
    ]);
    expect(result.coordinatorResult?.reviewerResults.find((reviewer) => reviewer.role === "security")?.findings).toHaveLength(1);
    expect(result.summary.decision).toBe("significant_concerns");
    expect(result.summary.outcome).toBe("fail");
  });

  test("emits agent lifecycle events into the trace sink", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-runtime-"));

    try {
      const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
      const tracePath = join(outputDirectory, "trace.jsonl");
      const traceSink = new JsonlTraceSink(tracePath);
      const runtime = new DummyAgentRuntime({
        defaultFindings: fixture.fakeFindings ?? [],
        timestamp: "2026-06-09T00:00:00.000Z",
      });

      await runReview({
        fixture,
        now: new Date("2026-06-09T00:00:00.000Z"),
        runtime,
        traceSink,
      });
      await traceSink.close();

      const events = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RuntimeEvent);
      const agentEvents = events.filter((event) => event.type.startsWith("agent."));

      expect(events[0]?.type).toBe("review.started");
      expect(agentEvents.map((event) => `${event.type}:${event.role}`)).toContain("agent.started:coordinator");
      expect(agentEvents.map((event) => `${event.type}:${event.role}`)).toContain("agent.completed:security");
      expect(agentEvents.map((event) => `${event.type}:${event.role}`)).toContain("agent.output:coordinator");
      expect(events.at(-1)?.type).toBe("review.completed");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
