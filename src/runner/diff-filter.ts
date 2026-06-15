import type { ChangedFile, DiffSummary, ReviewConfig } from "../contracts/index.ts";
import { matchesAnyGlob } from "./path-match.ts";

export type IgnoredFileReason = "binary" | "lockfile" | "vendored" | "generated" | "ignored_path";

// ---------------------------------------------------------------------------
// Low-signal path classifier (#218, M021)
// ---------------------------------------------------------------------------

/**
 * Path segments and extensions that identify high-confidence bulk-data / snapshot files.
 *
 * Conservative, path/dir-based only — NO content sniffing. A low-signal file STAYS in
 * review (name+stat minimum, full patch if budget allows); it is demoted preferentially
 * by the admission ranking but is NEVER fully excluded. Demote ≠ drop.
 *
 * MUST classify low-signal:
 *   - any path segment `__snapshots__/`
 *   - `*.snap` files
 *   - `*.golden` files
 *   - anything under `examples/fixtures/` (this repo's PR-fixture dir)
 *   - pure-data files (.json/.jsonl/.txt/.csv/.golden/.snap) under a `fixtures/` or
 *     `__fixtures__/` path segment (e.g. `test/fixtures/foo.json`)
 *
 * MUST NOT classify low-signal:
 *   - test *logic* files: `*.test.ts`, `*.test.tsx`, `*.spec.ts`, `*.spec.tsx`,
 *     `*.test.js`, etc. — even if they happen to live under a fixture dir
 *   - any `.ts`/`.tsx`/`.js` source file (could be a fixture *builder* with logic)
 *   - normal source files anywhere
 */
export const LOW_SIGNAL_PATTERNS = {
  /** Path segment checks (applied after normalizing `\\`→`/`). */
  segments: {
    snapshots: "__snapshots__/",
    fixtures: "fixtures/",
    fixturesAlt: "__fixtures__/",
    examplesFixtures: "examples/fixtures/",
  },
  /** File extensions that are always low-signal regardless of directory. */
  extensionsAlways: [".snap", ".golden"],
  /**
   * File extensions that are low-signal only when under a fixtures dir. (`.snap`/`.golden` are
   * intentionally NOT listed here — they are always low-signal via `extensionsAlways`, checked
   * first, so listing them here would be unreachable dead code.)
   */
  extensionsUnderFixtures: [".json", ".jsonl", ".txt", ".csv"],
  /** Extensions that are NEVER low-signal (source logic — protect even under fixture dirs). */
  sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
  /** Test-file suffixes that are NEVER low-signal. */
  testSuffixes: [
    ".test.ts",
    ".test.tsx",
    ".spec.ts",
    ".spec.tsx",
    ".test.js",
    ".test.jsx",
    ".spec.js",
    ".spec.jsx",
  ],
} as const;

/**
 * Returns `true` when `path` is a high-confidence low-signal / bulk-data file that should
 * be demoted preferentially by the patch-admission ranking (#218). Conservative: only
 * path/dir-based patterns, no content sniffing.
 *
 * Normalizes `\\`→`/` before matching (mirrors `createPatchArtifactFilename`).
 */
export function isLowSignalPath(path: string): boolean {
  const p = path.replaceAll("\\", "/");

  // MUST-NOT: test logic files are always signal-bearing. This is the load-bearing #213 invariant
  // (never demote test logic), so it is checked first and EXPLICITLY by suffix — kept as
  // intentional defense-in-depth even though the sourceExtensions guard below currently subsumes
  // every entry (e.g. `.test.ts` ends in `.ts`). If sourceExtensions is ever trimmed, this guard
  // still protects test logic.
  for (const suffix of LOW_SIGNAL_PATTERNS.testSuffixes) {
    if (p.endsWith(suffix)) {
      return false;
    }
  }

  // MUST-NOT: source files are never low-signal (even under fixture dirs).
  for (const ext of LOW_SIGNAL_PATTERNS.sourceExtensions) {
    if (p.endsWith(ext)) {
      return false;
    }
  }

  // MUST: always-low-signal extensions (.snap, .golden).
  for (const ext of LOW_SIGNAL_PATTERNS.extensionsAlways) {
    if (p.endsWith(ext)) {
      return true;
    }
  }

  // MUST: anything under __snapshots__/ is low-signal.
  if (containsPathSegment(p, LOW_SIGNAL_PATTERNS.segments.snapshots)) {
    return true;
  }

  // MUST: anything under examples/fixtures/ (this repo's PR-fixture dir).
  if (containsPathSegment(p, LOW_SIGNAL_PATTERNS.segments.examplesFixtures)) {
    return true;
  }

  // MUST: pure-data extensions under fixtures/ or __fixtures__/.
  const underFixtures =
    containsPathSegment(p, LOW_SIGNAL_PATTERNS.segments.fixtures) ||
    containsPathSegment(p, LOW_SIGNAL_PATTERNS.segments.fixturesAlt);

  if (underFixtures) {
    for (const ext of LOW_SIGNAL_PATTERNS.extensionsUnderFixtures) {
      if (p.endsWith(ext)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * True when `segment` (a dir prefix ending in `/`) appears at a PATH-SEGMENT boundary in `p`
 * (i.e. at the start, or immediately after a `/`). Boundary-anchored so a substring like
 * `fixtures/` does NOT match `src/test-fixtures/config.json` — a non-anchored `includes` would
 * over-classify such a file as low-signal and demote a potentially security-relevant data file.
 */
function containsPathSegment(p: string, segment: string): boolean {
  return p.startsWith(segment) || p.includes(`/${segment}`);
}

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
