import type {
  ActorRef,
  AgentRole,
  CiOutcome,
  Confidence,
  FindingSide,
  JsonValue,
  ProviderKind,
  RepositoryRef,
  ReviewDecision,
  ReviewMode,
  RiskTier,
  SafetyMode,
  Severity,
  TimeoutPolicy,
  ModelSelection,
} from "./common.ts";

export interface ChangeRef {
  provider: ProviderKind;
  repository: RepositoryRef;
  changeId: string;
  headSha: string;
  baseSha?: string;
  sourceBranch?: string;
  targetBranch?: string;
}

export interface ChangeMetadata extends ChangeRef {
  title: string;
  description?: string;
  author: ActorRef;
  labels: string[];
  webUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ChangedFileStatus = "added" | "modified" | "renamed" | "deleted" | "copied" | "unchanged";

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  isGenerated?: boolean;
  isVendored?: boolean;
  isLockfile?: boolean;
  patch?: string;
  patchPath?: string;
}

export interface DiffSummary {
  files: ChangedFile[];
  totalAdditions: number;
  totalDeletions: number;
  truncated: boolean;
  truncationReason?: string;
}

export interface RiskAssessment {
  tier: RiskTier;
  reason: string;
  matchedRules: string[];
  sensitivePaths: string[];
  reviewedFileCount: number;
  ignoredFileCount: number;
}

export interface ModelRoutingConfig {
  default: ModelSelection;
  roles: Record<string, ModelSelection>;
}

export interface ReviewConfig {
  mode: ReviewMode;
  failOn: Severity[];
  sensitivePaths: string[];
  ignoredPaths: string[];
  reviewerPolicy: Record<string, "enabled" | "disabled" | "full_only">;
  timeouts: TimeoutPolicy;
  modelRouting: ModelRoutingConfig;
  projectInstructionsPath?: string;
  extra: Record<string, JsonValue>;
}

export interface ReviewContext {
  runId: string;
  safetyMode: SafetyMode;
  workingDirectory: string;
  contextDirectory: string;
  metadata: ChangeMetadata;
  diff: DiffSummary;
  risk: RiskAssessment;
  config: ReviewConfig;
  priorState?: PriorReviewState;
}

export interface FindingLocation {
  path: string;
  line?: number;
  startLine?: number;
  endLine?: number;
  side?: FindingSide;
}

export interface Finding {
  id?: string;
  reviewer: AgentRole | string;
  severity: Severity;
  category: string;
  title: string;
  body: string;
  location?: FindingLocation;
  confidence: Confidence;
  evidence: string[];
  recommendation: string;
}

export interface ReviewSummary {
  decision: ReviewDecision;
  outcome: CiOutcome;
  title: string;
  body: string;
  findings: Finding[];
  risk: RiskAssessment;
}

export interface PriorFindingState {
  stableId: string;
  finding: Finding;
  vcsThreadId?: string;
  vcsCommentId?: string;
  status: "open" | "resolved" | "acknowledged" | "disputed";
  lastSeenHeadSha: string;
}

export interface PriorReviewState {
  previousRunId?: string;
  previousHeadSha?: string;
  findings: PriorFindingState[];
  hiddenMetadata?: Record<string, JsonValue>;
}

export interface ReviewRunRecord {
  runId: string;
  startedAt: string;
  completedAt?: string;
  context: Pick<ReviewContext, "safetyMode" | "metadata" | "risk">;
  summary?: ReviewSummary;
  tracePath?: string;
  error?: string;
}
