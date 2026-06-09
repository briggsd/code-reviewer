import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRoutingConfig, ReviewConfig } from "../contracts/index.ts";
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
