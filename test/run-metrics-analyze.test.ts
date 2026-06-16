import { describe, expect, test } from "bun:test";

import type { TelemetryEvent } from "../src/contracts/telemetry.ts";
import { analyzeRunMetrics, formatRunMetricsAnalysis } from "../src/state/run-metrics-analyze.ts";

// Synthetic events that cover all branches:
//   run-1: full tier, many findings, high output tokens — NOT thin (contextual floor: 300 + 60*4 = 540 < 1200)
//   run-2: lite tier, low output tokens — flagged thin (contextual floor: 0 + 60*3 = 180 > 100)
//   run-3: trivial tier, ~0 output tokens — NOT thin (trivial is never flagged)
//   run-4: dummy runtime — EXCLUDED
//   run-5: non-run_metrics event — ignored
//   run-1 also carries grounding/locationBackfill/acknowledgements blocks

const events: TelemetryEvent[] = [
  // run-1: full tier, 2 findings, high output tokens, optional blocks present
  //   reviewedFileCount=4 → floor = 300 + 60*4 = 540 < 1200 → NOT thin
  {
    type: "ai_review.run_metrics",
    timestamp: "2026-06-11T00:00:00.000Z",
    runId: "run-1",
    data: {
      runtime: "pi",
      riskTier: "full",
      reviewedFileCount: 4,
      decision: "significant_concerns",
      outcome: "fail",
      durationMs: 5000,
      findingsByReviewer: {
        security: 1,
        performance: 1,
      },
      findingCount: 2,
      tokens: {
        agentCount: 4,
        inputTokens: 3000,
        outputTokens: 1200,
        cacheReadTokens: 6000,
        cacheWriteTokens: 1000,
        estimatedCostUsd: 0.6,
      },
      grounding: { droppedFindingCount: 1 },
      locationBackfill: { backfilledCount: 1 },
      acknowledgements: { acknowledgedCount: 1 },
    },
  },
  // run-2: lite tier, 1 finding, low output tokens
  //   reviewedFileCount=3 → contextual floor = 0 + 60*3 = 180 > 100 → thin
  {
    type: "ai_review.run_metrics",
    timestamp: "2026-06-11T01:00:00.000Z",
    runId: "run-2",
    data: {
      runtime: "pi",
      riskTier: "lite",
      reviewedFileCount: 3,
      decision: "no_findings",
      outcome: "pass",
      durationMs: 2000,
      findingsByReviewer: {
        security: 1,
      },
      findingCount: 1,
      tokens: {
        agentCount: 2,
        inputTokens: 800,
        outputTokens: 100,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.2,
      },
    },
  },
  // run-3: trivial tier, 0 findings, ~0 output tokens → NOT thin (trivial is never flagged)
  {
    type: "ai_review.run_metrics",
    timestamp: "2026-06-11T02:00:00.000Z",
    runId: "run-3",
    data: {
      runtime: "pi",
      riskTier: "trivial",
      decision: "approved",
      outcome: "pass",
      durationMs: 500,
      findingsByReviewer: {},
      findingCount: 0,
      tokens: {
        agentCount: 1,
        inputTokens: 200,
        outputTokens: 10,
        estimatedCostUsd: 0.01,
      },
    },
  },
  // run-4: dummy runtime → EXCLUDED
  {
    type: "ai_review.run_metrics",
    timestamp: "2026-06-11T03:00:00.000Z",
    runId: "run-4",
    data: {
      runtime: "dummy",
      riskTier: "full",
      decision: "significant_concerns",
      outcome: "fail",
      findingCount: 10,
    },
  },
  // run-5: non-run_metrics event → ignored
  {
    type: "runtime.event",
    timestamp: "2026-06-11T04:00:00.000Z",
    data: {
      event: "telemetry.emit_failed",
    },
  },
];

test("analyzeRunMetrics excludes dummy runtime and non-run_metrics events", () => {
  const analysis = analyzeRunMetrics(events);
  // Only run-1, run-2, run-3 are real pi runs
  expect(analysis.runCount).toBe(3);
});

test("analyzeRunMetrics byTier runCount", () => {
  const analysis = analyzeRunMetrics(events);
  expect(analysis.byTier.full?.runCount).toBe(1);
  expect(analysis.byTier.lite?.runCount).toBe(1);
  expect(analysis.byTier.trivial?.runCount).toBe(1);
});

test("analyzeRunMetrics byTier findingsPerRun", () => {
  const analysis = analyzeRunMetrics(events);
  expect(analysis.byTier.full?.findingsPerRun).toBe(2);
  expect(analysis.byTier.lite?.findingsPerRun).toBe(1);
  expect(analysis.byTier.trivial?.findingsPerRun).toBe(0);
});

test("analyzeRunMetrics byTier outputTokensPerRun", () => {
  const analysis = analyzeRunMetrics(events);
  expect(analysis.byTier.full?.outputTokensPerRun).toBe(1200);
  expect(analysis.byTier.lite?.outputTokensPerRun).toBe(100);
  expect(analysis.byTier.trivial?.outputTokensPerRun).toBe(10);
});

test("analyzeRunMetrics byTier costPerFindingUsd — null when 0 findings", () => {
  const analysis = analyzeRunMetrics(events);
  // full tier: cost 0.6, 2 findings → 0.3
  expect(analysis.byTier.full?.costPerFindingUsd).toBeCloseTo(0.3, 5);
  // trivial tier: 0 findings → null
  expect(analysis.byTier.trivial?.costPerFindingUsd).toBeNull();
});

test("analyzeRunMetrics thin-review: lite run is thin, trivial run is NOT thin", () => {
  const analysis = analyzeRunMetrics(events);

  // lite run has 100 output tokens < contextual floor (60*3=180) → thin
  expect(analysis.byTier.lite?.thinReviewRunCount).toBe(1);
  expect(analysis.byTier.lite?.thinReviewRate).toBeCloseTo(1.0, 5);

  // full run has 1200 output tokens > contextual floor (300+60*4=540) → NOT thin
  expect(analysis.byTier.full?.thinReviewRunCount).toBe(0);
  expect(analysis.byTier.full?.thinReviewRate).toBe(0);

  // trivial run is NEVER flagged thin regardless of token count
  expect(analysis.byTier.trivial?.thinReviewRunCount).toBe(0);
  expect(analysis.byTier.trivial?.thinReviewRate).toBe(0);
});

test("analyzeRunMetrics thin-review: overall thinReviewRate uses non-trivial denominator", () => {
  const analysis = analyzeRunMetrics(events);
  // Non-trivial runs: full (1) + lite (1) = 2; thin = 1 (lite) → rate = 0.5
  expect(analysis.rates.thinReviewRate).toBeCloseTo(0.5, 5);
});

test("analyzeRunMetrics thin-review: legacy events without reviewedFileCount fall back to the flat floor", () => {
  // Pre-#91 telemetry events do not carry reviewedFileCount. Without a fallback these would get
  // a lite contextual floor of 60*0 = 0 and never flag thin — silently breaking historical
  // comparability. Assert the flat legacy floor (250) is applied instead.
  const legacyEvents: TelemetryEvent[] = [
    // legacy lite run, 100 output tokens, NO reviewedFileCount → thin via flat-250 fallback
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-05-01T00:00:00.000Z",
      runId: "legacy-thin",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "no_findings",
        outcome: "pass",
        findingCount: 0,
        tokens: { agentCount: 2, outputTokens: 100 },
      },
    },
    // legacy lite run, 400 output tokens, NO reviewedFileCount → NOT thin (above flat-250)
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-05-01T01:00:00.000Z",
      runId: "legacy-engaged",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "minor_issues",
        outcome: "pass",
        findingCount: 1,
        tokens: { agentCount: 2, outputTokens: 400 },
      },
    },
  ];

  const analysis = analyzeRunMetrics(legacyEvents);
  expect(analysis.byTier.lite?.runCount).toBe(2);
  // Only the 100-token run is thin (100 < 250); the 400-token run is not (400 >= 250).
  expect(analysis.byTier.lite?.thinReviewRunCount).toBe(1);
});

test("analyzeRunMetrics custom thinReviewOutputTokenFloor (flat-floor override)", () => {
  // With flat floor = 150, the lite run (100 tokens) is still thin, full (1200) is not
  const analysis = analyzeRunMetrics(events, { thinReviewOutputTokenFloor: 150 });
  expect(analysis.byTier.lite?.thinReviewRunCount).toBe(1);
  expect(analysis.byTier.full?.thinReviewRunCount).toBe(0);

  // With a flat floor of 2000, both full (1200) and lite (100) are thin
  const analysis2 = analyzeRunMetrics(events, { thinReviewOutputTokenFloor: 2000 });
  expect(analysis2.byTier.lite?.thinReviewRunCount).toBe(1);
  expect(analysis2.byTier.full?.thinReviewRunCount).toBe(1);
  expect(analysis2.byTier.trivial?.thinReviewRunCount).toBe(0); // trivial still excluded
});

test("analyzeRunMetrics byReviewer and reviewerShare", () => {
  const analysis = analyzeRunMetrics(events);
  // run-1: security=1, performance=1; run-2: security=1; trivial: empty
  expect(analysis.byReviewer.security).toBe(2);
  expect(analysis.byReviewer.performance).toBe(1);
  // Total findings = 3; security share = 2/3, performance share = 1/3
  expect(analysis.reviewerShare.security).toBeCloseTo(2 / 3, 5);
  expect(analysis.reviewerShare.performance).toBeCloseTo(1 / 3, 5);
});

test("analyzeRunMetrics decisionCounts", () => {
  const analysis = analyzeRunMetrics(events);
  expect(analysis.decisionCounts.significant_concerns).toBe(1);
  expect(analysis.decisionCounts.no_findings).toBe(1);
  expect(analysis.decisionCounts.approved).toBe(1);
  // dummy run decision not counted
  expect(analysis.decisionCounts.review_failed).toBeUndefined();
});

test("analyzeRunMetrics outcomeCounts", () => {
  const analysis = analyzeRunMetrics(events);
  expect(analysis.outcomeCounts.fail).toBe(1);
  expect(analysis.outcomeCounts.pass).toBe(2);
});

