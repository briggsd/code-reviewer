# Continue — AI Code Review Factory / M009

## Last action

Committed **M009 S03: Portable reviewer prompt module contract**:

- `b413a50 Add trusted reviewer definition contract`

Then implemented **M009 S04: MVP per-domain reviewer modules** (not yet committed).

Key S04 changes:

- Enriched `src/runner/reviewer-definitions.ts` with domain-specific flag/non-flag lists, severity calibration, output expectations, allowed severities, and per-definition `*.m009-s04` versions.
- Added prompt-level allowed severity rendering in `src/runtime/pi-agent-runtime.ts`.
- Limited the documentation reviewer to `warning` and `suggestion`; Pi runtime now clamps out-of-policy reviewer severities to the maximum allowed severity and emits `agent.output` severity adjustment metadata.
- Added tests for domain-specific reviewer guidance, prompt severity rendering, and deterministic severity enforcement.
- Marked S04 complete in `M009-ROADMAP.md` and documented domain-specific severity expectations in `docs/architecture.md`.

## Verification

Run before handing off:

```bash
bun run check
```

Expected recent result before the final handoff edit: `113 pass, 0 fail, 719 expect() calls`.

## Next action

Run fresh verification after this handoff edit, then commit S04 if clean.

Recommended commands:

```bash
git status --short
bun run check
git add M009-ROADMAP.md continue.md docs/architecture.md src/contracts/runtime.ts src/runner/reviewer-definitions.ts src/runtime/pi-agent-runtime.ts test/contracts.test.ts test/pi-runtime.test.ts test/runner.test.ts
git commit -m "Add domain-specific reviewer guidance"
```

Then start **M009 S05: Coordinator judgment and deterministic dedup floor**.

## Current state

- Branch: `main`
- Local `main` is ahead of `origin/main` by at least 9 commits.
- M009 status: S01/S02/S03 committed; S04 implemented but not committed; S05–S06 remain.
- There is no project-local `.gsd/STATE.md`; this repo currently uses root `continue.md` plus roadmap files.
- Pre-existing uncommitted note remains in `src/runner/risk-classifier.ts` for #21 risk-tier recalibration; do not stage it unless explicitly asked.

## Open threads

- #21 risk-tier recalibration is only noted, not implemented (`src/runner/risk-classifier.ts`).
- M009 S05 should fix `chooseDecision`: single warning without production risk should be `approved_with_comments`; multiple warnings/risk pattern should be `minor_issues`.
- S05 should add coordinator prompt language for dedup/reasonableness/source verification and a deterministic dedup floor.
- Backlog/out-of-scope note: `validateFinding` accepts any string `reviewer`; consider normalizing or rejecting reviewer outputs that mislabel their own role because coordinator/re-review keying may trust that field.

## Do not

- Do not stage or commit the pre-existing `src/runner/risk-classifier.ts` review-note edit unless explicitly asked.
- Do not reopen PR #9 or work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real Pi review workflow by default.
