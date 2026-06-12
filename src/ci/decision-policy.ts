import type { CiDecision, ReviewConfig, ReviewSummary, Severity } from "../contracts/index.ts";

export interface CiDecisionPolicyOptions {
  failOpenOnReviewFailed?: boolean;
}

export function decideCiOutcome(
  summary: ReviewSummary,
  config: ReviewConfig,
  options: CiDecisionPolicyOptions = {},
): CiDecision {
  if (summary.decision === "review_failed") {
    const failOpen = options.failOpenOnReviewFailed ?? config.mode === "advisory";
    return {
      outcome: failOpen ? "neutral" : "fail",
      exitCode: failOpen ? 0 : 1,
      reason: failOpen
        ? "Review failed but policy is fail-open."
        : "Review failed and policy is fail-closed.",
    };
  }

  if (config.mode === "advisory") {
    return {
      outcome: "pass",
      exitCode: 0,
      reason: "Advisory mode does not fail CI for review findings.",
    };
  }

  const highestBlockingSeverity = highestSeverity(
    summary.findings.map((finding) => finding.severity),
    config.failOn,
  );
  if (highestBlockingSeverity !== undefined) {
    return {
      outcome: "fail",
      exitCode: 1,
      reason: `Blocking mode fails CI because a ${highestBlockingSeverity} finding matched fail_on policy.`,
    };
  }

  if (summary.outcome === "fail") {
    return {
      outcome: "fail",
      exitCode: 1,
      reason: "Review summary requested a failing CI outcome.",
    };
  }

  return {
    outcome: "pass",
    exitCode: 0,
    reason: "No findings matched blocking CI policy.",
  };
}

function highestSeverity(severities: Severity[], allowed: Severity[]): Severity | undefined {
  const order: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    suggestion: 1,
  };
  const allowedSet = new Set(allowed);
  let highest: Severity | undefined;

  for (const severity of severities) {
    if (!allowedSet.has(severity)) {
      continue;
    }

    if (highest === undefined || order[severity] > order[highest]) {
      highest = severity;
    }
  }

  return highest;
}
