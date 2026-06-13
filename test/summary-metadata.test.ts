import { describe, expect, test } from "bun:test";
import type { ChangeRef } from "../src/index.ts";
import { createPriorReviewStateFromMetadata, parseSummaryHiddenMetadata } from "../src/index.ts";

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
});
