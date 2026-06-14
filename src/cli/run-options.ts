export interface RunPublishOptions {
  publishSummary: boolean;
  publishInline: boolean;
}

export function parseRunPublishOptions(args: string[]): RunPublishOptions {
  return {
    publishSummary: hasFlag(args, "--publish-summary"),
    publishInline: hasFlag(args, "--publish-inline"),
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
