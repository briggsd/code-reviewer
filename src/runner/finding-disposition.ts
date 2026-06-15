import type { ReReviewFindingClassification } from "../contracts/review.ts";

/**
 * Per-finding disposition outcome (#256, M023 S04).
 *
 *   fixed       — the finding was resolved (re-review found it absent)
 *   dismissed   — a human explicitly rejected the finding (wrong/won't-fix)
 *   ignored     — still present but not addressed (recurring, no ack)
 *   acknowledged — human accepted-as-is (ack without dismissed verdict)
 *
 * M026 S03 imports this to render per-finding disposition in the comment.
 */
export type FindingDisposition = "fixed" | "dismissed" | "ignored" | "acknowledged";

/**
 * Derive the disposition of a prior finding from this round of re-review.
 *
 * Precedence (first match wins):
 *   1. Finding has an ack with verdict "dismissed"             → dismissed
 *   2. Finding has an ack (verdict "acknowledged" or absent)   → acknowledged
 *   3. Re-review status "fixed" (absent + actually re-reviewed) → fixed
 *   4. Re-review status "recurring" (still present, no ack)    → ignored
 *   5. Status new / withheld / carried_forward                 → undefined (excluded)
 *
 * Ack detection: for a recurring finding, the ack is on the live `finding`; for a fixed
 * finding, the ack (if any) is on the `priorFinding` from the prior state. The ack's verdict
 * is surfaced via `finding.acknowledged.verdict` by `applyAcknowledgements` (#256).
 *
 * Pure, deterministic, no I/O. Exported for M026 S03 (#280) to import.
 *
 * @param classification - A single re-review classification from ReReviewSummary.classifications.
 * @returns The FindingDisposition, or undefined for excluded statuses.
 */
export function deriveDisposition(
  classification: ReReviewFindingClassification,
): FindingDisposition | undefined {
  const { status, finding, priorFinding } = classification;

  // Only "recurring" and "fixed" can be prior findings with a disposition.
  // New / withheld / carried_forward → excluded (not dispositions of prior findings).
  if (status !== "recurring" && status !== "fixed") {
    return undefined;
  }

  // Determine which finding carries the ack annotation.
  // - recurring: the live `finding` was acked this round.
  // - fixed: the finding is gone; check `priorFinding` for a prior-round ack.
  const ackedFinding = status === "recurring" ? finding : priorFinding;
  const ackVerdict = ackedFinding?.acknowledged?.verdict;
  const hasAck = ackedFinding?.acknowledged !== undefined;

  // Precedence 1: ack with verdict "dismissed"
  if (hasAck && ackVerdict === "dismissed") {
    return "dismissed";
  }

  // Precedence 2: ack with verdict "acknowledged" or absent verdict (default)
  if (hasAck) {
    return "acknowledged";
  }

  // Precedence 3: no ack, re-review classified it fixed
  if (status === "fixed") {
    return "fixed";
  }

  // Precedence 4: no ack, still present (recurring)
  return "ignored";
}
