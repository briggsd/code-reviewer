import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";

describe("GitHub Action wrapper", () => {
  test("is a thin composite wrapper around the packaged CLI", async () => {
    const action = await readFile("action.yml", "utf8");

    expect(action).toContain("using: composite");
    expect(action).toContain("oven-sh/setup-bun@v2");
    expect(action).toContain('bun add --global "$AI_REVIEW_PACKAGE"');
    expect(action).toContain('default: "@briggsd/code-reviewer@0.4.0"');
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

  test("manifest scalar values do not start with an unquoted YAML indicator", async () => {
    // Regression lock for the v0.3.0 action-wrapper bug: a plain YAML scalar starting with a
    // reserved indicator is invalid, so GitHub fails to LOAD the manifest before any input
    // override can apply. The string `.toContain` assertions above never caught it because they
    // never inspect the value's first character.
    //
    // This is a deliberate heuristic, NOT a full YAML parse — it stays independent of the
    // CI-pinned Bun's YAML support (`Bun.YAML` has had cross-version issues). It flags a value
    // (after a `:` or a `-` list marker) whose first character is one of the indicators that are
    // invalid as a plain-scalar start AND never legitimately begin a value in these manifests:
    //   @  `  *  &  !  %
    // `|`/`>` (block scalars), `"`/`'` (quotes), and `[`/`{` (flow collections) are valid starts
    // and are intentionally NOT flagged; a quoted value (`default: "@..."`) starts with `"`.
    const ciFiles = (await readdir("examples/ci")).filter((f) => f.endsWith(".yml"));
    const files = ["action.yml", ...ciFiles.map((f) => `examples/ci/${f}`)];
    const offenders: string[] = [];
    for (const file of files) {
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        if (/(:\s+|^\s*-\s+)[@`*&!%]/.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
