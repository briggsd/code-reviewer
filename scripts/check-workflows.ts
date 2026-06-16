#!/usr/bin/env bun

/**
 * Workflow hygiene gate — deterministic checks on .github/workflows/*.yml.
 *
 * Currently enforces:
 *   - Every `actions/upload-artifact` step must set `retention-days`.
 *     PII / diff content MUST NOT persist indefinitely; an explicit retention
 *     cap forces a deliberate policy decision on each artifact.
 *
 *   bun run workflows:check    # blocking: missing retention-days → exit 1
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── util ────────────────────────────────────────────────────────────────────

const repoRoot = (() => {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    throw new Error(`not inside a git repository: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
})();

function readWorkflowFiles(): { file: string; content: string }[] {
  const result = Bun.spawnSync(["git", "ls-files", "--", ".github/workflows/*.yml"], {
    cwd: repoRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  }
  const paths = result.stdout.toString().trim().split("\n").filter(Boolean);
  return paths.map((rel) => ({
    file: rel,
    content: readFileSync(join(repoRoot, rel), "utf8"),
  }));
}

// ─── rule: upload-artifact must have retention-days ──────────────────────────

export interface Violation {
  file: string;
  stepName: string;
  lineNumber: number;
}

/**
 * Parse YAML line-by-line to find `actions/upload-artifact` steps that lack a
 * `retention-days` key anywhere in the same `with:` block.
 *
 * Approach: scan for lines matching `uses: actions/upload-artifact@...`, then
 * look forward for a `with:` block, collecting lines until the block ends
 * (a non-indented or peer-level line). Flag the step if `retention-days:` is
 * absent from that block.
 *
 * This is a line-scan heuristic, not a full YAML parser. It handles:
 *   - Block-style `with:` (key on its own line, values indented below)
 *   - Inline-flow `with:` (e.g. `with: { retention-days: 7, path: dist }`)
 *   - Both `- uses:` list-item opener steps and `name:`-then-`uses:` steps
 *
 * `stepIndent` is normalised to the YAML key column (the position of the `u`
 * in `uses:`), not the leading-whitespace column, so that `with:` and
 * value-depth comparisons are always relative to the correct reference column
 * regardless of whether the step uses the `- uses:` or `name:`/`uses:` form.
 */
