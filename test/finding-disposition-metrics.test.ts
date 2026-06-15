/**
 * Tests for computeDispositions (#256, M023 S04).
 *
 * Verifies:
 *  - dispositions block emitted with correct counts + byReviewer/bySeverity on a re-review fixture
 *  - counts-only (no finding text in the block)
 *  - absent on first review (no classifications / undefined)
 */

import { describe, expect, test } from "bun:test";
import type { Finding, ReReviewFindingClassification } from "../src/contracts/index.ts";
import { computeDispositions } from "../src/runner/run-metrics.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "code_quality",
    severity: "warning",
    category: "correctness",
    title: "Test finding",
    body: "body",
    confidence: "high",
    evidence: [],
    recommendation: "fix it",
    location: { path: "src/foo.ts" },
    ...overrides,
  };
}

function cls(
  status: ReReviewFindingClassification["status"],
  finding?: Finding,
  priorFinding?: Finding,
): ReReviewFindingClassification {
  return {
    stableId: `id-${Math.random()}`,
    status,
    ...(finding !== undefined ? { finding } : {}),
    ...(priorFinding !== undefined ? { priorFinding } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeDispositions", () => {
  test("returns undefined when no classifications (first review)", () => {
    expect(computeDispositions(undefined)).toBeUndefined();
    expect(computeDispositions([])).toBeUndefined();
  });

  test("returns undefined when all classifications are excluded statuses (new only)", () => {
    const classifications = [cls("new", makeFinding()), cls("new", makeFinding())];
    expect(computeDispositions(classifications)).toBeUndefined();
  });

  test("counts fixed correctly", () => {
    const priorFinding = makeFinding({ reviewer: "security", severity: "critical" });
    const classifications = [cls("fixed", undefined, priorFinding)];
    const result = computeDispositions(classifications);
    expect(result).not.toBeUndefined();
    expect(result?.fixed).toBe(1);
    expect(result?.dismissed).toBe(0);
    expect(result?.ignored).toBe(0);
    expect(result?.acknowledged).toBe(0);
  });

  test("counts ignored correctly (recurring, no ack)", () => {
    const liveFinding = makeFinding({ reviewer: "code_quality", severity: "warning" });
    const classifications = [cls("recurring", liveFinding)];
    const result = computeDispositions(classifications);
    expect(result?.ignored).toBe(1);
    expect(result?.fixed).toBe(0);
  });

  test("counts dismissed correctly (recurring with dismissed ack)", () => {
    const liveFinding = makeFinding({
      reviewer: "documentation",
      severity: "suggestion",
      acknowledged: { reason: "wrong", verdict: "dismissed" },
    });
    const classifications = [cls("recurring", liveFinding)];
    const result = computeDispositions(classifications);
    expect(result?.dismissed).toBe(1);
    expect(result?.ignored).toBe(0);
  });

  test("counts acknowledged correctly (recurring with ack, no verdict)", () => {
    const liveFinding = makeFinding({
      reviewer: "security",
      severity: "warning",
      acknowledged: { reason: "known" },
    });
    const classifications = [cls("recurring", liveFinding)];
    const result = computeDispositions(classifications);
    expect(result?.acknowledged).toBe(1);
  });

  test("byReviewer and bySeverity are populated with stable-sorted keys", () => {
    const securityFixed = makeFinding({ reviewer: "security", severity: "critical" });
    const cqIgnored = makeFinding({ reviewer: "code_quality", severity: "warning" });
    const cqDismissed = makeFinding({
      reviewer: "code_quality",
      severity: "critical",
      acknowledged: { reason: "x", verdict: "dismissed" },
    });

    const classifications = [
      cls("fixed", undefined, securityFixed),
      cls("recurring", cqIgnored),
      cls("recurring", cqDismissed),
    ];

    const result = computeDispositions(classifications);
    expect(result).not.toBeUndefined();

    // Totals
    expect(result?.fixed).toBe(1);
    expect(result?.ignored).toBe(1);
    expect(result?.dismissed).toBe(1);
    expect(result?.acknowledged).toBe(0);

    // byReviewer — stable sorted keys
    const reviewerKeys = Object.keys(result?.byReviewer ?? {});
    expect(reviewerKeys).toEqual(["code_quality", "security"]); // sorted

    expect(result?.byReviewer?.["code_quality"]).toEqual({
      fixed: 0,
      dismissed: 1,
      ignored: 1,
      acknowledged: 0,
    });
    expect(result?.byReviewer?.["security"]).toEqual({
      fixed: 1,
      dismissed: 0,
      ignored: 0,
      acknowledged: 0,
    });

    // bySeverity — stable sorted keys
    const severityKeys = Object.keys(result?.bySeverity ?? {});
    expect(severityKeys).toEqual(["critical", "warning"]); // sorted

    expect(result?.bySeverity?.["critical"]).toEqual({
      fixed: 1,
      dismissed: 1,
      ignored: 0,
      acknowledged: 0,
    });
    expect(result?.bySeverity?.["warning"]).toEqual({
      fixed: 0,
      dismissed: 0,
      ignored: 1,
      acknowledged: 0,
    });
  });

  test("excluded statuses (new/withheld/carried_forward) are not counted", () => {
    const classifications = [
      cls("new", makeFinding()),
      cls("withheld", undefined, makeFinding()),
      cls("carried_forward", undefined, makeFinding()),
    ];
    expect(computeDispositions(classifications)).toBeUndefined();
  });

  test("mixed: excluded + dispositioned → only dispositioned counted", () => {
    const fixed = makeFinding({ reviewer: "security", severity: "critical" });
    const classifications = [
      cls("new", makeFinding()),
      cls("fixed", undefined, fixed),
      cls("withheld", undefined, makeFinding()),
    ];
    const result = computeDispositions(classifications);
    expect(result?.fixed).toBe(1);
    expect(result?.ignored).toBe(0);
  });

  // Counts-only: the returned object must NOT contain finding titles/bodies/paths
  test("counts-only: result contains no finding text content (M008 egress boundary)", () => {
    const finding = makeFinding({
      title: "SECRET_TITLE_XYZ",
      body: "SECRET_BODY_XYZ",
      location: { path: "SECRET_PATH_XYZ/file.ts" },
    });
    const classifications = [cls("recurring", finding)];
    const result = computeDispositions(classifications);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SECRET_TITLE_XYZ");
    expect(serialized).not.toContain("SECRET_BODY_XYZ");
    expect(serialized).not.toContain("SECRET_PATH_XYZ");
  });
});
