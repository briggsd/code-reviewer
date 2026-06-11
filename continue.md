# Continue — AI Code Review Factory / M014 #48+#49 + #60-P1 + #58 + #57-redaction shipped; Opus→Codex AND Opus→Sonnet duos validated; codex-delegate skill + docs/extending.md

## Last action

Long session run almost entirely through the **coordinator/implementer duo** pattern (Claude
coordinates; Codex or a Sonnet subagent implements). Shipped 5 PRs, built + hardened the
`codex-delegate` skill, designed the reviewer-conventions feature, ran an **Opus→Codex vs
Opus→Sonnet A/B**, and added a repo onboarding doc. `main` @ `e05e18f`, synced, gate 208/0.

- **MERGED this session:** PR #55 (#48 runtime-kind tag + trusted-publish upload, `30c8451`),
  PR #59 (#49 aggregation puller, `6f4b188`), PR #61 (#60 P1 reviewer conventions, `2462d60`),
  PR #62 (#58 job-kind tag, `161fba9`), PR #63 (#57 trace redaction slice, `e05e18f`).
  **Closed:** #48, #49, #58. **#56 auto-closed** (stacked base deleted → superseded by #59).
- **#48/#58** added `runtime`/`jobKind` tags to `run_metrics` (shared sanitizers in
  `src/runtime/runtime-kind.ts`). **#49** = `rollupRunMetrics` + `scripts/telemetry-rollup.ts`.
  **#60 P1** = `.ai-review.json` `conventions[]` rendered as sanitized inert prompt data.
  **#57 redaction** = `RedactingTraceSink` (opt-in `--redact-trace`) strips operator prompts
  from `message_start/end` trace content.
- **Codex confabulated tests 2/2 on the hard task (#60)**; coordinator caught it (diff
  reconcile + independent gate) and wrote the tests. **Sonnet subagent (Opus→Sonnet A/B) did
  #58 + #57 in one clean pass each, no confab** — but I gave it tighter specs + it runs
  in-harness (confound). Verdict: in-harness Sonnet for the *implement* loop, cross-provider
  for *review* (decorrelated blind spots). See `codex-delegate` skill + `codex-coordinator-workflow` memory.
- **New durable artifacts:** `docs/extending.md` (test-infra index + integration recipes,
  for fast orientation + subagent specs; linked from CLAUDE.md). `codex-delegate` skill updated
  with the **spec-quality lever** (precedent-pointing + front-loaded test-infra) and the
  **confabulation** rule.

## Next action

1. **#57 remaining (stays OPEN):** (a) **enablement** — redaction is default-off, so wire
   `--redact-trace` into the `trusted-real-review` job (or scope the artifact upload paths);
   (b) **redaction completeness** — extend beyond `message_start/end` `content` to other
   message fields + streaming `content_block_*` events (verify vs real Pi JSON output);
   (c) the original path-scoping/`if: always()`/diff-in-artifact concern. (See #57 comment.)
2. **#60 P2/P3:** P2 = read `conventions` from the **base branch** (the trust guard — until
   then conventions are advisory only); P3 = structured `acknowledgements` + downgrade/gate,
   with #54. Design doc: `docs/reviewer-conventions.md`.
3. **#54 (coordinator precision gate)** — M013; the dedup home for #60's acknowledgement filter
   and the answer to the reviewer's non-determinism / "must-find-something" floor seen all session.
4. **#46 (incremental re-review)** — NOTE: true "delta since previousHeadSha" needs NEW VCS
   plumbing (a prev-head..head diff isn't fetched today); not a clean small slice as-is.
5. **M013 waves** (#26/#27/#28/#29/#33), **M012 parking lot** (#15/#16/#22/#23/#24).
6. **Defer UX:** #41 (heartbeat), #42 (`--pi-api-key`), #20 (re-review analytics).

## State

- `main` @ `e05e18f`, pushed/synced, gate 208/0.
- **Issues open from this session:** #57 (partial — redaction landed; enablement + completeness
  + path-scoping remain), #60 (P1 landed; P2/P3 remain). Both touch security/trust — see comments.
- **Closed:** #48, #49, #58. Filed earlier + still open: #54, #46, #41, #42, #20; M013/M012 backlog.
- All this session's PRs/issues labeled `workflow:claude+gpt-5-codex` where applicable
  (Sonnet ones noted in PR body, not a separate label).
- Working tree (on `main`): clean (`M009-SUMMARY.md` tracked since `2462d60`).

## Open threads

- **Codex auth IS IN API-KEY MODE** (so `gpt-5-codex` works; bills OpenAI platform). Restore
  ChatGPT auth: `cp ~/.codex/auth.json.bak-chatgpt ~/.codex/auth.json`.
- **pi auth STILL IN DOGFOOD MODE** (prior session): `cp ~/.pi/agent/auth.json.bak-preA ~/.pi/agent/auth.json`.
- **`gh` Projects-classic bug:** `gh pr edit` / `gh issue view` (no `--json`) error on
  `projectCards`. Use `gh api` (REST) for mutations + `gh issue view --json`.
- **Parallel-PR conflicts:** two PRs on shared files (cli.ts, state.test.ts) conflict after the
  first merges — rebase the second onto `main`, resolve (usually additive), force-push, merge.
  Also: after a force-push, GitHub lags re-computing mergeability — retry the merge after a beat.
- **Codex confabulation:** over-claims tests + fakes gate output; reconcile summary vs
  `git diff --stat`, confirm test count rose. Sonnet subagents reconciled cleanly but verify anyway.
- **`docs/extending.md`** is the fast-start map (test-infra index + recipes) — read/cite it
  before writing or delegating a change.

## Do not

- Do not allowlist runtime-kind / job-kind / convention values to a closed set — they
  SANITIZE + (for runtime) fall back to `deterministic`, on purpose, so future real runtimes
  (e.g. `opencode`) / freeform operator job-kinds still register. The AI reviewer has pushed
  allowlisting repeatedly; it's wrong for extensibility. `NON_REAL_RUNTIME_KINDS`
  (`src/runtime/runtime-kind.ts`) is the single source for the puller's exclusion set.
- Do not render `conventions` (or any reviewed-repo content) as trusted instructions — only via
  `stringifyPromptData` under the fixed label (principle #6). Until #60 P2 (base-branch read),
  conventions are advisory context, not authority to silence findings.
- Do not treat `RedactingTraceSink` as complete trace protection — it covers only
  `message_start/end` `content` and is default-off (#57 remaining scope).
- Do not drop `thinking` preservation in `PiAgentRuntime.modelArgs` / move `thinking` out of
  `selectModel` (#45/#53). Do not unscale the retry reserve `minimumRemainingMs`. Do not revert
  the CI gate to deferred `process.exitCode` (use `finalizeCiExit`; `test/cli-exit.test.ts`).
- Do not put diff text, finding bodies, prompts, or secrets into telemetry/rollups — counts/
  identifiers only (M008; #50; #57).
- Do not trust an implementer (Codex or subagent) summary's "tests added"/gate claims — verify
  vs `git diff` and re-run `bun run check`. Do not `git add -A` when committing delegated work
  (it swept `M009-SUMMARY.md` in once).
- Do not reopen closed issues #10–#14/#17/#18/#19/#25/#31/#32/#37/#39/#40/#48/#49/#58 or merged
  PRs #9/#47/#53/#55/#56/#59/#61/#62/#63 unless new regressions appear.
- Do not expose provider secrets or disable the real-Pi review workflow's default-off gate.
