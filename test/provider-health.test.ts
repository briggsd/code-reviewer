/**
 * Unit tests for InMemoryProviderHealthRegistry (#137 S04).
 * All deterministic — no network, no randomness, no time dependencies.
 */
import { describe, expect, test } from "bun:test";
import type { ModelSelection, ReviewErrorClassification } from "../src/contracts/index.ts";
import { InMemoryProviderHealthRegistry } from "../src/runner/provider-health.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sel = (provider: string, model: string): ModelSelection => ({ provider, model });

const rateLimited = (): ReviewErrorClassification => ({
  category: "rate_limited",
  retryable: true,
  reason: "429 rate limit",
});

const transient = (): ReviewErrorClassification => ({
  category: "retryable_transient",
  retryable: true,
  reason: "503 service unavailable",
});

const timeout = (): ReviewErrorClassification => ({
  category: "timeout",
  retryable: true,
  reason: "timed out",
});

const authFailure = (): ReviewErrorClassification => ({
  category: "auth",
  retryable: false,
  reason: "unauthorized",
});

const chain = (entries: Array<{ p: string; m: string }>): ModelSelection[] =>
  entries.map(({ p, m }) => sel(p, m));

// ---------------------------------------------------------------------------
// 1. selectStart
// ---------------------------------------------------------------------------

