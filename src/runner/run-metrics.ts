import type {
  CoordinatorRunResult,
  Finding,
  JsonValue,
  ReviewContext,
  ReviewContextArtifacts,
  ReviewErrorClassification,
  ReviewRunMetrics,
  ReviewSummary,
  TelemetryEvent,
  TokenUsage,
} from "../contracts/index.ts";

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
  const effectiveModelSet = new Set<string>();
  if (input.coordinatorResult !== undefined) {
    for (const reviewer of input.coordinatorResult.reviewerResults) {
      if (reviewer.effectiveModel !== undefined) effectiveModelSet.add(reviewer.effectiveModel);
    }
    for (const failure of input.coordinatorResult.reviewerFailures ?? []) {
      if (failure.effectiveModel !== undefined) effectiveModelSet.add(failure.effectiveModel);
    }
    if (input.coordinatorResult.effectiveModel !== undefined) {
      effectiveModelSet.add(input.coordinatorResult.effectiveModel);
    }
  }
  const effectiveModelIds = [...effectiveModelSet].sort();

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
  errorClassification?: ReviewErrorClassification;
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
    }));
  }
  if (input.summary?.reReview !== undefined) {
    data.reReview = {
      newFindingCount: input.summary.reReview.newFindingIds.length,
      recurringFindingCount: input.summary.reReview.recurringFindingIds.length,
      fixedFindingCount: input.summary.reReview.fixedFindingIds.length,
      withheldFindingCount: input.summary.reReview.withheldFindingIds.length,
      carriedForwardFindingCount: input.summary.reReview.carriedForwardFindingIds.length,
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
