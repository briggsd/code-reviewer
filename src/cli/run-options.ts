import type { ReviewConfig, ReviewSummary } from "../contracts/review.ts";

/**
 * One-line nudge pointing local operators at `conventions` (#383, M034). Returned when the
 * effective config carries no conventions — covers BOTH "no .ai-review.json" (default config
 * has none) and "a config file without a conventions array". Empty array = no nudge. Printed to
 * stderr by the --git-diff local path only (see cli.ts) — it must never touch stdout (which
 * carries the markdown/JSON review output). Docs/discoverability only; reads config, mutates nothing.
 */
export function formatConventionsHint(config: ReviewConfig): string[] {
  if ((config.conventions?.length ?? 0) > 0) return [];
  return [
    "[ai-review] No project conventions configured. If the reviewer keeps flagging something " +
      'intentional in this repo, add a "conventions" array to .ai-review.json to steer ' +
      "reviewers away from flagging repo-specific exceptions — see docs/user/configuration.md " +
      "(conventions are advisory: they shape review generation, not a hard guarantee).",
  ];
}

/**
 * Build the local-run health + findings-count header lines printed to stdout above the
 * markdown tail (#380/#381, M034). Presentation only — reads the summary, mutates nothing.
 * `degraded` absent = clean (NEVER populate it; summary-markdown renders a banner when it is set).
 * Counts only (no finding text) — M008-safe and human-facing local echo.
 */
export function formatLocalRunHealthHeader(summary: ReviewSummary): string[] {
  const grounded = summary.findings.length;
  const withheld = summary.groundingWithheld?.length ?? 0;
  const failed = summary.degraded?.failedReviewerCount ?? 0;
  const degradedStr =
    summary.degraded === undefined
      ? "degraded=false (0 reviewers failed)"
      : `degraded=true (${failed} reviewers failed)`;
  return [`[ai-review] Run health: ${degradedStr} · ${grounded} grounded / ${withheld} withheld`];
}

/**
 * Apply the --git-diff smart default for a flag that has a conventional fallback.
 * When the flag was explicitly set, its value wins. When --git-diff is present and
 * no explicit value was provided, the given fallback is returned. Otherwise undefined.
 *
 * Used in runCommand for --output-dir (defaults to ".ai-review") so the defaulting
 * logic has a single, tested, non-test consumer. Runtime defaulting is handled by
 * resolveRuntimeName.
 */
export function applyGitDiffDefault(
  value: string | undefined,
  args: string[],
  fallback: string,
): string | undefined {
  return value ?? (args.includes("--git-diff") ? fallback : undefined);
}

/**
 * Resolve the effective runtime name from the explicit --runtime flag, model/auth signal,
 * and --git-diff context (#407). When --runtime is explicit it wins (with one loud guard:
 * an explicit dummy combined with a real model/auth flag would run a fake review while the
 * operator believes they asked for a real one — this is rejected with a clear error).
 * Without an explicit runtime, a real model/auth signal infers pi; otherwise the prior
 * default applies: dummy under --git-diff, undefined otherwise (which runReview turns into
 * deterministic fake reviewers). Unsupported-runtime validation is handled separately by
 * the caller.
 */
export function resolveRuntimeName(
  explicitRuntime: string | undefined,
  hasRealModelOrAuthSignal: boolean,
  gitDiff: boolean,
): string | undefined {
  if (explicitRuntime !== undefined) {
    // Explicit --runtime wins. Guard the one dangerous combination: a real model/auth flag under
    // an explicit dummy runtime would run a FAKE review while the operator believes they asked for
    // a real one (wart #2's inverse). Fail loudly instead of silently faking.
    if (explicitRuntime === "dummy" && hasRealModelOrAuthSignal) {
      throw new Error(
        "--runtime dummy cannot be combined with --model/--api-key/--pi-* (dummy runs a fake review — drop --runtime to auto-select pi, or drop the model/key flags)",
      );
    }
    return explicitRuntime;
  }
  // No explicit --runtime: a real model/auth flag signals intent for a real review → pi.
  if (hasRealModelOrAuthSignal) {
    return "pi";
  }
  // Otherwise preserve the prior default: dummy under --git-diff, else undefined (which runReview
  // turns into deterministic fake reviewers).
  return gitDiff ? "dummy" : undefined;
}

