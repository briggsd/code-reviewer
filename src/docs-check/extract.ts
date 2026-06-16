/**
 * Pure reference extraction from markdown text.
 *
 * Three reference kinds are extracted, each with a deliberately narrow surface
 * to keep the downstream BLOCKING check free of false positives:
 *
 *  - path refs   — repo-relative paths from inline code spans and markdown link
 *                  targets. Fenced code blocks are stripped first, so arbitrary
 *                  code (imports, `uses: actions/checkout@v4`, YAML) never leaks
 *                  in as a "path". The check itself anchors inline-span paths on
 *                  real top-level repo entries; link targets resolve doc-relative.
 *  - script refs — the token after `bun run` (scanned over the FULL text, since
 *                  the canonical examples live in ```bash fences). A token with a
 *                  slash/dot is a path arg, not a script name.
 *  - env refs    — `AI_REVIEW_*` tokens (scanned over the full text).
 */

/** A reference found in a doc, with its 1-based line number. */
interface FoundReference {
  /** The reference token as written (placeholders/URLs already filtered out). */
  raw: string;
  line: number;
}

export interface DocReferences {
  /** Paths from inline code spans (resolved repo-root-relative by the checker). */
  inlinePaths: FoundReference[];
  /** Paths from markdown link targets (resolved relative to the doc's directory). */
  linkPaths: FoundReference[];
  /** `bun run <name>` script names (no slash/dot). */
  scripts: FoundReference[];
  /** `AI_REVIEW_*` env var names. */
  envVars: FoundReference[];
  /**
   * Count claims: `(~N)` or `(N label)` patterns adjacent to a recognizable label
   * (e.g. `(~32 tests)`, `(32 tests)` for "tests", "specs", "modules"). The `~`
   * prefix is optional, so both tilde-prefixed estimates and exact stated counts are
   * collected; the entry's `approximate` flag distinguishes them. Both forms are
   * compared against live ground truth by the count-drift advisory rule in check.ts
   * (#276). Each entry carries the numeric claim and the label token that follows or
   * precedes it in the text.
   */
  countClaims: CountClaim[];
  /**
   * True when a code fence was opened but never closed by a matching delimiter
   * (same char, ≥ length). The remainder of the doc is treated as fenced
   * (blanked), so path/link refs after it are NOT extracted — the checker
   * surfaces this as an advisory so the coverage gap is observable rather than a
   * silent false-negative.
   */
  unclosedFence: boolean;
  /** 1-based line of an unclosed fence's opener (null when balanced). */
  unclosedFenceLine: number | null;
  /** Total line count of the source text (1 + newline count). */
  lineCount: number;
}

/** A numeric count claim extracted from a doc (e.g. `(~32)` labelled "test files"). */
interface CountClaim {
  /** The stated count. */
  count: number;
  /** True when the `~` approximation prefix was present. */
  approximate: boolean;
  /** Normalized label (lowercase). */
  label: string;
  /** 1-based line number. */
  line: number;
  /** The raw matched text, for use in advisory messages. */
  raw: string;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})([^\n]*)$/;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const INLINE_CODE_SPAN_RE = /`[^`\n]+`/g;
// A leading `!` (negative lookbehind) marks an image, not a link — images point at
// binary assets and are not a reference-check target, so they are excluded.
const LINK_RE = /(?<!!)\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const BUN_RUN_RE = /\bbun run\s+([^\s|;&`'"]+)/g;
const ENV_RE = /\bAI_REVIEW_[A-Z0-9_]+/g;
const SCRIPT_NAME_RE = /^[a-zA-Z][\w-]*(?::[\w-]+)*$/;

/**
 * Count-claim patterns for the count-drift advisory (#276 / M027).
 *
 * Detects patterns like `(~32)` or `(~32 tests)` or `(84 files)` in text.
 * The label is captured from:
 *   - text immediately INSIDE the parens after the number: `(~32 tests)`
 *   - text immediately BEFORE the parens: `test specs (~32)`
 *
 * Pattern anatomy: optional `~`, digits, optional space+word (in-paren label).
 * The in-paren label or the preceding word becomes the normalized label.
 * Deliberately narrow: requires parens so stray years like "added in 2024" don't
 * fire. The leading `~` signals an approximate/claimed count worth checking.
 */
