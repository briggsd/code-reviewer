#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { QualityReportThresholds } from "../src/state/quality-report.ts";
import { buildQualityReport, formatQualityReport } from "../src/state/quality-report.ts";
import type { AnalyzeOptions } from "../src/state/run-metrics-analyze.ts";
import { analyzeRunMetrics } from "../src/state/run-metrics-analyze.ts";
import { collectTelemetryEvents } from "./telemetry-artifacts.ts";

const DEFAULT_RUN_LIMIT = 20;
const DEFAULT_OUTPUT = "telemetry-quality-report.json";
const DEFAULT_THIN_FLOOR = 250;

const usage = `Usage: bun run scripts/telemetry-quality-report.ts [options]

Download telemetry artifacts from the latest workflow runs of .github/workflows/ai-review.yml
and produce a quality report (hypothesis queue) identifying segments that breach quality
thresholds. Counts/segments only — never finding text, diff text, prompts, or secrets.

Options:
  -n, --runs <N>               Number of workflow runs to inspect (default: ${DEFAULT_RUN_LIMIT})
  -o, --output <PATH>          Output JSON path for the report (default: ${DEFAULT_OUTPUT})
  -t, --thin-floor <N>         Output-token floor below which a non-trivial run counts as
                               "thin" (default: ${DEFAULT_THIN_FLOOR}; trivial-tier runs are never flagged)

Threshold overrides (each a float in [0,1]):
  --max-grounding-drop <F>     Max grounding-drop rate (default 0.15)
  --max-thin-review <F>        Max thin-review rate (default 0.20)
  --max-override <F>           Max override rate (default 0.10)
  --min-acceptance <F>         Min acceptance rate (default 0.50)
  --max-withhold <F>           Max withhold rate (default 0.30)
  --min-completion <F>         Min completion rate (default 0.90)
  --min-samples <N>            Min sample size for high-confidence (default 5; positive integer)

  -h, --help                   Show this help message`;

interface CliOptions {
  runLimit: number;
  outputPath: string;
  thinReviewOutputTokenFloor?: number;
  thresholdOverrides: Partial<QualityReportThresholds>;
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

  const {
    events: telemetryEvents,
    telemetryFileCount,
    artifactCount,
  } = await collectTelemetryEvents(runLimit);

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
        "excluding dummy/deterministic runs. The quality report contains zero runs — confirm that " +
        "real Pi review runs exist for this repo.",
    );
  }

  const report = buildQualityReport(analysis, options.thresholdOverrides);

  console.log(formatQualityReport(report));
  console.log(
    `\nAnalyzed ${analysis.runCount} ai_review.run_metrics events from ${telemetryFileCount} telemetry files across ${artifactCount} artifacts.`,
  );

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
}

function parseFloat01(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} value must be a finite number in [0,1]`);
  }
  return parsed;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let runLimit = DEFAULT_RUN_LIMIT;
  let outputPath = DEFAULT_OUTPUT;
  let thinReviewOutputTokenFloor: number | undefined;
  const thresholdOverrides: Partial<QualityReportThresholds> = {};

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
    if (arg === "--thin-floor" || arg === "-t") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--thin-floor requires a numeric value");
      }
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("--thin-floor value must be a non-negative integer");
      }
      thinReviewOutputTokenFloor = parsed;
      continue;
    }
    if (arg === "--max-grounding-drop") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--max-grounding-drop requires a numeric value");
      }
      index += 1;
      thresholdOverrides.maxGroundingDropRate = parseFloat01(value, "--max-grounding-drop");
      continue;
    }
    if (arg === "--max-thin-review") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--max-thin-review requires a numeric value");
      }
      index += 1;
      thresholdOverrides.maxThinReviewRate = parseFloat01(value, "--max-thin-review");
      continue;
    }
    if (arg === "--max-override") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--max-override requires a numeric value");
      }
      index += 1;
      thresholdOverrides.maxOverrideRate = parseFloat01(value, "--max-override");
      continue;
    }
    if (arg === "--min-acceptance") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--min-acceptance requires a numeric value");
      }
      index += 1;
      thresholdOverrides.minAcceptanceRate = parseFloat01(value, "--min-acceptance");
      continue;
    }
    if (arg === "--max-withhold") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--max-withhold requires a numeric value");
      }
      index += 1;
      thresholdOverrides.maxWithholdRate = parseFloat01(value, "--max-withhold");
      continue;
    }
    if (arg === "--min-completion") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--min-completion requires a numeric value");
      }
      index += 1;
      thresholdOverrides.minCompletionRate = parseFloat01(value, "--min-completion");
      continue;
    }
    if (arg === "--min-samples") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--min-samples requires a numeric value");
      }
      index += 1;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--min-samples value must be a positive integer");
      }
      thresholdOverrides.minSampleSize = parsed;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const result: CliOptions = { runLimit, outputPath, thresholdOverrides };
  if (thinReviewOutputTokenFloor !== undefined) {
    result.thinReviewOutputTokenFloor = thinReviewOutputTokenFloor;
  }
  return result;
}
