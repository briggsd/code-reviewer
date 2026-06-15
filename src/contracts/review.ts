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
import type { ReviewerDefinition } from "./runtime.ts";

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

/** Per-tier routing override for a single risk tier (#138). */
export interface ModelTierRouting {
  default?: ModelSelection;
  roles?: Record<string, ModelSelection>;
}

export interface ModelRoutingConfig {
  default: ModelSelection;
  roles: Record<string, ModelSelection>;
  /** Per-risk-tier overrides (#138). Looked up before role/default in selectModel; a tier omitted
   *  here inherits the top-level roles/default. Same trust level as `roles` (config-sourced). */
  byTier?: Partial<Record<RiskTier, ModelTierRouting>>;
}

export interface Acknowledgement {
  path: string; // glob, required
  category?: string;
  stableFindingId?: string;
  mode: "acknowledge" | "suppress"; // acknowledge = downgrade+annotate; suppress = hide
  /** Disposition outcome of this acknowledgement (#256, M023 S04).
   *  dismissed = human explicitly rejected the finding (wrong/won't-fix).
   *  acknowledged = accepted-as-is (default when absent).
   *  Orthogonal to `mode` (visibility); governs outcome only. */
  verdict?: "dismissed" | "acknowledged";
  reason: string;
  expires?: string; // ISO date (YYYY-MM-DD); a past date deactivates the entry
}

export interface ReviewConfig {
  mode: ReviewMode;
  failOn: Severity[];
  sensitivePaths: string[];
  ignoredPaths: string[];
  // Content markers (e.g. `// @generated`, `/* eslint-disable */`) that flag a generated file by
  // its patch head, complementing path-glob detection (#24). Matched case-insensitively against the
  // leading bytes of each file's patch, AFTER the sensitive-path short-circuit so sensitive files are
  // never dropped. Project-overridable (REPLACES the default set — some projects hand-edit
  // eslint-disabled files and want them reviewed). Default covers the two common markers.
  generatedFileMarkers?: string[];
  reviewerPolicy: Record<string, "enabled" | "disabled" | "full_only">;
  timeouts: TimeoutPolicy;
  modelRouting: ModelRoutingConfig;
  conventions?: string[];
  // Project-supplied policy text for the compliance reviewer. Reviewed-repo content: untrusted,
  // data-only. Read from the BASE branch (never PR head) and quoted as untrusted data in the
  // compliance reviewer prompt; it never becomes trusted runtime config (#23).
  compliancePolicy?: string[];
  acknowledgements?: Acknowledgement[];
  /**
   * Per-tier patch byte budgets (#145). Absent ⇒ tier-profile defaults are used. An adopter can
   * lower or raise the budget for a specific tier. The admission gate demotes files gracefully
   * (name+stat only) rather than hard-failing when the budget is exceeded.
   */
  patchBudgets?: {
    trivial?: number;
    lite?: number;
    full?: number;
  };
  extra: Record<string, JsonValue>;
}