describe("InMemoryProviderHealthRegistry.selectStart", () => {
  test("returns first entry when no providers are degraded", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);
    expect(registry.selectStart(c)).toEqual(sel("anthropic", "claude-sonnet"));
  });

  test("returns undefined for an empty chain", () => {
    const registry = new InMemoryProviderHealthRegistry();
    expect(registry.selectStart([])).toBeUndefined();
  });

  test("skips degraded first provider and returns the second", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);
    // Degrade anthropic.
    registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });
    expect(registry.selectStart(c)).toEqual(sel("openai", "gpt-4"));
  });

  test("returns undefined when all chain providers are degraded", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);
    // Degrade both.
    registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });
    registry.recordFailureAndSelectNext({
      failed: sel("openai", "gpt-4"),
      classification: transient(),
      chain: c,
    });
    expect(registry.selectStart(c)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. recordFailureAndSelectNext — failback-eligible classifications
// ---------------------------------------------------------------------------

describe("InMemoryProviderHealthRegistry.recordFailureAndSelectNext — failback-eligible", () => {
  test("rate_limited failure advances to next non-degraded provider (hop)", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });

    expect(decision.next).toEqual(sel("openai", "gpt-4"));
    expect(decision.exhausted).toBe(false);
    expect(decision.hopCount).toBeGreaterThan(0);
  });

  test("retryable_transient failure advances to next non-degraded provider", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: transient(),
      chain: c,
    });

    expect(decision.next).toEqual(sel("openai", "gpt-4"));
    expect(decision.exhausted).toBe(false);
  });

  test("degraded provider is skipped in subsequent selectStart calls", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
      { p: "google", m: "gemini" },
    ]);

    // Fail anthropic.
    registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });

    // anthropic is now degraded; selectStart should skip it.
    expect(registry.selectStart(c)).toEqual(sel("openai", "gpt-4"));
  });

  test("failed provider is not returned as next even if it appears later in the chain", () => {
    const registry = new InMemoryProviderHealthRegistry();
    // Chain has anthropic twice — should not return the second occurrence after first fails.
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "anthropic", m: "claude-opus" },
      { p: "openai", m: "gpt-4" },
    ]);
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });

    // anthropic degraded → skip both anthropic entries → openai.
    expect(decision.next).toEqual(sel("openai", "gpt-4"));
    expect(decision.exhausted).toBe(false);
  });

  test("returns exhausted:true when chain is drained after last provider fails", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);

    // Degrade anthropic → hop to openai.
    registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });

    // Now openai also fails.
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("openai", "gpt-4"),
      classification: transient(),
      chain: c,
    });

    expect(decision.exhausted).toBe(true);
    expect(decision.next).toBeUndefined();
  });

  test("chain-exhaustion: hopCount is 0 when no hop occurred before exhaustion", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([{ p: "anthropic", m: "claude-sonnet" }]);
    // Single-entry chain — no next to hop to.
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });
    expect(decision.exhausted).toBe(true);
    expect(decision.next).toBeUndefined();
    expect(decision.hopCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. recordFailureAndSelectNext — non-failback-eligible classifications
// ---------------------------------------------------------------------------

describe("InMemoryProviderHealthRegistry.recordFailureAndSelectNext — non-failback-eligible", () => {
  test("timeout: returns no next, exhausted:false (same-model retry)", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: timeout(),
      chain: c,
    });

    expect(decision.next).toBeUndefined();
    expect(decision.exhausted).toBe(false);
    expect(decision.hopCount).toBe(0);
  });

  test("auth: returns no next, exhausted:false", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: authFailure(),
      chain: c,
    });

    expect(decision.next).toBeUndefined();
    expect(decision.exhausted).toBe(false);
  });

  test("non-failback failures do NOT degrade the provider (F1 regression)", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);

    // A timeout is not a provider-health signal — it must NOT degrade anthropic.
    registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: timeout(),
      chain: c,
    });

    // The load-bearing assertion: selectStart STILL returns anthropic, proving the timeout did not
    // sideline a healthy provider for later agents. (The prior assertion — that a *subsequent*
    // rate_limit hops to openai — held whether or not the timeout degraded anthropic, so it never
    // actually caught the bug.)
    expect(registry.selectStart(c)).toEqual(sel("anthropic", "claude-sonnet"));

    // An auth failure likewise leaves anthropic eligible.
    registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: authFailure(),
      chain: c,
    });
    expect(registry.selectStart(c)).toEqual(sel("anthropic", "claude-sonnet"));

    // Only NOW, a failback-eligible (rate_limit) failure degrades anthropic → next is openai.
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: c,
    });
    expect(decision.next).toEqual(sel("openai", "gpt-4"));
    expect(registry.selectStart(c)).toEqual(sel("openai", "gpt-4"));
  });

  test("hopCount is 1 per provider switch, even when same-provider entries are skipped (F4)", () => {
    const registry = new InMemoryProviderHealthRegistry();
    // anthropic appears twice before openai — degrading anthropic skips BOTH its entries, but that
    // is a single provider failover, so hopCount must be 1 (not the 2-position delta).
    const c = chain([
      { p: "anthropic", m: "model-a" },
      { p: "anthropic", m: "model-b" },
      { p: "openai", m: "gpt-4" },
    ]);
    const decision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "model-a"),
      classification: rateLimited(),
      chain: c,
    });
    expect(decision.next).toEqual(sel("openai", "gpt-4"));
    expect(decision.hopCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Two-reviewer interleave: independent degradation per provider
// ---------------------------------------------------------------------------

describe("InMemoryProviderHealthRegistry — multi-reviewer interleave", () => {
  test("reviewer A failure degrades the provider; reviewer B decision sees it degraded", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const chain2 = chain([
      { p: "anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);

    // Reviewer A fails on anthropic → anthropic degraded → hop to openai.
    const aDecision = registry.recordFailureAndSelectNext({
      failed: sel("anthropic", "claude-sonnet"),
      classification: rateLimited(),
      chain: chain2,
    });
    expect(aDecision.next).toEqual(sel("openai", "gpt-4"));

    // Reviewer B starts — anthropic already degraded. selectStart skips it.
    expect(registry.selectStart(chain2)).toEqual(sel("openai", "gpt-4"));

    // Reviewer B fails on openai → exhausted for both.
    const bDecision = registry.recordFailureAndSelectNext({
      failed: sel("openai", "gpt-4"),
      classification: transient(),
      chain: chain2,
    });
    expect(bDecision.exhausted).toBe(true);
    expect(bDecision.next).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Provider identity: case-insensitive
// ---------------------------------------------------------------------------

describe("InMemoryProviderHealthRegistry — provider key is case-insensitive", () => {
  test("degrading 'Anthropic' (mixed-case) causes selectStart to skip 'anthropic' (lower)", () => {
    const registry = new InMemoryProviderHealthRegistry();
    const c = chain([
      { p: "Anthropic", m: "claude-sonnet" },
      { p: "openai", m: "gpt-4" },
    ]);

    registry.recordFailureAndSelectNext({
      failed: { provider: "ANTHROPIC", model: "claude-sonnet" },
      classification: rateLimited(),
      chain: c,
    });

    // The chain entry uses "Anthropic" (different case) — must still be treated as degraded.
    expect(registry.selectStart(c)).toEqual({ provider: "openai", model: "gpt-4" });
  });
});
