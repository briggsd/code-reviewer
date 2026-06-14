import type { CiDecision, ReviewConfig, ReviewSummary, Severity } from "../contracts/index.ts";

export interface CiDecisionPolicyOptions {
  failOpenOnReviewFailed?: boolean;
  /**
   * A human break-glass override was recognized for this run (#22 phase 2):
   * a trusted commenter posted a `break glass` PR/MR comment. The CI outcome
   * becomes non-blocking (neutral / exit 0) regardless of findings — the human
   * accepts the risk and the override is recorded as a `run.override` event.
   *
   * This is the single "non-blocking outcome" path in the policy; #26-S02
   * (gate → advisory CI outcome) is intended to route through this same neutral
   * result rather than introduce a second mechanism.
   */
  overridden?: boolean;
}

export function decideCiOutcome(
  summary: ReviewSummary,
  config: ReviewConfig,
  options: CiDecisionPolicyOptions = {},
): CiDecision {
  // Break-glass override short-circuits everything else: a trusted human has
  // accepted the risk for this run, so CI must not block. The override is still
  // measured (run.override) so a rising override rate surfaces a misfiring bot.
  if (options.overridden === true) {
    return {
      outcome: "neutral",
      exitCode: 0,
      reason: "Human break-glass override — CI status is non-blocking for this run.",
    };
  }

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

  let base: CiDecision;

  if (config.mode === "advisory") {
    base = {
      outcome: "pass",
      exitCode: 0,
      reason: "Advisory mode does not fail CI for review findings.",
    };
  } else {
    const highestBlockingSeverity = highestSeverity(
      summary.findings.map((finding) => finding.severity),
      config.failOn,
    );
    if (highestBlockingSeverity !== undefined) {
      base = {
        outcome: "fail",
        exitCode: 1,
        reason: `Blocking mode fails CI because a ${highestBlockingSeverity} finding matched fail_on policy.`,
      };
    } else if (summary.outcome === "fail") {
      base = {
        outcome: "fail",
        exitCode: 1,
        reason: "Review summary requested a failing CI outcome.",
      };
    } else {
      base = {
        outcome: "pass",
        exitCode: 0,
        reason: "No findings matched blocking CI policy.",
      };
    }
  }

  // Degraded review (#212): when a STRICT MAJORITY of attempted reviewers failed in a
  // completing run, the surviving findings are not a trustworthy full review — treat it like
  // review_failed for the gate. ESCALATION ONLY: never downgrade a would-be-fail (a blocking
  // finding from a surviving reviewer must still fail), so this fires only when base == pass.
  const degraded = summary.degraded;
  const degradedMajority =
    degraded !== undefined && degraded.failedReviewerCount > degraded.completedReviewerCount;
  if (degradedMajority && base.outcome === "pass") {
    const failOpen = options.failOpenOnReviewFailed ?? config.mode === "advisory";
    return failOpen
      ? {
          outcome: "neutral",
          exitCode: 0,
          reason: "Majority of reviewers failed — review is degraded; policy is fail-open.",
        }
      : {
          outcome: "fail",
          exitCode: 1,
          reason: "Majority of reviewers failed — review is degraded; policy is fail-closed.",
        };
  }
  return base;
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
