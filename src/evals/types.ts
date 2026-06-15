import type { CiOutcome, ReviewDecision, Severity } from "../contracts/index.ts";

interface EvalCriterionBase {
  label: string;
  /** Critical criteria gate the scenario by pass rate, defaulting to 100% when minPassRate is omitted. */
  critical?: boolean;
  /** Optional criterion-level required pass rate in [0,1]; gates the scenario even without critical. */
  minPassRate?: number;
}

/** A single behavioral acceptance check, evaluated against one ReviewSummary. */
export type EvalCriterion =
  // At least one finding matches ALL provided filters (omitted filters are wildcards).
  // `minSeverity` matches that severity OR higher (critical > warning > suggestion).
  | (EvalCriterionBase & {
      kind: "has_finding";
      severity?: Severity;
      minSeverity?: Severity;
      category?: string;
      reviewer?: string;
      pathIncludes?: string;
      textIncludes?: string;
    })
  // No finding at or above the given severity (e.g. clean diff must not raise warning+).
  | (EvalCriterionBase & { kind: "no_findings_at_or_above"; severity: Severity })
  // At most `count` findings at or above `atOrAbove` (default: all severities) — signal-to-noise.
  | (EvalCriterionBase & { kind: "max_findings"; count: number; atOrAbove?: Severity })
  // The review decision is one of `values`.
  | (EvalCriterionBase & { kind: "decision_in"; values: ReviewDecision[] })
  // The CI outcome equals `value`.
  | (EvalCriterionBase & { kind: "outcome_is"; value: CiOutcome })
  // A named reviewer did not fail in a completing degraded review.
  | (EvalCriterionBase & { kind: "reviewer_not_failed"; reviewer: string })
  // Patch-admission demotion was visible in the counts-only summary block.
  | (EvalCriterionBase & {
      kind: "partial_by_size";
      minDroppedFileCount?: number;
      minAdmittedFileCount?: number;
    });

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
