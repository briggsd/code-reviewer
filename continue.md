# Continue — AI Code Review Factory / M010 S04

## Last action

Committed M010 slices:

- `d7e71f5` — Add shared review context artifacts (S01)
- `3c7c232` — Add reviewer context references (S02)
- `bced1b2` — Render reviewer prompts with context references (S03)

Then implemented **M010 S04: Token/cost measurement for context savings**.

Key S04 changes:

- Added `AgentPromptMetrics` / `AgentPromptContextMode` contract fields.
- `ReviewerRunResult` can carry `promptMetrics`.
- Run metrics now include context artifact byte counts:
  - total artifact bytes
  - change-context bytes
  - patch bytes
  - patch file count
- Agent run metrics can persist reviewer prompt metrics.
- Pi reviewer runs now compute and emit/return:
  - `contextMode` (`path_references` or `inline_fallback`)
  - `promptBytes`
  - `contextPayloadBytes`
  - `inlineDiffBytes`
  - `estimatedInputTokensSaved`
- Added tests for context byte metrics in state and Pi reviewer prompt savings metrics.
- Marked M010 S04 complete in `M010-ROADMAP.md`.

Verification:

```bash
bun run check
# 125 pass, 0 fail, 814 expect() calls
```

## Next action

Commit S04, then implement **M010 S05: Package/docs verification sweep**.

Suggested starting points:

```bash
git status --short
read M010-ROADMAP.md
read docs/architecture.md
read docs/configuration.md
read docs/packaging.md
read scripts/package-smoke.ts
rg "contextDirectory|context artifact|patchPath|promptMetrics|AgentPromptMetrics" README.md docs scripts test src -n
```

S05 should document context artifact behavior and add/adjust package smoke coverage proving artifacts are present and consumable from an adopter-like install.

## Open threads

- M010 S04 is implemented and verified but not committed yet.
- Pre-existing uncommitted note remains in `src/runner/risk-classifier.ts` for #21 risk-tier recalibration; do not stage it unless explicitly asked.
- `M009-SUMMARY.md` remains untracked from the prior M009 wrap-up.
- Backlog: `validateFinding` accepts any string `reviewer`; consider normalizing/rejecting model outputs that mislabel their own reviewer role.

## Do not

- Do not commit `src/runner/risk-classifier.ts` unless explicitly asked; it is a separate #21 note.
- Do not reopen PR #9 or work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real Pi review workflow by default.
