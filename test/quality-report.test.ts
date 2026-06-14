import { describe, expect, test } from "bun:test";

import type { TelemetryEvent } from "../src/contracts/telemetry.ts";
import {
  buildQualityReport,
  DEFAULT_QUALITY_THRESHOLDS,
  formatQualityReport,
} from "../src/state/quality-report.ts";
import type { RunMetricsAnalysis } from "../src/state/run-metrics-analyze.ts";
import { analyzeRunMetrics } from "../src/state/run-metrics-analyze.ts";

// ─── helpers ──────────────────────────────────────────────────────────────────

type PartialRates = Partial<RunMetricsAnalysis["rates"]>;
type AnalysisOverride = Omit<Partial<RunMetricsAnalysis>, "rates"> & { rates?: PartialRates };

/** Minimal RunMetricsAnalysis with no runEvents and zero rates. */
function makeAnalysis(overrides: AnalysisOverride): RunMetricsAnalysis {
  const baseRates: RunMetricsAnalysis["rates"] = {
    groundingDropRunRate: 0,
    groundingWithholdFindingRate: 0,
    groundingProducedFindingCount: 0,
    locationBackfillRunRate: 0,
    acknowledgementRunRate: 0,
    thinReviewRate: 0,
    structuredOutputRate: 0,
  };
  const base: RunMetricsAnalysis = {
    runCount: 10,
    byTier: {},
    cacheHitRate: null,
    byReviewer: {},
    reviewerShare: {},
    decisionCounts: {},
    outcomeCounts: {},
    rates: baseRates,
  };
  // Deep-merge rates so callers only need to specify the fields they care about.
  const mergedRates =
    overrides.rates !== undefined ? { ...baseRates, ...overrides.rates } : baseRates;
  return { ...base, ...overrides, rates: mergedRates };
}

// ─── Basic breach logic ────────────────────────────────────────────────────────

describe("buildQualityReport — overall breach logic", () => {
  test("groundingDropRate breach: above maxGroundingDropRate → hypothesis emitted", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.2, // > 0.15 → breach
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find(
      (x) => x.metric === "groundingDropRate" && x.segment === "overall",
    );
    expect(h).toBeDefined();
    expect(h?.direction).toBe("above");
    expect(h?.value).toBeCloseTo(0.2, 5);
    expect(h?.threshold).toBeCloseTo(0.15, 5);
    expect(h?.sampleSize).toBe(10);
  });

  test("groundingDropRate within threshold → no hypothesis", () => {
    const analysis = makeAnalysis({
      rates: {
        groundingDropRunRate: 0.1, // < 0.15 → OK
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "groundingDropRate")).toBeUndefined();
  });

  test("thinReviewRate breach: above maxThinReviewRate → hypothesis emitted", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      byTier: {
        full: {
          runCount: 8,
          findingsPerRun: 0,
          outputTokensPerRun: 0,
          inputTokensPerRun: 0,
          cacheWriteTokensPerRun: 0,
          cacheReadTokensPerRun: 0,
          cacheHitRate: null,
          durationMsPerRun: 0,
          fanOutMsPerRun: 0,
          fusionMsPerRun: 0,
          costPerRunUsd: 0,
          costPerFindingUsd: null,
          thinReviewRunCount: 0,
          thinReviewRate: 0,
        },
        trivial: {
          runCount: 2,
          findingsPerRun: 0,
          outputTokensPerRun: 0,
          inputTokensPerRun: 0,
          cacheWriteTokensPerRun: 0,
          cacheReadTokensPerRun: 0,
          cacheHitRate: null,
          durationMsPerRun: 0,
          fanOutMsPerRun: 0,
          fusionMsPerRun: 0,
          costPerRunUsd: 0,
          costPerFindingUsd: null,
          thinReviewRunCount: 0,
          thinReviewRate: 0,
        },
      },
      rates: {
        groundingDropRunRate: 0,
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0.25, // > 0.20 → breach; sampleSize = non-trivial = 8
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find(
      (x) => x.metric === "thinReviewRate" && x.segment === "overall",
    );
    expect(h).toBeDefined();
    expect(h?.direction).toBe("above");
    expect(h?.sampleSize).toBe(8); // non-trivial only
  });

  test("runCount === 0 → empty hypotheses", () => {
    const analysis = makeAnalysis({ runCount: 0 });
    const report = buildQualityReport(analysis);
    expect(report.runCount).toBe(0);
    expect(report.hypotheses).toHaveLength(0);
  });
});

