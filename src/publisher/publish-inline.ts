import type {
  ChangeMetadata,
  DiffSummary,
  JsonValue,
  PublishInlineFindingOutcome,
  PublishInlineFindingsInput,
  PublishInlineFindingsResult,
  ReviewSummary,
  TraceSink,
  VcsAdapter,
} from "../contracts/index.ts";
import { evaluateInlinePublishReadiness } from "./inline-readiness.ts";

export interface PublishReviewInlineFindingsInput {
  adapter: Pick<VcsAdapter, "provider" | "publishInlineFindings">;
  change: ChangeMetadata;
  diff: DiffSummary;
  summary: ReviewSummary;
  runId: string;
  traceSink?: TraceSink;
  timestamp?: string;
  expectedHeadSha?: string;
}

export async function publishReviewInlineFindings(input: PublishReviewInlineFindingsInput): Promise<PublishInlineFindingsResult> {
  if (input.adapter.publishInlineFindings === undefined) {
    throw new Error(`${input.adapter.provider} does not support inline finding publishing`);
  }

  const readiness = evaluateInlinePublishReadiness({
    change: input.change,
    diff: input.diff,
    findings: input.summary.findings,
    expectedHeadSha: input.expectedHeadSha ?? input.change.headSha,
  });
  const blockedOutcomes: PublishInlineFindingOutcome[] = readiness.blockedFindings.map((blocked) => ({
    ...(blocked.finding.id !== undefined ? { findingId: blocked.finding.id } : {}),
    disposition: "skipped",
    reason: blocked.reasons.join(","),
  }));
  const providerResult = readiness.readyFindings.length === 0
    ? emptyInlineResult(input.change.provider)
    : await input.adapter.publishInlineFindings({
      change: input.change,
      findings: readiness.readyFindings,
      runId: input.runId,
    } satisfies PublishInlineFindingsInput);
  const outcomes = [...providerResult.findings, ...blockedOutcomes];
  const result: PublishInlineFindingsResult = {
    provider: input.change.provider,
    attemptedInlineCount: input.summary.findings.length,
    postedInlineCount: outcomes.filter((outcome) => outcome.disposition === "posted").length,
    skippedInlineCount: outcomes.filter((outcome) => outcome.disposition === "skipped").length,
    failedInlineCount: outcomes.filter((outcome) => outcome.disposition === "failed").length,
    findings: outcomes,
  };

  await input.traceSink?.write({
    type: "publisher.completed",
    runId: input.runId,
    timestamp: input.timestamp ?? new Date().toISOString(),
    data: {
      publisher: "inline",
      provider: result.provider,
      attemptedInlineCount: result.attemptedInlineCount,
      postedInlineCount: result.postedInlineCount,
      skippedInlineCount: result.skippedInlineCount,
      failedInlineCount: result.failedInlineCount,
      inlineFindings: inlineFindingTraceData(result.findings),
      skippedInlineReasons: skippedReasons(result.findings),
    },
  });

  return result;
}

function emptyInlineResult(provider: PublishInlineFindingsResult["provider"]): PublishInlineFindingsResult {
  return {
    provider,
    attemptedInlineCount: 0,
    postedInlineCount: 0,
    skippedInlineCount: 0,
    failedInlineCount: 0,
    findings: [],
  };
}

function inlineFindingTraceData(findings: PublishInlineFindingOutcome[]): JsonValue {
  return findings.map((finding) => ({
    ...(finding.findingId !== undefined ? { findingId: finding.findingId } : {}),
    disposition: finding.disposition,
    ...(finding.reason !== undefined ? { reason: finding.reason } : {}),
    ...(finding.providerCommentId !== undefined ? { providerCommentId: finding.providerCommentId } : {}),
    ...(finding.url !== undefined ? { url: finding.url } : {}),
  }));
}

function skippedReasons(findings: PublishInlineFindingOutcome[]): JsonValue {
  return findings
    .filter((finding) => finding.disposition === "skipped" && finding.reason !== undefined)
    .map((finding) => ({
      ...(finding.findingId !== undefined ? { findingId: finding.findingId } : {}),
      reason: finding.reason ?? "unknown",
    }));
}
