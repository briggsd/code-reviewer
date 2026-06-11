#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { JsonValue } from "../src/contracts/common.ts";
import type { TelemetryEvent } from "../src/contracts/telemetry.ts";
import { rollupRunMetrics } from "../src/state/run-metrics-rollup.ts";

const DEFAULT_RUN_LIMIT = 20;
const DEFAULT_OUTPUT = "telemetry-rollup.json";

const usage = `Usage: bun run scripts/telemetry-rollup.ts [options]

Download telemetry artifacts from the latest workflow runs of .github/workflows/ai-review.yml
and aggregate ai_review.run_metrics events into a counts-only JSON summary.

Options:
  -n, --runs <N>     Number of workflow runs to inspect (default: ${DEFAULT_RUN_LIMIT})
  -o, --output <PATH>  Output JSON path for the rollup (default: ${DEFAULT_OUTPUT})
  -h, --help         Show this help message`;

interface CliOptions {
  runLimit: number;
  outputPath: string;
}

interface WorkflowRunSummary {
  databaseId: number;
  headBranch?: string;
  displayTitle?: string;
}

interface WorkflowArtifact {
  name: string;
  expired?: boolean;
}

void main().catch((error) => {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
});

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const runLimit = options.runLimit;
  const outputPath = resolve(options.outputPath);

  const runs = await listWorkflowRuns(runLimit);
  if (runs.length === 0) {
    console.error("No workflow runs found for .github/workflows/ai-review.yml");
    process.exit(1);
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "ai-review-telemetry-"));
  const telemetryEvents: TelemetryEvent[] = [];
  let telemetryFileCount = 0;
  let artifactCount = 0;

  try {
    for (const run of runs) {
      const runLabel = `${run.databaseId}${run.displayTitle === undefined ? "" : ` ${run.displayTitle}`}`;
      process.stderr.write(`Fetching telemetry for run ${runLabel}\n`);

      const artifacts = await listRunArtifacts(run.databaseId);
      const telemetryArtifacts = artifacts.filter((artifact) => artifact.name.startsWith("ai-review") && artifact.expired !== true);
      if (telemetryArtifacts.length === 0) {
        process.stderr.write("  no telemetry artifacts found\n");
        continue;
      }

      for (const artifact of telemetryArtifacts) {
        artifactCount += 1;
        const artifactDirectory = join(tempDirectory, `${run.databaseId}-${sanitizeName(artifact.name)}`);
        await mkdir(artifactDirectory, { recursive: true });
        await runGhCommand([
          "run",
          "download",
          String(run.databaseId),
          "--name",
          artifact.name,
          "--dir",
          artifactDirectory,
        ]);

        const telemetryFiles = await findTelemetryFiles(artifactDirectory);
        if (telemetryFiles.length === 0) {
          process.stderr.write(`  artifact ${artifact.name} has no telemetry.jsonl\n`);
          continue;
        }

        telemetryFileCount += telemetryFiles.length;
        for (const telemetryFile of telemetryFiles) {
          const fileEvents = await readTelemetryEvents(telemetryFile);
          // Append in a loop rather than spreading into push(): a large JSONL file
          // could exceed the argument-count limit and throw a RangeError.
          for (const fileEvent of fileEvents) {
            telemetryEvents.push(fileEvent);
          }
        }
      }
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  if (telemetryEvents.length === 0) {
    console.error("No telemetry events collected; nothing to roll up.");
    process.exit(1);
  }

  const rollup = rollupRunMetrics(telemetryEvents);

  if (rollup.runCount === 0) {
    console.warn(
      "Warning: collected telemetry but no real-runtime run_metrics events remained after "
        + "excluding dummy/deterministic runs. The rollup contains zero runs — confirm that "
        + "real Pi review runs exist for this repo.",
    );
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(rollup, null, 2)}\n`);

  console.log(`Aggregated ${rollup.runCount} ai_review.run_metrics events from ${telemetryFileCount} telemetry files across ${artifactCount} artifacts.`);
  console.log(`Wrote ${outputPath}`);
}

function parseArgs(argv: readonly string[]): CliOptions {
  let runLimit = DEFAULT_RUN_LIMIT;
  let outputPath = DEFAULT_OUTPUT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--runs" || arg === "-n") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--runs requires a numeric value");
      }
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--runs value must be a positive integer");
      }
      runLimit = parsed;
      continue;
    }
    if (arg === "--output" || arg === "-o") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--output requires a path value");
      }
      index += 1;
      outputPath = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { runLimit, outputPath };
}

async function listWorkflowRuns(limit: number): Promise<WorkflowRunSummary[]> {
  const json = await runGhCommand([
    "run",
    "list",
    "--workflow",
    ".github/workflows/ai-review.yml",
    "--limit",
    String(limit),
    "--json",
    "databaseId,headBranch,displayTitle",
  ]);

  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("Unexpected run list response");
  }

  const runs: WorkflowRunSummary[] = [];
  for (const item of parsed) {
    if (isWorkflowRunSummary(item)) {
      runs.push(item);
    }
  }

  return runs;
}

async function listRunArtifacts(runId: number): Promise<WorkflowArtifact[]> {
  const json = await runGhCommand([
    "run",
    "view",
    String(runId),
    "--json",
    "artifacts",
  ]);

  const parsed = JSON.parse(json) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Unexpected run view response");
  }

  const artifactsValue = parsed.artifacts;
  if (!Array.isArray(artifactsValue)) {
    return [];
  }

  const artifacts: WorkflowArtifact[] = [];
  for (const artifact of artifactsValue) {
    if (isWorkflowArtifact(artifact)) {
      artifacts.push(artifact);
    }
  }

  return artifacts;
}

async function runGhCommand(args: readonly string[]): Promise<string> {
  const command = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    command.exited,
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
  ]);

  if (exitCode !== 0) {
    throw new Error(`gh ${args.join(" ")} failed (${exitCode}): ${stderr.trim()}`);
  }

  return stdout;
}

async function findTelemetryFiles(directory: string): Promise<string[]> {
  const results: string[] = [];
  const queue: string[] = [directory];

  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined) {
      break;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name === "telemetry.jsonl") {
        results.push(entryPath);
      }
    }
  }

  return results;
}

async function readTelemetryEvents(filePath: string): Promise<TelemetryEvent[]> {
  const content = await readFile(filePath, "utf8");
  const events: TelemetryEvent[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isTelemetryEvent(parsed)) {
        events.push(parsed);
      }
    } catch (error) {
      console.warn(`Skipping invalid telemetry line in ${filePath}: ${(error as Error).message}`);
    }
  }
  return events;
}

function isWorkflowRunSummary(value: unknown): value is WorkflowRunSummary {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.databaseId === "number" && Number.isFinite(value.databaseId);
}

function isWorkflowArtifact(value: unknown): value is WorkflowArtifact {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.name === "string" && value.name.length > 0;
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (!isPlainObject(value)) {
    return false;
  }
  const type = value.type;
  const timestamp = value.timestamp;
  if (typeof type !== "string" || typeof timestamp !== "string") {
    return false;
  }
  if (value.data !== undefined && !isPlainObject(value.data)) {
    return false;
  }
  if (value.runId !== undefined && typeof value.runId !== "string") {
    return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]+/g, "-");
}
