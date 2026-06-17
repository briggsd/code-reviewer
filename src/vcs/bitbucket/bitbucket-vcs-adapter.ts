import type {
  BreakGlassOverride,
  ChangedPathsSince,
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
import { parseUnifiedDiff } from "../../shared/unified-diff.ts";
import {
  BITBUCKET_TRUSTED_PERMISSIONS,
  breakGlassMatchesHead,
  mapBitbucketPermission,
} from "../break-glass-marker.ts";
import type { FetchLike } from "../shared/http-json-client.ts";
import { HttpJsonClient, HttpRequestError } from "../shared/http-json-client.ts";

export type { FetchLike } from "../shared/http-json-client.ts";

export interface BitbucketVcsAdapterOptions {
  token?: string;
  apiBaseUrl?: string;
  userAgent?: string;
  fetch?: FetchLike;
}

// Bitbucket Cloud REST API 2.0 response interfaces

interface BitbucketUserResponse {
  uuid?: string;
  nickname?: string;
  display_name?: string;
}

interface BitbucketCommitResponse {
  hash: string;
}

interface BitbucketBranchResponse {
  name: string;
}

interface BitbucketRepoResponse {
  full_name?: string;
  links?: {
    html?: { href?: string };
  };
}

interface BitbucketPrRefResponse {
  branch: BitbucketBranchResponse;
  commit: BitbucketCommitResponse;
  repository?: BitbucketRepoResponse;
}

interface BitbucketPrLinksResponse {
  html?: { href?: string };
}

interface BitbucketSummaryResponse {
  raw?: string;
  markup?: string;
  html?: string;
}

interface BitbucketPullResponse {
  id: number;
  title: string;
  description?: string;
  summary?: BitbucketSummaryResponse;
  author: BitbucketUserResponse | null;
  source: BitbucketPrRefResponse;
  destination: BitbucketPrRefResponse;
  links?: BitbucketPrLinksResponse;
  created_on?: string;
  updated_on?: string;
}

interface BitbucketCommentContentResponse {
  raw?: string;
}

interface BitbucketCommentLinksResponse {
  html?: { href?: string };
}

interface BitbucketCommentResponse {
  id: number;
  content?: BitbucketCommentContentResponse;
  user?: BitbucketUserResponse | null;
  links?: BitbucketCommentLinksResponse;
  inline?: {
    path?: string;
    from?: number;
    to?: number;
  };
}

// Repository permission entry returned by
// GET /workspaces/{ws}/permissions/repositories/{slug}?q=user.uuid="..."
interface BitbucketRepoPermissionEntry {
  permission?: string;
}

// One entry from the diffstat paginated response.
// `new` / `old` hold path objects when the file exists on that side.
interface BitbucketDiffstatEntry {
  new?: { path?: string } | null;
  old?: { path?: string } | null;
}

// Commit list response from /commits (used for ancestry check).
interface BitbucketCommitsResponse {
  values?: Array<{ hash?: string }>;
}

export class BitbucketVcsAdapter implements VcsAdapter {
  readonly provider = "bitbucket" as const;

  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly http: HttpJsonClient;

  // Memoized promise for the bot's own UUID — resolved once per adapter instance.
  // Undefined means the identity could not be fetched; safe-on-failure: an unresolved
  // identity causes prior-state loading to return undefined (no prior state) rather than
  // trusting author-blind metadata (which is the unsafe direction — see #84).
  private botUuidPromise: Promise<string | undefined> | undefined;

  constructor(options: BitbucketVcsAdapterOptions = {}) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "code-reviewer";
    this.fetchImpl = options.fetch ?? fetch;
    this.http = new HttpJsonClient({
      baseUrl: this.apiBaseUrl,
      fetchImpl: this.fetchImpl,
      providerNoun: "Bitbucket",
      headers: (hasJsonBody) => this.headers(hasJsonBody),
    });
  }

  // Resolves the UUID of the authenticated token's user via GET /user.
  // Best-effort: any non-2xx response or network error yields undefined — a uuid-identity
  // hiccup must never fail a review operation. Memoized so repeated calls in one cycle are free.
  private resolveBotUuid(): Promise<string | undefined> {
    if (this.botUuidPromise === undefined) {
      this.botUuidPromise = (async () => {
        try {
          const response = await this.fetchImpl(`${this.apiBaseUrl}/user`, {
            headers: this.headers(),
          });
          if (!response.ok) {
            return undefined;
          }
          const data = (await response.json()) as { uuid?: unknown };
          return typeof data.uuid === "string" ? data.uuid : undefined;
        } catch {
          return undefined;
        }
      })();
    }
    return this.botUuidPromise;
  }

  async getChange(ref: ChangeRef): Promise<ChangeMetadata> {
    const response = await this.http.request<BitbucketPullResponse>(this.pullPath(ref));
    const [workspace, repoSlug] = splitSlug(ref.repository.slug);

    // Prefer `summary.raw` (Bitbucket's description rendered source) as description.
    // Fall back to the `description` field when summary is absent — treating an
    // empty/whitespace-only `summary.raw` as absent so a populated `description` is
    // not masked by an empty string (`??` alone would keep the empty string).
    const summaryRaw = response.summary?.raw;
    const description =
      summaryRaw !== undefined && summaryRaw.trim().length > 0 ? summaryRaw : response.description;

    const authorUsername =
      response.author?.nickname ??
      response.author?.display_name ??
      response.author?.uuid ??
      "unknown";

    return {
      provider: "bitbucket",
      repository: {
        provider: "bitbucket",
        owner: workspace,
        name: repoSlug,
        slug: `${workspace}/${repoSlug}`,
        ...(response.destination.repository?.links?.html?.href !== undefined
          ? { webUrl: response.destination.repository.links.html.href }
          : ref.repository.webUrl !== undefined
            ? { webUrl: ref.repository.webUrl }
            : {}),
      },
      changeId: String(response.id),
      headSha: response.source.commit.hash,
      baseSha: response.destination.commit.hash,
      sourceBranch: response.source.branch.name,
      targetBranch: response.destination.branch.name,
      title: response.title,
      ...(description !== undefined && description.length > 0 ? { description } : {}),
      author: {
        ...(response.author?.uuid !== undefined ? { id: response.author.uuid } : {}),
        username: authorUsername,
      },
      // Bitbucket Cloud PRs have no labels concept.
      labels: [],
      ...(response.links?.html?.href !== undefined ? { webUrl: response.links.html.href } : {}),
      ...(response.created_on !== undefined ? { createdAt: response.created_on } : {}),
      ...(response.updated_on !== undefined ? { updatedAt: response.updated_on } : {}),
    };
  }

  async getDiff(ref: ChangeRef): Promise<DiffSummary> {
    // Bitbucket's diff endpoint returns a raw unified diff text, NOT JSON.
    // We must do a raw GET and read the response as text, then parse with parseUnifiedDiff.
    const url = `${this.apiBaseUrl}${this.pullDiffPath(ref)}`;
    const response = await this.fetchImpl(url, {
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new HttpRequestError(
        `Bitbucket API request failed: ${response.status} ${response.statusText} for ${url}`,
        response.status,
      );
    }

    const diffText = await response.text();
    const files = parseUnifiedDiff(diffText);

    return {
      files,
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
      // Refined truncation handling is out of scope for the read-path slice.
      truncated: false,
    };
  }

  async getPriorReviewState(ref: ChangeRef): Promise<PriorReviewState | undefined> {
    // Mirror the #84 bot-author guard: only load prior state from a comment authored by the
    // bot itself. Any PR participant can post a comment with a crafted <!-- code-reviewer -->
    // block — without an author check, a forged comment would be loaded as prior state.
    // Safe-on-failure: if botUuid is unresolved, return undefined (first review) rather than
    // falling back to author-blind metadata selection (the unsafe direction).
    const [comments, botUuid] = await Promise.all([
      this.http.requestAllPagesCursor<BitbucketCommentResponse>(this.prCommentsPath(ref)),
      this.resolveBotUuid(),
    ]);

    if (botUuid === undefined) {
      return undefined;
    }

    const existing = comments.findLast((comment) => this.isOwnSummaryComment(comment, botUuid));
    const metadata = parseSummaryHiddenMetadata(existing?.content?.raw);

    return metadata === undefined ? undefined : createPriorReviewStateFromMetadata(metadata, ref);
  }

  async readBaseBranchFile(change: ChangeMetadata, path: string): Promise<string | undefined> {
    try {
      // Prefer the target-branch tip (the protected branch P2 trusts). `baseSha` is a committed base
      // ancestor — not PR-authored, so still trust-safe — used only when no branch name is available;
      // it may be slightly behind the branch tip.
      const baseRef = change.targetBranch ?? change.baseSha;
      if (baseRef === undefined) {
        return undefined;
      }

      const [workspace, repoSlug] = splitSlug(change.repository.slug);
      // Bitbucket's src endpoint returns RAW file content (text/plain), not a base64-JSON blob.
      // Each path segment is URL-encoded independently so slashes remain as path separators.
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const url = `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/src/${encodeURIComponent(baseRef)}/${encodedPath}`;
      const response = await this.fetchImpl(url, { headers: this.headers() });

      // Best-effort read: any non-2xx (404 absent, 5xx transient, 401/403 auth) yields undefined so a
      // conventions-read hiccup degrades to "no base conventions" rather than failing the whole review.
      if (!response.ok) {
        return undefined;
      }

      return await response.text();
    } catch {
      // Best-effort: a fetch/body error must never fail the review (mirror readChangeFileAtHead).
      return undefined;
    }
  }

  async readChangeFileAtHead(change: ChangeMetadata, path: string): Promise<string | undefined> {
    try {
      const [workspace, repoSlug] = splitSlug(change.repository.slug);
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const url = `${this.apiBaseUrl}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/src/${encodeURIComponent(change.headSha)}/${encodedPath}`;
      const response = await this.fetchImpl(url, { headers: this.headers() });
      if (!response.ok) {
        return undefined;
      }

      return response.text();
    } catch {
      // Best-effort deterministic grounding: head-file read failures never fail the review.
      return undefined;
    }
  }

  async detectBreakGlassOverride(ref: ChangeRef): Promise<BreakGlassOverride | undefined> {
    try {
      const comments = await this.http.requestAllPagesCursor<BitbucketCommentResponse>(
        this.prCommentsPath(ref),
      );
      // Candidates: non-bot comments whose leading line is `break glass <head-sha>` for THIS head
      // commit. We exclude comments that contain our bot marker to avoid the bot's own summary
      // triggering an override. Iterate most-recent-first so the first qualifying author wins.
      const candidates = comments
        .filter(
          (comment) =>
            comment.content?.raw?.includes("<!-- code-reviewer") !== true &&
            breakGlassMatchesHead(comment.content?.raw, ref.headSha),
        )
        .reverse();

      for (const comment of candidates) {
        const userUuid = comment.user?.uuid;
        if (userUuid === undefined) {
          continue;
        }
        const permission = await this.bitbucketRepoPermission(ref.repository.slug, userUuid);
        if (permission !== undefined && BITBUCKET_TRUSTED_PERMISSIONS.has(permission)) {
          return {
            commentId: String(comment.id),
            authorAssociation: mapBitbucketPermission(permission),
          };
        }
        // Untrusted permission ("read" / absent) or lookup failure → this author does not activate
        // the override; continue searching for an earlier trusted commenter (most-recent-first order
        // means an earlier comment in the original list appears later in the reversed candidates).
      }

      return undefined;
    } catch {
      // Best-effort: a detection hiccup must never throw — the canonical CI gate is unaffected.
      return undefined;
    }
  }

  // Fetch the repository permission for a specific user UUID.
  // Returns the permission string ("admin" | "write" | "read") or undefined when the user is
  // not a member or any fetch error occurs. Best-effort: a lookup failure means "not trusted".
  private async bitbucketRepoPermission(
    slug: string,
    userUuid: string,
  ): Promise<string | undefined> {
    try {
      const [workspace, repoSlug] = splitSlug(slug);
      // The permission endpoint accepts a FIQL `q` filter on user.uuid. The uuid includes
      // curly braces for Bitbucket's account-id format, so it must be URL-encoded in the query.
      const url = `${this.apiBaseUrl}/workspaces/${encodeURIComponent(workspace)}/permissions/repositories/${encodeURIComponent(repoSlug)}?q=user.uuid="${encodeURIComponent(userUuid)}"`;
      const response = await this.fetchImpl(url, { headers: this.headers() });
      if (!response.ok) {
        return undefined;
      }
      const data = (await response.json()) as { values?: BitbucketRepoPermissionEntry[] };
      const first = data.values?.[0];
      return typeof first?.permission === "string" ? first.permission : undefined;
    } catch {
      return undefined;
    }
  }

  async getChangedPathsSince(
    ref: ChangeRef,
    sinceSha: string,
  ): Promise<ChangedPathsSince | undefined> {
    try {
      // sinceSha originates from prior-review metadata (untrusted reviewed-repo content).
      // Require a commit-SHA shape before interpolating it into the API path — a malformed
      // value would only error anyway; rejecting it avoids a wasted call (→ full-review fallback).
      if (!/^[0-9a-f]{7,64}$/i.test(sinceSha)) {
        return undefined;
      }

      const [workspace, repoSlug] = splitSlug(ref.repository.slug);
      const repoBase = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;

      // Bitbucket has no GitHub-style three-dot compare with an `isAncestor` status field, so
      // ancestry is DERIVED via a two-step approach (mirrors the GitLab adapter).
      //
      // REVERSE (ancestry check): GET /commits?include={sinceSha}&exclude={headSha} returns
      // commits reachable from sinceSha but NOT from headSha.  On a clean fast-forward that set
      // is empty (sinceSha IS reachable from head, so all its ancestors are excluded) → isAncestor.
      // A force-push / rebase leaves sinceSha-only commits → non-empty → NOT an ancestor.
      // An error or unexpected shape → treat as NOT ancestor (the safe, full-review direction).
      const reverseUrl = `${this.apiBaseUrl}${repoBase}/commits?include=${encodeURIComponent(sinceSha)}&exclude=${encodeURIComponent(ref.headSha)}`;
      const reverseResponse = await this.fetchImpl(reverseUrl, { headers: this.headers() });
      if (!reverseResponse.ok) {
        return undefined;
      }
      const reverseData = (await reverseResponse.json()) as BitbucketCommitsResponse;
      // Confirm emptiness: only an empty values array (no reachable-from-since-only commits)
      // confirms a clean fast-forward. A non-array or non-empty array → not ancestor.
      const isAncestor = Array.isArray(reverseData.values) && reverseData.values.length === 0;

      if (!isAncestor) {
        // Force-push / rebase (or unconfirmable ancestry): return empty changedPaths so a caller
        // that narrows on them without checking isAncestor reviews nothing (the safe direction)
        // rather than a misleading partial set. The flag is still returned so the runner records
        // `base_changed` (distinct from the `delta_unavailable` that an undefined result yields).
        return { changedPaths: [], isAncestor: false };
      }

      // FORWARD (delta): GET /diffstat/{headSha}..{sinceSha} (note: head..since → paths changed
      // moving from the since-commit's perspective to head, i.e. the net delta since that commit).
      const diffstatPath = `${repoBase}/diffstat/${encodeURIComponent(ref.headSha)}..${encodeURIComponent(sinceSha)}`;
      const entries = await this.http.requestAllPagesCursor<BitbucketDiffstatEntry>(diffstatPath);

      // Mirror the GitHub / GitLab 300-file cap: a very large delta is no cheaper to review
      // incrementally and risks truncation → fall back to full review (correctness over savings).
      if (entries.length >= 300) {
        return undefined;
      }

      const changedPaths = entries
        .map((entry) => entry.new?.path ?? entry.old?.path ?? "")
        .filter((p) => p.length > 0);

      return { changedPaths, isAncestor: true };
    } catch {
      // Best-effort: any error (network, 404, auth) degrades to full review, never throws.
      return undefined;
    }
  }

  async publishSummary(input: PublishSummaryInput): Promise<PublishSummaryResult> {
    const body = formatReviewSummaryMarkdown(input.summary, {
      includeHiddenMetadata: true,
      ...(input.hiddenMetadata !== undefined ? { hiddenMetadata: input.hiddenMetadata } : {}),
    });

    const [comments, botUuid] = await Promise.all([
      this.http.requestAllPagesCursor<BitbucketCommentResponse>(this.prCommentsPath(input.change)),
      this.resolveBotUuid(),
    ]);

    const existing =
      botUuid !== undefined
        ? comments.findLast((comment) => this.isOwnSummaryComment(comment, botUuid))
        : undefined;

    const response =
      existing === undefined
        ? await this.http.request<BitbucketCommentResponse>(this.prCommentsPath(input.change), {
            method: "POST",
            body: { content: { raw: body } },
          })
        : await this.http.request<BitbucketCommentResponse>(
            this.prCommentPath(input.change, existing.id),
            {
              method: "PUT",
              body: { content: { raw: body } },
            },
          );

    return {
      provider: "bitbucket",
      summaryCommentId: String(response.id),
      ...(response.links?.html?.href !== undefined ? { summaryUrl: response.links.html.href } : {}),
      postedInlineCount: 0,
      failedInlineCount: 0,
    };
  }

  async publishInlineFindings(
    input: PublishInlineFindingsInput,
  ): Promise<PublishInlineFindingsResult> {
    const existingByKey = await this.buildExistingInlineCommentsMap(input);
    const outcomes: PublishInlineFindingsResult["findings"] = [];

    for (const finding of input.findings) {
      const anchor = bitbucketInlineCoordinateForFinding(finding);
      if (anchor === undefined) {
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
          ...(duplicate.links?.html?.href !== undefined ? { url: duplicate.links.html.href } : {}),
        });
        continue;
      }

      try {
        const response = await this.http.request<BitbucketCommentResponse>(
          this.prCommentsPath(input.change),
          {
            method: "POST",
            body: {
              content: { raw: formatInlineFindingComment(finding, input.change, input.runId) },
              inline: anchor,
            },
          },
        );
        outcomes.push({
          ...(finding.id !== undefined ? { findingId: finding.id } : {}),
          disposition: "posted",
          providerCommentId: String(response.id),
          ...(response.links?.html?.href !== undefined ? { url: response.links.html.href } : {}),
        });
      } catch (error) {
        outcomes.push({
          ...(finding.id !== undefined ? { findingId: finding.id } : {}),
          disposition: "failed",
          reason: error instanceof Error ? error.message : String(error),
          ...(error instanceof HttpRequestError ? { httpStatus: error.status } : {}),
        });
      }
    }

    return {
      provider: "bitbucket",
      attemptedInlineCount: input.findings.length,
      postedInlineCount: outcomes.filter((o) => o.disposition === "posted").length,
      skippedInlineCount: outcomes.filter((o) => o.disposition === "skipped").length,
      failedInlineCount: outcomes.filter((o) => o.disposition === "failed").length,
      summaryFallbackCount: 0,
      findings: outcomes,
    };
  }

  /** Build the dedup map for inline comments from existing bot-authored PR comments. */
  private async buildExistingInlineCommentsMap(
    input: PublishInlineFindingsInput,
  ): Promise<Map<string, BitbucketCommentResponse>> {
    const [comments, botUuid] = await Promise.all([
      this.http.requestAllPagesCursor<BitbucketCommentResponse>(this.prCommentsPath(input.change)),
      this.resolveBotUuid(),
    ]);
    const byFindingAndHead = new Map<string, BitbucketCommentResponse>();

    for (const comment of comments) {
      const metadata = parseInlineCommentMetadata(comment.content?.raw);
      if (
        metadata?.findingId !== undefined &&
        metadata.headSha !== undefined &&
        botUuid !== undefined &&
        comment.user?.uuid === botUuid
      ) {
        byFindingAndHead.set(inlineCommentKey(metadata.findingId, metadata.headSha), comment);
      }
    }

    return byFindingAndHead;
  }

  // Returns true when a comment was authored by the bot AND is the review *summary* comment.
  // This is the single trust point for getPriorReviewState — the author-identity check (#84/#263).
  //
  // Bitbucket exposes ONE comments endpoint for both summary and inline comments (unlike GitHub's
  // separate issue/pull-review endpoints), so the summary scan must distinguish the two: the inline
  // marker `<!-- code-reviewer-inline` would match a bare `includes("<!-- code-reviewer")`
  // substring. We therefore require the comment to parse as a real summary hidden-metadata block —
  // `parseSummaryHiddenMetadata`'s regex requires `code-reviewer\n` and so rejects the
  // `-inline` marker. Without this, an inline comment could be selected as the "existing summary",
  // losing prior review state (getPriorReviewState) or overwriting an inline comment (publishSummary).
  private isOwnSummaryComment(comment: BitbucketCommentResponse, botUuid: string): boolean {
    return (
      comment.user?.uuid === botUuid &&
      parseSummaryHiddenMetadata(comment.content?.raw) !== undefined
    );
  }

  private pullPath(ref: ChangeRef): string {
    const [workspace, repoSlug] = splitSlug(ref.repository.slug);
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(ref.changeId)}`;
  }

  private pullDiffPath(ref: ChangeRef): string {
    const [workspace, repoSlug] = splitSlug(ref.repository.slug);
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(ref.changeId)}/diff`;
  }

  private prCommentsPath(ref: ChangeRef | ChangeMetadata): string {
    const [workspace, repoSlug] = splitSlug(ref.repository.slug);
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(ref.changeId)}/comments`;
  }

  private prCommentPath(ref: ChangeRef | ChangeMetadata, commentId: number): string {
    const [workspace, repoSlug] = splitSlug(ref.repository.slug);
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(ref.changeId)}/comments/${encodeURIComponent(String(commentId))}`;
  }

  private headers(hasJsonBody = false): HeadersInit {
    return {
      Accept: "application/json",
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      "User-Agent": this.userAgent,
      ...(this.token !== undefined ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }
}

// Maps a finding's location to Bitbucket's `inline` comment anchor.
// RIGHT/new-side → { path, to: line }; LEFT/old-side → { path, from: line }.
// Returns undefined when coordinate data is absent (caller skips with missing_inline_coordinates).
function bitbucketInlineCoordinateForFinding(
  finding: Finding,
): { path: string; to: number } | { path: string; from: number } | undefined {
  const location = finding.location;
  const line = location?.line ?? location?.startLine;
  if (location === undefined || line === undefined || location.side === undefined) {
    return undefined;
  }

  if (location.side !== "LEFT" && location.side !== "RIGHT") {
    return undefined;
  }

  return location.side === "RIGHT"
    ? { path: location.path, to: line }
    : { path: location.path, from: line };
}

// Splits a Bitbucket `workspace/repo_slug` slug into its two components.
// Throws a descriptive error when the slug is not in the expected form.
function splitSlug(slug: string): [string, string] {
  const [workspace, repoSlug] = slug.split("/");
  if (
    workspace === undefined ||
    workspace.length === 0 ||
    repoSlug === undefined ||
    repoSlug.length === 0
  ) {
    throw new Error(
      `Bitbucket repository slug must be workspace/repo_slug, got ${JSON.stringify(slug)}`,
    );
  }
  return [workspace, repoSlug];
}
