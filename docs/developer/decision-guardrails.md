# Decision guardrails — load-bearing invariants not to revert

> Migrated from `continue.md` (2026-06-15) so these durable, cross-session technical
> invariants live in a **committed, shared, versioned** home instead of a gitignored
> machine-local file. These are decisions already made + shipped — guard against silent
> reversal (often by an AI reviewer re-litigating a settled call). Status of the issues/PRs
> referenced lives in GitHub; this file is the *why-not-to-undo*, not a status tracker.
> Milestone-scope entries (M015/M016/M017) are historical — those milestones shipped; the
> guards stay as "don't undo the shipped design."

## Do not

- **M017 (extensibility seam, #7) — don't drift the settled scope:** ship the *minimal*
  explicit-load **reviewer-definition** seam framed as **"great defaults, swappable"** — the
  pre-built trusted reviewers are the OOTB experience; the seam adds extend (union) / swap
  (override-by-role/id) / full-replace on top (S01 picks the predictable merge/override rule;
  the socket already supports full-replace + `reviewerPolicy` already disables built-ins).
  NOT the #16 plugin lifecycle (DEFERRED by S01 —
  premature without a 2nd independent config contributor; both #16's record + the #143
  assessment agree). The seam MUST be **explicit-operator-load only**, never reviewed-repo
  discovery (mirrors `../user/fork-safety.md:60` `--no-extensions` + explicit `--extension`) — so it
  can't weaken the lockout it copies. Operator reviewer *definitions* are trusted; their
  *output* still re-validates through `validateFinding`. Keep it **open/denylist, never an
  allowlist** of factory-blessed reviewers (the extensibility philosophy + the closed-set
  Do-not below). Don't flip `private:false` / add a registry publish — that's a separate
  go-to-market call, out of M017. Don't fold in #139/#162 (off-theme; deferred in roadmap).
- **Don't reopen the closed milestone issues** (M015 #124–#128, M016 #129–#133, #51, #154,
  #155). They shipped this session; status lives in GitHub, not in re-litigation here.
