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

    const cli = await readFile("src/cli.ts", "utf8");
    expect(cli.startsWith("#!/usr/bin/env bun\n")).toBe(true);
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
