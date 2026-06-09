import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("inline publishing documentation", () => {
  test("documents the opt-in GitHub inline path and conservative readiness gates", async () => {
    const guide = await readFile("docs/inline-publishing.md", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(guide).toContain("experimental, opt-in GitHub-only");
    expect(guide).toContain("evaluateInlinePublishReadiness()");
    expect(guide).toContain("stale head SHA");
    expect(guide).toContain("line is not present in the provider patch hunk");
    expect(guide).toContain("duplicate_inline_comment");
    expect(guide).toContain("`inlineFindings`");
    expect(guide).toContain("malformed hidden metadata");
    expect(guide).toContain("starter CI templates do **not** pass `--publish-inline`");
    expect(readme).toContain("[Inline publishing](docs/inline-publishing.md)");
  });
});
