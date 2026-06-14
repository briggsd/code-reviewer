import type {
  ChangeMetadata,
  DiffSummary,
  Finding,
  JsonValue,
  ProviderKind,
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

export async function publishReviewInlineFindings(
  input: PublishReviewInlineFindingsInput,
): Promise<PublishInlineFindingsResult> {
  if (input.adapter.publishInlineFindings === undefined) {
    throw new Error(`${input.adapter.provider} does not support inline finding publishing`);
  }

  const readiness = evaluateInlinePublishReadiness({
    change: input.change,
    diff: input.diff,
    findings: input.summary.findings,
    expectedHeadSha: input.expectedHeadSha ?? input.change.headSha,
  });
  const blockedOutcomes: PublishInlineFindingOutcome[] = readiness.blockedFindings.map(
    (blocked) => ({
      ...(blocked.finding.id !== undefined ? { findingId: blocked.finding.id } : {}),
      disposition: "skipped",
      reason: blocked.reasons.join(","),
    }),
  );
  let providerResult: PublishInlineFindingsResult;
  if (readiness.readyFindings.length === 0) {
    providerResult = emptyInlineResult(input.change.provider);
  } else {
    try {
      // publishInlineFindings is narrowed to defined by the guard above.
      providerResult = await input.adapter.publishInlineFindings({
        change: input.change,
        findings: readiness.readyFindings,
        runId: input.runId,
      } satisfies PublishInlineFindingsInput);
    } catch (error) {
      // A wholesale throw (the comment listing, or every POST, hit the same wall) would
      // otherwise fail the entire run. If it is a recoverable inline-coordinate error
      // (422 coordinate-invalid / 429 rate), degrade ALL ready findings to summary fallback
      // instead. Any other failure — including 403, which is an authorization signal that must
      // stay visible (see SUMMARY_FALLBACK_STATUSES) — re-throws, preserving the run's existing
      // fail behavior rather than masking a misconfiguration or bug.
      const status = httpStatusOf(error);
      if (status === undefined || !SUMMARY_FALLBACK_STATUSES.has(status)) {
        throw error;
      }
      providerResult = wholesaleFailureResult(
        input.change.provider,
        readiness.readyFindings,
        status,
      );
    }
  }

  // POST-failure fallback (architecture.md:430): the VCS API returns a recoverable status (see
  // SUMMARY_FALLBACK_STATUSES — 422/429) for inline coordinates our local pre-flight
  // (inline-readiness.ts) cannot anticipate. Re-route those findings into the summary body —
  // which already renders every finding — instead of losing them as silent `failed`. Recording
  // them as `skipped` with a structured reason keeps the finding visible in telemetry; any other
  // failure (5xx, network, and 403 auth) stays `failed`.
  const recoveredOutcomes = providerResult.findings.map(toSummaryFallbackOutcome);
  const summaryFallbackCount = recoveredOutcomes.filter(isSummaryFallbackOutcome).length;
  const outcomes = [...recoveredOutcomes, ...blockedOutcomes];
  const result: PublishInlineFindingsResult = {
    provider: input.change.provider,
    attemptedInlineCount: input.summary.findings.length,
    postedInlineCount: outcomes.filter((outcome) => outcome.disposition === "posted").length,
    skippedInlineCount: outcomes.filter((outcome) => outcome.disposition === "skipped").length,
    failedInlineCount: outcomes.filter((outcome) => outcome.disposition === "failed").length,
    summaryFallbackCount,
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
      // Always emitted (0 when none) so telemetry can measure the fallback RATE — a silent
      // absence would hide how often inline publishing degrades to summary-only.
      summaryFallbackCount,
      inlineFindings: inlineFindingTraceData(result.findings),
      skippedInlineReasons: skippedReasons(result.findings),
    },
  });

  return result;
}

function emptyInlineResult(
  provider: PublishInlineFindingsResult["provider"],
): PublishInlineFindingsResult {
  return {
    provider,
    attemptedInlineCount: 0,
    postedInlineCount: 0,
    skippedInlineCount: 0,
    failedInlineCount: 0,
    summaryFallbackCount: 0,
    findings: [],
  };
}

