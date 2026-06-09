import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("re-review state documentation", () => {
  test("documents stable finding IDs and hidden metadata", async () => {
    const guide = await readFile("docs/re-review-state.md", "utf8");
    const readme = await readFile("README.md", "utf8");

    expect(guide).toContain("Stable finding IDs");
    expect(guide).toContain("assignStableFindingIds()");
    expect(guide).toContain("createStableFindingId()");
    expect(guide).toContain("schemaVersion: 1");
    expect(guide).toContain("findingIds");
    expect(guide).toContain("parseSummaryHiddenMetadata()");
    expect(guide).toContain("createPriorReviewStateFromMetadata()");
    expect(guide).toContain("new, recurring, or absent/fixed");
    expect(readme).toContain("[Re-review state](docs/re-review-state.md)");
  });
});
