/**
 * Acceptance tests for the M016 S02 (#130) release-gated holdout eval + quality stamp.
 *
 * These tests are DETERMINISTIC — no runtime, no tokens, no I/O.
 * They prove that:
 *   1. A regressed reviewer (misses the bug) blocks the gate.  ← THE red test (#130 acceptance)
 *   2. A good reviewer (catches the bug) passes the gate.
 *   3. An empty holdout blocks (fail-toward-not-shipping).
 *   4. A mixed result (one pass, one fail) blocks.
 *   5. buildQualityStamp produces the correct schema shape with counts/scores only.
 */

import { describe, expect, test } from "bun:test";
import type { Finding, ReviewSummary, RiskAssessment } from "../src/contracts/index.ts";
import type { EvalScenario } from "../src/evals/index.ts";
import { buildQualityStamp, scoreScenario, summarizeEvalRun } from "../src/evals/index.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const baseRisk: RiskAssessment = {
  tier: "full",
  reason: "test",
  matchedRules: [],
  sensitivePaths: [],
  reviewedFileCount: 1,
  ignoredFileCount: 0,
};

function makeSummary(
  findings: Finding[],
  decision: ReviewSummary["decision"] = "approved",
  outcome: ReviewSummary["outcome"] = "neutral",
): ReviewSummary {
  return {
    decision,
    outcome,
    title: "Test review",
    body: "Test body",
    findings,
    risk: baseRisk,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "critical",
    category: "injection",
    title: "SQL injection vulnerability",
    body: "User input injected directly into query string",
    confidence: "high",
    evidence: ["query = `SELECT...${userId}`"],
    recommendation: "Use parameterized queries to prevent injection",
    ...overrides,
  };
}

/**
 * A holdout-shaped scenario mirroring evals/scenarios/auth-sqli.json:
 * requires a has_finding at minSeverity critical + decision_in non-approved.
 */
const holdoutScenario: EvalScenario = {
  name: "auth-sqli-holdout",
  description: "Regression check: SQL injection must be caught at critical severity",
  fixture: "evals/fixtures/auth-sqli.json",
  criteria: [
    {
      kind: "has_finding",
      label: "flags SQL injection at critical severity",
      minSeverity: "critical",
      textIncludes: "inject",
    },
    {
      kind: "decision_in",
      label: "decision is not approved",
      values: ["significant_concerns", "minor_issues"],
    },
  ],
};

// ---------------------------------------------------------------------------
// 1. Regressed reviewer blocks the gate (THE red test — #130 acceptance)
// ---------------------------------------------------------------------------

