import { describe, expect, test } from "bun:test";
import { checkRetentionDays } from "../scripts/check-workflows.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Minimal workflow YAML fixture builder.  Wraps a `steps:` block in enough
 * context that the indent structure is realistic (jobs → steps → step keys).
 */
function wrapSteps(steps: string): string {
  return `on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${steps}`;
}

// ─── block-style with: (name:-then-uses: form) ────────────────────────────────

describe("checkRetentionDays — block-style with: (name: then uses: form)", () => {
  test("passes when retention-days is present", () => {
    const content = wrapSteps(`
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: my-artifact
          path: dist
          retention-days: 7
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(0);
  });

  test("flags a violation when retention-days is absent", () => {
    const content = wrapSteps(`
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: my-artifact
          path: dist
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.stepName).toBe("Upload artifact");
  });
});

// ─── block-style with: (- uses: list-item opener form) ───────────────────────

describe("checkRetentionDays — block-style with: (- uses: opener form)", () => {
  test("passes when retention-days is present", () => {
    const content = wrapSteps(`
      - uses: actions/upload-artifact@v4
        with:
          name: my-artifact
          path: dist
          retention-days: 14
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(0);
  });

  test("flags a violation when retention-days is absent", () => {
    const content = wrapSteps(`
      - uses: actions/upload-artifact@v4
        with:
          name: my-artifact
          path: dist
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.stepName).toBe("(unnamed step)");
  });
});

// ─── inline-flow with: form (Finding 1 regression) ───────────────────────────

describe("checkRetentionDays — inline-flow with: { ... } form", () => {
  test("passes when retention-days is present in inline braces", () => {
    const content = wrapSteps(`
      - name: Upload inline
        uses: actions/upload-artifact@v4
        with: { name: my-artifact, path: dist, retention-days: 7 }
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(0);
  });

  test("flags a violation when retention-days is absent from inline braces", () => {
    const content = wrapSteps(`
      - name: Upload inline missing
        uses: actions/upload-artifact@v4
        with: { name: my-artifact, path: dist }
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.stepName).toBe("Upload inline missing");
  });

  test("passes when retention-days appears first in inline braces", () => {
    const content = wrapSteps(`
      - name: Upload inline first
        uses: actions/upload-artifact@v4
        with: { retention-days: 3, name: my-artifact, path: dist }
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(0);
  });
});

// ─── multiple steps in the same workflow ──────────────────────────────────────

describe("checkRetentionDays — multiple upload-artifact steps", () => {
  test("reports only steps missing retention-days", () => {
    const content = wrapSteps(`
      - name: Upload with retention
        uses: actions/upload-artifact@v4
        with:
          path: dist
          retention-days: 7
      - name: Upload without retention
        uses: actions/upload-artifact@v4
        with:
          path: logs
      - name: Upload inline with retention
        uses: actions/upload-artifact@v4
        with: { path: reports, retention-days: 5 }
      - name: Upload inline without retention
        uses: actions/upload-artifact@v4
        with: { path: extras }
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(2);
    const names = violations.map((v) => v.stepName);
    expect(names).toContain("Upload without retention");
    expect(names).toContain("Upload inline without retention");
  });
});

// ─── non-upload-artifact uses: steps are ignored ─────────────────────────────

describe("checkRetentionDays — other uses: steps are not checked", () => {
  test("ignores steps that are not actions/upload-artifact", () => {
    const content = wrapSteps(`
      - name: Checkout
        uses: actions/checkout@v4
      - name: Setup bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.0
`);
    const violations = checkRetentionDays("test.yml", content);
    expect(violations).toHaveLength(0);
  });
});
