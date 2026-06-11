# Continue — AI Code Review Factory / #54-P1 precision prompts shipped (PR #64); filed #65 (real-Pi reviewers not thinking in CI); cross-cutting plan for #54/#60/#57/#46 mapped

## Last action

Mapped the **cross-cutting plan** across the top-4 backlog (#57/#60/#54/#46) into three shared
foundations (see "Cross-cutting plan" below), then shipped **Slice 1** via the duo:
**PR #64 = #54-P1 precision prompts** (`ee66927`, `main` synced, gate **209/0**). Sonnet subagent
implemented cleanly (208→209, reconciled, no confab); coordinator fixed one comment mislabel.

- **#54-P1 (PR #64):** prompt-only half of #54 — coordinator "validate, don't just fuse"
  directive (3 lines in `buildCoordinatorPrompt`: validate-evidence / **asymmetric skepticism** /
  filter-fabrications-not-just-dedup) + reviewer recall discipline (new `SHARED_MANDATORY_RULES`
  entry "Reporting zero findings is a correct and common result" + a `buildReviewerPrompt`
  "Set confidence honestly…" line). Trusted instruction lines only; #60-P1 conventions untouched.
- **⚠️ FILED #65 (priority:high bug) — real-Pi reviewers return empty near-instantly in CI.**
  Triaging #64's auto-review (the 47s job the user flagged): the review WAS real (Anthropic,
  `claude-sonnet-4-6`, $0.06, `stopReason: stop`) but each reviewer emitted bare `{"findings":[]}`
  in **8–13 output tokens** in 7.6s total → **~zero extended thinking happened** (thinking tokens
  count toward output). Prompts were well-formed (full diff reached each agent). Suspected: the
  `--pi-model` `defaultModel` path drops the role's `thinking:"medium"` bound (or Pi doesn't
  translate `--thinking` for this model) — the #45/#53 hazard. NOT caused by #64 (prompt-only).
  Evidence + repro steps in #65. **This is the highest-value next thread** (it nullifies CI review
  assurance and is central to the repo's purpose). Lite tier also (correctly) dropped `performance`.

- **(Prior session) MERGED:** PR #55 (#48 runtime-kind tag + trusted-publish upload, `30c8451`),
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
  for *review* (decorrelated blind spots). See `delegate-implement` skill + `codex-coordinator-workflow` memory.
- **New durable artifacts:** `docs/extending.md` (test-infra index + integration recipes,
  for fast orientation + subagent specs; linked from CLAUDE.md). `delegate-implement` skill updated
  with the **spec-quality lever** (precedent-pointing + front-loaded test-infra) and the
  **confabulation** rule.

## Cross-cutting plan (top-4 backlog → 3 shared foundations)

Reviewed #57/#60/#54/#46 for shared seams (grounded against code). The four collapse into:
- **Foundation A — post-review finding-transform chain** (`run-review.ts:215`,
  `assignStableFindingIds → classifyReReviewFindings`). Both **#54.2** (deterministic
  evidence-grounding filter) and **#60-P3** (acknowledgement downgrade) are new links here; build
  the composable stage once. #60-P3 *depends on #54* per the issue.
- **Foundation B — ref-addressing VCS plumbing.** `VcsAdapter` is single-`ChangeRef` today.
  **#60-P2** needs "read `.ai-review.json` at the base ref"; **#46** needs "diff
  `previousHeadSha..headSha`." Same contract gap — design the extension once.
- **Foundation C — trusted prompt construction** (`pi-agent-runtime.ts`). #54.1/#54.3 (DONE in
  #64) + #60-P1/P2 all edit the same `buildReviewer/CoordinatorPrompt`.
- **#57 is mostly orthogonal** (CI YAML + trace redaction); light coupling = new trace markers
  from #54/#46 must land inside #57's redaction-safe/path-scoped artifact set.

Dependency-ordered slices: **1 (DONE, #64)** → **2** (#54.2 grounding stage + P3 framework) →
**3** (ref plumbing + #60-P2 trust guard) → then **4** (#46) and **5** (#60-P3) both unblock.
#57 enablement anytime; #57 completeness after 2/4 settle trace fields.

## Next action

0. **#65 (priority:high) is the recommended next thread** — real-Pi reviewers do ~no thinking in
   CI (empty 8-token findings). Repro locally with `--runtime pi --pi-model claude-sonnet-4-6`,
   capture the Pi argv to confirm whether `--thinking` is emitted; fix the drop in
   `modelArgs`/`selectModel` (extend the #45 inheritance test to the CLI-override path). High
   leverage: it nullifies CI review assurance. May touch Foundation C code.
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

- `main` @ `ee66927`, pushed/synced, gate **209/0**.
- **MERGED this session:** PR #64 (#54-P1 precision prompts; backend: in-harness Sonnet subagent,
  noted in PR body). **FILED:** #65 (priority:high — real-Pi reviewers not thinking in CI).
- **Issues open:** #65 (NEW, recommended next), #54 (P1 done in #64; #54.2 grounding stage +
  precision-gate remain = Slice 2), #60 (P1 landed; P2/P3 remain = Slices 3/5), #57 (partial —
  redaction landed; enablement + completeness + path-scoping remain), #46 (Slice 4), plus #41/#42/#20
  + M013/M012 backlog. #28 (holdout eval) is the measurement counterpart for #54/#65.
- **Closed (prior):** #48, #49, #58.
- Working tree (on `main`): clean.

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
- **Auditing a real-Pi CI review:** `gh run download <runId> -R briggsd/ai-code-review-factory -n
  ai-review-real-<PR> -D <dir>` pulls the artifact; `runs/*/telemetry.jsonl` has per-agent
  `usage.outputTokens` (8–13 ⇒ empty `{"findings":[]}`, ~no thinking) + `durationMs`; `trace.jsonl`
  has the forwarded Pi message stream (full prompts — see #57). Output-token count is the cheapest
  tell for whether reviewers actually reasoned. `gh run download` needs `-R` outside the repo dir.

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
  PRs #9/#47/#53/#55/#56/#59/#61/#62/#63/#64 unless new regressions appear.
- Do not attribute #65 (reviewers-not-thinking) to the #64 prompt changes — #64 is prompt-only
  and cannot touch thinking plumbing; #65 is pre-existing. The new "zero findings is correct"
  rule is desirable for precision and was NOT the cause of the empty outputs (no thinking ran).
- Do not expose provider secrets or disable the real-Pi review workflow's default-off gate.
