import type {
  ChangeRef,
  Finding,
  JsonValue,
  PriorFindingState,
  PriorReviewState,
} from "../contracts/index.ts";

const hiddenMetadataPattern = /<!--\s*code-reviewer\s*\n([\s\S]*?)\n\s*-->/m;

export interface ParsedSummaryMetadata {
  schemaVersion?: number;
  runId?: string;
  headSha?: string;
  provider?: string;
  repository?: string;
  changeId?: string;
  findingIds: string[];
  /** schemaVersion 2+: id → location.path mapping for prior findings. */
  findingPaths?: Record<string, string>;
  /** schemaVersion 3+: id → reviewer role for prior findings. */
  findingReviewers?: Record<string, string>;
  /** schemaVersion 8+: id → finding title (truncated) for prior findings. (#333) */
  findingTitles?: Record<string, string>;
  /** schemaVersion 7+: id → consecutive open reviewed-round count. */
  recurrenceDepths?: Record<string, number>;
  /**
   * schemaVersion 5+: SHA-256 (16-hex) of the sorted stable finding-ID set (#149).
   * Substrate for cross-round convergence robustness. Absent in older comments — treated as
   * undefined, which is the safe direction (no hash = no cross-round fast-path).
   */
  findingsHash?: string;
  raw: Record<string, JsonValue>;
}

export function parseSummaryHiddenMetadata(
  body: string | undefined,
): ParsedSummaryMetadata | undefined {
  if (body === undefined) {
    return undefined;
  }

  const match = hiddenMetadataPattern.exec(body);
  const rawJson = match?.[1];
  if (rawJson === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!isJsonObject(parsed)) {
      return undefined;
    }

    // Parse findingPaths defensively. This is UNTRUSTED prior-comment content: it only
    // influences re-review CLASSIFICATION (new/recurring/fixed/carried_forward), which is
    // analytics — it never affects the CI gate, decision, or outcome. Still, accept only
    // string values with a safe repo-relative-path shape (no absolute path, no `..` traversal,
    // no control chars, bounded length); a rejected entry simply leaves that prior finding
    // path-less, which carry-forward classifies as carried_forward (the safe direction — it is
    // never auto-marked "fixed"). See docs/developer/re-review-state.md and docs/user/fork-safety.md.
    let findingPaths: Record<string, string> | undefined;
    if (isJsonObject(parsed.findingPaths)) {
      const filtered: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.findingPaths)) {
        if (typeof value === "string" && isSafeMetadataPath(value)) {
          filtered[key] = value;
        }
      }
      if (Object.keys(filtered).length > 0) {
        findingPaths = filtered;
      }
    }

    // Parse findingReviewers defensively. This is UNTRUSTED prior-comment content: it only
    // influences re-review CLASSIFICATION / analytics (acceptanceByReviewer attribution) —
    // it never affects the CI gate, decision, or outcome. Accept only non-empty string values
    // with a safe reviewer-role shape (bounded length, no control chars). A rejected entry
    // leaves that prior finding with reviewer "unknown", the safe direction. (schemaVersion 3+)
    let findingReviewers: Record<string, string> | undefined;
    if (isJsonObject(parsed.findingReviewers)) {
      const filtered: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.findingReviewers)) {
        if (typeof value === "string" && isSafeReviewerRole(value)) {
          filtered[key] = value;
        }
      }
      if (Object.keys(filtered).length > 0) {
        findingReviewers = filtered;
      }
    }

    // Parse findingTitles defensively. This is UNTRUSTED prior-comment content: it only
    // influences the display title of prior-finding placeholder findings in re-review
    // summaries — it never affects the CI gate, decision, or outcome. Accept only non-empty
    // string values after trim, bounded to 200 chars (permissive — titles are free text, not
    // constrained to a shape like path/reviewer). A rejected entry leaves that prior finding
    // with the existing "Prior finding fnd_…" fallback title, which is the safe direction.
    // SAFETY: titles are passed through escapeMarkdown(...) at every render site in
    // summary-markdown.ts, so no new injection vector is introduced here.
    let findingTitles: Record<string, string> | undefined;
    if (isJsonObject(parsed.findingTitles)) {
      const filtered: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.findingTitles)) {
        if (typeof value === "string" && isSafeFindingTitle(value)) {
          filtered[key] = value;
        }
      }
      if (Object.keys(filtered).length > 0) {
        findingTitles = filtered;
      }
    }

    // Parse recurrenceDepths defensively. This is UNTRUSTED prior-comment content and only
    // feeds convergence analytics. Accept bounded positive integers; rejected values fall
    // back to legacy depth inference in createReReviewSummary.
    let recurrenceDepths: Record<string, number> | undefined;
    if (isJsonObject(parsed.recurrenceDepths)) {
      const filtered: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed.recurrenceDepths)) {
        if (isSafeRecurrenceDepth(value)) {
          filtered[key] = value;
        }
      }
      if (Object.keys(filtered).length > 0) {
        recurrenceDepths = filtered;
      }
    }

    return {
      ...(typeof parsed.schemaVersion === "number" ? { schemaVersion: parsed.schemaVersion } : {}),
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
      ...(typeof parsed.headSha === "string" ? { headSha: parsed.headSha } : {}),
      ...(typeof parsed.provider === "string" ? { provider: parsed.provider } : {}),
      ...(typeof parsed.repository === "string" ? { repository: parsed.repository } : {}),
      ...(typeof parsed.changeId === "string" ? { changeId: parsed.changeId } : {}),
      findingIds: Array.isArray(parsed.findingIds)
        ? parsed.findingIds.filter((id): id is string => typeof id === "string" && id.length > 0)
        : [],
      ...(findingPaths !== undefined ? { findingPaths } : {}),
      ...(findingReviewers !== undefined ? { findingReviewers } : {}),
      ...(findingTitles !== undefined ? { findingTitles } : {}),
      ...(recurrenceDepths !== undefined ? { recurrenceDepths } : {}),
      // Parse findingsHash defensively: accept only a 16-hex string (schemaVersion 5+).
      // This is UNTRUSTED prior-comment content. It influences convergence substrate only —
      // the Tier-1 decision uses the authoritative re-review delta, not this hash.
      // A rejected/absent hash is the safe direction (no cross-round fast-path).
      ...(typeof parsed.findingsHash === "string" && /^[0-9a-f]{16}$/.test(parsed.findingsHash)
        ? { findingsHash: parsed.findingsHash }
        : {}),
      raw: parsed,
    };
  } catch {
    return undefined;
  }
}

