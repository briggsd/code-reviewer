# Continue — AI Code Review Factory / M009

## Last action

Implemented **M009 S03: Portable reviewer prompt module contract** on `main`.

Key changes:

- Added runtime-neutral `ReviewerDefinition` contract in `src/contracts/runtime.ts`.
- Added trusted factory-owned reviewer definitions and formatting helpers in `src/runner/reviewer-definitions.ts`.
- Changed reviewer selection in `src/runner/run-review.ts` to select only trusted built-in reviewer definitions; reviewed-repo config can enable/disable known roles but cannot define new reviewer prompt authority.
- Changed Pi reviewer prompt assembly in `src/runtime/pi-agent-runtime.ts` to render the trusted reviewer definition instead of free-form `domainInstructions`.
- Added `agent.skipped` trace events for enabled reviewerPolicy roles that do not have a trusted reviewer definition (for example `release: "enabled"`).
- Documented the contract and skip-observability boundary in `docs/architecture.md`.
- Marked S03 complete in `M009-ROADMAP.md`.

Fresh verification:

```bash
bun run check
# 113 pass, 0 fail, 719 expect() calls
```

## Next action

Review the S03 diff, then either commit it or continue to **M009 S04: MVP per-domain reviewer modules**.

Recommended commands:

```bash
git status --short
git diff -- src/contracts/runtime.ts src/runner/reviewer-definitions.ts src/runner/run-review.ts src/runtime/pi-agent-runtime.ts src/runner/index.ts test/runner.test.ts test/pi-runtime.test.ts test/contracts.test.ts docs/architecture.md M009-ROADMAP.md continue.md
bunx tsc --noEmit
bun test test/runner.test.ts test/pi-runtime.test.ts test/contracts.test.ts test/fork-safety-docs.test.ts
```

## Current state

- Branch: `main`
- M009 status: S01/S02 committed; S03 implemented but not committed; S04–S06 remain.
- There is no project-local `.gsd/STATE.md`; this repo currently uses root `continue.md` plus roadmap files.
- Uncommitted changes now include both S03 implementation files and earlier planning/review notes.

## Open threads

- #21 risk-tier recalibration is only noted, not implemented (`src/runner/risk-classifier.ts`).
- M009 S04 should enrich `security`, `code_quality`, and `documentation` reviewer definitions with fuller domain-specific flag/non-flag guidance, output expectations, and severity rubrics. Decide whether documentation should expose `critical` at all; if it does, give it a docs-specific critical bar.
- Reviewer definitions now have per-role versions (`security.m009-s03`, etc.); bump only the changed definition when S04 content diverges.
- M009 S05 should later fix `chooseDecision`: single warning without production risk should be `approved_with_comments`; multiple warnings/risk pattern should be `minor_issues`.
- Keep the pre-existing uncommitted primary-source notes unless the user asks to clean/commit them.

## Do not

- Do not stage or commit the pre-existing review-note edits unless explicitly asked.
- Do not reopen PR #9 or work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real Pi review workflow by default.
