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
  durationMsPerRun: number;
  costPerRunUsd: number;
  /** null when there are 0 findings across all runs in this tier */
  costPerFindingUsd: number | null;
  thinReviewRunCount: number;
  thinReviewRate: number;
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

export interface RunMetricsAnalysis {
  runCount: number;
  /** Per risk-tier aggregates (keys are tier names, e.g. "trivial", "lite", "full"). */
  byTier: Record<string, TierSegment>;
  /** Total finding count per reviewer across all runs. */
  byReviewer: Record<string, number>;
  /** Each reviewer's fraction of total findings (0 when no findings). */
  reviewerShare: Record<string, number>;
  /** How many runs produced each decision value. */
  decisionCounts: Record<string, number>;
  /** How many runs produced each CI outcome value. */
  outcomeCounts: Record<string, number>;
  rates: {
    /** Fraction of runs whose event carried a non-empty grounding block. */
    groundingDropRunRate: number;
    /** Fraction of runs whose event carried a non-empty locationBackfill block. */
    locationBackfillRunRate: number;
    /** Fraction of runs whose event carried a non-empty acknowledgements block. */
    acknowledgementRunRate: number;
    /** Fraction of non-trivial runs with output tokens below the thin-review floor. */
    thinReviewRate: number;
  };
  /**
   * Run-event aggregates. Present only when run_event events exist in the
   * stream AND at least one run_event runId matches a real-runtime run_metrics
   * event (orphan run_events are ignored).
   */
  runEvents?: RunEventsAnalysis;
}

interface TierAccumulator {
  runCount: number;
  totalFindings: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  totalCacheWriteTokens: number;
  totalDurationMs: number;
  totalCostUsd: number;
  thinReviewRunCount: number;
}

interface RunMetricsEventData extends Record<string, JsonValue> {
  runtime?: string;
  riskTier?: string;
  reviewedFileCount?: number;
  decision?: string;
  outcome?: string;
  durationMs?: number;
  findingCount?: number;
  findingsByReviewer?: Record<string, JsonValue>;
  tokens?: Record<string, JsonValue>;
  grounding?: Record<string, JsonValue>;
  locationBackfill?: Record<string, JsonValue>;
  acknowledgements?: Record<string, JsonValue>;
}

type RunMetricsEvent = TelemetryEvent & { data: RunMetricsEventData };

interface RunEventData extends Record<string, JsonValue> {
  event?: string;
  riskTier?: string;
  acceptanceByReviewer?: Record<string, JsonValue>;
}

type RunEvent = TelemetryEvent & { data: RunEventData };

interface AccumulatedAcceptance {
  accepted: number;
  notAccepted: number;
  rejected: number;
  withheldExcluded: number;
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

  let groundingRunCount = 0;
  let locationBackfillRunCount = 0;
  let acknowledgementRunCount = 0;
  let thinReviewRunCount = 0;
  let totalFindings = 0;

