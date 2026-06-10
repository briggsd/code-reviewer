# Continue — AI Code Review Factory / after M010

## Last action

Completed and committed **M010: Shared context files and token economics** through S05.

M010 commits:

- `d7e71f5` — Add shared review context artifacts
- `3c7c232` — Add reviewer context references
- `bced1b2` — Render reviewer prompts with context references
- `f139708` — Add context token savings metrics
- Verify packaged context artifacts

Summary artifact: `M010-SUMMARY.md`.

Verification:

```bash
bun run check
# 125 pass, 0 fail, 819 expect() calls

bun run smoke:external-package
# external package smoke passed: ai-code-review-factory-0.1.0.tgz; provider dry-run skipped

bun run pack:smoke
# package smoke passed: ai-code-review-factory-0.1.0.tgz (78 files)
```

## Next action

Decide whether to push accumulated local commits or start the next milestone.

Suggested starting points:

```bash
git status --short
git log --oneline --decorate -10
read M011-ROADMAP.md
read M012-ROADMAP.md
```

M011 appears to be the likely next milestone for product analytics/telemetry after M008/M010 metrics; M012 covers advanced resilience/plugin lifecycle work.

## Open threads

- `main` is ahead of `origin/main` by the accumulated M009/M010 commits.
- Pre-existing uncommitted note remains in `src/runner/risk-classifier.ts` for #21 risk-tier recalibration; do not stage it unless explicitly asked.
- `M009-SUMMARY.md` remains untracked from the prior M009 wrap-up.
- Backlog: `validateFinding` accepts any string `reviewer`; consider normalizing/rejecting model outputs that mislabel their own reviewer role.
- S04 estimated input-token savings use a byte/4 approximation; future provider telemetry can replace or calibrate the estimate.

## Do not

- Do not commit `src/runner/risk-classifier.ts` unless explicitly asked; it is a separate #21 note.
- Do not reopen PR #9 or work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real Pi review workflow by default.