export interface ReviewContextArtifacts {
  changeContextPath: string;
  patchDirectory: string;
  patchFileCount: number;
  changeContextBytes: number;
  patchBytes: number;
  totalBytes: number;
  /** Counts-only patch admission summary (#145). */
  admission: {
    budgetBytes: number;
    originalBytes: number;
    admittedBytes: number;
    admittedFileCount: number;
    demotedFileCount: number;
    degraded: boolean;
  };
  /** Number of deletion-only hunks pruned across all modified files (#144). */
  deletionHunksPruned: number;
  /** Number of fully-deleted file patch bodies suppressed (#144). */
  deletedFileBodiesPruned: number;
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
  /**
   * The reviewer definitions in effect for this run (M017 S03, #143). When absent, the runner
   * falls back to the factory's TRUSTED_REVIEWER_DEFINITIONS. When an operator loads custom
   * reviewers via `--reviewers <path>`, this carries the **merged** set (merge-by-role,
   * operator-wins, or operator-only in full-replace mode). `reviewerPolicy` still independently
   * gates which of these roles run at the current tier.
   */
  reviewerDefinitions?: readonly ReviewerDefinition[];
  /**
   * Providers the trusted operator has disabled for this run (#138) — sourced from the
   * AI_REVIEW_DISABLED_PROVIDERS env var via RunReviewOptions, NEVER from reviewed-repo
   * `.ai-review.json`. selectModel skips candidate models whose provider is in this set.
   */
  disabledProviders?: readonly string[];
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
   *  are surfaced + annotated but excluded from the CI gate; they are never hidden.
   *  `verdict` (when present) mirrors the ack's verdict field (#256, M023 S04) — used by
   *  `deriveDisposition` to distinguish dismissed vs acknowledged outcomes. */
  acknowledged?: { reason: string; verdict?: "dismissed" | "acknowledged" };
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
  /**
   * Low-confidence findings kept and shown but excluded from the CI gate, title count, and
   * `findingIds` (#204, #207). These are findings whose cited code was not found in the diff
   * hunks — down-weighted to `confidence: "low"` and rendered in a separate labeled block
   * (non-blocking). No finding is ever silently dropped; not-grounded-with-quote findings are
   * demoted, not discarded. Full-file-corpus promotion (reinstating blocking eligibility) is
   * tracked in #214.
   */
  groundingWithheld?: Finding[];
  /**
   * Set when the diff exceeded the per-tier patch byte budget and some files were reviewed by
   * name+stat only (#145). The run degrades gracefully — it is NOT a hard failure. Counts and
   * identifiers only (M008 compliance); no patch content. `droppedPaths` is for rendering and
   * is bounded by the publisher (first 20, with "…and N more").
   */
  partialBySize?: {
    admittedFileCount: number;
    droppedFileCount: number;
    originalBytes: number;
    admittedBytes: number;
    budgetBytes: number;
    droppedPaths: string[];
  };
  /**
   * Set when one or more reviewers FAILED in a COMPLETING run (#212) — surviving findings are
   * published, but the review is degraded, not clean. Counts/roles only (M008): no finding/
   * diff/prompt text. Distinct from `review_failed` (whole-run failure) and `partialBySize`
   * (diff exceeded the byte budget). Rendered as a degraded banner and factored into the CI
   * decision when a majority of attempted reviewers failed.
   */
  degraded?: {
    failedReviewerCount: number;
    completedReviewerCount: number;
    /** Failed reviewer roles, de-duplicated and sorted (counts/identifiers only). */
    failedRoles: string[];
  };
  /** Run-level stats for the comment footer + low-activity warning (#285). Optional — absent on
   *  fixtures / degraded paths; the renderer degrades gracefully. The PR comment is human-facing
   *  content, so this is allowed here (M008 counts-only governs telemetry/egress, not the comment). */
  runStats?: {
    durationMs: number; // review wall-clock (fan-out + fusion), NOT incl. publish
    modelTokenTotal: number; // sum of (input + output) model tokens across all agents — the "did it run" signal
    reviewerCount: number; // reviewers that completed this run (distinct roles, not raw invocation count)
    tier: string; // risk tier (so the warning can respect the #65 trivial fast-path)
  };
  /** Cross-round resolved-finding history (#279, M026 S02). Accumulated across re-review rounds
   *  and persisted in the comment's hidden metadata (schemaVersion 6+). Optional — absent on first
   *  review / fixture paths. Comment content (not counts-only-egress); titles route through
   *  escapeMarkdown. */
  resolvedLog?: Array<{ stableId: string; title: string; resolvedAtSha: string }>;
  /**
   * Display-only truncation flag: true when the resolved-log was capped (merged set exceeded 50
   * entries before slicing). Drives the "…older resolved findings omitted" note in the rendered
   * summary comment. NOT persisted in hidden metadata (recomputed from the log each round).
   */
  resolvedLogTruncated?: boolean;
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
  fanOutMs?: number;
  fusionMs?: number;
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
  effectiveModel?: string;
  durationMs?: number;
  /** Pi only (#137): number of cross-provider failback hops taken before a successful attempt. */
  failbackHopCount?: number;
  /** Pi only (#137): ordered provider+model pairs attempted (including any failback hops). Identifiers only (M008). */
  attemptedModels?: ReadonlyArray<{ provider: string; model: string }>;
  /** Pi only (#137): provider that ultimately succeeded after any failback hops. */
  effectiveProvider?: string;
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
  /** Pi only (#189): the model the failed reviewer was invoked on — for per-model error-rate attribution. */
  effectiveModel?: string;
  /** Pi only (#137): true when all providers in the failback chain were exhausted before final failure. */
  failbackExhausted?: boolean;
  /** Pi only (#137): number of cross-provider failback hops taken before the final failure. */
  failbackHopCount?: number;
  /** Pi only (#137): ordered provider+model pairs attempted before failure. Identifiers only (M008). */
  attemptedModels?: ReadonlyArray<{ provider: string; model: string }>;
  /** Pi only (#137): the last provider attempted before failure. */
  effectiveProvider?: string;
}

export interface ReviewRunContextMetrics {
  artifactBytes: number;
  changeContextBytes: number;
  patchBytes: number;
  patchFileCount: number;
  admission: ReviewContextArtifacts["admission"];
  deletionHunksPruned: number;
  deletedFileBodiesPruned: number;
}

/** Per-finding outcome counts for a re-review run (#256, M023 S04).
 *  Counts-only (M008/egress): integers + reviewer-role/severity identifiers only.
 *  Absent on first review (no prior state to compare). */
export interface DispositionCounts {
  fixed: number;
  dismissed: number;
  ignored: number;
  acknowledged: number;
  byReviewer?: Record<
    string,
    { fixed: number; dismissed: number; ignored: number; acknowledged: number }
  >;
  bySeverity?: Record<
    string,
    { fixed: number; dismissed: number; ignored: number; acknowledged: number }
  >;
}

export interface ReviewRunMetrics {
  durationsMs: ReviewRunDurations;
  context?: ReviewRunContextMetrics;
  tokens?: ReviewRunTokenMetrics;
  agents?: ReviewRunAgentMetrics[];
  failures?: ReviewRunAgentFailureMetrics[];
  /** Counts-only structured-vs-prose tally across this run's Pi agents (M015 S05, #128). totalCount excludes agents with no structured-tool concept. */
  structuredOutput?: { structuredCount: number; totalCount: number };
  /** Deduped, sorted runtime-reported effective model identifiers for this run (#189). Identifiers-only (M008). Absent for runtimes that resolve no real model (e.g. dummy). Distinct from run.start `modelIds`, which records CONFIGURED intent. */
  effectiveModelIds?: readonly string[];
  /** Per-finding outcome counts from re-review disposition derivation (#256, M023 S04).
   *  Absent on first review. Counts-only — no finding bodies/locations/paths (M008). */
  dispositions?: DispositionCounts;
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
