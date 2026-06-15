import { describe, expect, test } from "bun:test";
import { decidePatchAdmission } from "../src/runner/patch-admission.ts";

describe("decidePatchAdmission — pure unit tests (#145)", () => {
  // -------------------------------------------------------------------------
  // Under-budget: admit all
  // -------------------------------------------------------------------------

  test("under-budget: admits all files, degraded=false", () => {
    const result = decidePatchAdmission({
      files: [
        { path: "src/a.ts", patchBytes: 100 },
        { path: "src/b.ts", patchBytes: 200 },
      ],
      budgetBytes: 1000,
    });

    expect(result.degraded).toBe(false);
    expect(result.demotedPaths).toHaveLength(0);
    expect(result.admittedPaths.size).toBe(2);
    expect(result.admittedPaths.has("src/a.ts")).toBe(true);
    expect(result.admittedPaths.has("src/b.ts")).toBe(true);
    expect(result.originalBytes).toBe(300);
    expect(result.admittedBytes).toBe(300);
    expect(result.budgetBytes).toBe(1000);
  });

  test("exactly at budget: admits all, degraded=false", () => {
    const result = decidePatchAdmission({
      files: [
        { path: "src/a.ts", patchBytes: 500 },
        { path: "src/b.ts", patchBytes: 500 },
      ],
      budgetBytes: 1000,
    });

    expect(result.degraded).toBe(false);
    expect(result.admittedPaths.size).toBe(2);
    expect(result.originalBytes).toBe(1000);
    expect(result.admittedBytes).toBe(1000);
  });

  test("empty file list: admits nothing, degraded=false", () => {
    const result = decidePatchAdmission({
      files: [],
      budgetBytes: 1000,
    });

    expect(result.degraded).toBe(false);
    expect(result.admittedPaths.size).toBe(0);
    expect(result.demotedPaths).toHaveLength(0);
    expect(result.originalBytes).toBe(0);
    expect(result.admittedBytes).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Over-budget: smallest-first greedy admission
  // -------------------------------------------------------------------------

  test("over-budget: admits smallest files first, demotes largest", () => {
    // Budget: 300. Files: a=100, b=200, c=300, d=500.
    // Sorted ascending: a(100), b(200), c(300), d(500).
    // Admit a(100): running=100 ≤ 300. ✓
    // Admit b(200): running=300 ≤ 300. ✓
    // Admit c(300): running=600 > 300. ✗ — demoted.
    // d(500): demoted.
    const result = decidePatchAdmission({
      files: [
        { path: "src/d.ts", patchBytes: 500 },
        { path: "src/c.ts", patchBytes: 300 },
        { path: "src/a.ts", patchBytes: 100 },
        { path: "src/b.ts", patchBytes: 200 },
      ],
      budgetBytes: 300,
    });

    expect(result.degraded).toBe(true);
    expect(result.admittedPaths.has("src/a.ts")).toBe(true);
    expect(result.admittedPaths.has("src/b.ts")).toBe(true);
    expect(result.admittedPaths.has("src/c.ts")).toBe(false);
    expect(result.admittedPaths.has("src/d.ts")).toBe(false);
    expect(result.demotedPaths).toHaveLength(2);
    expect(result.originalBytes).toBe(1100);
    expect(result.admittedBytes).toBe(300);
    expect(result.budgetBytes).toBe(300);
  });

  test("over-budget: byte arithmetic is exact (no rounding)", () => {
    // Budget: 599. Files: a=300, b=300, c=1.
    // Sorted: c(1), a(300), b(300).
    // Admit c(1): running=1 ≤ 599. ✓
    // Admit a(300): running=301 ≤ 599. ✓
    // Admit b(300): running=601 > 599. ✗ — demoted.
    const result = decidePatchAdmission({
      files: [
        { path: "src/a.ts", patchBytes: 300 },
        { path: "src/b.ts", patchBytes: 300 },
        { path: "src/c.ts", patchBytes: 1 },
      ],
      budgetBytes: 599,
    });

    expect(result.degraded).toBe(true);
    expect(result.admittedPaths.has("src/a.ts")).toBe(true);
    expect(result.admittedPaths.has("src/c.ts")).toBe(true);
    expect(result.admittedPaths.has("src/b.ts")).toBe(false);
    expect(result.admittedBytes).toBe(301); // 1 + 300
    expect(result.originalBytes).toBe(601);
  });

  // -------------------------------------------------------------------------
  // Graceful floor: even the smallest file exceeds budget → demote all
  // -------------------------------------------------------------------------

  test("single-file over budget: demotes all (graceful floor, NOT a hard fail)", () => {
    const result = decidePatchAdmission({
      files: [{ path: "src/huge.ts", patchBytes: 1000 }],
      budgetBytes: 100,
    });

    expect(result.degraded).toBe(true);
    expect(result.admittedPaths.size).toBe(0);
    expect(result.demotedPaths).toEqual(["src/huge.ts"]);
    expect(result.admittedBytes).toBe(0);
    expect(result.originalBytes).toBe(1000);
  });

  test("all files over budget: demotes all, admits nothing", () => {
    const result = decidePatchAdmission({
      files: [
        { path: "src/a.ts", patchBytes: 500 },
        { path: "src/b.ts", patchBytes: 800 },
        { path: "src/c.ts", patchBytes: 200 },
      ],
      budgetBytes: 100,
    });

    expect(result.degraded).toBe(true);
    expect(result.admittedPaths.size).toBe(0);
    expect(result.demotedPaths).toHaveLength(3);
    expect(result.admittedBytes).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Deterministic tiebreak: equal patchBytes → sort by path ascending
  // -------------------------------------------------------------------------

  test("equal-size files: tiebreak by path ascending", () => {
    // Budget: 100. All files are 50 bytes. Sorted by path: a < b < c.
    // Admit a(50): running=50 ≤ 100. ✓
    // Admit b(50): running=100 ≤ 100. ✓
    // c(50): running=150 > 100. ✗ — demoted.
    const result = decidePatchAdmission({
      files: [
        { path: "src/c.ts", patchBytes: 50 },
        { path: "src/a.ts", patchBytes: 50 },
        { path: "src/b.ts", patchBytes: 50 },
      ],
      budgetBytes: 100,
    });

    expect(result.degraded).toBe(true);
    expect(result.admittedPaths.has("src/a.ts")).toBe(true);
    expect(result.admittedPaths.has("src/b.ts")).toBe(true);
    expect(result.admittedPaths.has("src/c.ts")).toBe(false);
    // Demoted in rank order (sorted: c comes after b which comes after a when
    // the first two fill the budget, so c is the only demoted entry).
    expect(result.demotedPaths).toEqual(["src/c.ts"]);
  });

  test("tiebreak: is deterministic — same input always yields same output", () => {
    const input = {
      files: [
        { path: "z/file.ts", patchBytes: 100 },
        { path: "a/file.ts", patchBytes: 100 },
        { path: "m/file.ts", patchBytes: 100 },
      ],
      budgetBytes: 200,
    };

    const r1 = decidePatchAdmission(input);
    const r2 = decidePatchAdmission(input);

    expect([...r1.admittedPaths].sort()).toEqual([...r2.admittedPaths].sort());
    expect(r1.demotedPaths).toEqual(r2.demotedPaths);
    // a and m should be admitted (alphabetically first), z demoted.
    expect(r1.admittedPaths.has("a/file.ts")).toBe(true);
    expect(r1.admittedPaths.has("m/file.ts")).toBe(true);
    expect(r1.admittedPaths.has("z/file.ts")).toBe(false);
    expect(r1.demotedPaths).toEqual(["z/file.ts"]);
  });

  // -------------------------------------------------------------------------
  // Budget boundary values
  // -------------------------------------------------------------------------

  test("budget of 0: demotes all files", () => {
    const result = decidePatchAdmission({
      files: [
        { path: "src/a.ts", patchBytes: 1 },
        { path: "src/b.ts", patchBytes: 100 },
      ],
      budgetBytes: 0,
    });

    expect(result.degraded).toBe(true);
    expect(result.admittedPaths.size).toBe(0);
    expect(result.demotedPaths).toHaveLength(2);
    expect(result.admittedBytes).toBe(0);
  });

  test("single-file exactly at budget: admitted, degraded=false", () => {
    const result = decidePatchAdmission({
      files: [{ path: "src/a.ts", patchBytes: 1000 }],
      budgetBytes: 1000,
    });

    expect(result.degraded).toBe(false);
    expect(result.admittedPaths.size).toBe(1);
    expect(result.admittedPaths.has("src/a.ts")).toBe(true);
    expect(result.admittedBytes).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Signal-aware ranking (#218, M021)
// ---------------------------------------------------------------------------

describe("decidePatchAdmission — signal-aware ranking (#218)", () => {
  test("over-budget: signal-bearing logic file admitted before smaller low-signal file", () => {
    // Key invariant: signal beats pure size.
    // logic.ts: 500 bytes, lowSignal=false (large but signal-bearing)
    // fixture.json: 100 bytes, lowSignal=true (small but low-signal)
    // Budget: 600 bytes (fits logic alone; both together = 600 so would fit, but let's
    // make it tighter — budget 550 so total 600 > 550 triggers over-budget path).
    //
    // Before #218 (smallest-first): fixture.json(100) admitted, logic.ts(500): 600 > 550 → demoted.
    // After #218 (signal-first): logic.ts admitted first (600>550 but 500<=550), fixture demoted.
    const result = decidePatchAdmission({
      files: [
        { path: "test/fixtures/data.json", patchBytes: 100, lowSignal: true },
        { path: "src/runner/logic.ts", patchBytes: 500, lowSignal: false },
      ],
      budgetBytes: 550,
    });

    expect(result.degraded).toBe(true);
    // Signal-bearing logic file MUST be admitted even though it's larger.
    expect(result.admittedPaths.has("src/runner/logic.ts")).toBe(true);
    // Low-signal fixture MUST be demoted (preferentially, even though it's smaller).
    expect(result.admittedPaths.has("test/fixtures/data.json")).toBe(false);
    expect(result.demotedPaths).toContain("test/fixtures/data.json");
    expect(result.admittedBytes).toBe(500);
    expect(result.originalBytes).toBe(600);
  });

  test("lowSignalDemotedFileCount counts correctly", () => {
    // 2 low-signal + 1 signal-bearing. Budget admits the logic file + one small low-signal.
    const result = decidePatchAdmission({
      files: [
        { path: "src/app.ts", patchBytes: 200, lowSignal: false },
        { path: "test/fixtures/a.json", patchBytes: 50, lowSignal: true },
        { path: "test/fixtures/b.json", patchBytes: 400, lowSignal: true },
      ],
      budgetBytes: 300, // admits app.ts(200) + a.json(50)=250 ≤ 300; b.json(400) demoted
    });

    expect(result.degraded).toBe(true);
    expect(result.admittedPaths.has("src/app.ts")).toBe(true);
    expect(result.admittedPaths.has("test/fixtures/a.json")).toBe(true);
    expect(result.admittedPaths.has("test/fixtures/b.json")).toBe(false);
    expect(result.lowSignalDemotedFileCount).toBe(1); // only b.json was demoted + lowSignal
  });

  test("lowSignalDemotedFileCount=0 on fast path (under budget)", () => {
    const result = decidePatchAdmission({
      files: [
        { path: "src/a.ts", patchBytes: 100, lowSignal: false },
        { path: "test/fixtures/data.json", patchBytes: 200, lowSignal: true },
      ],
      budgetBytes: 1000,
    });

    expect(result.degraded).toBe(false);
    expect(result.lowSignalDemotedFileCount).toBe(0);
    expect(result.admittedPaths.size).toBe(2);
  });

  test("all files low-signal: still admits smallest first (size tiebreak within low-signal group)", () => {
    // When all are low-signal, the secondary sort (patchBytes asc) still applies.
    const result = decidePatchAdmission({
      files: [
        { path: "test/fixtures/big.json", patchBytes: 800, lowSignal: true },
        { path: "test/fixtures/small.json", patchBytes: 100, lowSignal: true },
        { path: "test/fixtures/mid.json", patchBytes: 300, lowSignal: true },
      ],
      budgetBytes: 450,
    });

    expect(result.degraded).toBe(true);
    // small(100) + mid(300) = 400 ≤ 450: admitted
    expect(result.admittedPaths.has("test/fixtures/small.json")).toBe(true);
    expect(result.admittedPaths.has("test/fixtures/mid.json")).toBe(true);
    // big(800): 400+800 > 450: demoted
    expect(result.admittedPaths.has("test/fixtures/big.json")).toBe(false);
    expect(result.lowSignalDemotedFileCount).toBe(1);
  });

  test("determinism: same input always yields same output with signal flags", () => {
    const input = {
      files: [
        { path: "z/logic.ts", patchBytes: 100, lowSignal: false },
        { path: "a/fixture.json", patchBytes: 100, lowSignal: true },
        { path: "m/fixture.json", patchBytes: 100, lowSignal: true },
      ],
      budgetBytes: 150,
    };

    const r1 = decidePatchAdmission(input);
    const r2 = decidePatchAdmission(input);

    expect([...r1.admittedPaths].sort()).toEqual([...r2.admittedPaths].sort());
    expect(r1.demotedPaths).toEqual(r2.demotedPaths);
    expect(r1.lowSignalDemotedFileCount).toBe(r2.lowSignalDemotedFileCount);
    // logic.ts (signal-bearing) must be admitted; one fixture admitted (tiebreak: a < m < z)
    expect(r1.admittedPaths.has("z/logic.ts")).toBe(true);
    expect(r1.admittedPaths.has("a/fixture.json")).toBe(false); // 100+100=200 > 150
    // Actually: signal-first. logic.ts(100, false) sorts before fixtures (true).
    // After logic.ts: 100 bytes used. Budget left: 50. a/fixture.json(100) > 50 → demoted.
    // m/fixture.json(100) > 50 → demoted.
    expect(r1.admittedPaths.size).toBe(1);
    expect(r1.admittedPaths.has("z/logic.ts")).toBe(true);
    expect(r1.lowSignalDemotedFileCount).toBe(2);
  });

  test("mixed: no lowSignal field (undefined) treated as signal-bearing (false)", () => {
    // Files without lowSignal should rank before files with lowSignal=true.
    const result = decidePatchAdmission({
      files: [
        { path: "test/fixtures/big.json", patchBytes: 500, lowSignal: true },
        { path: "src/no-flag.ts", patchBytes: 300 }, // no lowSignal field
      ],
      budgetBytes: 400,
    });

    expect(result.degraded).toBe(true);
    // no-flag.ts (undefined → treated as false) ranks first → admitted (300 ≤ 400)
    expect(result.admittedPaths.has("src/no-flag.ts")).toBe(true);
    // big.json demoted (300+500 > 400)
    expect(result.admittedPaths.has("test/fixtures/big.json")).toBe(false);
    expect(result.lowSignalDemotedFileCount).toBe(1);
  });
});
