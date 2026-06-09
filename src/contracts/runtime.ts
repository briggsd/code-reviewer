import type {
  AgentRole,
  JsonValue,
  ModelSelection,
  TokenUsage,
  TraceEventType,
} from "./common.ts";
import type { Finding, ReviewContext, ReviewSummary } from "./review.ts";

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

export interface ReviewerRunInput extends AgentRunInput {
  role: Exclude<AgentRole, "coordinator"> | string;
  assignedFiles?: string[];
  domainInstructions: string;
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
  tracePath?: string;
}

export interface CoordinatorRunResult {
  runId: string;
  agentRunId: string;
  summary: ReviewSummary;
  reviewerResults: ReviewerRunResult[];
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
