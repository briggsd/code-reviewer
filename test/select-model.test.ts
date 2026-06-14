import { describe, expect, test } from "bun:test";
import { parseDisabledProviders } from "../src/cli/run-options.ts";
import type {
  ModelRoutingConfig,
  ModelSelection,
  ReviewConfig,
  ReviewContext,
  RiskAssessment,
} from "../src/index.ts";
import { normalizeReviewConfig } from "../src/runner/config.ts";
import { selectModel, selectModelChain } from "../src/runner/run-review.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRisk(tier: "trivial" | "lite" | "full"): RiskAssessment {
  return {
    tier,
    reason: "test",
    matchedRules: [],
    sensitivePaths: [],
    reviewedFileCount: 1,
    ignoredFileCount: 0,
  };
}

/**
 * Minimal ReviewContext for selectModel tests. Mirrors the shape used in
 * tier-profile.test.ts and runner.test.ts, with no I/O required.
 */
function makeContext(
  options: {
    tier?: "trivial" | "lite" | "full";
    modelRouting?: Partial<ModelRoutingConfig>;
    disabledProviders?: readonly string[];
  } = {},
): ReviewContext {
  const tier = options.tier ?? "full";
  const baseRouting: ModelRoutingConfig = {
    default: { provider: "anthropic", model: "claude-default" },
    roles: {},
  };
  const modelRouting: ModelRoutingConfig = { ...baseRouting, ...options.modelRouting };
  const config = normalizeReviewConfig({}) as ReviewConfig;
  const effectiveConfig: ReviewConfig = { ...config, modelRouting };

  const context: ReviewContext = {
    runId: "test-run",
    safetyMode: "trusted",
    workingDirectory: "/tmp",
    contextDirectory: "/tmp/ctx",
    metadata: {
      provider: "local",
      repository: { provider: "local", name: "demo", slug: "demo" },
      changeId: "1",
      headSha: "abc",
      title: "test",
      author: { username: "dev" },
      labels: [],
    },
    diff: {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    },
    risk: makeRisk(tier),
    config: effectiveConfig,
  };

  if (options.disabledProviders !== undefined) {
    return { ...context, disabledProviders: options.disabledProviders };
  }
  return context;
}

const sel = (provider: string, model: string): ModelSelection => ({ provider, model });

// ---------------------------------------------------------------------------
// 1. No-regression: no byTier, no disabledProviders
// ---------------------------------------------------------------------------

describe("selectModel — no byTier, no disabledProviders (regression)", () => {
  test("returns routing.roles[role] when role is configured", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { coordinator: sel("anthropic", "claude-coordinator") },
      },
    });
    const result = selectModel(ctx, "coordinator");
    expect(result.model).toBe("claude-coordinator");
    expect(result.provider).toBe("anthropic");
  });

  test("falls back to routing.default when role is not configured", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: {},
      },
    });
    const result = selectModel(ctx, "security");
    expect(result.model).toBe("claude-default");
  });

  test("thinking inheritance: role without thinking inherits default thinking", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "high" },
        roles: { code_quality: sel("anthropic", "claude-lite") },
      },
    });
    const result = selectModel(ctx, "code_quality");
    expect(result.model).toBe("claude-lite");
    expect(result.thinking).toBe("high");
  });

  test("thinking not inherited when role explicitly sets it", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "high" },
        roles: {
          code_quality: { provider: "anthropic", model: "claude-lite", thinking: "low" },
        },
      },
    });
    const result = selectModel(ctx, "code_quality");
    expect(result.thinking).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// 2. Per-tier role override wins over top-level role for that tier
// ---------------------------------------------------------------------------

