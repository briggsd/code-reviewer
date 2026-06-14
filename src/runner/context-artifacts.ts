import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  ChangedFile,
  DiffSummary,
  ReviewContext,
  ReviewContextArtifacts,
} from "../contracts/index.ts";
import { pruneDeletionOnlyHunks } from "./prune-deletion-hunks.ts";

const CONTEXT_SCHEMA_VERSION = "ai-review.context.v1";
const CHANGE_CONTEXT_FILENAME = "change-context.json";
const PATCH_DIRECTORY_NAME = "patches";

export interface WriteReviewContextArtifactsInput {
  context: ReviewContext;
  generatedAt: string;
}

export interface WriteReviewContextArtifactsResult {
  diff: DiffSummary;
  artifacts: ReviewContextArtifacts;
}

export async function writeReviewContextArtifacts(
  input: WriteReviewContextArtifactsInput,
): Promise<WriteReviewContextArtifactsResult> {
  const patchDirectoryPath = join(input.context.contextDirectory, PATCH_DIRECTORY_NAME);
  const patchDirectoryWritePath = resolveContextPath(input.context, patchDirectoryPath);
  await mkdir(patchDirectoryWritePath, { recursive: true });

  const files: ChangedFile[] = [];
  const patchWrites: Promise<void>[] = [];
  let patchBytes = 0;
  let patchFileCount = 0;
  let deletionHunksPruned = 0;
  let deletedFileBodiesPruned = 0;

  for (const [index, file] of input.context.diff.files.entries()) {
    // Fully-deleted files: emit name + stat only — never write a patch body (#144,
    // port of PR-Agent `handle_patch_deletions`). Strip patchPath to satisfy
    // exactOptionalPropertyTypes (setting it to undefined is not assignable).
    if (file.status === "deleted") {
      const { patchPath: _omit, ...fileWithoutPatchPath } = file;
      files.push(fileWithoutPatchPath);
      if (file.patch !== undefined && file.patch.length > 0) {
        deletedFileBodiesPruned += 1;
      }
      continue;
    }

    if (file.patch === undefined || file.patch.length === 0) {
      files.push(file);
      continue;
    }

    // Prune deletion-only hunks (#144, port of PR-Agent `omit_deletion_hunks`).
    const pruned = pruneDeletionOnlyHunks(file.patch);
    deletionHunksPruned += pruned.droppedHunks;

    if (pruned.patch === undefined) {
      // All hunks were deletion-only — write file name-only (no patchPath).
      const { patchPath: _omit, ...fileWithoutPatchPath } = file;
      files.push(fileWithoutPatchPath);
      continue;
    }

    const patch = pruned.patch;
    const patchPath = join(patchDirectoryPath, createPatchArtifactFilename(index, file));
    patchWrites.push(writeFile(resolveContextPath(input.context, patchPath), patch, "utf8"));
    patchBytes += Buffer.byteLength(patch, "utf8");
    patchFileCount += 1;
    files.push({ ...file, patchPath });
  }

  await Promise.all(patchWrites);

  const diff: DiffSummary = {
    ...input.context.diff,
    files,
  };
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
      deletionHunksPruned,
      deletedFileBodiesPruned,
    },
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
