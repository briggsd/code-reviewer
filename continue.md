# Continue — AI Code Review Factory / M009

## Last action

Committed **M009 S04: MVP per-domain reviewer modules**:

- `8b72261 Add domain-specific reviewer guidance`

Then implemented **M009 S05: Coordinator judgment and deterministic dedup floor** (not yet committed).

Key S05 changes:

- Coordinator prompt now requires root-cause/changed-location dedup, evidence filtering, speculation suppression, and the approval-bias decision rubric.
- Deterministic fallback summaries now deduplicate repeated findings before decision/outcome construction.
- `chooseDecision` now maps single warning → `approved_with_comments`, multiple warnings → `minor_issues`, critical → `significant_concerns`.
- Added tests for single-warning approval bias, multiple-warning minor issue decisions, deterministic dedup, and coordinator prompt guidance.
- Marked S05 complete in `M009-ROADMAP.md` and documented the deterministic floor in `docs/architecture.md`.

## Verification

Recent scoped verification before this handoff edit:

```bash
bunx tsc --noEmit
bun test test/runner.test.ts test/pi-runtime.test.ts
# 27 pass, 0 fail, 118 expect() calls
```

Run full verification before committing S05:

```bash
bun run check
```

## Next action

Run fresh full verification, then commit S05 if clean.

Recommended commands:

```bash
git status --short
bun run check
git add M009-ROADMAP.md continue.md docs/architecture.md src/runner/run-review.ts src/runtime/pi-agent-runtime.ts test/pi-runtime.test.ts test/runner.test.ts
git commit -m "Add coordinator judgment and dedup floor"
```

Then start **M009 S06: Prompt quality verification sweep**.

## Current state

- Branch: `main`
- Local `main` is ahead of `origin/main` by at least 10 commits.
- M009 status: S01/S02/S03/S04 committed; S05 implemented but not committed; S06 remains.
- There is no project-local `.gsd/STATE.md`; this repo currently uses root `continue.md` plus roadmap files.
- Pre-existing uncommitted note remains in `src/runner/risk-classifier.ts` for #21 risk-tier recalibration; do not stage it unless explicitly asked.

## Open threads

- #21 risk-tier recalibration is only noted, not implemented (`src/runner/risk-classifier.ts`).
- S06 should run/lock a prompt-quality verification sweep across trusted-resource docs, hostile input handling, reviewer module coverage, and coordinator fallback behavior.
- Backlog/out-of-scope note: `validateFinding` accepts any string `reviewer`; consider normalizing or rejecting reviewer outputs that mislabel their own role because coordinator/re-review keying may trust that field.

## Do not

- Do not stage or commit the pre-existing `src/runner/risk-classifier.ts` review-note edit unless explicitly asked.
- Do not reopen PR #9 or work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real Pi review workflow by default.