  for (const event of realEvents) {
    const data = event.data;

    const tier =
      typeof data.riskTier === "string" && data.riskTier.length > 0 ? data.riskTier : "unknown";

    const tierAcc = getOrCreateTierAccumulator(tierAccumulators, tier);
    tierAcc.runCount += 1;

    if (typeof data.decision === "string" && data.decision.length > 0) {
      incrementMap(decisionCounts, data.decision, 1);
    }

    if (typeof data.outcome === "string" && data.outcome.length > 0) {
      incrementMap(outcomeCounts, data.outcome, 1);
    }

    // Count findings and accumulate per-reviewer totals
    const findingsRecord = data.findingsByReviewer;
    let runFindings = 0;
    if (findingsRecord !== undefined && isPlainObject(findingsRecord)) {
      for (const [reviewer, count] of Object.entries(findingsRecord)) {
        if (typeof count === "number" && Number.isFinite(count)) {
          incrementMap(findingsByReviewer, reviewer, count);
          runFindings += count;
          totalFindings += count;
        }
      }
    } else if (typeof data.findingCount === "number" && Number.isFinite(data.findingCount)) {
      runFindings = data.findingCount;
      totalFindings += data.findingCount;
    }
    tierAcc.totalFindings += runFindings;

    // Token totals
    const tokens = data.tokens;
    let outputTokens = 0;
    let inputTokens = 0;
    let cacheWriteTokens = 0;
    let costUsd = 0;
    if (tokens !== undefined && isPlainObject(tokens)) {
      outputTokens = asNumber(tokens.outputTokens);
      inputTokens = asNumber(tokens.inputTokens);
      cacheWriteTokens = asNumber(tokens.cacheWriteTokens);
      costUsd = asNumber(tokens.estimatedCostUsd);
    }
    tierAcc.totalOutputTokens += outputTokens;
    tierAcc.totalInputTokens += inputTokens;
    tierAcc.totalCacheWriteTokens += cacheWriteTokens;
    tierAcc.totalCostUsd += costUsd;

    // Duration
    const durationMs = asNumber(data.durationMs);
    tierAcc.totalDurationMs += durationMs;

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
        outputTokens,
      },
      flatFloor !== undefined ? { flatFloor } : undefined,
    );
    if (assessment.thin) {
      tierAcc.thinReviewRunCount += 1;
      thinReviewRunCount += 1;
    }

    // Optional block presence rates
    const groundingBlock = data.grounding;
    if (
      groundingBlock !== undefined &&
      isPlainObject(groundingBlock) &&
      Object.keys(groundingBlock).length > 0
    ) {
      groundingRunCount += 1;
    }

    const locationBackfillBlock = data.locationBackfill;
    if (
      locationBackfillBlock !== undefined &&
      isPlainObject(locationBackfillBlock) &&
      Object.keys(locationBackfillBlock).length > 0
    ) {
      locationBackfillRunCount += 1;
    }

    const acknowledgementsBlock = data.acknowledgements;
    if (
      acknowledgementsBlock !== undefined &&
      isPlainObject(acknowledgementsBlock) &&
      Object.keys(acknowledgementsBlock).length > 0
    ) {
      acknowledgementRunCount += 1;
    }
  }

  // Build byTier with stable key ordering
  const byTier: Record<string, TierSegment> = {};
  for (const key of Array.from(tierAccumulators.keys()).sort()) {
    const acc = tierAccumulators.get(key);
    if (acc === undefined) {
      continue;
    }
    const tierRunCount = acc.runCount;
    byTier[key] = {
      runCount: tierRunCount,
      findingsPerRun: tierRunCount === 0 ? 0 : acc.totalFindings / tierRunCount,
      outputTokensPerRun: tierRunCount === 0 ? 0 : acc.totalOutputTokens / tierRunCount,
      inputTokensPerRun: tierRunCount === 0 ? 0 : acc.totalInputTokens / tierRunCount,
      cacheWriteTokensPerRun: tierRunCount === 0 ? 0 : acc.totalCacheWriteTokens / tierRunCount,
      durationMsPerRun: tierRunCount === 0 ? 0 : acc.totalDurationMs / tierRunCount,
      costPerRunUsd: tierRunCount === 0 ? 0 : acc.totalCostUsd / tierRunCount,
      costPerFindingUsd: acc.totalFindings === 0 ? null : acc.totalCostUsd / acc.totalFindings,
      thinReviewRunCount: acc.thinReviewRunCount,
      thinReviewRate: tierRunCount === 0 ? 0 : acc.thinReviewRunCount / tierRunCount,
    };
  }

  // Build byReviewer and reviewerShare with stable key ordering
  const byReviewer: Record<string, number> = {};
  const reviewerShare: Record<string, number> = {};
  for (const key of Array.from(findingsByReviewer.keys()).sort()) {
    const count = findingsByReviewer.get(key) ?? 0;
    byReviewer[key] = count;
    reviewerShare[key] = totalFindings === 0 ? 0 : count / totalFindings;
  }

  // Build decisionCounts and outcomeCounts with stable key ordering
  const decisionCountsRecord: Record<string, number> = {};
  for (const key of Array.from(decisionCounts.keys()).sort()) {
    decisionCountsRecord[key] = decisionCounts.get(key) ?? 0;
  }

  const outcomeCountsRecord: Record<string, number> = {};
  for (const key of Array.from(outcomeCounts.keys()).sort()) {
    outcomeCountsRecord[key] = outcomeCounts.get(key) ?? 0;
  }

  // Non-trivial run count for thin-review rate denominator
  const nonTrivialRunCount = runCount - (tierAccumulators.get("trivial")?.runCount ?? 0);

  // S06: run_event analysis — filter to run_event events, match to real runs
  const runEventAnalysis = buildRunEventsAnalysis(events, realRunIds);

  return {
    runCount,
    byTier,
    byReviewer,
    reviewerShare,
    decisionCounts: decisionCountsRecord,
    outcomeCounts: outcomeCountsRecord,
    rates: {
      groundingDropRunRate: runCount === 0 ? 0 : groundingRunCount / runCount,
      locationBackfillRunRate: runCount === 0 ? 0 : locationBackfillRunCount / runCount,
      acknowledgementRunRate: runCount === 0 ? 0 : acknowledgementRunCount / runCount,
      thinReviewRate: nonTrivialRunCount === 0 ? 0 : thinReviewRunCount / nonTrivialRunCount,
    },
    ...(runEventAnalysis !== undefined ? { runEvents: runEventAnalysis } : {}),
  };
}

