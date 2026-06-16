import { describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import type { EvalScenario } from "../src/evals/index.ts";
import { evaluateCriterion, scoreRun, scoreScenario } from "../src/evals/index.ts";
import type { Finding, ReviewSummary, RiskAssessment } from "../src/index.ts";
import { normalizeReviewConfig } from "../src/index.ts";

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

const baseFinding: Finding = {
  reviewer: "security",
  severity: "warning",
  category: "injection",
  title: "SQL injection risk",
  body: "User input concatenated into query string",
  location: { path: "auth/login.ts", line: 5 },
  confidence: "high",
  evidence: ["query = `SELECT...${username}`"],
  recommendation: "Use parameterized queries",
};

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return { ...baseFinding, ...overrides };
}

function makeSummary(
  findings: Finding[],
  decision: ReviewSummary["decision"] = "approved",
  outcome: ReviewSummary["outcome"] = "pass",
  overrides: Partial<ReviewSummary> = {},
): ReviewSummary {
  return {
    decision,
    outcome,
    title: "Test review",
    body: "Test body",
    findings,
    risk: baseRisk,
    ...overrides,
  };
}

const baseScenario: EvalScenario = {
  name: "test",
  description: "test scenario",
  fixture: "evals/fixtures/clean-refactor.json",
  criteria: [],
};

// ---------------------------------------------------------------------------
// evaluateCriterion — has_finding
// ---------------------------------------------------------------------------

