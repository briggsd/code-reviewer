import type { ChangeMetadata, ReviewConfig, VcsAdapter } from "../contracts/index.ts";
import { normalizeConventions } from "./config.ts";

export interface ResolvedConventions {
  conventions: string[];
  source: "base" | "local";
  baseFileFound: boolean;
}

export async function resolveBaseConventions(input: {
  adapter: VcsAdapter;
  metadata: ChangeMetadata;
  config: ReviewConfig;
}): Promise<ResolvedConventions> {
  const { adapter, metadata, config } = input;

  if (adapter.readBaseBranchFile === undefined) {
    // Adapter does not support base-branch reads (e.g. GitLab in this slice).
    // Degrade safely: keep the head/local config conventions (P1 advisory behavior).
    return { conventions: config.conventions ?? [], source: "local", baseFileFound: false };
  }

  const text = await adapter.readBaseBranchFile(metadata, ".ai-review.json");

  if (text === undefined) {
    // Base file is absent — empty conventions (the PR adding them for the first time
    // has them only on head, so they must not take effect here).
    return { conventions: [], source: "base", baseFileFound: false };
  }

  // Base file found — parse and normalize its conventions (malformed → safe empty).
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { conventions: [], source: "base", baseFileFound: true };
  }

  const parsed = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>).conventions
    : undefined;

  const conventions = normalizeConventions(parsed, []);
  return { conventions, source: "base", baseFileFound: true };
}
