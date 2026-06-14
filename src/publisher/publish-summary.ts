import type {
  ChangeMetadata,
  JsonValue,
  PublishSummaryResult,
  ReviewSummary,
  TraceSink,
  VcsAdapter,
} from "../contracts/index.ts";

export interface PublishReviewSummaryInput {
  adapter: Pick<VcsAdapter, "publishSummary">;
  change: ChangeMetadata;
  summary: ReviewSummary;
  runId: string;
  traceSink?: TraceSink;
  timestamp?: string;
  hiddenMetadata?: Record<string, JsonValue>;
}

export async function publishReviewSummary(
  input: PublishReviewSummaryInput,
): Promise<PublishSummaryResult> {
  const hiddenMetadata =
    input.hiddenMetadata ?? createPublishHiddenMetadata(input.runId, input.change, input.summary);
  const publishResult = await input.adapter.publishSummary({
    change: input.change,
    summary: input.summary,
    hiddenMetadata,
  });

  await input.traceSink?.write({
    type: "publisher.completed",
    runId: input.runId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    data: {
      provider: publishResult.provider,
      ...(publishResult.summaryCommentId !== undefined
        ? { summaryCommentId: publishResult.summaryCommentId }
        : {}),
      ...(publishResult.summaryUrl !== undefined ? { summaryUrl: publishResult.summaryUrl } : {}),
      postedInlineCount: publishResult.postedInlineCount,
      failedInlineCount: publishResult.failedInlineCount,
    },
  });

  return publishResult;
}

export function createPublishHiddenMetadata(
  runId: string,
  change: ChangeMetadata,
  summary?: ReviewSummary,
): Record<string, JsonValue> {
  const findingIds =
    summary !== undefined
      ? summary.findings.map((finding) => finding.id ?? "").filter((id) => id.length > 0)
      : undefined;

  // findingPaths: id → location.path for findings that have both a non-empty id and a path.
  // Only included at schemaVersion 2+; omitted entirely when empty.
  const findingPaths: Record<string, string> = {};
  if (summary !== undefined) {
    for (const finding of summary.findings) {
      if (
        finding.id !== undefined &&
        finding.id.length > 0 &&
        finding.location?.path !== undefined
      ) {
        findingPaths[finding.id] = finding.location.path;
      }
    }
  }
  const hasFindingPaths = Object.keys(findingPaths).length > 0;

  // findingReviewers: id → reviewer role for findings that have a non-empty id.
  // Only included at schemaVersion 3; omitted entirely when empty.
  const findingReviewers: Record<string, string> = {};
  if (summary !== undefined) {
    for (const finding of summary.findings) {
      if (finding.id !== undefined && finding.id.length > 0) {
        findingReviewers[finding.id] = finding.reviewer;
      }
    }
  }
  const hasFindingReviewers = Object.keys(findingReviewers).length > 0;

  // partialBySize counts-only block (#145, schemaVersion 4+). Counts + byte totals only (M008).
  // Old parsers (schemaVersion ≤ 3) ignore unknown keys — backward-compatible.
  const partialBySize =
    summary?.partialBySize !== undefined
      ? {
          admittedFileCount: summary.partialBySize.admittedFileCount,
          droppedFileCount: summary.partialBySize.droppedFileCount,
          originalBytes: summary.partialBySize.originalBytes,
          admittedBytes: summary.partialBySize.admittedBytes,
          budgetBytes: summary.partialBySize.budgetBytes,
        }
      : undefined;

  return {
    // Bumped 3 → 4 for the partialBySize counts block (#145). The bump is additive and
    // backward-compatible: old parsers (schemaVersion ≤ 3) ignore unknown keys per the existing
    // defensive-parse pattern (parseSummaryHiddenMetadata in summary-metadata.ts line ~40).
    schemaVersion: 4,
    runId,
    headSha: change.headSha,
    provider: change.provider,
    repository: change.repository.slug,
    changeId: change.changeId,
    ...(findingIds !== undefined ? { findingIds } : {}),
    ...(hasFindingPaths ? { findingPaths } : {}),
    ...(hasFindingReviewers ? { findingReviewers } : {}),
    // Comprehension-gate verdict (#26): additive, present only when the reviewer ran. v1 parsers
    // ignore unknown keys, so this stays backward-compatible with the existing metadata reader.
    ...(summary?.gateDecision !== undefined ? { gateDecision: summary.gateDecision } : {}),
    ...(partialBySize !== undefined ? { partialBySize } : {}),
  };
}
