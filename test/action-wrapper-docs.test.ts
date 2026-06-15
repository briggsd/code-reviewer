import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("GitHub Action wrapper docs", () => {
  test("document wrapper usage, immutable pinning, and safety stance", async () => {
    const guide = await readFile("docs/user/github-action-wrapper.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const ciDocs = await readFile("docs/user/ci-templates.md", "utf8");
    const adoption = await readFile("docs/user/adoption.md", "utf8");

    expect(readme).toContain("[GitHub Action wrapper](docs/user/github-action-wrapper.md)");
    expect(ciDocs).toContain("examples/ci/github-actions-ai-review-action.yml");
    expect(adoption).toContain("github-actions-ai-review-action.yml");
    expect(guide).toContain("thin GitHub Action wrapper around the packaged `ai-code-review` CLI");
    expect(guide).toContain("sets up Bun");
    expect(guide).toContain("installs `inputs.package-source` with `bun add --global`");
    expect(guide).toContain("Do not pin the action or package source to mutable branches");
    expect(guide).toContain("fixture` — optional smoke/local mode");
    expect(guide).toContain("smoke:action-wrapper");
    expect(guide).toContain("same package install/run boundary");
    expect(guide).toContain("publish-summary` — defaults to `false`");
    expect(guide).toContain("publish-inline` — defaults to `false`");
    expect(guide).toContain("Fork PRs should remain dry-run/artifact-only");
  });
});
