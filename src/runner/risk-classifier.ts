import type { DiffSummary, ReviewConfig, RiskAssessment } from "../contracts/index.ts";
import { matchesAnyGlob } from "./path-match.ts";

export interface RiskClassificationInput {
  diff: DiffSummary;
  config: ReviewConfig;
  ignoredFileCount: number;
}

export function classifyRisk(input: RiskClassificationInput): RiskAssessment {
  const sensitivePaths = input.diff.files
    .map((file) => file.path)
    .filter((path) => matchesAnyGlob(path, input.config.sensitivePaths));
  const reviewedFileCount = input.diff.files.length;
  const totalChangedLines = input.diff.totalAdditions + input.diff.totalDeletions;

  if (sensitivePaths.length > 0) {
    return {
      tier: "full",
      reason: "Security or production-sensitive paths changed.",
      matchedRules: ["sensitive_paths"],
      sensitivePaths,
      reviewedFileCount,
      ignoredFileCount: input.ignoredFileCount,
    };
  }

  if (reviewedFileCount > 50 || totalChangedLines > 500) {
    return {
      tier: "full",
      reason: "Large change exceeds full-review thresholds.",
      matchedRules: ["large_change"],
      sensitivePaths: [],
      reviewedFileCount,
      ignoredFileCount: input.ignoredFileCount,
    };
  }

  if (reviewedFileCount <= 5 && totalChangedLines <= 25) {
    return {
      tier: "trivial",
      reason: "Small change with no configured sensitive paths.",
      matchedRules: ["small_change"],
      sensitivePaths: [],
      reviewedFileCount,
      ignoredFileCount: input.ignoredFileCount,
    };
  }

  return {
    tier: "lite",
    reason: "Moderate change with no configured sensitive paths.",
    matchedRules: ["default_lite"],
    sensitivePaths: [],
    reviewedFileCount,
    ignoredFileCount: input.ignoredFileCount,
  };
}
