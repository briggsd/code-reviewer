import type {
  AgentRuntime,
  ChangeMetadata,
  CoordinatorRunInput,
  CoordinatorRunResult,
  DiffSummary,
  Finding,
  ModelSelection,
  PriorReviewState,
  ReviewConfig,
  ReviewContext,
  ReviewDecision,
  ReviewerRunInput,
  ReviewRunMetrics,
  ReviewStateStore,
  ReviewSummary,
  RuntimeEvent,
  RuntimeEventSubscription,
  RuntimeToolPolicy,
  SafetyMode,
  Severity,
  TokenUsage,
  TraceSink,
} from "../contracts/index.ts";
import { filterDiff } from "./diff-filter.ts";
import { classifyReviewError } from "./error-classifier.ts";
import { normalizeReviewFixture, type ReviewFixture } from "./fixture.ts";
import { classifyRisk } from "./risk-classifier.ts";
import { findUnsupportedReviewerPolicyEntries, selectTrustedReviewerDefinitions } from "./reviewer-definitions.ts";
import { classifyReReviewFindings } from "./re-review.ts";
import { assignStableFindingIds } from "./stable-finding-id.ts";

export interface RunReviewOptions {
  fixture: ReviewFixture;
  now?: Date;
  clock?: () => Date;
  stateStore?: ReviewStateStore;
  traceSink?: TraceSink;
  tracePath?: string;
  runtime?: AgentRuntime;
}

