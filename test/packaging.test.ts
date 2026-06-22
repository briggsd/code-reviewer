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
  publishConfig?: { access?: string };
}

describe("package distribution metadata", () => {
  test("defines a Bun CLI entrypoint and package smoke script", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    expect(manifest.bin?.["code-reviewer"]).toBe("./src/cli.ts");
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

    expect(manifest.name).toBe("@briggsd/code-reviewer");
    expect(manifest.version).toBe("0.4.0");
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig?.access).toBe("public");
    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.homepage).toBe("https://github.com/briggsd/code-reviewer#readme");
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/briggsd/code-reviewer.git",
    });
    expect(manifest.bugs?.url).toBe("https://github.com/briggsd/code-reviewer/issues");
    expect(packaging).toContain("licensed Apache-2.0");
    expect(packaging).toContain("published to the public npm registry");
    expect(packaging).toContain("bun add @briggsd/code-reviewer");
    expect(releaseReadiness).toContain("Registry publish is enabled");
    expect(releaseReadiness).toContain("npm publish");
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
      "https://gitlab.example.com/<your-org>/dev-tools/code-reviewer/-/releases/vX.Y.Z/downloads/briggsd-code-reviewer-X.Y.Z.tgz",
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

  test("exports package root to src/public.ts and publishes with public access", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    // Package-metadata shape only; the public-surface resolve/file-existence lock
    // lives in test/public-api.test.ts (which also imports the exported symbols).
    expect(manifest.exports?.["."]).toBe("./src/public.ts");
    expect(manifest.private).toBeUndefined();
    expect(manifest.publishConfig?.access).toBe("public");
  });

  test("declares Apache-2.0 license with LICENSE + NOTICE at repo root", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

    expect(manifest.license).toBe("Apache-2.0");
    expect(manifest.author).toBe("The Code Reviewer Authors");

    const license = await readFile("LICENSE", "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");

    const notice = await readFile("NOTICE", "utf8");
    expect(notice).toContain("Code Reviewer");
    expect(notice).toContain("Copyright 2026 The Code Reviewer Authors");
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

  // Release-hygiene guard: the package version and the changelog must not drift.
  // Tagging v0.2.0/v0.3.0/v0.3.1 each bumped package.json without ever promoting
  // [Unreleased] into a versioned section, so the changelog silently fell three
  // releases behind. This ties promotion to the version bump every release requires:
  // bumping to X.Y.Z without writing its dated CHANGELOG section fails the gate.
  test("CHANGELOG.md has a dated section and link for the current package version", async () => {
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
    const version = manifest.version;
    if (!version) {
      throw new Error("package.json is missing a version");
    }
    const changelog = await readFile("CHANGELOG.md", "utf8");

    const escaped = version.replace(/\./g, "\\.");
    // Keep a Changelog dated header, e.g. "## [0.4.0] - 2026-06-21".
    const datedSection = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m");
    expect(changelog).toMatch(datedSection);
    // Reference-link definition at the foot, e.g. "[0.4.0]: https://github.com/...".
    expect(changelog).toContain(`\n[${version}]: https://github.com/briggsd/code-reviewer`);
  });
});
