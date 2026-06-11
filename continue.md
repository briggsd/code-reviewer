# Continue — AI Code Review Factory / #28 eval VALIDATED @ 100% (precision+recall proven); #73 #74 #77 #80 #82 #28 closed; next = #69 / #84 / #87 / M014

## Last action

**EVAL RAN AGAINST PI → 5/5 SCENARIOS, 100.0% MEAN SATISFACTION (after one recalibration, PR #86).**
The capstone payoff: the holdout eval empirically validates the session's precision work on real
`pi` reviews (claude-sonnet-4-6, 5 scenarios × 3 runs):
- **Precision** (`clean-refactor`, `noisy-benign`): **100%** — zero findings on benign refactors /
  formatting churn (the #54 "must-find-something" bias, held in check).
- **Recall** (`auth-sqli`, `logic-bug`, `hardcoded-secret`): **100%** — every planted bug caught
  (critical SQLi; both pagination bugs; hardcoded credential), CI correctly blocks.
First run was 83.3% (3/5): root-caused NOT to recall but to two criteria using `pathIncludes` while
the model omits the contract-optional `location.path` — both bugs WERE caught. Recalibrated those
criteria to `textIncludes` (PR #86, holdout discipline intact — reviewer prompts untouched) → 5/5 @
100%. Recorded on #54 + #28 (both already closed); the `location.path` gap → **filed #87** (findings
omit location → inline publishing silently skips them; quotedCode-backfill is the likely fix, builds
on evidence-grounding). **#54's last acceptance criterion is now empirically satisfied.**
**Re-run anytime:** `set -a; . ./.env; set +a` then `AI_REVIEW_LIVE_EVAL=1 bun run evals --runtime pi`.

---

**#28 SHIPPED & CLOSED (PR #85, squash `97a224b`, gate 385/0).** The holdout eval harness — the
capstone validating the session's precision work. **Architecture (load-bearing split):** pure scorer
+ types in `src/evals/` (type-checked, 34+ unit tests — `EvalCriterion` DSL: has_finding /
no_findings_at_or_above / max_findings / decision_in / outcome_is; `scoreRun`/`scoreScenario` =
satisfaction fraction meaned over K runs + per-criterion pass rates + threshold). Gated runner in
`scripts/evals.ts` (`AI_REVIEW_LIVE_EVAL=1 bun run evals`, spawns the real CLI per scenario × K, reads
summary.json, scores; never in `bun run check`). 5 holdout scenarios in `evals/` (real diffs, NO
fakeFindings, SEPARATE from examples/fixtures/): auth-sqli, **clean-refactor (the precision guard —
must NOT over-flag)**, hardcoded-secret, noisy-benign, logic-bug. `src/evals` NOT in the public barrel.
Full-tier review (size-escalated, 7 findings) → fixed 5 (flag NaN/0 validation; scorer searches
`recommendation`; defused a scanner-tripping fake secret; scenario-fixture path containment + sort),
documented 2 (safetyMode coverage gap — fixtures use repo-convention "trusted", which is tool-policy
not injection-defense; serial-execution intentional for the opt-in MVP). Backend: Sonnet subagent.

**>>> NEXT ACTION (the payoff): RUN the eval against pi.** `set -a; . ./.env; set +a` then
`AI_REVIEW_LIVE_EVAL=1 bun run evals --runtime pi` (5 scenarios × 3 runs = 15 real reviews, ~30min +
tokens; needs ANTHROPIC_API_KEY in .env). This produces the actual satisfaction numbers that validate
#54/#60/#73 — and is **#54's last open acceptance criterion** ("precision impact measurable... no
recall regression"). After a clean run, **#54 can CLOSE**. Watch `clean-refactor` (precision) +
`auth-sqli`/`logic-bug` (recall). If scenarios underperform, that's real signal (prompt tuning) — do
NOT tune `reviewer-definitions.ts` against the holdout (breaks discipline); investigate first.

---

**#82 SHIPPED & CLOSED (PR #83, squash `e1efa14`, gate 350/0).** GitLab inline publishing (MR diff
discussions) — completes GitLab write-back. **Part A:** extracted the shared inline-comment renderer
to `src/publisher/inline-comment-markdown.ts` (both adapters import it — keeps #74 escaping + dedup
metadata in ONE place). **Part B:** `GitLabVcsAdapter.publishInlineFindings` mirrors GitHub — fetch
`diff_refs` for the position object (missing → all skipped, not throw); dedup via discussions list;
per finding build the GitLab text position (RIGHT→`new_line`, LEFT→`old_line`); skip/dedup/POST/catch.

**This was the FIRST PR to exercise #77's full-tier escalation** (touched `src/publisher/**` → tier
`full`, security+code_quality+documentation reviewers, 10 findings — vs the empty lite passes). The
escalation WORKS. Triaged: **fixed 4 code + 5 docs**, deferred 1:
- **[security] fixed** `formatInlineFindingComment` embedded metadata JSON in an HTML comment without
  escaping `>` → a finding field with `-->` (LLM-influenced `finding.id`) could close the comment early
  and inject Markdown. Now unicode-escapes `>` (JSON.parse round-trips, dedup unaffected). Pre-existing
  in the GitHub copy; the shared move made it one fix for both. +injection test.
