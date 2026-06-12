// Thin-review assessment: contextual floor calibrated from observed session data.
//
// Observed bimodal distribution (from M008/M009 session telemetry):
//   - correct/empty reviews: ~140–170 output tokens
//   - engaged reviews: 1.5K–16K output tokens
//
// The motivating failure case for this feature (#76): a substantive gate-logic change
// was reviewed in ~138 output tokens, classified as "full" tier post-#77.
//
// Floor formula: base + 60 * fileCount
//   - trivial tier → floor = 0 (never thin; empty review is CORRECT — #65 says thinking
//     is a cap, not a floor; fast trivial review is expected behavior)
//   - lite tier   → base = 0; floor grows purely with file count
//   - full tier   → base = 300 (the #76 class: any near-empty full-tier review flags)
//
// Why these numbers:
//   - Small clean lite diffs (1–2 files → floor ≤ 120) are NOT flagged when output is
//     ~150 tokens — the common correct-empty case stays quiet.
//   - Larger lite diffs (e.g. 6 files → floor 360) and any near-empty full-tier review
//     (base 300) DO flag — the class of reviews that are suspiciously thin.
//   - Engaged reviews (1.5K+) are far above any realistic floor → never thin.

export interface ThinReviewInput {
  riskTier: string; // "trivial" | "lite" | "full" | other
  reviewedFileCount: number; // diff-size proxy (from risk.reviewedFileCount)
  outputTokens: number | undefined; // total output tokens across all agents
}

export interface ThinReviewAssessment {
  thin: boolean;
  expectedFloor: number; // the contextual floor used (0 for trivial)
  outputTokens: number; // resolved (undefined -> 0)
}

export interface ThinReviewOptions {
  /** If set to a finite, non-negative number, use this FLAT floor instead of the contextual
   *  function (escape hatch for `telemetry:analyze --thin-floor`). A NaN/negative value is
   *  ignored (falls through to the contextual floor) so a bad override can't silently disable
   *  thin detection. Trivial tier is still never flagged. */
  flatFloor?: number;
}

const PER_FILE = 60;
const FULL_BASE = 300;

export function assessThinReview(
  input: ThinReviewInput,
  options?: ThinReviewOptions,
): ThinReviewAssessment {
  const outputTokens = input.outputTokens ?? 0;

  // Trivial tier is never thin — an empty/fast review on a trivial diff is expected
  // (#65: thinking is a cap, not a floor).
  if (input.riskTier === "trivial") {
    return { thin: false, expectedFloor: 0, outputTokens };
  }

  // Guard reviewedFileCount: clamp NaN/negative → 0
  const fileCount = Math.max(
    0,
    Number.isFinite(input.reviewedFileCount) ? input.reviewedFileCount : 0,
  );

  let expectedFloor: number;
  // Use the flat override only when it is a finite, non-negative number — a NaN/negative
  // override would make `outputTokens < floor` always false and silently disable detection.
  if (
    options?.flatFloor !== undefined &&
    Number.isFinite(options.flatFloor) &&
    options.flatFloor >= 0
  ) {
    // Flat override provided (e.g. via --thin-floor CLI flag)
    expectedFloor = options.flatFloor;
  } else {
    const base = input.riskTier === "full" ? FULL_BASE : 0;
    expectedFloor = base + PER_FILE * fileCount;
  }

  const thin = outputTokens < expectedFloor;
  return { thin, expectedFloor, outputTokens };
}
