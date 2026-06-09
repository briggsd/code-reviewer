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
  ReviewStateStore,
  ReviewSummary,
  RuntimeEvent,
  RuntimeEventSubscription,
  RuntimeToolPolicy,
  SafetyMode,
  Severity,
  TraceSink,
} from "../contracts/index.ts";
import { filterDiff } from "./diff-filter.ts";
import { normalizeReviewFixture, type ReviewFixture } from "./fixture.ts";
import { classifyRisk } from "./risk-classifier.ts";
import { classifyReReviewFindings } from "./re-review.ts";
import { assignStableFindingIds } from "./stable-finding-id.ts";

export interface RunReviewOptions {
  fixture: ReviewFixture;
  now?: Date;
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
    ...(options.stateStore !== undefined ? { stateStore: options.stateStore } : {}),
    ...(options.traceSink !== undefined ? { traceSink: options.traceSink } : {}),
    ...(options.tracePath !== undefined ? { tracePath: options.tracePath } : {}),
    ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
  });
}

export async function runReview(options: RunReviewOptions): Promise<RunReviewResult> {
  const fixture = options.fixture;
  const now = options.now ?? new Date();
  const timestamp = now.toISOString();
  const runId = fixture.runId ?? createRunId(now);

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

  const filtered = filterDiff(fixture.diff, fixture.config);
  const risk = fixture.risk ?? classifyRisk({
    diff: filtered.diff,
    config: fixture.config,
    ignoredFileCount: filtered.ignoredFiles.length,
  });

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

  await emitTrace(options.traceSink, {
    type: "context.built",
    runId,
    timestamp,
    data: {
      contextDirectory: context.contextDirectory,
      fileCount: context.diff.files.length,
      totalAdditions: context.diff.totalAdditions,
      totalDeletions: context.diff.totalDeletions,
      priorFindingCount: context.priorState?.findings.length ?? 0,
    },
  });

  await emitTrace(options.traceSink, {
    type: "risk.assessed",
    runId,
    timestamp,
    data: {
      tier: risk.tier,
      reason: risk.reason,
      reviewedFileCount: risk.reviewedFileCount,
      ignoredFileCount: risk.ignoredFileCount,
      matchedRules: risk.matchedRules,
      sensitivePaths: risk.sensitivePaths,
    },
  });

  try {
    const runtimeResult = await runAgents({
      runtime: options.runtime,
      context,
      traceSink: options.traceSink,
      fakeFindings: fixture.fakeFindings ?? [],
    });
    const summary = classifyReReviewFindings(assignStableFindingIds(runtimeResult.summary), context.priorState);

    await emitTrace(options.traceSink, {
      type: "coordinator.completed",
      runId,
      role: "coordinator",
      timestamp,
      data: {
        decision: summary.decision,
        outcome: summary.outcome,
        findingCount: summary.findings.length,
        ...(summary.reReview !== undefined
          ? {
            newFindingCount: summary.reReview.newFindingIds.length,
            recurringFindingCount: summary.reReview.recurringFindingIds.length,
            fixedFindingCount: summary.reReview.fixedFindingIds.length,
          }
          : {}),
      },
    });

    const completedAt = new Date(now.getTime()).toISOString();
    await options.stateStore?.saveRun({
      runId,
      startedAt: timestamp,
      completedAt,
      context: {
        safetyMode: context.safetyMode,
        metadata: context.metadata,
        risk: context.risk,
      },
      summary,
      ...(options.tracePath !== undefined ? { tracePath: options.tracePath } : {}),
    });
    await options.stateStore?.saveSummary(runId, summary);

    await emitTrace(options.traceSink, {
      type: "review.completed",
      runId,
      timestamp: completedAt,
      data: {
        decision: summary.decision,
        outcome: summary.outcome,
      },
    });

    return {
      context,
      summary,
      ...(runtimeResult.coordinatorResult !== undefined ? { coordinatorResult: runtimeResult.coordinatorResult } : {}),
    };
  } catch (error) {
    const failedAt = new Date(now.getTime()).toISOString();
    const serializedError = serializeError(error);
    await emitTrace(options.traceSink, {
      type: "review.failed",
      runId,
      timestamp: failedAt,
      message: serializedError.message,
      data: {
        phase: "agent_runtime",
        errorName: serializedError.name,
        errorMessage: serializedError.message,
        ...(serializedError.stack !== undefined ? { errorStack: serializedError.stack } : {}),
      },
    });
    await options.stateStore?.saveRun({
      runId,
      startedAt: timestamp,
      completedAt: failedAt,
      context: {
        safetyMode: context.safetyMode,
        metadata: context.metadata,
        risk: context.risk,
      },
      error: serializedError.message,
      ...(options.tracePath !== undefined ? { tracePath: options.tracePath } : {}),
    });

    throw error;
  }
}

export function summarizeReview(context: ReviewContext, findings: Finding[]): ReviewSummary {
  const highestSeverity = getHighestSeverity(findings);
  const hasBlockingFinding = highestSeverity !== undefined && context.config.failOn.includes(highestSeverity);
  const decision = chooseDecision(findings, highestSeverity);
  const outcome = context.config.mode === "blocking" && hasBlockingFinding ? "fail" : "pass";

  return {
    decision,
    outcome,
    title: createSummaryTitle(decision, findings),
    body: createSummaryBody(context, findings),
    findings,
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
    const coordinatorResult = await input.runtime.runCoordinator(createCoordinatorRunInput(input.context));
    await Promise.all(runtimeTraceWrites);

    return {
      summary: coordinatorResult.summary,
      coordinatorResult,
    };
  } finally {
    subscription.unsubscribe();
  }
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
  return Object.entries(context.config.reviewerPolicy)
    .filter(([, policy]) => policy === "enabled" || (policy === "full_only" && context.risk.tier === "full"))
    .map(([role]) => ({
      runId: context.runId,
      role,
      prompt: `Review the change as the ${role} reviewer.`,
      context,
      model: selectModel(context, role),
      toolPolicy: createRuntimeToolPolicy(context.safetyMode),
      timeoutMs: context.config.timeouts.reviewerMs,
      outputSchemaName: "reviewer",
      assignedFiles: context.diff.files.map((file) => file.path),
      domainInstructions: `Return only concrete ${role} findings for the filtered diff.`,
    }));
}

export function selectModel(context: ReviewContext, role: string): ModelSelection {
  return context.config.modelRouting.roles[role] ?? context.config.modelRouting.default;
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
    return "minor_issues";
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
