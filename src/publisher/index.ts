// inline-comment-markdown.ts is intentionally NOT re-exported here: it encodes the exact wire
// format of the `ai-code-review-factory-inline` dedup metadata (incl. the security-sensitive
// parser), which must not become part of the package's public API surface (#82 review). The
// adapters import it via its direct file path; tests do the same.
export * from "./inline-readiness.ts";
// `raw` is a module-internal escape hatch (no sanitization); exclude it from the public API
// so callers cannot bypass the EscapedString brand without importing the module directly.
export { codeSpan, type EscapedString, escapeMarkdown } from "./markdown-escape.ts";
export * from "./publish-inline.ts";
export * from "./publish-summary.ts";
export * from "./summary-markdown.ts";
export * from "./summary-metadata.ts";
