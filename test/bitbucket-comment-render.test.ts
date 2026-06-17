import { describe, expect, test } from "bun:test";
import { parseInlineCommentMetadata } from "../src/publisher/inline-comment-markdown.ts";
import { parseSummaryHiddenMetadata } from "../src/publisher/summary-metadata.ts";
import {
  buildBitbucketMetadataFence,
  fenceInlineMetadataMarker,
  flattenHtmlDetails,
} from "../src/vcs/bitbucket/bitbucket-comment-render.ts";

// ---------------------------------------------------------------------------
// flattenHtmlDetails
// ---------------------------------------------------------------------------

describe("flattenHtmlDetails", () => {
  test("removes standalone <details> and </details> lines", () => {
    const input = ["<details>", "Some content", "</details>"].join("\n");
    const result = flattenHtmlDetails(input);
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("</details>");
    expect(result).toContain("Some content");
  });

  test("converts <summary>TEXT</summary> to **TEXT**", () => {
    const input = "<summary>Evidence</summary>";
    const result = flattenHtmlDetails(input);
    expect(result).toBe("**Evidence**");
  });

  test("full collapsible block: details/summary removed, inner content preserved", () => {
    const input = [
      "<details>",
      "<summary>Evidence</summary>",
      "",
      "- Item 1",
      "- Item 2",
      "",
      "</details>",
    ].join("\n");
    const result = flattenHtmlDetails(input);
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("</details>");
    expect(result).toContain("**Evidence**");
    expect(result).toContain("- Item 1");
    expect(result).toContain("- Item 2");
  });

  test("leaves other Markdown lines unchanged", () => {
    const input = "## Heading\n\nSome paragraph.\n\n**Bold** text.";
    expect(flattenHtmlDetails(input)).toBe(input);
  });

  test("handles <summary> with emoji and punctuation", () => {
    const input = "<summary>🗂 Resolved over this PR (3)</summary>";
    const result = flattenHtmlDetails(input);
    expect(result).toBe("**🗂 Resolved over this PR (3)**");
  });

  test("handles indented <details>/<summary> (trimmed match)", () => {
    const input = "  <details>\n  <summary>Section</summary>\n  </details>";
    const result = flattenHtmlDetails(input);
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("</details>");
    expect(result).toContain("**Section**");
  });

  test("handles <details> with attribute (e.g. <details open>)", () => {
    const input = "<details open>\n<summary>Open section</summary>\n</details>";
    const result = flattenHtmlDetails(input);
    expect(result).not.toContain("<details");
    expect(result).not.toContain("</details>");
    expect(result).toContain("**Open section**");
  });

  test("handles combined <details><summary>TEXT</summary> on one line", () => {
    // summary-markdown.ts emits this pattern for the break-glass footer and resolved log
    const input = "<details><summary>🔓 Break glass</summary>";
    const result = flattenHtmlDetails(input);
    expect(result).toBe("**🔓 Break glass**");
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("<summary>");
  });

  test("handles combined <details><summary>TEXT</summary> with content and closing tag", () => {
    const input = [
      "<details><summary>🗂 Resolved (2)</summary>",
      "",
      "- ✅ Item A",
      "- ✅ Item B",
      "",
      "</details>",
    ].join("\n");
    const result = flattenHtmlDetails(input);
    expect(result).toContain("**🗂 Resolved (2)**");
    expect(result).toContain("- ✅ Item A");
    expect(result).toContain("- ✅ Item B");
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("</details>");
    expect(result).not.toContain("<summary>");
  });

  test("multiple collapsible blocks", () => {
    const input = [
      "<details>",
      "<summary>First</summary>",
      "",
      "content A",
      "",
      "</details>",
      "",
      "<details>",
      "<summary>Second</summary>",
      "",
      "content B",
      "",
      "</details>",
    ].join("\n");
    const result = flattenHtmlDetails(input);
    expect(result).toContain("**First**");
    expect(result).toContain("content A");
    expect(result).toContain("**Second**");
    expect(result).toContain("content B");
    expect(result).not.toContain("<details>");
    expect(result).not.toContain("</details>");
  });

  test("empty string returns empty string", () => {
    expect(flattenHtmlDetails("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildBitbucketMetadataFence
// ---------------------------------------------------------------------------

describe("buildBitbucketMetadataFence", () => {
  test("returns a fence with empty metadata when hiddenMetadata is undefined", () => {
    const result = buildBitbucketMetadataFence(undefined);
    // The fence must be present so parseSummaryHiddenMetadata can recognise the comment
    // as a bot summary (for dedup and prior-state loading).
    expect(result).toContain("```");
    expect(result).toContain("<!-- code-reviewer");
    expect(result).toContain("-->");
    // The JSON body is an empty object
    const parsed = parseSummaryHiddenMetadata("prefix text" + result);
    expect(parsed).toBeDefined();
    expect(parsed?.findingIds).toEqual([]);
  });

  test("wraps metadata in a fenced code block containing the standard marker", () => {
    const metadata = {
      schemaVersion: 1,
      runId: "run-abc",
      headSha: "deadbeef",
      findingIds: ["fnd_1"],
      findingPaths: { fnd_1: "src/auth.ts" },
    };
    const result = buildBitbucketMetadataFence(metadata);
    expect(result).toContain("```");
    expect(result).toContain("<!-- code-reviewer");
    expect(result).toContain("-->");
    expect(result).toContain("```");
  });

  test("excludes findingTitles but keeps recurrenceDepths in the fenced block", () => {
    const metadata = {
      schemaVersion: 1,
      runId: "run-xyz",
      headSha: "cafebabe",
      findingIds: ["fnd_1", "fnd_2"],
      findingPaths: { fnd_1: "src/a.ts" },
      findingTitles: { fnd_1: "Some Title", fnd_2: "Another Title" },
      recurrenceDepths: { fnd_1: 2 },
    };
    const result = buildBitbucketMetadataFence(metadata);
    expect(result).not.toContain("findingTitles");
    // recurrenceDepths is small + load-bearing for convergence depth — retained.
    expect(result).toContain("recurrenceDepths");
    expect(result).toContain("findingIds");
    expect(result).toContain("findingPaths");
  });

  test("round-trip: parseSummaryHiddenMetadata reads back findingIds and findingPaths", () => {
    const metadata = {
      schemaVersion: 1,
      runId: "round-trip-run",
      headSha: "roundtrip-head",
      provider: "bitbucket",
      repository: "acme-org/payments-api",
      changeId: "42",
      findingIds: ["fnd_rt_1", "fnd_rt_2"],
      findingPaths: { fnd_rt_1: "src/auth.ts", fnd_rt_2: "src/billing.ts" },
      findingTitles: { fnd_rt_1: "Title A" },
      recurrenceDepths: { fnd_rt_1: 3 },
    };
    const fence = buildBitbucketMetadataFence(metadata);
    // Compact (single-line) JSON — no pretty-print indentation — to keep the visible block small.
    expect(fence).not.toContain("\n  "); // no 2-space indent from JSON.stringify(x, null, 2)
    // Re-derivable context fields are dropped (createPriorReviewStateFromMetadata ignores them).
    expect(fence).not.toContain("provider");
    expect(fence).not.toContain("repository");
    expect(fence).not.toContain("changeId");
    // Simulate the full posted body (core markdown + fenced metadata)
    const postedBody = "Core review body here.\n\n_Generated by code-reviewer._" + fence;
    const parsed = parseSummaryHiddenMetadata(postedBody);
    expect(parsed).toBeDefined();
    expect(parsed?.runId).toBe("round-trip-run");
    expect(parsed?.headSha).toBe("roundtrip-head");
    expect(parsed?.findingIds).toEqual(["fnd_rt_1", "fnd_rt_2"]);
    expect(parsed?.findingPaths).toEqual({ fnd_rt_1: "src/auth.ts", fnd_rt_2: "src/billing.ts" });
    // findingTitles is excluded; recurrenceDepths is retained (small + load-bearing).
    expect(parsed?.findingTitles).toBeUndefined();
    expect(parsed?.recurrenceDepths).toEqual({ fnd_rt_1: 3 });
  });

  test("escapes > to \\u003e in JSON string values", () => {
    const metadata = {
      schemaVersion: 1,
      findingIds: [],
      // A contrived value with > that mirrors defence-in-depth from #82
      runId: "run-with->-in-value",
    };
    const result = buildBitbucketMetadataFence(metadata);
    // The > inside the JSON string value must be escaped to >
    // so a crafted value cannot prematurely close a bare HTML comment if ever parsed outside a fence.
    expect(result).toContain("\\u003e");
    // The closing --> of the marker block itself is expected in the output
    expect(result).toContain("-->");
  });
});

// ---------------------------------------------------------------------------
// fenceInlineMetadataMarker
// ---------------------------------------------------------------------------

describe("fenceInlineMetadataMarker", () => {
  test("wraps the inline metadata marker in a fenced code block", () => {
    const body = [
      "### AI review: ⚠️ Warning · auth",
      "",
      "**Some finding**",
      "",
      "<!-- code-reviewer-inline",
      '{"findingId":"fnd_1","headSha":"abc"}',
      "-->",
    ].join("\n");

    const result = fenceInlineMetadataMarker(body);
    expect(result).toContain("```\n<!-- code-reviewer-inline");
    expect(result).toContain("-->\n```");
    expect(result).toContain("**Some finding**");
  });

  test("round-trip: parseInlineCommentMetadata reads back findingId from fenced body", () => {
    const marker = [
      "<!-- code-reviewer-inline",
      JSON.stringify({ findingId: "fnd_rt_inline", headSha: "sha-abc" }).replace(/>/g, "\\u003e"),
      "-->",
    ].join("\n");
    const body = `### AI review\n\n**Title**\n\n${marker}`;
    const fenced = fenceInlineMetadataMarker(body);

    const parsed = parseInlineCommentMetadata(fenced);
    expect(parsed).toBeDefined();
    expect(parsed?.findingId).toBe("fnd_rt_inline");
    expect(parsed?.headSha).toBe("sha-abc");
  });

  test("body without a marker is returned unchanged", () => {
    const body = "### AI review\n\nNo marker here.";
    expect(fenceInlineMetadataMarker(body)).toBe(body);
  });
});
