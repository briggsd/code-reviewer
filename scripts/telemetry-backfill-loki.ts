#!/usr/bin/env bun

// Backfill historical telemetry from CI artifacts into Loki, so a Grafana dashboard shows the
// full PR-review evolution rather than only newly-emitted runs.
//
// It replays each collected event through the SAME pipeline the live runner uses (cli.ts):
//   collectTelemetryEvents (gh artifact download)  →  CountsOnlyTelemetryTransport (#50 egress
//   boundary)  →  createLokiTelemetryTransport (Loki wire shape, low-card labels).
// Each event keeps its ORIGINAL timestamp (the Loki transport derives the ns timestamp from
// event.timestamp), so history lands on the real timeline.
//
// Idempotent: Loki silently drops exact-duplicate entries (same stream labels + ns timestamp +
// identical line), and the counts-only projection is deterministic — so re-running ships only
// genuinely new events. Re-runs are safe.
//
//   bun run scripts/telemetry-backfill-loki.ts --runs 100            # ship
//   bun run scripts/telemetry-backfill-loki.ts --runs 100 --dry-run  # preview only, no egress
//
// Requires: authed `gh` (artifact download) and AI_REVIEW_LOKI_{URL, BASIC_AUTH|AUTHORIZATION}.

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRemoteEndpoint } from "../src/cli/telemetry-auth.ts";
import type { TelemetryEvent } from "../src/contracts/index.ts";
import { resolveAuthorization } from "../src/state/http-telemetry-transport.ts";
import { CountsOnlyTelemetryTransport, createLokiTelemetryTransport } from "../src/state/index.ts";
import {
  findTelemetryFiles,
  listRunArtifacts,
  listWorkflowRuns,
  readTelemetryEvents,
  runGhCommand,
  sanitizeName,
} from "./telemetry-artifacts.ts";

interface CollectResult {
  events: TelemetryEvent[];
  telemetryFileCount: number;
  okArtifacts: number;
  failedArtifacts: number;
}

// A resilience-first variant of collectTelemetryEvents: it tolerates a per-run/per-artifact gh
// failure (e.g. a single artifact whose zip fails to extract) and keeps going, where the shared
// collector aborts the whole sweep on the first error. A 100-run backfill must not be sunk by one
// bad artifact. The temp dir name includes the artifact index so two artifacts whose names
// sanitize to the same slug can't collide on disk.
async function collectResilient(runLimit: number): Promise<CollectResult> {
  const runs = await listWorkflowRuns(runLimit);
  const tempDirectory = await mkdtemp(join(tmpdir(), "ai-review-backfill-"));
  const events: TelemetryEvent[] = [];
  let telemetryFileCount = 0;
  let okArtifacts = 0;
  let failedArtifacts = 0;

  try {
    for (const run of runs) {
      let artifacts: Awaited<ReturnType<typeof listRunArtifacts>>;
      try {
        artifacts = await listRunArtifacts(run.databaseId);
      } catch (error) {
        process.stderr.write(`  skip run ${run.databaseId}: ${(error as Error).message}\n`);
        continue;
      }
      const telemetryArtifacts = artifacts.filter(
        (artifact) => artifact.name.startsWith("ai-review") && artifact.expired !== true,
      );

      for (const [index, artifact] of telemetryArtifacts.entries()) {
        const artifactDirectory = join(
          tempDirectory,
          `${run.databaseId}-${index}-${sanitizeName(artifact.name)}`,
        );
        await mkdir(artifactDirectory, { recursive: true });
        try {
          await runGhCommand([
            "run",
            "download",
            String(run.databaseId),
            "--name",
            artifact.name,
            "--dir",
            artifactDirectory,
          ]);
        } catch (error) {
          failedArtifacts += 1;
          process.stderr.write(
            `  skip artifact ${artifact.name} (run ${run.databaseId}): ${(error as Error).message.split("\n")[0]}\n`,
          );
          continue;
        }
        okArtifacts += 1;

        const telemetryFiles = await findTelemetryFiles(artifactDirectory);
        for (const telemetryFile of telemetryFiles) {
          telemetryFileCount += 1;
          for (const fileEvent of await readTelemetryEvents(telemetryFile)) {
            events.push(fileEvent);
          }
        }
      }
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  return { events, telemetryFileCount, okArtifacts, failedArtifacts };
}

function readNumberFlag(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return fallback;
  }
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Parse repeatable `--label key=value` flags into a static-label object handed to the Loki
// transport. Backfilled history is routed into its OWN label namespace (e.g. backfill="ci") so it
// lands in FRESH streams instead of contending with live data: Loki rejects an entry that is "too
// far behind" the newest timestamp already in its exact stream (~1h out-of-order window), so
// replaying old history into a stream that already holds newer live events fails. A distinct label
// gives the history empty streams where an ascending replay is always accepted.
function readLabelFlags(): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] !== "--label") {
      continue;
    }
    if (i + 1 >= process.argv.length) {
      throw new Error("--label expects a key=value value but none followed");
    }
    const raw = process.argv[i + 1] ?? "";
    const eq = raw.indexOf("=");
    if (eq <= 0 || eq === raw.length - 1) {
      throw new Error(`--label expects key=value, got "${raw}"`);
    }
    labels[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return labels;
}

