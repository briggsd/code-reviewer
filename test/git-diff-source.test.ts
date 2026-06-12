import { describe, expect, test } from "bun:test";
import type { GitRunner } from "../src/index.ts";
import { loadGitDiffChange, parseUnifiedDiff } from "../src/index.ts";

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

const DELETED = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index 4444444..0000000
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`;

const RENAMED = `diff --git a/src/from.ts b/src/to.ts
similarity index 90%
rename from src/from.ts
rename to src/to.ts
index 5555555..6666666 100644
--- a/src/from.ts
+++ b/src/to.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;
`;

const BINARY = `diff --git a/logo.png b/logo.png
new file mode 100644
index 0000000..7777777
Binary files /dev/null and b/logo.png differ
`;

const LOCKFILE = `diff --git a/bun.lock b/bun.lock
index 8888888..9999999 100644
--- a/bun.lock
+++ b/bun.lock
@@ -1,1 +1,2 @@
 {}
+{"added": true}
`;

describe("parseUnifiedDiff", () => {
  test("parses a modified file's status, counts, and patch", () => {
    const [file] = parseUnifiedDiff(MODIFIED);

    expect(file?.path).toBe("src/app.ts");
    expect(file?.status).toBe("modified");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(file?.isBinary).toBe(false);
    expect(file?.patch).toContain("@@ -1,3 +1,4 @@");
    expect(file?.patch).toContain("+const c = 4;");
  });

  test("classifies added and deleted files", () => {
    expect(parseUnifiedDiff(ADDED)[0]).toMatchObject({
      path: "src/new.ts",
      status: "added",
      additions: 2,
      deletions: 0,
    });
    expect(parseUnifiedDiff(DELETED)[0]).toMatchObject({
      path: "old.ts",
      status: "deleted",
      additions: 0,
      deletions: 1,
    });
  });

  test("captures rename old/new paths", () => {
    const [file] = parseUnifiedDiff(RENAMED);

    expect(file?.status).toBe("renamed");
    expect(file?.path).toBe("src/to.ts");
    expect(file?.oldPath).toBe("src/from.ts");
  });

  test("marks binary files and omits a patch", () => {
    const [file] = parseUnifiedDiff(BINARY);

    expect(file?.isBinary).toBe(true);
    expect(file?.patch).toBeUndefined();
    expect(file?.additions).toBe(0);
  });

  test("flags lockfiles so the diff filter can drop them", () => {
    expect(parseUnifiedDiff(LOCKFILE)[0]?.isLockfile).toBe(true);
  });

  test("parses multiple files in one diff", () => {
    const files = parseUnifiedDiff(`${MODIFIED}${ADDED}${DELETED}`);

    expect(files.map((file) => file.path)).toEqual(["src/app.ts", "src/new.ts", "old.ts"]);
  });

  test("handles paths containing spaces (unquoted by git)", () => {
    const spaced = `diff --git a/docs/my notes.md b/docs/my notes.md
index aaa..bbb 100644
--- a/docs/my notes.md
+++ b/docs/my notes.md
@@ -1,1 +1,1 @@
-old
+new
`;
    const [file] = parseUnifiedDiff(spaced);

    expect(file?.path).toBe("docs/my notes.md");
    expect(file?.status).toBe("modified");
  });

  test("uses the +++ line for an added file's path", () => {
    const addedSpaced = `diff --git a/a b.ts b/a b.ts
new file mode 100644
index 000..ccc
--- /dev/null
+++ b/a b.ts
@@ -0,0 +1,1 @@
+const v = 1;
`;
    const [file] = parseUnifiedDiff(addedSpaced);

    expect(file?.path).toBe("a b.ts");
    expect(file?.status).toBe("added");
  });

  test("decodes git C-quoted non-ASCII paths to UTF-8", () => {
    // git quotes and octal-escapes non-ASCII bytes: "café.md" → \303\251 for "é".
    const quoted = `diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"