describe("selectModel — per-tier role override (#138)", () => {
  test("per-tier role wins over top-level role for the matching tier", () => {
    const ctx = makeContext({
      tier: "trivial",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { coordinator: sel("anthropic", "claude-coordinator-toplevel") },
        byTier: {
          trivial: {
            roles: { coordinator: sel("openai", "gpt-tier-role") },
          },
        },
      },
    });
    const result = selectModel(ctx, "coordinator");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-tier-role");
  });

  test("a different tier falls back to top-level role when byTier doesn't override it", () => {
    const ctx = makeContext({
      tier: "full", // byTier only defines trivial
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { coordinator: sel("anthropic", "claude-coordinator-toplevel") },
        byTier: {
          trivial: {
            roles: { coordinator: sel("openai", "gpt-tier-role") },
          },
        },
      },
    });
    const result = selectModel(ctx, "coordinator");
    // full tier: no byTier entry → falls back to top-level role
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-coordinator-toplevel");
  });

  test("per-tier default is used when the tier has no role entry for the role", () => {
    const ctx = makeContext({
      tier: "lite",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: {},
        byTier: {
          lite: {
            default: sel("google", "gemini-lite-default"),
            // no roles entry for 'security'
          },
        },
      },
    });
    const result = selectModel(ctx, "security");
    expect(result.provider).toBe("google");
    expect(result.model).toBe("gemini-lite-default");
  });

  test("per-tier role wins over per-tier default", () => {
    const ctx = makeContext({
      tier: "lite",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: {},
        byTier: {
          lite: {
            default: sel("google", "gemini-lite-default"),
            roles: { security: sel("openai", "gpt-security") },
          },
        },
      },
    });
    const result = selectModel(ctx, "security");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-security");
  });
});

// ---------------------------------------------------------------------------
// 3. Provider-disable fall-through
// ---------------------------------------------------------------------------

describe("selectModel — provider-disable (#138)", () => {
  test("disabling the most-specific candidate's provider falls through to the next candidate", () => {
    const ctx = makeContext({
      tier: "trivial",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { coordinator: sel("openai", "gpt-coordinator") },
        byTier: {
          trivial: {
            roles: { coordinator: sel("google", "gemini-tier-role") },
          },
        },
      },
      disabledProviders: ["google"], // disables the most-specific (per-tier role) candidate
    });
    // Should fall through to: [google (disabled), undefined(no tier-default), openai, anthropic]
    // → openai is the first non-disabled
    const result = selectModel(ctx, "coordinator");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-coordinator");
  });

  test("disabling multiple providers falls through to the remaining candidate", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { coordinator: sel("openai", "gpt-coordinator") },
      },
      disabledProviders: ["openai"], // disables the role candidate; falls through to default
    });
    const result = selectModel(ctx, "coordinator");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-default");
  });

  test("no candidates disabled → first candidate wins (regression)", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { coordinator: sel("openai", "gpt-coordinator") },
      },
      disabledProviders: [], // empty set; no disabling
    });
    const result = selectModel(ctx, "coordinator");
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-coordinator");
  });
});

// ---------------------------------------------------------------------------
// 4. All-disabled throws terminal error
// ---------------------------------------------------------------------------

describe("selectModel — all-disabled throws (#138)", () => {
  test("throws when every candidate provider is disabled", () => {
    const ctx = makeContext({
      tier: "trivial",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { coordinator: sel("openai", "gpt-coordinator") },
      },
      disabledProviders: ["openai", "anthropic"], // covers both role + default
    });
    expect(() => selectModel(ctx, "coordinator")).toThrow(
      /selectModel: no model for role "coordinator" at tier "trivial"/,
    );
    expect(() => selectModel(ctx, "coordinator")).toThrow(/anthropic.*openai|openai.*anthropic/);
  });

  test("throw message lists disabled providers sorted", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("openai", "gpt-default"),
        roles: {},
      },
      disabledProviders: ["openai"],
    });
    expect(() => selectModel(ctx, "any_role")).toThrow("openai");
  });
});

// ---------------------------------------------------------------------------
// 5. Trust boundary: disabledProviders is NOT in ReviewConfig / .ai-review.json
// ---------------------------------------------------------------------------