/** Stable identity of an event as stored in Loki: runId + type + timestamp + run-event subtype. */
function eventKey(event: TelemetryEvent): string {
  const subtype = event.data === undefined ? "" : String(event.data.event ?? "");
  return `${event.runId ?? ""}|${event.type}|${event.timestamp}|${subtype}`;
}

/**
 * Fetch the identity keys of events ALREADY in Loki across [startMs, endMs], so a re-run ships
 * only genuinely-missing events (no double-count when some already landed in shared streams).
 * Best-effort: on any query failure we warn and return an empty set (ship everything) rather than
 * abort — losing the skip optimization is preferable to losing the backfill.
 */
async function fetchPresentKeys(
  baseUrl: string,
  authHeader: string | undefined,
  startMs: number,
  endMs: number,
): Promise<Set<string>> {
  const keys = new Set<string>();
  // Loki caps a single query_range response at this many entries. If the window holds more than
  // PRESENT_QUERY_LIMIT prior events the response is silently truncated — a truncated present-set
  // looks identical to a smaller one, so we'd miss keys and re-ship them. We can't tell "exactly
  // LIMIT events" from "LIMIT-and-more" without paging, so we warn whenever the cap is hit and let
  // the operator decide (narrow the window, or accept that some events may double-ship).
  const PRESENT_QUERY_LIMIT = 5000;
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/loki/api/v1/query_range`);
  url.searchParams.set("query", '{service="ai-code-review"}');
  url.searchParams.set("start", `${BigInt(startMs) * 1_000_000n}`);
  url.searchParams.set("end", `${BigInt(endMs) * 1_000_000n}`);
  url.searchParams.set("limit", String(PRESENT_QUERY_LIMIT));
  url.searchParams.set("direction", "forward");

  try {
    const headers: Record<string, string> = {};
    if (authHeader !== undefined) {
      headers.authorization = authHeader;
    }
    const response = await fetch(url, { headers });
    if (!response.ok) {
      process.stderr.write(`  warn: present-key query returned HTTP ${response.status}\n`);
      return keys;
    }
    const body = (await response.json()) as {
      data?: { result?: Array<{ values?: Array<[string, string]> }> };
    };
    let lineCount = 0;
    for (const stream of body.data?.result ?? []) {
      for (const [, line] of stream.values ?? []) {
        lineCount += 1;
        try {
          keys.add(eventKey(JSON.parse(line) as TelemetryEvent));
        } catch {
          // A non-JSON line (e.g. a smoke probe) has no event identity — ignore it.
        }
      }
    }
    if (lineCount >= PRESENT_QUERY_LIMIT) {
      process.stderr.write(
        `  warn: present-key query hit the ${PRESENT_QUERY_LIMIT}-entry cap — the skip-present set may be INCOMPLETE, so some events could double-ship. Narrow --runs or the time window for full idempotency.\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`  warn: present-key query failed: ${(error as Error).message}\n`);
  }
  return keys;
}