test("analyzeRunMetrics rates — grounding/locationBackfill/acknowledgements from run-1 only", () => {
  const analysis = analyzeRunMetrics(events);
  // Only run-1 has those blocks; 1/3 runs
  expect(analysis.rates.groundingDropRunRate).toBeCloseTo(1 / 3, 5);
  expect(analysis.rates.locationBackfillRunRate).toBeCloseTo(1 / 3, 5);
  expect(analysis.rates.acknowledgementRunRate).toBeCloseTo(1 / 3, 5);
});

test("analyzeRunMetrics rates are 0 when runCount is 0", () => {
  const analysis = analyzeRunMetrics([]);
  expect(analysis.runCount).toBe(0);
  expect(analysis.rates.groundingDropRunRate).toBe(0);
  expect(analysis.rates.locationBackfillRunRate).toBe(0);
  expect(analysis.rates.acknowledgementRunRate).toBe(0);
  expect(analysis.rates.thinReviewRate).toBe(0);
  expect(analysis.rates.structuredOutputRate).toBe(0);
  expect(analysis.rates.fusionDropRate).toBe(0);
  expect(analysis.rates.fusionDropSampleFindingCount).toBe(0);
  expect(analysis.rates.fusionRawMinusSurvivingRate).toBe(0);
  expect(analysis.rates.fusionRawFindingCount).toBe(0);
  expect(analysis.structuredOutput).toBeUndefined();
});

// ---------------------------------------------------------------------------
// #258 fusionDropRate
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics fusionDropRate (#258)", () => {
  const fusionEvents: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T00:00:00.000Z",
      runId: "fusion-a",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "minor_issues",
        outcome: "pass",
        findingCount: 2,
        findingsByReviewer: { security: 2 },
        fusion: {
          rawFindingCount: 5,
          survivingFindingCount: 2,
          rawMinusSurvivingCount: 3,
          attributionComplete: false,
          mergedCount: 0,
          droppedCount: 0,
          rawByReviewer: { correctness: 3, security: 2 },
        },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T01:00:00.000Z",
      runId: "fusion-b",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        findingCount: 1,
        findingsByReviewer: { security: 1 },
        fusion: {
          rawFindingCount: 1,
          survivingFindingCount: 1,
          rawMinusSurvivingCount: 0,
          attributionComplete: false,
          mergedCount: 0,
          droppedCount: 0,
          rawByReviewer: { security: 1 },
        },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T02:00:00.000Z",
      runId: "fusion-dummy",
      data: {
        runtime: "dummy",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        findingCount: 0,
        fusion: {
          rawFindingCount: 100,
          survivingFindingCount: 0,
          rawMinusSurvivingCount: 100,
          attributionComplete: false,
          mergedCount: 0,
          droppedCount: 0,
        },
      },
    },
  ];

  test("pooled raw-minus-surviving rate uses raw-finding denominator across real runs", () => {
    const analysis = analyzeRunMetrics(fusionEvents);
    expect(analysis.rates.fusionRawFindingCount).toBe(6);
    expect(analysis.rates.fusionRawMinusSurvivingRate).toBeCloseTo(3 / 6, 5);
    expect(analysis.rates.fusionDropRate).toBe(0);
    expect(analysis.rates.fusionDropSampleFindingCount).toBe(0);
  });

  test("formatRunMetricsAnalysis includes fusion raw-minus and drop denominators", () => {
    const output = formatRunMetricsAnalysis(analyzeRunMetrics(fusionEvents));
    expect(output).toContain("fusionRawMinusSurvivingRate");
    expect(output).toContain("fusionDropRate");
    expect(output).toContain("n=6");
    expect(output).toContain("n=0");
  });

  test("attribution-complete events contribute to true fusionDropRate", () => {
    const analysis = analyzeRunMetrics([
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-14T02:30:00.000Z",
        runId: "fusion-attributed",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "minor_issues",
          outcome: "pass",
          findingCount: 3,
          findingsByReviewer: { security: 3 },
          fusion: {
            rawFindingCount: 5,
            survivingFindingCount: 3,
            rawMinusSurvivingCount: 2,
            attributionComplete: true,
            mergedCount: 0,
            droppedCount: 2,
            rawByReviewer: { security: 5 },
          },
        },
      },
    ]);

    expect(analysis.rates.fusionDropSampleFindingCount).toBe(5);
    expect(analysis.rates.fusionDropRate).toBeCloseTo(2 / 5, 5);
    expect(analysis.rates.fusionRawMinusSurvivingRate).toBeCloseTo(2 / 5, 5);
  });

  test("no raw findings is no-data denominator: rate 0, sample count 0", () => {
    const analysis = analyzeRunMetrics([
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-14T03:00:00.000Z",
        runId: "fusion-empty",
        data: {
          runtime: "pi",
          riskTier: "lite",
          decision: "approved",
          outcome: "pass",
          findingCount: 0,
          findingsByReviewer: {},
          fusion: {
            rawFindingCount: 0,
            survivingFindingCount: 1,
            rawMinusSurvivingCount: 0,
            attributionComplete: false,
            mergedCount: 0,
            droppedCount: 0,
            rawByReviewer: { security: 0 },
          },
        },
      },
    ]);

    expect(analysis.rates.fusionDropRate).toBe(0);
    expect(analysis.rates.fusionDropSampleFindingCount).toBe(0);
    expect(analysis.rates.fusionRawMinusSurvivingRate).toBe(0);
    expect(analysis.rates.fusionRawFindingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #260 convergence / flap metric
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics convergence metrics (#260)", () => {
  const convergenceEvents: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T00:00:00.000Z",
      runId: "convergence-a",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "significant_concerns",
        outcome: "fail",
        findingCount: 2,
        findingsByReviewer: { security: 2 },
        convergence: {
          maxRecurrenceDepth: 4,
          flappingFindingCount: 1,
          currentFindingCount: 2,
        },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T01:00:00.000Z",
      runId: "convergence-b",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "minor_issues",
        outcome: "pass",
        findingCount: 1,
        findingsByReviewer: { correctness: 1 },
        convergence: {
          maxRecurrenceDepth: 2,
          flappingFindingCount: 0,
          currentFindingCount: 1,
        },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T02:00:00.000Z",
      runId: "convergence-dummy",
      data: {
        runtime: "dummy",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        findingCount: 1,
        convergence: {
          maxRecurrenceDepth: 99,
          flappingFindingCount: 99,
          currentFindingCount: 99,
        },
      },
    },
  ];

  test("aggregates flap rate and max recurrence depth across real runs", () => {
    const analysis = analyzeRunMetrics(convergenceEvents);
    expect(analysis.convergence).toEqual({
      runCount: 2,
      currentFindingCount: 3,
      flappingFindingCount: 1,
      flapRate: 1 / 3,
      maxRecurrenceDepth: 4,
    });
  });

  test("formatRunMetricsAnalysis includes convergence metrics when present", () => {
    const output = formatRunMetricsAnalysis(analyzeRunMetrics(convergenceEvents));
    expect(output).toContain("convergenceFlapRate");
    expect(output).toContain("maxRecurrenceDepth");
    expect(output).toContain("n=3");
    expect(output).toContain("runs=2");
  });
});

// ---------------------------------------------------------------------------
// M015 S05 (#128): structuredOutputRate
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics structuredOutputRate (M015 S05, #128)", () => {
  // run-A: 3 of 3 Pi agents used the structured tool
  // run-B: 1 of 3 Pi agents used the structured tool
  // pooled: 4/6 ≈ 0.6667
  const structuredEvents: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-13T00:00:00.000Z",
      runId: "run-A",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 3000,
        findingCount: 0,
        findingsByReviewer: {},
        structuredOutput: { structuredCount: 3, totalCount: 3 },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-13T01:00:00.000Z",
      runId: "run-B",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "minor_issues",
        outcome: "pass",
        durationMs: 4000,
        findingCount: 1,
        findingsByReviewer: { security: 1 },
        structuredOutput: { structuredCount: 1, totalCount: 3 },
      },
    },
    // dummy runtime: EXCLUDED from real events; structuredOutput block must not be counted
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-13T02:00:00.000Z",
      runId: "run-dummy",
      data: {
        runtime: "dummy",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        findingCount: 0,
        findingsByReviewer: {},
        structuredOutput: { structuredCount: 99, totalCount: 99 },
      },
    },
  ];

  test("pooled structuredOutputRate across two real-Pi runs", () => {
    const analysis = analyzeRunMetrics(structuredEvents);
    // run-A: 3/3, run-B: 1/3 → pooled 4/6
    expect(analysis.rates.structuredOutputRate).toBeCloseTo(4 / 6, 5);
    expect(analysis.structuredOutput).toEqual({ structuredCount: 4, totalCount: 6 });
  });

  test("dummy-runtime run is excluded from structuredOutput counts", () => {
    const analysis = analyzeRunMetrics(structuredEvents);
    // only run-A and run-B contribute (dummy excluded); totalCount should be 6, not 105
    expect(analysis.structuredOutput?.totalCount).toBe(6);
    expect(analysis.structuredOutput?.structuredCount).toBe(4);
  });

  test("events with no structuredOutput block → structuredOutputRate 0, structuredOutput absent", () => {
    // Use the existing base events fixture (no structuredOutput block in any event)
    const analysis = analyzeRunMetrics(events);
    expect(analysis.rates.structuredOutputRate).toBe(0);
    expect(analysis.structuredOutput).toBeUndefined();
  });
});

