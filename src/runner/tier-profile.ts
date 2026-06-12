/**
 * Declarative tier → behavior mapping (issues #100 / #101).
 * This is the SINGLE place where risk tier maps to runtime behavior.
 * All consumers (reviewer selection, timeout scaling, tool policy, coordinator short-circuit)
 * read from getTierProfile() rather than implementing their own tier checks.
 */

import type { RiskTier } from "../contracts/index.ts";

export interface TierProfile {
  readonly tier: RiskTier;
  /**
   * Cap on reviewer roles for this tier.
   * "all_enabled" = no cap (config reviewerPolicy alone decides).
   * A list = intersect with config-enabled roles; the cap never re-enables a disabled role.
   */
  readonly reviewerRoleCap: readonly string[] | "all_enabled";
  /**
   * When true, the runtime may skip the coordinator agent call if every dispatched reviewer
   * succeeded and produced zero findings. A deterministic approved summary is returned instead.
   */
  readonly shortCircuitCoordinatorOnZeroFindings: boolean;
  /** Multiplier applied to configured reviewer/coordinator/overall timeouts. */
  readonly timeoutScale: number;
  /**
   * When true, deny repo-crawling read tools + shell for this tier
   * (forces supplied-artifact-only review).
   */
  readonly denyContextTools: boolean;
}

const TIER_PROFILES: Readonly<Record<RiskTier, TierProfile>> = Object.freeze({
  trivial: Object.freeze({
    tier: "trivial" as const,
    reviewerRoleCap: Object.freeze(["code_quality"]),
    shortCircuitCoordinatorOnZeroFindings: true,
    timeoutScale: 0.25,
    denyContextTools: true,
  }),
  lite: Object.freeze({
    tier: "lite" as const,
    reviewerRoleCap: "all_enabled" as const,
    shortCircuitCoordinatorOnZeroFindings: true,
    timeoutScale: 0.5,
    denyContextTools: true,
  }),
  full: Object.freeze({
    tier: "full" as const,
    reviewerRoleCap: "all_enabled" as const,
    shortCircuitCoordinatorOnZeroFindings: false,
    timeoutScale: 1,
    denyContextTools: false,
  }),
});

export function getTierProfile(tier: RiskTier): TierProfile {
  return TIER_PROFILES[tier];
}
