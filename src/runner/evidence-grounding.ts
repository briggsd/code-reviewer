import type { DiffSummary, Finding } from "../contracts/index.ts";
import { isLowSignalPath } from "./diff-filter.ts";
import { matchesAnyGlob } from "./path-match.ts";
import { normalizeForMatch as normalize } from "./text-normalize.ts";

// A small floor avoids dropping on trivially short quotes; quotedCode is verbatim
// so a modest length suffices.
const MIN_CHECKABLE_QUOTE_LENGTH = 8;

/**
 * Normalize a file path for changed-file set membership checks.
 * Intentionally mirrors stable-finding-id.ts `normalizePath` (do NOT import across modules —
 * keeping evidence-grounding.ts self-contained).
 */
function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

export interface FindingGroundingAssessment {
  grounded: Finding[]; // keep — order preserved
  dropped: Finding[]; // fabricated-quote findings to withhold
  corpusStats: FindingGroundingCorpusStats;
}

export interface FindingGroundingCorpusStats {
  fullContentAvailableCount: number;
  fullContentIncludedCount: number;
  fullContentSkippedByBudgetCount: number;
  fullContentIncludedBytes: number;
  fullContentBudgetBytes?: number;
}

export interface FindingGroundingOptions {
  /**
   * Full PR/MR-head file bodies for changed files. Untrusted content for deterministic matching
   * only; callers must not put this map on ReviewContext, prompt payloads, artifacts, telemetry, or
   * summaries.
   */
  changedFileContents?: Readonly<Record<string, string>> | undefined;
  /** Byte budget for the full-content corpus. Mirrors the per-tier patch admission budget. */
  fullContentBudgetBytes?: number;
  /** Sensitive files are ranked as signal-bearing even if their path resembles low-signal bulk. */
  sensitivePaths?: readonly string[];
}

/**
 * Build a normalized searchable corpus from a DiffSummary.
 *
 * Steps:
 * 1. Collect each file's patch string (skip undefined/empty).
 * 2. Drop unified-diff scaffolding lines (@@, diff , index , --- , +++ ).
 * 3. For body lines, strip a single leading +/- /space column character. ALL changed lines are
 *    included — added (+), removed (-), and context ( ) — because a finding may legitimately quote
 *    any of them (e.g. flagging a dangerous *deletion* by quoting the removed line). Including a
 *    removed line can let a fabricated quote of removed code ground, but that only *keeps* a finding
 *    (the safe direction); dropping a real deletion finding would not be.
 * 4. Join the stripped lines and normalize the WHOLE corpus once, so its newlines collapse to
 *    spaces exactly as normalize() collapses the newlines inside a multi-line quotedCode entry —
 *    otherwise a multi-line quote could never match (and a dropped critical could flip the gate).
 */
const EMPTY_CORPUS_STATS: FindingGroundingCorpusStats = {
  fullContentAvailableCount: 0,
  fullContentIncludedCount: 0,
  fullContentSkippedByBudgetCount: 0,
  fullContentIncludedBytes: 0,
};

function buildPatchCorpusByPath(diff: DiffSummary): Map<string, string> {
  const partsByPath = new Map<string, string[]>();

  for (const file of diff.files) {
    const patch = file.patch;
    if (patch === undefined || patch.length === 0) {
      continue;
    }

    const path = normalizePath(file.path);
    const parts = partsByPath.get(path) ?? [];
    const lines = patch.split("\n");
    for (const line of lines) {
      if (isDiffScaffoldingLine(line)) {
        continue;
      }

      parts.push(stripUnifiedDiffColumn(line));
    }
    partsByPath.set(path, parts);
  }

  return new Map([...partsByPath].map(([path, parts]) => [path, normalize(parts.join("\n"))]));
}

function isDiffScaffoldingLine(line: string): boolean {
  return DIFF_SCAFFOLDING_PREFIXES.some((prefix) => line.startsWith(prefix));
}

const DIFF_SCAFFOLDING_PREFIXES = ["@@", "diff ", "index ", "--- ", "+++ "] as const;

function stripUnifiedDiffColumn(line: string): string {
  return line.length > 0 && DIFF_COLUMN_PREFIXES.has(line[0] ?? "") ? line.slice(1) : line;
}

const DIFF_COLUMN_PREFIXES = new Set(["+", "-", " "]);

