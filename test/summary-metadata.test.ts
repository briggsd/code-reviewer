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
  test("parses code-reviewer hidden metadata", () => {
    const metadata = parseSummaryHiddenMetadata(
      [
        "## AI Review",
        "",
        "<!-- code-reviewer",
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
    expect(parseSummaryHiddenMetadata("<!-- code-reviewer\nnot json\n-->")).toBeUndefined();
  });

  test("creates prior review state from parsed metadata", () => {
    const metadata = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
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
        "<!-- code-reviewer",
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
        "<!-- code-reviewer",
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
        "<!-- code-reviewer",
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
        "<!-- code-reviewer",
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
// schemaVersion 6 + resolvedLog (#279) / schemaVersion 7 + recurrenceDepths (#260)
// schemaVersion 8 + findingTitles (#333)
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

describe("schemaVersion 8 hidden metadata (#333)", () => {
  test("createPublishHiddenMetadata emits schemaVersion 10", () => {
    const meta = createPublishHiddenMetadata("run-1", CHANGE);
    expect(meta.schemaVersion).toBe(10);
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

    expect(meta.schemaVersion).toBe(10);
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
      "<!-- code-reviewer",
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
    expect(meta.recurrenceDepths).toEqual({ fnd_aaa: 1, fnd_bbb: 1 });

    // Parse it back out — round-trip.
    const body = ["<!-- code-reviewer", JSON.stringify(meta), "-->"].join("\n");
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
      "<!-- code-reviewer",
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

    expect(meta.schemaVersion).toBe(10);
    expect(meta.resolvedLog).toEqual([
      { stableId: "fnd_old", title: "Old auth issue", resolvedAtSha: "abc1234" },
    ]);
  });

  test("createPublishHiddenMetadata omits resolvedLog when absent (back-compat)", () => {
    const meta = createPublishHiddenMetadata("run-6", CHANGE, BASE_SUMMARY);

    expect(meta.schemaVersion).toBe(10);
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
      "<!-- code-reviewer",
      JSON.stringify(meta, null, 2),
      "-->",
    ].join("\n");

    const parsed = parseSummaryHiddenMetadata(commentBody);
    // The resolvedLog is preserved in raw (parseSummaryHiddenMetadata preserves all raw keys)
    expect(parsed?.raw.resolvedLog).toEqual(resolvedLog);
  });

  test("a v5 comment (no resolvedLog) still parses cleanly (back-compat)", () => {
    const bodyV5 = [
      "<!-- code-reviewer",
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

// ---------------------------------------------------------------------------
// schemaVersion 7 — recurrenceDepths (#260)
// ---------------------------------------------------------------------------

describe("schemaVersion 7 — recurrenceDepths (#260)", () => {
  test("recurrenceDepths round-trip through parse and prior state", () => {
    const body = [
      "<!-- code-reviewer",
      JSON.stringify({
        schemaVersion: 7,
        runId: "run-7",
        headSha: "abc123",
        findingIds: ["fnd_a", "fnd_b"],
        recurrenceDepths: {
          fnd_a: 3,
          fnd_b: 1,
        },
      }),
      "-->",
    ].join("\n");

    const parsed = parseSummaryHiddenMetadata(body);
    expect(parsed?.recurrenceDepths).toEqual({ fnd_a: 3, fnd_b: 1 });

    if (parsed === undefined) {
      throw new Error("expected metadata to parse");
    }
    const state = createPriorReviewStateFromMetadata(parsed, ref);
    expect(state.findings[0]?.recurrenceDepth).toBe(3);
    expect(state.findings[1]?.recurrenceDepth).toBe(1);
  });

  test("recurrenceDepths parser rejects unsafe values and legacy comments remain valid", () => {
    const body = [
      "<!-- code-reviewer",
      JSON.stringify({
        schemaVersion: 7,
        runId: "run-7",
        headSha: "abc123",
        findingIds: ["fnd_valid", "fnd_zero", "fnd_string", "fnd_huge"],
        recurrenceDepths: {
          fnd_valid: 2,
          fnd_zero: 0,
          fnd_string: "3",
          fnd_huge: 10_001,
        },
      }),
      "-->",
    ].join("\n");

    const parsed = parseSummaryHiddenMetadata(body);
    expect(parsed?.recurrenceDepths).toEqual({ fnd_valid: 2 });

    const legacy = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 6,
          runId: "run-6",
          headSha: "abc123",
          findingIds: ["fnd_legacy"],
        }),
        "-->",
      ].join("\n"),
    );
    expect(legacy?.recurrenceDepths).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #333 — findingTitles: write round-trip, parse, placeholder title recovery
// ---------------------------------------------------------------------------

describe("#333 — findingTitles metadata", () => {
  test("write round-trip: createPublishHiddenMetadata emits findingTitles map with id→title", () => {
    const summary = {
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
          title: "SQL injection in query builder",
          body: "body",
          confidence: "high" as const,
          evidence: [],
          recommendation: "Sanitize input.",
        },
        {
          id: "fnd_bbb",
          reviewer: "code_quality",
          severity: "suggestion" as const,
          category: "style",
          title: "Unused import",
          body: "body",
          confidence: "medium" as const,
          evidence: [],
          recommendation: "Remove it.",
        },
      ],
      risk: {
        tier: "full" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 2,
        ignoredFileCount: 0,
      },
    };

    const meta = createPublishHiddenMetadata("run-tt", CHANGE, summary);
    const titles = meta.findingTitles as Record<string, string> | undefined;
    expect(titles).toBeDefined();
    expect(titles?.["fnd_aaa"]).toBe("SQL injection in query builder");
    expect(titles?.["fnd_bbb"]).toBe("Unused import");
  });

  test("write round-trip: titles are truncated at 120 chars", () => {
    const longTitle = "A".repeat(130);
    const summary = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "Test",
      body: "body",
      findings: [
        {
          id: "fnd_long",
          reviewer: "security",
          severity: "warning" as const,
          category: "auth",
          title: longTitle,
          body: "body",
          confidence: "high" as const,
          evidence: [],
          recommendation: "Fix it.",
        },
      ],
      risk: {
        tier: "full" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
    };

    const meta = createPublishHiddenMetadata("run-trunc", CHANGE, summary);
    const titles = meta.findingTitles as Record<string, string> | undefined;
    expect(titles?.["fnd_long"]).toBe("A".repeat(120));
  });

  test("write round-trip: findingTitles is omitted when all findings lack id or title", () => {
    const summary = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "Test",
      body: "body",
      findings: [
        {
          // no id
          reviewer: "security",
          severity: "warning" as const,
          category: "auth",
          title: "Some issue",
          body: "body",
          confidence: "high" as const,
          evidence: [],
          recommendation: "Fix it.",
        },
      ],
      risk: {
        tier: "full" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
    };

    const meta = createPublishHiddenMetadata("run-noid", CHANGE, summary);
    expect((meta as Record<string, unknown>).findingTitles).toBeUndefined();
  });

  test("write round-trip: findingTitles is omitted when summary has no findings", () => {
    const meta = createPublishHiddenMetadata("run-empty", CHANGE);
    expect((meta as Record<string, unknown>).findingTitles).toBeUndefined();
  });

  test("parse: valid findingTitles entries are accepted", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 8,
          runId: "run-8",
          headSha: "abc123",
          findingIds: ["fnd_a", "fnd_b"],
          findingTitles: {
            fnd_a: "SQL injection in query builder",
            fnd_b: "Unused variable in loop",
          },
        }),
        "-->",
      ].join("\n"),
    );
    expect(parsed?.findingTitles).toEqual({
      fnd_a: "SQL injection in query builder",
      fnd_b: "Unused variable in loop",
    });
  });

  test("parse: untrusted findingTitles — non-string, empty, and over-long values are dropped", () => {
    const overLong = "A".repeat(201);
    const emptyAfterTrim = "   ";
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 8,
          runId: "run-bad",
          headSha: "abc123",
          findingIds: ["fnd_valid", "fnd_nonstring", "fnd_empty", "fnd_toolong"],
          findingTitles: {
            fnd_valid: "Good title",
            fnd_nonstring: 42,
            fnd_empty: emptyAfterTrim,
            fnd_toolong: overLong,
          },
        }),
        "-->",
      ].join("\n"),
    );
    // Only the valid entry survives.
    expect(parsed?.findingTitles).toEqual({ fnd_valid: "Good title" });
  });

  test("parse: findingTitles absent → undefined (back-compat with older comments)", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 7,
          runId: "run-7",
          headSha: "abc123",
          findingIds: ["fnd_a"],
        }),
        "-->",
      ].join("\n"),
    );
    expect(parsed?.findingTitles).toBeUndefined();
  });

  test("placeholder: findingTitles recovered → createPriorReviewStateFromMetadata uses real title", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 8,
          runId: "run-8",
          headSha: "abc123",
          findingIds: ["fnd_a", "fnd_b"],
          findingTitles: {
            fnd_a: "SQL injection in query builder",
          },
        }),
        "-->",
      ].join("\n"),
    );
    if (parsed === undefined) throw new Error("expected metadata to parse");

    const state = createPriorReviewStateFromMetadata(parsed, ref);
    const byId = new Map(state.findings.map((f) => [f.stableId, f]));
    // fnd_a: real title recovered
    expect(byId.get("fnd_a")?.finding.title).toBe("SQL injection in query builder");
    // fnd_b: no title in map → fallback placeholder
    expect(byId.get("fnd_b")?.finding.title).toBe("Prior finding fnd_b");
  });

  test("placeholder: no findingTitles → fallback 'Prior finding fnd_…' for all (no regression)", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 7,
          runId: "run-7",
          headSha: "abc123",
          findingIds: ["fnd_x"],
        }),
        "-->",
      ].join("\n"),
    );
    if (parsed === undefined) throw new Error("expected metadata to parse");

    const state = createPriorReviewStateFromMetadata(parsed, ref);
    expect(state.findings[0]?.finding.title).toBe("Prior finding fnd_x");
  });
});

