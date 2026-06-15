import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("fork safety documentation", () => {
  test("documents the public-repo default and token boundaries", async () => {
    const guide = await readFile("docs/user/fork-safety.md", "utf8");

    expect(guide).toContain(
      "read-only analysis on `pull_request` plus artifacts/status only for fork PRs",
    );
    expect(guide).toContain("Do not expose model provider secrets or write tokens to fork PRs");
    expect(guide).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(guide).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID");
    expect(guide).toContain("Avoid using `pull_request_target`");
    expect(guide).toContain("Treat model credentials like write tokens");
    expect(guide).toContain("two-stage reporter");
  });

  test("documents trusted operator resources versus reviewed-repo resources", async () => {
    const guide = await readFile("docs/user/fork-safety.md", "utf8");
    const architecture = await readFile("docs/developer/architecture.md", "utf8");

    expect(guide).toContain("Trusted operator resources");
    expect(guide).toContain("Reviewed-repo resources");
    expect(guide).toContain("reviewed-repo Pi resources stay disabled by default");
    expect(guide).toContain("project-local context files, skills, prompt templates, extensions");
    expect(guide).toContain(
      "Project config may select policy within the supported schema, but it is not a permission boundary",
    );
    expect(architecture).toContain("### Trusted resource boundary");
    expect(architecture).toContain(
      "Only trusted operator resources may define reviewer authority in CI",
    );
    expect(architecture).toContain(
      "context files, skills, prompt templates, extensions, session state, and approval state remain disabled",
    );
  });

  test("CI template docs link to fork safety guidance", async () => {
    const ciDocs = await readFile("docs/user/ci-templates.md", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(ciDocs).toContain("[Public repository fork safety](fork-safety.md)");
    expect(readme).toContain("[Fork safety](docs/user/fork-safety.md)");
  });
});
