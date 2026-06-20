/**
 * Tests for the local-run health + findings-count header (#380/#381, M034).
 *
 * Exercises the real formatLocalRunHealthHeader helper from src/cli/run-options.ts,
 * which is the same function runCommand uses — changing the production logic will break
 * these tests rather than silently passing with a local copy.
 */

import { describe, expect, test } from "bun:test";
import { formatLocalRunHealthHeader } from "../src/cli/run-options.ts";
import type { Finding, ReviewSummary } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers (local copies — not exported from other test files)
// ---------------------------------------------------------------------------

function makeRisk(): ReviewSummary["risk"] {
  return {
    tier: "full",
    reason: "Sensitive auth change.",
    matchedRules: ["sensitive_paths"],
    sensitivePaths: ["auth/accounts.ts"],
    reviewedFileCount: 2,
    ignoredFileCount: 0,
  };
}

function makeSummary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    decision: "significant_concerns",
    outcome: "fail",
    title: "AI review found issues",
    body: "Risk tier: full\nRisk reason: Sensitive auth change.\nFiles reviewed: 2\nFiles ignored: 0\nFindings: 3",
    findings: [],
    risk: makeRisk(),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Auth check changed",
    body: "The auth check changed.",
    confidence: "high",
    evidence: ["Evidence item."],
    recommendation: "Verify the new auth behavior.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatLocalRunHealthHeader (#380/#381)", () => {
  test("clean run with grounded findings and no withheld → degraded=false, correct grounded count", () => {
    const summary = makeSummary({
      findings: [makeFinding(), makeFinding({ title: "Another finding" })],
    });
    const lines = formatLocalRunHealthHeader(summary);
    const header = lines.join("\n");

    expect(header).toContain("degraded=false (0 reviewers failed)");
    expect(header).toContain("2 grounded / 0 withheld");
  });

  test("degraded run → degraded=true with correct failed reviewer count", () => {
    const summary = makeSummary({
      findings: [makeFinding()],
      degraded: {
        failedReviewerCount: 2,
        completedReviewerCount: 1,
        failedRoles: ["code_quality", "perf"],
      },
    });
    const lines = formatLocalRunHealthHeader(summary);
    const header = lines.join("\n");

    expect(header).toContain("degraded=true (2 reviewers failed)");
  });

  test("withheld present → withheld count reflects groundingWithheld length", () => {
    const withheldFinding = makeFinding({ confidence: "low", title: "Low confidence nit" });
    const summary = makeSummary({
      findings: [makeFinding()],
      groundingWithheld: [withheldFinding],
    });
    const lines = formatLocalRunHealthHeader(summary);
    const header = lines.join("\n");

    expect(header).toContain("1 grounded / 1 withheld");
  });

  test("zero grounded with withheld present → 0 grounded / 1 withheld (the #380 mismatch case)", () => {
    const withheldFinding = makeFinding({ confidence: "low", title: "Low confidence nit" });
    const summary = makeSummary({
      findings: [],
      groundingWithheld: [withheldFinding],
    });
    const lines = formatLocalRunHealthHeader(summary);
    const header = lines.join("\n");

    expect(header).toContain("0 grounded / 1 withheld");
    expect(header).toContain("degraded=false (0 reviewers failed)");
  });
});
