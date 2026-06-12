import type {
  ChangedFile,
  ChangeMetadata,
  DiffSummary,
  Finding,
  FindingLocation,
} from "../contracts/index.ts";

export type InlinePublishBlockReason =
  | "stale_head_sha"
  | "diff_truncated"
  | "missing_location"
  | "missing_line"
  | "missing_side"
  | "unsupported_side"
  | "file_not_in_diff"
  | "binary_file"
  | "patch_missing"
  | "deleted_file_right_side"
  | "added_file_left_side"
  | "line_not_in_patch";

export interface InlinePublishBlockedFinding {
  finding: Finding;
  reasons: InlinePublishBlockReason[];
}

export interface InlinePublishReadiness {
  canPublishInline: boolean;
  readyFindings: Finding[];
  blockedFindings: InlinePublishBlockedFinding[];
}

export interface EvaluateInlinePublishReadinessInput {
  change: ChangeMetadata;
  diff: DiffSummary;
  findings: Finding[];
  /**
   * The head SHA used when the findings were generated. If it differs from the
   * current change head SHA, all inline publishing must be blocked.
   */
  expectedHeadSha?: string;
}

export function evaluateInlinePublishReadiness(
  input: EvaluateInlinePublishReadinessInput,
): InlinePublishReadiness {
  const globalReasons: InlinePublishBlockReason[] = [];
  if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== input.change.headSha) {
    globalReasons.push("stale_head_sha");
  }
  if (input.diff.truncated) {
    globalReasons.push("diff_truncated");
  }

  const readyFindings: Finding[] = [];
  const blockedFindings: InlinePublishBlockedFinding[] = [];

  for (const finding of input.findings) {
    const reasons = [...globalReasons, ...evaluateFindingLocation(finding, input.diff)];
    if (reasons.length === 0) {
      readyFindings.push(finding);
    } else {
      blockedFindings.push({ finding, reasons: uniqueReasons(reasons) });
    }
  }

  return {
    canPublishInline: blockedFindings.length === 0,
    readyFindings,
    blockedFindings,
  };
}

function evaluateFindingLocation(finding: Finding, diff: DiffSummary): InlinePublishBlockReason[] {
  const location = finding.location;
  if (location === undefined) {
    return ["missing_location"];
  }

  const reasons: InlinePublishBlockReason[] = [];
  const line = lineForLocation(location);
  if (line === undefined) {
    reasons.push("missing_line");
  }

  if (location.side === undefined) {
    reasons.push("missing_side");
  } else if (location.side !== "LEFT" && location.side !== "RIGHT") {
    reasons.push("unsupported_side");
  }

  const file = findChangedFile(diff.files, location.path);
  if (file === undefined) {
    reasons.push("file_not_in_diff");
  } else {
    reasons.push(...evaluateFileCoordinate(file, location, line));
  }

  return reasons;
}

function evaluateFileCoordinate(
  file: ChangedFile,
  location: FindingLocation,
  line: number | undefined,
): InlinePublishBlockReason[] {
  const reasons: InlinePublishBlockReason[] = [];
  if (file.isBinary) {
    reasons.push("binary_file");
  }
  if (file.patch === undefined || file.patch.length === 0) {
    reasons.push("patch_missing");
  }
  if (location.side === "RIGHT" && file.status === "deleted") {
    reasons.push("deleted_file_right_side");
  }
  if (location.side === "LEFT" && file.status === "added") {
    reasons.push("added_file_left_side");
  }

  if (
    line !== undefined &&
    location.side !== undefined &&
    file.patch !== undefined &&
    file.patch.length > 0
  ) {
    const lines = parsePatchLines(file.patch);
    const candidateLines = location.side === "LEFT" ? lines.left : lines.right;
    if (!candidateLines.has(line)) {
      reasons.push("line_not_in_patch");
    }
  }

  return reasons;
}

function lineForLocation(location: FindingLocation): number | undefined {
  return location.line ?? location.startLine;
}

function findChangedFile(files: ChangedFile[], path: string): ChangedFile | undefined {
  return files.find((file) => file.path === path || file.oldPath === path);
}

function parsePatchLines(patch: string): { left: Set<number>; right: Set<number> } {
  const left = new Set<number>();
  const right = new Set<number>();
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const row of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (
      oldLine === undefined ||
      newLine === undefined ||
      row.startsWith("diff --git") ||
      row.startsWith("---") ||
      row.startsWith("+++")
    ) {
      continue;
    }

    if (row.startsWith("+")) {
      right.add(newLine);
      newLine += 1;
    } else if (row.startsWith("-")) {
      left.add(oldLine);
      oldLine += 1;
    } else {
      left.add(oldLine);
      right.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }

  return { left, right };
}

function uniqueReasons(reasons: InlinePublishBlockReason[]): InlinePublishBlockReason[] {
  return [...new Set(reasons)];
}
