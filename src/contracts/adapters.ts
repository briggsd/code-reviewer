import type { CiOutcome, JsonValue, ProviderKind, SafetyMode } from "./common.ts";
import type {
  ChangedPathsSince,
  ChangeMetadata,
  ChangeRef,
  DiffSummary,
  Finding,
  PriorReviewState,
  ReviewRunRecord,
  ReviewSummary,
} from "./review.ts";
import type { RuntimeEvent } from "./runtime.ts";

export interface DetectedCiEnvironment {
  provider: "github_actions" | "gitlab_ci" | "local";
  repository?: string;
  changeId?: string;
  headSha?: string;
  sourceBranch?: string;
  targetBranch?: string;
  raw: Record<string, string | undefined>;
}

export interface CiDecision {
  outcome: CiOutcome;
  exitCode: number;
  reason: string;
}

export interface CiAdapter {
  readonly name: string;

  detect(): DetectedCiEnvironment | undefined;

  inferSafetyMode(environment: DetectedCiEnvironment): SafetyMode;

  emitDecision(decision: CiDecision): Promise<void>;
}

export interface PublishSummaryInput {
  change: ChangeMetadata;
  summary: ReviewSummary;
  hiddenMetadata?: Record<string, JsonValue>;
}

export interface PublishSummaryResult {
  provider: ProviderKind;
  summaryCommentId?: string;
  summaryUrl?: string;
  postedInlineCount: number;
  failedInlineCount: number;
}

export type InlinePublishDisposition = "posted" | "skipped" | "failed";

export interface PublishInlineFindingOutcome {
  findingId?: string;
  disposition: InlinePublishDisposition;
  reason?: string;
  providerCommentId?: string;
  url?: string;
}

export interface PublishInlineFindingsInput {
  change: ChangeMetadata;
  findings: Finding[];
  runId?: string;
}

export interface PublishInlineFindingsResult {
  provider: ProviderKind;
  attemptedInlineCount: number;
  postedInlineCount: number;
  skippedInlineCount: number;
  failedInlineCount: number;
  findings: PublishInlineFindingOutcome[];
}

export interface VcsAdapter {
  readonly provider: ProviderKind;

  getChange(ref: ChangeRef): Promise<ChangeMetadata>;

  getDiff(ref: ChangeRef): Promise<DiffSummary>;

  getPriorReviewState(ref: ChangeRef): Promise<PriorReviewState | undefined>;

  publishSummary(input: PublishSummaryInput): Promise<PublishSummaryResult>;

  publishInlineFindings?(input: PublishInlineFindingsInput): Promise<PublishInlineFindingsResult>;

  // Read a UTF-8 text file from the change's BASE/target branch (not the PR head). Used to read
  // trust-sensitive config (conventions) from a ref the PR author cannot modify in the same diff.
  // Best-effort: returns undefined if the file is absent OR cannot be fetched (transient/auth
  // errors included) — a read hiccup must degrade to "no base config", never fail the review.
  // First of the base-ref reads (Foundation B; #46's prev-head..head diff will be a sibling later).
  readBaseBranchFile?(change: ChangeMetadata, path: string): Promise<string | undefined>;

  // Detect a human "break glass" override from a PR/MR comment by a TRUSTED author (#22 phase 2).
  // Returns the most recent qualifying override, or undefined when none is present. Best-effort:
  // a fetch failure degrades to "no override" (returns undefined), never fails the review — the
  // canonical CI gate is unaffected by a detection hiccup. All comment content is untrusted; only
  // a leading break-glass marker from an OWNER/MEMBER/COLLABORATOR-equivalent author qualifies.
  detectBreakGlassOverride?(ref: ChangeRef): Promise<BreakGlassOverride | undefined>;

  // Compute the files changed between `sinceSha` and the change head, for incremental re-review
  // (#46): narrow a re-push to only the delta since the last reviewed head. Best-effort — returns
  // undefined when the delta cannot be computed (unsupported provider, API error, or too many
  // files); the runner then falls back to a full review. `isAncestor` MUST be false on a
  // rebase/force-push (sinceSha no longer an ancestor of head), which also forces a full review.
  getChangedPathsSince?(ref: ChangeRef, sinceSha: string): Promise<ChangedPathsSince | undefined>;
}

// A recognized human break-glass override (#22 phase 2). Counts/identifiers only — the human
// audit trail (who, why) lives in the PR/MR comment itself, not in telemetry (M008). `commentId`
// is the stable identifier of the triggering comment; `authorAssociation` is the coarse role
// category that authorized it (e.g. "OWNER"/"MEMBER"/"COLLABORATOR"), never an author name.
export interface BreakGlassOverride {
  commentId: string;
  authorAssociation: string;
}

export interface ReviewStateStore {
  load(ref: ChangeRef): Promise<PriorReviewState | undefined>;

  saveRun(record: ReviewRunRecord): Promise<void>;

  saveSummary(runId: string, summary: ReviewSummary): Promise<void>;
}

export interface TraceSink {
  write(event: RuntimeEvent): Promise<void>;

  close(): Promise<void>;
}
