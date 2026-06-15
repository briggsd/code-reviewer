import { describe, expect, test } from "bun:test";
import type { ChangedFile, DiffSummary } from "../src/index.ts";
import { classifyRisk, createDefaultReviewConfig, loadProjectReviewConfig } from "../src/index.ts";

// Guards the repo-local .ai-review.json (#77): the factory must full-tier changes to its OWN
// deterministic review-gate logic, which the default sensitivePaths (auth/**, crypto/**, …) do
// not cover. PR #76 (a change to src/runner/evidence-grounding.ts, i.e. the merge-gate filter)
// was tiered `lite` and got a shallow, no-thinking review precisely because of this gap.

function changedFile(path: string): ChangedFile {
  return { path, status: "modified", additions: 10, deletions: 2, isBinary: false };
}

function diffOf(...paths: string[]): DiffSummary {
  const files = paths.map(changedFile);
  return {
    files,
    totalAdditions: files.length * 10,
    totalDeletions: files.length * 2,
    truncated: false,
  };
}

describe("repo .ai-review.json self-review sensitive paths (#77)", () => {
  test("loads the repo config and still includes the default sensitive paths (override replaces, must re-list)", async () => {
    // cwd is the repo root under `bun test`; this auto-discovers the repo-local .ai-review.json.
    const config = await loadProjectReviewConfig();
    const defaults = createDefaultReviewConfig().sensitivePaths;

    // The repo file overrides sensitivePaths wholesale (normalizeReviewConfig does not merge
    // arrays), so the defaults must be re-listed — assert none were dropped.
    for (const pattern of defaults) {
      expect(config.sensitivePaths).toContain(pattern);
    }

    // …plus the factory's own gate/trust/policy/publish surface.
    expect(config.sensitivePaths).toContain("src/runner/**");
    expect(config.sensitivePaths).toContain("src/runtime/prompt-boundary.ts");
    expect(config.sensitivePaths).toContain("src/ci/**");
    expect(config.sensitivePaths).toContain("src/publisher/**");
  });

  test("a change to the gate filter (src/runner/evidence-grounding.ts) classifies as full tier", async () => {
    const config = await loadProjectReviewConfig();
    const risk = classifyRisk({
      diff: diffOf("src/runner/evidence-grounding.ts"),
      config,
      ignoredFileCount: 0,
    });

    expect(risk.tier).toBe("full");
    expect(risk.matchedRules).toEqual(["sensitive_paths"]);
    expect(risk.sensitivePaths).toEqual(["src/runner/evidence-grounding.ts"]);
  });

  test("changes to prompt-boundary, ci policy, and the publisher each escalate to full tier", async () => {
    const config = await loadProjectReviewConfig();
    for (const path of [
      "src/runtime/prompt-boundary.ts",
      "src/ci/decision-policy.ts",
      "src/publisher/markdown-escape.ts",
    ]) {
      const risk = classifyRisk({ diff: diffOf(path), config, ignoredFileCount: 0 });
      expect(risk.tier).toBe("full");
    }
  });

  test("a non-gate change (docs only) is NOT escalated to full tier", async () => {
    const config = await loadProjectReviewConfig();
    const risk = classifyRisk({
      diff: diffOf("docs/developer/architecture.md"),
      config,
      ignoredFileCount: 0,
    });

    expect(risk.tier).not.toBe("full");
    expect(risk.sensitivePaths).toEqual([]);
  });
});

describe("repo .ai-review.json conventions (#162)", () => {
  test("loads conventions array with expected entries", async () => {
    const config = await loadProjectReviewConfig();

    // Non-empty array — at least the 10 entries added in #162 Step 1.
    expect(Array.isArray(config.conventions)).toBe(true);
    expect((config.conventions ?? []).length).toBeGreaterThanOrEqual(8);

    // Spot-check: one Tier 2 entry (silent-contract rule) and one Tier 3 entry (zero-width-space).
    expect(config.conventions?.some((c) => c.includes("silent contract"))).toBe(true);
    expect(config.conventions?.some((c) => c.includes("Zero-width-space"))).toBe(true);
  });

  test("all convention entries satisfy schema bounds (≤500 chars, ≤50 entries)", async () => {
    const config = await loadProjectReviewConfig();
    const entries = config.conventions ?? [];

    expect(entries.length).toBeLessThanOrEqual(50);
    for (const entry of entries) {
      expect(entry.length).toBeLessThanOrEqual(500);
    }
  });
});
