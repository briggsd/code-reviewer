#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AnalyzeOptions } from "../src/state/run-metrics-analyze.ts";
import { analyzeRunMetrics, formatRunMetricsAnalysis } from "../src/state/run-metrics-analyze.ts";
import type { CommonTelemetryCliOptions } from "./telemetry-artifacts.ts";
import {
  filterTelemetryEvents,
  loadTelemetryEvents,
  parseCommonTelemetryArgs,
} from "./telemetry-artifacts.ts";

const DEFAULT_RUN_LIMIT = 20;
const DEFAULT_OUTPUT = "telemetry-analyze.json";
const DEFAULT_THIN_FLOOR = 250;

const usage = `Usage: bun run scripts/telemetry-analyze.ts [options]

Download telemetry artifacts from the latest workflow runs of .github/workflows/ai-review.yml
and produce a segmented run-metrics analysis (by tier, reviewer, decision, outcome, and rates).

Alternatively, read run_metrics from a local fleet-dataset JSONL (the own-fleet fan-in store
produced by telemetry:ingest, #136) via --dataset instead of collecting from CI artifacts.

Options:
  -n, --runs <N>        Number of workflow runs to inspect (default: ${DEFAULT_RUN_LIMIT})
  -d, --dataset <PATH>  Read run_metrics from this local JSONL dataset instead of collecting
                        from CI artifacts via gh (mutually exclusive with --runs)
  -o, --output <PATH>   Output JSON path for the analysis (default: ${DEFAULT_OUTPUT})
  -t, --thin-floor <N>  Output-token floor below which a non-trivial run counts as
                        "thin" (default: ${DEFAULT_THIN_FLOOR}; trivial-tier runs are never flagged)
  -h, --help            Show this help message`;

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
  const outputPath = resolve(options.outputPath);

  const { events: rawEvents, sourceSummary } = await loadTelemetryEvents({
    runLimit: options.runLimit,
    datasetPath: options.datasetPath,
  });

  const telemetryEvents = filterTelemetryEvents(rawEvents, {
    since: options.since,
    until: options.until,
    includeRepositories: options.includeRepositories,
    excludeRepositories: options.excludeRepositories,
  });

  const filterDesc = buildFilterDescription(options);
  const filteredSuffix =
    telemetryEvents.length !== rawEvents.length
      ? ` (filtered: ${rawEvents.length - telemetryEvents.length} dropped${filterDesc})`
      : "";

  if (telemetryEvents.length === 0) {
    console.error("No telemetry events collected; nothing to analyze.");
    process.exit(1);
  }

  const analyzeOptions: AnalyzeOptions = {};
  if (options.thinReviewOutputTokenFloor !== undefined) {
    analyzeOptions.thinReviewOutputTokenFloor = options.thinReviewOutputTokenFloor;
  }
  const analysis = analyzeRunMetrics(telemetryEvents, analyzeOptions);

  if (analysis.runCount === 0) {
    console.warn(
      "Warning: collected telemetry but no real-runtime run_metrics events remained after " +
        "excluding dummy/deterministic runs. The analysis contains zero runs — confirm that " +
        "real Pi review runs exist for this repo.",
    );
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(analysis, null, 2)}\n`);

  console.log(formatRunMetricsAnalysis(analysis));
  console.log(
    `\nAnalyzed ${telemetryEvents.length} of ${rawEvents.length} events ${sourceSummary}${filteredSuffix}.`,
  );
  console.log(`Wrote ${outputPath}`);
}

function parseArgs(argv: readonly string[]): CommonTelemetryCliOptions {
  const { options, rest } = parseCommonTelemetryArgs(argv, {
    defaultRunLimit: DEFAULT_RUN_LIMIT,
    defaultOutput: DEFAULT_OUTPUT,
    usage,
  });
  const unknown = rest[0];
  if (unknown !== undefined) {
    throw new Error(`Unknown argument: ${unknown}`);
  }
  return options;
}

function buildFilterDescription(options: CommonTelemetryCliOptions): string {
  const parts: string[] = [];
  if (options.since !== undefined) {
    parts.push(`since=${options.since}`);
  }
  if (options.until !== undefined) {
    parts.push(`until=${options.until}`);
  }
  if (options.includeRepositories !== undefined && options.includeRepositories.length > 0) {
    parts.push(`repository=${options.includeRepositories.join(",")}`);
  }
  if (options.excludeRepositories !== undefined && options.excludeRepositories.length > 0) {
    parts.push(`exclude-repository=${options.excludeRepositories.join(",")}`);
  }
  return parts.length > 0 ? ` [${parts.join(", ")}]` : "";
}
