import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

describe("GitHub Action wrapper", () => {
  test("is a thin composite wrapper around the packaged CLI", async () => {
    const action = await readFile("action.yml", "utf8");

    expect(action).toContain("using: composite");
    expect(action).toContain("oven-sh/setup-bun@v2");
    expect(action).toContain('bun add --global "$AI_REVIEW_PACKAGE"');
    expect(action).toContain('default: "@briggsd/code-reviewer@0.3.1"');
    expect(action).toContain('code-reviewer "${args[@]}"');
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

  test("manifests have no unquoted YAML reserved-indicator scalars", async () => {
    // Regression lock for the v0.3.0 action-wrapper bug: a plain YAML scalar starting with a
    // reserved indicator (`@` or a backtick) is invalid, so GitHub fails to LOAD the manifest
    // before any input override can apply. The string `.toContain` assertions above never caught
    // it because they never parse the YAML. Scan the real manifests for a value (after `:` or a
    // `-` list marker) that begins with an unquoted reserved indicator. A quoted value
    // (`default: "@..."`) starts with `"`, so it is correctly NOT flagged.
    const ciFiles = (await readdir("examples/ci")).filter((f) => f.endsWith(".yml"));
    const files = ["action.yml", ...ciFiles.map((f) => `examples/ci/${f}`)];
    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (/(:\s+|^\s*-\s+)[@`]/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
