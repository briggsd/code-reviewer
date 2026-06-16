import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  author?: string;
  homepage?: string;
  repository?: {
    type?: string;
    url?: string;
  };
  bugs?: {
    url?: string;
  };
  exports?: Record<string, string>;
  bin?: Record<string, string>;
  files?: string[];
  scripts?: Record<string, string>;
}

describe("package distribution metadata", () => {
  test("defines a Bun CLI entrypoint and package smoke script", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    expect(manifest.bin?.["ai-code-review"]).toBe("./src/cli.ts");
    expect(manifest.scripts?.["pack:smoke"]).toBe("bun run scripts/package-smoke.ts");
    expect(manifest.scripts?.["smoke:external-package"]).toBe(
      "bun run scripts/external-package-smoke.ts",
    );
    expect(manifest.scripts?.["smoke:gitlab"]).toBe("bun run scripts/gitlab-live-smoke.ts");
    expect(manifest.scripts?.["smoke:action-wrapper"]).toBe(
      "bun run scripts/action-wrapper-smoke.ts",
    );

    const cli = await readFile("src/cli.ts", "utf8");
    expect(cli.startsWith("#!/usr/bin/env bun\n")).toBe(true);
  });

  test("locks release identity metadata and explicit registry publish blockers", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
    const packaging = await readFile("docs/user/packaging.md", "utf8");
    const releaseReadiness = await readFile("docs/user/release-readiness.md", "utf8");

    expect(manifest.name).toBe("ai-code-review-factory");
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.homepage).toBe("https://github.com/briggsd/ai-code-review-factory#readme");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/briggsd/ai-code-review-factory.git",
    });
    expect(manifest.bugs?.url).toBe("https://github.com/briggsd/ai-code-review-factory/issues");
    expect(packaging).toContain("Registry publishing is intentionally blocked");
    expect(packaging).toContain("public npm is not part of the beta channel");
    expect(packaging).toContain("private: true");
    expect(packaging).toContain('license: "UNLICENSED"');
    expect(releaseReadiness).toContain("Registry publish is currently blocked");
    expect(releaseReadiness).toContain("do not require public npm");
  });

  test("documents external packaged install smoke", async () => {
    const packaging = await readFile("docs/user/packaging.md", "utf8");
    const releaseReadiness = await readFile("docs/user/release-readiness.md", "utf8");
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
    const packaging = await readFile("docs/user/packaging.md", "utf8");
    const ciTemplates = await readFile("docs/user/ci-templates.md", "utf8");
    const releaseReadiness = await readFile("docs/user/release-readiness.md", "utf8");

    for (const guide of [packaging, ciTemplates, releaseReadiness]) {
      expect(guide).toContain("immutable");
      expect(guide).toContain("full Git commit SHA");
      expect(guide).toContain("mutable");
    }

    expect(packaging).toContain("Do not use mutable install sources");
    expect(packaging).toContain("internal/self-managed GitLab beta");
    expect(packaging).toContain(
      "https://gitlab.example.com/<your-org>/dev-tools/ai-code-review-factory/-/releases/v0.1.0/downloads/ai-code-review-factory-0.1.0.tgz",
    );
    expect(ciTemplates).toContain("Do not pin adopter CI to mutable branches");
    expect(ciTemplates).toContain(
      "GitLab beta template defaults to an internal immutable tarball URL placeholder",
    );
    expect(releaseReadiness).toContain("Install-source priority");
    expect(releaseReadiness).toContain(
      "Immutable internal tarball URL for the internal/self-managed GitLab beta",
    );
  });

  test("exports package root to src/public.ts and keeps private:true", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    // Package-metadata shape only; the public-surface resolve/file-existence lock
    // lives in test/public-api.test.ts (which also imports the exported symbols).
    expect(manifest.exports?.["."]).toBe("./src/public.ts");
    expect(manifest.private).toBe(true);
  });

  test("declares Apache-2.0 license with LICENSE + NOTICE at repo root", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.author).toBe("The AI Code Review Factory Authors");

    // private:true is a DELIBERATE registry-deferral guard: distribution this round is
    // GitHub Releases + tarball, and `private:true` blocks only `npm publish`, not
    // `npm pack`/install-by-URL. Do NOT "fix" this to false to enable publishing.
    expect(manifest.private).toBe(true);

    const license = await readFile("LICENSE", "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");

    const notice = await readFile("NOTICE", "utf8");
    expect(notice).toContain("AI Code Review Factory");
    expect(notice).toContain("Copyright 2026 The AI Code Review Factory Authors");
  });

  test("ships runtime assets without test or workflow internals", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    expect(manifest.files).toEqual([
      ".ai-review.schema.json",
      "NOTICE",
      "README.md",
      "docs/user",
      "examples/ci",
      "examples/fixtures",
      "research",
      "scripts",
      "src",
      "tsconfig.json",
    ]);
    expect(manifest.files).not.toContain("docs");
    expect(manifest.files).not.toContain("docs/developer");
    expect(manifest.files).not.toContain("docs/milestones");
    expect(manifest.files).not.toContain("test");
    expect(manifest.files).not.toContain(".github");
    expect(manifest.files).not.toContain("continue.md");
  });
});
