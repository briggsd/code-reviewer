import type {
  ChangeRef,
  Finding,
  JsonValue,
  PriorFindingState,
  PriorReviewState,
} from "../contracts/index.ts";

const hiddenMetadataPattern = /<!--\s*ai-code-review-factory\s*\n([\s\S]*?)\n\s*-->/m;

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
    // never auto-marked "fixed"). See docs/re-review-state.md and docs/fork-safety.md.
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
        ),
        status: "open",
        lastSeenHeadSha,
      }),
    ),
  };
}

function createPlaceholderFinding(stableId: string, path?: string, reviewer?: string): Finding {
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
    title: `Prior finding ${stableId}`,
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
