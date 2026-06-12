import type {
  AgentRuntime,
  ChangeMetadata,
  CoordinatorRunInput,
  CoordinatorRunResult,
  DiffSummary,
  Finding,
  JsonValue,
  ModelSelection,
  PriorReviewState,
  ReviewConfig,
  ReviewContext,
  ReviewContextArtifacts,
  ReviewDecision,
  ReviewErrorClassification,
  ReviewerContextReferences,
  ReviewerRunInput,
  ReviewRunMetrics,
  ReviewStateStore,
  ReviewSummary,
  RiskTier,
  RuntimeEvent,
  RuntimeEventSubscription,
  RuntimeToolPolicy,
  SafetyMode,
  Severity,
  TelemetryEvent,
  TelemetrySink,
  TokenUsage,
  TraceSink,
} from "../contracts/index.ts";
import { escapeMarkdown } from "../publisher/markdown-escape.ts";
import { resolveRuntimeKind, sanitizeJobKind } from "../runtime/runtime-kind.ts";
import { applyAcknowledgements } from "./acknowledgements.ts";
import { writeReviewContextArtifacts } from "./context-artifacts.ts";
import { filterDiff } from "./diff-filter.ts";
import { classifyReviewError } from "./error-classifier.ts";
import { assessFindingGrounding } from "./evidence-grounding.ts";
import { normalizeReviewFixture, type ReviewFixture } from "./fixture.ts";
import { backfillFindingLocations } from "./location-backfill.ts";
import { classifyReReviewFindings } from "./re-review.ts";
import {
  findUnsupportedReviewerPolicyEntries,
  selectTrustedReviewerDefinitions,
} from "./reviewer-definitions.ts";
import { classifyRisk } from "./risk-classifier.ts";
import {
  createRunCompletedEvent,
  createRunCorrectionEvent,
  createRunStartEvent,
} from "./run-events.ts";
import { assignStableFindingIds, createStableFindingId } from "./stable-finding-id.ts";
import { assessThinReview } from "./thin-review.ts";
import { getTierProfile } from "./tier-profile.ts";

export interface RunReviewOptions {
  fixture: ReviewFixture;
  now?: Date;
  clock?: () => Date;
  stateStore?: ReviewStateStore;
  traceSink?: TraceSink;
  tracePath?: string;
  telemetrySink?: TelemetrySink;
  runtime?: AgentRuntime;
  jobKind?: string;
}

export interface RunReviewResult {
  context: ReviewContext;
  summary: ReviewSummary;
  coordinatorResult?: CoordinatorRunResult;
}

interface PartialCoordinatorResultRuntime {
  getPartialCoordinatorResult(runId: string): CoordinatorRunResult | undefined;
}

export interface RunReviewFromChangeOptions extends Omit<RunReviewOptions, "fixture"> {
  metadata: ChangeMetadata;
  diff: DiffSummary;
  config?: Partial<ReviewConfig>;
  safetyMode?: ReviewFixture["safetyMode"];
  workingDirectory?: string;
  contextDirectory?: string;
  runId?: string;
  priorState?: PriorReviewState;
  fakeFindings?: Finding[];
}

