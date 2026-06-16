import type {
  CoordinatorRunResult,
  DispositionCounts,
  Finding,
  FusionCounts,
  JsonValue,
  ReReviewFindingClassification,
  ReviewContext,
  ReviewContextArtifacts,
  ReviewErrorClassification,
  ReviewRunMetrics,
  ReviewSummary,
  TelemetryEvent,
  TokenUsage,
} from "../contracts/index.ts";
import { deriveDisposition } from "./finding-disposition.ts";

export function createRunMetrics(input: {
  durationsMs: ReviewRunMetrics["durationsMs"];
  contextArtifacts?: ReviewContextArtifacts;
  coordinatorResult?: CoordinatorRunResult;
}): ReviewRunMetrics {
  const agentMetrics =
    input.coordinatorResult === undefined
      ? []
      : [
          ...input.coordinatorResult.reviewerResults.flatMap((result) =>
            result.usage === undefined
              ? []
              : [
                  {
                    agentRunId: result.agentRunId,
                    role: result.role,
                    kind: "reviewer" as const,
                    usage: result.usage,
                    ...(result.promptMetrics !== undefined ? { prompt: result.promptMetrics } : {}),
                    ...(result.attemptCount !== undefined
                      ? { attemptCount: result.attemptCount }
                      : {}),
                    ...(result.retryCount !== undefined ? { retryCount: result.retryCount } : {}),
                    ...(result.effectiveModel !== undefined
                      ? { effectiveModel: result.effectiveModel }
                      : {}),
                    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
                    ...(result.failbackHopCount !== undefined
                      ? { failbackHopCount: result.failbackHopCount }
                      : {}),
                    ...(result.attemptedModels !== undefined
                      ? { attemptedModels: result.attemptedModels }
                      : {}),
                    ...(result.effectiveProvider !== undefined
                      ? { effectiveProvider: result.effectiveProvider }
                      : {}),
                  },
                ],
          ),
          ...(input.coordinatorResult.usage === undefined
            ? []
            : [
                {
                  agentRunId: input.coordinatorResult.agentRunId,
                  role: "coordinator",
                  kind: "coordinator" as const,
                  usage: input.coordinatorResult.usage,
                  ...(input.coordinatorResult.effectiveModel !== undefined
                    ? { effectiveModel: input.coordinatorResult.effectiveModel }
                    : {}),
                  ...(input.coordinatorResult.fusionMs !== undefined
                    ? { durationMs: input.coordinatorResult.fusionMs }
                    : {}),
                },
              ]),
        ];

  const failureMetrics =
    input.coordinatorResult?.reviewerFailures?.map((failure) => ({
      agentRunId: failure.agentRunId,
      role: failure.role,
      kind: "reviewer" as const,
      errorName: failure.errorName,
      errorClassification: failure.errorClassification,
      ...(failure.durationMs !== undefined ? { durationMs: failure.durationMs } : {}),
      ...(failure.attemptCount !== undefined ? { attemptCount: failure.attemptCount } : {}),
      ...(failure.retryCount !== undefined ? { retryCount: failure.retryCount } : {}),
      ...(failure.effectiveModel !== undefined ? { effectiveModel: failure.effectiveModel } : {}),
      ...(failure.failbackExhausted === true ? { failbackExhausted: true } : {}),
      ...(failure.failbackHopCount !== undefined
        ? { failbackHopCount: failure.failbackHopCount }
        : {}),
      ...(failure.attemptedModels !== undefined
        ? { attemptedModels: failure.attemptedModels }
        : {}),
      ...(failure.effectiveProvider !== undefined
        ? { effectiveProvider: failure.effectiveProvider }
        : {}),
    })) ?? [];

  // Counts-only structured-output tally (M015 S05, #128): how many Pi agents delivered via the
  // structured tool vs the prose fallback. Agents with no structuredOutput (e.g. dummy runtime,
  // short-circuit / degraded paths) are excluded from totalCount so a non-Pi run reports nothing.
  const structuredFlags: boolean[] = [];
  if (input.coordinatorResult !== undefined) {
    for (const reviewer of input.coordinatorResult.reviewerResults) {
      if (reviewer.structuredOutput !== undefined) structuredFlags.push(reviewer.structuredOutput);
    }
    if (input.coordinatorResult.structuredOutput !== undefined) {
      structuredFlags.push(input.coordinatorResult.structuredOutput);
    }
  }
  const structuredOutput =
    structuredFlags.length === 0
      ? undefined
      : {
          structuredCount: structuredFlags.filter((flag) => flag).length,
          totalCount: structuredFlags.length,
        };

  // Deduped, sorted effective model identifiers (#189): collect from ALL reviewerResults,
  // reviewerFailures, and the coordinatorResult directly (NOT from agentMetrics, which excludes
  // agents without usage). Failed reviewers still invoked a real model, so they must contribute
  // or per-model attribution silently undercounts runs with transient provider failures.
  // Also collect from attemptedModels (#137): when failback occurs, earlier providers in the
  // chain that were tried before the final result/failure must still be counted.
  const effectiveModelSet = new Set<string>();
  if (input.coordinatorResult !== undefined) {
    for (const reviewer of input.coordinatorResult.reviewerResults) {
      if (reviewer.effectiveModel !== undefined) effectiveModelSet.add(reviewer.effectiveModel);
      for (const m of reviewer.attemptedModels ?? []) effectiveModelSet.add(m.model);
    }
    for (const failure of input.coordinatorResult.reviewerFailures ?? []) {
      if (failure.effectiveModel !== undefined) effectiveModelSet.add(failure.effectiveModel);
      for (const m of failure.attemptedModels ?? []) effectiveModelSet.add(m.model);
    }
    if (input.coordinatorResult.effectiveModel !== undefined) {
      effectiveModelSet.add(input.coordinatorResult.effectiveModel);
    }
  }
  const effectiveModelIds = [...effectiveModelSet].sort();
  const fusion =
    input.coordinatorResult !== undefined
      ? computeFusionCounts(input.coordinatorResult)
      : undefined;

  return {
    durationsMs: input.durationsMs,
    ...(input.contextArtifacts !== undefined
      ? {
          context: createContextMetrics(input.contextArtifacts),
        }
      : {}),
    ...(agentMetrics.length > 0
      ? {
          agents: agentMetrics,
          tokens: sumTokenUsage(agentMetrics.map((agent) => agent.usage)),
        }
      : {}),
    ...(failureMetrics.length > 0 ? { failures: failureMetrics } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(effectiveModelIds.length > 0 ? { effectiveModelIds } : {}),
    ...(fusion !== undefined ? { fusion } : {}),
  };
}

export function createRunMetricsTelemetryEvent(input: {
  runId: string;
  timestamp: string;
  context: ReviewContext;
  metrics: ReviewRunMetrics;
  status: "completed" | "failed";
  runtime: string;
  jobKind?: string;
  groundingDroppedCount?: number;
  locationBackfilledCount?: number;
  acknowledgedCount?: number;
  suppressedCount?: number;
  thinReview?: { outputTokens: number; expectedFloor: number };
  coordinatorShortCircuited?: boolean;
  incremental?: { mode: string; reason: string; reviewedFileCount: number };
  summary?: ReviewSummary;
  /** Convergence gate (#149): true when the re-review finding set is unchanged. Counts-only. */
  converged?: boolean;
  errorClassification?: ReviewErrorClassification;
  /** Per-finding disposition counts (#256, M023 S04). Counts-only; absent on first review. */
  dispositions?: DispositionCounts;
}): TelemetryEvent {
  const data: Record<string, JsonValue> = {
    schemaVersion: "ai-review.run_metrics.v1",
    status: input.status,
    runtime: input.runtime,
    provider: input.context.metadata.provider,
    repository: input.context.metadata.repository.slug,
    changeId: input.context.metadata.changeId,
    headSha: input.context.metadata.headSha,
    safetyMode: input.context.safetyMode,
    riskTier: input.context.risk.tier,
    riskReason: input.context.risk.reason,
    reviewedFileCount: input.context.risk.reviewedFileCount,
    ignoredFileCount: input.context.risk.ignoredFileCount,
    durationMs: input.metrics.durationsMs.overallMs,
    durationsMs: toJsonRecord(input.metrics.durationsMs),
    findingCount: input.summary?.findings.length ?? 0,
    findingsBySeverity: countFindingsBy(
      input.summary?.findings ?? [],
      (finding) => finding.severity,
    ),
    findingsByReviewer: countFindingsBy(
      input.summary?.findings ?? [],
      (finding) => finding.reviewer,
    ),
    decision: input.summary?.decision ?? "review_failed",
    outcome: input.summary?.outcome ?? "fail",
  };

  if (input.jobKind !== undefined) {
    data.jobKind = input.jobKind;
  }

  if (input.metrics.context !== undefined) {
    data.context = toJsonRecord(input.metrics.context);
  }
  if (input.metrics.tokens !== undefined) {
    data.tokens = toJsonRecord(input.metrics.tokens);
  }
  if (input.metrics.structuredOutput !== undefined) {
    data.structuredOutput = {
      structuredCount: input.metrics.structuredOutput.structuredCount,
      totalCount: input.metrics.structuredOutput.totalCount,
    };
  }
  if (input.metrics.effectiveModelIds !== undefined) {
    data.effectiveModelIds = [...input.metrics.effectiveModelIds];
  }
  if (input.metrics.fusion !== undefined) {
    const fusion: Record<string, JsonValue> = {
      rawFindingCount: input.metrics.fusion.rawFindingCount,
      survivingFindingCount: input.metrics.fusion.survivingFindingCount,
      rawMinusSurvivingCount: input.metrics.fusion.rawMinusSurvivingCount,
      attributionComplete: input.metrics.fusion.attributionComplete,
      mergedCount: input.metrics.fusion.mergedCount,
      droppedCount: input.metrics.fusion.droppedCount,
    };
    if (
      input.metrics.fusion.rawByReviewer !== undefined &&
      Object.keys(input.metrics.fusion.rawByReviewer).length > 0
    ) {
      fusion.rawByReviewer = input.metrics.fusion.rawByReviewer as unknown as JsonValue;
    }
    data.fusion = fusion;
  }
  if (input.metrics.agents !== undefined) {
    data.agents = input.metrics.agents.map((agent) => ({
      agentRunId: agent.agentRunId,
      role: agent.role,
      kind: agent.kind,
      usage: toJsonRecord(agent.usage),
      ...(agent.prompt !== undefined ? { prompt: toJsonRecord(agent.prompt) } : {}),
      ...(agent.attemptCount !== undefined ? { attemptCount: agent.attemptCount } : {}),
      ...(agent.retryCount !== undefined ? { retryCount: agent.retryCount } : {}),
      ...(agent.effectiveModel !== undefined ? { effectiveModel: agent.effectiveModel } : {}),
      ...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {}),
      ...(agent.failbackHopCount !== undefined ? { failbackHopCount: agent.failbackHopCount } : {}),
      ...(agent.effectiveProvider !== undefined
        ? { effectiveProvider: agent.effectiveProvider }
        : {}),
      ...(agent.attemptedModels !== undefined
        ? {
            attemptedModels: agent.attemptedModels.map((m) => ({
              provider: m.provider,
              model: m.model,
            })),
          }
        : {}),
    }));
  }
  if (input.metrics.failures !== undefined) {
    data.failures = input.metrics.failures.map((failure) => ({
      agentRunId: failure.agentRunId,
      role: failure.role,
      kind: failure.kind,
      errorName: failure.errorName,
      errorCategory: failure.errorClassification.category,
      retryable: failure.errorClassification.retryable,
      ...(failure.durationMs !== undefined ? { durationMs: failure.durationMs } : {}),
      ...(failure.attemptCount !== undefined ? { attemptCount: failure.attemptCount } : {}),
      ...(failure.retryCount !== undefined ? { retryCount: failure.retryCount } : {}),
      ...(failure.effectiveModel !== undefined ? { effectiveModel: failure.effectiveModel } : {}),
      ...(failure.failbackExhausted === true ? { failbackExhausted: true } : {}),
      ...(failure.failbackHopCount !== undefined
        ? { failbackHopCount: failure.failbackHopCount }
        : {}),
      ...(failure.effectiveProvider !== undefined
        ? { effectiveProvider: failure.effectiveProvider }
        : {}),
      ...(failure.attemptedModels !== undefined
        ? {
            attemptedModels: failure.attemptedModels.map((m) => ({
              provider: m.provider,
              model: m.model,
            })),
          }
        : {}),
    }));
  }
  if (input.summary?.reReview !== undefined) {
    data.reReview = {
      newFindingCount: input.summary.reReview.newFindingIds.length,
      recurringFindingCount: input.summary.reReview.recurringFindingIds.length,
      fixedFindingCount: input.summary.reReview.fixedFindingIds.length,
      withheldFindingCount: input.summary.reReview.withheldFindingIds.length,
      carriedForwardFindingCount: input.summary.reReview.carriedForwardFindingIds.length,
      // Convergence gate (#149): counts-only boolean — converged = 0 new + 0 fixed.
      // M008: no finding text, counts only.
      ...(input.converged === true ? { converged: true } : {}),
    };
  }

  if (input.incremental !== undefined) {
    data.incremental = {
      mode: input.incremental.mode,
      reason: input.incremental.reason,
      reviewedFileCount: input.incremental.reviewedFileCount,
    };
  }
  if (input.groundingDroppedCount !== undefined && input.groundingDroppedCount > 0) {
    data.grounding = { droppedFindingCount: input.groundingDroppedCount };
  }
  if (input.locationBackfilledCount !== undefined && input.locationBackfilledCount > 0) {
    data.locationBackfill = { backfilledCount: input.locationBackfilledCount };
  }
  if (
    (input.acknowledgedCount !== undefined && input.acknowledgedCount > 0) ||
    (input.suppressedCount !== undefined && input.suppressedCount > 0)
  ) {
    const ackData: Record<string, number> = {};
    if (input.acknowledgedCount !== undefined && input.acknowledgedCount > 0) {
      ackData.acknowledgedCount = input.acknowledgedCount;
    }
    if (input.suppressedCount !== undefined && input.suppressedCount > 0) {
      ackData.suppressedCount = input.suppressedCount;
    }
    data.acknowledgements = ackData;
  }
  if (input.thinReview !== undefined) {
    data.thinReview = {
      flagged: true,
      outputTokens: input.thinReview.outputTokens,
      expectedFloor: input.thinReview.expectedFloor,
    };
  }
  if (input.coordinatorShortCircuited === true) {
    data.coordinatorShortCircuited = true;
  }
  if (input.errorClassification !== undefined) {
    data.errorClassification = {
      category: input.errorClassification.category,
      retryable: input.errorClassification.retryable,
      reason: input.errorClassification.reason,
    };
  }
  if (input.dispositions !== undefined) {
    // Counts-only (M008): integers + reviewer-role/severity identifiers — no finding text.
    const d = input.dispositions;
    const dispoData: Record<string, JsonValue> = {
      fixed: d.fixed,
      dismissed: d.dismissed,
      ignored: d.ignored,
      acknowledged: d.acknowledged,
    };
    if (d.byReviewer !== undefined && Object.keys(d.byReviewer).length > 0) {
      dispoData.byReviewer = d.byReviewer as unknown as JsonValue;
    }
    if (d.bySeverity !== undefined && Object.keys(d.bySeverity).length > 0) {
      dispoData.bySeverity = d.bySeverity as unknown as JsonValue;
    }
    data.dispositions = dispoData;
  }

  return {
    type: "ai_review.run_metrics",
    runId: input.runId,
    timestamp: input.timestamp,
    data,
  };
}

