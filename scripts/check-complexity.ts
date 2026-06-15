#!/usr/bin/env bun

/**
 * Cognitive-complexity baseline-and-ratchet gate.
 *
 * Checks per-file violation counts from Biome's
 * complexity/noExcessiveCognitiveComplexity rule against a committed baseline
 * and fails only when a file's count rises (a regression). Existing violations
 * are grandfathered; lower the floor over time with `--update`.
 *
 *   bun run complexity:check    # blocking: regression vs baseline → exit 1
 *   bun run complexity:update   # regenerate complexity-baseline.json from current state
 *   bun run complexity:check --list  # print current per-file counts, exit 0
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── types ───────────────────────────────────────────────────────────────────

interface BiomeDiagnostic {
  category: string;
  location: { path: string };
  severity: string;
}

interface BiomeJson {
  diagnostics: BiomeDiagnostic[];
}

interface BaselineFile {
  rule: string;
  threshold: number;
  files: Record<string, number>;
}

// ─── constants ───────────────────────────────────────────────────────────────

const RULE = "complexity/noExcessiveCognitiveComplexity";
const CATEGORY = `lint/${RULE}`;
const THRESHOLD = 15;
const BASELINE_FILENAME = "complexity-baseline.json";

const usage = `Usage: bun run scripts/check-complexity.ts [--update | --list | -h]

Cognitive-complexity baseline-and-ratchet gate. Compares per-file violation
counts from Biome's ${RULE} rule
(threshold ${THRESHOLD}) against the committed ${BASELINE_FILENAME}.

  (no flag)   check: fail with exit 1 if any file's count rose above baseline
  --update    regenerate ${BASELINE_FILENAME} from the current state and exit 0
  --list      print current per-file counts sorted by count desc; exit 0
  -h, --help  show this message

To intentionally accept a new or worsened violation:
  bun run complexity:update   # bumps the baseline — visible in the PR diff`;

// ─── repo root ───────────────────────────────────────────────────────────────

const repoRoot = (() => {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    throw new Error(`not inside a git repository: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
})();

// ─── pure functions (exported for tests) ─────────────────────────────────────

/**
 * Group Biome diagnostics by file path, counting only the
 * cognitive-complexity category. Returns `{ [repoRelativePath]: count }`.
 */
export function parseDiagnostics(json: BiomeJson): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const d of json.diagnostics) {
    if (d.category !== CATEGORY) continue;
    const file = d.location.path;
    counts[file] = (counts[file] ?? 0) + 1;
  }
  return counts;
}

/**
 * Compare current per-file counts against the committed baseline.
 * - A file whose count rose above its baseline entry is a regression.
 * - A file not in the baseline at all but with ≥1 violation is a regression
 *   (from=0, to=current).
 * - A file that improved (current < baseline) is noted but not a failure.
 * - A file only in the baseline (fully fixed) is silently ignored.
 */
export function compareToBaseline(
  baseline: Record<string, number>,
  current: Record<string, number>,
): {
  regressions: Array<{ file: string; from: number; to: number }>;
  improvements: Array<{ file: string; from: number; to: number }>;
} {
  const regressions: Array<{ file: string; from: number; to: number }> = [];
  const improvements: Array<{ file: string; from: number; to: number }> = [];

  for (const [file, to] of Object.entries(current)) {
    const from = baseline[file] ?? 0;
    if (to > from) {
      regressions.push({ file, from, to });
    } else if (to < from) {
      improvements.push({ file, from, to });
    }
  }

  return { regressions, improvements };
}

// ─── biome invocation ─────────────────────────────────────────────────────────

// This is a SECOND, deliberate Biome process, separate from `bun run lint`
// (which runs the full ruleset with --reporter=github). Deduping is not worth it:
// the ratchet needs machine-readable per-file counts (--reporter=json) which the
// human lint step doesn't emit, and `--only` keeps the rule out of the shared
// biome.json so it never adds noise to everyone's lint output. The overhead is
// sub-100ms (Biome lints the whole src tree in ~60ms) against a multi-second
// tsc+test job. Keeping it a blocking gate (not the advisory quality job) is the
// whole point of a ratchet. (Re-raised by ai-review as ci/redundant-work — declined.)
function runBiome(): Record<string, number> {
  const result = Bun.spawnSync(
    ["bunx", "biome", "lint", `--only=${RULE}`, "--reporter=json", "src"],
    { cwd: repoRoot },
  );

  const rawStdout = result.stdout.toString().trim();
  if (!rawStdout) {
    // biome produced no stdout — a hard failure
    console.error("biome produced no output. stderr:");
    console.error(result.stderr.toString());
    process.exit(2);
  }

  let parsed: BiomeJson;
  try {
    parsed = JSON.parse(rawStdout) as BiomeJson;
  } catch {
    console.error("Failed to parse biome JSON output. stderr:");
    console.error(result.stderr.toString());
    console.error("stdout (first 500 chars):", rawStdout.slice(0, 500));
    process.exit(2);
  }

  return parseDiagnostics(parsed);
}

// ─── baseline I/O ─────────────────────────────────────────────────────────────