test("formatRunMetricsAnalysis contains expected tier rows and labels", () => {
  const analysis = analyzeRunMetrics(events);
  const output = formatRunMetricsAnalysis(analysis);

  // Header
  expect(output).toContain("Run Metrics Analysis");
  expect(output).toContain("3 runs");

  // Tier section
  expect(output).toContain("By Risk Tier");
  expect(output).toContain("full");
  expect(output).toContain("lite");
  expect(output).toContain("trivial");

  // Reviewer section
  expect(output).toContain("By Reviewer");
  expect(output).toContain("security");
  expect(output).toContain("performance");

  // Decision section
  expect(output).toContain("Decision Distribution");
  expect(output).toContain("significant_concerns");
  expect(output).toContain("no_findings");
  expect(output).toContain("approved");

  // Outcome section
  expect(output).toContain("CI Outcome Distribution");
  expect(output).toContain("fail");
  expect(output).toContain("pass");

  // Rates section
  expect(output).toContain("Rates");
  expect(output).toContain("groundingDropRunRate");
  expect(output).toContain("locationBackfillRunRate");
  expect(output).toContain("acknowledgementRunRate");
  expect(output).toContain("thinReviewRate");
});

test("formatRunMetricsAnalysis is deterministic across multiple calls", () => {
  const analysis = analyzeRunMetrics(events);
  const output1 = formatRunMetricsAnalysis(analysis);
  const output2 = formatRunMetricsAnalysis(analysis);
  expect(output1).toBe(output2);
});

test("formatRunMetricsAnalysis shows n/a for zero-findings tier costPerFinding", () => {
  const analysis = analyzeRunMetrics(events);
  const output = formatRunMetricsAnalysis(analysis);
  expect(output).toContain("n/a");
});

// ---------------------------------------------------------------------------
// S06: run_event analysis (#20)
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics with run_event stream", () => {
  // Synthetic stream:
  //   run-1: pi runtime (real) → run_metrics + run.start + run.completed + run.correction
  //   run-2: pi runtime (real) → run_metrics + run.start + run.completed (no correction)
  //   run-orphan: run.start with no matching run_metrics → IGNORED
  //   run-dummy: dummy runtime run_metrics (excluded from real runs) → run_event ignored

  const streamEvents: TelemetryEvent[] = [
    // run-1: real run, full tier, has correction with acceptance data
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T00:00:00.000Z",
      runId: "run-1",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 3000,
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T00:00:00.100Z",
      runId: "run-1",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.start",
        repository: "acme/api",
        riskTier: "full",
        selectedReviewerRoles: ["security"],
        modelIds: ["model-a"],
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T00:00:03.000Z",
      runId: "run-1",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.completed",
        repository: "acme/api",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 3000,
        findingCount: 0,
        findingsBySeverity: {},
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T00:00:03.100Z",
      runId: "run-1",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.correction",
        repository: "acme/api",
        riskTier: "full",
        newFindingCount: 0,
        recurringFindingCount: 0,
        fixedFindingCount: 2,
        withheldFindingCount: 0,
        acceptanceByReviewer: {
          security: {
            accepted: 2,
            notAccepted: 0,
            rejected: 0,
            withheldExcluded: 0,
          },
        },
      },
    },
    // run-2: real run, lite tier, no correction
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T01:00:00.000Z",
      runId: "run-2",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "approved",
        outcome: "pass",
        durationMs: 1000,
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T01:00:00.100Z",
      runId: "run-2",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.start",
        repository: "acme/api",
        riskTier: "lite",
        selectedReviewerRoles: ["security"],
        modelIds: ["model-a"],
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T01:00:01.000Z",
      runId: "run-2",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.completed",
        repository: "acme/api",
        riskTier: "lite",
        decision: "approved",
        outcome: "pass",
        durationMs: 1000,
        findingCount: 0,
        findingsBySeverity: {},
        findingsByReviewer: {},
      },
    },
    // run-orphan: run.start with no matching run_metrics → must be IGNORED
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T02:00:00.000Z",
      runId: "run-orphan",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.start",
        repository: "orphan/repo",
        riskTier: "full",
        selectedReviewerRoles: [],
        modelIds: [],
      },
    },
    // run-dummy: dummy runtime run_metrics (not real) + run.start → run_event ignored
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T03:00:00.000Z",
      runId: "run-dummy",
      data: {
        runtime: "dummy",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 100,
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T03:00:00.100Z",
      runId: "run-dummy",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.start",
        repository: "acme/api",
        riskTier: "full",
        selectedReviewerRoles: [],
        modelIds: [],
      },
    },
  ];

  test("completion rate: 2 started, 2 completed = 100%", () => {
    const analysis = analyzeRunMetrics(streamEvents);
    expect(analysis.runEvents).toBeDefined();
    expect(analysis.runEvents?.startCount).toBe(2);
    expect(analysis.runEvents?.completedCount).toBe(2);
    expect(analysis.runEvents?.completionRate).toBeCloseTo(1.0, 5);
  });

  test("correctionCount = 1 (only run-1 has a correction)", () => {
    const analysis = analyzeRunMetrics(streamEvents);
    expect(analysis.runEvents?.correctionCount).toBe(1);
    expect(analysis.runEvents?.correctionRunCount).toBe(1);
  });

  test("correction event WITHOUT acceptance data counts in correctionCount but not correctionRunCount", () => {
    const noAcceptanceStream: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-12T00:00:00.000Z",
        runId: "run-x",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 0,
          findingsByReviewer: {},
        },
      },
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-12T00:00:01.000Z",
        runId: "run-x",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.correction",
          repository: "acme/api",
          riskTier: "full",
          newFindingCount: 0,
          recurringFindingCount: 0,
          fixedFindingCount: 0,
          withheldFindingCount: 0,
          acceptanceByReviewer: {},
        },
      },
    ];
    const analysis = analyzeRunMetrics(noAcceptanceStream);
    expect(analysis.runEvents?.correctionCount).toBe(1);
    expect(analysis.runEvents?.correctionRunCount).toBe(0);
  });

  test("acceptanceByReviewer: security accepted=2 from correction event", () => {
    const analysis = analyzeRunMetrics(streamEvents);
    const acceptance = analysis.runEvents?.acceptanceByReviewer;
    expect(acceptance).toBeDefined();
    expect(acceptance?.security?.accepted).toBe(2);
    expect(acceptance?.security?.notAccepted).toBe(0);
    expect(acceptance?.security?.rejected).toBe(0);
    expect(acceptance?.security?.acceptanceRate).toBeCloseTo(1.0, 5);
  });

  test("acceptanceByTier: full tier has security's acceptance", () => {
    const analysis = analyzeRunMetrics(streamEvents);
    const byTier = analysis.runEvents?.acceptanceByTier;
    expect(byTier).toBeDefined();
    expect(byTier?.full?.accepted).toBe(2);
  });

  test("directional: true is set", () => {
    const analysis = analyzeRunMetrics(streamEvents);
    expect(analysis.runEvents?.directional).toBe(true);
  });

  test("orphan run_event (no matching run_metrics) is ignored", () => {
    // orphan run.start should NOT count toward startCount
    const analysis = analyzeRunMetrics(streamEvents);
    // Only run-1 and run-2 have matching run_metrics → 2 starts
    expect(analysis.runEvents?.startCount).toBe(2);
  });

  test("dummy runtime run_metrics excludes its run.start from analysis", () => {
    // run-dummy is excluded by isRunMetricsEvent; its run.start is orphaned → ignored
    const analysis = analyzeRunMetrics(streamEvents);
    // Only run-1 and run-2 → 2 starts
    expect(analysis.runEvents?.startCount).toBe(2);
  });

  test("runEvents is undefined when no run_event events in stream", () => {
    const metricsOnly = streamEvents.filter((e) => e.type === "ai_review.run_metrics");
    const analysis = analyzeRunMetrics(metricsOnly);
    expect(analysis.runEvents).toBeUndefined();
  });

  test("runEvents is undefined when all run_events are orphans", () => {
    // Only orphan run_event (no matching run_metrics)
    const orphanOnly: TelemetryEvent[] = [
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-12T00:00:00.000Z",
        runId: "no-match",
        data: { event: "run.start", schemaVersion: "ai-review.run_event.v1" },
      },
    ];
    const analysis = analyzeRunMetrics(orphanOnly);
    expect(analysis.runEvents).toBeUndefined();
  });

  test("formatted output contains the directional caveat line", () => {
    const analysis = analyzeRunMetrics(streamEvents);
    const output = formatRunMetricsAnalysis(analysis);
    expect(output).toContain("directional");
    expect(output).toContain("longitudinal signal");
    expect(output).toContain("1 correction runs");
  });

  test("formatted output contains completionRate and counts", () => {
    const analysis = analyzeRunMetrics(streamEvents);
    const output = formatRunMetricsAnalysis(analysis);
    expect(output).toContain("completionRate");
    expect(output).toContain("startCount");
    expect(output).toContain("completedCount");
    expect(output).toContain("correctionCount");
  });
});

