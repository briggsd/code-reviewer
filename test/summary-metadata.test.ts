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
// schemaVersion 4 + partialBySize counts (#145)
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

describe("schemaVersion 4 hidden metadata (#145)", () => {
  test("createPublishHiddenMetadata emits schemaVersion 4", () => {
    const meta = createPublishHiddenMetadata("run-1", CHANGE);
    expect(meta.schemaVersion).toBe(4);
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

    expect(meta.schemaVersion).toBe(4);
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

  test("old parsers (schemaVersion ≤ 3) parsing v4 metadata ignore unknown keys (backward compat)", () => {
    // Simulate what an old parser sees: parse the v4 JSON and check it doesn't throw.
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
  });
});
