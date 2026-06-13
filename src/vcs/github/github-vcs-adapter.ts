import type {
  BreakGlassOverride,
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
import { breakGlassMatchesHead, GITHUB_TRUSTED_ASSOCIATIONS } from "../break-glass-marker.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface GitHubVcsAdapterOptions {
  token?: string;
  apiBaseUrl?: string;
  userAgent?: string;
  fetch?: FetchLike;
}

interface GitHubUserResponse {
  id?: number;
  login: string;
  html_url?: string;
}

interface GitHubLabelResponse {
  name: string;
}

interface GitHubBranchRefResponse {
  ref: string;
  sha: string;
  repo?: {
    default_branch?: string;
    html_url?: string;
    name?: string;
    owner?: GitHubUserResponse;
    full_name?: string;
  } | null;
}

interface GitHubPullResponse {
  number: number;
  title: string;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  user: GitHubUserResponse | null;
  labels: GitHubLabelResponse[];
  head: GitHubBranchRefResponse;
  base: GitHubBranchRefResponse;
}

interface GitHubPullFileResponse {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

interface GitHubIssueCommentResponse {
  id: number;
  body?: string;
  html_url?: string;
  user?: GitHubUserResponse | null;
  author_association?: string;
}

interface GitHubPullReviewCommentResponse {
  id: number;
  body?: string;
  html_url?: string;
  user?: GitHubUserResponse | null;
}

// The fixed user id GitHub assigns to comments authored via an Actions installation token
// (login `github-actions[bot]`). Server-assigned and unforgeable by commenters.
const GITHUB_ACTIONS_BOT_USER_ID = 41_898_282;

export class GitHubVcsAdapter implements VcsAdapter {
  readonly provider = "github" as const;

  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;

  // Memoized promise for the bot's own user id — resolved once per adapter instance.
  // Undefined means the identity could not be fetched; safe-on-failure: an unresolved
  // identity causes the dedup map to remain empty (no suppression) rather than trusting
  // author-blind metadata (which is the unsafe direction — see #84).
  private botUserIdPromise: Promise<number | undefined> | undefined;

  constructor(options: GitHubVcsAdapterOptions = {}) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "ai-code-review-factory";
    this.fetchImpl = options.fetch ?? fetch;
  }

