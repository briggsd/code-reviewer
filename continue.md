# Continue — AI Code Review Factory / #37 + #40 + #39 shipped; timeout/over-spend hardened

## Last action

Drove a review + dogfood loop that landed three security/resilience fixes on `main` and filed the residuals. `main` is at `a42dc3b`.

- **#37 merged (`6b6eaec`)** — coordinator reviewer-label validation. `enforceCoordinatorReviewerRoles` membership-checks coordinator finding labels against `coordinator` + dispatched roles; out-of-set → normalized to `coordinator` + `reviewerRoleAdjustments` trace; stable IDs never keyed on an attacker-chosen role. (Follow-up to #31/#32.)
- **#40 merged (`46137a3`, PR #43)** — **bound reviewer effort by risk tier.** Tier-coupled tool policy (`lite`/`trivial` get no repo-crawl tools) + tier-scaled timeouts (`scaleTimeoutsForRiskTier`: full 1×, lite 0.5×, trivial 0.25×). Adds **partial-on-timeout**: a fired overall timeout publishes completed reviewer findings as a partial summary that **always carries `decision: review_failed` / `outcome: fail`**, so the fail-open/closed CI policy still governs. **Caught + fixed a blocker in review:** the partial path left an outstanding Pi subprocess handle, so deferred `process.exitCode` was force-exited to 0 by Bun → fail-closed gate silently passed. Fix = `finalizeCiExit()` → explicit `process.exit(code)` after sinks flush (`src/cli/ci-exit.ts`), proven with a process-level repro + a lingering-handle regression test (`test/support/partial-timeout-cli-harness.ts`).
- **#39 merged (`a42dc3b`, PR #44)** — **surface Pi provider error envelopes.** `{"type":"error",...}` (e.g. "out of extra usage") is now detected per-line in `readJsonlStream` **before** the parse path, thrown as `ProviderRuntimeError`, and classified `provider_error`. Previously masked as `Unexpected identifier "Finding"`. Classifier refined (review nits folded in): terminal quota/billing/bad-request rejections rank above the 429/transient branches (so a 429 `insufficient_quota` or an out-of-usage msg containing "try again" is terminal), while generic/unknown envelopes stay below transient so `overloaded_error` still retries.

**Dogfood found all of this** via `--git-diff --runtime pi`. The session's debugging detour: pi authenticates from `~/.pi/agent/auth.json` (Claude subscription OAuth) in preference to the `ANTHROPIC_API_KEY` the factory forwards — see pi-auth note below.

## Next action — fix the cost before building more

1. **#45 (full-tier reviews still exceed the 11-min budget) — priority:medium, the live residual.** #40 only scaled `lite`/`trivial`; `full` keeps the 11-min budget, so moderate PRs (≈500 lines) still time out — now *survivable* (partial + correct fail-closed gate) but not *fitting*. Right-size full-tier fan-out / raise `full` `overallMs` / lean on #21.
2. **#21 (recalibrate risk thresholds) — priority:high, blocks the M013 waves.** Sequence with #45: #21 = "is the tier right?", #45 = "does full complete in budget?".
3. **#46 (incremental re-review) — the highest-leverage lever on #45.** Review only the delta since `previousHeadSha` on re-push (plumbing already stored, unused). Cuts iterative-PR cost directly.
4. **#20** (re-review analytics) unblocked. **M013 waves** (#27/#33→#28/#26/#29) sit behind #45/#21.
5. **Defer UX:** #41 (heartbeat progress) and #42 (`--pi-api-key`) — make dogfooding pleasant once the tool is reliable.

## State

- `main` @ `a42dc3b`, synced. (Local `main` had diverged on the pre-squash #40 commit; realigned to origin.)
- **Open issues filed/handled this session:** #39 (closed/merged), #40 (closed/merged), #45 (full-tier timeout, med), #46 (incremental re-review, med), #41 (heartbeat), #42 (`--pi-api-key`), #21 (bumped low→high, blocks M013). Plus pre-existing M013 #26/#27/#28/#29/#33, M012 parking lot #15/#16/#22/#23/#24, #20.
- Working tree: only untracked `M009-SUMMARY.md`.

## Open threads

- **pi auth (ACTIVE local state):** removed the `anthropic` OAuth block from `~/.pi/agent/auth.json` so pi uses the `.env` `ANTHROPIC_API_KEY`. Backup: `~/.pi/agent/auth.json.bak-preA`. **Interactive pi now bills the API key; restore the backup when done dogfooding** (`cp ~/.pi/agent/auth.json.bak-preA ~/.pi/agent/auth.json`). #42 fixes this in-product.
- **The #21 risk-classifier note is now committed** (reworded into a tracked reference comment via #40). The old "do not commit `risk-classifier.ts`" guard is **obsolete** — CLAUDE.md still carries that stale gotcha; update it when convenient.
- `M009-SUMMARY.md` still untracked — decide keep vs delete.
- Re-review optimization map (Cloudflare parity): classification ✅ (M002/#31), analytics 📋 #20, inline *actions* 📋 deferred in #15, incremental 📋 #46.
- **Local review loops** (`--git-diff`): `bun run src/cli.ts run --git-diff [--base main] --runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6 --output-dir .ai-review --format markdown`. Default base HEAD = uncommitted; `--base main` for committed branch work; untracked files need `git add -N`. Whole-tree diffs hit #45's timeout — narrow the diff for a clean run. Writes `telemetry.jsonl` + `trace.jsonl` under `.ai-review/runs/<id>/`.

## Do not

- Do not include `M009-SUMMARY.md` unless explicitly deciding to keep that prior artifact.
- Do not re-introduce deferred `process.exitCode` for the CI gate — use `finalizeCiExit` / `process.exit` (the partial-timeout fail-closed guarantee depends on it; guarded by `test/cli-exit.test.ts`).
- Do not reopen PR #9 or work on the deleted branch `real-review-smoke-pr`.
- Do not reopen closed issues #10–#14/#17/#18/#19/#25/#31/#32/#37/#39/#40 unless new regressions appear.
- Do not expose provider secrets or disable the real Pi review workflow by default.
