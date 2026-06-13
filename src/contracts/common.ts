export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type ProviderKind = "github" | "gitlab" | "local";

export type SafetyMode =
  | "trusted"
  | "untrusted_read_only"
  | "privileged_metadata_only"
  | "manual_privileged";

export type ReviewMode = "advisory" | "blocking";

export type ReviewDecision =
  | "approved"
  | "approved_with_comments"
  | "minor_issues"
  | "significant_concerns"
  | "review_failed";

export type CiOutcome = "pass" | "fail" | "neutral" | "skipped";

export type Severity = "critical" | "warning" | "suggestion";

export type Confidence = "high" | "medium" | "low";

export type FindingSide = "LEFT" | "RIGHT";

export type RiskTier = "trivial" | "lite" | "full";

export type AgentRole =
  | "coordinator"
  | "code_quality"
  | "security"
  | "documentation"
  | "performance"
  | "release"
  | "custom";

export type TraceEventType =
  | "review.started"
  | "context.built"
  | "conventions.resolved"
  | "risk.assessed"
  | "agent.started"
  | "agent.output"
  | "agent.skipped"
  | "agent.failed"
  | "agent.completed"
  | "coordinator.completed"
  | "grounding.applied"
  | "location.backfill.applied"
  | "acknowledgements.applied"
  | "publisher.completed"
  | "review.timeout"
  | "review.failed"
  | "review.completed"
  | "review.thin_detected"
  | "review.incremental";

export interface RepositoryRef {
  provider: ProviderKind;
  owner?: string;
  name: string;
  slug: string;
  webUrl?: string;
  defaultBranch?: string;
}

export interface ActorRef {
  id?: string;
  username: string;
  displayName?: string;
  webUrl?: string;
}

// Pi reasoning-effort levels (`pi --thinking <level>`). Bounding this is the
// primary lever against full-tier reviewer non-convergence (#45): at Pi's default
// level a reviewer can spend its whole per-reviewer budget deliberating over a
// large diff without ever emitting findings. Lower levels force earlier commitment.
//
// Single source of truth for the level set: the config JSON schema derives its enum
// from this array (src/schemas/review-config.ts), so the TS type and the runtime
// validator cannot drift.
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelSelection {
  provider: string;
  model: string;
  tier?: "top" | "standard" | "light";
  temperature?: number;
  maxOutputTokens?: number;
  // Reasoning-effort bound for this role's agent. A task property, not part of the
  // model identity: it is preserved even when the concrete provider/model is swapped
  // for the runtime's default model (see PiAgentRuntime.modelArgs).
  thinking?: ThinkingLevel;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCostUsd?: number;
}

export type AgentPromptContextMode = "path_references" | "inline_fallback";

export interface AgentPromptMetrics {
  contextMode: AgentPromptContextMode;
  promptBytes: number;
  contextPayloadBytes: number;
  inlineDiffBytes: number;
  estimatedInputTokensSaved: number;
}

export type ReviewErrorCategory =
  | "retryable_transient"
  | "rate_limited"
  | "auth"
  | "context_overflow"
  | "schema_invalid"
  | "provider_error"
  | "timeout"
  | "truncated"
  | "unsafe_fork"
  | "unknown";

export interface ReviewErrorClassification {
  category: ReviewErrorCategory;
  retryable: boolean;
  reason: string;
}

export interface TimeoutPolicy {
  reviewerMs: number;
  coordinatorMs: number;
  overallMs: number;
}
