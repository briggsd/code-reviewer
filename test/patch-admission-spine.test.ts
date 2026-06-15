/**
 * Integration tests for the patch-admission gate wired into the run-review spine (#145).
 *
 * Verifies:
 * 1. context.built trace has an `admission` block with correct counts/bytes.
 * 2. Demoted files have NO patch written (name+stat only) and appear in overflowFiles in
 *    change-context.json.
 * 3. result.summary.partialBySize is set when degraded=true; absent when degraded=false.
 * 4. A degraded run does NOT hard-fail (no context_overflow error thrown).
 * 5. Config patchBudgets override wins over tier-profile default.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, TraceSink } from "../src/index.ts";
import { normalizeReviewFixture, runReview } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Minimal in-test sinks
// ---------------------------------------------------------------------------

class RecordingTraceSink implements TraceSink {
  readonly events: RuntimeEvent[] = [];

  async write(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a patch string of approximately `bytes` UTF-8 bytes. */
function makePatch(approxBytes: number): string {
  const line = "+const x = 1; // padding padding padding\n";
  const count = Math.ceil(approxBytes / line.length);
  return `@@ -0,0 +1,${count} @@\n${line.repeat(count)}`;
}

/** Calculate exact byte size of a patch string. */
function patchByteLength(patch: string): number {
  return Buffer.byteLength(patch, "utf8");
}

