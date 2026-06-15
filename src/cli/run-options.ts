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
 * never derived from the reviewed repo (see docs/fork-safety.md).
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
