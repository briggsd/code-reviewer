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
export function escapeMarkdown(text: string): string {
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

  return result;
}
