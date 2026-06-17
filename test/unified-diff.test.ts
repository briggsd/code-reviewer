import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "../src/shared/unified-diff.ts";

// Locks the public surface of the new src/shared/unified-diff module directly —
// distinct from the barrel-path coverage in git-diff-source.test.ts.

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 export { a };
`;

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const fresh = true;
+export const second = 1;
`;

describe("parseUnifiedDiff (src/shared/unified-diff.ts)", () => {
  test("parses a modified file: status, path, addition/deletion counts, and patch content", () => {
    const files = parseUnifiedDiff(MODIFIED);

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file?.path).toBe("src/app.ts");
    expect(file?.status).toBe("modified");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(file?.isBinary).toBe(false);
    expect(file?.patch).toContain("@@ -1,3 +1,4 @@");
    expect(file?.patch).toContain("+const b = 3;");
    expect(file?.patch).toContain("-const b = 2;");
  });

  test("parses an added file: status is added, path from +++ line, no deletions", () => {
    const files = parseUnifiedDiff(ADDED);

    expect(files).toHaveLength(1);
    const [file] = files;
    expect(file?.path).toBe("src/new.ts");
    expect(file?.status).toBe("added");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(0);
    expect(file?.isBinary).toBe(false);
    expect(file?.oldPath).toBeUndefined();
  });

  test("returns an empty array for an empty diff string", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  test("parses multiple files and preserves order", () => {
    const files = parseUnifiedDiff(`${MODIFIED}${ADDED}`);

    expect(files).toHaveLength(2);
    expect(files.map((f) => f.path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(files[0]?.status).toBe("modified");
    expect(files[1]?.status).toBe("added");
  });

  test("flags lockfile paths with isLockfile: true", () => {
    const lockfileDiff = `diff --git a/bun.lock b/bun.lock
index 8888888..9999999 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,1 +1,2 @@
 {}
+{"added": true}
`;
    const [file] = parseUnifiedDiff(lockfileDiff);

    expect(file?.isLockfile).toBe(true);
    expect(file?.path).toBe("bun.lock");
  });
});
