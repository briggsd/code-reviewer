# Continue — AI Code Review Factory / M010 S02

## Last action

Committed **M010 S01: Shared context writer**:

- `d7e71f5` — Add shared review context artifacts

Then implemented **M010 S02: Reviewer context assignment by reference**.

Key S02 changes:

- Added `ReviewerContextReferenceFile` and `ReviewerContextReferences` to `src/contracts/runtime.ts`.
- `ReviewerRunInput` now includes `contextReferences`.
- Runner builds reviewer context references from the reviewer’s assigned files:
  - shared `changeContextPath`
  - shared `patchDirectory`
  - per-file metadata with `patchPath`
  - no inline `patch` bodies in `contextReferences.files`
- Existing full `ReviewContext` remains on runtime input as the compatibility/fallback channel until S03 updates prompt rendering.
- Added runner coverage to assert reviewer inputs carry path references without inline patch bodies.
- Marked M010 S02 complete in `M010-ROADMAP.md`.

Verification:

```bash
bun run check
# 124 pass, 0 fail, 802 expect() calls
```

## Next action

Commit S02, then implement **M010 S03: Runtime prompt rendering for path-based context**.

Suggested starting points:

```bash
git status --short
read M010-ROADMAP.md
read src/runtime/pi-agent-runtime.ts
rg "contextReferences|files: input.context.diff.files|assignedFiles|stringifyPromptData|Review context" src test -n
```

S03 should update Pi reviewer prompts to point reviewers at `contextReferences.changeContextPath` and selected `patchPath`s instead of embedding full `context.diff.files` patch payloads. Preserve a clear fallback for runtimes/safety modes that cannot read local files by path.

## Open threads

- M010 S02 is implemented and verified but not committed yet.
- Pre-existing uncommitted note remains in `src/runner/risk-classifier.ts` for #21 risk-tier recalibration; do not stage it unless explicitly asked.
- `M009-SUMMARY.md` remains untracked from the prior M009 wrap-up.
- Backlog: `validateFinding` accepts any string `reviewer`; consider normalizing/rejecting model outputs that mislabel their own reviewer role.

## Do not

- Do not commit `src/runner/risk-classifier.ts` unless explicitly asked; it is a separate #21 note.
- Do not reopen PR #9 or work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real Pi review workflow by default.