index aaa..bbb 100644
--- "a/caf\\303\\251.md"
+++ "b/caf\\303\\251.md"
@@ -1,1 +1,1 @@
-a
+b
`;
    expect(parseUnifiedDiff(quoted)[0]?.path).toBe("café.md");
  });

  test("decodes a literal multibyte char alongside an escape in a quoted path", () => {
    // core.quotePath=false keeps "é" literal, but an embedded quote still forces
    // quoting: "a/café\"x.md". The literal é must round-trip as one codepoint.
    const quoted = `diff --git "a/café\\"x.md" "b/café\\"x.md"
--- "a/café\\"x.md"
+++ "b/café\\"x.md"
@@ -1,1 +1,1 @@
-a
+b
`;
    expect(parseUnifiedDiff(quoted)[0]?.path).toBe('café"x.md');
  });

  test("decodes a C-quoted rename path (rename lines bypass --- / +++)", () => {
    const renamed = `diff --git "a/caf\\303\\251.md" "b/re\\303\\251named.md"
similarity index 100%
rename from "caf\\303\\251.md"
rename to "re\\303\\251named.md"
`;
    const [file] = parseUnifiedDiff(renamed);

    expect(file?.status).toBe("renamed");
    expect(file?.path).toBe("reénamed.md");
    expect(file?.oldPath).toBe("café.md");
  });

  test("returns no files for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});

describe("loadGitDiffChange", () => {
  const fakeGit =
    (overrides: Record<string, string> = {}): GitRunner =>
    async (args) => {
      const key = args.join(" ");
      const responses: Record<string, string> = {
        "diff --no-color main": `${MODIFIED}${ADDED}`,
        "rev-parse HEAD": "headsha123\n",
        "rev-parse main": "basesha456\n",
        "rev-parse --abbrev-ref HEAD": "feature/x\n",
        "config user.name": "Ada Lovelace\n",
        "config user.email": "ada@example.com\n",
        "remote get-url origin": "git@github.com:acme/widgets.git\n",
        "rev-parse --show-toplevel": "/home/ada/widgets\n",
        ...overrides,
      };
      if (!(key in responses)) {
        throw new Error(`unexpected git call: ${key}`);
      }

      return responses[key] as string;
    };

  test("builds local change metadata and a totalled diff from git output", async () => {
    const { metadata, diff } = await loadGitDiffChange({ base: "main" }, fakeGit());

    expect(metadata.provider).toBe("local");
    expect(metadata.repository.name).toBe("widgets");
    expect(metadata.changeId).toBe("feature/x");
    expect(metadata.sourceBranch).toBe("feature/x");
    expect(metadata.targetBranch).toBe("main");
    expect(metadata.headSha).toBe("headsha123");
    expect(metadata.baseSha).toBe("basesha456");
    expect(metadata.author.username).toBe("Ada Lovelace");

    expect(diff.files).toHaveLength(2);
    expect(diff.totalAdditions).toBe(4);
    expect(diff.totalDeletions).toBe(1);
    expect(diff.truncated).toBe(false);
  });

  test("rejects a base ref that could be parsed as a git option", async () => {
    const git: GitRunner = async () => {
      throw new Error("git should not be invoked for an invalid base");
    };

    await expect(loadGitDiffChange({ base: "--upload-pack=evil" }, git)).rejects.toThrow(
      /invalid --base/,
    );
  });

  test("defaults base to HEAD (working-tree review)", async () => {
    const git = fakeGit({ "diff --no-color HEAD": MODIFIED, "rev-parse HEAD": "headsha123\n" });
    const { metadata } = await loadGitDiffChange({}, git);

    expect(metadata.targetBranch).toBe("HEAD");
  });

  test("degrades gracefully when optional metadata commands fail", async () => {
    const git: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key === "diff --no-color HEAD") {
        return MODIFIED;
      }
      throw new Error("not a git repo");
    };
    const { metadata, diff } = await loadGitDiffChange({}, git);

    expect(metadata.provider).toBe("local");
    expect(metadata.headSha).toBe("working-tree");
    expect(metadata.repository.name).toBe("local-repo");
    expect(diff.files).toHaveLength(1);
  });
});
