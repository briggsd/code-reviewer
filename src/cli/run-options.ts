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
 * Used in runCommand for --output-dir (defaults to ".ai-review") and --runtime
 * (defaults to "dummy") so the defaulting logic has a single, tested, non-test consumer.
 */
export function applyGitDiffDefault(
  value: string | undefined,
  args: string[],
  fallback: string,
): string | undefined {
  return value ?? (args.includes("--git-diff") ? fallback : undefined);
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
