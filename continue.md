# Continue — AI Code Review Factory / M014 #48+#49 SHIPPED via Claude+Codex duo; codex-delegate skill created

## Last action

Ran the **Claude(coordinator) + Codex(gpt-5-codex, implementer)** workflow end-to-end to ship
two M014 telemetry slices, survived two AI-review rounds each, **merged the stack to `main`**,
filed the deferred findings, and **packaged the workflow as the `codex-delegate` skill**.
`main` @ `6f4b188`, synced, gate green (190/0).

- **#48 MERGED (PR #55 → `30c8451`).** `run_metrics` telemetry now carries a top-level
  `runtime` kind tag (`pi`/`dummy`/`deterministic`) on **both** completed + failed emit paths,
  sourced from `AgentRuntime.name` via `resolveRuntimeKind()` (sanitizes: trim → strip control
  chars → trim → cap 64; falls back to `"deterministic"`). `trusted-publish` CI job now uploads
  `ai-review-trusted-<n>` (was dropping telemetry). Shared constants in
  **`src/runtime/runtime-kind.ts`**: `DUMMY_RUNTIME_KIND`, `DETERMINISTIC_RUNTIME_KIND`,
  `NON_REAL_RUNTIME_KINDS`.
- **#49 MERGED (PR #59 → `6f4b188`; superseded auto-closed #56).** Cross-run aggregation puller:
  pure **`rollupRunMetrics`** (`src/state/run-metrics-rollup.ts`, counts-only, excludes
  `NON_REAL_RUNTIME_KINDS` + untagged) + on-demand **`scripts/telemetry-rollup.ts`**
  (`bun run telemetry:rollup`) that pulls last-N runs' `ai-review*` artifacts and filters by the
  runtime tag, not artifact name.
- **Codex workflow:** 5 codex runs, each coordinator-reviewed + independently gated. Lessons:
  gpt-5-codex needs **API-key auth** (not ChatGPT); codex **yields after exploration** unless the
  spec forces "implement to completion"; `codex exec resume` drops `-C`/`-s` (use fresh `exec`).
  Coordinator judgment beat the reviewer (held the allowlist push 3×; sanitize+extensible won).
- **`codex-delegate` skill created** (user `~/.claude/skills/codex-delegate/` = portable playbook +
  `spec-template.md` + `run-codex.sh`; project `.claude/skills/codex-delegate/SKILL.md` = repo pins).
  Memory: `codex-coordinator-workflow.md`.

## Next action

1. **Smoke-test `/codex-delegate`** on a small real task — **#58** (job-kind tag) is the candidate.
2. **#57 (security, med)** — scope CI telemetry artifact uploads (operator prompts in trace.jsonl,
   PR diffs, write-scoped token). **#58 (obs, low)** — dry-run vs trusted-publish job-kind tag.
   Both filed this session from PR #55 review's deferred findings.
3. **#54 (coordinator precision gate)** — M013; directly motivated by the reviewer's non-determinism
   + "must-find-something" floor observed across the #55/#56 review rounds this session.
4. **#46 (incremental re-review)** — highest-leverage cost lever; plumbing stored, unused.
5. **M013 waves** (#27/#33→#28/#26/#29) and **M012 parking lot** (#15/#16/#22/#23/#24).
6. **Defer UX:** #41 (heartbeat), #42 (`--pi-api-key`), #20 (re-review analytics).

## State

- `main` @ `6f4b188`, pushed/synced, gate 190/0. Merged this session: PR #55 (`30c8451`, closes #48),
  PR #59 (`6f4b188`, closes #49). #56 auto-closed (its stacked base `codex/48` was deleted on merge).
- **New issues this session:** **#57** (artifact-scoping security, med), **#58** (job-kind tag, low).
  Both labeled `workflow:claude+gpt-5-codex`.
- **Closed:** #48, #49.
- **Open residuals:** #54 (precision gate), #46 (incremental re-review), #57, #58, #41, #42, #20;
  M013 #26/#27/#28/#29/#33/#54; M012 parking lot #15/#16/#22/#23/#24.
- Working tree (on `main`): untracked `M009-SUMMARY.md`; the project skill
  `.claude/skills/codex-delegate/SKILL.md` (committing this session).

## Open threads

- **Codex auth IS IN API-KEY MODE** (switched so `gpt-5-codex` works; bills OpenAI platform).
  Restore ChatGPT auth: `cp ~/.codex/auth.json.bak-chatgpt ~/.codex/auth.json`. (#42 is the in-product fix on the pi side.)
- **pi auth STILL IN DOGFOOD MODE** (prior session): `cp ~/.pi/agent/auth.json.bak-preA ~/.pi/agent/auth.json`.
- **`gh` Projects-classic bug on this repo:** `gh pr edit` / `gh issue view` (no `--json`) error on
  `projectCards`. Use `gh api` (REST) for mutations + `gh issue view --json`.
- **Stacked-PR merge order:** retarget the child PR onto `main` BEFORE merging+deleting the parent's
  base branch (deleting the base auto-closes the child, which can't then be retargeted). This bit #56.
- `M009-SUMMARY.md` still untracked — decide keep vs delete.
- Two `codex-delegate` skills (user portable + project overlay, same name) — project wins in this repo.

## Do not

- Do not allowlist runtime-kind values to a closed set — `resolveRuntimeKind` SANITIZES + falls back
  to `deterministic` on purpose so a future real runtime (e.g. `opencode`) still registers as signal.
  The AI reviewer pushed an allowlist 3× across #55; it is wrong for extensibility. `NON_REAL_RUNTIME_KINDS`
  (`src/runtime/runtime-kind.ts`) is the single source the puller imports — do not duplicate the set.
- Do not drop the `thinking` preservation through the dummy→`defaultModel` swap in
  `PiAgentRuntime.modelArgs` (reopens #45 non-convergence; guarded by modelArgs test). Do not move
  `thinking` inheritance out of `selectModel` or re-add explicit `thinking` to role entries (#53).
- Do not remove tier-scaling of the retry reserve (`scaleTimeoutForRiskTier` on `minimumRemainingMs`)
  — without it `trivial`/`lite` silently stop retrying.
- Do not re-introduce deferred `process.exitCode` for the CI gate — use `finalizeCiExit`/`process.exit`
  (partial-timeout fail-closed; guarded by `test/cli-exit.test.ts`).
- Do not put diff text, finding bodies, prompts, or secrets into telemetry/rollups — counts/identifiers
  only (M008; the #50 boundary; the #57 concern).
- Do not include `M009-SUMMARY.md` in a commit unless explicitly deciding to keep it.
- Do not reopen closed issues #10–#14/#17/#18/#19/#25/#31/#32/#37/#39/#40/#48/#49 or PRs #9/#47/#53/#55/#56/#59
  unless new regressions appear. Do not work on deleted branch `real-review-smoke-pr`.
- Do not expose provider secrets or disable the real-Pi review workflow's default-off gate.
