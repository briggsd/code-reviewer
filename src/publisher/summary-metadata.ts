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
        finding: createPlaceholderFinding(stableId, metadata.findingPaths?.[stableId]),
        status: "open",
        lastSeenHeadSha,
      }),
    ),
  };
}

function createPlaceholderFinding(stableId: string, path?: string): Finding {
  return {
    id: stableId,
    reviewer: "custom",
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