describe("evaluateCriterion — has_finding", () => {
  test("matches when a finding satisfies all filters", () => {
    const summary = makeSummary([makeFinding()]);
    expect(
      evaluateCriterion(
        { kind: "has_finding", label: "test", reviewer: "security", category: "injection" },
        summary,
      ),
    ).toBe(true);
  });

  test("returns false when no finding matches", () => {
    const summary = makeSummary([]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", reviewer: "security" }, summary),
    ).toBe(false);
  });

  test("minSeverity: warning finding satisfies minSeverity warning (boundary: same level passes)", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", minSeverity: "warning" }, summary),
    ).toBe(true);
  });

  test("minSeverity: warning finding does NOT satisfy minSeverity critical", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", minSeverity: "critical" }, summary),
    ).toBe(false);
  });

  test("minSeverity: critical finding satisfies minSeverity warning (higher rank passes lower threshold)", () => {
    const summary = makeSummary([makeFinding({ severity: "critical" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", minSeverity: "warning" }, summary),
    ).toBe(true);
  });

  test("severity exact: critical finding does NOT match severity warning", () => {
    const summary = makeSummary([makeFinding({ severity: "critical" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", severity: "warning" }, summary),
    ).toBe(false);
  });

  test("category filter: case-insensitive match", () => {
    const summary = makeSummary([makeFinding({ category: "Injection" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", category: "injection" }, summary),
    ).toBe(true);
  });

  test("reviewer filter: case-insensitive match", () => {
    const summary = makeSummary([makeFinding({ reviewer: "Security" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", reviewer: "security" }, summary),
    ).toBe(true);
  });

  test("pathIncludes: case-insensitive substring of location.path", () => {
    const summary = makeSummary([makeFinding({ location: { path: "AUTH/login.ts" } })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", pathIncludes: "auth" }, summary),
    ).toBe(true);
  });

  test("textIncludes: matches substring in finding.title (case-insensitive)", () => {
    const summary = makeSummary([makeFinding({ title: "SQL Injection Risk" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", textIncludes: "inject" }, summary),
    ).toBe(true);
  });

  test("textIncludes: matches substring in finding.body (case-insensitive)", () => {
    const summary = makeSummary([makeFinding({ body: "User input is INJECTED into query" })]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", textIncludes: "injected" }, summary),
    ).toBe(true);
  });

  test("textIncludes: matches substring in finding.evidence[] (case-insensitive)", () => {
    const summary = makeSummary([makeFinding({ evidence: ["Parameterized query missing"] })]);
    expect(
      evaluateCriterion(
        { kind: "has_finding", label: "test", textIncludes: "parameterized" },
        summary,
      ),
    ).toBe(true);
  });

  test("textIncludes: matches substring found only in finding.recommendation (#85 review)", () => {
    const summary = makeSummary([
      makeFinding({
        title: "Issue",
        body: "see fix",
        evidence: ["n/a"],
        recommendation: "Switch to a prepared statement to remediate",
      }),
    ]);
    expect(
      evaluateCriterion(
        { kind: "has_finding", label: "test", textIncludes: "prepared statement" },
        summary,
      ),
    ).toBe(true);
  });

  test("textIncludes: returns false when substring is absent", () => {
    const summary = makeSummary([
      makeFinding({ title: "Missing auth check", body: "No ownership verification" }),
    ]);
    expect(
      evaluateCriterion({ kind: "has_finding", label: "test", textIncludes: "inject" }, summary),
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // textIncludesAny — OR-semantics across needle list
  // ---------------------------------------------------------------------------

  test("textIncludesAny: matches logic-bug vocab needle 'off-by-one' in title", () => {
    const summary = makeSummary([
      makeFinding({ title: "Off-by-one in page end", body: "End index is wrong." }),
    ]);
    expect(
      evaluateCriterion(
        {
          kind: "has_finding",
          label: "test",
          minSeverity: "warning",
          textIncludesAny: [
            "off-by-one",
            "off by one",
            "off-by one",
            "boundary",
            "out of range",
            "extra item",
            "one more",
            "pagination",
            "slice",
            "index",
          ],
        },
        summary,
      ),
    ).toBe(true);
  });

  test("textIncludesAny: matches hardcoded-secret vocab needle 'api key' (case-insensitive)", () => {
    const summary = makeSummary([
      makeFinding({
        severity: "warning",
        title: "Hardcoded API key committed in source",
        body: "The value was found inline.",
      }),
    ]);
    expect(
      evaluateCriterion(
        {
          kind: "has_finding",
          label: "test",
          minSeverity: "warning",
          textIncludesAny: [
            "secret",
            "credential",
            "api key",
            "api_key",
            "apikey",
            "token",
            "password",
            "hardcoded",
          ],
        },
        summary,
      ),
    ).toBe(true);
  });

  test("textIncludesAny: unrelated finding matches neither logic-bug nor secret vocab", () => {
    const summary = makeSummary([
      makeFinding({
        title: "Missing JSDoc on exported function",
        body: "The function lacks documentation.",
        recommendation: "Add a JSDoc comment.",
        evidence: [],
      }),
    ]);
    const logicBugResult = evaluateCriterion(
      {
        kind: "has_finding",
        label: "test",
        minSeverity: "warning",
        textIncludesAny: [
          "off-by-one",
          "off by one",
          "off-by one",
          "boundary",
          "out of range",
          "extra item",
          "one more",
          "pagination",
          "slice",
          "index",
        ],
      },
      summary,
    );
    const secretResult = evaluateCriterion(
      {
        kind: "has_finding",
        label: "test",
        minSeverity: "warning",
        textIncludesAny: [
          "secret",
          "credential",
          "api key",
          "api_key",
          "apikey",
          "token",
          "password",
          "hardcoded",
        ],
      },
      summary,
    );
    expect(logicBugResult).toBe(false);
    expect(secretResult).toBe(false);
  });

  test("textIncludesAny: returns false when no needle matches (OR semantics)", () => {
    const summary = makeSummary([
      makeFinding({ title: "Missing null check", body: "Dereference without guard." }),
    ]);
    expect(
      evaluateCriterion(
        { kind: "has_finding", label: "test", textIncludesAny: ["secret", "token", "password"] },
        summary,
      ),
    ).toBe(false);
  });

  test("textIncludesAny + textIncludes: BOTH must match the same finding (AND semantics)", () => {
    // Finding matches textIncludesAny("token") but NOT textIncludes("hardcoded") — should fail
    const summaryPartial = makeSummary([
      makeFinding({
        title: "Token used in URL",
        body: "The access token is passed as a query param.",
      }),
    ]);
    expect(
      evaluateCriterion(
        {
          kind: "has_finding",
          label: "test",
          textIncludes: "hardcoded",
          textIncludesAny: ["token", "password"],
        },
        summaryPartial,
      ),
    ).toBe(false);

    // Finding matches BOTH textIncludes("hardcoded") AND textIncludesAny("token") — should pass
    const summaryBoth = makeSummary([
      makeFinding({
        title: "Hardcoded token in source",
        body: "The value is committed directly.",
      }),
    ]);
    expect(
      evaluateCriterion(
        {
          kind: "has_finding",
          label: "test",
          textIncludes: "hardcoded",
          textIncludesAny: ["token", "password"],
        },
        summaryBoth,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — no_findings_at_or_above
// ---------------------------------------------------------------------------

describe("evaluateCriterion — no_findings_at_or_above", () => {
  test("true when summary has only suggestions (below warning)", () => {
    const summary = makeSummary([makeFinding({ severity: "suggestion" })]);
    expect(
      evaluateCriterion(
        { kind: "no_findings_at_or_above", label: "test", severity: "warning" },
        summary,
      ),
    ).toBe(true);
  });

  test("false when summary has a warning finding (severity matches threshold)", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(
      evaluateCriterion(
        { kind: "no_findings_at_or_above", label: "test", severity: "warning" },
        summary,
      ),
    ).toBe(false);
  });

  test("false when summary has a critical finding (above warning threshold)", () => {
    const summary = makeSummary([makeFinding({ severity: "critical" })]);
    expect(
      evaluateCriterion(
        { kind: "no_findings_at_or_above", label: "test", severity: "warning" },
        summary,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — max_findings
// ---------------------------------------------------------------------------

describe("evaluateCriterion — max_findings", () => {
  test("passes when finding count is below cap", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(
      evaluateCriterion(
        { kind: "max_findings", label: "test", count: 2, atOrAbove: "warning" },
        summary,
      ),
    ).toBe(true);
  });

  test("fails when finding count exceeds cap", () => {
    const summary = makeSummary([
      makeFinding({ severity: "warning" }),
      makeFinding({ severity: "critical" }),
    ]);
    expect(
      evaluateCriterion(
        { kind: "max_findings", label: "test", count: 1, atOrAbove: "warning" },
        summary,
      ),
    ).toBe(false);
  });

  test("default atOrAbove is suggestion (counts all findings)", () => {
    // 3 findings at suggestion level, cap is 2 — should fail
    const summary = makeSummary([
      makeFinding({ severity: "suggestion" }),
      makeFinding({ severity: "suggestion" }),
      makeFinding({ severity: "suggestion" }),
    ]);
    expect(evaluateCriterion({ kind: "max_findings", label: "test", count: 2 }, summary)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — decision_in / outcome_is
// ---------------------------------------------------------------------------

describe("evaluateCriterion — decision_in", () => {
  test("true when decision is in values", () => {
    const summary = makeSummary([], "approved");
    expect(
      evaluateCriterion(
        { kind: "decision_in", label: "test", values: ["approved", "approved_with_comments"] },
        summary,
      ),
    ).toBe(true);
  });

  test("false when decision is not in values", () => {
    const summary = makeSummary([], "significant_concerns");
    expect(
      evaluateCriterion(
        { kind: "decision_in", label: "test", values: ["approved", "approved_with_comments"] },
        summary,
      ),
    ).toBe(false);
  });
});

describe("evaluateCriterion — outcome_is", () => {
  test("true when outcome matches", () => {
    const summary = makeSummary([], "approved", "pass");
    expect(evaluateCriterion({ kind: "outcome_is", label: "test", value: "pass" }, summary)).toBe(
      true,
    );
  });

  test("false when outcome does not match", () => {
    const summary = makeSummary([], "significant_concerns", "fail");
    expect(evaluateCriterion({ kind: "outcome_is", label: "test", value: "pass" }, summary)).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — reviewer_not_failed
// ---------------------------------------------------------------------------

describe("evaluateCriterion — reviewer_not_failed", () => {
  test("passes when summary has no degraded reviewer-failure block", () => {
    const summary = makeSummary([]);
    expect(
      evaluateCriterion(
        { kind: "reviewer_not_failed", label: "code_quality completed", reviewer: "code_quality" },
        summary,
      ),
    ).toBe(true);
  });

  test("passes when degraded block names other failed reviewers only", () => {
    const summary = makeSummary([], "approved", "pass", {
      degraded: {
        failedReviewerCount: 1,
        completedReviewerCount: 2,
        failedRoles: ["security"],
      },
    });

    expect(
      evaluateCriterion(
        { kind: "reviewer_not_failed", label: "code_quality completed", reviewer: "code_quality" },
        summary,
      ),
    ).toBe(true);
  });

  test("fails on exact case-insensitive reviewer match in failedRoles", () => {
    const summary = makeSummary([], "approved", "pass", {
      degraded: {
        failedReviewerCount: 1,
        completedReviewerCount: 2,
        failedRoles: ["Code_Quality"],
      },
    });

    expect(
      evaluateCriterion(
        { kind: "reviewer_not_failed", label: "code_quality completed", reviewer: "code_quality" },
        summary,
      ),
    ).toBe(false);
  });

  test("does not fail on substring-only reviewer matches", () => {
    const summary = makeSummary([], "approved", "pass", {
      degraded: {
        failedReviewerCount: 1,
        completedReviewerCount: 2,
        failedRoles: ["code_quality_extra"],
      },
    });

    expect(
      evaluateCriterion(
        { kind: "reviewer_not_failed", label: "code_quality completed", reviewer: "code_quality" },
        summary,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — partial_by_size
// ---------------------------------------------------------------------------

describe("evaluateCriterion — partial_by_size", () => {
  test("fails when partialBySize is absent", () => {
    const summary = makeSummary([]);
    expect(evaluateCriterion({ kind: "partial_by_size", label: "demoted files" }, summary)).toBe(
      false,
    );
  });

  test("passes when partialBySize is present and count thresholds are met", () => {
    const summary = makeSummary([], "approved", "pass", {
      partialBySize: {
        admittedFileCount: 2,
        droppedFileCount: 3,
        originalBytes: 10_000,
        admittedBytes: 4_000,
        budgetBytes: 5_000,
        droppedPaths: ["test/fixtures/a.json", "test/fixtures/b.json", "snapshots/c.snap"],
      },
    });

    expect(
      evaluateCriterion(
        {
          kind: "partial_by_size",
          label: "bulk demotion was visible",
          minDroppedFileCount: 1,
          minAdmittedFileCount: 1,
        },
        summary,
      ),
    ).toBe(true);
  });

  test("fails when dropped-file minimum is not met", () => {
    const summary = makeSummary([], "approved", "pass", {
      partialBySize: {
        admittedFileCount: 2,
        droppedFileCount: 0,
        originalBytes: 4_000,
        admittedBytes: 4_000,
        budgetBytes: 5_000,
        droppedPaths: [],
      },
    });

    expect(
      evaluateCriterion(
        { kind: "partial_by_size", label: "bulk demotion was visible", minDroppedFileCount: 1 },
        summary,
      ),
    ).toBe(false);
  });

  test("fails when admitted-file minimum is not met", () => {
    const summary = makeSummary([], "approved", "pass", {
      partialBySize: {
        admittedFileCount: 0,
        droppedFileCount: 3,
        originalBytes: 10_000,
        admittedBytes: 0,
        budgetBytes: 500,
        droppedPaths: ["test/fixtures/a.json", "test/fixtures/b.json", "snapshots/c.snap"],
      },
    });

    expect(
      evaluateCriterion(
        { kind: "partial_by_size", label: "logic stayed admitted", minAdmittedFileCount: 1 },
        summary,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreRun
// ---------------------------------------------------------------------------

describe("scoreRun", () => {
  test("3 of 4 criteria met → satisfaction = 0.75", () => {
    const summary = makeSummary([makeFinding({ severity: "suggestion" })], "approved", "pass");
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        { kind: "outcome_is", label: "pass", value: "pass" },
        { kind: "decision_in", label: "approved", values: ["approved"] },
        { kind: "no_findings_at_or_above", label: "no warnings", severity: "warning" },
        // This will fail: we have no critical finding
        { kind: "has_finding", label: "has critical", minSeverity: "critical" },
      ],
    };
    const result = scoreRun(scenario, summary);
    expect(result.met).toBe(3);
    expect(result.total).toBe(4);
    expect(result.satisfaction).toBe(0.75);
  });

  test("all criteria met → satisfaction = 1", () => {
    const summary = makeSummary([], "approved", "pass");
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        { kind: "outcome_is", label: "pass", value: "pass" },
        { kind: "decision_in", label: "approved", values: ["approved"] },
      ],
    };
    const result = scoreRun(scenario, summary);
    expect(result.satisfaction).toBe(1);
    expect(result.met).toBe(2);
  });

  test("empty criteria → satisfaction = 1 (zero-criteria edge case)", () => {
    const summary = makeSummary([]);
    const scenario: EvalScenario = { ...baseScenario, criteria: [] };
    const result = scoreRun(scenario, summary);
    expect(result.satisfaction).toBe(1);
    expect(result.total).toBe(0);
  });

  test("results array has correct label and met for each criterion", () => {
    const summary = makeSummary([], "approved", "pass");
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        { kind: "outcome_is", label: "outcome-label", value: "pass" },
        { kind: "has_finding", label: "finding-label", minSeverity: "warning" },
      ],
    };
    const result = scoreRun(scenario, summary);
    expect(result.results[0]).toEqual({ label: "outcome-label", met: true });
    expect(result.results[1]).toEqual({ label: "finding-label", met: false });
  });
});

// ---------------------------------------------------------------------------
// scoreScenario
// ---------------------------------------------------------------------------

describe("scoreScenario", () => {
  const scenarioWithTwoCriteria: EvalScenario = {
    ...baseScenario,
    criteria: [
      { kind: "outcome_is", label: "pass", value: "pass" },
      { kind: "decision_in", label: "approved", values: ["approved"] },
    ],
  };

  test("two runs (1.0 and 0.5) → overall satisfaction = 0.75", () => {
    // Run 1: both criteria met (satisfaction = 1.0)
    const s1 = makeSummary([], "approved", "pass");
    // Run 2: only one of two criteria met (satisfaction = 0.5)
    const s2 = makeSummary([], "significant_concerns", "pass");
    const result = scoreScenario(scenarioWithTwoCriteria, [s1, s2], 0.8);
    expect(result.satisfaction).toBe(0.75);
    expect(result.runSatisfactions).toEqual([1, 0.5]);
    expect(result.minSatisfaction).toBe(0.5);
    expect(result.maxSatisfaction).toBe(1);
    expect(result.variance).toBe(0.0625);
    expect(result.flaky).toBe(true);
    expect(result.runCount).toBe(2);
  });

  test("perCriterion pass rate: criterion met in 1 of 2 runs → passRate = 0.5", () => {
    const s1 = makeSummary([], "approved", "pass"); // both met
    const s2 = makeSummary([], "significant_concerns", "pass"); // only outcome met
    const result = scoreScenario(scenarioWithTwoCriteria, [s1, s2], 0.8);
    // "pass" outcome: met in both runs → 1.0
    expect(result.perCriterion[0]?.passRate).toBe(1.0);
    expect(result.perCriterion[0]?.critical).toBe(false);
    expect(result.perCriterion[0]?.requiredPassRate).toBeNull();
    expect(result.perCriterion[0]?.passed).toBe(true);
    // "approved" decision: met only in run 1 → 0.5
    expect(result.perCriterion[1]?.passRate).toBe(0.5);
  });

  test("passed is true when satisfaction equals threshold (boundary: == passes)", () => {
    const s1 = makeSummary([], "approved", "pass");
    const s2 = makeSummary([], "significant_concerns", "pass");
    // satisfaction = 0.75, threshold = 0.75 → passes
    const result = scoreScenario(scenarioWithTwoCriteria, [s1, s2], 0.75);
    expect(result.passed).toBe(true);
  });

  test("passed is false when satisfaction is below threshold", () => {
    const s1 = makeSummary([], "approved", "pass");
    const s2 = makeSummary([], "significant_concerns", "pass");
    // satisfaction = 0.75, threshold = 0.8 → fails
    const result = scoreScenario(scenarioWithTwoCriteria, [s1, s2], 0.8);
    expect(result.passed).toBe(false);
  });

  test("zero summaries → satisfaction=0, passed=false, runCount=0", () => {
    const result = scoreScenario(scenarioWithTwoCriteria, [], 0.8);
    expect(result.satisfaction).toBe(0);
    expect(result.passed).toBe(false);
    expect(result.runCount).toBe(0);
    expect(result.runSatisfactions).toEqual([]);
    expect(result.minSatisfaction).toBe(0);
    expect(result.maxSatisfaction).toBe(0);
    expect(result.variance).toBe(0);
    expect(result.flaky).toBe(false);
    expect(result.perCriterion[0]?.passRate).toBe(0);
  });

  test("zero summaries still apply explicit zero pass-rate gates consistently", () => {
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        {
          kind: "decision_in",
          label: "zero-rate gate",
          values: ["approved"],
          minPassRate: 0,
        },
      ],
    };

    const result = scoreScenario(scenario, [], 0.8);

    expect(result.perCriterion[0]).toEqual({
      label: "zero-rate gate",
      passRate: 0,
      critical: false,
      requiredPassRate: 0,
      passed: true,
    });
    expect(result.passed).toBe(false);
  });

  test("threshold uses scenario.threshold when set, defaultThreshold otherwise", () => {
    const scenarioWithThreshold: EvalScenario = { ...scenarioWithTwoCriteria, threshold: 0.5 };
    const s1 = makeSummary([], "approved", "pass");
    const s2 = makeSummary([], "significant_concerns", "pass");
    // satisfaction = 0.75, scenario threshold = 0.5 → passes
    const result = scoreScenario(scenarioWithThreshold, [s1, s2], 0.9);
    expect(result.threshold).toBe(0.5);
    expect(result.passed).toBe(true);
  });

  test("critical criteria fail the scenario when pass rate misses the default 100% requirement", () => {
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        { kind: "outcome_is", label: "pass", value: "pass" },
        { kind: "decision_in", label: "approved every run", values: ["approved"], critical: true },
      ],
    };
    const s1 = makeSummary([], "approved", "pass");
    const s2 = makeSummary([], "significant_concerns", "pass");
    const result = scoreScenario(scenario, [s1, s2], 0.5);

    expect(result.satisfaction).toBe(0.75);
    expect(result.perCriterion[1]).toEqual({
      label: "approved every run",
      passRate: 0.5,
      critical: true,
      requiredPassRate: 1,
      passed: false,
    });
    expect(result.passed).toBe(false);
  });

  test("minPassRate can set an explicit criterion gate below 100%", () => {
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        { kind: "outcome_is", label: "pass", value: "pass" },
        {
          kind: "decision_in",
          label: "mostly approved",
          values: ["approved"],
          critical: true,
          minPassRate: 0.5,
        },
      ],
    };
    const s1 = makeSummary([], "approved", "pass");
    const s2 = makeSummary([], "significant_concerns", "pass");
    const result = scoreScenario(scenario, [s1, s2], 0.5);

    expect(result.perCriterion[1]?.requiredPassRate).toBe(0.5);
    expect(result.perCriterion[1]?.passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  test("minPassRate gates a scenario even when critical is omitted", () => {
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        { kind: "outcome_is", label: "pass", value: "pass" },
        {
          kind: "decision_in",
          label: "mostly approved",
          values: ["approved"],
          minPassRate: 0.75,
        },
      ],
    };
    const s1 = makeSummary([], "approved", "pass");
    const s2 = makeSummary([], "significant_concerns", "pass");
    const result = scoreScenario(scenario, [s1, s2], 0.5);

    expect(result.satisfaction).toBe(0.75);
    expect(result.perCriterion[1]?.critical).toBe(false);
    expect(result.perCriterion[1]?.requiredPassRate).toBe(0.75);
    expect(result.perCriterion[1]?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("minPassRate outside [0,1] is rejected", () => {
    const scenario: EvalScenario = {
      ...baseScenario,
      criteria: [
        {
          kind: "decision_in",
          label: "impossible gate",
          values: ["approved"],
          minPassRate: 1.5,
        },
      ],
    };

    expect(() => scoreScenario(scenario, [makeSummary([], "approved", "pass")], 0.8)).toThrow(
      /minPassRate must be a finite number in \[0, 1\]/,
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario JSON file guard — verifies all seed scenario files are well-formed
// ---------------------------------------------------------------------------

const HOLDOUT_DIR = join(import.meta.dir, "../evals/scenarios");
const DEV_DIR = join(import.meta.dir, "../evals/scenarios-dev");

/**
 * Load every *.json scenario in a split directory. Returns [] when the directory is
 * absent or holds no scenario files (the dev split legitimately starts empty — only a
 * README.md — until the improvement playbook (M016 S05) distills the first one).
 */
async function loadScenarioFiles(
  dir: string,
): Promise<{ file: string; scenario: Record<string, unknown> }[]> {
  // Both splits are tracked (each carries a README.md) so the directory ALWAYS exists. A
  // missing dir therefore means a typo'd/renamed path constant — we let readdir throw it
  // loudly rather than swallow it into an empty split that would make the disjointness guard
  // below pass vacuously without anyone noticing the dir was never read. A dir holding only
  // its README (zero *.json) is the legitimate "empty split" state and returns [].
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const loaded: { file: string; scenario: Record<string, unknown> }[] = [];
  for (const file of files) {
    const content = await readFile(join(dir, file), "utf-8");
    const parsed: unknown = JSON.parse(content);
    loaded.push({ file, scenario: parsed as Record<string, unknown> });
  }
  return loaded;
}

function expectWellFormed(file: string, scenario: Record<string, unknown>): void {
  expect(typeof scenario, file).toBe("object");
  expect(scenario, file).not.toBeNull();
  expect(typeof scenario.name, file).toBe("string");
  expect(typeof scenario.fixture, file).toBe("string");
  expect(Array.isArray(scenario.criteria), file).toBe(true);
}

describe("seed scenario JSON files", () => {
  test("all evals/scenarios/*.json (holdout) files parse and have required fields", async () => {
    const holdout = await loadScenarioFiles(HOLDOUT_DIR);
    expect(holdout.length).toBeGreaterThan(0);
    for (const { file, scenario } of holdout) expectWellFormed(file, scenario);
  });

  test("all evals/scenarios-dev/*.json (dev split) files parse and have required fields", async () => {
    // The dev split may be empty (README only) — that is valid; this only guards shape
    // for whatever scenarios the improvement loop has distilled so far.
    const dev = await loadScenarioFiles(DEV_DIR);
    for (const { file, scenario } of dev) expectWellFormed(file, scenario);
  });
});

// ---------------------------------------------------------------------------
// Holdout/dev disjointness guard (M016 S01, #129) — the mechanical half of
// holdout discipline. A dev scenario the reviewer was tuned against must never be
// promoted into the sealed holdout. This catches the obvious copy vector (same name
// or same fixture in both splits); the re-authored-from-scratch case is covered by
// documented discipline (evals/scenarios{,-dev}/README.md), since it is
// indistinguishable from a genuinely new scenario at the file level.
// ---------------------------------------------------------------------------

/** A scenario reduced to the identity fields the disjointness guard compares. */
interface SplitKey {
  label: string;
  name: string;
  fixture: string;
}

/**
 * Pure disjointness check: returns one message per violation (empty === disjoint).
 * A dev scenario violates if it shares a `name` or `fixture` with any holdout scenario.
 * Extracted as a pure function so the guard's LOGIC is exercised by synthetic unit tests
 * below — proving it actually catches collisions in CI, independent of whether the real
 * `evals/scenarios-dev/` dir is empty (it is, until M016 S05 distills the first scenario).
 *
 * Fixture paths are compared by `normalize()`d form and MUST be repo-root-relative on both
 * sides (an absolute path would not normalize to its relative equivalent and could slip a
 * collision past the guard). `toSplitKey` enforces the relative-path invariant mechanically.
 */
function findSplitCollisions(holdout: readonly SplitKey[], dev: readonly SplitKey[]): string[] {
  // Compare fixtures by their normalized path so a cosmetic variation ("./evals/...",
  // doubled slashes, a "foo/../" segment) can't silently slip a copy past the guard.
  const holdoutNames = new Set(holdout.map((s) => s.name));
  const holdoutFixtures = new Set(holdout.map((s) => normalize(s.fixture)));
  const violations: string[] = [];
  for (const d of dev) {
    if (holdoutNames.has(d.name)) {
      violations.push(
        `dev scenario ${d.label} shares name "${d.name}" with a holdout scenario — a tuned dev scenario must never be promoted into the sealed holdout (#129)`,
      );
    }
    if (holdoutFixtures.has(normalize(d.fixture))) {
      violations.push(
        `dev scenario ${d.label} shares fixture "${d.fixture}" with a holdout scenario — dev fixtures must be distinct from holdout fixtures (#129)`,
      );
    }
  }
  return violations;
}

/**
 * Narrow a loaded scenario to a SplitKey, failing loudly on a non-string name/fixture or an
 * absolute fixture path. The absolute-path check keeps the disjointness invariant mechanical:
 * `normalize()` can't equate an absolute fixture with its repo-relative twin, so an absolute
 * path could otherwise slip a copy past the guard (AI-review #163).
 */
function toSplitKey({
  file,
  scenario,
}: {
  file: string;
  scenario: Record<string, unknown>;
}): SplitKey {
  const { name, fixture } = scenario;
  if (typeof name !== "string" || typeof fixture !== "string") {
    throw new Error(
      `scenario ${file}: "name" and "fixture" must be strings for the #129 disjointness guard`,
    );
  }
  if (fixture.startsWith("/")) {
    throw new Error(
      `scenario ${file}: "fixture" must be a repo-root-relative path, not absolute (got "${fixture}") — required for the #129 disjointness guard`,
    );
  }
  return { label: file, name, fixture };
}

describe("holdout/dev split disjointness (#129)", () => {
  // Synthetic cases — these run regardless of the real dev dir being empty, so the guard's
  // logic is proven non-vacuous in CI (addresses the testability gap of the file-based check
  // while the dev split has no scenarios yet).
  const H: SplitKey[] = [
    { label: "h1", name: "auth-sqli", fixture: "evals/fixtures/auth-sqli.json" },
    { label: "h2", name: "clean-refactor", fixture: "evals/fixtures/clean-refactor.json" },
  ];

  test("synthetic: disjoint splits report no collisions", () => {
    const dev: SplitKey[] = [
      { label: "d1", name: "new-miss", fixture: "evals/fixtures/new-miss.json" },
    ];
    expect(findSplitCollisions(H, dev)).toEqual([]);
  });

  test("synthetic: an empty dev split reports no collisions", () => {
    expect(findSplitCollisions(H, [])).toEqual([]);
  });

  test("synthetic: a shared scenario name is flagged", () => {
    const dev: SplitKey[] = [
      { label: "d1", name: "auth-sqli", fixture: "evals/fixtures/other.json" },
    ];
    const violations = findSplitCollisions(H, dev);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('shares name "auth-sqli"');
  });

  test("synthetic: a shared fixture path is flagged", () => {
    const dev: SplitKey[] = [
      { label: "d1", name: "renamed", fixture: "evals/fixtures/auth-sqli.json" },
    ];
    const violations = findSplitCollisions(H, dev);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain('shares fixture "evals/fixtures/auth-sqli.json"');
  });

  test("synthetic: a copy-promoted scenario (same name AND fixture) is flagged twice", () => {
    const dev: SplitKey[] = [
      { label: "d1", name: "auth-sqli", fixture: "evals/fixtures/auth-sqli.json" },
    ];
    expect(findSplitCollisions(H, dev).length).toBe(2);
  });

  test("synthetic: a cosmetic fixture-path variation still collides (normalized compare)", () => {
    const dev: SplitKey[] = [
      // Same fixture as h1, written with a "./" prefix and a redundant "x/../" segment.
      { label: "d1", name: "renamed", fixture: "./evals/x/../fixtures/auth-sqli.json" },
    ];
    const violations = findSplitCollisions(H, dev);
    expect(violations.length).toBe(1);
    expect(violations[0]).toContain("shares fixture");
  });

  test("toSplitKey rejects an absolute fixture path (keeps the invariant mechanical)", () => {
    expect(() =>
      toSplitKey({
        file: "x.json",
        scenario: { name: "x", fixture: "/abs/evals/fixtures/auth-sqli.json", criteria: [] },
      }),
    ).toThrow(/repo-root-relative/);
  });

  // The real guard over the on-disk splits. Both directories are tracked (each carries a
  // README.md), so they MUST exist — asserting that first turns a typo'd/renamed path constant
  // into a loud failure instead of a silent vacuous pass (loadScenarioFiles now lets readdir
  // throw ENOENT loudly rather than swallowing a missing dir into an empty split).
  test("the on-disk holdout and dev splits exist and are disjoint", async () => {
    expect((await stat(HOLDOUT_DIR)).isDirectory(), HOLDOUT_DIR).toBe(true);
    expect((await stat(DEV_DIR)).isDirectory(), DEV_DIR).toBe(true);

    // Vacuously-true while the dev split is empty (README only) — the synthetic cases above
    // prove the logic, and the existence checks above prove the dir was actually read. This
    // activates the moment a real dev `.json` lands (M016 S05).
    const holdout = (await loadScenarioFiles(HOLDOUT_DIR)).map(toSplitKey);
    const dev = (await loadScenarioFiles(DEV_DIR)).map(toSplitKey);
    expect(findSplitCollisions(holdout, dev)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// .ai-review.json modelRouting — routes complex roles to opus (M029)
// ---------------------------------------------------------------------------

describe(".ai-review.json modelRouting routes complex roles to a non-dummy model", () => {
  test("parses and routes code_quality, security, performance, coordinator to claude-opus-4-8", async () => {
    const raw = await readFile(join(import.meta.dir, "../.ai-review.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    const config = normalizeReviewConfig(parsed);

    const roles = config.modelRouting.roles ?? {};
    const opusModel = "claude-opus-4-8";
    const opusProvider = "anthropic";

    for (const role of ["code_quality", "security", "performance", "coordinator"] as const) {
      const routing = roles[role];
      expect(routing, `modelRouting.roles.${role} should be defined`).toBeDefined();
      expect(routing?.model, `modelRouting.roles.${role}.model`).toBe(opusModel);
      expect(routing?.provider, `modelRouting.roles.${role}.provider`).toBe(opusProvider);
    }
  });
});
