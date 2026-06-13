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
export interface FoundReference {
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
  });

  return {
    inlinePaths,
    linkPaths,
    scripts,
    envVars,
    unclosedFence,
    unclosedFenceLine,
    lineCount: lines.length,
  };
}
