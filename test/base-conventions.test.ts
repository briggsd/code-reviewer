import { describe, expect, test } from "bun:test";
import { resolveBaseConfig } from "../src/index.ts";
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

describe("resolveBaseConfig", () => {
  test("base file present → base conventions used; head config conventions are ignored", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["head convention — must be ignored"] };
    const baseFileContent = JSON.stringify({
      conventions: ["base convention A", "base convention B"],
    });
    const adapter = makeAdapter(async () => baseFileContent);

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(true);
    expect(result.conventions).toEqual(["base convention A", "base convention B"]);
    // The HEAD config conventions must NOT appear.
    expect(result.conventions).not.toContain("head convention — must be ignored");
  });

  test("base file absent → empty conventions, source:base, baseFileFound:false", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["head convention — must be ignored"] };
    const adapter = makeAdapter(async () => undefined);

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(false);
    expect(result.conventions).toEqual([]);
  });

  test("adapter without readBaseBranchFile → returns config conventions, source:local", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["advisory convention from config"] };
    const adapter = makeAdapterWithoutBaseRead();

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("local");
    expect(result.baseFileFound).toBe(false);
    expect(result.conventions).toEqual(["advisory convention from config"]);
  });

  test("malformed base JSON → empty conventions without throwing", async () => {
    const config = { ...createDefaultReviewConfig(), conventions: ["head"] };
    const adapter = makeAdapter(async () => "not-json{{{");

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(true);
    expect(result.conventions).toEqual([]);
  });

  test("base file has no conventions field → empty conventions", async () => {
    const adapter = makeAdapter(async () => JSON.stringify({ failOn: ["critical"] }));
    const config = createDefaultReviewConfig();

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

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

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.conventions).toEqual(["valid", "x".repeat(500)]);
  });

  // P3a: acknowledgements resolved from the base file.
  test("base file with acknowledgements → resolved on ResolvedBaseConfig.acknowledgements", async () => {
    const config = createDefaultReviewConfig();
    const baseFileContent = JSON.stringify({
      acknowledgements: [
        { path: "scripts/**", mode: "acknowledge", reason: "maintainer tool", category: "injection" },
      ],
    });
    const adapter = makeAdapter(async () => baseFileContent);

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.acknowledgements).toHaveLength(1);
    expect(result.acknowledgements[0]?.path).toBe("scripts/**");
    expect(result.acknowledgements[0]?.mode).toBe("acknowledge");
    expect(result.acknowledgements[0]?.reason).toBe("maintainer tool");
    expect(result.acknowledgements[0]?.category).toBe("injection");
  });

  test("head config acknowledgements IGNORED in the provider path (base authoritative)", async () => {
    const config = {
      ...createDefaultReviewConfig(),
      acknowledgements: [
        { path: "src/**", mode: "suppress" as const, reason: "head acknowledgement — must be ignored" },
      ],
    };
    const baseFileContent = JSON.stringify({
      acknowledgements: [
        { path: "scripts/**", mode: "acknowledge", reason: "base acknowledgement" },
      ],
    });
    const adapter = makeAdapter(async () => baseFileContent);

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    // Only base acknowledgements should be present.
    expect(result.acknowledgements).toHaveLength(1);
    expect(result.acknowledgements[0]?.path).toBe("scripts/**");
    expect(result.acknowledgements[0]?.reason).toBe("base acknowledgement");
    // The head config acknowledgement must NOT appear.
    expect(result.acknowledgements.some((a) => a.reason === "head acknowledgement — must be ignored")).toBe(false);
  });

  test("adapter without readBaseBranchFile → config acknowledgements kept (source:local)", async () => {
    const config = {
      ...createDefaultReviewConfig(),
      acknowledgements: [
        { path: "scripts/**", mode: "acknowledge" as const, reason: "local advisory" },
      ],
    };
    const adapter = makeAdapterWithoutBaseRead();

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("local");
    expect(result.acknowledgements).toHaveLength(1);
    expect(result.acknowledgements[0]?.path).toBe("scripts/**");
  });

  test("malformed base JSON → acknowledgements [] without throwing", async () => {
    const config = createDefaultReviewConfig();
    const adapter = makeAdapter(async () => "not-json{{{");

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.acknowledgements).toEqual([]);
  });

  test("base file absent → acknowledgements [], source:base, baseFileFound:false", async () => {
    const config = {
      ...createDefaultReviewConfig(),
      acknowledgements: [
        { path: "scripts/**", mode: "acknowledge" as const, reason: "head-only — must be ignored" },
      ],
    };
    const adapter = makeAdapter(async () => undefined);

    const result = await resolveBaseConfig({ adapter, metadata: baseMetadata, config });

    expect(result.source).toBe("base");
    expect(result.baseFileFound).toBe(false);
    expect(result.acknowledgements).toEqual([]);
  });
});