interface FullContentCandidate {
  path: string;
  content: string;
  bytes: number;
  lowSignal: boolean;
}

function buildFullContentCorpusByPath(
  diff: DiffSummary,
  options: FindingGroundingOptions,
): { corpusByPath: Map<string, string>; stats: FindingGroundingCorpusStats } {
  const contents = options.changedFileContents;
  const budgetBytes = options.fullContentBudgetBytes;
  if (contents === undefined || budgetBytes === undefined || budgetBytes <= 0) {
    return emptyFullContentCorpus(budgetBytes);
  }

  const candidates = collectFullContentCandidates(diff, contents, options.sensitivePaths ?? []);
  const ranked = rankFullContentCandidates(candidates, budgetBytes);

  const included = new Set<string>();
  let includedBytes = 0;
  for (const candidate of ranked) {
    if (includedBytes + candidate.bytes <= budgetBytes) {
      included.add(candidate.path);
      includedBytes += candidate.bytes;
    }
  }

  const corpusByPath = new Map<string, string>();
  for (const candidate of candidates) {
    if (included.has(candidate.path)) {
      corpusByPath.set(candidate.path, normalize(candidate.content));
    }
  }

  return {
    corpusByPath,
    stats: {
      fullContentAvailableCount: candidates.length,
      fullContentIncludedCount: included.size,
      fullContentSkippedByBudgetCount: candidates.length - included.size,
      fullContentIncludedBytes: includedBytes,
      fullContentBudgetBytes: budgetBytes,
    },
  };
}

function emptyFullContentCorpus(budgetBytes: number | undefined): {
  corpusByPath: Map<string, string>;
  stats: FindingGroundingCorpusStats;
} {
  return {
    corpusByPath: new Map(),
    stats:
      budgetBytes === undefined
        ? EMPTY_CORPUS_STATS
        : { ...EMPTY_CORPUS_STATS, fullContentBudgetBytes: budgetBytes },
  };
}

function collectFullContentCandidates(
  diff: DiffSummary,
  contents: Readonly<Record<string, string>>,
  sensitivePaths: readonly string[],
): FullContentCandidate[] {
  const contentByNormalizedPath = new Map(
    Object.entries(contents).map(([path, content]) => [normalizePath(path), content]),
  );
  const candidates: FullContentCandidate[] = [];

  for (const file of diff.files) {
    if (file.isBinary || file.status === "deleted") {
      continue;
    }

    const path = normalizePath(file.path);
    const content = contentByNormalizedPath.get(path);
    if (content === undefined) {
      continue;
    }

    candidates.push({
      path,
      content,
      bytes: Buffer.byteLength(content, "utf8"),
      lowSignal: !matchesAnyGlob(file.path, sensitivePaths) && isLowSignalPath(file.path),
    });
  }

  return candidates;
}

function rankFullContentCandidates(
  candidates: readonly FullContentCandidate[],
  budgetBytes: number,
): readonly FullContentCandidate[] {
  const originalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  return originalBytes <= budgetBytes
    ? candidates
    : [...candidates].sort(compareFullContentCandidates);
}

