import { describe, expect, test } from "bun:test";
import {
  classifyRisk,
  createDefaultReviewConfig,
  filterDiff,
  loadReviewFixture,
  matchesGlob,
  runReview,
} from "../src/index.ts";

describe("path glob matching", () => {
  test("matches root and nested ignored path patterns", () => {
    expect(matchesGlob("package-lock.json", "**/package-lock.json")).toBe(true);
    expect(matchesGlob("frontend/package-lock.json", "**/package-lock.json")).toBe(true);
    expect(matchesGlob("public/app.min.js", "**/*.min.js")).toBe(true);
    expect(matchesGlob("auth/accounts.ts", "auth/**")).toBe(true);
    expect(matchesGlob(".github/workflows/release.yml", ".github/workflows/**")).toBe(true);
  });
});

describe("diff filtering and risk classification", () => {
  test("filters low-value files but keeps generated sensitive migrations", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/mixed-diff.json");
    const result = filterDiff(fixture.diff, fixture.config);

    expect(result.diff.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "migrations/20260609_add_accounts.sql",
      ".github/workflows/release.yml",
    ]);
    expect(result.ignoredFiles.map((ignored) => ignored.reason)).toEqual([
      "lockfile",
      "ignored_path",
      "binary",
    ]);
    expect(result.diff.totalAdditions).toBe(48);
    expect(result.diff.totalDeletions).toBe(4);
  });

  test("escalates filtered sensitive paths to full risk", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/mixed-diff.json");
    const filtered = filterDiff(fixture.diff, fixture.config);
    const risk = classifyRisk({
      diff: filtered.diff,
      config: fixture.config,
      ignoredFileCount: filtered.ignoredFiles.length,
    });

    expect(risk.tier).toBe("full");
    expect(risk.matchedRules).toEqual(["sensitive_paths"]);
    expect(risk.sensitivePaths).toEqual([
      "migrations/20260609_add_accounts.sql",
      ".github/workflows/release.yml",
    ]);
    expect(risk.reviewedFileCount).toBe(3);
    expect(risk.ignoredFileCount).toBe(3);
  });

  test("classifies ordinary 3-file small changes as trivial", () => {
    const config = createDefaultReviewConfig();
    const risk = classifyRisk({
      diff: {
        files: [
          { path: "src/a.ts", status: "modified", additions: 5, deletions: 0, isBinary: false },
          { path: "src/b.ts", status: "modified", additions: 5, deletions: 0, isBinary: false },
          { path: "docs/c.md", status: "modified", additions: 5, deletions: 0, isBinary: false },
        ],
        totalAdditions: 15,
        totalDeletions: 0,
        truncated: false,
      },
      config,
      ignoredFileCount: 0,
    });

    expect(risk.tier).toBe("trivial");
    expect(risk.matchedRules).toEqual(["small_change"]);
  });

  test("keeps 50-file ordinary changes lite and escalates 51-file changes to full", () => {
    const config = createDefaultReviewConfig();
    const files = Array.from({ length: 50 }, (_, index) => ({
      path: `src/file-${index}.ts`,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      isBinary: false,
    }));

    expect(classifyRisk({
      diff: {
        files,
        totalAdditions: 50,
        totalDeletions: 0,
        truncated: false,
      },
      config,
      ignoredFileCount: 0,
    }).tier).toBe("lite");

    expect(classifyRisk({
      diff: {
        files: [
          ...files,
          { path: "src/file-50.ts", status: "modified", additions: 1, deletions: 0, isBinary: false },
        ],
        totalAdditions: 51,
        totalDeletions: 0,
        truncated: false,
      },
      config,
      ignoredFileCount: 0,
    }).tier).toBe("full");
  });

  test("still escalates sensitive paths even when the change is otherwise trivial", () => {
    const config = createDefaultReviewConfig();
    const risk = classifyRisk({
      diff: {
        files: [
          { path: ".github/workflows/release.yml", status: "modified", additions: 1, deletions: 0, isBinary: false },
        ],
        totalAdditions: 1,
        totalDeletions: 0,
        truncated: false,
      },
      config,
      ignoredFileCount: 0,
    });

    expect(risk.tier).toBe("full");
    expect(risk.matchedRules).toEqual(["sensitive_paths"]);
  });

  test("runner context uses filtered diff", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/mixed-diff.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(result.context.diff.files.map((file) => file.path)).toEqual([
      "src/app.ts",
      "migrations/20260609_add_accounts.sql",
      ".github/workflows/release.yml",
    ]);
    expect(result.summary.risk.ignoredFileCount).toBe(3);
    expect(result.summary.body).toContain("Files ignored: 3");
  });

  test("generated non-sensitive files are ignored", () => {
    const config = createDefaultReviewConfig();
    const result = filterDiff(
      {
        files: [
          {
            path: "src/generated/client.ts",
            status: "modified",
            additions: 100,
            deletions: 100,
            isBinary: false,
            isGenerated: true,
          },
        ],
        totalAdditions: 100,
        totalDeletions: 100,
        truncated: false,
      },
      config,
    );

    expect(result.diff.files).toHaveLength(0);
    expect(result.ignoredFiles[0]?.reason).toBe("generated");
  });
});
