// Quality report: turns RunMetricsAnalysis segments into a hypothesis queue.
// Pure leaf module — no I/O, no network, no adapter imports.
// Imports only from ./run-metrics-analyze.ts (the single source of input shape).
//
// M008 constraint: this report carries only rates, counts, segment keys, and
// threshold numbers — never a finding body, diff, prompt, or secret.
// The input (RunMetricsAnalysis) already excludes these; we add no new content field.

import type { ReviewerAcceptanceStat, RunMetricsAnalysis } from "./run-metrics-analyze.ts";

// ─── public types ────────────────────────────────────────────────────────────

export type HypothesisMetric =
  | "groundingDropRate"
  | "groundingWithholdRate"
  | "thinReviewRate"
  | "overrideRate"
  | "acceptanceRate"
  | "withholdRate"
  | "completionRate"
  | "structuredOutputRate";

export type SegmentType = "overall" | "tier" | "reviewer";

/** "above" = breached a MAX threshold (bad-high); "below" = fell under a MIN threshold (bad-low). */
export type BreachDirection = "above" | "below";

export interface QualityHypothesis {
  segmentType: SegmentType;
  /** Segment key: "overall", a tier name ("full"/"lite"/...), or a reviewer role. */
  segment: string;
  metric: HypothesisMetric;
  /** Observed rate in [0,1]. */
  value: number;
  /** The threshold it breached. */
  threshold: number;
  direction: BreachDirection;
  /** Denominator behind `value` (runs, or directional acceptance samples) — confidence weight. */
  sampleSize: number;
  /** true when sampleSize < thresholds.minSampleSize: surfaced, but flagged low-confidence. */
  lowConfidence: boolean;
}

