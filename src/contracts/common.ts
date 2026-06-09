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
  | "risk.assessed"
  | "agent.started"
  | "agent.output"
  | "agent.failed"
  | "agent.completed"
  | "coordinator.completed"
  | "publisher.completed"
  | "review.completed";

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

export interface ModelSelection {
  provider: string;
  model: string;
  tier?: "top" | "standard" | "light";
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TimeoutPolicy {
  reviewerMs: number;
  coordinatorMs: number;
  overallMs: number;
}
