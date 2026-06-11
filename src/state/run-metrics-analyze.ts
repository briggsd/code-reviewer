import type { JsonValue } from "../contracts/common.ts";
import type { TelemetryEvent } from "../contracts/telemetry.ts";
import { NON_REAL_RUNTIME_KINDS } from "../runtime/runtime-kind.ts";

// Local copies of asNumber/isPlainObject/incrementMap — intentional local copy,
// do NOT import from run-metrics-rollup.ts (keep each analytics module self-contained,
// mirroring the evidence-grounding.ts ↔ stable-finding-id.ts precedent).

const NON_REAL_RUNTIME_KIND_SET: ReadonlySet<string> = new Set(NON_REAL_RUNTIME_KINDS);

// Default output-token floor for the thin-review heuristic.
// A non-trivial run is considered "thin" if its total output tokens are below this
// value. This is a deliberately simple placeholder floor pending #91's contextual
// flag (diff-size-aware threshold). The floor is a tunable option so #91 can refine
// it without changing callers. Trivial-tier runs are never flagged thin — an
// empty/fast review on a trivial diff is expected (see CLAUDE.md / #65: thinking is
// a cap, not a floor).
const DEFAULT_THIN_REVIEW_OUTPUT_TOKEN_FLOOR = 250;

export interface AnalyzeOptions {
  /** Output-token count below which a non-trivial run is considered "thin". Default: 250. */
  thinReviewOutputTokenFloor?: number;
}

export interface TierSegment {
  runCount: number;
  findingsPerRun: number;
  outputTokensPerRun: number;
  inputTokensPerRun: number;
  durationMsPerRun: number;
  costPerRunUsd: number;
  /** null when there are 0 findings across all runs in this tier */
  costPerFindingUsd: number | null;
  thinReviewRunCount: number;
  thinReviewRate: number;
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
}

interface TierAccumulator {
  runCount: number;
  totalFindings: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  totalDurationMs: number;
  totalCostUsd: number;
  thinReviewRunCount: number;
}

interface RunMetricsEventData extends Record<string, JsonValue> {
  runtime?: string;
  riskTier?: string;
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

export function analyzeRunMetrics(
  events: readonly TelemetryEvent[],
  options?: AnalyzeOptions,
): RunMetricsAnalysis {
  const floor = options?.thinReviewOutputTokenFloor ?? DEFAULT_THIN_REVIEW_OUTPUT_TOKEN_FLOOR;

  const realEvents = events.filter(isRunMetricsEvent);
  const runCount = realEvents.length;

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

    const tier = typeof data.riskTier === "string" && data.riskTier.length > 0
      ? data.riskTier
      : "unknown";

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
    let costUsd = 0;
    if (tokens !== undefined && isPlainObject(tokens)) {
      outputTokens = asNumber(tokens.outputTokens);
      inputTokens = asNumber(tokens.inputTokens);
      costUsd = asNumber(tokens.estimatedCostUsd);
    }
    tierAcc.totalOutputTokens += outputTokens;
    tierAcc.totalInputTokens += inputTokens;
    tierAcc.totalCostUsd += costUsd;

    // Duration
    const durationMs = asNumber(data.durationMs);
    tierAcc.totalDurationMs += durationMs;

    // Thin-review heuristic: a run is "thin" iff its riskTier is NOT "trivial"
    // AND its total output tokens are below the floor. Trivial runs are never
    // flagged — an empty/fast review on a trivial diff is expected (#65).
    // Pending #91's contextual/diff-size-aware flag, this simple floor is the
    // placeholder. The floor is tunable via AnalyzeOptions.thinReviewOutputTokenFloor.
    if (tier !== "trivial" && outputTokens < floor) {
      tierAcc.thinReviewRunCount += 1;
      thinReviewRunCount += 1;
    }

    // Optional block presence rates
    const groundingBlock = data.grounding;
    if (groundingBlock !== undefined && isPlainObject(groundingBlock) && Object.keys(groundingBlock).length > 0) {
      groundingRunCount += 1;
    }

    const locationBackfillBlock = data.locationBackfill;
    if (locationBackfillBlock !== undefined && isPlainObject(locationBackfillBlock) && Object.keys(locationBackfillBlock).length > 0) {
      locationBackfillRunCount += 1;
    }

    const acknowledgementsBlock = data.acknowledgements;
    if (acknowledgementsBlock !== undefined && isPlainObject(acknowledgementsBlock) && Object.keys(acknowledgementsBlock).length > 0) {
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
  };
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
      padRight("Tier", 10)
        + padLeft("Runs", 6)
        + padLeft("Findings/run", 14)
        + padLeft("Out tok/run", 13)
        + padLeft("In tok/run", 12)
        + padLeft("Dur ms/run", 12)
        + padLeft("Cost/run", 10)
        + padLeft("Cost/finding", 14)
        + padLeft("Thin", 6)
        + padLeft("ThinRate", 10),
    );
    for (const tier of tierKeys) {
      const seg = analysis.byTier[tier];
      if (seg === undefined) {
        continue;
      }
      lines.push(
        padRight(tier, 10)
          + padLeft(String(seg.runCount), 6)
          + padLeft(seg.findingsPerRun.toFixed(2), 14)
          + padLeft(seg.outputTokensPerRun.toFixed(0), 13)
          + padLeft(seg.inputTokensPerRun.toFixed(0), 12)
          + padLeft(seg.durationMsPerRun.toFixed(0), 12)
          + padLeft(`$${seg.costPerRunUsd.toFixed(4)}`, 10)
          + padLeft(seg.costPerFindingUsd === null ? "n/a" : `$${seg.costPerFindingUsd.toFixed(4)}`, 14)
          + padLeft(String(seg.thinReviewRunCount), 6)
          + padLeft(`${(seg.thinReviewRate * 100).toFixed(1)}%`, 10),
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
      lines.push(`  ${padRight(reviewer, 20)} ${padLeft(String(count), 5)} findings  (${(share * 100).toFixed(1)}%)`);
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

  return lines.join("\n");
}

// ─── helpers ────────────────────────────────────────────────────────────────

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

function getOrCreateTierAccumulator(map: Map<string, TierAccumulator>, key: string): TierAccumulator {
  let acc = map.get(key);
  if (acc === undefined) {
    acc = {
      runCount: 0,
      totalFindings: 0,
      totalOutputTokens: 0,
      totalInputTokens: 0,
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