// ---------------------------------------------------------------------------
// #22 override rate in RunEventsAnalysis
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics override rate (#22)", () => {
  // Stream: 2 real runs, 1 with a run.override event (full tier), 1 without.
  // 2 run.start events → overrideRate = 1/2 = 0.5
  const overrideStream: TelemetryEvent[] = [
    // run-a: real, full tier, has run.start + run.override
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T10:00:00.000Z",
      runId: "run-a",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 2000,
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T10:00:00.100Z",
      runId: "run-a",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.start",
        repository: "acme/api",
        riskTier: "full",
        selectedReviewerRoles: ["security"],
        modelIds: ["model-x"],
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T10:00:00.200Z",
      runId: "run-a",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.override",
        repository: "acme/api",
        changeId: "42",
        riskTier: "full",
        overrideCommentId: "c1",
      },
    },
    // run-b: real, lite tier, has run.start, no override
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T11:00:00.000Z",
      runId: "run-b",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "approved",
        outcome: "pass",
        durationMs: 1000,
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-12T11:00:00.100Z",
      runId: "run-b",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.start",
        repository: "acme/api",
        riskTier: "lite",
        selectedReviewerRoles: ["security"],
        modelIds: ["model-x"],
      },
    },
  ];

  test("overrideCount is 1 (only run-a has a run.override)", () => {
    const analysis = analyzeRunMetrics(overrideStream);
    expect(analysis.runEvents?.overrideCount).toBe(1);
  });

  test("overrideRate is 0.5 (1 override / 2 starts)", () => {
    const analysis = analyzeRunMetrics(overrideStream);
    expect(analysis.runEvents?.overrideRate).toBeCloseTo(0.5, 5);
  });

  test("overrideCountByTier attributes override to full tier", () => {
    const analysis = analyzeRunMetrics(overrideStream);
    const byTier = analysis.runEvents?.overrideCountByTier;
    expect(byTier).toBeDefined();
    expect(byTier?.full).toBe(1);
    expect(byTier?.lite).toBeUndefined();
  });

  test("overrideCountByTier keys are stable-sorted", () => {
    // Add a second run.override for a 'lite' tier to get two keys
    const twoTierStream: TelemetryEvent[] = [
      ...overrideStream,
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-12T11:00:00.200Z",
        runId: "run-b",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.override",
          repository: "acme/api",
          changeId: "43",
          riskTier: "lite",
          overrideCommentId: "c2",
        },
      },
    ];
    const analysis = analyzeRunMetrics(twoTierStream);
    const keys = Object.keys(analysis.runEvents?.overrideCountByTier ?? {});
    expect(keys).toEqual([...keys].sort());
    expect(analysis.runEvents?.overrideCountByTier.full).toBe(1);
    expect(analysis.runEvents?.overrideCountByTier.lite).toBe(1);
  });

  test("overrideRate is null when startCount is 0 (no run.start events)", () => {
    // A stream with only a run.override event (orphan-ish — no real run_metrics start)
    // But run.override with a matching run_metrics but no run.start → startCount=0
    const noStartStream: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-12T12:00:00.000Z",
        runId: "run-c",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 0,
          findingsByReviewer: {},
        },
      },
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-12T12:00:00.100Z",
        runId: "run-c",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.override",
          repository: "acme/api",
          changeId: "44",
          riskTier: "full",
          overrideCommentId: "c3",
        },
      },
    ];
    const analysis = analyzeRunMetrics(noStartStream);
    expect(analysis.runEvents?.overrideCount).toBe(1);
    expect(analysis.runEvents?.overrideRate).toBeNull();
  });

  test("overrideCount is 0 and overrideRate is 0 when no override events", () => {
    const analysis = analyzeRunMetrics(
      overrideStream.filter(
        (e) => !(e.type === "ai_review.run_event" && e.data?.event === "run.override"),
      ),
    );
    expect(analysis.runEvents?.overrideCount).toBe(0);
    expect(analysis.runEvents?.overrideRate).toBeCloseTo(0, 5);
    expect(analysis.runEvents?.overrideCountByTier).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// M023 S01 (#257): merge-despite-fail rate
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics merge-despite-fail rate (#257)", () => {
  const mergeDespiteFailStream: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T10:00:00.000Z",
      runId: "prior-ignored",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "significant_concerns",
        outcome: "fail",
        findingCount: 2,
        findingsByReviewer: { security: 2 },
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-15T10:05:00.000Z",
      runId: "prior-ignored",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.prior_decision_respected",
        repository: "acme/api",
        changeId: "42",
        riskTier: "full",
        priorDecision: "review_required",
        priorOutcome: "fail",
        priorBlocked: true,
        merged: true,
        overrideRecorded: false,
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T11:00:00.000Z",
      runId: "prior-overridden",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "significant_concerns",
        outcome: "fail",
        findingCount: 1,
        findingsByReviewer: { correctness: 1 },
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-15T11:05:00.000Z",
      runId: "prior-overridden",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.prior_decision_respected",
        repository: "acme/api",
        changeId: "43",
        riskTier: "full",
        priorDecision: "significant_concerns",
        priorOutcome: "fail",
        priorBlocked: true,
        merged: true,
        overrideRecorded: true,
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T12:00:00.000Z",
      runId: "prior-not-merged",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "review_failed",
        outcome: "fail",
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-15T12:05:00.000Z",
      runId: "prior-not-merged",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.prior_decision_respected",
        repository: "beta/web",
        changeId: "44",
        riskTier: "lite",
        priorDecision: "review_failed",
        priorOutcome: "fail",
        priorBlocked: true,
        merged: false,
        overrideRecorded: false,
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T13:00:00.000Z",
      runId: "prior-pass",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "approved",
        outcome: "pass",
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-15T13:05:00.000Z",
      runId: "prior-pass",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.prior_decision_respected",
        repository: "beta/web",
        changeId: "45",
        riskTier: "lite",
        priorDecision: "approved",
        priorOutcome: "pass",
        priorBlocked: false,
        merged: true,
        overrideRecorded: false,
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T13:30:00.000Z",
      runId: "prior-explicit-not-blocking",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "significant_concerns",
        outcome: "fail",
        findingCount: 1,
        findingsByReviewer: { security: 1 },
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-15T13:35:00.000Z",
      runId: "prior-explicit-not-blocking",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.prior_decision_respected",
        repository: "acme/api",
        changeId: "48",
        riskTier: "full",
        priorDecision: "review_required",
        priorOutcome: "fail",
        priorBlocked: false,
        merged: true,
        overrideRecorded: false,
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-15T14:05:00.000Z",
      runId: "orphan-prior",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.prior_decision_respected",
        repository: "orphan/repo",
        changeId: "46",
        riskTier: "full",
        priorDecision: "review_required",
        priorOutcome: "fail",
        priorBlocked: true,
        merged: true,
        overrideRecorded: false,
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T15:00:00.000Z",
      runId: "dummy-prior",
      data: {
        runtime: "dummy",
        riskTier: "full",
        decision: "review_failed",
        outcome: "fail",
        findingCount: 0,
      },
    },
    {
      type: "ai_review.run_event",
      timestamp: "2026-06-15T15:05:00.000Z",
      runId: "dummy-prior",
      data: {
        schemaVersion: "ai-review.run_event.v1",
        event: "run.prior_decision_respected",
        repository: "dummy/repo",
        changeId: "47",
        riskTier: "full",
        priorDecision: "review_required",
        priorOutcome: "fail",
        priorBlocked: true,
        merged: true,
        overrideRecorded: false,
      },
    },
  ];

  test("pooled rate counts blocking prior runs merged without override", () => {
    const analysis = analyzeRunMetrics(mergeDespiteFailStream);
    const pooled = analysis.runEvents?.mergeDespiteFail?.pooled;
    expect(pooled).toBeDefined();
    expect(pooled?.priorBlockedObservationCount).toBe(3);
    expect(pooled?.priorBlockedMergedCount).toBe(2);
    expect(pooled?.mergeDespiteFailCount).toBe(1);
    expect(pooled?.mergeDespiteFailRate).toBeCloseTo(1 / 3, 5);
  });

  test("overrideRecorded true is excluded from the numerator", () => {
    const analysis = analyzeRunMetrics(mergeDespiteFailStream);
    const acme = analysis.runEvents?.mergeDespiteFail?.byRepository["acme/api"];
    expect(acme?.priorBlockedObservationCount).toBe(2);
    expect(acme?.priorBlockedMergedCount).toBe(2);
    expect(acme?.mergeDespiteFailCount).toBe(1);
    expect(acme?.mergeDespiteFailRate).toBeCloseTo(1 / 2, 5);
  });

  test("non-blocking prior decisions are excluded", () => {
    const analysis = analyzeRunMetrics(mergeDespiteFailStream);
    const beta = analysis.runEvents?.mergeDespiteFail?.byRepository["beta/web"];
    expect(beta?.priorBlockedObservationCount).toBe(1);
    expect(beta?.priorBlockedMergedCount).toBe(0);
    expect(beta?.mergeDespiteFailCount).toBe(0);
    expect(beta?.mergeDespiteFailRate).toBe(0);
  });

  test("explicit priorBlocked false overrides fail-looking fallback fields", () => {
    const analysis = analyzeRunMetrics(mergeDespiteFailStream);
    const pooled = analysis.runEvents?.mergeDespiteFail?.pooled;
    const acme = analysis.runEvents?.mergeDespiteFail?.byRepository["acme/api"];

    expect(pooled?.priorBlockedObservationCount).toBe(3);
    expect(pooled?.mergeDespiteFailCount).toBe(1);
    expect(acme?.priorBlockedObservationCount).toBe(2);
    expect(acme?.mergeDespiteFailCount).toBe(1);
  });

  test("missing overrideRecorded counts as no recorded override", () => {
    const analysis = analyzeRunMetrics([
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T16:00:00.000Z",
        runId: "prior-missing-override",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "significant_concerns",
          outcome: "fail",
          findingCount: 1,
          findingsByReviewer: { security: 1 },
        },
      },
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-15T16:05:00.000Z",
        runId: "prior-missing-override",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.prior_decision_respected",
          repository: "gamma/api",
          changeId: "49",
          riskTier: "full",
          priorDecision: "review_required",
          priorOutcome: "fail",
          priorBlocked: true,
          merged: true,
        },
      },
    ]);

    const pooled = analysis.runEvents?.mergeDespiteFail?.pooled;
    expect(pooled?.priorBlockedObservationCount).toBe(1);
    expect(pooled?.priorBlockedMergedCount).toBe(1);
    expect(pooled?.mergeDespiteFailCount).toBe(1);
    expect(pooled?.mergeDespiteFailRate).toBe(1);
  });

  test("omitted priorBlocked falls back to blocking priorOutcome or priorDecision", () => {
    const analysis = analyzeRunMetrics([
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T16:30:00.000Z",
        runId: "prior-fallback-blocking",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "significant_concerns",
          outcome: "fail",
          findingCount: 1,
          findingsByReviewer: { security: 1 },
        },
      },
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-15T16:35:00.000Z",
        runId: "prior-fallback-blocking",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.prior_decision_respected",
          repository: "fallback/api",
          changeId: "51",
          riskTier: "full",
          priorDecision: "approved",
          priorOutcome: "fail",
          merged: true,
          overrideRecorded: false,
        },
      },
    ]);

    const pooled = analysis.runEvents?.mergeDespiteFail?.pooled;
    expect(pooled?.priorBlockedObservationCount).toBe(1);
    expect(pooled?.mergeDespiteFailCount).toBe(1);
  });

  test("omitted priorBlocked with non-blocking fallback fields is excluded", () => {
    const analysis = analyzeRunMetrics([
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T16:40:00.000Z",
        runId: "prior-fallback-nonblocking",
        data: {
          runtime: "pi",
          riskTier: "lite",
          decision: "approved",
          outcome: "pass",
          findingCount: 0,
          findingsByReviewer: {},
        },
      },
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-15T16:45:00.000Z",
        runId: "prior-fallback-nonblocking",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.prior_decision_respected",
          repository: "fallback/web",
          changeId: "52",
          riskTier: "lite",
          priorDecision: "approved",
          priorOutcome: "pass",
          merged: true,
          overrideRecorded: false,
        },
      },
    ]);

    expect(analysis.runEvents?.mergeDespiteFail).toBeUndefined();
  });

  test("repository and tier segment keys normalize controls and bidi markers for formatted output", () => {
    const analysis = analyzeRunMetrics([
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T17:00:00.000Z",
        runId: "prior-control-key",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "significant_concerns",
          outcome: "fail",
          findingCount: 1,
          findingsByReviewer: { security: 1 },
        },
      },
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-15T17:05:00.000Z",
        runId: "prior-control-key",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.prior_decision_respected",
          repository: "acme/\u0000api\t\u200e",
          changeId: "50",
          riskTier: "full\u0085tier\u202e",
          priorDecision: "review_required",
          priorOutcome: "fail",
          priorBlocked: true,
          merged: true,
          overrideRecorded: false,
        },
      },
    ]);

    const byRepository = analysis.runEvents?.mergeDespiteFail?.byRepository ?? {};
    const byTier = analysis.runEvents?.mergeDespiteFail?.byTier ?? {};
    expect(Object.keys(byRepository)).toEqual(["acme/ api  "]);
    expect(Object.keys(byTier)).toEqual(["full tier "]);

    const output = formatRunMetricsAnalysis(analysis);
    expect(output).not.toContain("\u0000");
    expect(output).not.toContain("\t");
    expect(output).not.toContain("\u0085");
    expect(output).not.toContain("\u200e");
    expect(output).not.toContain("\u202e");
  });

  test("repository segment truncation is code-point safe for supplementary characters", () => {
    const repository = `${"a".repeat(159)}😀b`;
    const analysis = analyzeRunMetrics([
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T17:30:00.000Z",
        runId: "prior-supplementary-key",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "significant_concerns",
          outcome: "fail",
          findingCount: 1,
          findingsByReviewer: { security: 1 },
        },
      },
      {
        type: "ai_review.run_event",
        timestamp: "2026-06-15T17:35:00.000Z",
        runId: "prior-supplementary-key",
        data: {
          schemaVersion: "ai-review.run_event.v1",
          event: "run.prior_decision_respected",
          repository,
          changeId: "53",
          riskTier: "full",
          priorDecision: "review_required",
          priorOutcome: "fail",
          priorBlocked: true,
          merged: true,
          overrideRecorded: false,
        },
      },
    ]);

    const key = Object.keys(analysis.runEvents?.mergeDespiteFail?.byRepository ?? {})[0];
    expect(key).toBe(`${"a".repeat(159)}😀`);
    expect(Array.from(key ?? "")).toHaveLength(160);
    expect(Array.from(key ?? "").at(-1)).toBe("😀");
  });

  test("segments by repository and tier with stable-sorted keys", () => {
    const analysis = analyzeRunMetrics(mergeDespiteFailStream);
    const byRepository = analysis.runEvents?.mergeDespiteFail?.byRepository ?? {};
    const byTier = analysis.runEvents?.mergeDespiteFail?.byTier ?? {};

    expect(Object.keys(byRepository)).toEqual(["acme/api", "beta/web"]);
    expect(byTier.full?.priorBlockedObservationCount).toBe(2);
    expect(byTier.full?.mergeDespiteFailCount).toBe(1);
    expect(byTier.lite?.priorBlockedObservationCount).toBe(1);
    expect(byTier.lite?.mergeDespiteFailCount).toBe(0);
  });

  test("orphan and dummy-runtime observations are ignored", () => {
    const analysis = analyzeRunMetrics(mergeDespiteFailStream);
    const byRepository = analysis.runEvents?.mergeDespiteFail?.byRepository ?? {};
    expect(byRepository["orphan/repo"]).toBeUndefined();
    expect(byRepository["dummy/repo"]).toBeUndefined();
  });

  test("formatted output includes headline, repository, and tier breakdowns", () => {
    const output = formatRunMetricsAnalysis(analyzeRunMetrics(mergeDespiteFailStream));
    expect(output).toContain("mergeDespiteFailRate");
    expect(output).toContain("ignored=1");
    expect(output).toContain("n=3");
    expect(output).toContain("Merge-Despite-Fail by Repository");
    expect(output).toContain("acme/api");
    expect(output).toContain("beta/web");
    expect(output).toContain("Merge-Despite-Fail by Tier");
    expect(output).toContain("full");
    expect(output).toContain("lite");
  });
});

