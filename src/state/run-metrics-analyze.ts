import type { JsonValue } from "../contracts/common.ts";
import type { TelemetryEvent } from "../contracts/telemetry.ts";
import { assessThinReview } from "../runner/thin-review.ts";
import { NON_REAL_RUNTIME_KINDS } from "../runtime/runtime-kind.ts";

// Local copies of asNumber/isPlainObject/incrementMap — intentional local copy,
// do NOT import from run-metrics-rollup.ts (keep each analytics module self-contained,
// mirroring the evidence-grounding.ts ↔ stable-finding-id.ts precedent).

const NON_REAL_RUNTIME_KIND_SET: ReadonlySet<string> = new Set(NON_REAL_RUNTIME_KINDS);

// Thin-review classification is now contextual (implemented in #91), delegated to
// assessThinReview() in src/runner/thin-review.ts. The contextual floor depends on
// riskTier and reviewedFileCount: trivial is never flagged, lite uses 60*fileCount,
// full uses 300 + 60*fileCount. See thin-review.ts for calibration notes.
//
// LEGACY events: pre-#91 run_metrics events do NOT carry `reviewedFileCount`. Passing
// the field's absence through as 0 would give a lite-tier floor of 60*0 = 0, silently
// classifying every historical lite run as not-thin and breaking comparability across
// the #91 boundary. So when the field is absent we fall back to LEGACY_FLAT_THIN_FLOOR
// (the pre-#91 flat floor), keeping historical analyze output stable; events that carry
// the field use the contextual floor.
//
// The --thin-floor CLI flag (thinReviewOutputTokenFloor option) provides a flat-floor
// override that wins for ALL events; its CLI-side default lives in
// scripts/telemetry-analyze.ts.
const LEGACY_FLAT_THIN_FLOOR = 250;

export interface AnalyzeOptions {
  /** Flat-floor override: output-token count below which a non-trivial run is considered "thin".
   *  Default is the contextual tier/diff-size floor from assessThinReview() in thin-review.ts.
   *  Trivial-tier runs are never flagged regardless of this value. */
  thinReviewOutputTokenFloor?: number;
}

export interface TierSegment {
  runCount: number;
  findingsPerRun: number;
  outputTokensPerRun: number;
  inputTokensPerRun: number;
  cacheWriteTokensPerRun: number;
  cacheReadTokensPerRun: number;
  /** Fraction of total input tokens served from cache: cacheRead / (input + cacheRead + cacheWrite). null when denominator is 0 (no token data). */
  cacheHitRate: number | null;
  durationMsPerRun: number;
  /**
   * Average fan-out span ms per run (first reviewer dispatched → all settled) (#196).
   * Denominator is ALL runs in the tier. Fan-out runs on EVERY path (normal, short-circuit, and
   * all-reviewers-failed), so every post-#196 run contributes its real measured fanOutMs; only
   * pre-#196 historical events (which lack the field) contribute 0. This is a per-run
   * decomposition figure (it composes with fusionMsPerRun against coordinatorMs), NOT a
   * per-fan-out average. A tier dominated by pre-#196 events reads low — segment by date when
   * mixing old and new data.
   */
  fanOutMsPerRun: number;
  /**
   * Average coordinator fusion ms per run (post-fan-out synthesis call) (#196). Same all-runs
   * denominator as {@link fanOutMsPerRun}, but short-circuit / all-reviewers-failed runs run NO
   * synthesis and so contribute 0 (as do pre-#196 events) while still counting toward the
   * denominator — a tier with many short-circuit runs reads lower than the per-synthesis latency.
   */
  fusionMsPerRun: number;
  costPerRunUsd: number;
  /** null when there are 0 findings across all runs in this tier */
  costPerFindingUsd: number | null;
  thinReviewRunCount: number;
  thinReviewRate: number;
  /** null when there are 0 findings across all runs in this tier */
  outputTokensPerFinding: number | null;
}

export interface DecisionSegment {
  runCount: number;
  findingsPerRun: number;
  outputTokensPerRun: number;
  /** null when there are 0 findings across all runs in this decision segment */
  outputTokensPerFinding: number | null;
}

export interface ReviewerAcceptanceStat {
  accepted: number;
  notAccepted: number;
  rejected: number;
  withheldExcluded: number;
  /** accepted / (accepted + notAccepted + rejected); omitted when denominator is 0. */
  acceptanceRate?: number;
}

export interface RunEventsAnalysis {
  startCount: number;
  completedCount: number;
  correctionCount: number;
  /** completed / started; null when startCount is 0. */
  completionRate: number | null;
  /** Total run.override events observed. */
  overrideCount: number;
  /** overrideCount / startCount; null when startCount is 0. */
  overrideRate: number | null;
  /** Per-tier override counts (stable-sorted keys). */
  overrideCountByTier: Record<string, number>;
  /** Per-reviewer acceptance signal from correction events (directional). */
  acceptanceByReviewer: Record<string, ReviewerAcceptanceStat>;
  /** Per-tier acceptance signal from correction events (directional). */
  acceptanceByTier: Record<string, ReviewerAcceptanceStat>;
  /** Number of correction runs contributing acceptance data. */
  correctionRunCount: number;
  /**
   * Always true: this is a directional, longitudinal signal accumulated
   * across many runs — not a per-PR score.
   */
  directional: true;
}

interface ProseFindingDropAnalysis {
  droppedFindingCount: number;
  producedFindingCount: number;
}

interface SupplementalEventsAnalysis {
  runEvents?: RunEventsAnalysis;
  proseDrops: ProseFindingDropAnalysis;
}

/** Precision stats for a single reviewer or severity segment (#256, M023 S04). */
export interface DispositionPrecisionSegment {
  fixed: number;
  dismissed: number;
  ignored: number;
  acknowledged: number;
  /** fixed ÷ (fixed + ignored + dismissed); null when denominator is 0. */
  precision: number | null;
}

/** Pooled + segmented disposition outcome analysis (#256, M023 S04).
 *  Absent when no run has emitted a `dispositions` block (first-review-only fleet). */
export interface DispositionAnalysis {
  /** Pooled totals across all runs with disposition data. */
  pooled: DispositionPrecisionSegment;
  /** Per-reviewer breakdown (stable-sorted keys). */
  byReviewer: Record<string, DispositionPrecisionSegment>;
  /** Per-severity breakdown (stable-sorted keys). */
  bySeverity: Record<string, DispositionPrecisionSegment>;
}