export async function runReviewFromChange(
  options: RunReviewFromChangeOptions,
): Promise<RunReviewResult> {
  const fixture = normalizeReviewFixture({
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.safetyMode !== undefined ? { safetyMode: options.safetyMode } : {}),
    ...(options.workingDirectory !== undefined
      ? { workingDirectory: options.workingDirectory }
      : {}),
    ...(options.contextDirectory !== undefined
      ? { contextDirectory: options.contextDirectory }
      : {}),
    metadata: options.metadata,
    diff: options.diff,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.priorState !== undefined ? { priorState: options.priorState } : {}),
    ...(options.fakeFindings !== undefined ? { fakeFindings: options.fakeFindings } : {}),
  });

  return runReview({
    fixture,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    ...(options.stateStore !== undefined ? { stateStore: options.stateStore } : {}),
    ...(options.traceSink !== undefined ? { traceSink: options.traceSink } : {}),
    ...(options.tracePath !== undefined ? { tracePath: options.tracePath } : {}),
    ...(options.telemetrySink !== undefined ? { telemetrySink: options.telemetrySink } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
    ...(options.jobKind !== undefined ? { jobKind: options.jobKind } : {}),
  });
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  const fixture = options.fixture;
  const clock = options.clock ?? (() => new Date());
  const startedAt = options.now ?? clock();
  const timestamp = startedAt.toISOString();
  const runId = fixture.runId ?? createRunId(startedAt);
  const runtimeKind = resolveRuntimeKind(options.runtime?.name);
  const jobKind = sanitizeJobKind(options.jobKind);

  await emitTrace(options.traceSink, {
    type: "review.started",
    runId,
    timestamp,
    data: {
      provider: fixture.metadata.provider,
      repository: fixture.metadata.repository.slug,
      changeId: fixture.metadata.changeId,
      headSha: fixture.metadata.headSha,
      safetyMode: fixture.safetyMode ?? "trusted",
    },
  });

  const contextBuildStartedAt = clock();
  const filtered = filterDiff(fixture.diff, fixture.config);
  const riskAssessmentStartedAt = clock();
  const risk =
    fixture.risk ??
    classifyRisk({
      diff: filtered.diff,
      config: fixture.config,
      ignoredFileCount: filtered.ignoredFiles.length,
    });
  const riskAssessmentCompletedAt = clock();

  const context: ReviewContext = {
    runId,
    safetyMode: fixture.safetyMode ?? "trusted",
    workingDirectory: fixture.workingDirectory ?? process.cwd(),
    contextDirectory: fixture.contextDirectory ?? ".ai-review/context",
    metadata: fixture.metadata,
    diff: filtered.diff,
    risk,
    config: fixture.config,
    ...(fixture.priorState !== undefined ? { priorState: fixture.priorState } : {}),
  };

  const contextArtifacts = await writeReviewContextArtifacts({
    context,
    generatedAt: clock().toISOString(),
  });
  context.diff = contextArtifacts.diff;
  context.contextArtifacts = contextArtifacts.artifacts;

  const contextBuiltAt = clock();
  const contextBuildMs = elapsedMs(contextBuildStartedAt, contextBuiltAt);
  const riskAssessmentMs = elapsedMs(riskAssessmentStartedAt, riskAssessmentCompletedAt);

  await emitTrace(options.traceSink, {
    type: "context.built",
    runId,
    timestamp: contextBuiltAt.toISOString(),
    data: {
      contextDirectory: context.contextDirectory,
      fileCount: context.diff.files.length,
      totalAdditions: context.diff.totalAdditions,
      totalDeletions: context.diff.totalDeletions,
      priorFindingCount: context.priorState?.findings.length ?? 0,
      contextArtifacts: {
        changeContextPath: context.contextArtifacts.changeContextPath,
        patchDirectory: context.contextArtifacts.patchDirectory,
        patchFileCount: context.contextArtifacts.patchFileCount,
        changeContextBytes: context.contextArtifacts.changeContextBytes,
        patchBytes: context.contextArtifacts.patchBytes,
        totalBytes: context.contextArtifacts.totalBytes,
      },
      durationMs: contextBuildMs,
    },
  });

  await emitTrace(options.traceSink, {
    type: "risk.assessed",
    runId,
    timestamp: clock().toISOString(),
    data: {
      tier: risk.tier,
      reason: risk.reason,
      reviewedFileCount: risk.reviewedFileCount,
      ignoredFileCount: risk.ignoredFileCount,
      matchedRules: risk.matchedRules,
      sensitivePaths: risk.sensitivePaths,
      durationMs: riskAssessmentMs,
    },
  });

  // S04: run.start — emitted on every run (before agent execution), so
  // completion rate = completed / started is meaningful even for failed runs.
  const selectedReviewerDefs = selectTrustedReviewerDefinitions({
    config: context.config,
    risk: context.risk,
  });
  const selectedReviewerRoles = selectedReviewerDefs.map((d) => d.role);
  const modelIds = [
    ...selectedReviewerDefs.map((d) => selectModel(context, d.role).model),
    selectModel(context, "coordinator").model,
  ];
  await emitTelemetry({
    telemetrySink: options.telemetrySink,
    traceSink: options.traceSink,
    event: createRunStartEvent({
      runId,
      timestamp,
      repository: context.metadata.repository.slug,
      changeId: context.metadata.changeId,
      riskTier: context.risk.tier,
      selectedReviewerRoles,
      modelIds,
    }),
  });

  for (const unsupportedReviewer of findUnsupportedReviewerPolicyEntries({
    config: context.config,
  })) {
    await emitTrace(options.traceSink, {
      type: "agent.skipped",
      runId,
      role: unsupportedReviewer.role,
      timestamp: clock().toISOString(),
      message: `Configured reviewer role ${formatRoleForTraceMessage(unsupportedReviewer.role)} has no trusted definition; ignored.`,
      data: {
        reason: unsupportedReviewer.reason,
        policy: unsupportedReviewer.policy,
      },
    });
  }

  try {
    const coordinatorStartedAt = clock();
    const runtimeResult = await runAgents({
      runtime: options.runtime,
      context,
      traceSink: options.traceSink,
      fakeFindings: fixture.fakeFindings ?? [],
    });
    const coordinatorCompletedAt = clock();
    const coordinatorMs = elapsedMs(coordinatorStartedAt, coordinatorCompletedAt);
    const grounding = assessFindingGrounding(runtimeResult.summary.findings, context.diff);
    const groundingDroppedCount = grounding.dropped.length;
    let groundedSummary = runtimeResult.summary;
    if (groundingDroppedCount > 0) {
      const highestSeverity = getHighestSeverity(grounding.grounded);
      const decision = chooseDecision(grounding.grounded, highestSeverity);
      const hasBlockingFinding =
        highestSeverity !== undefined && context.config.failOn.includes(highestSeverity);
      const outcome = context.config.mode === "blocking" && hasBlockingFinding ? "fail" : "pass";
      groundedSummary = {
        ...runtimeResult.summary,
        findings: grounding.grounded,
        decision,
        outcome,
        // The displayed finding set changed (some withheld), so refresh the title — its count must
        // reflect the findings now shown, not the coordinator's pre-grounding count.
        title: createSummaryTitle(decision, grounding.grounded),
        body: `${runtimeResult.summary.body}\n\n_${groundingDroppedCount} finding(s) withheld: the code they cited could not be found in the changed files._`,
      };
      await emitTrace(options.traceSink, {
        type: "grounding.applied",
        runId,
        role: "coordinator",
        timestamp: clock().toISOString(),
        data: {
          droppedFindingCount: groundingDroppedCount,
          dropped: grounding.dropped.map((f) => ({
            reviewer: f.reviewer,
            severity: f.severity,
            category: f.category,
            title: f.title,
          })),
        },
      });
    }
    // Deterministically backfill `location` from `quotedCode` for findings that
    // have evidence but no usable line — so they become inline-eligible after
    // assignStableFindingIds keys them at their authoritative coordinates (#87).
    // The backfill runs after grounding (so we only locate grounded findings) and
    // before stable-id assignment (so backfilled coordinates feed the id key,
    // making ids stable across re-reviews).
    const backfill = backfillFindingLocations(groundedSummary.findings, context.diff);
    const locationBackfilledCount = backfill.backfilledCount;
    if (locationBackfilledCount > 0) {
      groundedSummary = { ...groundedSummary, findings: backfill.findings };
      await emitTrace(options.traceSink, {
        type: "location.backfill.applied",
        runId,
        role: "coordinator",
        timestamp: clock().toISOString(),
        data: { backfilledCount: locationBackfilledCount },
      });
    }

    const withIds = assignStableFindingIds(groundedSummary);
    const acked = applyAcknowledgements(
      withIds.findings,
      context.config.acknowledgements ?? [],
      startedAt,
    );
    const acknowledgedCount = acked.acknowledgedCount;
    const suppressedCount = acked.suppressedCount;
    let ackedSummary = withIds;
    if (acked.acknowledgedCount > 0 || acked.suppressedCount > 0) {
      // Recompute the gate from findings that still count — acknowledged + suppressed are excluded.
      const gateFindings = acked.findings.filter((f) => f.acknowledged === undefined);
      const highestSeverity = getHighestSeverity(gateFindings);
      const decision = chooseDecision(gateFindings, highestSeverity);
      const hasBlockingFinding =
        highestSeverity !== undefined && context.config.failOn.includes(highestSeverity);
      const outcome = context.config.mode === "blocking" && hasBlockingFinding ? "fail" : "pass";
      const notes: string[] = [];
      if (acked.acknowledgedCount > 0)
        notes.push(`${acked.acknowledgedCount} finding(s) acknowledged`);
      if (acked.suppressedCount > 0) notes.push(`${acked.suppressedCount} suppressed`);
      ackedSummary = {
        ...withIds,
        findings: acked.findings,
        decision,
        outcome,
        // Refresh the title for the changed set. Count reflects the findings SHOWN (acked.findings —
        // acknowledged ones are still listed, annotated); the decision is driven by gateFindings.
        title: createSummaryTitle(decision, acked.findings),
        body: `${withIds.body}\n\n_${notes.join("; ")} by project acknowledgements (base-branch .ai-review.json)._`,
      };
      await emitTrace(options.traceSink, {
        type: "acknowledgements.applied",
        runId,
        role: "coordinator",
        timestamp: clock().toISOString(),
        data: {
          acknowledgedCount: acked.acknowledgedCount,
          suppressedCount: acked.suppressedCount,
        },
      });
    }
    // Stable IDs of findings grounding withheld this run, so re-review classifies a prior
    // finding that vanished only because grounding dropped it as `withheld`, not `fixed` (#69).
    // Best-effort match: recomputing the ID here matches the prior stored ID only when it was not
    // backfill-derived or collision-suffixed (a dropped finding can't be re-backfilled — its quote
    // is absent from the current diff). When it doesn't match, the prior finding stays in
    // `fixedFindingIds` (pre-#69 behavior — no regression). This is analytics/signal-accuracy only:
    // withheld/fixed never affect the CI gate, decision, or outcome (those were finalized above).
    const withheldStableIds = new Set(grounding.dropped.map((f) => createStableFindingId(f)));
    const summary = classifyReReviewFindings(ackedSummary, context.priorState, withheldStableIds);

    await emitTrace(options.traceSink, {
      type: "coordinator.completed",
      runId,
      role: "coordinator",
      timestamp: coordinatorCompletedAt.toISOString(),
      data: {
        decision: summary.decision,
        outcome: summary.outcome,
        findingCount: summary.findings.length,
        durationMs: coordinatorMs,
        ...(runtimeResult.coordinatorResult?.coordinatorShortCircuited === true
          ? { coordinatorShortCircuited: true }
          : {}),
        ...(summary.reReview !== undefined
          ? {
              newFindingCount: summary.reReview.newFindingIds.length,
              recurringFindingCount: summary.reReview.recurringFindingIds.length,
              fixedFindingCount: summary.reReview.fixedFindingIds.length,
              withheldFindingCount: summary.reReview.withheldFindingIds.length,
            }
          : {}),
      },
    });

    const completedAt = clock();
    const completedAtTimestamp = completedAt.toISOString();
    const overallMs = elapsedMs(startedAt, completedAt);
    const metrics = createRunMetrics({
      durationsMs: {
        overallMs,
        contextBuildMs,
        riskAssessmentMs,
        coordinatorMs,
      },
      ...(context.contextArtifacts !== undefined
        ? { contextArtifacts: context.contextArtifacts }
        : {}),
      ...(runtimeResult.coordinatorResult !== undefined
        ? { coordinatorResult: runtimeResult.coordinatorResult }
        : {}),
    });
    await options.stateStore?.saveRun({
      runId,
      startedAt: timestamp,
      completedAt: completedAtTimestamp,
      context: {
        safetyMode: context.safetyMode,
        metadata: context.metadata,
        risk: context.risk,
      },
      summary,
      metrics,
      ...(options.tracePath !== undefined ? { tracePath: options.tracePath } : {}),
    });
    await options.stateStore?.saveSummary(runId, summary);

    const thinReview = assessThinReview({
      riskTier: context.risk.tier,
      reviewedFileCount: context.risk.reviewedFileCount,
      outputTokens: metrics.tokens?.outputTokens,
    });

    await emitTelemetry({
      telemetrySink: options.telemetrySink,
      traceSink: options.traceSink,
      event: createRunMetricsTelemetryEvent({
        runId,
        timestamp: completedAtTimestamp,
        context,
        summary,
        metrics,
        status: "completed",
        runtime: runtimeKind,
        ...(jobKind !== undefined ? { jobKind } : {}),
        ...(groundingDroppedCount > 0 ? { groundingDroppedCount } : {}),
        ...(locationBackfilledCount > 0 ? { locationBackfilledCount } : {}),
        ...(acknowledgedCount > 0 ? { acknowledgedCount } : {}),
        ...(suppressedCount > 0 ? { suppressedCount } : {}),
        ...(thinReview.thin
          ? {
              thinReview: {
                outputTokens: thinReview.outputTokens,
                expectedFloor: thinReview.expectedFloor,
              },
            }
          : {}),
        ...(runtimeResult.coordinatorResult?.coordinatorShortCircuited === true
          ? { coordinatorShortCircuited: true }
          : {}),
      }),
    });

    // S04: run.completed — emitted in the completed path only; failed runs
    // emit no run.completed so completion rate = completed/started.
    await emitTelemetry({
      telemetrySink: options.telemetrySink,
      traceSink: options.traceSink,
      event: createRunCompletedEvent({
        runId,
        timestamp: completedAtTimestamp,
        repository: context.metadata.repository.slug,
        riskTier: context.risk.tier,
        decision: summary.decision,
        outcome: summary.outcome,
        durationMs: overallMs,
        findingCount: summary.findings.length,
        findingsBySeverity: countFindingsBy(summary.findings, (f) => f.severity),
        findingsByReviewer: countFindingsBy(summary.findings, (f) => f.reviewer),
        // Forward tokens whole — the builder is the single per-field filter
        // (re-spreading fields here would silently drop any future field).
        ...(metrics.tokens !== undefined ? { tokens: metrics.tokens } : {}),
      }),
    });

    // S04/S05: run.correction — emitted only when there is a correction/acceptance signal.
    const correctionEvent = createRunCorrectionEvent({
      runId,
      timestamp: completedAtTimestamp,
      repository: context.metadata.repository.slug,
      riskTier: context.risk.tier,
      summary,
    });
    if (correctionEvent !== undefined) {
      await emitTelemetry({
        telemetrySink: options.telemetrySink,
        traceSink: options.traceSink,
        event: correctionEvent,
      });
    }

    if (thinReview.thin) {
      await emitTrace(options.traceSink, {
        type: "review.thin_detected",
        runId,
        timestamp: clock().toISOString(),
        data: {
          riskTier: context.risk.tier,
          reviewedFileCount: context.risk.reviewedFileCount,
          outputTokens: thinReview.outputTokens,
          expectedFloor: thinReview.expectedFloor,
        },
      });
    }

    await emitTrace(options.traceSink, {
      type: "review.completed",
      runId,
      timestamp: completedAtTimestamp,
      data: {
        decision: summary.decision,
        outcome: summary.outcome,
        durationMs: overallMs,
      },
    });

    return {
      context,
      summary,
      ...(runtimeResult.coordinatorResult !== undefined
        ? { coordinatorResult: runtimeResult.coordinatorResult }
        : {}),
    };
  } catch (error) {
    const failedAt = clock();
    const failedAtTimestamp = failedAt.toISOString();
    const overallMs = elapsedMs(startedAt, failedAt);
    const serializedError = serializeError(error);
    const errorClassification = classifyReviewError(error);
    await emitTrace(options.traceSink, {
      type: "review.failed",
      runId,
      timestamp: failedAtTimestamp,
      message: serializedError.message,
      data: {
        phase: "agent_runtime",
        errorName: serializedError.name,
        errorMessage: serializedError.message,
        errorClassification: {
          category: errorClassification.category,
          retryable: errorClassification.retryable,
          reason: errorClassification.reason,
        },
        errorCategory: errorClassification.category,
        retryable: errorClassification.retryable,
        ...(serializedError.stack !== undefined ? { errorStack: serializedError.stack } : {}),
        durationMs: overallMs,
      },
    });
    const metrics: ReviewRunMetrics = {
      durationsMs: {
        overallMs,
        contextBuildMs,
        riskAssessmentMs,
      },
      ...(context.contextArtifacts !== undefined
        ? {
            context: createContextMetrics(context.contextArtifacts),
          }
        : {}),
    };
    await options.stateStore?.saveRun({
      runId,
      startedAt: timestamp,
      completedAt: failedAtTimestamp,
      context: {
        safetyMode: context.safetyMode,
        metadata: context.metadata,
        risk: context.risk,
      },
      metrics,
      error: serializedError.message,
      errorClassification,
      ...(options.tracePath !== undefined ? { tracePath: options.tracePath } : {}),
    });
    await emitTelemetry({
      telemetrySink: options.telemetrySink,
      traceSink: options.traceSink,
      event: createRunMetricsTelemetryEvent({
        runId,
        timestamp: failedAtTimestamp,
        context,
        metrics,
        status: "failed",
        runtime: runtimeKind,
        ...(jobKind !== undefined ? { jobKind } : {}),
        errorClassification,
      }),
    });

    throw error;
  }
}