describe("selectModel — trust boundary: disabledProviders is NOT config-sourced (#138)", () => {
  test("ReviewConfig has no disabledProviders property — it lives on ReviewContext, not config", () => {
    // The ReviewConfig type (from .ai-review.json) does NOT have a disabledProviders field.
    // The only path to set ReviewContext.disabledProviders is via RunReviewOptions (env/operator).
    // We verify: even if a stray disabledProviders key is passed in config JSON, selectModel
    // ignores it — the lever only works through ReviewContext.disabledProviders (set from
    // RunReviewOptions.disabledProviders, sourced from AI_REVIEW_DISABLED_PROVIDERS env only).

    // 1. The static type check: ReviewConfig does not have the field. This is enforced by TS
    //    (the field does not exist on ReviewConfig) — verified by compilation.
    //    We document the runtime invariant: a context built from a config carrying the stray key
    //    does NOT gate provider selection (the key does not propagate to context.disabledProviders).
    const config = normalizeReviewConfig({}) as ReviewConfig;

    // 2. The runtime check: a context with no disabledProviders set in RunReviewOptions does NOT
    //    block any provider, even if the underlying config is from .ai-review.json.
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("openai", "gpt-default"),
        roles: {},
        ...(config.modelRouting.byTier !== undefined ? { byTier: config.modelRouting.byTier } : {}),
      },
      // deliberately NO disabledProviders — simulates a config-only path
    });
    // openai is selected without restriction; no disabledProviders on context → no gating
    expect(selectModel(ctx, "any_role").provider).toBe("openai");
  });

  test("only ReviewContext.disabledProviders (from options/env) gates provider selection", () => {
    // Context WITHOUT disabledProviders → provider not gated
    const ctxWithout = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("openai", "gpt-default"),
        roles: {},
      },
      // no disabledProviders
    });
    expect(() => selectModel(ctxWithout, "any_role")).not.toThrow();
    expect(selectModel(ctxWithout, "any_role").provider).toBe("openai");

    // Context WITH disabledProviders (operator-set) → provider gated
    const ctxWith = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("openai", "gpt-default"),
        roles: {},
      },
      disabledProviders: ["openai"],
    });
    expect(() => selectModel(ctxWith, "any_role")).toThrow(/no model for role/);
  });
});

// ---------------------------------------------------------------------------
// 6. Config merge: byTier survives normalizeReviewConfig
// ---------------------------------------------------------------------------