export function countFindingsBy(
  findings: Finding[],
  selectKey: (finding: Finding) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    const key = selectKey(finding);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  return counts;
}

function toJsonRecord(record: object): Record<string, JsonValue> {
  const jsonRecord: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) {
      continue;
    }
    jsonRecord[key] = value as JsonValue;
  }

  return jsonRecord;
}

export function createContextMetrics(
  artifacts: ReviewContextArtifacts,
): NonNullable<ReviewRunMetrics["context"]> {
  return {
    artifactBytes: artifacts.totalBytes,
    changeContextBytes: artifacts.changeContextBytes,
    patchBytes: artifacts.patchBytes,
    patchFileCount: artifacts.patchFileCount,
    admission: artifacts.admission,
    deletionHunksPruned: artifacts.deletionHunksPruned,
    deletedFileBodiesPruned: artifacts.deletedFileBodiesPruned,
  };
}

function sumTokenUsage(usages: TokenUsage[]): NonNullable<ReviewRunMetrics["tokens"]> {
  const inputTokens = sumOptional(usages.map((usage) => usage.inputTokens));
  const outputTokens = sumOptional(usages.map((usage) => usage.outputTokens));
  const cacheReadTokens = sumOptional(usages.map((usage) => usage.cacheReadTokens));
  const cacheWriteTokens = sumOptional(usages.map((usage) => usage.cacheWriteTokens));
  const estimatedCostUsd = sumOptional(usages.map((usage) => usage.estimatedCostUsd));

  return {
    agentCount: usages.length,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
  };
}

