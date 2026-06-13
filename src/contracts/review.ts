import type {
  ActorRef,
  AgentPromptMetrics,
  AgentRole,
  CiOutcome,
  Confidence,
  FindingSide,
  GateDecision,
  JsonValue,
  ModelSelection,
  ProviderKind,
  RepositoryRef,
  ReviewDecision,
  ReviewErrorClassification,
  ReviewMode,
  RiskTier,
  SafetyMode,
  Severity,
  TimeoutPolicy,
  TokenUsage,
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

export type ChangedFileStatus =
  | "added"
  | "modified"
  | "renamed"
  | "deleted"
  | "copied"
  | "unchanged";

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

/** Files changed between two SHAs, for incremental re-review (#46). */
export interface ChangedPathsSince {
  /** Repo-relative paths changed between sinceSha and the change head. */
  changedPaths: string[];
  /** True only when sinceSha is a strict ancestor of head (clean fast-forward; not a force-push/rebase). */
  isAncestor: boolean;
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

export interface Acknowledgement {
  path: string; // glob, required
  category?: string;
  stableFindingId?: string;
  mode: "acknowledge" | "suppress"; // acknowledge = downgrade+annotate; suppress = hide
  reason: string;
  expires?: string; // ISO date (YYYY-MM-DD); a past date deactivates the entry
}

export interface ReviewConfig {
  mode: ReviewMode;
  failOn: Severity[];
  sensitivePaths: string[];
  ignoredPaths: string[];
  reviewerPolicy: Record<string, "enabled" | "disabled" | "full_only">;
  timeouts: TimeoutPolicy;
  modelRouting: ModelRoutingConfig;
  conventions?: string[];
  // Project-supplied policy text for the compliance reviewer. Reviewed-repo content: untrusted,
  // data-only. Read from the BASE branch (never PR head) and quoted as untrusted data in the
  // compliance reviewer prompt; it never becomes trusted runtime config (#23).
  compliancePolicy?: string[];
  acknowledgements?: Acknowledgement[];
  extra: Record<string, JsonValue>;
}

export interface ReviewContextArtifacts {
  changeContextPath: string;
  patchDirectory: string;
  patchFileCount: number;
  changeContextBytes: number;
  patchBytes: number;
  totalBytes: number;
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
  contextArtifacts?: ReviewContextArtifacts;
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
  /**
   * The exact changed line(s) the finding flags, copied verbatim from the diff.
   * Optional; present only for line-specific findings; omit for absence/architectural
   * findings. Reserved for the #54.2 grounding slice (which will deterministically verify
   * it against the diff); no grounding/verification is performed in this version.
   */
  quotedCode?: string[];
  /** Set when a base-branch acknowledgement matched this finding (#60-P3). Acknowledged findings
   *  are surfaced + annotated but excluded from the CI gate; they are never hidden. */
  acknowledged?: { reason: string };
  recommendation: string;
}

export type ReReviewFindingStatus =
  | "new"
  | "recurring"
  | "fixed"
  | "withheld"
  // Incremental re-review only: a prior finding on a file NOT in this push's delta
  // (or whose path is unknown). It was not re-evaluated, so it cannot be called
  // "fixed" — it is carried forward as still-open. See docs/re-review-state.md.
  | "carried_forward";

export interface ReReviewFindingClassification {
  stableId: string;
  status: ReReviewFindingStatus;
  finding?: Finding;
  priorFinding?: Finding;
  lastSeenHeadSha?: string;
}

export interface ReReviewSummary {
  newFindingIds: string[];
  recurringFindingIds: string[];
  fixedFindingIds: string[];
  withheldFindingIds: string[];
  /**
   * Prior findings carried forward unverified in an incremental re-review (their
   * file was not in the delta since previousHeadSha). Empty in a full review.
   */
  carriedForwardFindingIds: string[];
  classifications: ReReviewFindingClassification[];
}

export interface ReviewSummary {
  decision: ReviewDecision;
  outcome: CiOutcome;
  title: string;
  body: string;
  findings: Finding[];
  risk: RiskAssessment;
  reReview?: ReReviewSummary;
  /**
   * Comprehension-gate verdict (#26): set only when the opt-in `comprehension` reviewer ran.
   * Observability/rendering only — the CI gate stays driven by `decideCiOutcome` over findings.
   */
  gateDecision?: GateDecision;
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

export interface ReviewRunDurations {
  overallMs: number;
  contextBuildMs?: number;
  riskAssessmentMs?: number;
  coordinatorMs?: number;
  publishMs?: number;
  fetchMs?: number;
}

export interface ReviewRunAgentMetrics {
  agentRunId: string;
  role: AgentRole | string;
  kind: "reviewer" | "coordinator";
  usage: TokenUsage;
  prompt?: AgentPromptMetrics;
  attemptCount?: number;
  retryCount?: number;
}

export interface ReviewRunTokenMetrics extends TokenUsage {
  agentCount: number;
}

export interface ReviewRunAgentFailureMetrics {
  agentRunId: string;
  role: AgentRole | string;
  kind: "reviewer" | "coordinator";
  errorName: string;
  errorClassification: ReviewErrorClassification;
  durationMs?: number;
  attemptCount?: number;
  retryCount?: number;
}

export interface ReviewRunContextMetrics {
  artifactBytes: number;
  changeContextBytes: number;
  patchBytes: number;
  patchFileCount: number;
}

export interface ReviewRunMetrics {
  durationsMs: ReviewRunDurations;
  context?: ReviewRunContextMetrics;
  tokens?: ReviewRunTokenMetrics;
  agents?: ReviewRunAgentMetrics[];
  failures?: ReviewRunAgentFailureMetrics[];
}

export interface ReviewRunRecord {
  runId: string;
  startedAt: string;
  completedAt?: string;
  context: Pick<ReviewContext, "safetyMode" | "metadata" | "risk">;
  summary?: ReviewSummary;
  metrics?: ReviewRunMetrics;
  tracePath?: string;
  error?: string;
  errorClassification?: ReviewErrorClassification;
}
