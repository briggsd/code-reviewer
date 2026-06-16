/**
 * Escape Markdown/HTML metacharacters in untrusted text (LLM-produced finding fields,
 * base-branch acknowledgement reasons) before interpolating it into published Markdown.
 * Policy is intentionally centralized (#74) so every renderer escapes identically.
 *
 * Rules applied in order:
 * 1. Backslash first — `\` → `\\` (must precede other insertions to avoid double-escaping).
 * 2. Inline metacharacters — backslash-escape `` ` ``, `*`, `_`, `[`, `]`, `<`, `>` anywhere.
 *    Escaping `<`/`>` neutralizes raw HTML injection AND blockquote markers (`>` at line-start
 *    becomes `\>`, so Rule 3 does not — and must not — repeat it). `*`/`_` likewise pre-empt
 *    `*`-started lists and thematic breaks.
 * 3. Leading block markers not covered by Rule 2 — at the start of a line (the `m` flag makes
 *    `^` match after each newline): the single-char heading/list markers `#`, `-`, `+`, and
 *    ordered-list markers (`1.` / `1)` — 1–9 digits followed by `.` or `)`). Without this a
 *    multi-line body could open a line with a heading or list and inject block structure.
 */

/**
 * Branded string type produced by `escapeMarkdown` or `codeSpan`. Renderer helpers that
 * accept untrusted text should declare their parameters as `EscapedString` so the TypeScript
 * compiler rejects plain `string` values — forcing callers to pass text through an escape path
 * first. Static/controlled string literals can be admitted via the `raw` marker.
 */
export type EscapedString = string & { readonly __escapedBrand: unique symbol };

/**
 * Escape Markdown/HTML metacharacters in untrusted text and return a branded
 * `EscapedString`. The output is byte-for-byte identical to the previous
 * `string` return — only the type narrows.
 */
export function escapeMarkdown(text: string): EscapedString {
  // Rule 1 — backslash must come first so the backslashes we insert next aren't re-escaped.
  let result = text.replace(/\\/g, "\\\\");

  // Rule 2 — inline metacharacters that GitHub Markdown (and CommonMark) interprets.
  // Escaping `<`/`>` also neutralizes raw HTML injection and (for line-start `>`) blockquotes.
  result = result.replace(/[`*_[\]<>]/g, "\\$&");

  // Rule 3a — single-char block markers at the start of a line (`>` is intentionally absent:
  // Rule 2 already escaped it everywhere, so a line-start `>` is `\>` by now).
  result = result.replace(/^([#\-+])/gm, "\\$1");

  // Rule 3b — ordered-list markers (1–9 digits + `.` or `)`). Escape the DELIMITER, not the
  // digit (a backslash before a digit is literal, not an escape), e.g. `1.` → `1\.`.
  result = result.replace(/^(\d{1,9})([.)])/gm, "$1\\$2");

  return result as EscapedString;
}

/**
 * Wrap a value in a CommonMark code span without escaping the inner text. Values
 * inside a code span are rendered literally by CommonMark parsers — running
 * `escapeMarkdown` on them would backslash-escape metacharacters that must stay
 * unmodified (M022 S05 no-double-escape constraint).
 *
 * Fence width follows CommonMark §6.11: the surrounding backtick fence must be at
 * least one tick longer than the longest contiguous backtick run inside `value`;
 * if the value starts or ends with a backtick the content is padded with spaces;
 * if the value both starts and ends with a space the content is padded to prevent
 * §6.11 space-stripping.
 *
 * Empty input yields an empty string (no code span emitted).
 *
 * Returns an `EscapedString` so the output is accepted wherever escaped text is
 * required without a second round of escaping.
 */
export function codeSpan(value: string): EscapedString {
  if (value === "") return "" as EscapedString;
  // Determine minimum fence length per CommonMark §6.11.
  const runs = value.match(/`+/g) ?? [];
  const maxRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(1, maxRun + 1));

  // Pad with a single space on each side when the value starts or ends with a backtick
  // (CommonMark §6.11 prevents the fence from being mistaken as part of the content run),
  // or when the value both starts and ends with a space and is not all-whitespace
  // (CommonMark §6.11 strips one leading and one trailing space in that case, so padding
  // is required to preserve the original content).
  const needsPad =
    value.startsWith("`") ||
    value.endsWith("`") ||
    (value.startsWith(" ") && value.endsWith(" ") && value.trim().length > 0);
  const inner = needsPad ? ` ${value} ` : value;

  return `${fence}${inner}${fence}` as EscapedString;
}
