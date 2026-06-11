import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Acknowledgement, ModelRoutingConfig, ReviewConfig } from "../contracts/index.ts";
import { createDefaultReviewConfig } from "./default-config.ts";

const DEFAULT_CONFIG_FILENAMES = [".ai-review.json", "ai-review.json"];

export async function loadReviewConfigFile(path: string, base: ReviewConfig = createDefaultReviewConfig()): Promise<ReviewConfig> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as unknown;

  return normalizeReviewConfig(parsed, base, path);
}

export async function loadProjectReviewConfig(options: {
  path?: string;
  cwd?: string;
  base?: ReviewConfig;
} = {}): Promise<ReviewConfig> {
  const base = options.base ?? createDefaultReviewConfig();
  const path = options.path ?? await findProjectReviewConfig(options.cwd ?? process.cwd());
  if (path === undefined) {
    return base;
  }

  return loadReviewConfigFile(path, base);
}

export async function findProjectReviewConfig(cwd = process.cwd()): Promise<string | undefined> {
  for (const filename of DEFAULT_CONFIG_FILENAMES) {
    const path = join(cwd, filename);
    try {
      await access(path);
      return path;
    } catch {
      // Try the next conventional config name.
    }
  }

  return undefined;
}

export function normalizeReviewConfig(
  override: unknown,
  base: ReviewConfig = createDefaultReviewConfig(),
  source = "<inline>",
): ReviewConfig {
  if (override === undefined) {
    return base;
  }

  if (!isRecord(override)) {
    throw new Error(`Review config ${source} must be a JSON object`);
  }

  return {
    ...base,
    ...override,
    conventions: normalizeConventions(override.conventions, base.conventions ?? []),
    acknowledgements: normalizeAcknowledgements(override.acknowledgements, base.acknowledgements ?? []),
    failOn: Array.isArray(override.failOn) ? (override.failOn as ReviewConfig["failOn"]) : base.failOn,
    sensitivePaths: Array.isArray(override.sensitivePaths)
      ? (override.sensitivePaths as string[])
      : base.sensitivePaths,
    ignoredPaths: Array.isArray(override.ignoredPaths) ? (override.ignoredPaths as string[]) : base.ignoredPaths,
    reviewerPolicy: isRecord(override.reviewerPolicy)
      ? { ...base.reviewerPolicy, ...(override.reviewerPolicy as ReviewConfig["reviewerPolicy"]) }
      : base.reviewerPolicy,
    timeouts: isRecord(override.timeouts)
      ? { ...base.timeouts, ...(override.timeouts as unknown as ReviewConfig["timeouts"]) }
      : base.timeouts,
    modelRouting: mergeModelRouting(base.modelRouting, override.modelRouting),
    extra: isRecord(override.extra) ? (override.extra as ReviewConfig["extra"]) : base.extra,
  };
}

function mergeModelRouting(base: ModelRoutingConfig, override: unknown): ModelRoutingConfig {
  if (!isRecord(override)) {
    return base;
  }

  return {
    default: isRecord(override.default)
      ? { ...base.default, ...(override.default as unknown as ModelRoutingConfig["default"]) }
      : base.default,
    roles: isRecord(override.roles)
      ? { ...base.roles, ...(override.roles as ModelRoutingConfig["roles"]) }
      : base.roles,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeConventions(value: unknown, fallback: string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }

  const entries = Array.isArray(value) ? value : [value];
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") {
      continue;
    }

    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      continue;
    }

    normalized.push(trimmed.length > 500 ? trimmed.slice(0, 500) : trimmed);
    if (normalized.length === 50) {
      break;
    }
  }

  return normalized;
}

export function normalizeAcknowledgements(value: unknown, fallback: Acknowledgement[]): Acknowledgement[] {
  if (value === undefined) {
    return [...fallback];
  }

  const entries = Array.isArray(value) ? value : [];
  const normalized: Acknowledgement[] = [];

  for (const entry of entries) {
    // Entry must be a non-null object.
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;

    // path is required: must be a non-empty string.
    if (typeof obj["path"] !== "string") {
      continue;
    }
    const path = obj["path"].trim();
    if (path.length === 0) {
      continue;
    }

    // reason: string trimmed + truncated to 500 chars; missing/non-string → "".
    const reason = typeof obj["reason"] === "string"
      ? obj["reason"].trim().slice(0, 500)
      : "";

    // mode: keep only "acknowledge"/"suppress"; anything else → default "acknowledge".
    const mode: "acknowledge" | "suppress" =
      obj["mode"] === "acknowledge" || obj["mode"] === "suppress"
        ? obj["mode"]
        : "acknowledge";

    const ack: Acknowledgement = {
      path: path.slice(0, 500),
      mode,
      reason,
    };

    // category: optional, keep only non-empty string, bounded to 200 chars.
    if (typeof obj["category"] === "string") {
      const category = obj["category"].trim().slice(0, 200);
      if (category.length > 0) {
        ack.category = category;
      }
    }

    // stableFindingId: optional, keep only non-empty string, bounded to 100 chars.
    if (typeof obj["stableFindingId"] === "string") {
      const stableFindingId = obj["stableFindingId"].trim().slice(0, 100);
      if (stableFindingId.length > 0) {
        ack.stableFindingId = stableFindingId;
      }
    }

    // expires: optional, keep only non-empty string, bounded to 200 chars.
    if (typeof obj["expires"] === "string") {
      const expires = obj["expires"].trim().slice(0, 200);
      if (expires.length > 0) {
        ack.expires = expires;
      }
    }

    normalized.push(ack);

    if (normalized.length === 100) {
      break;
    }
  }

  return normalized;
}