export function checkRetentionDays(file: string, content: string): Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    // Detect `uses: actions/upload-artifact@<sha>`
    if (!/uses:\s*actions\/upload-artifact@/.test(line)) {
      continue;
    }

    // Finding 2 fix: normalise stepIndent to the YAML KEY column, not the
    // leading-whitespace column. For a `- uses:` opener the leading whitespace
    // is before the `- ` marker; the key (`u` of `uses:`) sits further right.
    // indexOf("uses:") gives the true key column directly.
    const usesOffset = line.indexOf("uses:");
    const stepIndent =
      usesOffset >= 0 ? usesOffset : ((line.match(/^(\s*)/) ?? ["", ""])[1] ?? "").length;

    // Capture the step name by looking backwards for a `name:` key at the same
    // indentation level as `uses:` (sibling step key), stopping when we leave
    // the step block (deeper indent or the dash-prefixed step entry line itself).
    let stepName = "(unnamed step)";
    // Track whether we have already crossed the current step's own `- ` opener so
    // that a second `- ` signals the PREVIOUS step and we can stop without adopting
    // its name.
    let crossedCurrentStepMarker = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j] ?? "";
      if (prev.trim() === "") continue;
      // Use the key column for `name:` comparisons too (indexOf gives the `n` of `name:`).
      const prevNameOffset = prev.indexOf("name:");
      const prevKeyCol =
        prevNameOffset >= 0 ? prevNameOffset : ((prev.match(/^(\s*)/) ?? ["", ""])[1] ?? "").length;
      // Stop if we step out of the step (shallower than step keys, e.g. job-level key)
      if (prevKeyCol < stepIndent) break;
      // `name:` at the same level as `uses:` — this is the step name
      if (prevKeyCol === stepIndent) {
        const nameMatch = /^\s*(?:-\s+)?name:\s*(.+)/.exec(prev);
        if (nameMatch?.[1] !== undefined) {
          stepName = nameMatch[1].trim();
          break;
        }
      }
      // Detect list-item `- ` markers (a step opener at the list level).
      // The first one we encounter going backward is the current step's own opener;
      // a second one belongs to the previous step — stop to avoid adopting its name.
      if (/^\s*-\s/.test(prev)) {
        if (crossedCurrentStepMarker) {
          // We've crossed into the previous step — leave stepName as "(unnamed step)"
          break;
        }
        crossedCurrentStepMarker = true;
      }
    }

    // Scan forward for the `with:` block, then look for `retention-days:`.
    // In GitHub Actions YAML, step keys (uses:, with:, if:, name:) are all at
    // the same indent level as `uses:`. The `with:` values are one level deeper.
    let inWith = false;
    let foundRetentionDays = false;

    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? "";
      if (next.trim() === "") continue; // skip blank lines

      // Key column for this line (same normalisation as stepIndent).
      const nextKeyOffset = next.indexOf("with:");
      const nextIndent =
        nextKeyOffset >= 0 ? nextKeyOffset : ((next.match(/^(\s*)/) ?? ["", ""])[1] ?? "").length;

      if (!inWith) {
        // Finding 1 fix: also handle inline-flow `with: { ... }` on a single line.
        // When `with:` is followed by `{...}` on the same line, check the braces
        // directly for `retention-days` and do not enter block-scan mode.
        const inlineWithMatch = /^\s*with:\s*\{([^}]*)\}/.exec(next);
        if (inlineWithMatch !== null && nextIndent === stepIndent) {
          // Inline-flow form: check the brace content for retention-days.
          if (/retention-days/.test(inlineWithMatch[1] ?? "")) {
            foundRetentionDays = true;
          }
          // Whether found or not, the `with:` has been handled — stop scanning.
          break;
        }

        // Block-style `with:` on its own line (nothing after the colon but whitespace)
        if (/^\s*with:\s*$/.test(next) && nextIndent === stepIndent) {
          inWith = true;
        } else if (nextIndent < stepIndent) {
          // Moved past this step entirely (back to a shallower context)
          break;
        }
        // Keep scanning (other step keys like `if:`, `env:` at same level)
        continue;
      }

      // Inside block-style `with:` — values are deeper than `uses:` key column.
      // Use raw leading-whitespace here (values don't have a `with:` key to index).
      const nextRawIndent = ((next.match(/^(\s*)/) ?? ["", ""])[1] ?? "").length;
      if (nextRawIndent <= stepIndent) {
        // Exited the `with:` block (back to step-level or shallower)
        break;
      }
      if (/retention-days:/.test(next)) {
        foundRetentionDays = true;
        break;
      }
    }

    if (!foundRetentionDays) {
      violations.push({ file, stepName, lineNumber: i + 1 });
    }
  }

  return violations;
}

// ─── main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const workflows = readWorkflowFiles();
  const allViolations: Violation[] = [];

  for (const { file, content } of workflows) {
    const v = checkRetentionDays(file, content);
    allViolations.push(...v);
  }

  if (allViolations.length === 0) {
    console.log(
      `✅ Workflow hygiene: all upload-artifact steps have retention-days (${workflows.length} workflow(s) checked).`,
    );
    process.exit(0);
  }

  console.error(
    `❌ Workflow hygiene: ${allViolations.length} upload-artifact step(s) missing retention-days:\n`,
  );
  for (const v of allViolations) {
    console.error(`  ${v.file}:${v.lineNumber}  step: "${v.stepName}"`);
  }
  console.error("\nFix: add `retention-days: <N>` under the `with:` block of each flagged step.");
  process.exit(1);
}

if (import.meta.main) {
  main();
}