const COUNT_CLAIM_PAREN_RE = /\((~?)(\d+)(?:\s+([a-z][a-z\s]*?[a-z]))?\)/gi;
// When no in-paren label is present, the word before the `(` is captured with
// an inline regex anchored at the end of the line-up-to-match string:
//   /([a-z][a-z-]*)\s*\(~?\d+[^)]*\)\s*$/i

/** Known label synonyms — maps doc words to canonical KnownFacts.countFacts keys. */
const LABEL_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["tests", "test files"],
  ["test", "test files"],
  ["specs", "test files"],
  ["spec", "test files"],
  ["modules", "src modules"],
  ["module", "src modules"],
]);

function normalizeLabel(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return LABEL_SYNONYMS.get(lower) ?? lower;
}
/**
 * Tokens carrying these are placeholders/templates/globs, not concrete paths:
 * glob/template metacharacters, an ellipsis, or the milestone `M0xx` convention.
 * Deliberately NOT a broad `xx`/`nn` substring match — that matched real path
 * segments like `ru`+`nn`+`er`, silently skipping every `src/runner/*` ref.
 */
const PLACEHOLDER_RE = /[*?<>{}$]|\.\.\.|\dxx/i;

interface FenceDelimiter {
  char: string;
  len: number;
  /** True when only whitespace follows the run (a valid closing fence). */
  bare: boolean;
}

function fenceInfo(line: string): FenceDelimiter | null {
  const m = FENCE_RE.exec(line);
  if (!m?.[1]) return null;
  const seq = m[1];
  return { char: seq[0] ?? "`", len: seq.length, bare: (m[2] ?? "").trim().length === 0 };
}

/**
 * Split text into lines, blanking out fenced code blocks (replaced by empty
 * strings so line numbers are preserved). A fence is closed only by a delimiter
 * using the same character, at least the same length, and NO info string
 * (CommonMark) — so a 3-backtick line inside a 4-backtick fence, or a
 * ```python line inside a fence, is content, not a close. `openLine` is the
 * 1-based line of an unclosed opener (null when balanced).
 */
function stripFences(lines: readonly string[]): {
  lines: string[];
  unclosed: boolean;
  openLine: number | null;
} {
  const out: string[] = [];
  let open: FenceDelimiter | null = null;
  let openLine = 0;
  lines.forEach((line, index) => {
    const fence = fenceInfo(line);
    if (open === null) {
      if (fence) {
        open = fence;
        openLine = index + 1;
        out.push("");
      } else {
        out.push(line);
      }
      return;
    }
    // inside a fence: close only on a matching, bare delimiter; else blank content
    if (fence?.bare && fence.char === open.char && fence.len >= open.len) {
      open = null;
    }
    out.push("");
  });
  return { lines: out, unclosed: open !== null, openLine: open !== null ? openLine : null };
}

/** Replace inline code-span content with spaces (preserving length & columns). */
function blankInlineCode(line: string): string {
  return line.replace(INLINE_CODE_SPAN_RE, (m) => " ".repeat(m.length));
}

/** True for tokens that are URLs, anchors, mail/git refs, or placeholders. */
function isNonPathToken(token: string): boolean {
  if (token.length === 0) return true;
  if (/\s/.test(token)) return true; // multi-word prose span, not a path
  if (token.startsWith("#")) return true; // pure anchor
  if (token.startsWith("@")) return true; // scoped npm package
  if (token.includes("://")) return true; // URL
  if (token.startsWith("mailto:") || token.startsWith("git@")) return true;
  if (token.includes("@")) return true; // actions/checkout@v4, name@version
  if (PLACEHOLDER_RE.test(token)) return true;
  return false;
}

/** Normalize a path token: drop a `#anchor`, trailing `:line[:col]`, trailing slash. */
export function normalizePathToken(token: string): string {
  let t = token.split("#")[0] ?? token;
  t = t.replace(/(?::\d+)+$/, ""); // file.ts:42 / file.ts:42:7 → file.ts
  t = t.replace(/\/+$/, ""); // src/runner/ → src/runner
  return t;
}

