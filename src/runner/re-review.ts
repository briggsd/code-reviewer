import type {
  PriorFindingState,
  PriorReviewState,
  ReReviewSummary,
  ReviewSummary,
} from "../contracts/index.ts";

/**
 * Convergence (#149 — Tier 1): a re-review whose finding set is unchanged since the last
 * review — zero new, zero fixed, AND zero withheld. Withheld is included because a
 * recurring→withheld transition (e.g. a prior finding grounding-dropped this push) changes
 * the published summary, so the comment must be re-posted. `carriedForwardFindingIds` is
 * intentionally excluded — those are prior findings on files NOT re-reviewed this push
 * (incremental, off-delta); gating on them would make incremental re-pushes never converge.
 * Distinct from "all issues resolved" (a clean PR). Returns false when there is no re-review
 * (first review / no prior state) — the first post is never suppressed.
 *
 * Single source of truth for the convergence decision: run-review.ts surfaces this on
 * RunReviewResult.converged, and the CLI suppresses the redundant summary re-post when true.
 */
export function isReReviewConverged(reReview: ReReviewSummary | undefined): boolean {
  return (
    reReview !== undefined &&
    reReview.newFindingIds.length === 0 &&
    reReview.fixedFindingIds.length === 0 &&
    reReview.withheldFindingIds.length === 0
  );
}

export function classifyReReviewFindings(
  summary: ReviewSummary,
  priorState: PriorReviewState | undefined,
  withheldStableIds?: ReadonlySet<string>,
  reviewedPaths?: ReadonlySet<string>,
): ReviewSummary {
  if (priorState === undefined) {
    return summary;
  }

  const reReview = createReReviewSummary(summary, priorState, withheldStableIds, reviewedPaths);
  const hasVisibleReReviewState =
    reReview.newFindingIds.length > 0 ||
    reReview.recurringFindingIds.length > 0 ||
    reReview.fixedFindingIds.length > 0 ||
    reReview.withheldFindingIds.length > 0 ||
    reReview.carriedForwardFindingIds.length > 0;

  if (!hasVisibleReReviewState) {
    return summary;
  }

  return {
    ...summary,
    reReview,
  };
}

/**
 * A prior finding absent from the current run can be called "fixed" ONLY when it
 * was actually re-reviewed this push. In an incremental re-review (`reviewedPaths`
 * provided), a prior finding whose file is NOT in the delta — or whose path is
 * unknown — was not re-evaluated, so it is carried forward as still-open instead
 * of being misclassified as fixed (#46, AC #2). In a full review (`reviewedPaths`
 * undefined) every file is re-reviewed, so absence means fixed, as before.
 */
function wasReReviewed(
  prior: PriorFindingState,
  reviewedPaths: ReadonlySet<string> | undefined,
): boolean {
  if (reviewedPaths === undefined) {
    return true;
  }
  const path = prior.finding.location?.path;
  return path !== undefined && reviewedPaths.has(path);
}

export function createReReviewSummary(
  summary: ReviewSummary,
  priorState: PriorReviewState,
  withheldStableIds?: ReadonlySet<string>,
  reviewedPaths?: ReadonlySet<string>,
): ReReviewSummary {
  const withheld: ReadonlySet<string> = withheldStableIds ?? new Set<string>();
  const priorById = new Map(priorState.findings.map((finding) => [finding.stableId, finding]));
  const currentFindings = summary.findings.filter(
    (finding) => finding.id !== undefined && finding.id.length > 0,
  );
  const currentById = new Map(currentFindings.map((finding) => [finding.id as string, finding]));

  const newFindingIds = currentFindings
    .map((finding) => finding.id as string)
    .filter((stableId) => !priorById.has(stableId));
  const recurringFindingIds = currentFindings
    .map((finding) => finding.id as string)
    .filter((stableId) => priorById.has(stableId));
  // Prior findings absent from the current run, split by whether they were actually
  // re-reviewed: re-reviewed → fixed; not re-reviewed (incremental, off-delta) → carried forward.
  const absentPrior = priorState.findings.filter(
    (finding) => !currentById.has(finding.stableId) && !withheld.has(finding.stableId),
  );
  const fixedFindingIds = absentPrior
    .filter((finding) => wasReReviewed(finding, reviewedPaths))
    .map((finding) => finding.stableId);
  const carriedForwardFindingIds = absentPrior
    .filter((finding) => !wasReReviewed(finding, reviewedPaths))
    .map((finding) => finding.stableId);
  const withheldFindingIds = priorState.findings
    .map((finding) => finding.stableId)
    .filter((stableId) => withheld.has(stableId) && !currentById.has(stableId));

  return {
    newFindingIds,
    recurringFindingIds,
    fixedFindingIds,
    withheldFindingIds,
    carriedForwardFindingIds,
    classifications: [
      ...newFindingIds.map((stableId) => ({
        stableId,
        status: "new" as const,
        finding: requireCurrentFinding(currentById, stableId),
      })),
      ...recurringFindingIds.map((stableId) => {
        const prior = priorById.get(stableId);

        return {
          stableId,
          status: "recurring" as const,
          finding: requireCurrentFinding(currentById, stableId),
          ...(prior !== undefined
            ? { priorFinding: prior.finding, lastSeenHeadSha: prior.lastSeenHeadSha }
            : {}),
        };
      }),
      ...fixedFindingIds.map((stableId) => {
        const prior = priorById.get(stableId);

        return {
          stableId,
          status: "fixed" as const,
          ...(prior !== undefined
            ? { priorFinding: prior.finding, lastSeenHeadSha: prior.lastSeenHeadSha }
            : {}),
        };
      }),
      ...withheldFindingIds.map((stableId) => {
        const prior = priorById.get(stableId);

        return {
          stableId,
          status: "withheld" as const,
          ...(prior !== undefined
            ? { priorFinding: prior.finding, lastSeenHeadSha: prior.lastSeenHeadSha }
            : {}),
        };
      }),
      ...carriedForwardFindingIds.map((stableId) => {
        const prior = priorById.get(stableId);

        return {
          stableId,
          status: "carried_forward" as const,
          ...(prior !== undefined
            ? { priorFinding: prior.finding, lastSeenHeadSha: prior.lastSeenHeadSha }
            : {}),
        };
      }),
    ],
  };
}

function requireCurrentFinding(
  currentById: Map<string, ReviewSummary["findings"][number]>,
  stableId: string,
): ReviewSummary["findings"][number] {
  const finding = currentById.get(stableId);
  if (finding === undefined) {
    throw new Error(`missing current finding for stable ID ${stableId}`);
  }

  return finding;
}
