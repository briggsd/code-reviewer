/**
 * Type-safety and runtime tests for the EscapedString brand (#310).
 *
 * Covers:
 * 1. Compile-time rejection: a raw `string` in an `EscapedString`-typed slot is a TS error.
 * 2. Positive paths: `escapeMarkdown`, `codeSpan`, and `raw` all produce `EscapedString`.
 * 3. Runtime: `codeSpan` does not escape inner text and chooses a safe fence width.
 * 4. Runtime: `raw` returns the input string unchanged.
 */
import { describe, expect, test } from "bun:test";
import type { Finding } from "../src/index.ts";
import { codeSpan, type EscapedString, escapeMarkdown } from "../src/index.ts";
import { raw } from "./helpers/markdown.ts";

// ---------------------------------------------------------------------------
// Compile-time rejection test
//
// `requireEscaped` is a typed sentinel that accepts only `EscapedString`.
// Passing a plain `string` (e.g. a raw LLM-produced field like `finding.title`)
// is a TypeScript compile error — that is the enforcement guarantee.
// ---------------------------------------------------------------------------

function requireEscaped(value: EscapedString): string {
  return value;
}

const finding: Finding = {
  reviewer: "security",
  severity: "warning",
  category: "auth",
  title: "Raw untrusted title",
  body: "body",
  confidence: "high",
  evidence: [],
  recommendation: "fix it",
};

// @ts-expect-error — plain string (untrusted LLM text) is not assignable to EscapedString
requireEscaped(finding.title);

// @ts-expect-error — direct string literal is not assignable to EscapedString
requireEscaped("unescaped text");

// Positive: escapeMarkdown produces EscapedString — accepted without error.
requireEscaped(escapeMarkdown(finding.title));

// Positive: codeSpan produces EscapedString — accepted without error.
requireEscaped(codeSpan(finding.category));

// Positive: raw admits a known-safe literal — accepted without error.
requireEscaped(raw("trusted static fragment"));

// ---------------------------------------------------------------------------
// Runtime: codeSpan does not escape inner text
// ---------------------------------------------------------------------------

describe("codeSpan — literal pass-through", () => {
  test("plain value is wrapped in backticks unchanged", () => {
    expect(codeSpan("auth")).toBe(raw("`auth`"));
  });

  test("value with a single backtick is fenced with double backticks", () => {
    // The inner backtick must not be escaped; the fence widens instead.
    const result = codeSpan("a`b");
    expect(result).toBe(raw("``a`b``"));
    // Inner text is literal — the backtick is preserved, not backslash-escaped.
    expect(result).not.toContain("\\`");
  });

  test("value with double backticks is fenced with triple backticks", () => {
    const result = codeSpan("a``b");
    expect(result).toBe(raw("```a``b```"));
  });

  test("value starting with a backtick is padded with spaces", () => {
    const result = codeSpan("`leading");
    // Fence is `` (double, because value has a single-tick run) and content is padded.
    expect(result).toBe(raw("`` `leading ``"));
  });

  test("value ending with a backtick is padded with spaces", () => {
    const result = codeSpan("trailing`");
    expect(result).toBe(raw("`` trailing` ``"));
  });

  test("markdown metacharacters inside codeSpan are NOT escaped (literal path)", () => {
    // Proves the M022 S05 no-double-escape convention: values inside a code span
    // are literal, so running escapeMarkdown on them would corrupt the rendered output.
    const result = codeSpan("a*b_c<d>");
    // No backslash escaping — the fence handles containment, not escaping.
    expect(result).not.toContain("\\*");
    expect(result).not.toContain("\\_");
    expect(result).not.toContain("\\<");
    expect(result).toContain("a*b_c<d>");
  });

  test("empty value yields empty string (no code span emitted)", () => {
    expect(codeSpan("")).toBe(raw(""));
  });

  test("value with leading and trailing spaces is padded to prevent §6.11 space-stripping", () => {
    // CommonMark §6.11 strips one leading and one trailing space when the content both
    // starts and ends with a space (and is not all-whitespace). codeSpan adds an extra
    // space on each side so after stripping the original leading/trailing space is preserved.
    // Input: " hello " (1 space each side) → inner becomes "  hello  " (2 spaces each side).
    expect(codeSpan(" hello ")).toBe(raw("`  hello  `"));
  });
});

// ---------------------------------------------------------------------------
// Runtime: raw returns the input unchanged
// ---------------------------------------------------------------------------

describe("raw — identity for trusted literals", () => {
  test("returns the input string unchanged", () => {
    const input = "static trusted fragment";
    // Cast through `string` to satisfy the type checker; the point is that the runtime
    // value is reference-equal to the input (no copying or transformation).
    expect(raw(input) as string).toBe(input);
    expect(String(raw(input))).toBe(input);
  });
});
