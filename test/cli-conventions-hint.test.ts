/**
 * Tests for the conventions discoverability hint (#383, M034).
 * formatConventionsHint returns a one-line stderr nudge when the effective config
 * carries no conventions, and an empty array when conventions are present.
 *
 * Exercises the real formatConventionsHint helper from src/cli/run-options.ts,
 * which is the same function runCommand uses — changing the production logic will
 * break these tests rather than silently passing with a local copy.
 */

import { describe, expect, test } from "bun:test";
import { formatConventionsHint } from "../src/cli/run-options.ts";
import { createDefaultReviewConfig } from "../src/runner/default-config.ts";

describe("formatConventionsHint (#383)", () => {
  test("default config (no conventions) returns a one-line hint", () => {
    const config = createDefaultReviewConfig();
    const lines = formatConventionsHint(config);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("conventions");
    expect(lines[0]).toContain(".ai-review.json");
  });

  test("config with empty conventions array still returns the hint", () => {
    const config = { ...createDefaultReviewConfig(), conventions: [] };
    const lines = formatConventionsHint(config);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("conventions");
  });

  test("config with at least one convention returns empty array (no nudge)", () => {
    const config = {
      ...createDefaultReviewConfig(),
      conventions: ["scripts/* are maintainer tools"],
    };
    expect(formatConventionsHint(config)).toEqual([]);
  });
});
