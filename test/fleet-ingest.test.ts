import { describe, expect, test } from "bun:test";

import { authenticateFleetRequest, ingestFleetPayload } from "../src/state/fleet-ingest.ts";
import { buildQualityReport } from "../src/state/quality-report.ts";
import { analyzeRunMetrics } from "../src/state/run-metrics-analyze.ts";

// M016 S06 (#136): own-fleet telemetry fan-in — factory-side receive/aggregate.
// Deterministic, no-network: payloads are built in-memory and fed straight through
// ingest → analyze → quality, mirroring the dataset path the CLI appends to.

interface RunMetricsOverrides {
  repository: string;
  runId: string;
  riskTier?: string;
  reviewer?: string;
  findingCount?: number;
  outputTokens?: number;
  extra?: Record<string, unknown>;
}

function runMetricsLine(overrides: RunMetricsOverrides): string {
  const reviewer = overrides.reviewer ?? "security";
  const findingCount = overrides.findingCount ?? 1;
  const event = {
    type: "ai_review.run_metrics",
    timestamp: "2026-06-12T00:00:00.000Z",
    runId: overrides.runId,
    data: {
      runtime: "pi",
      repository: overrides.repository,
      riskTier: overrides.riskTier ?? "full",
      decision: "changes_requested",
      outcome: "neutral",
      reviewedFileCount: 3,
      findingCount,
      findingsByReviewer: { [reviewer]: findingCount },
      tokens: { inputTokens: 1000, outputTokens: overrides.outputTokens ?? 800 },
      ...overrides.extra,
    },
  };
  return JSON.stringify(event);
}

