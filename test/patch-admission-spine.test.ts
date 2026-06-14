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

async function mkTempDir(prefix: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(join(tmpdir(), `acrf-test-${prefix}-`));
}
