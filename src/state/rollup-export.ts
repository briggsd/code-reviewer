import type { JsonValue } from "../contracts/common.ts";
import type { TelemetryEvent } from "../contracts/telemetry.ts";
import { NON_REAL_RUNTIME_KINDS } from "../runtime/runtime-kind.ts";
import {
  type AgentTokenAggregate,
  type RunMetricsRollup,
  rollupRunMetrics,
} from "./run-metrics-rollup.ts";

/**
 * Runtime kinds whose run-level telemetry is deterministic noise (0 tokens / 0 findings) and
 * must never reach a remote collector or the fleet dataset (#194). Mirrors the analysis-side
 * `NON_REAL_RUNTIME_KIND_SET` in run-metrics-analyze.ts so egress and analysis agree on what
 * "real" means.
 */
const NON_REAL_RUNTIME_KIND_SET: ReadonlySet<string> = new Set(NON_REAL_RUNTIME_KINDS);

export const ROLLUP_EXPORT_SCHEMA_VERSION = "ai-review.rollup_export.v1";

/**
 * Exportable rollup record — counts-only, shape-bounded, schema-versioned.
 *
 * All `Record<string, …>` keys in the nested `rollup` are shape-bounded before
 * the export is assembled (see `AGGREGATE_KEY_PATTERN`). Keys that fail the
 * pattern are merged into the `__other__` bucket (`SANITIZED_KEY_BUCKET`) so
 * counts are preserved but free-text, prompt fragments, or secret-shaped
 * strings can never reach an export destination.
 *
 * M008 rule: telemetry exports carry counts, shape-bounded keys, and stable
 * identifiers only — never raw prompts, diff text, finding bodies, or
 * user-controlled content.
 */
export interface RollupExport {
  schemaVersion: typeof ROLLUP_EXPORT_SCHEMA_VERSION;
  /** ISO-8601 timestamp, caller-supplied so the function stays pure/testable. */
  generatedAt: string;
  runCount: number;
  /** Sorted, deduplicated list of exportable event types that contributed. */
  sourceEventTypes: string[];
  /** Unique, shape-bounded repository slugs from contributing events. */
  repositories: string[];
  /**
   * Present only when one or more repository values from contributing events
   * failed the slug shape check and were dropped (counts-only observability of
   * the egress boundary itself).
   */
  droppedRepositoryCount?: number;
  /**
   * Present only when one or more aggregate Record keys failed the shape check
   * and had their counts folded into the `__other__` bucket (the aggregate-key
   * sibling of `droppedRepositoryCount` — lets an operator see the boundary
   * fired without learning the rejected content).
   */
  sanitizedAggregateKeyCount?: number;
  /** Aggregate rollup with all Record keys shape-bounded. */
  rollup: RunMetricsRollup;
}

/**
 * Conservative identifier pattern for aggregate Record keys.
 *
 * Allows well-formed runtime kinds, reviewer roles, risk tiers, and decision
 * labels (e.g. `pi`, `security`, `compliance_v2`, `no_findings`, `full`).
 * Rejects free text, newlines, prompt fragments, long strings, and
 * secret-shaped values.
 *
 * This is intentionally NOT a closed value set — any well-formed future
 * runtime kind or reviewer role passes automatically, preserving extensibility
 * without requiring schema changes.
 */
const AGGREGATE_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/**
 * Overflow bucket for shape-rejected aggregate keys. Starts with `_`, which
 * `AGGREGATE_KEY_PATTERN` rejects — so no legitimate runtime kind, reviewer
 * role, or decision label can ever collide with it (a real key literally named
 * `other` passes the pattern and is preserved untouched).
 */
export const SANITIZED_KEY_BUCKET = "__other__";

/**
 * Shape pattern for repository slugs (`owner/repo`). Each segment must START
 * with an alphanumeric — leading dots/dashes are rejected so traversal-shaped
 * (`../..`) and hidden-directory-shaped (`.hidden/repo`) values never reach an
 * export, in case a downstream consumer builds paths/URLs from slugs.
 */
const REPO_SLUG_PATTERN = /^[A-Za-z0-9][\w.-]{0,99}\/[A-Za-z0-9][\w.-]{0,99}$/;

