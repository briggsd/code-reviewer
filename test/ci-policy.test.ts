import { describe, expect, test } from "bun:test";
import type { ReviewSummary } from "../src/index.ts";
import {
  createDefaultReviewConfig,
  decideCiOutcome,
  formatReviewSummaryMarkdown,
  loadReviewFixture,
  normalizeReviewFixture,
  runReview,
} from "../src/index.ts";

describe("CI decision policy", () => {
  test("advisory mode passes even with critical findings", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const advisoryFixture = normalizeReviewFixture({
      ...fixture,
      config: {
        ...fixture.config,
        mode: "advisory",
      },
    });
    const result = await runReview({
      fixture: advisoryFixture,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(decideCiOutcome(result.summary, advisoryFixture.config)).toEqual({
      outcome: "pass",
      exitCode: 0,
      reason: "Advisory mode does not fail CI for review findings.",
    });
  });

  test("blocking mode fails when finding severity matches fail_on", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(decideCiOutcome(result.summary, fixture.config)).toEqual({
      outcome: "fail",
      exitCode: 1,
      reason: "Blocking mode fails CI because a critical finding matched fail_on policy.",
    });
  });

  test("blocking mode passes when findings do not match fail_on", async () => {
    const fixture = normalizeReviewFixture({
      metadata: {
        provider: "local",
        repository: {
          provider: "local",
          name: "demo",
          slug: "demo",
        },
        changeId: "local",
        headSha: "abc123",
        title: "Update copy",
        author: {
          username: "dev",
        },
        labels: [],
      },
      diff: {
        files: [
          {
            path: "README.md",
            status: "modified",
            additions: 2,
            deletions: 1,
            isBinary: false,
          },
        ],
        totalAdditions: 2,
        totalDeletions: 1,
        truncated: false,
      },
      config: {
        mode: "blocking",
        failOn: ["critical"],
      },
      fakeFindings: [
        {
          reviewer: "documentation",
          severity: "suggestion",
          category: "docs",
          title: "Clarify README wording",
          body: "The wording could be clearer.",
          confidence: "high",
          evidence: ["README changed."],
          recommendation: "Tighten the wording.",
        },
      ],
    });
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(decideCiOutcome(result.summary, fixture.config)).toEqual({
      outcome: "pass",
      exitCode: 0,
      reason: "No findings matched blocking CI policy.",
    });
  });

  test("review_failed is fail-open in advisory and fail-closed in blocking", () => {
    const config = createDefaultReviewConfig();
    const summary = reviewFailedSummary();

    expect(decideCiOutcome(summary, { ...config, mode: "advisory" })).toEqual({
      outcome: "neutral",
      exitCode: 0,
      reason: "Review failed but policy is fail-open.",
    });
    expect(decideCiOutcome(summary, { ...config, mode: "blocking" })).toEqual({
      outcome: "fail",
      exitCode: 1,
      reason: "Review failed and policy is fail-closed.",
    });
  });

  test("break-glass override forces a non-blocking outcome over a would-be fail", async () => {
    // A blocking-mode critical finding that would normally fail CI...
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    expect(decideCiOutcome(result.summary, fixture.config)).toEqual({
      outcome: "fail",
      exitCode: 1,
      reason: "Blocking mode fails CI because a critical finding matched fail_on policy.",
    });

    // ...is overridden to neutral / exit 0 when a trusted human broke glass.
    expect(decideCiOutcome(result.summary, fixture.config, { overridden: true })).toEqual({
      outcome: "neutral",
      exitCode: 0,
      reason: "Human break-glass override — CI status is non-blocking for this run.",
    });
  });

  test("review_failed override is neutral even under fail-closed blocking", () => {
    const config = createDefaultReviewConfig();
    const summary = reviewFailedSummary();
    expect(decideCiOutcome(summary, { ...config, mode: "blocking" }, { overridden: true })).toEqual(
      {
        outcome: "neutral",
        exitCode: 0,
        reason: "Human break-glass override — CI status is non-blocking for this run.",
      },
    );
  });
});

describe("summary markdown formatting", () => {
  test("renders no-finding summaries", () => {
    const markdown = formatReviewSummaryMarkdown({
      decision: "approved",
      outcome: "pass",
      title: "AI review found no blocking issues",
      body: "Risk tier: trivial\nFindings: 0",
      findings: [],
      risk: {
        tier: "trivial",
        reason: "Small change.",
        matchedRules: ["small_change"],
        sensitivePaths: [],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
    });

    expect(markdown).toContain("## AI review found no blocking issues");
    expect(markdown).toContain("✅ Approved");
    expect(markdown).toContain("No findings.");
  });

  test("renders finding details and optional hidden metadata", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const markdown = formatReviewSummaryMarkdown(result.summary, {
      includeHiddenMetadata: true,
      hiddenMetadata: {
        runId: result.context.runId,
      },
    });

    expect(markdown).toContain(
      "**CRITICAL: Account lookup misses authorization** (auth/accounts.ts:23)",
    );
    // Reviewer is now shown as a group heading (escaped plain text), not inline in detail lines
    expect(markdown).toContain("🔒 security");
    expect(markdown).toContain("<!-- ai-code-review-factory");
    expect(markdown).toContain('"runId": "fixture-auth-pr"');
  });
});

function reviewFailedSummary(): ReviewSummary {
  return {
    decision: "review_failed",
    outcome: "fail",
    title: "AI review failed",
    body: "The review could not complete.",
    findings: [],
    risk: {
      tier: "lite",
      reason: "Unknown due to failure.",
      matchedRules: [],
      sensitivePaths: [],
      reviewedFileCount: 0,
      ignoredFileCount: 0,
    },
  };
}
