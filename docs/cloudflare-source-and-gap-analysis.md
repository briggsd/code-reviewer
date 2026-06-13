# Cloudflare AI Code Review — source inventory & gap analysis

**Reference point.** This project was inspired by Cloudflare's
[*"How we built our AI code review system"*](https://blog.cloudflare.com/ai-code-review/).
This doc is a faithful capture of that source's load-bearing technical detail (Part A) plus a
capability-by-capability comparison against what this repo has **shipped** and **planned**
(Part B), with a summary of where we are at parity, where we exceed it, and the remaining gap
backlog (Part C).

- **Captured:** 2026-06-13. Source metrics window: 2026-03-10 → 2026-04-09 (their first 30 days).
- **Not a spec.** The source is one team's internal GitLab-only OpenCode deployment. We are a
  runtime-neutral, GitHub+GitLab, *published* package — so several differences are deliberate
  divergence, not gaps. Read the Part B verdicts, not just the rows.
- See also `docs/runtime-comparison.md` (the OpenCode-vs-Pi decision that flowed from this source).

---

## Part A — Faithful source inventory

### Architecture & pipeline
- CI-native orchestration around **OpenCode** (open-source coding agent). Trigger = GitLab MR
  webhook. Output = a single structured review comment + per-file inline findings.
- Coordinator spawned as a child process (`Bun.spawn`, prompt via stdin to dodge `ARG_MAX`);
  sub-reviewers via OpenCode SDK `session.create()` + `session.promptAsync()`.
- JSONL streaming with 100-line / 50 ms buffer flush. Config assembled by a plugin-based
  `ConfigureContext` into `opencode.json`.

### Risk tiering
| Tier | Lines | Files | Agents | Coordinator | Sub-reviewers |
|---|---|---|---|---|---|
| Trivial | ≤10 | ≤20 | 2 | Sonnet | 1 generalist |
| Lite | ≤100 | ≤20 | 4 | Sonnet | quality + docs + … |
| Full | >100 or >50 files | any | 7+ | Opus | all specialists |
- Materiality override: any security-sensitive path (`auth/`, `crypto/`) forces full review.

### Agent roster (7 specialists + coordinator)
Coordinator (dedup / re-categorise / false-positive filter / approval decision) + **Code
Quality, Security, Performance, Documentation, Release Management, Compliance (Codex/RFC
alignment), AGENTS.md reviewer** (assesses whether changes warrant instruction-file updates;
materiality-classifies high/medium/low; penalises filler, files >200 lines, tool names without
runnable commands).

### Model routing
Top-tier coordinator = Claude Opus 4.7 / GPT-5.4; standard = Sonnet 4.6 / GPT-5.3 Codex;
lightweight = Kimi K2.5 (Workers AI). Dynamic via a `reviewer-config` Cloudflare Worker + Workers
KV: can disable a provider in ~5 s, reshape failback chains, A/B or emergency-downgrade per
reviewer — all without a code change.

### Context sharing
Per-file patch files in a `diff_directory` (agents read only relevant patches); shared
`shared-mr-context.txt` on disk that sub-reviewers read instead of re-embedding full MR context
in each of 7 prompts. Coordinator prompt = MR metadata/comments/prior-findings/paths/custom
instructions as structured XML.

### Deterministic vs agentic
Deterministic: diff filtering, tiering, agent selection, boundary-tag sanitisation, timeout/retry
scheduling, approval rubric, cache tracking, token budgeting. Agentic: what counts as a
violation, severity, tool use (read/grep/search), dedup judgement, false-positive filtering.

### CI merge gate
GitLab CI component. Rubric → `approved` / `approved_with_comments` / `minor_issues` (POST
unapprove) / `significant_concerns` (request-changes, blocks). **Approval-leaning** (single
warning = approved_with_comments, not block). `break glass` comment forces approval (tracked;
0.6% of MRs). Local `/fullreview` TUI plugin runs identical agents on the working tree.

### Output / re-review
MCP comment server posts inline DiffNotes + summary; dedup keeps one finding in best-fit
section; coordinator re-categorises. Incremental re-review: coordinator gets prior review text +
inline-thread resolution status → fixed omitted (thread auto-resolved), unfixed re-emitted,
user-resolved respected unless materially worse, "I disagree" replies → coordinator reads
justification and resolves or **argues back**.

### Reliability
**Circuit breaker** (Hystrix-style) per model tier: open/closed/half-open, 2-min cooldown probe,
failback chains within a family (`opus-4-7 → opus-4-6 → null`). Error classification: `APIError`
(429/503) retryable→failback; `ProviderAuthError` / `ContextOverflowError` / `MessageAbortedError`
/ structured-output errors → no failback. Coordinator hot-swaps model in `opencode.json` on
retryable stderr ("overloaded"/"503"). Timeouts: per-task 5 min (10 for code quality), overall
25-min cap, 2-min retry-budget minimum. 60-s inactivity kill; 30-s heartbeat log.

### Telemetry & 30-day results
Fire-and-forget Worker `TrackerClient` (2-s timeout, ≤50 pending), token usage by model/provider,
Prometheus. **131,246 runs / 48,095 MRs / 5,169 repos; median 3m39s; avg cost $1.19 (median
$0.98, P99 $4.45); 120B tokens; 85.7% cache hit; 159,103 findings (~1.2/review).** Cost by tier:
trivial $0.20 / lite $0.67 / full $1.68. Security has the highest critical share (4%).

### Security / trust
Boundary-tag stripping (regex removes user-supplied `<mr_input>`, `<mr_body>`, `<mr_comments>`,
`<changed_files>`, `<previous_review>`, … to block XML breakout); env sanitised before spawn;
plugins isolated (GitLab plugin can't read AI Gateway config; VCS coupling confined to
`ci-config.ts`); diffs read from disk patches, not prompts.

### Diff filtering
Strips lockfiles (`bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`,
`go.sum`, …), `.min.js`/`.min.css`/`.bundle.js`/`.map`, and generated markers (`// @generated`,
`/* eslint-disable */`). **DB migrations exempt** from generated-file filtering.

### Stated lessons
"What NOT to flag" sections killed the speculative-warning firehose; specialised agents beat a
monolithic prompt; risk tiering avoids trivial-diff token waste; 0.6% break-glass ⇒ earned trust.
Naive "diff + half-baked prompt" was noisy/hallucinated. **No evaluation / quality-measurement /
feedback-loop discipline is described** (explicitly absent). Acknowledged limits: architectural
*why*, cross-system impact, subtle concurrency, cost scales with diff size; "not a replacement for
human review."

---

## Part B — Gap analysis vs this repo

Legend: ✓ parity · ◐ partial · ✗ gap · ★ we exceed the source · ⟂ deliberate divergence

| Capability | Cloudflare | This repo | Verdict |
|---|---|---|---|
| Pipeline shape | trigger→…→publish→status | same (`run-review.ts` spine; CLAUDE.md lifecycle) | ✓ |
| Runtime | OpenCode-coupled | runtime-neutral `AgentRuntime` (dummy/pi; opencode pluggable) | ★ ⟂ |
| VCS | GitLab only | GitHub **and** GitLab adapters | ★ |
| Risk tiering | trivial/lite/full + security override | `risk-classifier.ts` + `tier-profile.ts` (#21/#104); sensitive-path escalation (#101) | ✓ |
| Specialist roster | quality/security/perf/docs/release/compliance/AGENTS.md | quality/security/perf/docs + release+compliance (#23) + **comprehension gate (#26, theirs lacks)** | ◐ (no AGENTS.md reviewer) / ★ (comprehension) |
| Context sharing | per-file patches + shared-context file | `context-artifacts.ts` (changeContextPath, patchDirectory, contextReferences) | ✓ |
| Determinism split | code orchestrates / LLM judges | identical philosophy (principle #3) | ✓ |
| Merge gate | approve/unapprove/request-changes rubric | `ci/decision-policy.ts` `decideCiOutcome`; same decision vocab | ✓ |
| Fail-open vs fail-closed | not a project choice (always posts) | **explicit per-project policy** (principle #7) | ★ |
| break glass | comment override (0.6%) | `#22` (PR #112), routed through `decideCiOutcome({overridden})` | ✓ |
| Output + dedup | inline + summary, cross-reviewer dedup, re-categorise | `publisher/` + grouped renderer (#33) + dedup (#84); inline gated/experimental | ◐ (inline more cautious by design) |
| Re-review / incremental | prior-findings aware; fixed/unfixed/resolved | `re-review.ts` (new/recurring/fixed/withheld/carried_forward) + `incremental-review.ts` (#46) + GitLab (#115) | ✓ |
| Conversational replies | "I disagree" → coordinator argues back | acknowledgements (#69, base-branch acks) — **no interactive argue-back** | ✗ |
| Diff filtering | lockfiles/minified/generated + migration exemption | `diff-filter.ts` + `// @generated` markers (#24, PR #123) | ◐ (verify migration exemption) |
| Circuit breaker / failback chains | Hystrix per-tier, provider health, cross-gen failback | `error-classifier.ts` classifies retryable/terminal; retry-reserve — **no breaker / health states / failback chains** | ✗ |
| Dynamic model routing | KV provider-disable in ~5 s, per-reviewer override | static `modelRouting` + `selectModel`; thinking caps (#45/#53) — **no runtime health switch** | ◐ |
| Inactivity kill / heartbeat | 60-s kill + 30-s heartbeat | heartbeat events + progress reporter (#41) — inactivity-kill less explicit | ◐ |
| Cost / cache telemetry | real $/token, 85.7% cache hit | `TokenUsage` carries `estimatedCostUsd`/`cacheReadTokens`; **populated only when provider supplies it** (bytes/4 elsewhere) | ◐ |
| Telemetry egress / privacy | internal Worker (single tenant) | counts-only boundary (#50) + redaction (#57) + remote transport (#51) + flywheel fan-in (M016 S06) — **built for multi-tenant/published** | ★ |
| Evaluation / quality loop | **none described** | holdout eval harness (#28) + **review-quality flywheel (M016)** | ★ |
| Mechanized arch boundaries | plugin isolation (convention) | `dependency-cruiser` blocking in CI (#27) | ★ |
| AGENTS.md freshness | dedicated agentic reviewer | mechanical `docs:check` (#29); agentic version is an M012 candidate | ◐ |
| Local mode | `/fullreview` TUI | `--git-diff` local runs (no PR/publish) | ◐ |
| Published-package target | internal service | the product goal (CLAUDE.md "Product target") | ★ ⟂ |

---

## Part C — Summary

**At parity (the core is reproduced):** pipeline shape, risk tiering, context-sharing, the
deterministic/agentic split, the merge-gate rubric + decision vocab, break-glass, dedup/re-review,
diff filtering, prompt-injection boundary handling.

**Where we exceed the source:**
- **Evaluation & improvement** — the source describes *no* eval/quality loop; we have the holdout
  harness (#28) and the M016 flywheel. This is our clearest lead.
- **Runtime-neutral + dual-VCS + published-package** posture (they are OpenCode/GitLab/internal).
- **Multi-tenant-grade telemetry boundary** (counts-only egress + redaction), **mechanized
  architecture boundaries**, **explicit fail-open/closed policy**, and the **comprehension gate**.

**Gap backlog (candidate future work — source has it, we don't):**
1. **Circuit breaker + cross-generation model failback chains + provider-health states** — the
   biggest *reliability* gap. Their breaker (open/half-open, 2-min cooldown, `opus→opus-prev`
   failback, coordinator hot-swap) has no analogue here; `error-classifier.ts` only labels
   retryable/terminal. High-value for a published package on moving providers.
2. **Dynamic runtime model/provider routing** (disable a provider in seconds without a deploy) —
   pairs with (1); ties to M015's runtime/provider thinking.
3. **AGENTS.md-updates reviewer** (agentic) — partially covered mechanically by `docs:check`;
   the agentic escalation is the parked M012 candidate.
4. **Conversational reply handling** ("I disagree" → coordinator argues back / resolves) — we have
   one-directional acknowledgements (#69), not the interactive thread.
5. **Real cost/$ + cache-hit economics** — contract supports it; needs real provider telemetry
   wired (today bytes/4 approximation). Their 85.7% cache-hit / $1.19-per-review numbers are the
   benchmark to instrument toward (and a natural consumer of the M016 telemetry arm).
6. **Inactivity-kill + richer heartbeat semantics**, **DB-migration exemption** to generated-file
   filtering, **local `/fullreview`-style TUI** — smaller items.

None of these are filed yet. The reliability cluster (1+2) is the strongest candidate for a future
milestone; the rest are issue-sized.