// ---------------------------------------------------------------------------
// #100b cacheWriteTokensPerRun in TierSegment
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics cacheWriteTokensPerRun (#100b)", () => {
  const cacheWriteStream: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T20:00:00.000Z",
      runId: "cw-run-1",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 3000,
        findingCount: 0,
        findingsByReviewer: {},
        tokens: {
          agentCount: 3,
          inputTokens: 1000,
          outputTokens: 500,
          cacheWriteTokens: 800,
          estimatedCostUsd: 0.3,
        },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T20:01:00.000Z",
      runId: "cw-run-2",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 2000,
        findingCount: 0,
        findingsByReviewer: {},
        tokens: {
          agentCount: 2,
          inputTokens: 800,
          outputTokens: 400,
          cacheWriteTokens: 200,
          estimatedCostUsd: 0.2,
        },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T20:02:00.000Z",
      runId: "cw-run-3",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "approved",
        outcome: "pass",
        durationMs: 1000,
        findingCount: 0,
        findingsByReviewer: {},
        tokens: {
          agentCount: 1,
          inputTokens: 400,
          outputTokens: 200,
          // no cacheWriteTokens field → treated as 0
          estimatedCostUsd: 0.1,
        },
      },
    },
  ];

  test("cacheWriteTokensPerRun averages cacheWriteTokens across runs in tier", () => {
    const analysis = analyzeRunMetrics(cacheWriteStream);
    // full tier: (800 + 200) / 2 = 500
    expect(analysis.byTier.full?.cacheWriteTokensPerRun).toBeCloseTo(500, 5);
  });

  test("cacheWriteTokensPerRun is 0 when no cacheWriteTokens field present", () => {
    const analysis = analyzeRunMetrics(cacheWriteStream);
    // lite tier: only run-3 with no cacheWriteTokens → 0/1 = 0
    expect(analysis.byTier.lite?.cacheWriteTokensPerRun).toBe(0);
  });

  test("cacheWriteTokensPerRun is 0 when run has no tokens at all", () => {
    const noTokensStream: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-12T21:00:00.000Z",
        runId: "no-tokens",
        data: {
          runtime: "pi",
          riskTier: "trivial",
          decision: "approved",
          outcome: "pass",
          durationMs: 100,
          findingCount: 0,
          findingsByReviewer: {},
        },
      },
    ];
    const analysis = analyzeRunMetrics(noTokensStream);
    expect(analysis.byTier.trivial?.cacheWriteTokensPerRun).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #141 cache-hit-rate telemetry (M018 S04)
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics cacheHitRate (#141)", () => {
  // Uses the top-level `events` fixture (run-1 full, run-2 lite, run-3 trivial).
  //
  // run-1 (full):   input=3000, cacheRead=6000, cacheWrite=1000
  //   → denom = 3000 + 6000 + 1000 = 10000
  //   → cacheHitRate = 6000 / 10000 = 0.6
  //
  // run-2 (lite):   input=800, cacheRead=200, cacheWrite=0
  //   → denom = 800 + 200 + 0 = 1000
  //   → cacheHitRate = 200 / 1000 = 0.2
  //
  // run-3 (trivial): input=200, cacheRead=0, cacheWrite=0
  //   → denom = 200 + 0 + 0 = 200
  //   → cacheHitRate = 0 / 200 = 0  (NOT null — denom is non-zero)
  //
  // Overall (fleet-wide):
  //   totalInput = 3000 + 800 + 200 = 4000
  //   totalCacheRead = 6000 + 200 + 0 = 6200
  //   totalCacheWrite = 1000 + 0 + 0 = 1000
  //   denom = 4000 + 6200 + 1000 = 11200
  //   overallCacheHitRate = 6200 / 11200 ≈ 0.553571

  test("byTier.full cacheReadTokensPerRun is 6000", () => {
    const analysis = analyzeRunMetrics(events);
    // run-1 (full) has cacheReadTokens=6000; only 1 run in full tier → 6000/1 = 6000
    expect(analysis.byTier.full?.cacheReadTokensPerRun).toBe(6000);
  });

  test("byTier.full cacheHitRate is 0.6 (6000/10000)", () => {
    const analysis = analyzeRunMetrics(events);
    // 6000 / (3000 + 6000 + 1000) = 6000/10000 = 0.6
    expect(analysis.byTier.full?.cacheHitRate).toBeCloseTo(0.6, 5);
  });

  test("byTier.lite cacheReadTokensPerRun is 200", () => {
    const analysis = analyzeRunMetrics(events);
    // run-2 (lite) has cacheReadTokens=200; only 1 run → 200/1 = 200
    expect(analysis.byTier.lite?.cacheReadTokensPerRun).toBe(200);
  });

  test("byTier.lite cacheHitRate is 0.2 (200/1000)", () => {
    const analysis = analyzeRunMetrics(events);
    // 200 / (800 + 200 + 0) = 200/1000 = 0.2
    expect(analysis.byTier.lite?.cacheHitRate).toBeCloseTo(0.2, 5);
  });

  test("byTier.trivial cacheHitRate is 0 (not null — denom is non-zero from inputTokens)", () => {
    const analysis = analyzeRunMetrics(events);
    // input=200, cacheRead=0, cacheWrite=0 → denom=200, ratio=0/200=0
    expect(analysis.byTier.trivial?.cacheHitRate).toBe(0);
  });

  test("overall cacheHitRate is pooled across all tiers ≈ 6200/11200", () => {
    const analysis = analyzeRunMetrics(events);
    // totalInput=4000, totalCacheRead=6200, totalCacheWrite=1000 → denom=11200
    expect(analysis.cacheHitRate).toBeCloseTo(6200 / 11200, 5);
  });

  test("cacheHitRate is null when denominator is 0 (no token data at all)", () => {
    // Events with no tokens block → all token counts stay 0, denom=0 → cacheHitRate null
    const noTokensEvents: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-14T00:00:00.000Z",
        runId: "no-tokens-a",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 0,
          findingsByReviewer: {},
          // no tokens block
        },
      },
    ];
    const analysis = analyzeRunMetrics(noTokensEvents);
    expect(analysis.byTier.full?.cacheHitRate).toBeNull();
    expect(analysis.cacheHitRate).toBeNull();
  });

  test("overall cacheHitRate is null when runCount is 0", () => {
    const analysis = analyzeRunMetrics([]);
    expect(analysis.cacheHitRate).toBeNull();
  });

  test("formatRunMetricsAnalysis contains CacheHit column header", () => {
    const analysis = analyzeRunMetrics(events);
    const output = formatRunMetricsAnalysis(analysis);
    expect(output).toContain("CacheHit");
  });

  test("formatRunMetricsAnalysis contains Overall cache-hit rate", () => {
    const analysis = analyzeRunMetrics(events);
    const output = formatRunMetricsAnalysis(analysis);
    expect(output).toContain("Overall cache-hit rate:");
  });
});

