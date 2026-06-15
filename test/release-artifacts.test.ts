import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("release artifact workflow", () => {
  test("dispatch + tag triggers, builds an npm tarball, no registry publish", async () => {
    const workflow = await readFile(".github/workflows/release-package.yml", "utf8");
    const guide = await readFile("docs/release-artifacts.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const readiness = await readFile("docs/release-readiness.md", "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    // Tag push (vX.Y.Z) is the release trigger; the build job stays least-privilege.
    expect(workflow).toContain("push:");
    expect(workflow).toMatch(/tags:\s*\n\s*-\s*"v\*"/);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run check");
    expect(workflow).toContain("bun run pack:smoke");
    expect(workflow).toContain("npm pack --pack-destination dist");
    // Actions are SHA-pinned repo-wide (#96); the trailing comment preserves the version tag.
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v4/);
    expect(workflow).not.toContain("npm publish");

    // Tag-only GitHub Release: confined contents: write, gh CLI run-step (no third-party action).
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/v')");

    expect(readme).toContain("[Release artifacts](docs/release-artifacts.md)");
    expect(guide).toContain("does **not** publish to npm");
    expect(guide).toContain("contents: read");
    expect(guide).toContain("immutable URL");
    expect(guide).toContain("Fortis/self-managed GitLab beta");
    expect(guide).toContain(
      "https://gitlab.example.com/fortis/dev-tools/ai-code-review-factory/-/releases/v0.1.0/downloads/ai-code-review-factory-0.1.0.tgz",
    );
    expect(readiness).toContain("manual release artifact workflow");
  });
});
