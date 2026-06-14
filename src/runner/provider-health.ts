import type {
  ModelSelection,
  ProviderHealthRegistry,
  ReviewErrorClassification,
} from "../contracts/index.ts";
import { isFailbackEligible } from "./error-classifier.ts";

/**
 * After this many failback-eligible failures from a single provider in the current run, that
 * provider is marked degraded and skipped for the rest of the run.
 *
 * Hardcoded at 1: a single rate-limit or transient failure is enough signal to try the next
 * provider. The degradation is within-run only — see ProviderHealthRegistry comment.
 */
const PROVIDER_DEGRADE_THRESHOLD = 1;

/** Stable identity key for a ModelSelection: lowercased provider (case-insensitive, matching #138 selectModel). */
function providerKey(sel: ModelSelection): string {
  return sel.provider.toLowerCase();
}

/**
 * In-memory provider health registry for within-run cross-provider failback (#137 S04).
 *
 * WITHIN-RUN ONLY: state is in-memory and discarded after the CI process exits. A provider that
 * fails in one run rediscovers failback on the next PR — there is no cross-run durable state, no
 * half-open/cooldown probe, and no file-backed circuit breaker. This is deliberate: the runner is
 * a short-lived CI process and cross-run persistence is explicitly deferred.
 */
export class InMemoryProviderHealthRegistry implements ProviderHealthRegistry {
  /** Per-provider failback-eligible failure count this run. */
  private readonly failureCounts = new Map<string, number>();

  private isDegraded(provider: string): boolean {
    return (this.failureCounts.get(provider.toLowerCase()) ?? 0) >= PROVIDER_DEGRADE_THRESHOLD;
  }

  selectStart(chain: readonly ModelSelection[]): ModelSelection | undefined {
    return chain.find((sel) => !this.isDegraded(sel.provider));
  }

  recordFailureAndSelectNext(input: {
    failed: ModelSelection;
    classification: ReviewErrorClassification;
    chain: readonly ModelSelection[];
  }): { next?: ModelSelection; exhausted: boolean; hopCount: number } {
    const { failed, classification, chain } = input;

    if (!isFailbackEligible(classification)) {
      // Non-failback-eligible (timeout, truncated, auth, etc.) is NOT a provider-health signal: a
      // slow or timed-out reviewer does not mean the provider is down, so it must NOT degrade the
      // provider — doing so would sideline a healthy provider for every later agent. The caller
      // retries the SAME model. Only failback-eligible failures count toward degradation (below).
      return { exhausted: false, hopCount: 0 };
    }

    // Failback-eligible (rate_limited / retryable_transient) IS a provider-health signal: record it
    // (degrading the provider once it reaches PROVIDER_DEGRADE_THRESHOLD), then scan forward in the
    // chain from the position after `failed` for the first non-degraded provider.
    const key = providerKey(failed);
    this.failureCounts.set(key, (this.failureCounts.get(key) ?? 0) + 1);

    const failedIndex = chain.findIndex(
      (sel) => sel.provider.toLowerCase() === key && sel.model === failed.model,
    );
    const searchFrom = failedIndex === -1 ? 0 : failedIndex + 1;

    for (let i = searchFrom; i < chain.length; i += 1) {
      const candidate = chain[i];
      if (candidate !== undefined && !this.isDegraded(candidate.provider)) {
        // hopCount is the number of provider failovers performed by THIS call — always 1 (a single
        // switch to the selected provider). Skipped same-provider chain entries are not extra hops.
        return { next: candidate, exhausted: false, hopCount: 1 };
      }
    }

    // No non-degraded provider remains in the chain.
    return { exhausted: true, hopCount: 0 };
  }
}
