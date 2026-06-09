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

export async function publishReviewSummary(input: PublishReviewSummaryInput): Promise<PublishSummaryResult> {
  const hiddenMetadata = input.hiddenMetadata ?? createPublishHiddenMetadata(input.runId, input.change);
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
      ...(publishResult.summaryCommentId !== undefined ? { summaryCommentId: publishResult.summaryCommentId } : {}),
      ...(publishResult.summaryUrl !== undefined ? { summaryUrl: publishResult.summaryUrl } : {}),
      postedInlineCount: publishResult.postedInlineCount,
      failedInlineCount: publishResult.failedInlineCount,
    },
  });

  return publishResult;
}

export function createPublishHiddenMetadata(runId: string, change: ChangeMetadata): Record<string, JsonValue> {
  return {
    runId,
    headSha: change.headSha,
    provider: change.provider,
    repository: change.repository.slug,
    changeId: change.changeId,
  };
}
