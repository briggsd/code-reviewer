import type {
  ChangeMetadata,
  ChangeRef,
  DiffSummary,
  PriorReviewState,
  PublishSummaryInput,
  PublishSummaryResult,
  VcsAdapter,
} from "../../contracts/index.ts";
import {
  createPriorReviewStateFromMetadata,
  parseSummaryHiddenMetadata,
} from "../../publisher/summary-metadata.ts";
import { parseUnifiedDiff } from "../../shared/unified-diff.ts";
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

interface BitbucketCommentResponse {
  id: number;
  content?: BitbucketCommentContentResponse;
  user?: BitbucketUserResponse | null;
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
    this.userAgent = options.userAgent ?? "ai-code-review-factory";
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
    // bot itself. Any PR participant can post a comment with a crafted <!-- ai-code-review-factory -->
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

  // publishSummary is implemented in S03 (write-path slice). This stub satisfies the VcsAdapter
  // interface contract so the class can be compiled and tested without the write path.
  publishSummary(_input: PublishSummaryInput): Promise<PublishSummaryResult> {
    return Promise.reject(
      new Error("BitbucketVcsAdapter.publishSummary is not yet implemented (S03)"),
    );
  }

  // Returns true when a comment was authored by the bot AND carries the hidden-metadata marker.
  // This is the single trust point for getPriorReviewState — the author-identity check (#84/#263).
  private isOwnSummaryComment(comment: BitbucketCommentResponse, botUuid: string): boolean {
    return (
      comment.content?.raw?.includes("<!-- ai-code-review-factory") === true &&
      comment.user?.uuid === botUuid
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

  private prCommentsPath(ref: ChangeRef): string {
    const [workspace, repoSlug] = splitSlug(ref.repository.slug);
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/pullrequests/${encodeURIComponent(ref.changeId)}/comments`;
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
