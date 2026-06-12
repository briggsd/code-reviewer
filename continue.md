# Continue — AI Code Review Factory / Foundations A+B+C-part-1 SHIPPED (PRs #104–#108: #101/#27/#96/#50 closed + dedup fix); next = C part 2 (#20 run events on the reserved vocabulary) / Foundation D (#33+#22-P1)

## Last action

**Foundation C part 1 SHIPPED — #50 counts-only rollup export schema (PR #108, squash `6cda18e`,
gate 522/0).** New `src/state/rollup-export.ts`: `createRollupExport()` → `ai-review.rollup_export.v1`,
the egress boundary for any rollup leaving the repo trust domain. Backend: Sonnet subagent
(Opus 4.8 coordinator), 2 full-tier review rounds (9 findings → all fixed; 7 → fixed 4 / held 3 /
noise-floor merge).
- **The boundary (safe by construction):** event-type allowlist (`EXPORTABLE_EVENT_TYPES`) — foreign
  types' fields never reach the export; **shape-bounded aggregate keys** (letter-first identifier
  pattern, ≤64 chars) — closes the real hole that `findingsByReviewer` keys are MODEL-AUTHORED
  (validateFinding accepts any string) and could carry poisoned text into exports verbatim; rejected
  keys fold into **`__other__`** (`SANITIZED_KEY_BUCKET` — the name itself FAILS the pattern, so a
  legitimate key named `other` can never collide), counted in `sanitizedAggregateKeyCount`;
  repo slugs are the only identifiers carried (segment-leading-alnum pattern rejects `../..` shapes;
  malformed → dropped + `droppedRepositoryCount`); `shapeBoundRollup` uses **exhaustive NO-SPREAD
  construction** so a future Record field on `RunMetricsRollup` fails compilation at the boundary
  instead of leaking. NOT a closed value set (shape constraint — future runtimes/roles pass; the
  standing extensibility rule).
- **#20/#22 designed in:** `ai_review.run_event` reserved in the allowlist with documented
  counts-only subtypes (`run.start`/`run.completed`/`run.correction`/`run.override`) + the
  letter-first Record-key caveat for runId keys (prefix digit-leading ids). #20's implementation
  lands INSIDE the boundary — see `docs/telemetry-export.md` (identifier policy, migration from the
  pre-v1 flat output shape: fields now nest under `.rollup`).
- **Review triage:** R1 (9, ALL real — the strong round): `other`-collision, no-spread construction,
  `../..` slug shapes, generatedAt validation, loose runCount assertion, observability counter,
  migration doc, runId policy gaps. R2 (7): fixed 4 cheap (exact `toBe(3)` sanitization assertion,
  run_event→repositories positive test, migration note re reviewer keys becoming `__other__`, script
  stderr parity), HELD 3 (per-event drop counting = documented deliberate semantic; `repositories[]`
  "disclosure" IS the documented identifier policy; underscore-key folding = the deliberate
  collision-proofing). Merged at noise floor without R3.

