import type { Finding, ReviewDecision, ReviewSummary, Severity } from "../contracts/index.ts";
import { assertNever } from "../contracts/index.ts";
import { deriveDisposition } from "../runner/finding-disposition.ts";
import { codeSpan, type EscapedString, escapeMarkdown } from "./markdown-escape.ts";

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

function severityEmoji(severity: Severity): string {
  switch (severity) {
    case "critical":
      return "🔴";
    case "warning":
      return "⚠️";
    case "suggestion":
      return "💬";
    default:
      // Exhaustiveness guard: a new Severity member added without a matching case here
      // becomes a compile error (TypeScript narrows to never).
      return assertNever(severity, "Severity");
  }
}

function severityPlural(severity: Severity, count: number): string {
  switch (severity) {
    case "critical":
      return count === 1 ? "critical" : "criticals";
    case "warning":
      return count === 1 ? "warning" : "warnings";
    case "suggestion":
      return count === 1 ? "suggestion" : "suggestions";
    default:
      return assertNever(severity, "Severity");
  }
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
      // Exhaustiveness guard: each Severity member is handled; new members require a
      // matching case or the switch becomes a compile error.
      switch (sev) {
        case "critical":
          return "🔴 Address before merge";
        case "warning":
          return "⚠️ Worth addressing";
        case "suggestion":
          return "💬 Optional";
        default:
          return assertNever(sev, "Severity");
      }
    }
  }
  return "💬 Optional";
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
// Dismiss-this-finding block: paste-ready ack snippet (#159)
//
// Rendered inside a collapsed <details> so it adds zero above-the-fold noise.
// Skipped when: the finding has no location.path (an ack requires a path) OR
// the finding is already acknowledged (no point offering to dismiss again).
//
// Markdown safety: the JSON goes inside a fenced code block, so we do NOT
// run values through escapeMarkdown (it backslash-escapes backticks, which
// corrupts JSON inside a fence). JSON.stringify handles quotes/backslashes/
// control-chars in path/category/id. We also guard against code-fence
// breakout: a value containing a run of backticks could prematurely close the
// fence, so we size the fence to exceed the longest backtick run in the
// serialized JSON (CommonMark: a fenced block closes only on a fence of ≥ its
// own length). path is repo-controlled — this guard matters (#74 discipline).
// ---------------------------------------------------------------------------

