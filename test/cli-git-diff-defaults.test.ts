/**
 * Tests for --git-diff smart defaults (#337).
 * When --git-diff is set, --output-dir defaults to ".ai-review" and --runtime
 * defaults to "dummy" — but only when those flags are absent. Explicit values win.
 *
 * Exercises the real applyGitDiffDefault helper from src/cli/run-options.ts, which
 * is the same function runCommand uses — changing the production logic will break
 * these tests rather than silently passing with a local copy.
 */

import { describe, expect, test } from "bun:test";
import { applyGitDiffDefault } from "../src/cli/run-options.ts";

function resolveOutputDir(args: string[]): string | undefined {
  return applyGitDiffDefault(
    args.includes("--output-dir") ? args[args.indexOf("--output-dir") + 1] : undefined,
    args,
    ".ai-review",
  );
}

function resolveRuntime(args: string[]): string | undefined {
  return applyGitDiffDefault(
    args.includes("--runtime") ? args[args.indexOf("--runtime") + 1] : undefined,
    args,
    "dummy",
  );
}

describe("--git-diff smart defaults (#337)", () => {
  describe("with --git-diff only (no explicit --output-dir or --runtime)", () => {
    const args = ["--git-diff"];

    test("defaults output-dir to .ai-review", () => {
      expect(resolveOutputDir(args)).toBe(".ai-review");
    });

    test("defaults runtime to dummy", () => {
      expect(resolveRuntime(args)).toBe("dummy");
    });
  });

  describe("with --git-diff and explicit overrides", () => {
    test("explicit --output-dir wins over default", () => {
      expect(resolveOutputDir(["--git-diff", "--output-dir", "/tmp/my-review"])).toBe(
        "/tmp/my-review",
      );
    });

    test("explicit --runtime pi wins over default", () => {
      expect(resolveRuntime(["--git-diff", "--runtime", "pi"])).toBe("pi");
    });

    test("explicit --runtime dummy is preserved as-is", () => {
      expect(resolveRuntime(["--git-diff", "--runtime", "dummy"])).toBe("dummy");
    });
  });

  describe("without --git-diff (CI / fixture paths unchanged)", () => {
    test("output-dir remains undefined when not set", () => {
      expect(
        resolveOutputDir(["--provider", "github", "--repo", "acme/app", "--change-id", "1"]),
      ).toBeUndefined();
    });

    test("runtime remains undefined when not set", () => {
      expect(
        resolveRuntime(["--provider", "github", "--repo", "acme/app", "--change-id", "1"]),
      ).toBeUndefined();
    });

    test("explicit --output-dir without --git-diff still works", () => {
      expect(resolveOutputDir(["--output-dir", ".ai-review"])).toBe(".ai-review");
    });

    test("explicit --runtime without --git-diff still works", () => {
      expect(resolveRuntime(["--runtime", "pi"])).toBe("pi");
    });
  });
});
