/**
 * Stable public surface for adopters importing from `@briggsd/code-reviewer` to author
 * a reviewer extension (#175 / M017 S02). This barrel is the package root export (mapped
 * via `package.json` `exports` to `src/public.ts`). The broad `src/index.ts` barrel
 * stays internal — only what is here is considered public API.
 */

export type { ReviewerDefinition, Severity } from "./contracts/index.ts";
export type { DefineReviewerInput } from "./runner/reviewer-definitions.ts";
export { createReviewerDefinition, defineReviewer } from "./runner/reviewer-definitions.ts";
