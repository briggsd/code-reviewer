/**
 * Tests for the escapeMarkdown utility (#74) and its application across the three
 * published-Markdown sinks: summary-markdown (Sink 1), createSummaryBody in run-review.ts
 * (Sink 3), and formatInlineFindingComment in github-vcs-adapter (Sink 2).
 *
 * Sink 2 (formatInlineFindingComment) is module-private and not exported. Coverage for
 * that sink is provided indirectly: the escapeMarkdown unit tests (this file) lock down
 * the escape policy, and each call site in formatInlineFindingComment is wrapped with
 * escapeMarkdown. There is no existing test path that exposes the rendered inline comment
 * body, so the unit-test + applied call sites approach is used per spec note.
 */
import { describe, expect, test } from "bun:test";
import type { Finding, ReviewSummary } from "../src/index.ts";
import {
  escapeMarkdown,
  formatReviewSummaryMarkdown,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";
import { raw } from "./helpers/markdown.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRisk(): ReviewSummary["risk"] {
  return {
    tier: "full",
    reason: "auth changes",
    matchedRules: [],
    sensitivePaths: [],
    reviewedFileCount: 1,
    ignoredFileCount: 0,
  };
}

function makeSummary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    decision: "approved_with_comments",
    outcome: "pass",
    title: "AI review found 1 finding",
    body: "Summary body.",
    findings: [],
    risk: makeRisk(),
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Auth issue",
    body: "body text",
    confidence: "high",
    evidence: ["evidence item"],
    recommendation: "fix it",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. escapeMarkdown unit tests — the policy
// ---------------------------------------------------------------------------

