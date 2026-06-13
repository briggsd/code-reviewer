import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

// Guards the #27 architecture-boundary lint wiring. The rules themselves are exercised by
// `bun run boundaries` (blocking in CI); this test locks the wiring so the step can't be
// silently dropped or made advisory.
describe("architecture-boundary lint (#27)", () => {
  test("dependency-cruiser config declares the load-bearing rules with remediation messages", async () => {
    const config = requireCjs("../.dependency-cruiser.cjs") as {
      forbidden: Array<{ name: string; severity: string; comment: string }>;
      required: Array<{ name: string; severity: string; comment: string }>;
    };
    const { forbidden, required } = config;

    const forbiddenNames = forbidden.map((rule) => rule.name);
    expect(forbiddenNames).toContain("runner-no-concrete-adapters");
    expect(forbiddenNames).toContain("contracts-stay-pure");
    expect(forbiddenNames).toContain("no-cross-vcs-coupling");
    expect(forbiddenNames).toContain("no-cross-vcs-coupling-reverse");
    expect(forbiddenNames).toContain("no-circular");
    expect(required.map((rule) => rule.name)).toContain("pi-runtime-routes-prompt-boundary");

    // A dependency-cruiser `required` rule passes VACUOUSLY when no module matches its
    // `module.path` — renaming/deleting reviewer-prompt.ts would silently vacate the
    // sanitization invariant. Pin the guarded module's existence so a rename fails here.
    expect(existsSync("src/runtime/reviewer-prompt.ts")).toBe(true);
    expect(existsSync("src/runtime/prompt-boundary.ts")).toBe(true);

    // Remediation-in-error-message is the point of #27 — every rule must explain the fix.
    for (const rule of [...forbidden, ...required]) {
      expect(rule.severity).toBe("error");
      expect(rule.comment.length).toBeGreaterThan(40);
    }
  });

  test("CI runs the boundaries step as blocking in the check job", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(workflow).toContain("bun run boundaries");
    // The boundaries step must stay blocking: it belongs to the check job, where no step
    // carries continue-on-error (that marker is exclusive to the advisory quality job).
    // Anchor on the indented job-key form so a stray "check:"/"quality:" inside a step
    // name or comment can't shift the slice.
    const checkJobStart = workflow.indexOf("\n  check:\n");
    const qualityJobStart = workflow.indexOf("\n  quality:\n");
    expect(checkJobStart).toBeGreaterThan(-1);
    expect(qualityJobStart).toBeGreaterThan(checkJobStart);
    const checkJob = workflow.slice(checkJobStart, qualityJobStart);
    expect(checkJob).toContain("bun run boundaries");
    expect(checkJob).not.toContain("continue-on-error");
  });

  test("package.json exposes the boundaries script", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.boundaries).toBe("depcruise src --config .dependency-cruiser.cjs");
  });
});
