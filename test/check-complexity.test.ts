import { describe, expect, it } from "bun:test";
import { compareToBaseline, parseDiagnostics } from "../scripts/check-complexity.ts";

// ─── parseDiagnostics ─────────────────────────────────────────────────────────

describe("parseDiagnostics", () => {
  it("groups by location.path and counts only the matching category", () => {
    const json = {
      diagnostics: [
        {
          category: "lint/complexity/noExcessiveCognitiveComplexity",
          location: { path: "src/runner/run-metrics.ts" },
          severity: "info",
        },
        {
          category: "lint/complexity/noExcessiveCognitiveComplexity",
          location: { path: "src/runner/run-metrics.ts" },
          severity: "info",
        },
        {
          category: "lint/complexity/noExcessiveCognitiveComplexity",
          location: { path: "src/cli.ts" },
          severity: "info",
        },
      ],
    };
    const result = parseDiagnostics(json);
    expect(result["src/runner/run-metrics.ts"]).toBe(2);
    expect(result["src/cli.ts"]).toBe(1);
  });

  it("ignores diagnostics with a different category", () => {
    const json = {
      diagnostics: [
        {
          category: "lint/complexity/noExcessiveCognitiveComplexity",
          location: { path: "src/foo.ts" },
          severity: "info",
        },
        {
          // Different rule — must be ignored
          category: "lint/style/noUnusedTemplateLiteral",
          location: { path: "src/foo.ts" },
          severity: "error",
        },
        {
          category: "lint/suspicious/noConsole",
          location: { path: "src/bar.ts" },
          severity: "error",
        },
      ],
    };
    const result = parseDiagnostics(json);
    expect(result["src/foo.ts"]).toBe(1);
    expect(result["src/bar.ts"]).toBeUndefined();
  });

  it("returns an empty record when there are no matching diagnostics", () => {
    const json = {
      diagnostics: [
        {
          category: "lint/style/noUnusedTemplateLiteral",
          location: { path: "src/foo.ts" },
          severity: "error",
        },
      ],
    };
    expect(parseDiagnostics(json)).toEqual({});
  });

  it("returns an empty record for empty diagnostics array", () => {
    expect(parseDiagnostics({ diagnostics: [] })).toEqual({});
  });
});

// ─── compareToBaseline ────────────────────────────────────────────────────────

describe("compareToBaseline", () => {
  it("reports no regressions when counts exactly match baseline", () => {
    const baseline = { "src/foo.ts": 2, "src/bar.ts": 1 };
    const current = { "src/foo.ts": 2, "src/bar.ts": 1 };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    expect(regressions).toHaveLength(0);
    expect(improvements).toHaveLength(0);
  });

  it("detects a regression when a file's count rises above its baseline", () => {
    const baseline = { "src/foo.ts": 2 };
    const current = { "src/foo.ts": 3 };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toEqual({ file: "src/foo.ts", from: 2, to: 3 });
    expect(improvements).toHaveLength(0);
  });

  it("treats a file absent from baseline with violations as a regression (from=0)", () => {
    const baseline: Record<string, number> = {};
    const current = { "src/new-file.ts": 1 };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toEqual({ file: "src/new-file.ts", from: 0, to: 1 });
    expect(improvements).toHaveLength(0);
  });

  it("recognises an improvement when a file's count falls below baseline", () => {
    const baseline = { "src/runner/run-metrics.ts": 6 };
    const current = { "src/runner/run-metrics.ts": 4 };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    expect(regressions).toHaveLength(0);
    expect(improvements).toHaveLength(1);
    expect(improvements[0]).toEqual({ file: "src/runner/run-metrics.ts", from: 6, to: 4 });
  });

  it("ignores a file that is only in the baseline (fully fixed)", () => {
    const baseline = { "src/fixed.ts": 3, "src/still-bad.ts": 2 };
    const current = { "src/still-bad.ts": 2 };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    // src/fixed.ts vanished from current — that is a good thing, not a regression
    expect(regressions).toHaveLength(0);
    expect(improvements).toHaveLength(0);
  });

  it("handles mixed regressions and improvements simultaneously", () => {
    const baseline = { "src/a.ts": 1, "src/b.ts": 5 };
    const current = { "src/a.ts": 3, "src/b.ts": 2 };
    const { regressions, improvements } = compareToBaseline(baseline, current);
    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toEqual({ file: "src/a.ts", from: 1, to: 3 });
    expect(improvements).toHaveLength(1);
    expect(improvements[0]).toEqual({ file: "src/b.ts", from: 5, to: 2 });
  });
});
