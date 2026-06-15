import type { Finding, ReviewSummary } from "../contracts/index.ts";
import type { EvalCriterion, EvalScenario } from "./types.ts";

// Severity rank: higher number = higher severity.
// This is the single source of truth for ordering within this module.
const SEVERITY_RANK: Record<string, number> = {
  suggestion: 1,
  warning: 2,
  critical: 3,
};

function rank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 0;
}

/** Returns true if `finding` matches every provided filter in a `has_finding` criterion. */
function matchesFinding(
  finding: Finding,
  criterion: Extract<EvalCriterion, { kind: "has_finding" }>,
): boolean {
  // severity: exact match
  if (criterion.severity !== undefined) {
    if (finding.severity.toLowerCase() !== criterion.severity.toLowerCase()) {
      return false;
    }
  }

  // minSeverity: rank(finding) >= rank(minSeverity)
  if (criterion.minSeverity !== undefined) {
    if (rank(finding.severity) < rank(criterion.minSeverity)) {
      return false;
    }
  }

  // category: exact, case-insensitive
  if (criterion.category !== undefined) {
    if (finding.category.toLowerCase() !== criterion.category.toLowerCase()) {
      return false;
    }
  }

  // reviewer: exact, case-insensitive
  if (criterion.reviewer !== undefined) {
    if (String(finding.reviewer).toLowerCase() !== criterion.reviewer.toLowerCase()) {
      return false;
    }
  }

  // pathIncludes: case-insensitive substring of finding.location?.path
  if (criterion.pathIncludes !== undefined) {
    const path = finding.location?.path ?? "";
    if (!path.toLowerCase().includes(criterion.pathIncludes.toLowerCase())) {
      return false;
    }
  }

  // textIncludes: case-insensitive substring of title, body, evidence[], or quotedCode[]
  if (criterion.textIncludes !== undefined) {
    const needle = criterion.textIncludes.toLowerCase();
    const haystack = [
      finding.title,
      finding.body,
      finding.recommendation,
      ...finding.evidence,
      ...(finding.quotedCode ?? []),
    ];
    if (!haystack.some((s) => s.toLowerCase().includes(needle))) {
      return false;
    }
  }

  return true;
}

/** Evaluates a single criterion against one ReviewSummary. Pure, no I/O. */
export function evaluateCriterion(criterion: EvalCriterion, summary: ReviewSummary): boolean {
  switch (criterion.kind) {
    case "has_finding":
      return summary.findings.some((f) => matchesFinding(f, criterion));

    case "no_findings_at_or_above":
      return !summary.findings.some((f) => rank(f.severity) >= rank(criterion.severity));

    case "max_findings": {
      const threshold = criterion.atOrAbove ?? "suggestion";
      const count = summary.findings.filter((f) => rank(f.severity) >= rank(threshold)).length;
      return count <= criterion.count;
    }

    case "decision_in":
      return criterion.values.includes(summary.decision);

    case "outcome_is":
      return summary.outcome === criterion.value;

    case "reviewer_not_failed": {
      const failedRoles = summary.degraded?.failedRoles ?? [];
      const reviewer = criterion.reviewer.toLowerCase();
      return !failedRoles.some((role) => role.toLowerCase() === reviewer);
    }

    case "partial_by_size": {
      const partialBySize = summary.partialBySize;
      if (partialBySize === undefined) {
        return false;
      }
      if (
        criterion.minDroppedFileCount !== undefined &&
        partialBySize.droppedFileCount < criterion.minDroppedFileCount
      ) {
        return false;
      }
      if (
        criterion.minAdmittedFileCount !== undefined &&
        partialBySize.admittedFileCount < criterion.minAdmittedFileCount
      ) {
        return false;
      }
      return true;
    }
  }
}

export interface RunScore {
  satisfaction: number;
  met: number;
  total: number;
  results: Array<{ label: string; met: boolean }>;
}

