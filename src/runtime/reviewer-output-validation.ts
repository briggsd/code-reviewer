/**
 * Reviewer and coordinator output parsing, role enforcement, and severity enforcement.
 *
 * Consumes the raw text (or tool-call args) from an agent run and returns
 * typed, validated findings. Trust-boundary enforcement (reviewer-role and
 * severity normalisation) lives here alongside the parse/repair entrypoints.
 */

import type { Finding, ReviewSummary, RiskAssessment, Severity } from "../contracts/index.ts";
import type { summarizeReview } from "../runner/run-review.ts";
import { extractFencedJson, parseJsonCandidate, parseJsonObject } from "./pi-json-repair.ts";
import { getRecord, type ParsedReviewerOutput, validateFinding } from "./structured-tool-output.ts";

// ParsedReviewerOutput is defined in structured-tool-output.ts (where parseReviewerToolArgs lives)
// and re-exported from there. It is re-used here for the prose path so both delivery paths share
// the same return shape. See structured-tool-output.ts for the type's doc comment and rationale.
export type { ParsedReviewerOutput };

export function parseReviewerOutput(text: string): ParsedReviewerOutput {
  // Tier 1 (whole-object parse, unchanged path): if the full JSON parses, take its findings array.
  // Tier 2 (line-independent recovery): if the whole-object parse throws, salvage findings element
  // by element so one syntactically-corrupt finding drops ONE, not the whole reviewer.
  const { rawFindings, recoveredDropCount } = extractRawFindings(text); // throws if no array found

  if (rawFindings.length === 0 && recoveredDropCount === 0) {
    return { findings: [], droppedFindingCount: 0 }; // a genuinely empty array is a clean review
  }

  // Tolerant per-element validation: drop a structurally-invalid finding instead of throwing on it.
  const findings = rawFindings.flatMap((raw) => {
    try {
      return [validateFinding(raw)];
    } catch {
      return [];
    }
  });

  // Correctness over savings (principle #1): a non-empty array whose findings ALL failed is a
  // failed reviewer, NOT a clean approval — surface it as a classified failure (the #120 degrade
  // path), do not silently return an empty (approve) summary.
  if (findings.length === 0 && rawFindings.length > 0) {
    throw new Error("Pi reviewer output: all findings failed validation");
  }

  // Count BOTH drop classes: corrupt elements dropped during recovery + valid-JSON elements that
  // failed validation. Emitted as `droppedFindingCount` telemetry so a partial drop is observable.
  const droppedFindingCount = recoveredDropCount + (rawFindings.length - findings.length);
  return { findings, droppedFindingCount };
}

// Tier 1 then Tier 2. Returns the raw (un-validated) finding values plus how many corrupt elements
// the Tier-2 recovery had to drop (0 on the Tier-1 happy path). Throws only when no findings array
// can be located at all (a genuinely unparseable reviewer output → classified failure).
function extractRawFindings(text: string): { rawFindings: unknown[]; recoveredDropCount: number } {
  try {
    const parsed = parseJsonObject(text);
    const findings = Array.isArray(parsed) ? parsed : getRecord(parsed).findings;
    if (Array.isArray(findings)) {
      return { rawFindings: findings, recoveredDropCount: 0 };
    }
  } catch {
    // fall through to line-independent recovery
  }
  return recoverFindingElements(text);
}

// Line-independent (JSONL-style) recovery: locate the findings array, split it into top-level
// element substrings, and parseJsonCandidate each INDEPENDENTLY — a syntactically-corrupt element
// is dropped while its siblings survive.
function recoverFindingElements(text: string): {
  rawFindings: unknown[];
  recoveredDropCount: number;
} {
  const trimmed = text.trim();
  const candidate = extractFencedJson(trimmed) ?? trimmed;

  // Find the '[' that opens the findings array. Prefer the bracket after a "findings" key; fall
  // back to the first '[' (covers a bare top-level array). If neither exists, this output has no
  // findings array to recover — a genuine total failure.
  const openBracket = locateFindingsArrayStart(candidate);
  if (openBracket === -1) {
    throw new Error("Pi reviewer output: no findings array to recover");
  }

  const elements = splitTopLevelArrayElements(candidate, openBracket); // string[] of element text
  const raw: unknown[] = [];
  let firstElementError: unknown;
  for (const element of elements) {
    try {
      raw.push(parseJsonCandidate(element)); // reuse repair tiers per-element
    } catch (err) {
      // drop this one corrupt element; its siblings still parse
      if (firstElementError === undefined) {
        firstElementError = err;
      }
    }
  }

  // A located-but-non-empty array that salvaged NOTHING is a failed reviewer (don't false-approve).
  // Re-throw the first element error to preserve its message (e.g. bounded-repair budget exceeded)
  // so the failure is observable and classifiable downstream. An array we split into zero elements
  // (e.g. "[]") legitimately yields [] (clean review).
  if (elements.length > 0 && raw.length === 0) {
    if (firstElementError instanceof Error) {
      throw firstElementError;
    }
    throw new Error("Pi reviewer output: every recovered finding was unparseable");
  }
  return { rawFindings: raw, recoveredDropCount: elements.length - raw.length };
}

