#!/usr/bin/env bun

// Shared gh/artifact/JSONL helpers used by both telemetry-rollup.ts and
// telemetry-analyze.ts. Extracted so the per-run download loop and leaf
// helpers are not duplicated across scripts.

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../src/contracts/common.ts";
import type { TelemetryEvent } from "../src/contracts/telemetry.ts";

export interface WorkflowRunSummary {
  databaseId: number;
  headBranch?: string;
  displayTitle?: string;
}

export interface WorkflowArtifact {
  name: string;
  expired?: boolean;
}

export interface CollectedTelemetry {
  events: TelemetryEvent[];
  telemetryFileCount: number;
  artifactCount: number;
}

export async function collectTelemetryEvents(runLimit: number): Promise<CollectedTelemetry> {
  const runs = await listWorkflowRuns(runLimit);
  if (runs.length === 0) {
    // Throw rather than process.exit so this shared library function stays testable and
    // lets the calling script own lifecycle (each script's main().catch logs + exits 1).
    throw new Error("No workflow runs found for .github/workflows/ai-review.yml");
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), "ai-review-telemetry-"));
  const events: TelemetryEvent[] = [];
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
            events.push(fileEvent);
          }
        }
      }
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  return { events, telemetryFileCount, artifactCount };
}

export async function listWorkflowRuns(limit: number): Promise<WorkflowRunSummary[]> {
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

export async function listRunArtifacts(runId: number): Promise<WorkflowArtifact[]> {
  // Use the REST API rather than `gh run view --json artifacts`: the `artifacts`
  // field was removed from `gh run view` (gone as of gh 2.94.0), so the JSON-field
  // form errors out. The runs/<id>/artifacts endpoint returns the same shape
  // ({ artifacts: [{ name, expired, ... }] }) and is stable across gh versions.
  const json = await runGhCommand([
    "api",
    `repos/{owner}/{repo}/actions/runs/${runId}/artifacts`,
  ]);

  const parsed = JSON.parse(json) as unknown;
  if (!isPlainObject(parsed)) {
    throw new Error("Unexpected artifacts response");
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

export async function runGhCommand(args: readonly string[]): Promise<string> {
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

export async function findTelemetryFiles(directory: string): Promise<string[]> {
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

export async function readTelemetryEvents(filePath: string): Promise<TelemetryEvent[]> {
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

export function isWorkflowRunSummary(value: unknown): value is WorkflowRunSummary {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.databaseId === "number" && Number.isFinite(value.databaseId);
}

export function isWorkflowArtifact(value: unknown): value is WorkflowArtifact {
  if (!isPlainObject(value)) {
    return false;
  }
  return typeof value.name === "string" && value.name.length > 0;
}

export function isTelemetryEvent(value: unknown): value is TelemetryEvent {
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

export function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9-_]+/g, "-");
}
