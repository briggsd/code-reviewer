import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

interface PackageJson {
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

    const cli = await readFile("src/cli.ts", "utf8");
    expect(cli.startsWith("#!/usr/bin/env bun\n")).toBe(true);
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
    expect(script).toContain('"bun", "add"');
    expect(script).toContain("--global");
    expect(script).toContain("installedCli");
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
    expect(ciTemplates).toContain("Do not pin adopter CI to mutable branches");
    expect(releaseReadiness).toContain("Install-source priority");
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
