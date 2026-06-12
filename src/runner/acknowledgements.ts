import type { Acknowledgement, Finding } from "../contracts/index.ts";
import { matchesGlob } from "./path-match.ts";

export interface AcknowledgementResult {
  findings: Finding[]; // acknowledged ones annotated + kept; suppressed ones removed; order preserved
  acknowledgedCount: number;
  suppressedCount: number;
}

/**
 * Apply base-branch acknowledgements to findings (#60-P3b).
 *
 * - acknowledge (safe default): finding is kept + annotated; excluded from gate.
 * - suppress: finding is removed — UNLESS reviewer === "security", which is downgraded to
 *   acknowledge (never silently hide a security finding from a project-config suppression).
 * - An ack whose `expires` (YYYY-MM-DD) is strictly before `todayStr` is inactive (ignored).
 *
 * Pure: no I/O, no mutation of inputs.
 */
export function applyAcknowledgements(
  findings: readonly Finding[],
  acknowledgements: readonly Acknowledgement[],
  now: Date,
): AcknowledgementResult {
  const todayStr = now.toISOString().slice(0, 10);

  const activeAcks = acknowledgements.filter(
    (ack) => ack.expires === undefined || ack.expires >= todayStr,
  );

  const result: Finding[] = [];
  let acknowledgedCount = 0;
  let suppressedCount = 0;

  for (const finding of findings) {
    const matchedAck = activeAcks.find((ack) => matchesAck(finding, ack));

    if (matchedAck === undefined) {
      result.push(finding);
      continue;
    }

    // Security guard: suppress on a security finding is downgraded to acknowledge
    const effectiveMode: "acknowledge" | "suppress" =
      matchedAck.mode === "suppress" && finding.reviewer === "security"
        ? "acknowledge"
        : matchedAck.mode;

    if (effectiveMode === "acknowledge") {
      result.push({ ...finding, acknowledged: { reason: matchedAck.reason } });
      acknowledgedCount += 1;
    } else {
      // suppress: drop the finding entirely
      suppressedCount += 1;
    }
  }

  return { findings: result, acknowledgedCount, suppressedCount };
}

function matchesAck(finding: Finding, ack: Acknowledgement): boolean {
  // path is required on an ack
  if (!matchesGlob(finding.location?.path ?? "", ack.path)) {
    return false;
  }

  // category: if specified, must equal finding.category
  if (ack.category !== undefined && ack.category !== finding.category) {
    return false;
  }

  // stableFindingId: if specified, must equal finding.id
  if (ack.stableFindingId !== undefined && ack.stableFindingId !== finding.id) {
    return false;
  }

  return true;
}