export function summarizeReview(context: ReviewContext, findings: Finding[]): ReviewSummary {
  const dedupedFindings = deduplicateFindings(findings);
  const highestSeverity = getHighestSeverity(dedupedFindings);
  const hasBlockingFinding =
    highestSeverity !== undefined && context.config.failOn.includes(highestSeverity);
  const decision = chooseDecision(dedupedFindings, highestSeverity);
  const outcome = context.config.mode === "blocking" && hasBlockingFinding ? "fail" : "pass";

  return {
    decision,
    outcome,
    title: createSummaryTitle(decision, dedupedFindings),
    body: createSummaryBody(context, dedupedFindings),
    findings: dedupedFindings,
    risk: context.risk,
  };
}

async function runAgents(input: {
  runtime: AgentRuntime | undefined;
  context: ReviewContext;
  traceSink: TraceSink | undefined;
  fakeFindings: Finding[];
}): Promise<{ summary: ReviewSummary; coordinatorResult?: CoordinatorRunResult }> {
  if (input.runtime === undefined) {
    return {
      summary: summarizeReview(input.context, runDeterministicFakeReviewers(input.fakeFindings)),
    };
  }

  const runtimeTraceWrites: Promise<void>[] = [];
  const subscription: RuntimeEventSubscription = input.runtime.streamEvents(
    input.context.runId,
    (event) => {
      runtimeTraceWrites.push(emitTrace(input.traceSink, event));
    },
  );

  try {
    const coordinatorResult = await withOverallTimeout(
      input.runtime.runCoordinator(createCoordinatorRunInput(input.context)),
      getEffectiveTimeouts(input.context).overallMs,
      input.context.runId,
      async () => {
        const partial = getPartialCoordinatorResult(input.runtime, input.context.runId);
        await input.runtime?.cancel(input.context.runId);
        return partial;
      },
    );
    if (coordinatorResult.partial?.reason === "overall_timeout") {
      await emitTrace(input.traceSink, {
        type: "review.timeout",
        runId: input.context.runId,
        role: "coordinator",
        timestamp: new Date().toISOString(),
        message:
          "Review run reached the overall timeout; returning completed reviewer findings as a partial summary.",
        data: {
          phase: "agent_runtime",
          partial: true,
          reason: "overall_timeout",
          completedReviewerCount: coordinatorResult.reviewerResults.length,
          failedReviewerCount: coordinatorResult.reviewerFailures?.length ?? 0,
        },
      });
    }
    await Promise.all(runtimeTraceWrites);

    return {
      summary: coordinatorResult.summary,
      coordinatorResult,
    };
  } finally {
    subscription.unsubscribe();
  }
}

