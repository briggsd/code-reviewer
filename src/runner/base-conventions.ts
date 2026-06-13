import type {
  Acknowledgement,
  ChangeMetadata,
  ReviewConfig,
  VcsAdapter,
} from "../contracts/index.ts";
import { normalizeAcknowledgements, normalizeConventions, normalizeStringList } from "./config.ts";

export interface ResolvedBaseConfig {
  conventions: string[];
  compliancePolicy: string[];
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
    // compliancePolicy is NOT carried from head here (#23): in the VCS path the local config is
    // resolved from the PR head, so a head-supplied policy is author-controlled. conventions are
    // advisory ("weigh as guidance") so the head fallback is tolerable, but compliance policy is
    // authority-like (it defines what counts as a violation), so it must come from a provably-base
    // source or not at all. Without a base read it resolves to empty — the compliance reviewer is
    // simply inert until base-branch reads land for this adapter, never author-controllable.
    return {
      conventions: config.conventions ?? [],
      compliancePolicy: [],
      acknowledgements: config.acknowledgements ?? [],
      source: "local",
      baseFileFound: false,
    };
  }

  const text = await adapter.readBaseBranchFile(metadata, ".ai-review.json");

  if (text === undefined) {
    // Base file is absent — empty conventions + compliancePolicy + acknowledgements (the PR adding
    // them for the first time has them only on head, so they must not take effect here).
    return {
      conventions: [],
      compliancePolicy: [],
      acknowledgements: [],
      source: "base",
      baseFileFound: false,
    };
  }

  // Base file found — parse ONCE and normalize conventions, compliancePolicy, and acknowledgements.
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      conventions: [],
      compliancePolicy: [],
      acknowledgements: [],
      source: "base",
      baseFileFound: true,
    };
  }

  const parsed =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : undefined;

  const conventions = normalizeConventions(parsed?.conventions, []);
  const compliancePolicy = normalizeStringList(parsed?.compliancePolicy, []);
  const acknowledgements = normalizeAcknowledgements(parsed?.acknowledgements, []);
  return { conventions, compliancePolicy, acknowledgements, source: "base", baseFileFound: true };
}
