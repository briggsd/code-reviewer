/**
 * New coverage for the group-by-reviewer summary renderer (#33).
 *
 * These tests cover the layout added in the rewrite:
 *  - Grouping by reviewer with correct ordering and emoji
 *  - Severity badge counts and singular/plural labels
 *  - Recommendation tier derived from max severity
 *  - One-line bullets: escaping, 120-char recommendation trim, ack suffix
 *  - Progressive disclosure <details> blocks
 *  - Headline mapping for all five decision values
 *  - Preservation: hidden metadata, Re-review status, No findings., break-glass footer
 *  - Escaping regression: metacharacters in title/recommendation/evidence
 *  - Doc test: break-glass section present in docs/developer/architecture.md
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Finding, ReviewSummary } from "../src/index.ts";
import {
  formatReviewSummaryMarkdown,
  formatTokenCount,
  parseSummaryHiddenMetadata,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRisk(): ReviewSummary["risk"] {
  return {
    tier: "full",
    reason: "Sensitive auth change.",
    matchedRules: ["sensitive_paths"],
    sensitivePaths: ["auth/accounts.ts"],
    reviewedFileCount: 2,
    ignoredFileCount: 0,
  };
}

function makeSummary(overrides: Partial<ReviewSummary> = {}): ReviewSummary {
  return {
    decision: "significant_concerns",
    outcome: "fail",
    title: "AI review found issues",
    body: "Risk tier: full\nRisk reason: Sensitive auth change.\nFiles reviewed: 2\nFiles ignored: 0\nFindings: 3",
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
    title: "Auth check changed",
    body: "The auth check changed.",
    confidence: "high",
    evidence: ["Evidence item."],
    recommendation: "Verify the new auth behavior.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Grouping — ordering, emoji, escaped reviewer names
// ---------------------------------------------------------------------------

describe("group-by-reviewer layout", () => {
  test("security group appears first, unknown reviewer last with 🔍", () => {
    const findings: Finding[] = [
      makeFinding({ reviewer: "perf_v2", severity: "suggestion", title: "Perf nit" }),
      makeFinding({ reviewer: "code_quality", severity: "warning", title: "Quality issue" }),
      makeFinding({ reviewer: "security", severity: "critical", title: "Security vuln" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    const secIdx = markdown.indexOf("🔒 security");
    const cqIdx = markdown.indexOf("🧹 code\\_quality");
    const perfIdx = markdown.indexOf("🔍 perf\\_v2");

    expect(secIdx).toBeGreaterThan(-1);
    expect(cqIdx).toBeGreaterThan(-1);
    expect(perfIdx).toBeGreaterThan(-1);
    // security < code_quality < perf_v2
    expect(secIdx).toBeLessThan(cqIdx);
    expect(cqIdx).toBeLessThan(perfIdx);
  });

  test("documentation group uses 📚 emoji and appears after code_quality", () => {
    const findings: Finding[] = [
      makeFinding({ reviewer: "documentation", severity: "suggestion", title: "Doc fix" }),
      makeFinding({ reviewer: "code_quality", severity: "warning", title: "Quality issue" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    const cqIdx = markdown.indexOf("🧹 code\\_quality");
    const docIdx = markdown.indexOf("📚 documentation");
    expect(docIdx).toBeGreaterThan(-1);
    expect(cqIdx).toBeLessThan(docIdx);
  });

  test("reviewer names appear escaped (plain context) in group headers", () => {
    const findings: Finding[] = [
      makeFinding({ reviewer: "security", title: "Sec issue" }),
      makeFinding({ reviewer: "perf_v2", title: "Perf issue" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    // Reviewer is model-authored — escaped in plain heading context, NOT a code span
    // (a backtick in the role name would break out of a code span at heading level).
    expect(markdown).toContain("### 🔒 security —");
    expect(markdown).toContain("### 🔍 perf\\_v2 —");
  });

  test("reviewer name with newlines cannot terminate the heading and open a new block", () => {
    const findings: Finding[] = [
      makeFinding({ reviewer: "security\n# Injected heading", severity: "warning", title: "X" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    // Newlines collapse to a space before escaping — the injected block marker stays
    // inline (mid-line # is inert markdown), never at line start.
    expect(markdown).not.toContain("\n# Injected heading");
    expect(markdown).toContain("security # Injected heading");
  });

  test("reviewer name with markdown metacharacters is escaped in the group heading", () => {
    const findings: Finding[] = [
      makeFinding({ reviewer: "sec`urity**", severity: "warning", title: "Injected role" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    // Backtick and asterisks must be escaped — no live code span / bold in the heading
    expect(markdown).toContain("### 🔍 sec\\`urity\\*\\* —");
    expect(markdown).not.toContain("### 🔍 sec`urity** —");
  });

  test("three reviewers including unknown: all groups present, ordered correctly", () => {
    const findings: Finding[] = [
      makeFinding({ reviewer: "security", severity: "critical", title: "Sec vuln" }),
      makeFinding({ reviewer: "code_quality", severity: "warning", title: "Quality issue" }),
      makeFinding({ reviewer: "perf_v2", severity: "suggestion", title: "Perf nit" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    expect(markdown).toContain("🔒 security");
    expect(markdown).toContain("🧹 code\\_quality");
    expect(markdown).toContain("🔍 perf\\_v2");
  });
});

// ---------------------------------------------------------------------------
// 2. Severity badge counts + singular/plural; recommendation tier = max severity
// ---------------------------------------------------------------------------

describe("severity badge and recommendation tier", () => {
  test("single critical: badge shows '1 critical' (singular), tier = 🔴 Major Comments", () => {
    const findings = [makeFinding({ severity: "critical", title: "Critical issue" })];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    expect(markdown).toContain("🔴 1 critical");
    expect(markdown).toContain("Recommendation: 🔴 Major Comments");
    // plural should NOT appear
    expect(markdown).not.toContain("criticals");
  });

  test("two warnings: badge shows '2 warnings' (plural), tier = ⚠️ Minor Comments", () => {
    const findings = [
      makeFinding({ severity: "warning", title: "Warning A" }),
      makeFinding({ severity: "warning", title: "Warning B" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    expect(markdown).toContain("⚠️ 2 warnings");
    expect(markdown).toContain("Recommendation: ⚠️ Minor Comments");
  });

  test("one suggestion: badge shows '1 suggestion' (singular), tier = 💬 Optional Nits", () => {
    const findings = [makeFinding({ severity: "suggestion", title: "Suggestion" })];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    expect(markdown).toContain("💬 1 suggestion");
    expect(markdown).toContain("Recommendation: 💬 Optional Nits");
    expect(markdown).not.toContain("suggestions");
  });

  test("mixed: critical + warning + suggestion → badge has all three, tier = Major Comments", () => {
    const findings = [
      makeFinding({ severity: "critical", title: "Critical" }),
      makeFinding({ severity: "warning", title: "Warning" }),
      makeFinding({ severity: "suggestion", title: "Suggestion" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    expect(markdown).toContain("🔴 1 critical");
    expect(markdown).toContain("⚠️ 1 warning");
    expect(markdown).toContain("💬 1 suggestion");
    expect(markdown).toContain("Recommendation: 🔴 Major Comments");
  });

  test("absent severities are omitted from badge", () => {
    const findings = [makeFinding({ severity: "warning", title: "Just a warning" })];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));
    // No critical or suggestion badge
    expect(markdown).not.toContain("critical");
    expect(markdown).not.toContain("suggestion");
    expect(markdown).toContain("⚠️ 1 warning");
  });
});

// ---------------------------------------------------------------------------
// 3. One-line bullets: title escaped, rec trimmed at 120 chars, ack suffix preserved
// ---------------------------------------------------------------------------

describe("one-line bullets", () => {
  test("title is escaped in the one-line bullet", () => {
    const finding = makeFinding({ title: "Use `code` and **bold**", recommendation: "Fix it." });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find((l) => l.startsWith("- **WARNING:"))!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("\\`code\\`");
    expect(bulletLine).toContain("\\*\\*bold\\*\\*");
  });

  test("recommendation trimmed to ≤120 chars with ellipsis in one-line bullet", () => {
    const longRec = "A".repeat(130);
    const finding = makeFinding({ recommendation: longRec });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find((l) => l.startsWith("- **WARNING:"))!;
    expect(bulletLine).toBeDefined();
    // The trimmed rec is 120 A's + ellipsis
    expect(bulletLine).toContain("A".repeat(120) + "…");
    expect(bulletLine).not.toContain("A".repeat(121));
  });

  test("acknowledged suffix appears on one-line bullet", () => {
    const finding = makeFinding({
      title: "Auth issue",
      acknowledged: { reason: "tracked via TICKET-999" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find((l) => l.startsWith("- **WARNING:") && l.includes("Auth issue"))!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("_acknowledged: tracked via TICKET-999_");
  });

  test("recommendation trimmed BEFORE escaping (escape after trim)", () => {
    // If we escaped first, a metachar near position 120 could be split mid-sequence.
    // Build a rec where char 120 is the start of a markdown metachar.
    const prefix = "A".repeat(119);
    const rec = `${prefix}` + "`backtick content"; // backtick at position 119 (0-indexed)
    const finding = makeFinding({ recommendation: rec });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find((l) => l.startsWith("- **WARNING:"))!;
    expect(bulletLine).toBeDefined();
    // Trimmed at 120 chars: first 120 chars = prefix(119) + "`", then "…"
    // After escaping: the "`" becomes "\`"
    expect(bulletLine).toContain("\\`…");
  });
});

// ---------------------------------------------------------------------------
// 4. Progressive disclosure: <details> per group
// ---------------------------------------------------------------------------

describe("progressive disclosure <details>", () => {
  test("<details> block present for each reviewer group", () => {
    const findings = [
      makeFinding({ reviewer: "security", title: "Sec issue" }),
      makeFinding({ reviewer: "code_quality", title: "Quality issue" }),
    ];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    const detailsCount = (markdown.match(/<details>/g) ?? []).length;
    // One details block per reviewer group + break-glass footer
    expect(detailsCount).toBe(3);
  });

  test("<details> block contains Why it matters and Evidence", () => {
    const finding = makeFinding({
      title: "Sec vuln",
      body: "Why this matters: detailed explanation here.",
      evidence: ["Evidence line one.", "Evidence line two."],
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const detailsStart = markdown.indexOf("<details><summary>View full review");
    const detailsEnd = markdown.indexOf("</details>", detailsStart);
    const detailsBlock = markdown.slice(detailsStart, detailsEnd);

    expect(detailsBlock).toContain("Why it matters:");
    expect(detailsBlock).toContain("Why this matters: detailed explanation here.");
    expect(detailsBlock).toContain("Evidence line one.");
    expect(detailsBlock).toContain("Evidence line two.");
  });

  test("blank line after </summary> tag is present (required for GitHub MD rendering)", () => {
    const findings = [makeFinding({ title: "Issue" })];
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings }));

    // After <summary>View full review (N findings)</summary> there must be a blank line
    expect(markdown).toContain("</summary>\n\n");
  });

  test("verbose body text appears exactly once, inside the details block (not above the fold)", () => {
    const verboseBody = "Very specific verbose body text for this finding.";
    const finding = makeFinding({ body: verboseBody });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    // Count occurrences — must be exactly 1
    const count = markdown.split(verboseBody).length - 1;
    expect(count).toBe(1);

    // That one occurrence must be inside the <details> block
    const detailsStart = markdown.indexOf("<details><summary>View full review");
    const detailsEnd = markdown.indexOf("</details>", detailsStart);
    const detailsBlock = markdown.slice(detailsStart, detailsEnd);
    expect(detailsBlock).toContain(verboseBody);

    // And the text before <details> must NOT contain it
    const aboveFold = markdown.slice(0, detailsStart);
    expect(aboveFold).not.toContain(verboseBody);
  });
});

// ---------------------------------------------------------------------------
// 5. Escaping regression: metacharacters in both bullet and details
// ---------------------------------------------------------------------------

describe("escaping regression", () => {
  test("title with ** < ` is escaped in both bullet and details", () => {
    const title = "**bold** and <img src=x> and `code`";
    const finding = makeFinding({ title });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    // Escaped forms must appear; bare forms must not
    expect(markdown).toContain("\\*\\*bold\\*\\*");
    expect(markdown).toContain("\\<img");
    expect(markdown).toContain("\\`code\\`");
    expect(markdown).not.toContain("<img src=x>");

    // Must appear in both the one-line bullet and the details block
    const bulletLine = markdown.split("\n").find((l) => l.startsWith("- **WARNING:"))!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("\\*\\*bold\\*\\*");

    const detailsStart = markdown.indexOf("<details><summary>View full review");
    const detailsEnd = markdown.indexOf("</details>", detailsStart);
    const detailsBlock = markdown.slice(detailsStart, detailsEnd);
    expect(detailsBlock).toContain("\\*\\*bold\\*\\*");
  });

  test("recommendation with metacharacters is escaped in one-line bullet", () => {
    const rec = "Use `sanitize()` and check for <null>";
    const finding = makeFinding({ recommendation: rec });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const bulletLine = markdown.split("\n").find((l) => l.startsWith("- **WARNING:"))!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("\\`sanitize()\\`");
    expect(bulletLine).toContain("\\<null\\>");
  });

  test("evidence with metacharacters is escaped in details block", () => {
    const finding = makeFinding({
      evidence: ["Found `issue` at line 42", "See <here>"],
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const detailsStart = markdown.indexOf("<details><summary>View full review");
    const detailsEnd = markdown.indexOf("</details>", detailsStart);
    const detailsBlock = markdown.slice(detailsStart, detailsEnd);

    expect(detailsBlock).toContain("\\`issue\\`");
    expect(detailsBlock).toContain("\\<here\\>");
  });
});

// ---------------------------------------------------------------------------
// 6. Headline mapping
// ---------------------------------------------------------------------------

describe("decision headline", () => {
  test("unknown decision value (cast past the type) is escaped in the fallback headline", () => {
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({
        decision: "weird**decision" as ReviewSummary["decision"],
        outcome: "pass",
        findings: [],
      }),
    );
    // Defense-in-depth: fallback escapes — no live bold in the headline
    expect(markdown).toContain("⚠️ weird\\*\\*decision");
    expect(markdown).not.toContain("⚠️ weird**decision");
  });

  test("approved → ✅ Approved", () => {
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ decision: "approved", outcome: "pass", findings: [] }),
    );
    expect(markdown).toContain("✅ Approved");
  });

  test("approved_with_comments → ✅ Approved with comments", () => {
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ decision: "approved_with_comments", outcome: "pass", findings: [] }),
    );
    expect(markdown).toContain("✅ Approved with comments");
  });

  test("minor_issues → 🟡 Minor issues", () => {
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ decision: "minor_issues", outcome: "pass", findings: [] }),
    );
    expect(markdown).toContain("🟡 Minor issues");
  });

  test("significant_concerns → 🔴 Significant concerns", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ decision: "significant_concerns" }));
    expect(markdown).toContain("🔴 Significant concerns");
  });

  test("review_failed → ⚠️ Review failed", () => {
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ decision: "review_failed", outcome: "fail", findings: [] }),
    );
    expect(markdown).toContain("⚠️ Review failed");
  });

  test("headline includes risk tier and CI outcome as code spans", () => {
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({
        decision: "approved",
        outcome: "pass",
        findings: [],
        risk: { ...makeRisk(), tier: "lite" },
      }),
    );
    expect(markdown).toContain("Risk tier `lite`");
    expect(markdown).toContain("CI `pass`");
  });
});

// ---------------------------------------------------------------------------
// 7. Preservation: hidden metadata, Re-review status, No findings., break-glass
// ---------------------------------------------------------------------------

describe("preservation of existing behaviors", () => {
  test("No findings. rendered when findings array is empty", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }));
    expect(markdown).toContain("No findings.");
    expect(markdown).not.toContain("<details><summary>View full review");
  });

  test("hidden metadata block is present and parseable by parseSummaryHiddenMetadata", () => {
    const hiddenMeta = {
      schemaVersion: 1,
      runId: "test-run-123",
      headSha: "abc123",
      provider: "github",
      repository: "example/repo",
      changeId: "42",
      findingIds: ["fnd_1", "fnd_2"],
    };
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }), {
      includeHiddenMetadata: true,
      hiddenMetadata: hiddenMeta,
    });

    // Raw block present
    expect(markdown).toContain("<!-- ai-code-review-factory");
    expect(markdown).toContain('"runId": "test-run-123"');

    // Round-trip parseable
    const parsed = parseSummaryHiddenMetadata(markdown);
    expect(parsed).not.toBeNull();
    expect(parsed?.runId).toBe("test-run-123");
    expect(parsed?.headSha).toBe("abc123");
  });

  test("hidden metadata block is omitted when includeHiddenMetadata is false", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }), {
      includeHiddenMetadata: false,
    });
    expect(markdown).not.toContain("<!-- ai-code-review-factory");
  });

  test("### Re-review status section preserved with correct bullets", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [makeFinding({ title: "Issue" })] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: ["fnd_1"],
        fixedFindingIds: ["fnd_2"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_2",
            status: "fixed",
            priorFinding: {
              id: "fnd_2",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "Prior fixed finding",
              body: "Was a bug.",
              confidence: "high",
              evidence: [],
              recommendation: "Already fixed.",
            },
            lastSeenHeadSha: "abc1234567890",
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("### Re-review status");
    expect(markdown).toContain("New findings: 0");
    expect(markdown).toContain("Recurring findings: 1");
    expect(markdown).toContain("Fixed prior findings: 1");
    // New readable format — title is rendered, not opaque ID
    expect(markdown).toContain("✅ Prior fixed finding — last seen `abc1234`");
    // Old opaque format must NOT appear
    expect(markdown).not.toContain("Fixed IDs:");
    expect(markdown).toContain("Withheld prior findings: 0");
  });

  test("carried-forward line rendered when carriedForwardFindingIds is populated", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [makeFinding({ title: "Issue" })] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: [],
        carriedForwardFindingIds: ["fnd_offpath"],
        classifications: [
          {
            stableId: "fnd_offpath",
            status: "carried_forward",
            priorFinding: {
              id: "fnd_offpath",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "Off-delta finding",
              body: "Not re-reviewed this push.",
              confidence: "medium",
              evidence: [],
              recommendation: "Review later.",
              location: { path: "src/untouched.ts" },
            },
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("Carried forward (not re-reviewed this push): 1");
    expect(markdown).toContain("src/untouched.ts");
  });

  test("carried-forward line shows multiple deduped paths sorted", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: [],
        carriedForwardFindingIds: ["fnd_b", "fnd_a", "fnd_c"],
        classifications: [
          {
            stableId: "fnd_b",
            status: "carried_forward",
            priorFinding: {
              id: "fnd_b",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "B",
              body: "",
              confidence: "medium",
              evidence: [],
              recommendation: "",
              location: { path: "b.ts" },
            },
          },
          {
            stableId: "fnd_a",
            status: "carried_forward",
            priorFinding: {
              id: "fnd_a",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "A",
              body: "",
              confidence: "medium",
              evidence: [],
              recommendation: "",
              location: { path: "a.ts" },
            },
          },
          {
            stableId: "fnd_c",
            status: "carried_forward",
            // no priorFinding → no path to render
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("Carried forward (not re-reviewed this push): 3");
    // Paths: a.ts and b.ts, sorted; fnd_c has no path
    const carryIdx = markdown.indexOf("Carried forward");
    const aIdx = markdown.indexOf("a.ts", carryIdx);
    const bIdx = markdown.indexOf("b.ts", carryIdx);
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeLessThan(bIdx);
    // fnd_c has no path — must not render a blank bullet
    expect(markdown).not.toContain("  - \n");
  });

  // ---------------------------------------------------------------------------
  // Re-review: resolved findings readable render (#278 S01)
  // ---------------------------------------------------------------------------

  test("fixed classification renders readable title + last-seen sha (not opaque ID)", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_fixed1"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_fixed1",
            status: "fixed",
            priorFinding: {
              id: "fnd_fixed1",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "SQL injection in user input",
              body: "Body text.",
              confidence: "high",
              evidence: [],
              recommendation: "Sanitize input.",
            },
            lastSeenHeadSha: "deadbeef99abc",
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    // Readable format with 7-char sha
    expect(markdown).toContain("✅ SQL injection in user input — last seen `deadbee`");
    // Count line unchanged
    expect(markdown).toContain("Fixed prior findings: 1");
    // Old opaque ID format must NOT appear
    expect(markdown).not.toContain("Fixed IDs:");
    expect(markdown).not.toContain("`fnd_fixed1`");
  });

  test("withheld classification renders readable title + withheld suffix", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: ["fnd_with1"],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_with1",
            status: "withheld",
            priorFinding: {
              id: "fnd_with1",
              reviewer: "code_quality",
              severity: "suggestion",
              category: "style",
              title: "Unused variable in loop",
              body: "Unused var.",
              confidence: "medium",
              evidence: [],
              recommendation: "Remove it.",
            },
            lastSeenHeadSha: "cafe1234abcdef",
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("Unused variable in loop — withheld, last seen `cafe123`");
    // Count line unchanged
    expect(markdown).toContain("Withheld prior findings: 1");
    // Old opaque ID format must NOT appear
    expect(markdown).not.toContain("Withheld IDs:");
    expect(markdown).not.toContain("`fnd_with1`");
  });

  test("fixed classification with no priorFinding falls back to stableId code span", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_noPrior"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_noPrior",
            status: "fixed",
            lastSeenHeadSha: "111aaa",
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    // Falls back to stableId in a code span
    expect(markdown).toContain("✅ `fnd_noPrior`");
    // Does not throw or produce blank title
    expect(markdown).toContain("Fixed prior findings: 1");
  });

  test("fixed classification with no lastSeenHeadSha omits 'last seen' suffix", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_noSha"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_noSha",
            status: "fixed",
            priorFinding: {
              id: "fnd_noSha",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "Missing auth check",
              body: "No auth.",
              confidence: "high",
              evidence: [],
              recommendation: "Add auth.",
            },
            // no lastSeenHeadSha
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("✅ Missing auth check");
    // No "last seen" suffix when sha is absent
    expect(markdown).not.toContain("last seen");
    expect(markdown).toContain("Fixed prior findings: 1");
  });

  test("title with markdown metacharacters is escaped in fixed/withheld render", () => {
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_escape1"],
        withheldFindingIds: ["fnd_escape2"],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_escape1",
            status: "fixed",
            priorFinding: {
              id: "fnd_escape1",
              reviewer: "security",
              severity: "critical",
              category: "injection",
              title: "`x` and <b>bold</b>",
              body: "Injection.",
              confidence: "high",
              evidence: [],
              recommendation: "Fix it.",
            },
            lastSeenHeadSha: "aabbcc11223344",
          },
          {
            stableId: "fnd_escape2",
            status: "withheld",
            priorFinding: {
              id: "fnd_escape2",
              reviewer: "code_quality",
              severity: "suggestion",
              category: "style",
              title: "[link](http://evil.example)",
              body: "Bad link.",
              confidence: "low",
              evidence: [],
              recommendation: "Remove link.",
            },
            lastSeenHeadSha: "112233aabbcc",
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    // Backticks and angle brackets must be escaped
    expect(markdown).toContain("\\`x\\`");
    expect(markdown).toContain("\\<b\\>");
    // Link in withheld title must be escaped (brackets escaped)
    expect(markdown).toContain("\\[link\\]");
    // Raw unescaped metachar must not appear in the re-review section
    const reReviewIdx = markdown.indexOf("### Re-review status");
    const section = markdown.slice(reReviewIdx);
    // No raw unescaped backtick-x-backtick (would be `x`, not \`x\`)
    expect(section).not.toMatch(/(?<!\\)`x`(?!`)/);
  });

  // ---------------------------------------------------------------------------
  // Re-review: count/detail consistency (#289)
  // ---------------------------------------------------------------------------

  test("fixed count/detail mismatch: fixedFindingIds has entry but no matching classification — fallback row emitted (count N ⇒ N detail rows)", () => {
    // Regression for #289: fixedFindingIds has 1 entry but classifications has no fixed record.
    // Before the fix this rendered "Fixed prior findings: 1" with zero detail rows (silent gap).
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_orphan"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [], // intentionally empty — mismatch
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    // Count still says 1
    expect(markdown).toContain("Fixed prior findings: 1");
    // Fallback row uses the stable ID as a code span
    expect(markdown).toContain("✅ `fnd_orphan`");
    // No silent gap: count the "  - ✅" detail rows
    const detailRows = markdown.split("\n").filter((line) => line.startsWith("  - ✅"));
    expect(detailRows).toHaveLength(1);
  });

  test("withheld count/detail mismatch: withheldFindingIds has entry but no matching classification — fallback row emitted", () => {
    // Regression for #289: withheldFindingIds has 1 entry but classifications has no withheld record.
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: ["fnd_orphan_w"],
        carriedForwardFindingIds: [],
        classifications: [], // intentionally empty — mismatch
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    // Count still says 1
    expect(markdown).toContain("Withheld prior findings: 1");
    // Fallback row uses the stable ID as a code span + withheld suffix
    expect(markdown).toContain("`fnd_orphan_w` — withheld");
    // No silent gap: count the "  - " detail rows under Withheld
    const withheldIdx = markdown.indexOf("Withheld prior findings: 1");
    const afterWithheld = markdown.slice(withheldIdx);
    const withheldDetailRows = afterWithheld
      .split("\n")
      .filter((line) => line.startsWith("  - ") && line.includes("withheld"));
    expect(withheldDetailRows).toHaveLength(1);
  });

  test("mixed: one fixed with classification + one orphan fixed ID — count 2, both detail rows present", () => {
    // Two fixed IDs: one has a classification record, one is orphan. Both must appear as detail rows.
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_with_class", "fnd_orphan2"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_with_class",
            status: "fixed",
            priorFinding: {
              id: "fnd_with_class",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "Auth token leak",
              body: "Token was leaked.",
              confidence: "high",
              evidence: [],
              recommendation: "Rotate tokens.",
            },
            lastSeenHeadSha: "abc1234567",
          },
          // fnd_orphan2 intentionally absent from classifications
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    // Count is 2 (1 classified + 1 orphan)
    expect(markdown).toContain("Fixed prior findings: 2");
    // Classified row: readable title + sha
    expect(markdown).toContain("✅ Auth token leak — last seen `abc1234`");
    // Orphan row: fallback to stable ID code span
    expect(markdown).toContain("✅ `fnd_orphan2`");
    // Exactly 2 detail rows
    const detailRows = markdown.split("\n").filter((line) => line.startsWith("  - ✅"));
    expect(detailRows).toHaveLength(2);
  });

  test("normal case unchanged: classified fixed/withheld IDs still render readable titles (no regression)", () => {
    // Both fixedFindingIds and withheldFindingIds have matching classifications — normal path.
    const summary: ReviewSummary = {
      ...makeSummary({ findings: [] }),
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_f1"],
        withheldFindingIds: ["fnd_w1"],
        carriedForwardFindingIds: [],
        classifications: [
          {
            stableId: "fnd_f1",
            status: "fixed",
            priorFinding: {
              id: "fnd_f1",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "XSS in template",
              body: "Cross-site scripting.",
              confidence: "high",
              evidence: [],
              recommendation: "Escape output.",
            },
            lastSeenHeadSha: "deadbeef001",
          },
          {
            stableId: "fnd_w1",
            status: "withheld",
            priorFinding: {
              id: "fnd_w1",
              reviewer: "code_quality",
              severity: "suggestion",
              category: "style",
              title: "Magic number in config",
              body: "Hard-coded value.",
              confidence: "medium",
              evidence: [],
              recommendation: "Use a constant.",
            },
            lastSeenHeadSha: "cafe5678abc",
          },
        ],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    // Counts are still derived correctly
    expect(markdown).toContain("Fixed prior findings: 1");
    expect(markdown).toContain("Withheld prior findings: 1");
    // Readable titles preserved
    expect(markdown).toContain("✅ XSS in template — last seen `deadbee`");
    expect(markdown).toContain("Magic number in config — withheld, last seen `cafe567`");
  });

  test("break-glass footer always present before _Generated by_ line", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }));

    expect(markdown).toContain("🔓 Break glass");
    // ABSOLUTE link required: relative hrefs 404 from PR/MR comment pages, and the doc
    // lives in the factory repo, not the reviewed repo (PR #110 R2 finding).
    expect(markdown).toContain(
      "[Break-glass / human override](https://github.com/briggsd/ai-code-review-factory/blob/main/docs/developer/architecture.md#break-glass--human-override)",
    );

    // Footer must appear before the _Generated by_ line
    const footerIdx = markdown.indexOf("🔓 Break glass");
    const generatedIdx = markdown.indexOf("_Generated by ai-code-review-factory._");
    expect(footerIdx).toBeLessThan(generatedIdx);
  });

  test("_Generated by ai-code-review-factory._ line always present", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }));
    expect(markdown).toContain("_Generated by ai-code-review-factory._");
  });

  test("hidden metadata block always last when present", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }), {
      includeHiddenMetadata: true,
      hiddenMetadata: { schemaVersion: 1 },
    });

    const generatedIdx = markdown.indexOf("_Generated by ai-code-review-factory._");
    const metaIdx = markdown.indexOf("<!-- ai-code-review-factory");
    expect(metaIdx).toBeGreaterThan(generatedIdx);
  });
});

// ---------------------------------------------------------------------------
// 8. Multi-reviewer 8-finding summary (sample output)
// ---------------------------------------------------------------------------

describe("multi-reviewer 8-finding summary", () => {
  test("8-finding multi-reviewer summary renders all groups and sections", () => {
    const findings: Finding[] = [
      makeFinding({
        reviewer: "security",
        severity: "critical",
        title: "SQL injection in query builder",
        body: "User input is concatenated directly into SQL.",
        evidence: ["Line 42: `query += userInput`"],
        recommendation: "Use parameterized queries.",
        location: { path: "src/db/query.ts", line: 42 },
      }),
      makeFinding({
        reviewer: "security",
        severity: "warning",
        title: "Missing CSRF token check",
        body: "POST endpoint lacks CSRF protection.",
        evidence: ["No csrf middleware applied."],
        recommendation: "Add csrf middleware to all state-changing routes.",
      }),
      makeFinding({
        reviewer: "security",
        severity: "suggestion",
        title: "Log rotation not configured",
        body: "Logs may grow unbounded.",
        evidence: [],
        recommendation: "Configure log rotation.",
      }),
      makeFinding({
        reviewer: "code_quality",
        severity: "warning",
        title: "Missing null check on response",
        body: "Response can be null, causing a crash.",
        evidence: ["response.data used without null check."],
        recommendation: "Check for null before accessing response.data.",
      }),
      makeFinding({
        reviewer: "code_quality",
        severity: "suggestion",
        title: "Unused import",
        body: "Import is never used.",
        evidence: [],
        recommendation: "Remove the unused import.",
      }),
      makeFinding({
        reviewer: "documentation",
        severity: "suggestion",
        title: "Missing JSDoc on public API",
        body: "Public function lacks documentation.",
        evidence: [],
        recommendation: "Add JSDoc comments.",
      }),
      makeFinding({
        reviewer: "perf_v2",
        severity: "warning",
        title: "N+1 query in list endpoint",
        body: "Each item fetches from DB separately.",
        evidence: ["Loop at line 88 calls findById."],
        recommendation: "Use a batch fetch.",
        location: { path: "src/api/list.ts", line: 88 },
      }),
      makeFinding({
        reviewer: "perf_v2",
        severity: "suggestion",
        title: "Unindexed sort column",
        body: "Sorting on unindexed column is slow.",
        evidence: [],
        recommendation: "Add an index on the sort column.",
      }),
    ];

    const summary = makeSummary({ findings, decision: "significant_concerns", outcome: "fail" });
    const markdown = formatReviewSummaryMarkdown(summary, {
      includeHiddenMetadata: true,
      hiddenMetadata: { schemaVersion: 1, runId: "test-8-finding" },
    });

    // All four groups present in correct order
    const secIdx = markdown.indexOf("🔒 security");
    const cqIdx = markdown.indexOf("🧹 code\\_quality");
    const docIdx = markdown.indexOf("📚 documentation");
    const perfIdx = markdown.indexOf("🔍 perf\\_v2");
    expect(secIdx).toBeGreaterThan(-1);
    expect(cqIdx).toBeGreaterThan(secIdx);
    expect(docIdx).toBeGreaterThan(cqIdx);
    expect(perfIdx).toBeGreaterThan(docIdx);

    // Security group: 1 critical, 1 warning, 1 suggestion
    const secGroup = markdown.slice(secIdx, cqIdx);
    expect(secGroup).toContain("🔴 1 critical");
    expect(secGroup).toContain("⚠️ 1 warning");
    expect(secGroup).toContain("💬 1 suggestion");
    expect(secGroup).toContain("Recommendation: 🔴 Major Comments");

    // One-line bullets (above the fold, before details)
    expect(secGroup).toContain("CRITICAL: SQL injection in query builder");
    expect(secGroup).toContain("WARNING: Missing CSRF token check");

    // Details block for security group (3 findings)
    expect(secGroup).toContain("View full review (3 findings)");

    // Break-glass footer present
    expect(markdown).toContain("🔓 Break glass");

    // Hidden metadata parseable
    const parsed = parseSummaryHiddenMetadata(markdown);
    expect(parsed?.runId).toBe("test-8-finding");

    // Generated by line
    expect(markdown).toContain("_Generated by ai-code-review-factory._");
  });
});

// ---------------------------------------------------------------------------
// 9. Grounding-withheld block (#204)
// ---------------------------------------------------------------------------

describe("grounding-withheld block (#204, #207 low-confidence reframe)", () => {
  test("all-withheld: renders 'No blocking findings' and low-confidence heading (#207)", () => {
    const withheld = makeFinding({
      reviewer: "security",
      title: "Withheld vuln",
      severity: "critical",
    });
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ findings: [], groundingWithheld: [withheld] }),
    );

    // Must use the low-confidence message, not the bare one
    expect(markdown).toContain("No blocking findings (see low-confidence block below).");
    expect(markdown).not.toMatch(/^No findings\.$/m);
    // Old wording must be gone
    expect(markdown).not.toContain("No findings survived grounding.");

    // Low-confidence block heading and context note (#207)
    expect(markdown).toContain("### ⚠️ Low-confidence findings (kept, non-blocking)");
    expect(markdown).toContain("Excluded from the gate / not counted toward the result");

    // Low-confidence finding title appears as a one-liner
    expect(markdown).toContain("Withheld vuln");
  });

  test("partial: grounded finding + low-confidence finding — both blocks render", () => {
    const grounded = makeFinding({
      reviewer: "code_quality",
      title: "Grounded nit",
      severity: "suggestion",
    });
    const withheld = makeFinding({
      reviewer: "security",
      title: "Withheld issue",
      severity: "warning",
    });
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ findings: [grounded], groundingWithheld: [withheld] }),
    );

    // Normal reviewer group rendered
    expect(markdown).toContain("🧹 code\\_quality");
    expect(markdown).toContain("Grounded nit");

    // Low-confidence block also rendered (#207)
    expect(markdown).toContain("### ⚠️ Low-confidence findings (kept, non-blocking)");
    expect(markdown).toContain("Withheld issue");

    // Old wording must be gone
    expect(markdown).not.toContain("No findings survived grounding.");
    // Old heading must be gone
    expect(markdown).not.toContain("Withheld (ungrounded this run)");
    // Bare "No findings." must also NOT appear
    expect(markdown).not.toMatch(/^No findings\.$/m);
  });

  test("regression: no groundingWithheld + zero findings → plain 'No findings.' preserved", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }));

    expect(markdown).toContain("No findings.");
    expect(markdown).not.toContain("No blocking findings");
    expect(markdown).not.toContain("Low-confidence findings");
  });

  test("low-confidence block not rendered when groundingWithheld is undefined", () => {
    const finding = makeFinding({ title: "Normal finding" });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    expect(markdown).not.toContain("Low-confidence findings");
    expect(markdown).not.toContain("Withheld (ungrounded this run)");
  });

  test("withheld findings are severity-sorted and rendered as one-liners", () => {
    const withheld = [
      makeFinding({ title: "Suggestion withheld", severity: "suggestion" }),
      makeFinding({ title: "Critical withheld", severity: "critical" }),
      makeFinding({ title: "Warning withheld", severity: "warning" }),
    ];
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ findings: [], groundingWithheld: withheld }),
    );

    const critIdx = markdown.indexOf("CRITICAL: Critical withheld");
    const warnIdx = markdown.indexOf("WARNING: Warning withheld");
    const suggIdx = markdown.indexOf("SUGGESTION: Suggestion withheld");

    expect(critIdx).toBeGreaterThan(-1);
    expect(warnIdx).toBeGreaterThan(-1);
    expect(suggIdx).toBeGreaterThan(-1);
    // Critical before warning before suggestion
    expect(critIdx).toBeLessThan(warnIdx);
    expect(warnIdx).toBeLessThan(suggIdx);
  });
});

describe("break-glass section in docs/developer/architecture.md", () => {
  test("architecture.md documents the Break-glass / human override section", async () => {
    const arch = await readFile("docs/developer/architecture.md", "utf8");

    expect(arch).toContain("Break-glass / human override");
    expect(arch).toContain("admin-only");
    expect(arch).toContain("not yet recorded as a review-level telemetry event");
    expect(arch).toContain("run.override");
    expect(arch).toContain("issue #22");
  });
});

// ---------------------------------------------------------------------------
// Partial-by-size block (#145)
// ---------------------------------------------------------------------------

describe("partial-by-size block (#145)", () => {
  const basePartialBySize = {
    admittedFileCount: 3,
    droppedFileCount: 2,
    originalBytes: 700_000,
    admittedBytes: 500_000,
    budgetBytes: 512_000,
    droppedPaths: ["src/huge-a.ts", "src/huge-b.ts"],
  };

  test("renders partial-by-size block when partialBySize is present", () => {
    const summary = makeSummary({ partialBySize: basePartialBySize });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("Partial review by size");
    expect(markdown).toContain("3 of 5 changed files");
    // Paths are escaped via escapeMarkdown; hyphens and dots mid-string are not escaped.
    expect(markdown).toContain("src/huge-a.ts");
    expect(markdown).toContain("src/huge-b.ts");
  });

  test("does NOT render partial-by-size block when partialBySize is absent", () => {
    // No partialBySize → omit the field entirely (exactOptionalPropertyTypes).
    const summary = makeSummary();
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("Partial review by size");
    expect(markdown).not.toContain("reviewed by name only");
  });

  test("renders '…and N more' marker when droppedPaths exceeds 20", () => {
    // Build 25 dropped paths — first 20 should appear, then the overflow marker.
    const droppedPaths = Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`);
    const summary = makeSummary({
      partialBySize: {
        ...basePartialBySize,
        droppedPaths,
        droppedFileCount: 25,
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("…and 5 more");
    // First 20 should be present; 21st (index 20) should NOT appear directly.
    // Dots in paths are NOT escaped mid-string by escapeMarkdown.
    expect(markdown).toContain("src/file0.ts");
    expect(markdown).toContain("src/file19.ts");
    // file20 through file24 should NOT appear as individual paths (collapsed into "and N more")
    expect(markdown).not.toContain("src/file20.ts");
  });

  test("no '…and N more' marker when droppedPaths is exactly 20", () => {
    const droppedPaths = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const summary = makeSummary({
      partialBySize: {
        ...basePartialBySize,
        droppedPaths,
        droppedFileCount: 20,
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("…and");
    expect(markdown).toContain("src/file19.ts");
  });

  test("paths in partial-by-size block are markdown-escaped (injection defense)", () => {
    const summary = makeSummary({
      partialBySize: {
        ...basePartialBySize,
        droppedPaths: ["src/file**bold**.ts", "src/file<img src=x>.ts"],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    // Raw metacharacters must not appear in the output.
    expect(markdown).not.toContain("**bold**");
    expect(markdown).not.toContain("<img src=x>");
    // Escaped forms should be present.
    expect(markdown).toContain("\\*\\*bold\\*\\*");
    expect(markdown).toContain("\\<img");
  });

  test("budget and admitted byte values are shown in SI units in the header line", () => {
    const summary = makeSummary({
      partialBySize: {
        admittedFileCount: 2,
        droppedFileCount: 1,
        originalBytes: 800_000,
        admittedBytes: 200_000,
        budgetBytes: 512_000,
        droppedPaths: ["src/huge.ts"],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    // SI units (÷1000) so the display matches the round patchBudgets defaults/docs (#145, AI-review).
    expect(markdown).toContain("200 KB"); // Math.round(200_000/1000)
    expect(markdown).toContain("512 KB"); // Math.round(512_000/1000)
  });

  test("budgets ≥ 1 MB render in MB (SI)", () => {
    const summary = makeSummary({
      partialBySize: {
        admittedFileCount: 1,
        droppedFileCount: 5,
        originalBytes: 10_000_000,
        admittedBytes: 3_500_000,
        budgetBytes: 4_000_000,
        droppedPaths: ["src/huge.ts"],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("3.5 MB"); // Math.round(3_500_000/100_000)/10
    expect(markdown).toContain("4 MB"); // Math.round(4_000_000/100_000)/10
  });
});

// ---------------------------------------------------------------------------
// Degraded-review banner (#212)
// ---------------------------------------------------------------------------

describe("formatReviewSummaryMarkdown — degraded banner (#212)", () => {
  test("renders degraded banner with count and role names when degraded is set", () => {
    const summary = makeSummary({
      degraded: {
        failedReviewerCount: 2,
        completedReviewerCount: 1,
        failedRoles: ["code_quality", "performance"],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("Degraded review");
    expect(markdown).toContain("2 of 3");
    expect(markdown).toContain("code\\_quality"); // escaped
    expect(markdown).toContain("performance");
  });

  test("summary WITHOUT degraded does not contain 'Degraded review'", () => {
    const summary = makeSummary();
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("Degraded review");
  });

  test("degraded banner appears above reviewer groups (above the fold)", () => {
    const summary = makeSummary({
      degraded: {
        failedReviewerCount: 1,
        completedReviewerCount: 1,
        failedRoles: ["code_quality"],
      },
      findings: [makeFinding({ reviewer: "security", severity: "warning", title: "Some issue" })],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    const bannerIdx = markdown.indexOf("Degraded review");
    const reviewerGroupIdx = markdown.indexOf("🔒 security");

    expect(bannerIdx).toBeGreaterThan(-1);
    expect(reviewerGroupIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(reviewerGroupIdx);
  });

  test("role names with CR/LF are sanitized and escaped in the banner", () => {
    const summary = makeSummary({
      degraded: {
        failedReviewerCount: 1,
        completedReviewerCount: 1,
        failedRoles: ["bad\nrole\r\nname"],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    // CR/LF stripped, then escaped — role value appears as "bad role name" (spaces, not newlines)
    expect(markdown).toContain("bad role name");
    // The banner line itself must not split into multiple blockquote lines due to the embedded
    // newline in the role text. Extract the blockquote line and check the role text doesn't
    // contain a raw newline.
    const bannerLine = markdown
      .split("\n")
      .find((line) => line.startsWith("> ⚠️ **Degraded review"));
    expect(bannerLine).toBeDefined();
    // The single banner line must contain the sanitized role text, not be broken
    expect(bannerLine).toContain("bad role name");
  });
});

// ---------------------------------------------------------------------------
// Dismiss-this-finding block (#159)
// ---------------------------------------------------------------------------

describe("dismiss-this-finding block (#159)", () => {
  // Helper: extract the dismiss <details> block from a single-finding render.
  // Looks for the block that starts with the "Acknowledge / dismiss this finding" summary.
  function extractDismissBlock(markdown: string): string | null {
    const start = markdown.indexOf(
      "<details><summary>Acknowledge / dismiss this finding</summary>",
    );
    if (start === -1) return null;
    const end = markdown.indexOf("</details>", start);
    if (end === -1) return null;
    return markdown.slice(start, end + "</details>".length);
  }

  // Helper: extract + JSON.parse the first JSON code block inside the dismiss block.
  function parseJsonFromBlock(block: string): Record<string, string> {
    // Match a fenced code block: fence marker (3+ backticks) + "json" ... fence marker.
    const match = block.match(/(`{3,})json\n([\s\S]*?)\n\1/);
    if (match === null) throw new Error("No JSON fence block found in dismiss block");
    return JSON.parse(match[2]!) as Record<string, string>;
  }

  test("1. snippet present + correct fields (parse JSON, don't substring-match)", () => {
    const finding = makeFinding({
      id: "fnd_abc123",
      category: "auth",
      location: { path: "src/auth.ts", line: 10 },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const block = extractDismissBlock(markdown);
    expect(block).not.toBeNull();

    const parsed = parseJsonFromBlock(block!);
    expect(parsed["path"]).toBe("src/auth.ts");
    expect(parsed["category"]).toBe("auth");
    expect(parsed["stableFindingId"]).toBe("fnd_abc123");
    expect(parsed["mode"]).toBe("acknowledge");
    // verdict is modeled in the template (#256) so a dismiss intent isn't silently defaulted.
    expect(parsed["verdict"]).toBe("acknowledged");
    expect(parsed["reason"]).toBe("<why this is intentional>");

    // Instruction text must clarify acknowledge-vs-suppress behaviour + the expires option
    // (PR #269 review): "Dismiss" alone misleads since acknowledge keeps the finding visible.
    expect(block).toContain("base branch");
    expect(block).toContain('"suppress"');
    expect(block).toContain('"expires"');
  });

  test("2. stableFindingId omitted when no id — block still parses and has no stableFindingId key", () => {
    const finding = makeFinding({
      // no id field
      category: "auth",
      location: { path: "src/auth.ts" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const block = extractDismissBlock(markdown);
    expect(block).not.toBeNull();

    const parsed = parseJsonFromBlock(block!);
    expect(parsed["path"]).toBe("src/auth.ts");
    expect(parsed["category"]).toBe("auth");
    expect(parsed["mode"]).toBe("acknowledge");
    // stableFindingId must NOT be present
    expect(Object.hasOwn(parsed, "stableFindingId")).toBe(false);
  });

  test("3. skipped for path-less findings (no location.path)", () => {
    const finding = makeFinding({
      // no location at all
      category: "auth",
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const block = extractDismissBlock(markdown);
    expect(block).toBeNull();
  });

  test("4. skipped for already-acknowledged findings", () => {
    const finding = makeFinding({
      id: "fnd_xyz",
      category: "auth",
      location: { path: "src/auth.ts" },
      acknowledged: { reason: "tracked via TICKET-42" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const block = extractDismissBlock(markdown);
    expect(block).toBeNull();
  });

  test("5. code-fence-breakout guard — path with triple-backtick still yields intact block", () => {
    // A path containing a triple-backtick would naively close a 3-backtick fence early.
    // The fence must be sized to exceed the longest backtick run in the JSON payload.
    const finding = makeFinding({
      id: "fnd_fence_test",
      category: "injection",
      location: { path: "a```b" }, // triple-backtick in path
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const block = extractDismissBlock(markdown);
    expect(block).not.toBeNull();

    // The JSON must round-trip correctly (no premature fence closure).
    const parsed = parseJsonFromBlock(block!);
    expect(parsed["path"]).toBe("a```b");
    expect(parsed["mode"]).toBe("acknowledge");

    // The outer markdown structure must be intact: </details> must close the block.
    expect(block!.endsWith("</details>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 14. runStats — footer stats + low-activity warning (#285)
// ---------------------------------------------------------------------------

describe("runStats — footer stats and low-activity warning (#285)", () => {
  test("footer with runStats folds stats into the generated-by line", () => {
    const summary = makeSummary({
      findings: [],
      runStats: { durationMs: 175000, modelTokenTotal: 47200, reviewerCount: 5, tier: "full" },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain(
      "_Generated by ai-code-review-factory · Review: 175s · 5 reviewers · ~47.2k model tokens._",
    );
    // Must NOT contain the bare line when runStats is present
    expect(markdown).not.toContain("_Generated by ai-code-review-factory._");
  });

  test("footer uses singular 'reviewer' when reviewerCount is 1", () => {
    const summary = makeSummary({
      findings: [],
      runStats: { durationMs: 12000, modelTokenTotal: 8000, reviewerCount: 1, tier: "lite" },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("1 reviewer ·");
    expect(markdown).not.toContain("1 reviewers");
  });

  test("back-compat: summary with no runStats renders bare generated-by line and no stats/warning", () => {
    const summary = makeSummary({ findings: [] });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("_Generated by ai-code-review-factory._");
    // No stats injected
    expect(markdown).not.toContain("model tokens");
    expect(markdown).not.toContain("reviewers ·");
    // No warning
    expect(markdown).not.toContain("Low model activity");
  });

  test("low-activity warning fires when tier is not trivial and modelTokenTotal is 0", () => {
    const summary = makeSummary({
      findings: [],
      runStats: { durationMs: 8000, modelTokenTotal: 0, reviewerCount: 3, tier: "full" },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    // Assert on a string UNIQUE to the warning block (not just "~0 model tokens" which also
    // appears in the footer line and would pass even if the warning block were suppressed).
    expect(markdown).toContain("Low model activity");
    expect(markdown).toContain("~0 model tokens");
    // No bare internal issue reference in published comment text (adopter-boundary).
    expect(markdown).not.toContain("#283");
  });

  test("no warning when tier is not trivial and modelTokenTotal is non-zero (full + 12000)", () => {
    const summary = makeSummary({
      findings: [],
      runStats: { durationMs: 60000, modelTokenTotal: 12000, reviewerCount: 3, tier: "full" },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("Low model activity");
  });

  test("no warning when tier is trivial and modelTokenTotal is 0 (respects #65 fast-path)", () => {
    const summary = makeSummary({
      findings: [],
      runStats: { durationMs: 500, modelTokenTotal: 0, reviewerCount: 0, tier: "trivial" },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("Low model activity");
  });

  test("low-activity warning appears before the body/findings (above the fold)", () => {
    const summary = makeSummary({
      findings: [],
      runStats: { durationMs: 8000, modelTokenTotal: 0, reviewerCount: 3, tier: "full" },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    const warningIdx = markdown.indexOf("Low model activity");
    const bodyIdx = markdown.indexOf(summary.body);
    // Warning appears before the body content
    expect(warningIdx).toBeGreaterThan(-1);
    expect(warningIdx).toBeLessThan(bodyIdx);
  });

  // Token formatting tests
  describe("formatTokenCount", () => {
    test("under 1000 → bare integer", () => {
      expect(formatTokenCount(0)).toBe("0");
      expect(formatTokenCount(1)).toBe("1");
      expect(formatTokenCount(999)).toBe("999");
    });

    test("thousands → k suffix (47200 → 47.2k)", () => {
      expect(formatTokenCount(47200)).toBe("47.2k");
      expect(formatTokenCount(1000)).toBe("1k");
      expect(formatTokenCount(10000)).toBe("10k");
      expect(formatTokenCount(1500)).toBe("1.5k");
    });

    test("millions → M suffix (1_200_000 → 1.2M)", () => {
      expect(formatTokenCount(1_200_000)).toBe("1.2M");
      expect(formatTokenCount(1_000_000)).toBe("1M");
      expect(formatTokenCount(2_500_000)).toBe("2.5M");
    });

    test("boundary guard: 999_950 rounds to 1000k → promotes to '1M'", () => {
      // Math.round(999_950 / 1000 * 10) / 10 = Math.round(9999.5) / 10 = 10000 / 10 = 1000
      // Without the guard this would emit "1000k" — the guard must promote it to "1M".
      expect(formatTokenCount(999_950)).toBe("1M");
      // Also check the values just below the boundary stay as k
      expect(formatTokenCount(999_940)).toBe("999.9k");
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-round resolved-finding history (#279, M026 S02)
// ---------------------------------------------------------------------------

describe("resolvedLog — cross-round history section", () => {
  test("renders collapsed <details> history when resolvedLog is present and non-empty", () => {
    const summary = makeSummary({
      findings: [],
      resolvedLog: [
        { stableId: "fnd_old", title: "Old auth issue", resolvedAtSha: "abc1234" },
        { stableId: "fnd_old2", title: "Second old issue", resolvedAtSha: "def5678" },
      ],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("🗂 Resolved over this PR (2)");
    expect(markdown).toContain("✅ Old auth issue — fixed in `abc1234`");
    expect(markdown).toContain("✅ Second old issue — fixed in `def5678`");
    expect(markdown).toContain("<details>");
    expect(markdown).toContain("</details>");
  });

  test("absent resolvedLog renders nothing (back-compat — first review / fixture path)", () => {
    const summary = makeSummary({ findings: [] }); // resolvedLog absent (not set)
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("🗂 Resolved over this PR");
    expect(markdown).not.toContain("resolvedLog");
  });

  test("empty resolvedLog array renders nothing", () => {
    const summary = makeSummary({ findings: [], resolvedLog: [] });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("🗂 Resolved over this PR");
  });

  test("entry whose stableId is in current findings is filtered out (recurred — shown as current)", () => {
    const finding = makeFinding({ id: "fnd_recurring", title: "Still open issue" });
    const summary = makeSummary({
      findings: [finding],
      resolvedLog: [
        // This one recurred — must NOT appear in history
        { stableId: "fnd_recurring", title: "Still open issue", resolvedAtSha: "abc1234" },
        // This one is genuinely resolved — must appear
        { stableId: "fnd_gone", title: "Gone for good", resolvedAtSha: "def5678" },
      ],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    // Genuinely resolved entry appears
    expect(markdown).toContain("✅ Gone for good — fixed in `def5678`");
    // Recurred entry does NOT appear in history section
    // (it IS shown in the current findings block though)
    const historySection = markdown.slice(markdown.indexOf("🗂 Resolved over this PR"));
    expect(historySection).not.toContain("Still open issue");
    // The history count reflects only the visible entry
    expect(markdown).toContain("🗂 Resolved over this PR (1)");
  });

  test("all entries recurred → history section not rendered at all", () => {
    const finding = makeFinding({ id: "fnd_back", title: "Back again" });
    const summary = makeSummary({
      findings: [finding],
      resolvedLog: [{ stableId: "fnd_back", title: "Back again", resolvedAtSha: "abc1234" }],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("🗂 Resolved over this PR");
  });

  test("titles are run through escapeMarkdown (#74 — untrusted prior-comment content)", () => {
    const summary = makeSummary({
      findings: [],
      resolvedLog: [
        {
          stableId: "fnd_x",
          title: "Issue with `backtick` and _underscore_",
          resolvedAtSha: "abc1234",
        },
      ],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    // escapeMarkdown should escape backticks and underscores
    expect(markdown).toContain("\\`backtick\\`");
    expect(markdown).toContain("\\_underscore\\_");
  });

  test("resolvedLogTruncated=true adds truncation note (explicit flag, any log size)", () => {
    // A >50 case with resolvedLogTruncated=true (as set by buildResolvedLog when merged > cap).
    const log = Array.from({ length: 50 }, (_, i) => ({
      stableId: `fnd_${i}`,
      title: `Issue ${i}`,
      resolvedAtSha: "abc1234",
    }));
    const summary = makeSummary({ findings: [], resolvedLog: log, resolvedLogTruncated: true });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("older resolved findings omitted");
  });

  test("resolvedLog at exactly 50 entries without resolvedLogTruncated shows NO truncation note", () => {
    // Exactly 50 entries — NOT truncated (merged.length === RESOLVED_LOG_CAP, not >).
    // resolvedLogTruncated is absent (not set), so no omitted note should appear.
    const log = Array.from({ length: 50 }, (_, i) => ({
      stableId: `fnd_${i}`,
      title: `Issue ${i}`,
      resolvedAtSha: "abc1234",
    }));
    const summary = makeSummary({ findings: [], resolvedLog: log });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("older resolved findings omitted");
  });

  test("resolvedLog below cap (49 entries) does NOT add truncation note", () => {
    const log = Array.from({ length: 49 }, (_, i) => ({
      stableId: `fnd_${i}`,
      title: `Issue ${i}`,
      resolvedAtSha: "abc1234",
    }));
    const summary = makeSummary({ findings: [], resolvedLog: log });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("older resolved findings omitted");
  });

  test("history section appears after re-review status and before break-glass footer", () => {
    const summary = makeSummary({
      findings: [],
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_old"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [],
      },
      resolvedLog: [{ stableId: "fnd_old", title: "Old issue", resolvedAtSha: "abc1234" }],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    const reReviewIdx = markdown.indexOf("### Re-review status");
    const historyIdx = markdown.indexOf("🗂 Resolved over this PR");
    const breakGlassIdx = markdown.indexOf("Break glass");

    expect(reReviewIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(-1);
    expect(breakGlassIdx).toBeGreaterThan(-1);
    expect(reReviewIdx).toBeLessThan(historyIdx);
    expect(historyIdx).toBeLessThan(breakGlassIdx);
  });
});

// ---------------------------------------------------------------------------
// #280 — Disposition surfacing: rollup line + verdict-aware ack suffix
// ---------------------------------------------------------------------------

describe("disposition surfacing (#280)", () => {
  // Helper to build a minimal recurring classification with an optional ack.
  function makeRecurring(
    id: string,
    ack?: { reason: string; verdict?: "dismissed" | "acknowledged" },
  ): import("../src/contracts/review.ts").ReReviewFindingClassification {
    return {
      stableId: id,
      status: "recurring",
      finding: {
        id,
        reviewer: "security",
        severity: "warning",
        category: "auth",
        title: `Finding ${id}`,
        body: "Body.",
        confidence: "high",
        evidence: [],
        recommendation: "Fix it.",
        ...(ack !== undefined ? { acknowledged: ack } : {}),
      },
    };
  }

  function makeFixed(
    id: string,
    priorAck?: { reason: string; verdict?: "dismissed" | "acknowledged" },
  ): import("../src/contracts/review.ts").ReReviewFindingClassification {
    return {
      stableId: id,
      status: "fixed",
      priorFinding: {
        id,
        reviewer: "security",
        severity: "warning",
        category: "auth",
        title: `Prior finding ${id}`,
        body: "Was a bug.",
        confidence: "high",
        evidence: [],
        recommendation: "Already fixed.",
        ...(priorAck !== undefined ? { acknowledged: priorAck } : {}),
      },
      lastSeenHeadSha: "abc1234567890",
    };
  }

  // ---------------------------------------------------------------------------
  // Part 1: disposition rollup
  // ---------------------------------------------------------------------------

  test("rollup line renders all four nonzero categories", () => {
    const summary = makeSummary({
      findings: [makeFinding({ id: "fnd_rec_ign", title: "Ignored finding" })],
      reReview: {
        newFindingIds: [],
        recurringFindingIds: ["fnd_rec_ign", "fnd_rec_ack", "fnd_rec_dis"],
        fixedFindingIds: ["fnd_fixed"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [
          makeFixed("fnd_fixed"),
          makeRecurring("fnd_rec_dis", { reason: "wrong call", verdict: "dismissed" }),
          makeRecurring("fnd_rec_ign"), // no ack → ignored
          makeRecurring("fnd_rec_ack", { reason: "intentional" }), // ack, no dismiss verdict → acknowledged
        ],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain(
      "- Dispositions: 1 fixed · 1 dismissed · 1 ignored · 1 acknowledged",
    );
  });

  test("rollup omits zero categories", () => {
    // Only fixed and ignored — dismissed and acknowledged are 0.
    const summary = makeSummary({
      findings: [makeFinding({ id: "fnd_rec_ign2", title: "Ignored finding 2" })],
      reReview: {
        newFindingIds: [],
        recurringFindingIds: ["fnd_rec_ign2"],
        fixedFindingIds: ["fnd_fixed2"],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [makeFixed("fnd_fixed2"), makeRecurring("fnd_rec_ign2")],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("- Dispositions: 1 fixed · 1 ignored");
    expect(markdown).not.toContain("dismissed");
    expect(markdown).not.toContain("acknowledged");
  });

  test("rollup line is absent when all dispositions are zero (e.g. only carried_forward classifications)", () => {
    const summary = makeSummary({
      findings: [],
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: [],
        carriedForwardFindingIds: ["fnd_cf"],
        classifications: [
          {
            stableId: "fnd_cf",
            status: "carried_forward",
            priorFinding: {
              id: "fnd_cf",
              reviewer: "security",
              severity: "warning",
              category: "auth",
              title: "Carried",
              body: "",
              confidence: "high",
              evidence: [],
              recommendation: "",
            },
          },
        ],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("Dispositions:");
  });

  test("rollup line is absent when reReview.classifications is empty", () => {
    const summary = makeSummary({
      findings: [],
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: [],
        carriedForwardFindingIds: [],
        classifications: [],
      },
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).not.toContain("Dispositions:");
  });

  // ---------------------------------------------------------------------------
  // Part 2: verdict-aware acknowledged suffix
  // ---------------------------------------------------------------------------

  test("dismissed finding renders '✗ dismissed: <reason>' NOT 'acknowledged' in one-liner", () => {
    const finding = makeFinding({
      title: "Auth bypass",
      acknowledged: { reason: "won't fix", verdict: "dismissed" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find(
      (l) => l.startsWith("- **WARNING:") && l.includes("Auth bypass"),
    )!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("_✗ dismissed: won't fix_");
    expect(bulletLine).not.toContain("_acknowledged:");
  });

  test("dismissed finding renders '✗ dismissed: <reason>' NOT 'acknowledged' in the detail block", () => {
    const finding = makeFinding({
      title: "Auth bypass detail",
      acknowledged: { reason: "won't fix", verdict: "dismissed" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const detailsStart = markdown.indexOf("<details><summary>View full review");
    const detailsEnd = markdown.indexOf("</details>", detailsStart);
    const detailsBlock = markdown.slice(detailsStart, detailsEnd);

    expect(detailsBlock).toContain("_✗ dismissed: won't fix_");
    expect(detailsBlock).not.toContain("_acknowledged:");
  });

  test("acknowledged finding (no verdict) still renders 'acknowledged: <reason>' (back-compat)", () => {
    const finding = makeFinding({
      title: "Back-compat ack",
      acknowledged: { reason: "tracked via JIRA-123" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find(
      (l) => l.startsWith("- **WARNING:") && l.includes("Back-compat ack"),
    )!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("_acknowledged: tracked via JIRA-123_");
    expect(bulletLine).not.toContain("dismissed");
  });

  test("acknowledged finding with explicit verdict 'acknowledged' renders 'acknowledged: <reason>'", () => {
    const finding = makeFinding({
      title: "Explicit ack verdict",
      acknowledged: { reason: "accepted as-is", verdict: "acknowledged" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find(
      (l) => l.startsWith("- **WARNING:") && l.includes("Explicit ack verdict"),
    )!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("_acknowledged: accepted as-is_");
    expect(bulletLine).not.toContain("dismissed");
  });

  test("dismissed reason with markdown metacharacters is escaped", () => {
    const finding = makeFinding({
      title: "Esc dismissed",
      acknowledged: { reason: "Use `safeMode` and **always** check", verdict: "dismissed" },
    });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

    const lines = markdown.split("\n");
    const bulletLine = lines.find(
      (l) => l.startsWith("- **WARNING:") && l.includes("Esc dismissed"),
    )!;
    expect(bulletLine).toBeDefined();
    expect(bulletLine).toContain("\\`safeMode\\`");
    expect(bulletLine).toContain("\\*\\*always\\*\\*");
    expect(bulletLine).not.toContain("`safeMode`");
  });
});