function compareFullContentCandidates(a: FullContentCandidate, b: FullContentCandidate): number {
  const aLow = a.lowSignal ? 1 : 0;
  const bLow = b.lowSignal ? 1 : 0;
  if (aLow !== bLow) {
    return aLow - bLow;
  }
  if (a.bytes !== b.bytes) {
    return a.bytes - b.bytes;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * Assess whether each finding's quotedCode is grounded in the diff corpus.
 *
 * Partition rule — a finding goes to `dropped` iff:
 *   - finding.quotedCode is present with ≥1 checkable quote (length >= MIN_CHECKABLE_QUOTE_LENGTH), AND
 *   - none of its checkable quotes appears as a substring of the normalized corpus of ANY changed
 *     file (patch or full-content, across the whole changeset, #393).
 *
 * No-quote carve-out: a finding with no quotedCode (undefined/empty) or only sub-threshold
 * quotes is ALWAYS kept in `grounded` at full confidence and CAN block the CI gate. There is
 * no fabricated-location risk when there is no checkable quote to verify — dropping such a
 * finding would silently discard valid structural/architectural observations that simply did
 * not cite a specific code line.
 *
 * Caller contract (#207): the `dropped` set is NOT silently discarded by the caller. Each
 * dropped finding is down-weighted to `confidence: "low"` and kept visible in the labeled
 * low-confidence render block (non-blocking, excluded from the gate/title/findingIds). The
 * partition itself is unchanged here; #214 is the full-file-corpus promoter that reinstates
 * blocking eligibility for findings citing unchanged regions of changed files.
 *
 * Cross-file grounding (#393): a finding located in changed file A whose quotedCode matches
 * ANY changed file's corpus (patch or full-content) is GROUNDED. Cross-file findings are
 * real — e.g. a stale version string in action.yml flagged against package.json, or a
 * default URL inconsistency spanning two files. The fabrication guard (#207) and scope gate
 * (#73) are both preserved: a quote that matches NOWHERE in the changeset is still DROPPED,
 * and only findings whose location.path is a changed file are even eligible to be dropped.
 */
export function assessFindingGrounding(
  findings: readonly Finding[],
  diff: DiffSummary,
  options: FindingGroundingOptions = {},
): FindingGroundingAssessment {
  // When the diff is truncated the corpus is incomplete, so a legitimate quote may be absent
  // from it. Never drop on a partial corpus — keep every finding (the #54.2 filter must not
  // hide real findings; correctness over savings).
  if (diff.truncated) {
    return { grounded: [...findings], dropped: [], corpusStats: EMPTY_CORPUS_STATS };
  }

  const patchCorpusByPath = buildPatchCorpusByPath(diff);
  const fullContent = buildFullContentCorpusByPath(diff, options);

  // Build the set of changed-file paths so we can scope the drop gate.
  // Only findings whose location.path is itself a changed file are eligible to be dropped —
  // staleness/absence findings (e.g. "you forgot to update docs/X") legitimately cite files
  // that were NOT changed, so dropping them on a diff-corpus miss is a false positive (#73).
  const changedFilePaths = new Set(diff.files.map((f) => normalizePath(f.path)));

  // Precompute flat arrays of all changed files' corpora for whole-changeset matching (#393).
  // Iterate per-file arrays rather than concatenating into one string — concatenation can
  // create a false match across a file boundary.
  const allPatchCorpora = [...patchCorpusByPath.values()];
  const allFullContentCorpora = [...fullContent.corpusByPath.values()];

  const grounded: Finding[] = [];
  const dropped: Finding[] = [];

  for (const finding of findings) {
    // Scope gate: only findings whose location.path is a CHANGED file are eligible to be
    // dropped. A finding with no location, no location.path, or a path that is not in the
    // changed-file set is always kept — we cannot refute it by checking the diff corpus.
    const locationPath = finding.location?.path;
    if (locationPath === undefined || !changedFilePaths.has(normalizePath(locationPath))) {
      grounded.push(finding);
      continue;
    }

    const quotedCode = finding.quotedCode;

    // No quotedCode or empty array → always keep (cannot be mechanically refuted)
    if (quotedCode === undefined || quotedCode.length === 0) {
      grounded.push(finding);
      continue;
    }

    // Collect checkable (above-threshold) quotes
    const checkableQuotes = quotedCode
      .map((q) => normalize(q))
      .filter((q) => q.length >= MIN_CHECKABLE_QUOTE_LENGTH);

    // No checkable quotes (all sub-threshold) → always keep
    if (checkableQuotes.length === 0) {
      grounded.push(finding);
      continue;
    }

    // Drop iff none of the checkable quotes is a substring of ANY changed file's corpus
    // (patch or full-content, whole changeset, #393). Cross-file findings — e.g. a finding
    // located in file A whose quotedCode comes from file B — are grounded as long as the
    // quote exists somewhere in the changeset. The hunk corpus keeps deleted-line findings
    // eligible; the optional full-content corpus promotes real quotes from unchanged regions.
    // A quote matching NOWHERE in the changeset is still DROPPED (fabrication guard intact).
    const anyGrounded = checkableQuotes.some(
      (q) =>
        allPatchCorpora.some((c) => c.includes(q)) ||
        allFullContentCorpora.some((c) => c.includes(q)),
    );
    if (anyGrounded) {
      grounded.push(finding);
    } else {
      dropped.push(finding);
    }
  }

  return { grounded, dropped, corpusStats: fullContent.stats };
}
