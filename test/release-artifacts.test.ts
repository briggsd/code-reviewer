import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("release artifact workflow", () => {
  test("is manual-only, read-only, and uploads an npm tarball artifact", async () => {
    const workflow = await readFile(".github/workflows/release-package.yml", "utf8");
    const guide = await readFile("docs/release-artifacts.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const readiness = await readFile("docs/release-readiness.md", "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("push:");
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run check");
    expect(workflow).toContain("bun run pack:smoke");
    expect(workflow).toContain("npm pack --pack-destination dist");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).not.toContain("npm publish");

    expect(readme).toContain("[Release artifacts](docs/release-artifacts.md)");
    expect(guide).toContain("manual-only (`workflow_dispatch`)");
    expect(guide).toContain("does **not** publish to npm");
    expect(guide).toContain("contents: read");
    expect(guide).toContain("immutable URL");
    expect(readiness).toContain("manual release artifact workflow");
  });
});
