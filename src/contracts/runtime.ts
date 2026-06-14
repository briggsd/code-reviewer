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

/**
 * Within-run, in-memory provider health tracker for cross-provider failback (#137 S04).
 *
 * WITHIN-RUN ONLY: this breaker is in-memory and resets between CI runs. A flapping provider
 * rediscovers failback every PR — there is no cross-run durable memory, no half-open/cooldown
 * probe, and no circuit-breaker state file. This is deliberate: the runner is a short-lived CI
 * process. Cross-run persistence and half-open probing are explicitly deferred.
 */
export interface ProviderHealthRegistry {
  /**
   * Synchronous + atomic: record this failed attempt, then — if the failure is failback-eligible
   * — return the next non-degraded model in the chain to try. Returns no `next` and
   * `exhausted: false` for non-failback-eligible classifications (caller retries same model as
   * today). Returns `exhausted: true, next: undefined` when the chain is drained.
   * `hopCount` is the number of positions advanced (0 when no hop).
   */
  recordFailureAndSelectNext(input: {
    failed: ModelSelection;
    classification: ReviewErrorClassification;
    chain: readonly ModelSelection[];
  }): { next?: ModelSelection; exhausted: boolean; hopCount: number };

  /**
   * Synchronous read used at attempt START to skip already-degraded providers in the chain.
   * Returns the first non-degraded provider in the chain, or `undefined` if the chain is empty.
   */
  selectStart(chain: readonly ModelSelection[]): ModelSelection | undefined;
}

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
  /** Pi only (#137): ordered failback chain (operator-disabled filtered, deduped) for this reviewer. When present with `providerHealth`, enables cross-provider failback in the retry loop. */
  failbackChain?: readonly ModelSelection[];
  /** Pi only (#137): shared per-run provider health registry. Passed alongside `failbackChain` to keep the check-then-act atomic. Constructed once per run in the runner and shared across coordinator+reviewers. */
  providerHealth?: ProviderHealthRegistry;
}

export interface CoordinatorRunInput extends AgentRunInput {
  role: "coordinator";
  selectedReviewers: ReviewerRunInput[];
  shortCircuitOnZeroFindings?: boolean;
  /** Pi only (#137): ordered failback chain for the coordinator. */
  failbackChain?: readonly ModelSelection[];
  /** Pi only (#137): shared per-run provider health registry. */
  providerHealth?: ProviderHealthRegistry;
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
  /** Pi only (#137): provider that ultimately succeeded after any failback hops. Counts-only; never contains diff/finding text. */
  effectiveProvider?: string;
  /** Pi only (#137): number of cross-provider failback hops taken before a successful attempt. 0 when no failback occurred. */
  failbackHopCount?: number;
  /** Pi only (#137): ordered list of provider+model pairs attempted (including the initial attempt and any failback hops). Identifiers only (M008). */
  attemptedModels?: ReadonlyArray<{ provider: string; model: string }>;
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
  /** Pi only (#137): true when all providers in the failback chain were exhausted — the reviewer failed even after attempting every available provider. */
  failbackExhausted?: boolean;
  /** Pi only (#137): number of cross-provider failback hops taken before the final failure. */
  failbackHopCount?: number;
  /** Pi only (#137): ordered list of provider+model pairs attempted before final failure. Identifiers only (M008). */
  attemptedModels?: ReadonlyArray<{ provider: string; model: string }>;
  /** Pi only (#137): the last provider attempted before failure. */
  effectiveProvider?: string;
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