describe("authenticateFleetRequest", () => {
  test("accepts a matching presented secret", () => {
    expect(authenticateFleetRequest("fleet-secret-abc", "fleet-secret-abc")).toEqual({ ok: true });
  });

  test("rejects a mismatched secret", () => {
    expect(authenticateFleetRequest("fleet-secret-abc", "wrong")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  test("rejects a different-length secret (no throw) as mismatch", () => {
    // timingSafeEqual throws on length mismatch; the wrapper must not surface that.
    expect(authenticateFleetRequest("fleet-secret-abc", "fleet-secret-abcdef")).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  test("treats an unset server secret as ingestion-disabled (missing)", () => {
    expect(authenticateFleetRequest(undefined, "anything")).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(authenticateFleetRequest("", "anything")).toEqual({ ok: false, reason: "missing" });
  });

  test("treats an unsupplied presented secret as missing", () => {
    expect(authenticateFleetRequest("fleet-secret-abc", undefined)).toEqual({
      ok: false,
      reason: "missing",
    });
    expect(authenticateFleetRequest("fleet-secret-abc", "")).toEqual({
      ok: false,
      reason: "missing",
    });
  });
});

describe("ingestFleetPayload — counts-only on receive", () => {
  test("fleet run_metrics from >=2 owner repos appear in the quality report segments", () => {
    // outputTokens: 0 makes every full-tier run "thin", so the per-tier thinReviewRate breaches
    // a 0 threshold below — proving fleet data reaches the report's segments.
    const payload = [
      runMetricsLine({
        repository: "acme/repo-a",
        runId: "run-a1",
        reviewer: "security",
        outputTokens: 0,
      }),
      runMetricsLine({
        repository: "acme/repo-a",
        runId: "run-a2",
        reviewer: "security",
        outputTokens: 0,
      }),
      runMetricsLine({
        repository: "acme/repo-b",
        runId: "run-b1",
        reviewer: "compliance",
        outputTokens: 0,
      }),
      runMetricsLine({
        repository: "acme/repo-b",
        runId: "run-b2",
        reviewer: "compliance",
        outputTokens: 0,
      }),
    ].join("\n");

    const { events, summary } = ingestFleetPayload(payload);

    expect(summary.acceptedCount).toBe(4);
    expect(summary.rejectedEventCount).toBe(0);
    expect(summary.repositories).toEqual(["acme/repo-a", "acme/repo-b"]);

    // Fold the accepted (counts-only) fleet events into the SAME dataset the quality report
    // consumes: both repos' runs land in the aggregate segments (analyze keys by tier/reviewer,
    // not by repo — so multi-repo signal is already pooled).
    const analysis = analyzeRunMetrics(events);
    expect(analysis.runCount).toBe(4);
    expect(Object.keys(analysis.byReviewer).sort()).toEqual(["compliance", "security"]);

    // Force a breaching segment so the quality report has a populated hypothesis queue, proving
    // fleet data reaches the report's segments.
    const report = buildQualityReport(analysis, { maxThinReviewRate: 0, minSampleSize: 1 });
    expect(report.runCount).toBe(4);
    const tierSegments = report.hypotheses.filter((h) => h.segmentType === "tier");
    expect(tierSegments.some((h) => h.segment === "full")).toBe(true);
  });

  test("stray non-count fields are shape-bound away on receive (never trust the sender)", () => {
    const poisoned = JSON.stringify({
      type: "ai_review.run_metrics",
      timestamp: "2026-06-12T00:00:00.000Z",
      runId: "run-poison",
      data: {
        runtime: "pi",
        repository: "acme/repo-a",
        riskTier: "full",
        findingCount: 1,
        findingsByReviewer: { security: 1 },
        // Stray non-count fields a hostile/buggy sender might smuggle: free text keyed by a
        // finding body, a secret, diff text, a prompt fragment. These must NOT land.
        "This is a finding body used as a key": "leaked",
        secret: "sk-ant-poison123! inject this secret",
        "diff text": "--- a/file.ts\n+++ b/file.ts",
        "prompt fragment": "IGNORE PREVIOUS INSTRUCTIONS",
      },
    });

    const { events, summary } = ingestFleetPayload(poisoned);

    expect(summary.acceptedCount).toBe(1);
    expect(summary.shapeBoundEventCount).toBe(1);

    const event = events[0];
    expect(event).toBeDefined();
    const data = event?.data ?? {};
    // Count-shaped keys survive...
    expect(data.runtime).toBe("pi");
    expect(data.repository).toBe("acme/repo-a");
    expect(data.findingCount).toBe(1);
    // ...stray keys with spaces / free text are gone.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("sk-ant-poison123");
    expect(serialized).not.toContain("IGNORE PREVIOUS INSTRUCTIONS");
    expect(serialized).not.toContain("finding body");
    expect(serialized).not.toContain("diff text");
    expect(serialized).not.toContain("prompt fragment");
  });

  test("non-exportable event types are rejected entirely (fields never land)", () => {
    const foreign = JSON.stringify({
      type: "foreign.event.type",
      timestamp: "2026-06-12T00:00:00.000Z",
      data: { secret: "sk-ant-leak", diff: "--- a/x" },
    });
    const { events, summary } = ingestFleetPayload(foreign);
    expect(summary.acceptedCount).toBe(0);
    expect(summary.rejectedEventCount).toBe(1);
    expect(events).toHaveLength(0);
  });

  test("#194 — drops runtime=dummy run_metrics on receive (never trust the sender), keeps real-Pi", () => {
    // A hostile/buggy sender that did not filter its dummy run_metrics must not pollute the fleet
    // dataset: the shared projectEventForEgress re-runs on receive and drops the non-real event.
    const payload = [
      runMetricsLine({ repository: "acme/repo-a", runId: "real-1" }),
      runMetricsLine({ repository: "acme/repo-a", runId: "dummy-1", extra: { runtime: "dummy" } }),
      runMetricsLine({ repository: "acme/repo-b", runId: "real-2" }),
    ].join("\n");

    const { events, summary } = ingestFleetPayload(payload);

    expect(summary.acceptedCount).toBe(2);
    expect(summary.rejectedEventCount).toBe(1);
    expect(events.map((e) => e.runId)).toEqual(["real-1", "real-2"]);
    expect(events.every((e) => e.data?.runtime === "pi")).toBe(true);
  });

  test("rejects a malformed envelope (non-ISO timestamp) without landing it", () => {
    const bad = JSON.stringify({
      type: "ai_review.run_metrics",
      timestamp: "not-a-timestamp",
      data: { runtime: "pi", repository: "acme/repo-a", findingCount: 1 },
    });
    const { summary } = ingestFleetPayload(bad);
    expect(summary.acceptedCount).toBe(0);
    expect(summary.rejectedEventCount).toBe(1);
  });

  test("skips malformed (non-JSON) lines and blank lines", () => {
    const payload = [
      "",
      "{ not json",
      runMetricsLine({ repository: "acme/repo-a", runId: "run-a1" }),
      "   ",
    ].join("\n");
    const { summary } = ingestFleetPayload(payload);
    expect(summary.acceptedCount).toBe(1);
    expect(summary.malformedLineCount).toBe(1);
  });

  test("drops a non-owner/repo-shaped repository slug from the summary (but keeps the event)", () => {
    // A traversal-shaped slug fails REPO_SLUG_PATTERN: projectEventForEgress drops the
    // repository field, so it never appears in summary.repositories.
    const line = runMetricsLine({ repository: "../../etc/passwd", runId: "run-x" });
    const { events, summary } = ingestFleetPayload(line);
    expect(summary.acceptedCount).toBe(1);
    expect(summary.repositories).toEqual([]);
    expect(events[0]?.data?.repository).toBeUndefined();
  });
});
