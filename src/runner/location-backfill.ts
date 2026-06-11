import type { DiffSummary, Finding, FindingLocation } from "../contracts/index.ts";
// Shared with evidence-grounding so backfill matches exactly the changed-line text grounding
// passed — see text-normalize.ts for why this is imported, not copied (#87 review).
import { normalizeForMatch as normalize } from "./text-normalize.ts";

// A small floor avoids locating on trivially short quotes; mirrors the same
// constant in evidence-grounding.ts (a single 8-char value, low drift risk).
const MIN_CHECKABLE_QUOTE_LENGTH = 8;

export interface LocationBackfillResult {
  findings: Finding[];
  backfilledCount: number;
}

/**
 * A single entry in the new-side line index: the absolute new-side line
 * number and the normalized content of that line (without the leading +/ column).
 *
 * Only RIGHT-side (new-side) locations are produced. Removed-line (LEFT)
 * backfill is out of scope — a removed line has no new-side coordinate, so
 * there is no authoritative inline anchor to set.
 */
interface NewSideEntry {
  path: string;
  newLine: number;
  content: string; // normalized
}

/**
 * Parse the unified-diff patch for one file and emit a new-side line index.
 *
 * Walk rules (per spec):
 * - Hunk header `@@ -oldStart,oldLen +newStart,newLen @@` → set newCursor = newStart.
 * - `+` (added) line: record {path, newLine: newCursor, content}, then newCursor++.
 * - ` ` (context) line: record {path, newLine: newCursor, content}, then newCursor++.
 * - `-` (removed) line: do NOT record, do NOT advance newCursor.
 * - Skip diff/index/--- /+++ scaffolding lines.
 */
function buildNewSideIndex(path: string, patch: string): NewSideEntry[] {
  const entries: NewSideEntry[] = [];
  let newCursor: number | undefined;

  for (const rawLine of patch.split("\n")) {
    // Hunk header — set the new-side cursor
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunkMatch !== null) {
      newCursor = Number(hunkMatch[1]);
      continue;
    }

    // Skip scaffolding lines
    if (
      rawLine.startsWith("diff ") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("+++ ")
    ) {
      continue;
    }

    // Only process body lines once we've seen a hunk header
    if (newCursor === undefined) {
      continue;
    }

    if (rawLine.startsWith("+")) {
      const content = normalize(rawLine.slice(1));
      entries.push({ path, newLine: newCursor, content });
      newCursor++;
    } else if (rawLine.startsWith(" ")) {
      const content = normalize(rawLine.slice(1));
      entries.push({ path, newLine: newCursor, content });
      newCursor++;
    } else if (rawLine.startsWith("-")) {
      // Removed line: gone from the new side — do NOT record and do NOT advance newCursor.
    }
    // Lines that don't start with +, -, or space (e.g. empty lines at hunk boundary)
    // are ignored.
  }

  return entries;
}

/**
 * Backfill `location` on findings that have `quotedCode` but no usable line number.
 *
 * Semantics (per spec):
 * - Candidate: finding has no usable line (`location` is absent OR
 *   `(location.line ?? location.startLine)` is undefined) AND has at least one
 *   `quotedCode` entry whose normalized first physical line is ≥ MIN_CHECKABLE_QUOTE_LENGTH.
 * - For each candidate, take its first checkable quotedCode entry, extract its first
 *   non-empty line, normalize it, and search the new-side index for the first entry
 *   whose normalized content *contains* that normalized line.
 * - On a match, overwrite (or create) `finding.location` with
 *   `{ path, line: entry.newLine, side: "RIGHT" }`.
 * - On no match, leave the finding unchanged.
 * - Preserve finding order. Return the new array and the count actually backfilled.
 *
 * Only RIGHT-side (new-side) locations are produced. LEFT-side (removed-line)
 * backfill is out of scope.
 */
export function backfillFindingLocations(
  findings: readonly Finding[],
  diff: DiffSummary,
): LocationBackfillResult {
  // Build the new-side index once from all changed files that have a patch.
  const index: NewSideEntry[] = [];
  for (const file of diff.files) {
    // Skip binary and lockfiles: no useful backfill target, and a huge lockfile patch would build
    // tens of thousands of entries. (Append entry-by-entry — spreading a large array into push hits
    // V8's argument-list limit and throws a RangeError on big patches — #87 review.)
    if (file.isBinary || file.isLockfile === true) {
      continue;
    }
    const patch = file.patch;
    if (patch === undefined || patch.length === 0) {
      continue;
    }
    for (const entry of buildNewSideIndex(file.path, patch)) {
      index.push(entry);
    }
  }

  const result: Finding[] = [];
  let backfilledCount = 0;

  for (const finding of findings) {
    const location = finding.location;
    const usableLine = location !== undefined
      ? (location.line ?? location.startLine)
      : undefined;

    // Not a candidate if the finding already has a usable line.
    if (usableLine !== undefined) {
      result.push(finding);
      continue;
    }

    // Determine the first checkable quotedCode entry.
    const quotedCode = finding.quotedCode;
    if (quotedCode === undefined || quotedCode.length === 0) {
      result.push(finding);
      continue;
    }

    // Find the first entry whose first physical line meets the length threshold.
    let firstCheckableLine: string | undefined;
    for (const entry of quotedCode) {
      // Split on \n, take the first non-empty raw line, then normalize.
      const rawLines = entry.split("\n");
      for (const rawLine of rawLines) {
        const normalized = normalize(rawLine);
        if (normalized.length >= MIN_CHECKABLE_QUOTE_LENGTH) {
          firstCheckableLine = normalized;
          break;
        }
      }
      if (firstCheckableLine !== undefined) {
        break;
      }
    }

    if (firstCheckableLine === undefined) {
      // All quotedCode entries are sub-threshold — not a candidate.
      result.push(finding);
      continue;
    }

    // Search the new-side index for the first entry whose content contains the normalized quote line.
    // If the reviewer supplied a path hint (path known, line missing), constrain the search to that
    // file so a same-text line in another file can't overwrite the correct path with a wrong one
    // (#87 review). With no path hint, search globally.
    const pathHint = location?.path;
    let matched: NewSideEntry | undefined;
    for (const indexEntry of index) {
      if (pathHint !== undefined && indexEntry.path !== pathHint) {
        continue;
      }
      if (indexEntry.content.includes(firstCheckableLine)) {
        matched = indexEntry;
        break;
      }
    }

    if (matched === undefined) {
      // No match — leave the finding unchanged.
      result.push(finding);
      continue;
    }

    // Backfill: create an authoritative RIGHT-side location.
    // Overwrite any partial location since the matched coordinate is authoritative.
    const backfilledLocation: FindingLocation = {
      path: matched.path,
      line: matched.newLine,
      side: "RIGHT",
    };

    result.push({ ...finding, location: backfilledLocation });
    backfilledCount++;
  }

  return { findings: result, backfilledCount };
}
