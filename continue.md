# Continue — AI Code Review Factory / M014 #48+#49 shipped, #60 reviewer-conventions P1 shipped, codex-delegate skill built

## Last action

Full session via the **Claude(coordinator) + Codex(gpt-5-codex) duo**: shipped three PRs,
built + hardened the reusable `codex-delegate` skill, and designed/started the per-repo
"reviewer conventions" feature. `main` @ `2462d60`, synced, gate green (194/0).

- **#48 MERGED (PR #55 → `30c8451`)** — `run_metrics` runtime-kind tag (`resolveRuntimeKind`
  sanitizes; shared constants in `src/runtime/runtime-kind.ts`) + `trusted-publish` artifact
  upload.
- **#49 MERGED (PR #59 → `6f4b188`)** — cross-run aggregation puller (`rollupRunMetrics` +
  `scripts/telemetry-rollup.ts`, `bun run telemetry:rollup`).
- **#60 P1 MERGED (PR #61 → `2462d60`)** — per-repo reviewer `conventions`: `.ai-review.json`
  `conventions: string[]`, normalized+bounded (drop non-string/empty, trim, truncate 500,
  cap 50; schema mirrors via maxItems/maxLength), rendered into BOTH reviewer + coordinator
  prompts via `stringifyPromptData` (inert sanitized data under a fixed trusted label — can't
  issue instructions). Removed the dead `projectInstructionsPath` stub. Design:
  **`docs/reviewer-conventions.md`**.
- **`codex-delegate` skill built + hardened.** User `~/.claude/skills/codex-delegate/`
  (portable playbook + `spec-template.md` + `run-codex.sh`); project overlay committed at
  `.claude/skills/codex-delegate/SKILL.md`. Updated with the **confabulation lesson** (Codex
  reliably over-claims tests + fakes gate output; coordinator owns tests + reconciles summary
  vs `git diff`). Memory: `codex-coordinator-workflow.md`.
- **NOTE — `M009-SUMMARY.md` was accidentally committed** into PR #61 via a `git add -A`
  (now tracked on `main` as of `2462d60`). It's a legitimate milestone-summary doc so it was
  kept; flag if it should be `git rm`'d.

## Next action

1. **#60 P2 — base-branch read** for `conventions` (the real trust guard: a PR can't grant
   itself an exception; until then conventions are advisory context only). **#60 P3 —
   structured `acknowledgements`** + downgrade/gate semantics, landed with #54.
2. **#54 (coordinator precision gate)** — M013; the precision counterpart, and the dedup home
   for #60's acknowledgement filter. Motivated by the reviewer's non-determinism + "must-find-
   something" floor seen all session.
3. **#57 (security, med)** — scope CI telemetry artifact uploads (operator prompts in
   trace.jsonl, PR diffs, write-scoped token). **#58 (obs, low)** — dry-run vs trusted-publish
   job-kind tag.
4. **#46 (incremental re-review)** — highest-leverage cost lever; plumbing stored, unused.
5. **M013 waves** (#26/#27/#28/#29/#33/#54), **M012 parking lot** (#15/#16/#22/#23/#24).
6. **Defer UX:** #41 (heartbeat), #42 (`--pi-api-key`), #20 (re-review analytics).

## State

- `main` @ `2462d60`, pushed/synced, gate 194/0. Merged this session: PR #55 (`30c8451`,
  closes #48), PR #59 (`6f4b188`, closes #49), PR #61 (`2462d60`, advances #60). #56 auto-closed
  (stacked base deleted on merge → superseded by #59).
- **New issues this session:** #57 (artifact-scoping security), #58 (job-kind tag), #60
  (reviewer conventions; **P1 done, P2/P3 open**). All labeled `workflow:claude+gpt-5-codex`.
- **Closed:** #48, #49.
- **Open residuals:** #60 (P2/P3), #54, #57, #58, #46, #41, #42, #20; M013 #26/#27/#28/#29/#33;
  M012 parking lot #15/#16/#22/#23/#24.
- Working tree (on `main`): clean (M009-SUMMARY.md now tracked).

## Open threads

- **Codex auth IS IN API-KEY MODE** (so `gpt-5-codex` works; bills OpenAI platform). Restore
  ChatGPT auth: `cp ~/.codex/auth.json.bak-chatgpt ~/.codex/auth.json`.
- **pi auth STILL IN DOGFOOD MODE** (prior session): `cp ~/.pi/agent/auth.json.bak-preA ~/.pi/agent/auth.json`.
- **`gh` Projects-classic bug on this repo:** `gh pr edit` / `gh issue view` (no `--json`)
  error on `projectCards`. Use `gh api` (REST) for mutations + `gh issue view --json`.
- **Stacked-PR merge order:** retarget the child PR onto `main` BEFORE merging+deleting the
  parent's base (deleting the base auto-closes the child, which can't be retargeted). Bit #56.
- **Codex confabulation:** over-claims tests + fakes gate output, esp. on big tasks / hard test
  infra. Coordinator owns tests; reconcile summary vs `git diff --stat`; check test count rose.
  Encoded in the skill.
- `M009-SUMMARY.md` decision: kept (tracked) — `git rm` if undesired.

## Do not

- Do not allowlist runtime-kind values — `resolveRuntimeKind` SANITIZES + falls back to
  `deterministic` so a future real runtime (e.g. `opencode`) still registers as signal. The
  AI reviewer pushed an allowlist 3× on #55; wrong for extensibility. `NON_REAL_RUNTIME_KINDS`
  (`src/runtime/runtime-kind.ts`) is the single source the puller imports — don't duplicate it.
- Do not render `conventions` as trusted instructions — they go ONLY through
  `stringifyPromptData` under the fixed label (untrusted config text must not hijack the
  reviewer; principle #6). Until #60 P2 (base-branch read), treat conventions as advisory
  context, not authority to silence findings.
- Do not drop `thinking` preservation through the dummy→`defaultModel` swap in
  `PiAgentRuntime.modelArgs` (reopens #45); do not move `thinking` inheritance out of
  `selectModel` or re-add explicit `thinking` to role entries (#53).
- Do not remove tier-scaling of the retry reserve (`scaleTimeoutForRiskTier` on
  `minimumRemainingMs`) — `trivial`/`lite` silently stop retrying without it.
- Do not re-introduce deferred `process.exitCode` for the CI gate — use `finalizeCiExit`/
  `process.exit` (guarded by `test/cli-exit.test.ts`).
- Do not put diff text, finding bodies, prompts, or secrets into telemetry/rollups — counts/
  identifiers only (M008; #50 boundary; the #57 concern).
- Do not trust a Codex summary's "tests added" / gate claims — verify against `git diff` and
  re-run `bun run check` yourself.
- Do not reopen closed issues #10–#14/#17/#18/#19/#25/#31/#32/#37/#39/#40/#48/#49 or PRs
  #9/#47/#53/#55/#56/#59/#61 unless new regressions appear. Do not work on deleted branch
  `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real-Pi review workflow's default-off gate.
