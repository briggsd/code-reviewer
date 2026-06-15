import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ChangedFile,
  DiffSummary,
  ReviewContext,
  ReviewContextArtifacts,
} from "../contracts/index.ts";
import { isLowSignalPath } from "./diff-filter.ts";
import { type AdmissionDecision, decidePatchAdmission } from "./patch-admission.ts";
import { matchesAnyGlob } from "./path-match.ts";
import { pruneDeletionOnlyHunks } from "./prune-deletion-hunks.ts";

const CONTEXT_SCHEMA_VERSION = "ai-review.context.v1";
const CHANGE_CONTEXT_FILENAME = "change-context.json";
const PATCH_DIRECTORY_NAME = "patches";

export interface WriteReviewContextArtifactsInput {
  context: ReviewContext;
  generatedAt: string;
  /** Per-tier byte budget for patch content (#145). From tier-profile default or config override. */
  budgetBytes: number;
}

export interface WriteReviewContextArtifactsResult {
  diff: DiffSummary;
  artifacts: ReviewContextArtifacts;
  /** Admission decision from the patch budget gate (#145). Always present. */
  admission: AdmissionDecision;
}

export async function writeReviewContextArtifacts(
  input: WriteReviewContextArtifactsInput,
): Promise<WriteReviewContextArtifactsResult> {
  const patchDirectoryPath = join(input.context.contextDirectory, PATCH_DIRECTORY_NAME);
  const patchDirectoryWritePath = resolveContextPath(input.context, patchDirectoryPath);
  await mkdir(patchDirectoryWritePath, { recursive: true });

  // -------------------------------------------------------------------------
  // Pass 1: for each file, run deletion-pruning and compute post-pruning
  //         patch bytes. Fully-deleted files are excluded from admission
  //         ranking (they carry no body already). Collect per-file data for
  //         the admission gate (#145).
  // -------------------------------------------------------------------------

  type PruneResult =
    | { kind: "deleted" }
    | { kind: "no_patch" }
    | { kind: "all_hunks_pruned"; droppedHunks: number }
    | { kind: "admittable"; patch: string; patchBytes: number; droppedHunks: number };

  interface FileEntry {
    file: ChangedFile;
    prune: PruneResult;
  }

  const fileEntries: FileEntry[] = [];
  let totalDeletionHunksPruned = 0;
  let totalDeletedFileBodiesPruned = 0;

  for (const file of input.context.diff.files) {
    // Fully-deleted files: name+stat only — no patch body, excluded from admission.
    if (file.status === "deleted") {
      fileEntries.push({ file, prune: { kind: "deleted" } });
      if (file.patch !== undefined && file.patch.length > 0) {
        totalDeletedFileBodiesPruned += 1;
      }
      continue;
    }

    if (file.patch === undefined || file.patch.length === 0) {
      fileEntries.push({ file, prune: { kind: "no_patch" } });
      continue;
    }

    // Prune deletion-only hunks (#144, port of PR-Agent `omit_deletion_hunks`).
    const pruned = pruneDeletionOnlyHunks(file.patch);

    if (pruned.patch === undefined) {
      // All hunks were deletion-only — name-only after pruning, excluded from admission.
      fileEntries.push({
        file,
        prune: { kind: "all_hunks_pruned", droppedHunks: pruned.droppedHunks },
      });
      totalDeletionHunksPruned += pruned.droppedHunks;
      continue;
    }

    const patch = pruned.patch;
    const patchBytes = Buffer.byteLength(patch, "utf8");
    fileEntries.push({
      file,
      prune: { kind: "admittable", patch, patchBytes, droppedHunks: pruned.droppedHunks },
    });
    totalDeletionHunksPruned += pruned.droppedHunks;
  }

  // -------------------------------------------------------------------------
  // Admission gate: rank admittable files smallest-first, admit until budget.
  // -------------------------------------------------------------------------

  const admittableEntries = fileEntries.filter(
    (e): e is FileEntry & { prune: Extract<PruneResult, { kind: "admittable" }> } =>
      e.prune.kind === "admittable",
  );

  // sensitivePaths preserves the existing trust-boundary guarantee that operator-flagged
  // security-critical files are never deprioritized: a sensitive file is NEVER tagged low-signal,
  // so it is ranked as signal-bearing and keeps its full patch under budget pressure (#218 must not
  // weaken the sensitivePaths guard that filterDiff honors for exclusion).
  const sensitivePaths = input.context.config.sensitivePaths;
  const admission = decidePatchAdmission({
    files: admittableEntries.map((e) => ({
      path: e.file.path,
      patchBytes: e.prune.patchBytes,
      lowSignal: !matchesAnyGlob(e.file.path, sensitivePaths) && isLowSignalPath(e.file.path),
    })),
    budgetBytes: input.budgetBytes,
  });

  // -------------------------------------------------------------------------
  // Pass 2: write patch bodies for admitted files; emit name+stat only for
  //         demoted files (mirrors the existing fully-deleted-file branch).
  // -------------------------------------------------------------------------

  const files: ChangedFile[] = [];
  const patchWrites: Promise<void>[] = [];
  let patchBytes = 0;
  let patchFileCount = 0;

  for (const [index, entry] of fileEntries.entries()) {
    const { file, prune } = entry;

    if (prune.kind === "deleted" || prune.kind === "no_patch") {
      const { patchPath: _omit, ...fileWithoutPatchPath } = file;
      files.push(prune.kind === "deleted" ? fileWithoutPatchPath : file);
      continue;
    }

    if (prune.kind === "all_hunks_pruned") {
      // All hunks were deletion-only — write file name-only (no patchPath).
      const { patchPath: _omit, ...fileWithoutPatchPath } = file;
      files.push(fileWithoutPatchPath);
      continue;
    }

    // prune.kind === "admittable"
    if (!admission.admittedPaths.has(file.path)) {
      // Demoted by admission gate: name+stat only, no patch body (#145).
      // Mirror the existing fully-deleted-file branch exactly.
      const { patchPath: _omit, ...fileWithoutPatchPath } = file;
      files.push(fileWithoutPatchPath);
      continue;
    }

    // Admitted: write patch body to disk.
    const patch = prune.patch;
    const patchPath = join(patchDirectoryPath, createPatchArtifactFilename(index, file));
    patchWrites.push(writeFile(resolveContextPath(input.context, patchPath), patch, "utf8"));
    patchBytes += prune.patchBytes;
    patchFileCount += 1;
    files.push({ ...file, patchPath });
  }

  await Promise.all(patchWrites);

  const diff: DiffSummary = {
    ...input.context.diff,
    files,
  };

  // -------------------------------------------------------------------------
  // Overflow list: demoted files appear in change-context.json so reviewers
  // can see what changed but wasn't included (#145).
  // -------------------------------------------------------------------------

  // Build a fast lookup for demoted files by path.
  const demotedPathSet = new Set(admission.demotedPaths);
  const overflowFiles = input.context.diff.files
    .filter((f) => demotedPathSet.has(f.path))
    .map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));

  const changeContextPath = join(input.context.contextDirectory, CHANGE_CONTEXT_FILENAME);
  const changeContext = {
    schemaVersion: CONTEXT_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    runId: input.context.runId,
    safetyMode: input.context.safetyMode,
    metadata: input.context.metadata,
    risk: input.context.risk,
    diff: {
      ...diff,
      files: diff.files.map(({ patch, ...file }) => file),
    },
    ...(overflowFiles.length > 0 ? { overflowFiles } : {}),
    ...(input.context.priorState !== undefined ? { priorState: input.context.priorState } : {}),
  };
  const changeContextJson = `${JSON.stringify(changeContext, null, 2)}\n`;
  await writeFile(resolveContextPath(input.context, changeContextPath), changeContextJson, "utf8");

  const changeContextBytes = Buffer.byteLength(changeContextJson, "utf8");
  return {
    diff,
    artifacts: {
      changeContextPath,
      patchDirectory: patchDirectoryPath,
      patchFileCount,
      changeContextBytes,
      patchBytes,
      totalBytes: changeContextBytes + patchBytes,
      admission: {
        budgetBytes: admission.budgetBytes,
        originalBytes: admission.originalBytes,
        admittedBytes: admission.admittedBytes,
        admittedFileCount: admission.admittedPaths.size,
        demotedFileCount: admission.demotedPaths.length,
        degraded: admission.degraded,
      },
      deletionHunksPruned: totalDeletionHunksPruned,
      deletedFileBodiesPruned: totalDeletedFileBodiesPruned,
    },
    admission,
  };
}

function resolveContextPath(context: ReviewContext, path: string): string {
  return isAbsolute(path) ? path : join(context.workingDirectory, path);
}

function createPatchArtifactFilename(index: number, file: ChangedFile): string {
  const ordinal = String(index + 1).padStart(4, "0");
  const hash = createHash("sha256")
    .update(file.path)
    .update("\0")
    .update(file.oldPath ?? "")
    .digest("hex")
    .slice(0, 12);
  const safePathHint =
    file.path
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
      .join("__")
      .replaceAll(/[^A-Za-z0-9._-]/g, "_")
      .replaceAll(/_+/g, "_")
      .replaceAll(/^\.+|\.+$/g, "")
      .slice(0, 80) || "file";

  return `${ordinal}-${safePathHint}-${hash}.patch`;
}
