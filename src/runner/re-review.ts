import type {
  ConvergenceMetrics,
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
  const convergence = computeConvergenceMetrics(
    currentFindings.map((finding) => finding.id as string),
    newFindingIds,
    recurringFindingIds,
    priorById,
    priorState.hiddenMetadata,
  );

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
    convergence,
  };
}

function computeConvergenceMetrics(
  currentFindingIds: readonly string[],
  newFindingIds: readonly string[],
  recurringFindingIds: readonly string[],
  priorById: ReadonlyMap<string, PriorFindingState>,
  priorHiddenMetadata: PriorReviewState["hiddenMetadata"],
): ConvergenceMetrics {
  const recurring = new Set(recurringFindingIds);
  const newIds = new Set(newFindingIds);
  const resolvedIds = parseResolvedStableIds(priorHiddenMetadata?.resolvedLog);
  const recurrenceDepths: Record<string, number> = {};
  let maxRecurrenceDepth = 0;
  let flappingFindingCount = 0;

  for (const stableId of currentFindingIds) {
    const prior = priorById.get(stableId);
    const depth =
      recurring.has(stableId) && prior !== undefined
        ? (sanitizeDepth(prior.recurrenceDepth) ?? 2)
        : 1;
    recurrenceDepths[stableId] = depth;
    maxRecurrenceDepth = Math.max(maxRecurrenceDepth, depth);

    // A flap is a re-raised finding: it is new relative to the immediately prior open
    // set, but prior hidden metadata says the same stable ID was resolved in an earlier
    // round. This is counts-only; finding bodies/paths never enter telemetry.
    if (newIds.has(stableId) && resolvedIds.has(stableId)) {
      flappingFindingCount += 1;
    }
  }

  return {
    maxRecurrenceDepth,
    flappingFindingCount,
    currentFindingCount: currentFindingIds.length,
    recurrenceDepths,
  };
}

function parseResolvedStableIds(raw: unknown): ReadonlySet<string> {
  const stableIds = new Set<string>();
  if (!Array.isArray(raw)) {
    return stableIds;
  }

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const stableId = (entry as { stableId?: unknown }).stableId;
    if (typeof stableId === "string" && stableId.length > 0 && stableId.length <= 256) {
      stableIds.add(stableId);
    }
  }
  return stableIds;
}

function sanitizeDepth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 10_000
    ? Math.min(value + 1, 10_000)
    : undefined;
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
