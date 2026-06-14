# CLAUDE.md

Agent onboarding for the **AI Code Review Factory** — a reusable, CI-native AI code
review system for GitHub and GitLab. This file is a map, not the manual: it points to
the canonical docs. Keep it under ~250 lines.

## What this is

A shared review runner installed across many repos, triggered by PR/MR CI, configured
per-project via a small `.ai-review.json` (the core is **never forked** per project).
Deterministic code owns orchestration, state, policy, and CI integration; LLM agents own
judgment-heavy review. GitHub, GitLab, model providers, and agent runtimes are adapters.

**Product target vs current state (don't anchor on the latter):** the intent is a
*published, multi-repo* package external parties adopt — so when planning, reason at the
publish/adopter boundary (who configures via `.ai-review.json` vs trusted factory code; where
quality/telemetry/secrets cross factory↔adopter; whether a gate belongs at a PR or at
*publish*). The current artifact state is still prototype — `package.json` is `private:true`
at v0.x and `release-package.yml` only emits a tarball artifact, not a registry publish — but
that is the *not-yet*, not the goal. Reviewer definitions are a **shared asset every adopter
inherits**: a regression in the factory's reviewers degrades all downstream repos on upgrade.

Full design: **docs/architecture.md**. Project purpose & status: **README.md**.

## Workflow
- use the delegate-implement skill when working on selected issues
- open PR and work through findings from the ai-review
- merge in
- **Running agents in parallel? One git worktree per agent — never share this checkout.**
  One repo = one HEAD/index/working tree, so two agents here corrupt each other's branch
  work. Spin each concurrent agent into its own checkout:
  `.claude/skills/delegate-implement/new-worktree.sh <branch>` (node_modules pre-symlinked,
  gate-ready); tear down with the sibling `rm-worktree.sh`. Details in that skill's overlay.

## Stack & how to run

- **Runtime:** Bun `>=1.3.0`, TypeScript (ESNext, `type: module`). Bun runs `.ts`
  directly — there is **no build step** in the prototype.
- **Entry point:** `src/cli.ts` (installed as the `ai-code-review` bin).

```bash
bun run gate           # check + boundaries + lint + docs:check  ← THE pre-PR verification gate (mirrors CI's blocking check job)
bun run check          # bunx tsc --noEmit && bun test (the tsc+test core; CI blocks on gate, not just check)
bun test               # bun:test suite (tests live in test/)
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --runtime dummy
bun run src/cli.ts run --git-diff --runtime dummy --output-dir .ai-review   # review local changes, no PR. default base HEAD = uncommitted only; --base main for committed branch work. captures telemetry/traces
bun run src/cli.ts schemas        # emit config + structured-output JSON schemas
bun run schema:config             # regenerate .ai-review.schema.json
bun run telemetry:rollup --runs 20 --output telemetry-rollup.json   # aggregate run_metrics from recent CI artifacts (needs authed `gh`; targets the hardcoded .github/workflows/ai-review.yml)
bun run telemetry:analyze --runs 20 --output telemetry-analyze.json  # segmented analysis (by tier/reviewer/decision/rates) from same events; prints human table + writes JSON. Or read a local fleet dataset: --dataset .ai-review-fleet/telemetry.jsonl (mutually exclusive with --runs, #198)
bun run telemetry:quality --runs 20 --output telemetry-quality-report.json  # quality report (hypothesis queue): segments breaching thresholds; prints table + writes JSON. Or read a local fleet dataset: --dataset <fleet.jsonl> (mutually exclusive with --runs, #198)
bun run telemetry:ingest --input fleet.jsonl --dataset .ai-review-fleet/telemetry.jsonl  # own-fleet fan-in (#136): authenticate (AI_REVIEW_FLEET_INGEST_SECRET) + re-apply counts-only boundary ON RECEIVE, append accepted run_metrics to the fleet dataset telemetry:quality reads
bun run boundaries     # architecture-boundary lint (dependency-cruiser; BLOCKING in CI's check job)
bun run lint           # Biome lint+format check (BLOCKING in CI's check job since #96; not in `check`)
bun run lint:fix       # auto-apply Biome fixes
bun run docs:check     # docs dead-reference linter over tracked *.md (dead path/`bun run` script refs; BLOCKING in CI's check job + gate)
bun run docs:stale     # docs staleness heuristics (env-var drift, oversized docs, src/ dirs missing from CLAUDE.md map, unclosed code fences; ADVISORY, CI quality job)
bun run knip           # unused files/exports/deps (advisory)
bun run dup            # jscpd copy-paste detection over src/ (advisory)
```

Smoke scripts (opt-in, network/model-gated — default tests are fake/no-network):
`pack:smoke`, `smoke:external-package`, `smoke:pi` (needs `AI_REVIEW_LIVE_PI=1`),
`smoke:gitlab` (`AI_REVIEW_LIVE_GITLAB=1`), `smoke:action-wrapper`.

## Repo map

```
src/
  cli.ts, cli/run-options.ts   # CLI entry + arg parsing
  contracts/                   # all adapter interfaces: adapters, review, runtime, telemetry, common
  runner/                      # deterministic orchestration — run-review.ts is the spine
    run-review.ts              #   top-level lifecycle
    config.ts, default-config.ts
    risk-classifier.ts         #   trivial/lite/full tiering  (see #21)
    diff-filter.ts, context-artifacts.ts, stable-finding-id.ts, path-match.ts
    error-classifier.ts        #   retryable vs terminal failures
    re-review.ts               #   new/recurring/fixed/withheld finding classification
    reviewer-definitions.ts    #   TRUSTED, factory-owned reviewer prompts/modules
    fixture.ts                 #   fixture loading for local/dummy runs
    git-diff-source.ts         #   --git-diff: build metadata+diff from local git (no PR, no publish)
  runtime/                     # agent runtimes behind AgentRuntime
    dummy-agent-runtime.ts     #   deterministic, for tests / no-network runs
    pi-agent-runtime.ts        #   real Pi subprocess (JSON mode, project resources disabled)
    prompt-boundary.ts         #   prompt-injection sanitization of untrusted content
  vcs/github, vcs/gitlab       # VCS adapters (metadata + diff + publish)
  publisher/                   # summary + experimental inline write-back (+ inline-readiness gates)
  ci/                          # CI env detection + decision-policy (fail-open/closed)
  state/                       # filesystem state, jsonl trace sink, non-blocking telemetry sink/transport
  schemas/                     # review-config + review-output JSON schemas
  docs-check/                  # pure docs-freshness rules (dead-ref + staleness; CLI = scripts/check-docs.ts)
test/                          # bun:test specs (~32)   examples/fixtures/ # PR/MR fixtures
docs/                          # canonical design docs (see README "Documents" index)
  milestones/                  #   M0xx-ROADMAP/-SUMMARY: sequential milestone plans + completion notes
continue.md                    # session handoff — LOCAL/UNTRACKED (gitignored), machine-only
```

**Extending or testing the codebase?** Start with **docs/extending.md** — integration
recipes (add a telemetry field / config field / CLI flag / prompt injection) and a
**test-infra index** (which capture fake/fixture to use, where to assert). Fastest way to
orient before writing or delegating a change.

## Lifecycle (one sentence per stage)

`PR/MR event → CI job → VCS adapter fetches metadata+diff+prior state → diff filter →
risk classifier → shared context builder → coordinator agent → specialist reviewer
fan-out → coordinator fusion → publisher write-back → CI status → traces/state persisted.`

Details + diagram: **docs/architecture.md**.

## Design principles (load-bearing — violate only deliberately)

1. **CI status is the canonical merge gate.** Comments/reviews are UX only.
2. **Adapters at the edges.** VCS, runtimes, model providers, state, telemetry.
3. **Deterministic orchestration, agentic judgment.** Code does fetch/filter/fan-out/
   timeout/retry/state/publish; agents judge inside bounded contracts.
4. **Specialize by risk & domain.** Cheap review for small diffs; more agents + stronger
   models for risky ones.
5. **Share context deliberately** — never duplicate full PR context into every prompt.
6. **All PR/MR content is untrusted** (titles, descriptions, comments, diffs, repo files
   may carry prompt injection or malicious code).
7. **Fail behavior is policy** — projects choose fail-open vs fail-closed; the choice is explicit.

## Trust & safety boundaries (do not weaken)

- User-controlled metadata is sanitized centrally in `src/runtime/prompt-boundary.ts`
  before prompt assembly. Reviewer-definitions are the only trusted prompt source.
- Reviewed-repo Pi/project-local resources are **disabled** in CI; only factory-owned
  reviewer definitions run. See **docs/fork-safety.md**.
- Never execute untrusted fork code in a privileged CI context.
- Never expose provider secrets or disable the real-Pi review workflow's default-off gate.

## How work is planned here (spec-driven)

- **Plan and status are kept in separate systems — do not duplicate.**
  `docs/milestones/M0xx-ROADMAP.md` holds the *plan and reasoning*: vision, success
  criteria, sequencing, cross-milestone boundaries, and named slices `S01..` (each with
  `risk:`/`depends:` plan metadata and a `→ #NN` link to its GitHub issue). **Status lives
  in GitHub** — the milestone progress bar and each issue's open/closed state. Roadmaps
  carry **no `[x]`/`[ ]` checkboxes** and are never hand-updated when an issue closes;
  that mirroring is what drifts. Each actionable slice = one GitHub issue in the matching
  milestone. Completed milestones get an `M0xx-SUMMARY.md` design/decision record (history
  GitHub doesn't capture well). `docs/milestones/M013-ROADMAP.md` is the reference example
  of this format.
- **`continue.md`** (repo root, **local/untracked — gitignored on purpose**) is the
  session-to-session handoff: last action, next action, open threads, and an explicit
  **Do not** list. Read it first; update it before you stop. It is machine-local working
  state — never commit it.

## Conventions & known gotchas

- TypeScript strict everywhere (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`). No `any`. `bun run check` stays exactly tsc + tests; CI's check job
  additionally runs three BLOCKING steps: `bun run boundaries` (#27), **Biome lint+format**
  (`bun run lint`, blocking since #96 — formatter adopted, debt cleared; bulk-reformat commits are
  listed in `.git-blame-ignore-revs`), and **`bun run docs:check`** (#92/#29 — dead path/`bun run`
  script references in tracked `*.md`; milestone docs are historical and exempt from blocking).
  **knip**, **jscpd** (`bun run dup`), and **`bun run docs:stale`** (docs staleness heuristics)
  stay **advisory** (CI `quality` job, continue-on-error). Actions in the project's own four workflows are SHA-pinned
  (#96); adoption templates in `examples/ci/` keep readable mutable tags by design
  (`test/ci-templates.test.ts` locks that — don't "fix" them).
- **Architecture boundaries are mechanized** (#27): `bun run boundaries` (dependency-cruiser,
  `.dependency-cruiser.cjs`) blocks in CI's check job — runner must not import concrete adapters
  (the runner rule alone exempts two pure leaf utilities: `publisher/markdown-escape.ts`,
  `runtime/runtime-kind.ts`), contracts import only contracts (no exemptions), no cross-VCS
  coupling, no cycles, Pi runtime must route `prompt-boundary.ts`. Rule error messages carry the
  remediation; read them before working around a failure. Biome `suspicious/noConsole` is `error`
  for `src/` (structured trace/telemetry sinks only — `src/cli.ts`, `scripts/`, `test/`, `evals/`
  are exempt) and blocks via the Biome CI step.
- `validateFinding` currently accepts any `reviewer` string; model self-mislabeling is a
  known backlog item, not a guarantee.
- Context/token-savings metrics use a `bytes/4` approximation pending real provider telemetry.
- Config is JSON-first: `.ai-review.json` / `ai-review.json` / `--config`. Regenerate the
  published schema with `bun run schema:config`.
- **CI bun is pinned to `1.3.0`** (`.github/workflows/*.yml`); your local bun is usually newer.
  A green local `bun run gate` can still fail CI on a parser/runtime difference — **CI is the
  real gate; watch the first CI run, don't assume local-green ⇒ CI-green.** Concretely (#46): a
  regex with **literal control-character bytes** in a class (`/[<0x00>-<0x1f>]/`) parsed locally
  but threw `SyntaxError: range out of order in character class` under bun 1.3.0, failing every
  importing test (and `tsc` doesn't evaluate regex literals). Never embed literal control-char
  bytes in a source regex — use `charCodeAt(i) < 0x20` or `\uNNNN` escapes.
- **Never `git add -A` / `git add .`** — stage explicit paths and check `git status` first;
  `continue.md` is gitignored machine-local state that a catch-all add must never sweep into a PR.
- **`AGENTS.md` + `.agents/` are the Codex-CLI port** of this onboarding config (for the
  delegate-implement Codex backend — the Codex CLI reads `AGENTS.md`, the `.claude`→`.agents` /
  `Claude`→`Codex` equivalents of this tree). They are tracked, but `AGENTS.md` is generated from
  this file **by hand with no live sync**: regenerate it with
  `sed 's/CLAUDE\.md/AGENTS.md/g' CLAUDE.md > AGENTS.md` whenever you edit this file so the two
  don't drift.