/**
 * HTTP statuses that mean "this inline coordinate is unusable, but the finding is still valid" —
 * 422 (coordinate invalid: multi-line suggestion over unchanged lines, context-line rules) and
 * 429 (rate limit). On these we degrade to the summary body rather than failing the run
 * (architecture.md:430), mirroring PR-Agent's file-level fallback.
 *
 * 403 is deliberately EXCLUDED. On GitHub's PR-comment endpoints a 403 is an authorization
 * signal (missing token scope, CODEOWNERS-only policy, fork restrictions) — a permanent
 * misconfiguration, not a per-comment condition. Before this fallback existed any throw failed
 * the run, making such regressions immediately visible; silently degrading a 403 to summary-only
 * would hide a broken token behind a green CI. So a 403 keeps its prior hard-failure behavior.
 */
const SUMMARY_FALLBACK_STATUSES = new Set([422, 429]);

const SUMMARY_FALLBACK_REASON_PREFIX = "summary_fallback_http_";

/**
 * Read a numeric HTTP status off a thrown error structurally (HttpJsonClient throws an
 * HttpRequestError carrying `.status`). Duck-typed rather than `instanceof` so the publisher
 * stays decoupled from the VCS layer — and so it never depends on the human-readable message
 * format. Returns undefined for non-HTTP errors.
 */
function httpStatusOf(value: unknown): number | undefined {
  const status = (value as { status?: unknown } | null | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Reclassify a `failed` outcome whose recorded `httpStatus` is a recoverable inline-coordinate
 * failure into a `skipped` summary-fallback outcome; pass every other outcome through unchanged.
 * Keys off the adapter-supplied status code, not the failure message text.
 */
function toSummaryFallbackOutcome(
  outcome: PublishInlineFindingOutcome,
): PublishInlineFindingOutcome {
  if (
    outcome.disposition !== "failed" ||
    outcome.httpStatus === undefined ||
    !SUMMARY_FALLBACK_STATUSES.has(outcome.httpStatus)
  ) {
    return outcome;
  }
  return {
    ...(outcome.findingId !== undefined ? { findingId: outcome.findingId } : {}),
    disposition: "skipped",
    reason: `${SUMMARY_FALLBACK_REASON_PREFIX}${outcome.httpStatus}`,
  };
}

function isSummaryFallbackOutcome(outcome: PublishInlineFindingOutcome): boolean {
  return (
    outcome.disposition === "skipped" &&
    outcome.reason?.startsWith(SUMMARY_FALLBACK_REASON_PREFIX) === true
  );
}

/**
 * Build the per-finding result for a wholesale publish throw: every ready finding is recorded
 * as `failed` carrying the recoverable status, so the unified reclassifier above routes them
 * all to summary fallback.
 */
function wholesaleFailureResult(
  provider: ProviderKind,
  readyFindings: Finding[],
  httpStatus: number,
): PublishInlineFindingsResult {
  const findings: PublishInlineFindingOutcome[] = readyFindings.map((finding) => ({
    ...(finding.id !== undefined ? { findingId: finding.id } : {}),
    disposition: "failed",
    httpStatus,
  }));
  return {
    provider,
    attemptedInlineCount: readyFindings.length,
    postedInlineCount: 0,
    skippedInlineCount: 0,
    failedInlineCount: findings.length,
    summaryFallbackCount: 0,
    findings,
  };
}

function inlineFindingTraceData(findings: PublishInlineFindingOutcome[]): JsonValue {
  return findings.map((finding) => ({
    ...(finding.findingId !== undefined ? { findingId: finding.findingId } : {}),
    disposition: finding.disposition,
    ...(finding.reason !== undefined ? { reason: finding.reason } : {}),
    ...(finding.providerCommentId !== undefined
      ? { providerCommentId: finding.providerCommentId }
      : {}),
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
