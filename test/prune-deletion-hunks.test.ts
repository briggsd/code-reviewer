import { describe, expect, test } from "bun:test";
import { pruneDeletionOnlyHunks } from "../src/runner/prune-deletion-hunks.ts";

describe("pruneDeletionOnlyHunks", () => {
  test("(a) pure-deletion hunk is dropped — patch becomes undefined, droppedHunks = 1", () => {
    // A hunk with only `-` lines and no `+` lines.
    const patch = "@@ -1,3 +1,0 @@\n-line1\n-line2\n-line3";
    const result = pruneDeletionOnlyHunks(patch);
    expect(result.patch).toBeUndefined();
    expect(result.droppedHunks).toBe(1);
  });

  test("(a) context-only hunk (no + or - lines) is dropped", () => {
    const patch = "@@ -1,2 +1,2 @@\n line1\n line2";
    const result = pruneDeletionOnlyHunks(patch);
    expect(result.patch).toBeUndefined();
    expect(result.droppedHunks).toBe(1);
  });

  test("(b) mixed hunk (-old/+new) is KEPT in full, including its - lines", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new";
    const result = pruneDeletionOnlyHunks(patch);
    // Must be kept unchanged.
    expect(result.patch).toBe(patch);
    expect(result.droppedHunks).toBe(0);
  });

  test("(c) addition-only hunk is kept", () => {
    const patch = "@@ -0,0 +1 @@\n+safe";
    const result = pruneDeletionOnlyHunks(patch);
    expect(result.patch).toBe(patch);
    expect(result.droppedHunks).toBe(0);
  });

  test("(d) multi-hunk patch: deletion-only hunk dropped, hunk with additions kept; header + surviving hunk reassembled", () => {
    // Two hunks: first is deletion-only, second has an addition.
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,1 @@",
      "-deleted line",
      "-another deleted",
      "@@ -10 +9 @@",
      "-old value",
      "+new value",
    ].join("\n");

    const result = pruneDeletionOnlyHunks(patch);
    expect(result.droppedHunks).toBe(1);
    expect(result.patch).toBeDefined();

    // The file-level header lines must be in the output.
    expect(result.patch).toContain("diff --git a/foo.ts b/foo.ts");
    expect(result.patch).toContain("--- a/foo.ts");
    expect(result.patch).toContain("+++ b/foo.ts");

    // The surviving hunk must be present.
    expect(result.patch).toContain("@@ -10 +9 @@");
    expect(result.patch).toContain("-old value");
    expect(result.patch).toContain("+new value");

    // The dropped hunk must NOT be present.
    expect(result.patch).not.toContain("@@ -1,2 +1,1 @@");
    expect(result.patch).not.toContain("-deleted line");
  });

  test("(d) when both hunks have additions, neither is dropped", () => {
    const patch = ["@@ -1 +1 @@", "-a", "+b", "@@ -5 +5 @@", "+c"].join("\n");
    const result = pruneDeletionOnlyHunks(patch);
    expect(result.droppedHunks).toBe(0);
    expect(result.patch).toBe(patch);
  });

  test("(e) patch with no @@ header is returned unchanged (droppedHunks: 0)", () => {
    const patch = "Binary files differ";
    const result = pruneDeletionOnlyHunks(patch);
    expect(result.patch).toBe(patch);
    expect(result.droppedHunks).toBe(0);
  });

  test("(e) empty string with no @@ header is returned unchanged", () => {
    const result = pruneDeletionOnlyHunks("");
    expect(result.patch).toBe("");
    expect(result.droppedHunks).toBe(0);
  });

  test("file-header +++ line is not mistaken for an addition", () => {
    // A hunk that has `+++` as the only `+`-prefixed content — it's a file header,
    // not a body line. The hunk has no actual added lines and should be dropped.
    const patch = ["--- a/foo.ts", "+++ b/foo.ts", "@@ -1,1 +0,0 @@", "-only deleted"].join("\n");
    const result = pruneDeletionOnlyHunks(patch);
    // The +++ line is before the first @@, so it's in the header block, not the hunk body.
    // The hunk itself has no + body line — it should be pruned.
    expect(result.patch).toBeUndefined();
    expect(result.droppedHunks).toBe(1);
  });

  test("hunk-body addition whose source starts with `++` is KEPT (not treated as a +++ header)", () => {
    // Source line `++counter;` (a pre-increment) added inside a hunk → diff line `+++counter;`.
    // This is a genuine addition; the hunk must NOT be pruned (#144 review regression guard).
    const patch = ["@@ -1,0 +1,1 @@", "+++counter;"].join("\n");
    const result = pruneDeletionOnlyHunks(patch);
    expect(result.patch).toBe(patch);
    expect(result.droppedHunks).toBe(0);
  });

  test("reassembled patch from multi-hunk preserves exact line content", () => {
    const hunk1Header = "@@ -1,1 +0,0 @@";
    const hunk2Header = "@@ -5,1 +4,2 @@";
    const patch = [hunk1Header, "-removed", hunk2Header, " ctx", "+added"].join("\n");
    const result = pruneDeletionOnlyHunks(patch);
    expect(result.droppedHunks).toBe(1);
    // Only hunk2 should survive; no leading header block in this patch.
    expect(result.patch).toBe([hunk2Header, " ctx", "+added"].join("\n"));
  });
});