function readBaseline(): BaselineFile {
  const path = join(repoRoot, BASELINE_FILENAME);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BaselineFile;
  } catch {
    console.error(
      `Could not read ${BASELINE_FILENAME}. Run \`bun run complexity:update\` to generate it.`,
    );
    process.exit(2);
  }
}

function writeBaseline(files: Record<string, number>): void {
  const baseline: BaselineFile = {
    rule: RULE,
    threshold: THRESHOLD,
    files,
  };
  // Sort keys for deterministic diffs
  const sorted = Object.fromEntries(
    Object.entries(baseline.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  baseline.files = sorted;
  const path = join(repoRoot, BASELINE_FILENAME);
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
}

// ─── modes ────────────────────────────────────────────────────────────────────

function modeCheck(): void {
  const baseline = readBaseline();

  if (baseline.threshold !== THRESHOLD) {
    console.error(
      `Threshold mismatch: baseline has ${baseline.threshold} but script expects ${THRESHOLD}. Run \`bun run complexity:update\` to realign.`,
    );
    process.exit(1);
  }

  const current = runBiome();
  const { regressions, improvements } = compareToBaseline(baseline.files, current);

  if (improvements.length > 0) {
    console.log(
      `ℹ️  ${improvements.length} file(s) improved — run \`bun run complexity:update\` to lock in the lower floor:`,
    );
    for (const { file, from, to } of improvements) {
      console.log(`   ${file}: ${from} → ${to}`);
    }
  }

  if (regressions.length === 0) {
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    const fileCount = Object.keys(current).length;
    console.log(
      `✅ Complexity ratchet: no regressions (${total} violation(s) across ${fileCount} file(s), all within baseline).`,
    );
    process.exit(0);
  }

  console.error(`❌ Complexity regressions detected (${regressions.length} file(s)):`);
  for (const { file, from, to } of regressions.sort((a, b) => a.file.localeCompare(b.file))) {
    console.error(`   ${file}: ${from} → ${to}`);
  }
  console.error(
    "\nRemediation: reduce cognitive complexity in the files above, OR if the new\n" +
      "complexity is intentional and reviewed, run `bun run complexity:update` to\n" +
      "update the baseline (the change will be visible in the PR diff for reviewers).",
  );
  process.exit(1);
}

function modeUpdate(): void {
  const current = runBiome();

  // Try to read the old baseline to show a diff; tolerate missing file
  let oldFiles: Record<string, number> = {};
  const baselinePath = join(repoRoot, BASELINE_FILENAME);
  try {
    const existing = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
    oldFiles = existing.files;
  } catch {
    // first-time generation — no diff to show
  }

  writeBaseline(current);

  const allKeys = new Set([...Object.keys(oldFiles), ...Object.keys(current)]);
  const raised: string[] = [];
  const lowered: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const file of [...allKeys].sort()) {
    const before = oldFiles[file];
    const after = current[file];
    if (before === undefined && after !== undefined) {
      added.push(`   + ${file}: 0 → ${after}`);
    } else if (before !== undefined && after === undefined) {
      removed.push(`   - ${file}: ${before} → 0 (fixed)`);
    } else if (before !== undefined && after !== undefined) {
      if (after > before) raised.push(`   ↑ ${file}: ${before} → ${after}`);
      else if (after < before) lowered.push(`   ↓ ${file}: ${before} → ${after}`);
    }
  }

  const total = Object.values(current).reduce((a, b) => a + b, 0);
  const fileCount = Object.keys(current).length;
  console.log(`Updated ${BASELINE_FILENAME}: ${total} violation(s) across ${fileCount} file(s).`);

  if (raised.length > 0) {
    console.log("Raised (worse):");
    for (const line of raised) console.log(line);
  }
  if (lowered.length > 0) {
    console.log("Lowered (improved):");
    for (const line of lowered) console.log(line);
  }
  if (added.length > 0) {
    console.log("Added (new violations):");
    for (const line of added) console.log(line);
  }
  if (removed.length > 0) {
    console.log("Removed (fully fixed):");
    for (const line of removed) console.log(line);
  }
  if (raised.length === 0 && lowered.length === 0 && added.length === 0 && removed.length === 0) {
    console.log("No changes from previous baseline.");
  }

  process.exit(0);
}

function modeList(): void {
  const current = runBiome();
  const entries = Object.entries(current).sort(([, a], [, b]) => b - a);
  const total = entries.reduce((sum, [, c]) => sum + c, 0);
  console.log(`Per-file cognitive-complexity violations (threshold ${THRESHOLD}):`);
  for (const [file, count] of entries) {
    console.log(`  ${String(count).padStart(3)}  ${file}`);
  }
  console.log(`\nTotal: ${total} violation(s) across ${entries.length} file(s).`);
  process.exit(0);
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = Bun.argv.slice(2);

  let mode: "check" | "update" | "list" = "check";

  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--update") {
      mode = "update";
      continue;
    }
    if (arg === "--list") {
      mode = "list";
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    console.error(usage);
    process.exit(1);
  }

  if (mode === "update") modeUpdate();
  else if (mode === "list") modeList();
  else modeCheck();
}
