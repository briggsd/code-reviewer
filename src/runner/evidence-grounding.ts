import type { DiffSummary, Finding } from "../contracts/index.ts";

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
  grounded: Finding[];  // keep — order preserved
  dropped: Finding[];   // fabricated-quote findings to withhold
}

/**
 * Normalize a text fragment for grounding comparison.
 * Applies Unicode NFC, collapses all whitespace sequences to a single space,
 * and trims. Zero-width / control chars (e.g. U+200B) are intentionally NOT
 * stripped so that a fabricated quote containing such characters cannot
 * trivially match a clean corpus.
 */
function normalize(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
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
function buildCorpus(diff: DiffSummary): string {
  const parts: string[] = [];

  for (const file of diff.files) {
    const patch = file.patch;
    if (patch === undefined || patch.length === 0) {
      continue;
    }

    const lines = patch.split("\n");
    for (const line of lines) {
      // Drop unified-diff scaffolding lines
      if (
        line.startsWith("@@") ||
        line.startsWith("diff ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        continue;
      }

      // Strip a single leading column char (+, -, or space); keep the line content.
      const stripped = line.length > 0 && (line[0] === "+" || line[0] === "-" || line[0] === " ")
        ? line.slice(1)
        : line;

      parts.push(stripped);
    }
  }

  return normalize(parts.join("\n"));
}

/**
 * Assess whether each finding's quotedCode is grounded in the diff corpus.
 *
 * Drop rule: a finding goes to `dropped` iff:
 *   - finding.quotedCode is present with ≥1 checkable quote (length >= MIN_CHECKABLE_QUOTE_LENGTH), AND
 *   - none of its checkable quotes appears as a substring of the normalized corpus.
 *
 * A finding with no quotedCode (undefined/empty) or only sub-threshold quotes is ALWAYS kept.
 */
export function assessFindingGrounding(
  findings: readonly Finding[],
  diff: DiffSummary,
): FindingGroundingAssessment {
  // When the diff is truncated the corpus is incomplete, so a legitimate quote may be absent
  // from it. Never drop on a partial corpus — keep every finding (the #54.2 filter must not
  // hide real findings; correctness over savings).
  if (diff.truncated) {
    return { grounded: [...findings], dropped: [] };
  }

  const corpus = buildCorpus(diff);

  // Build the set of changed-file paths so we can scope the drop gate.
  // Only findings whose location.path is itself a changed file are eligible to be dropped —
  // staleness/absence findings (e.g. "you forgot to update docs/X") legitimately cite files
  // that were NOT changed, so dropping them on a diff-corpus miss is a false positive (#73).
  const changedFilePaths = new Set(diff.files.map((f) => normalizePath(f.path)));

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

    // Drop iff none of the checkable quotes is a substring of the corpus
    const anyGrounded = checkableQuotes.some((q) => corpus.includes(q));
    if (anyGrounded) {
      grounded.push(finding);
    } else {
      dropped.push(finding);
    }
  }

  return { grounded, dropped };
}