function getPartialCoordinatorResult(
  runtime: AgentRuntime | undefined,
  runId: string,
): CoordinatorRunResult | undefined {
  if (!hasPartialCoordinatorResult(runtime)) {
    return undefined;
  }

  return runtime.getPartialCoordinatorResult(runId);
}

function hasPartialCoordinatorResult(
  runtime: AgentRuntime | undefined,
): runtime is AgentRuntime & PartialCoordinatorResultRuntime {
  return (
    typeof (runtime as { getPartialCoordinatorResult?: unknown } | undefined)
      ?.getPartialCoordinatorResult === "function"
  );
}

async function withOverallTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  runId: string,
  onTimeout: () => Promise<T | undefined>,
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(
        new Error(
          `Review run timed out after overall timeout ${timeoutMs}ms for ${formatRunIdForError(runId)}`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      promise.catch(() => undefined);
      const partial = await onTimeout().catch(() => undefined);
      if (partial !== undefined) {
        return partial;
      }
    }
    throw error;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function formatRunIdForError(runId: string): string {
  return runId.replace(/[^A-Za-z0-9:._-]/g, "_");
}

function formatRoleForTraceMessage(role: string): string {
  return role.replaceAll(/[\r\n\t]/g, " ").slice(0, 120);
}

function elapsedMs(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function createRunMetrics(input: {
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
    })) ?? [];

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
  };
}

