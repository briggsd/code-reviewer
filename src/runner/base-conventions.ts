import type { Acknowledgement, ChangeMetadata, ReviewConfig, VcsAdapter } from "../contracts/index.ts";
import { normalizeAcknowledgements, normalizeConventions } from "./config.ts";

export interface ResolvedBaseConfig {
  conventions: string[];
  acknowledgements: Acknowledgement[];
  source: "base" | "local";
  baseFileFound: boolean;
}

export async function resolveBaseConfig(input: {
  adapter: VcsAdapter;
  metadata: ChangeMetadata;
  config: ReviewConfig;
}): Promise<ResolvedBaseConfig> {
  const { adapter, metadata, config } = input;

  if (adapter.readBaseBranchFile === undefined) {
    // Adapter does not support base-branch reads (e.g. GitLab in this slice).
    // Degrade safely: keep the head/local config conventions and acknowledgements (P1 advisory behavior).
    return {
      conventions: config.conventions ?? [],
      acknowledgements: config.acknowledgements ?? [],
      source: "local",
      baseFileFound: false,
    };
  }

  const text = await adapter.readBaseBranchFile(metadata, ".ai-review.json");

  if (text === undefined) {
    // Base file is absent — empty conventions + acknowledgements (the PR adding them for the
    // first time has them only on head, so they must not take effect here).
    return { conventions: [], acknowledgements: [], source: "base", baseFileFound: false };
  }

  // Base file found — parse ONCE and normalize both conventions and acknowledgements.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { conventions: [], acknowledgements: [], source: "base", baseFileFound: true };
  }

  const parsed = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;

  const conventions = normalizeConventions(parsed?.["conventions"], []);
  const acknowledgements = normalizeAcknowledgements(parsed?.["acknowledgements"], []);
  return { conventions, acknowledgements, source: "base", baseFileFound: true };
}
