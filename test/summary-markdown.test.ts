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
 *  - Doc test: break-glass section present in docs/architecture.md
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { Finding, ReviewSummary } from "../src/index.ts";
import { formatReviewSummaryMarkdown, parseSummaryHiddenMetadata } from "../src/index.ts";

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
        classifications: [],
      },
    };
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(markdown).toContain("### Re-review status");
    expect(markdown).toContain("New findings: 0");
    expect(markdown).toContain("Recurring findings: 1");
    expect(markdown).toContain("Fixed prior findings: 1");
    expect(markdown).toContain("`fnd_2`");
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

  test("break-glass footer always present before _Generated by_ line", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }));

    expect(markdown).toContain("🔓 Break glass");
    // ABSOLUTE link required: relative hrefs 404 from PR/MR comment pages, and the doc
    // lives in the factory repo, not the reviewed repo (PR #110 R2 finding).
    expect(markdown).toContain(
      "[Break-glass / human override](https://github.com/briggsd/ai-code-review-factory/blob/main/docs/architecture.md#break-glass--human-override)",
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

describe("grounding-withheld block (#204)", () => {
  test("all-withheld: renders 'No findings survived grounding.' and withheld heading", () => {
    const withheld = makeFinding({
      reviewer: "security",
      title: "Withheld vuln",
      severity: "critical",
    });
    const markdown = formatReviewSummaryMarkdown(
      makeSummary({ findings: [], groundingWithheld: [withheld] }),
    );

    // Must use the survived-grounding message, not the bare one
    expect(markdown).toContain("No findings survived grounding.");
    expect(markdown).not.toMatch(/^No findings\.$/m);

    // Withheld block heading and context note
    expect(markdown).toContain("### ⚠️ Withheld (ungrounded this run)");
    expect(markdown).toContain("withheld from the result");

    // Withheld finding title appears as a one-liner
    expect(markdown).toContain("Withheld vuln");
  });

  test("partial: grounded finding + withheld finding — both blocks render", () => {
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

    // Withheld block also rendered
    expect(markdown).toContain("### ⚠️ Withheld (ungrounded this run)");
    expect(markdown).toContain("Withheld issue");

    // Bare "No findings survived grounding." must NOT appear (there are grounded findings)
    expect(markdown).not.toContain("No findings survived grounding.");
    // Bare "No findings." must also NOT appear
    expect(markdown).not.toMatch(/^No findings\.$/m);
  });

  test("regression: no groundingWithheld + zero findings → plain 'No findings.' preserved", () => {
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [] }));

    expect(markdown).toContain("No findings.");
    expect(markdown).not.toContain("No findings survived grounding.");
    expect(markdown).not.toContain("Withheld (ungrounded this run)");
  });

  test("withheld block not rendered when groundingWithheld is undefined", () => {
    const finding = makeFinding({ title: "Normal finding" });
    const markdown = formatReviewSummaryMarkdown(makeSummary({ findings: [finding] }));

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

describe("break-glass section in docs/architecture.md", () => {
  test("architecture.md documents the Break-glass / human override section", async () => {
    const arch = await readFile("docs/architecture.md", "utf8");

    expect(arch).toContain("Break-glass / human override");
    expect(arch).toContain("admin-only");
    expect(arch).toContain("not yet recorded as a review-level telemetry event");
    expect(arch).toContain("run.override");
    expect(arch).toContain("issue #22");
  });
});
