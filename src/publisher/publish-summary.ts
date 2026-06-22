import { createHash } from "node:crypto";
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

  // findingTitles: id → title (truncated to 120 chars) for findings that have a non-empty id
  // and a non-empty title. Only included when non-empty; omitted entirely when no findings
  // qualify. Enables re-review summaries to recover real titles from the prior PR comment
  // instead of degrading to placeholder "Prior finding fnd_…" text. (#333)
  // M008 counts-only / egress boundary: titles are stored only in the HIDDEN PR-COMMENT
  // metadata (same channel as findingPaths/findingReviewers) — NOT in telemetry/run_metrics.
  const findingTitles: Record<string, string> = {};
  if (summary !== undefined) {
    for (const finding of summary.findings) {
      if (finding.id !== undefined && finding.id.length > 0 && finding.title.length > 0) {
        findingTitles[finding.id] = finding.title.slice(0, 120);
      }
    }
  }
  const hasFindingTitles = Object.keys(findingTitles).length > 0;

  // findingConfidences / findingSeverities: id → real confidence/severity for findings with a
  // non-empty id (#395, schemaVersion 10+). Lets re-review reconstruct prior findings with their
  // REAL confidence/severity instead of the hardcoded `low`/`suggestion` placeholder, so
  // precision/recall analysis segmenting by confidence or severity is meaningful. Same hidden
  // PR-comment channel as findingReviewers — NOT telemetry (M008).
  const findingConfidences: Record<string, string> = {};
  const findingSeverities: Record<string, string> = {};
  if (summary !== undefined) {
    for (const finding of summary.findings) {
      if (finding.id !== undefined && finding.id.length > 0) {
        findingConfidences[finding.id] = finding.confidence;
        findingSeverities[finding.id] = finding.severity;
      }
    }
  }
  const hasFindingConfidences = Object.keys(findingConfidences).length > 0;
  const hasFindingSeverities = Object.keys(findingSeverities).length > 0;

  // withheldFindingIds: stable IDs of findings grounding-withheld this run (#392, schemaVersion 9+).
  // Separate channel from findingIds (which carries BLOCKING findings only). Enables re-review
  // to track withheld findings across rounds (promoted | stillWithheld | resolved | carriedForward).
  // Paths and reviewer roles are included for disposition derivation; titles are intentionally
  // omitted (withheld finding text is model-authored untrusted content, same egress bound as M008).
  // withheldFindingSeverities (#395, v10+): real severity per withheld finding. Severity is NOT
  // demoted by grounding, so it carries real signal; withheld *confidence* is intentionally NOT
  // persisted because grounding overwrites it to "low" (run-review.ts) — it would be a useless
  // all-"low" map. (Capturing pre-demotion model confidence is a possible future follow-up if
  // recall calibration #391 needs it.)
  const withheldFindingIds: string[] = [];
  const withheldFindingPaths: Record<string, string> = {};
  const withheldFindingReviewers: Record<string, string> = {};
  const withheldFindingSeverities: Record<string, string> = {};
  if (summary !== undefined && summary.groundingWithheld !== undefined) {
    for (const finding of summary.groundingWithheld) {
      const id = finding.id;
      if (id !== undefined && id.length > 0) {
        withheldFindingIds.push(id);
        if (finding.location?.path !== undefined) {
          withheldFindingPaths[id] = finding.location.path;
        }
        withheldFindingReviewers[id] = finding.reviewer;
        withheldFindingSeverities[id] = finding.severity;
      }
    }
  }
  const hasWithheldFindings = withheldFindingIds.length > 0;
  const hasWithheldFindingPaths = Object.keys(withheldFindingPaths).length > 0;
  const hasWithheldFindingReviewers = Object.keys(withheldFindingReviewers).length > 0;
  const hasWithheldFindingSeverities = Object.keys(withheldFindingSeverities).length > 0;

  // recurrenceDepths: id → consecutive reviewed rounds currently open (#260, schemaVersion 7+).
  // First reviews seed depth=1; re-reviews use the computed per-finding depths.
  const recurrenceDepths: Record<string, number> = {};
  if (findingIds !== undefined) {
    for (const id of findingIds) {
      recurrenceDepths[id] = summary?.reReview?.convergence?.recurrenceDepths[id] ?? 1;
    }
  }
  const hasRecurrenceDepths = Object.keys(recurrenceDepths).length > 0;

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

  // findingsHash: SHA-256 of the sorted stable finding-ID set (#149, schemaVersion 5+).
  // Substrate for Tier-2 convergence cross-round robustness; Tier-1 uses the re-review delta
  // directly. IDs are sorted before hashing so insertion order doesn't affect the digest.
  // Mirrors the hashing idiom in stable-finding-id.ts: JSON-encoded input, hex slice to 16.
  // Old parsers (schemaVersion ≤ 4) ignore unknown keys — backward-compatible.
  const findingsHash =
    findingIds !== undefined && findingIds.length > 0
      ? createHash("sha256")
          .update(JSON.stringify([...findingIds].sort()))
          .digest("hex")
          .slice(0, 16)
      : undefined;

  return {
    // Bumped 9 → 10 for findingConfidences/findingSeverities/withheldFindingSeverities (#395).
    // The bump is additive and backward-compatible: old parsers ignore unknown keys per the
    // existing defensive-parse pattern (parseSummaryHiddenMetadata in summary-metadata.ts).
    schemaVersion: 10,
    runId,
    headSha: change.headSha,
    provider: change.provider,
    repository: change.repository.slug,
    changeId: change.changeId,
    ...(findingIds !== undefined ? { findingIds } : {}),
    ...(hasFindingPaths ? { findingPaths } : {}),
    ...(hasFindingReviewers ? { findingReviewers } : {}),
    ...(hasFindingTitles ? { findingTitles } : {}),
    ...(hasFindingConfidences ? { findingConfidences } : {}),
    ...(hasFindingSeverities ? { findingSeverities } : {}),
    ...(hasWithheldFindings ? { withheldFindingIds } : {}),
    ...(hasWithheldFindingPaths ? { withheldFindingPaths } : {}),
    ...(hasWithheldFindingReviewers ? { withheldFindingReviewers } : {}),
    ...(hasWithheldFindingSeverities ? { withheldFindingSeverities } : {}),
    ...(hasRecurrenceDepths ? { recurrenceDepths } : {}),
    // Comprehension-gate verdict (#26): additive, present only when the reviewer ran. v1 parsers
    // ignore unknown keys, so this stays backward-compatible with the existing metadata reader.
    ...(summary?.gateDecision !== undefined ? { gateDecision: summary.gateDecision } : {}),
    ...(partialBySize !== undefined ? { partialBySize } : {}),
    ...(findingsHash !== undefined ? { findingsHash } : {}),
    // Cross-round resolved-finding log (#279, schemaVersion 6+). Additive — old parsers ignore it.
    ...(summary?.resolvedLog !== undefined && summary.resolvedLog.length > 0
      ? { resolvedLog: summary.resolvedLog }
      : {}),
  };
}