function sumOptional(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) {
    return undefined;
  }

  return present.reduce((total, value) => total + value, 0);
}

function computeFusionCounts(coordinatorResult: CoordinatorRunResult): FusionCounts | undefined {
  if (coordinatorResult.reviewerResults.length === 0) {
    return undefined;
  }

  let rawFindingCount = 0;
  const rawByReviewer = new Map<string, number>();
  for (const result of coordinatorResult.reviewerResults) {
    const reviewerFindingCount = result.findings.length;
    rawFindingCount += reviewerFindingCount;
    rawByReviewer.set(result.role, (rawByReviewer.get(result.role) ?? 0) + reviewerFindingCount);
  }

  const rawByReviewerRecord: Record<string, number> = {};
  for (const role of [...rawByReviewer.keys()].sort()) {
    rawByReviewerRecord[role] = rawByReviewer.get(role) ?? 0;
  }

  const survivingFindingCount = coordinatorResult.summary.findings.length;
  const rawMinusSurvivingCount = Math.max(rawFindingCount - survivingFindingCount, 0);
  const attributionComplete = false;
  // Current contracts do not preserve a trusted raw→final finding mapping. Keep true
  // attribution counts at zero until mapping work can split raw-minus-surviving into
  // true duplicates vs true drops.
  const mergedCount = 0;
  const droppedCount = 0;

  return {
    rawFindingCount,
    survivingFindingCount,
    rawMinusSurvivingCount,
    attributionComplete,
    mergedCount,
    droppedCount,
    ...(Object.keys(rawByReviewerRecord).length > 0 ? { rawByReviewer: rawByReviewerRecord } : {}),
  };
}

