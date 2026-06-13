/**
 * Tests for src/runner/run-events.ts (pure builders).
 *
 * Coverage:
 * 1. run.start shape: schemaVersion, event subtype, sorted/deduped modelIds, roles verbatim.
 * 2. run.completed: counts only; tokens block present iff token metrics given.
 * 3. deriveAcceptanceByReviewer: full mapping from re-review classifications.
 * 4. createRunCorrectionEvent: built/absent conditions.
 * 5. Negative/boundary: no free-text fields in event data.
 */

import { describe, expect, test } from "bun:test";
import type { Finding, ReReviewFindingClassification, ReviewSummary } from "../src/index.ts";
import {
  createRunCompletedEvent,
  createRunCorrectionEvent,
  createRunOverrideEvent,
  createRunStartEvent,
  deriveAcceptanceByReviewer,
  RUN_EVENT_SCHEMA_VERSION,
} from "../src/runner/run-events.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseSummary(overrides?: Partial<ReviewSummary>): ReviewSummary {
  return {
    decision: "approved",
    outcome: "pass",
    title: "AI review found no blocking issues",
    body: "Risk tier: full",
    findings: [],
    risk: {
      tier: "full",
      reason: "changed files",
      matchedRules: [],
      sensitivePaths: [],
      reviewedFileCount: 2,
      ignoredFileCount: 0,
    },
    ...overrides,
  };
}

function makeFinding(overrides?: Partial<Finding>): Finding {
  return {
    reviewer: "security",
    severity: "critical",
    category: "auth",
    title: "FINDING_TITLE_SHOULD_NOT_APPEAR",
    body: "FINDING_BODY_SHOULD_NOT_APPEAR",
    confidence: "high",
    evidence: ["evidence text"],
    recommendation: "fix it",
    ...overrides,
  };
}

function makeClassification(
  status: ReReviewFindingClassification["status"],
  opts?: {
    reviewer?: string;
    priorReviewer?: string;
  },
): ReReviewFindingClassification {
  const reviewer = opts?.reviewer ?? "security";
  const priorReviewer = opts?.priorReviewer ?? "code_quality";

  if (status === "fixed" || status === "withheld") {
    return {
      stableId: `fnd_${status}`,
      status,
      priorFinding: makeFinding({ reviewer: priorReviewer }),
      lastSeenHeadSha: "abc123",
    };
  }

  if (status === "new") {
    return {
      stableId: "fnd_new",
      status,
      finding: makeFinding({ reviewer }),
    };
  }

  // recurring
  return {
    stableId: "fnd_recurring",
    status: "recurring",
    finding: makeFinding({ reviewer }),
    priorFinding: makeFinding({ reviewer: priorReviewer }),
    lastSeenHeadSha: "abc123",
  };
}

// ---------------------------------------------------------------------------
// 1. run.start shape
// ---------------------------------------------------------------------------

describe("createRunStartEvent", () => {
  test("produces correct type and event subtype", () => {
    const event = createRunStartEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:00.000Z",
      repository: "acme/api",
      changeId: "42",
      riskTier: "full",
      selectedReviewerRoles: ["security", "code_quality"],
      modelIds: ["claude-sonnet-4", "claude-sonnet-4"],
    });

    expect(event.type).toBe("ai_review.run_event");
    expect(event.runId).toBe("run-1");
    expect(event.timestamp).toBe("2026-06-12T00:00:00.000Z");
    expect(event.data?.event).toBe("run.start");
    expect(event.data?.schemaVersion).toBe(RUN_EVENT_SCHEMA_VERSION);
  });

  test("deduplicates and sorts modelIds", () => {
    const event = createRunStartEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:00.000Z",
      repository: "acme/api",
      changeId: "42",
      riskTier: "full",
      selectedReviewerRoles: ["security"],
      modelIds: ["claude-sonnet-4", "claude-opus-4", "claude-sonnet-4", "claude-haiku-3"],
    });

    expect(event.data?.modelIds).toEqual(["claude-haiku-3", "claude-opus-4", "claude-sonnet-4"]);
  });

  test("preserves selectedReviewerRoles verbatim", () => {
    const roles = ["code_quality", "security", "performance"];
    const event = createRunStartEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:00.000Z",
      repository: "acme/api",
      changeId: "42",
      riskTier: "lite",
      selectedReviewerRoles: roles,
      modelIds: ["model-a"],
    });

    expect(event.data?.selectedReviewerRoles).toEqual(roles);
  });

  test("carries repository, changeId, riskTier", () => {
    const event = createRunStartEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:00.000Z",
      repository: "org/repo",
      changeId: "99",
      riskTier: "trivial",
      selectedReviewerRoles: [],
      modelIds: [],
    });

    expect(event.data?.repository).toBe("org/repo");
    expect(event.data?.changeId).toBe("99");
    expect(event.data?.riskTier).toBe("trivial");
  });
});

