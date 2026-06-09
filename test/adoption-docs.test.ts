import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("adoption documentation", () => {
  test("documents adopter path, live-tested evidence, deferred work, and failure artifacts", async () => {
    const adoption = await readFile("docs/adoption.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const packaging = await readFile("docs/packaging.md", "utf8");
    const releaseReadiness = await readFile("docs/release-readiness.md", "utf8");
    const ciTemplates = await readFile("docs/ci-templates.md", "utf8");

    expect(readme).toContain("[Adoption guide](docs/adoption.md)");
    expect(packaging).toContain("[Adoption guide](adoption.md)");
    expect(releaseReadiness).toContain("[Adoption guide](adoption.md)");
    expect(ciTemplates).toContain("[Adoption guide](adoption.md)");

    expect(adoption).toContain("Recommended adoption path");
    expect(adoption).toContain("Pin the package source");
    expect(adoption).toContain("Start with dry-run only");
    expect(adoption).toContain("Enable same-repo/same-project summary publishing");
    expect(adoption).toContain("Optionally enable GitHub inline publishing");
    expect(adoption).toContain("Switch to Pi only in trusted jobs");

    expect(adoption).toContain("What has been live-tested");
    expect(adoption).toContain("GitHub same-repository summary publishing");
    expect(adoption).toContain("GitHub re-review metadata");
    expect(adoption).toContain("Packaged external install");
    expect(adoption).toContain("Packaged Pi runtime");
    expect(adoption).toContain("Failure observability");
    expect(adoption).toContain("GitHub inline publishing");
    expect(adoption).toContain("GitLab live summary publishing");

    expect(adoption).toContain("Not yet live-tested or intentionally deferred");
    expect(adoption).toContain("GitLab inline discussions");
    expect(adoption).toContain("Container image, GitHub Action wrapper, GitLab component wrapper");
    expect(adoption).toContain("Fork privileged write-back");

    expect(adoption).toContain("run.json.error");
    expect(adoption).toContain("review.failed");
    expect(adoption).toContain("Inline publishing remains disabled by default");
    expect(releaseReadiness).toContain("Live-tested vs deferred");
  });
});
