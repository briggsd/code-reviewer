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