- **M016 (review-quality flywheel, #6, issues #129–#133) — don't re-plan the settled shape:**
  the live holdout eval gates at the **PUBLISH boundary** (`release-package.yml`), NOT per-PR
  (publishing is where quality reaches adopters; bounds token spend to release cadence — USER
  decision "release-gated + free PR signal"). The PR-time signal is the FREE **dummy-runtime**
  eval, advisory only. **Holdout stays SEALED** — never tune reviewer-defs against it, never
  promote a tuned DEV scenario into the holdout (#28 discipline; S01 #129 builds the split).
  Quality report (S04 #132) is **COUNTS-ONLY** (M008) — content investigation happens only on
  LOCAL dogfood traces / dev scenarios, never from egress telemetry. Loop stays a **MANUAL
  playbook** (no auto-tuning agent — M013 S05 deferral). **Fleet fan-in (#51 send-side UNPARKED +
  S06 #136 receive):** factory ingests ONLY the owner's OWN fleet (shared secret), counts-only
  enforced ON RECEIVE; external adopters' telemetry stays PRIVATE to their own backends (#51 points
  at their endpoint, never the factory); **open 3rd-party contribution to the factory signal is OUT
  OF SCOPE** (poisoning vector) — don't "open it up." Keep #51 in M014 (send), S06 in M016 (receive).
- **M015 (structured reviewer output, #5, issues #124–#128) — see Last/Previous action** for the
  full instruct-only / demote-not-delete / parked-escalation invariants; don't collapse the
  structured-tool-primary + repair-fallback split or unpark the forced-`tool_choice`/OpenCode
  escalation without the S01 #124 hit-rate evidence. **S01 #124 DONE (PR #150, squash `1575634`):
  100% instruct-only hit-rate = GO; escalation STAYS PARKED (trigger didn't fire).** S02–S05 still
  open. Don't re-run the S01 spike to "re-decide" — the number is in the roadmap Decision record.
  **The 100% was measured with `--no-builtin-tools`** (isolating the question); S03's production-config
  per-agent `structuredOutput` telemetry is the REAL gate for retiring repair in S05 — don't retire
  repair on the spike number alone. **S02 MUST re-validate tool `args` against `reviewerOutputSchema`**
  (the spike didn't prove pi rejects malformed args; the extension's TypeBox schema is a hand-mirror
  that can drift). **Production wiring (S03/S04) MUST pipe the prompt via STDIN, not `--print` argv**
  (argv is world-readable). The factory extension lives at `scripts/structured-output-spike/
  submit-findings-extension.ts` (spike home; relocate to a shippable/`-e` home when S03 wires it).
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
  with `src/publisher/markdown-escape.ts`. Use `codeSpan()` for model-produced values embedded in
  code spans (`category`, `confidence`) — it widens the backtick fence for embedded backticks and
  does NOT run `escapeMarkdown` on inner content (values inside a code span are literal; escaping
  would render literal backslashes). Controlled enums (decision/outcome/tier/reviewer) may also use
  `codeSpan()` for consistency. `escapeMarkdown`: backslash
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
  #84/#87/#69/#90/#91/#101/#27/#96/#50/#20/#33/#57/#22/#92/#29/#46/#23/#26/#115/#120/#41/#42 or merged PRs #9/#47/#53/#55/#56/#59/#61/#62/#63/#64/#66/#68/#70/#71/#72/#76/#78/#79/#81/#83/#85/#86/#88/#89/#93/#94/#95/#97/#98/#103/#104/#106/#107/#108/#109/#110/#111/#112/#113/#114/#116/#117/#118/#119/#121/#122
  /#24/#124/#125/#129/#126/#127/#128 or merged PRs … /#123/#150/#153/#163/#164/#166/#170
  (#100/#51/#16/#15 + M015 #128 + M016 #130/#131/#133/#136 + tokenomics #151 still open; #124 CLOSED via PR #150 `1575634`, #125 via PR #153 `90b2873`, #129 via PR #163 `f9cb6ad`, #126 via PR #164 `f0067c0`, #127 via PR #166 `299cf79`)
- Do not revert the #33 grouped renderer invariants (PR #110): model-authored `reviewer` in
  group HEADINGS renders escapeMarkdown'd in PLAIN context with newlines collapsed first — NEVER
  a code span (backtick breakout; escapes don't render inside code spans) and NEVER raw. The
  break-glass footer link MUST stay an ABSOLUTE factory-repo URL (relative hrefs resolve against
  the comment page URL → 404; verified via rendered bodyHTML on PR #110 — the AI reviewer's
  earlier repo-root-resolution claim was WRONG). Keep the blank line before `<details>`
  (GitLab/CommonMark) and after `</summary>`. tier/outcome/decision/category/confidence are
  passed through `codeSpan()` — NOT through `escapeMarkdown` — because values inside a code span
  are literal and escaping them would render literal backslashes (the reviewer pushed
  escapeMarkdown-inside-code-span and it is technically wrong). The visible comment
  markdown is NOT a stable interface (documented in ../user/adoption.md) — consumers parse
  run.json/summary.json/hidden metadata. Hidden metadata block + `### Re-review status` formats
  are load-bearing (dedup PATCH + prior-state reads) — change only with the parser.
- Do not shape-bound/sanitize/allowlist model-authored reviewer keys at EMISSION or in the local
  `telemetry:analyze` view (#20, PR #109) — the AI reviewer pushed this in BOTH rounds. The
  egress boundary (`rollup-export.ts`) is the single enforcement point; `run_metrics.
  findingsByReviewer` has carried verbatim keys since it existed and the run_event path matches
  it deliberately. Do not emit `run.completed` on the FAILED path (completion rate =
  completed/started by design); do not re-spread token fields at the `createRunCompletedEvent`
  call site (forward `metrics.tokens` whole — the builder is the single per-field filter);
  `correctionRunCount` counts only acceptance-carrying correction events (the directional
  denominator); `withheldExcluded` stays OUT of the acceptanceRate denominator. Do not reopen
  #20 / PR #109.
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
  empty-roster case (deliberate: deterministic approved, documented footgun in ../user/configuration.md).
  The trivial security-waiver is BY DESIGN (#101; sensitive paths escalate to full; documented in
  architecture.md) — the reviewer re-litigated it twice, hold the line. Do not reopen #101 / PR #104.
- Do not re-chase the #98 AI-review JSON-parse failures as a thin-review bug — they were two
  pre-existing `pi-agent-runtime.ts` JSON-EXTRACTION gaps (preamble-before-fence + nested-quote-
  before-comma), **FIXED in PR #103**, independent of #91's post-coordinator code. Do not revert
  `extractFencedJson`'s find-anywhere logic or the comma-aware `isLikelyJsonStringTerminator`
  refinement (`nextNonSpaceStartsJsonValue`) — each guards a real failure reproduced from CI output.
  unless new regressions appear. Closed issues #60/#65/#67 likewise stay closed.
- Do not revert the **container-aware quote repair (PR #119)** in `repairUnescapedStringQuotes`:
  `isLikelyJsonStringTerminator` takes the enclosing container, and on a `,` an OBJECT value uses
  `nextTokenIsObjectKey` (terminate only if a real `"<key>":` follows) while an ARRAY element keeps
  `nextNonSpaceStartsJsonValue` (value-start guard). **Do NOT make the array branch unconditionally
  return `true`** — that regresses `quotedCode: string[]` repair (the dogfood reviewer caught exactly
  this in the first cut). Both helpers must stay. The two tests
  (`ProseQuoteListPiProcessRunner` object case, `ArrayElementProseQuotePiProcessRunner` array case)
  lock it. The real-Pi JSON-parse crash was a GENUINE defect (all-reviewers-fail → zero review), NOT
  a non-blocking nuisance — do not re-file it as cosmetic ([[real-pi-review-nonblocking-json-parse]]).
- Do not collapse the **#120 all-reviewers-failed SPLIT** in `pi-agent-runtime.ts` into "degrade
  everything" or "crash everything." ONLY CONTENT failures (`DEGRADABLE_REVIEWER_FAILURE_CATEGORIES` =
  schema_invalid/truncated/context_overflow/unknown) degrade to a published `review_failed` (routed
  through `decideCiOutcome` fail-open/closed); OPERATIONAL failures (provider_error/auth/rate_limited/
  retryable_transient/timeout/unsafe_fork) keep CRASHING (re-throw) so an outage isn't silently
  fail-opened. This was an explicit USER decision ("Split: infra still crashes"). `unknown` is
  deliberately in the degrade set (the real #119 crash classifies as `unknown`). Unrecognized category
  → operational (crash), the safe default. ANY operational in an all-fail set → whole run crashes.
  Tests lock both sides (degraded: InvalidJson/excessive-repair/tier-(c); crash: provider-error +
  MixedFailure). Do not reopen #120 / PR #121.
- Do not tune `src/runner/reviewer-definitions.ts` (or coordinator prompts) against the
  `evals/scenarios/` SEALED HOLDOUT to make them pass — that destroys the holdout discipline (#28). The
  holdout is a TRUE holdout: investigate underperformance, don't memorize the fixtures. Tune against
  the `evals/scenarios-dev/` DEV split instead (that's its purpose). `src/evals` is pure logic
  (no I/O); the runner (`scripts/evals.ts`) is gated + not type-checked (lives outside tsconfig).
- **M016 S01 #129 (holdout/dev split, PR #163 `f9cb6ad`) — do not collapse the split or weaken its
  guard.** `evals/scenarios/` = sealed HOLDOUT (gate-only, `--scenarios` default, what the S02 release
  gate runs); `evals/scenarios-dev/` = DEV iteration material (starts empty, README keeps it tracked).
  **THE ONE-WAY DOOR:** never promote/copy a tuned dev scenario into the holdout — author a NEW
  never-tuned scenario from scratch instead. `test/evals-scoring.test.ts` enforces this mechanically
  (disjoint by scenario **name AND normalized fixture path**; `toSplitKey` rejects absolute fixtures;
  `loadScenarioFiles` lets ENOENT throw loudly — both dirs are tracked so a missing dir = a typo, not
  an empty split). Do not re-add the ENOENT→[] swallow, do not weaken the disjointness/synthetic tests,
  do not move a dev fixture path to collide with a holdout one. The re-author-from-scratch evasion is
  deliberately documented-discipline-only (file-level indistinguishable from a new scenario). Do not
  reopen #129 / PR #163. (Declined in review: the round-5 Windows-absolute-path nit — hypothetical on
  Linux/macOS CI with committed repo-relative fixtures; the POSIX `/` check is sufficient here.)
- Do not re-export `src/publisher/inline-comment-markdown.ts` from `publisher/index.ts` (#82/#83 review):
  it encodes the `code-reviewer-inline` wire format + the security-sensitive dedup parser;
  keep it off the public API. Adapters/tests import it via the direct file path. The renderer
  unicode-escapes `>` in the embedded metadata (prevents `-->` HTML-comment breakout); don't undo that.
- Do not set `sensitivePaths`/`ignoredPaths`/`failOn` in `.ai-review.json` expecting them to APPEND to
  defaults — those arrays REPLACE wholesale (`normalizeReviewConfig`); object maps (`reviewerPolicy`/
  `timeouts`/`modelRouting`) merge. The repo `.ai-review.json` deliberately re-lists the 5 default
  sensitivePaths before its gate-file additions; don't drop them. Documented in `../user/configuration.md`.
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
- Full-file grounding content (#214) is PR/MR-head content: untrusted reviewed-repo data for
  deterministic matching ONLY. It may be fetched through `readChangeFileAtHead` / local
  working-tree reads and passed as an internal runner map to `assessFindingGrounding`, but it must
  never be put on `ReviewContext`, reviewer/coordinator prompts, `change-context.json`, trace
  payloads, telemetry/rollups, summary hidden metadata, or state records. Counts/bytes-only
  observability is fine; paths and file bodies are not.
- Do not ground/drop findings against the narrative `evidence` field (the #54.2 trap). Real
  `evidence` is prose or about-absence, not verbatim quotes → string-matching it false-drops real
  findings (violates principle #1). Grounding requires a contractually-verbatim field
  (`quotedCode`) FIRST. Don't "fix" the resulting test failures by rewriting fixtures to bare
  quotes — that masks the flaw (the implementer did this; it's wrong).
- Do not re-investigate #65 (CLOSED, works-as-designed). Reviewers/thinking/runtime/CI all work;
  thinking is a CAP not a floor → trivial diffs correctly yield fast empty reviews. A fast/empty
  CI review on a small clean PR is EXPECTED, not a regression. Only reopen if a *substantive* diff
  produces an empty/no-thinking review (use the repro recipe in "Last action" to check).
- A reviewer/coordinator Pi turn that ends in `stopReason:"error"` is a **failure, not an empty
  review** (#283). `processRunner.run()` *returns* (does not throw) such turns, so
  `assertNoTerminalModelError` (sibling to `assertNotTruncatedOutput`) throws on them in both
  `runReviewer` and the coordinator loop, preserving the provider error text so `classifyError`
  maps it to `provider_error`. `provider_error` is **non-degradable** → all-reviewers-error makes
  the run throw → CI exits non-zero (fail-loud). Do NOT revert this to reading an errored turn as
  `0 findings` — that reproduces the #281 silent ✅-Approved-on-credit-outage. This is the
  *substantive-diff* counterpart to the #65 trivial-diff exemption above: a fast empty review on a
  trivial diff is fine; an empty review because every reviewer hit a provider error is the bug.
- Do not expose provider secrets or disable the real-Pi review workflow's default-off gate.