export interface RunReviewResult {
  context: ReviewContext;
  summary: ReviewSummary;
  coordinatorResult?: CoordinatorRunResult;
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

export async function runReviewFromChange(options: RunReviewFromChangeOptions): Promise<RunReviewResult> {
  const fixture = normalizeReviewFixture({
    ...(options.runId !== undefined ? { runId: options.runId } : {}),
    ...(options.safetyMode !== undefined ? { safetyMode: options.safetyMode } : {}),
    ...(options.workingDirectory !== undefined ? { workingDirectory: options.workingDirectory } : {}),
    ...(options.contextDirectory !== undefined ? { contextDirectory: options.contextDirectory } : {}),
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
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
  });
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  const fixture = options.fixture;
  const clock = options.clock ?? (() => new Date());
  const startedAt = options.now ?? clock();
  const timestamp = startedAt.toISOString();
  const runId = fixture.runId ?? createRunId(startedAt);

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
  const risk = fixture.risk ?? classifyRisk({
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

  for (const unsupportedReviewer of findUnsupportedReviewerPolicyEntries({ config: context.config })) {
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
    const summary = classifyReReviewFindings(assignStableFindingIds(runtimeResult.summary), context.priorState);

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
        ...(summary.reReview !== undefined
          ? {
            newFindingCount: summary.reReview.newFindingIds.length,
            recurringFindingCount: summary.reReview.recurringFindingIds.length,
            fixedFindingCount: summary.reReview.fixedFindingIds.length,
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
      ...(runtimeResult.coordinatorResult !== undefined ? { coordinatorResult: runtimeResult.coordinatorResult } : {}),
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
      ...(runtimeResult.coordinatorResult !== undefined ? { coordinatorResult: runtimeResult.coordinatorResult } : {}),
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
    await options.stateStore?.saveRun({
      runId,
      startedAt: timestamp,
      completedAt: failedAtTimestamp,
      context: {
        safetyMode: context.safetyMode,
        metadata: context.metadata,
        risk: context.risk,
      },
      metrics: {
        durationsMs: {
          overallMs,
          contextBuildMs,
          riskAssessmentMs,
        },
      },
      error: serializedError.message,
      errorClassification,
      ...(options.tracePath !== undefined ? { tracePath: options.tracePath } : {}),
    });

    throw error;
  }
}

export function summarizeReview(context: ReviewContext, findings: Finding[]): ReviewSummary {
  const dedupedFindings = deduplicateFindings(findings);
  const highestSeverity = getHighestSeverity(dedupedFindings);
  const hasBlockingFinding = highestSeverity !== undefined && context.config.failOn.includes(highestSeverity);
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
  const subscription: RuntimeEventSubscription = input.runtime.streamEvents(input.context.runId, (event) => {
    runtimeTraceWrites.push(emitTrace(input.traceSink, event));
  });

  try {
    const coordinatorResult = await withOverallTimeout(
      input.runtime.runCoordinator(createCoordinatorRunInput(input.context)),
      input.context.config.timeouts.overallMs,
      input.context.runId,
      () => input.runtime?.cancel(input.context.runId) ?? Promise.resolve(),
    );
    await Promise.all(runtimeTraceWrites);

    return {
      summary: coordinatorResult.summary,
      coordinatorResult,
    };
  } finally {
    subscription.unsubscribe();
  }
}

async function withOverallTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  runId: string,
  onTimeout: () => Promise<void>,
): Promise<T> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Review run timed out after overall timeout ${timeoutMs}ms for ${formatRunIdForError(runId)}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } catch (error) {
    if (timedOut) {
      promise.catch(() => undefined);
      await onTimeout().catch(() => undefined);
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
  coordinatorResult?: CoordinatorRunResult;
}): ReviewRunMetrics {
  const agentMetrics = input.coordinatorResult === undefined ? [] : [
    ...input.coordinatorResult.reviewerResults.flatMap((result) => result.usage === undefined ? [] : [{
      agentRunId: result.agentRunId,
      role: result.role,
      kind: "reviewer" as const,
      usage: result.usage,
      ...(result.attemptCount !== undefined ? { attemptCount: result.attemptCount } : {}),
      ...(result.retryCount !== undefined ? { retryCount: result.retryCount } : {}),
    }]),
    ...(input.coordinatorResult.usage === undefined ? [] : [{
      agentRunId: input.coordinatorResult.agentRunId,
      role: "coordinator",
      kind: "coordinator" as const,
      usage: input.coordinatorResult.usage,
    }]),
  ];

  const failureMetrics = input.coordinatorResult?.reviewerFailures?.map((failure) => ({
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
    ...(agentMetrics.length > 0
      ? {
        agents: agentMetrics,
        tokens: sumTokenUsage(agentMetrics.map((agent) => agent.usage)),
      }
      : {}),
    ...(failureMetrics.length > 0 ? { failures: failureMetrics } : {}),
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
  return {
    runId: context.runId,
    role: "coordinator",
    prompt: "Coordinate deterministic code review reviewers and consolidate their findings.",
    context,
    model: selectModel(context, "coordinator"),
    toolPolicy: createRuntimeToolPolicy(context.safetyMode),
    timeoutMs: context.config.timeouts.coordinatorMs,
    outputSchemaName: "coordinator",
    selectedReviewers: createReviewerRunInputs(context),
  };
}

function createReviewerRunInputs(context: ReviewContext): ReviewerRunInput[] {
  return selectTrustedReviewerDefinitions({ config: context.config, risk: context.risk })
    .map((reviewerDefinition) => ({
      runId: context.runId,
      role: reviewerDefinition.role,
      prompt: `Review the change as the ${reviewerDefinition.role} reviewer.`,
      context,
      model: selectModel(context, reviewerDefinition.role),
      toolPolicy: createRuntimeToolPolicy(context.safetyMode),
      timeoutMs: context.config.timeouts.reviewerMs,
      outputSchemaName: "reviewer",
      assignedFiles: context.diff.files.map((file) => file.path),
      reviewerDefinition,
    }));
}

export function selectModel(context: ReviewContext, role: string): ModelSelection {
  return context.config.modelRouting.roles[role] ?? context.config.modelRouting.default;
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

export function createRuntimeToolPolicy(safetyMode: SafetyMode): RuntimeToolPolicy {
  if (safetyMode === "privileged_metadata_only") {
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

function chooseDecision(findings: Finding[], highestSeverity: Severity | undefined): ReviewDecision {
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
      const location = finding.location?.path !== undefined
        ? ` (${finding.location.path}${finding.location.line !== undefined ? `:${finding.location.line}` : ""})`
        : "";
      lines.push(`- [${finding.severity}] ${finding.title}${location}`);
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

export function createRunId(now: Date): string {
  return `local-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
}
