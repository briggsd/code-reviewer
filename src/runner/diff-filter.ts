import type { ChangedFile, DiffSummary, ReviewConfig } from "../contracts/index.ts";
import { matchesAnyGlob } from "./path-match.ts";

export type IgnoredFileReason = "binary" | "lockfile" | "vendored" | "generated" | "ignored_path";

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

  if (file.isGenerated || hasGeneratedMarker(file, config)) {
    return "generated";
  }

  if (matchesAnyGlob(file.path, config.ignoredPaths)) {
    return "ignored_path";
  }

  return undefined;
}

// Bytes of each file's patch head scanned for generated markers. A marker (`// @generated`) is
// conventionally at the top of the source file, so it surfaces near the start of the patch when the
// change includes the file head (new / fully-regenerated files — the case this targets). The cap
// bounds cost; a marker outside the diff hunks is not seen, which is the safe direction: a file is
// only ever dropped when a marker is actually present.
const GENERATED_MARKER_SCAN_HEAD_BYTES = 4096;

function hasGeneratedMarker(file: ChangedFile, config: ReviewConfig): boolean {
  const markers = config.generatedFileMarkers;
  if (markers === undefined || markers.length === 0) {
    return false;
  }

  // Only the inline patch text is scannable; when the patch is absent or offloaded to a file
  // (large diffs → patchPath) there is nothing cheap to scan, so the file is reviewed (never
  // silently dropped on missing content).
  if (file.patch === undefined) {
    return false;
  }

  // Scan ONLY added lines (`+`, excluding the `+++ b/path` file header) — i.e. content that exists
  // in the new file. Matching the raw patch would also hit `-` (deleted) and context lines, so a PR
  // that *removes* a marker would falsely drop the file from review (the opposite of intent). The
  // marker prefixes themselves contain no `+`, so a substring match on the de-prefixed added text is
  // exact. NOTE (trust): added lines are PR-author-authored, so this is author-influenceable like a
  // path-glob ignore — `sensitivePaths` short-circuits above to protect security-critical files, and
  // every drop is recorded by path in the `context.built` trace (see run-review.ts) for audit.
  const addedContent = file.patch
    .slice(0, GENERATED_MARKER_SCAN_HEAD_BYTES)
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n")
    .toLowerCase();

  return markers.some((marker) => addedContent.includes(marker.toLowerCase()));
}
