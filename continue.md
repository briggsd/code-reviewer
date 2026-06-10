# Continue — AI Code Review Factory / #31 + #32 + --git-diff shipped via dogfood loop

## Last action

- **Merged PR #38** — `--git-diff` local review source. `main` is at `229dd3f`. Lets you review working-tree changes (`git diff <base>`, default HEAD = uncommitted; `--base main` for committed branch work) with `--runtime dummy|pi` and `--output-dir` telemetry/traces, **without opening a PR**. `src/runner/git-diff-source.ts` (injected `GitRunner`, `parseUnifiedDiff`). Hardened over two dogfood/codex rounds: stderr-deadlock, `--base` arg-injection guard, space/non-ASCII (C-quoted UTF-8) path decoding, author-PII default. **Merged despite the real-Pi dogfood check failing on a consistent 11-min `overall timeout 660000ms`** (infra/wall-clock, not findings; dry-run green; content review had passed; `main` unprotected; user OK'd "merge now").
- **Merged PR #35 (fix #31)** and **PR #36 (fix #32)** to `main` (squash).
  - **#31** — stable finding ID no longer hashes volatile model prose (`title`/`body`); keyed on reviewer+category+location only. Collisions disambiguated with a deterministic, content-ordered `#N` ordinal (order-independent, reserves pre-assigned ids); hash input JSON-encoded to stop separator injection. Docs (`re-review-state.md`, `architecture.md`, `M002-ROADMAP.md`) corrected + migration note.
  - **#32** — specialist reviewer label asserted to the dispatched role (`enforceReviewerRole`, normalizes + traces mismatch). Model-emitted finding ids dropped centrally in `validateFinding` so the factory-computed stable id is always authoritative (covers specialist *and* coordinator). Trust boundary documented in `docs/fork-safety.md`.
- **Dogfood loop drove both PRs**: ran the factory's own real-Pi review on each PR, fed the findings back as a second commit per branch before merge. codex used as a pre-commit review gate throughout.
- **Filed #37** (coordinator-emitted reviewer labels not validated against the dispatched role set) — the one substantive residual the dogfood review kept flagging on #36; deliberately out of #32's scope (coordinator spans roles → needs membership validation, not equality). User chose "merge now, track coordinator."

## Next action

```bash
git status --short
gh issue list --state open
read M013-ROADMAP.md   # "Sequencing" section = the wave plan
```

- **#37** (coordinator reviewer-label validation) — direct security follow-up to #31/#32; grounded fix direction in the issue.
- **M013 waves** continue: Wave 1 #27 (boundary lint) remains; #32 done. Then Wave 2 (#33→#28), Wave 3 (#26), Wave 4 (#29).
- **#20** (run-level analytics) is now unblocked — #31 fixed the recurrence signal it depends on.
- **Now dogfood locally with `--git-diff`** instead of opening a PR (much faster loop — see below).

## State

- Branch: `main`, synced with `origin/main` at `229dd3f`. Branches `fix/31-*`, `fix/32-*`, `feat/git-diff-local-source` merged + deleted.
- Open issues: **#37** (new, coordinator labels), **M011** #20 (now unblocked) / #31 (closed), **M013** #26/#27/#28/#29/#33, **M012** parking lot #15/#16/#21/#22/#23/#24.

## Open threads

- `src/runner/risk-classifier.ts` still modified in the tree (the #21 threshold note) — intentionally uncommitted. Taking **#21** lifts this guard.
- `M009-SUMMARY.md` remains untracked — decide keep vs delete.
- **#37** captures the coordinator-label residual; the harder half (detecting in-set valid-but-wrong-role spoofing) may need its own slice + a provenance marker from coordinator → specialist finding.
- `reviewerRoleAdjustments` trace event has no documented schema yet (noted in #37).
- **Real-Pi review overall timeout (660000ms / 11min) is too tight for full-tier reviews of larger PRs** — #38's dogfood check timed out twice on this. Not yet filed; relates to risk-tier over-spend (#21). Candidate: raise `timeouts.overallMs` or right-size full-tier fan-out.
- **Local review loops:**
  - Fast/no-PR (NEW, #38): `bun run src/cli.ts run --git-diff [--base main] --runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6 --output-dir .ai-review --format markdown`. Default base HEAD = uncommitted only; `--base main` for committed branch work; untracked files need `git add -N`. No publish.
  - Against a real PR: same with `--provider github --repo briggsd/ai-code-review-factory --change-id <N> --head-sha $(git rev-parse HEAD)` (no `--publish-summary`).
  - Both write `telemetry.jsonl` + `trace.jsonl` under `.ai-review/runs/<id>/`.

## Do not

- Do not commit `src/runner/risk-classifier.ts` unless explicitly taking on #21.
- Do not include `M009-SUMMARY.md` unless explicitly deciding to keep that prior artifact.
- Do not reopen PR #9 or work on the deleted branch `real-review-smoke-pr`.
- Do not reopen closed issues #10/#11/#12/#13/#14/#17/#18/#19/#25/#31/#32 unless new regressions appear.
- Do not expose provider secrets or disable the real Pi review workflow by default.