function createRunMetricsTelemetryEvent(input: {
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
  if (input.metrics.agents !== undefined) {
    data.agents = input.metrics.agents.map((agent) => ({
      agentRunId: agent.agentRunId,
      role: agent.role,
      kind: agent.kind,
      usage: toJsonRecord(agent.usage),
      ...(agent.prompt !== undefined ? { prompt: toJsonRecord(agent.prompt) } : {}),
      ...(agent.attemptCount !== undefined ? { attemptCount: agent.attemptCount } : {}),
      ...(agent.retryCount !== undefined ? { retryCount: agent.retryCount } : {}),
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
    }));
  }
  if (input.summary?.reReview !== undefined) {
    data.reReview = {
      newFindingCount: input.summary.reReview.newFindingIds.length,
      recurringFindingCount: input.summary.reReview.recurringFindingIds.length,
      fixedFindingCount: input.summary.reReview.fixedFindingIds.length,
      withheldFindingCount: input.summary.reReview.withheldFindingIds.length,
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

function countFindingsBy(
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

function createContextMetrics(
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

function runDeterministicFakeReviewers(fakeFindings: Finding[]): Finding[] {
  return fakeFindings;
}

function createCoordinatorRunInput(context: ReviewContext): CoordinatorRunInput {
  const shortCircuit = getTierProfile(context.risk.tier).shortCircuitCoordinatorOnZeroFindings;
  return {
    runId: context.runId,
    role: "coordinator",
    prompt: "Coordinate deterministic code review reviewers and consolidate their findings.",
    context,
    model: selectModel(context, "coordinator"),
    toolPolicy: createRuntimeToolPolicy(context.safetyMode, context.risk.tier),
    timeoutMs: getEffectiveTimeouts(context).coordinatorMs,
    outputSchemaName: "coordinator",
    selectedReviewers: createReviewerRunInputs(context),
    ...(shortCircuit ? { shortCircuitOnZeroFindings: true } : {}),
  };
}

function createReviewerRunInputs(context: ReviewContext): ReviewerRunInput[] {
  const timeouts = getEffectiveTimeouts(context);

  return selectTrustedReviewerDefinitions({ config: context.config, risk: context.risk }).map(
    (reviewerDefinition) => {
      const assignedFiles = context.diff.files.map((file) => file.path);

      return {
        runId: context.runId,
        role: reviewerDefinition.role,
        prompt: `Review the change as the ${reviewerDefinition.role} reviewer.`,
        context,
        model: selectModel(context, reviewerDefinition.role),
        toolPolicy: createRuntimeToolPolicy(context.safetyMode, context.risk.tier),
        timeoutMs: timeouts.reviewerMs,
        outputSchemaName: "reviewer",
        assignedFiles,
        contextReferences: createReviewerContextReferences(context, assignedFiles),
        reviewerDefinition,
      };
    },
  );
}

function createReviewerContextReferences(
  context: ReviewContext,
  assignedFiles: string[],
): ReviewerContextReferences {
  const assignedFileSet = new Set(assignedFiles);
  const files = context.diff.files
    .filter((file) => assignedFileSet.has(file.path))
    .map(({ patch, ...file }) => file);

  return {
    ...(context.contextArtifacts !== undefined
      ? {
          changeContextPath: context.contextArtifacts.changeContextPath,
          patchDirectory: context.contextArtifacts.patchDirectory,
        }
      : {}),
    files,
  };
}

export function selectModel(context: ReviewContext, role: string): ModelSelection {
  const routing = context.config.modelRouting;
  const selected = routing.roles[role] ?? routing.default;
  // `thinking` is a task-level reasoning bound, not part of model identity. We resolve its
  // inheritance here, in the runtime-agnostic orchestration layer, so the convergence guard
  // (#45) applies consistently for every agent runtime (pi, opencode, ...) — each adapter
  // just translates the already-resolved value. A role override that omits `thinking` inherits
  // modelRouting.default.thinking; model identity (provider/model/tier) stays object-level.
  if (selected.thinking === undefined && routing.default.thinking !== undefined) {
    return { ...selected, thinking: routing.default.thinking };
  }
  return selected;
}

export function getEffectiveTimeouts(context: ReviewContext): ReviewConfig["timeouts"] {
  return scaleTimeoutsForRiskTier(context.config.timeouts, context.risk.tier);
}

export function riskTierTimeoutScale(tier: RiskTier): number {
  return getTierProfile(tier).timeoutScale;
}

export function scaleTimeoutsForRiskTier(
  timeouts: ReviewConfig["timeouts"],
  tier: RiskTier,
): ReviewConfig["timeouts"] {
  if (tier === "full") {
    return timeouts;
  }

  const scale = riskTierTimeoutScale(tier);

  return {
    reviewerMs: scaleTimeout(timeouts.reviewerMs, scale),
    coordinatorMs: scaleTimeout(timeouts.coordinatorMs, scale),
    overallMs: scaleTimeout(timeouts.overallMs, scale),
  };
}

export function scaleTimeoutForRiskTier(timeoutMs: number, tier: RiskTier): number {
  return scaleTimeout(timeoutMs, riskTierTimeoutScale(tier));
}

function scaleTimeout(timeoutMs: number, scale: number): number {
  return Math.max(1, Math.floor(timeoutMs * scale));
}

function deduplicateFindings(findings: Finding[]): Finding[] {
  const findingsByKey = new Map<string, Finding>();

  for (const finding of findings) {
    const key = dedupeFindingKey(finding);
    const existing = findingsByKey.get(key);
    if (existing === undefined || compareSeverity(finding.severity, existing.severity) > 0) {
      findingsByKey.set(key, finding);
    }
  }

  return [...findingsByKey.values()];
}

function dedupeFindingKey(finding: Finding): string {
  const location = finding.location;
  return JSON.stringify({
    category: normalizeDedupeText(finding.category),
    title: normalizeDedupeText(finding.title),
    body: normalizeDedupeText(finding.body),
    path: location?.path ?? "",
    line: location?.line ?? null,
    startLine: location?.startLine ?? null,
    endLine: location?.endLine ?? null,
    side: location?.side ?? "",
  });
}

function normalizeDedupeText(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, " ").trim();
}

function compareSeverity(left: Severity, right: Severity): number {
  const order: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    suggestion: 1,
  };

  return order[left] - order[right];
}

export function createRuntimeToolPolicy(
  safetyMode: SafetyMode,
  tier: RiskTier = "full",
): RuntimeToolPolicy {
  if (safetyMode === "privileged_metadata_only") {
    return {
      allowRead: false,
      allowWrite: false,
      allowShell: false,
      allowedTools: [],
      deniedTools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
    };
  }

  if (getTierProfile(tier).denyContextTools) {
    return {
      allowRead: false,
      allowWrite: false,
      allowShell: false,
      allowedTools: [],
      deniedTools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
    };
  }

  if (safetyMode === "manual_privileged") {
    return {
      allowRead: true,
      allowWrite: false,
      allowShell: true,
      allowedTools: [],
      deniedTools: ["write", "edit"],
    };
  }

  return {
    allowRead: true,
    allowWrite: false,
    allowShell: false,
    allowedTools: [],
    deniedTools: ["bash", "write", "edit"],
  };
}

function chooseDecision(
  findings: Finding[],
  highestSeverity: Severity | undefined,
): ReviewDecision {
  if (findings.length === 0) {
    return "approved";
  }

  if (highestSeverity === "critical") {
    return "significant_concerns";
  }

  if (highestSeverity === "warning") {
    const warningCount = findings.filter((finding) => finding.severity === "warning").length;
    return warningCount > 1 ? "minor_issues" : "approved_with_comments";
  }

  return "approved_with_comments";
}

function getHighestSeverity(findings: Finding[]): Severity | undefined {
  const order: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    suggestion: 1,
  };

  let highest: Severity | undefined;
  for (const finding of findings) {
    if (highest === undefined || order[finding.severity] > order[highest]) {
      highest = finding.severity;
    }
  }

  return highest;
}

function createSummaryTitle(decision: ReviewDecision, findings: Finding[]): string {
  if (findings.length === 0) {
    return "AI review found no blocking issues";
  }

  if (decision === "significant_concerns") {
    return "AI review found significant concerns";
  }

  return `AI review found ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
}

function createSummaryBody(context: ReviewContext, findings: Finding[]): string {
  const lines = [
    `Risk tier: ${context.risk.tier}`,
    `Risk reason: ${context.risk.reason}`,
    `Files reviewed: ${context.risk.reviewedFileCount}`,
    `Files ignored: ${context.risk.ignoredFileCount}`,
    `Findings: ${findings.length}`,
  ];

  if (findings.length > 0) {
    lines.push("");
    for (const finding of findings) {
      // title is LLM-produced; path comes from the diff — both are untrusted and must be
      // escaped here so that summary.body is safe for structural Markdown assembly in
      // formatReviewSummaryMarkdown, which leaves summary.body unescaped (#74).
      const location =
        finding.location?.path !== undefined
          ? ` (${escapeMarkdown(finding.location.path)}${finding.location.line !== undefined ? `:${finding.location.line}` : ""})`
          : "";
      lines.push(`- [${finding.severity}] ${escapeMarkdown(finding.title)}${location}`);
    }
  }

  return lines.join("\n");
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

async function emitTrace(traceSink: TraceSink | undefined, event: RuntimeEvent): Promise<void> {
  await traceSink?.write(event);
}

async function emitTelemetry(input: {
  telemetrySink: TelemetrySink | undefined;
  traceSink: TraceSink | undefined;
  event: TelemetryEvent;
}): Promise<void> {
  try {
    input.telemetrySink?.emit(input.event);
  } catch (error) {
    const serializedError = serializeError(error);
    await emitTrace(input.traceSink, {
      type: "runtime.event",
      runId: input.event.runId ?? "unknown",
      timestamp: input.event.timestamp,
      message: "Telemetry emit failed",
      data: {
        event: "telemetry.emit_failed",
        telemetryEventType: input.event.type,
        errorName: serializedError.name,
        errorMessage: serializedError.message,
      },
    });
  }
}

export function createRunId(now: Date): string {
  return `local-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
}
