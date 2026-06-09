import { createHash } from "node:crypto";
import type { Finding, FindingLocation, ReviewSummary } from "../contracts/index.ts";

export function assignStableFindingIds(summary: ReviewSummary): ReviewSummary {
  return {
    ...summary,
    findings: summary.findings.map((finding) => ({
      ...finding,
      id: finding.id ?? createStableFindingId(finding),
    })),
  };
}

export function createStableFindingId(finding: Finding): string {
  const input = [
    normalizeText(String(finding.reviewer)),
    normalizeText(finding.category),
    normalizeLocation(finding.location),
    normalizeText(finding.title),
    normalizeText(finding.body),
  ].join("|");
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
