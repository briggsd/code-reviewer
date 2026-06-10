import { createHash } from "node:crypto";
import type { Finding, FindingLocation, ReviewSummary } from "../contracts/index.ts";

export function assignStableFindingIds(summary: ReviewSummary): ReviewSummary {
  // Identity is keyed only on reviewer+category+location (see
  // createStableFindingId), so two distinct findings that share those signals
  // collapse to the same base ID. re-review.ts indexes current findings in a
  // Map by ID, where a duplicate key would silently drop one finding from
  // recurrence/fixed classification. We disambiguate collisions with an ordinal
  // suffix (`#2`, `#3`, …).
  //
  // Two properties matter for that ordinal:
  //  1. It must never duplicate an ID a runtime/adapter already supplied, so we
  //     reserve every pre-assigned ID up front and allocate around them.
  //  2. It is assigned in a deterministic *content* order, NOT the order the
  //     model emitted findings — so the same set of findings always yields the
  //     same IDs, and an unchanged diff re-reviewed classifies as recurring
  //     regardless of how the model happened to order its output.
  //
  // Known limitation: if a colliding sibling is later added or removed, the
  // ordinals of the remaining siblings can shift. We accept this — two findings
  // identical on every stable signal cannot be told apart run-to-run without
  // their volatile prose, and the ordinal exists only to guarantee
  // within-summary uniqueness for the re-review index.
  const used = new Set<string>();
  for (const finding of summary.findings) {
    if (hasAssignedId(finding)) {
      used.add(finding.id);
    }
  }

  const collisionGroups = new Map<string, number[]>();
  summary.findings.forEach((finding, index) => {
    if (hasAssignedId(finding)) {
      return;
    }

    const baseId = createStableFindingId(finding);
    const group = collisionGroups.get(baseId);
    if (group === undefined) {
      collisionGroups.set(baseId, [index]);
    } else {
      group.push(index);
    }
  });

  const generatedIdByIndex = new Map<number, string>();
  for (const [baseId, indices] of collisionGroups) {
    const ordered = indices
      .map((index) => ({ index, key: collisionSortKey(summary.findings[index] as Finding) }))
      .sort((a, b) => a.key.localeCompare(b.key) || a.index - b.index);
    ordered.forEach(({ index }, rank) => {
      generatedIdByIndex.set(index, allocateFindingId(baseId, rank, used));
    });
  }

  return {
    ...summary,
    findings: summary.findings.map((finding, index) =>
      hasAssignedId(finding) ? finding : { ...finding, id: generatedIdByIndex.get(index) as string },
    ),
  };
}

function hasAssignedId(finding: Finding): finding is Finding & { id: string } {
  return finding.id !== undefined && finding.id.length > 0;
}

// Tie-breaker ordering for findings that collide on the same base ID. Title and
// body are used ONLY to order siblings deterministically — they are not part of
// the identity hash, so reworded prose still maps to the same base ID.
function collisionSortKey(finding: Finding): string {
  return JSON.stringify([finding.severity, normalizeText(finding.title), normalizeText(finding.body)]);
}

// First member of a collision group keeps the bare base ID; subsequent members
// get `#2`, `#3`, …, skipping any value already reserved by a pre-assigned ID.
function allocateFindingId(baseId: string, rank: number, used: Set<string>): string {
  let ordinal = rank;
  let candidate = ordinal === 0 ? baseId : `${baseId}#${ordinal + 1}`;
  while (used.has(candidate)) {
    ordinal += 1;
    candidate = `${baseId}#${ordinal + 1}`;
  }
  used.add(candidate);

  return candidate;
}

// Stable finding identity is keyed ONLY on low-entropy, run-stable signals:
// reviewer role, category, and normalized location. `title`/`body` are
// model-authored free text — the LLM rewords them on every run, so including
// them in the hash produced a fresh ID per run and silently defeated
// recurring-finding suppression (the same unfixed finding read as new + the
// prior one as fixed). See issue #31. Title/body are intentionally NOT part of
// the identity; if richer disambiguation is ever needed it must be an explicit
// fuzzy tie-breaker, not part of this hash.
//
// Fields are JSON-encoded (not joined on a separator) so a value containing the
// separator character can't shift the field boundaries and forge another
// finding's preimage — relevant now that the key space is small and the fields
// (path, reviewer, category) can carry adversarial repo-controlled content.
export function createStableFindingId(finding: Finding): string {
  const input = JSON.stringify([
    normalizeText(String(finding.reviewer)),
    normalizeText(finding.category),
    normalizeLocation(finding.location),
  ]);
  const hash = createHash("sha256").update(input).digest("hex").slice(0, 16);

  return `fnd_${hash}`;
}

function normalizeLocation(location: FindingLocation | undefined): string {
  if (location === undefined) {
    return "unknown-location";
  }

  const line = location.line ?? location.startLine ?? "unknown-line";
  const endLine = location.endLine ?? line;
  const side = location.side ?? "unknown-side";

  return [
    normalizePath(location.path),
    String(line),
    String(endLine),
    side,
  ].join(":");
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

function normalizePath(path: string): string {
  return path.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}