// ---------------------------------------------------------------------------
// #196: fanOutMsPerRun / fusionMsPerRun latency decomposition
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics fanOutMsPerRun / fusionMsPerRun (#196)", () => {
  // Three synthetic runs:
  //   run-196-a: full tier, durationsMs.fanOutMs=2000, durationsMs.fusionMs=1000
  //   run-196-b: full tier, durationsMs.fanOutMs=3000, durationsMs.fusionMs=500
  //   run-196-c: lite tier, durationsMs.fanOutMs=1000, durationsMs.fusionMs=0 (short-circuit: fusionMs omitted)
  const subDurationEvents: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T00:00:00.000Z",
      runId: "run-196-a",
      data: {
        runtime: "pi",
        riskTier: "full",
        reviewedFileCount: 2,
        decision: "approved",
        outcome: "pass",
        durationMs: 5000,
        durationsMs: { overallMs: 5000, coordinatorMs: 3000, fanOutMs: 2000, fusionMs: 1000 },
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T01:00:00.000Z",
      runId: "run-196-b",
      data: {
        runtime: "pi",
        riskTier: "full",
        reviewedFileCount: 2,
        decision: "minor_issues",
        outcome: "pass",
        durationMs: 6000,
        durationsMs: { overallMs: 6000, coordinatorMs: 3500, fanOutMs: 3000, fusionMs: 500 },
        findingCount: 1,
        findingsByReviewer: { security: 1 },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T02:00:00.000Z",
      runId: "run-196-c",
      data: {
        runtime: "pi",
        riskTier: "lite",
        reviewedFileCount: 1,
        decision: "approved",
        outcome: "pass",
        durationMs: 1200,
        // Short-circuit: fanOutMs present, fusionMs absent (no synthesis ran)
        durationsMs: { overallMs: 1200, coordinatorMs: 800, fanOutMs: 1000 },
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
    {
      // dummy runtime: excluded
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T03:00:00.000Z",
      runId: "run-196-dummy",
      data: {
        runtime: "dummy",
        riskTier: "full",
        durationMs: 1000,
        durationsMs: { overallMs: 1000, fanOutMs: 9999, fusionMs: 9999 },
        findingCount: 0,
        findingsByReviewer: {},
      },
    },
  ];

  test("fanOutMsPerRun averages fanOutMs correctly per tier (#196)", () => {
    const analysis = analyzeRunMetrics(subDurationEvents);
    // full tier: (2000 + 3000) / 2 = 2500
    expect(analysis.byTier.full?.fanOutMsPerRun).toBeCloseTo(2500, 5);
    // lite tier: 1000 / 1 = 1000
    expect(analysis.byTier.lite?.fanOutMsPerRun).toBeCloseTo(1000, 5);
  });

  test("fusionMsPerRun averages fusionMs correctly per tier, missing values contribute 0 (#196)", () => {
    const analysis = analyzeRunMetrics(subDurationEvents);
    // full tier: (1000 + 500) / 2 = 750
    expect(analysis.byTier.full?.fusionMsPerRun).toBeCloseTo(750, 5);
    // lite tier: fusionMs absent → treated as 0; average = 0/1 = 0
    expect(analysis.byTier.lite?.fusionMsPerRun).toBeCloseTo(0, 5);
  });

  test("dummy runtime is excluded from fanOutMsPerRun / fusionMsPerRun (#196)", () => {
    const analysis = analyzeRunMetrics(subDurationEvents);
    // Only 2 real full-tier runs; dummy's 9999 values must not appear
    expect(analysis.byTier.full?.fanOutMsPerRun).not.toBe(9999);
    expect(analysis.byTier.full?.fusionMsPerRun).not.toBe(9999);
    // Confirms exact averages (also validates dummy exclusion)
    expect(analysis.byTier.full?.fanOutMsPerRun).toBeCloseTo(2500, 5);
    expect(analysis.byTier.full?.fusionMsPerRun).toBeCloseTo(750, 5);
  });

  test("fanOutMsPerRun and fusionMsPerRun are 0 when no sub-duration data is present (#196)", () => {
    // Use the base events which have no durationsMs block
    const analysis = analyzeRunMetrics(events);
    for (const seg of Object.values(analysis.byTier)) {
      expect(seg.fanOutMsPerRun).toBe(0);
      expect(seg.fusionMsPerRun).toBe(0);
    }
  });

  test("formatRunMetricsAnalysis includes FanOut ms/run and Fusion ms/run columns (#196)", () => {
    const analysis = analyzeRunMetrics(subDurationEvents);
    const formatted = formatRunMetricsAnalysis(analysis);
    expect(formatted).toContain("FanOut ms/run");
    expect(formatted).toContain("Fusion ms/run");
  });
});

// ---------------------------------------------------------------------------
// #207: groundingWithholdFindingRate (finding-level withhold rate)
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics groundingWithholdFindingRate (#207)", () => {
  // Synthetic: 2 runs
  //   run-A: grounding block with droppedFindingCount:2, findingCount surfaced:2
  //   run-B: no grounding block, findingCount surfaced:6
  // produced = (2 + 6) + 2 = 10, demoted = 2 → rate = 2/10 = 0.20
  const twoRunEvents: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T00:00:00.000Z",
      runId: "rate-A",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved_with_comments",
        outcome: "pass",
        durationMs: 3000,
        findingCount: 2,
        grounding: { droppedFindingCount: 2 },
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T01:00:00.000Z",
      runId: "rate-B",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "no_findings",
        outcome: "pass",
        durationMs: 1000,
        findingCount: 6,
      },
    },
  ];

  test("groundingWithholdFindingRate = demoted / produced (pooled across runs)", () => {
    const analysis = analyzeRunMetrics(twoRunEvents);
    // produced = surfaced (2+6) + demoted (2) = 10; rate = 2/10 = 0.20
    expect(analysis.rates.groundingWithholdFindingRate).toBeCloseTo(0.2, 5);
    // produced count is exposed as the finding-level sample size (#207)
    expect(analysis.rates.groundingProducedFindingCount).toBe(10);
  });

  test("non-numeric droppedFindingCount does not propagate NaN (asNumber guard, #207)", () => {
    const dirty: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-14T03:00:00.000Z",
        runId: "dirty",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 2000,
          findingCount: 4,
          // a stringified / malformed count must coerce to 0, not NaN
          grounding: { droppedFindingCount: "oops" as unknown as number },
        },
      },
    ];
    const analysis = analyzeRunMetrics(dirty);
    expect(Number.isNaN(analysis.rates.groundingWithholdFindingRate)).toBe(false);
    expect(analysis.rates.groundingWithholdFindingRate).toBe(0);
    expect(analysis.rates.groundingProducedFindingCount).toBe(4);
  });

  test("groundingWithholdFindingRate = 0 when no grounding blocks present", () => {
    const analysis = analyzeRunMetrics([twoRunEvents[1]!]);
    expect(analysis.rates.groundingWithholdFindingRate).toBe(0);
  });

  test("groundingWithholdFindingRate = 0 when runCount is 0", () => {
    const analysis = analyzeRunMetrics([]);
    expect(analysis.rates.groundingWithholdFindingRate).toBe(0);
  });

  test("groundingWithholdFindingRate = 1 when all produced findings are demoted", () => {
    // Only a grounding block present, zero surfaced findings
    const allDemotedEvents: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-14T02:00:00.000Z",
        runId: "all-demoted",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 2000,
          findingCount: 0,
          grounding: { droppedFindingCount: 3 },
        },
      },
    ];
    const analysis = analyzeRunMetrics(allDemotedEvents);
    // produced = 0 + 3 = 3, demoted = 3 → rate = 1.0
    expect(analysis.rates.groundingWithholdFindingRate).toBeCloseTo(1.0, 5);
  });
});

