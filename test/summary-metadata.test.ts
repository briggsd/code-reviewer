import { describe, expect, test } from "bun:test";
import type { ChangeMetadata, ChangeRef } from "../src/index.ts";
import { createPriorReviewStateFromMetadata, parseSummaryHiddenMetadata } from "../src/index.ts";
import { createPublishHiddenMetadata } from "../src/publisher/publish-summary.ts";

const ref: ChangeRef = {
  provider: "github",
  repository: {
    provider: "github",
    owner: "example",
    name: "demo",
    slug: "example/demo",
  },
  changeId: "42",
  headSha: "new-head",
};

describe("summary hidden metadata parsing", () => {
  test("parses ai-code-review-factory hidden metadata", () => {
    const metadata = parseSummaryHiddenMetadata(
      [
        "## AI Review",
        "",
        "<!-- ai-code-review-factory",
        JSON.stringify(
          {
            schemaVersion: 1,
            runId: "run-1",
            headSha: "old-head",
            provider: "github",
            repository: "example/demo",
            changeId: "42",
            findingIds: ["fnd_111", "", 123, "fnd_222"],
          },
          null,
          2,
        ),
        "-->",
      ].join("\n"),
    );

    expect(metadata).toMatchObject({
      schemaVersion: 1,
      runId: "run-1",
      headSha: "old-head",
      provider: "github",
      repository: "example/demo",
      changeId: "42",
      findingIds: ["fnd_111", "fnd_222"],
    });
  });

  test("returns undefined for missing or malformed metadata", () => {
    expect(parseSummaryHiddenMetadata("plain comment")).toBeUndefined();
    expect(
      parseSummaryHiddenMetadata("<!-- ai-code-review-factory\nnot json\n-->"),
    ).toBeUndefined();
  });

  test("creates prior review state from parsed metadata", () => {
    const metadata = parseSummaryHiddenMetadata(
      [
        "<!-- ai-code-review-factory",
        JSON.stringify({
          schemaVersion: 1,
          runId: "run-1",
          headSha: "old-head",
          findingIds: ["fnd_111"],
        }),
        "-->",
      ].join("\n"),
    );

    if (metadata === undefined) {
      throw new Error("expected metadata to parse");
    }

    const state = createPriorReviewStateFromMetadata(metadata, ref);

    expect(state.previousRunId).toBe("run-1");
    expect(state.previousHeadSha).toBe("old-head");
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({
      stableId: "fnd_111",
      status: "open",
      lastSeenHeadSha: "old-head",
      finding: {
        id: "fnd_111",
        category: "prior_state",
      },
    });
  });

  test("findingPaths: a safe path is restored onto the placeholder; unsafe paths are dropped (#46)", () => {
    const metadata = parseSummaryHiddenMetadata(
      [
        "<!-- ai-code-review-factory",
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-2",
          headSha: "old-head",
          findingIds: ["fnd_safe", "fnd_traversal", "fnd_absolute"],
          findingPaths: {
            fnd_safe: "src/auth/accounts.ts",
            fnd_traversal: "../../etc/passwd",
            fnd_absolute: "/etc/shadow",
          },
        }),
        "-->",
      ].join("\n"),
    );
    if (metadata === undefined) {
      throw new Error("expected metadata to parse");
    }
    // Only the safe repo-relative path survives the guard.
    expect(metadata.findingPaths).toEqual({ fnd_safe: "src/auth/accounts.ts" });

    const state = createPriorReviewStateFromMetadata(metadata, ref);
    const byId = new Map(state.findings.map((f) => [f.stableId, f]));
    expect(byId.get("fnd_safe")?.finding.location?.path).toBe("src/auth/accounts.ts");
    // Rejected (unsafe) paths leave the placeholder path-less → carry-forward treats it as
    // carried_forward, never auto-fixed (the safe direction).
    expect(byId.get("fnd_traversal")?.finding.location).toBeUndefined();
    expect(byId.get("fnd_absolute")?.finding.location).toBeUndefined();
  });

  test("findingReviewers (v3): recovered reviewer role is used; v2-style metadata falls back to 'unknown'", () => {
    // v3 metadata WITH findingReviewers → placeholder gets the recovered role
    const v3metadata = parseSummaryHiddenMetadata(
      [
        "<!-- ai-code-review-factory",
        JSON.stringify({
          schemaVersion: 3,
          runId: "run-3",
          headSha: "old-head",
          findingIds: ["fnd_aaa", "fnd_bbb"],
          findingReviewers: {
            fnd_aaa: "security",
            fnd_bbb: "custom",
          },
        }),
        "-->",
      ].join("\n"),
    );
    if (v3metadata === undefined) {
      throw new Error("expected v3 metadata to parse");
    }
    expect(v3metadata.findingReviewers).toEqual({ fnd_aaa: "security", fnd_bbb: "custom" });

    const v3state = createPriorReviewStateFromMetadata(v3metadata, ref);
    const v3byId = new Map(v3state.findings.map((f) => [f.stableId, f]));
    expect(v3byId.get("fnd_aaa")?.finding.reviewer).toBe("security");
    expect(v3byId.get("fnd_bbb")?.finding.reviewer).toBe("custom");

    // v2-style metadata (no findingReviewers) → placeholder reviewer falls back to "unknown"
    const v2metadata = parseSummaryHiddenMetadata(
      [
        "<!-- ai-code-review-factory",
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-2b",
          headSha: "old-head",
          findingIds: ["fnd_ccc"],
        }),
        "-->",
      ].join("\n"),
    );
    if (v2metadata === undefined) {
      throw new Error("expected v2 metadata to parse");
    }
    expect(v2metadata.findingReviewers).toBeUndefined();

    const v2state = createPriorReviewStateFromMetadata(v2metadata, ref);
    expect(v2state.findings[0]?.finding.reviewer).toBe("unknown");
  });

  test("findingReviewers: defensive parsing drops invalid entries; valid ones survive", () => {
    // Build a string that is 65 chars long (over the 64-char limit)
    const tooLong = "a".repeat(65);
    // Control character: \x01 (charCode 1 < 0x20)
    const withControlChar = "secu\x01rity";
    const metadata = parseSummaryHiddenMetadata(
      [
        "<!-- ai-code-review-factory",
        JSON.stringify({
          schemaVersion: 3,
          runId: "run-def",
          headSha: "old-head",
          findingIds: ["fnd_valid", "fnd_toolong", "fnd_nonstring", "fnd_ctrl"],
          findingReviewers: {
            fnd_valid: "security",
            fnd_toolong: tooLong,
            fnd_nonstring: 42,
            fnd_ctrl: withControlChar,
          },
        }),
        "-->",
      ].join("\n"),
    );
    if (metadata === undefined) {
      throw new Error("expected metadata to parse");
    }
    // Only the valid entry survives the guard.
    expect(metadata.findingReviewers).toEqual({ fnd_valid: "security" });

    const state = createPriorReviewStateFromMetadata(metadata, ref);
    const byId = new Map(state.findings.map((f) => [f.stableId, f]));
    // Valid entry gets the recovered role.
    expect(byId.get("fnd_valid")?.finding.reviewer).toBe("security");
    // Dropped entries fall back to "unknown" — the safe direction.
    expect(byId.get("fnd_toolong")?.finding.reviewer).toBe("unknown");
    expect(byId.get("fnd_nonstring")?.finding.reviewer).toBe("unknown");
    expect(byId.get("fnd_ctrl")?.finding.reviewer).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// schemaVersion 4 + partialBySize counts (#145) / schemaVersion 5 + findingsHash (#149)
// schemaVersion 6 + resolvedLog (#279)
// ---------------------------------------------------------------------------

const CHANGE: ChangeMetadata = {
  provider: "github",
  repository: { provider: "github", owner: "example", name: "demo", slug: "example/demo" },
  changeId: "42",
  headSha: "abc123",
  title: "Test PR",
  author: { username: "dev" },
  labels: [],
};

describe("schemaVersion 6 hidden metadata (#279)", () => {
  test("createPublishHiddenMetadata emits schemaVersion 6", () => {
    const meta = createPublishHiddenMetadata("run-1", CHANGE);
    expect(meta.schemaVersion).toBe(6);
  });

  test("partialBySize counts block is included when summary.partialBySize is present", () => {
    const summary = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "AI review found no blocking issues",
      body: "body",
      findings: [],
      risk: {
        tier: "lite" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 2,
        ignoredFileCount: 0,
      },
      partialBySize: {
        admittedFileCount: 1,
        droppedFileCount: 1,
        originalBytes: 700_000,
        admittedBytes: 300_000,
        budgetBytes: 512_000,
        droppedPaths: ["src/huge.ts"],
      },
    };

    const meta = createPublishHiddenMetadata("run-1", CHANGE, summary);

    expect(meta.schemaVersion).toBe(6);
    const partialBySize = meta.partialBySize as
      | {
          admittedFileCount: number;
          droppedFileCount: number;
          originalBytes: number;
          admittedBytes: number;
          budgetBytes: number;
        }
      | undefined;
    expect(partialBySize).toBeDefined();
    expect(partialBySize?.admittedFileCount).toBe(1);
    expect(partialBySize?.droppedFileCount).toBe(1);
    expect(partialBySize?.originalBytes).toBe(700_000);
    expect(partialBySize?.admittedBytes).toBe(300_000);
    expect(partialBySize?.budgetBytes).toBe(512_000);
    // droppedPaths must NOT be present in metadata (counts+identifiers only, no content list).
    expect((partialBySize as Record<string, unknown> | undefined)?.droppedPaths).toBeUndefined();
  });

  test("partialBySize is absent from metadata when summary.partialBySize is undefined", () => {
    const meta = createPublishHiddenMetadata("run-1", CHANGE);
    expect((meta as Record<string, unknown>).partialBySize).toBeUndefined();
  });

  test("old parsers (schemaVersion ≤ 4) parsing v4 metadata ignore unknown keys (backward compat)", () => {
    // Simulate what an old parser sees: parse a v4 comment and check it doesn't throw.
    // parseSummaryHiddenMetadata is the real parser — it must succeed and return known fields.
    const v4body = [
      "<!-- ai-code-review-factory",
      JSON.stringify({
        schemaVersion: 4,
        runId: "run-v4",
        headSha: "abc123",
        provider: "github",
        repository: "example/demo",
        changeId: "42",
        findingIds: ["fnd_1"],
        partialBySize: { admittedFileCount: 1, droppedFileCount: 1 },
        unknownFuture: "ignored",
      }),
      "-->",
    ].join("\n");

    const parsed = parseSummaryHiddenMetadata(v4body);
    expect(parsed).toBeDefined();
    expect(parsed?.schemaVersion).toBe(4);
    expect(parsed?.runId).toBe("run-v4");
    expect(parsed?.findingIds).toEqual(["fnd_1"]);
    // Unknown keys are tolerated (no error thrown); they appear in `raw`.
    expect((parsed?.raw as Record<string, unknown>)?.partialBySize).toBeDefined();
    expect((parsed?.raw as Record<string, unknown>)?.unknownFuture).toBe("ignored");
    // findingsHash is absent in v4 — treated as undefined (no fast-path, safe direction).
    expect(parsed?.findingsHash).toBeUndefined();
  });

  test("findingsHash: round-trips through write→parse and is 16 hex chars", () => {
    const summaryWithFindings = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "Test",
      body: "body",
      findings: [
        {
          id: "fnd_aaa",
          reviewer: "security",
          severity: "warning" as const,
          category: "auth",
          title: "Finding A",
          body: "body",
          confidence: "high" as const,
          evidence: [],
          recommendation: "Fix it",
        },
        {
          id: "fnd_bbb",
          reviewer: "code_quality",
          severity: "suggestion" as const,
          category: "correctness",
          title: "Finding B",
          body: "body",
          confidence: "medium" as const,
          evidence: [],
          recommendation: "Fix it",
        },
      ],
      risk: {
        tier: "full" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 5,
        ignoredFileCount: 0,
      },
    };

    const meta = createPublishHiddenMetadata("run-hash", CHANGE, summaryWithFindings);
    expect(typeof meta.findingsHash).toBe("string");
    expect((meta.findingsHash as string).length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(meta.findingsHash as string)).toBe(true);

    // Parse it back out — round-trip.
    const body = ["<!-- ai-code-review-factory", JSON.stringify(meta), "-->"].join("\n");
    const parsed = parseSummaryHiddenMetadata(body);
    expect(parsed?.findingsHash).toBe(meta.findingsHash as string);
  });

  test("findingsHash: absent when there are no findings", () => {
    const meta = createPublishHiddenMetadata("run-1", CHANGE);
    expect((meta as Record<string, unknown>).findingsHash).toBeUndefined();
  });

  test("findingsHash: same hash regardless of finding order in summary", () => {
    const findingA = {
      id: "fnd_aaa",
      reviewer: "security",
      severity: "warning" as const,
      category: "auth",
      title: "A",
      body: "body",
      confidence: "high" as const,
      evidence: [],
      recommendation: "fix",
    };
    const findingB = {
      id: "fnd_bbb",
      reviewer: "code_quality",
      severity: "suggestion" as const,
      category: "correctness",
      title: "B",
      body: "body",
      confidence: "medium" as const,
      evidence: [],
      recommendation: "fix",
    };
    const base = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "Test",
      body: "body",
      risk: {
        tier: "lite" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 2,
        ignoredFileCount: 0,
      },
    };

    const metaAB = createPublishHiddenMetadata("run-1", CHANGE, {
      ...base,
      findings: [findingA, findingB],
    });
    const metaBA = createPublishHiddenMetadata("run-1", CHANGE, {
      ...base,
      findings: [findingB, findingA],
    });
    expect(metaAB.findingsHash).toBe(metaBA.findingsHash);
  });

  test("findingsHash: parser rejects non-hex and wrong-length values (backward compat, safe direction)", () => {
    const bodyWithBadHash = [
      "<!-- ai-code-review-factory",
      JSON.stringify({
        schemaVersion: 5,
        runId: "run-5",
        headSha: "abc123",
        findingIds: ["fnd_1"],
        findingsHash: "not-valid-hex!!",
      }),
      "-->",
    ].join("\n");
    const parsed = parseSummaryHiddenMetadata(bodyWithBadHash);
    // Rejected — treated as absent (safe direction: no fast-path).
    expect(parsed?.findingsHash).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// schemaVersion 6 — resolvedLog (#279, M026 S02)
// ---------------------------------------------------------------------------

describe("schemaVersion 6 — resolvedLog (#279)", () => {
  const BASE_SUMMARY = {
    decision: "approved" as const,
    outcome: "pass" as const,
    title: "Test",
    body: "body",
    findings: [],
    risk: {
      tier: "lite" as const,
      reason: "test",
      matchedRules: [],
      sensitivePaths: [],
      reviewedFileCount: 1,
      ignoredFileCount: 0,
    },
  };

  test("createPublishHiddenMetadata writes resolvedLog when present and non-empty", () => {
    const summary = {
      ...BASE_SUMMARY,
      resolvedLog: [{ stableId: "fnd_old", title: "Old auth issue", resolvedAtSha: "abc1234" }],
    };
    const meta = createPublishHiddenMetadata("run-6", CHANGE, summary);

    expect(meta.schemaVersion).toBe(6);
    expect(meta.resolvedLog).toEqual([
      { stableId: "fnd_old", title: "Old auth issue", resolvedAtSha: "abc1234" },
    ]);
  });

  test("createPublishHiddenMetadata omits resolvedLog when absent (back-compat)", () => {
    const meta = createPublishHiddenMetadata("run-6", CHANGE, BASE_SUMMARY);

    expect(meta.schemaVersion).toBe(6);
    expect(meta.resolvedLog).toBeUndefined();
  });

  test("resolvedLog round-trips through hidden metadata (write → embed → parse → raw)", () => {
    const resolvedLog = [
      { stableId: "fnd_a", title: "Issue A", resolvedAtSha: "aaaaaaa" },
      { stableId: "fnd_b", title: "Issue B", resolvedAtSha: "bbbbbbb" },
    ];
    const summary = { ...BASE_SUMMARY, resolvedLog };
    const meta = createPublishHiddenMetadata("run-6", CHANGE, summary);

    // Embed in a comment body (mirrors what the publisher does with includeHiddenMetadata)
    const commentBody = [
      "## AI Review",
      "",
      "<!-- ai-code-review-factory",
      JSON.stringify(meta, null, 2),
      "-->",
    ].join("\n");

    const parsed = parseSummaryHiddenMetadata(commentBody);
    // The resolvedLog is preserved in raw (parseSummaryHiddenMetadata preserves all raw keys)
    expect(parsed?.raw.resolvedLog).toEqual(resolvedLog);
  });

  test("a v5 comment (no resolvedLog) still parses cleanly (back-compat)", () => {
    const bodyV5 = [
      "<!-- ai-code-review-factory",
      JSON.stringify({
        schemaVersion: 5,
        runId: "run-old",
        headSha: "abc123",
        findingIds: ["fnd_1"],
        findingsHash: "abcdef0123456789",
      }),
      "-->",
    ].join("\n");

    const parsed = parseSummaryHiddenMetadata(bodyV5);
    expect(parsed?.schemaVersion).toBe(5);
    expect(parsed?.findingIds).toEqual(["fnd_1"]);
    // resolvedLog is not in raw — treated as absent
    expect(parsed?.raw.resolvedLog).toBeUndefined();
  });
});
