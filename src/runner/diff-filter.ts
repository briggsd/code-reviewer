import type { ChangedFile, DiffSummary, ReviewConfig } from "../contracts/index.ts";
import { matchesAnyGlob } from "./path-match.ts";

export type IgnoredFileReason =
  | "binary"
  | "lockfile"
  | "vendored"
  | "generated"
  | "ignored_path";

export interface IgnoredFile {
  file: ChangedFile;
  reason: IgnoredFileReason;
}

export interface DiffFilterResult {
  diff: DiffSummary;
  ignoredFiles: IgnoredFile[];
}

export function filterDiff(diff: DiffSummary, config: ReviewConfig): DiffFilterResult {
  const reviewableFiles: ChangedFile[] = [];
  const ignoredFiles: IgnoredFile[] = [];

  for (const file of diff.files) {
    const reason = getIgnoredReason(file, config);
    if (reason === undefined) {
      reviewableFiles.push(file);
    } else {
      ignoredFiles.push({ file, reason });
    }
  }

  return {
    diff: {
      files: reviewableFiles,
      totalAdditions: reviewableFiles.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: reviewableFiles.reduce((sum, file) => sum + file.deletions, 0),
      truncated: diff.truncated,
      ...(diff.truncationReason !== undefined ? { truncationReason: diff.truncationReason } : {}),
    },
    ignoredFiles,
  };
}

function getIgnoredReason(file: ChangedFile, config: ReviewConfig): IgnoredFileReason | undefined {
  if (file.isBinary) {
    return "binary";
  }

  const isSensitive = matchesAnyGlob(file.path, config.sensitivePaths);
  if (isSensitive) {
    return undefined;
  }

  if (file.isLockfile) {
    return "lockfile";
  }

  if (file.isVendored) {
    return "vendored";
  }

  if (file.isGenerated) {
    return "generated";
  }

  if (matchesAnyGlob(file.path, config.ignoredPaths)) {
    return "ignored_path";
  }

  return undefined;
}
