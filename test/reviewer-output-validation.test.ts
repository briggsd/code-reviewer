import { describe, expect, test } from "bun:test";
import type { Finding, Severity } from "../src/contracts/index.ts";
import {
  enforceReviewerAllowedSeverities,
  enforceReviewerRole,
  parseReviewerOutput,
} from "../src/runtime/reviewer-output-validation.ts";

// Focused unit tests for the reviewer-output-validation leaf module (#155). These pure
// trust-boundary functions were module-private before the split and only exercised end-to-end
// via FakePiProcessRunner; this suite pins their load-bearing safety invariants directly. They
// are imported from the module (not the public barrel) — the same pattern as
// structured-tool-output.test.ts — because they must not be part of the package's public surface.

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "correctness",
    title: "Example finding",
    body: "Example body",
    confidence: "high",
    evidence: ["line 1"],
    recommendation: "Fix it",
    ...overrides,
  };
}

describe("parseReviewerOutput", () => {
  test("returns an empty result for a genuinely empty findings array (clean review)", () => {
    const result = parseReviewerOutput('{"findings": []}');
    expect(result.findings).toEqual([]);
    expect(result.droppedFindingCount).toBe(0);
  });

  test("parses and keeps a single valid finding", () => {
    const result = parseReviewerOutput(
      JSON.stringify({
        findings: [
          {
            reviewer: "security",
            severity: "critical",
            category: "auth",
            title: "SQL injection",
            body: "Unparameterized query",
            confidence: "high",
            evidence: ["q = `select ... ${id}`"],
            recommendation: "Parameterize",
          },
        ],
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("SQL injection");
    expect(result.droppedFindingCount).toBe(0);
  });

  test("THROWS when a non-empty findings array yields zero valid findings (false-approval guard)", () => {
    // Every element is structurally invalid (missing required fields). A non-empty array that
    // salvages nothing is a failed reviewer, NOT a clean approval — it must surface as a
    // classified failure (#120 degrade path), never a silent empty/approve summary.
    expect(() => parseReviewerOutput('{"findings": [{"nope": 1}, {"also": "bad"}]}')).toThrow(
      "all findings failed validation",
    );
  });

  test("drops one invalid finding while keeping its valid sibling, and counts the drop", () => {
    const result = parseReviewerOutput(
      JSON.stringify({
        findings: [
          { nope: 1 },
          {
            reviewer: "security",
            severity: "warning",
            category: "correctness",
            title: "Valid one",
            body: "body",
            confidence: "medium",
            evidence: ["e"],
            recommendation: "fix",
          },
        ],
      }),
    );
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe("Valid one");
    expect(result.droppedFindingCount).toBe(1);
  });
});

describe("enforceReviewerRole", () => {
  test("normalizes a mismatched reviewer label to the dispatched role and records the adjustment", () => {
    const findings = [makeFinding({ reviewer: "Correctness Reviewer" })];
    const { findings: normalized, adjustments } = enforceReviewerRole(findings, "security");
    expect(normalized[0]?.reviewer).toBe("security");
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.emittedReviewer).toBe("Correctness Reviewer");
    expect(adjustments[0]?.dispatchedRole).toBe("security");
    expect(adjustments[0]?.reason).toBe("reviewer_role_mismatch");
  });

  test("leaves a matching reviewer untouched with no adjustments", () => {
    const findings = [makeFinding({ reviewer: "security" })];
    const { findings: normalized, adjustments } = enforceReviewerRole(findings, "security");
    expect(normalized[0]?.reviewer).toBe("security");
    expect(adjustments).toEqual([]);
  });
});

describe("enforceReviewerAllowedSeverities", () => {
  test("downgrades an out-of-set severity to the max allowed and records the adjustment", () => {
    const findings = [makeFinding({ severity: "critical" })];
    const allowed: Severity[] = ["suggestion", "warning"];
    const { findings: normalized, adjustments } = enforceReviewerAllowedSeverities(
      findings,
      allowed,
    );
    expect(normalized[0]?.severity).toBe("warning"); // max of the allowed set
    expect(adjustments).toHaveLength(1);
    expect(adjustments[0]?.originalSeverity).toBe("critical");
    expect(adjustments[0]?.adjustedSeverity).toBe("warning");
    expect(adjustments[0]?.reason).toBe("reviewer_severity_not_allowed");
  });

  test("an EMPTY allowed-severities set passes all findings through unchanged (no max to clamp to)", () => {
    const findings = [makeFinding({ severity: "critical" })];
    const { findings: normalized, adjustments } = enforceReviewerAllowedSeverities(findings, []);
    expect(normalized).toEqual(findings);
    expect(adjustments).toEqual([]);
  });
});