export interface RunMetricsAnalysis {
  runCount: number;
  /** Runs whose run_metrics carried >=1 reviewer-kind failure (#212). */
  reviewerFailureRunCount: number;
  /** reviewerFailureRunCount / runCount; null when runCount is 0. */
  reviewerFailureRate: number | null;
  /** Per-role reviewer-failure run counts, stable-sorted keys (counts only). */
  reviewerFailureCountByRole: Record<string, number>;
  /** Per risk-tier aggregates (keys are tier names, e.g. "trivial", "lite", "full"). */
  byTier: Record<string, TierSegment>;
  /** Pooled cache-hit rate across ALL real runs (the headline number). null when no token data. */
  cacheHitRate: number | null;
  /** Pooled output-tokens-per-finding across ALL real runs (verbosity ratio). null when 0 findings across all runs. */
  outputTokensPerFinding: number | null;
  /** Total finding count per reviewer across all runs. */
  byReviewer: Record<string, number>;
  /** Each reviewer's fraction of total findings (0 when no findings). */
  reviewerShare: Record<string, number>;
  /** How many runs produced each decision value. */
  decisionCounts: Record<string, number>;
  /** Output-volume breakdown by decision value (stable-sorted keys). */
  byDecision: Record<string, DecisionSegment>;
  /** How many runs produced each CI outcome value. */
  outcomeCounts: Record<string, number>;
  rates: {
    /** Fraction of runs whose event carried a non-empty grounding block. */
    groundingDropRunRate: number;
    /**
     * Finding-level: demoted (ungrounded-with-quote) findings ÷ total produced
     * (surfaced + demoted), pooled across runs. A climbing rate signals grounding may be
     * over-demoting valid findings (#207 signal; complement to the run-level groundingDropRunRate).
     */
    groundingWithholdFindingRate: number;
    /**
     * Denominator behind groundingWithholdFindingRate: total findings produced (surfaced +
     * demoted) pooled across runs. The finding-level sample size for that rate — distinct from
     * runCount, which is the run-level sample size for groundingDropRunRate (#207).
     */
    groundingProducedFindingCount: number;
    /**
     * File-level: ignored/filtered files ÷ total changed files seen by risk classification
     * (reviewed + ignored). 0 when no file-count denominator is available.
     */
    diffFilterDropRate: number;
    /** Denominator behind diffFilterDropRate: reviewedFileCount + ignoredFileCount. */
    diffFilterFileCount: number;
    /**
     * Run-level: fraction of runs carrying patch-admission counts whose admission gate degraded
     * at least one file to name+stat-only.
     */
    patchAdmissionDegradedRate: number;
    /** Denominator behind patchAdmissionDegradedRate: runs with admission count data. */
    patchAdmissionSampleRunCount: number;
    /**
     * Run-level: fraction of runs carrying deletion-pruning counts with any hunk/file body pruned.
     */
    deletionPruningRate: number;
    /** Denominator behind deletionPruningRate: runs with deletion-pruning count data. */
    deletionPruningSampleRunCount: number;
    /**
     * Finding-level: prose-parser dropped findings ÷ total prose-parser produced findings
     * (surviving + dropped), pooled across agent.output events for real run_metrics runIds.
     */
    proseFindingDropRate: number;
    /** Denominator behind proseFindingDropRate: surviving + dropped prose findings. */
    proseProducedFindingCount: number;
    /** Fraction of runs whose event carried a non-empty locationBackfill block. */
    locationBackfillRunRate: number;
    /** Fraction of runs whose event carried a non-empty acknowledgements block. */
    acknowledgementRunRate: number;
    /** Fraction of non-trivial runs with output tokens below the thin-review floor. */
    thinReviewRate: number;
    /** Fraction of Pi agent-runs that delivered via the structured tool (pooled across runs). 0 when no run carried structured-output counts. */
    structuredOutputRate: number;
  };
  /** Pooled structured-vs-prose agent-run counts (M015 S05, #128). Absent when no real-runtime run carried the block. */
  structuredOutput?: { structuredCount: number; totalCount: number };
  /**
   * Run-event aggregates. Present only when run_event events exist in the
   * stream AND at least one run_event runId matches a real-runtime run_metrics
   * event (orphan run_events are ignored).
   */
  runEvents?: RunEventsAnalysis;
  /** Per-finding disposition outcome analysis (#256, M023 S04).
   *  Absent when no run has a dispositions block (first-review-only fleet). */
  dispositions?: DispositionAnalysis;
}

interface TierAccumulator {
  runCount: number;
  totalFindings: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  totalCacheWriteTokens: number;
  totalCacheReadTokens: number;
  totalDurationMs: number;
  totalFanOutMs: number;
  totalFusionMs: number;
  totalCostUsd: number;
  thinReviewRunCount: number;
}

interface DecisionAccumulator {
  runCount: number;
  totalFindings: number;
  totalOutputTokens: number;
}

interface RunMetricsEventData extends Record<string, JsonValue> {
  runtime?: string;
  riskTier?: string;
  reviewedFileCount?: number;
  decision?: string;
  outcome?: string;
  durationMs?: number;
  durationsMs?: Record<string, JsonValue>;
  findingCount?: number;
  findingsByReviewer?: Record<string, JsonValue>;
  tokens?: Record<string, JsonValue>;
  grounding?: Record<string, JsonValue>;
  context?: Record<string, JsonValue>;
  contextArtifacts?: Record<string, JsonValue>;
  ignoredFileCount?: number;
  locationBackfill?: Record<string, JsonValue>;
  acknowledgements?: Record<string, JsonValue>;
  structuredOutput?: Record<string, JsonValue>;
  failures?: JsonValue[];
  /** Per-finding disposition counts (#256, M023 S04). Absent on first review. */
  dispositions?: Record<string, JsonValue>;
}

type RunMetricsEvent = TelemetryEvent & { data: RunMetricsEventData };

interface RunEventData extends Record<string, JsonValue> {
  event?: string;
  riskTier?: string;
  acceptanceByReviewer?: Record<string, JsonValue>;
}

type RunEvent = TelemetryEvent & { data: RunEventData };

interface AgentOutputEventData extends Record<string, JsonValue> {
  findingCount?: number;
  droppedFindingCount?: number;
  structuredOutput?: boolean;
}

type AgentOutputEvent = TelemetryEvent & { data: AgentOutputEventData };

interface AccumulatedAcceptance {
  accepted: number;
  notAccepted: number;
  rejected: number;
  withheldExcluded: number;
}

// ─── per-event accumulation helpers ─────────────────────────────────────────

/** Accumulate decision and outcome counts from a single run_metrics event. */
function accumulateDecisionsAndOutcomes(
  data: RunMetricsEventData,
  decisionCounts: Map<string, number>,
  outcomeCounts: Map<string, number>,
): void {
  if (typeof data.decision === "string" && data.decision.length > 0) {
    incrementMap(decisionCounts, data.decision, 1);
  }
  if (typeof data.outcome === "string" && data.outcome.length > 0) {
    incrementMap(outcomeCounts, data.outcome, 1);
  }
}

/** Accumulate per-reviewer finding counts from a single run_metrics event.
 *  Returns the total findings in this run (for updating the tier accumulator). */
function accumulateFindingsByReviewer(
  data: RunMetricsEventData,
  findingsByReviewer: Map<string, number>,
): { runFindings: number; totalDelta: number } {
  const findingsRecord = data.findingsByReviewer;
  let runFindings = 0;
  let totalDelta = 0;
  if (findingsRecord !== undefined && isPlainObject(findingsRecord)) {
    for (const [reviewer, count] of Object.entries(findingsRecord)) {
      if (typeof count === "number" && Number.isFinite(count)) {
        incrementMap(findingsByReviewer, reviewer, count);
        runFindings += count;
        totalDelta += count;
      }
    }
  } else if (typeof data.findingCount === "number" && Number.isFinite(data.findingCount)) {
    runFindings = data.findingCount;
    totalDelta = data.findingCount;
  }
  return { runFindings, totalDelta };
}

