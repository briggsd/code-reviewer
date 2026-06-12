import type { CiOutcome, ReviewDecision, Severity } from "../contracts/index.ts";

/** A single behavioral acceptance check, evaluated against one ReviewSummary. */
export type EvalCriterion =
  // At least one finding matches ALL provided filters (omitted filters are wildcards).
  // `minSeverity` matches that severity OR higher (critical > warning > suggestion).
  | {
      kind: "has_finding";
      label: string;
      severity?: Severity;
      minSeverity?: Severity;
      category?: string;
      reviewer?: string;
      pathIncludes?: string;
      textIncludes?: string;
    }
  // No finding at or above the given severity (e.g. clean diff must not raise warning+).
  | { kind: "no_findings_at_or_above"; label: string; severity: Severity }
  // At most `count` findings at or above `atOrAbove` (default: all severities) — signal-to-noise.
  | { kind: "max_findings"; label: string; count: number; atOrAbove?: Severity }
  // The review decision is one of `values`.
  | { kind: "decision_in"; label: string; values: ReviewDecision[] }
  // The CI outcome equals `value`.
  | { kind: "outcome_is"; label: string; value: CiOutcome };

export interface EvalScenario {
  name: string;
  description: string;
  /** Path (repo-root-relative) to a holdout fixture with NO fakeFindings. */
  fixture: string;
  /** K runs; runner default applies when omitted. */
  runs?: number;
  /** Per-scenario satisfaction threshold in [0,1]; runner default 0.8 when omitted. */
  threshold?: number;
  criteria: EvalCriterion[];
}