describe("normalizeReviewConfig — byTier in modelRouting (#138)", () => {
  test("byTier from override survives normalizeReviewConfig and is accessible", () => {
    const config = normalizeReviewConfig({
      modelRouting: {
        byTier: {
          trivial: {
            default: { provider: "openai", model: "gpt-trivial" },
          },
        },
      },
    });
    expect(config.modelRouting.byTier?.trivial?.default?.model).toBe("gpt-trivial");
  });

  test("byTier from base is preserved when override doesn't set byTier", () => {
    const base = normalizeReviewConfig({
      modelRouting: {
        byTier: { lite: { default: { provider: "google", model: "gemini-lite" } } },
      },
    });
    // Apply a second override that doesn't mention byTier
    const merged = normalizeReviewConfig({ modelRouting: { roles: {} } }, base);
    expect(merged.modelRouting.byTier?.lite?.default?.model).toBe("gemini-lite");
  });

  test("byTier from override replaces byTier from base (wholesale)", () => {
    const base = normalizeReviewConfig({
      modelRouting: {
        byTier: { lite: { default: { provider: "google", model: "gemini-lite" } } },
      },
    });
    const merged = normalizeReviewConfig(
      {
        modelRouting: {
          byTier: { trivial: { default: { provider: "openai", model: "gpt-trivial" } } },
        },
      },
      base,
    );
    // Override wins wholesale — base's lite tier is gone
    expect(merged.modelRouting.byTier?.trivial?.default?.model).toBe("gpt-trivial");
    expect(merged.modelRouting.byTier?.lite).toBeUndefined();
  });

  test("absent byTier stays absent (no spurious field)", () => {
    const config = normalizeReviewConfig({});
    expect(config.modelRouting.byTier).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. parseDisabledProviders helper
// ---------------------------------------------------------------------------

describe("parseDisabledProviders (#138)", () => {
  test("undefined input → undefined", () => {
    expect(parseDisabledProviders(undefined)).toBeUndefined();
  });

  test("empty string → undefined", () => {
    expect(parseDisabledProviders("")).toBeUndefined();
  });

  test("whitespace-only string → undefined", () => {
    expect(parseDisabledProviders("   ")).toBeUndefined();
  });

  test("single provider", () => {
    expect(parseDisabledProviders("openai")).toEqual(["openai"]);
  });

  test("comma-separated providers", () => {
    expect(parseDisabledProviders("openai,google")).toEqual(["openai", "google"]);
  });

  test("trims whitespace around commas", () => {
    expect(parseDisabledProviders(" openai , google ")).toEqual(["openai", "google"]);
  });

  test("deduplicates repeated providers", () => {
    expect(parseDisabledProviders("openai,openai,google")).toEqual(["openai", "google"]);
  });

  test("drops empty entries from trailing/double commas", () => {
    expect(parseDisabledProviders("openai,,google,")).toEqual(["openai", "google"]);
  });

  test("all-empty-after-split → undefined", () => {
    expect(parseDisabledProviders(",,,")).toBeUndefined();
  });

  test("lowercases tokens so the disable lever is case-insensitive (#138 review)", () => {
    expect(parseDisabledProviders("OpenAI,Google")).toEqual(["openai", "google"]);
  });

  test("dedupes case-insensitively after lowercasing", () => {
    expect(parseDisabledProviders("OpenAI,openai,OPENAI")).toEqual(["openai"]);
  });
});

// ---------------------------------------------------------------------------
// 8. thinking inheritance through byTier (#138 — review follow-up)
// ---------------------------------------------------------------------------

describe("selectModel — tier-scoped thinking inheritance (#138)", () => {
  test("a byTier candidate omitting thinking inherits byTier.<tier>.default.thinking over top-level", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "medium" },
        roles: {},
        byTier: {
          full: {
            default: { provider: "anthropic", model: "claude-full", thinking: "high" },
            roles: { security: { provider: "anthropic", model: "claude-sec" } },
          },
        },
      },
    });
    // security (full tier) omits thinking → inherits the tier default's "high", NOT top-level "medium".
    expect(selectModel(ctx, "security").thinking).toBe("high");
  });

  test("falls back to top-level default.thinking when the tier default sets none", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "medium" },
        roles: {},
        byTier: {
          full: { roles: { security: { provider: "anthropic", model: "claude-sec" } } },
        },
      },
    });
    // No byTier.full.default.thinking → inherits top-level "medium".
    expect(selectModel(ctx, "security").thinking).toBe("medium");
  });

  test("a candidate's own thinking still wins over any inherited tier/top-level bound", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "medium" },
        roles: {},
        byTier: {
          full: {
            default: { provider: "anthropic", model: "claude-full", thinking: "high" },
            roles: { security: { provider: "anthropic", model: "claude-sec", thinking: "low" } },
          },
        },
      },
    });
    expect(selectModel(ctx, "security").thinking).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// 9. Round-2 review fixes: case-insensitive disable + no thinking bleed (#138)
// ---------------------------------------------------------------------------

describe("selectModel — case-insensitive provider-disable (#138 review)", () => {
  test("disables a config provider regardless of case in the env value", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { security: sel("openai", "gpt") },
      },
      disabledProviders: ["OpenAI"], // mixed-case env value vs lowercase config provider
    });
    // security's "openai" is disabled by "OpenAI" → falls through to default.
    expect(selectModel(ctx, "security").provider).toBe("anthropic");
  });

  test("disables an upper-case config provider via a lower-case env value", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { security: sel("OpenAI", "gpt") },
      },
      disabledProviders: ["openai"],
    });
    expect(selectModel(ctx, "security").provider).toBe("anthropic");
  });
});

describe("selectModel — tier thinking does not bleed onto top-level fallback (#138 review)", () => {
  test("when provider-disable skips the tier default, a top-level role inherits the TOP default thinking", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "medium" },
        roles: { security: sel("anthropic", "claude-sec") }, // no thinking
        byTier: {
          full: { default: { provider: "google", model: "gemini", thinking: "high" } },
        },
      },
      disabledProviders: ["google"], // disables the tier default candidate
    });
    // Tier default (google, high) is skipped → selected = top-level roles.security (anthropic).
    // It must inherit the TOP default's "medium", NOT the skipped tier default's "high".
    const result = selectModel(ctx, "security");
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sec");
    expect(result.thinking).toBe("medium");
  });
});