// Return the index of the '[' that opens the findings array, or -1.
function locateFindingsArrayStart(candidate: string): number {
  const match = /"findings"\s*:\s*\[/.exec(candidate);
  if (match !== null) {
    // Return the index of the '[' at the end of the match
    return match.index + match[0].length - 1;
  }
  return candidate.indexOf("[");
}

// Walk the text from openBracketIndex (the opening '['), returning the trimmed substring of each
// top-level element of that array. String-aware and depth-aware so braces/brackets/commas INSIDE
// a finding object or string don't split it.
// Note: a corrupt element with an unterminated string can, in pathological cases, swallow its
// neighbor — that's an acceptable bound: the dominant case (one self-contained corrupt object among
// valid ones) drops exactly one.
function splitTopLevelArrayElements(text: string, openBracketIndex: number): string[] {
  const elements: string[] = [];
  let current = "";
  let bracketDepth = 0;
  let braceDepth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openBracketIndex; i < text.length; i++) {
    const ch = text[i] ?? "";

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escaped = true;
        current += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      current += ch;
      continue;
    }

    // Not in a string
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }

    if (ch === "[") {
      bracketDepth++;
      if (bracketDepth === 1) {
        // This is the opening bracket of the array — don't add it to the element accumulator
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "]") {
      bracketDepth--;
      if (bracketDepth === 0) {
        // End of the array — push final element and stop
        const trimmed = current.trim();
        if (trimmed.length > 0) {
          elements.push(trimmed);
        }
        break;
      }
      current += ch;
      continue;
    }

    if (ch === "{") {
      braceDepth++;
      current += ch;
      continue;
    }

    if (ch === "}") {
      braceDepth--;
      current += ch;
      continue;
    }

    if (ch === "," && bracketDepth === 1 && braceDepth === 0) {
      // Top-level element separator
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        elements.push(trimmed);
      }
      current = "";
      continue;
    }

    current += ch;
  }

  return elements;
}

export interface SeverityAdjustment {
  index: number;
  originalSeverity: Severity;
  adjustedSeverity: Severity;
  reason: "reviewer_severity_not_allowed";
}

export interface ReviewerRoleAdjustment {
  index: number;
  emittedReviewer: string;
  dispatchedRole: string;
  reason: "reviewer_role_mismatch";
}

export interface CoordinatorRoleAdjustment {
  index: number;
  emittedReviewer: string;
  adjustedReviewer: "coordinator";
  reason: "coordinator_reviewer_not_dispatched";
}

// Trust boundary (issue #32): the `reviewer` label in a specialist finding is
// model-authored and untrusted — a prompt-injected diff can make a reviewer
// self-label as any role (e.g. "security"), and publisher/summary render it
// verbatim. Reviewer-definitions are the only trusted prompt source, so the
// emitted label must equal the role this slot was actually dispatched under.
// Normalize any mismatch back to the dispatched role (rather than discarding,
// to preserve a possibly-real finding) and record an adjustment so spoofing is
// observable. (Model-emitted finding ids are dropped centrally in
// validateFinding, so identity stays factory-owned for every path.)
export function enforceReviewerRole(
  findings: Finding[],
  dispatchedRole: string,
): {
  findings: Finding[];
  adjustments: ReviewerRoleAdjustment[];
} {
  const adjustments: ReviewerRoleAdjustment[] = [];
  const normalizedFindings = findings.map((finding, index) => {
    if (finding.reviewer === dispatchedRole) {
      return finding;
    }

    adjustments.push({
      index,
      emittedReviewer: truncateTraceValue(String(finding.reviewer)),
      dispatchedRole,
      reason: "reviewer_role_mismatch",
    });

    return {
      ...finding,
      reviewer: dispatchedRole,
    };
  });

  return { findings: normalizedFindings, adjustments };
}

// Trust boundary (issue #37): coordinator output is also model-authored, but it
// can legitimately attribute consolidated findings to multiple specialist
// roles. Preserve labels for roles that were actually dispatched for this run,
// and normalize clearly-spoofed out-of-set labels to `coordinator` so summaries
// and stable IDs are not keyed on attacker-chosen roles.
function enforceCoordinatorReviewerRoles(
  findings: Finding[],
  allowedReviewerRoles: readonly string[],
): {
  findings: Finding[];
  adjustments: CoordinatorRoleAdjustment[];
} {
  const allowed = new Set(allowedReviewerRoles);
  const adjustments: CoordinatorRoleAdjustment[] = [];
  const normalizedFindings = findings.map((finding, index) => {
    if (allowed.has(finding.reviewer)) {
      return finding;
    }

    adjustments.push({
      index,
      emittedReviewer: truncateTraceValue(String(finding.reviewer)),
      adjustedReviewer: "coordinator",
      reason: "coordinator_reviewer_not_dispatched",
    });

    return {
      ...finding,
      reviewer: "coordinator",
    };
  });

  return { findings: normalizedFindings, adjustments };
}

