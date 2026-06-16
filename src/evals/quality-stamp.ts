import type { ScenarioScore } from "./score.ts";

/** Aggregate gate decision over scored scenarios. `blocked` is the release-gate verdict. */
export interface EvalRunSummary {
  passed: number;
  total: number;
  meanSatisfaction: number;
  /** true when the release gate would BLOCK: any scenario failed, OR there were zero scenarios
   *  (an empty holdout must never silently pass — fail toward not-shipping). */
  blocked: boolean;
}

export function summarizeEvalRun(results: readonly ScenarioScore[]): EvalRunSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const meanSatisfaction =
    total === 0 ? 0 : results.reduce((s, r) => s + r.satisfaction, 0) / total;
  return { passed, total, meanSatisfaction, blocked: total === 0 || passed !== total };
}

interface QualityStampScenario {
  name: string;
  satisfaction: number;
  threshold: number;
  passed: boolean;
  runSatisfactions: number[];
  minSatisfaction: number;
  maxSatisfaction: number;
  variance: number;
  flaky: boolean;
  perCriterion: Array<{
    label: string;
    passRate: number;
    critical: boolean;
    requiredPassRate: number | null;
    passed: boolean;
  }>;
  runCount: number;
}

/** Inputs the caller supplies (script-side, where I/O + Date live). */
export interface QualityStampMeta {
  /** ISO-8601 string; the CALLER stamps the time (keeps this module pure). */
  generatedAt: string;
  /** Source commit SHA, or null when unknown. */
  commit: string | null;
  runtime: string;
  /** Pinned model id, or null when the runtime default was used. */
  model: string | null;
  /** Runs-per-scenario the eval used (the --runs value). */
  runs: number;
  /** The default satisfaction threshold passed to the eval (per-scenario overrides still apply). */
  threshold: number;
}

export interface QualityStamp {
  schemaVersion: "ai-review.quality_stamp.v2";
  generatedAt: string;
  commit: string | null;
  runtime: string;
  model: string | null;
  runs: number;
  threshold: number;
  passed: number;
  total: number;
  meanSatisfaction: number;
  /** Mirrors EvalRunSummary.blocked — true means this run would block the release. */
  blocked: boolean;
  scenarios: QualityStampScenario[];
}

/** Build the schema-versioned quality stamp. Pure: no I/O, no Date — counts/scores only. */
export function buildQualityStamp(
  results: readonly ScenarioScore[],
  meta: QualityStampMeta,
): QualityStamp {
  const { passed, total, meanSatisfaction, blocked } = summarizeEvalRun(results);
  return {
    schemaVersion: "ai-review.quality_stamp.v2",
    generatedAt: meta.generatedAt,
    commit: meta.commit,
    runtime: meta.runtime,
    model: meta.model,
    runs: meta.runs,
    threshold: meta.threshold,
    passed,
    total,
    meanSatisfaction,
    blocked,
    scenarios: results.map((r) => ({
      name: r.name,
      satisfaction: r.satisfaction,
      threshold: r.threshold,
      passed: r.passed,
      runSatisfactions: r.runSatisfactions,
      minSatisfaction: r.minSatisfaction,
      maxSatisfaction: r.maxSatisfaction,
      variance: r.variance,
      flaky: r.flaky,
      perCriterion: r.perCriterion.map((criterion) => ({
        label: criterion.label,
        passRate: criterion.passRate,
        critical: criterion.critical,
        requiredPassRate: criterion.requiredPassRate,
        passed: criterion.passed,
      })),
      runCount: r.runCount,
    })),
  };
}