function buildRunEventsAnalysis(
  events: readonly TelemetryEvent[],
  realRunIds: ReadonlySet<string>,
): RunEventsAnalysis | undefined {
  const runEvents = events.filter(isRunEvent);
  if (runEvents.length === 0) {
    return undefined;
  }

  // Filter to events whose runId belongs to a real-runtime run_metrics run.
  // Orphan run_events (from dummy/test runs with no matching run_metrics) are ignored.
  const matchedEvents = runEvents.filter((e) => e.runId !== undefined && realRunIds.has(e.runId));

  if (matchedEvents.length === 0) {
    return undefined;
  }

  let startCount = 0;
  let completedCount = 0;
  let correctionCount = 0;
  let overrideCount = 0;

  // For acceptance: accumulate across correction events
  const acceptanceByReviewer = new Map<string, AccumulatedAcceptance>();
  const acceptanceByTier = new Map<string, AccumulatedAcceptance>();
  const overrideCountByTierMap = new Map<string, number>();
  let correctionRunCount = 0;

  for (const event of matchedEvents) {
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

export function formatRunMetricsAnalysis(analysis: RunMetricsAnalysis): string {
  const lines: string[] = [];

  lines.push(`=== Run Metrics Analysis (${analysis.runCount} runs) ===`);
  lines.push("");

  // Per-tier table
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
        padLeft("Dur ms/run", 12) +
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
          padLeft(seg.durationMsPerRun.toFixed(0), 12) +
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

  lines.push("");

  // Reviewer share
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

  lines.push("");

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

  lines.push("");

  // Rates
  lines.push("--- Rates ---");
  const r = analysis.rates;
  lines.push(`  groundingDropRunRate      ${(r.groundingDropRunRate * 100).toFixed(1)}%`);
  lines.push(`  locationBackfillRunRate   ${(r.locationBackfillRunRate * 100).toFixed(1)}%`);
  lines.push(`  acknowledgementRunRate    ${(r.acknowledgementRunRate * 100).toFixed(1)}%`);
  lines.push(`  thinReviewRate            ${(r.thinReviewRate * 100).toFixed(1)}%`);

  // Run events section (present only when run_event data exists)
  if (analysis.runEvents !== undefined) {
    const re = analysis.runEvents;
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
  }

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
      totalDurationMs: 0,
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