describe("escapeMarkdown — character policy", () => {
  test("empty string returns empty string", () => {
    expect(escapeMarkdown("")).toBe(raw(""));
  });

  test("clean string with no metacharacters is returned unchanged", () => {
    expect(escapeMarkdown("Hello world 123")).toBe(raw("Hello world 123"));
  });

  test("backtick is escaped", () => {
    expect(escapeMarkdown("a`b")).toBe(raw("a\\`b"));
  });

  test("asterisk is escaped", () => {
    expect(escapeMarkdown("a*b")).toBe(raw("a\\*b"));
  });

  test("underscore is escaped", () => {
    expect(escapeMarkdown("a_b")).toBe(raw("a\\_b"));
  });

  test("open bracket is escaped", () => {
    expect(escapeMarkdown("a[b")).toBe(raw("a\\[b"));
  });

  test("close bracket is escaped", () => {
    expect(escapeMarkdown("a]b")).toBe(raw("a\\]b"));
  });

  test("less-than is escaped (neutralizes raw HTML)", () => {
    expect(escapeMarkdown("a<b")).toBe(raw("a\\<b"));
  });

  test("greater-than is escaped (neutralizes raw HTML)", () => {
    expect(escapeMarkdown("a>b")).toBe(raw("a\\>b"));
  });

  test("backslash is escaped (rule 1 — must come first)", () => {
    expect(escapeMarkdown("a\\b")).toBe(raw("a\\\\b"));
  });

  test("backslash-first ordering: input `\\`` produces `\\\\\\`` (backslash doubled, backtick escaped)", () => {
    // Input contains a literal backslash followed by a backtick: \`
    // Rule 1 doubles the backslash: \\`
    // Rule 2 escapes the backtick: \\\`
    expect(escapeMarkdown("\\`")).toBe(raw("\\\\\\`"));
  });

  test("leading # is escaped (heading marker)", () => {
    expect(escapeMarkdown("# heading")).toBe(raw("\\# heading"));
  });

  test("leading > is escaped (blockquote marker)", () => {
    expect(escapeMarkdown("> quote")).toBe(raw("\\> quote"));
  });

  test("leading - is escaped (list marker)", () => {
    expect(escapeMarkdown("- item")).toBe(raw("\\- item"));
  });

  test("leading + is escaped (list marker)", () => {
    expect(escapeMarkdown("+ item")).toBe(raw("\\+ item"));
  });

  test("# after a newline is escaped (multi-line body heading injection)", () => {
    const input = "first line\n# second heading";
    const result = escapeMarkdown(input);
    expect(result).toBe(raw("first line\n\\# second heading"));
  });

  test("- after a newline is escaped (embedded list injection)", () => {
    const input = "first line\n- list item";
    const result = escapeMarkdown(input);
    expect(result).toBe(raw("first line\n\\- list item"));
  });

  test("> after a newline is escaped (embedded blockquote injection)", () => {
    const input = "first line\n> blockquote";
    const result = escapeMarkdown(input);
    expect(result).toBe(raw("first line\n\\> blockquote"));
  });

  test("+ after a newline is escaped (embedded list item)", () => {
    const input = "first line\n+ list";
    const result = escapeMarkdown(input);
    expect(result).toBe(raw("first line\n\\+ list"));
  });

  test("non-leading block markers are NOT escaped (only at start of line)", () => {
    // Rule 3a only fires when # / - / + appear at the start of a line.
    // Mid-line occurrences are not block starters and are left alone.
    // (Note: `#` is not in rule 2's inline set either. `>` is escaped everywhere by rule 2.)
    expect(escapeMarkdown("foo # bar")).toBe(raw("foo # bar"));
    expect(escapeMarkdown("foo - bar")).toBe(raw("foo - bar"));
    expect(escapeMarkdown("foo > bar")).toBe(raw("foo \\> bar")); // > IS in rule 2 (inline set)
  });

  test("digits alone are not escaped (no list delimiter)", () => {
    expect(escapeMarkdown("123")).toBe(raw("123"));
    expect(escapeMarkdown("1 apple")).toBe(raw("1 apple"));
  });

  test("leading ordered-list marker `1.` escapes the delimiter (1\\.)", () => {
    expect(escapeMarkdown("1. first")).toBe(raw("1\\. first"));
  });

  test("leading ordered-list marker `1)` escapes the delimiter (1\\))", () => {
    expect(escapeMarkdown("1) first")).toBe(raw("1\\) first"));
  });

  test("multi-digit ordered-list marker is escaped (42.)", () => {
    expect(escapeMarkdown("42. item")).toBe(raw("42\\. item"));
  });

  test("ordered-list marker after a newline is escaped (embedded list injection)", () => {
    expect(escapeMarkdown("intro\n1. step one")).toBe(raw("intro\n1\\. step one"));
  });

  test("non-leading ordered-list marker is NOT escaped (only at start of line)", () => {
    expect(escapeMarkdown("see 1. above")).toBe(raw("see 1. above"));
  });

  test("combined metacharacters in a realistic title", () => {
    const input = "H`x* <b>_ [y]";
    const result = escapeMarkdown(input);
    // Expected: H\`x\* \<b\>\_ \[y\]
    expect(result).toContain("\\`");
    expect(result).toContain("\\*");
    expect(result).toContain("\\<b\\>");
    expect(result).toContain("\\_");
    expect(result).toContain("\\[y\\]");
    // No bare metacharacters left
    expect(result).not.toMatch(/(?<!\\)[`*_[\]<>]/);
  });
});

// ---------------------------------------------------------------------------
// 2. formatReviewSummaryMarkdown integration (Sink 1)
// ---------------------------------------------------------------------------

describe("formatReviewSummaryMarkdown — Sink 1 escaping", () => {
  const metacharTitle = "H`x* <b>_ [y]";

  test("finding title metacharacters are escaped in rendered output", () => {
    const finding = makeFinding({ title: metacharTitle });
    const summary = makeSummary({ findings: [finding] });
    const markdown = formatReviewSummaryMarkdown(summary);

    // Should contain escaped forms
    expect(markdown).toContain("\\`");
    expect(markdown).toContain("\\*");
    expect(markdown).toContain("\\<b\\>");
    expect(markdown).toContain("\\_");
    expect(markdown).toContain("\\[y\\]");

    // The title line specifically should have the escaped version of <b> and not the bare form.
    // (Code-span fields like `auth`, `security`, `high` legitimately contain unescaped backticks
    // — they are controlled-ish enums wrapped in code spans and not escaped per spec.)
    const titleLine = markdown.split("\n").find((line) => line.includes("WARNING:")) ?? "";
    expect(titleLine).not.toContain("<b>");
    // The escaped backtick \` must appear in the title line
    expect(titleLine).toContain("\\`");
  });

  test("finding body metacharacters are escaped", () => {
    const finding = makeFinding({ body: "A <script>alert(1)</script> body" });
    const summary = makeSummary({ findings: [finding] });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("\\<script\\>");
    expect(markdown).not.toContain("<script>");
  });

  test("finding recommendation metacharacters are escaped", () => {
    const finding = makeFinding({ recommendation: "Use `sanitize()` and `>` checks" });
    const summary = makeSummary({ findings: [finding] });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("\\`sanitize()\\`");
    expect(markdown).toContain("\\>");
  });

  test("finding evidence metacharacters are escaped (per-entry before join)", () => {
    const finding = makeFinding({
      evidence: ["item with `backtick`", "item with *star*"],
    });
    const summary = makeSummary({ findings: [finding] });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("\\`backtick\\`");
    expect(markdown).toContain("\\*star\\*");
    expect(markdown).not.toContain("`backtick`");
    expect(markdown).not.toContain("*star*");
  });

  test("acknowledged.reason metacharacters are escaped", () => {
    const finding = makeFinding({
      title: "Auth issue",
      acknowledged: { reason: "tracked in <TICKET-123>; *accepted*" },
    });
    const summary = makeSummary({ findings: [finding] });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("\\<TICKET-123\\>");
    expect(markdown).toContain("\\*accepted\\*");
    expect(markdown).not.toContain("<TICKET-123>");
    expect(markdown).not.toContain("*accepted*");
  });

  test("summary.title is rendered verbatim (controlled string — not escaped)", () => {
    // summary.title is always produced by createSummaryTitle — no untrusted text.
    const summary = makeSummary({ title: "AI review found 2 findings" });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("## AI review found 2 findings");
  });

  test("summary.body structural Markdown (list lines) survives unescaped", () => {
    // summary.body is structural Markdown assembled by our own code — must not be escaped.
    const summary = makeSummary({ body: "- list item\n- another item" });
    const markdown = formatReviewSummaryMarkdown(summary);

    // The body should appear verbatim so list items render correctly.
    expect(markdown).toContain("- list item");
    expect(markdown).toContain("- another item");
  });

  test("finding location path metacharacters are escaped", () => {
    const finding = makeFinding({
      location: { path: "src/<gen>/file.ts", line: 10 },
    });
    const summary = makeSummary({ findings: [finding] });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("\\<gen\\>");
    // The escaped form must appear in plain-markdown context (the one-liner bullet).
    // The raw path may legally appear inside the JSON code fence in the dismiss block —
    // scope the "not present unescaped" check to the one-liner bullet line only (#159).
    const bulletLine = markdown
      .split("\n")
      .find((l) => l.includes("WARNING:") && l.includes("gen"));
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("\\<gen\\>");
    expect(bulletLine).not.toContain("<gen>");
  });
});

// ---------------------------------------------------------------------------
// 3. Sink 3 — createSummaryBody via runReview fixture
// ---------------------------------------------------------------------------

describe("createSummaryBody — Sink 3 content via runReview", () => {
  test("summary.body contains the five risk-fact lines after runReview", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const result = await runReview({ fixture });

    // summary.body contains the five risk-fact lines only — finding bullets were removed in
    // the group-by-reviewer renderer rewrite (#33). The renderer (Sink 1) now owns finding
    // listing; body carries only the structural risk facts.
    expect(result.summary.body).toContain("Risk tier:");
    expect(result.summary.body).toContain("Risk reason:");
    expect(result.summary.body).toContain("Files reviewed:");
    expect(result.summary.body).toContain("Files ignored:");
    expect(result.summary.body).toContain("Findings:");
    // No per-finding bullet list in the body
    expect(result.summary.body).not.toMatch(/^- \[/m);
  });

  test("finding title/path metacharacters are escaped in the rendered markdown (Sink 1)", async () => {
    // Escaping coverage for finding content lives in the renderer (Sink 1). This test
    // verifies the end-to-end path: metachar title renders escaped in formatReviewSummaryMarkdown.
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const findingWithMetachar: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Use `sanitize()` — _escape_ <input>",
      body: "body",
      confidence: "high",
      evidence: [],
      recommendation: "fix it",
      location: { path: "src/<generated>/auth.ts", line: 5 },
    };

    fixture.fakeFindings = [findingWithMetachar];

    const result = await runReview({ fixture });
    const markdown = formatReviewSummaryMarkdown(result.summary);

    // Title metacharacters must be escaped in rendered output
    expect(markdown).toContain("\\`sanitize()\\`");
    expect(markdown).toContain("\\_escape\\_");
    expect(markdown).toContain("\\<input\\>");

    // Location path metacharacters must be escaped in plain-markdown context.
    expect(markdown).toContain("\\<generated\\>");
    // The raw path may legally appear inside the JSON code fence in the dismiss block —
    // scope the "not present unescaped" check to the one-liner bullet line only (#159).
    const bulletLine = markdown
      .split("\n")
      .find((l) => l.includes("WARNING:") && l.includes("generated"));
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("\\<generated\\>");
    expect(bulletLine).not.toContain("<generated>");
  });
});