/**
 * Exportable event type allowlist.
 *
 * `ai_review.run_metrics` — primary aggregate event; fully aggregated into
 * `rollup` by `rollupRunMetrics`.
 *
 * `ai_review.run_event` — emitted as of issue #20 (S04–S06), #22 (phase 2),
 * and M023 S01 (#257).
 *
 * Emitted subtypes and their counts-only payloads:
 *
 * - `run.start` (every run): repository slug, changeId, riskTier,
 *   selectedReviewerRoles (array of role identifiers), modelIds (unique
 *   sorted array of model identifier strings). No free text.
 *
 * - `run.completed` (completed runs only): repository, riskTier, decision,
 *   outcome, durationMs, findingCount, findingsBySeverity (counts),
 *   findingsByReviewer (counts), tokens? (input/output/cacheRead/cacheWrite/
 *   estimatedCostUsd numbers). No free text, no diff, no finding bodies.
 *
 * - `run.correction` (when prior-state comparison or acknowledged findings
 *   exist): repository, riskTier, newFindingCount, recurringFindingCount,
 *   fixedFindingCount, withheldFindingCount, acceptanceByReviewer (per-
 *   reviewer accepted/notAccepted/rejected/withheldExcluded counts). No
 *   free text. Note: acceptanceByReviewer keys are model-authored and stay
 *   verbatim at emission; the egress boundary shape-bounds them at export.
 *   A Record key derived from runId must satisfy `AGGREGATE_KEY_PATTERN`
 *   (letter-first) or its counts fold into `__other__` — design avoids
 *   runId-keyed aggregates; if ever needed prefix with `run-`.
 *
 * - `run.override`: break-glass override marker (#22 phase 2). Contains only
 *   stable identifiers and timestamps. No free text.
 *
 * - `run.prior_decision_respected`: merge-state observation for a prior
 *   blocking run (#257). Contains repository, changeId, riskTier,
 *   priorDecision/priorOutcome/priorBlocked, merged, and overrideRecorded.
 *   No PR title/body, comments, author names, branch names, finding text, or
 *   override reasons.
 *
 * NOTE: `ai_review.run_event` events contribute to `sourceEventTypes` and
 * `repositories` when present but are NOT aggregated into `rollup` — rollup
 * remains run_metrics-only. Acceptance and merge-despite-fail analysis are at
 * the telemetry:analyze level (src/state/run-metrics-analyze.ts). Future work
 * must stay inside this boundary: counts, stable identifiers, shape-bounded
 * keys only (M008).
 *
 * Adding a new exportable type here is sufficient to allow it through the
 * egress filter; no other change is required.
 */
export const EXPORTABLE_EVENT_TYPES = Object.freeze([
  "ai_review.run_metrics",
  // Reserved (ai-review.rollup_export.v1, issue #20 S04 + #22 phase 2):
  // emitted-but-not-yet-aggregated event types pass the type filter so future
  // emission lands INSIDE this boundary from day one.
  "ai_review.run_event",
] as const);

/**
 * Build a schema-versioned, counts-only export from a stream of telemetry
 * events.
 *
 * Pure function: no I/O, no `Date.now()`. Pass `new Date().toISOString()` from
 * the calling script.
 *
 * Events whose type is not in `EXPORTABLE_EVENT_TYPES` are filtered out
 * entirely — their fields never reach the export.
 *
 * All `Record<string, number>` / `Record<string, AgentTokenAggregate>` keys
 * in the rollup are shape-bounded by `AGGREGATE_KEY_PATTERN` before being
 * included. Offending keys have their counts preserved under
 * `SANITIZED_KEY_BUCKET` (multiple offenders merge into one bucket), counted
 * in `sanitizedAggregateKeyCount`.
 *
 * @throws when `generatedAt` is not a parseable timestamp.
 */