// ─── runEvents-gated metrics ──────────────────────────────────────────────────

describe("buildQualityReport — runEvents-gated metrics", () => {
  test("overrideRate breach (above) when runEvents present", () => {
    const analysis = makeAnalysis({
      runEvents: {
        startCount: 10,
        completedCount: 9,
        correctionCount: 0,
        completionRate: 0.9,
        overrideCount: 2,
        overrideRate: 0.2, // > 0.10 → breach
        overrideCountByTier: {},
        acceptanceByReviewer: {},
        acceptanceByTier: {},
        correctionRunCount: 0,
        directional: true,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find((x) => x.metric === "overrideRate");
    expect(h).toBeDefined();
    expect(h?.direction).toBe("above");
    expect(h?.sampleSize).toBe(10);
  });

  test("completionRate breach (below) when runEvents present", () => {
    const analysis = makeAnalysis({
      runEvents: {
        startCount: 10,
        completedCount: 7,
        correctionCount: 0,
        completionRate: 0.7, // < 0.90 → breach
        overrideCount: 0,
        overrideRate: 0,
        overrideCountByTier: {},
        acceptanceByReviewer: {},
        acceptanceByTier: {},
        correctionRunCount: 0,
        directional: true,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find((x) => x.metric === "completionRate");
    expect(h).toBeDefined();
    expect(h?.direction).toBe("below");
    expect(h?.value).toBeCloseTo(0.7, 5);
    expect(h?.threshold).toBeCloseTo(0.9, 5);
    expect(h?.sampleSize).toBe(10);
  });

  test("acceptanceRate breach (below) via runEvents.acceptanceByReviewer", () => {
    const analysis = makeAnalysis({
      runEvents: {
        startCount: 10,
        completedCount: 10,
        correctionCount: 3,
        completionRate: 1.0,
        overrideCount: 0,
        overrideRate: 0,
        overrideCountByTier: {},
        acceptanceByReviewer: {
          security: {
            accepted: 2,
            notAccepted: 8,
            rejected: 0,
            withheldExcluded: 0,
            acceptanceRate: 0.2, // < 0.50 → breach
          },
        },
        acceptanceByTier: {},
        correctionRunCount: 3,
        directional: true,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find(
      (x) => x.metric === "acceptanceRate" && x.segmentType === "reviewer",
    );
    expect(h).toBeDefined();
    expect(h?.direction).toBe("below");
    expect(h?.segment).toBe("security");
    expect(h?.sampleSize).toBe(10); // accepted + notAccepted + rejected
  });

  test("withholdRate breach (above) via runEvents.acceptanceByReviewer", () => {
    const analysis = makeAnalysis({
      runEvents: {
        startCount: 10,
        completedCount: 10,
        correctionCount: 3,
        completionRate: 1.0,
        overrideCount: 0,
        overrideRate: 0,
        overrideCountByTier: {},
        acceptanceByReviewer: {
          security: {
            accepted: 1,
            notAccepted: 1,
            rejected: 1,
            withheldExcluded: 7, // withholdRate = 7/10 = 0.70 > 0.30 → breach
            acceptanceRate: 1 / 3,
          },
        },
        acceptanceByTier: {},
        correctionRunCount: 3,
        directional: true,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find(
      (x) =>
        x.metric === "withholdRate" && x.segmentType === "reviewer" && x.segment === "security",
    );
    expect(h).toBeDefined();
    expect(h?.direction).toBe("above");
    expect(h?.value).toBeCloseTo(0.7, 5);
    expect(h?.sampleSize).toBe(10); // full denominator incl. withheld
  });

  test("runEvents undefined → no override/acceptance/withhold hypotheses, grounding/thin still evaluated", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.25, // > 0.15 → breach
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
      // no runEvents
    });
    const report = buildQualityReport(analysis);

    // grounding breach present
    expect(report.hypotheses.find((x) => x.metric === "groundingDropRate")).toBeDefined();

    // no override, completion, acceptance, withhold
    expect(report.hypotheses.find((x) => x.metric === "overrideRate")).toBeUndefined();
    expect(report.hypotheses.find((x) => x.metric === "completionRate")).toBeUndefined();
    expect(report.hypotheses.find((x) => x.metric === "acceptanceRate")).toBeUndefined();
    expect(report.hypotheses.find((x) => x.metric === "withholdRate")).toBeUndefined();
  });

  test("overrideRate null → no override hypothesis", () => {
    const analysis = makeAnalysis({
      runEvents: {
        startCount: 0,
        completedCount: 0,
        correctionCount: 0,
        completionRate: null,
        overrideCount: 0,
        overrideRate: null, // null → skip
        overrideCountByTier: {},
        acceptanceByReviewer: {},
        acceptanceByTier: {},
        correctionRunCount: 0,
        directional: true,
      },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "overrideRate")).toBeUndefined();
    expect(report.hypotheses.find((x) => x.metric === "completionRate")).toBeUndefined();
  });
});

// ─── Per-tier segments ────────────────────────────────────────────────────────

describe("buildQualityReport — per-tier segments", () => {
  test("high thinReviewRate in one tier appears; within-threshold tier omitted", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      byTier: {
        full: {
          runCount: 8,
          findingsPerRun: 0,
          outputTokensPerRun: 0,
          inputTokensPerRun: 0,
          cacheWriteTokensPerRun: 0,
          cacheReadTokensPerRun: 0,
          cacheHitRate: null,
          durationMsPerRun: 0,
          fanOutMsPerRun: 0,
          fusionMsPerRun: 0,
          costPerRunUsd: 0,
          costPerFindingUsd: null,
          thinReviewRunCount: 5,
          thinReviewRate: 0.625, // > 0.20 → breach
        },
        lite: {
          runCount: 2,
          findingsPerRun: 0,
          outputTokensPerRun: 0,
          inputTokensPerRun: 0,
          cacheWriteTokensPerRun: 0,
          cacheReadTokensPerRun: 0,
          cacheHitRate: null,
          durationMsPerRun: 0,
          fanOutMsPerRun: 0,
          fusionMsPerRun: 0,
          costPerRunUsd: 0,
          costPerFindingUsd: null,
          thinReviewRunCount: 0,
          thinReviewRate: 0.0, // within threshold → no hypothesis
        },
      },
      rates: {
        groundingDropRunRate: 0,
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);

    // full tier thinReviewRate breach present
    const hFull = report.hypotheses.find(
      (x) => x.metric === "thinReviewRate" && x.segmentType === "tier" && x.segment === "full",
    );
    expect(hFull).toBeDefined();
    expect(hFull?.value).toBeCloseTo(0.625, 5);
    expect(hFull?.sampleSize).toBe(8);

    // lite tier thinReviewRate NOT present
    const hLite = report.hypotheses.find(
      (x) => x.metric === "thinReviewRate" && x.segmentType === "tier" && x.segment === "lite",
    );
    expect(hLite).toBeUndefined();
  });

  test("per-tier acceptanceRate breach from acceptanceByTier", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      byTier: {
        full: {
          runCount: 8,
          findingsPerRun: 0,
          outputTokensPerRun: 0,
          inputTokensPerRun: 0,
          cacheWriteTokensPerRun: 0,
          cacheReadTokensPerRun: 0,
          cacheHitRate: null,
          durationMsPerRun: 0,
          fanOutMsPerRun: 0,
          fusionMsPerRun: 0,
          costPerRunUsd: 0,
          costPerFindingUsd: null,
          thinReviewRunCount: 0,
          thinReviewRate: 0,
        },
      },
      runEvents: {
        startCount: 10,
        completedCount: 10,
        correctionCount: 5,
        completionRate: 1.0,
        overrideCount: 0,
        overrideRate: 0,
        overrideCountByTier: {},
        acceptanceByReviewer: {},
        acceptanceByTier: {
          full: {
            accepted: 1,
            notAccepted: 9,
            rejected: 0,
            withheldExcluded: 0,
            acceptanceRate: 0.1, // < 0.50 → breach
          },
        },
        correctionRunCount: 5,
        directional: true,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find(
      (x) => x.metric === "acceptanceRate" && x.segmentType === "tier" && x.segment === "full",
    );
    expect(h).toBeDefined();
    expect(h?.direction).toBe("below");
  });
});

// ─── lowConfidence flagging ───────────────────────────────────────────────────

describe("buildQualityReport — lowConfidence", () => {
  test("sampleSize < minSampleSize → lowConfidence: true, hypothesis still surfaced", () => {
    const analysis = makeAnalysis({
      runCount: 3, // < minSampleSize (5)
      rates: {
        groundingDropRunRate: 0.7, // > 0.15 → breach
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find((x) => x.metric === "groundingDropRate");
    expect(h).toBeDefined();
    expect(h?.lowConfidence).toBe(true);
    expect(h?.sampleSize).toBe(3);
  });

  test("sampleSize >= minSampleSize → lowConfidence: false", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.2, // > 0.15 → breach
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find((x) => x.metric === "groundingDropRate");
    expect(h).toBeDefined();
    expect(h?.lowConfidence).toBe(false);
  });
});

// ─── Threshold overrides ──────────────────────────────────────────────────────

describe("buildQualityReport — threshold overrides", () => {
  test("passing overrides merges with defaults", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.12, // default 0.15 → OK; override 0.10 → breach
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });

    // Default: no breach
    const defaultReport = buildQualityReport(analysis);
    expect(defaultReport.hypotheses.find((x) => x.metric === "groundingDropRate")).toBeUndefined();

    // Override: 0.10 → breach
    const overrideReport = buildQualityReport(analysis, { maxGroundingDropRate: 0.1 });
    expect(overrideReport.hypotheses.find((x) => x.metric === "groundingDropRate")).toBeDefined();
    expect(overrideReport.thresholds.maxGroundingDropRate).toBe(0.1);
    // Other thresholds unchanged
    expect(overrideReport.thresholds.maxThinReviewRate).toBe(
      DEFAULT_QUALITY_THRESHOLDS.maxThinReviewRate,
    );
  });

  test("minSampleSize override changes lowConfidence threshold", () => {
    const analysis = makeAnalysis({
      runCount: 5,
      rates: {
        groundingDropRunRate: 0.25,
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    // Default minSampleSize=5: sampleSize=5, NOT lowConfidence
    const defaultReport = buildQualityReport(analysis);
    const h1 = defaultReport.hypotheses.find((x) => x.metric === "groundingDropRate");
    expect(h1?.lowConfidence).toBe(false);

    // Override minSampleSize=10: sampleSize=5 < 10 → lowConfidence
    const overrideReport = buildQualityReport(analysis, { minSampleSize: 10 });
    const h2 = overrideReport.hypotheses.find((x) => x.metric === "groundingDropRate");
    expect(h2?.lowConfidence).toBe(true);
  });
});

// ─── Deterministic sort ───────────────────────────────────────────────────────

describe("buildQualityReport — sort order", () => {
  test("high-confidence first, then magnitude descending, then lexical tie-break", () => {
    // analysis2 has full(runCount=3, thinRate=1.0 → low-conf breach) +
    // lite(runCount=7, within threshold) so the overall non-trivial sampleSize = 10
    // and overall groundingDrop+thin are high-confidence while the full-tier thin is low-conf.
    const analysis2 = makeAnalysis({
      runCount: 10,
      byTier: {
        full: {
          runCount: 3,
          findingsPerRun: 0,
          outputTokensPerRun: 0,
          inputTokensPerRun: 0,
          cacheWriteTokensPerRun: 0,
          cacheReadTokensPerRun: 0,
          cacheHitRate: null,
          durationMsPerRun: 0,
          fanOutMsPerRun: 0,
          fusionMsPerRun: 0,
          costPerRunUsd: 0,
          costPerFindingUsd: null,
          thinReviewRunCount: 3,
          thinReviewRate: 1.0, // > 0.20 → breach magnitude=0.80, sampleSize=3 → low-conf
        },
        lite: {
          runCount: 7,
          findingsPerRun: 0,
          outputTokensPerRun: 0,
          inputTokensPerRun: 0,
          cacheWriteTokensPerRun: 0,
          cacheReadTokensPerRun: 0,
          cacheHitRate: null,
          durationMsPerRun: 0,
          fanOutMsPerRun: 0,
          fusionMsPerRun: 0,
          costPerRunUsd: 0,
          costPerFindingUsd: null,
          thinReviewRunCount: 0,
          thinReviewRate: 0, // within threshold
        },
      },
      rates: {
        groundingDropRunRate: 0.2, // > 0.15 → breach, magnitude=0.05, sampleSize=10 → high-conf
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0.3, // > 0.20 → breach, magnitude=0.10, sampleSize = full(3)+lite(7)=10 → high-conf
      },
    });

    const report = buildQualityReport(analysis2);
    const hypotheses = report.hypotheses;

    // All high-confidence should come before low-confidence
    let seenLowConf = false;
    for (const h of hypotheses) {
      if (h.lowConfidence) {
        seenLowConf = true;
      } else {
        expect(seenLowConf).toBe(false); // no high-confidence after low-confidence
      }
    }

    // Among high-confidence: thinReviewRate overall (magnitude 0.10) before groundingDropRate (0.05)
    const highConfident = hypotheses.filter((x) => !x.lowConfidence);
    const thinIdx = highConfident.findIndex(
      (x) => x.metric === "thinReviewRate" && x.segment === "overall",
    );
    const groundingIdx = highConfident.findIndex((x) => x.metric === "groundingDropRate");
    expect(thinIdx).toBeLessThan(groundingIdx);
  });
});

// ─── End-to-end wiring: analyzeRunMetrics → buildQualityReport ───────────────

describe("buildQualityReport end-to-end via analyzeRunMetrics", () => {
  test("pipes synthetic events through analyzeRunMetrics then buildQualityReport", () => {
    // Synthetic events: 2 real runs, both full tier
    // run-a has grounding block (groundingDropRunRate = 1.0 > 0.15 → breach)
    // both runs carry run_events with override + low completion
    const events: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-13T00:00:00.000Z",
        runId: "run-a",
        data: {
          runtime: "pi",
          riskTier: "full",
          reviewedFileCount: 4,
          decision: "approved",
          outcome: "pass",
          durationMs: 3000,
          findingCount: 0,
          findingsByReviewer: {},
          tokens: { outputTokens: 1200, inputTokens: 3000, estimatedCostUsd: 0.3 },
          grounding: { droppedFindingCount: 1 }, // counts as grounding drop
        },
      },
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-13T01:00:00.000Z",
        runId: "run-b",
        data: {
          runtime: "pi",
          riskTier: "full",
          reviewedFileCount: 4,
          decision: "approved",
          outcome: "pass",
          durationMs: 3000,
          findingCount: 0,
          findingsByReviewer: {},
          tokens: { outputTokens: 1200, inputTokens: 3000, estimatedCostUsd: 0.3 },
          grounding: { droppedFindingCount: 2 }, // also grounding drop
        },
      },
      // run.start for run-a
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-13T00:00:00.100Z",
        runId: "run-a",
        data: { event: "run.start", schemaVersion: "ai-review.run_event.v1", riskTier: "full" },
      },
      // run.start for run-b
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-13T01:00:00.100Z",
        runId: "run-b",
        data: { event: "run.start", schemaVersion: "ai-review.run_event.v1", riskTier: "full" },
      },
      // only run-a completes → completionRate = 0.5 < 0.90 → breach
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-13T00:00:03.000Z",
        runId: "run-a",
        data: {
          event: "run.completed",
          schemaVersion: "ai-review.run_event.v1",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 3000,
          findingCount: 0,
          findingsBySeverity: {},
          findingsByReviewer: {},
        },
      },
    ];

    const analysis = analyzeRunMetrics(events);
    expect(analysis.runCount).toBe(2);

    const report = buildQualityReport(analysis);
    expect(report.runCount).toBe(2);

    // groundingDropRunRate = 1.0 (both runs have grounding block) → breach above 0.15
    const groundingH = report.hypotheses.find((x) => x.metric === "groundingDropRate");
    expect(groundingH).toBeDefined();
    expect(groundingH?.direction).toBe("above");
    expect(groundingH?.value).toBeCloseTo(1.0, 5);

    // completionRate = 0.5 (1/2 started completed) → breach below 0.90
    const completionH = report.hypotheses.find((x) => x.metric === "completionRate");
    expect(completionH).toBeDefined();
    expect(completionH?.direction).toBe("below");
    expect(completionH?.value).toBeCloseTo(0.5, 5);
  });
});

// ─── formatQualityReport ──────────────────────────────────────────────────────

describe("formatQualityReport", () => {
  test("smoke: output contains header and known hypothesis segment+metric", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.25,
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    const output = formatQualityReport(report);

    expect(output).toContain("Quality Report");
    expect(output).toContain("10 runs");
    expect(output).toContain("overall");
    expect(output).toContain("groundingDropRate");
  });

  test("empty-case line when no hypotheses", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0, // within threshold
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    const output = formatQualityReport(report);
    expect(output).toContain("no quality hypotheses — all segments within thresholds");
  });

  test("low-confidence suffix shown when lowConfidence=true", () => {
    const analysis = makeAnalysis({
      runCount: 3, // < minSampleSize(5) → low-confidence
      rates: {
        groundingDropRunRate: 0.25,
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    const output = formatQualityReport(report);
    expect(output).toContain("[low-confidence n=3]");
  });

  test("direction indicator: > for above, < for below", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.25, // above → >
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
      runEvents: {
        startCount: 10,
        completedCount: 7,
        correctionCount: 0,
        completionRate: 0.7, // below → <
        overrideCount: 0,
        overrideRate: 0,
        overrideCountByTier: {},
        acceptanceByReviewer: {},
        acceptanceByTier: {},
        correctionRunCount: 0,
        directional: true,
      },
    });
    const report = buildQualityReport(analysis);
    const output = formatQualityReport(report);
    expect(output).toContain(">");
    expect(output).toContain("<");
  });

  test("deterministic: identical output on repeated calls", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.25,
        locationBackfillRunRate: 0,
        acknowledgementRunRate: 0,
        thinReviewRate: 0,
      },
    });
    const report = buildQualityReport(analysis);
    expect(formatQualityReport(report)).toBe(formatQualityReport(report));
  });
});

