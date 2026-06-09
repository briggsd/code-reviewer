import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("inline publishing documentation", () => {
  test("documents the conservative readiness gate and deferred publishing stance", async () => {
    const guide = await readFile("docs/inline-publishing.md", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(guide).toContain("Inline comments/discussions are still deferred");
    expect(guide).toContain("evaluateInlinePublishReadiness()");
    expect(guide).toContain("stale head SHA");
    expect(guide).toContain("line is not present in the provider patch hunk");
    expect(guide).toContain("Publish only `readyFindings` inline");
    expect(readme).toContain("[Inline publishing readiness](docs/inline-publishing.md)");
  });
});
