/**
 * Prune deletion-only hunks from a unified diff patch.
 *
 * Port of PR-Agent's `omit_deletion_hunks` behaviour. The hunk-header regex and
 * per-line classification (+ = addition, - = deletion, else context; lines
 * starting with `diff --git` / `---` / `+++` are file headers, not body) mirror
 * `src/publisher/inline-readiness.ts:parsePatchLines` intentionally, but are
 * kept here as a separate implementation to respect the runner→publisher
 * architecture boundary (`bun run boundaries` blocks runner imports of publisher).
 * The return shape is different too — we need hunk *segments*, not line-number Sets.
 */

export interface PrunedPatch {
  /**
   * The reassembled patch (header lines + kept hunks), or `undefined` when no
   * hunks remain. When `undefined` the caller should write the file by name only
   * (no patch body / patchPath).
   */
  patch: string | undefined;
  /** Number of hunks that were dropped because they contained no `+` lines. */
  droppedHunks: number;
}

/**
 * Drop any hunk whose body contains no added (`+`) lines.
 *
 * - A "mixed" hunk (`-old`/`+new`) is KEPT in full, including its `-` lines.
 * - Addition-only hunks are kept.
 * - Pure-deletion or context-only hunks are dropped.
 * - Patches with no recognisable `@@` hunk header are returned unchanged
 *   (`droppedHunks: 0`) — never prune what we cannot parse.
 */
export function pruneDeletionOnlyHunks(patch: string): PrunedPatch {
  const lines = patch.split("\n");

  // Hunk-header regex — mirrors inline-readiness.ts:parsePatchLines.
  const hunkHeaderRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  // Separate the file-level header block (lines before the first @@) from hunks.
  let headerEnd = lines.length; // index of first @@ line, or lines.length if none
  for (let i = 0; i < lines.length; i++) {
    if (hunkHeaderRe.test(lines[i] ?? "")) {
      headerEnd = i;
      break;
    }
  }

  // No recognisable @@ hunk found — return unchanged.
  if (headerEnd === lines.length) {
    return { patch, droppedHunks: 0 };
  }

  const headerLines = lines.slice(0, headerEnd);

  // Segment the remainder into hunks: each @@ line starts a new hunk.
  interface Hunk {
    lines: string[];
    hasAddition: boolean;
  }
  const hunks: Hunk[] = [];

  for (let i = headerEnd; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (hunkHeaderRe.test(line)) {
      hunks.push({ lines: [line], hasAddition: false });
    } else {
      const current = hunks[hunks.length - 1];
      if (current === undefined) {
        // Shouldn't happen (headerEnd guards), but satisfy noUncheckedIndexedAccess.
        continue;
      }
      current.lines.push(line);
      // Classify: a body line starting with `+` is an addition. File-header lines
      // (`diff --git`, `---`, `+++ b/path`) only ever precede the first `@@`, so they
      // land in `headerLines` and never reach here — which means a hunk-body line
      // starting with `+++` is a genuine addition whose source content starts with
      // `++` (e.g. a `++counter;` pre-increment) and MUST count. Guarding on `+++`
      // here would false-negative such hunks and silently prune real added content
      // from reviewer context (#144 review).
      if (line.startsWith("+")) {
        current.hasAddition = true;
      }
    }
  }

  // Keep only hunks that have at least one added line.
  let droppedHunks = 0;
  const keptHunks: string[][] = [];
  for (const hunk of hunks) {
    if (hunk.hasAddition) {
      keptHunks.push(hunk.lines);
    } else {
      droppedHunks += 1;
    }
  }

  // No hunks survive — signal caller to write file name-only.
  if (keptHunks.length === 0) {
    return { patch: undefined, droppedHunks };
  }

  // Reassemble: header block + kept hunks, preserving original line content exactly.
  const reassembled = [...headerLines, ...keptHunks.flat()].join("\n");
  return { patch: reassembled, droppedHunks };
}
