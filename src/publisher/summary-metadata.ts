import type { ChangeRef, Finding, JsonValue, PriorFindingState, PriorReviewState } from "../contracts/index.ts";

const hiddenMetadataPattern = /<!--\s*ai-code-review-factory\s*\n([\s\S]*?)\n\s*-->/m;

export interface ParsedSummaryMetadata {
  schemaVersion?: number;
  runId?: string;
  headSha?: string;
  provider?: string;
  repository?: string;
  changeId?: string;
  findingIds: string[];
  raw: Record<string, JsonValue>;
}

export function parseSummaryHiddenMetadata(body: string | undefined): ParsedSummaryMetadata | undefined {
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
    findings: metadata.findingIds.map((stableId): PriorFindingState => ({
      stableId,
      finding: createPlaceholderFinding(stableId),
      status: "open",
      lastSeenHeadSha,
    })),
  };
}

function createPlaceholderFinding(stableId: string): Finding {
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
  };
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
