import type {
  ChangedFile,
  ChangedFileStatus,
  ChangeMetadata,
  ChangeRef,
  DiffSummary,
  Finding,
  PriorReviewState,
  PublishInlineFindingsInput,
  PublishInlineFindingsResult,
  PublishSummaryInput,
  PublishSummaryResult,
  VcsAdapter,
} from "../../contracts/index.ts";
import {
  formatInlineFindingComment,
  inlineCommentKey,
  parseInlineCommentMetadata,
} from "../../publisher/inline-comment-markdown.ts";
import { formatReviewSummaryMarkdown } from "../../publisher/summary-markdown.ts";
import {
  createPriorReviewStateFromMetadata,
  parseSummaryHiddenMetadata,
} from "../../publisher/summary-metadata.ts";

export type GitLabFetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GitLabVcsAdapterOptions {
  token?: string;
  apiBaseUrl?: string;
  fetch?: GitLabFetchLike;
}

interface GitLabUserResponse {
  id?: number;
  username: string;
  name?: string;
  web_url?: string;
}

interface GitLabDiffRefsResponse {
  base_sha?: string;
  head_sha?: string;
  start_sha?: string;
}

interface GitLabMergeRequestResponse {
  iid: number;
  title: string;
  description?: string | null;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
  author: GitLabUserResponse;
  labels: string[];
  source_branch: string;
  target_branch: string;
  sha?: string;
  diff_refs?: GitLabDiffRefsResponse | null;
}

interface GitLabChangeResponse {
  old_path: string;
  new_path: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
  diff?: string;
  generated_file?: boolean;
  collapsed?: boolean;
  too_large?: boolean;
}

interface GitLabChangesResponse {
  changes: GitLabChangeResponse[];
  overflow?: boolean;
}

interface GitLabNoteResponse {
  id: number;
  body?: string;
  web_url?: string;
  author?: GitLabUserResponse;
  system?: boolean;
}

// Inline diff-discussion types — GitLab discussion IDs are hashes (strings), note IDs are numbers.
interface GitLabDiscussionNote {
  id: number;
  body?: string;
  web_url?: string;
  author?: GitLabUserResponse;
  system?: boolean;
}
interface GitLabDiscussionResponse {
  id: string;
  notes?: GitLabDiscussionNote[];
}

export class GitLabVcsAdapter implements VcsAdapter {
  readonly provider = "gitlab" as const;

  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: GitLabFetchLike;

  // Memoized promise for the bot's own user id — resolved once per adapter instance.
  // Undefined means the identity could not be fetched; safe-on-failure: an unresolved
  // identity causes the dedup map to remain empty (no suppression) rather than trusting
  // author-blind metadata (which is the unsafe direction — see #84).
  private botUserIdPromise: Promise<number | undefined> | undefined;

  constructor(options: GitLabVcsAdapterOptions = {}) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://gitlab.com/api/v4").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  // Resolves the numeric id of the authenticated token's user via GET /user.
  // Best-effort via direct fetchImpl (NOT this.request which throws): any non-2xx response
  // or network error yields undefined — a dedup-identity hiccup must never fail publish.
  // Memoized so repeated calls in one publish cycle are free.
  private resolveBotUserId(): Promise<number | undefined> {
    if (this.botUserIdPromise === undefined) {
      this.botUserIdPromise = (async () => {
        try {
          const response = await this.fetchImpl(`${this.apiBaseUrl}/user`, {
            headers: this.headers(),
          });
          if (!response.ok) {
            return undefined;
          }
          const data = (await response.json()) as { id?: unknown };
          return typeof data.id === "number" ? data.id : undefined;
        } catch {
          return undefined;
        }
      })();
    }
    return this.botUserIdPromise;
  }

  async getChange(ref: ChangeRef): Promise<ChangeMetadata> {
    const response = await this.request<GitLabMergeRequestResponse>(this.mergeRequestPath(ref));
    const headSha = response.diff_refs?.head_sha ?? response.sha ?? ref.headSha;
    const baseSha = response.diff_refs?.base_sha ?? ref.baseSha;

    return {
      provider: "gitlab",
      repository: {
        provider: "gitlab",
        ...(ref.repository.owner !== undefined ? { owner: ref.repository.owner } : {}),
        name: ref.repository.name,
        slug: ref.repository.slug,
        ...(ref.repository.webUrl !== undefined ? { webUrl: ref.repository.webUrl } : {}),
        ...(ref.repository.defaultBranch !== undefined
          ? { defaultBranch: ref.repository.defaultBranch }
          : {}),
      },
      changeId: String(response.iid),
      headSha,
      ...(baseSha !== undefined ? { baseSha } : {}),
      sourceBranch: response.source_branch,
      targetBranch: response.target_branch,
      title: response.title,
      ...(response.description !== null && response.description !== undefined
        ? { description: response.description }
        : {}),
      author: {
        ...(response.author.id !== undefined ? { id: String(response.author.id) } : {}),
        username: response.author.username,
        ...(response.author.name !== undefined ? { displayName: response.author.name } : {}),
        ...(response.author.web_url !== undefined ? { webUrl: response.author.web_url } : {}),
      },
      labels: response.labels,
      ...(response.web_url !== undefined ? { webUrl: response.web_url } : {}),
      ...(response.created_at !== undefined ? { createdAt: response.created_at } : {}),
      ...(response.updated_at !== undefined ? { updatedAt: response.updated_at } : {}),
    };
  }

