import type { Acknowledgement, Finding } from "../contracts/index.ts";
import { matchesGlob } from "./path-match.ts";

export interface AcknowledgementResult {
  findings: Finding[]; // acknowledged ones annotated + kept; suppressed ones removed; order preserved
  acknowledgedCount: number;
  suppressedCount: number;
}

/**
 * Per-ack precomputed scope metadata — computed once per active ack before the per-finding loop
 * to avoid O(N²·A) rescans and to carry the fan-out guard count (#346 round 3).
 */
interface AckScope {
  ack: Acknowledgement;
  /** True when the pinned stableFindingId is present among findings that match this ack's path
   * (and optional category). False when the ID has drifted away from scope. */
  pinnedIdIsPresentInScope: boolean;
  /** How many findings in the full set match this ack's path (and optional category).
   * Used as a fan-out guard: relaxation on a drifted ID fires ONLY when exactly one
   * path+category-matching finding exists — if ≥2 match, the drift is ambiguous and the
   * ack requires an exact ID match instead of fanning out. */
  scopeMatchCount: number;
}

/**
 * Apply base-branch acknowledgements to findings (#60-P3b).
 *
 * - acknowledge (safe default): finding is kept + annotated; excluded from gate.
 * - suppress: finding is removed — UNLESS reviewer === "security", which is downgraded to
 *   acknowledge (never silently hide a security finding from a project-config suppression).
 * - An ack whose `expires` (YYYY-MM-DD) is strictly before `todayStr` is inactive (ignored).
 *
 * Pure: no I/O, no mutation of inputs.
 */
export function applyAcknowledgements(
  findings: readonly Finding[],
  acknowledgements: readonly Acknowledgement[],
  now: Date,
): AcknowledgementResult {
  const todayStr = now.toISOString().slice(0, 10);

  const activeAcks = acknowledgements.filter(
    (ack) => ack.expires === undefined || ack.expires >= todayStr,
  );

  // Precompute per-ack scope metadata once — O(N·A) — so the per-finding loop does not
  // rescan allFindings on every call to matchesAck (avoids O(N²·A) cost, #346 round 3).
  const ackScopes: AckScope[] = activeAcks.map((ack) => {
    if (ack.stableFindingId === undefined) {
      // No pinned ID: scope metadata is unused for the stableFindingId branch.
      return { ack, pinnedIdIsPresentInScope: false, scopeMatchCount: 0 };
    }

    let pinnedIdIsPresentInScope = false;
    let scopeMatchCount = 0;

    for (const f of findings) {
      const pathMatches = matchesGlob(f.location?.path ?? "", ack.path);
      const categoryMatches = ack.category === undefined || ack.category === f.category;
      if (pathMatches && categoryMatches) {
        scopeMatchCount += 1;
        if (f.id === ack.stableFindingId) {
          pinnedIdIsPresentInScope = true;
        }
      }
    }

    return { ack, pinnedIdIsPresentInScope, scopeMatchCount };
  });

  const result: Finding[] = [];
  let acknowledgedCount = 0;
  let suppressedCount = 0;

  for (const finding of findings) {
    const matchedScope = ackScopes.find((scope) => matchesAck(finding, scope));

    if (matchedScope === undefined) {
      result.push(finding);
      continue;
    }

    const matchedAck = matchedScope.ack;

    // Security guard: suppress on a security finding is downgraded to acknowledge
    const effectiveMode: "acknowledge" | "suppress" =
      matchedAck.mode === "suppress" && finding.reviewer === "security"
        ? "acknowledge"
        : matchedAck.mode;

    if (effectiveMode === "acknowledge") {
      result.push({
        ...finding,
        acknowledged: {
          reason: matchedAck.reason,
          // Surface the ack's verdict so deriveDisposition can distinguish dismissed vs acknowledged (#256).
          ...(matchedAck.verdict !== undefined ? { verdict: matchedAck.verdict } : {}),
        },
      });
      acknowledgedCount += 1;
    } else {
      // suppress: drop the finding entirely
      suppressedCount += 1;
    }
  }

  return { findings: result, acknowledgedCount, suppressedCount };
}

/**
 * Returns true when `finding` matches the precomputed ack scope.
 *
 * stableFindingId three-case logic (#346):
 *   (a) no stableFindingId → path+category match is sufficient.
 *   (b) pinned ID is still live in scope → require exact-ID match (sibling precision).
 *   (c) pinned ID has drifted away:
 *       - suppress mode: DO NOT relax (drifted suppressed finding re-surfaces safely).
 *       - security findings: NEVER relax, regardless of mode.
 *       - scopeMatchCount !== 1: DO NOT relax (ambiguous; ≥2 path+category matches would
 *         fan out the ack to siblings the operator never accepted).
 *       - else: relax to path+category (exactly one path+category match — unambiguous drift).
 *
 * Per-ack scope (pinnedIdIsPresentInScope, scopeMatchCount) is precomputed once in
 * applyAcknowledgements to keep matching cost at O(N·A).
 */
function matchesAck(finding: Finding, scope: AckScope): boolean {
  const { ack, pinnedIdIsPresentInScope, scopeMatchCount } = scope;

  // path is required on an ack
  if (!matchesGlob(finding.location?.path ?? "", ack.path)) {
    return false;
  }

  // category: if specified, must equal finding.category
  if (ack.category !== undefined && ack.category !== finding.category) {
    return false;
  }

  if (ack.stableFindingId !== undefined) {
    if (pinnedIdIsPresentInScope) {
      // Case (b): pinned ID is still live in scope — require exact match (sibling precision).
      if (ack.stableFindingId !== finding.id) {
        return false;
      }
    } else {
      // Case (c): pinned ID has drifted away.
      // Suppress mode must NOT relax — drifted suppressed finding re-surfaces safely.
      if (ack.mode === "suppress") {
        return false;
      }
      // Security findings must NOT relax, even in acknowledge mode — never silently absorb
      // a drifted security finding; it re-surfaces for manual review.
      if (finding.reviewer === "security") {
        return false;
      }
      // Fan-out guard: relaxation requires exactly one path+category match in scope.
      // If ≥2 findings match, the drift is ambiguous — do NOT relax (require exact ID,
      // so drifted siblings re-surface safely rather than being fan-out acknowledged).
      if (scopeMatchCount !== 1) {
        return false;
      }
      // acknowledge mode + non-security + exactly one scope match: relax to path+category.
    }
  }

  return true;
}
