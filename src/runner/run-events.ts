/**
 * Pure builders for ai_review.run_event telemetry events (issue #20 S04/S05).
 *
 * Import rules: contracts only — dependency-cruiser blocks runner → adapters.
 * M008: counts, numbers, and stable identifiers only. Never finding bodies,
 * diff text, file paths, reasons, prompts, branch names, PR titles, or author names.
 */
import type {
  CiOutcome,
  JsonValue,
  ReReviewSummary,
  ReviewDecision,
  ReviewSummary,
  TelemetryEvent,
  TokenUsage,
} from "../contracts/index.ts";

export const RUN_EVENT_SCHEMA_VERSION = "ai-review.run_event.v1";

// ---------------------------------------------------------------------------
// run.start
// ---------------------------------------------------------------------------

export interface RunStartInput {
  runId: string;
  timestamp: string;
  repository: string;
  changeId: string;
  riskTier: string;
  selectedReviewerRoles: string[];
  modelIds: string[];
}

export function createRunStartEvent(input: RunStartInput): TelemetryEvent {
  const modelIds = [...new Set(input.modelIds)].sort();

  const data: Record<string, JsonValue> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    event: "run.start",
    repository: input.repository,
    changeId: input.changeId,
    riskTier: input.riskTier,
    selectedReviewerRoles: input.selectedReviewerRoles,
    modelIds,
  };

  return {
    type: "ai_review.run_event",
    runId: input.runId,
    timestamp: input.timestamp,
    data,
  };
}

// ---------------------------------------------------------------------------
// run.completed
// ---------------------------------------------------------------------------

export interface RunCompletedInput {
  runId: string;
  timestamp: string;
  repository: string;
  riskTier: string;
  decision: string;
  outcome: string;
  durationMs: number;
  findingCount: number;
  findingsBySeverity: Record<string, number>;
  findingsByReviewer: Record<string, number>;
  /** Forward `metrics.tokens` directly — the builder is the single authoritative
   * per-field filter (do not re-spread fields at the call site). */
  tokens?: TokenUsage;
}

export function createRunCompletedEvent(input: RunCompletedInput): TelemetryEvent {
  const data: Record<string, JsonValue> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    event: "run.completed",
    repository: input.repository,
    riskTier: input.riskTier,
    decision: input.decision,
    outcome: input.outcome,
    durationMs: input.durationMs,
    findingCount: input.findingCount,
    findingsBySeverity: input.findingsBySeverity,
    findingsByReviewer: input.findingsByReviewer,
  };

  if (input.tokens !== undefined) {
    const tokensData: Record<string, JsonValue> = {};
    if (input.tokens.inputTokens !== undefined) {
      tokensData.inputTokens = input.tokens.inputTokens;
    }
    if (input.tokens.outputTokens !== undefined) {
      tokensData.outputTokens = input.tokens.outputTokens;
    }
    if (input.tokens.cacheReadTokens !== undefined) {
      tokensData.cacheReadTokens = input.tokens.cacheReadTokens;
    }
    if (input.tokens.cacheWriteTokens !== undefined) {
      tokensData.cacheWriteTokens = input.tokens.cacheWriteTokens;
    }
    if (input.tokens.estimatedCostUsd !== undefined) {
      tokensData.estimatedCostUsd = input.tokens.estimatedCostUsd;
    }
    if (Object.keys(tokensData).length > 0) {
      data.tokens = tokensData;
    }
  }

  return {
    type: "ai_review.run_event",
    runId: input.runId,
    timestamp: input.timestamp,
    data,
  };
}

// ---------------------------------------------------------------------------
// Acceptance derivation (S05)
// ---------------------------------------------------------------------------

export interface ReviewerAcceptance {
  accepted: number;
  notAccepted: number;
  rejected: number;
  withheldExcluded: number;
}

/**
 * Derive per-reviewer acceptance signal from re-review classifications and
 * the current finding set.
 *
 * Mapping:
 * - fixed → accepted (attributed to priorFinding.reviewer; "unknown" when absent)
 * - recurring → notAccepted (attributed to current finding.reviewer)
 * - withheld → withheldExcluded (attributed to priorFinding.reviewer; "unknown" when absent)
 * - finding.acknowledged set → rejected (by current finding.reviewer)
 *
 * M008: counts only — never reasons, finding bodies, or free text.
 */