  async getDiff(ref: ChangeRef): Promise<DiffSummary> {
    const response = await this.request<GitLabChangesResponse>(
      `${this.mergeRequestPath(ref)}/changes`,
    );
    const files = response.changes.map((change) => normalizeChangedFile(change));
    const hasOmittedDiff = response.changes.some((change) => isOmittedDiff(change));
    const truncated =
      response.overflow === true ||
      response.changes.some((change) => change.too_large === true || change.collapsed === true) ||
      hasOmittedDiff;

    return {
      files,
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
      truncated,
      ...(truncated
        ? {
            truncationReason:
              "One or more GitLab merge request diffs were omitted or marked overflow/collapsed.",
          }
        : {}),
    };
  }

  async getPriorReviewState(ref: ChangeRef): Promise<PriorReviewState | undefined> {
    const notes = await this.request<GitLabNoteResponse[]>(this.mergeRequestNotesPath(ref));
    const existing = notes.findLast((note) => parseSummaryHiddenMetadata(note.body) !== undefined);
    const metadata = parseSummaryHiddenMetadata(existing?.body);

    return metadata === undefined ? undefined : createPriorReviewStateFromMetadata(metadata, ref);
  }

  async publishSummary(input: PublishSummaryInput): Promise<PublishSummaryResult> {
    const body = formatReviewSummaryMarkdown(input.summary, {
      includeHiddenMetadata: true,
      ...(input.hiddenMetadata !== undefined ? { hiddenMetadata: input.hiddenMetadata } : {}),
    });
    const existing = await this.findExistingSummaryNote(input.change);
    const response =
      existing === undefined
        ? await this.request<GitLabNoteResponse>(this.mergeRequestNotesPath(input.change), {
            method: "POST",
            body: { body },
          })
        : await this.request<GitLabNoteResponse>(
            this.mergeRequestNotePath(input.change, existing.id),
            {
              method: "PUT",
              body: { body },
            },
          );

    return {
      provider: "gitlab",
      summaryCommentId: String(response.id),
      ...(response.web_url !== undefined ? { summaryUrl: response.web_url } : {}),
      postedInlineCount: 0,
      failedInlineCount: 0,
    };
  }

  async readBaseBranchFile(change: ChangeMetadata, path: string): Promise<string | undefined> {
    // Prefer the target-branch tip (the protected branch P2 trusts). `baseSha` is a committed base
    // ancestor — not MR-authored, so still trust-safe — used only when no branch name is available;
    // it may be slightly behind the branch tip.
    const baseRef = change.targetBranch ?? change.baseSha;
    if (baseRef === undefined) {
      return undefined;
    }

    // GitLab repository-files API requires the full file path URL-encoded (slashes become %2F),
    // so encodeURIComponent is applied to the whole path — unlike GitHub which keeps the slashes.
    const url = `${this.apiBaseUrl}/projects/${encodeURIComponent(change.repository.slug)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(baseRef)}`;
    const response = await this.fetchImpl(url, { headers: this.headers() });

    // Best-effort read: any non-2xx (404 absent, 5xx transient, 401/403 auth) yields undefined so a
    // conventions-read hiccup degrades to "no base conventions" rather than failing the whole review.
    if (!response.ok) {
      return undefined;
    }

    const data = (await response.json()) as { content?: unknown; encoding?: unknown };
    if (data.encoding !== "base64" || typeof data.content !== "string") {
      return undefined;
    }

    return Buffer.from(data.content, "base64").toString("utf8");
  }

