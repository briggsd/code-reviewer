/**
 * Budget-tiered patch admission gate (#145, M019 Reliability; signal-aware ranking #218, M021).
 *
 * Runs BEFORE the model call: when the total post-pruning patch bytes exceed the per-tier
 * byte budget, this module ranks files and greedily admits them until the budget is reached,
 * demoting the rest to name+stat only. This is a graceful degradation, NOT a hard failure —
 * the run continues with a clearly-marked partial-by-size review.
 *
 * Ranking (over-budget only): 1) signal-bearing files (lowSignal=false) before low-signal
 * bulk (lowSignal=true); 2) patchBytes ascending; 3) path ascending. This ensures logic files
 * win the byte budget when a diff is dominated by test fixtures / snapshots / generated data.
 * The fast path (under budget) admits everything and is unchanged.
 *
 * Pure module: no I/O, no imports from concrete adapters.
 */

export interface AdmissionFileEntry {
  /** Repo-relative file path. */
  path: string;
  /** Post-pruning patch byte size (Buffer.byteLength of the pruned patch body). */
  patchBytes: number;
  /**
   * When `true`, this file is a low-signal bulk-data file (test fixture, snapshot, generated
   * data) and should be demoted preferentially to preserve budget for signal-bearing logic
   * files. Set via `isLowSignalPath` from `diff-filter.ts`. (#218)
   */
  lowSignal?: boolean;
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
  /**
   * Count of demoted files that were classified as low-signal (lowSignal===true). Counts-only
   * per M008 — no file paths or content. 0 on the fast path (no demotion). (#218)
   */
  lowSignalDemotedFileCount: number;
}

/**
 * Decide which files get full patch admission vs. name+stat-only demotion.
 *
 * Algorithm:
 * - If total bytes ≤ budget → admit all, `degraded: false`, `lowSignalDemotedFileCount: 0`.
 * - Else: sort files by 3-key comparator — `lowSignal` asc (false before true), then
 *   `patchBytes` asc, then `path` asc — greedily admit while
 *   `admittedBytes + next.patchBytes <= budgetBytes`, demote the rest. Signal-bearing logic
 *   files win the budget; low-signal bulk (fixtures, snapshots) is demoted preferentially.
 *   Leftover budget may still admit small low-signal files (fine). (#218)
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
      lowSignalDemotedFileCount: 0,
    };
  }

  // Over budget: 3-key sort — lowSignal asc (false < true), patchBytes asc, path asc.
  // Signal-bearing files (lowSignal=false/undefined) rank before low-signal bulk so that
  // logic wins the byte budget.
  const sorted = [...files].sort((a, b) => {
    const aLow = a.lowSignal === true ? 1 : 0;
    const bLow = b.lowSignal === true ? 1 : 0;
    if (aLow !== bLow) {
      return aLow - bLow;
    }
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
  const demotedEntries = sorted.filter((f) => !admittedPaths.has(f.path));
  const demotedPaths = demotedEntries.map((f) => f.path);
  const lowSignalDemotedFileCount = demotedEntries.filter((f) => f.lowSignal === true).length;

  return {
    admittedPaths,
    demotedPaths,
    originalBytes,
    admittedBytes,
    budgetBytes,
    degraded: true,
    lowSignalDemotedFileCount,
  };
}
