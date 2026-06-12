import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChangeMetadata,
  DiffSummary,
  Finding,
  PublishInlineFindingsInput,
  PublishInlineFindingsResult,
  PublishSummaryInput,
  PublishSummaryResult,
  RuntimeEvent,
  VcsAdapter,
} from "../src/index.ts";
import {
  createPublishHiddenMetadata,
  JsonlTraceSink,
  loadReviewFixture,
  publishReviewInlineFindings,
  publishReviewSummary,
  runReview,
} from "../src/index.ts";

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

      await expect(
        publishReviewSummary({
          adapter: publisher,
          change: review.context.metadata,
          summary: review.summary,
          runId: review.context.runId,
          traceSink,
          timestamp: "2026-06-09T00:00:01.000Z",
        }),
      ).rejects.toThrow("provider write failed");
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

describe("inline publishing orchestration", () => {
  test("publishes only readiness-approved findings and traces skipped reasons", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-inline-publisher-"));

    try {
      const tracePath = join(outputDirectory, "trace.jsonl");
      const traceSink = new JsonlTraceSink(tracePath);
      const publisher = new RecordingInlinePublisher();
      const result = await publishReviewInlineFindings({
        adapter: publisher,
        change,
        diff,
        summary: {
          decision: "significant_concerns",
          outcome: "fail",
          title: "Inline test",
          body: "One ready finding and one blocked finding.",
          findings: [readyFinding, blockedFinding],
          risk: {
            tier: "full",
            reason: "test",
            matchedRules: [],
            sensitivePaths: [],
            reviewedFileCount: 1,
            ignoredFileCount: 0,
          },
        },
        runId: "run-inline-1",
        traceSink,
        timestamp: "2026-06-09T00:00:02.000Z",
      });
      await traceSink.close();

      const events = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RuntimeEvent);

      expect(publisher.inputs).toHaveLength(1);
      expect(publisher.inputs[0]?.runId).toBe("run-inline-1");
      expect(publisher.inputs[0]?.findings.map((finding) => finding.id)).toEqual(["ready-finding"]);
      expect(result.attemptedInlineCount).toBe(2);
      expect(result.postedInlineCount).toBe(1);
      expect(result.skippedInlineCount).toBe(1);
      expect(result.failedInlineCount).toBe(0);
      expect(result.findings).toEqual([
        {
          findingId: "ready-finding",
          disposition: "posted",
          providerCommentId: "inline-1",
          url: "https://example.test/inline-1",
        },
        {
          findingId: "blocked-finding",
          disposition: "skipped",
          reason: "line_not_in_patch",
        },
      ]);
      expect(events).toEqual([
        {
          type: "publisher.completed",
          runId: "run-inline-1",
          timestamp: "2026-06-09T00:00:02.000Z",
          data: {
            publisher: "inline",
            provider: "github",
            attemptedInlineCount: 2,
            postedInlineCount: 1,
            skippedInlineCount: 1,
            failedInlineCount: 0,
            inlineFindings: [
              {
                findingId: "ready-finding",
                disposition: "posted",
                providerCommentId: "inline-1",
                url: "https://example.test/inline-1",
              },
              {
                findingId: "blocked-finding",
                disposition: "skipped",
                reason: "line_not_in_patch",
              },
            ],
            skippedInlineReasons: [
              {
                findingId: "blocked-finding",
                reason: "line_not_in_patch",
              },
            ],
          },
        },
      ]);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});

const change: ChangeMetadata = {
  provider: "github",
  repository: {
    provider: "github",
    owner: "example",
    name: "demo",
    slug: "example/demo",
  },
  changeId: "7",
  headSha: "head-1",
  title: "Example PR",
  author: { username: "laszlo" },
  labels: [],
};

const diff: DiffSummary = {
  totalAdditions: 2,
  totalDeletions: 1,
  truncated: false,
  files: [
    {
      path: "src/auth.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      isBinary: false,
      patch: [
        "@@ -10,4 +10,5 @@ export function check(user) {",
        " const account = getAccount();",
        "-return account.owner === user.id;",
        "+if (!user) return false;",
        "+return account.owner === user.id;",
        " }",
      ].join("\n"),
    },
  ],
};

const readyFinding: Finding = {
  id: "ready-finding",
  reviewer: "security",
  severity: "warning",
  category: "auth",
  title: "Auth check changed",
  body: "The auth check changed and needs attention.",
  location: {
    path: "src/auth.ts",
    line: 12,
    side: "RIGHT",
  },
  confidence: "high",
  evidence: ["The patch changes the auth return path."],
  recommendation: "Verify the new auth behavior.",
};

const blockedFinding: Finding = {
  ...readyFinding,
  id: "blocked-finding",
  location: {
    path: "src/auth.ts",
    line: 99,
    side: "RIGHT",
  },
};

class RecordingInlinePublisher implements Pick<VcsAdapter, "provider" | "publishInlineFindings"> {
  readonly provider = "github" as const;

  readonly inputs: PublishInlineFindingsInput[] = [];

  async publishInlineFindings(
    input: PublishInlineFindingsInput,
  ): Promise<PublishInlineFindingsResult> {
    this.inputs.push(input);
    return {
      provider: "github",
      attemptedInlineCount: input.findings.length,
      postedInlineCount: input.findings.length,
      skippedInlineCount: 0,
      failedInlineCount: 0,
      findings: input.findings.map((finding, index) => ({
        ...(finding.id !== undefined ? { findingId: finding.id } : {}),
        disposition: "posted",
        providerCommentId: `inline-${index + 1}`,
        url: `https://example.test/inline-${index + 1}`,
      })),
    };
  }
}

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
