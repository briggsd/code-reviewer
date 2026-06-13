import type { Finding, GateDecision, ReviewerRunResult } from "../contracts/index.ts";

/** The trusted reviewer role that produces the comprehension-gate verdict (#26). */
export const COMPREHENSION_ROLE = "comprehension";

/**
 * Derive the comprehension-gate verdict from a set of comprehension findings.
 *
 * Deterministic and severity-driven, biased to FAIL TOWARD SURFACING:
 * - no findings              → `allow` (the change is self-explanatory)
 * - only `suggestion`s       → `warn`  (minor clarity gaps; human review starts here)
 * - any `warning`/`critical` → `block` (a real comprehension gap to resolve first)
 *
 * Any present finding whose severity is neither `warning` nor `critical` still yields at least
 * `warn` — including an unrecognized/future severity value — so the gate never silently returns
 * `allow` when findings exist.
 */
export function deriveGateDecision(comprehensionFindings: readonly Finding[]): GateDecision {
  let sawNonBlocking = false;
  for (const finding of comprehensionFindings) {
    // Widen for the defensive check: `severity` is typed but the findings are model-authored.
    const severity: string = finding.severity;
    if (severity === "critical" || severity === "warning") {
      return "block";
    }
    sawNonBlocking = true;
  }
  return sawNonBlocking ? "warn" : "allow";
}

/**
 * True when the opt-in comprehension reviewer actually ran this review — keyed on the
 * runner-DISPATCHED `ReviewerRunResult.role` (set by the runner when it dispatches the reviewer),
 * never a model-authored label. This decides whether a verdict is shown at all, so a run without a
 * comprehension reviewer never produces one regardless of how findings are labeled.
 */
export function comprehensionReviewerRan(reviewerResults: readonly ReviewerRunResult[]): boolean {
  return reviewerResults.some((result) => result.role === COMPREHENSION_ROLE);
}

/**
 * The comprehension findings that drive the verdict: from the FINAL gated finding set (post-
 * grounding, post-stable-id, post-acknowledgement), attributed by the `reviewer` label and
 * excluding acknowledged ones.
 *
 * Why the gated set + label rather than the raw dispatched findings: the verdict is observability
 * and must match what CI sees and what the comment displays. Deriving from raw reviewer output
 * diverges from CI whenever grounding drops a finding (cited code absent from the diff) or a
 * `stableFindingId` acknowledgement matches (raw findings have no assigned id yet). Reading the
 * gated set keeps all three consistent. Attribution uses the same model-authored `reviewer` label
 * that the grouped renderer and `run_metrics.findingsByReviewer` already rely on system-wide.
 *
 * Trade-off, both directions, accepted and bounded (#26 review rounds 1–4): because attribution is
 * by label, a comprehension finding the model mis-attributes to another role is UNDER-counted
 * (verdict skews toward `allow`), and conversely a co-dispatched reviewer's finding the model labels
 * `comprehension` is OVER-counted (verdict skews toward `block`). Both skew only this observability
 * verdict: CI is governed independently by `decideCiOutcome` over ALL findings regardless of label,
 * so the merge gate is never affected in either direction. `comprehensionReviewerRan` (trusted
 * dispatched role) still guards whether a verdict is shown at all, so a run where the comprehension
 * reviewer never dispatched cannot surface a verdict no matter how findings are labeled. Attributing
 * the verdict VALUE by dispatched role instead would require finding-level provenance through
 * coordinator fusion (which does not exist) and diverged from CI on grounding + stableFindingId acks
 * (rounds 2–3); label attribution keeps the verdict consistent with CI and with the rest of the
 * system (grouped rendering, `run_metrics.findingsByReviewer`).
 */
export function selectComprehensionGateFindings(gatedFindings: readonly Finding[]): Finding[] {
  return gatedFindings.filter(
    (finding) => finding.reviewer === COMPREHENSION_ROLE && finding.acknowledged === undefined,
  );
}
