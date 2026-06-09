import type {
  ChangeMetadata,
  ChangeRef,
  ChangedFile,
  ChangedFileStatus,
  DiffSummary,
  Finding,
  PriorReviewState,
  PublishSummaryInput,
  PublishSummaryResult,
  VcsAdapter,
} from "../../contracts/index.ts";
import { formatReviewSummaryMarkdown } from "../../publisher/summary-markdown.ts";
import { createPriorReviewStateFromMetadata, parseSummaryHiddenMetadata } from "../../publisher/summary-metadata.ts";

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
}

export class GitLabVcsAdapter implements VcsAdapter {
  readonly provider = "gitlab" as const;

  private readonly token: string | undefined;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: GitLabFetchLike;

  constructor(options: GitLabVcsAdapterOptions = {}) {
    this.token = options.token;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://gitlab.com/api/v4").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
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
        ...(ref.repository.defaultBranch !== undefined ? { defaultBranch: ref.repository.defaultBranch } : {}),
      },
      changeId: String(response.iid),
      headSha,
      ...(baseSha !== undefined ? { baseSha } : {}),
      sourceBranch: response.source_branch,
      targetBranch: response.target_branch,
      title: response.title,
      ...(response.description !== null && response.description !== undefined ? { description: response.description } : {}),
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
    const response = await this.request<GitLabChangesResponse>(`${this.mergeRequestPath(ref)}/changes`);
    const files = response.changes.map((change) => normalizeChangedFile(change));
    const hasOmittedDiff = response.changes.some((change) => isOmittedDiff(change));
    const truncated = response.overflow === true || response.changes.some((change) => change.too_large === true || change.collapsed === true) || hasOmittedDiff;

    return {
      files,
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
      truncated,
      ...(truncated ? { truncationReason: "One or more GitLab merge request diffs were omitted or marked overflow/collapsed." } : {}),
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
    const response = existing === undefined
      ? await this.request<GitLabNoteResponse>(this.mergeRequestNotesPath(input.change), {
        method: "POST",
        body: { body },
      })
      : await this.request<GitLabNoteResponse>(this.mergeRequestNotePath(input.change, existing.id), {
        method: "PUT",
        body: { body },
      });

    return {
      provider: "gitlab",
      summaryCommentId: String(response.id),
      ...(response.web_url !== undefined ? { summaryUrl: response.web_url } : {}),
      postedInlineCount: 0,
      failedInlineCount: 0,
    };
  }

  async publishInlineFindings(_change: ChangeMetadata, _findings: Finding[]): Promise<PublishSummaryResult> {
    throw new Error("GitLab inline finding publishing is not implemented in the metadata/diff MVP adapter");
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

  private async findExistingSummaryNote(change: ChangeMetadata): Promise<GitLabNoteResponse | undefined> {
    const notes = await this.request<GitLabNoteResponse[]>(this.mergeRequestNotesPath(change));

    return notes.findLast((note) => note.body?.includes("<!-- ai-code-review-factory") === true);
  }

  private async request<T>(pathOrUrl: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.apiBaseUrl}${pathOrUrl}`;
    const response = await this.fetchImpl(url, {
      ...(options.method !== undefined ? { method: options.method } : {}),
      headers: this.headers(options.body !== undefined),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      throw new Error(`GitLab API request failed: ${response.status} ${response.statusText} for ${url}`);
    }

    return await response.json() as T;
  }

  private headers(hasJsonBody = false): HeadersInit {
    return {
      Accept: "application/json",
      ...(hasJsonBody ? { "Content-Type": "application/json" } : {}),
      ...(this.token !== undefined ? { "PRIVATE-TOKEN": this.token } : {}),
    };
  }
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
  return /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|tgz|woff2?|ttf|otf|mp4|mov|mp3|wav)$/i.test(path);
}
