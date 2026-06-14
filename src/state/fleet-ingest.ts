import { timingSafeEqual } from "node:crypto";

import type { JsonValue } from "../contracts/common.ts";
import type { TelemetryEvent } from "../contracts/telemetry.ts";
import { projectEventForEgress } from "./rollup-export.ts";

// ---------------------------------------------------------------------------
// Own-fleet telemetry fan-in (M016 S06, #136) — factory-side RECEIVE/aggregate.
//
// The receive counterpart of the #51 send side. Each repo in the owner's OWN fleet
// POSTs counts-only `run_metrics` (the #51 transport, egress-projected on the way out);
// this module accepts those POSTs, AUTHENTICATES them with a shared secret (own-fleet
// trusted — same owner), and RE-APPLIES the rollup-export.ts counts-only boundary on
// receive. The accepted events fold into the SAME dataset the S04 #132 quality report
// consumes, so the hypothesis queue reflects the whole fleet, not just this repo's PRs.
//
// LOAD-BEARING BOUNDARIES
//   • OWN-FLEET ONLY. This path authenticates with a single shared secret held by the
//     owner. Open third-party contribution to the factory signal is OUT OF SCOPE — a
//     hostile sender could skew quality hypotheses (the poisoning vector). Adopters who
//     want their own telemetry point #51 at THEIR OWN private backend; that never reaches
//     here. Secret rotation revokes the whole fleet at once, by design.
//   • NEVER TRUST THE SENDER TO HAVE FILTERED. The send side already egress-projects, but
//     this module re-runs `projectEventForEgress` on every received event regardless. A
//     payload carrying stray non-count fields (finding/diff/prompt/secret text, M008/#50)
//     is shape-bound away here — those fields never land in the fleet dataset. The boundary
//     is enforced at INGESTION, not assumed from the wire.
//   • FAIL-OPEN / NON-BLOCKING (inherited). Ingestion is decoupled from any repo's review:
//     an ingestion outage never blocks or fails a review. This module is pure (no network,
//     no clock); the CLI owns I/O and lifecycle, exactly like rollup-export.ts ↔ scripts.
// ---------------------------------------------------------------------------

/**
 * Per-payload, counts-only ingestion summary. Carries only counts and the shape-bounded
 * repository slugs that survived the boundary — never any rejected content, never a reason
 * string derived from payload bytes. This is itself an M008-safe artifact.
 */
export interface FleetIngestSummary {
  /** Events that passed the type allowlist + counts-only boundary and were accepted. */
  acceptedCount: number;
  /**
   * Events dropped entirely on receive: a non-exportable event type, a malformed
   * envelope (non-ISO timestamp), or a non-object line. Their fields never land.
   */
  rejectedEventCount: number;
  /**
   * Accepted events from which one or more stray (non-count-shaped) `data` keys were
   * shape-bound away on receive. Counts-only observability that the boundary fired on
   * an accepted event without recording the rejected content.
   */
  shapeBoundEventCount: number;
  /** Lines that were not valid JSON and were skipped. */
  malformedLineCount: number;
  /** Sorted, deduplicated shape-bounded repository slugs across accepted events. */
  repositories: string[];
}

export interface FleetIngestResult {
  /** The accepted, re-projected (counts-only) events, ready to append to the fleet dataset. */
  events: TelemetryEvent[];
  summary: FleetIngestSummary;
}

/** Repository-slug shape — kept in sync with rollup-export.ts (owner/repo, alnum-first segments). */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/;

/**
 * Receive-side STRING-VALUE allowlist for `run_metrics` data.
 *
 * `projectEventForEgress` (the send-side boundary) shape-bounds Record *keys* but, by its own
 * documented caveat, does NOT enforce VALUE-level free-text allowlisting — a string VALUE on an
 * allowlisted key (e.g. `secret: "sk-ant-…"`, or a key literally named `secret`) still passes.
 * The send side is safe-by-construction (its events are counts-only), but THIS path explicitly
 * does not trust the sender — so we close the value-level gap here.
 *
 * Every string value in an ingested `run_metrics` `data` block must be one of these stable
 * identifier/category fields; any other string is DROPPED on receive. Numbers, booleans, nested
 * count objects, and arrays of identifier strings pass. These are the only string fields the
 * downstream analyzers (`run-metrics-analyze.ts` / `run-metrics-rollup.ts`) actually read.
 */
const RUN_METRICS_STRING_VALUE_ALLOWLIST: ReadonlySet<string> = new Set([
  "runtime",
  "repository",
  "riskTier",
  "decision",
  "outcome",
  "changeId",
  "headSha",
]);

/** Shape pattern for an allowlisted stable-identifier string VALUE. Rejects free text / secrets. */
const STABLE_IDENTIFIER_VALUE_PATTERN = /^[A-Za-z0-9][\w.:/-]{0,127}$/;

/**
 * Authentication outcome — boolean-only, never echoes the supplied or expected secret.
 */
export type FleetAuthResult = { ok: true } | { ok: false; reason: "missing" | "mismatch" };

/**
 * Constant-time shared-secret check for an own-fleet ingestion request.
 *
 * `expected` is the factory-held shared secret (from the ingestion environment).
 * `presented` is the secret the sender supplied (e.g. a bearer token / `X-Fleet-Secret`
 * header value). Comparison is timing-safe so a caller cannot probe the secret byte-by-byte
 * via response latency. A length mismatch returns `mismatch` without leaking the length
 * through the timing of the compare (both branches do bounded work).
 *
 * OWN-FLEET ONLY: a single shared secret authenticates the entire owner fleet. There is no
 * per-repo identity here — that is the deliberate trust model (same owner). Do NOT extend
 * this to accept third-party-presented credentials; that reopens the poisoning vector.
 */
