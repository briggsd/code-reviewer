/**
 * Provider-agnostic inline-comment renderer shared by GitHub and GitLab adapters.
 *
 * Centralising the formatter here (rather than one copy per adapter) ensures that the
 * #74 markdown-escaping and the `ai-code-review-factory-inline` dedup metadata are
 * identical across providers and cannot drift.
 */

import type { ChangeMetadata, Finding } from "../contracts/index.ts";
import { assertNever } from "../contracts/index.ts";
import { escapeMarkdown } from "./markdown-escape.ts";

/**
 * Render a finding as a Markdown inline-comment body.
 *
 * `change.provider` is read dynamically so the hidden metadata records the right provider
 * regardless of which VCS adapter calls this function.
 *
 * All LLM-produced finding fields (title, body, category, evidence, recommendation) are
 * escaped with `escapeMarkdown` before interpolation (#74).
 */
export function formatInlineFindingComment(
  finding: Finding,
  change: ChangeMetadata,
  runId: string | undefined,
): string {
  // Unicode-escape '>' in the serialized metadata so no field value (e.g. an LLM-influenced
  // finding.id containing '-->') can prematurely close the HTML comment and inject Markdown
  // into the rendered body (#82 security review). JSON.parse in parseInlineCommentMetadata
  // decodes > back to '>', so the dedup round-trip is unaffected.
  const metadata = JSON.stringify({
    schemaVersion: 1,
    provider: change.provider,
    repository: change.repository.slug,
    changeId: change.changeId,
    headSha: change.headSha,
    findingId: finding.id ?? null,
    runId: runId ?? null,
  }).replace(/>/g, "\\u003e");
  // Escape each evidence item individually before embedding in a list line (#74).
  // category is NOT in a code span in this inline format — escape it too (#74).
  const evidence =
    finding.evidence.length === 0
      ? ["- No separate evidence was provided."]
      : finding.evidence.map((item) => `- ${escapeMarkdown(item)}`);

  return [
    // category appears outside a code span here (unlike summary-markdown) — escape it (#74).
    `### AI review: ${formatSeverity(finding.severity)} · ${escapeMarkdown(finding.category)}`,
    "",
    // title/body/recommendation are LLM-produced free text — escape before embedding (#74).
    `**${escapeMarkdown(finding.title)}**`,
    "",
    escapeMarkdown(finding.body),
    "",
    `**Confidence:** ${formatTitleCase(finding.confidence)}`,
    "",
    "<details>",
    "<summary>Evidence</summary>",
    "",
    ...evidence,
    "",
    "</details>",
    "",
    "**Recommendation**",
    "",
    escapeMarkdown(finding.recommendation),
    "",
    "_AI review inline comment. CI status and the summary comment remain authoritative._",
    "",
    "<!-- ai-code-review-factory-inline",
    metadata,
    "-->",
  ].join("\n");
}

/**
 * Parse the hidden metadata block from an inline comment body.
 *
 * Returns `undefined` if the body is undefined, lacks the sentinel comment, or contains
 * unparseable JSON — callers treat these as "no dedup match" and post fresh.
 */
export function parseInlineCommentMetadata(
  body: string | undefined,
): { findingId?: string; headSha?: string } | undefined {
  if (body === undefined) {
    return undefined;
  }

  const match = /<!-- ai-code-review-factory-inline\s*\n([\s\S]*?)\n-->/m.exec(body);
  if (match?.[1] === undefined) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(match[1]) as { findingId?: unknown; headSha?: unknown };
    return {
      ...(typeof parsed.findingId === "string" && parsed.findingId.length > 0
        ? { findingId: parsed.findingId }
        : {}),
      ...(typeof parsed.headSha === "string" && parsed.headSha.length > 0
        ? { headSha: parsed.headSha }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * Build the dedup map key from a finding ID and the head SHA at the time of posting.
 * The key is stable: the same finding posted at the same head is a duplicate.
 */
export function inlineCommentKey(findingId: string, headSha: string): string {
  return `${headSha}:${findingId}`;
}

// Module-private helpers — not exported; only used by formatInlineFindingComment above.

function formatSeverity(severity: Finding["severity"]): string {
  // Exhaustiveness guard: each Severity member mapped; new members require a matching
  // case or the switch becomes a compile error.
  let icon: string;
  switch (severity) {
    case "critical":
      icon = "🚨";
      break;
    case "warning":
      icon = "⚠️";
      break;
    case "suggestion":
      icon = "💬";
      break;
    default:
      icon = assertNever(severity, "Severity");
  }
  return `${icon} ${formatTitleCase(severity)}`;
}

function formatTitleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
