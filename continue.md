# Continue — AI Code Review Factory / #54 precision gate + #60 conventions/acknowledgements COMPLETE & CLOSED (9 PRs this session); next = #73 (grounding false-drop fix) / GitLab parity / #28 eval

## Last action

**Big session: 9 PRs merged** (#64/#66/#68/#70/#71/#72/#75 + the #67 fix). Two whole feature lines
shipped — the **#54 precision gate** (prompts + quotedCode contract + evidence-grounding) and **#60
conventions/acknowledgements** (P1+P2+P3, issue CLOSED). `main` @ `60a77a8`, synced, gate **293/0**,
working tree CLEAN.

**The very last thing:** answering "what were the 4 withheld findings on #71/#72?" — inspected the
`grounding.applied` traces and discovered my #54.2 grounding filter **false-dropped LEGITIMATE
findings** (doc-staleness + a markdown-escape concern — they quote *unchanged* code, so the quote
isn't in the diff). Fixed the real doc/comment ones (**PR #75**), and filed the root causes:
**#73** (scope grounding to changed-file findings — the fix) + **#74** (renderer escapes no finding
text). **#73 is the natural next pickup.** Everything below is session history (read top-down).

- **#54-P1 (PR #64):** prompt-only half of #54 — coordinator "validate, don't just fuse"
  directive (3 lines in `buildCoordinatorPrompt`: validate-evidence / **asymmetric skepticism** /
  filter-fabrications-not-just-dedup) + reviewer recall discipline (new `SHARED_MANDATORY_RULES`
  entry "Reporting zero findings is a correct and common result" + a `buildReviewerPrompt`
  "Set confidence honestly…" line). Trusted instruction lines only; #60-P1 conventions untouched.
- **#65 FILED then CLOSED (works-as-designed) — NO bug.** Triaging #64's auto-review (the 47s job
  the user flagged): real Anthropic call, but reviewers emitted bare `{"findings":[]}` in 8–13
  output tokens / 7.6s with no thinking. Initial hypotheses (dropped `thinking` bound; unknown
  model) BOTH **refuted**. **Billed repro settled it:** the exact CI invocation
  (`--runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6`) on a substantive fixture
  (`examples/fixtures/auth-pr.json`) → **719 thinking blocks, 1.5K–3.2K output tokens/agent, 8
  findings (4 critical), ~2m24s**. So model/thinking/runtime/CI all work. **#64's empty review was
  CORRECT** — its diff was trivial (prompt strings + tests, nothing to flag). **Key learning:
  thinking is a CAP, not a floor** — trivial diffs correctly produce fast empty reviews; don't
  re-chase this. #45 test `pi-runtime.test.ts:499` locks the thinking-bound argv. Residual idea
  (deferred, not filed): a *contextual* thin-review observability signal (flag low output relative
  to diff size/risk) — only worth it if a genuinely-degraded run needs distinguishing from a clean
  one. **Repro recipe** (needs `ANTHROPIC_API_KEY`, in `.env`): `set -a; . ./.env; set +a` then
  `bun run src/cli.ts run --fixture <f> --runtime pi --pi-provider anthropic --pi-model
  claude-sonnet-4-6 --output-dir <dir>`; inspect `runs/*/telemetry.jsonl` (per-agent
  `usage.outputTokens`) + `trace.jsonl` (`grep -c '"type":"thinking"'`).