export function createRollupExport(
  events: readonly TelemetryEvent[],
  generatedAt: string,
): RollupExport {
  if (!Number.isFinite(new Date(generatedAt).getTime())) {
    throw new Error(
      `createRollupExport: generatedAt must be a parseable timestamp, got ${JSON.stringify(generatedAt)}`,
    );
  }
  const exportableSet = new Set<string>(EXPORTABLE_EVENT_TYPES);
  const filteredEvents = events.filter((e) => exportableSet.has(e.type));

  const rollup = rollupRunMetrics(filteredEvents);

  // Collect repository slugs from all contributing events (any exportable type).
  const repoSlugSet = new Set<string>();
  let droppedRepositoryCount = 0;
  for (const event of filteredEvents) {
    const repo = event.data?.repository;
    if (typeof repo === "string" && repo.length > 0) {
      if (REPO_SLUG_PATTERN.test(repo)) {
        repoSlugSet.add(repo);
      } else {
        droppedRepositoryCount += 1;
      }
    }
  }

  // Collect which exportable event types actually appear in the stream.
  const seenTypes = new Set<string>();
  for (const event of filteredEvents) {
    seenTypes.add(event.type);
  }
  const sourceEventTypes = [...seenTypes].sort();
  const repositories = [...repoSlugSet].sort();

  const bounded = shapeBoundRollup(rollup);

  return {
    schemaVersion: ROLLUP_EXPORT_SCHEMA_VERSION,
    generatedAt,
    runCount: rollup.runCount,
    sourceEventTypes,
    repositories,
    ...(droppedRepositoryCount > 0 ? { droppedRepositoryCount } : {}),
    ...(bounded.sanitizedKeyCount > 0
      ? { sanitizedAggregateKeyCount: bounded.sanitizedKeyCount }
      : {}),
    rollup: bounded.rollup,
  };
}

// ---------------------------------------------------------------------------
// Shape-bounding helpers
// ---------------------------------------------------------------------------

function isValidKey(key: string): boolean {
  return AGGREGATE_KEY_PATTERN.test(key);
}

interface BoundedRecord<T> {
  record: Record<string, T>;
  sanitizedKeyCount: number;
}

/**
 * Shape-bound a `Record<string, number>`: keep valid keys as-is; merge
 * offending keys' values into the `__other__` bucket. The bucket name fails
 * `AGGREGATE_KEY_PATTERN` by construction, so a legitimate key cannot collide.
 */
function boundNumberRecord(record: Record<string, number>): BoundedRecord<number> {
  const result: Record<string, number> = {};
  let otherCount = 0;
  let sanitizedKeyCount = 0;

  for (const [key, value] of Object.entries(record)) {
    if (isValidKey(key)) {
      result[key] = value;
    } else {
      otherCount += value;
      sanitizedKeyCount += 1;
    }
  }

  if (sanitizedKeyCount > 0) {
    result[SANITIZED_KEY_BUCKET] = otherCount;
  }

  return { record: result, sanitizedKeyCount };
}

/**
 * Shape-bound a `Record<string, AgentTokenAggregate>`: keep valid keys as-is;
 * merge offending keys' aggregates (by summing all fields) into `__other__`.
 */
function boundAgentRecord(
  record: Record<string, AgentTokenAggregate>,
): BoundedRecord<AgentTokenAggregate> {
  const result: Record<string, AgentTokenAggregate> = {};
  let otherAggregate: AgentTokenAggregate | undefined;
  let sanitizedKeyCount = 0;

  for (const [key, value] of Object.entries(record)) {
    if (isValidKey(key)) {
      result[key] = { ...value };
    } else {
      sanitizedKeyCount += 1;
      if (otherAggregate === undefined) {
        otherAggregate = {
          callCount: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheWriteTokens: 0,
          totalEstimatedCostUsd: 0,
        };
      }
      otherAggregate.callCount += value.callCount;
      otherAggregate.totalInputTokens += value.totalInputTokens;
      otherAggregate.totalOutputTokens += value.totalOutputTokens;
      otherAggregate.totalCacheReadTokens += value.totalCacheReadTokens;
      otherAggregate.totalCacheWriteTokens += value.totalCacheWriteTokens;
      otherAggregate.totalEstimatedCostUsd += value.totalEstimatedCostUsd;
    }
  }

  if (otherAggregate !== undefined) {
    result[SANITIZED_KEY_BUCKET] = otherAggregate;
  }

  return { record: result, sanitizedKeyCount };
}

/**
 * EGRESS BOUNDARY — constructs the bounded rollup field-by-field with NO
 * object spreads, deliberately: adding a new field to `RunMetricsRollup`
 * (especially a new `Record`) must fail compilation here so it cannot bypass
 * shape-bounding silently. Keep this exhaustive; do not "simplify" to spreads.
 */
