/**
 * Incremental re-review (#46): on a re-push, narrow the reviewed diff to only the
 * files changed since the last reviewed head (`previousHeadSha`), instead of
 * re-spending the full reviewer budget on the entire PR diff.
 *
 * This module owns the DETERMINISTIC policy — eligibility, the safe-fallback
 * rules, and the pure diff-narrowing transform. Computing the actual delta (an
 * IO/network concern) lives in the VCS adapters (`getChangedPathsSince`); the CLI
 * feeds the result here. Correctness over savings: any uncertainty degrades to a
 * full review, never a silent coverage drop.
 */

import type { ChangedPathsSince, DiffSummary, PriorReviewState } from "../contracts/index.ts";

/** Why a re-review did or did not run incrementally (for trace/telemetry). */
export type IncrementalReason =
  | "incremental" // narrowed to the delta
  | "no_prior_state" // first review (or prior state without a head SHA)
  | "same_head" // re-review of an identical head — nothing new to narrow
  | "delta_unavailable" // adapter could not compute the delta (unsupported/error/too large)
  | "base_changed"; // previousHeadSha is no longer an ancestor (rebase/force-push)

export interface IncrementalReviewPlan {
  mode: "incremental" | "full";
  reason: IncrementalReason;
  /**
   * In incremental mode, the repo-relative file paths that ARE re-reviewed this
   * push (the delta). Used to narrow the diff and to drive carry-forward
   * classification. Undefined/empty in full mode.
   */
  reviewedPaths?: readonly string[];
}

export interface DecideIncrementalReviewInput {
  priorState: PriorReviewState | undefined;
  /** The head SHA being reviewed now. */
  headSha: string;
  /**
   * The delta computed by the adapter (`getChangedPathsSince(ref, previousHeadSha)`),
   * or undefined when the adapter does not support it / could not compute it.
   */
  delta: ChangedPathsSince | undefined;
}

/**
 * Decide whether to run an incremental re-review. Pure and total — every branch
 * that is not a clean, ancestor-verified delta returns a full-review plan with a
 * reason, so coverage is never silently narrowed.
 */
export function decideIncrementalReview(
  input: DecideIncrementalReviewInput,
): IncrementalReviewPlan {
  const previousHeadSha = input.priorState?.previousHeadSha;
  if (input.priorState === undefined || previousHeadSha === undefined) {
    return { mode: "full", reason: "no_prior_state" };
  }
  if (previousHeadSha === input.headSha) {
    return { mode: "full", reason: "same_head" };
  }
  if (input.delta === undefined) {
    return { mode: "full", reason: "delta_unavailable" };
  }
  if (!input.delta.isAncestor) {
    return { mode: "full", reason: "base_changed" };
  }
  return {
    mode: "incremental",
    reason: "incremental",
    reviewedPaths: [...input.delta.changedPaths],
  };
}

/**
 * Narrow a diff to only the files whose path is in `reviewedPaths`, recomputing
 * totals. Files outside the delta are dropped from review; their prior findings
 * are carried forward (see re-review.ts). Pure.
 */
export function narrowDiffToPaths(
  diff: DiffSummary,
  reviewedPaths: ReadonlySet<string>,
): DiffSummary {
  const files = diff.files.filter((file) => reviewedPaths.has(file.path));
  return {
    ...diff,
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
