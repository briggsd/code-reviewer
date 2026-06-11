#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { rollupRunMetrics } from "../src/state/run-metrics-rollup.ts";
import { collectTelemetryEvents } from "./telemetry-artifacts.ts";

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

  const { events: telemetryEvents, telemetryFileCount, artifactCount } = await collectTelemetryEvents(runLimit);

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
