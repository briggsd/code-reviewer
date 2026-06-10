# Continue — AI Code Review Factory / M013 planned & merged; full backlog triaged

## Last action

- **Merged PR #30** (`0cf7500`) and pushed a follow-up directly to main (`1105cab`). `main` is at `1105cab`. Shipped this session:
  - `CLAUDE.md` (agent onboarding map), `M013-ROADMAP.md` (Agent-ready codebase milestone).
  - **Plan-vs-status convention**: roadmaps hold plan/reasoning; GitHub milestones/issues hold live status; no `[x]`/`[ ]` checkboxes. Documented in `CLAUDE.md`; `M013-ROADMAP.md` is the template; `M011-ROADMAP.md` converted; `M011-SUMMARY.md` added.
- **Triaged every open issue** with implementor-ready direction (concrete steps + acceptance criteria; recommendations recorded on the `question`/decision issues).
- Closed **#19** (shipped via M011 S01–S03). Filed **#33** (review-summary layout redesign, from the Cloudflare example). Milestoned **#31→M011**, **#32→M013**.
- Sequenced M013 into waves and folded in **S06→#32 / S07→#33**.

## Next action

```bash
git status --short
gh issue list --state open
read M013-ROADMAP.md   # "Sequencing" section = the wave plan
```

Two good entry points:
- **#31** (re-review recurrence bug) — highest leverage single fix: unblocks M011 #20 S05 *and* M013 #28, and de-risks the re-review feature. Grounded direction in the issue.
- **M013 Wave 1** (cheap, foundational): **#27** boundary lint + **#32** label assertion (#32 also must precede #26). Then Wave 2 (#33→#28), Wave 3 (#26), Wave 4 (#29).

## State

- Branch: `main`, synced with `origin/main` at `1105cab`. Everything from this session is on main.
- Branch `m013-agent-ready-codebase` is fully merged — safe to delete.
- Open issues by milestone (each has an Implementation-direction / recommendation section + acceptance criteria):
  - **M011** — #20 (run-level analytics; blocked-in-practice by #31), #31 (recurrence bug).
  - **M012** parking lot — #15 (tracking), #16/#21/#22 (decisions, recommendations recorded), #23/#24 (low-pri coverage). #21 and #24 are the actionable low-priority ones.
  - **M013** — #26, #27, #28, #29, #32, #33 (sequenced into waves; see roadmap).

## Open threads

- `src/runner/risk-classifier.ts` is modified in the tree (the #21 threshold note) — still intentionally uncommitted. Taking **#21** lifts this guard and commits it.
- `M009-SUMMARY.md` remains untracked — decide keep vs delete.
- Decision issues **#16/#21/#22** carry *my recommendations* in their bodies (keep-imperative / specific thresholds / phase-1-now) — confirm or adjust before implementing.
- #33 (summary layout) is mostly a `summary-markdown.ts` rewrite; the richer per-reviewer synthesis is an optional coordinator follow-up.

## Do not

- Do not commit `src/runner/risk-classifier.ts` unless explicitly taking on #21.
- Do not include `M009-SUMMARY.md` unless explicitly deciding to keep that prior artifact.
- Do not reopen PR #9 or work on the deleted branch `real-review-smoke-pr`.
- Do not reopen closed issues #10/#11/#12/#13/#14/#17/#18/#19/#25 unless new regressions appear.
- Do not expose provider secrets or disable the real Pi review workflow by default.