export function extractReferences(text: string): DocReferences {
  const lines = text.split("\n");
  const {
    lines: strippedLines,
    unclosed: unclosedFence,
    openLine: unclosedFenceLine,
  } = stripFences(lines);

  const inlinePaths: FoundReference[] = [];
  const linkPaths: FoundReference[] = [];

  strippedLines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line.length === 0) return;

    for (const match of line.matchAll(INLINE_CODE_RE)) {
      const content = (match[1] ?? "").trim();
      if (isNonPathToken(content)) continue;
      if (!content.includes("/")) continue; // require a directory separator
      inlinePaths.push({ raw: content, line: lineNo });
    }

    // Run link extraction on a copy with inline code spans blanked, so a literal
    // `[text](path)` written INSIDE backticks (not a real link) is not captured.
    for (const match of blankInlineCode(line).matchAll(LINK_RE)) {
      const target = (match[1] ?? "").trim();
      if (isNonPathToken(target)) continue;
      linkPaths.push({ raw: target, line: lineNo });
    }
  });

  const scripts: FoundReference[] = [];
  const envVars: FoundReference[] = [];
  const countClaims: CountClaim[] = [];

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    for (const match of line.matchAll(BUN_RUN_RE)) {
      const token = match[1] ?? "";
      // A token with a slash or dot is a file path arg (e.g. `bun run src/cli.ts`),
      // handled by path extraction in source files — not a package.json script.
      if (token.includes("/") || token.includes(".")) continue;
      if (!SCRIPT_NAME_RE.test(token)) continue; // <script>, --flag, etc.
      scripts.push({ raw: token, line: lineNo });
    }
    for (const match of line.matchAll(ENV_RE)) {
      envVars.push({ raw: match[0], line: lineNo });
    }

    // Count-claim extraction. Recognised forms:
    //   (a) `(~N)` — approximate-only, no label (filtered out unless N>=2)
    //   (b) `(N label)` / `(~N label)` — in-paren label (e.g. `(~32 tests)`)
    //   (c) label-before-paren fallback — word immediately before the `(`
    //       (e.g. `tests (~32)` where the label precedes the parenthesis)
    // Only approximate counts (`~N`) or explicit in-paren/before-paren labels
    // are captured to keep noise low. Years (4-digit numbers) are filtered out.
    for (const match of line.matchAll(COUNT_CLAIM_PAREN_RE)) {
      const approxPrefix = match[1] ?? "";
      const numStr = match[2] ?? "";
      const inParenLabel = (match[3] ?? "").trim();
      const num = Number.parseInt(numStr, 10);

      // Skip years and small noise (single-digit counts in parens are common prose)
      if (num >= 1900 && num <= 2100) continue; // year filter
      if (num < 2 && inParenLabel.length === 0) continue; // single-digit without label

      const approximate = approxPrefix === "~";

      // Determine label: prefer in-paren label; fall back to word-before-paren
      let label = inParenLabel.length > 0 ? normalizeLabel(inParenLabel) : "";

      if (label.length === 0) {
        // Try to find the word immediately before this `(` in the line
        // by re-scanning with WORD_BEFORE_PAREN_RE anchored at the match offset.
        const lineUpTo = line.slice(0, (match.index ?? 0) + match[0].length);
        const beforeMatch = /([a-z][a-z-]*)\s*\(~?\d+[^)]*\)\s*$/i.exec(lineUpTo);
        if (beforeMatch?.[1] !== undefined) {
          label = normalizeLabel(beforeMatch[1]);
        }
      }

      // Only emit claims with a recognizable label (skip bare `(~N)` in prose)
      if (label.length === 0) continue;

      countClaims.push({
        count: num,
        approximate,
        label,
        line: lineNo,
        raw: match[0],
      });
    }
  });

  return {
    inlinePaths,
    linkPaths,
    scripts,
    envVars,
    countClaims,
    unclosedFence,
    unclosedFenceLine,
    lineCount: lines.length,
  };
}