export function createPriorReviewStateFromMetadata(
  metadata: ParsedSummaryMetadata,
  ref: ChangeRef,
): PriorReviewState {
  const lastSeenHeadSha = metadata.headSha ?? ref.headSha;

  return {
    ...(metadata.runId !== undefined ? { previousRunId: metadata.runId } : {}),
    previousHeadSha: lastSeenHeadSha,
    hiddenMetadata: metadata.raw,
    findings: metadata.findingIds.map(
      (stableId): PriorFindingState => ({
        stableId,
        finding: createPlaceholderFinding(
          stableId,
          metadata.findingPaths?.[stableId],
          metadata.findingReviewers?.[stableId],
          metadata.findingTitles?.[stableId],
        ),
        status: "open",
        lastSeenHeadSha,
        ...(metadata.recurrenceDepths?.[stableId] !== undefined
          ? { recurrenceDepth: metadata.recurrenceDepths[stableId] }
          : {}),
      }),
    ),
  };
}

function createPlaceholderFinding(
  stableId: string,
  path?: string,
  reviewer?: string,
  title?: string,
): Finding {
  return {
    id: stableId,
    // Use the recovered reviewer role when available (schemaVersion 3+ metadata). Fall back to
    // "unknown" (not "custom") so the unrecoverable-old-format bucket stays distinct from the
    // real "custom" AgentRole an operator extension could legitimately emit. This aligns with
    // deriveAcceptanceByReviewer (src/runner/run-events.ts) which also uses ?? "unknown" for an
    // absent prior reviewer, keeping acceptanceByReviewer attribution honest.
    reviewer: reviewer ?? "unknown",
    severity: "suggestion",
    category: "prior_state",
    // Use the recovered title when available (schemaVersion 8+ metadata via findingTitles).
    // Fall back to the opaque "Prior finding fnd_…" placeholder so older comments (which lack
    // findingTitles) continue to display a recognisable label rather than a blank. (#333)
    title: title ?? `Prior finding ${stableId}`,
    body: "Full prior finding details were not available in summary metadata.",
    confidence: "low",
    evidence: [],
    recommendation: "Load the full prior summary artifact or state store for finding details.",
    ...(path !== undefined ? { location: { path } } : {}),
  };
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A safe repo-relative path shape for untrusted findingPaths values: non-empty, bounded,
// not absolute, no `..` traversal segment, no control characters.
function isSafeMetadataPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) {
    return false;
  }
  if (value.startsWith("/")) {
    return false; // not repo-relative
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) {
      return false; // control character
    }
  }
  return !value.split("/").includes(".."); // no traversal segment
}

// A safe reviewer-role shape for untrusted findingReviewers values: non-empty, bounded
// length (≤ 64), no control characters. Reviewer roles are stable low-cardinality identifiers
// (e.g. "security", "custom", "coordinator") — same safety class as findingPaths.
function isSafeReviewerRole(value: string): boolean {
  if (value.length === 0 || value.length > 64) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) {
      return false; // control character
    }
  }
  return true;
}

function isSafeRecurrenceDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 10_000;
}

// A safe finding-title value for untrusted findingTitles values: non-empty after trim,
// bounded length (≤ 200). Titles are free text (no shape constraint like path/reviewer);
// the parse-side cap of 200 provides a defence-in-depth bound above the 120-char write cap.
// Titles are always passed through escapeMarkdown(...) at every render site in
// summary-markdown.ts, so no injection vector is introduced by accepting the value here.
function isSafeFindingTitle(value: string): boolean {
  return value.trim().length > 0 && value.length <= 200;
}
