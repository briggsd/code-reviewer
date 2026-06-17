/**
 * Pure helpers for recognizing a human "break glass" override marker in PR/MR comments.
 *
 * LEADING-LINE + HEAD-SHA RULE: only the FIRST non-empty line of a comment body is checked, and
 * that entire line (after trimming + whitespace collapse + lowercasing) must be exactly
 * `break glass <commit>` or `break-glass <commit>`, where `<commit>` is a hex commit-sha prefix
 * (7–40 chars) that is a PREFIX of the head commit being reviewed. Binding the trigger to a
 * specific commit means an override does NOT silently carry over to later pushes that introduce
 * code the human never saw (#22 review). A leading-line-only, exact-format match also prevents a
 * quoted "break glass" buried in prose or a bot's summary footer from triggering an override. All
 * comment content is untrusted (Principle 6); the SHA binding + opening-line rule minimise the
 * attack surface.
 *
 * TRUSTED-AUTHOR SETS: the adapters use these to enforce that only sufficiently privileged authors
 * can activate an override.  Lower-privileged roles (GitHub CONTRIBUTOR/NONE, GitLab Guest/Reporter)
 * are intentionally excluded — ignoring them is a load-bearing security decision.
 */

// ≥12 hex chars (48 bits). A short 7-char prefix is grindable: an attacker with push access
// could craft an unreviewed commit whose SHA shares a trusted break-glass comment's short prefix
// and thereby reuse that override (#112 review R2). 48 bits makes a partial-preimage grind
// impractical; pasting the full 40-char SHA (recommended in the docs) is strictly safer.
const MIN_COMMIT_PREFIX_LENGTH = 12;
// Matches a normalized (lowercased, single-spaced) first line: "break glass <hex>" /
// "break-glass <hex>", capturing the 12–40 char commit-sha prefix.
const BREAK_GLASS_LINE = /^break[- ]glass ([0-9a-f]{12,40})$/;

/**
 * Returns true iff the comment body's first non-empty line is a well-formed break-glass marker
 * (`break glass <commit>` / `break-glass <commit>`) whose `<commit>` is a ≥12-char hex prefix of
 * `headSha` (case-insensitive). A missing/empty/`unknown` head, a bare marker without a commit,
 * a too-short prefix (< 12 hex), or a commit that does not match the head all return false — the
 * override is honored only for the exact commit a trusted human acknowledged.
 */
export function breakGlassMatchesHead(
  body: string | undefined | null,
  headSha: string | undefined,
): boolean {
  if (body === undefined || body === null || body.length === 0) {
    return false;
  }
  if (headSha === undefined || headSha.length === 0) {
    return false;
  }
  const normalizedHead = headSha.toLowerCase();
  if (normalizedHead === "unknown") {
    return false;
  }

  let firstLine: string | undefined;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      firstLine = trimmed;
      break;
    }
  }
  if (firstLine === undefined) {
    return false;
  }

  const normalized = firstLine.replace(/\s+/g, " ").toLowerCase();
  const match = BREAK_GLASS_LINE.exec(normalized);
  const commitPrefix = match?.[1];
  if (commitPrefix === undefined || commitPrefix.length < MIN_COMMIT_PREFIX_LENGTH) {
    return false;
  }
  // The named commit must be the head commit under review (a prefix of its SHA).
  return normalizedHead.startsWith(commitPrefix);
}

/**
 * GitHub `author_association` values that are trusted for break-glass overrides.
 * CONTRIBUTOR and NONE are intentionally excluded — they do not have write access
 * to the repository and must not be able to bypass CI gates.
 */
export const GITHUB_TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/**
 * Minimum GitLab project access level (numeric) required to trigger a break-glass override.
 * 30 = Developer. Guest (10) and Reporter (20) are excluded.
 */
export const GITLAB_MIN_TRUSTED_ACCESS_LEVEL = 30;

/**
 * Map a numeric GitLab project access level to a coarse role string suitable for
 * `BreakGlassOverride.authorAssociation`.  The numeric thresholds follow GitLab's
 * access-level constants: Owner=50, Maintainer=40, Developer=30.
 */
export function mapGitLabAccessLevel(level: number): string {
  if (level >= 50) {
    return "OWNER";
  }
  if (level >= 40) {
    return "MEMBER";
  }
  return "COLLABORATOR";
}

/**
 * Bitbucket Cloud repository permission strings that are trusted for break-glass overrides.
 * `"read"` (and absent) are intentionally excluded — a read-only collaborator does not have
 * write access to the repository and must not be able to bypass CI gates. This mirrors the
 * GitHub CONTRIBUTOR/NONE and GitLab Guest/Reporter exclusions: the set of excluded roles is
 * a load-bearing security decision, not an accident.
 */
export const BITBUCKET_TRUSTED_PERMISSIONS = new Set(["admin", "write"]);

/**
 * Map a Bitbucket Cloud repository permission string to a coarse role string suitable for
 * `BreakGlassOverride.authorAssociation`.  Only `"admin"` and `"write"` reach this function
 * (callers gate on `BITBUCKET_TRUSTED_PERMISSIONS` first), but we handle the full surface for
 * safety.  Mirrors `mapGitLabAccessLevel` in shape.
 */
export function mapBitbucketPermission(permission: string): string {
  if (permission === "admin") {
    return "OWNER";
  }
  // "write" and anything unexpected — treat as collaborator-level trust.
  return "COLLABORATOR";
}