// ---------------------------------------------------------------------------
// #392 — withheldFindingIds / withheldFindingPaths / withheldFindingReviewers
// schemaVersion 9
// ---------------------------------------------------------------------------

describe("#392 — withheldFindingIds metadata (schemaVersion 9)", () => {
  test("createPublishHiddenMetadata emits schemaVersion 10 (#395)", () => {
    const meta = createPublishHiddenMetadata("run-9", CHANGE);
    expect(meta.schemaVersion).toBe(10);
  });

  test("write round-trip: withheldFindingIds, paths, and reviewers are emitted for withheld findings", () => {
    const summary = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "Test",
      body: "body",
      findings: [],
      groundingWithheld: [
        {
          id: "fnd_withheld1",
          reviewer: "security",
          severity: "critical" as const,
          category: "auth",
          title: "Withheld finding A",
          body: "body",
          confidence: "low" as const,
          evidence: [],
          recommendation: "fix it",
          location: { path: "src/auth.ts" },
        },
        {
          id: "fnd_withheld2",
          reviewer: "code_quality",
          severity: "warning" as const,
          category: "correctness",
          title: "Withheld finding B",
          body: "body",
          confidence: "low" as const,
          evidence: [],
          recommendation: "fix it too",
          // no location → path should be omitted
        },
      ],
      risk: {
        tier: "full" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 2,
        ignoredFileCount: 0,
      },
    };

    const meta = createPublishHiddenMetadata("run-9", CHANGE, summary);
    const withheldIds = meta.withheldFindingIds as string[] | undefined;
    const withheldPaths = meta.withheldFindingPaths as Record<string, string> | undefined;
    const withheldReviewers = meta.withheldFindingReviewers as Record<string, string> | undefined;

    expect(withheldIds).toEqual(["fnd_withheld1", "fnd_withheld2"]);
    expect(withheldPaths).toEqual({ fnd_withheld1: "src/auth.ts" });
    // fnd_withheld2 has no location → absent from withheldFindingPaths
    expect(withheldPaths?.fnd_withheld2).toBeUndefined();
    expect(withheldReviewers).toEqual({
      fnd_withheld1: "security",
      fnd_withheld2: "code_quality",
    });
    // Withheld titles are NOT in the metadata (M008 egress boundary)
    expect((meta as Record<string, unknown>).withheldFindingTitles).toBeUndefined();
  });

  test("write round-trip: withheldFindingIds absent when no groundingWithheld", () => {
    const meta = createPublishHiddenMetadata("run-9", CHANGE);
    expect((meta as Record<string, unknown>).withheldFindingIds).toBeUndefined();
    expect((meta as Record<string, unknown>).withheldFindingPaths).toBeUndefined();
    expect((meta as Record<string, unknown>).withheldFindingReviewers).toBeUndefined();
  });

  test("write round-trip: withheldFindingIds absent when groundingWithheld is empty array", () => {
    const summary = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "Test",
      body: "body",
      findings: [],
      groundingWithheld: [],
      risk: {
        tier: "full" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
    };
    const meta = createPublishHiddenMetadata("run-9", CHANGE, summary);
    expect((meta as Record<string, unknown>).withheldFindingIds).toBeUndefined();
  });

  test("write round-trip: withheld findings without id are excluded from withheldFindingIds", () => {
    const summary = {
      decision: "approved" as const,
      outcome: "pass" as const,
      title: "Test",
      body: "body",
      findings: [],
      groundingWithheld: [
        {
          // no id field — should be excluded
          reviewer: "security",
          severity: "critical" as const,
          category: "auth",
          title: "No-id withheld",
          body: "body",
          confidence: "low" as const,
          evidence: [],
          recommendation: "fix it",
        },
      ],
      risk: {
        tier: "full" as const,
        reason: "test",
        matchedRules: [],
        sensitivePaths: [],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
    };
    const meta = createPublishHiddenMetadata("run-9", CHANGE, summary);
    // No withheldFindingIds when all withheld findings lack id
    expect((meta as Record<string, unknown>).withheldFindingIds).toBeUndefined();
  });

  test("parse: valid withheldFindingIds, paths, and reviewers are accepted", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 9,
          runId: "run-9",
          headSha: "abc123",
          findingIds: [],
          withheldFindingIds: ["fnd_w1", "fnd_w2"],
          withheldFindingPaths: {
            fnd_w1: "src/auth/tokens.ts",
          },
          withheldFindingReviewers: {
            fnd_w1: "security",
            fnd_w2: "code_quality",
          },
        }),
        "-->",
      ].join("\n"),
    );

    expect(parsed?.withheldFindingIds).toEqual(["fnd_w1", "fnd_w2"]);
    expect(parsed?.withheldFindingPaths).toEqual({ fnd_w1: "src/auth/tokens.ts" });
    expect(parsed?.withheldFindingReviewers).toEqual({
      fnd_w1: "security",
      fnd_w2: "code_quality",
    });
  });

  test("parse: withheldFindingIds — non-string and empty values are dropped", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 9,
          runId: "run-9",
          headSha: "abc123",
          findingIds: [],
          withheldFindingIds: ["fnd_valid", "", 42, null, "fnd_also_valid"],
        }),
        "-->",
      ].join("\n"),
    );

    expect(parsed?.withheldFindingIds).toEqual(["fnd_valid", "fnd_also_valid"]);
  });

  test("parse: unsafe withheldFindingPaths are dropped (traversal, absolute)", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 9,
          runId: "run-9",
          headSha: "abc123",
          findingIds: [],
          withheldFindingIds: ["fnd_safe", "fnd_traversal", "fnd_abs"],
          withheldFindingPaths: {
            fnd_safe: "src/auth.ts",
            fnd_traversal: "../../etc/passwd",
            fnd_abs: "/etc/shadow",
          },
        }),
        "-->",
      ].join("\n"),
    );

    expect(parsed?.withheldFindingPaths).toEqual({ fnd_safe: "src/auth.ts" });
  });

  test("parse: withheldFindingIds absent in older comments → undefined (back-compat)", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 8,
          runId: "run-8",
          headSha: "abc123",
          findingIds: ["fnd_x"],
        }),
        "-->",
      ].join("\n"),
    );

    expect(parsed?.withheldFindingIds).toBeUndefined();
    expect(parsed?.withheldFindingPaths).toBeUndefined();
    expect(parsed?.withheldFindingReviewers).toBeUndefined();
  });

  test("createPriorReviewStateFromMetadata: withheldFindings reconstructed from withheldFindingIds", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 9,
          runId: "run-9",
          headSha: "old-head",
          findingIds: ["fnd_blocking"],
          withheldFindingIds: ["fnd_w1", "fnd_w2"],
          withheldFindingPaths: {
            fnd_w1: "src/auth.ts",
          },
          withheldFindingReviewers: {
            fnd_w1: "security",
            fnd_w2: "code_quality",
          },
        }),
        "-->",
      ].join("\n"),
    );

    if (parsed === undefined) throw new Error("expected metadata to parse");

    const state = createPriorReviewStateFromMetadata(parsed, ref);

    // Main findings unaffected
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]?.stableId).toBe("fnd_blocking");

    // withheldFindings reconstructed
    expect(state.withheldFindings).toHaveLength(2);
    const byId = new Map((state.withheldFindings ?? []).map((f) => [f.stableId, f]));

    // fnd_w1: path and reviewer recovered
    expect(byId.get("fnd_w1")?.finding.location?.path).toBe("src/auth.ts");
    expect(byId.get("fnd_w1")?.finding.reviewer).toBe("security");
    expect(byId.get("fnd_w1")?.status).toBe("open");

    // fnd_w2: no path, reviewer recovered
    expect(byId.get("fnd_w2")?.finding.location).toBeUndefined();
    expect(byId.get("fnd_w2")?.finding.reviewer).toBe("code_quality");

    // Titles are NOT recovered (not persisted in metadata)
    expect(byId.get("fnd_w1")?.finding.title).toContain("fnd_w1");
    expect(byId.get("fnd_w2")?.finding.title).toContain("fnd_w2");
  });

  test("createPriorReviewStateFromMetadata: withheldFindings absent when no withheldFindingIds in metadata", () => {
    const parsed = parseSummaryHiddenMetadata(
      [
        "<!-- code-reviewer",
        JSON.stringify({
          schemaVersion: 8,
          runId: "run-8",
          headSha: "old-head",
          findingIds: ["fnd_x"],
        }),
        "-->",
      ].join("\n"),
    );

    if (parsed === undefined) throw new Error("expected metadata to parse");

    const state = createPriorReviewStateFromMetadata(parsed, ref);
    expect(state.withheldFindings).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #395 — findingConfidences / findingSeverities / withheldFindingSeverities
// schemaVersion 10
// ---------------------------------------------------------------------------

describe("#395 — real confidence/severity for prior findings (schemaVersion 10)", () => {
  const summaryWithFindings = {
    decision: "significant_concerns" as const,
    outcome: "fail" as const,
    title: "Test",
    body: "body",
    findings: [
      {
        id: "fnd_block1",
        reviewer: "security",
        severity: "critical" as const,
        category: "auth",
        title: "Blocking A",
        body: "body",
        confidence: "high" as const,
        evidence: [],
        recommendation: "fix it",
        location: { path: "src/auth.ts" },
      },
      {
        id: "fnd_block2",
        reviewer: "code_quality",
        severity: "warning" as const,
        category: "correctness",
        title: "Blocking B",
        body: "body",
        confidence: "medium" as const,
        evidence: [],
        recommendation: "fix it too",
      },
    ],
    groundingWithheld: [
      {
        id: "fnd_withheld1",
        reviewer: "documentation",
        severity: "critical" as const, // real severity; confidence is demoted to "low"
        category: "docs",
        title: "Withheld A",
        body: "body",
        confidence: "low" as const,
        evidence: [],
        recommendation: "fix it",
      },
    ],
    risk: {
      tier: "full" as const,
      reason: "test",
      matchedRules: [],
      sensitivePaths: [],
      reviewedFileCount: 2,
      ignoredFileCount: 0,
    },
  };

  test("write: emits findingConfidences/findingSeverities (blocking) + withheldFindingSeverities", () => {
    const meta = createPublishHiddenMetadata("run-10", CHANGE, summaryWithFindings);
    expect(meta.schemaVersion).toBe(10);
    expect(meta.findingConfidences).toEqual({ fnd_block1: "high", fnd_block2: "medium" });
    expect(meta.findingSeverities).toEqual({ fnd_block1: "critical", fnd_block2: "warning" });
    expect(meta.withheldFindingSeverities).toEqual({ fnd_withheld1: "critical" });
    // No withheld CONFIDENCE map — it is structurally "low" post-demotion (#395).
    expect((meta as Record<string, unknown>).withheldFindingConfidences).toBeUndefined();
  });

  test("write: maps omitted when there are no findings", () => {
    const meta = createPublishHiddenMetadata("run-10", CHANGE);
    expect((meta as Record<string, unknown>).findingConfidences).toBeUndefined();
    expect((meta as Record<string, unknown>).findingSeverities).toBeUndefined();
    expect((meta as Record<string, unknown>).withheldFindingSeverities).toBeUndefined();
  });

  test("parse: valid enum values are accepted, invalid ones rejected", () => {
    const metadata = parseSummaryHiddenMetadata(
      `<!-- code-reviewer\n${JSON.stringify({
        schemaVersion: 10,
        findingIds: ["fnd_a", "fnd_b"],
        findingConfidences: { fnd_a: "high", fnd_b: "certain" }, // "certain" invalid
        findingSeverities: { fnd_a: "critical", fnd_b: "catastrophic" }, // "catastrophic" invalid
        withheldFindingSeverities: { fnd_w: "warning", fnd_x: 7 }, // 7 not a string
      })}\n-->`,
    );
    expect(metadata?.findingConfidences).toEqual({ fnd_a: "high" });
    expect(metadata?.findingSeverities).toEqual({ fnd_a: "critical" });
    expect(metadata?.withheldFindingSeverities).toEqual({ fnd_w: "warning" });
  });

  test("reconstruct: blocking prior findings use recovered confidence + severity", () => {
    const meta = createPublishHiddenMetadata("run-10", CHANGE, summaryWithFindings);
    const parsed = parseSummaryHiddenMetadata(`<!-- code-reviewer\n${JSON.stringify(meta)}\n-->`);
    if (parsed === undefined) throw new Error("expected parsed metadata");
    const state = createPriorReviewStateFromMetadata(parsed, ref);

    const block1 = state.findings.find((f) => f.stableId === "fnd_block1")?.finding;
    expect(block1?.confidence).toBe("high");
    expect(block1?.severity).toBe("critical");
    const block2 = state.findings.find((f) => f.stableId === "fnd_block2")?.finding;
    expect(block2?.confidence).toBe("medium");
    expect(block2?.severity).toBe("warning");

    // Withheld: real severity recovered, confidence stays "low" (demoted).
    const withheld1 = state.withheldFindings?.find((f) => f.stableId === "fnd_withheld1")?.finding;
    expect(withheld1?.severity).toBe("critical");
    expect(withheld1?.confidence).toBe("low");
  });

  test("reconstruct back-compat: pre-v10 metadata falls back to low/suggestion", () => {
    const parsed = parseSummaryHiddenMetadata(
      `<!-- code-reviewer\n${JSON.stringify({
        schemaVersion: 9,
        findingIds: ["fnd_old"],
        findingReviewers: { fnd_old: "security" },
      })}\n-->`,
    );
    if (parsed === undefined) throw new Error("expected parsed metadata");
    const state = createPriorReviewStateFromMetadata(parsed, ref);
    const old = state.findings.find((f) => f.stableId === "fnd_old")?.finding;
    expect(old?.confidence).toBe("low");
    expect(old?.severity).toBe("suggestion");
    expect(old?.reviewer).toBe("security");
  });
});