function buildDismissBlock(finding: Finding): string | null {
  // Skip: no path (ack requires path) or already acknowledged.
  if (finding.location?.path === undefined || finding.acknowledged !== undefined) {
    return null;
  }

  // Build the ack object. stableFindingId is included only when id is a non-empty string.
  const ackObj: Record<string, string> = {
    path: finding.location.path,
    category: finding.category,
    ...(typeof finding.id === "string" && finding.id.length > 0
      ? { stableFindingId: finding.id }
      : {}),
    mode: "acknowledge",
    // Model the verdict field in the template (#256) so the snippet matches the prose below:
    // "acknowledged" = accepted-as-is (default); change to "dismissed" to record a rejection.
    verdict: "acknowledged",
    reason: "<why this is intentional>",
  };

  const serialized = JSON.stringify(ackObj, null, 2);

  // Compute fence length: must exceed the longest contiguous backtick run in the
  // serialized JSON so the fence is never prematurely closed (CommonMark §4.5).
  const backtickRuns = serialized.match(/`+/g) ?? [];
  const maxRun = backtickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, maxRun + 1));

  return [
    `<details><summary>Acknowledge / dismiss this finding</summary>`,
    ``,
    `Add this entry to the \`acknowledgements\` array in \`.ai-review.json\` and commit it to the **base branch**.`,
    `With \`mode: "acknowledge"\` the finding stays visible in the summary (annotated with your reason) but no`,
    `longer blocks CI; change \`mode\` to \`"suppress"\` to hide it entirely (security-reviewer findings are`,
    `downgraded to \`acknowledge\` regardless). Add an optional \`"expires": "YYYY-MM-DD"\` field to make the`,
    `acknowledgement lapse automatically. To record that you are explicitly **rejecting** this finding`,
    `(wrong call or won't-fix), add \`"verdict": "dismissed"\` alongside \`mode\` — omitting \`verdict\` defaults`,
    `to \`"acknowledged"\` (accepted-as-is). A \`"dismissed"\` finding renders as \`✗ dismissed: <reason>\` in`,
    `the next review comment (vs \`acknowledged: <reason>\`), and the verdict feeds re-review precision metrics.`,
    ``,
    `${fence}json`,
    serialized,
    `${fence}`,
    ``,
    `</details>`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Verdict-aware acknowledged suffix (#280)
//
// A finding dismissed via verdict: "dismissed" (an ack whose verdict field is
// "dismissed") is currently mislabeled as "acknowledged" because the same
// `finding.acknowledged` field is set in both cases.  This helper reads the
// verdict so dismissed findings render a distinct `✗ dismissed: <reason>`
// suffix while normal acknowledged findings keep the existing label.
//
// Shared by both `formatFindingDetail` and `formatOneLiner` to prevent drift.
// ---------------------------------------------------------------------------

function formatAcknowledgedSuffix(finding: Finding): string {
  if (finding.acknowledged === undefined) return "";
  const { reason, verdict } = finding.acknowledged;
  if (verdict === "dismissed") {
    return ` — _✗ dismissed: ${escapeMarkdown(reason)}_`;
  }
  return ` — _acknowledged: ${escapeMarkdown(reason)}_`;
}

// ---------------------------------------------------------------------------
// Per-finding detail block (inside <details>)
// Drops the "Reviewer:" line (group heading already says it).
// ---------------------------------------------------------------------------

function formatFindingDetail(finding: Finding): string {
  const location = formatLocation(finding);
  const acknowledgedSuffix = formatAcknowledgedSuffix(finding);

  const lines = [
    `- **${finding.severity.toUpperCase()}: ${escapeMarkdown(finding.title)}**${location}${acknowledgedSuffix}`,
    `  - Category: ${codeSpan(finding.category)}`,
    `  - Confidence: ${codeSpan(finding.confidence)}`,
    `  - Why it matters: ${escapeMarkdown(finding.body)}`,
    `  - Recommendation: ${escapeMarkdown(finding.recommendation)}`,
  ];

  if (finding.evidence.length > 0) {
    lines.push(`  - Evidence: ${finding.evidence.map((e) => escapeMarkdown(e)).join("; ")}`);
  }

  const dismissBlock = buildDismissBlock(finding);
  if (dismissBlock !== null) {
    lines.push(``, dismissBlock);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// One-line bullet (above the fold)
// Trim raw recommendation FIRST, then escape — so ellipsis cannot split an
// escape sequence. (#74 discipline)
// ---------------------------------------------------------------------------

/**
 * Low-level bullet assembler. Parameters that carry untrusted LLM text are typed
 * `EscapedString` so the TypeScript compiler rejects a raw `string` in those slots —
 * the caller must route untrusted values through `escapeMarkdown` or `codeSpan` first.
 * `location` and `suffix` are pre-composed safe strings assembled by this module.
 */
function buildOneLinerBullet(
  severity: string,
  title: EscapedString,
  location: string,
  suffix: string,
  recommendation: EscapedString,
): string {
  return `- **${severity}: ${title}**${location}${suffix} — ${recommendation}`;
}

function formatOneLiner(finding: Finding): string {
  const location = formatLocation(finding);
  const acknowledgedSuffix = formatAcknowledgedSuffix(finding);

  const rawRec = finding.recommendation;
  const trimmedRec = rawRec.length > 120 ? `${rawRec.slice(0, 120)}…` : rawRec;
  const escapedRec = escapeMarkdown(trimmedRec);

  return buildOneLinerBullet(
    finding.severity.toUpperCase(),
    escapeMarkdown(finding.title),
    location,
    acknowledgedSuffix,
    escapedRec,
  );
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
    "_Shown at low confidence: cited code was not found in the changed-file grounding corpus. Excluded from the gate / not counted toward the result._",
    "",
  ];
  for (const finding of sorted) {
    lines.push(formatOneLiner(finding));
  }
  lines.push("");
  return lines;
}

// ---------------------------------------------------------------------------
// Run-stats helpers (#285)
// ---------------------------------------------------------------------------

/**
 * Format a token count as a compact human-readable string: bare integer under 1000,
 * "47.2k" style for thousands, "1.2M" style for millions. No rounding surprises for
 * exact thousands (e.g. 1000 → "1k", 1_000_000 → "1M").
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    const rounded = Math.round(m * 10) / 10;
    return `${rounded}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    const rounded = Math.round(k * 10) / 10;
    // Guard: rounding at the boundary (e.g. 999_950 → 1000k) — promote to "1M".
    if (rounded >= 1000) return "1M";
    return `${rounded}k`;
  }
  return `${tokens}`;
}

/**
 * Low-activity warning (#285): shown near the top when runStats is present, tier is NOT
 * "trivial", and modelTokenTotal is 0. Gates on tokens (not duration) — a legitimate
 * trivial diff is fast (#65) but a real review consumes model tokens.
 */
function formatLowActivityWarning(runStats: NonNullable<ReviewSummary["runStats"]>): string[] {
  if (runStats.tier === "trivial" || runStats.modelTokenTotal !== 0) return [];
  return [
    "> ⚠️ **Low model activity** — this review consumed ~0 model tokens and may not have actually run. Verify before trusting the verdict (e.g. a provider/model API outage).",
    "",
  ];
}

// ---------------------------------------------------------------------------
// Break-glass footer (#22-P1)
// ---------------------------------------------------------------------------

// Absolute URL on purpose: PR/MR comments resolve relative hrefs against the comment
// page URL (404), and the doc lives in the FACTORY repo — a reviewed consumer repo has
// no docs/developer/architecture.md (verified against the rendered bodyHTML of PR #110's comment).
const BREAK_GLASS_DOC_URL =
  "https://github.com/briggsd/code-reviewer/blob/main/docs/developer/architecture.md#break-glass--human-override";

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
  // Low-activity warning (#285): inserted right after the decision headline / risk line and
  // before findings — most visible above-the-fold position. Only when runStats is present,
  // tier is NOT trivial, and modelTokenTotal is 0.
  if (summary.runStats !== undefined) {
    for (const line of formatLowActivityWarning(summary.runStats)) {
      lines.push(line);
    }
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
    // Derive fixed/withheld detail rows and counts from the same source (classifications)
    // so count and detail rows cannot diverge (#289). If fixedFindingIds has an entry with
    // no matching classification record, we still emit a fallback row keyed by stable ID —
    // guaranteeing count N ⇒ exactly N detail rows.
    const fixedClassifications = summary.reReview.classifications.filter(
      (c) => c.status === "fixed",
    );
    const withheldClassifications = summary.reReview.classifications.filter(
      (c) => c.status === "withheld",
    );
    // IDs present in fixedFindingIds but absent from classifications (mismatch fallback).
    const fixedClassifiedIds = new Set(fixedClassifications.map((c) => c.stableId));
    const withheldClassifiedIds = new Set(withheldClassifications.map((c) => c.stableId));
    const fixedOrphanIds = summary.reReview.fixedFindingIds.filter(
      (id) => !fixedClassifiedIds.has(id),
    );
    const withheldOrphanIds = summary.reReview.withheldFindingIds.filter(
      (id) => !withheldClassifiedIds.has(id),
    );
    // Count = classification rows + orphan IDs, so count always equals rendered detail rows.
    const fixedCount = fixedClassifications.length + fixedOrphanIds.length;
    const withheldCount = withheldClassifications.length + withheldOrphanIds.length;

    lines.push("### Re-review status");
    lines.push("");
    lines.push(`- New findings: ${summary.reReview.newFindingIds.length}`);
    lines.push(`- Recurring findings: ${summary.reReview.recurringFindingIds.length}`);
    lines.push(`- Fixed this round: ${fixedCount}`);
    if (fixedCount > 0) {
      for (const c of fixedClassifications) {
        const title =
          c.priorFinding?.title !== undefined
            ? escapeMarkdown(c.priorFinding.title)
            : `\`${c.stableId}\``;
        const lastSeen =
          c.lastSeenHeadSha !== undefined
            ? ` — last seen \`${c.lastSeenHeadSha.slice(0, 7)}\``
            : "";
        lines.push(`  - ✅ ${title}${lastSeen}`);
      }
      // Fallback rows for IDs with no matching classification record.
      for (const id of fixedOrphanIds) {
        lines.push(`  - ✅ \`${id}\``);
      }
    }
    lines.push(`- Withheld this round: ${withheldCount}`);
    if (withheldCount > 0) {
      for (const c of withheldClassifications) {
        const title =
          c.priorFinding?.title !== undefined
            ? escapeMarkdown(c.priorFinding.title)
            : `\`${c.stableId}\``;
        const lastSeen =
          c.lastSeenHeadSha !== undefined ? `, last seen \`${c.lastSeenHeadSha.slice(0, 7)}\`` : "";
        lines.push(`  - ${title} — withheld${lastSeen}`);
      }
      // Fallback rows for IDs with no matching classification record.
      for (const id of withheldOrphanIds) {
        lines.push(`  - \`${id}\` — withheld`);
      }
    }
    // Disposition rollup (#280): iterate all classifications and derive per-finding
    // disposition; render only nonzero categories. Omit line entirely when all zero.
    {
      const counts = { fixed: 0, dismissed: 0, ignored: 0, acknowledged: 0 };
      for (const c of summary.reReview.classifications) {
        const d = deriveDisposition(c);
        if (d !== undefined) counts[d]++;
      }
      const parts: string[] = [];
      if (counts.fixed > 0) parts.push(`${counts.fixed} fixed`);
      if (counts.dismissed > 0) parts.push(`${counts.dismissed} dismissed`);
      if (counts.ignored > 0) parts.push(`${counts.ignored} ignored`);
      if (counts.acknowledged > 0) parts.push(`${counts.acknowledged} acknowledged`);
      if (parts.length > 0) {
        lines.push(`- Dispositions: ${parts.join(" · ")}`);
      }
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

  // Cross-round resolved-finding history (#279, M026 S02): collapsed <details> section.
  // Only rendered when the log is present and at least one entry is not currently a
  // recurring finding (recurred entries are shown in current findings, not as resolved).
  if (summary.resolvedLog !== undefined && summary.resolvedLog.length > 0) {
    const currentFindingIds = new Set(summary.findings.map((f) => f.id).filter(Boolean));
    // Also include withheld findings as "current" so recurred-but-withheld entries don't render.
    for (const f of summary.groundingWithheld ?? []) {
      if (f.id !== undefined) currentFindingIds.add(f.id);
    }
    // Dedup against this round's fixed + withheld (#332): an entry already shown under
    // "Fixed this round" or "Withheld this round" must not appear again in the
    // resolved log. Build the exclusion set from classifications + orphan IDs (same source
    // the re-review section uses above) so the two sections are always consistent.
    // Cross-round value is preserved: entries resolved in earlier pushes that are NOT in
    // this round's fixed/withheld and NOT currently recurring still appear here.
    if (summary.reReview !== undefined) {
      const thisRoundFixed = summary.reReview.classifications.filter((c) => c.status === "fixed");
      const thisRoundWithheld = summary.reReview.classifications.filter(
        (c) => c.status === "withheld",
      );
      const thisRoundFixedClassifiedIds = new Set(thisRoundFixed.map((c) => c.stableId));
      const thisRoundWithheldClassifiedIds = new Set(thisRoundWithheld.map((c) => c.stableId));
      const thisRoundFixedOrphans = summary.reReview.fixedFindingIds.filter(
        (id) => !thisRoundFixedClassifiedIds.has(id),
      );
      const thisRoundWithheldOrphans = summary.reReview.withheldFindingIds.filter(
        (id) => !thisRoundWithheldClassifiedIds.has(id),
      );
      for (const c of thisRoundFixed) currentFindingIds.add(c.stableId);
      for (const c of thisRoundWithheld) currentFindingIds.add(c.stableId);
      for (const id of thisRoundFixedOrphans) currentFindingIds.add(id);
      for (const id of thisRoundWithheldOrphans) currentFindingIds.add(id);
    }
    const visibleEntries = summary.resolvedLog.filter(
      (entry) => !currentFindingIds.has(entry.stableId),
    );
    if (visibleEntries.length > 0) {
      lines.push(`<details><summary>🗂 Resolved over this PR (${visibleEntries.length})</summary>`);
      lines.push("");
      for (const entry of visibleEntries) {
        lines.push(`- ✅ ${escapeMarkdown(entry.title)} — fixed in \`${entry.resolvedAtSha}\``);
      }
      if (summary.resolvedLogTruncated === true) {
        lines.push("- …older resolved findings omitted");
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  // Break-glass footer (always, before the generated-by line)
  lines.push(BREAK_GLASS_FOOTER);
  lines.push("");
  // Footer stats (#285): fold run stats into the generated-by line when available.
  // When runStats is absent (fixture/degraded paths), render the bare line unchanged.
  if (summary.runStats !== undefined) {
    const { durationMs, modelTokenTotal, reviewerCount } = summary.runStats;
    const durationS = Math.round(durationMs / 1000);
    const tokenStr = formatTokenCount(modelTokenTotal);
    const reviewerLabel = reviewerCount === 1 ? "reviewer" : "reviewers";
    lines.push(
      `_Generated by code-reviewer · Review: ${durationS}s · ${reviewerCount} ${reviewerLabel} · ~${tokenStr} model tokens._`,
    );
  } else {
    lines.push("_Generated by code-reviewer._");
  }

  // Hidden metadata (last, gated)
  if (options.includeHiddenMetadata === true) {
    lines.push("");
    lines.push("<!-- code-reviewer");
    // Unicode-escape '>' so no model-authored field value (e.g. a findingTitles entry containing
    // '-->') can prematurely close the HTML comment and inject Markdown into the rendered body
    // (#82 security review — mirrors the same defence in inline-comment-markdown.ts).
    // JSON.parse in parseSummaryHiddenMetadata decodes > back to '>', so the round-trip is unaffected.
    lines.push(JSON.stringify(options.hiddenMetadata ?? {}, null, 2).replace(/>/g, "\\u003e"));
    lines.push("-->");
  }

  return lines.join("\n").trimEnd();
}
