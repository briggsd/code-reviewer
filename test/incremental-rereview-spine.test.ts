/**
 * Spine e2e test for incremental re-review (#46).
 *
 * Drives `runReviewFromChange` with an incremental plan and verifies:
 *   1. Prior finding on a reviewed file that is NOT re-found → fixedFindingIds.
 *   2. Prior finding on an off-delta file → carriedForwardFindingIds, NOT fixedFindingIds.
 *   3. The narrowed diff contains only the reviewed paths.
 *   4. A `review.incremental` trace event is emitted with mode === "incremental".
 */

import { describe, expect, test } from "bun:test";
import type { Finding, PriorReviewState, RuntimeEvent } from "../src/index.ts";
import { loadReviewFixture, runReviewFromChange } from "../src/index.ts";

// ---------------------------------------------------------------------------
// Minimal recording trace sink (mirrors break-glass-wiring.test.ts pattern)
// ---------------------------------------------------------------------------

class RecordingTraceSink {
  readonly events: RuntimeEvent[] = [];

  async write(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
  }

  async close(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function priorFinding(stableId: string, path?: string): PriorReviewState["findings"][number] {
  const finding: Finding = {
    id: stableId,
    reviewer: "security",
    severity: "warning",
    category: "security",
    title: stableId,
    body: "Prior finding body.",
    confidence: "medium",
    evidence: [],
    recommendation: "Fix this.",
    ...(path !== undefined ? { location: { path } } : {}),
  };
  return { stableId, finding, status: "open", lastSeenHeadSha: "old-head" };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("incremental re-review spine (end-to-end)", () => {
  test("carry-forward and fixed classification with incremental plan", async () => {
    // Use the mixed-diff fixture which has ≥2 files.
    // Files in the diff: src/app.ts, package-lock.json, public/app.min.js, assets/logo.png,
    // migrations/20260609_add_accounts.sql, .github/workflows/release.yml
    const fixture = await loadReviewFixture("examples/fixtures/mixed-diff.json");

    // The incremental plan says only src/app.ts was changed since previousHeadSha.
    const reviewedPath = "src/app.ts";
    const offDeltaPath = "migrations/20260609_add_accounts.sql";

    const priorState: PriorReviewState = {
      previousRunId: "prior-run",
      previousHeadSha: "old-head",
      findings: [
        // On the delta — absent from current findings → should be "fixed"
        priorFinding("fnd_on_delta", reviewedPath),
        // Off the delta — should be "carried_forward", never "fixed"
        priorFinding("fnd_off_delta", offDeltaPath),
      ],
    };

    const traceSink = new RecordingTraceSink();

    // Run with incremental plan: only reviewedPath is in the delta
    const result = await runReviewFromChange({
      metadata: fixture.metadata,
      diff: fixture.diff,
      config: fixture.config,
      priorState,
      traceSink,
      incremental: {
        mode: "incremental",
        reason: "incremental",
        reviewedPaths: [reviewedPath],
      },
      // No fakeFindings → zero findings returned → on-delta prior is fixed
      fakeFindings: [],
    });

    // 1. Narrowed diff contains only the reviewed file
    const reviewedFiles = result.context.diff.files.map((f) => f.path);
    expect(reviewedFiles).toEqual([reviewedPath]);

    // 2. On-delta prior finding (absent this run) → fixed
    expect(result.summary.reReview?.fixedFindingIds).toContain("fnd_on_delta");
    expect(result.summary.reReview?.fixedFindingIds).not.toContain("fnd_off_delta");

    // 3. Off-delta prior finding → carried_forward (still-open, not fixed)
    expect(result.summary.reReview?.carriedForwardFindingIds).toContain("fnd_off_delta");
    expect(result.summary.reReview?.carriedForwardFindingIds).not.toContain("fnd_on_delta");

    // 4. Classifications match expectations
    const offDeltaClass = result.summary.reReview?.classifications.find(
      (c) => c.stableId === "fnd_off_delta",
    );
    expect(offDeltaClass?.status).toBe("carried_forward");

    const onDeltaClass = result.summary.reReview?.classifications.find(
      (c) => c.stableId === "fnd_on_delta",
    );
    expect(onDeltaClass?.status).toBe("fixed");

    // 5. review.incremental trace event emitted with correct mode
    const incrementalEvent = traceSink.events.find((e) => e.type === "review.incremental");
    expect(incrementalEvent).toBeDefined();
    const eventData = incrementalEvent?.data as Record<string, unknown> | undefined;
    expect(eventData?.mode).toBe("incremental");
  });

  test("full plan emits no review.incremental event (no incremental option passed)", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/mixed-diff.json");
    const traceSink = new RecordingTraceSink();

    await runReviewFromChange({
      metadata: fixture.metadata,
      diff: fixture.diff,
      config: fixture.config,
      traceSink,
      fakeFindings: [],
    });

    const incrementalEvent = traceSink.events.find((e) => e.type === "review.incremental");
    expect(incrementalEvent).toBeUndefined();
  });

  test("full-mode incremental plan (delta_unavailable fallback) does not carry forward", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/mixed-diff.json");
    const offDeltaPath = "migrations/20260609_add_accounts.sql";
    const priorState: PriorReviewState = {
      previousRunId: "prior-run",
      previousHeadSha: "old-head",
      findings: [priorFinding("fnd_will_be_fixed", offDeltaPath)],
    };
    const traceSink = new RecordingTraceSink();

    // "full" mode plan — the delta was unavailable
    const result = await runReviewFromChange({
      metadata: fixture.metadata,
      diff: fixture.diff,
      config: fixture.config,
      priorState,
      traceSink,
      incremental: {
        mode: "full",
        reason: "delta_unavailable",
      },
      fakeFindings: [],
    });

    // Full review: all prior findings absent → fixed, none carried forward
    expect(result.summary.reReview?.fixedFindingIds).toContain("fnd_will_be_fixed");
    expect(result.summary.reReview?.carriedForwardFindingIds).toEqual([]);

    // review.incremental is still emitted (mode="full") since the incremental option was provided
    const incrementalEvent = traceSink.events.find((e) => e.type === "review.incremental");
    expect(incrementalEvent).toBeDefined();
    const eventData = incrementalEvent?.data as Record<string, unknown> | undefined;
    expect(eventData?.mode).toBe("full");
  });
});
