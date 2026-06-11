import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { Finding, RiskAssessment, ReviewSummary } from "../src/index.ts";
import {
  evaluateCriterion,
  scoreRun,
  scoreScenario,
} from "../src/evals/index.ts";
import type { EvalScenario } from "../src/evals/index.ts";

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
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", reviewer: "security", category: "injection" },
      summary,
    )).toBe(true);
  });

  test("returns false when no finding matches", () => {
    const summary = makeSummary([]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", reviewer: "security" },
      summary,
    )).toBe(false);
  });

  test("minSeverity: warning finding satisfies minSeverity warning (boundary: same level passes)", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", minSeverity: "warning" },
      summary,
    )).toBe(true);
  });

  test("minSeverity: warning finding does NOT satisfy minSeverity critical", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", minSeverity: "critical" },
      summary,
    )).toBe(false);
  });

  test("minSeverity: critical finding satisfies minSeverity warning (higher rank passes lower threshold)", () => {
    const summary = makeSummary([makeFinding({ severity: "critical" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", minSeverity: "warning" },
      summary,
    )).toBe(true);
  });

  test("severity exact: critical finding does NOT match severity warning", () => {
    const summary = makeSummary([makeFinding({ severity: "critical" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", severity: "warning" },
      summary,
    )).toBe(false);
  });

  test("category filter: case-insensitive match", () => {
    const summary = makeSummary([makeFinding({ category: "Injection" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", category: "injection" },
      summary,
    )).toBe(true);
  });

  test("reviewer filter: case-insensitive match", () => {
    const summary = makeSummary([makeFinding({ reviewer: "Security" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", reviewer: "security" },
      summary,
    )).toBe(true);
  });

  test("pathIncludes: case-insensitive substring of location.path", () => {
    const summary = makeSummary([makeFinding({ location: { path: "AUTH/login.ts" } })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", pathIncludes: "auth" },
      summary,
    )).toBe(true);
  });

  test("textIncludes: matches substring in finding.title (case-insensitive)", () => {
    const summary = makeSummary([makeFinding({ title: "SQL Injection Risk" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", textIncludes: "inject" },
      summary,
    )).toBe(true);
  });

  test("textIncludes: matches substring in finding.body (case-insensitive)", () => {
    const summary = makeSummary([makeFinding({ body: "User input is INJECTED into query" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", textIncludes: "injected" },
      summary,
    )).toBe(true);
  });

  test("textIncludes: matches substring in finding.evidence[] (case-insensitive)", () => {
    const summary = makeSummary([makeFinding({ evidence: ["Parameterized query missing"] })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", textIncludes: "parameterized" },
      summary,
    )).toBe(true);
  });

  test("textIncludes: matches substring found only in finding.recommendation (#85 review)", () => {
    const summary = makeSummary([makeFinding({
      title: "Issue", body: "see fix", evidence: ["n/a"],
      recommendation: "Switch to a prepared statement to remediate",
    })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", textIncludes: "prepared statement" },
      summary,
    )).toBe(true);
  });

  test("textIncludes: returns false when substring is absent", () => {
    const summary = makeSummary([makeFinding({ title: "Missing auth check", body: "No ownership verification" })]);
    expect(evaluateCriterion(
      { kind: "has_finding", label: "test", textIncludes: "inject" },
      summary,
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — no_findings_at_or_above
// ---------------------------------------------------------------------------

describe("evaluateCriterion — no_findings_at_or_above", () => {
  test("true when summary has only suggestions (below warning)", () => {
    const summary = makeSummary([makeFinding({ severity: "suggestion" })]);
    expect(evaluateCriterion(
      { kind: "no_findings_at_or_above", label: "test", severity: "warning" },
      summary,
    )).toBe(true);
  });

  test("false when summary has a warning finding (severity matches threshold)", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(evaluateCriterion(
      { kind: "no_findings_at_or_above", label: "test", severity: "warning" },
      summary,
    )).toBe(false);
  });

  test("false when summary has a critical finding (above warning threshold)", () => {
    const summary = makeSummary([makeFinding({ severity: "critical" })]);
    expect(evaluateCriterion(
      { kind: "no_findings_at_or_above", label: "test", severity: "warning" },
      summary,
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — max_findings
// ---------------------------------------------------------------------------

describe("evaluateCriterion — max_findings", () => {
  test("passes when finding count is below cap", () => {
    const summary = makeSummary([makeFinding({ severity: "warning" })]);
    expect(evaluateCriterion(
      { kind: "max_findings", label: "test", count: 2, atOrAbove: "warning" },
      summary,
    )).toBe(true);
  });

  test("fails when finding count exceeds cap", () => {
    const summary = makeSummary([
      makeFinding({ severity: "warning" }),
      makeFinding({ severity: "critical" }),
    ]);
    expect(evaluateCriterion(
      { kind: "max_findings", label: "test", count: 1, atOrAbove: "warning" },
      summary,
    )).toBe(false);
  });

  test("default atOrAbove is suggestion (counts all findings)", () => {
    // 3 findings at suggestion level, cap is 2 — should fail
    const summary = makeSummary([
      makeFinding({ severity: "suggestion" }),
      makeFinding({ severity: "suggestion" }),
      makeFinding({ severity: "suggestion" }),
    ]);
    expect(evaluateCriterion(
      { kind: "max_findings", label: "test", count: 2 },
      summary,
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateCriterion — decision_in / outcome_is
// ---------------------------------------------------------------------------

describe("evaluateCriterion — decision_in", () => {
  test("true when decision is in values", () => {
    const summary = makeSummary([], "approved");
    expect(evaluateCriterion(
      { kind: "decision_in", label: "test", values: ["approved", "approved_with_comments"] },
      summary,
    )).toBe(true);
  });

  test("false when decision is not in values", () => {
    const summary = makeSummary([], "significant_concerns");
    expect(evaluateCriterion(
      { kind: "decision_in", label: "test", values: ["approved", "approved_with_comments"] },
      summary,
    )).toBe(false);
  });
});

describe("evaluateCriterion — outcome_is", () => {
  test("true when outcome matches", () => {
    const summary = makeSummary([], "approved", "pass");
    expect(evaluateCriterion(
      { kind: "outcome_is", label: "test", value: "pass" },
      summary,
    )).toBe(true);
  });

  test("false when outcome does not match", () => {
    const summary = makeSummary([], "significant_concerns", "fail");
    expect(evaluateCriterion(
      { kind: "outcome_is", label: "test", value: "pass" },
      summary,
    )).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scoreRun
// ---------------------------------------------------------------------------

describe("scoreRun", () => {
  test("3 of 4 criteria met → satisfaction = 0.75", () => {
    const summary = makeSummary(
      [makeFinding({ severity: "suggestion" })],
      "approved",
      "pass",
    );
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
    expect(result.runCount).toBe(2);
  });

  test("perCriterion pass rate: criterion met in 1 of 2 runs → passRate = 0.5", () => {
    const s1 = makeSummary([], "approved", "pass");     // both met
    const s2 = makeSummary([], "significant_concerns", "pass"); // only outcome met
    const result = scoreScenario(scenarioWithTwoCriteria, [s1, s2], 0.8);
    // "pass" outcome: met in both runs → 1.0
    expect(result.perCriterion[0]?.passRate).toBe(1.0);
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
    expect(result.perCriterion[0]?.passRate).toBe(0);
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
});

// ---------------------------------------------------------------------------
// Scenario JSON file guard — verifies all seed scenario files are well-formed
// ---------------------------------------------------------------------------

describe("seed scenario JSON files", () => {
  test("all evals/scenarios/*.json files parse and have required fields", async () => {
    const scenariosDir = join(import.meta.dir, "../evals/scenarios");
    const files = (await readdir(scenariosDir)).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(join(scenariosDir, file), "utf-8");
      const parsed: unknown = JSON.parse(content);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      const scenario = parsed as Record<string, unknown>;
      expect(typeof scenario["name"]).toBe("string");
      expect(typeof scenario["fixture"]).toBe("string");
      expect(Array.isArray(scenario["criteria"])).toBe(true);
    }
  });
});
