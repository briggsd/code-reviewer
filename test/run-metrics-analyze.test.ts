import { expect, test } from "bun:test";

import type { TelemetryEvent } from "../src/contracts/telemetry.ts";
import { analyzeRunMetrics, formatRunMetricsAnalysis } from "../src/state/run-metrics-analyze.ts";

// Synthetic events that cover all branches:
//   run-1: full tier, many findings, high output tokens — NOT thin
//   run-2: lite tier, low output tokens (below 250 floor) — flagged thin
//   run-3: trivial tier, ~0 output tokens — NOT thin (trivial is never flagged)
//   run-4: dummy runtime — EXCLUDED
//   run-5: non-run_metrics event — ignored
//   run-1 also carries grounding/locationBackfill/acknowledgements blocks

const events: TelemetryEvent[] = [
  // run-1: full tier, 2 findings, high output tokens, optional blocks present
  {
    type: "ai_review.run_metrics",
    timestamp: "2026-06-11T00:00:00.000Z",
    runId: "run-1",
    data: {
      runtime: "pi",
      riskTier: "full",
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
        estimatedCostUsd: 0.6,
      },
      grounding: { droppedFindingCount: 1 },
      locationBackfill: { backfilledCount: 1 },
      acknowledgements: { acknowledgedCount: 1 },
    },
  },
  // run-2: lite tier, 1 finding, low output tokens (below 250 floor) → thin
  {
    type: "ai_review.run_metrics",
    timestamp: "2026-06-11T01:00:00.000Z",
    runId: "run-2",
    data: {
      runtime: "pi",
      riskTier: "lite",
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

  // lite run has 100 output tokens < 250 floor → thin
  expect(analysis.byTier.lite?.thinReviewRunCount).toBe(1);
  expect(analysis.byTier.lite?.thinReviewRate).toBeCloseTo(1.0, 5);

  // full run has 1200 output tokens > 250 floor → NOT thin
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

test("analyzeRunMetrics custom thinReviewOutputTokenFloor", () => {
  // With floor = 150, the lite run (100 tokens) is still thin, but let's verify
  // the full run (1200 tokens) is still not thin
  const analysis = analyzeRunMetrics(events, { thinReviewOutputTokenFloor: 150 });
  expect(analysis.byTier.lite?.thinReviewRunCount).toBe(1);
  expect(analysis.byTier.full?.thinReviewRunCount).toBe(0);

  // With a floor of 2000, both full (1200) and lite (100) would be thin
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