  async publishInlineFindings(
    input: PublishInlineFindingsInput,
  ): Promise<PublishInlineFindingsResult> {
    // Fetch diff_refs from the MR — these three SHAs are required to position inline comments
    // as GitLab diff discussions.  A hard fetch failure propagates like other adapter methods
    // (publish-inline is already inside the publish path — mirror publishSummary's request usage).
    const mrResponse = await this.request<GitLabMergeRequestResponse>(
      this.mergeRequestPath(input.change),
    );
    const diffRefs = mrResponse.diff_refs;

    // If any of the three positioning SHAs is absent we cannot place comments — skip everything
    // rather than throw, so a single-page publish degradation never blocks CI status.
    if (
      diffRefs === undefined ||
      diffRefs === null ||
      diffRefs.base_sha === undefined ||
      diffRefs.start_sha === undefined ||
      diffRefs.head_sha === undefined
    ) {
      const outcomes: PublishInlineFindingsResult["findings"] = input.findings.map((finding) => ({
        ...(finding.id !== undefined ? { findingId: finding.id } : {}),
        disposition: "skipped" as const,
        reason: "missing_diff_refs",
      }));

      return {
        provider: "gitlab",
        attemptedInlineCount: input.findings.length,
        postedInlineCount: 0,
        skippedInlineCount: input.findings.length,
        failedInlineCount: 0,
        findings: outcomes,
      };
    }

    const { base_sha: baseSha, start_sha: startSha, head_sha: headSha } = diffRefs;

    // Fetch existing discussions and the bot user id concurrently, then build a dedup map
    // keyed by inlineCommentKey(findingId, headSha).
    // Single-page fetch — mirrors findExistingSummaryNote (no pagination; acceptable MVP limit).
    // Safe-on-failure: if botId is undefined the filter matches nothing and the map stays
    // empty — worst case is a duplicate comment, which is the safe direction; suppression
    // (skipping a real finding) is the unsafe one (#84).
    const [discussions, botId] = await Promise.all([
      this.request<GitLabDiscussionResponse[]>(
        `${this.mergeRequestPath(input.change)}/discussions`,
      ),
      this.resolveBotUserId(),
    ]);
    const existingByKey = new Map<string, GitLabDiscussionNote>();

    for (const discussion of discussions) {
      for (const note of discussion.notes ?? []) {
        // Skip system notes (e.g. "force pushed") — they never carry our metadata.
        if (note.system === true) {
          continue;
        }
        const metadata = parseInlineCommentMetadata(note.body);
        if (
          metadata?.findingId !== undefined &&
          metadata.headSha !== undefined &&
          botId !== undefined &&
          note.author?.id === botId
        ) {
          existingByKey.set(inlineCommentKey(metadata.findingId, metadata.headSha), note);
        }
      }
    }

    const outcomes: PublishInlineFindingsResult["findings"] = [];

    for (const finding of input.findings) {
      const position = gitlabPositionForFinding(finding, { baseSha, startSha, headSha });
      if (position === undefined) {
        outcomes.push({
          ...(finding.id !== undefined ? { findingId: finding.id } : {}),
          disposition: "skipped",
          reason: "missing_inline_coordinates",
        });
        continue;
      }

      const findingId = finding.id;
      const duplicate =
        findingId === undefined
          ? undefined
          : existingByKey.get(inlineCommentKey(findingId, input.change.headSha));
      if (duplicate !== undefined && findingId !== undefined) {
        outcomes.push({
          findingId,
          disposition: "skipped",
          reason: "duplicate_inline_comment",
          providerCommentId: String(duplicate.id),
          ...(duplicate.web_url !== undefined ? { url: duplicate.web_url } : {}),
        });
        continue;
      }

      try {
        const response = await this.request<GitLabDiscussionResponse>(
          `${this.mergeRequestPath(input.change)}/discussions`,
          {
            method: "POST",
            body: {
              body: formatInlineFindingComment(finding, input.change, input.runId),
              position,
            },
          },
        );
        // GitLab's discussions POST returns the created discussion with its first note. If `notes`
        // is empty/absent (unexpected API shape), don't silently record the discussion-level hash
        // as a note id — surface it as failed so callers never get a wrong-entity id (#82 review).
        const firstNote = response.notes?.[0];
        if (firstNote === undefined) {
          outcomes.push({
            ...(finding.id !== undefined ? { findingId: finding.id } : {}),
            disposition: "failed",
            reason: "missing_discussion_note",
          });
          continue;
        }
        outcomes.push({
          ...(finding.id !== undefined ? { findingId: finding.id } : {}),
          disposition: "posted",
          providerCommentId: String(firstNote.id),
          ...(firstNote.web_url !== undefined ? { url: firstNote.web_url } : {}),
        });
      } catch (error) {
        outcomes.push({
          ...(finding.id !== undefined ? { findingId: finding.id } : {}),
          disposition: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      provider: "gitlab",
      attemptedInlineCount: input.findings.length,
      postedInlineCount: outcomes.filter((outcome) => outcome.disposition === "posted").length,
      skippedInlineCount: outcomes.filter((outcome) => outcome.disposition === "skipped").length,
      failedInlineCount: outcomes.filter((outcome) => outcome.disposition === "failed").length,
      findings: outcomes,
    };
  }

  private mergeRequestPath(ref: ChangeRef): string {
    return `/projects/${encodeURIComponent(ref.repository.slug)}/merge_requests/${encodeURIComponent(ref.changeId)}`;
  }

  private mergeRequestNotesPath(ref: ChangeRef | ChangeMetadata): string {
    return `/projects/${encodeURIComponent(ref.repository.slug)}/merge_requests/${encodeURIComponent(ref.changeId)}/notes`;
  }

  private mergeRequestNotePath(change: ChangeMetadata, noteId: number): string {
    return `${this.mergeRequestNotesPath(change)}/${encodeURIComponent(String(noteId))}`;
  }

  private async findExistingSummaryNote(
    change: ChangeMetadata,
  ): Promise<GitLabNoteResponse | undefined> {
    // Only treat a BOT-authored note as the existing summary to update (#84). A planted
    // `<!-- ai-code-review-factory` marker from another author would otherwise be picked as the
    // "existing" summary and make publishSummary PUT a note the bot can't edit → the summary post
    // fails (suppression). Safe-on-failure: an unresolved botId matches nothing → a fresh note is
    // POSTed (possible duplicate, the safe direction) rather than editing an unverified one.
    const [notes, botId] = await Promise.all([
      this.request<GitLabNoteResponse[]>(this.mergeRequestNotesPath(change)),
      this.resolveBotUserId(),
    ]);

    return notes.findLast(
      (note) =>
        note.system !== true &&
        note.body?.includes("<!-- ai-code-review-factory") === true &&
        botId !== undefined &&
        note.author?.id === botId,
    );
  }

  private async request<T>(
    pathOrUrl: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiBaseUrl}${pathOrUrl}`;
    const response = await this.fetchImpl(url, {
      ...(options.method !== undefined ? { method: options.method } : {}),
      headers: this.headers(options.body !== undefined),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `GitLab API request failed: ${response.status} ${response.statusText} for ${url}`,
      );
    }

    return (await response.json()) as T;
  }

  private headers(hasJsonBody = false): HeadersInit {
    return {
      Accept: "application/json",
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      ...(this.token !== undefined ? { "PRIVATE-TOKEN": this.token } : {}),
    };
  }
}

// Module-private helper — builds the GitLab `position` object for a diff discussion POST.
// Returns undefined when the finding is missing a line or a valid side, so the caller can
// push a "skipped" outcome without posting.
function gitlabPositionForFinding(
  finding: Finding,
  diffRefs: { baseSha: string; startSha: string; headSha: string },
): object | undefined {
  const location = finding.location;
  const line = location?.line ?? location?.startLine;
  if (location === undefined || line === undefined || location.side === undefined) {
    return undefined;
  }

  if (location.side !== "LEFT" && location.side !== "RIGHT") {
    return undefined;
  }

  const { baseSha: base_sha, startSha: start_sha, headSha: head_sha } = diffRefs;

  return {
    base_sha,
    start_sha,
    head_sha,
    position_type: "text",
    old_path: location.path,
    new_path: location.path,
    // RIGHT = new (added) side → new_line; LEFT = old (removed) side → old_line.
    ...(location.side === "RIGHT" ? { new_line: line } : { old_line: line }),
  };
}

function normalizeChangedFile(change: GitLabChangeResponse): ChangedFile {
  const counts = countDiffLines(change.diff ?? "");
  const path = change.new_path;

  return {
    path,
    ...(change.renamed_file ? { oldPath: change.old_path } : {}),
    status: normalizeStatus(change),
    additions: counts.additions,
    deletions: counts.deletions,
    isBinary: isBinaryChange(change),
    isLockfile: isLockfilePath(path),
    ...(change.generated_file !== undefined ? { isGenerated: change.generated_file } : {}),
    ...(change.diff !== undefined && change.diff.length > 0 ? { patch: change.diff } : {}),
  };
}

function normalizeStatus(change: GitLabChangeResponse): ChangedFileStatus {
  if (change.new_file) {
    return "added";
  }

  if (change.deleted_file) {
    return "deleted";
  }

  if (change.renamed_file) {
    return "renamed";
  }

  return "modified";
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }

  return { additions, deletions };
}

function isOmittedDiff(change: GitLabChangeResponse): boolean {
  return change.diff === undefined && !isBinaryLike(change.new_path);
}

function isBinaryChange(change: GitLabChangeResponse): boolean {
  return (change.diff === undefined || change.diff.length === 0) && isBinaryLike(change.new_path);
}

function isLockfilePath(path: string): boolean {
  return (
    path.endsWith("package-lock.json") ||
    path.endsWith("pnpm-lock.yaml") ||
    path.endsWith("yarn.lock") ||
    path.endsWith("bun.lockb") ||
    path.endsWith("Cargo.lock") ||
    path.endsWith("Gemfile.lock") ||
    path.endsWith("poetry.lock")
  );
}

function isBinaryLike(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|tgz|woff2?|ttf|otf|mp4|mov|mp3|wav)$/i.test(
    path,
  );
}