async function main(): Promise<void> {
  const runLimit = readNumberFlag("--runs", 50);
  const dryRun = process.argv.includes("--dry-run");
  const skipPresent = !process.argv.includes("--no-skip-present");
  const labels = readLabelFlags();

  // Resolve + validate the Loki endpoint exactly as cli.ts does (same env namespace, same
  // startup checks). Fail loudly before touching the network if it isn't configured.
  const loki = resolveRemoteEndpoint("AI_REVIEW_LOKI", process.env);
  if (loki === undefined) {
    throw new Error("AI_REVIEW_LOKI_URL is not set — nothing to backfill into");
  }

  const collected = await collectResilient(runLimit);
  let events = collected.events;
  const { telemetryFileCount, okArtifacts, failedArtifacts } = collected;

  // Defensive global time-ordering: collection groups by run, not by clock. Modern Loki accepts
  // out-of-order writes, but sorting keeps any single stream monotonic regardless.
  events.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const byType: Record<string, number> = {};
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1;
  }

  process.stderr.write(
    `\nCollected ${events.length} events from ${telemetryFileCount} telemetry file(s) across ${okArtifacts} artifact(s) (${failedArtifacts} artifact download(s) skipped).\n`,
  );
  process.stderr.write(`  by type: ${JSON.stringify(byType)}\n`);
  if (events.length > 0) {
    process.stderr.write(`  range:   ${events[0]?.timestamp} .. ${events.at(-1)?.timestamp}\n`);
  }

  // Skip events already in Loki so a re-run (or a corrective pass after a partial ship) ships only
  // genuinely-missing events — no double-count. Keyed by stable identity (runId+type+ts+subtype).
  if (skipPresent && events.length > 0) {
    const authHeader = resolveAuthorization(loki);
    const startMs = Date.parse(events[0]?.timestamp ?? "") - 60_000;
    const endMs = Date.parse(events.at(-1)?.timestamp ?? "") + 60_000;
    const present = await fetchPresentKeys(loki.url, authHeader, startMs, endMs);
    if (present.size > 0) {
      const before = events.length;
      events = events.filter((event) => !present.has(eventKey(event)));
      process.stderr.write(
        `  skip-present: ${present.size} already in Loki; shipping ${events.length} of ${before} missing.\n`,
      );
    }
  }

  if (Object.keys(labels).length > 0) {
    process.stderr.write(`  labels: ${JSON.stringify(labels)}\n`);
  }

  if (dryRun) {
    process.stderr.write("\nDry run — nothing shipped to Loki.\n");
    return;
  }
  if (events.length === 0) {
    process.stderr.write("\nNothing to ship (all events already present).\n");
    return;
  }

  const transport = new CountsOnlyTelemetryTransport(
    createLokiTelemetryTransport({
      url: loki.url,
      labelFromData: ["riskTier", "decision", "outcome"],
      ...(Object.keys(labels).length > 0 ? { labels } : {}),
      ...(loki.authorization !== undefined ? { authorization: loki.authorization } : {}),
      ...(loki.basicAuth !== undefined ? { basicAuth: loki.basicAuth } : {}),
    }),
  );

  let shipped = 0;
  let failed = 0;
  // Deliberately sequential, one POST per event (an ai-review finding flagged the O(N) round
  // trips). Kept on purpose for this one-off ops tool: (1) it reuses the EXACT live egress
  // pipeline unchanged — batching would mean either forking createLokiTelemetryTransport to pack
  // multiple values per stream, or sending concurrently, which risks out-of-order writes within a
  // stream (the very `entry too far behind` rejection this script works around); (2) skip-present
  // already trims re-runs to only-missing events, so steady-state volume is small. A backfill of a
  // few hundred events takes a couple of minutes — acceptable for a manual, infrequent operation.
  // If this ever ships tens of thousands of events, add an opt-in batched sender then.
  for (const event of events) {
    try {
      await transport.send(event);
      shipped += 1;
    } catch (error) {
      failed += 1;
      process.stderr.write(
        `  failed ${event.type} @ ${event.timestamp}: ${(error as Error).message}\n`,
      );
    }
  }
  await transport.close();

  process.stderr.write(`\nDone. Shipped ${shipped} event(s) to Loki, ${failed} failed.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