// ---------------------------------------------------------------------------
// #212: reviewerFailureRunCount / reviewerFailureRate / reviewerFailureCountByRole
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics reviewer-failure counts (#212)", () => {
  // Three runs:
  //   run-A: failures=[{kind:"reviewer",role:"code_quality"},{kind:"reviewer",role:"performance"}]
  //   run-B: failures=[{kind:"reviewer",role:"code_quality"}]  (same role as A but separate run)
  //   run-C: failures=[{kind:"coordinator"}]  (coordinator kind — not counted)
  const reviewerFailureEvents: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T00:00:00.000Z",
      runId: "rf-A",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved_with_comments",
        outcome: "pass",
        durationMs: 3000,
        findingCount: 1,
        failures: [
          {
            kind: "reviewer",
            role: "code_quality",
            errorName: "TimeoutError",
            errorCategory: "timeout",
          },
          {
            kind: "reviewer",
            role: "performance",
            errorName: "SchemaError",
            errorCategory: "schema_invalid",
          },
        ],
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T01:00:00.000Z",
      runId: "rf-B",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "approved",
        outcome: "pass",
        durationMs: 2000,
        findingCount: 0,
        failures: [
          {
            kind: "reviewer",
            role: "code_quality",
            errorName: "TimeoutError",
            errorCategory: "timeout",
          },
        ],
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-14T02:00:00.000Z",
      runId: "rf-C",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "approved",
        outcome: "pass",
        durationMs: 1000,
        findingCount: 0,
        // coordinator kind — must NOT count toward reviewer-failure run count
        failures: [
          {
            kind: "coordinator",
            role: "coordinator",
            errorName: "SomeError",
            errorCategory: "unknown",
          },
        ],
      },
    },
  ];

  test("reviewerFailureRunCount counts only runs with reviewer-kind failures", () => {
    const analysis = analyzeRunMetrics(reviewerFailureEvents);
    // run-A and run-B have reviewer failures; run-C has coordinator only → count = 2
    expect(analysis.reviewerFailureRunCount).toBe(2);
  });

  test("reviewerFailureRate = reviewerFailureRunCount / runCount", () => {
    const analysis = analyzeRunMetrics(reviewerFailureEvents);
    // 2 of 3 runs → 0.6667
    expect(analysis.reviewerFailureRate).toBeCloseTo(2 / 3, 5);
  });

  test("reviewerFailureCountByRole accumulates per-role counts across runs (stable-sorted keys)", () => {
    const analysis = analyzeRunMetrics(reviewerFailureEvents);
    // code_quality failed in run-A AND run-B → 2 runs; performance failed in run-A only → 1 run
    expect(analysis.reviewerFailureCountByRole).toEqual({
      code_quality: 2,
      performance: 1,
    });
    // Stable-sorted: code_quality < performance
    expect(Object.keys(analysis.reviewerFailureCountByRole)).toEqual([
      "code_quality",
      "performance",
    ]);
  });

  test("a run with two failures of the same role counts that role only ONCE in byRole", () => {
    const dupRoleEvent: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-14T10:00:00.000Z",
        runId: "rf-dup",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 0,
          failures: [
            { kind: "reviewer", role: "security", errorName: "Err1", errorCategory: "timeout" },
            { kind: "reviewer", role: "security", errorName: "Err2", errorCategory: "timeout" },
          ],
        },
      },
    ];
    const analysis = analyzeRunMetrics(dupRoleEvent);
    expect(analysis.reviewerFailureRunCount).toBe(1);
    expect(analysis.reviewerFailureCountByRole).toEqual({ security: 1 });
  });

  test("reviewerFailureRate is null when runCount is 0", () => {
    const analysis = analyzeRunMetrics([]);
    expect(analysis.reviewerFailureRate).toBeNull();
  });

  test("reviewerFailureRunCount = 0 and byRole = {} when no failures block present", () => {
    const noFailuresEvent: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-14T00:00:00.000Z",
        runId: "rf-none",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 0,
        },
      },
    ];
    const analysis = analyzeRunMetrics(noFailuresEvent);
    expect(analysis.reviewerFailureRunCount).toBe(0);
    expect(analysis.reviewerFailureRate).toBe(0);
    expect(analysis.reviewerFailureCountByRole).toEqual({});
  });

  test("formatRunMetricsAnalysis includes reviewerFailureRunCount and reviewerFailureRate", () => {
    const analysis = analyzeRunMetrics(reviewerFailureEvents);
    const formatted = formatRunMetricsAnalysis(analysis);
    expect(formatted).toContain("reviewerFailureRunCount");
    expect(formatted).toContain("reviewerFailureRate");
  });

  test("formatRunMetricsAnalysis includes byRole line when roles present", () => {
    const analysis = analyzeRunMetrics(reviewerFailureEvents);
    const formatted = formatRunMetricsAnalysis(analysis);
    expect(formatted).toContain("reviewerFailureByRole");
    expect(formatted).toContain("code_quality:2");
    expect(formatted).toContain("performance:1");
  });
});

// ---------------------------------------------------------------------------
// #151 (M022 S01): outputTokensPerFinding + byDecision
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics outputTokensPerFinding (#151)", () => {
  // Fixture:
  //   run-A: full tier, 2 findings, outputTokens=1200, decision="significant_concerns"
  //   run-B: lite tier, 1 finding,  outputTokens=100,  decision="no_findings"
  //   run-C: trivial tier, 0 findings, outputTokens=10, decision="approved"
  // (reuses the top-level `events` fixture)

  test("byTier outputTokensPerFinding: full tier = 1200/2 = 600", () => {
    const analysis = analyzeRunMetrics(events);
    // full tier: 1200 output tokens / 2 findings = 600
    expect(analysis.byTier.full?.outputTokensPerFinding).toBeCloseTo(600, 5);
  });

  test("byTier outputTokensPerFinding: lite tier = 100/1 = 100", () => {
    const analysis = analyzeRunMetrics(events);
    // lite tier: 100 output tokens / 1 finding = 100
    expect(analysis.byTier.lite?.outputTokensPerFinding).toBeCloseTo(100, 5);
  });

  test("byTier outputTokensPerFinding: trivial tier null (0 findings)", () => {
    const analysis = analyzeRunMetrics(events);
    // trivial tier: 0 findings → null (not NaN, not 0)
    expect(analysis.byTier.trivial?.outputTokensPerFinding).toBeNull();
  });

  test("headline outputTokensPerFinding: pooled across all runs = (1200+100+10)/(2+1+0)", () => {
    const analysis = analyzeRunMetrics(events);
    // total output tokens = 1200+100+10 = 1310, total findings = 3 → 1310/3 ≈ 436.67
    expect(analysis.outputTokensPerFinding).toBeCloseTo(1310 / 3, 5);
  });

  test("headline outputTokensPerFinding: null when 0 findings across all runs", () => {
    const noFindingsEvents: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T00:00:00.000Z",
        runId: "zero-a",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 0,
          findingsByReviewer: {},
          tokens: { outputTokens: 500, inputTokens: 1000, estimatedCostUsd: 0.1 },
        },
      },
    ];
    const analysis = analyzeRunMetrics(noFindingsEvents);
    expect(analysis.outputTokensPerFinding).toBeNull();
  });

  test("headline outputTokensPerFinding: null when runCount is 0", () => {
    const analysis = analyzeRunMetrics([]);
    expect(analysis.outputTokensPerFinding).toBeNull();
  });

  test("outputTokensPerFinding is not NaN or Infinity in any case", () => {
    const analysis = analyzeRunMetrics(events);
    for (const seg of Object.values(analysis.byTier)) {
      const v = seg.outputTokensPerFinding;
      if (v !== null) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Number.isNaN(v)).toBe(false);
      }
    }
    const headline = analysis.outputTokensPerFinding;
    if (headline !== null) {
      expect(Number.isFinite(headline)).toBe(true);
      expect(Number.isNaN(headline)).toBe(false);
    }
  });

  // Additive guarantee: ensure existing fields on TierSegment are unchanged
  test("additive: existing TierSegment fields are still present and correct", () => {
    const analysis = analyzeRunMetrics(events);
    const full = analysis.byTier.full;
    expect(full?.runCount).toBe(1);
    expect(full?.findingsPerRun).toBe(2);
    expect(full?.outputTokensPerRun).toBe(1200);
    expect(full?.costPerFindingUsd).toBeCloseTo(0.3, 5);
    expect(full?.cacheHitRate).toBeCloseTo(0.6, 5);
  });
});