// ─── structuredOutputRate (M015 S05, #128) ───────────────────────────────────

describe("buildQualityReport — structuredOutputRate (M015 S05, #128)", () => {
  test("low structuredOutputRate (0.8 < 0.90) → hypothesis emitted, direction 'below'", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      structuredOutput: { structuredCount: 80, totalCount: 100 },
      rates: { structuredOutputRate: 0.8 },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find((x) => x.metric === "structuredOutputRate");
    expect(h).toBeDefined();
    expect(h?.direction).toBe("below");
    expect(h?.value).toBeCloseTo(0.8, 5);
    expect(h?.threshold).toBeCloseTo(0.9, 5);
    expect(h?.sampleSize).toBe(100);
    expect(h?.segmentType).toBe("overall");
    expect(h?.segment).toBe("overall");
  });

  test("high structuredOutputRate (0.99 ≥ 0.90) → no hypothesis", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      structuredOutput: { structuredCount: 99, totalCount: 100 },
      rates: { structuredOutputRate: 0.99 },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "structuredOutputRate")).toBeUndefined();
  });

  test("structuredOutput absent (no-data) → no hypothesis even though rate is 0", () => {
    // When no run carried a structuredOutput block, structuredOutput is undefined.
    // Rate 0 in that case means "no data", not "all prose" — must NOT flag.
    const analysis = makeAnalysis({
      runCount: 10,
      // structuredOutput intentionally absent
      rates: { structuredOutputRate: 0 },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "structuredOutputRate")).toBeUndefined();
  });

  test("structuredOutput.totalCount === 0 → no hypothesis", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      structuredOutput: { structuredCount: 0, totalCount: 0 },
      rates: { structuredOutputRate: 0 },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "structuredOutputRate")).toBeUndefined();
  });

  test("low structuredOutputRate with small sampleSize → lowConfidence = true", () => {
    // totalCount=3 < minSampleSize=5 → lowConfidence
    const analysis = makeAnalysis({
      runCount: 10,
      structuredOutput: { structuredCount: 0, totalCount: 3 },
      rates: { structuredOutputRate: 0 },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find((x) => x.metric === "structuredOutputRate");
    expect(h).toBeDefined();
    expect(h?.lowConfidence).toBe(true);
    expect(h?.sampleSize).toBe(3);
  });

  test("minStructuredOutputRate threshold override works", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      structuredOutput: { structuredCount: 85, totalCount: 100 },
      rates: { structuredOutputRate: 0.85 },
    });
    // Default 0.90: 0.85 < 0.90 → breach
    const defaultReport = buildQualityReport(analysis);
    expect(defaultReport.hypotheses.find((x) => x.metric === "structuredOutputRate")).toBeDefined();

    // Override to 0.80: 0.85 ≥ 0.80 → no breach
    const overrideReport = buildQualityReport(analysis, { minStructuredOutputRate: 0.8 });
    expect(
      overrideReport.hypotheses.find((x) => x.metric === "structuredOutputRate"),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #207: groundingWithholdRate (finding-level withhold rate)
// ---------------------------------------------------------------------------

describe("buildQualityReport — groundingWithholdRate (#207)", () => {
  test("groundingWithholdRate breach: above maxGroundingWithholdRate (0.30) → hypothesis emitted", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingWithholdFindingRate: 0.4, // > 0.30 → breach
        groundingProducedFindingCount: 100, // finding-level sample size, distinct from runCount=10
      },
    });
    const report = buildQualityReport(analysis);
    const h = report.hypotheses.find(
      (x) => x.metric === "groundingWithholdRate" && x.segment === "overall",
    );
    expect(h).toBeDefined();
    expect(h?.direction).toBe("above");
    expect(h?.value).toBeCloseTo(0.4, 5);
    expect(h?.threshold).toBeCloseTo(0.3, 5);
    // Finding-level metric → sampleSize is produced-finding count, NOT runCount (#207 fix).
    expect(h?.sampleSize).toBe(100);
  });

  test("groundingWithholdRate within threshold → no hypothesis", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingWithholdFindingRate: 0.2, // < 0.30 → OK
      },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "groundingWithholdRate")).toBeUndefined();
  });

  test("groundingWithholdRate at exactly threshold boundary → no hypothesis (not strictly above)", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingWithholdFindingRate: 0.3, // = 0.30 → not above → no breach
      },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "groundingWithholdRate")).toBeUndefined();
  });

  test("groundingWithholdRate threshold override works", () => {
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingWithholdFindingRate: 0.35, // > 0.30 default → breach
      },
    });
    // Default 0.30: breach
    const defaultReport = buildQualityReport(analysis);
    expect(
      defaultReport.hypotheses.find((x) => x.metric === "groundingWithholdRate"),
    ).toBeDefined();

    // Override to 0.40: 0.35 < 0.40 → no breach
    const overrideReport = buildQualityReport(analysis, { maxGroundingWithholdRate: 0.4 });
    expect(
      overrideReport.hypotheses.find((x) => x.metric === "groundingWithholdRate"),
    ).toBeUndefined();
  });

  test("existing groundingDropRate metric is unaffected by addition of groundingWithholdRate", () => {
    // Both can breach simultaneously — they are complementary, not substitutes.
    const analysis = makeAnalysis({
      runCount: 10,
      rates: {
        groundingDropRunRate: 0.2, // > 0.15 → breach
        groundingWithholdFindingRate: 0.4, // > 0.30 → breach
      },
    });
    const report = buildQualityReport(analysis);
    expect(report.hypotheses.find((x) => x.metric === "groundingDropRate")).toBeDefined();
    expect(report.hypotheses.find((x) => x.metric === "groundingWithholdRate")).toBeDefined();
  });
});