// Adjustment traces echo model-authored content (a spoofed reviewer label);
// bound it so an adversarial label can't bloat the trace/telemetry stream.
function truncateTraceValue(value: string): string {
  const limit = 120;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

export function enforceReviewerAllowedSeverities(
  findings: Finding[],
  allowedSeverities: readonly Severity[],
): {
  findings: Finding[];
  adjustments: SeverityAdjustment[];
} {
  const allowed = new Set(allowedSeverities);
  const maximumAllowedSeverity = maxSeverity(allowedSeverities);
  if (maximumAllowedSeverity === undefined) {
    return { findings, adjustments: [] };
  }

  const adjustments: SeverityAdjustment[] = [];
  const normalizedFindings = findings.map((finding, index) => {
    if (allowed.has(finding.severity)) {
      return finding;
    }

    adjustments.push({
      index,
      originalSeverity: finding.severity,
      adjustedSeverity: maximumAllowedSeverity,
      reason: "reviewer_severity_not_allowed",
    });

    return {
      ...finding,
      severity: maximumAllowedSeverity,
    };
  });

  return { findings: normalizedFindings, adjustments };
}

function maxSeverity(severities: readonly Severity[]): Severity | undefined {
  const order: Record<Severity, number> = {
    critical: 3,
    warning: 2,
    suggestion: 1,
  };

  let maximum: Severity | undefined;
  for (const severity of severities) {
    if (maximum === undefined || order[severity] > order[maximum]) {
      maximum = severity;
    }
  }

  return maximum;
}

export function parseCoordinatorOutput(text: string, allowedReviewerRoles: readonly string[]) {
  let parsed: Record<string, unknown>;
  try {
    parsed = getRecord(parseJsonObject(text));
  } catch {
    return undefined;
  }

  if (
    !isReviewDecision(parsed.decision) ||
    !isCiOutcome(parsed.outcome) ||
    typeof parsed.title !== "string" ||
    typeof parsed.body !== "string" ||
    !Array.isArray(parsed.findings) ||
    typeof parsed.risk !== "object" ||
    parsed.risk === null
  ) {
    return undefined;
  }

  const roleEnforcement = enforceCoordinatorReviewerRoles(
    parsed.findings.map((finding) => validateFinding(finding)),
    allowedReviewerRoles,
  );

  return {
    summary: {
      decision: parsed.decision,
      outcome: parsed.outcome,
      title: parsed.title,
      body: parsed.body,
      findings: roleEnforcement.findings,
      risk: parsed.risk as ReturnType<typeof summarizeReview>["risk"],
    },
    reviewerRoleAdjustments: roleEnforcement.adjustments,
  };
}

// Structured analogue of parseCoordinatorOutput (M015 S04, #127): validate the coordinator's
// submit_review tool args into a ReviewSummary. NO JSON.parse / repair on this path. risk is
// sourced from the TRUSTED context (contextRisk), not the model — the submit_review schema
// deliberately omits it (mirrors coordinatorOutputSchema), unlike the prose path which keeps the
// model-authored risk. A tool call with INVALID args THROWS (re-validated via validateFinding /
// the decision+outcome guards) rather than silently falling back to prose — schema drift surfaces
// as a classified failure, exactly like parseReviewerToolArgs in the reviewer path.
export function parseCoordinatorToolArgs(
  args: unknown,
  allowedReviewerRoles: readonly string[],
  contextRisk: RiskAssessment,
): {
  summary: ReviewSummary;
  reviewerRoleAdjustments: CoordinatorRoleAdjustment[];
} {
  const record = getRecord(args);
  if (
    !isReviewDecision(record.decision) ||
    !isCiOutcome(record.outcome) ||
    typeof record.title !== "string" ||
    typeof record.body !== "string" ||
    !Array.isArray(record.findings)
  ) {
    throw new Error("submit_review tool arguments did not match the coordinator output schema");
  }

  const roleEnforcement = enforceCoordinatorReviewerRoles(
    record.findings.map((finding) => validateFinding(finding)),
    allowedReviewerRoles,
  );

  return {
    summary: {
      decision: record.decision,
      outcome: record.outcome,
      title: record.title,
      body: record.body,
      findings: roleEnforcement.findings,
      risk: contextRisk,
    },
    reviewerRoleAdjustments: roleEnforcement.adjustments,
  };
}

function isReviewDecision(value: unknown): value is ReturnType<typeof summarizeReview>["decision"] {
  return (
    value === "approved" ||
    value === "approved_with_comments" ||
    value === "minor_issues" ||
    value === "significant_concerns" ||
    value === "review_failed"
  );
}

function isCiOutcome(value: unknown): value is ReturnType<typeof summarizeReview>["outcome"] {
  return value === "pass" || value === "fail" || value === "neutral" || value === "skipped";
}
