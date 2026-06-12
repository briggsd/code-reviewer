import type { TelemetryEvent } from "../contracts/telemetry.ts";
import {
  type AgentTokenAggregate,
  type RunMetricsRollup,
  rollupRunMetrics,
} from "./run-metrics-rollup.ts";

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
 * `ai_review.run_event` — reserved for issues #20 (S04) and #22 (phase 2).
 * Planned subtypes and their counts-only payloads:
 *
 * - `run.start`: runId (identifier), repository slug, changeId (stable
 *   identifier), riskTier, selectedReviewerRoles (array of role identifiers),
 *   modelIds (array of model identifier strings). No free text.
 *
 * - `run.completed`: decision (identifier), outcome (pass/fail), durationMs
 *   (number), findings by severity/reviewer as counts, token totals as
 *   numbers. No free text, no diff, no finding bodies.
 *
 * - `run.correction`: cross-push correction counts keyed by runId (stable
 *   identifier → count). No free text. CAVEAT for the #20 implementor: a
 *   Record key derived from runId must satisfy `AGGREGATE_KEY_PATTERN`
 *   (letter-first) or its counts fold into `__other__` — runIds that can start
 *   with a digit (UUIDs, timestamp prefixes) must be prefixed (e.g. `run-`)
 *   before use as keys.
 *
 * - `run.override`: break-glass override marker (#22 phase 2). Contains only
 *   stable identifiers and timestamps. No free text.
 *
 * NOTE: `ai_review.run_event` events contribute to `sourceEventTypes` when
 * present in the stream but are NOT yet aggregated into `rollup` — that
 * aggregation is #20's slice. Future #20/#22 work must stay inside this
 * boundary: counts, stable identifiers, shape-bounded keys only (M008).
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