const SHARED_METADATA = {
  provider: "local" as const,
  repository: { provider: "local" as const, name: "demo", slug: "demo" },
  changeId: "local",
  headSha: "abc123",
  title: "Large change",
  author: { username: "dev" },
  labels: [] as string[],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("patch-admission spine integration (#145)", () => {
  test("degraded run: context.built has admission block, demoted files in overflowFiles, partialBySize set, no hard-fail", async () => {
    // Build patches with known sizes:
    // small.ts ≈ 100 bytes; large.ts ≈ 600 bytes.
    // Set patchBudgets.lite = 200 (smaller than small+large, larger than small alone).
    // Risk tier will be lite (2 files, 60 additions).
    const smallPatch = makePatch(100);
    const largePatch = makePatch(600);
    const smallBytes = patchByteLength(smallPatch);
    const largeBytes = patchByteLength(largePatch);

    // Budget: 200 bytes. small (≈100) fits, large (≈600) does not.
    // After sorting smallest-first: small admitted, large demoted.
    const budget = smallBytes + 1; // just enough for small, not large

    // Create an isolated temp dir for context artifacts.
    const tmpDir = await mkTempDir("spine-admission");
    const contextDirectory = join(tmpDir, "ctx");
    await mkdir(contextDirectory, { recursive: true });

    const fixture = normalizeReviewFixture({
      workingDirectory: tmpDir,
      contextDirectory,
      config: {
        // Force lite tier budget to our tiny test budget.
        patchBudgets: { lite: budget },
      },
      metadata: SHARED_METADATA,
      diff: {
        // 2 files × 30 additions each → lite tier (> 25 lines, ≤ 500 lines)
        files: [
          {
            path: "src/small.ts",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: smallPatch,
          },
          {
            path: "src/large.ts",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: largePatch,
          },
        ],
        totalAdditions: 60,
        totalDeletions: 0,
        truncated: false,
      },
    });

    const traceSink = new RecordingTraceSink();

    // Should NOT throw even though large.ts was demoted.
    const result = await runReview({
      fixture,
      traceSink,
      now: new Date("2026-06-14T00:00:00.000Z"),
    });

    // (a) context.built trace has admission block.
    const contextBuilt = traceSink.events.find((e) => e.type === "context.built");
    expect(contextBuilt).toBeDefined();

    const admission = contextBuilt?.data?.admission as
      | {
          budgetBytes: number;
          originalBytes: number;
          admittedBytes: number;
          admittedFileCount: number;
          demotedFileCount: number;
          degraded: boolean;
        }
      | undefined;

    expect(admission).toBeDefined();
    expect(admission?.degraded).toBe(true);
    expect(admission?.demotedFileCount).toBe(1);
    expect(admission?.admittedFileCount).toBe(1);
    expect(admission?.budgetBytes).toBe(budget);
    // admittedBytes should equal smallBytes (the small patch)
    expect(admission?.admittedBytes).toBe(smallBytes);
    // originalBytes should equal smallBytes + largeBytes
    expect(admission?.originalBytes).toBe(smallBytes + largeBytes);

    // (b) Demoted file (large.ts) has NO patch written; patch dir should have only small.ts.
    const patchDir = join(contextDirectory, "patches");
    let patchFiles: string[];
    try {
      const { readdir } = await import("node:fs/promises");
      patchFiles = await readdir(patchDir);
    } catch {
      patchFiles = [];
    }
    // Only 1 patch file (for small.ts). large.ts was demoted.
    expect(patchFiles).toHaveLength(1);
    // The patch filename contains the ordinal and path hint.
    expect(patchFiles[0]).toMatch(/small/);

    // (c) change-context.json contains overflowFiles for large.ts.
    const changeContextJson = await readFile(join(contextDirectory, "change-context.json"), "utf8");
    const changeContext = JSON.parse(changeContextJson) as {
      overflowFiles?: { path: string; additions: number; deletions: number }[];
    };
    expect(changeContext.overflowFiles).toBeDefined();
    expect(changeContext.overflowFiles).toHaveLength(1);
    expect(changeContext.overflowFiles?.[0]?.path).toBe("src/large.ts");
    expect(changeContext.overflowFiles?.[0]?.additions).toBe(30);

    // (d) result.summary.partialBySize is set with correct counts.
    const { partialBySize } = result.summary;
    expect(partialBySize).toBeDefined();
    expect(partialBySize?.admittedFileCount).toBe(1);
    expect(partialBySize?.droppedFileCount).toBe(1);
    expect(partialBySize?.droppedPaths).toEqual(["src/large.ts"]);
    expect(partialBySize?.budgetBytes).toBe(budget);
    expect(partialBySize?.admittedBytes).toBe(smallBytes);
    expect(partialBySize?.originalBytes).toBe(smallBytes + largeBytes);

    // (e) Run did NOT hard-fail (we got here — summary decision is set).
    expect(result.summary.decision).toBeDefined();
  });

  test("under-budget run: partialBySize is undefined, context.built admission.degraded=false", async () => {
    const smallPatch = makePatch(50);

    const tmpDir = await mkTempDir("spine-no-admission");
    const contextDirectory = join(tmpDir, "ctx");
    await mkdir(contextDirectory, { recursive: true });

    const fixture = normalizeReviewFixture({
      workingDirectory: tmpDir,
      contextDirectory,
      metadata: SHARED_METADATA,
      diff: {
        files: [
          {
            path: "src/small.ts",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: smallPatch,
          },
          {
            path: "src/small2.ts",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: smallPatch,
          },
        ],
        totalAdditions: 60,
        totalDeletions: 0,
        truncated: false,
      },
    });

    const traceSink = new RecordingTraceSink();

    const result = await runReview({
      fixture,
      traceSink,
      now: new Date("2026-06-14T00:00:01.000Z"),
    });

    // partialBySize must be undefined (no degradation).
    expect(result.summary.partialBySize).toBeUndefined();

    // context.built admission block must show degraded=false.
    const contextBuilt = traceSink.events.find((e) => e.type === "context.built");
    const admission = contextBuilt?.data?.admission as { degraded: boolean } | undefined;
    expect(admission?.degraded).toBe(false);
  });

  test("config patchBudgets override wins over tier-profile default", async () => {
    // Use an enormous budget to guarantee no degradation.
    const smallPatch = makePatch(50);

    const tmpDir = await mkTempDir("spine-budget-override");
    const contextDirectory = join(tmpDir, "ctx");
    await mkdir(contextDirectory, { recursive: true });

    const fixture = normalizeReviewFixture({
      workingDirectory: tmpDir,
      contextDirectory,
      config: {
        // Explicitly set a huge lite budget — tier-profile default (512_000) is also fine,
        // but we test that config override propagates correctly by using a known value.
        patchBudgets: { lite: 10_000_000 },
      },
      metadata: SHARED_METADATA,
      diff: {
        files: [
          {
            path: "src/a.ts",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: smallPatch,
          },
          {
            path: "src/b.ts",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: smallPatch,
          },
        ],
        totalAdditions: 60,
        totalDeletions: 0,
        truncated: false,
      },
    });

    const traceSink = new RecordingTraceSink();

    const result = await runReview({
      fixture,
      traceSink,
      now: new Date("2026-06-14T00:00:02.000Z"),
    });

    // No degradation: both files under the 10MB budget.
    expect(result.summary.partialBySize).toBeUndefined();

    const contextBuilt = traceSink.events.find((e) => e.type === "context.built");
    const admission = contextBuilt?.data?.admission as
      | { budgetBytes: number; degraded: boolean }
      | undefined;
    expect(admission?.budgetBytes).toBe(10_000_000);
    expect(admission?.degraded).toBe(false);
    expect(admission?.budgetBytes).not.toBe(512_000); // confirms override was used, not tier-profile
  });
});

// ---------------------------------------------------------------------------
// #218 repro class: large fixture-heavy diff — signal-aware admission integration
// ---------------------------------------------------------------------------

describe("patch-admission spine — signal-aware ranking (#218)", () => {
  test("#218 repro class: logic file admitted, fixture-heavy bulk demoted when diff exceeds budget", async () => {
    // Simulate the #218 repro: a diff dominated by fixture/snapshot data files,
    // with one signal-bearing logic file. The total exceeds a small budget.
    //
    // BEFORE #218: smallest-first ranking would admit the tiny fixture data files and demote
    // the larger logic file (starvation). AFTER #218: signal-first ranking ensures logic is
    // admitted; low-signal bulk is demoted preferentially.
    //
    // File layout:
    //   src/runner/logic.ts          — signal-bearing, 200 bytes (logic, must be admitted)
    //   examples/fixtures/big1.json  — low-signal, 600 bytes
    //   examples/fixtures/big2.json  — low-signal, 600 bytes
    //   test/__snapshots__/snap.snap — low-signal, 400 bytes
    //
    // Total: 1800 bytes. Budget: 400 bytes (fits logic.ts but not any fixture).
    //
    // Before #218 (smallest-first): logic.ts(200) admitted, then big1.json would push to 800>400.
    // After #218 (signal-first): logic.ts(200, false) ranks first → admitted; then fixtures demoted.
    //
    // Note: actually smallest-first would ALSO admit logic.ts(200) since it's the smallest,
    // then reject big1(600). The true repro class is when fixtures are SMALLER than logic:
    //
    // Repro-class scenario (fixtures are smaller than logic):
    //   src/runner/auth-middleware.ts — signal-bearing, 800 bytes (the only logic change)
    //   examples/fixtures/pr1.json    — low-signal, 200 bytes
    //   examples/fixtures/pr2.json    — low-signal, 200 bytes
    //   examples/fixtures/pr3.json    — low-signal, 200 bytes
    //
    // Total: 1400 bytes. Budget: 700 bytes.
    // Before #218: fixtures(200 each) admitted first (3×200=600≤700), auth-middleware(800) → 1400>700 DEMOTED.
    // After  #218: auth-middleware(800, false) ranks first → admitted(800>700? No: 800>700 means even this fails).
    // Let's set budget=900: auth-middleware(800)≤900, admitted. Then pr1.json: 800+200=1000>900, demoted.
    //
    // Budget: 900. auth-middleware(800, signal-bearing) + 3 fixtures × 200 (low-signal) = 1400 total.
    // Before: pr1(200)+pr2(200)+pr3(200)=600≤900; auth-middleware(800): 600+800=1400>900 → DEMOTED.
    // After:  auth-middleware(800): 800≤900, admitted. pr1(200): 800+200=1000>900, demoted.

    const logicPatch = makePatch(800);
    const fixturePatch = makePatch(200);
    const logicBytes = patchByteLength(logicPatch);
    const fixtureBytes = patchByteLength(fixturePatch);

    // Sanity: confirm the before/after divergence holds
    // Before: 3 fixtures (200 each = 600) fit, then logic (800): 600+800=1400>900 → demoted
    // After: logic (800) admitted first, then fixture1 (200): 800+200=1000>900 → demoted
    const budget = 900;
    const totalBytes = logicBytes + fixtureBytes * 3;
    expect(totalBytes).toBeGreaterThan(budget); // confirms over-budget path is taken

    const tmpDir = await mkTempDir("spine-218-signal");
    const contextDirectory = join(tmpDir, "ctx");
    await mkdir(contextDirectory, { recursive: true });

    const fixture = normalizeReviewFixture({
      workingDirectory: tmpDir,
      contextDirectory,
      config: {
        // Force lite tier budget to our test budget (2 logic + 3 fixture files → lite tier)
        patchBudgets: { lite: budget },
      },
      metadata: SHARED_METADATA,
      diff: {
        // 5 files × ~25 additions → lite tier
        files: [
          {
            path: "src/runner/auth-middleware.ts",
            status: "modified",
            additions: 25,
            deletions: 0,
            isBinary: false,
            patch: logicPatch,
          },
          {
            path: "examples/fixtures/pr1.json",
            status: "modified",
            additions: 25,
            deletions: 0,
            isBinary: false,
            patch: fixturePatch,
          },
          {
            path: "examples/fixtures/pr2.json",
            status: "modified",
            additions: 25,
            deletions: 0,
            isBinary: false,
            patch: fixturePatch,
          },
          {
            path: "examples/fixtures/pr3.json",
            status: "modified",
            additions: 25,
            deletions: 0,
            isBinary: false,
            patch: fixturePatch,
          },
        ],
        totalAdditions: 100,
        totalDeletions: 0,
        truncated: false,
      },
    });

    const traceSink = new RecordingTraceSink();

    const result = await runReview({
      fixture,
      traceSink,
      now: new Date("2026-06-14T12:00:00.000Z"),
    });

    // (a) Logic file is admitted — patch written to disk.
    const patchDir = join(contextDirectory, "patches");
    const { readdir } = await import("node:fs/promises");
    const patchFiles = await readdir(patchDir);
    // Only auth-middleware.ts should have a patch file (it's the only admitted file).
    expect(patchFiles).toHaveLength(1);
    expect(patchFiles[0]).toMatch(/auth-middleware/);

    // (b) Fixture files are demoted — in overflowFiles.
    const changeContextJson = await readFile(join(contextDirectory, "change-context.json"), "utf8");
    const changeContext = JSON.parse(changeContextJson) as {
      overflowFiles?: { path: string }[];
    };
    expect(changeContext.overflowFiles).toBeDefined();
    expect(changeContext.overflowFiles?.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "examples/fixtures/pr1.json",
        "examples/fixtures/pr2.json",
        "examples/fixtures/pr3.json",
      ]),
    );
    expect(changeContext.overflowFiles).toHaveLength(3);

    // (c) Admission trace has correct counts.
    const contextBuilt = traceSink.events.find((e) => e.type === "context.built");
    const admission = contextBuilt?.data?.admission as
      | {
          degraded: boolean;
          admittedFileCount: number;
          demotedFileCount: number;
          lowSignalDemotedFileCount: number;
        }
      | undefined;

    expect(admission).toBeDefined();
    expect(admission?.degraded).toBe(true);
    expect(admission?.admittedFileCount).toBe(1); // auth-middleware.ts
    expect(admission?.demotedFileCount).toBe(3); // 3 fixture files
    expect(admission?.lowSignalDemotedFileCount).toBe(3); // all 3 demoted are low-signal

    // (d) partialBySize is set (degraded run).
    expect(result.summary.partialBySize).toBeDefined();
    expect(result.summary.partialBySize?.droppedFileCount).toBe(3);

    // (e) Run did NOT hard-fail.
    expect(result.summary.decision).toBeDefined();
  });

  test("#218 fast path: under budget with low-signal files — lowSignalDemotedFileCount=0", async () => {
    // Confirms the fast path sets lowSignalDemotedFileCount=0 and doesn't touch lowSignal.
    const smallPatch = makePatch(50);

    const tmpDir = await mkTempDir("spine-218-fast-path");
    const contextDirectory = join(tmpDir, "ctx");
    await mkdir(contextDirectory, { recursive: true });

    const fixture = normalizeReviewFixture({
      workingDirectory: tmpDir,
      contextDirectory,
      metadata: SHARED_METADATA,
      diff: {
        files: [
          {
            path: "src/logic.ts",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: smallPatch,
          },
          {
            path: "examples/fixtures/data.json",
            status: "modified",
            additions: 30,
            deletions: 0,
            isBinary: false,
            patch: smallPatch,
          },
        ],
        totalAdditions: 60,
        totalDeletions: 0,
        truncated: false,
      },
    });

    const traceSink = new RecordingTraceSink();

    await runReview({
      fixture,
      traceSink,
      now: new Date("2026-06-14T12:00:01.000Z"),
    });

    const contextBuilt = traceSink.events.find((e) => e.type === "context.built");
    const admission = contextBuilt?.data?.admission as
      | { degraded: boolean; lowSignalDemotedFileCount: number }
      | undefined;

    expect(admission?.degraded).toBe(false);
    expect(admission?.lowSignalDemotedFileCount).toBe(0);
  });

  test("#218 sensitivePaths guard: a sensitive file matching a low-signal pattern is NEVER demoted (AI-review #232)", async () => {
    // Trust-boundary regression: a file under an operator-configured sensitivePaths glob that ALSO
    // matches a low-signal pattern (fixtures/ + .json) must NOT be demoted preferentially. The
    // sensitive file (800B, larger) competes against a non-sensitive low-signal bulk file (200B,
    // smaller) under a budget that fits only one.
    //   WITHOUT the guard: both are low-signal → smallest-first admits the 200B bulk, demotes the
    //                      800B sensitive file (the regression).
    //   WITH the guard:    sensitive file is signal-bearing → admitted; bulk demoted.
    const sensitivePatch = makePatch(800);
    const bulkPatch = makePatch(200);
    const sensitiveBytes = patchByteLength(sensitivePatch);
    const budget = sensitiveBytes + 1; // fits the sensitive file alone, not also the bulk file

    const tmpDir = await mkTempDir("spine-218-sensitive");
    const contextDirectory = join(tmpDir, "ctx");
    await mkdir(contextDirectory, { recursive: true });

    const fixture = normalizeReviewFixture({
      workingDirectory: tmpDir,
      contextDirectory,
      config: {
        // sensitivePaths escalates the risk tier (likely full), so set the budget across tiers to
        // be robust to whichever tier the classifier picks.
        patchBudgets: { trivial: budget, lite: budget, full: budget },
        sensitivePaths: ["src/auth/**"],
      },
      metadata: SHARED_METADATA,
      diff: {
        files: [
          {
            // matches sensitivePaths AND the low-signal classifier (fixtures/ + .json)
            path: "src/auth/fixtures/rbac-policy.json",
            status: "modified",
            additions: 25,
            deletions: 0,
            isBinary: false,
            patch: sensitivePatch,
          },
          {
            // low-signal, not sensitive
            path: "examples/fixtures/bulk.json",
            status: "modified",
            additions: 25,
            deletions: 0,
            isBinary: false,
            patch: bulkPatch,
          },
        ],
        totalAdditions: 50,
        totalDeletions: 0,
        truncated: false,
      },
    });

    const traceSink = new RecordingTraceSink();
    const result = await runReview({
      fixture,
      traceSink,
      now: new Date("2026-06-14T12:00:02.000Z"),
    });

    // The sensitive file is admitted — its patch is written, despite being larger and matching a
    // low-signal pattern.
    const { readdir } = await import("node:fs/promises");
    const patchFiles = await readdir(join(contextDirectory, "patches"));
    expect(patchFiles).toHaveLength(1);
    expect(patchFiles[0]).toMatch(/rbac-policy/);

    // The non-sensitive low-signal bulk file is the one demoted.
    const changeContext = JSON.parse(
      await readFile(join(contextDirectory, "change-context.json"), "utf8"),
    ) as { overflowFiles?: { path: string }[] };
    expect(changeContext.overflowFiles?.map((f) => f.path)).toEqual([
      "examples/fixtures/bulk.json",
    ]);

    const contextBuilt = traceSink.events.find((e) => e.type === "context.built");
    const admission = contextBuilt?.data?.admission as
      | { admittedFileCount: number; demotedFileCount: number; lowSignalDemotedFileCount: number }
      | undefined;
    expect(admission?.admittedFileCount).toBe(1);
    expect(admission?.demotedFileCount).toBe(1);
    // The sensitive file was NOT counted as low-signal; only the bulk file was.
    expect(admission?.lowSignalDemotedFileCount).toBe(1);
    expect(result.summary.decision).toBeDefined();
  });
});

async function mkTempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), `acrf-test-${prefix}-`));
}