  // Resolves the numeric id of the authenticated token's user via GET /user.
  // Best-effort: any non-2xx response or network error yields undefined — a dedup-identity
  // hiccup must never fail publish. Memoized so repeated calls in one publish cycle are free.
  //
  // Installation tokens (GITHUB_TOKEN in Actions) get 403 from GET /user, and their comments
  // are authored as github-actions[bot] — a server-assigned identity an attacker cannot forge,
  // so accepting its well-known id preserves the #84 planted-marker defense. Without this
  // fallback every CI run posts a duplicate summary instead of updating in place. 403 only:
  // transient failures on user tokens still yield undefined (the duplicate-over-suppression
  // direction). Tokens of other GitHub Apps also 403 here, but their comments are authored
  // under each app's own [bot] id, so the mismatch just falls back to a fresh POST as before.
  private resolveBotUserId(): Promise<number | undefined> {
    if (this.botUserIdPromise === undefined) {
      this.botUserIdPromise = (async () => {
        try {
          const response = await this.fetchImpl(`${this.apiBaseUrl}/user`, {
            headers: this.headers(),
          });
          if (response.status === 403) {
            return GITHUB_ACTIONS_BOT_USER_ID;
          }
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
    const response = await this.request<GitHubPullResponse>(this.pullPath(ref));
    const owner = ref.repository.owner ?? ownerFromSlug(ref.repository.slug);
    const repoName = repoNameFromSlug(ref.repository.slug, ref.repository.name);

    return {
      provider: "github",
      repository: {
        provider: "github",
        owner,
        name: repoName,
        slug: `${owner}/${repoName}`,
        ...(response.base.repo?.html_url !== undefined
          ? { webUrl: response.base.repo.html_url }
          : ref.repository.webUrl !== undefined
            ? { webUrl: ref.repository.webUrl }
            : {}),
        ...(response.base.repo?.default_branch !== undefined
          ? { defaultBranch: response.base.repo.default_branch }
          : ref.repository.defaultBranch !== undefined
            ? { defaultBranch: ref.repository.defaultBranch }
            : {}),
      },
      changeId: String(response.number),
      headSha: response.head.sha,
      baseSha: response.base.sha,
      sourceBranch: response.head.ref,
      targetBranch: response.base.ref,
      title: response.title,
      ...(response.body !== null && response.body !== undefined
        ? { description: response.body }
        : {}),
      author: {
        ...(response.user?.id !== undefined ? { id: String(response.user.id) } : {}),
        username: response.user?.login ?? "unknown",
        ...(response.user?.html_url !== undefined ? { webUrl: response.user.html_url } : {}),
      },
      labels: response.labels.map((label) => label.name),
      ...(response.html_url !== undefined ? { webUrl: response.html_url } : {}),
      ...(response.created_at !== undefined ? { createdAt: response.created_at } : {}),
      ...(response.updated_at !== undefined ? { updatedAt: response.updated_at } : {}),
    };
  }

  async getDiff(ref: ChangeRef): Promise<DiffSummary> {
    const files = await this.requestAllPages<GitHubPullFileResponse>(`${this.pullPath(ref)}/files`);
    const normalizedFiles = files.map((file) => normalizeChangedFile(file));

    return {
      files: normalizedFiles,
      totalAdditions: normalizedFiles.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: normalizedFiles.reduce((sum, file) => sum + file.deletions, 0),
      truncated: files.some(
        (file) => file.patch === undefined && file.changes > 0 && !isBinaryLike(file.filename),
      ),
      ...(files.some(
        (file) => file.patch === undefined && file.changes > 0 && !isBinaryLike(file.filename),
      )
        ? { truncationReason: "One or more GitHub file patches were omitted by the API." }
        : {}),
    };
  }

  async getPriorReviewState(ref: ChangeRef): Promise<PriorReviewState | undefined> {
    const comments = await this.requestAllPages<GitHubIssueCommentResponse>(
      this.issueCommentsPath(ref),
    );
    const existing = comments.findLast(
      (comment) => parseSummaryHiddenMetadata(comment.body) !== undefined,
    );
    const metadata = parseSummaryHiddenMetadata(existing?.body);

    return metadata === undefined ? undefined : createPriorReviewStateFromMetadata(metadata, ref);
  }

  async detectBreakGlassOverride(ref: ChangeRef): Promise<BreakGlassOverride | undefined> {
    try {
      const comments = await this.requestAllPages<GitHubIssueCommentResponse>(
        this.issueCommentsPath(ref),
      );
      // Find the LAST qualifying break-glass comment (most recent wins).
      // Skip: bot/summary comments (containing our marker), untrusted associations, and
      // comments whose leading line is not `break glass <head-sha>` for THIS head commit.
      // `author_association` is computed by GitHub server-side at response time (it reflects the
      // author's CURRENT repo relationship and is not part of the user-controlled comment body),
      // so trusting it needs no extra live membership call — unlike GitLab, whose note payload
      // carries no association and forces the members/all lookup in the adapter below.
      const qualifying = comments.filter(
        (comment) =>
          comment.body?.includes("<!-- ai-code-review-factory") !== true &&
          breakGlassMatchesHead(comment.body, ref.headSha) &&
          comment.author_association !== undefined &&
          GITHUB_TRUSTED_ASSOCIATIONS.has(comment.author_association),
      );
      const last = qualifying[qualifying.length - 1];
      if (last === undefined) {
        return undefined;
      }
      return {
        commentId: String(last.id),
        authorAssociation: last.author_association as string,
      };
    } catch {
      // Best-effort: a detection hiccup must never throw — the canonical CI gate is unaffected.
      return undefined;
    }
  }

  async publishSummary(input: PublishSummaryInput): Promise<PublishSummaryResult> {
    const body = formatReviewSummaryMarkdown(input.summary, {
      includeHiddenMetadata: true,
      ...(input.hiddenMetadata !== undefined ? { hiddenMetadata: input.hiddenMetadata } : {}),
    });
    const existing = await this.findExistingSummaryComment(input.change);
    const response =
      existing === undefined
        ? await this.request<GitHubIssueCommentResponse>(this.issueCommentsPath(input.change), {
            method: "POST",
            body: { body },
          })
        : await this.request<GitHubIssueCommentResponse>(
            this.issueCommentPath(input.change, existing.id),
            {
              method: "PATCH",
              body: { body },
            },
          );

    return {
      provider: "github",
      summaryCommentId: String(response.id),
      ...(response.html_url !== undefined ? { summaryUrl: response.html_url } : {}),
      postedInlineCount: 0,
      failedInlineCount: 0,
    };
  }

  async readBaseBranchFile(change: ChangeMetadata, path: string): Promise<string | undefined> {
    // Prefer the target-branch tip (the protected branch P2 trusts). `baseSha` is a committed base
    // ancestor — not PR-authored, so still trust-safe — used only when no branch name is available;
    // it may be slightly behind the branch tip.
    const baseRef = change.targetBranch ?? change.baseSha;
    if (baseRef === undefined) {
      return undefined;
    }

    const owner = change.repository.owner ?? ownerFromSlug(change.repository.slug);
    const repo = repoNameFromSlug(change.repository.slug, change.repository.name);
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `${this.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?ref=${encodeURIComponent(baseRef)}`;
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

    return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  }

  async publishInlineFindings(
    input: PublishInlineFindingsInput,
  ): Promise<PublishInlineFindingsResult> {
    const outcomes: PublishInlineFindingsResult["findings"] = [];
    const existingInlineComments = await this.findExistingInlineComments(input.change);

    for (const finding of input.findings) {
      const coordinate = githubInlineCoordinateForFinding(finding);
      if (coordinate === undefined) {
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
          : existingInlineComments.get(inlineCommentKey(findingId, input.change.headSha));
      if (duplicate !== undefined && findingId !== undefined) {
        outcomes.push({
          findingId,
          disposition: "skipped",
          reason: "duplicate_inline_comment",
          providerCommentId: String(duplicate.id),
          ...(duplicate.html_url !== undefined ? { url: duplicate.html_url } : {}),
        });
        continue;
      }

      try {
        const response = await this.request<GitHubPullReviewCommentResponse>(
          this.pullCommentsPath(input.change),
          {
            method: "POST",
            body: {
              body: formatInlineFindingComment(finding, input.change, input.runId),
              commit_id: input.change.headSha,
              path: coordinate.path,
              line: coordinate.line,
              side: coordinate.side,
            },
          },
        );
        outcomes.push({
          ...(finding.id !== undefined ? { findingId: finding.id } : {}),
          disposition: "posted",
          providerCommentId: String(response.id),
          ...(response.html_url !== undefined ? { url: response.html_url } : {}),
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
      provider: "github",
      attemptedInlineCount: input.findings.length,
      postedInlineCount: outcomes.filter((outcome) => outcome.disposition === "posted").length,
      skippedInlineCount: outcomes.filter((outcome) => outcome.disposition === "skipped").length,
      failedInlineCount: outcomes.filter((outcome) => outcome.disposition === "failed").length,
      findings: outcomes,
    };
  }

  private pullPath(ref: ChangeRef): string {
    const owner = ref.repository.owner ?? ownerFromSlug(ref.repository.slug);
    const repo = repoNameFromSlug(ref.repository.slug, ref.repository.name);

    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(ref.changeId)}`;
  }

  private issueCommentsPath(ref: ChangeRef | ChangeMetadata): string {
    const owner = ref.repository.owner ?? ownerFromSlug(ref.repository.slug);
    const repo = repoNameFromSlug(ref.repository.slug, ref.repository.name);

    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(ref.changeId)}/comments`;
  }

  private pullCommentsPath(ref: ChangeRef | ChangeMetadata): string {
    const owner = ref.repository.owner ?? ownerFromSlug(ref.repository.slug);
    const repo = repoNameFromSlug(ref.repository.slug, ref.repository.name);

    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(ref.changeId)}/comments`;
  }

  private issueCommentPath(change: ChangeMetadata, commentId: number): string {
    const owner = change.repository.owner ?? ownerFromSlug(change.repository.slug);
    const repo = repoNameFromSlug(change.repository.slug, change.repository.name);

    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${encodeURIComponent(String(commentId))}`;
  }

  private async findExistingSummaryComment(
    change: ChangeMetadata,
  ): Promise<GitHubIssueCommentResponse | undefined> {
    // Only treat a BOT-authored comment as the existing summary to update (#84). An attacker who
    // can comment could otherwise plant a `<!-- ai-code-review-factory` marker, get picked as the
    // "existing" summary, and make publishSummary PATCH a comment the bot can't edit → 403 → the
    // whole summary post fails (suppression). Safe-on-failure: if botId is unresolved the filter
    // matches nothing → publishSummary POSTs a fresh comment (a possible duplicate, the safe
    // direction) rather than editing an unverified one.
    const [comments, botId] = await Promise.all([
      this.requestAllPages<GitHubIssueCommentResponse>(this.issueCommentsPath(change)),
      this.resolveBotUserId(),
    ]);

    return comments.findLast(
      (comment) =>
        comment.body?.includes("<!-- ai-code-review-factory") === true &&
        botId !== undefined &&
        comment.user?.id === botId,
    );
  }

  private async findExistingInlineComments(
    change: ChangeMetadata,
  ): Promise<Map<string, GitHubPullReviewCommentResponse>> {
    // Resolve the bot's own user id before scanning comments so we can reject planted
    // markers from other authors. Safe-on-failure: if botId is undefined the filter matches
    // nothing and the map stays empty — worst case is a duplicate comment, which is the
    // safe direction; suppression (skipping a real finding) is the unsafe one (#84).
    const [comments, botId] = await Promise.all([
      this.requestAllPages<GitHubPullReviewCommentResponse>(this.pullCommentsPath(change)),
      this.resolveBotUserId(),
    ]);
    const byFindingAndHead = new Map<string, GitHubPullReviewCommentResponse>();

    for (const comment of comments) {
      const metadata = parseInlineCommentMetadata(comment.body);
      if (
        metadata?.findingId !== undefined &&
        metadata.headSha !== undefined &&
        botId !== undefined &&
        comment.user?.id === botId
      ) {
        byFindingAndHead.set(inlineCommentKey(metadata.findingId, metadata.headSha), comment);
      }
    }

    return byFindingAndHead;
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
        `GitHub API request failed: ${response.status} ${response.statusText} for ${url}`,
      );
    }

    return (await response.json()) as T;
  }

  private async requestAllPages<T>(path: string): Promise<T[]> {
    let nextUrl: string | undefined = `${this.apiBaseUrl}${path}?per_page=100`;
    const results: T[] = [];

    while (nextUrl !== undefined) {
      const response = await this.fetchImpl(nextUrl, {
        headers: this.headers(),
      });

      if (!response.ok) {
        throw new Error(
          `GitHub API request failed: ${response.status} ${response.statusText} for ${nextUrl}`,
        );
      }

      const page = (await response.json()) as T[];
      results.push(...page);
      nextUrl = parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  private headers(hasJsonBody = false): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": this.userAgent,
      ...(this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }
}

function githubInlineCoordinateForFinding(
  finding: Finding,
): { path: string; line: number; side: "LEFT" | "RIGHT" } | undefined {
  const location = finding.location;
  const line = location?.line ?? location?.startLine;
  if (location === undefined || line === undefined || location.side === undefined) {
    return undefined;
  }

  if (location.side !== "LEFT" && location.side !== "RIGHT") {
    return undefined;
  }

  return {
    path: location.path,
    line,
    side: location.side,
  };
}

function normalizeChangedFile(file: GitHubPullFileResponse): ChangedFile {
  return {
    path: file.filename,
    ...(file.previous_filename !== undefined ? { oldPath: file.previous_filename } : {}),
    status: normalizeStatus(file.status),
    additions: file.additions,
    deletions: file.deletions,
    isBinary: file.patch === undefined && isBinaryLike(file.filename),
    isLockfile: isLockfilePath(file.filename),
    ...(file.patch !== undefined ? { patch: file.patch } : {}),
  };
}

function normalizeStatus(status: string): ChangedFileStatus {
  if (
    status === "added" ||
    status === "modified" ||
    status === "renamed" ||
    status === "deleted" ||
    status === "copied" ||
    status === "unchanged"
  ) {
    return status;
  }

  return "modified";
}

function parseNextLink(linkHeader: string | null): string | undefined {
  if (linkHeader === null) {
    return undefined;
  }

  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((value) => value.trim());
    if (relPart === 'rel="next"' && urlPart?.startsWith("<") && urlPart.endsWith(">")) {
      return urlPart.slice(1, -1);
    }
  }

  return undefined;
}

function ownerFromSlug(slug: string): string {
  const [owner] = slug.split("/");
  if (owner === undefined || owner.length === 0) {
    throw new Error(`GitHub repository slug must be owner/name, got ${slug}`);
  }

  return owner;
}

function repoNameFromSlug(slug: string, fallback: string): string {
  const [, repo] = slug.split("/");
  if (repo !== undefined && repo.length > 0) {
    return repo;
  }

  return fallback;
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
