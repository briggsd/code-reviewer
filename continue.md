# Continue — AI Code Review Factory / #47 shipped (full-tier budget + retry-reserve fix); M014 telemetry-egress milestone filed

## Last action

Reviewed PR #47 (`[codex] Bound full-tier review budget`), caught + fixed a correctness bug in review, shipped it, then planned and filed the telemetry-egress milestone the dogfood loop exposed. `main` is at `96be06e`.

- **#47 merged (`96be06e`, squash)** — **bound full-tier review budget.** Raised default `overallMs` 660k→**900k (15 min)**, keeping reviewer 6 min / coordinator 4 min; made retryable reviewer failures reserve `reviewer + coordinator + reserve` of wall-clock before retrying.
- **Review caught a real bug, fixed on the branch before merge (commit `61864e9`, folded into the squash):** the retry guard scaled reviewer/coordinator/overall by risk tier but left `minimumRemainingMs` (the reserve floor, default 2 min) **unscaled**. On `trivial` the unscaled floor pushed the reserve (270k) above the scaled overall ceiling (225k), **silently disabling all reviewer retries**; `lite` was nearly as tight. Fix = `scaleTimeoutForRiskTier(reserve, tier)` at the call site (`src/runtime/pi-agent-runtime.ts:368`), new `riskTierTimeoutScale`/`scaleTimeoutForRiskTier` exports (`src/runner/run-review.ts`). Exported `shouldRetryReviewerFailure` and added guard unit tests that actually exercise the `- elapsedMs` branch (the existing test was tautological: reserve > overall at t=0, so elapsed never decided). Docs corrected (restored the `660000` history figure; added scaled lite/trivial ceilings).
- **Reviewed the AI reviewer's own 6 findings on #47:** 4 fair (the tautological-test gap #1 was the best; doc nits #4/#5/#6), **1 false positive** (#2 — claimed the single-reviewer timeout under-counts the parallel phase, but reviewers share one `reviewerMs` and run via `Promise.allSettled`, so it's correct), 1 cosmetic (#3). The reviewer **missed the actual correctness bug** (unscaled reserve) — that's the dogfood signal motivating M014 below.
- **Filed M014 — Telemetry egress & CI collection (milestone #4)** + issues **#48–#51.** Root problem: PR review telemetry (`ai_review.run_metrics`, `run-review.ts:557–617`) is rich and counts-only, but only lands in a local JSONL → per-PR artifact zip; never aggregated, so we can't gather cross-run signal to improve reviewers. Decision: **artifact-first v1** (no new transport code), **remote centralization phase 2.** Roadmap: `M014-ROADMAP.md` (**UNTRACKED — needs commit**, like M011–M013).

## Next action

1. **Commit `M014-ROADMAP.md` to `main`** (track the spec like M011–M013), and **delete the merged branch** `codex/full-tier-review-budget` (local + remote — it's content-identical to `main`).
2. **#45 (full-tier timeout) — decide close vs keep.** #47 raised the ceiling to 15 min + bounded retries (the budget lever). #45 also mentions "right-size fan-out"; either confirm 15 min suffices via a real-Pi dogfood on a ~500-line PR and close, or keep open scoped to fan-out only. PR #47 did **not** reference #45.
3. **#21 (recalibrate risk thresholds) — priority:high, blocks M013 waves.** Now that full-tier budget is raised, the tier question is the live lever: #21 = "is the tier right?", #45 = "does full fit the budget?".
4. **#46 (incremental re-review)** — highest-leverage cost lever; review only the delta since `previousHeadSha` on re-push (plumbing stored, unused).
5. **M014 v1: #48 (S01) → #49 (S02).** #48 = fix dummy-vs-real capture + `trusted-publish` not uploading + tag runtime kind (CI-yaml + small tag, `risk:low`). #49 = the `gh`-based aggregation puller that turns artifacts into one rolled-up dataset — **the slice that actually delivers "access."** #50 (counts-only boundary) + #51 (remote transport, phase 2) follow.
6. **#20** (re-review analytics) unblocked; **M013 waves** (#27/#33→#28/#26/#29) sit behind #45/#21.
7. **Defer UX:** #41 (heartbeat progress) and #42 (`--pi-api-key`).

## State

- `main` @ `96be06e`, synced. Merged this session: PR #47.
- **New this session:** milestone **M014 #4** + issues **#48** (S01 artifact capture, high), **#49** (S02 puller, high), **#50** (S03 counts-only boundary, med/security), **#51** (S04 remote transport, low). All labeled `observability` (not `inspiration-gap` — that means "gap vs Cloudflare writeup"; M014 is dogfooding-sourced).
- **Open residuals:** #45 (full-tier, med — see Next #2), #46 (incremental re-review, med), #21 (risk thresholds, high), #41 (heartbeat), #42 (`--pi-api-key`), #20 (re-review analytics). M013 #26/#27/#28/#29/#33; M012 parking lot #15/#16/#22/#23/#24.
- Working tree (on `main`): untracked `M009-SUMMARY.md` and `M014-ROADMAP.md`.

## Open threads

- **`M014-ROADMAP.md` untracked** — commit it to `main` so the milestone spec is in-repo (Next #1).
- **Merged branch `codex/full-tier-review-budget`** still exists locally + on origin; safe to delete (squashed into `96be06e`, tree-identical).
- **pi auth (carried from prior session — VERIFY before next live dogfood):** the `anthropic` OAuth block was removed from `~/.pi/agent/auth.json` so pi bills the `.env` `ANTHROPIC_API_KEY`; backup at `~/.pi/agent/auth.json.bak-preA`. **Restore when done dogfooding** (`cp ~/.pi/agent/auth.json.bak-preA ~/.pi/agent/auth.json`). #42 fixes this in-product.
- `M009-SUMMARY.md` still untracked — decide keep vs delete.
- Re-review optimization map (Cloudflare parity): classification ✅ (M002/#31), analytics 📋 #20, telemetry egress 📋 M014/#48–#51, inline *actions* 📋 deferred in #15, incremental 📋 #46.
- **Local review loops** (`--git-diff`): `bun run src/cli.ts run --git-diff [--base main] --runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6 --output-dir .ai-review --format markdown`. Default base HEAD = uncommitted; `--base main` for committed branch work; untracked files need `git add -N`. Full budget is now 15 min, but whole-tree diffs can still be slow — narrow the diff for a clean run. Writes `telemetry.jsonl` + `trace.jsonl` under `.ai-review/runs/<id>/`.

## Do not

- Do not remove the tier-scaling of the retry reserve (`scaleTimeoutForRiskTier` on `minimumRemainingMs`) — without it `trivial`/`lite` silently stop retrying; guarded by the `shouldRetryReviewerFailure` unit tests and `scaleTimeoutForRiskTier` test.
- Do not re-introduce deferred `process.exitCode` for the CI gate — use `finalizeCiExit` / `process.exit` (partial-timeout fail-closed guarantee depends on it; guarded by `test/cli-exit.test.ts`).
- Do not include `M009-SUMMARY.md` in a commit unless explicitly deciding to keep that prior artifact.
- Do not put diff text, finding bodies, prompts, or secrets into telemetry payloads — counts/identifiers only (the M014 #50 boundary; the M008 rule).
- Do not reopen PR #9 or work on the deleted branch `real-review-smoke-pr`.
- Do not reopen closed issues #10–#14/#17/#18/#19/#25/#31/#32/#37/#39/#40 (and PR #47) unless new regressions appear.
- Do not expose provider secrets or disable the real Pi review workflow's default-off gate.