describe("analyzeRunMetrics byDecision (#151)", () => {
  // Reuses the top-level `events` fixture:
  //   run-1: decision="significant_concerns", findings=2, outputTokens=1200, full
  //   run-2: decision="no_findings",          findings=1, outputTokens=100,  lite
  //   run-3: decision="approved",             findings=0, outputTokens=10,   trivial

  test("byDecision keys are stable-sorted", () => {
    const analysis = analyzeRunMetrics(events);
    const keys = Object.keys(analysis.byDecision);
    expect(keys).toEqual([...keys].sort());
  });

  test("byDecision contains one entry per distinct decision value", () => {
    const analysis = analyzeRunMetrics(events);
    expect(Object.keys(analysis.byDecision)).toHaveLength(3);
    expect(analysis.byDecision).toHaveProperty("approved");
    expect(analysis.byDecision).toHaveProperty("no_findings");
    expect(analysis.byDecision).toHaveProperty("significant_concerns");
  });

  test("byDecision.significant_concerns: runCount=1, findings=2, outputTokens=1200, ratio=600", () => {
    const analysis = analyzeRunMetrics(events);
    const seg = analysis.byDecision.significant_concerns;
    expect(seg?.runCount).toBe(1);
    expect(seg?.findingsPerRun).toBeCloseTo(2, 5);
    expect(seg?.outputTokensPerRun).toBeCloseTo(1200, 5);
    expect(seg?.outputTokensPerFinding).toBeCloseTo(600, 5);
  });

  test("byDecision.no_findings: runCount=1, findings=1, outputTokens=100, ratio=100", () => {
    const analysis = analyzeRunMetrics(events);
    const seg = analysis.byDecision.no_findings;
    expect(seg?.runCount).toBe(1);
    expect(seg?.findingsPerRun).toBeCloseTo(1, 5);
    expect(seg?.outputTokensPerRun).toBeCloseTo(100, 5);
    expect(seg?.outputTokensPerFinding).toBeCloseTo(100, 5);
  });

  test("byDecision.approved: runCount=1, findings=0, outputTokensPerFinding=null", () => {
    const analysis = analyzeRunMetrics(events);
    const seg = analysis.byDecision.approved;
    expect(seg?.runCount).toBe(1);
    expect(seg?.findingsPerRun).toBe(0);
    expect(seg?.outputTokensPerFinding).toBeNull();
  });

  test("byDecision: two runs with same decision are merged correctly", () => {
    const twoSameDecision: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T00:00:00.000Z",
        runId: "same-a",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 2000,
          findingCount: 2,
          findingsByReviewer: { security: 2 },
          tokens: { outputTokens: 600, inputTokens: 1000, estimatedCostUsd: 0.1 },
        },
      },
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T01:00:00.000Z",
        runId: "same-b",
        data: {
          runtime: "pi",
          riskTier: "lite",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 4,
          findingsByReviewer: { security: 4 },
          tokens: { outputTokens: 400, inputTokens: 800, estimatedCostUsd: 0.08 },
        },
      },
    ];
    const analysis = analyzeRunMetrics(twoSameDecision);
    const seg = analysis.byDecision.approved;
    expect(seg?.runCount).toBe(2);
    // findingsPerRun: (2+4)/2 = 3
    expect(seg?.findingsPerRun).toBeCloseTo(3, 5);
    // outputTokensPerRun: (600+400)/2 = 500
    expect(seg?.outputTokensPerRun).toBeCloseTo(500, 5);
    // outputTokensPerFinding: (600+400)/(2+4) = 1000/6 ≈ 166.67
    expect(seg?.outputTokensPerFinding).toBeCloseTo(1000 / 6, 5);
  });

  test("byDecision: dummy runtime excluded from decision accumulation", () => {
    const withDummy: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T00:00:00.000Z",
        runId: "real",
        data: {
          runtime: "pi",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 1000,
          findingCount: 1,
          findingsByReviewer: { security: 1 },
          tokens: { outputTokens: 300, inputTokens: 600, estimatedCostUsd: 0.05 },
        },
      },
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T01:00:00.000Z",
        runId: "dummy",
        data: {
          runtime: "dummy",
          riskTier: "full",
          decision: "approved",
          outcome: "pass",
          durationMs: 100,
          findingCount: 99,
          findingsByReviewer: {},
          tokens: { outputTokens: 9999 },
        },
      },
    ];
    const analysis = analyzeRunMetrics(withDummy);
    // only real run contributes — dummy is excluded
    expect(analysis.byDecision.approved?.runCount).toBe(1);
    expect(analysis.byDecision.approved?.outputTokensPerRun).toBeCloseTo(300, 5);
    expect(analysis.byDecision.approved?.outputTokensPerFinding).toBeCloseTo(300, 5);
  });

  test("byDecision is empty when runCount is 0", () => {
    const analysis = analyzeRunMetrics([]);
    expect(analysis.byDecision).toEqual({});
  });

  test("byDecision: events with no decision field are excluded from byDecision", () => {
    const noDecisionEvent: TelemetryEvent[] = [
      {
        type: "ai_review.run_metrics",
        timestamp: "2026-06-15T00:00:00.000Z",
        runId: "no-dec",
        data: {
          runtime: "pi",
          riskTier: "full",
          // no decision field
          outcome: "pass",
          durationMs: 1000,
          findingCount: 1,
          tokens: { outputTokens: 200 },
        },
      },
    ];
    const analysis = analyzeRunMetrics(noDecisionEvent);
    expect(Object.keys(analysis.byDecision)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Disposition precision (#256, M023 S04)
// ---------------------------------------------------------------------------

describe("analyzeRunMetrics — disposition precision", () => {
  /** Build a synthetic run_metrics event with a dispositions block. */
  function makeDispositionEvent(
    runId: string,
    dispositions: {
      fixed: number;
      dismissed: number;
      ignored: number;
      acknowledged: number;
      byReviewer?: Record<
        string,
        { fixed: number; dismissed: number; ignored: number; acknowledged: number }
      >;
      bySeverity?: Record<
        string,
        { fixed: number; dismissed: number; ignored: number; acknowledged: number }
      >;
    },
  ): TelemetryEvent {
    return {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-15T10:00:00.000Z",
      runId,
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "significant_concerns",
        outcome: "fail",
        durationMs: 3000,
        findingCount: 0,
        dispositions: dispositions as unknown as Record<
          string,
          import("../src/contracts/common.ts").JsonValue
        >,
      },
    };
  }

  test("dispositions absent when no run has a dispositions block", () => {
    const analysis = analyzeRunMetrics(events); // events fixture has no dispositions block
    expect(analysis.dispositions).toBeUndefined();
  });

  test("dispositions present when at least one run has a dispositions block", () => {
    const eventsWithDispositions: TelemetryEvent[] = [
      makeDispositionEvent("d-1", { fixed: 3, dismissed: 1, ignored: 2, acknowledged: 0 }),
    ];
    const analysis = analyzeRunMetrics(eventsWithDispositions);
    expect(analysis.dispositions).not.toBeUndefined();
  });

  test("precision = fixed ÷ (fixed + ignored + dismissed)", () => {
    // fixed=3, ignored=2, dismissed=1 → precision = 3/6 = 0.5
    const eventsWithDispositions: TelemetryEvent[] = [
      makeDispositionEvent("d-1", { fixed: 3, dismissed: 1, ignored: 2, acknowledged: 1 }),
    ];
    const analysis = analyzeRunMetrics(eventsWithDispositions);
    expect(analysis.dispositions?.pooled.fixed).toBe(3);
    expect(analysis.dispositions?.pooled.dismissed).toBe(1);
    expect(analysis.dispositions?.pooled.ignored).toBe(2);
    expect(analysis.dispositions?.pooled.acknowledged).toBe(1);
    expect(analysis.dispositions?.pooled.precision).toBeCloseTo(0.5, 5);
  });

  test("precision is null when denominator is 0 (acknowledged only)", () => {
    const eventsWithDispositions: TelemetryEvent[] = [
      makeDispositionEvent("d-1", { fixed: 0, dismissed: 0, ignored: 0, acknowledged: 3 }),
    ];
    const analysis = analyzeRunMetrics(eventsWithDispositions);
    expect(analysis.dispositions?.pooled.precision).toBeNull();
  });

  test("pooled totals accumulate across multiple events", () => {
    const eventsWithDispositions: TelemetryEvent[] = [
      makeDispositionEvent("d-1", { fixed: 2, dismissed: 0, ignored: 1, acknowledged: 0 }),
      makeDispositionEvent("d-2", { fixed: 1, dismissed: 1, ignored: 2, acknowledged: 1 }),
    ];
    const analysis = analyzeRunMetrics(eventsWithDispositions);
    expect(analysis.dispositions?.pooled.fixed).toBe(3);
    expect(analysis.dispositions?.pooled.dismissed).toBe(1);
    expect(analysis.dispositions?.pooled.ignored).toBe(3);
    expect(analysis.dispositions?.pooled.acknowledged).toBe(1);
    // precision = 3 / (3+3+1) = 3/7
    expect(analysis.dispositions?.pooled.precision).toBeCloseTo(3 / 7, 5);
  });

  test("byReviewer segment with precision populated", () => {
    const eventsWithDispositions: TelemetryEvent[] = [
      makeDispositionEvent("d-1", {
        fixed: 2,
        dismissed: 0,
        ignored: 1,
        acknowledged: 0,
        byReviewer: {
          security: { fixed: 2, dismissed: 0, ignored: 0, acknowledged: 0 },
          code_quality: { fixed: 0, dismissed: 0, ignored: 1, acknowledged: 0 },
        },
      }),
    ];
    const analysis = analyzeRunMetrics(eventsWithDispositions);
    const byRev = analysis.dispositions?.byReviewer;
    expect(byRev).not.toBeUndefined();

    // stable-sorted keys
    expect(Object.keys(byRev ?? {})).toEqual(["code_quality", "security"]);

    // security: precision = 2/(2+0+0) = 1.0
    expect(byRev?.security?.precision).toBeCloseTo(1.0, 5);
    // code_quality: precision = 0/(0+1+0) = 0.0
    expect(byRev?.code_quality?.precision).toBeCloseTo(0.0, 5);
  });

  test("bySeverity segment with precision populated", () => {
    const eventsWithDispositions: TelemetryEvent[] = [
      makeDispositionEvent("d-1", {
        fixed: 2,
        dismissed: 1,
        ignored: 1,
        acknowledged: 0,
        bySeverity: {
          critical: { fixed: 2, dismissed: 0, ignored: 1, acknowledged: 0 },
          warning: { fixed: 0, dismissed: 1, ignored: 0, acknowledged: 0 },
        },
      }),
    ];
    const analysis = analyzeRunMetrics(eventsWithDispositions);
    const bySev = analysis.dispositions?.bySeverity;
    expect(bySev).not.toBeUndefined();

    // stable-sorted keys: critical before warning
    expect(Object.keys(bySev ?? {})).toEqual(["critical", "warning"]);

    // critical: precision = 2/(2+1+0) = 2/3
    expect(bySev?.critical?.precision).toBeCloseTo(2 / 3, 5);
    // warning: precision = 0/(0+0+1) = 0
    expect(bySev?.warning?.precision).toBeCloseTo(0.0, 5);
  });

  test("formatRunMetricsAnalysis includes disposition section when present", () => {
    const eventsWithDispositions: TelemetryEvent[] = [
      makeDispositionEvent("d-1", { fixed: 3, dismissed: 1, ignored: 2, acknowledged: 0 }),
    ];
    const analysis = analyzeRunMetrics(eventsWithDispositions);
    const formatted = formatRunMetricsAnalysis(analysis);
    expect(formatted).toContain("Disposition Precision");
    expect(formatted).toContain("pooled");
  });

  test("formatRunMetricsAnalysis omits disposition section when absent", () => {
    const analysis = analyzeRunMetrics(events); // no dispositions block
    const formatted = formatRunMetricsAnalysis(analysis);
    expect(formatted).not.toContain("Disposition Precision");
  });
});
