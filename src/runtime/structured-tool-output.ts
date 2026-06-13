/**
 * Structured reviewer output — read findings from Pi's `submit_findings` tool call (M015 S02, #125).
 *
 * The reviewer agent delivers its findings by calling the factory-owned `submit_findings` tool
 * (built in S01, #124, with `terminate: true`). In Pi's `--mode json` event stream the validated
 * tool arguments surface as one line:
 *
 *   {"type":"tool_execution_start","toolCallId":"toolu_…","toolName":"submit_findings",
 *    "args":{"findings":[ … ]}}
 *
 * `readToolCallArgs` pulls those `args` off the event stream and `parseReviewerToolArgs` validates
 * them into `Finding[]` — the structured analogue of the prose path's
 * `parseReviewerOutput(text)`, but with **no `JSON.parse` and no `repairUnescapedStringQuotes`** on
 * the happy path. Both paths share the same per-finding validator (`validateFinding`), so they
 * cannot drift: this module owns that validator, and the prose path imports it.
 *
 * Pure, no-network, no-I/O — fully exercised by fake event fixtures in the default `bun run check`
 * suite. It sits BELOW the `AgentRuntime` contract line (Pi-adapter-internal): the runner and other
 * adapters never see it. Wiring it into the reviewer fan-out (with prose repair demoted to a
 * fallback) is S03 (#126); the coordinator variant is S04 (#127).
 *
 * Trust note (#31/#32): `validateFinding` deliberately DROPS any model-emitted `id`. Pi output is
 * untrusted, and `assignStableFindingIds` resolves identity with `finding.id ?? hash`; a
 * passed-through id would win and could match a spoofed reviewer's hash. Dropping it here keeps the
 * factory-computed stable id authoritative for the structured path too. Do not reinstate the id.
 */

import type { Finding } from "../contracts/index.ts";

/** Name of the factory-owned terminal tool the reviewer calls to deliver findings (S01, #124). */
export const SUBMIT_FINDINGS_TOOL_NAME = "submit_findings";

/** Result of scanning an event stream for a tool call's validated arguments. */
export type StructuredToolArgs =
  | { readonly status: "found"; readonly args: unknown }
  | { readonly status: "absent" };

/**
 * Pull the arguments of the first `tool_execution_start` event for `toolName` from a Pi `--mode
 * json` event stream. First-wins: with `terminate: true` the tool is called at most once, but if a
 * model ever calls it twice we keep the first call so the consumed payload is deterministic.
 * Returns `{ status: "absent" }` when the tool was never called, so callers fall back to the prose
 * parse rather than failing. Non-object events and events missing `type`/`toolName` are ignored.
 */
export function readToolCallArgs(events: readonly unknown[], toolName: string): StructuredToolArgs {
  for (const event of events) {
    if (!isRecord(event)) {
      continue;
    }
    if (event.type === "tool_execution_start" && event.toolName === toolName) {
      return { status: "found", args: event.args };
    }
  }

  return { status: "absent" };
}

/**
 * Validate `submit_findings` tool arguments into `Finding[]`. Mirrors `parseReviewerOutput`'s
 * post-parse logic exactly (same `validateFinding` per item), minus the JSON parsing/repair the
 * structured path no longer needs. Throws when `args` is not an object or `args.findings` is not an
 * array, or when any finding fails validation — letting the caller fall back / classify the failure
 * just as the prose path does.
 */
export function parseReviewerToolArgs(args: unknown): Finding[] {
  const findings = getRecord(args).findings;
  if (!Array.isArray(findings)) {
    throw new Error("submit_findings tool arguments did not contain a findings array");
  }

  return findings.map((finding) => validateFinding(finding));
}

// ── Shared finding validation (moved verbatim from pi-agent-runtime.ts; the prose path imports
// `validateFinding` + `getRecord` from here so both delivery paths validate identically). ────────

export function getRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }

  return value as Record<string, unknown>;
}

export function validateFinding(value: unknown): Finding {
  const finding = getRecord(value);
  const evidence = normalizeEvidence(finding.evidence);
  const quotedCode = normalizeQuotedCode(finding.quotedCode);
  if (
    typeof finding.reviewer !== "string" ||
    !isSeverity(finding.severity) ||
    typeof finding.category !== "string" ||
    typeof finding.title !== "string" ||
    typeof finding.body !== "string" ||
    !isConfidence(finding.confidence) ||
    evidence === undefined ||
    typeof finding.recommendation !== "string"
  ) {
    throw new Error("Pi reviewer output contained an invalid finding");
  }

  // A model-emitted `id` is never honored: Pi output is untrusted, and
  // assignStableFindingIds resolves identity with `finding.id ?? hash`, so a
  // passed-through id would win and could carry a value matching a *spoofed*
  // reviewer's hash (re-opening the #31 corruption #32 closes). Dropping it here
  // — the single chokepoint for all Pi findings — keeps the factory-computed
  // stable id authoritative for both specialist and coordinator output.
  return {
    reviewer: finding.reviewer,
    severity: finding.severity,
    category: finding.category,
    title: finding.title,
    body: finding.body,
    ...(isValidFindingLocation(finding.location) ? { location: finding.location } : {}),
    confidence: finding.confidence,
    evidence,
    ...(quotedCode !== undefined ? { quotedCode } : {}),
    recommendation: finding.recommendation,
  };
}

// `evidence` is a required string array on a Finding. We tolerate a missing field (undefined ->
// []) and a bare string (-> [string]) because models legitimately emit those shapes, but any other
// non-string-array value — `null`, a number, an object, a mixed array — returns `undefined`, which
// `validateFinding` treats as REJECTION (the finding fails validation). This INTENTIONAL
// reject-don't-coerce choice was raised and DECLINED in the S02 review (#125): coercing `null` to
// `[]` would silently accept malformed model output for a required field, so it stays rejected.
// Documented here (per #159) so the decision is visible as diff context and not re-litigated.
function normalizeEvidence(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }

  return undefined;
}

// A model may emit a `location` object missing a string `path` (or with a non-string path).
// Honoring it would crash stable-id computation (`normalizePath` -> `path.trim()`). Untrusted
// model output is validated here (principle #6), so require a string `path` before passing it
// through; otherwise drop the location and keep the finding.
function isValidFindingLocation(value: unknown): value is NonNullable<Finding["location"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).path === "string"
  );
}

function normalizeQuotedCode(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : undefined;
  }

  if (Array.isArray(value)) {
    // Trim kept entries so both branches store canonically-trimmed strings (the future #54.2
    // grounding step matches these against diff lines; padded entries would fail that match).
    const trimmed = value.flatMap((item) =>
      typeof item === "string" && item.trim().length > 0 ? [item.trim()] : [],
    );
    return trimmed.length > 0 ? trimmed : undefined;
  }

  return undefined;
}

function isSeverity(value: unknown): value is Finding["severity"] {
  return value === "critical" || value === "warning" || value === "suggestion";
}

function isConfidence(value: unknown): value is Finding["confidence"] {
  return value === "high" || value === "medium" || value === "low";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
