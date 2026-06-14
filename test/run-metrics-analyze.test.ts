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
  expect(analysis.structuredOutput).toBeUndefined();
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
