import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("GitHub Action wrapper", () => {
  test("is a thin composite wrapper around the packaged CLI", async () => {
    const action = await readFile("action.yml", "utf8");

    expect(action).toContain("using: composite");
    expect(action).toContain("oven-sh/setup-bun@v2");
    expect(action).toContain('bun add --global "$AI_REVIEW_PACKAGE"');
    expect(action).toContain("default: ai-code-review-factory@0.1.0");
    expect(action).toContain('ai-code-review "${args[@]}"');
    expect(action).toContain("fixture:");
    expect(action).toContain('--fixture "$AI_REVIEW_FIXTURE"');
    expect(action).toContain("provider, repo, and change-id are required unless fixture is set");
    expect(action).toContain('--provider "$AI_REVIEW_PROVIDER"');
    expect(action).toContain('--repo "$AI_REVIEW_REPO"');
    expect(action).toContain('--change-id "$AI_REVIEW_CHANGE_ID"');
    expect(action).toContain('--output-dir "$AI_REVIEW_OUTPUT_DIR"');
    expect(action).not.toContain("bun run src/cli.ts");
  });

  test("keeps summary and inline publishing explicit opt-ins", async () => {
    const action = await readFile("action.yml", "utf8");

    expect(action).toContain("publish-summary:");
    expect(action).toContain("publish-inline:");
    expect(action).toContain("AI_REVIEW_PUBLISH_SUMMARY: ${{ inputs.publish-summary }}");
    expect(action).toContain("AI_REVIEW_PUBLISH_INLINE: ${{ inputs.publish-inline }}");
    expect(action).toContain('if [[ "$AI_REVIEW_PUBLISH_SUMMARY" == "true" ]]; then');
    expect(action).toContain('if [[ "$AI_REVIEW_PUBLISH_INLINE" == "true" ]]; then');
    expect(action).toContain("args+=(--publish-summary)");
    expect(action).toContain("args+=(--publish-inline)");
    expect(action).toContain('default: "false"');
  });
});
