# Continue — AI Code Review Factory / M009

## Last action

Committed **M009 S05: Coordinator judgment and deterministic dedup floor**:

- `d4fa5e8 Add coordinator judgment and dedup floor`

Then implemented **M009 S06: Prompt quality verification sweep** (not yet committed).

Key S06 changes:

- Added `test/prompt-quality.test.ts` to lock M009 prompt-quality invariants:
  - MVP trusted reviewer definitions have complete trusted guidance.
  - hostile prompt-boundary content stays inert JSON data after sanitization.
  - deterministic fallback summaries deduplicate repeated findings and preserve the approval-bias decision floor.
  - architecture docs no longer contain the stale `chooseDecision` over-block note and record the completed S05 rubric.
- Marked S06 complete in `M009-ROADMAP.md`.
- Updated the architecture primary-source delta for the coordinator rubric from future-work language to implemented-in-S05 language.

## Verification

Recent scoped verification before this handoff edit:

```bash
bunx tsc --noEmit
bun test test/prompt-quality.test.ts
# 4 pass, 0 fail, 39 expect() calls
```

Run full verification before committing S06:

```bash
bun run check
```

## Next action

Run fresh full verification, then commit S06 if clean.

Recommended commands:

```bash
git status --short
bun run check
git add M009-ROADMAP.md continue.md docs/architecture.md test/prompt-quality.test.ts
git commit -m "Add prompt quality verification sweep"
```

After that, M009 should be complete. Consider whether to push the accumulated local commits or move to the next roadmap. Local `main` will be ahead of `origin/main` by 12 commits after S06.

## Current state

- Branch: `main`
- Local `main` is ahead of `origin/main` by 11 commits before the S06 commit.
- M009 status: S01/S02/S03/S04/S05 committed; S06 implemented but not committed.
- There is no project-local `.gsd/STATE.md`; this repo currently uses root `continue.md` plus roadmap files.
- Pre-existing uncommitted note remains in `src/runner/risk-classifier.ts` for #21 risk-tier recalibration; do not stage it unless explicitly asked.

## Open threads

- #21 risk-tier recalibration is only noted, not implemented (`src/runner/risk-classifier.ts`).
- Backlog/out-of-scope note: `validateFinding` accepts any string `reviewer`; consider normalizing or rejecting reviewer outputs that mislabel their own role because coordinator/re-review keying may trust that field.
- M010 is the likely next roadmap if continuing prompt/context quality work; M011/M012 cover telemetry and advanced resilience.

## Do not

- Do not stage or commit the pre-existing `src/runner/risk-classifier.ts` review-note edit unless explicitly asked.
- Do not reopen PR #9 or work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real Pi review workflow by default.