const DISPOSITION_ZERO = (): {
  fixed: number;
  dismissed: number;
  ignored: number;
  acknowledged: number;
} => ({
  fixed: 0,
  dismissed: 0,
  ignored: 0,
  acknowledged: 0,
});

/**
 * Derive per-finding disposition counts from re-review classifications (#256, M023 S04).
 * Returns undefined when there are no prior findings (first review / no prior state).
 * Counts-only: no finding bodies/locations/paths cross egress (M008).
 */
export function computeDispositions(
  classifications: readonly ReReviewFindingClassification[] | undefined,
): DispositionCounts | undefined {
  if (classifications === undefined || classifications.length === 0) {
    return undefined;
  }

  const totals = DISPOSITION_ZERO();
  const byReviewer = new Map<string, ReturnType<typeof DISPOSITION_ZERO>>();
  const bySeverity = new Map<string, ReturnType<typeof DISPOSITION_ZERO>>();
  let hasAny = false;

  for (const cls of classifications) {
    const disposition = deriveDisposition(cls);
    if (disposition === undefined) {
      continue;
    }
    hasAny = true;

    totals[disposition] += 1;

    // Reviewer: prefer the live finding (recurring), fall back to priorFinding (fixed/dismissed).
    const reviewer = (cls.finding ?? cls.priorFinding)?.reviewer;
    if (typeof reviewer === "string" && reviewer.length > 0) {
      let rev = byReviewer.get(reviewer);
      if (rev === undefined) {
        rev = DISPOSITION_ZERO();
        byReviewer.set(reviewer, rev);
      }
      rev[disposition] += 1;
    }

    // Severity: same source preference.
    const severity = (cls.finding ?? cls.priorFinding)?.severity;
    if (typeof severity === "string" && severity.length > 0) {
      let sev = bySeverity.get(severity);
      if (sev === undefined) {
        sev = DISPOSITION_ZERO();
        bySeverity.set(severity, sev);
      }
      sev[disposition] += 1;
    }
  }

  if (!hasAny) {
    return undefined;
  }

  // Build stable-sorted records (mirrors existing byReviewer/bySeverity conventions).
  const byReviewerRecord: Record<
    string,
    { fixed: number; dismissed: number; ignored: number; acknowledged: number }
  > = {};
  for (const key of [...byReviewer.keys()].sort()) {
    byReviewerRecord[key] = byReviewer.get(key) ?? DISPOSITION_ZERO();
  }
  const bySeverityRecord: Record<
    string,
    { fixed: number; dismissed: number; ignored: number; acknowledged: number }
  > = {};
  for (const key of [...bySeverity.keys()].sort()) {
    bySeverityRecord[key] = bySeverity.get(key) ?? DISPOSITION_ZERO();
  }

  return {
    ...totals,
    ...(Object.keys(byReviewerRecord).length > 0 ? { byReviewer: byReviewerRecord } : {}),
    ...(Object.keys(bySeverityRecord).length > 0 ? { bySeverity: bySeverityRecord } : {}),
  };
}
