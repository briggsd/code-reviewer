import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  JsonlTraceSink,
  createPublishHiddenMetadata,
  loadReviewFixture,
  publishReviewSummary,
  runReview,
} from "../src/index.ts";
import type { PublishSummaryInput, PublishSummaryResult, RuntimeEvent, VcsAdapter } from "../src/index.ts";

describe("summary publishing orchestration", () => {
  test("publishes a summary and writes a publisher.completed trace event", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-publisher-"));

    try {
      const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
      const review = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
      const tracePath = join(outputDirectory, "trace.jsonl");
      const traceSink = new JsonlTraceSink(tracePath);
      const publisher = new RecordingSummaryPublisher({
        provider: "github",
        summaryCommentId: "123",
        summaryUrl: "https://example.test/comment/123",
        postedInlineCount: 0,
        failedInlineCount: 0,
      });

      const result = await publishReviewSummary({
        adapter: publisher,
        change: review.context.metadata,
        summary: review.summary,
        runId: review.context.runId,
        traceSink,
        timestamp: "2026-06-09T00:00:01.000Z",
      });
      await traceSink.close();

      const events = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RuntimeEvent);

      const findingId = review.summary.findings[0]?.id;
      expect(typeof findingId).toBe("string");
      expect(result.summaryCommentId).toBe("123");
      expect(publisher.inputs).toHaveLength(1);
      expect(publisher.inputs[0]?.hiddenMetadata).toEqual({
        schemaVersion: 1,
        runId: "fixture-auth-pr",
        headSha: "abc123",
        provider: "github",
        repository: "example/payments-api",
        changeId: "17",
        findingIds: [findingId as string],
      });
      expect(events).toEqual([
        {
          type: "publisher.completed",
          runId: "fixture-auth-pr",
          timestamp: "2026-06-09T00:00:01.000Z",
          data: {
            provider: "github",
            summaryCommentId: "123",
            summaryUrl: "https://example.test/comment/123",
            postedInlineCount: 0,
            failedInlineCount: 0,
          },
        },
      ]);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("does not write publisher.completed when provider publishing fails", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-publisher-fail-"));

    try {
      const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
      const review = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
      const tracePath = join(outputDirectory, "trace.jsonl");
      const traceSink = new JsonlTraceSink(tracePath);
      const publisher = {
        publishSummary: async (_input: PublishSummaryInput): Promise<PublishSummaryResult> => {
          throw new Error("provider write failed");
        },
      };

      await expect(publishReviewSummary({
        adapter: publisher,
        change: review.context.metadata,
        summary: review.summary,
        runId: review.context.runId,
        traceSink,
        timestamp: "2026-06-09T00:00:01.000Z",
      })).rejects.toThrow("provider write failed");
      await traceSink.close();

      const rawTrace = await readFile(tracePath, "utf8").catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return "";
        }
        throw error;
      });
      expect(rawTrace).toBe("");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("creates stable hidden metadata for summary comments", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    expect(createPublishHiddenMetadata("run-123", fixture.metadata)).toEqual({
      schemaVersion: 1,
      runId: "run-123",
      headSha: "abc123",
      provider: "github",
      repository: "example/payments-api",
      changeId: "17",
    });
  });
});

class RecordingSummaryPublisher implements Pick<VcsAdapter, "publishSummary"> {
  readonly inputs: PublishSummaryInput[] = [];

  private readonly result: PublishSummaryResult;

  constructor(result: PublishSummaryResult) {
    this.result = result;
  }

  async publishSummary(input: PublishSummaryInput): Promise<PublishSummaryResult> {
    this.inputs.push(input);
    return this.result;
  }
}
