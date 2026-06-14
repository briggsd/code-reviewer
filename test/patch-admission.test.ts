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
