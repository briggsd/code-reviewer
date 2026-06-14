/**
 * Budget-tiered patch admission gate (#145, M019 Reliability).
 *
 * Runs BEFORE the model call: when the total post-pruning patch bytes exceed the per-tier
 * byte budget, this module ranks files (smallest-first) and greedily admits them until the
 * budget is reached, demoting the rest to name+stat only. This is a graceful degradation,
 * NOT a hard failure — the run continues with a clearly-marked partial-by-size review.
 *
 * Pure module: no I/O, no imports from concrete adapters.
 */

export interface AdmissionFileEntry {
  /** Repo-relative file path. */
  path: string;
  /** Post-pruning patch byte size (Buffer.byteLength of the pruned patch body). */
  patchBytes: number;
}

export interface AdmissionInput {
  /** Post-pruning, per-file patch byte sizes. Fully-deleted files (no patch body) are excluded. */
  files: AdmissionFileEntry[];
  /** Byte budget for this tier (from tier-profile default or config override). */
  budgetBytes: number;
}

export interface AdmissionDecision {
  /** Paths that will have their full patch written to disk. */
  admittedPaths: Set<string>;
  /**
   * Paths demoted to name+stat only, in deterministic ranking order (smallest-first, path tiebreak).
   * When `degraded` is false, this is empty.
   */
  demotedPaths: string[];
  /** Total patch bytes across ALL files (admitted + demoted). */
  originalBytes: number;
  /** Total patch bytes for ADMITTED files only. */
  admittedBytes: number;
  /** The budget used for this decision. */
  budgetBytes: number;
  /** True when any file was demoted (originalBytes > budgetBytes). */
  degraded: boolean;
}

/**
 * Decide which files get full patch admission vs. name+stat-only demotion.
 *
 * Algorithm:
 * - If total bytes ≤ budget → admit all, `degraded: false`.
 * - Else: sort files ascending by `patchBytes` (tiebreak: path ascending), greedily admit
 *   while `admittedBytes + next.patchBytes <= budgetBytes`, demote the rest.
 * - Graceful floor: if even the single smallest file exceeds the budget, admit nothing and
 *   demote all (never a hard fail — the review continues with name-only context).
 */
export function decidePatchAdmission(input: AdmissionInput): AdmissionDecision {
  const { files, budgetBytes } = input;

  const originalBytes = files.reduce((sum, f) => sum + f.patchBytes, 0);

  // Fast path: under budget — admit everything.
  if (originalBytes <= budgetBytes) {
    return {
      admittedPaths: new Set(files.map((f) => f.path)),
      demotedPaths: [],
      originalBytes,
      admittedBytes: originalBytes,
      budgetBytes,
      degraded: false,
    };
  }

  // Over budget: sort ascending by patchBytes, tiebreak by path ascending.
  const sorted = [...files].sort((a, b) => {
    if (a.patchBytes !== b.patchBytes) {
      return a.patchBytes - b.patchBytes;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  const admittedPaths = new Set<string>();
  let admittedBytes = 0;

  for (const file of sorted) {
    if (admittedBytes + file.patchBytes <= budgetBytes) {
      admittedPaths.add(file.path);
      admittedBytes += file.patchBytes;
    }
    // Once the next file would exceed the budget, stop admitting.
    // (Remaining files will all be demoted because the list is sorted ascending.)
  }

  // Demoted paths in the same deterministic order (the files NOT admitted, in rank order).
  const demotedPaths = sorted.filter((f) => !admittedPaths.has(f.path)).map((f) => f.path);

  return {
    admittedPaths,
    demotedPaths,
    originalBytes,
    admittedBytes,
    budgetBytes,
    degraded: true,
  };
}