export function deriveAcceptanceByReviewer(
  summary: ReviewSummary,
): Record<string, ReviewerAcceptance> {
  const result = new Map<string, ReviewerAcceptance>();

  function getOrCreate(reviewer: string): ReviewerAcceptance {
    let entry = result.get(reviewer);
    if (entry === undefined) {
      entry = { accepted: 0, notAccepted: 0, rejected: 0, withheldExcluded: 0 };
      result.set(reviewer, entry);
    }
    return entry;
  }

  if (summary.reReview !== undefined) {
    for (const classification of summary.reReview.classifications) {
      if (classification.status === "fixed") {
        const reviewer = classification.priorFinding?.reviewer ?? "unknown";
        getOrCreate(reviewer).accepted += 1;
      } else if (classification.status === "recurring") {
        if (classification.finding !== undefined) {
          const reviewer = classification.finding.reviewer;
          getOrCreate(reviewer).notAccepted += 1;
        }
      } else if (classification.status === "withheld") {
        const reviewer = classification.priorFinding?.reviewer ?? "unknown";
        getOrCreate(reviewer).withheldExcluded += 1;
      }
      // "new" findings have no acceptance signal — skip
    }
  }

  // Acknowledged findings in the current summary → rejected
  for (const finding of summary.findings) {
    if (finding.acknowledged !== undefined) {
      const reviewer = finding.reviewer;
      getOrCreate(reviewer).rejected += 1;
    }
  }

  // Build stable sorted record
  const out: Record<string, ReviewerAcceptance> = {};
  for (const key of Array.from(result.keys()).sort()) {
    const entry = result.get(key);
    if (entry !== undefined) {
      out[key] = entry;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// run.correction
// ---------------------------------------------------------------------------

export interface RunCorrectionInput {
  runId: string;
  timestamp: string;
  repository: string;
  riskTier: string;
  summary: ReviewSummary;
}

/**
 * Build a run.correction telemetry event.
 *
 * Returns undefined when there is no correction/acceptance signal — i.e.
 * the summary has no reReview block AND no acknowledged findings.
 */
export function createRunCorrectionEvent(input: RunCorrectionInput): TelemetryEvent | undefined {
  const hasReReview = input.summary.reReview !== undefined;
  const hasAcknowledged = input.summary.findings.some((f) => f.acknowledged !== undefined);

  if (!hasReReview && !hasAcknowledged) {
    return undefined;
  }

  const reReview: ReReviewSummary | undefined = input.summary.reReview;
  const acceptanceByReviewer = deriveAcceptanceByReviewer(input.summary);

  const data: Record<string, JsonValue> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    event: "run.correction",
    repository: input.repository,
    riskTier: input.riskTier,
    newFindingCount: reReview?.newFindingIds.length ?? 0,
    recurringFindingCount: reReview?.recurringFindingIds.length ?? 0,
    fixedFindingCount: reReview?.fixedFindingIds.length ?? 0,
    withheldFindingCount: reReview?.withheldFindingIds.length ?? 0,
    acceptanceByReviewer: acceptanceByReviewerToJson(acceptanceByReviewer),
  };

  return {
    type: "ai_review.run_event",
    runId: input.runId,
    timestamp: input.timestamp,
    data,
  };
}

// ---------------------------------------------------------------------------
// run.override (#22 phase 2)
// ---------------------------------------------------------------------------

export interface RunOverrideInput {
  runId: string;
  timestamp: string;
  repository: string;
  changeId: string;
  riskTier: string;
  /** Stable identifier of the triggering break-glass comment (the audit pointer). */
  overrideCommentId: string;
  /** Coarse role category that authorized it (e.g. "OWNER"/"MEMBER"/"COLLABORATOR"). */
  authorAssociation: string;
}

/**
 * Build a run.override telemetry event — a human break-glass override of the
 * canonical CI gate for this run (#22 phase 2).
 *
 * M008: counts, coarse categories, and stable identifiers only. `overrideCommentId`
 * is a stable identifier (like `changeId`); `authorAssociation` is a coarse role
 * category (like `riskTier`), NOT an author name. The full audit trail (who overrode,
 * and why) lives in the PR/MR comment, never in telemetry. Override RATE — not identity —
 * is the quality signal the analyzer surfaces.
 */
export function createRunOverrideEvent(input: RunOverrideInput): TelemetryEvent {
  const data: Record<string, JsonValue> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    event: "run.override",
    repository: input.repository,
    changeId: input.changeId,
    riskTier: input.riskTier,
    overrideCommentId: input.overrideCommentId,
    authorAssociation: input.authorAssociation,
  };

  return {
    type: "ai_review.run_event",
    runId: input.runId,
    timestamp: input.timestamp,
    data,
  };
}

// ---------------------------------------------------------------------------
// run.prior_decision_respected (M023 S01 / #257)
// ---------------------------------------------------------------------------

export interface PriorDecisionRespectedInput {
  runId: string;
  timestamp: string;
  repository: string;
  changeId: string;
  riskTier: string;
  priorDecision: ReviewDecision | "review_required" | string;
  priorOutcome?: CiOutcome;
  /** Coarse gate signal from the prior run; true means the prior review should have blocked. */
  priorBlocked: boolean;
  merged: boolean;
  overrideRecorded: boolean;
}

/**
 * Build a run.prior_decision_respected telemetry event — a counts-only
 * observation of whether a prior blocking review was later merged with a
 * recorded break-glass override.
 *
 * The event belongs to the prior review runId so telemetry:analyze can join it
 * to that run's real-runtime run_metrics event. M008: identifiers, enums, and
 * booleans only; never PR titles, comments, author names, branch names, finding
 * text, or override reasons.
 */
export function createPriorDecisionRespectedEvent(
  input: PriorDecisionRespectedInput,
): TelemetryEvent {
  const data: Record<string, JsonValue> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    event: "run.prior_decision_respected",
    repository: input.repository,
    changeId: input.changeId,
    riskTier: input.riskTier,
    priorDecision: input.priorDecision,
    priorBlocked: input.priorBlocked,
    merged: input.merged,
    overrideRecorded: input.overrideRecorded,
  };

  if (input.priorOutcome !== undefined) {
    data.priorOutcome = input.priorOutcome;
  }

  return {
    type: "ai_review.run_event",
    runId: input.runId,
    timestamp: input.timestamp,
    data,
  };
}

function acceptanceByReviewerToJson(
  acceptance: Record<string, ReviewerAcceptance>,
): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [reviewer, counts] of Object.entries(acceptance)) {
    out[reviewer] = {
      accepted: counts.accepted,
      notAccepted: counts.notAccepted,
      rejected: counts.rejected,
      withheldExcluded: counts.withheldExcluded,
    };
  }
  return out;
}
