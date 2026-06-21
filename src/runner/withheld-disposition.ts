import type { PriorFindingState } from "../contracts/index.ts";

/**
 * Disposition of a grounding-withheld finding across re-review rounds (#392).
 *
 *   promoted      — the withheld finding surfaced as a blocking finding this round
 *                   (its stable ID appears in the current live finding set)
 *   stillWithheld — the finding was grounding-withheld again this round (evidence
 *                   still not found in the diff; its ID appears in the withheld set)
 *   resolved      — the file was reviewed this round and neither blocking nor withheld
 *                   (evidence absent AND grounding accepted the file → finding gone)
 *   carriedForward — the file was not reviewed this round (incremental narrow or
 *                   file not in diff); the finding's status is unknown
 *
 * Pure, deterministic, no I/O. Counts-only boundary: no finding bodies/titles/paths
 * cross egress; only integers are emitted in run_metrics (M008).
 */
export type WithheldDisposition = "promoted" | "stillWithheld" | "resolved" | "carriedForward";

/** Counts-only roll-up of withheld-finding dispositions for a re-review run (#392).
 *  Absent on first review (no prior withheld state). Emitted in run_metrics as
 *  `withheldDispositions`. Integers only — no finding ids, titles, paths (M008). */
export interface WithheldDispositionCounts {
  promoted: number;
  stillWithheld: number;
  resolved: number;
  carriedForward: number;
}

/**
 * Derive the per-finding disposition for each prior withheld finding.
 *
 * Precedence (first match wins):
 *   1. Prior withheld ID is in `currentBlockingIds`   → promoted
 *   2. Prior withheld ID is in `currentWithheldIds`   → stillWithheld
 *   3. Prior withheld path is in `reviewedPaths`      → resolved
 *   4. Otherwise (path not reviewed or unknown)       → carriedForward
 *
 * `reviewedPaths` may be undefined (full review, not incremental): in that case
 * every finding whose ID is not promoted or stillWithheld is treated as resolved
 * (the full diff was reviewed — the finding has no evidence, so it is gone).
 *
 * Pure, deterministic, no I/O.
 *
 * @param priorWithheld - Withheld findings from the prior run's hidden metadata.
 * @param currentBlockingIds - Stable IDs of blocking findings in the current review.
 * @param currentWithheldIds - Stable IDs of grounding-withheld findings this round.
 * @param reviewedPaths - Changed-file paths reviewed this round, or undefined for full.
 * @returns Map of stableId → WithheldDisposition.
 */
export function deriveWithheldDispositions(
  priorWithheld: PriorFindingState[],
  currentBlockingIds: ReadonlySet<string>,
  currentWithheldIds: ReadonlySet<string>,
  reviewedPaths: ReadonlySet<string> | undefined,
): Map<string, WithheldDisposition> {
  const result = new Map<string, WithheldDisposition>();

  for (const entry of priorWithheld) {
    const { stableId, finding } = entry;

    // Precedence 1: promoted to a live blocking finding
    if (currentBlockingIds.has(stableId)) {
      result.set(stableId, "promoted");
      continue;
    }

    // Precedence 2: withheld again this round (evidence still absent)
    if (currentWithheldIds.has(stableId)) {
      result.set(stableId, "stillWithheld");
      continue;
    }

    // Precedence 3: file was reviewed this round — finding not raised (resolved)
    // When reviewedPaths is undefined (full review), every non-promoted/non-withheld
    // finding's file was implicitly reviewed.
    const path = finding.location?.path;
    const fileWasReviewed =
      reviewedPaths === undefined || (path !== undefined && reviewedPaths.has(path));

    if (fileWasReviewed) {
      result.set(stableId, "resolved");
      continue;
    }

    // Precedence 4: file not reviewed — disposition unknown
    result.set(stableId, "carriedForward");
  }

  return result;
}

/**
 * Compute counts-only roll-up of withheld-finding dispositions.
 *
 * Returns undefined when `priorWithheld` is empty (no withheld findings to track).
 *
 * Pure, deterministic, no I/O. Counts-only — no finding ids, titles, paths emitted.
 *
 * @param priorWithheld - Withheld findings from the prior run's hidden metadata.
 * @param currentBlockingIds - Stable IDs of blocking findings in the current review.
 * @param currentWithheldIds - Stable IDs of grounding-withheld findings this round.
 * @param reviewedPaths - Changed-file paths reviewed this round, or undefined for full.
 */
export function computeWithheldDispositions(
  priorWithheld: PriorFindingState[],
  currentBlockingIds: ReadonlySet<string>,
  currentWithheldIds: ReadonlySet<string>,
  reviewedPaths: ReadonlySet<string> | undefined,
): WithheldDispositionCounts | undefined {
  if (priorWithheld.length === 0) {
    return undefined;
  }

  const dispositions = deriveWithheldDispositions(
    priorWithheld,
    currentBlockingIds,
    currentWithheldIds,
    reviewedPaths,
  );

  const counts: WithheldDispositionCounts = {
    promoted: 0,
    stillWithheld: 0,
    resolved: 0,
    carriedForward: 0,
  };

  for (const disposition of dispositions.values()) {
    counts[disposition] += 1;
  }

  return counts;
}