export interface RunPublishOptions {
  publishSummary: boolean;
  publishInline: boolean;
  /**
   * When true, bypasses re-review convergence suppression and always posts the
   * summary comment even when the finding set is unchanged since the last review
   * (#149 — convergence gate override).
   */
  forceReview: boolean;
}

export function parseRunPublishOptions(args: string[]): RunPublishOptions {
  return {
    publishSummary: hasFlag(args, "--publish-summary"),
    publishInline: hasFlag(args, "--publish-inline"),
    forceReview: hasFlag(args, "--force-review"),
  };
}

/**
 * Parse the operator-extension `--reviewers <path>` flag (M017 S03, #143). Returns the explicit
 * path to an operator reviewer-definitions module, or undefined when not supplied (the default —
 * the factory's trusted reviewer set is used). This is an **operator explicit-load** path; it is
 * never derived from the reviewed repo (see docs/user/fork-safety.md).
 *
 * Throws when `--reviewers` is present but has no following value (last token) or is immediately
 * followed by another flag — a silently-skipped custom reviewer set (the operator's security
 * reviewer or a `replace:true` set) would be a confusing, safety-relevant footgun, so the missing
 * value is surfaced as a clear error rather than treated as "flag absent".
 */
export function parseReviewersOption(args: string[]): string | undefined {
  const index = args.indexOf("--reviewers");
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("--reviewers requires a path argument");
  }
  return value;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/**
 * Parse the AI_REVIEW_DISABLED_PROVIDERS env var (#138 — operator provider-disable seam).
 * Splits on comma, trims whitespace, lowercases, drops empty entries, dedupes. Returns undefined
 * when the result is empty so the option is omitted (not set to an empty array) in RunReviewOptions.
 * Lowercasing makes the disable lever case-insensitive (selectModel also compares case-insensitively):
 * `AI_REVIEW_DISABLED_PROVIDERS=OpenAI` must still disable a config provider `"openai"` — a silent
 * no-op on this emergency lever is the worst failure mode. Only called from the trusted env path
 * (never from reviewed-repo config).
 */
/**
 * Normalize the operator-supplied --intent note (#384): trim, treat empty/whitespace as absent
 * (so a run without meaningful intent stays byte-for-byte unchanged), and cap length to bound
 * the prompt. Returns undefined when there is nothing to inject.
 */
export function normalizeIntent(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 1000);
}

// Conventional API-key env var per provider (mirrors the CI real-pi job's env block). Extend this
// map as providers are added. An unmapped provider has no convention (returns undefined).
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export function conventionApiKeyEnvVar(provider: string): string | undefined {
  return PROVIDER_API_KEY_ENV[provider];
}

/**
 * Resolve the convention API key to forward as pi's --api-key (#407). Applies ONLY when pi was
 * selected via the generic --model path and no explicit --api-key was given (the caller passes an
 * `env` snapshot so this stays pure/testable). Forwarding an env key as an explicit --api-key
 * defeats the #42 quirk where pi prefers a stored OAuth credential over the ANTHROPIC_API_KEY env
 * var. Returns undefined when it does not apply or when the convention env var is unset/empty (pi
 * then falls back to its own auth resolution).
 *
 * For a --model provider with no known convention: when pi was AUTO-INFERRED (no explicit
 * --runtime), this throws — the operator gave only `--model <provider>/…`, so requiring an explicit
 * --api-key keeps a real review from silently relying on a possibly-wrong stored OAuth identity.
 * When the operator EXPLICITLY passed --runtime pi (`runtimeAutoInferred` false), it returns
 * undefined instead, preserving the pre-#407 path where pi resolves its own env/OAuth auth for
 * out-of-convention providers.
 */
export function resolveConventionApiKey(opts: {
  runtimeName: string | undefined;
  runtimeAutoInferred: boolean;
  fromModelFlag: boolean;
  provider: string | undefined;
  env: Record<string, string | undefined>;
}): string | undefined {
  if (opts.runtimeName !== "pi" || !opts.fromModelFlag || opts.provider === undefined) {
    return undefined;
  }
  const envVar = conventionApiKeyEnvVar(opts.provider);
  if (envVar === undefined) {
    if (opts.runtimeAutoInferred) {
      throw new Error(
        `--model provider '${opts.provider}' has no conventional API-key env var; pass --api-key explicitly`,
      );
    }
    return undefined;
  }
  const value = opts.env[envVar];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function parseDisabledProviders(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result.length > 0 ? result : undefined;
}