export function authenticateFleetRequest(
  expected: string | undefined,
  presented: string | undefined,
): FleetAuthResult {
  if (expected === undefined || expected.length === 0) {
    // No configured secret = ingestion is not enabled. Reject rather than accept-all.
    return { ok: false, reason: "missing" };
  }
  if (presented === undefined || presented.length === 0) {
    return { ok: false, reason: "missing" };
  }
  const expectedBytes = Buffer.from(expected, "utf8");
  const presentedBytes = Buffer.from(presented, "utf8");
  if (expectedBytes.length !== presentedBytes.length) {
    // timingSafeEqual throws on length mismatch; compare expected against itself to keep the
    // work (and thus timing) independent of the presented length, then report mismatch.
    timingSafeEqual(expectedBytes, expectedBytes);
    return { ok: false, reason: "mismatch" };
  }
  return timingSafeEqual(expectedBytes, presentedBytes)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/**
 * Ingest a raw newline-delimited JSON payload from an own-fleet sender, RE-APPLYING the
 * rollup-export.ts counts-only boundary to every event on receive.
 *
 * Mirrors the #51 wire shape (`defaultNdjsonFormat`: one JSON event per line). For each line:
 *   1. Parse JSON — non-JSON lines are skipped (`malformedLineCount`).
 *   2. Validate the telemetry-event envelope — non-conforming lines are rejected.
 *   3. Run `projectEventForEgress` (the SAME boundary the send side uses): a non-exportable
 *      event type or malformed envelope projects to `null` and the event is REJECTED entirely
 *      (`rejectedEventCount`); otherwise stray non-count `data` keys are shape-bound away and,
 *      when any were dropped, the event is counted in `shapeBoundEventCount`.
 *
 * Pure: no I/O, no clock. The caller (scripts/telemetry-ingest.ts) authenticates first, then
 * appends `result.events` to the fleet dataset the quality report reads.
 */
export function ingestFleetPayload(rawBody: string): FleetIngestResult {
  const events: TelemetryEvent[] = [];
  const repositories = new Set<string>();
  let rejectedEventCount = 0;
  let shapeBoundEventCount = 0;
  let malformedLineCount = 0;

  for (const line of rawBody.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLineCount += 1;
      continue;
    }

    if (!isTelemetryEvent(parsed)) {
      rejectedEventCount += 1;
      continue;
    }

    // RE-APPLY the send-side egress boundary on receive (type allowlist + KEY shape-bounding) —
    // never trust the sender to have filtered.
    const projected = projectEventForEgress(parsed);
    if (projected === null) {
      // Non-exportable type or malformed envelope: drop the whole event, its fields never land.
      rejectedEventCount += 1;
      continue;
    }

    // Then close the VALUE-level gap the send side documents-but-defers: drop any string value
    // that is not an allowlisted stable identifier. This is the receive-only hardening that
    // makes ingestion safe even when the sender is hostile/buggy (the #136 boundary).
    const valueBounded = boundStringValues(projected);

    // The event was shape-bound if EITHER pass dropped/altered anything (key-level OR value-level).
    if (keyCount(parsed.data) !== keyCount(valueBounded.data)) {
      shapeBoundEventCount += 1;
    }

    const repo = valueBounded.data?.repository;
    if (typeof repo === "string" && REPO_SLUG_PATTERN.test(repo)) {
      repositories.add(repo);
    }

    events.push(valueBounded);
  }

  return {
    events,
    summary: {
      acceptedCount: events.length,
      rejectedEventCount,
      shapeBoundEventCount,
      malformedLineCount,
      repositories: [...repositories].sort(),
    },
  };
}

/**
 * Receive-only VALUE-level boundary: drop any string value in a `run_metrics` `data` block that
 * is not an allowlisted, shape-conforming stable identifier. This is the hardening the send-side
 * `projectEventForEgress` documents-but-defers (it bounds keys, not values) — applied here
 * because the fleet path explicitly does not trust the sender. Numbers/booleans/null and nested
 * count objects pass; arrays of identifier strings pass (e.g. `modelIds`, reviewer-role lists),
 * with non-conforming string elements dropped. Returns a new event; never mutates the input.
 */
function boundStringValues(event: TelemetryEvent): TelemetryEvent {
  if (event.data === undefined) {
    return event;
  }
  return {
    type: event.type,
    timestamp: event.timestamp,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    data: boundDataValues(event.data),
  };
}

function boundDataValues(record: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      // A string survives only on an allowlisted identifier key AND if it is itself shape-clean.
      if (
        RUN_METRICS_STRING_VALUE_ALLOWLIST.has(key) &&
        STABLE_IDENTIFIER_VALUE_PATTERN.test(value)
      ) {
        out[key] = value;
      }
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.filter(
        (element): element is JsonValue =>
          typeof element !== "string" || STABLE_IDENTIFIER_VALUE_PATTERN.test(element),
      );
      continue;
    }
    if (isPlainObject(value)) {
      out[key] = boundDataValues(value);
      continue;
    }
    // number | boolean | null — counts-only by nature, pass through.
    out[key] = value;
  }
  return out;
}

function keyCount(record: Record<string, JsonValue> | undefined): number {
  if (record === undefined) {
    return 0;
  }
  let total = 0;
  for (const value of Object.values(record)) {
    total += 1;
    if (isPlainObject(value)) {
      total += keyCount(value);
    }
  }
  return total;
}

function isTelemetryEvent(value: unknown): value is TelemetryEvent {
  if (!isPlainObject(value)) {
    return false;
  }
  if (typeof value.type !== "string" || typeof value.timestamp !== "string") {
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