function shapeBoundRollup(rollup: RunMetricsRollup): {
  rollup: RunMetricsRollup;
  sanitizedKeyCount: number;
} {
  const runtimeCounts = boundNumberRecord(rollup.runtimeCounts);
  const riskTierCounts = boundNumberRecord(rollup.riskTierCounts);
  const decisionCounts = boundNumberRecord(rollup.decisionCounts);
  const byReviewer = boundNumberRecord(rollup.findings.byReviewer);
  const agentRetryCountsByRole = boundNumberRecord(rollup.retries.agentRetryCountsByRole);
  const failureRetryCountsByRole = boundNumberRecord(rollup.retries.failureRetryCountsByRole);
  const byRole = boundAgentRecord(rollup.tokens.byRole);

  const sanitizedKeyCount =
    runtimeCounts.sanitizedKeyCount +
    riskTierCounts.sanitizedKeyCount +
    decisionCounts.sanitizedKeyCount +
    byReviewer.sanitizedKeyCount +
    agentRetryCountsByRole.sanitizedKeyCount +
    failureRetryCountsByRole.sanitizedKeyCount +
    byRole.sanitizedKeyCount;

  const bounded: RunMetricsRollup = {
    runCount: rollup.runCount,
    runtimeCounts: runtimeCounts.record,
    riskTierCounts: riskTierCounts.record,
    decisionCounts: decisionCounts.record,
    findings: {
      total: rollup.findings.total,
      byReviewer: byReviewer.record,
    },
    retries: {
      agentRetryCount: rollup.retries.agentRetryCount,
      agentRetryCountsByRole: agentRetryCountsByRole.record,
      failureRetryCount: rollup.retries.failureRetryCount,
      failureRetryCountsByRole: failureRetryCountsByRole.record,
      failureCount: rollup.retries.failureCount,
      retryableFailureCount: rollup.retries.retryableFailureCount,
    },
    tokens: {
      totalAgentCount: rollup.tokens.totalAgentCount,
      totalInputTokens: rollup.tokens.totalInputTokens,
      totalOutputTokens: rollup.tokens.totalOutputTokens,
      totalCacheReadTokens: rollup.tokens.totalCacheReadTokens,
      totalCacheWriteTokens: rollup.tokens.totalCacheWriteTokens,
      totalEstimatedCostUsd: rollup.tokens.totalEstimatedCostUsd,
      byRole: byRole.record,
    },
    yield: {
      findingsPerRun: rollup.yield.findingsPerRun,
      inputTokensPerFinding: rollup.yield.inputTokensPerFinding,
      outputTokensPerFinding: rollup.yield.outputTokensPerFinding,
      costPerFindingUsd: rollup.yield.costPerFindingUsd,
    },
  };

  return { rollup: bounded, sanitizedKeyCount };
}

// ---------------------------------------------------------------------------
// Per-event egress projection (streaming sibling of createRollupExport)
// ---------------------------------------------------------------------------

/**
 * Project a single telemetry event for streaming egress (e.g. a remote
 * TelemetryTransport, #51). The streaming counterpart of `createRollupExport`:
 * where that aggregates a batch into one shape-bounded rollup record, this
 * shape-bounds ONE event in place so it can be sent live.
 *
 * Enforced here (reusing this module's own boundary primitives so the
 * security-critical patterns are never duplicated):
 *   • TYPE allowlist — returns `null` for any type not in
 *     `EXPORTABLE_EVENT_TYPES`, so its fields never leave the process.
 *   • NON-REAL RUNTIME drop (#194) — a `run_metrics` event whose `runtime` is
 *     a non-real kind (dummy / deterministic) returns `null`, so dry-run/test
 *     noise never reaches a remote collector or the fleet dataset. run_event
 *     subtypes carry no `runtime` and are not filtered here (their dummy orphans
 *     are dropped downstream by runId-correlation in run-metrics-analyze).
 *   • KEY shape-bounding — every `data` Record key (recursively) must satisfy
 *     `AGGREGATE_KEY_PATTERN`; model-authored / free-text-shaped keys are
 *     DROPPED (the streaming analogue of folding into `__other__` — there is no
 *     batch count to preserve for a live value, so the conservative move is to
 *     drop, not bucket).
 *   • REPO SLUG shape — a `repository` value failing `REPO_SLUG_PATTERN` is
 *     dropped.
 *   • TOP-LEVEL scalar fields — `timestamp` must be ISO-8601 (a malformed one
 *     means a malformed event → the whole event is dropped, returning `null`);
 *     a `runId` failing `RUN_ID_PATTERN` is omitted. These envelope fields are
 *     not part of `data`, so they are validated explicitly here rather than via
 *     `boundEgressData`.
 *
 * NOT YET enforced — the open boundary-completion task gated on #51 promotion:
 *   • VALUE-level free-text allowlisting. `createRollupExport` is safe-by-
 *     construction because it emits an EXHAUSTIVE allowlisted field structure
 *     (no spreads); a per-event projection cannot enumerate unknown future
 *     fields, so a string VALUE on an allowlisted key still passes. Today's
 *     exportable events (#48) are counts-only by construction, so this is
 *     defense-in-depth, not the sole guard — but a real #51 promotion must
 *     close this (likely a per-event-type field allowlist) before shipping
 *     events that could carry model-authored free text.
 */
