import { describe, expect, test } from "bun:test";
import type { Finding, ReviewSummary } from "../src/index.ts";
import { assignStableFindingIds, createStableFindingId, loadReviewFixture, runReview } from "../src/index.ts";

const baseFinding: Finding = {
  reviewer: "security",
  severity: "critical",
  category: "auth",
  title: "Account lookup misses authorization",
  body: "The new lookup uses a request-supplied accountId without proving the caller can access that account.",
  location: {
    path: "./auth/accounts.ts",
    line: 23,
    side: "RIGHT",
  },
  confidence: "high",
  evidence: ["The patch returns db.accounts.findById(accountId) directly."],
  recommendation: "Check account ownership before returning account data.",
};

describe("stable finding IDs", () => {
  test("generates deterministic IDs from reviewer, category, location, title, and body", () => {
    const first = createStableFindingId(baseFinding);
    const second = createStableFindingId({
      ...baseFinding,
      title: "  Account   Lookup Misses Authorization ",
      body: "The new lookup uses a request-supplied accountId without proving the caller can access that account.",
      location: {
        path: "auth/accounts.ts",
        line: 23,
        side: "RIGHT",
      },
    });

    expect(first).toMatch(/^fnd_[a-f0-9]{16}$/);
    expect(second).toBe(first);
    expect(createStableFindingId({
      ...baseFinding,
      location: {
        path: "auth/accounts.ts",
        line: 24,
        side: "RIGHT",
      },
    })).not.toBe(first);
  });

  test("preserves IDs supplied by runtimes or adapters", () => {
    const summary: ReviewSummary = {
      decision: "significant_concerns",
      outcome: "fail",
      title: "Finding",
      body: "Review body",
      risk: {
        tier: "full",
        reason: "Sensitive auth change",
        matchedRules: ["sensitive_paths"],
        sensitivePaths: ["auth/accounts.ts"],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
      findings: [{ ...baseFinding, id: "runtime-provided-id" }],
    };

    expect(assignStableFindingIds(summary).findings[0]?.id).toBe("runtime-provided-id");
  });

  test("runner assigns stable IDs to completed summaries", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(result.summary.findings[0]?.id).toMatch(/^fnd_[a-f0-9]{16}$/);
  });
});