**Recommended next:** **C part 2 — #20** (emit `run.start`/`run.completed`/`run.correction` through
the sink against the reserved vocabulary; acceptance signal per reviewer from `re-review.ts`
fixed/recurring/withheld — #31 fixed + #69 withheld make the numbers honest now; aggregate by
reviewer × tier in `telemetry:analyze`; `run.correction` Record keys MUST be letter-first — prefix
runIds) / **Foundation D** (#33 renderer rewrite + #22-P1) / standalones #41/#42/#24.

---

**Earlier last action (same session):**

**Foundation B SHIPPED — one toolchain decision, two PRs (#106 closed #27, #107 closed #96), both
user-ratified (formatter: adopt; Biome: fix+flip-blocking).** The verification story changed:
**`bun run gate` (= check + boundaries + lint) is now THE pre-PR gate**, mirroring CI's blocking
check job exactly; `bun run check` stays tsc+test.
- **PR #106 (#27, squash `a4eb408`):** `bun run boundaries` — dependency-cruiser
  (`.dependency-cruiser.cjs`), BLOCKING step in CI's check job, remediation message in every rule:
  `runner-no-concrete-adapters` (exempts ONLY two pure leaf utils pending relocation:
  `publisher/markdown-escape.ts`, `runtime/runtime-kind.ts`), `contracts-stay-pure` (NO exemptions),
  `no-cross-vcs-coupling` ×2, `no-circular`, + REQUIRED rule `pi-runtime-routes-prompt-boundary`.
  Zero violations (69 modules). Both rule types probe-verified to fire. Biome `suspicious/noConsole`
  = error for src/ (cli.ts/scripts/test/evals exempt). Decision of record: dependency-cruiser for
  layering + Biome for style; NO ESLint. Deviation from #27's literal AC: separate blocking CI step,
  NOT folded into `bun run check` (the #95 decision holds). **R1 review's sharp catch: dep-cruiser
  `required` rules pass VACUOUSLY if the matched module is renamed/deleted** → test pins existence
  of both guarded files. R2 = 2 doc nits, deferred into #107 (noise-floor).
- **PR #107 (#96, squash `8cc2f4c`):** Biome formatter ADOPTED (commit 1 = mechanical bulk: 107
  files, formatter + organizeImports + safe fixes + scoped-unsafe useLiteralKeys×28) → **Biome
  lint+format now a BLOCKING check-job step** (`bun run lint` exits 0); knip/jscpd stay advisory.
  All 21 action refs in the project's 4 workflows SHA-pinned (`# vN` trailing comments);
  `examples/ci/` adoption templates DELIBERATELY keep mutable tags (`test/ci-templates.test.ts`
  locks it). biome.json: test/** override noNonNullAssertion off; `.claude/` excluded. The 114-file
  full-tier review produced **1 finding/round** (excellent S/N): R1 → added `bun run gate` composite;
  R2 → scoped the "repo-wide" pinning claim.
- **⚠️ GOTCHA (memory-worthy): Biome's "safe" noPrototypeBuiltins fix is NOT strict-tsc-safe** —
  `x?.data.hasOwnProperty(k)` → `Object.hasOwn(x?.data, k)` turns an optional-chained receiver into
  a possibly-undefined ARG. 3 occurrences hand-fixed with `?? {}`.
- **⚠️ GOTCHA: `.git-blame-ignore-revs` + squash merge** — the file initially listed the BRANCH
  commit; squash rewrote the hash so the entry was silently inert (non-ancestry revs don't error).
  Fixed post-merge (`34ff917`): list the SQUASH commit on main.
- **PR #105's PATCH-dedup fix CONFIRMED in production** on both PRs: multi-round reviews now update
  ONE summary comment in place w/ Re-review status (5 fixed/2 new on #106; 1 fixed/1 new on #107).

**Recommended next:** **Foundation C** (#50 counts-only schema designed to carry #20's 3-event run
schema + #22-P2's `run.override` UP FRONT → then #57 artifact scoping; #51 stays trigger-gated) /
**Foundation D** (#33 renderer rewrite + #22-P1 break-glass doc/footer) / standalones #41/#42/#24.

---

**Earlier last action (same session):**

**Summary-dedup duplicate-comment regression FIXED — PR #105 (squash `12256d0`, gate 479/0, AI review
`approved`/0 lite).** User spotted the reviewer posting TWO separate summary comments per PR instead of
updating one in place. Root-caused to **PR #88 (#84 author-verified dedup)**: `resolveBotUserId()` uses
`GET /user`, but `GITHUB_TOKEN` is an installation token and `GET /user` returns **403 for installation
tokens on every call** → botId never resolved → the deliberate safe-on-failure fallback (POST fresh,
duplicate-over-suppression) became the steady state. Evidence nailed the timeline: every multi-round PR
before #88 (#66/#68/#72/#83) has ONE bot comment; #94 (first after #88) has FOUR; #95/#104 two each.
- **Fix (`github-vcs-adapter.ts`):** 403 from `GET /user` = installation-token signature → fall back to
  the well-known `github-actions[bot]` user id (`41898282`, server-assigned/unforgeable → #84
  planted-marker defense fully preserved, locked by test). Non-403 failures keep returning undefined
  (safe direction). GitLab unchanged (its CI auth uses PATs/project tokens where `GET /user` works;
  `CI_JOB_TOKEN` can't call comment APIs at all). +2 tests (PATCH-in-place on 403; planted marker by
  other author still → fresh POST).
- **Re-review classification was NEVER affected** — `getPriorReviewState` reads hidden metadata with NO
  author gate (that's why #104's R2 still showed correct new/recurring/fixed). **Side observation (not
  fixed, not filed):** that ungated prior-state read is the same #84 class on the READ side — a planted
  metadata comment can poison re-review counts (not the CI gate). Low impact; file only if user wants.
- **⚡ LIVE VALIDATION of #104's lite-tier coordinator short-circuit (first real CI run):** PR #105's own
  review (lite, 2 files) → 3 specialists empty (8–13 out-tok each), `coordinatorShortCircuited:true` in
  run_metrics, **ZERO coordinator agent entries** — no coordinator model call at all (was ~3.2K out-tok /
  27% of spend). The #100/#101 levers work end-to-end in production. Coordinator-applied (no subagent).

**Recommended next:** **Foundation B** (#96 formatter+flip-blocking AND #27 tool choice = one decision)
/ **Foundation C** (#50 schema carrying #20+#22 events) / **Foundation D** (#33+#22-P1).

---

**Earlier last action (same session):**

**Foundation A SHIPPED — tier-profile consolidation, PR #104 (squash `4f4ee4c`, gate 477/0, closed
#101, progress note on #100).** This session first produced a **cross-cutting analysis of all 20 open
issues** (user asked for shared slices), collapsing ~14 of them into four foundations:
- **A — tier-profile consolidation** (#100+#101; unlocks #23/#26/#46) — DONE this session.
- **B — one toolchain decision** (#96 formatter/flip-blocking + #27 S01 tool choice are the SAME
  decision; Biome can't express import-direction rules → likely Biome-for-style + dependency-cruiser
  for #27 invariants; #92's deterministic doc-staleness checks then ride that lint family).
- **C — telemetry schema designed once** (#50 counts-only schema should include #20's 3-event run
  schema + #22-P2's `run.override` event UP FRONT, not retrofit; then #57 artifact scoping; #51 stays
  trigger-gated). #20's old blocker #31 is fixed; #69's `withheld` classification improved the signal.
- **D — summary renderer rewrite** (#33 + #22-P1 break-glass doc/footer bundled into the same PR;
  must preserve grounding/ack/withheld notes + hidden metadata + re-review section added since #33 was filed).
- Standalones (no shared seam): #42 (--pi-api-key), #41 (heartbeat), #24 (generated markers).
  #16/#15 stay trigger-gated decision records. Suggested order: B → C → D.

**What A shipped (PR #104):** new `src/runner/tier-profile.ts` — ONE declarative `TierProfile` table
(`reviewerRoleCap` / `shortCircuitCoordinatorOnZeroFindings` / `timeoutScale` / `denyContextTools`);
the three scattered tier mechanisms (reviewer selection in `reviewer-definitions.ts`, timeout scaling +
tool policy in `run-review.ts`) now all read `getTierProfile()`. Two cost levers from the 29-run
telemetry (#100/#101): **trivial roster capped to `["code_quality"]`** (was 3 specialists; cap
intersects `reviewerPolicy`, never re-enables disabled) and **trivial/lite skip the coordinator call
when all dispatched reviewers succeed with zero findings** (coordinator = 27% of spend; deterministic
`summarizeReview` approved summary instead; any failure or finding → coordinator runs). Contract:
optional `shortCircuitOnZeroFindings` on `CoordinatorRunInput` (spine computes from profile — policy
stays deterministic), `coordinatorShortCircuited` on `CoordinatorRunResult`; Pi + dummy runtimes honor
it. Counts-only observability: `coordinatorShortCircuited` in `coordinator.completed` trace +
`run_metrics` (only when true; thinReview pattern, schema stays v1). No new config surface (profiles
factory-owned this slice). Backend: in-harness Sonnet subagent (Opus 4.8 coordinator); clean report,
reconciled, no confabulation.

- **Review triage (R1 full-tier, 8 findings → fixed 4 / held 2 / cheap-fixed 1-dup):** REAL: (1)
  vacuous short-circuit on EMPTY roster (trivial + `code_quality:"disabled"` → approved with zero
  review) — kept the behavior (outcome parity with pre-cap semantics: coordinator fusing zero results
  also approved), LOCKED with e2e test (e) + documented as a `reviewerPolicy` footgun in
  configuration.md; (2) the sharp one — **original test (c) passed for the wrong reason** (1 reviewer
  on trivial → all-failed THROW fires before the short-circuit guard; `reviewerFailures.length === 0`
  was never exercised) → new test (c2): lite tier, security fails, others succeed-empty → coordinator
  IS spawned (would fail if the guard were removed); (3+4) lite/full doc-table rows implied fixed
  rosters (uncapped, config-driven). HELD: "trace field mismatch" (reviewer conflated the runtime
  `agent.completed` `shortCircuited` with the spine `coordinator.completed` `coordinatorShortCircuited`
  — doc was accurate); trivial security-waiver (deliberate #101 design; documented the tradeoff +
  `sensitivePaths` as the escalation lever). R2 (5 findings): ALL recurring/re-litigations of R1 holds
  → noise-floor stop, merged. One legit follow-up idea inside R2's re-litigation: a config-overridable
  tier roster cap (e.g. `trivialRoleCap`) — NOT filed (file only if a consumer actually wants it).
- **#100 stays OPEN** (progress note posted): trivial duplication largely solved by the roster cap;
  the LITE context-sharing question remains (3 specialists on `inline_fallback` still duplicate cache
  writes on non-empty runs). Remaining directions: write-once/read-many inline payload sharing without
  re-enabling read tools; surface `cacheWrite` per tier in `telemetry:analyze`. The profile now has a
  natural home for a future `contextMode` field.

**Recommended next:** **Foundation B** (settle #96 formatter+flip-blocking AND #27 tool choice in one
sitting) / **Foundation C** (#50 schema designed to carry #20+#22 events) / **Foundation D** (#33+#22-P1)
/ standalones #41/#42/#24.

---

**Earlier last action:**

**Coordinator/reviewer JSON-extraction robustness fix SHIPPED — PR #103 (squash `f0a459c`, gate
455/0, AI review `approved`/0 — the same pipeline that FAILED 3× on #98 now parses).** While
shipping #91, the repo's own real-Pi review failed to publish **3 consecutive times on PR #98**
with `JSON Parse error: Expected '}'`. Root-caused (against the captured `trace.jsonl` coordinator
output of all 3 runs) to **TWO distinct, pre-existing runtime gaps** in `pi-agent-runtime.ts`,
both independent of #91 (which is post-coordinator):
- **Bug 1 — prose preamble before the ```` ```json ```` fence.** The coordinator emitted
  "I have enough to validate… Summary: … `return { thin: false }` …" BEFORE the fence.
  `extractFencedJson` only matched a fence anchored at `^` → missed it → the `indexOf("{")` fallback
  sliced from the **brace in the prose** → invalid JSON. Fix: find the fence **anywhere**
  (line-anchored, ```` ```json ````-preferred); closing = last ```` ``` ```` line. (Fixed runs a + c.)
- **Bug 2 — nested prose quote before a comma** (`means "phrase", but …`, quotes unescaped).
  `repairUnescapedStringQuotes` escaped the opening quote but treated the closing one as a real
  terminator because a `,` followed. Fix: a quote-before-comma is a terminator only when the next
  non-space token actually STARTS a JSON value (`" { [ - digit true/false/null`) — else it's nested
  prose, escape it. (Fixed run b — which carried 5 findings that never published.)
- **Verified against the ACTUAL failing outputs** (all 3 now parse to their intended findings) +2
  regression tests (one per bug); existing quote/backtick-repair tests unaffected. Coordinator-applied.
- **NOTE:** `src/runtime/pi-agent-runtime.ts` is NOT in #77's `sensitivePaths` (only
  `prompt-boundary.ts` under src/runtime is) → #103 self-reviewed **lite**, not full. The parser fix
  is tier-independent so that's fine, but if you want the *runtime* output-parser full-tiered, add
  `src/runtime/**` (or just `pi-agent-runtime.ts`) to the repo `.ai-review.json` — a #77-option-2 call.
- **Audit recipe (cheap tell for a parse failure):** a FAILED review writes **no `summary.json`**,
  only `run.json` with `.error` + `decision:"review_failed"`. Recover the findings anyway from
  `trace.jsonl`: the coordinator `message_end` event → `content[].type==="text"` is the raw model
  output; strip the ```` ```json ```` fence to read the findings the runtime couldn't parse.

---

**Earlier last action (same session):**

**#91 SHIPPED & CLOSED — contextual thin-review observability flag (PR #98, squash `1c5fc3b`, gate
453/0).** Emits a counts-only signal when a run's output tokens fall below an expected floor for its
risk tier / diff size: new `src/runner/thin-review.ts` `assessThinReview()` — floor `base + 60×fileCount`
(full base 300, lite 0, **trivial always exempt**), calibrated from the bimodal session data (correct/empty
~150 out-tok vs engaged 1.5K–16K) + the #76 case. Spine (`run-review.ts`, completed path only) emits an
optional `thinReview` telemetry block `{flagged,outputTokens,expectedFloor}` + a `review.thin_detected`
trace marker, both **only when flagged**; `review.thin_detected` added to `TraceEventType`. **Informational
only — never gates CI.** `telemetry:analyze` repointed at the SAME shared fn (was a flat-250 placeholder
marked "pending #91"). Rollup out of scope. Backend: in-harness Sonnet subagent (Opus 4.8 coordinator).

- **Two full-tier self-review rounds, both parseable, all findings triaged & fixed (noise-floor stop):**
  R1 (5 findings, all REAL): the sharp one — **historical lite-tier events lacking `reviewedFileCount`
  silently lost thin detection** (`asNumber(undefined)=0` → lite floor `60×0=0` → never thin; my PR wrongly
  claimed "historical re-classify consistently"). Fixed: when the field is ABSENT, analyze falls back to the
  legacy flat **250** floor (`LEGACY_FLAT_THIN_FLOOR`); contextual only when present; `--thin-floor` overrides
  all. + decoupled a brittle ordered-trace assertion in `state.test.ts`; + legacy-path test; + inlined the
  floor formula in docs. R2 (4 minor): flatFloor NaN/negative guard (a NaN floor silently disables detection),
  2 doc nits (informational-only; `--thin-floor` is non-trivial-only), 1 safe ordering assertion. Held: none.
- **⚠️ KNOWN-FAILING (pre-existing, NOT my code): the real-Pi AI review on #98 FAILED TO PARSE 3×**
  (`JSON Parse error: Expected '}'`). Root cause: the **coordinator emits unescaped `"` quotes inside finding
  `body` strings** (this PR's content + my PR-description quoted phrases led the model to nest quotes) →
  `pi-agent-runtime`'s JSON extraction chokes. **My thin-review code runs POST-coordinator and cannot cause
  this.** Got the findings anyway by extracting the coordinator text from `trace.jsonl` (`message_end` →
  content `text`, strip ```` ```json ```` fence). **`main` is UNPROTECTED → the red AI-review check did NOT
  block merge; the BLOCKING `Type-check & tests` gate passed.** This is a real runtime-robustness gap worth an
  issue — NOT YET FILED (filing was auto-denied before unless user-asked). **OFFER to file it.**
- **Repro/audit recipe:** `gh run download <runId> -R briggsd/ai-code-review-factory -n ai-review-real-<PR>`;
  the review summary is in `runs/*/run.json` (`.error`/`.summary`), per-agent tokens in `telemetry.jsonl`,
  coordinator output in `trace.jsonl`. NOTE: a FAILED review writes **no `summary.json`** (only `run.json`
  with `.error` + `decision:"review_failed"`).

**Recommended next:** ~~FILE the coordinator JSON-parse bug~~ DONE (PR #103, both bugs fixed). **#92**
(doc-staleness — docs are 52% of findings) / decide formatter + flip-to-blocking (**#96**) / **M014** #50/#51.

---

**Earlier last action:**

**Biome advisory trustworthy-signal pass SHIPPED — PR #97 (squash `8acdb7c`, gate 434/0, AI review
`approved`/0, trivial tier).** The #95 advisory `quality` job emitted ~146 noisy findings nobody reads,
so it caught nothing in practice. **First PR to exercise #95's blocking `check` job end-to-end** (passed).
Minimal pass — **NOT** a full lint cleanup, **NOT** the formatter, **NOT** flipping Biome to blocking:
- **Disabled 2 confirmed false-positive rules** (`biome.json`): `noTemplateCurlyInString` (18 — all tests
  asserting on literal GitHub Actions `${{ }}` / shell `${VAR}` template strings) + `noControlCharactersInRegex`
  (8 — all in `prompt-boundary.ts`/`runtime-kind.ts` security sanitization, load-bearing).
- **Removed 7 genuinely-unused type imports** (real dead code tsc doesn't flag) in two spine test files.
- **GOTCHA:** this `biome.json` is parsed as **strict JSON** — inline `//` comments silently revert the
  override to defaults (false positives came back). Rationale lives in the PR/commit + #96, not the file.
- **Triage verdict (recorded on #96):** of the original 66 lint findings, only ~5 had real value (the
  unused imports); the rest were cosmetic/false-positive. **~38 remain** (all genuine but cosmetic:
  `useLiteralKeys` ×28, test-only `noNonNullAssertion` ×4, `noPrototypeBuiltins` ×3, escape/template nits).
  **#96 stays OPEN** for the deferred decisions: adopt the Biome **formatter** (~20-file reformat) or
  disable it; **flip Biome to blocking** — only worth it once those settle. Coordinator-applied (no subagent).

**Recommended next:** **#91** (thin-review flag — now unblocked, #90 landed) / **#92** (doc-staleness) /
decide formatter + flip-to-blocking (#96) / **M014** #50/#51.

---

**Earlier last action:**

**#69 SHIPPED & CLOSED — `withheld` re-review classification (PR #94, squash `0ad2a19`, gate 418/0,
AI review `minor_issues`/pass).** Grounding drops ungrounded findings BEFORE re-review classification,
so a prior finding withheld this run was miscounted as **fixed**. Added a distinct **`withheld`**
classification: `withheldFindingIds` + `withheld` status on `ReReviewSummary`; run-review computes the
dropped findings' stable ids (`createStableFindingId` over `grounding.dropped`) and passes them to
`classifyReReviewFindings`, which routes matching prior ids to `withheldFindingIds` (excluded from
`fixedFindingIds`) + `withheld` classification entries; `withheldFindingCount` in the
`coordinator.completed` trace + `run_metrics` telemetry (counts only); rendered in summary markdown.
**Analytics-only — no change to the CI gate, decision, or outcome.**
- **Known limitation (documented in `docs/re-review-state.md`):** withheld matching is **best-effort** —
  the recomputed id matches the stored prior id only when it was NOT backfill-derived or collision-
  suffixed (`#N`). A dropped finding can't be re-backfilled (its `quotedCode` is absent from the current
  diff), so a backfill-reliant finding won't match and stays in `fixedFindingIds` — the pre-fix behavior,
  **no regression**; withheld just doesn't fire for that subset.
- **Review triage (3 rounds, 9→4→3 findings):** fixed all real ones (5 doc-staleness; the withheld-only
  "all-zero section" markdown gap; a self-introduced stale doc sentence). **HELD** the trust-boundary
  finding (recommended prior-membership guard is a **no-op** — `re-review.ts` already intersects withheld
  with prior state) + the unconditional-`:0`-bullet (matches the New/Recurring/Fixed pattern). **DEFERRED**
  the backfill-mismatch e2e test (the no-match→fixed branch is already unit-tested) + hidden-metadata
  persistence of withheld ids (#46-adjacent). Backend: in-harness Sonnet subagent (Opus 4.8 coordinator).
- **⚠️ Concurrency lesson (memory `shared-worktree-head-collision`):** this ran **in parallel with the #90
  agent in the SAME working tree** → git HEAD collided (my commit briefly landed on their branch; my push
  sent the base). Recovered via `git branch -f` + fast-forward push; did the review-response edits in an
  **isolated `git worktree`**. Both shipped clean to `main` anyway (#93 #90, #95, #94 #69). **Next time:
  one git worktree per concurrent agent** (or Agent `isolation: "worktree"`); never `git add -A`.

**Recommended next:** **triage Biome's ~146 findings → flip Biome to blocking** (#96 follow-up) /
**#91** (thin-review flag — now unblocked, #90 landed) / **#92** (doc-staleness) / **M014** #50/#51.

---

**Earlier last action:**

**#95 SHIPPED & CLOSED — CI quality gates (squash `acba8d9`, gate 428/0, AI review `approved_with_comments`).**
The gap the user spotted: `ai-review.yml` was the ONLY PR workflow — **nothing ran `bun run check`
(tsc + tests) on PRs**, and there was no linter / unused-code / duplication detection. Added
**`.github/workflows/ci.yml`** with two jobs: **`check` (BLOCKING)** = `bun install --frozen-lockfile`
+ `bun run check`; **`quality` (ADVISORY)** = `needs: check`, three steps each `continue-on-error`:
**Biome** (lint+format, `--reporter=github` for inline annotations), **knip** (unused files/exports/deps),
**jscpd** (dup, 5% threshold). Tools added as devDeps (**`@biomejs/biome` PINNED `2.4.16`** to match
`biome.json` `$schema`; `knip`, `jscpd`) + `biome.json` / `knip.json` / `.jscpd.json` + scripts
`lint`/`lint:fix`/`knip`/`dup`. **`check` stays exactly `tsc + test` per CLAUDE.md — advisory tools
deliberately NOT folded in.** Backend: in-harness Sonnet subagent via `delegate-implement` (Opus 4.8 coordinator).

- **Advisory-first rollout:** Biome reports **~146 lint findings** on the never-linted codebase, but
  `continue-on-error` keeps CI green. **GOTCHA: the `quality` job is GREEN even when tools report
  findings** — a passing CI ≠ zero lint/dup; read the job logs / inline Biome annotations. Flip Biome
  to blocking only AFTER triaging that debt.
- **AI review: 9 findings → fixed 8 / deferred 1**; re-review then `approved_with_comments` (6 residual
  nits, all hold/defer — stopped per noise-floor). Fixes: `cancel-in-progress` conditional on non-main
  ref (don't cancel `main`'s check run → cancelled≠passing status), `needs: check`, Biome
  `--reporter=github`, Bun dep cache (`~/.bun/install/cache` keyed on `bun.lock`), exact biome pin,
  and corrected the now-stale "no linter yet" line in **CLAUDE.md + the delegate-implement overlay**.
- **Rebase-over-#93 lesson:** mid-flight **#93 (telemetry:analyze) merged to `main`**, conflicting #95
  on `package.json` + `CLAUDE.md` → **GitHub SILENTLY SKIPS `pull_request` checks on a CONFLICTING PR**
  (my last two pushes showed zero runs, no error). Fix: rebase onto `main`, keep BOTH script sets
  (telemetry:analyze + lint family), force-push → CI re-ran, all green. (This is the parallel-PR gotcha
  in Open threads, now with the "conflict ⇒ no checks fire" corollary.)
- **Filed #96** (tracking issue + the one deferred review item: **repo-wide SHA-pinning of GitHub
  Actions** — all workflows use `@vN` tags, pinning only `ci.yml` would be inconsistent; read-only perms
  so low blast radius). NOTE: filing the issue was auto-denied the first time (not user-requested) →
  created only after the user explicitly asked.

**Recommended next:** **triage Biome's ~146 findings → flip Biome to blocking** (the natural #96
follow-up) / **#69** (re-review miscount, low/quick) / **#91** (thin-review flag) / **#92** (doc-staleness)
/ **M014** #50/#51 (telemetry egress). NOTE **#90 (telemetry:analyze) is now DONE** — it merged as **PR #93**
while this session ran.

---

**Earlier last action:**

**SESSION-END: first organized telemetry analysis of our own self-reviews (9 real-`pi` runs, #76–#89).**
Pulled `ai_review.run_metrics` from the CI artifacts and segmented by tier — the numbers are the
durable baseline (saved to memory `telemetry-baseline-2026-06`). Headlines: **full tier ≈ 5.8
findings/run vs lite 1.5** (the #77 effect, measured, ~4× yield for ~3× cost); **documentation reviewer
= 52% of all findings** (docs go stale fastest); thin-review is cleanly bimodal (empty passes ~150
out-tok vs engaged 1.5K–16K); **zero criticals / never blocked** on self-review (the #28 eval is what
exercises critical-blocking); grounding dropped 0 in 9 runs (precision filters are latent insurance);
cost $1.62/9 runs (non-issue), duration is the budget pressure (#83 hit 569s). **Filed 3 issues from
the patterns:** **#90** (`telemetry:analyze` — tier-segmented analyzer, the durable version of this
manual pull; broader than #20's acceptance slice), **#91** (contextual thin-review flag — now
data-backed, #65/#76 lineage), **#92** (cheaper doc-staleness detection — docs are 52% of findings).
**Reproduce:** `gh run download <runId> -n ai-review-real-<PR>` → parse `runs/*/telemetry.jsonl`.

**Recommended next:** **#90** (build `telemetry:analyze` — makes this repeatable, real start on #20) /
**#69** (re-review miscount, low/quick) / **M014** #50/#57 (telemetry egress).

---

**Earlier last action:**

**#84 + #87 SHIPPED & CLOSED (PRs #88 + #89).** Two final fixes this session, both improved by their
full-tier reviews:
- **#84 (PR #88, security):** inline dedup trusted comment metadata WITHOUT checking the author → a
  planted marker could suppress a finding. Fix: verify the comment/note author == the bot identity
  (`GET /user`, memoized, safe-on-failure → no suppression). The review caught that the **summary**-
  comment dedup was the SAME class but **higher impact** (a planted `<!-- ai-code-review-factory`
  comment → bot PATCHes a comment it can't edit → 403 → whole summary suppressed) — fixed that too in
  the same PR. Both inline + summary dedup now author-verified, both adapters.
- **#87 (PR #89, UX/correctness):** findings often omit `location.path` → inline publishing skipped
  them (found via the #28 eval). Fix: `src/runner/location-backfill.ts` deterministically maps
  `quotedCode` → file+new-side line (hunk parser; RIGHT-side only) and backfills `location` in the
  spine after grounding / before stable-ids. Full-tier review found a real cross-file path-overwrite
  bug (now path-constrained), a `push(...spread)` RangeError on huge patches (now a loop + isLockfile
  skip), and the need for a re-review migration note (stable IDs change for backfilled findings) — all
  fixed. Also extracted the shared `normalizeForMatch` (text-normalize.ts) used by grounding + backfill
  (was duplicated). Backfill emits counts-only `location.backfill.applied` trace + telemetry.

---

**Earlier last action:**

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

## Cross-cutting plan (2026-06-12 session — 20 open issues → 4 foundations)

Grounded against code; the durable map for what remains. (The OLD #54/#60-era foundations plan
that lived here is complete and superseded — its history is in the session blocks above.)

- **Foundation A — tier-profile consolidation** (#100+#101) → **DONE** (PR #104). One declarative
  table `src/runner/tier-profile.ts`; trivial roster cap; coordinator zero-finding short-circuit.
  Unlocks #23/#26 (roster entries in the same mechanism) and multiplies #46's savings.
- **Foundation B — one toolchain decision** (#96+#27) → **DONE** (PRs #106/#107). dependency-cruiser
  for layering (remediation messages), Biome for style (BLOCKING, formatter adopted), no ESLint.
  `bun run gate` = the pre-PR gate. **#92's deterministic doc-staleness checks should ride this lint
  family** (still open).
- **Foundation C — telemetry schema designed once** (#50 → #20 → #57; #51 trigger-gated) →
  **part 1 DONE** (PR #108: egress boundary + reserved `ai_review.run_event` vocabulary).
  **Part 2 = #20**: emit `run.start`/`run.completed`/`run.correction` against the reserved
  vocabulary (`src/state/rollup-export.ts` JSDoc + `docs/telemetry-export.md` ARE the contract);
  acceptance signal per reviewer from `re-review.ts` fixed/recurring/withheld (#31 fixed + #69
  withheld → numbers are honest); aggregate reviewer × tier in `telemetry:analyze`; `run.correction`
  Record keys MUST be letter-first (prefix runIds). #22-P2's `run.override` lands after #20.
  **Then #57** (artifact scoping + redaction completeness) against the settled boundary.
- **Foundation D — summary renderer rewrite** (#33 + #22-P1 bundled) → **NOT STARTED**. Rewrite
  `summary-markdown.ts` (group-by-reviewer, severity badges, `<details>` disclosure per the issue's
  Cloudflare layout) + #22-P1 break-glass doc/architecture.md section + footer placeholder in the
  SAME PR. MUST preserve: hidden metadata block, `### Re-review status`, grounding/ack/withheld
  notes, escapeMarkdown at the leaves (see Do-not list).
- **Standalones** (no shared seam, any time): #41 (heartbeat consumer — event exists, wiring only),
  #42 (`--pi-api-key`), #24 (generated-marker diff filter — small, self-contained).
- **Deferred/trigger-gated:** #16 (plugin lifecycle — no trigger tripped), #15 (umbrella), #51
  (remote transport — promote on a concrete trigger), #46 (incremental re-review — needs
  prev-head..head VCS plumbing; benefits from A's tier profile), #29 (doc-gardening, heavier #92),
  #23/#26 (new reviewer roles — cheaper post-A), #22-P2 (after #20), #92 (post-B lint family),
  #57 (post-#20), #20 (C part 2 — the recommended next), #100 (lite context-sharing remainder).

## Next action

1. **C part 2 — #20 run events + acceptance analytics** (recommended): the reserved vocabulary in
   `src/state/rollup-export.ts` + `docs/telemetry-export.md` is the contract; emission precedent =
   the `run_metrics` emit in `run-review.ts` (~line 380); acceptance mapping source =
   `createReReviewSummary` (fixed→accepted, recurring→not-accepted, withheld→excluded); aggregate in
   `telemetry:analyze`. Sequencing note from the issue: S04 events first, S05/S06 acceptance are
   longitudinal/directional.
2. **Foundation D — #33 + #22-P1** (renderer rewrite; see plan above for must-preserve list).
3. **Standalones:** #41 / #42 / #24.
4. If real-review behavior questions come up: PR #105's PATCH-dedup is CONFIRMED working (one
   summary comment updated in place per PR); #104's tier levers are CONFIRMED live (lite
   zero-finding run → no coordinator call, `coordinatorShortCircuited` in run_metrics).

## State

- `main` @ `6cda18e` (PR #108 #50 rollup egress; under it: #107 #96 close-out, #106 #27 boundaries,
  #105 dedup fix, #104 tier-profile), pushed/synced, **gate = `bun run gate`** (check 522/0 +
  boundaries clean + lint 0), working tree CLEAN except this `continue.md` edit.
- **MERGED last big session (8 PRs):** #64 (#54.1 prompts), #66 (quotedCode contract + #67 fix), #68
  (#54.2 grounding), #70 (#60-P2 conventions trust guard), #71 (#60-P3a ack foundation), #72 (#60-P3b
  ack apply, closed #60). Backend: in-harness Sonnet subagent (Opus 4.8 coordinator) throughout.
- **MERGED this session:** **#76** (#73 grounding changed-file scope, closed #73), **#78** (#74
  markdown-escape across 3 renderer sinks, closed #74), **#79** (#77 repo `.ai-review.json` self-review
  full-tiering + config-docs footgun, closed #77), **#81** (#80 GitLab `readBaseBranchFile` trust-guard
  parity, closed #80), **#83** (#82 GitLab inline MR-discussion publishing + shared inline renderer,
  closed #82), **#85** (#28 holdout eval harness MVP, closed #28), **#86** (eval-criteria recalibration
  → 5/5 @ 100%), **#88** (#84 inline+summary dedup author-trust, closed #84), **#89** (#87 location backfill, closed #87).
- **MERGED this session: #95** (CI quality gates — `ci.yml` blocking check + advisory Biome/knip/jscpd,
  squash `acba8d9`). Also **#90 (telemetry:analyze) merged as PR #93** during this window.
- **Issues open (post-2026-06-12 session — #101/#27/#96/#50 all CLOSED):** **#20** (run events +
  acceptance — C part 2, recommended next), **#33** (renderer rewrite — Foundation D, w/ #22-P1),
  **#100** (lite context-sharing remainder; trivial half solved by PR #104, see issue comment),
  **#92** (doc-staleness — ride the post-B lint family), #57 (artifact scoping — after #20),
  **#51** (remote transport — trigger-gated), #46 (needs prev-head..head ref read), **M013** #26/#29,
  #41/#42/#22/#24, **M012** parking lot #15/#16/#23.
  **GitLab parity COMPLETE** (base-read #80 + inline publish #82 + dedup author-trust #84). **#77 PROVEN
  end-to-end**; eval VALIDATED 5/5@100%. **#77 option 2** revisit only if needed.
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
- **Parallel-PR conflicts:** two PRs on shared files (cli.ts, state.test.ts, **package.json/CLAUDE.md
  per #95**) conflict after the first merges — rebase the second onto `main`, resolve (usually
  additive), force-push, merge. Also: after a force-push, GitHub lags re-computing mergeability — retry
  the merge after a beat. **COROLLARY (from #95): a CONFLICTING PR fires NO `pull_request` checks at all**
  (GitHub can't build the test-merge ref) — pushes to a dirty PR show zero workflow runs with no error.
  If new pushes mysteriously don't trigger CI, check `gh pr view <N> --json mergeable,mergeStateStatus`
  for `CONFLICTING`/`DIRTY` and rebase.
- **Multi-agent shared-working-tree/HEAD hazard (observed live during #90):** when two agents drive the
  SAME clone, they share one git HEAD — so one agent's commit lands on whichever branch is currently
  checked out, i.e. *the other agent's branch*. During #90 the #69 commit (`ab031b4`) landed on the #90
  branch, so PR #93 bundled #69+#90 and its AI review flagged both. The whole gate I'd run (433/0)
  silently included #69's tests — the true #90-only gate was 428/0. **Untangle without disrupting the
  other agent via an isolated `git worktree`:** `git worktree add /tmp/wtX <branch>`; rebase/edit/gate
  there (`git -C /tmp/wtX rebase --onto main <other-commit> <branch>`; `bun install` in the worktree);
  force-push; `git worktree remove`. The main tree stays on the other agent's branch untouched. **Always
  reconcile `git log origin/main..HEAD` (not just the top commit) before trusting a PR's scope** — a
  branch can carry a foreign commit you didn't author. Recommend a separate worktree/clone per agent to
  prevent this entirely.
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
  #84/#87/#69/#90/#91 or merged PRs #9/#47/#53/#55/#56/#59/#61/#62/#63/#64/#66/#68/#70/#71/#72/#76/#78/#79/#81/#83/#85/#86/#88/#89/#93/#94/#95/#97/#98/#103
- Do not weaken the #50 egress boundary (`src/state/rollup-export.ts`): keep `shapeBoundRollup`'s
  exhaustive NO-SPREAD construction (a spread would let a future Record field bypass the boundary
  silently); keep `__other__` as the overflow bucket (its name fails the key pattern — that's the
  collision-proofing); keep the shape constraint a SHAPE rule, never a closed value set. New
  telemetry event types must be added to `EXPORTABLE_EVENT_TYPES` and obey the documented
  counts-only vocabulary; `run.correction` Record keys must be letter-first (prefix runIds).
- Do not revert the blocking Biome step or `bun run boundaries` in ci.yml's check job, and do not
  fold either into `bun run check` (stays tsc+test; `bun run gate` is the composite). Do not weaken
  `.dependency-cruiser.cjs` rules — the two runner-rule exemptions (markdown-escape, runtime-kind)
  are the ONLY allowed ones (pure leaf utils, relocation pending). Do not SHA-pin `examples/ci/`
  adoption templates (mutable tags by design; ci-templates.test.ts locks it). When adding a bulk
  commit to `.git-blame-ignore-revs`, list the SQUASH hash on main, never the branch hash.
- Do not trust Biome's "safe" noPrototypeBuiltins fix under strict tsc — `Object.hasOwn(x?.y, k)`
  makes the receiver a possibly-undefined argument; guard with `?? {}`.
- Do not remove the `GET /user` 403 → `GITHUB_ACTIONS_BOT_USER_ID` (41898282) fallback in
  `github-vcs-adapter.ts` (PR #105) — without it every CI run duplicates the summary comment
  (GITHUB_TOKEN always 403s on /user). 403 ONLY — non-403 failures stay undefined (the #84
  duplicate-over-suppression direction). The planted-marker rejection test locks the security property.
- Do not scatter new tier conditionals — ALL tier→behavior policy reads `getTierProfile()`
  (`src/runner/tier-profile.ts`, PR #104). Do not remove the trivial `["code_quality"]` roster cap or
  the coordinator zero-finding short-circuit guards (`reviewerFailures.length === 0` + every-result-
  empty in `pi-agent-runtime.ts`) — test (c2) locks the mixed-failure case, test (e) locks the
  empty-roster case (deliberate: deterministic approved, documented footgun in configuration.md).
  The trivial security-waiver is BY DESIGN (#101; sensitive paths escalate to full; documented in
  architecture.md) — the reviewer re-litigated it twice, hold the line. Do not reopen #101 / PR #104.
- Do not re-chase the #98 AI-review JSON-parse failures as a thin-review bug — they were two
  pre-existing `pi-agent-runtime.ts` JSON-EXTRACTION gaps (preamble-before-fence + nested-quote-
  before-comma), **FIXED in PR #103**, independent of #91's post-coordinator code. Do not revert
  `extractFencedJson`'s find-anywhere logic or the comma-aware `isLikelyJsonStringTerminator`
  refinement (`nextNonSpaceStartsJsonValue`) — each guards a real failure reproduced from CI output.
  unless new regressions appear. Closed issues #60/#65/#67 likewise stay closed.
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
