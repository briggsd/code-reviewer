import type { Finding, ReviewDecision, ReviewSummary } from "../contracts/index.ts";
import { escapeMarkdown } from "./markdown-escape.ts";

export interface SummaryMarkdownOptions {
  includeHiddenMetadata?: boolean;
  hiddenMetadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Reviewer ordering & emoji
// ---------------------------------------------------------------------------

const REVIEWER_ORDER: string[] = ["security", "code_quality", "documentation"];

const REVIEWER_EMOJI: Record<string, string> = {
  security: "🔒",
  code_quality: "🧹",
  documentation: "📚",
};

function reviewerEmoji(reviewer: string): string {
  return REVIEWER_EMOJI[reviewer] ?? "🔍";
}

function sortedReviewerKeys(findings: Finding[]): string[] {
  const keys = [...new Set(findings.map((f) => f.reviewer))];
  return keys.sort((a, b) => {
    const ai = REVIEWER_ORDER.indexOf(a);
    const bi = REVIEWER_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Severity ordering & badges
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = { critical: 0, warning: 1, suggestion: 2 };

function severityEmoji(severity: string): string {
  if (severity === "critical") return "🔴";
  if (severity === "warning") return "⚠️";
  return "💬";
}

function severityPlural(severity: string, count: number): string {
  if (severity === "critical") return count === 1 ? "critical" : "criticals";
  if (severity === "warning") return count === 1 ? "warning" : "warnings";
  return count === 1 ? "suggestion" : "suggestions";
}

function sortFindingsBySeverity(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const ai = SEVERITY_ORDER[a.severity] ?? 99;
    const bi = SEVERITY_ORDER[b.severity] ?? 99;
    return ai - bi;
  });
}

// ---------------------------------------------------------------------------
// Severity badge for group header
// ---------------------------------------------------------------------------

function severityBadge(findings: Finding[]): string {
  const counts: Record<string, number> = {};
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  }
  const parts: string[] = [];
  for (const sev of ["critical", "warning", "suggestion"] as const) {
    const count = counts[sev];
    if (count !== undefined && count > 0) {
      parts.push(`${severityEmoji(sev)} ${count} ${severityPlural(sev, count)}`);
    }
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Recommendation tier from max severity
// ---------------------------------------------------------------------------

function recommendationTier(findings: Finding[]): string {
  for (const sev of ["critical", "warning", "suggestion"] as const) {
    if (findings.some((f) => f.severity === sev)) {
      if (sev === "critical") return "🔴 Major Comments";
      if (sev === "warning") return "⚠️ Minor Comments";
      return "💬 Optional Nits";
    }
  }
  return "💬 Optional Nits";
}

// ---------------------------------------------------------------------------
// Decision headline
// ---------------------------------------------------------------------------

function decisionHeadline(decision: ReviewDecision): string {
  const labels: Record<ReviewDecision, string> = {
    approved: "✅ Approved",
    approved_with_comments: "✅ Approved with comments",
    minor_issues: "🟡 Minor issues",
    significant_concerns: "🔴 Significant concerns",
    review_failed: "⚠️ Review failed",
  };
  // decision is a closed contract type populated by deterministic runner logic; the
  // fallback is defense-in-depth for values arriving via deserialization/casts.
  return labels[decision] ?? `⚠️ ${escapeMarkdown(decision)}`;
}

// ---------------------------------------------------------------------------
// Location formatting (unchanged behavior)
// ---------------------------------------------------------------------------

function formatLocation(finding: Finding): string {
  if (finding.location === undefined) {
    return "";
  }

  // path comes from the diff/VCS response — treat as untrusted text and escape it (#74).
  // Line numbers are numeric — no escaping needed.
  const { path, line, startLine, endLine } = finding.location;
  const escapedPath = escapeMarkdown(path);
  if (line !== undefined) {
    return ` (${escapedPath}:${line})`;
  }

  if (startLine !== undefined && endLine !== undefined) {
    return ` (${escapedPath}:${startLine}-${endLine})`;
  }

  return ` (${escapedPath})`;
}

// ---------------------------------------------------------------------------
// Per-finding detail block (inside <details>)
// Drops the "Reviewer:" line (group heading already says it).
// ---------------------------------------------------------------------------

function formatFindingDetail(finding: Finding): string {
  const location = formatLocation(finding);
  const acknowledgedSuffix =
    finding.acknowledged !== undefined
      ? ` — _acknowledged: ${escapeMarkdown(finding.acknowledged.reason)}_`
      : "";

  const lines = [
    `- **${finding.severity.toUpperCase()}: ${escapeMarkdown(finding.title)}**${location}${acknowledgedSuffix}`,
    `  - Category: \`${finding.category}\``,
    `  - Confidence: \`${finding.confidence}\``,
    `  - Why it matters: ${escapeMarkdown(finding.body)}`,
    `  - Recommendation: ${escapeMarkdown(finding.recommendation)}`,
  ];

  if (finding.evidence.length > 0) {
    lines.push(`  - Evidence: ${finding.evidence.map((e) => escapeMarkdown(e)).join("; ")}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// One-line bullet (above the fold)
// Trim raw recommendation FIRST, then escape — so ellipsis cannot split an
// escape sequence. (#74 discipline)
// ---------------------------------------------------------------------------

function formatOneLiner(finding: Finding): string {
  const location = formatLocation(finding);
  const acknowledgedSuffix =
    finding.acknowledged !== undefined
      ? ` — _acknowledged: ${escapeMarkdown(finding.acknowledged.reason)}_`
      : "";

  const rawRec = finding.recommendation;
  const trimmedRec = rawRec.length > 120 ? `${rawRec.slice(0, 120)}…` : rawRec;
  const escapedRec = escapeMarkdown(trimmedRec);

  return `- **${finding.severity.toUpperCase()}: ${escapeMarkdown(finding.title)}**${location}${acknowledgedSuffix} — ${escapedRec}`;
}

// ---------------------------------------------------------------------------
// Reviewer group block
// ---------------------------------------------------------------------------

function formatReviewerGroup(reviewer: string, findings: Finding[]): string[] {
  const sorted = sortFindingsBySeverity(findings);
  const badge = severityBadge(sorted);
  const rec = recommendationTier(sorted);
  const emoji = reviewerEmoji(reviewer);

  const lines: string[] = [
    "---",
    // reviewer is MODEL-AUTHORED free text (validateFinding accepts any string, unknown
    // roles are supported) — at heading level a backtick would break out of a code span,
    // so escape it in plain context instead (#74; escapes don't render inside code spans).
    // Newlines collapse to a space first: a raw newline would terminate the heading and
    // open an attacker-controlled block (escapeMarkdown deliberately preserves newlines
    // for multi-line body slots; a heading is a single-line slot).
    `### ${emoji} ${escapeMarkdown(reviewer.replace(/[\r\n]+/g, " "))} — ${badge} — Recommendation: ${rec}`,
    "",
  ];

  // One-line bullets (above the fold)
  for (const finding of sorted) {
    lines.push(formatOneLiner(finding));
  }

  // Progressive disclosure: full details inside <details>
  // IMPORTANT: blank line after </summary> and around inner markdown for GitHub/GitLab
  // rendering — and a blank line BEFORE <details> so CommonMark-strict parsers (GitLab)
  // don't absorb the tag into the preceding list.
  lines.push("");
  lines.push(
    `<details><summary>View full review (${sorted.length} finding${sorted.length === 1 ? "" : "s"})</summary>`,
  );
  lines.push("");
  for (const finding of sorted) {
    lines.push(formatFindingDetail(finding));
    lines.push("");
  }
  lines.push("</details>");
  lines.push("");

  return lines;
}

// ---------------------------------------------------------------------------
// Partial-by-size block (#145)
// ---------------------------------------------------------------------------

/** Maximum number of dropped-file paths to render before adding "…and N more". */
const PARTIAL_SIZE_PATH_CAP = 20;

/**
 * Format a byte count in SI units (KB = 1000 bytes, MB = 1_000_000) so the rendered
 * value matches the round numbers the `patchBudgets` defaults and docs use (e.g. 64_000 →
 * "64 KB", 4_000_000 → "4 MB"). Binary KiB (÷1024) would render "63 KB" for a 64 KB budget.
 */
function formatSiBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${Math.round(bytes / 100_000) / 10} MB`;
  }
  return `${Math.round(bytes / 1000)} KB`;
}

function formatPartialBySize(partialBySize: NonNullable<ReviewSummary["partialBySize"]>): string[] {
  const { admittedFileCount, droppedFileCount, admittedBytes, budgetBytes, droppedPaths } =
    partialBySize;
  const totalFileCount = admittedFileCount + droppedFileCount;

  const lines: string[] = [
    "---",
    "",
    `> ⚠️ **Partial review by size** — ${admittedFileCount} of ${totalFileCount} changed files were fully included (admitted ${formatSiBytes(admittedBytes)} of ${formatSiBytes(budgetBytes)} budget). The following files changed but were reviewed by name only (patch not included):`,
    "",
  ];

  const capped = droppedPaths.slice(0, PARTIAL_SIZE_PATH_CAP);
  const overflow = droppedPaths.length - capped.length;
  for (const path of capped) {
    lines.push(`- ${escapeMarkdown(path)}`);
  }
  if (overflow > 0) {
    lines.push(`- …and ${overflow} more`);
  }
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Degraded-review banner (#212)
// ---------------------------------------------------------------------------

function formatDegradedBanner(degraded: NonNullable<ReviewSummary["degraded"]>): string[] {
  const { failedReviewerCount, completedReviewerCount, failedRoles } = degraded;
  const totalAttempted = failedReviewerCount + completedReviewerCount;
  // Roles are MODEL-AUTHORED free text → strip CR/LF first (heading discipline, #74) then escape
  const escapedRoles = failedRoles
    .map((role) => escapeMarkdown(role.replace(/[\r\n]+/g, " ")))
    .join(", ");
  return [
    "",
    `> ⚠️ **Degraded review — ${failedReviewerCount} of ${totalAttempted} reviewers failed.** Findings below are from the surviving reviewer(s) only and may be incomplete. Failed: ${escapedRoles}.`,
    "",
  ];
}

// ---------------------------------------------------------------------------
// Low-confidence (grounding-demoted) block (#204, #207)
// ---------------------------------------------------------------------------

function formatWithheldGroup(findings: Finding[]): string[] {
  const sorted = sortFindingsBySeverity(findings);
  const lines: string[] = [
    "---",
    "",
    "### ⚠️ Low-confidence findings (kept, non-blocking)",
    "",
    "_Shown at low confidence: cited code was not found in the changed hunks. Excluded from the gate / not counted toward the result._",
    "",
  ];
  for (const finding of sorted) {
    lines.push(formatOneLiner(finding));
  }
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Break-glass footer (#22-P1)
// ---------------------------------------------------------------------------

// Absolute URL on purpose: PR/MR comments resolve relative hrefs against the comment
// page URL (404), and the doc lives in the FACTORY repo — a reviewed consumer repo has
// no docs/architecture.md (verified against the rendered bodyHTML of PR #110's comment).
const BREAK_GLASS_DOC_URL =
  "https://github.com/briggsd/ai-code-review-factory/blob/main/docs/architecture.md#break-glass--human-override";

const BREAK_GLASS_FOOTER = `<details><summary>🔓 Break glass — need to merge anyway?</summary>

A repo admin can override the required CI check — that is the supported break-glass
path (admin-only; not yet recorded as a review-level event). See
[Break-glass / human override](${BREAK_GLASS_DOC_URL}).
</details>`;

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function formatReviewSummaryMarkdown(
  summary: ReviewSummary,
  options: SummaryMarkdownOptions = {},
): string {
  const lines: string[] = [
    `## ${summary.title}`,
    "",
    `${decisionHeadline(summary.decision)} — Risk tier \`${summary.risk.tier}\` · CI \`${summary.outcome}\``,
    "",
  ];
  // Comprehension-gate verdict (#26): one line, present only when the opt-in reviewer ran.
  // gateDecision is a closed enum populated by deterministic runner logic — render it in a code
  // span unescaped, matching tier/outcome/decision (escaping inside a code span renders literally).
  if (summary.gateDecision !== undefined) {
    lines.push(`🚦 Comprehension gate: \`${summary.gateDecision}\``, "");
  }
  lines.push(summary.body, "");

  // Degraded-review banner (#212): rendered above the fold, before reviewer groups, so a
  // near-empty review can't read as clean. Only when at least one reviewer failed.
  if (summary.degraded !== undefined) {
    for (const line of formatDegradedBanner(summary.degraded)) {
      lines.push(line);
    }
  }

  // Reviewer groups (or "No findings." / "No blocking findings (see low-confidence block below).")
  if (summary.findings.length === 0) {
    const hasWithheld = (summary.groundingWithheld?.length ?? 0) > 0;
    lines.push(
      hasWithheld ? "No blocking findings (see low-confidence block below)." : "No findings.",
    );
    lines.push("");
  } else {
    const reviewerKeys = sortedReviewerKeys(summary.findings);
    for (const reviewer of reviewerKeys) {
      const group = summary.findings.filter((f) => f.reviewer === reviewer);
      for (const line of formatReviewerGroup(reviewer, group)) {
        lines.push(line);
      }
    }
  }

  // Withheld (grounding-dropped) block (#204)
  if (summary.groundingWithheld !== undefined && summary.groundingWithheld.length > 0) {
    for (const line of formatWithheldGroup(summary.groundingWithheld)) {
      lines.push(line);
    }
  }

  // Partial-by-size block (#145): present only when the admission gate degraded.
  if (summary.partialBySize !== undefined) {
    for (const line of formatPartialBySize(summary.partialBySize)) {
      lines.push(line);
    }
  }

  // Re-review status section — exact heading + bullet format unchanged
  if (summary.reReview !== undefined) {
    lines.push("### Re-review status");
    lines.push("");
    lines.push(`- New findings: ${summary.reReview.newFindingIds.length}`);
    lines.push(`- Recurring findings: ${summary.reReview.recurringFindingIds.length}`);
    lines.push(`- Fixed prior findings: ${summary.reReview.fixedFindingIds.length}`);
    if (summary.reReview.fixedFindingIds.length > 0) {
      lines.push(
        `- Fixed IDs: ${summary.reReview.fixedFindingIds.map((id) => `\`${id}\``).join(", ")}`,
      );
    }
    lines.push(`- Withheld prior findings: ${summary.reReview.withheldFindingIds.length}`);
    if (summary.reReview.withheldFindingIds.length > 0) {
      lines.push(
        `- Withheld IDs: ${summary.reReview.withheldFindingIds.map((id) => `\`${id}\``).join(", ")}`,
      );
    }
    if (summary.reReview.carriedForwardFindingIds.length > 0) {
      lines.push(
        `- Carried forward (not re-reviewed this push): ${summary.reReview.carriedForwardFindingIds.length}`,
      );
      // Collect known paths from classifications with status "carried_forward".
      const carriedPaths = summary.reReview.classifications
        .filter(
          (c) => c.status === "carried_forward" && c.priorFinding?.location?.path !== undefined,
        )
        .map((c) => c.priorFinding?.location?.path as string);
      const uniqueSortedPaths = [...new Set(carriedPaths)].sort();
      for (const path of uniqueSortedPaths) {
        lines.push(`  - ${escapeMarkdown(path)}`);
      }
    }
    lines.push("");
  }

  // Break-glass footer (always, before the generated-by line)
  lines.push(BREAK_GLASS_FOOTER);
  lines.push("");
  lines.push("_Generated by ai-code-review-factory._");

  // Hidden metadata (last, gated)
  if (options.includeHiddenMetadata === true) {
    lines.push("");
    lines.push("<!-- ai-code-review-factory");
    lines.push(JSON.stringify(options.hiddenMetadata ?? {}, null, 2));
    lines.push("-->");
  }

  return lines.join("\n").trimEnd();
}