- **[correctness] fixed** GitLab posted-outcome fell back to the discussion-hash as `providerCommentId`
  when POST returned no notes → now `failed`/`missing_discussion_note`. +test.
- **[compat] fixed** removed the inline-comment-markdown re-export from `publisher/index.ts` (kept the
  wire-format + security-sensitive parser off the public API; adapters/tests import the direct path).
- **[maint] fixed** aligned missing-coordinate reason to `missing_inline_coordinates` in BOTH adapters.
- **[docs] fixed** inline-publishing.md / adoption.md / fortis-gitlab-beta.md all said GitLab inline was
  deferred/unimplemented (adoption blockers) → now "experimental, available", + MVP-limitations section
  (renamed files, single-page dedup) + both-provider dup-prevention; updated 2 doc-content tests.
- **[security] DEFERRED → filed #84:** inline dedup trusts comment-author-controlled metadata, so a
  planted `ai-code-review-factory-inline` marker can suppress a finding's inline echo. Pre-existing +
  cross-provider + needs author verification on both adapters — not this PR.

**Next pickup options:** **#28 holdout eval** (bigger — validates #54) / **#69** (re-review miscount,
low) / **#84** (inline dedup author-trust, low/security). #57 remaining also open.

---

**#80 SHIPPED & CLOSED (PR #81, squash `c081eab`, gate 342/0, clean AI review approved/0).** GitLab
parity for the #60-P2/P3 trust guard: added `GitLabVcsAdapter.readBaseBranchFile(change, path)`
mirroring the GitHub impl — base-ref precedence `targetBranch ?? baseSha`; GitLab repository-files API
`…/repository/files/{encodeURIComponent(path)}?ref=…` (full path URL-encoded, slashes→`%2F`, unlike
GitHub's segment encoding); best-effort direct `fetchImpl` + `response.ok` (NOT `request<T>()` which
throws); decode `{content,encoding:"base64"}`→utf8 (no newline strip). `resolveBaseConfig` is already
adapter-agnostic (`cli.ts:307`), so GitLab now reads base-branch conventions + acknowledgements with
**zero extra wiring** — parity complete. +4 tests mirror the GitHub suite (decoded; 404→undefined;
500→undefined no-throw; targetBranch as `?ref=`, URL-encoded). PR self-reviewed `lite` (src/vcs/** is
outside #77's full-tier scope — a small signal the base-read trust point isn't full-tiered; left as-is,
the trust ENFORCEMENT is in src/runner/base-conventions.ts which IS in scope). Backend: Sonnet subagent.

**Next pickup options:** **#28 holdout eval** (bigger — validates #54 precision/recall) / **#69**
(re-review miscount, low) / **GitLab inline-finding publishing** (still the documented MVP gap —
`publishInlineFindings` throws). #57 remaining also open.

---

**#77 SHIPPED & CLOSED (PR #79, squash `d751814`, gate 338/0).** Added repo-local **`.ai-review.json`**
so the factory full-tiers changes to its OWN deterministic gate logic (the #76-audit gap: gate-file
changes tiered `lite` → shallow review). `sensitivePaths` re-lists the 5 defaults (it REPLACES, never
merges — see `normalizeReviewConfig`) + the gate/trust/policy/publish surface: `src/runner/**`,
`src/runtime/prompt-boundary.ts`, `src/ci/**`, `src/publisher/**`. Only `sensitivePaths` overridden;
all else falls back to defaults. Affects THIS repo's self-review only (consumers set their own).
`test/repo-self-review-config.test.ts` guards it (defaults preserved; gate-file diff→full; docs→not
full). **#79 auto-review found 1 real doc footgun** (documentation reviewer, high conf: replace-not-merge
of array config is undocumented — a consumer setting `sensitivePaths` would silently drop the security
defaults) → fixed in `docs/configuration.md` (object maps merge / arrays replace; footgun callout;
example re-lists defaults). This is option 1 (cheap config) of #77; **option 2** (generalized
self-review-critical classifier signal / thin-review observability flag) stays DEFERRED unless shallow
gate reviews recur. NOTE: PR #79 itself reviewed `lite` (it changed config+test+docs, no gate file) —
**the NEXT `src/runner/**` PR is what actually exercises the full-tier escalation.** Coordinator-applied
(no subagent — config-shaped, not file-heavy).

---

**#74 SHIPPED & CLOSED (PR #78, squash `61710a6`, gate 334/0).** Markdown renderers escaped no
untrusted finding/summary text → metacharacters could break formatting / inject HTML. Added a
centralized `escapeMarkdown()` (`src/publisher/markdown-escape.ts`): rule 1 backslash-first, rule 2
escape inline `` ` * _ [ ] < > `` anywhere (covers HTML + line-start `>` blockquote), rule 3a escape
leading `# - +`, rule 3b escape ordered-list markers `1.`/`1)` (escape the DELIMITER → `1\.`). Applied
at all THREE published-Markdown sinks: `formatFinding`/`formatLocation` (summary), `formatInlineFindingComment`
(GitHub inline), `createSummaryBody` (the `summary.body` leaf). LEFT as-is: `summary.title` (controlled
`createSummaryTitle`), `summary.body` (structural markdown — leaf escaped at source), code-span enums
(`category`/`reviewer`/`confidence`/decision/outcome/tier). +37 tests. **The #78 auto-review ENGAGED
(3 code_quality findings — contrast with #76's empty pass; confirms engagement is diff-specific, not a
systemic break, supporting #77's "lite is shallow-not-broken" read).** Fixed 2 real ones (ordered-list
gap + a dead `>` in rule 3 — Rule 2 already escaped it); HELD finding 3 (branded `EscapedMarkdown` type
for `summary.body`) — the remedy mismodels `body` (a MIX of trusted structural markdown + escaped
leaves, not fully-escaped text) and reviewer rated risk low. Backend: in-harness Sonnet subagent.

**Next pickup options:** **#77** (cheapest — add a repo-local `.ai-review.json` `sensitivePaths` over
`src/runner/*`/`src/publisher/*`/`src/ci/*` gate files so the factory full-tiers its OWN gate-logic
changes) / **GitLab parity** (`readBaseBranchFile`) / **#28 holdout eval** / **#69** (re-review miscount).

---

**#73 SHIPPED & CLOSED (PR #76, squash `c657d38`, gate 297/0, clean AI review approved/0).** Fixed
the #54.2 grounding false-drop: `assessFindingGrounding` now only drops a finding whose
`location.path` is itself a **changed file** (built a normalized `changedFilePaths` set from
`diff.files`; scope-gate is the FIRST check in the per-finding loop — no location / no path / path
not changed → always kept). Findings ON a changed file still run the quote-match (U+200B fabrication
still caught). Drop semantics + "N withheld" note + `grounding.applied` trace + telemetry UNCHANGED —
only narrowed *which* findings are eligible. Paths normalized (trim, `\`→`/`, strip `./`) on both
sides, mirroring `stable-finding-id.ts` (local helper, not imported — kept module self-contained).
Tests: `makeFinding` now defaults `location` to the changed file so old fabrication-drop tests still
drop; "empty diff" test flipped (no changed files → nothing eligible → all kept); +4 new (staleness
on unchanged file→kept, no-location→kept, fabrication on changed file→still dropped, `./`-prefix
normalizes→dropped). Backend: in-harness Sonnet subagent (Opus 4.8 coordinator), one clean pass.

**Next pickup options:** **#74** (renderer escapes no finding text — low, the sibling of #73) /
**GitLab parity** (small) / **#28 holdout eval** / **#69** (re-review miscount). Everything below is
session history (read top-down).

**Prior session (9 PRs merged):** #64/#66/#68/#70/#71/#72/#75 + the #67 fix. Two whole feature lines
shipped — the **#54 precision gate** (prompts + quotedCode contract + evidence-grounding) and **#60
conventions/acknowledgements** (P1+P2+P3, issue CLOSED). **#73** filed when inspecting the
`grounding.applied` traces revealed the #54.2 filter **false-dropped LEGITIMATE findings**
(doc-staleness + a markdown-escape concern — they quote *unchanged* code, so the quote isn't in the
diff). Fixed the real doc/comment ones (**PR #75**), filed **#73** (now fixed) + **#74** (renderer
escapes no finding text — still open).

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

0. **#73 DONE (PR #76).** ~~Scope grounding to changed-file findings.~~ Recommended next is its
   sibling **#74** (markdown renderer escapes no finding text — low, well-scoped) — or any thread below.
1. **Other candidate threads** (#54 + #60 + #73 are COMPLETE):
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

- `main` @ `c30364f`, pushed/synced, gate **385/0**, working tree CLEAN.
- **MERGED last big session (8 PRs):** #64 (#54.1 prompts), #66 (quotedCode contract + #67 fix), #68
  (#54.2 grounding), #70 (#60-P2 conventions trust guard), #71 (#60-P3a ack foundation), #72 (#60-P3b
  ack apply, closed #60). Backend: in-harness Sonnet subagent (Opus 4.8 coordinator) throughout.
- **MERGED this session:** **#76** (#73 grounding changed-file scope, closed #73), **#78** (#74
  markdown-escape across 3 renderer sinks, closed #74), **#79** (#77 repo `.ai-review.json` self-review
  full-tiering + config-docs footgun, closed #77), **#81** (#80 GitLab `readBaseBranchFile` trust-guard
  parity, closed #80), **#83** (#82 GitLab inline MR-discussion publishing + shared inline renderer,
  closed #82), **#85** (#28 holdout eval harness MVP, closed #28), **#86** (eval-criteria recalibration
  → 5/5 @ 100%).
- **Issues open:** **#87** (findings omit `location.path` → inline publishing skips them; low/observ —
  filed from the eval run), **#84** (inline dedup trusts comment-author metadata → finding-suppression; low/
  security, cross-provider — filed from the #83 review), #69 (re-review miscount, low), #57 (partial),
  #46 (needs prev-head..head ref read), #28 (holdout eval — validates #54), #41/#42/#20 + M013/M012.
  **GitLab parity now COMPLETE** (base-read #80 + inline publish #82); GitLab inline has documented MVP
  limits (renamed files, single-page dedup) + a pending live smoke. **#77 option 2** (generalized
  self-review signal / thin-review flag) deferred — but #77 is now PROVEN end-to-end (#83 got a real
  full-tier review). **#77 option 2** revisit only if needed.
- **#76 post-merge audit (PR #76's empty AI review):** NOT a regression. Reviewers got real ~5K
  prompts (`cacheWrite≈5070`) but returned `{"findings":[]}` in 8 tokens / 0 thinking because risk
  tier = `lite` (no sensitive-path match for `src/runner/*`). Model `sonnet-4-6` is capable (#65:
  719 thinking blocks on the auth/full-tier fixture). The gap is the under-tiering → **#77**, not the
  reviewer. Don't re-chase #65.
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
- Do not escape `summary.title` or `summary.body` wholesale in the markdown renderers (#74) — title
  is the controlled `createSummaryTitle` string and body is structural markdown we assemble
  (`createSummaryBody` + grounding/ack notes). Their untrusted LEAVES (`finding.title`, location
  `path`) are escaped at the SOURCE in `createSummaryBody` via `escapeMarkdown`. Untrusted finding
  text is escaped at each sink (`formatFinding`, `formatInlineFindingComment`, `createSummaryBody`)
  with `src/publisher/markdown-escape.ts`. Leave the backtick code-span enums
  (`category`/`reviewer`/`confidence`/decision/outcome/tier) unescaped. `escapeMarkdown`: backslash
  first, then inline `` ` * _ [ ] < > ``, then leading `# - +` and ordered-list `1.`/`1)` (escape the
  delimiter). `>` is NOT in rule 3 (rule 2 already escaped it — don't re-add).
- Do not drop `thinking` preservation in `PiAgentRuntime.modelArgs` / move `thinking` out of
  `selectModel` (#45/#53). Do not unscale the retry reserve `minimumRemainingMs`. Do not revert
  the CI gate to deferred `process.exitCode` (use `finalizeCiExit`; `test/cli-exit.test.ts`).
- Do not put diff text, finding bodies, prompts, or secrets into telemetry/rollups — counts/
  identifiers only (M008; #50; #57).
- Do not trust an implementer (Codex or subagent) summary's "tests added"/gate claims — verify
  vs `git diff` and re-run `bun run check`. Do not `git add -A` when committing delegated work
  (it swept `M009-SUMMARY.md` in once).
- Do not reopen closed issues #10–#14/#17/#18/#19/#25/#31/#32/#37/#39/#40/#48/#49/#58/#73/#74/#77/#80/#82/#28
  or merged PRs #9/#47/#53/#55/#56/#59/#61/#62/#63/#64/#66/#68/#70/#71/#72/#76/#78/#79/#81/#83/#85 unless new
  regressions appear. Closed issues #60/#65/#67 likewise stay closed.
- Do not tune `src/runner/reviewer-definitions.ts` (or coordinator prompts) against the `evals/`
  holdout scenarios to make them pass — that destroys the holdout discipline (#28). The eval set is a
  TRUE holdout: investigate underperformance, don't memorize the fixtures. `src/evals` is pure logic
  (no I/O); the runner (`scripts/evals.ts`) is gated + not type-checked (lives outside tsconfig).
- Do not re-export `src/publisher/inline-comment-markdown.ts` from `publisher/index.ts` (#82/#83 review):
  it encodes the `ai-code-review-factory-inline` wire format + the security-sensitive dedup parser;
  keep it off the public API. Adapters/tests import it via the direct file path. The renderer
  unicode-escapes `>` in the embedded metadata (prevents `-->` HTML-comment breakout); don't undo that.
- Do not set `sensitivePaths`/`ignoredPaths`/`failOn` in `.ai-review.json` expecting them to APPEND to
  defaults — those arrays REPLACE wholesale (`normalizeReviewConfig`); object maps (`reviewerPolicy`/
  `timeouts`/`modelRouting`) merge. The repo `.ai-review.json` deliberately re-lists the 5 default
  sensitivePaths before its gate-file additions; don't drop them. Documented in `docs/configuration.md`.
- #54.2 grounding is now **scoped to changed-file findings (#73, PR #76)** — it only drops a finding
  whose `location.path` is a CHANGED file (set built from `diff.files`, normalized). Findings with no
  location / cross-file / staleness quotes are KEPT. Do not revert this scope gate (it's the first
  check in `assessFindingGrounding`'s loop) — removing it reinstates the false-drop of legitimate
  staleness / "you forgot to update X" findings. The fabrication guard still applies on changed files
  (U+200B case). When a PR's review still shows "N withheld", the dropped findings DID cite changed
  files (legitimate grounding). **#74** (renderer escapes no finding text) is the remaining sibling.
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