export function projectEventForEgress(event: TelemetryEvent): TelemetryEvent | null {
  if (!(EXPORTABLE_EVENT_TYPES as readonly string[]).includes(event.type)) {
    return null;
  }

  // #194: drop non-real-runtime run_metrics at the egress boundary so dummy/dry-run runs (the
  // #131 CI smoke job — 0 tokens / 0 findings, ~half the dataset) never reach a remote collector
  // or the fleet dataset and skew real-runtime aggregates (e.g. falsely firing thinReviewRate).
  // The dry-run JOB is unaffected; only its remote telemetry is suppressed, and the local
  // telemetry.jsonl still keeps dummy events for debugging (this is send-side only). Because
  // fleet-ingest re-runs this projection on receive, the same drop applies "never trust the
  // sender" on ingest. Only run_metrics carries `runtime`; run_event subtypes do not, and their
  // dummy orphans are already ignored downstream by runId-correlation in run-metrics-analyze, so
  // threading their runtime is out of this boundary's scope. Drop ONLY on an explicit non-real
  // match — a missing/odd runtime falls through and ships, so real telemetry is never silently lost.
  if (event.type === "ai_review.run_metrics" && isNonRealRuntimeRunMetrics(event)) {
    return null;
  }

  // Top-level envelope fields are not part of `data`, so shape-check them here. A non-ISO
  // timestamp is a malformed event — drop it rather than egress an unvalidated value.
  if (!ISO_8601_PATTERN.test(event.timestamp)) {
    return null;
  }
  const runIdValid = event.runId !== undefined && RUN_ID_PATTERN.test(event.runId);

  const boundedData = event.data === undefined ? undefined : boundEgressData(event.data);

  return {
    type: event.type,
    timestamp: event.timestamp,
    ...(runIdValid ? { runId: event.runId as string } : {}),
    ...(boundedData !== undefined ? { data: boundedData } : {}),
  };
}

/** ISO-8601 datetime (matches `new Date().toISOString()` output, plus offset forms). */
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Conservative run-id shape: alphanumeric-first, then word/dot/colon/dash. Rejects free text. */
const RUN_ID_PATTERN = /^[A-Za-z0-9][\w.:-]{0,127}$/;

/**
 * Recursively drop shape-failing keys from an egress `data` record. Nested
 * plain objects recurse; arrays and scalars pass through (arrays of identifier
 * strings — e.g. `modelIds`, reviewer roles — are legitimate counts-only
 * payloads). See `projectEventForEgress` for the value-level caveat.
 */
function boundEgressData(record: Record<string, JsonValue>): Record<string, JsonValue> {
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isValidKey(key)) {
      continue;
    }
    if (key === "repository" && typeof value === "string" && !REPO_SLUG_PATTERN.test(value)) {
      continue;
    }
    out[key] = isPlainJsonObject(value) ? boundEgressData(value) : value;
  }
  return out;
}

function isPlainJsonObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when a run_metrics event's `runtime` is an explicit non-real kind (dummy / deterministic).
 * Conservative by design: only a string value present in the non-real set returns true, so a
 * run_metrics event with a missing or non-string runtime is NOT treated as non-real and still
 * egresses — the boundary drops known noise, never real telemetry on absence.
 */
function isNonRealRuntimeRunMetrics(event: TelemetryEvent): boolean {
  const runtime = event.data?.runtime;
  return typeof runtime === "string" && NON_REAL_RUNTIME_KIND_SET.has(runtime);
}
