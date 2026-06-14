import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReviewerDefinition } from "../contracts/index.ts";
import {
  assertReviewerDefinition,
  type OperatorReviewerExtension,
} from "./reviewer-definitions.ts";

/**
 * Load an operator reviewer-definitions module by **explicit path** (M017 S03, #143).
 *
 * This is the operator-extension seam: an adopter, acting as the trusted operator in their own CI,
 * supplies their own `ReviewerDefinition[]` by an explicit `--reviewers <path>` they control. It
 * mirrors the proven Pi lockout shape (`docs/fork-safety.md`): exactly like the factory's single
 * `--extension <…>` load, the path is operator-supplied and resolved in the trusted CI — it is
 * **never discovered from the reviewed repo**, so a reviewed repo cannot smuggle a reviewer in.
 *
 * The module is authored against the S02 public `defineReviewer`/`createReviewerDefinition`
 * (`ai-code-review-factory`). It may export either:
 *
 *   - an array of `ReviewerDefinition` (default export or a named `reviewers` export), or
 *   - an `{ definitions, replace? }` object (default export or named `reviewers`),
 *
 * where `replace: true` opts into full-replace mode (the operator set entirely supplants the
 * trusted set instead of merging by role). The caller passes the returned extension into
 * `mergeReviewerDefinitions`, which applies the merge-by-role/operator-wins rule and the reserved
 * `coordinator`-name guard.
 */
export async function loadOperatorReviewerDefinitions(
  path: string,
): Promise<OperatorReviewerExtension> {
  const absolute = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let imported: Record<string, unknown>;
  try {
    imported = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`--reviewers: failed to load operator reviewer module "${path}": ${message}`);
  }

  const exported = imported.default ?? imported.reviewers;
  if (exported === undefined) {
    throw new Error(
      `--reviewers: operator reviewer module "${path}" must export a default or "reviewers" value (an array of reviewer definitions or { definitions, replace? })`,
    );
  }

  const { rawDefinitions, replace } = normalizeExport(exported, path);
  const definitions: ReviewerDefinition[] = rawDefinitions.map((value, index) =>
    assertReviewerDefinition(value, index),
  );
  if (definitions.length === 0) {
    throw new Error(
      `--reviewers: operator reviewer module "${path}" exported no reviewer definitions`,
    );
  }

  assertUniqueRoles(definitions, path);

  return { definitions, replace };
}

function normalizeExport(
  exported: unknown,
  path: string,
): { rawDefinitions: unknown[]; replace: boolean } {
  if (Array.isArray(exported)) {
    return { rawDefinitions: exported, replace: false };
  }
  if (typeof exported === "object" && exported !== null) {
    const obj = exported as Record<string, unknown>;
    if (Array.isArray(obj.definitions)) {
      const replace = obj.replace;
      if (replace !== undefined && typeof replace !== "boolean") {
        throw new Error(
          `--reviewers: operator reviewer module "${path}" "replace" must be a boolean when present`,
        );
      }
      return { rawDefinitions: obj.definitions, replace: replace === true };
    }
  }
  throw new Error(
    `--reviewers: operator reviewer module "${path}" export must be an array of reviewer definitions or { definitions, replace? }`,
  );
}

function assertUniqueRoles(definitions: readonly ReviewerDefinition[], path: string): void {
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.role)) {
      throw new Error(
        `--reviewers: operator reviewer module "${path}" declares role "${definition.role}" more than once`,
      );
    }
    seen.add(definition.role);
  }
}