interface TokenAccumulation {
  outputTokens: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Extract token counts from a single run_metrics event's tokens block. */
function extractTokens(data: RunMetricsEventData): TokenAccumulation {
  const tokens = data.tokens;
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheWriteTokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;
  if (tokens !== undefined && isPlainObject(tokens)) {
    outputTokens = asNumber(tokens.outputTokens);
    inputTokens = asNumber(tokens.inputTokens);
    cacheWriteTokens = asNumber(tokens.cacheWriteTokens);
    cacheReadTokens = asNumber(tokens.cacheReadTokens);
    costUsd = asNumber(tokens.estimatedCostUsd);
  }
  return { outputTokens, inputTokens, cacheWriteTokens, cacheReadTokens, costUsd };
}

/** Accumulate optional-block presence rates (grounding, locationBackfill, acknowledgements,
 *  structuredOutput) from a single run_metrics event.
 *  Mutates the provided counters in-place. */
function accumulateOptionalBlocks(
  data: RunMetricsEventData,
  counters: {
    groundingRunCount: number;
    groundingDemotedTotal: number;
    ignoredFileTotal: number;
    totalFileCount: number;
    patchAdmissionDegradedRunCount: number;
    patchAdmissionSampleRunCount: number;
    deletionPruningRunCount: number;
    deletionPruningSampleRunCount: number;
    locationBackfillRunCount: number;
    acknowledgementRunCount: number;
    structuredOutputStructuredCount: number;
    structuredOutputTotalCount: number;
  },
): void {
  const groundingBlock = data.grounding;
  if (
    groundingBlock !== undefined &&
    isPlainObject(groundingBlock) &&
    Object.keys(groundingBlock).length > 0
  ) {
    counters.groundingRunCount += 1;
    // asNumber() (not bare Number()) so a non-numeric droppedFindingCount can't propagate NaN
    // into produced/the rate and past buildQualityReport's null-check — matching every other
    // numeric accumulation in this function.
    counters.groundingDemotedTotal += asNumber(groundingBlock.droppedFindingCount);
  }

  const locationBackfillBlock = data.locationBackfill;
  if (
    locationBackfillBlock !== undefined &&
    isPlainObject(locationBackfillBlock) &&
    Object.keys(locationBackfillBlock).length > 0
  ) {
    counters.locationBackfillRunCount += 1;
  }

  const acknowledgementsBlock = data.acknowledgements;
  if (
    acknowledgementsBlock !== undefined &&
    isPlainObject(acknowledgementsBlock) &&
    Object.keys(acknowledgementsBlock).length > 0
  ) {
    counters.acknowledgementRunCount += 1;
  }

  const structuredOutputBlock = data.structuredOutput;
  if (structuredOutputBlock !== undefined && isPlainObject(structuredOutputBlock)) {
    counters.structuredOutputStructuredCount +=
      asNumber(structuredOutputBlock.structuredCount) ?? 0;
    counters.structuredOutputTotalCount += asNumber(structuredOutputBlock.totalCount) ?? 0;
  }

  const ignoredFileCount = asNumber(data.ignoredFileCount);
  const reviewedFileCount = asNumber(data.reviewedFileCount);
  const totalFileCount = ignoredFileCount + reviewedFileCount;
  if (totalFileCount > 0) {
    counters.ignoredFileTotal += ignoredFileCount;
    counters.totalFileCount += totalFileCount;
  }

  const contextBlock = data.context;
  const contextArtifactsBlock = data.contextArtifacts;
  const admissionBlock =
    contextBlock !== undefined && isPlainObject(contextBlock.admission)
      ? contextBlock.admission
      : isPlainObject(data.admission)
        ? data.admission
        : undefined;
  if (admissionBlock !== undefined) {
    const demotedFileCount = asNumber(admissionBlock.demotedFileCount);
    const degraded = admissionBlock.degraded === true || demotedFileCount > 0;
    counters.patchAdmissionSampleRunCount += 1;
    if (degraded) {
      counters.patchAdmissionDegradedRunCount += 1;
    }
  }

  const deletionSource =
    contextArtifactsBlock !== undefined
      ? contextArtifactsBlock
      : contextBlock !== undefined
        ? contextBlock
        : undefined;
  if (
    deletionSource !== undefined &&
    (deletionSource.deletionHunksPruned !== undefined ||
      deletionSource.deletedFileBodiesPruned !== undefined)
  ) {
    counters.deletionPruningSampleRunCount += 1;
    if (
      asNumber(deletionSource.deletionHunksPruned) +
        asNumber(deletionSource.deletedFileBodiesPruned) >
      0
    ) {
      counters.deletionPruningRunCount += 1;
    }
  }
}

/** Accumulate reviewer-failure counts from a single run_metrics event.
 *  Mutates the provided counters in-place. */
function accumulateReviewerFailures(
  data: RunMetricsEventData,
  reviewerFailureCountByRoleMap: Map<string, number>,
): { didFailThisRun: boolean } {
  const failuresBlock = data.failures;
  if (!Array.isArray(failuresBlock)) {
    return { didFailThisRun: false };
  }
  const reviewerFailureEntries = failuresBlock.filter(
    (entry): entry is Record<string, JsonValue> =>
      isPlainObject(entry) && entry.kind === "reviewer",
  );
  if (reviewerFailureEntries.length === 0) {
    return { didFailThisRun: false };
  }
  // De-duplicate roles within this run before incrementing per-role counts
  const rolesInThisRun = new Set<string>();
  for (const entry of reviewerFailureEntries) {
    if (typeof entry.role === "string" && entry.role.length > 0) {
      // Roles are MODEL-AUTHORED free text (validateFinding accepts any string). Strip
      // CR/LF + cap length before using as a key — this value is later interpolated into
      // the line-oriented analytics text report, where an embedded newline would inject a
      // synthetic key:value line. Mirrors the #74 discipline in summary-markdown.ts.
      rolesInThisRun.add(entry.role.replace(/[\r\n]+/g, " ").slice(0, 128));
    }
  }
  for (const role of rolesInThisRun) {
    incrementMap(reviewerFailureCountByRoleMap, role, 1);
  }
  return { didFailThisRun: true };
}

// ─── disposition accumulation helpers (#256, M023 S04) ───────────────────────

interface DispositionAccumulator {
  fixed: number;
  dismissed: number;
  ignored: number;
  acknowledged: number;
}

function dispositionAccZero(): DispositionAccumulator {
  return { fixed: 0, dismissed: 0, ignored: 0, acknowledged: 0 };
}

function computePrecision(acc: DispositionAccumulator): number | null {
  const denom = acc.fixed + acc.ignored + acc.dismissed;
  return denom === 0 ? null : acc.fixed / denom;
}

function toDispositionSegment(acc: DispositionAccumulator): DispositionPrecisionSegment {
  return {
    fixed: acc.fixed,
    dismissed: acc.dismissed,
    ignored: acc.ignored,
    acknowledged: acc.acknowledged,
    precision: computePrecision(acc),
  };
}

/** Accumulate disposition counts from a single run_metrics event's `dispositions` block. */
function accumulateDispositions(
  data: RunMetricsEventData,
  pooled: DispositionAccumulator,
  byReviewer: Map<string, DispositionAccumulator>,
  bySeverity: Map<string, DispositionAccumulator>,
): boolean {
  const block = data.dispositions;
  if (block === undefined || !isPlainObject(block)) {
    return false;
  }

  const fixed = asNumber(block.fixed);
  const dismissed = asNumber(block.dismissed);
  const ignored = asNumber(block.ignored);
  const acknowledged = asNumber(block.acknowledged);
  const hasAny = fixed + dismissed + ignored + acknowledged > 0;

  pooled.fixed += fixed;
  pooled.dismissed += dismissed;
  pooled.ignored += ignored;
  pooled.acknowledged += acknowledged;

  // byReviewer: each entry is { fixed, dismissed, ignored, acknowledged }
  const reviewerBlock = block.byReviewer;
  if (reviewerBlock !== undefined && isPlainObject(reviewerBlock)) {
    for (const [reviewer, counts] of Object.entries(reviewerBlock)) {
      if (!isPlainObject(counts)) continue;
      // Sanitize reviewer key (mirrors #74 discipline in accumulateReviewerFailures)
      const safeKey = reviewer.replace(/[\r\n]+/g, " ").slice(0, 128);
      let acc = byReviewer.get(safeKey);
      if (acc === undefined) {
        acc = dispositionAccZero();
        byReviewer.set(safeKey, acc);
      }
      acc.fixed += asNumber(counts.fixed);
      acc.dismissed += asNumber(counts.dismissed);
      acc.ignored += asNumber(counts.ignored);
      acc.acknowledged += asNumber(counts.acknowledged);
    }
  }

  // bySeverity: same structure
  const severityBlock = block.bySeverity;
  if (severityBlock !== undefined && isPlainObject(severityBlock)) {
    for (const [severity, counts] of Object.entries(severityBlock)) {
      if (!isPlainObject(counts)) continue;
      const safeKey = severity.replace(/[\r\n]+/g, " ").slice(0, 64);
      let acc = bySeverity.get(safeKey);
      if (acc === undefined) {
        acc = dispositionAccZero();
        bySeverity.set(safeKey, acc);
      }
      acc.fixed += asNumber(counts.fixed);
      acc.dismissed += asNumber(counts.dismissed);
      acc.ignored += asNumber(counts.ignored);
      acc.acknowledged += asNumber(counts.acknowledged);
    }
  }

  return hasAny;
}

/** Build a DispositionAnalysis from accumulated data. Returns undefined when no data. */
function buildDispositionAnalysis(
  pooled: DispositionAccumulator,
  byReviewer: Map<string, DispositionAccumulator>,
  bySeverity: Map<string, DispositionAccumulator>,
  hasDispositionData: boolean,
): DispositionAnalysis | undefined {
  if (!hasDispositionData) {
    return undefined;
  }

  const byReviewerRecord: Record<string, DispositionPrecisionSegment> = {};
  for (const key of [...byReviewer.keys()].sort()) {
    const acc = byReviewer.get(key);
    if (acc !== undefined) {
      byReviewerRecord[key] = toDispositionSegment(acc);
    }
  }

  const bySeverityRecord: Record<string, DispositionPrecisionSegment> = {};
  for (const key of [...bySeverity.keys()].sort()) {
    const acc = bySeverity.get(key);
    if (acc !== undefined) {
      bySeverityRecord[key] = toDispositionSegment(acc);
    }
  }

  return {
    pooled: toDispositionSegment(pooled),
    byReviewer: byReviewerRecord,
    bySeverity: bySeverityRecord,
  };
}

// ─── record-assembly helpers ─────────────────────────────────────────────────

/** Build the `byTier` record with stable key ordering from accumulated tier data. */
function buildByTierRecord(
  tierAccumulators: Map<string, TierAccumulator>,
): Record<string, TierSegment> {
  const byTier: Record<string, TierSegment> = {};
  for (const key of Array.from(tierAccumulators.keys()).sort()) {
    const acc = tierAccumulators.get(key);
    if (acc === undefined) {
      continue;
    }
    const tierRunCount = acc.runCount;
    const tierCacheHitDenom =
      acc.totalInputTokens + acc.totalCacheReadTokens + acc.totalCacheWriteTokens;
    byTier[key] = {
      runCount: tierRunCount,
      findingsPerRun: tierRunCount === 0 ? 0 : acc.totalFindings / tierRunCount,
      outputTokensPerRun: tierRunCount === 0 ? 0 : acc.totalOutputTokens / tierRunCount,
      inputTokensPerRun: tierRunCount === 0 ? 0 : acc.totalInputTokens / tierRunCount,
      cacheWriteTokensPerRun: tierRunCount === 0 ? 0 : acc.totalCacheWriteTokens / tierRunCount,
      cacheReadTokensPerRun: tierRunCount === 0 ? 0 : acc.totalCacheReadTokens / tierRunCount,
      cacheHitRate: tierCacheHitDenom === 0 ? null : acc.totalCacheReadTokens / tierCacheHitDenom,
      durationMsPerRun: tierRunCount === 0 ? 0 : acc.totalDurationMs / tierRunCount,
      fanOutMsPerRun: tierRunCount === 0 ? 0 : acc.totalFanOutMs / tierRunCount,
      fusionMsPerRun: tierRunCount === 0 ? 0 : acc.totalFusionMs / tierRunCount,
      costPerRunUsd: tierRunCount === 0 ? 0 : acc.totalCostUsd / tierRunCount,
      costPerFindingUsd: acc.totalFindings === 0 ? null : acc.totalCostUsd / acc.totalFindings,
      thinReviewRunCount: acc.thinReviewRunCount,
      thinReviewRate: tierRunCount === 0 ? 0 : acc.thinReviewRunCount / tierRunCount,
      outputTokensPerFinding:
        acc.totalFindings === 0 ? null : acc.totalOutputTokens / acc.totalFindings,
    };
  }
  return byTier;
}

/** Build `byReviewer` and `reviewerShare` records with stable key ordering. */
function buildByReviewerRecords(
  findingsByReviewer: Map<string, number>,
  totalFindings: number,
): { byReviewer: Record<string, number>; reviewerShare: Record<string, number> } {
  const byReviewer: Record<string, number> = {};
  const reviewerShare: Record<string, number> = {};
  for (const key of Array.from(findingsByReviewer.keys()).sort()) {
    const count = findingsByReviewer.get(key) ?? 0;
    byReviewer[key] = count;
    reviewerShare[key] = totalFindings === 0 ? 0 : count / totalFindings;
  }
  return { byReviewer, reviewerShare };
}

/** Build `decisionCounts` and `outcomeCounts` records with stable key ordering. */
function buildDecisionAndOutcomeRecords(
  decisionCounts: Map<string, number>,
  outcomeCounts: Map<string, number>,
): { decisionCountsRecord: Record<string, number>; outcomeCountsRecord: Record<string, number> } {
  const decisionCountsRecord: Record<string, number> = {};
  for (const key of Array.from(decisionCounts.keys()).sort()) {
    decisionCountsRecord[key] = decisionCounts.get(key) ?? 0;
  }

  const outcomeCountsRecord: Record<string, number> = {};
  for (const key of Array.from(outcomeCounts.keys()).sort()) {
    outcomeCountsRecord[key] = outcomeCounts.get(key) ?? 0;
  }
  return { decisionCountsRecord, outcomeCountsRecord };
}

/** Build the `byDecision` record with stable key ordering from accumulated decision data. */
function buildByDecisionRecord(
  decisionAccumulators: Map<string, DecisionAccumulator>,
): Record<string, DecisionSegment> {
  const byDecision: Record<string, DecisionSegment> = {};
  for (const key of Array.from(decisionAccumulators.keys()).sort()) {
    const acc = decisionAccumulators.get(key);
    if (acc === undefined) {
      continue;
    }
    byDecision[key] = {
      runCount: acc.runCount,
      findingsPerRun: acc.runCount === 0 ? 0 : acc.totalFindings / acc.runCount,
      outputTokensPerRun: acc.runCount === 0 ? 0 : acc.totalOutputTokens / acc.runCount,
      outputTokensPerFinding:
        acc.totalFindings === 0 ? null : acc.totalOutputTokens / acc.totalFindings,
    };
  }
  return byDecision;
}

/** Compute pooled fleet-wide cache-hit rate across all tier accumulators. */
function computeFleetCacheHitRate(tierAccumulators: Map<string, TierAccumulator>): number | null {
  let fleetTotalInputTokens = 0;
  let fleetTotalCacheReadTokens = 0;
  let fleetTotalCacheWriteTokens = 0;
  for (const acc of tierAccumulators.values()) {
    fleetTotalInputTokens += acc.totalInputTokens;
    fleetTotalCacheReadTokens += acc.totalCacheReadTokens;
    fleetTotalCacheWriteTokens += acc.totalCacheWriteTokens;
  }
  const fleetCacheHitDenom =
    fleetTotalInputTokens + fleetTotalCacheReadTokens + fleetTotalCacheWriteTokens;
  return fleetCacheHitDenom === 0 ? null : fleetTotalCacheReadTokens / fleetCacheHitDenom;
}

export function analyzeRunMetrics(
  events: readonly TelemetryEvent[],
  options?: AnalyzeOptions,
): RunMetricsAnalysis {
  const realEvents = events.filter(isRunMetricsEvent);
  const runCount = realEvents.length;

  // Collect the set of runIds that belong to real-runtime run_metrics events.
  // run_event events whose runId is not in this set are "orphans" and are ignored.
  const realRunIds = new Set(
    realEvents.map((e) => e.runId).filter((id): id is string => id !== undefined),
  );

  const tierAccumulators = new Map<string, TierAccumulator>();
  const findingsByReviewer = new Map<string, number>();
  const decisionCounts = new Map<string, number>();
  const outcomeCounts = new Map<string, number>();
  const decisionAccumulators = new Map<string, DecisionAccumulator>();

  const optionalBlockCounters = {
    groundingRunCount: 0,
    groundingDemotedTotal: 0,
    ignoredFileTotal: 0,
    totalFileCount: 0,
    patchAdmissionDegradedRunCount: 0,
    patchAdmissionSampleRunCount: 0,
    deletionPruningRunCount: 0,
    deletionPruningSampleRunCount: 0,
    locationBackfillRunCount: 0,
    acknowledgementRunCount: 0,
    structuredOutputStructuredCount: 0,
    structuredOutputTotalCount: 0,
  };

  let thinReviewRunCount = 0;
  let totalFindings = 0;
  let reviewerFailureRunCount = 0;
  const reviewerFailureCountByRoleMap = new Map<string, number>();

  // Disposition analysis accumulators (#256, M023 S04)
  const dispositionPooled = dispositionAccZero();
  const dispositionByReviewer = new Map<string, DispositionAccumulator>();
  const dispositionBySeverity = new Map<string, DispositionAccumulator>();
  let hasDispositionData = false;

  for (const event of realEvents) {
    const data = event.data;

    const tier =
      typeof data.riskTier === "string" && data.riskTier.length > 0 ? data.riskTier : "unknown";

    const tierAcc = getOrCreateTierAccumulator(tierAccumulators, tier);
    tierAcc.runCount += 1;

    accumulateDecisionsAndOutcomes(data, decisionCounts, outcomeCounts);

    // Count findings and accumulate per-reviewer totals
    const { runFindings, totalDelta } = accumulateFindingsByReviewer(data, findingsByReviewer);
    tierAcc.totalFindings += runFindings;
    totalFindings += totalDelta;

    // Token totals
    const tokenAccum = extractTokens(data);
    tierAcc.totalOutputTokens += tokenAccum.outputTokens;
    tierAcc.totalInputTokens += tokenAccum.inputTokens;
    tierAcc.totalCacheWriteTokens += tokenAccum.cacheWriteTokens;
    tierAcc.totalCacheReadTokens += tokenAccum.cacheReadTokens;
    tierAcc.totalCostUsd += tokenAccum.costUsd;

    // byDecision accumulation (#151): extend the decision tally to carry findings + output tokens
    if (typeof data.decision === "string" && data.decision.length > 0) {
      const decisionKey = data.decision;
      let decAcc = decisionAccumulators.get(decisionKey);
      if (decAcc === undefined) {
        decAcc = { runCount: 0, totalFindings: 0, totalOutputTokens: 0 };
        decisionAccumulators.set(decisionKey, decAcc);
      }
      decAcc.runCount += 1;
      decAcc.totalFindings += runFindings;
      decAcc.totalOutputTokens += tokenAccum.outputTokens;
    }

    // Duration
    const durationMs = asNumber(data.durationMs);
    tierAcc.totalDurationMs += durationMs;

    // Sub-durations: fanOutMs / fusionMs from data.durationsMs (#196)
    const durationsMs = data.durationsMs;
    if (durationsMs !== undefined && isPlainObject(durationsMs)) {
      tierAcc.totalFanOutMs += asNumber(durationsMs.fanOutMs);
      tierAcc.totalFusionMs += asNumber(durationsMs.fusionMs);
    }

    // Thin-review classification (#91): contextual floor from assessThinReview(), which
    // uses riskTier and reviewedFileCount to compute the expected minimum. Trivial runs
    // are never flagged. Explicit --thin-floor wins for all events; otherwise legacy
    // events lacking reviewedFileCount fall back to the flat pre-#91 floor (see comment
    // at LEGACY_FLAT_THIN_FLOOR) so historical analyze output stays comparable.
    const hasFileCount =
      typeof data.reviewedFileCount === "number" && Number.isFinite(data.reviewedFileCount);
    const flatFloor =
      options?.thinReviewOutputTokenFloor ?? (hasFileCount ? undefined : LEGACY_FLAT_THIN_FLOOR);
    const assessment = assessThinReview(
      {
        riskTier: tier,
        reviewedFileCount: hasFileCount ? (data.reviewedFileCount as number) : 0,
        outputTokens: tokenAccum.outputTokens,
      },
      flatFloor !== undefined ? { flatFloor } : undefined,
    );
    if (assessment.thin) {
      tierAcc.thinReviewRunCount += 1;
      thinReviewRunCount += 1;
    }

    // Optional block presence rates
    accumulateOptionalBlocks(data, optionalBlockCounters);

    // Reviewer-failure run count (#212): count a run AT MOST ONCE toward reviewerFailureRunCount
    // even if it has multiple failed reviewers; but per-role counts increment once per DISTINCT
    // failed role in that run (so the per-role denominator stays "runs", consistent with runCount).
    const { didFailThisRun } = accumulateReviewerFailures(data, reviewerFailureCountByRoleMap);
    if (didFailThisRun) {
      reviewerFailureRunCount += 1;
    }

    // Disposition counts (#256, M023 S04)
    const hadDispositions = accumulateDispositions(
      data,
      dispositionPooled,
      dispositionByReviewer,
      dispositionBySeverity,
    );
    if (hadDispositions) {
      hasDispositionData = true;
    }
  }

  const byTier = buildByTierRecord(tierAccumulators);
  const { byReviewer, reviewerShare } = buildByReviewerRecords(findingsByReviewer, totalFindings);
  const { decisionCountsRecord, outcomeCountsRecord } = buildDecisionAndOutcomeRecords(
    decisionCounts,
    outcomeCounts,
  );
  const byDecision = buildByDecisionRecord(decisionAccumulators);

  // Non-trivial run count for thin-review rate denominator
  const nonTrivialRunCount = runCount - (tierAccumulators.get("trivial")?.runCount ?? 0);

  // Overall (fleet-wide) cache-hit rate: pool totals across all tiers
  const overallCacheHitRate = computeFleetCacheHitRate(tierAccumulators);

  // Headline pooled output-tokens-per-finding across all runs (#151)
  let fleetTotalOutputTokens = 0;
  for (const acc of tierAccumulators.values()) {
    fleetTotalOutputTokens += acc.totalOutputTokens;
  }
  const overallOutputTokensPerFinding: number | null =
    totalFindings === 0 ? null : fleetTotalOutputTokens / totalFindings;

  // S06 / #227: scan non-run_metrics events once, matching them to real-runtime run IDs.
  const supplementalEventsAnalysis = buildSupplementalEventsAnalysis(events, realRunIds);

  // Build stable-key-sorted reviewerFailureCountByRole record (#212), mirroring overrideCountByTier
  const reviewerFailureCountByRole: Record<string, number> = {};
  for (const key of Array.from(reviewerFailureCountByRoleMap.keys()).sort()) {
    reviewerFailureCountByRole[key] = reviewerFailureCountByRoleMap.get(key) ?? 0;
  }

  const {
    groundingRunCount,
    groundingDemotedTotal,
    ignoredFileTotal,
    totalFileCount,
    patchAdmissionDegradedRunCount,
    patchAdmissionSampleRunCount,
    deletionPruningRunCount,
    deletionPruningSampleRunCount,
    locationBackfillRunCount,
    acknowledgementRunCount,
    structuredOutputStructuredCount,
    structuredOutputTotalCount,
  } = optionalBlockCounters;

  return {
    runCount,
    reviewerFailureRunCount,
    reviewerFailureRate: runCount === 0 ? null : reviewerFailureRunCount / runCount,
    reviewerFailureCountByRole,
    byTier,
    cacheHitRate: overallCacheHitRate,
    outputTokensPerFinding: overallOutputTokensPerFinding,
    byReviewer,
    reviewerShare,
    decisionCounts: decisionCountsRecord,
    byDecision,
    outcomeCounts: outcomeCountsRecord,
    rates: {
      groundingDropRunRate: runCount === 0 ? 0 : groundingRunCount / runCount,
      // produced = surfaced (totalFindings) + demoted (groundingDemotedTotal)
      groundingWithholdFindingRate:
        totalFindings + groundingDemotedTotal === 0
          ? 0
          : groundingDemotedTotal / (totalFindings + groundingDemotedTotal),
      groundingProducedFindingCount: totalFindings + groundingDemotedTotal,
      diffFilterDropRate: totalFileCount === 0 ? 0 : ignoredFileTotal / totalFileCount,
      diffFilterFileCount: totalFileCount,
      patchAdmissionDegradedRate:
        patchAdmissionSampleRunCount === 0
          ? 0
          : patchAdmissionDegradedRunCount / patchAdmissionSampleRunCount,
      patchAdmissionSampleRunCount,
      deletionPruningRate:
        deletionPruningSampleRunCount === 0
          ? 0
          : deletionPruningRunCount / deletionPruningSampleRunCount,
      deletionPruningSampleRunCount,
      proseFindingDropRate:
        supplementalEventsAnalysis.proseDrops.producedFindingCount === 0
          ? 0
          : supplementalEventsAnalysis.proseDrops.droppedFindingCount /
            supplementalEventsAnalysis.proseDrops.producedFindingCount,
      proseProducedFindingCount: supplementalEventsAnalysis.proseDrops.producedFindingCount,
      locationBackfillRunRate: runCount === 0 ? 0 : locationBackfillRunCount / runCount,
      acknowledgementRunRate: runCount === 0 ? 0 : acknowledgementRunCount / runCount,
      thinReviewRate: nonTrivialRunCount === 0 ? 0 : thinReviewRunCount / nonTrivialRunCount,
      structuredOutputRate:
        structuredOutputTotalCount === 0
          ? 0
          : structuredOutputStructuredCount / structuredOutputTotalCount,
    },
    ...(structuredOutputTotalCount > 0
      ? {
          structuredOutput: {
            structuredCount: structuredOutputStructuredCount,
            totalCount: structuredOutputTotalCount,
          },
        }
      : {}),
    ...(supplementalEventsAnalysis.runEvents !== undefined
      ? { runEvents: supplementalEventsAnalysis.runEvents }
      : {}),
    // Disposition analysis (#256, M023 S04): absent when no run has disposition data.
    ...(() => {
      const da = buildDispositionAnalysis(
        dispositionPooled,
        dispositionByReviewer,
        dispositionBySeverity,
        hasDispositionData,
      );
      return da !== undefined ? { dispositions: da } : {};
    })(),
  };
}

function buildSupplementalEventsAnalysis(
  events: readonly TelemetryEvent[],
  realRunIds: ReadonlySet<string>,
): SupplementalEventsAnalysis {
  let startCount = 0;
  let completedCount = 0;
  let correctionCount = 0;
  let overrideCount = 0;
  let matchedRunEventCount = 0;
  let proseDroppedFindingCount = 0;
  let proseProducedFindingCount = 0;

  // For acceptance: accumulate across correction events
  const acceptanceByReviewer = new Map<string, AccumulatedAcceptance>();
  const acceptanceByTier = new Map<string, AccumulatedAcceptance>();
  const overrideCountByTierMap = new Map<string, number>();
  let correctionRunCount = 0;

  for (const event of events) {
    if (event.runId === undefined || !realRunIds.has(event.runId)) {
      continue;
    }

    if (isAgentOutputEvent(event)) {
      if (event.data.structuredOutput !== false) {
        continue;
      }

      const dropped = asNumber(event.data.droppedFindingCount);
      const surviving = asNumber(event.data.findingCount);
      const produced = dropped + surviving;
      if (produced <= 0) {
        continue;
      }
      proseDroppedFindingCount += dropped;
      proseProducedFindingCount += produced;
      continue;
    }

    if (!isRunEvent(event)) {
      continue;
    }
    matchedRunEventCount += 1;

    const eventSubtype = event.data.event;
    if (eventSubtype === "run.start") {
      startCount += 1;
    } else if (eventSubtype === "run.completed") {
      completedCount += 1;
    } else if (eventSubtype === "run.override") {
      overrideCount += 1;
      const tier =
        typeof event.data.riskTier === "string" && event.data.riskTier.length > 0
          ? event.data.riskTier
          : "unknown";
      incrementMap(overrideCountByTierMap, tier, 1);
    } else if (eventSubtype === "run.correction") {
      correctionCount += 1;

      const tier =
        typeof event.data.riskTier === "string" && event.data.riskTier.length > 0
          ? event.data.riskTier
          : "unknown";

      const acceptanceRecord = event.data.acceptanceByReviewer;
      if (
        acceptanceRecord !== undefined &&
        isPlainObject(acceptanceRecord) &&
        Object.keys(acceptanceRecord).length > 0
      ) {
        // Only correction events that actually carry acceptance data count
        // toward the directional-signal denominator.
        correctionRunCount += 1;
        for (const [reviewer, reviewerData] of Object.entries(acceptanceRecord)) {
          if (!isPlainObject(reviewerData)) {
            continue;
          }
          const accepted = asNumber(reviewerData.accepted);
          const notAccepted = asNumber(reviewerData.notAccepted);
          const rejected = asNumber(reviewerData.rejected);
          const withheldExcluded = asNumber(reviewerData.withheldExcluded);

          // Accumulate by reviewer
          accumulateAcceptance(acceptanceByReviewer, reviewer, {
            accepted,
            notAccepted,
            rejected,
            withheldExcluded,
          });

          // Accumulate by tier
          accumulateAcceptance(acceptanceByTier, tier, {
            accepted,
            notAccepted,
            rejected,
            withheldExcluded,
          });
        }
      }
    }
  }

  const completionRate = startCount === 0 ? null : completedCount / startCount;
  const overrideRate = startCount === 0 ? null : overrideCount / startCount;

  // Build stable-key-sorted overrideCountByTier record
  const overrideCountByTier: Record<string, number> = {};
  for (const key of Array.from(overrideCountByTierMap.keys()).sort()) {
    overrideCountByTier[key] = overrideCountByTierMap.get(key) ?? 0;
  }

  return {
    ...(matchedRunEventCount > 0
      ? {
          runEvents: {
            startCount,
            completedCount,
            correctionCount,
            completionRate,
            overrideCount,
            overrideRate,
            overrideCountByTier,
            acceptanceByReviewer: buildAcceptanceRecord(acceptanceByReviewer),
            acceptanceByTier: buildAcceptanceRecord(acceptanceByTier),
            correctionRunCount,
            directional: true,
          },
        }
      : {}),
    proseDrops: {
      droppedFindingCount: proseDroppedFindingCount,
      producedFindingCount: proseProducedFindingCount,
    },
  };
}

function accumulateAcceptance(
  map: Map<string, AccumulatedAcceptance>,
  key: string,
  delta: AccumulatedAcceptance,
): void {
  let acc = map.get(key);
  if (acc === undefined) {
    acc = { accepted: 0, notAccepted: 0, rejected: 0, withheldExcluded: 0 };
    map.set(key, acc);
  }
  acc.accepted += delta.accepted;
  acc.notAccepted += delta.notAccepted;
  acc.rejected += delta.rejected;
  acc.withheldExcluded += delta.withheldExcluded;
}

function buildAcceptanceRecord(
  map: Map<string, AccumulatedAcceptance>,
): Record<string, ReviewerAcceptanceStat> {
  const out: Record<string, ReviewerAcceptanceStat> = {};
  for (const key of Array.from(map.keys()).sort()) {
    const acc = map.get(key);
    if (acc === undefined) {
      continue;
    }
    const denominator = acc.accepted + acc.notAccepted + acc.rejected;
    const acceptanceRate = denominator === 0 ? undefined : acc.accepted / denominator;
    out[key] = {
      accepted: acc.accepted,
      notAccepted: acc.notAccepted,
      rejected: acc.rejected,
      withheldExcluded: acc.withheldExcluded,
      ...(acceptanceRate !== undefined ? { acceptanceRate } : {}),
    };
  }
  return out;
}

// ─── formatRunMetricsAnalysis section helpers ────────────────────────────────

/** Render the per-tier table section. */
function formatTierTableSection(analysis: RunMetricsAnalysis): string[] {
  const lines: string[] = [];
  lines.push("--- By Risk Tier ---");
  const tierKeys = Object.keys(analysis.byTier).sort();
  if (tierKeys.length === 0) {
    lines.push("  (no data)");
  } else {
    lines.push(
      padRight("Tier", 10) +
        padLeft("Runs", 6) +
        padLeft("Findings/run", 14) +
        padLeft("Out tok/run", 13) +
        padLeft("In tok/run", 12) +
        padLeft("CacheHit", 9) +
        padLeft("Dur ms/run", 12) +
        padLeft("FanOut ms/run", 15) +
        padLeft("Fusion ms/run", 15) +
        padLeft("Cost/run", 10) +
        padLeft("Cost/finding", 14) +
        padLeft("Thin", 6) +
        padLeft("ThinRate", 10),
    );
    for (const tier of tierKeys) {
      const seg = analysis.byTier[tier];
      if (seg === undefined) {
        continue;
      }
      lines.push(
        padRight(tier, 10) +
          padLeft(String(seg.runCount), 6) +
          padLeft(seg.findingsPerRun.toFixed(2), 14) +
          padLeft(seg.outputTokensPerRun.toFixed(0), 13) +
          padLeft(seg.inputTokensPerRun.toFixed(0), 12) +
          padLeft(
            seg.cacheHitRate === null ? "n/a" : `${(seg.cacheHitRate * 100).toFixed(1)}%`,
            9,
          ) +
          padLeft(seg.durationMsPerRun.toFixed(0), 12) +
          padLeft(seg.fanOutMsPerRun.toFixed(0), 15) +
          padLeft(seg.fusionMsPerRun.toFixed(0), 15) +
          padLeft(`$${seg.costPerRunUsd.toFixed(4)}`, 10) +
          padLeft(
            seg.costPerFindingUsd === null ? "n/a" : `$${seg.costPerFindingUsd.toFixed(4)}`,
            14,
          ) +
          padLeft(String(seg.thinReviewRunCount), 6) +
          padLeft(`${(seg.thinReviewRate * 100).toFixed(1)}%`, 10),
      );
    }
  }
  lines.push(
    `Overall cache-hit rate: ${analysis.cacheHitRate === null ? "n/a" : `${(analysis.cacheHitRate * 100).toFixed(1)}%`}`,
  );
  return lines;
}

/** Render the by-reviewer section. */
function formatReviewerSection(analysis: RunMetricsAnalysis): string[] {
  const lines: string[] = [];
  lines.push("--- By Reviewer ---");
  const reviewerKeys = Object.keys(analysis.byReviewer).sort();
  if (reviewerKeys.length === 0) {
    lines.push("  (no findings)");
  } else {
    for (const reviewer of reviewerKeys) {
      const count = analysis.byReviewer[reviewer] ?? 0;
      const share = analysis.reviewerShare[reviewer] ?? 0;
      lines.push(
        `  ${padRight(reviewer, 20)} ${padLeft(String(count), 5)} findings  (${(share * 100).toFixed(1)}%)`,
      );
    }
  }
  return lines;
}

/** Render decision and outcome distribution sections. */
function formatDecisionAndOutcomeSections(analysis: RunMetricsAnalysis): string[] {
  const lines: string[] = [];

  // Decision counts
  lines.push("--- Decision Distribution ---");
  const decisionKeys = Object.keys(analysis.decisionCounts).sort();
  if (decisionKeys.length === 0) {
    lines.push("  (no data)");
  } else {
    for (const key of decisionKeys) {
      lines.push(`  ${padRight(key, 28)} ${analysis.decisionCounts[key] ?? 0}`);
    }
  }

  lines.push("");

  // Outcome counts
  lines.push("--- CI Outcome Distribution ---");
  const outcomeKeys = Object.keys(analysis.outcomeCounts).sort();
  if (outcomeKeys.length === 0) {
    lines.push("  (no data)");
  } else {
    for (const key of outcomeKeys) {
      lines.push(`  ${padRight(key, 28)} ${analysis.outcomeCounts[key] ?? 0}`);
    }
  }

  return lines;
}

/** Render the rates section. */
function formatRatesSection(analysis: RunMetricsAnalysis): string[] {
  const lines: string[] = [];
  lines.push("--- Rates ---");
  const r = analysis.rates;
  lines.push(`  groundingDropRunRate      ${(r.groundingDropRunRate * 100).toFixed(1)}%`);
  lines.push(
    `  groundingWithholdFindingRate ${(r.groundingWithholdFindingRate * 100).toFixed(1)}% (n=${r.groundingProducedFindingCount})`,
  );
  lines.push(
    `  diffFilterDropRate       ${(r.diffFilterDropRate * 100).toFixed(1)}% (n=${r.diffFilterFileCount})`,
  );
  lines.push(
    `  patchAdmissionDegradedRate ${(r.patchAdmissionDegradedRate * 100).toFixed(1)}% (n=${r.patchAdmissionSampleRunCount})`,
  );
  lines.push(
    `  deletionPruningRate      ${(r.deletionPruningRate * 100).toFixed(1)}% (n=${r.deletionPruningSampleRunCount})`,
  );
  lines.push(
    `  proseFindingDropRate     ${(r.proseFindingDropRate * 100).toFixed(1)}% (n=${r.proseProducedFindingCount})`,
  );
  lines.push(`  locationBackfillRunRate   ${(r.locationBackfillRunRate * 100).toFixed(1)}%`);
  lines.push(`  acknowledgementRunRate    ${(r.acknowledgementRunRate * 100).toFixed(1)}%`);
  lines.push(`  thinReviewRate            ${(r.thinReviewRate * 100).toFixed(1)}%`);
  lines.push(`  structuredOutputRate      ${(r.structuredOutputRate * 100).toFixed(1)}%`);
  lines.push(`  reviewerFailureRunCount   ${analysis.reviewerFailureRunCount}`);
  const rfRateStr =
    analysis.reviewerFailureRate === null
      ? "n/a"
      : `${(analysis.reviewerFailureRate * 100).toFixed(1)}%`;
  lines.push(`  reviewerFailureRate       ${rfRateStr}`);
  const rfByRoleKeys = Object.keys(analysis.reviewerFailureCountByRole);
  if (rfByRoleKeys.length > 0) {
    const byRoleParts = rfByRoleKeys.map(
      (role) => `${role}:${analysis.reviewerFailureCountByRole[role] ?? 0}`,
    );
    lines.push(`  reviewerFailureByRole     ${byRoleParts.join(", ")}`);
  }
  return lines;
}

/** Render the run-events section (returns empty array when no run_event data). */
function formatRunEventsSection(analysis: RunMetricsAnalysis): string[] {
  if (analysis.runEvents === undefined) {
    return [];
  }
  const re = analysis.runEvents;
  const lines: string[] = [];
  lines.push("");
  lines.push("--- Run Events ---");
  lines.push(`  startCount                ${re.startCount}`);
  lines.push(`  completedCount            ${re.completedCount}`);
  lines.push(`  correctionCount           ${re.correctionCount}`);
  const rateStr = re.completionRate === null ? "n/a" : `${(re.completionRate * 100).toFixed(1)}%`;
  lines.push(`  completionRate            ${rateStr}`);

  lines.push("");
  lines.push(
    `--- Acceptance by Reviewer (directional — longitudinal signal, ${re.correctionRunCount} correction runs) ---`,
  );
  const reviewerKeys = Object.keys(re.acceptanceByReviewer).sort();
  if (reviewerKeys.length === 0) {
    lines.push("  (no data)");
  } else {
    lines.push(
      padRight("Reviewer", 22) +
        padLeft("Accepted", 10) +
        padLeft("NotAccepted", 13) +
        padLeft("Rejected", 10) +
        padLeft("Withheld", 10) +
        padLeft("AccRate", 9),
    );
    for (const reviewer of reviewerKeys) {
      const stat = re.acceptanceByReviewer[reviewer];
      if (stat === undefined) {
        continue;
      }
      const rateDisplay =
        stat.acceptanceRate !== undefined ? `${(stat.acceptanceRate * 100).toFixed(1)}%` : "n/a";
      lines.push(
        padRight(reviewer, 22) +
          padLeft(String(stat.accepted), 10) +
          padLeft(String(stat.notAccepted), 13) +
          padLeft(String(stat.rejected), 10) +
          padLeft(String(stat.withheldExcluded), 10) +
          padLeft(rateDisplay, 9),
      );
    }
  }

  lines.push("");
  lines.push(
    `--- Acceptance by Tier (directional — longitudinal signal, ${re.correctionRunCount} correction runs) ---`,
  );
  const tierKeys = Object.keys(re.acceptanceByTier).sort();
  if (tierKeys.length === 0) {
    lines.push("  (no data)");
  } else {
    lines.push(
      padRight("Tier", 12) +
        padLeft("Accepted", 10) +
        padLeft("NotAccepted", 13) +
        padLeft("Rejected", 10) +
        padLeft("Withheld", 10) +
        padLeft("AccRate", 9),
    );
    for (const tier of tierKeys) {
      const stat = re.acceptanceByTier[tier];
      if (stat === undefined) {
        continue;
      }
      const rateDisplay =
        stat.acceptanceRate !== undefined ? `${(stat.acceptanceRate * 100).toFixed(1)}%` : "n/a";
      lines.push(
        padRight(tier, 12) +
          padLeft(String(stat.accepted), 10) +
          padLeft(String(stat.notAccepted), 13) +
          padLeft(String(stat.rejected), 10) +
          padLeft(String(stat.withheldExcluded), 10) +
          padLeft(rateDisplay, 9),
      );
    }
  }

  return lines;
}

/** Render the dispositions precision section (#256, M023 S04).
 *  Returns an empty array when no disposition data is present. */
function formatDispositionsSection(analysis: RunMetricsAnalysis): string[] {
  if (analysis.dispositions === undefined) {
    return [];
  }
  const da = analysis.dispositions;
  const lines: string[] = [];
  lines.push("");
  lines.push("--- Disposition Precision (fixed ÷ (fixed + ignored + dismissed)) ---");

  function renderSegment(label: string, seg: DispositionPrecisionSegment): string {
    const precStr = seg.precision === null ? "n/a" : `${(seg.precision * 100).toFixed(1)}%`;
    return (
      padRight(label, 24) +
      padLeft(String(seg.fixed), 7) +
      padLeft(String(seg.dismissed), 10) +
      padLeft(String(seg.ignored), 8) +
      padLeft(String(seg.acknowledged), 13) +
      padLeft(precStr, 10)
    );
  }

  lines.push(
    padRight("Segment", 24) +
      padLeft("Fixed", 7) +
      padLeft("Dismissed", 10) +
      padLeft("Ignored", 8) +
      padLeft("Acknowledged", 13) +
      padLeft("Precision", 10),
  );
  lines.push(renderSegment("pooled", da.pooled));

  const reviewerKeys = Object.keys(da.byReviewer).sort();
  if (reviewerKeys.length > 0) {
    lines.push("");
    lines.push("  By Reviewer:");
    for (const reviewer of reviewerKeys) {
      const seg = da.byReviewer[reviewer];
      if (seg !== undefined) {
        lines.push(renderSegment(`  ${reviewer}`, seg));
      }
    }
  }

  const severityKeys = Object.keys(da.bySeverity).sort();
  if (severityKeys.length > 0) {
    lines.push("");
    lines.push("  By Severity:");
    for (const severity of severityKeys) {
      const seg = da.bySeverity[severity];
      if (seg !== undefined) {
        lines.push(renderSegment(`  ${severity}`, seg));
      }
    }
  }

  return lines;
}

export function formatRunMetricsAnalysis(analysis: RunMetricsAnalysis): string {
  const lines: string[] = [];

  lines.push(`=== Run Metrics Analysis (${analysis.runCount} runs) ===`);
  lines.push("");

  // Per-tier table
  lines.push(...formatTierTableSection(analysis));
  lines.push("");

  // Reviewer share
  lines.push(...formatReviewerSection(analysis));
  lines.push("");

  // Decision counts and CI outcome distribution
  lines.push(...formatDecisionAndOutcomeSections(analysis));
  lines.push("");

  // Rates
  lines.push(...formatRatesSection(analysis));

  // Run events section (present only when run_event data exists)
  lines.push(...formatRunEventsSection(analysis));

  // Disposition precision section (#256, M023 S04)
  lines.push(...formatDispositionsSection(analysis));

  return lines.join("\n");
}

// ─── helpers ────────────────────────────────────────────────────────────────

function isRunEvent(event: TelemetryEvent): event is RunEvent {
  if (event.type !== "ai_review.run_event") {
    return false;
  }
  return isPlainObject(event.data);
}

function isRunMetricsEvent(event: TelemetryEvent): event is RunMetricsEvent {
  if (event.type !== "ai_review.run_metrics") {
    return false;
  }
  if (!isPlainObject(event.data)) {
    return false;
  }
  const runtime = event.data.runtime;
  return typeof runtime === "string" && !NON_REAL_RUNTIME_KIND_SET.has(runtime);
}

function isAgentOutputEvent(event: TelemetryEvent): event is AgentOutputEvent {
  if (event.type !== "agent.output") {
    return false;
  }
  return isPlainObject(event.data);
}

function incrementMap(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function getOrCreateTierAccumulator(
  map: Map<string, TierAccumulator>,
  key: string,
): TierAccumulator {
  let acc = map.get(key);
  if (acc === undefined) {
    acc = {
      runCount: 0,
      totalFindings: 0,
      totalOutputTokens: 0,
      totalInputTokens: 0,
      totalCacheWriteTokens: 0,
      totalCacheReadTokens: 0,
      totalDurationMs: 0,
      totalFanOutMs: 0,
      totalFusionMs: 0,
      totalCostUsd: 0,
      thinReviewRunCount: 0,
    };
    map.set(key, acc);
  }
  return acc;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
  return str.length >= width ? str : " ".repeat(width - str.length) + str;
}
