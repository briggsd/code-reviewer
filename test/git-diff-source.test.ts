import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("reads working-tree full content for non-binary, non-deleted changed files", async () => {
    const reads: string[] = [];
    const { changedFileContents } = await loadGitDiffChange(
      {
        base: "main",
        readWorkingTreeFile: async (path) => {
          reads.push(path);
          return `full content for ${path}`;
        },
      },
      fakeGit({ "diff --no-color main": `${MODIFIED}${ADDED}${DELETED}${BINARY}` }),
    );

    expect(reads.sort()).toEqual(["src/app.ts", "src/new.ts"]);
    expect(changedFileContents).toEqual({
      "src/app.ts": "full content for src/app.ts",
      "src/new.ts": "full content for src/new.ts",
    });
  });

  test("working-tree full content read failures degrade to absent content", async () => {
    const { changedFileContents } = await loadGitDiffChange(
      {
        base: "main",
        readWorkingTreeFile: async (path) => {
          if (path === "src/app.ts") {
            throw new Error("read failed");
          }
          return `full content for ${path}`;
        },
      },
      fakeGit(),
    );

    expect(changedFileContents).toEqual({
      "src/new.ts": "full content for src/new.ts",
    });
  });

  test("default working-tree reader skips symlinks that resolve outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "acrf-git-diff-"));
    const repo = join(root, "repo");
    const outside = join(root, "outside-secret.txt");
    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await writeFile(outside, "do not read me", "utf8");
      await symlink(outside, join(repo, "src/app.ts"));

      const { changedFileContents } = await loadGitDiffChange(
        { base: "main" },
        fakeGit({
          "diff --no-color main": MODIFIED,
          "rev-parse --show-toplevel": `${repo}\n`,
        }),
      );

      expect(changedFileContents).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

describe("includeUntracked", () => {
  // A recording runner: pushes every args array into `calls`, then dispatches on the
  // joined key. Throws for any key not in `responses`.
  function recordingGit(responses: Record<string, string>): {
    runner: GitRunner;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push([...args]);
      const key = args.join(" ");
      if (!(key in responses)) {
        throw new Error(`unexpected git call: ${key}`);
      }
      return responses[key] as string;
    };
    return { runner, calls };
  }

  // Base responses shared by tests that need a successful full run.
  const baseResponses: Record<string, string> = {
    "rev-parse HEAD": "headsha123\n",
    "rev-parse main": "basesha456\n",
    "rev-parse --abbrev-ref HEAD": "feature/x\n",
    "config user.name": "Ada Lovelace\n",
    "config user.email": "ada@example.com\n",
    "remote get-url origin": "git@github.com:acme/widgets.git\n",
    "rev-parse --show-toplevel": "/home/ada/widgets\n",
  };

  test("untracked file included + index restored", async () => {
    const { runner, calls } = recordingGit({
      "ls-files --others --exclude-standard -z": "src/new-untracked.ts\0",
      "add -N -- src/new-untracked.ts": "",
      "diff --no-color main": `${MODIFIED}${ADDED}`,
      "reset -- src/new-untracked.ts": "",
      ...baseResponses,
    });

    const { diff } = await loadGitDiffChange({ base: "main", includeUntracked: true }, runner);

    // The new file (ADDED = src/new.ts) is in the diff files.
    expect(diff.files.map((f) => f.path)).toContain("src/new.ts");

    const joinedCalls = calls.map((c) => c.join(" "));
    const addIdx = joinedCalls.indexOf("add -N -- src/new-untracked.ts");
    const diffIdx = joinedCalls.findIndex((c) => c.startsWith("diff --no-color"));
    const resetIdx = joinedCalls.indexOf("reset -- src/new-untracked.ts");

    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(diffIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(addIdx).toBeLessThan(diffIdx);
    expect(resetIdx).toBeGreaterThan(diffIdx);
  });

  test("index restored even when the diff throws (load-bearing regression guard)", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key === "ls-files --others --exclude-standard -z") {
        return "src/new-untracked.ts\0";
      }
      if (key === "add -N -- src/new-untracked.ts") {
        return "";
      }
      if (key === "reset -- src/new-untracked.ts") {
        return "";
      }
      // diff --no-color main (and all other git metadata calls) throw — simulating
      // a transient failure after add -N has already mutated the index.
      throw new Error("git diff failed");
    };

    await expect(
      loadGitDiffChange({ base: "main", includeUntracked: true }, runner),
    ).rejects.toThrow("git diff failed");

    // The finally block must have fired: reset was still called even though diff threw.
    expect(calls.map((c) => c.join(" "))).toContain("reset -- src/new-untracked.ts");
  });

  test("dual failure (diff throws AND reset throws) preserves the original cause", async () => {
    const calls: string[][] = [];
    const runner: GitRunner = async (args) => {
      calls.push([...args]);
      const key = args.join(" ");
      if (key === "ls-files --others --exclude-standard -z") {
        return "src/new-untracked.ts\0";
      }
      if (key === "add -N -- src/new-untracked.ts") {
        return "";
      }
      if (key === "reset -- src/new-untracked.ts") {
        throw new Error("index.lock held");
      }
      throw new Error("git diff failed");
    };

    // Both body (diff) and restore (reset) fail. The thrown error must SIGNAL the restore
    // failure but RETAIN the original diff error as the cause — never mask it.
    let caught: unknown;
    try {
      await loadGitDiffChange({ base: "main", includeUntracked: true }, runner);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("could not be restored");
    expect((caught as Error).message).toContain("index.lock held");
    expect((caught as Error).cause).toBeInstanceOf(Error);
    expect(((caught as Error).cause as Error).message).toBe("git diff failed");
    // Restore was attempted despite the body failure.
    expect(calls.map((c) => c.join(" "))).toContain("reset -- src/new-untracked.ts");
  });

  test("flag off (default) — no ls-files, add, or reset calls", async () => {
    const { runner, calls } = recordingGit({
      "diff --no-color main": MODIFIED,
      ...baseResponses,
    });

    await loadGitDiffChange({ base: "main" }, runner);

    const joinedCalls = calls.map((c) => c.join(" "));
    expect(joinedCalls.some((c) => c.startsWith("ls-files"))).toBe(false);
    expect(joinedCalls.some((c) => c.startsWith("add"))).toBe(false);
    expect(joinedCalls.some((c) => c.startsWith("reset"))).toBe(false);
  });

  test("no untracked files — no add/reset calls even with flag set", async () => {
    const { runner, calls } = recordingGit({
      "ls-files --others --exclude-standard -z": "",
      "diff --no-color main": MODIFIED,
      ...baseResponses,
    });

    await loadGitDiffChange({ base: "main", includeUntracked: true }, runner);

    const joinedCalls = calls.map((c) => c.join(" "));
    expect(joinedCalls.some((c) => c.startsWith("add"))).toBe(false);
    expect(joinedCalls.some((c) => c.startsWith("reset"))).toBe(false);
  });

  // Integration: the mock tests above prove the command sequence; this one proves the real git
  // effect — an untracked file actually lands in the diff, a gitignored one does not, and the
  // operator's index is genuinely restored (the invariant a mock can't verify).
  test("real git: untracked file enters the diff, gitignored excluded, index restored", async () => {
    const root = await mkdtemp(join(tmpdir(), "acrf-untracked-"));
    // A real GitRunner scoped to the temp repo — mirrors the production runner (throws on non-zero).
    const realGit: GitRunner = async (args) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
      }
      return stdout;
    };

    try {
      await realGit(["init", "-q"]);
      await realGit(["config", "user.email", "test@example.com"]);
      await realGit(["config", "user.name", "Test"]);
      await realGit(["config", "commit.gpgsign", "false"]);
      await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
      await writeFile(join(root, "committed.ts"), "export const a = 1;\n", "utf8");
      await realGit(["add", ".gitignore", "committed.ts"]);
      await realGit(["commit", "-q", "-m", "initial"]);
      // A genuinely-untracked, non-ignored file (the case the flag exists for) + an ignored one.
      await writeFile(join(root, "new-untracked.ts"), "export const fresh = true;\n", "utf8");
      await writeFile(join(root, "ignored.txt"), "should not be reviewed\n", "utf8");

      const { diff } = await loadGitDiffChange({ base: "HEAD", includeUntracked: true }, realGit);

      const paths = diff.files.map((f) => f.path);
      expect(paths).toContain("new-untracked.ts");
      expect(paths).not.toContain("ignored.txt");

      // The load-bearing invariant against a REAL index: the file is still merely untracked
      // ("?? "), not left intent-added ("A  ") — i.e. the index was restored to what we found.
      const status = await realGit(["status", "--porcelain"]);
      expect(status).toContain("?? new-untracked.ts");
      expect(status).not.toContain("A  new-untracked.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