// ---------------------------------------------------------------------------
// 2. run.completed
// ---------------------------------------------------------------------------

describe("createRunCompletedEvent", () => {
  test("produces correct type and event subtype", () => {
    const event = createRunCompletedEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:01.000Z",
      repository: "acme/api",
      riskTier: "full",
      decision: "significant_concerns",
      outcome: "fail",
      durationMs: 5000,
      findingCount: 2,
      findingsBySeverity: { critical: 1, warning: 1 },
      findingsByReviewer: { security: 1, code_quality: 1 },
    });

    expect(event.type).toBe("ai_review.run_event");
    expect(event.data?.event).toBe("run.completed");
    expect(event.data?.schemaVersion).toBe(RUN_EVENT_SCHEMA_VERSION);
  });

  test("carries counts and identifiers", () => {
    const event = createRunCompletedEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:01.000Z",
      repository: "acme/api",
      riskTier: "full",
      decision: "approved",
      outcome: "pass",
      durationMs: 1234,
      findingCount: 0,
      findingsBySeverity: {},
      findingsByReviewer: {},
    });

    expect(event.data?.decision).toBe("approved");
    expect(event.data?.outcome).toBe("pass");
    expect(event.data?.durationMs).toBe(1234);
    expect(event.data?.findingCount).toBe(0);
    expect(event.data?.repository).toBe("acme/api");
    expect(event.data?.riskTier).toBe("full");
  });

  test("includes tokens block when token metrics provided", () => {
    const event = createRunCompletedEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:01.000Z",
      repository: "acme/api",
      riskTier: "full",
      decision: "approved",
      outcome: "pass",
      durationMs: 1000,
      findingCount: 0,
      findingsBySeverity: {},
      findingsByReviewer: {},
      tokens: {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        estimatedCostUsd: 0.05,
      },
    });

    expect(event.data?.tokens).toBeDefined();
    const tokens = event.data?.tokens as Record<string, unknown>;
    expect(tokens.inputTokens).toBe(1000);
    expect(tokens.outputTokens).toBe(500);
    expect(tokens.cacheReadTokens).toBe(200);
    expect(tokens.estimatedCostUsd).toBe(0.05);
  });

  test("omits tokens block when no token metrics given", () => {
    const event = createRunCompletedEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:01.000Z",
      repository: "acme/api",
      riskTier: "full",
      decision: "approved",
      outcome: "pass",
      durationMs: 1000,
      findingCount: 0,
      findingsBySeverity: {},
      findingsByReviewer: {},
    });

    expect(event.data?.tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. deriveAcceptanceByReviewer
// ---------------------------------------------------------------------------

describe("deriveAcceptanceByReviewer", () => {
  test("fixed → accepted, attributed to priorFinding.reviewer", () => {
    const summary = makeBaseSummary({
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_fixed"],
        withheldFindingIds: [],
        classifications: [makeClassification("fixed", { priorReviewer: "security" })],
      },
    });

    const result = deriveAcceptanceByReviewer(summary);
    expect(result.security?.accepted).toBe(1);
    expect(result.security?.notAccepted).toBe(0);
  });

  test("recurring → notAccepted, attributed to current finding.reviewer", () => {
    const summary = makeBaseSummary({
      reReview: {
        newFindingIds: [],
        recurringFindingIds: ["fnd_recurring"],
        fixedFindingIds: [],
        withheldFindingIds: [],
        classifications: [makeClassification("recurring", { reviewer: "performance" })],
      },
    });

    const result = deriveAcceptanceByReviewer(summary);
    expect(result.performance?.notAccepted).toBe(1);
    expect(result.performance?.accepted).toBe(0);
  });

  test("withheld → withheldExcluded, attributed to priorFinding.reviewer", () => {
    const summary = makeBaseSummary({
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: ["fnd_withheld"],
        classifications: [makeClassification("withheld", { priorReviewer: "code_quality" })],
      },
    });

    const result = deriveAcceptanceByReviewer(summary);
    expect(result.code_quality?.withheldExcluded).toBe(1);
  });

  test("acknowledged finding → rejected, attributed to current finding.reviewer", () => {
    const finding = makeFinding({
      id: "fnd_ack",
      reviewer: "security",
      acknowledged: { reason: "won't fix - accepted risk" },
    });
    const summary = makeBaseSummary({ findings: [finding] });

    const result = deriveAcceptanceByReviewer(summary);
    expect(result.security?.rejected).toBe(1);
  });

  test("missing priorFinding → bucket under 'unknown'", () => {
    const classification: ReReviewFindingClassification = {
      stableId: "fnd_orphan_fixed",
      status: "fixed",
      // No priorFinding field
    };
    const summary = makeBaseSummary({
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_orphan_fixed"],
        withheldFindingIds: [],
        classifications: [classification],
      },
    });

    const result = deriveAcceptanceByReviewer(summary);
    expect(result.unknown?.accepted).toBe(1);
  });

  test("empty/no-reReview summary → empty record", () => {
    const summary = makeBaseSummary();
    const result = deriveAcceptanceByReviewer(summary);
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("'new' findings are not counted (no acceptance signal)", () => {
    const summary = makeBaseSummary({
      reReview: {
        newFindingIds: ["fnd_new"],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: [],
        classifications: [makeClassification("new", { reviewer: "security" })],
      },
    });

    const result = deriveAcceptanceByReviewer(summary);
    // new findings contribute nothing — no keys
    expect(Object.keys(result)).toHaveLength(0);
  });

  test("mixed classifications accumulate correctly per reviewer", () => {
    const summary = makeBaseSummary({
      findings: [
        makeFinding({
          reviewer: "security",
          id: "fnd_ack",
          acknowledged: { reason: "accepted risk" },
        }),
      ],
      reReview: {
        newFindingIds: ["fnd_new"],
        recurringFindingIds: ["fnd_recurring"],
        fixedFindingIds: ["fnd_fixed"],
        withheldFindingIds: [],
        classifications: [
          makeClassification("new", { reviewer: "security" }),
          makeClassification("recurring", { reviewer: "security" }),
          makeClassification("fixed", { priorReviewer: "security" }),
        ],
      },
    });

    const result = deriveAcceptanceByReviewer(summary);
    expect(result.security?.accepted).toBe(1); // fixed
    expect(result.security?.notAccepted).toBe(1); // recurring
    expect(result.security?.rejected).toBe(1); // acknowledged
    expect(result.security?.withheldExcluded).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. createRunCorrectionEvent
// ---------------------------------------------------------------------------

describe("createRunCorrectionEvent", () => {
  test("returns undefined when no reReview and no acknowledged findings", () => {
    const summary = makeBaseSummary({ findings: [makeFinding()] }); // no acknowledged
    const result = createRunCorrectionEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:02.000Z",
      repository: "acme/api",
      riskTier: "full",
      summary,
    });

    expect(result).toBeUndefined();
  });

  test("is built when summary has a reReview block", () => {
    const summary = makeBaseSummary({
      reReview: {
        newFindingIds: ["fnd_new"],
        recurringFindingIds: [],
        fixedFindingIds: [],
        withheldFindingIds: [],
        classifications: [makeClassification("new")],
      },
    });

    const result = createRunCorrectionEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:02.000Z",
      repository: "acme/api",
      riskTier: "full",
      summary,
    });

    expect(result).toBeDefined();
    expect(result?.type).toBe("ai_review.run_event");
    expect(result?.data?.event).toBe("run.correction");
    expect(result?.data?.schemaVersion).toBe(RUN_EVENT_SCHEMA_VERSION);
    expect(result?.data?.newFindingCount).toBe(1);
    expect(result?.data?.fixedFindingCount).toBe(0);
  });

  test("is built when summary has ONLY acknowledged findings (no reReview)", () => {
    const finding = makeFinding({ acknowledged: { reason: "accepted risk" } });
    const summary = makeBaseSummary({ findings: [finding] });

    const result = createRunCorrectionEvent({
      runId: "run-1",
      timestamp: "2026-06-12T00:00:02.000Z",
      repository: "acme/api",
      riskTier: "full",
      summary,
    });

    expect(result).toBeDefined();
    expect(result?.data?.event).toBe("run.correction");
    // rejected count via acceptanceByReviewer
    const acc = result?.data?.acceptanceByReviewer as Record<string, Record<string, number>>;
    expect(acc.security?.rejected).toBe(1);
  });

  test("correction event carries repository and riskTier", () => {
    const summary = makeBaseSummary({
      reReview: {
        newFindingIds: [],
        recurringFindingIds: [],
        fixedFindingIds: ["fnd_fixed"],
        withheldFindingIds: [],
        classifications: [makeClassification("fixed")],
      },
    });

    const result = createRunCorrectionEvent({
      runId: "run-2",
      timestamp: "2026-06-12T00:00:02.000Z",
      repository: "org/myrepo",
      riskTier: "lite",
      summary,
    });

    expect(result?.data?.repository).toBe("org/myrepo");
    expect(result?.data?.riskTier).toBe("lite");
    expect(result?.runId).toBe("run-2");
  });
});

