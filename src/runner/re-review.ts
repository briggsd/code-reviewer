import type { PriorReviewState, ReReviewSummary, ReviewSummary } from "../contracts/index.ts";

export function classifyReReviewFindings(summary: ReviewSummary, priorState: PriorReviewState | undefined): ReviewSummary {
  if (priorState === undefined) {
    return summary;
  }

  const reReview = createReReviewSummary(summary, priorState);

  return {
    ...summary,
    reReview,
  };
}

export function createReReviewSummary(summary: ReviewSummary, priorState: PriorReviewState): ReReviewSummary {
  const priorById = new Map(priorState.findings.map((finding) => [finding.stableId, finding]));
  const currentFindings = summary.findings.filter((finding) => finding.id !== undefined && finding.id.length > 0);
  const currentById = new Map(currentFindings.map((finding) => [finding.id as string, finding]));

  const newFindingIds = currentFindings
    .map((finding) => finding.id as string)
    .filter((stableId) => !priorById.has(stableId));
  const recurringFindingIds = currentFindings
    .map((finding) => finding.id as string)
    .filter((stableId) => priorById.has(stableId));
  const fixedFindingIds = priorState.findings
    .map((finding) => finding.stableId)
    .filter((stableId) => !currentById.has(stableId));

  return {
    newFindingIds,
    recurringFindingIds,
    fixedFindingIds,
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
          ...(prior !== undefined ? { priorFinding: prior.finding, lastSeenHeadSha: prior.lastSeenHeadSha } : {}),
        };
      }),
      ...fixedFindingIds.map((stableId) => {
        const prior = priorById.get(stableId);

        return {
          stableId,
          status: "fixed" as const,
          ...(prior !== undefined ? { priorFinding: prior.finding, lastSeenHeadSha: prior.lastSeenHeadSha } : {}),
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