describe("release gate — regressed reviewer blocks", () => {
  // #130 acceptance: a deliberately-bad/regressed reviewer (misses the bug, empty findings,
  // approves) fails the gate and blocks pack. This is the load-bearing red test for M016 S02.
  test("a reviewer that misses the bug (empty findings, approved) fails the scenario → gate is blocked", () => {
    // Regressed reviewer: no findings, approved decision — completely missed the SQL injection
    const regressedSummary = makeSummary([], "approved", "pass");
    const score = scoreScenario(holdoutScenario, [regressedSummary], 0.8);

    // The reviewer failed: did not catch the bug
    expect(score.passed).toBe(false);
    expect(score.satisfaction).toBe(0); // neither criterion met

    const runSummary = summarizeEvalRun([score]);
    // The gate MUST be blocked: passed=0, total=1
    expect(runSummary.passed).toBe(0);
    expect(runSummary.total).toBe(1);
    expect(runSummary.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Good reviewer passes
// ---------------------------------------------------------------------------

describe("release gate — good reviewer passes", () => {
  test("a reviewer that catches the bug (critical finding + non-approved decision) passes", () => {
    const criticalFinding = makeFinding({
      severity: "critical",
      title: "SQL injection risk",
      body: "Untrusted input directly injected into query",
    });
    const goodSummary = makeSummary([criticalFinding], "significant_concerns", "fail");
    const score = scoreScenario(holdoutScenario, [goodSummary], 0.8);

    expect(score.passed).toBe(true);
    expect(score.satisfaction).toBe(1); // both criteria met

    const runSummary = summarizeEvalRun([score]);
    expect(runSummary.passed).toBe(1);
    expect(runSummary.total).toBe(1);
    expect(runSummary.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Empty holdout blocks (fail-toward-not-shipping)
// ---------------------------------------------------------------------------

describe("release gate — empty holdout", () => {
  test("summarizeEvalRun([]) blocks (empty holdout must never silently pass)", () => {
    const runSummary = summarizeEvalRun([]);
    expect(runSummary.blocked).toBe(true);
    expect(runSummary.total).toBe(0);
    expect(runSummary.passed).toBe(0);
    expect(runSummary.meanSatisfaction).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Mixed (one pass, one fail) blocks
// ---------------------------------------------------------------------------

describe("release gate — mixed results", () => {
  test("one passing + one failing scenario → blocked=true, passed=1, total=2", () => {
    const criticalFinding = makeFinding();
    const goodSummary = makeSummary([criticalFinding], "significant_concerns", "fail");
    const goodScore = scoreScenario(holdoutScenario, [goodSummary], 0.8);

    const regressedSummary = makeSummary([], "approved", "pass");
    const badScore = scoreScenario(holdoutScenario, [regressedSummary], 0.8);

    const runSummary = summarizeEvalRun([goodScore, badScore]);
    expect(runSummary.blocked).toBe(true);
    expect(runSummary.passed).toBe(1);
    expect(runSummary.total).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. buildQualityStamp shape
// ---------------------------------------------------------------------------

describe("buildQualityStamp", () => {
  const FIXED_DATE = "2026-01-01T00:00:00.000Z"; // fixed literal — no Date in tests

  test("stamp has correct schemaVersion and blocked matches summarizeEvalRun", () => {
    const criticalFinding = makeFinding();
    const goodSummary = makeSummary([criticalFinding], "significant_concerns", "fail");
    const goodScore = scoreScenario(holdoutScenario, [goodSummary], 0.8);

    const regressedSummary = makeSummary([], "approved", "pass");
    const badScore = scoreScenario(holdoutScenario, [regressedSummary], 0.8);

    const results = [goodScore, badScore];
    const meta = {
      generatedAt: FIXED_DATE,
      commit: "abc123def456",
      runtime: "pi",
      model: "claude-sonnet-4-6",
      runs: 3,
      threshold: 0.8,
    };

    const stamp = buildQualityStamp(results, meta);
    const runSummary = summarizeEvalRun(results);

    expect(stamp.schemaVersion).toBe("ai-review.quality_stamp.v1");
    expect(stamp.blocked).toBe(runSummary.blocked);
    expect(stamp.blocked).toBe(true); // because one scenario failed
  });

  test("stamp passes through all meta fields", () => {
    const stamp = buildQualityStamp([], {
      generatedAt: FIXED_DATE,
      commit: "deadbeef",
      runtime: "pi",
      model: null,
      runs: 5,
      threshold: 0.9,
    });

    expect(stamp.generatedAt).toBe(FIXED_DATE);
    expect(stamp.commit).toBe("deadbeef");
    expect(stamp.runtime).toBe("pi");
    expect(stamp.model).toBeNull();
    expect(stamp.runs).toBe(5);
    expect(stamp.threshold).toBe(0.9);
  });

  test("stamp scenarios[] mirror satisfaction/threshold/passed/runCount from inputs", () => {
    const criticalFinding = makeFinding();
    const goodSummary = makeSummary([criticalFinding], "significant_concerns", "fail");
    const goodScore = scoreScenario(holdoutScenario, [goodSummary], 0.8);

    const regressedSummary = makeSummary([], "approved", "pass");
    const badScore = scoreScenario(holdoutScenario, [regressedSummary], 0.8);

    const stamp = buildQualityStamp([goodScore, badScore], {
      generatedAt: FIXED_DATE,
      commit: null,
      runtime: "pi",
      model: null,
      runs: 1,
      threshold: 0.8,
    });

    expect(stamp.scenarios).toHaveLength(2);

    const goodScenario = stamp.scenarios[0];
    expect(goodScenario?.satisfaction).toBe(goodScore.satisfaction);
    expect(goodScenario?.threshold).toBe(goodScore.threshold);
    expect(goodScenario?.passed).toBe(true);
    expect(goodScenario?.runCount).toBe(1);

    const badScenario = stamp.scenarios[1];
    expect(badScenario?.satisfaction).toBe(badScore.satisfaction);
    expect(badScenario?.threshold).toBe(badScore.threshold);
    expect(badScenario?.passed).toBe(false);
    expect(badScenario?.runCount).toBe(1);
  });

  test("stamp contains NO finding-text fields — counts/scores only", () => {
    const criticalFinding = makeFinding({
      body: "SENSITIVE_FINDING_BODY_THAT_MUST_NOT_APPEAR_IN_STAMP",
      title: "SENSITIVE_TITLE",
      evidence: ["SENSITIVE_EVIDENCE"],
      recommendation: "SENSITIVE_RECOMMENDATION",
    });
    const summary = makeSummary([criticalFinding], "significant_concerns", "fail");
    const score = scoreScenario(holdoutScenario, [summary], 0.8);

    const stamp = buildQualityStamp([score], {
      generatedAt: FIXED_DATE,
      commit: null,
      runtime: "pi",
      model: null,
      runs: 1,
      threshold: 0.8,
    });

    // Serialize to JSON and verify no sensitive finding content leaks into the stamp
    const stampJson = JSON.stringify(stamp);
    expect(stampJson).not.toContain("SENSITIVE_FINDING_BODY_THAT_MUST_NOT_APPEAR_IN_STAMP");
    expect(stampJson).not.toContain("SENSITIVE_TITLE");
    expect(stampJson).not.toContain("SENSITIVE_EVIDENCE");
    expect(stampJson).not.toContain("SENSITIVE_RECOMMENDATION");

    // Also verify that the scenario keys are only counts/scores
    const scenario = stamp.scenarios[0];
    expect(scenario).toBeDefined();
    if (scenario !== undefined) {
      const scenarioKeys = Object.keys(scenario);
      expect(scenarioKeys).toEqual(
        expect.arrayContaining(["name", "satisfaction", "threshold", "passed", "runCount"]),
      );
      // Exactly these 5 keys — no extra fields
      expect(scenarioKeys).toHaveLength(5);
    }
  });
});
