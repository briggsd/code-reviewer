import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  homepage?: string;
  repository?: {
    type?: string;
    url?: string;
  };
  bugs?: {
    url?: string;
  };
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
}

describe("package distribution metadata", () => {
  test("defines a Bun CLI entrypoint and package smoke script", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    expect(manifest.bin?.["ai-code-review"]).toBe("./src/cli.ts");
    expect(manifest.scripts?.["pack:smoke"]).toBe("bun run scripts/package-smoke.ts");
    expect(manifest.scripts?.["smoke:external-package"]).toBe("bun run scripts/external-package-smoke.ts");
    expect(manifest.scripts?.["smoke:gitlab"]).toBe("bun run scripts/gitlab-live-smoke.ts");
    expect(manifest.scripts?.["smoke:action-wrapper"]).toBe("bun run scripts/action-wrapper-smoke.ts");

    const cli = await readFile("src/cli.ts", "utf8");
    expect(cli.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("locks release identity metadata and explicit registry publish blockers", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
    const packaging = await readFile("docs/packaging.md", "utf8");
    const releaseReadiness = await readFile("docs/release-readiness.md", "utf8");

    expect(manifest.name).toBe("ai-code-review-factory");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("UNLICENSED");
    expect(manifest.homepage).toBe("https://github.com/briggsd/ai-code-review-factory#readme");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/briggsd/ai-code-review-factory.git",
    });
    expect(manifest.bugs?.url).toBe("https://github.com/briggsd/ai-code-review-factory/issues");
    expect(packaging).toContain("Registry publishing is intentionally blocked");
    expect(packaging).toContain("public npm is not part of the beta channel");
    expect(packaging).toContain("private: true");
    expect(packaging).toContain("license: \"UNLICENSED\"");
    expect(releaseReadiness).toContain("Registry publish is currently blocked");
    expect(releaseReadiness).toContain("do not require public npm");
  });

  test("documents external packaged install smoke", async () => {
    const packaging = await readFile("docs/packaging.md", "utf8");
    const releaseReadiness = await readFile("docs/release-readiness.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const script = await readFile("scripts/external-package-smoke.ts", "utf8");

    for (const guide of [packaging, releaseReadiness, readme]) {
      expect(guide).toContain("smoke:external-package");
    }

    expect(packaging).toContain("isolated Bun global directory");
    expect(packaging).toContain("AI_REVIEW_EXTERNAL_SMOKE_PROVIDER");
    expect(packaging).toContain(".ai-review/context/change-context.json");
    expect(packaging).toContain("records `patchPath` references without inline patch bodies");
    expect(script).toContain('"bun", "add"');
    expect(script).toContain("--global");
    expect(script).toContain("installedCli");
    expect(script).toContain("assertContextArtifacts");
    expect(script).toContain("change-context.json");
    expect(script).toContain("patchPath");
    expect(script).toContain("AI_REVIEW_EXTERNAL_SMOKE_REPO");
  });

  test("documents immutable install source strategy", async () => {
    const packaging = await readFile("docs/packaging.md", "utf8");
    const ciTemplates = await readFile("docs/ci-templates.md", "utf8");
    const releaseReadiness = await readFile("docs/release-readiness.md", "utf8");

    for (const guide of [packaging, ciTemplates, releaseReadiness]) {
      expect(guide).toContain("immutable");
      expect(guide).toContain("full Git commit SHA");
      expect(guide).toContain("mutable");
    }

    expect(packaging).toContain("Do not use mutable install sources");
    expect(packaging).toContain("Fortis/self-managed GitLab beta");
    expect(packaging).toContain("https://gitlab.example.com/fortis/dev-tools/ai-code-review-factory/-/releases/v0.1.0/downloads/ai-code-review-factory-0.1.0.tgz");
    expect(ciTemplates).toContain("Do not pin adopter CI to mutable branches");
    expect(ciTemplates).toContain("GitLab beta template defaults to an internal immutable tarball URL placeholder");
    expect(releaseReadiness).toContain("Install-source priority");
    expect(releaseReadiness).toContain("Immutable internal tarball URL for the Fortis/self-managed GitLab beta");
  });

  test("ships runtime assets without test or workflow internals", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    expect(manifest.files).toEqual([
      ".ai-review.schema.json",
      "README.md",
      "docs",
      "examples/ci",
      "examples/fixtures",
      "research",
      "scripts",
      "src",
      "tsconfig.json",
    ]);
    expect(manifest.files).not.toContain("test");
    expect(manifest.files).not.toContain(".github");
    expect(manifest.files).not.toContain("continue.md");
  });
});
