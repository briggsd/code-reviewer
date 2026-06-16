/**
 * Types for the deterministic docs-freshness checker (`bun run docs:check`).
 *
 * The checker is split into a pure core (this directory) and an IO wrapper
 * (`scripts/check-docs.ts`) that reads the filesystem / git and assembles the
 * inputs — the same load-bearing split as `src/evals`. Nothing here touches the
 * filesystem, so every rule is unit-testable over plain strings.
 */

/** A markdown document fed to the checker. */
export interface DocInput {
  /** Repo-root-relative path of the markdown file (e.g. `docs/developer/architecture.md`). */
  path: string;
  /** Full file contents. */
  text: string;
  /**
   * "live" docs are held to the blocking dead-reference rules; "historical"
   * docs (milestone roadmaps/summaries) are append-only records of past state
   * and are exempt from blocking path/script checks and the oversized-doc
   * advisory (they reference paths that legitimately no longer exist).
   */
  scope: "live" | "historical";
}

/**
 * Authoritative facts a reference is validated against. The IO wrapper builds
 * these from the filesystem, `package.json`, and a broad source-of-truth grep.
 */
export interface KnownFacts {
  /**
   * Every repo-root-relative path that exists — tracked files AND every
   * ancestor directory of those files (directory references like `src/runner/`
   * must resolve too). Stored without a trailing slash.
   */
  existingPaths: ReadonlySet<string>;
  /** `package.json` script names that exist. */
  scriptNames: ReadonlySet<string>;
  /** `AI_REVIEW_*` env var names referenced anywhere in code/CI (source of truth). */
  envVarNames: ReadonlySet<string>;
  /**
   * Count-drift facts (#276 / M027): known ground-truth counts for quantities
   * that docs tend to mention explicitly. When a doc's `(~N)` claim near a
   * labelled quantity drifts significantly from the real count, an advisory
   * fires so a reviewer catches the stale number without relying on the LLM.
   *
   * Keys are human-readable labels (e.g. `"test files"`, `"src modules"`).
   * Values are the live counts read by the IO wrapper.
   *
   * Optional: callers that do not populate this field get no count-drift
   * advisories (backward-compatible).
   */
  countFacts?: ReadonlyMap<string, number>;
}

/** A single problem the checker reports, with its source location. */
export interface DocFinding {
  /** Repo-root-relative doc path. */
  doc: string;
  /** 1-based line number within the doc. */
  line: number;
  /** The reference token (or doc identifier, for whole-doc advisories) that triggered it. */
  reference: string;
  /** Human-readable explanation. */
  message: string;
}

/**
 * The checker's verdict. `blocking` findings fail the check (exit 1);
 * `advisory` findings are informational only and never affect the exit code.
 */
export interface DocCheckReport {
  blocking: DocFinding[];
  advisory: DocFinding[];
}