/** Scores a single review run against a scenario's criteria. */
export function scoreRun(scenario: EvalScenario, summary: ReviewSummary): RunScore {
  const results = scenario.criteria.map((criterion) => ({
    label: criterion.label,
    met: evaluateCriterion(criterion, summary),
  }));
  const met = results.filter((r) => r.met).length;
  const total = results.length;
  const satisfaction = total === 0 ? 1 : met / total;
  return { satisfaction, met, total, results };
}

export interface ScenarioScore {
  name: string;
  satisfaction: number;
  threshold: number;
  passed: boolean;
  runSatisfactions: number[];
  minSatisfaction: number;
  maxSatisfaction: number;
  variance: number;
  flaky: boolean;
  perCriterion: CriterionScore[];
  runCount: number;
}

export interface CriterionScore {
  label: string;
  passRate: number;
  critical: boolean;
  requiredPassRate: number | null;
  passed: boolean;
}

function criterionRequiredPassRate(criterion: EvalCriterion): number | null {
  const requiredPassRate = criterion.minPassRate ?? (criterion.critical === true ? 1 : null);
  if (
    requiredPassRate !== null &&
    (!Number.isFinite(requiredPassRate) || requiredPassRate < 0 || requiredPassRate > 1)
  ) {
    throw new Error(`Criterion "${criterion.label}" minPassRate must be a finite number in [0, 1]`);
  }
  return requiredPassRate;
}

function variance(values: readonly number[], mean: number): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

/**
 * Aggregates K run summaries into a scenario-level satisfaction score.
 * `satisfaction` = mean of per-run satisfaction fractions.
 * `perCriterion[i].passRate` = fraction of runs where criterion i was met.
 * `passed` requires the mean satisfaction threshold AND every criterion-level pass-rate gate.
 */
export function scoreScenario(
  scenario: EvalScenario,
  summaries: ReviewSummary[],
  defaultThreshold: number,
): ScenarioScore {
  const threshold = scenario.threshold ?? defaultThreshold;

  if (summaries.length === 0) {
    return {
      name: scenario.name,
      satisfaction: 0,
      threshold,
      passed: false,
      runSatisfactions: [],
      minSatisfaction: 0,
      maxSatisfaction: 0,
      variance: 0,
      flaky: false,
      perCriterion: scenario.criteria.map((c) => {
        const requiredPassRate = criterionRequiredPassRate(c);
        return {
          label: c.label,
          passRate: 0,
          critical: c.critical === true,
          requiredPassRate,
          passed: requiredPassRate === null || requiredPassRate === 0,
        };
      }),
      runCount: 0,
    };
  }

  const runScores = summaries.map((s) => scoreRun(scenario, s));
  const runSatisfactions = runScores.map((r) => r.satisfaction);
  const satisfaction =
    runSatisfactions.reduce((sum, value) => sum + value, 0) / runSatisfactions.length;
  const minSatisfaction = Math.min(...runSatisfactions);
  const maxSatisfaction = Math.max(...runSatisfactions);
  const satisfactionVariance = variance(runSatisfactions, satisfaction);

  // perCriterion: for each criterion index, fraction of runs where it was met
  const perCriterion = scenario.criteria.map((criterion, i) => {
    const metCount = runScores.filter((r) => r.results[i]?.met === true).length;
    const passRate = metCount / runScores.length;
    const requiredPassRate = criterionRequiredPassRate(criterion);
    return {
      label: criterion.label,
      passRate,
      critical: criterion.critical === true,
      requiredPassRate,
      passed: requiredPassRate === null || passRate >= requiredPassRate,
    };
  });
  const criteriaPassed = perCriterion.every((criterion) => criterion.passed);

  return {
    name: scenario.name,
    satisfaction,
    threshold,
    passed: satisfaction >= threshold && criteriaPassed,
    runSatisfactions,
    minSatisfaction,
    maxSatisfaction,
    variance: satisfactionVariance,
    flaky: minSatisfaction !== maxSatisfaction,
    perCriterion,
    runCount: summaries.length,
  };
}
