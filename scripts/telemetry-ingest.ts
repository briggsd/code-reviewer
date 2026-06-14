#!/usr/bin/env bun

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { authenticateFleetRequest, ingestFleetPayload } from "../src/state/fleet-ingest.ts";

// Own-fleet telemetry fan-in CLI (M016 S06, #136) — the factory-side RECEIVE counterpart of
// the #51 send side. Reads a counts-only newline-delimited `run_metrics` payload from one of
// the owner's OWN fleet repos, authenticates it with the shared fleet secret, RE-APPLIES the
// rollup-export.ts counts-only boundary on receive (never trusting the sender to have
// filtered), and appends the accepted events to the fleet dataset that `telemetry:quality`
// consumes — so the hypothesis queue reflects the whole fleet, not just this repo's PRs.
//
// OWN-FLEET ONLY: a single shared secret (AI_REVIEW_FLEET_INGEST_SECRET) authenticates the
// whole owner fleet. Open third-party contribution is out of scope (the poisoning vector).
// Mirrors the standalone-script convention of the other telemetry:* tools — it is NOT a
// subcommand of the run CLI.

const DEFAULT_DATASET = ".ai-review-fleet/telemetry.jsonl";
const SECRET_ENV = "AI_REVIEW_FLEET_INGEST_SECRET";
/** Stdin payload ceiling (16 MiB) — guards a constrained CI runner against an oversized body. */
const MAX_STDIN_BYTES = 16 * 1024 * 1024;

const usage = `Usage: bun run scripts/telemetry-ingest.ts [options]

Ingest a counts-only newline-delimited run_metrics payload from one of the owner's OWN fleet
repos into the fleet telemetry dataset (the JSONL store the quality/analyze collectors will
read). The receive-side counts-only boundary (rollup-export.ts) is re-applied to every event:
non-exportable event types are rejected and stray non-count fields (finding/diff/prompt/secret
text) are shape-bound away on receive — the sender is never trusted to have filtered.

Authentication (OWN-FLEET ONLY):
  Reads the server secret from ${SECRET_ENV} and the presented secret from
  ${SECRET_ENV}_PRESENTED, compared timing-safely. BOTH are read from the environment ONLY —
  there is deliberately no --secret flag, so the credential never lands in the process table,
  shell history, or CI logs. A single shared secret authenticates the whole owner fleet by
  design; open third-party contribution is out of scope.

Options:
  -i, --input <PATH>     Payload file of newline-delimited JSON (default: read stdin)
  -d, --dataset <PATH>   Fleet dataset JSONL to append accepted events to
                         (default: ${DEFAULT_DATASET})
      --dry-run          Validate + summarize without appending to the dataset
  -h, --help             Show this help message`;

interface CliOptions {
  inputPath?: string;
  datasetPath: string;
  dryRun: boolean;
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

  const expectedSecret = process.env[SECRET_ENV];
  // Presented secret is env-only — never a CLI flag, so it cannot leak via the process table,
  // shell history, or CI command logs (the secret authenticates the whole owner fleet).
  const presentedSecret = process.env[`${SECRET_ENV}_PRESENTED`];

  const auth = authenticateFleetRequest(expectedSecret, presentedSecret);
  if (!auth.ok) {
    // Counts-only failure surface — never echo either secret. "missing" covers an unset
    // server secret (ingestion disabled) or an unsupplied presented secret; "mismatch" is a
    // bad credential. Both are an authentication failure to the caller.
    console.error(
      auth.reason === "missing"
        ? `Fleet ingestion authentication failed: set ${SECRET_ENV} (server) and ${SECRET_ENV}_PRESENTED (sender) in the environment.`
        : "Fleet ingestion authentication failed: presented secret does not match.",
    );
    process.exit(1);
  }

  const rawBody =
    options.inputPath !== undefined
      ? await readFile(resolve(options.inputPath), "utf8")
      : await readStdin();

  const { events, summary } = ingestFleetPayload(rawBody);

  if (!options.dryRun && events.length > 0) {
    const datasetPath = resolve(options.datasetPath);
    await mkdir(dirname(datasetPath), { recursive: true });
    // Append one JSON event per line — the same JSONL shape the quality/analyze pipeline reads,
    // so the fleet dataset folds straight into the hypothesis queue alongside this repo's events.
    const serialized = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    await appendFile(datasetPath, serialized, "utf8");
  }

  console.log(formatSummary(summary, options));
}

function formatSummary(
  summary: ReturnType<typeof ingestFleetPayload>["summary"],
  options: CliOptions,
): string {
  const lines: string[] = [];
  lines.push("=== Fleet telemetry ingest (counts-only, own-fleet) ===");
  lines.push(`  acceptedCount        ${summary.acceptedCount}`);
  lines.push(`  rejectedEventCount   ${summary.rejectedEventCount}`);
  lines.push(`  shapeBoundEventCount ${summary.shapeBoundEventCount}`);
  lines.push(`  malformedLineCount   ${summary.malformedLineCount}`);
  lines.push(`  repositories         ${summary.repositories.length}`);
  for (const repo of summary.repositories) {
    lines.push(`    - ${repo}`);
  }
  if (options.dryRun) {
    lines.push("  (dry-run: dataset not modified)");
  } else if (summary.acceptedCount > 0) {
    lines.push(`  appended to          ${resolve(options.datasetPath)}`);
  }
  return lines.join("\n");
}

async function readStdin(): Promise<string> {
  // Bound the payload so a mistakenly-piped large file (or an authenticated fleet member sending
  // an oversized body) cannot exhaust a constrained CI runner's memory. The full counts-only
  // run_metrics payload for a fleet batch is small; 16 MiB is a generous ceiling.
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for await (const chunk of Bun.stdin.stream()) {
    totalBytes += chunk.byteLength;
    if (totalBytes > MAX_STDIN_BYTES) {
      throw new Error(
        `stdin payload exceeds the ${MAX_STDIN_BYTES}-byte limit; split the batch or pass a file via --input.`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(argv: readonly string[]): CliOptions {
  let inputPath: string | undefined;
  let datasetPath = DEFAULT_DATASET;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    }
    if (arg === "--input" || arg === "-i") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--input requires a path value");
      }
      index += 1;
      inputPath = value;
      continue;
    }
    if (arg === "--dataset" || arg === "-d") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--dataset requires a path value");
      }
      index += 1;
      datasetPath = value;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  const result: CliOptions = { datasetPath, dryRun };
  if (inputPath !== undefined) {
    result.inputPath = inputPath;
  }
  return result;
}