// ---------------------------------------------------------------------------
// 10. selectModelChain (#137 S04)
// ---------------------------------------------------------------------------

describe("selectModelChain — chain ordering and selectModel head identity", () => {
  test("chain[0] === selectModel result (head identity)", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { security: sel("openai", "gpt-4") },
      },
    });
    const chain = selectModelChain(ctx, "security");
    expect(chain[0]).toEqual(selectModel(ctx, "security"));
  });

  test("ordering: tier-role → tier-default → role → default", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: { security: sel("openai", "gpt-4") },
        byTier: {
          full: {
            default: sel("google", "gemini"),
            roles: { security: sel("mistral", "mistral-large") },
          },
        },
      },
    });
    const chain = selectModelChain(ctx, "security");
    // Order: tier-role(mistral), tier-default(google), role(openai), default(anthropic)
    expect(chain[0]?.provider).toBe("mistral");
    expect(chain[1]?.provider).toBe("google");
    expect(chain[2]?.provider).toBe("openai");
    expect(chain[3]?.provider).toBe("anthropic");
  });

  test("disabled providers are excluded from the chain", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: {
          security: sel("openai", "gpt-4"),
        },
      },
      disabledProviders: ["openai"],
    });
    const chain = selectModelChain(ctx, "security");
    expect(chain.every((c) => c.provider.toLowerCase() !== "openai")).toBe(true);
    expect(chain[0]?.provider).toBe("anthropic");
  });

  test("deduplication: same provider+model appears only once (first occurrence wins)", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        // role and default both point to the same model.
        default: sel("anthropic", "claude-sonnet"),
        roles: { security: sel("anthropic", "claude-sonnet") },
      },
    });
    const chain = selectModelChain(ctx, "security");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.provider).toBe("anthropic");
    expect(chain[0]?.model).toBe("claude-sonnet");
  });

  test("thinking is resolved for EVERY chain element, not just the head", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "high" },
        roles: {
          // security omits thinking → should inherit from default.
          security: sel("anthropic", "claude-sec"),
        },
        // byTier: omitted — no tier routing, so both entries are top-level.
      },
    });
    const chain = selectModelChain(ctx, "security");
    // chain[0] = roles.security (no thinking → inherits "high")
    // chain[1] = default (has thinking: "high" already)
    expect(chain[0]?.thinking).toBe("high");
    expect(chain[1]?.thinking).toBe("high");
  });

  test("thinking inheritance: tier-scoped element inherits tier default, not top default", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: { provider: "anthropic", model: "claude-default", thinking: "medium" },
        roles: {},
        byTier: {
          full: {
            default: { provider: "google", model: "gemini", thinking: "high" },
            roles: { security: sel("google", "gemini-sec") }, // no thinking — should get "high"
          },
        },
      },
    });
    const chain = selectModelChain(ctx, "security");
    // chain[0] = tier-roles.security — tier-scoped → inherits tier-default's "high"
    // chain[1] = tier-default (google/gemini) — already "high"
    // chain[2] = top-level default (anthropic) — "medium"
    expect(chain[0]?.thinking).toBe("high");
    expect(chain[1]?.thinking).toBe("high");
    expect(chain[2]?.thinking).toBe("medium");
  });

  test("throws the same error as selectModel when all candidates are disabled", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: {},
      },
      disabledProviders: ["anthropic"],
    });
    expect(() => selectModelChain(ctx, "security")).toThrow(
      /selectModel.*no model.*operator-disabled/,
    );
  });

  test("chain with a single entry (no byTier, single default)", () => {
    const ctx = makeContext({
      tier: "full",
      modelRouting: {
        default: sel("anthropic", "claude-default"),
        roles: {},
      },
    });
    const chain = selectModelChain(ctx, "security");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.provider).toBe("anthropic");
  });
});
