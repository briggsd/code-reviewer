import { readFile } from "node:fs/promises";
import type {
  ChangeMetadata,
  DiffSummary,
  Finding,
  PriorReviewState,
  ReviewConfig,
  RiskAssessment,
  SafetyMode,
} from "../contracts/index.ts";
import { normalizeReviewConfig } from "./config.ts";
import { createDefaultReviewConfig } from "./default-config.ts";

export interface ReviewFixture {
  runId?: string;
  safetyMode?: SafetyMode;
  workingDirectory?: string;
  contextDirectory?: string;
  metadata: ChangeMetadata;
  diff: DiffSummary;
  config: ReviewConfig;
  risk?: RiskAssessment;
  priorState?: PriorReviewState;
  fakeFindings?: Finding[];
}

export async function loadReviewFixture(path: string): Promise<ReviewFixture> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return normalizeReviewFixture(parsed, path);
}

export function normalizeReviewFixture(value: unknown, source = "<inline>"): ReviewFixture {
  if (!isRecord(value)) {
    throw new Error(`Review fixture ${source} must be a JSON object`);
  }

  if (!isRecord(value.metadata)) {
    throw new Error(`Review fixture ${source} is missing metadata`);
  }

  if (!isRecord(value.diff) || !Array.isArray(value.diff.files)) {
    throw new Error(`Review fixture ${source} is missing diff.files`);
  }

  const config = normalizeReviewConfig(value.config, createDefaultReviewConfig(), source);

  return {
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    safetyMode: isSafetyMode(value.safetyMode) ? value.safetyMode : "trusted",
    workingDirectory:
      typeof value.workingDirectory === "string" ? value.workingDirectory : process.cwd(),
    contextDirectory:
      typeof value.contextDirectory === "string" ? value.contextDirectory : ".ai-review/context",
    metadata: value.metadata as unknown as ChangeMetadata,
    diff: value.diff as unknown as DiffSummary,
    config,
    ...(isRecord(value.risk) ? { risk: value.risk as unknown as RiskAssessment } : {}),
    ...(isRecord(value.priorState)
      ? { priorState: value.priorState as unknown as PriorReviewState }
      : {}),
    fakeFindings: Array.isArray(value.fakeFindings) ? (value.fakeFindings as Finding[]) : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafetyMode(value: unknown): value is SafetyMode {
  return (
    value === "trusted" ||
    value === "untrusted_read_only" ||
    value === "privileged_metadata_only" ||
    value === "manual_privileged"
  );
}
