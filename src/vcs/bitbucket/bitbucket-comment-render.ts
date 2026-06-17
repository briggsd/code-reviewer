/**
 * Bitbucket-specific comment rendering helpers.
 *
 * Bitbucket Cloud does not render raw HTML in Markdown: `<details>`/`<summary>` tags and
 * `<!-- ... -->` HTML comments appear as escaped literal text rather than being processed.
 * This module provides two transforms applied before posting to Bitbucket:
 *
 * 1. `flattenHtmlDetails` — converts `<details>`/`<summary>` constructs to plain Markdown
 *    (section headers as bold text, body always expanded) so the content is readable.
 *
 * 2. `buildBitbucketMetadataFence` — wraps the hidden-metadata block in a fenced code block
 *    so it renders as a contained monospace block rather than escaped HTML. The existing
 *    parser (`parseSummaryHiddenMetadata`, `parseInlineCommentMetadata`) matches the marker
 *    anywhere in `content.raw`, including inside a fenced code block, so re-review and dedup
 *    continue to work unchanged.
 *
 * These helpers are intentionally local to the Bitbucket adapter and must not be used by
 * the shared publisher formatters or the GitHub/GitLab adapters.
 */

/**
 * Flatten `<details>`/`<summary>` HTML constructs into plain Markdown.
 *
 * Bitbucket Cloud does not render HTML tags — they appear as escaped text. This function
 * transforms collapsible sections into always-visible bold headings so the content is
 * readable without raw HTML support.
 *
 * Rules applied (line-by-line):
 * - `<details><summary>TEXT</summary>` (combined opening, possibly with surrounding whitespace)
 *   → `**TEXT**` on its own line.
 * - `<summary>TEXT</summary>` (standalone, possibly with surrounding whitespace) →
 *   `**TEXT**` on its own line. The section header stays, just always expanded.
 * - Standalone `<details>` (with or without attributes) and `</details>` lines → removed.
 * - All other lines are passed through unchanged.
 */
export function flattenHtmlDetails(md: string): string {
  const lines = md.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Convert <details><summary>TEXT</summary> (combined opening line) → **TEXT**
    // This pattern is used by BREAK_GLASS_FOOTER and resolved-log blocks in summary-markdown.ts.
    const combinedMatch = /^<details(\s[^>]*)?>[ \t]*<summary>(.*?)<\/summary>$/.exec(trimmed);
    if (combinedMatch !== null) {
      const summaryText = combinedMatch[2] ?? "";
      result.push(`**${summaryText}**`);
      continue;
    }

    // Remove standalone <details> and </details> tags
    if (trimmed === "<details>" || trimmed === "</details>") {
      continue;
    }

    // <details> with an attribute (e.g. <details open>) — remove
    if (/^<details(\s[^>]*)?>$/.test(trimmed)) {
      continue;
    }

    // Convert <summary>TEXT</summary> (standalone line) → **TEXT**
    const summaryMatch = /^<summary>(.*?)<\/summary>$/.exec(trimmed);
    if (summaryMatch !== null) {
      const summaryText = summaryMatch[1] ?? "";
      result.push(`**${summaryText}**`);
      continue;
    }

    result.push(line);
  }

  return result.join("\n");
}

/**
 * Build the fenced-block metadata section appended to Bitbucket summary comments.
 *
 * Bitbucket doesn't hide HTML comments — `<!-- ... -->` appears as escaped text in the
 * rendered view. Wrapping the marker in a fenced code block makes it render as a small
 * contained block rather than a raw escaped blob.
 *
 * The existing `parseSummaryHiddenMetadata` regex matches the marker anywhere in
 * `content.raw`, including inside a fenced code block, so re-review and dedup are unchanged.
 *
 * The metadata object is minimized: `findingTitles` and `recurrenceDepths` are excluded
 * to keep the visible block small. Both fields are optional in `parseSummaryHiddenMetadata`,
 * so dropping them is safe — re-review still works with `findingIds`/`findingPaths`.
 *
 * The `>` → `>` escape mirrors the defence applied by `formatReviewSummaryMarkdown`
 * (#82): no model-authored field value can prematurely close the HTML comment.
 *
 * Returns the two-newline-prefixed fenced block string, ready to append to a comment body.
 * When `hiddenMetadata` is undefined, a fence with an empty metadata object is appended so
 * the comment is still recognisable as a bot summary comment by `parseSummaryHiddenMetadata`
 * (which the adapter uses for dedup and prior-state loading).
 */
export function buildBitbucketMetadataFence(
  hiddenMetadata: Record<string, unknown> | undefined,
): string {
  // The block is unavoidably visible on Bitbucket (no hidden HTML comments, no Connect-app
  // property store), so keep it as small as possible:
  //   - Drop `findingTitles` — bulky human-readable strings (re-review falls back to placeholders).
  //   - Drop `provider` / `repository` / `changeId` — re-derivable from the current run's ref;
  //     `createPriorReviewStateFromMetadata` never reads them.
  //   - Retain `findingIds` / `findingPaths` / `findingReviewers` / `recurrenceDepths` /
  //     `findingsHash` / `runId` / `headSha` / `schemaVersion` — all consumed by re-review.
  //   - Serialize COMPACT (no indentation) so the visible block is ~one line, not ~25.
  // `parseSummaryHiddenMetadata` matches the marker + JSON regardless of formatting.
  const {
    findingTitles: _ft,
    provider: _p,
    repository: _r,
    changeId: _c,
    ...minimized
  } = hiddenMetadata ?? {};

  const json = JSON.stringify(minimized).replace(/>/g, "\\u003e");

  return `\n\n\`\`\`\n<!-- code-reviewer\n${json}\n-->\n\`\`\``;
}

/**
 * Wrap the `<!-- code-reviewer-inline … -->` marker region in a fenced code block.
 *
 * Applied to inline finding comment bodies before posting to Bitbucket, so the marker
 * renders as a contained block rather than visible escaped HTML.
 *
 * `parseInlineCommentMetadata` matches `/<!-- code-reviewer-inline\s*\n([\s\S]*?)\n-->/m`
 * anywhere in `content.raw`, including inside a fenced block — dedup still works.
 */
export function fenceInlineMetadataMarker(body: string): string {
  // Match the inline marker block (from the opening comment to the closing --)
  return body.replace(/(<!-- code-reviewer-inline\s*\n[\s\S]*?\n-->)/, "```\n$1\n```");
}