export interface QualityReportThresholds {
  maxGroundingDropRate: number; // default 0.15
  /** Finding-level grounding withhold rate (demoted ÷ produced); climbing-rate MAX threshold. default 0.30 */
  maxGroundingWithholdRate: number; // default 0.30
  maxThinReviewRate: number; // default 0.20
  maxOverrideRate: number; // default 0.10
  minAcceptanceRate: number; // default 0.50
  maxWithholdRate: number; // default 0.30
  minCompletionRate: number; // default 0.90
  minStructuredOutputRate: number; // default 0.90
  /** Segments below this sample size are surfaced but marked lowConfidence. default 5 */
  minSampleSize: number;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityReportThresholds = {
  maxGroundingDropRate: 0.15,
  maxGroundingWithholdRate: 0.3,
  maxThinReviewRate: 0.2,
  maxOverrideRate: 0.1,
  minAcceptanceRate: 0.5,
  maxWithholdRate: 0.3,
  minCompletionRate: 0.9,
  minStructuredOutputRate: 0.9,
  minSampleSize: 5,
};

export interface QualityReport {
  runCount: number;
  thresholds: QualityReportThresholds;
  /** Threshold-breaching segments = the hypothesis queue, deterministically sorted. */
  hypotheses: QualityHypothesis[];
}

// ─── public API ──────────────────────────────────────────────────────────────

export function buildQualityReport(
  analysis: RunMetricsAnalysis,
  thresholds?: Partial<QualityReportThresholds>,
): QualityReport {
  const t: QualityReportThresholds = { ...DEFAULT_QUALITY_THRESHOLDS, ...thresholds };

  if (analysis.runCount === 0) {
    return { runCount: 0, thresholds: t, hypotheses: [] };
  }

  const hypotheses: QualityHypothesis[] = [];

  // ── Overall segment ────────────────────────────────────────────────────────

  // groundingDropRate ← rates.groundingDropRunRate; sampleSize = runCount
  const groundingDropRate = analysis.rates.groundingDropRunRate;
  if (groundingDropRate !== null && groundingDropRate !== undefined) {
    checkBreach(hypotheses, t, {
      segmentType: "overall",
      segment: "overall",
      metric: "groundingDropRate",
      value: groundingDropRate,
      threshold: t.maxGroundingDropRate,
      direction: "above",
      sampleSize: analysis.runCount,
    });
  }

  // groundingWithholdRate ← rates.groundingWithholdFindingRate (#207). Finding-level rate:
  // demoted ÷ produced. Complements the run-level groundingDropRate — "1 of 10 findings demoted"
  // is distinguishable from "10 of 10 findings demoted".
  const groundingWithholdFindingRate = analysis.rates.groundingWithholdFindingRate;
  if (groundingWithholdFindingRate !== null && groundingWithholdFindingRate !== undefined) {
    checkBreach(hypotheses, t, {
      segmentType: "overall",
      segment: "overall",
      metric: "groundingWithholdRate",
      value: groundingWithholdFindingRate,
      threshold: t.maxGroundingWithholdRate,
      direction: "above",
      // Finding-level rate → finding-level sample size (produced findings), NOT runCount.
      // runCount would mis-flag lowConfidence whenever runs and produced-findings diverge.
      sampleSize: analysis.rates.groundingProducedFindingCount,
    });
  }

  // thinReviewRate ← rates.thinReviewRate; sampleSize = non-trivial run count
  const thinReviewRate = analysis.rates.thinReviewRate;
  if (thinReviewRate !== null && thinReviewRate !== undefined) {
    const nonTrivialRunCount = Object.entries(analysis.byTier)
      .filter(([tier]) => tier !== "trivial")
      .reduce((sum, [, seg]) => sum + seg.runCount, 0);
    checkBreach(hypotheses, t, {
      segmentType: "overall",
      segment: "overall",
      metric: "thinReviewRate",
      value: thinReviewRate,
      threshold: t.maxThinReviewRate,
      direction: "above",
      sampleSize: nonTrivialRunCount,
    });
  }

  // structuredOutputRate ← rates.structuredOutputRate; sampleSize = total Pi agent-runs measured.
  // Only checked when at least one run carried structured-output counts (else 0% is "no data",
  // not a breach). Surfaces when the structured path underperforms — the signal that gates the
  // eventual repair retirement (see docs/milestones/M015-ROADMAP.md S05). Direction "below".
  if (analysis.structuredOutput !== undefined && analysis.structuredOutput.totalCount > 0) {
    checkBreach(hypotheses, t, {
      segmentType: "overall",
      segment: "overall",
      metric: "structuredOutputRate",
      value: analysis.rates.structuredOutputRate,
      threshold: t.minStructuredOutputRate,
      direction: "below",
      sampleSize: analysis.structuredOutput.totalCount,
    });
  }

  // overrideRate + completionRate — only if runEvents is present
  if (analysis.runEvents !== undefined) {
    const re = analysis.runEvents;

    // overrideRate: skip if null
    if (re.overrideRate !== null && re.overrideRate !== undefined) {
      checkBreach(hypotheses, t, {
        segmentType: "overall",
        segment: "overall",
        metric: "overrideRate",
        value: re.overrideRate,
        threshold: t.maxOverrideRate,
        direction: "above",
        sampleSize: re.startCount,
      });
    }

    // completionRate: skip if null
    if (re.completionRate !== null && re.completionRate !== undefined) {
      checkBreach(hypotheses, t, {
        segmentType: "overall",
        segment: "overall",
        metric: "completionRate",
        value: re.completionRate,
        threshold: t.minCompletionRate,
        direction: "below",
        sampleSize: re.startCount,
      });
    }
  }

  // ── Per-tier segments ──────────────────────────────────────────────────────

  for (const tier of Object.keys(analysis.byTier).sort()) {
    const seg = analysis.byTier[tier];
    if (seg === undefined) {
      continue;
    }

    // thinReviewRate per tier
    checkBreach(hypotheses, t, {
      segmentType: "tier",
      segment: tier,
      metric: "thinReviewRate",
      value: seg.thinReviewRate,
      threshold: t.maxThinReviewRate,
      direction: "above",
      sampleSize: seg.runCount,
    });

    // acceptanceRate + withholdRate per tier — only if runEvents present
    if (analysis.runEvents !== undefined) {
      const stat = analysis.runEvents.acceptanceByTier[tier];
      if (stat !== undefined) {
        checkAcceptanceAndWithhold(hypotheses, t, "tier", tier, stat);
      }
    }
  }

  // ── Per-reviewer segments ──────────────────────────────────────────────────

  if (analysis.runEvents !== undefined) {
    const re = analysis.runEvents;
    for (const reviewer of Object.keys(re.acceptanceByReviewer).sort()) {
      const stat = re.acceptanceByReviewer[reviewer];
      if (stat === undefined) {
        continue;
      }
      checkAcceptanceAndWithhold(hypotheses, t, "reviewer", reviewer, stat);
    }
  }

  // ── Sort hypotheses deterministically ─────────────────────────────────────
  // (1) high-confidence first (lowConfidence false before true)
  // (2) breach magnitude descending
  // (3) tie-break: segmentType, segment, metric (lexical)

  hypotheses.sort((a, b) => {
    // (1) confidence: false (high-confidence) before true (low-confidence)
    if (a.lowConfidence !== b.lowConfidence) {
      return a.lowConfidence ? 1 : -1;
    }
    // (2) magnitude descending
    const magA = breachMagnitude(a);
    const magB = breachMagnitude(b);
    if (magA !== magB) {
      return magB - magA;
    }
    // (3) lexical tie-break
    if (a.segmentType !== b.segmentType) {
      return a.segmentType < b.segmentType ? -1 : 1;
    }
    if (a.segment !== b.segment) {
      return a.segment < b.segment ? -1 : 1;
    }
    return a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0;
  });

  return { runCount: analysis.runCount, thresholds: t, hypotheses };
}

export function formatQualityReport(report: QualityReport): string {
  const lines: string[] = [];

  lines.push(
    `=== Quality Report (${report.runCount} runs, ${report.hypotheses.length} hypotheses) ===`,
  );
  lines.push("");

  if (report.hypotheses.length === 0) {
    lines.push("  (no quality hypotheses — all segments within thresholds)");
    return lines.join("\n");
  }

  // Header row
  lines.push(
    padRight("Segment", 28) +
      padRight("Metric", 20) +
      padLeft("Value", 8) +
      padLeft("Threshold", 11) +
      "  Note",
  );

  for (const h of report.hypotheses) {
    const segLabel = `${h.segmentType}:${h.segment}`;
    const direction = h.direction === "above" ? ">" : "<";
    const note = h.lowConfidence ? `  [low-confidence n=${h.sampleSize}]` : "";
    lines.push(
      padRight(segLabel, 28) +
        padRight(h.metric, 20) +
        padLeft(`${(h.value * 100).toFixed(1)}%`, 8) +
        padLeft(`${direction}${(h.threshold * 100).toFixed(1)}%`, 11) +
        note,
    );
  }

  return lines.join("\n");
}

// ─── helpers ─────────────────────────────────────────────────────────────────

interface BreachCandidate {
  segmentType: SegmentType;
  segment: string;
  metric: HypothesisMetric;
  value: number;
  threshold: number;
  direction: BreachDirection;
  sampleSize: number;
}

function checkBreach(
  out: QualityHypothesis[],
  t: QualityReportThresholds,
  candidate: BreachCandidate,
): void {
  const breached =
    candidate.direction === "above"
      ? candidate.value > candidate.threshold
      : candidate.value < candidate.threshold;

  if (!breached) {
    return;
  }

  out.push({
    segmentType: candidate.segmentType,
    segment: candidate.segment,
    metric: candidate.metric,
    value: candidate.value,
    threshold: candidate.threshold,
    direction: candidate.direction,
    sampleSize: candidate.sampleSize,
    lowConfidence: candidate.sampleSize < t.minSampleSize,
  });
}

function checkAcceptanceAndWithhold(
  out: QualityHypothesis[],
  t: QualityReportThresholds,
  segmentType: SegmentType,
  segment: string,
  stat: ReviewerAcceptanceStat,
): void {
  // acceptanceRate: skip if undefined
  if (stat.acceptanceRate !== undefined) {
    const denominator = stat.accepted + stat.notAccepted + stat.rejected;
    checkBreach(out, t, {
      segmentType,
      segment,
      metric: "acceptanceRate",
      value: stat.acceptanceRate,
      threshold: t.minAcceptanceRate,
      direction: "below",
      sampleSize: denominator,
    });
  }

  // withholdRate: skip when full denominator (incl. withheld) is 0
  const withholdDenominator =
    stat.accepted + stat.notAccepted + stat.rejected + stat.withheldExcluded;
  if (withholdDenominator > 0) {
    const withholdRate = stat.withheldExcluded / withholdDenominator;
    checkBreach(out, t, {
      segmentType,
      segment,
      metric: "withholdRate",
      value: withholdRate,
      threshold: t.maxWithholdRate,
      direction: "above",
      sampleSize: withholdDenominator,
    });
  }
}

function breachMagnitude(h: QualityHypothesis): number {
  return h.direction === "above" ? h.value - h.threshold : h.threshold - h.value;
}

// Local copies of padRight/padLeft — intentional local copy, do NOT export from
// run-metrics-analyze.ts (keep each analytics module self-contained, mirroring the
// evidence-grounding.ts ↔ stable-finding-id.ts precedent; see comment at the top of
// run-metrics-analyze.ts).

function padRight(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function padLeft(str: string, width: number): string {
  return str.length >= width ? str : " ".repeat(width - str.length) + str;
}