// ---------------------------------------------------------------------------
// 5. Negative/boundary: no free-text fields in event data
// ---------------------------------------------------------------------------

describe("no free-text fields in emitted events", () => {
  const SENTINEL_TITLE = "SENTINEL_FINDING_TITLE_MUST_NOT_APPEAR";
  const SENTINEL_BODY = "SENTINEL_FINDING_BODY_MUST_NOT_APPEAR";
  const SENTINEL_REASON = "SENTINEL_ACKNOWLEDGED_REASON_MUST_NOT_APPEAR";
  const SENTINEL_BRANCH = "SENTINEL_BRANCH_NAME_MUST_NOT_APPEAR";

  const findingWithSentinel = makeFinding({
    title: SENTINEL_TITLE,
    body: SENTINEL_BODY,
    acknowledged: { reason: SENTINEL_REASON },
  });

  const summaryWithSentinels = makeBaseSummary({
    findings: [findingWithSentinel],
    reReview: {
      newFindingIds: [],
      recurringFindingIds: [],
      fixedFindingIds: ["fnd_fixed"],
      withheldFindingIds: [],
      classifications: [makeClassification("fixed", { priorReviewer: "security" })],
    },
  });

  test("run.start event contains no sentinel strings", () => {
    const event = createRunStartEvent({
      runId: "run-sentinel",
      timestamp: "2026-06-12T00:00:00.000Z",
      repository: "acme/api",
      changeId: "42",
      riskTier: "full",
      selectedReviewerRoles: ["security"],
      modelIds: ["model-a"],
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SENTINEL_TITLE);
    expect(serialized).not.toContain(SENTINEL_BODY);
    expect(serialized).not.toContain(SENTINEL_BRANCH);
  });

  test("run.completed event contains no sentinel strings from findings", () => {
    const event = createRunCompletedEvent({
      runId: "run-sentinel",
      timestamp: "2026-06-12T00:00:01.000Z",
      repository: "acme/api",
      riskTier: "full",
      decision: "approved_with_comments",
      outcome: "pass",
      durationMs: 1000,
      findingCount: 1,
      findingsBySeverity: { critical: 1 },
      findingsByReviewer: { security: 1 },
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SENTINEL_TITLE);
    expect(serialized).not.toContain(SENTINEL_BODY);
    expect(serialized).not.toContain(SENTINEL_REASON);
  });

  test("run.correction event contains no sentinel free-text from summary", () => {
    const event = createRunCorrectionEvent({
      runId: "run-sentinel",
      timestamp: "2026-06-12T00:00:02.000Z",
      repository: "acme/api",
      riskTier: "full",
      summary: summaryWithSentinels,
    });

    expect(event).toBeDefined();
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SENTINEL_TITLE);
    expect(serialized).not.toContain(SENTINEL_BODY);
    expect(serialized).not.toContain(SENTINEL_REASON);
    expect(serialized).not.toContain(SENTINEL_BRANCH);
  });

  test("run.override event carries counts/identifiers only (no author name)", () => {
    const event = createRunOverrideEvent({
      runId: "run-ovr",
      timestamp: "2026-06-12T00:00:03.000Z",
      repository: "acme/api",
      changeId: "42",
      riskTier: "full",
      overrideCommentId: "comment-99887766",
      authorAssociation: "OWNER",
    });

    expect(event.type).toBe("ai_review.run_event");
    expect(event.runId).toBe("run-ovr");
    expect(event.timestamp).toBe("2026-06-12T00:00:03.000Z");
    const data = event.data as Record<string, unknown>;
    expect(data.schemaVersion).toBe(RUN_EVENT_SCHEMA_VERSION);
    expect(data.event).toBe("run.override");
    expect(data.repository).toBe("acme/api");
    expect(data.changeId).toBe("42");
    expect(data.riskTier).toBe("full");
    expect(data.overrideCommentId).toBe("comment-99887766");
    // authorAssociation is a coarse role category (like riskTier), not an author name.
    expect(data.authorAssociation).toBe("OWNER");
    // No author NAME / identity field leaks into telemetry (M008).
    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/login|username|displayName/i);
  });
});
