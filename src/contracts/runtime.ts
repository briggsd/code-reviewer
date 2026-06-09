import type {
  AgentRole,
  JsonValue,
  ModelSelection,
  Severity,
  TokenUsage,
  TraceEventType,
} from "./common.ts";
import type { Finding, ReviewContext, ReviewSummary } from "./review.ts";
import type { ReviewErrorClassification } from "./common.ts";

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

export interface ReviewerRunInput extends AgentRunInput {
  role: Exclude<AgentRole, "coordinator"> | string;
  assignedFiles?: string[];
  reviewerDefinition: ReviewerDefinition;
}

export interface CoordinatorRunInput extends AgentRunInput {
  role: "coordinator";
  selectedReviewers: ReviewerRunInput[];
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
  attemptCount?: number;
  retryCount?: number;
  tracePath?: string;
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
}

export interface CoordinatorRunResult {
  runId: string;
  agentRunId: string;
  summary: ReviewSummary;
  reviewerResults: ReviewerRunResult[];
  reviewerFailures?: ReviewerRunFailure[];
  rawOutput?: string;
  usage?: TokenUsage;
  tracePath?: string;
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
