import { describe, expect, test } from "bun:test";
import type {
  ChangedPathsSince,
  DiffSummary,
  Finding,
  PriorReviewState,
  ReviewSummary,
} from "../src/contracts/index.ts";
import {
  classifyReReviewFindings,
  createReReviewSummary,
  decideIncrementalReview,
  narrowDiffToPaths,
} from "../src/runner/index.ts";

function prior(previousHeadSha: string | undefined, findings: PriorReviewState["findings"] = []) {
  return {
    ...(previousHeadSha !== undefined ? { previousHeadSha } : {}),
    findings,
  } satisfies PriorReviewState;
}

function priorFinding(stableId: string, path?: string) {
  const finding: Finding = {
    id: stableId,
    reviewer: "security",
    severity: "warning",
    category: "security",
    title: stableId,
    body: "",
    confidence: "medium",
    evidence: [],
    recommendation: "",
    ...(path !== undefined ? { location: { path } } : {}),
  };
  return { stableId, finding, status: "open" as const, lastSeenHeadSha: "old" };
}

function delta(changedPaths: string[], isAncestor: boolean): ChangedPathsSince {
  return { changedPaths, isAncestor };
}

describe("decideIncrementalReview", () => {
  test("full review when there is no prior state", () => {
    const plan = decideIncrementalReview({ priorState: undefined, headSha: "h", delta: undefined });
    expect(plan).toEqual({ mode: "full", reason: "no_prior_state" });
  });

  test("full review when previousHeadSha equals the current head", () => {
    const plan = decideIncrementalReview({
      priorState: prior("h"),
      headSha: "h",
      delta: delta(["a.ts"], true),
    });
    expect(plan.reason).toBe("same_head");
  });

  test("full review when the adapter cannot compute the delta", () => {
    const plan = decideIncrementalReview({
      priorState: prior("old"),
      headSha: "new",
      delta: undefined,
    });
    expect(plan.reason).toBe("delta_unavailable");
  });

  test("full review (base_changed) on a force-push / rebase — previousHeadSha not an ancestor", () => {
    const plan = decideIncrementalReview({
      priorState: prior("old"),
      headSha: "new",
      delta: delta(["a.ts"], false),
    });
    expect(plan).toEqual({ mode: "full", reason: "base_changed" });
  });

  test("incremental when prior head is a clean ancestor and the delta is known", () => {
    const plan = decideIncrementalReview({
      priorState: prior("old"),
      headSha: "new",
      delta: delta(["b.ts", "c.ts"], true),
    });
    expect(plan.mode).toBe("incremental");
    expect(plan.reviewedPaths).toEqual(["b.ts", "c.ts"]);
  });
});

describe("narrowDiffToPaths", () => {
  test("keeps only delta files and recomputes totals", () => {
    const diff: DiffSummary = {
      files: [
        { path: "a.ts", status: "modified", additions: 1, deletions: 0, isBinary: false },
        { path: "b.ts", status: "modified", additions: 3, deletions: 2, isBinary: false },
      ],
      totalAdditions: 4,
      totalDeletions: 2,
      truncated: false,
    };
    const narrowed = narrowDiffToPaths(diff, new Set(["b.ts"]));
    expect(narrowed.files.map((f) => f.path)).toEqual(["b.ts"]);
    expect(narrowed.totalAdditions).toBe(3);
    expect(narrowed.totalDeletions).toBe(2);
  });
});

function summaryWith(findings: Finding[]): ReviewSummary {
  return {
    decision: "approved",
    outcome: "pass",
    title: "",
    body: "",
    findings,
    risk: {
      tier: "lite",
      reason: "",
      matchedRules: [],
      sensitivePaths: [],
      reviewedFileCount: 1,
      ignoredFileCount: 0,
    },
  };
}

describe("carry-forward classification (incremental)", () => {
  const priorState = prior("old", [
    priorFinding("fnd_delta_gone", "delta.ts"), // on the delta, now absent → fixed
    priorFinding("fnd_offdelta", "untouched.ts"), // off the delta → carried forward
    priorFinding("fnd_nopath"), // path-less → carried forward (cannot confirm)
  ]);

  test("full review (no reviewedPaths): absent prior findings are fixed, none carried forward", () => {
    const reReview = createReReviewSummary(summaryWith([]), priorState);
    expect(reReview.fixedFindingIds.sort()).toEqual([
      "fnd_delta_gone",
      "fnd_nopath",
      "fnd_offdelta",
    ]);
    expect(reReview.carriedForwardFindingIds).toEqual([]);
  });

  test("incremental: only re-reviewed-and-absent is fixed; off-delta + path-less carried forward", () => {
    const reReview = createReReviewSummary(
      summaryWith([]),
      priorState,
      new Set<string>(),
      new Set(["delta.ts"]),
    );
    expect(reReview.fixedFindingIds).toEqual(["fnd_delta_gone"]);
    expect(reReview.carriedForwardFindingIds.sort()).toEqual(["fnd_nopath", "fnd_offdelta"]);
    const carried = reReview.classifications.find((c) => c.stableId === "fnd_offdelta");
    expect(carried?.status).toBe("carried_forward");
    expect(carried?.priorFinding?.location?.path).toBe("untouched.ts");
  });

  test("a finding still present on the delta is recurring, not carried forward", () => {
    const current = priorFinding("fnd_delta_gone", "delta.ts").finding;
    const reReview = createReReviewSummary(
      summaryWith([current]),
      priorState,
      new Set<string>(),
      new Set(["delta.ts"]),
    );
    expect(reReview.recurringFindingIds).toEqual(["fnd_delta_gone"]);
    expect(reReview.fixedFindingIds).toEqual([]);
    expect(reReview.carriedForwardFindingIds.sort()).toEqual(["fnd_nopath", "fnd_offdelta"]);
  });

  test("classifyReReviewFindings attaches the block when only carried-forward exists", () => {
    const out = classifyReReviewFindings(
      summaryWith([]),
      prior("old", [priorFinding("fnd_offdelta", "untouched.ts")]),
      new Set<string>(),
      new Set(["delta.ts"]),
    );
    expect(out.reReview?.carriedForwardFindingIds).toEqual(["fnd_offdelta"]);
  });
});
