/**
 * Pure rules engine for the docs-freshness checker.
 *
 * BLOCKING (fail the check):
 *  - dead path reference — an inline-code path anchored on a real top-level repo
 *    entry, or a markdown link target, that does not resolve to an existing path.
 *  - dead `bun run` script — a script name not present in package.json.
 *
 * ADVISORY (informational only, never affects exit code):
 *  - `AI_REVIEW_*` env var referenced in docs but absent from the code/CI
 *    source-of-truth (renamed/removed var, or an illustrative adoption example).
 *  - oversized live doc (> threshold lines) — a staleness smell.
 *  - a `src/<dir>/` module missing from the CLAUDE.md repo map.
 */

import { extractReferences, normalizePathToken } from "./extract.ts";
import type { DocCheckReport, DocFinding, DocInput, KnownFacts } from "./types.ts";

export interface CheckOptions {
  /** Lines above which a live doc earns an oversized-doc advisory. Default 200. */
  oversizedLineThreshold?: number;
  /** Doc whose repo map must mention every `src/<dir>/`. Default "CLAUDE.md". */
  repoMapDoc?: string;
}

const DEFAULT_OVERSIZED_THRESHOLD = 200;
const DEFAULT_REPO_MAP_DOC = "CLAUDE.md";

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

/**
 * Resolve a doc-relative (or root-relative) link target to a repo-root-relative
 * path. Returns null when the target escapes the repo root (unverifiable).
 */
