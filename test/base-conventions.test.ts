import { describe, expect, test } from "bun:test";
import { resolveBaseConventions } from "../src/index.ts";
import type { ChangeMetadata, VcsAdapter } from "../src/index.ts";
import { createDefaultReviewConfig } from "../src/index.ts";

// Minimal ChangeMetadata for tests.
const baseMetadata: ChangeMetadata = {
  provider: "github",
  repository: {
    provider: "github",
    owner: "example",
    name: "my-repo",
    slug: "example/my-repo",
  },
  changeId: "99",
  headSha: "headabc",
  targetBranch: "main",
  title: "test PR",
  author: { username: "test-author" },
  labels: [],
};

// Helper to build a fake VcsAdapter that supports readBaseBranchFile.
function makeAdapter(
  readBaseBranchFile: (change: ChangeMetadata, path: string) => Promise<string | undefined>,
): VcsAdapter {
  return {
    provider: "github",
    getChange: async () => { throw new Error("not used"); },
    getDiff: async () => { throw new Error("not used"); },
    getPriorReviewState: async () => undefined,
    publishSummary: async () => { throw new Error("not used"); },
    readBaseBranchFile,
  };
}

// Helper for an adapter WITHOUT readBaseBranchFile (simulates GitLab in this slice).
function makeAdapterWithoutBaseRead(): VcsAdapter {
  return {
    provider: "gitlab",
    getChange: async () => { throw new Error("not used"); },
    getDiff: async () => { throw new Error("not used"); },
    getPriorReviewState: async () => undefined,
    publishSummary: async () => { throw new Error("not used"); },
  };
}

describe("resolveBaseConventions", () => {
  test("base file present → base conventions used; head config conventions are ignored", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["head convention — must be ignored"] };
    const baseFileContent = JSON.stringify({
      conventions: ["base convention A", "base convention B"],
    });
    const adapter = makeAdapter(async () => baseFileContent);

    const result = await resolveBaseConventions({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(true);
    expect(result.conventions).toEqual(["base convention A", "base convention B"]);
    // The HEAD config conventions must NOT appear.
    expect(result.conventions).not.toContain("head convention — must be ignored");
  });

  test("base file absent → empty conventions, source:base, baseFileFound:false", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["head convention — must be ignored"] };
    const adapter = makeAdapter(async () => undefined);

    const result = await resolveBaseConventions({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(false);
    expect(result.conventions).toEqual([]);
  });

  test("adapter without readBaseBranchFile → returns config conventions, source:local", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["advisory convention from config"] };
    const adapter = makeAdapterWithoutBaseRead();

    const result = await resolveBaseConventions({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("local");
    expect(result.baseFileFound).toBe(false);
    expect(result.conventions).toEqual(["advisory convention from config"]);
  });

  test("malformed base JSON → empty conventions without throwing", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["head"] };
    const adapter = makeAdapter(async () => "not-json{{{");

    const result = await resolveBaseConventions({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(true);
    expect(result.conventions).toEqual([]);
  });

  test("base file has no conventions field → empty conventions", async () => {
    const adapter = makeAdapter(async () => JSON.stringify({ failOn: ["critical"] }));
    const config = createDefaultReviewConfig();

    const result = await resolveBaseConventions({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(true);
    expect(result.conventions).toEqual([]);
  });

  test("normalizeConventions bounds: non-string entries dropped, oversized entries truncated at 500 chars", async () => {
    const longEntry = "x".repeat(600);
    const adapter = makeAdapter(async () => JSON.stringify({
      conventions: [42, "", "  valid  ", longEntry, null],
    }));
    const config = createDefaultReviewConfig();

    const result = await resolveBaseConventions({ adapter, metadata: baseMetadata, config });

    expect(result.conventions).toEqual(["valid", "x".repeat(500)]);
  });
});
