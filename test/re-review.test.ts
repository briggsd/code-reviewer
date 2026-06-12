import { describe, expect, test } from "bun:test";
import type { Finding, PriorReviewState, ReviewSummary } from "../src/index.ts";
import {
  classifyReReviewFindings,
  createReReviewSummary,
  formatReviewSummaryMarkdown,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";

const recurringFinding: Finding = {
  id: "fnd_recurring",
  reviewer: "security",
  severity: "critical",
  category: "auth",
  title: "Account lookup misses authorization",
  body: "The endpoint still misses an ownership check.",
  location: {
    path: "auth/accounts.ts",
    line: 23,
    side: "RIGHT",
  },
  confidence: "high",
  evidence: ["The patch still returns account data without ownership verification."],
  recommendation: "Check account ownership before returning account data.",
};

const newFinding: Finding = {
  id: "fnd_new",
  reviewer: "code_quality",
  severity: "warning",
  category: "correctness",
  title: "Missing null handling",
  body: "The endpoint does not handle missing account IDs.",
  confidence: "medium",
  evidence: ["accountId is read without a presence check."],
  recommendation: "Return a validation error when accountId is missing.",
};

const priorState: PriorReviewState = {
  previousRunId: "prior-run",
  previousHeadSha: "old-head",
  findings: [
    {
      stableId: "fnd_recurring",
      finding: recurringFinding,
      status: "open",
      lastSeenHeadSha: "old-head",
    },
    {
      stableId: "fnd_fixed",
      finding: {
        ...recurringFinding,
        id: "fnd_fixed",
        title: "Fixed prior issue",
      },
      status: "open",
      lastSeenHeadSha: "old-head",
    },
  ],
};

describe("re-review finding classification", () => {
  test("classifies current findings as new/recurring and prior missing findings as fixed", () => {
    const summary = createSummary([recurringFinding, newFinding]);
    const reReview = createReReviewSummary(summary, priorState);

    expect(reReview.newFindingIds).toEqual(["fnd_new"]);
    expect(reReview.recurringFindingIds).toEqual(["fnd_recurring"]);
    expect(reReview.fixedFindingIds).toEqual(["fnd_fixed"]);
    expect(reReview.classifications.map((classification) => classification.status)).toEqual([
      "new",
      "recurring",
      "fixed",
    ]);
    expect(
      reReview.classifications.find((classification) => classification.stableId === "fnd_recurring")
        ?.lastSeenHeadSha,
    ).toBe("old-head");
  });

  test("runner attaches re-review classification when prior state is present", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const currentFinding = fixture.fakeFindings?.[0];
    if (currentFinding === undefined) {
      throw new Error("expected fixture finding");
    }

    const firstRun = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });
    const stableId = firstRun.summary.findings[0]?.id;
    if (stableId === undefined) {
      throw new Error("expected stable finding id");
    }

    const secondRun = await runReview({
      fixture: {
        ...fixture,
        priorState: {
          previousRunId: "prior-run",
          previousHeadSha: "old-head",
          findings: [
            {
              stableId,
              finding: { ...currentFinding, id: stableId },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
            {
              stableId: "fnd_fixed_prior",
              finding: { ...currentFinding, id: "fnd_fixed_prior", title: "Prior fixed finding" },
              status: "open",
              lastSeenHeadSha: "old-head",
            },
          ],
        },
      },
      now: new Date("2026-06-09T00:00:01.000Z"),
    });

    expect(secondRun.context.priorState?.previousRunId).toBe("prior-run");
    expect(secondRun.summary.reReview?.newFindingIds).toEqual([]);
    expect(secondRun.summary.reReview?.recurringFindingIds).toEqual([stableId]);
    expect(secondRun.summary.reReview?.fixedFindingIds).toEqual(["fnd_fixed_prior"]);
  });

  test("re-review fixture demonstrates recurring and fixed prior findings", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/re-review-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(result.context.priorState?.previousRunId).toBe("fixture-auth-pr");
    expect(result.summary.reReview?.newFindingIds).toEqual([]);
    expect(result.summary.reReview?.recurringFindingIds).toEqual(["fnd_fixture_recurring_auth"]);
    expect(result.summary.reReview?.fixedFindingIds).toEqual(["fnd_fixture_fixed_null_check"]);
  });

  test("omits empty zero-count re-review state", () => {
    const summary = classifyReReviewFindings(createSummary([]), {
      previousRunId: "prior-empty-run",
      previousHeadSha: "old-head",
      findings: [],
    });
    const markdown = formatReviewSummaryMarkdown(summary);

    expect(summary.reReview).toBeUndefined();
    expect(markdown).not.toContain("### Re-review status");
  });

  test("summary markdown renders re-review counts and fixed IDs", () => {
    const markdown = formatReviewSummaryMarkdown({
      ...createSummary([recurringFinding]),
      reReview: createReReviewSummary(createSummary([recurringFinding]), priorState),
    });

    expect(markdown).toContain("### Re-review status");
    expect(markdown).toContain("New findings: 0");
    expect(markdown).toContain("Recurring findings: 1");
    expect(markdown).toContain("Fixed prior findings: 1");
    expect(markdown).toContain("`fnd_fixed`");
  });

  test("summary markdown renders withheld counts and IDs (withheld finding surfaces, not silently absent)", () => {
    // fnd_fixed is withheld this run (not resolved) → it must show as withheld, not fixed,
    // and the count must render so the section isn't misleading (the finding-1 fix).
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, priorState, new Set(["fnd_fixed"]));
    const markdown = formatReviewSummaryMarkdown({ ...summary, reReview });

    expect(markdown).toContain("### Re-review status");
    expect(markdown).toContain("Fixed prior findings: 0");
    expect(markdown).toContain("Withheld prior findings: 1");
    expect(markdown).toContain("Withheld IDs: `fnd_fixed`");
  });

  test("withheld: prior finding in withheldStableIds goes to withheldFindingIds, not fixedFindingIds", () => {
    // fnd_fixed is absent from current summary; passing it as withheld should route it to withheld
    const summary = createSummary([recurringFinding]);
    const withheldStableIds = new Set(["fnd_fixed"]);
    const reReview = createReReviewSummary(summary, priorState, withheldStableIds);

    expect(reReview.withheldFindingIds).toEqual(["fnd_fixed"]);
    expect(reReview.fixedFindingIds).toEqual([]);
    const withheldClassification = reReview.classifications.find((c) => c.stableId === "fnd_fixed");
    expect(withheldClassification?.status).toBe("withheld");
    expect(withheldClassification?.priorFinding).toBeDefined();
    expect(withheldClassification?.lastSeenHeadSha).toBe("old-head");
  });

  test("withheld: prior finding absent from current AND absent from withheldStableIds stays in fixedFindingIds (regression guard)", () => {
    // fnd_fixed is absent from current summary; NOT in withheldStableIds → must still be fixed
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, priorState, new Set<string>());

    expect(reReview.fixedFindingIds).toEqual(["fnd_fixed"]);
    expect(reReview.withheldFindingIds).toEqual([]);
    const fixedClassification = reReview.classifications.find((c) => c.stableId === "fnd_fixed");
    expect(fixedClassification?.status).toBe("fixed");
  });

  test("withheld: no third arg → withheldFindingIds is empty and fixedFindingIds unchanged (back-compat)", () => {
    // Calling without the optional third parameter must behave exactly as before the change
    const summary = createSummary([recurringFinding]);
    const reReview = createReReviewSummary(summary, priorState);

    expect(reReview.withheldFindingIds).toEqual([]);
    expect(reReview.fixedFindingIds).toEqual(["fnd_fixed"]);
  });

  test("withheld: hasVisibleReReviewState becomes true when only withheldFindingIds is non-empty", () => {
    // A summary with NO new/recurring/fixed but with withheld findings should still attach reReview
    const emptyPrior: PriorReviewState = {
      previousRunId: "prior-run",
      previousHeadSha: "old-head",
      findings: [
        {
          stableId: "fnd_withheld_only",
          finding: { ...recurringFinding, id: "fnd_withheld_only" },
          status: "open",
          lastSeenHeadSha: "old-head",
        },
      ],
    };
    // Current summary has NO findings → fnd_withheld_only absent from current
    // withheldStableIds contains it → should be withheld not fixed
    const summary = createSummary([]);
    const withheldStableIds = new Set(["fnd_withheld_only"]);
    const result = classifyReReviewFindings(summary, emptyPrior, withheldStableIds);

    expect(result.reReview).toBeDefined();
    expect(result.reReview?.withheldFindingIds).toEqual(["fnd_withheld_only"]);
    expect(result.reReview?.fixedFindingIds).toEqual([]);
  });
});

function createSummary(findings: Finding[]): ReviewSummary {
  return {
    decision: "significant_concerns",
    outcome: "fail",
    title: "AI review found issues",
    body: "Review body",
    findings,
    risk: {
      tier: "full",
      reason: "Sensitive auth change.",
      matchedRules: ["sensitive_paths"],
      sensitivePaths: ["auth/accounts.ts"],
      reviewedFileCount: 1,
      ignoredFileCount: 0,
    },
  };
}
