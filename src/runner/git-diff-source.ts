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
  // Opt-in: momentarily `add -N`s untracked-non-ignored files for the diff snapshot,
  // then restores the index. Default behavior is unchanged — untracked files stay invisible
  // unless this flag is set. Uses `--exclude-standard` so build/scratch junk (node_modules/,
  // dist/) is never pulled into the review.
  includeUntracked?: boolean;
}

export interface GitDiffChange {
  metadata: ChangeMetadata;
  diff: DiffSummary;
  /** Working-tree file bodies for deterministic grounding only; omitted from prompt artifacts. */
  changedFileContents?: Record<string, string>;
}

// Run `body` with untracked-non-ignored files momentarily marked intent-to-add so `git diff`
// includes them, then restore the index to exactly what was found. When `includeUntracked` is
// false (or nothing is untracked) it just runs `body` — no git mutation. The index restore always
// runs (success and failure paths) and a restore failure is NOT swallowed: it surfaces loudly
// rather than silently leaving the operator's index mutated (the regression this guards). On the
// failure path the original `body` error is preserved as the actionable cause — a restore failure
// is reported alongside it (wrapped, with `cause`), never in place of it.
async function withUntrackedSnapshot<T>(
  run: GitRunner,
  includeUntracked: boolean,
  body: () => Promise<T>,
): Promise<T> {
  if (!includeUntracked) {
    return body();
  }
  // NUL-separated so filenames with spaces/quotes/unicode stay literal (never quote-decoded).
  // --exclude-standard honours the project's .gitignore (+ .git/info/exclude, global gitignore),
  // so files the repo already ignores (e.g. a gitignored node_modules/, dist/) stay out of the review.
  const raw = await run(["ls-files", "--others", "--exclude-standard", "-z"]);
  const untracked = raw.split("\0").filter((p) => p.length > 0);
  if (untracked.length === 0) {
    return body();
  }
  // intent-to-add: makes `git diff` render each new file as all-additions without writing blob
  // content to the index. `--` separates paths from options (a filename starting with '-' can't be
  // parsed as a git option — the same argument-injection guard as the --base check).
  await run(["add", "-N", "--", ...untracked]);
  // Restore = remove only the intent-to-add entries we created. For genuinely-untracked files (no
  // prior index entry) this returns them to untracked and never touches the operator's other staged
  // changes (only our paths are named).
  const restore = () => run(["reset", "--", ...untracked]);
  let result: T;
  try {
    result = await body();
  } catch (bodyError) {
    // Body failed — still restore, but never let a restore failure mask the root cause.
    try {
      await restore();
    } catch (restoreError) {
      throw new Error(
        `local diff failed and the working index could not be restored — ${untracked.length} intent-to-add entry(ies) remain; run \`git reset\` to clear them. Restore error: ${String(restoreError)}`,
        { cause: bodyError },
      );
    }
    throw bodyError;
  }
  // Body succeeded — a restore failure is now the only (and actionable) error: surface it loudly.
  await restore();
  return result;
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

  // Snapshot untracked files into the diff (opt-in) while restoring the index afterward; the
  // index-restore guarantee lives in withUntrackedSnapshot, keeping this function flat.
  const [rawDiff, headSha, baseSha, branch, authorName, authorEmail, remoteUrl, topLevel] =
    await withUntrackedSnapshot(run, options.includeUntracked === true, () =>
      Promise.all([
        run(["diff", "--no-color", base]),
        runValue(run, ["rev-parse", "HEAD"]),
        runValue(run, ["rev-parse", base]),
        runValue(run, ["rev-parse", "--abbrev-ref", "HEAD"]),
        runValue(run, ["config", "user.name"]),
        runValue(run, ["config", "user.email"]),
        runValue(run, ["remote", "get-url", "origin"]),
        runValue(run, ["rev-parse", "--show-toplevel"]),
      ]),
    );

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