- **#60 CLOSED — acknowledgements (P3) SHIPPED (PRs #71 `fffb872` + #72 `354c03c`, gate 293/0).**
  The whole reviewer-conventions+acknowledgements feature is done (P1 conventions + P2 base-read +
  P3 acknowledgements). **P3a (#71)** = `Acknowledgement` contract + config field + schema +
  `normalizeAcknowledgements` + base-branch read (generalized `resolveBaseConventions` →
  `resolveBaseConfig`, one fetch returns conventions + acknowledgements). **P3b (#72)** = apply:
  `src/runner/acknowledgements.ts` `applyAcknowledgements(findings, acks, now)` — match by path-glob
  (req) + optional category/stableFindingId; **acknowledge** = keep+annotate+EXCLUDE-from-gate;
  **suppress** = remove, BUT a `reviewer:"security"` finding is downgraded to acknowledge (never
  hidden); `expires` (YYYY-MM-DD, inclusive) deactivates. Spine applies after `assignStableFindingIds`,
  recomputes gate over NON-acknowledged findings, annotates summary (`— acknowledged: <reason>`),
  trace `acknowledgements.applied` + counts-only telemetry. Review found a real stale-title-count bug
  (fixed in BOTH grounding + ack blocks: always refresh title when the shown set changes) + doc gaps
  (configuration.md entries added). **#54.2 grounding withheld 4 findings on #72's own review — they
  turned out LEGITIMATE, not fabricated (false-drop; see #73 + the "Last action" note).**
- **#60-P2 conventions trust guard SHIPPED (PR #70, `ea4eeb0`, gate 246/0).** In the VCS provider
  path, `conventions` are now read from the **base/target branch**, not the PR head (principle #6: a
  PR can't grant itself an exception). New `VcsAdapter.readBaseBranchFile?` (GitHub: contents API at
  `?ref=<targetBranch>`, **best-effort** — any non-2xx → undefined, never fails the review);
  `src/runner/base-conventions.ts` `resolveBaseConventions` (base present → authoritative, head
  IGNORED; absent → empty NOT head; no adapter support → keep config = safe P1 degradation);
  `cli.ts` overrides `config.conventions` + counts-only `conventions.resolved` trace. **GitLab
  DEFERRED** (stays P1 advisory — follow-up). Migration: head-only conventions stop counting on
  GitHub → commit `.ai-review.json` to the base branch (documented in `docs/reviewer-conventions.md`).
  Review caught a real best-effort-vs-throw mismatch (fixed) + doc gaps (added). **This unblocks
  #60-P3** (acknowledgements need this trust boundary + #54, both now done).
- **#54.2 evidence-grounding SHIPPED (PR #68, `03e311e`, gate 236/0).** Deterministic post-review
  filter (`src/runner/evidence-grounding.ts`, `assessFindingGrounding`): drops a finding iff its
  verbatim `quotedCode` has a checkable quote (≥8 chars) and NONE substring-matches the changed-file
  corpus. No `quotedCode` → always kept (safety). Spine (`run-review.ts:215`, before stable-ids/
  re-review) recomputes decision/outcome, appends a "N withheld" note, emits `grounding.applied`
  trace + counts-only telemetry. **Hardened through 2 adversarial auto-review rounds:** (r1) skip
  grounding on `diff.truncated`, reword note; (r2) **multi-line quotedCode was always false-dropped**
  (normalize collapsed quote newlines but corpus joined with `\n` → fixed by whole-corpus normalize;
  this could flip a blocking run fail→pass) + **reverted a deleted-line exclusion** that false-dropped
  legitimate *deletion* findings (now all +/-/space lines in corpus; keeping a fabricated-quote-of-
  removed-code is the safe direction). Held: no severity exemption (drop is groundability-based by
  design — U+200B was high-confidence). **Filed #69** (low): grounding-dropped findings can be
  miscounted as "fixed" in re-review (ordering; analytics-accuracy only).
- **Coordinator-budget signal:** #68's auto-review **timed out once** (coordinator hit its 240s cap)
  then converged on re-run. The #54.1 validation directives (PR #64) ask the coordinator to do MORE
  per finding → tighter budget (the #45/#54 tension, now observed live). #54.2 grounding runs
  POST-coordinator so doesn't relieve it. If timeouts recur, tune coordinator `thinking` (medium→low)
  or trim the #54.1 directives — see #45/#54.
- **quotedCode contract SHIPPED (PR #66, `0f6ce6a`, gate 218/0)** — the #54.2 prerequisite.
  Optional, contractually-verbatim `quotedCode?: string[]` on `Finding` (reviewer fills it only for
  line-specific findings, omits for absence findings); `validateFinding` normalizes it (never fails
  a finding); reviewer/coordinator prompts populate+preserve it; output schema optional w/ minItems:1.
  **#54.2 grounding is now UNBLOCKED** — ground `quotedCode` (reliable by contract), not narrative
  `evidence`. Findings without quotedCode are never grounded (safe).
- **#67 FILED + CLOSED (bundled in #66) — pre-existing crash fix.** #66's auto-review *engaged*
  (first real findings-producing review this session) and **crashed**: `validateFinding` passed a
  model `location` through without checking `path`, then `stable-finding-id`'s `normalizePath` did
  `path.trim()` on undefined → `undefined is not an object`. Latent (trivial/empty reviews like #64
  never produced findings). Fixed: `isValidFindingLocation` guard at the trust boundary + defensive
  `normalizePath` guard (fixtures/prior-state) + regression tests. **Lesson: a findings-producing
  real review exercises code paths the local fake-gate + empty reviews never hit** — watch for it.
- **Duo loop caught real issues twice on #66:** (1) the #67 crash (review engaged → crashed →
  I fixed); (2) the re-review found 4 *legitimate* findings (untrimmed quotedCode array entries that
  would break grounding; schema/runtime [] divergence; prompt ordering; misleading JSDoc tense) —
  all fixed in one pass (`f73be5e`), re-review then approved/0 (4 marked fixed). The #54.1 precision
  prompts (PR #64) are visibly helping — well-evidenced findings, not "must-find-something" noise.
- **(Earlier) Slice 2 (#54.2 evidence-grounding) ATTEMPTED → DEFERRED (no merge).** Built the deterministic
  grounding post-filter (drop findings whose cited `evidence` isn't in the diff). Worked
  mechanically (221/0) but the duo caught a **design flaw**: it dropped *legitimate* findings,
  because real `evidence` is **narrative prose** ("The patch returns db.accounts.findById(accountId)
  directly…") or **about-absence** ("no auth check before returning"), not verbatim quotes — neither
  substring-matches the diff. The implementer had masked it by rewriting fixtures to bare quotes.
  Dropping real findings violates principle #1. **Branch deleted, `main` clean.** Decision (user):
  **defer until a verbatim-quote contract exists.** New sequencing: (1) prerequisite slice = add a
  contractually-verbatim `quotedCode: string[]` to `Finding` + reviewer-prompt to populate it; (2)
  THEN ground `quotedCode` (reliable by contract), revisit drop-vs-demote. #54.1 (shipped) covers
  the judgment side meanwhile. Full writeup + reusable spine scaffolding in **#54 comment**
  (`run-review.ts:215` transform, decision recompute via `chooseDecision`, `grounding.applied`
  trace, counts-only telemetry, "N withheld" note).
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

0. **#73 (recommended next) — fix #54.2's false-drop of legitimate findings.** The grounding filter
   drops findings whose `quotedCode` isn't in the diff, which wrongly hides staleness / "you forgot to
   update X" / cross-file findings (it hid 4 real ones on #72 — that's how this was found). Fix: only
   ground a finding whose `location.path` is a CHANGED file; keep the rest; still catch fabricated
   quotes on changed files. Sibling: **#74** (renderer escapes no finding text). Both well-scoped.
1. **Other candidate threads** (#54 + #60 are COMPLETE):
   - **GitLab parity** (small, high-coherence): implement `readBaseBranchFile` on the GitLab adapter
     so #60-P2/P3 trust guard applies to GitLab too (currently degrades to P1 advisory). Mirror the
     GitHub impl (GitLab files API at `?ref=<targetBranch>`). Not yet filed as an issue.
   - **#28 holdout eval** — the measurement counterpart: validate the #54 precision gains (and now
     acks) with no recall regression. Bigger (eval harness + dataset).
   - **#46 incremental re-review** — needs a `prev-head..head` sibling of `readBaseBranchFile`
     (Foundation B continues); carry-forward correctness is the hard part.
   - **#69** (low — grounding/suppress-dropped findings miscounted as "fixed" in re-review).
   - **#57 remaining** (trace-redaction enablement + completeness + artifact path-scoping).
   - **Coordinator-budget** (#45/#54): #68 + #72 auto-reviews each timed out ONCE before converging.
     The #54.1 validation directives raise coordinator load. If timeouts worsen, lower coordinator
     `thinking` (medium→low) or trim the directives.
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
- **MERGED this session (8 PRs):** #64 (#54.1 prompts), #66 (quotedCode contract + #67 fix), #68
  (#54.2 grounding), #70 (#60-P2 conventions trust guard), #71 (#60-P3a ack foundation), #72 (#60-P3b
  ack apply, closed #60). Backend: in-harness Sonnet subagent (Opus 4.8 coordinator) throughout.
- **Issues open:** **#73** (#54.2 grounding false-drops unchanged-code findings — priority:medium,
  good next), **#74** (markdown renderer escapes no finding text — low), #69 (re-review miscount, low),
  #57 (partial), #46 (needs prev-head..head ref read), #28 (holdout eval — validates #54),
  #41/#42/#20 + M013/M012. GitLab-P2/P3 parity not yet filed (degrades safely to P1 advisory).
- **Closed this session:** #60 (conventions+acks complete), #65 (no bug), #67 (location-crash, fixed
  in #66). Prior: #48/#49/#58. #54 substantially complete (open or close at will).
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
  PRs #9/#47/#53/#55/#56/#59/#61/#62/#63/#64/#66/#68/#70/#71/#72 unless new regressions appear. Closed
  issues #60/#65/#67 (this session) likewise stay closed.
- Do not assume #54.2 grounding only drops *fabricated* findings — it ALSO false-drops LEGITIMATE
  findings that quote code NOT in the diff (staleness / "you forgot to update X" / cross-file). Found
  by inspecting `grounding.applied` traces: #72's 4 "withheld" were all real (doc-staleness + a
  markdown-escape concern). Fix tracked in **#73** (scope grounding to changed-file findings). When a
  PR's review shows "N withheld", check the trace (`gh run download … -n ai-review-real-<PR>`,
  `grounding.applied` event) — some may be real. **#74** = renderer escapes no finding text.
- Do not let `suppress` hide a `reviewer:"security"` finding (acknowledgements.ts downgrades it to
  acknowledge on purpose). Acknowledged findings stay in `summary.findings` (annotated) + are excluded
  from the gate only — never silently dropped. Acks come from the BASE branch (provider path), not head.
  Refresh the summary title whenever the shown finding set changes (grounding + ack blocks).
- Do not read `conventions`/`acknowledgements` from the PR head in the VCS path — only from the base
  branch via `readBaseBranchFile` (#60-P2 trust guard). `readBaseBranchFile` is BEST-EFFORT (non-2xx →
  undefined); don't make it throw (a conventions-read hiccup must not fail the review). Head-config
  conventions are intentionally ignored in the provider path (the trust point).
- Do not ground/drop against narrative `evidence` — #54.2 grounds the verbatim `quotedCode` field
  ONLY (`evidence-grounding.ts`). The corpus includes ALL changed lines (+/-/space) and is normalized
  as ONE string (so multi-line quotes match); truncated diffs skip grounding. Don't "optimize" any of
  these back — each guards a real false-drop class found in review (multi-line gate-flip; deletion
  findings; partial corpus). No severity exemption (drop is groundability-based by design).
- Do not ground/drop findings against the narrative `evidence` field (the #54.2 trap). Real
  `evidence` is prose or about-absence, not verbatim quotes → string-matching it false-drops real
  findings (violates principle #1). Grounding requires a contractually-verbatim field
  (`quotedCode`) FIRST. Don't "fix" the resulting test failures by rewriting fixtures to bare
  quotes — that masks the flaw (the implementer did this; it's wrong).
- Do not re-investigate #65 (CLOSED, works-as-designed). Reviewers/thinking/runtime/CI all work;
  thinking is a CAP not a floor → trivial diffs correctly yield fast empty reviews. A fast/empty
  CI review on a small clean PR is EXPECTED, not a regression. Only reopen if a *substantive* diff
  produces an empty/no-thinking review (use the repro recipe in "Last action" to check).
- Do not expose provider secrets or disable the real-Pi review workflow's default-off gate.
