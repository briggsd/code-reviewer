import type { CiOutcome, JsonValue, ProviderKind, SafetyMode } from "./common.ts";
import type {
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
