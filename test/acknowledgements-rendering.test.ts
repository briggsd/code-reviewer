/**
 * Rendering tests for acknowledged findings in formatReviewSummaryMarkdown (#60-P3b).
 */
import { describe, expect, test } from "bun:test";
import { formatReviewSummaryMarkdown } from "../src/index.ts";
import type { Finding, ReviewSummary } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRisk(): ReviewSummary["risk"] {
  return {
    tier: "full",
    reason: "auth changes",
    matchedRules: [],
    sensitivePaths: [],
    reviewedFileCount: 1,
    ignoredFileCount: 0,
  };
}

function makeSummary(findings: Finding[]): ReviewSummary {
  return {
    decision: "approved_with_comments",
    outcome: "pass",
    title: "Test summary",
    body: "Summary body.",
    findings,
    risk: makeRisk(),
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Auth issue",
    body: "body text",
    confidence: "high",
    evidence: ["evidence item"],
    recommendation: "fix it",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acknowledged finding rendering", () => {
  test("acknowledged finding renders with 'acknowledged:' marker + reason on the title line", () => {
    const finding = makeFinding({
      title: "Auth token not validated",
      acknowledged: { reason: "tracked in TICKET-123; accepted" },
    });
    const summary = makeSummary([finding]);

    const markdown = formatReviewSummaryMarkdown(summary);

    // The marker should appear on the title line
    expect(markdown).toContain("— _acknowledged: tracked in TICKET-123; accepted_");
    // Full title line should also contain the finding title
    expect(markdown).toContain("Auth token not validated");
  });

  test("non-acknowledged finding renders without acknowledged marker", () => {
    const finding = makeFinding({ title: "Regular issue" });
    const summary = makeSummary([finding]);

    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("acknowledged:");
    expect(markdown).toContain("Regular issue");
  });

  test("mix of acknowledged and non-acknowledged findings: each renders correctly", () => {
    const acknowledged = makeFinding({
      title: "Known issue",
      acknowledged: { reason: "accepted via waiver" },
    });
    const normal = makeFinding({ title: "New issue" });
    const summary = makeSummary([acknowledged, normal]);

    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("Known issue");
    expect(markdown).toContain("— _acknowledged: accepted via waiver_");
    expect(markdown).toContain("New issue");

    // The marker must appear only once (for the acknowledged finding only)
    const occurrences = (markdown.match(/acknowledged:/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  test("acknowledged finding still shows category, reviewer, confidence, body, recommendation", () => {
    const finding = makeFinding({
      title: "Auth issue",
      category: "injection",
      reviewer: "security",
      confidence: "medium",
      body: "Detailed explanation.",
      recommendation: "Sanitize inputs.",
      acknowledged: { reason: "accepted" },
    });
    const summary = makeSummary([finding]);

    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("Category: `injection`");
    expect(markdown).toContain("Reviewer: `security`");
    expect(markdown).toContain("Confidence: `medium`");
    expect(markdown).toContain("Detailed explanation.");
    expect(markdown).toContain("Sanitize inputs.");
  });
});
