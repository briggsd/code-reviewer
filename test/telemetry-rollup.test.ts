import { expect, test } from "bun:test";

import type { TelemetryEvent } from "../src/contracts/telemetry.ts";
import { rollupRunMetrics } from "../src/state/run-metrics-rollup.ts";

test("rollup aggregates metrics and excludes dummy runtimes", () => {
  const events: TelemetryEvent[] = [
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-10T00:00:00.000Z",
      runId: "run-1",
      data: {
        runtime: "pi",
        riskTier: "full",
        decision: "significant_concerns",
        findingsByReviewer: {
          security: 1,
          performance: 1,
        },
        findingCount: 2,
        tokens: {
          agentCount: 4,
          inputTokens: 2000,
          outputTokens: 900,
          estimatedCostUsd: 0.5,
        },
        agents: [
          {
            role: "coordinator",
            kind: "coordinator",
            usage: {
              inputTokens: 500,
              outputTokens: 250,
              estimatedCostUsd: 0.1,
            },
            retryCount: 1,
          },
          {
            role: "security",
            kind: "reviewer",
            usage: {
              inputTokens: 1000,
              outputTokens: 500,
              estimatedCostUsd: 0.3,
            },
          },
        ],
        failures: [
          {
            role: "security",
            kind: "reviewer",
            retryCount: 1,
            errorClassification: {
              retryable: true,
            },
          },
        ],
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-10T01:00:00.000Z",
      runId: "run-2",
      data: {
        runtime: "pi",
        riskTier: "lite",
        decision: "no_findings",
        findingsByReviewer: {
          security: 1,
        },
        findingCount: 1,
        tokens: {
          agentCount: 3,
          inputTokens: 1500,
          outputTokens: 600,
          estimatedCostUsd: 0.4,
        },
        agents: [
          {
            role: "coordinator",
            kind: "coordinator",
            usage: {
              inputTokens: 400,
              outputTokens: 200,
              estimatedCostUsd: 0.08,
            },
            retryCount: 0,
          },
          {
            role: "security",
            kind: "reviewer",
            usage: {
              inputTokens: 700,
              outputTokens: 300,
              estimatedCostUsd: 0.15,
            },
            retryCount: 2,
          },
        ],
        failures: [
          {
            role: "coordinator",
            kind: "coordinator",
            retryCount: 0,
            errorClassification: {
              retryable: false,
            },
          },
        ],
      },
    },
    {
      type: "ai_review.run_metrics",
      timestamp: "2026-06-10T02:00:00.000Z",
      runId: "run-3",
      data: {
        runtime: "dummy",
        riskTier: "full",
        decision: "review_failed",
        findingCount: 5,
      },
    },
    {
      type: "runtime.event",
      timestamp: "2026-06-10T03:00:00.000Z",
      data: {
        event: "telemetry.emit_failed",
      },
    },
  ];

  const rollup = rollupRunMetrics(events);

  expect(rollup.runCount).toBe(2);
  expect(rollup.runtimeCounts.pi).toBe(2);
  expect(rollup.riskTierCounts).toEqual({
    full: 1,
    lite: 1,
  });
  expect(rollup.decisionCounts).toEqual({
    significant_concerns: 1,
    no_findings: 1,
  });
  expect(rollup.findings.total).toBe(3);
  expect(rollup.findings.byReviewer).toEqual({
    security: 2,
    performance: 1,
  });
  expect(rollup.retries.agentRetryCount).toBe(3);
  expect(rollup.retries.agentRetryCountsByRole).toEqual({
    coordinator: 1,
    security: 2,
  });
  expect(rollup.retries.failureCount).toBe(2);
  expect(rollup.retries.retryableFailureCount).toBe(1);
  expect(rollup.retries.failureRetryCount).toBe(1);
  expect(rollup.retries.failureRetryCountsByRole).toEqual({
    security: 1,
  });
  expect(rollup.tokens.totalAgentCount).toBe(7);
  expect(rollup.tokens.totalInputTokens).toBe(3500);
  expect(rollup.tokens.totalOutputTokens).toBe(1500);
  expect(rollup.tokens.totalEstimatedCostUsd).toBeCloseTo(0.9);
  const coordinatorTokens = rollup.tokens.byRole.coordinator;
  expect(coordinatorTokens).toBeDefined();
  expect(coordinatorTokens).toMatchObject({
    callCount: 2,
    totalInputTokens: 900,
    totalOutputTokens: 450,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  });
  expect(coordinatorTokens?.totalEstimatedCostUsd).toBeCloseTo(0.18, 4);

  const securityTokens = rollup.tokens.byRole.security;
  expect(securityTokens).toBeDefined();
  expect(securityTokens).toMatchObject({
    callCount: 2,
    totalInputTokens: 1700,
    totalOutputTokens: 800,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
  });
  expect(securityTokens?.totalEstimatedCostUsd).toBeCloseTo(0.45, 4);
  expect(rollup.yield.findingsPerRun).toBeCloseTo(1.5);
  expect(rollup.yield.inputTokensPerFinding).toBeCloseTo(1166.6667, 3);
  expect(rollup.yield.outputTokensPerFinding).toBeCloseTo(500, 4);
  expect(rollup.yield.costPerFindingUsd).toBeCloseTo(0.3, 4);
});
