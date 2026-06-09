import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("fork safety documentation", () => {
  test("documents the public-repo default and token boundaries", async () => {
    const guide = await readFile("docs/fork-safety.md", "utf8");

    expect(guide).toContain("read-only analysis on `pull_request` plus artifacts/status only for fork PRs");
    expect(guide).toContain("Do not expose model provider secrets or write tokens to fork PRs");
    expect(guide).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(guide).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID");
    expect(guide).toContain("Avoid using `pull_request_target`");
    expect(guide).toContain("Treat model credentials like write tokens");
    expect(guide).toContain("two-stage reporter");
  });

  test("CI template docs link to fork safety guidance", async () => {
    const ciDocs = await readFile("docs/ci-templates.md", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(ciDocs).toContain("[Public repository fork safety](fork-safety.md)");
    expect(readme).toContain("[Fork safety](docs/fork-safety.md)");
  });
});
