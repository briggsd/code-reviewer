#!/usr/bin/env bun

/**
 * Holdout scenario eval runner (#28 MVP).
 *
 * Gated: requires AI_REVIEW_LIVE_EVAL=1 when --runtime is `pi` (the default), so a
 * plain `bun run check` / CI run never burns tokens. Pass `--runtime dummy` to run
 * immediately without the gate (useful for fixture-shape validation).
 *
 * Usage:
 *   AI_REVIEW_LIVE_EVAL=1 bun run evals [--runtime dummy|pi] [--runs K]
 *     [--threshold T] [--scenarios <dir>] [--gate] [--keep-summaries <dir>]
 *   Optional: AI_REVIEW_PI_PROVIDER=<provider> AI_REVIEW_PI_MODEL=<model>
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReviewSummary, RiskAssessment } from "../src/contracts/index.ts";
import { buildQualityStamp, summarizeEvalRun } from "../src/evals/quality-stamp.ts";
import type { ScenarioScore } from "../src/evals/score.ts";
import { scoreScenario } from "../src/evals/score.ts";
import type { EvalScenario } from "../src/evals/types.ts";

// ---------------------------------------------------------------------------
// Argument parsing (simple process.argv, mirrors pi-live-smoke.ts style)
// ---------------------------------------------------------------------------

function readFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return undefined;
  const val = process.argv[idx + 1];
  return val !== undefined && !val.startsWith("--") ? val : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

const FALSEY_ENV_VALUES = new Set(["0", "false", "no"]);
const CI_RUNNER_ENV_VARS = ["GITHUB_ACTIONS", "GITLAB_CI", "CIRCLECI", "BUILDKITE", "TF_BUILD"];

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized.length > 0 && !FALSEY_ENV_VALUES.has(normalized);
}

function isCiEnvironment(): boolean {
  return (
    isTruthyEnvValue(process.env.CI) ||
    CI_RUNNER_ENV_VARS.some((name) => isTruthyEnvValue(process.env[name]))
  );
}

const runtime = readFlag("--runtime") ?? "pi";
const defaultRuns = runtime === "dummy" ? 1 : 3;
const runs = parseInt(readFlag("--runs") ?? String(defaultRuns), 10);
const threshold = parseFloat(readFlag("--threshold") ?? "0.8");
const scenariosDir = resolve(readFlag("--scenarios") ?? "evals/scenarios");
const gate = hasFlag("--gate");
const stampPath = readFlag("--stamp");
const keepSummariesPath = readFlag("--keep-summaries");

// Validate numeric flags up front: an unparsed/NaN/out-of-range value would otherwise silently
// produce 0 runs (NaN > 0 is false) or always-fail thresholds (x >= NaN is false), reporting a
// misleading "all scenarios failed" with no diagnostic (#85 review).
// Upper bound (#130 review): the release gate spends live tokens (scenarios x runs model calls);
// an unbounded --runs (e.g. a fat-fingered workflow_dispatch input) could burn arbitrary credit.
// MAX_RUNS is a generous ceiling that never constrains legitimate use but caps accidental abuse.
const MAX_RUNS = 50;
if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) {
  console.error(
    `Invalid --runs value: must be an integer in [1, ${MAX_RUNS}] (got ${JSON.stringify(readFlag("--runs"))}).`,
  );
  process.exit(1);
}
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  console.error(
    `Invalid --threshold value: must be a number in [0, 1] (got ${JSON.stringify(readFlag("--threshold"))}).`,
  );
  process.exit(1);
}
if (
  hasFlag("--keep-summaries") &&
  (keepSummariesPath === undefined || keepSummariesPath.trim().length === 0)
) {
  console.error("Invalid --keep-summaries value: expected a directory path.");
  process.exit(1);
}
if (keepSummariesPath !== undefined && isCiEnvironment()) {
  console.error("--keep-summaries preserves raw review output and must not be used in CI.");
  process.exit(1);
}

const provider = readOptionalEnv("AI_REVIEW_PI_PROVIDER");
const model = readOptionalEnv("AI_REVIEW_PI_MODEL");

// ---------------------------------------------------------------------------
// Gate: require AI_REVIEW_LIVE_EVAL=1 for pi runtime
// ---------------------------------------------------------------------------

const enabled = runtime === "dummy" || process.env.AI_REVIEW_LIVE_EVAL === "1";
if (!enabled) {
  console.log("Skipping eval harness (runtime=pi requires AI_REVIEW_LIVE_EVAL=1 to run).");
  console.log("Usage: AI_REVIEW_LIVE_EVAL=1 bun run evals [--runtime dummy|pi] [--runs K]");
  console.log("         [--threshold T] [--scenarios <dir>] [--gate] [--keep-summaries <dir>]");
  console.log("Optional: AI_REVIEW_PI_PROVIDER=<provider> AI_REVIEW_PI_MODEL=<model>");
  process.exit(0);
}

if ((provider === undefined) !== (model === undefined)) {
  throw new Error("AI_REVIEW_PI_PROVIDER and AI_REVIEW_PI_MODEL must be provided together");
}

// ---------------------------------------------------------------------------
// Empty ReviewSummary used when a run fails or produces no output
// ---------------------------------------------------------------------------

const EMPTY_RISK: RiskAssessment = {
  tier: "trivial",
  reason: "run failed or produced no output",
  matchedRules: [],
  sensitivePaths: [],
  reviewedFileCount: 0,
  ignoredFileCount: 0,
};

const EMPTY_SUMMARY: ReviewSummary = {
  decision: "review_failed",
  outcome: "neutral",
  title: "",
  body: "",
  findings: [],
  risk: EMPTY_RISK,
};

// ---------------------------------------------------------------------------
// Spawn helper: run one CLI invocation, return parsed summary
// ---------------------------------------------------------------------------

function safeSummaryName(scenarioName: string, runNumber: number): string {
  const safeScenarioName =
    scenarioName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "") || "scenario";
  return `${safeScenarioName}-run-${runNumber}.summary.json`;
}

async function preserveSummary(
  scenario: EvalScenario,
  runNumber: number,
  rawSummary: string,
): Promise<void> {
  if (keepSummariesPath === undefined) return;
  const destinationDir = resolve(keepSummariesPath);
  await mkdir(destinationDir, { recursive: true });
  await writeFile(join(destinationDir, safeSummaryName(scenario.name, runNumber)), rawSummary);
}

async function runOnce(scenario: EvalScenario, runNumber: number): Promise<ReviewSummary> {
  const tmpDir = await mkdtemp(join(tmpdir(), "ai-review-eval-"));
  try {
    const command = [
      "bun",
      "run",
      "src/cli.ts",
      "run",
      "--fixture",
      scenario.fixture,
      "--runtime",
      runtime,
      "--output-dir",
      tmpDir,
    ];

    if (scenario.config !== undefined) {
      command.push("--config", scenario.config);
    }

    if (provider !== undefined && model !== undefined) {
      command.push("--pi-provider", provider, "--pi-model", model);
    }

    const subprocess = Bun.spawn(command, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const [, stderr, exitCode] = await Promise.all([
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
      subprocess.exited,
    ]);

    if (exitCode !== 0) {
      console.warn(`  [warn] subprocess exited ${exitCode}: ${stderr.trim().slice(0, 200)}`);
      return EMPTY_SUMMARY;
    }

    // Find the single run directory under <tmpDir>/runs/
    const runsBase = join(tmpDir, "runs");
    let runDirs: string[];
    try {
      runDirs = await readdir(runsBase);
    } catch {
      console.warn(`  [warn] runs directory not found at ${runsBase}`);
      return EMPTY_SUMMARY;
    }

    // Sorted for deterministic selection (a fresh tmpDir holds exactly one run dir, but don't
    // rely on readdir order). The newest/only run is what we score (#85 review).
    const runDir = runDirs.sort()[runDirs.length - 1];
    if (runDir === undefined) {
      console.warn(`  [warn] no run directory found under ${runsBase}`);
      return EMPTY_SUMMARY;
    }

    const summaryPath = join(runsBase, runDir, "summary.json");
    let raw: string;
    try {
      raw = await readFile(summaryPath, "utf-8");
    } catch {
      console.warn(`  [warn] summary.json not found at ${summaryPath}`);
      return EMPTY_SUMMARY;
    }

    const parsed = JSON.parse(raw) as ReviewSummary;
    try {
      await preserveSummary(scenario, runNumber, raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [warn] could not preserve raw summary: ${msg.slice(0, 200)}`);
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [warn] run failed: ${msg.slice(0, 200)}`);
    return EMPTY_SUMMARY;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const scenarioFiles = (await readdir(scenariosDir)).filter((f) => f.endsWith(".json"));
if (scenarioFiles.length === 0) {
  console.error(`No scenario JSON files found in: ${scenariosDir}`);
  process.exit(1);
}

console.log(`\nEval harness — runtime=${runtime}, runs=${runs}, threshold=${threshold}`);
console.log(`Scenarios dir: ${scenariosDir}`);
if (keepSummariesPath !== undefined) {
  console.log(`Keeping raw summaries in trusted-local dir: ${resolve(keepSummariesPath)}`);
}
console.log(`Scenarios: ${scenarioFiles.join(", ")}\n`);

const results: ScenarioScore[] = [];

const projectRoot = resolve(".");

for (const file of scenarioFiles) {
  const raw = await readFile(join(scenariosDir, file), "utf-8");
  const scenario = JSON.parse(raw) as EvalScenario;

  // Contain the fixture path: a scenario file (potentially contributed via a fork PR that runs
  // `bun run evals` on CI) could otherwise point --fixture at any file on disk (#85 review).
  // Require a repo-relative .json path that resolves inside the project root.
  const resolvedFixture = resolve(projectRoot, scenario.fixture);
  if (!scenario.fixture.endsWith(".json") || !resolvedFixture.startsWith(`${projectRoot}/`)) {
    console.error(
      `Scenario ${file}: fixture path must be a .json file inside the repo (got ${JSON.stringify(scenario.fixture)}).`,
    );
    process.exit(1);
  }

  // Per-scenario `runs` override must also be a positive integer (same guard as the --runs flag).
  const effectiveRuns = scenario.runs ?? runs;
  if (!Number.isInteger(effectiveRuns) || effectiveRuns < 1) {
    console.error(
      `Scenario ${file}: "runs" must be a positive integer (got ${JSON.stringify(scenario.runs)}).`,
    );
    process.exit(1);
  }

  console.log(`Running scenario: ${scenario.name} (${effectiveRuns} run(s))...`);

  const summaries: ReviewSummary[] = [];
  for (let i = 0; i < effectiveRuns; i++) {
    process.stdout.write(`  run ${i + 1}/${effectiveRuns}... `);
    const summary = await runOnce(scenario, i + 1);
    summaries.push(summary);
    process.stdout.write(
      `done (${summary.findings.length} findings, outcome=${summary.outcome})\n`,
    );
  }

  const score = scoreScenario(scenario, summaries, threshold);
  results.push(score);

  // Per-scenario table
  const passStr = score.passed ? "PASS" : "FAIL";
  const runDistribution = score.runSatisfactions.map((s) => `${(s * 100).toFixed(1)}%`).join(", ");
  const flakyMarker = score.flaky ? " FLAKY" : "";
  console.log(
    `  ${score.name}: satisfaction=${(score.satisfaction * 100).toFixed(1)}% (threshold=${(score.threshold * 100).toFixed(0)}%) → ${passStr}`,
  );
  console.log(
    `    runs=[${runDistribution}] min=${(score.minSatisfaction * 100).toFixed(1)}% max=${(score.maxSatisfaction * 100).toFixed(1)}% variance=${score.variance.toFixed(4)}${flakyMarker}`,
  );
  for (const c of score.perCriterion) {
    const pct = (c.passRate * 100).toFixed(0).padStart(3);
    const requirement =
      c.requiredPassRate === null
        ? ""
        : ` [${c.critical ? "critical " : ""}>=${(c.requiredPassRate * 100).toFixed(0)}% ${c.passed ? "OK" : "FAIL"}]`;
    console.log(`    ${pct}%  ${c.label}${requirement}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------

const summary = summarizeEvalRun(results);
const { passed, total, meanSatisfaction } = summary;

console.log("=".repeat(60));
console.log(`Aggregate: ${passed}/${total} scenarios passed`);
console.log(`Mean satisfaction: ${(meanSatisfaction * 100).toFixed(1)}%`);
console.log("=".repeat(60));

if (stampPath !== undefined) {
  const stamp = buildQualityStamp(results, {
    generatedAt: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? null,
    runtime,
    model: model ?? null,
    runs,
    threshold,
  });
  // Exit 2 on a write failure so a filesystem error is distinguishable from the gate's
  // pass/fail verdict (exit 0/1) — otherwise CI reads a disk/permission error as a quality
  // regression (#130 review). The release workflow always passes both --gate and --stamp.
  try {
    await writeFile(resolve(stampPath), `${JSON.stringify(stamp, null, 2)}\n`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write quality stamp to ${stampPath}: ${msg}`);
    process.exit(2);
  }
  console.log(`Wrote quality stamp: ${stampPath}`);
}

if (gate) {
  process.exit(summary.blocked ? 1 : 0);
}