function resolveRelative(docPath: string, target: string): string | null {
  const base = target.startsWith("/") ? [] : dirOf(docPath).split("/").filter(Boolean);
  const out = [...base];
  for (const seg of target.replace(/^\/+/, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/** Top-level repo entries (first path segment of every known path). */
function topLevelEntries(existingPaths: ReadonlySet<string>): Set<string> {
  const set = new Set<string>();
  for (const p of existingPaths) {
    const first = p.split("/")[0];
    if (first !== undefined && first.length > 0) set.add(first);
  }
  return set;
}

/** Module directories directly under `src/` (those that contain files). */
function srcModuleDirs(existingPaths: ReadonlySet<string>): Set<string> {
  const set = new Set<string>();
  for (const p of existingPaths) {
    const m = /^src\/([^/]+)\//.exec(p);
    if (m?.[1]) set.add(m[1]);
  }
  return set;
}

export function checkDocs(
  docs: readonly DocInput[],
  facts: KnownFacts,
  options: CheckOptions = {},
): DocCheckReport {
  const oversized = options.oversizedLineThreshold ?? DEFAULT_OVERSIZED_THRESHOLD;
  const repoMapDoc = options.repoMapDoc ?? DEFAULT_REPO_MAP_DOC;
  const topLevel = topLevelEntries(facts.existingPaths);

  const blocking: DocFinding[] = [];
  const advisory: DocFinding[] = [];

  for (const doc of docs) {
    const refs = extractReferences(doc.text);

    // env-var advisory runs on every doc (live + historical)
    for (const ref of refs.envVars) {
      if (!facts.envVarNames.has(ref.raw)) {
        advisory.push({
          doc: doc.path,
          line: ref.line,
          reference: ref.raw,
          message: `references ${ref.raw}, not found in any code/CI source-of-truth (renamed/removed env var, or an illustrative example)`,
        });
      }
    }

    if (doc.scope !== "live") continue;

    // unclosed code fence → the remainder of the doc is blanked and not checked
    if (refs.unclosedFence) {
      advisory.push({
        doc: doc.path,
        line: refs.unclosedFenceLine ?? 1,
        reference: doc.path,
        message: "has an unclosed ``` code fence — path/link references after it are NOT validated",
      });
    }

    // dead inline-code paths (anchored on a real top-level repo entry)
    for (const ref of refs.inlinePaths) {
      const path = normalizePathToken(ref.raw);
      const first = path.split("/")[0];
      if (first === undefined || !topLevel.has(first)) continue; // external / not repo-rooted
      if (!facts.existingPaths.has(path)) {
        blocking.push({
          doc: doc.path,
          line: ref.line,
          reference: ref.raw,
          message: `path \`${path}\` does not exist`,
        });
      }
    }

    // dead markdown link targets (resolved relative to the doc's directory).
    // Only flag when the target's PARENT directory is tracked — a link into an
    // untracked/gitignored/generated area (whose parent dir is absent) is skipped,
    // mirroring the inline-path branch's precision-first stance.
    for (const ref of refs.linkPaths) {
      const resolved = resolveRelative(doc.path, normalizePathToken(ref.raw));
      if (resolved === null || resolved.length === 0) continue;
      if (facts.existingPaths.has(resolved)) continue;
      const parent = dirOf(resolved);
      if (parent.length > 0 && !facts.existingPaths.has(parent)) continue; // untracked/external area
      blocking.push({
        doc: doc.path,
        line: ref.line,
        reference: ref.raw,
        message: `link target resolves to \`${resolved}\`, which does not exist`,
      });
    }

    // dead `bun run` script references
    for (const ref of refs.scripts) {
      if (!facts.scriptNames.has(ref.raw)) {
        blocking.push({
          doc: doc.path,
          line: ref.line,
          reference: ref.raw,
          message: `\`bun run ${ref.raw}\` references a script not defined in package.json`,
        });
      }
    }

    // oversized-doc advisory (live docs only) — reuse the split from extraction
    const lineCount = refs.lineCount;
    if (lineCount > oversized) {
      advisory.push({
        doc: doc.path,
        line: 1,
        reference: doc.path,
        message: `is ${lineCount} lines (> ${oversized}) — review for staleness/splitting`,
      });
    }

    // count-drift advisory (#276 / M027): when countFacts are provided, compare
    // any `(~N label)` claim against the live ground truth. Fires only when the
    // drift exceeds 25% (|claimed − actual| / actual > 0.25) — gross staleness,
    // not pedantic rounding. Advisory only, never blocking.
    if (facts.countFacts !== undefined && facts.countFacts.size > 0) {
      for (const claim of refs.countClaims) {
        const actual = facts.countFacts.get(claim.label);
        if (actual === undefined) continue; // no fact registered for this label
        if (actual === 0) continue; // avoid division by zero
        const drift = Math.abs(claim.count - actual) / actual;
        if (drift > 0.25) {
          advisory.push({
            doc: doc.path,
            line: claim.line,
            reference: claim.raw,
            message: `count-drift: doc says ${claim.raw} (${claim.label}) but live count is ${actual} (${Math.round(drift * 100)}% off — update the doc)`,
          });
        }
      }
    }
  }

  // repo-map coverage advisory: every src/<dir>/ must appear in the map doc.
  // The map lists modules as bare `runner/` (indented under a `src/` heading), so
  // we match `dir/` at a boundary (line start / whitespace / `/` / backtick) rather
  // than a bare substring — `runner/` in the map matches, prose like `task-runner/`
  // does not (and would no longer suppress the advisory).
  const mapDoc = docs.find((d) => d.path === repoMapDoc);
  if (mapDoc) {
    for (const dir of srcModuleDirs(facts.existingPaths)) {
      if (!boundaryMentions(mapDoc.text, dir)) {
        advisory.push({
          doc: repoMapDoc,
          line: 1,
          reference: `src/${dir}/`,
          message: `module \`src/${dir}/\` is not mentioned in the ${repoMapDoc} repo map`,
        });
      }
    }
  }

  return { blocking: dedupe(blocking), advisory: dedupe(advisory) };
}

/** True if `dir/` appears in `text` at a token boundary (not mid-word). */
function boundaryMentions(text: string, dir: string): boolean {
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s/\`(])${escaped}/`, "m").test(text);
}

function dedupe(findings: readonly DocFinding[]): DocFinding[] {
  const seen = new Set<string>();
  const out: DocFinding[] = [];
  for (const f of findings) {
    const key = `${f.doc}::${f.line}::${f.reference}::${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}
