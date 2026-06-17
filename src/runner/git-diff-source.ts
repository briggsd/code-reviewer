import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ChangedFile, ChangeMetadata, DiffSummary } from "../contracts/index.ts";
import { parseUnifiedDiff } from "../shared/unified-diff.ts";

// Local git-diff review source. Builds the same ChangeMetadata + DiffSummary the
// VCS adapters produce, but from the local repository instead of a provider PR —
// so the review runner can be driven against working-tree changes without
// opening a pull/merge request. There is no adapter, so publishing is not
// available; this is the fast pre-PR iteration loop.
//
// git invocation is injected (`GitRunner`) so the parsing is unit-testable
// without a real repository.

export type GitRunner = (args: readonly string[]) => Promise<string>;
export type WorkingTreeFileReader = (repoRelativePath: string) => Promise<string>;

export interface GitDiffSourceOptions {
  // Ref to diff the working tree against. Default "HEAD" reviews uncommitted
  // changes; passing a base branch (e.g. "main") reviews everything that would
  // land in the PR — committed-on-branch plus uncommitted.
  base?: string;
  // Overrides the synthesized changeId (defaults to the current branch name).
  changeId?: string;
  // Injected in tests to avoid filesystem I/O. Reads a repo-relative working-tree path.
  readWorkingTreeFile?: WorkingTreeFileReader;
}

export interface GitDiffChange {
  metadata: ChangeMetadata;
  diff: DiffSummary;
  /** Working-tree file bodies for deterministic grounding only; omitted from prompt artifacts. */
  changedFileContents?: Record<string, string>;
}

export async function loadGitDiffChange(
  options: GitDiffSourceOptions,
  run: GitRunner,
): Promise<GitDiffChange> {
  const base = options.base ?? "HEAD";
  // The base ref is interpolated into `git diff <base>` / `git rev-parse <base>`.
  // Reject a leading dash so a ref like `--upload-pack=…` can't be parsed as a
  // git option (argument injection).
  if (base.startsWith("-")) {
    throw new Error(`invalid --base ref: ${base} (must not start with "-")`);
  }

  const [rawDiff, headSha, baseSha, branch, authorName, authorEmail, remoteUrl, topLevel] =
    await Promise.all([
      run(["diff", "--no-color", base]),
      runValue(run, ["rev-parse", "HEAD"]),
      runValue(run, ["rev-parse", base]),
      runValue(run, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runValue(run, ["config", "user.name"]),
      runValue(run, ["config", "user.email"]),
      runValue(run, ["remote", "get-url", "origin"]),
      runValue(run, ["rev-parse", "--show-toplevel"]),
    ]);

  const files = parseUnifiedDiff(rawDiff);
  const diff: DiffSummary = {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: false,
  };

  const branchName = branch.length > 0 ? branch : "HEAD";
  const repoName = repoNameFromRemote(remoteUrl) ?? basename(topLevel) ?? "local-repo";
  // Prefer the configured name over the email as the identity, so a raw email
  // address is not the default value carried into telemetry/traces.
  const username =
    authorName.length > 0 ? authorName : authorEmail.length > 0 ? authorEmail : "local";

  const metadata: ChangeMetadata = {
    provider: "local",
    repository: {
      provider: "local",
      name: repoName,
      slug: repoName,
    },
    changeId: options.changeId ?? branchName,
    headSha: headSha.length > 0 ? headSha : "working-tree",
    ...(baseSha.length > 0 ? { baseSha } : {}),
    sourceBranch: branchName,
    targetBranch: base,
    title: `Local diff: ${branchName} vs ${base}`,
    author: {
      username,
      ...(authorName.length > 0 ? { displayName: authorName } : {}),
    },
    labels: [],
  };

  const changedFileContents = await readChangedFileContents(files, topLevel, options);

  return {
    metadata,
    diff,
    ...(Object.keys(changedFileContents).length > 0 ? { changedFileContents } : {}),
  };
}

async function readChangedFileContents(
  files: readonly ChangedFile[],
  topLevel: string,
  options: GitDiffSourceOptions,
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {};
  const reader =
    options.readWorkingTreeFile ??
    (topLevel.length > 0
      ? async (repoRelativePath: string) =>
          readFile(await resolveRepoFilePath(topLevel, repoRelativePath), "utf8")
      : undefined);

  if (reader === undefined) {
    return contents;
  }

  await Promise.all(
    files.map(async (file) => {
      if (file.isBinary || file.status === "deleted") {
        return;
      }
      try {
        contents[file.path] = await reader(file.path);
      } catch {
        // Best-effort local grounding: read failures simply mean no full-file corpus entry.
      }
    }),
  );

  return contents;
}

async function resolveRepoFilePath(topLevel: string, repoRelativePath: string): Promise<string> {
  if (isAbsolute(repoRelativePath)) {
    throw new Error("changed file path must be repo-relative");
  }

  const candidate = join(topLevel, repoRelativePath);
  const rel = relative(topLevel, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("changed file path must stay inside the repository");
  }

  const [realTopLevel, realCandidate] = await Promise.all([
    realpath(topLevel),
    realpath(candidate),
  ]);
  const realRel = relative(realTopLevel, realCandidate);
  if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) {
    throw new Error("changed file path must stay inside the repository");
  }

  return realCandidate;
}

async function runValue(run: GitRunner, args: readonly string[]): Promise<string> {
  try {
    return (await run(args)).trim();
  } catch {
    // Best-effort metadata: a missing remote, detached HEAD, or unset user.name
    // should degrade gracefully rather than abort a local review.
    return "";
  }
}

function repoNameFromRemote(remoteUrl: string): string | undefined {
  if (remoteUrl.length === 0) {
    return undefined;
  }

  const trimmed = remoteUrl.trim().replace(/\.git$/, "");
  const lastSegment = trimmed.split(/[/:]/).at(-1);

  return lastSegment !== undefined && lastSegment.length > 0 ? lastSegment : undefined;
}

function basename(path: string): string | undefined {
  if (path.length === 0) {
    return undefined;
  }

  const segment = path.trim().replaceAll("\\", "/").split("/").at(-1);

  return segment !== undefined && segment.length > 0 ? segment : undefined;
}
