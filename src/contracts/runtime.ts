import type {
  AgentPromptMetrics,
  AgentRole,
  JsonValue,
  ModelSelection,
  ReviewErrorClassification,
  Severity,
  TokenUsage,
  TraceEventType,
} from "./common.ts";
import type { ChangedFile, Finding, ReviewContext, ReviewSummary } from "./review.ts";

export interface RuntimeToolPolicy {
  allowRead: boolean;
  allowWrite: boolean;
  allowShell: boolean;
  allowedTools: string[];
  deniedTools: string[];
}

export interface AgentRunInput {
  runId: string;
  role: AgentRole | string;
  prompt: string;
  context: ReviewContext;
  model: ModelSelection;
  toolPolicy: RuntimeToolPolicy;
  timeoutMs: number;
  outputSchemaName: string;
}

export interface ReviewerDefinition {
  role: Exclude<AgentRole, "coordinator"> | string;
  displayName: string;
  source: "trusted_operator";
  version: string;
  summary: string;
  guidance: {
    sharedMandatoryRules: string[];
    flag: string[];
    doNotFlag: string[];
    allowedSeverities: Severity[];
    severityCalibration: string[];
    outputExpectations: string[];
  };
}

export type ReviewerContextReferenceFile = Omit<ChangedFile, "patch">;

export interface ReviewerContextReferences {
  changeContextPath?: string;
  patchDirectory?: string;
  files: ReviewerContextReferenceFile[];
}

export interface ReviewerRunInput extends AgentRunInput {
  role: Exclude<AgentRole, "coordinator"> | string;
  assignedFiles?: string[];
  contextReferences: ReviewerContextReferences;
  reviewerDefinition: ReviewerDefinition;
}

export interface CoordinatorRunInput extends AgentRunInput {
  role: "coordinator";
  selectedReviewers: ReviewerRunInput[];
  shortCircuitOnZeroFindings?: boolean;
}

export type { TokenUsage } from "./common.ts";

export interface RuntimeEvent {
  type: TraceEventType | "runtime.event";
  runId: string;
  agentRunId?: string;
  role?: AgentRole | string;
  timestamp: string;
  message?: string;
  data?: Record<string, JsonValue>;
}

export interface ReviewerRunResult {
  runId: string;
  agentRunId: string;
  role: AgentRole | string;
  findings: Finding[];
  rawOutput?: string;
  usage?: TokenUsage;
  promptMetrics?: AgentPromptMetrics;
  attemptCount?: number;
  retryCount?: number;
  tracePath?: string;
  /** Pi only: true when output came via the structured tool, false via the prose fallback (M015 S05, #128). */
  structuredOutput?: boolean;
  /** Pi only (#189): the model the agent actually executed on — resolved AFTER the #45 dummy→defaultModel swap. Undefined for runtimes that resolve no real model (dummy) or a degenerate setup with no model at all. */
  effectiveModel?: string;
  /** Wall-clock ms of this reviewer's full runReviewer invocation incl. retries (#196). Pi only. */
  durationMs?: number;
}

export interface ReviewerRunFailure {
  runId: string;
  agentRunId: string;
  role: AgentRole | string;
  errorName: string;
  errorMessage: string;
  errorClassification: ReviewErrorClassification;
  durationMs?: number;
  attemptCount?: number;
  retryCount?: number;
  /** Pi only (#189): the model this reviewer was invoked on before it failed (resolved like ReviewerRunResult.effectiveModel). A failed invocation still consumed a real model, so it must count toward per-model cost/error-rate attribution. */
  effectiveModel?: string;
}

export interface CoordinatorRunResult {
  runId: string;
  agentRunId: string;
  summary: ReviewSummary;
  reviewerResults: ReviewerRunResult[];
  reviewerFailures?: ReviewerRunFailure[];
  partial?: {
    reason: "overall_timeout" | "all_reviewers_failed";
  };
  coordinatorShortCircuited?: boolean;
  rawOutput?: string;
  usage?: TokenUsage;
  tracePath?: string;
  /** Pi only: true when output came via the structured tool, false via the prose fallback (M015 S05, #128). */
  structuredOutput?: boolean;
  /** Pi only (#189): the model the agent actually executed on — resolved AFTER the #45 dummy→defaultModel swap. Undefined for runtimes that resolve no real model (dummy) or a degenerate setup with no model at all. */
  effectiveModel?: string;
  /** Fan-out span ms: first reviewer dispatched → all reviewers settled (#196). Pi only. */
  fanOutMs?: number;
  /** Coordinator fusion ms: the post-fan-out synthesis LLM call; undefined when no synthesis ran (short-circuit / all-failed) (#196). Pi only. */
  fusionMs?: number;
}

export interface RuntimeEventSubscription {
  unsubscribe(): void;
}

export interface AgentRuntime {
  readonly name: string;

  runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult>;

  runReviewer(input: ReviewerRunInput): Promise<ReviewerRunResult>;

  streamEvents(runId: string, onEvent: (event: RuntimeEvent) => void): RuntimeEventSubscription;

  cancel(runId: string): Promise<void>;
}
