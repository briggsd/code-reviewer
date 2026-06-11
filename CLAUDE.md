# CLAUDE.md

Agent onboarding for the **AI Code Review Factory** — a reusable, CI-native AI code
review system for GitHub and GitLab. This file is a map, not the manual: it points to
the canonical docs. Keep it under ~250 lines.

## What this is

A shared review runner installed across many repos, triggered by PR/MR CI, configured
per-project via a small `.ai-review.json` (the core is **never forked** per project).
Deterministic code owns orchestration, state, policy, and CI integration; LLM agents own
judgment-heavy review. GitHub, GitLab, model providers, and agent runtimes are adapters.

Full design: **docs/architecture.md**. Project purpose & status: **README.md**.

## Stack & how to run

- **Runtime:** Bun `>=1.3.0`, TypeScript (ESNext, `type: module`). Bun runs `.ts`
  directly — there is **no build step** in the prototype.
- **Entry point:** `src/cli.ts` (installed as the `ai-code-review` bin).

```bash
bun run check          # bunx tsc --noEmit && bun test  ← THE verification gate. Run before any PR.
bun test               # bun:test suite (tests live in test/)
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --runtime dummy
bun run src/cli.ts run --git-diff --runtime dummy --output-dir .ai-review   # review local changes, no PR. default base HEAD = uncommitted only; --base main for committed branch work. captures telemetry/traces
bun run src/cli.ts schemas        # emit config + structured-output JSON schemas
bun run schema:config             # regenerate .ai-review.schema.json
bun run telemetry:rollup --runs 20 --output telemetry-rollup.json   # aggregate run_metrics from recent CI artifacts (needs authed `gh`; targets the hardcoded .github/workflows/ai-review.yml)
bun run telemetry:analyze --runs 20 --output telemetry-analyze.json  # segmented analysis (by tier/reviewer/decision/rates) from same events; prints human table + writes JSON
bun run lint           # Biome lint+format check (advisory — NOT part of `check`)
bun run lint:fix       # auto-apply Biome fixes
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
test/                          # bun:test specs (~32)   examples/fixtures/ # PR/MR fixtures
docs/                          # canonical design docs (see README "Documents" index)
M0xx-ROADMAP.md / -SUMMARY.md  # sequential milestone roadmaps + completion notes
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

- **Plan and status are kept in separate systems — do not duplicate.** `M0xx-ROADMAP.md`
  holds the *plan and reasoning*: vision, success criteria, sequencing, cross-milestone
  boundaries, and named slices `S01..` (each with `risk:`/`depends:` plan metadata and a
  `→ #NN` link to its GitHub issue). **Status lives in GitHub** — the milestone progress
  bar and each issue's open/closed state. Roadmaps carry **no `[x]`/`[ ]` checkboxes** and
  are never hand-updated when an issue closes; that mirroring is what drifts. Each
  actionable slice = one GitHub issue in the matching milestone. Completed milestones get
  an `M0xx-SUMMARY.md` design/decision record (history GitHub doesn't capture well).
  `M013-ROADMAP.md` is the reference example of this format.
- **`continue.md`** is the session-to-session handoff: last action, next action,
  open threads, and an explicit **Do not** list. Read it first; update it before you stop.

## Conventions & known gotchas

- TypeScript strict everywhere (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`). No `any`. **Strict tsc is the blocking static gate** (the only
  gate folded into `bun run check`). **Biome** (`bun run lint` / `lint:fix`), **knip**, and
  **jscpd** (`bun run dup`) are **advisory** quality tools — run in CI's `quality` job
  (continue-on-error) and available locally, but deliberately not part of `check`.
  Mechanizing architecture-boundary rules is tracked in #27.
- `validateFinding` currently accepts any `reviewer` string; model self-mislabeling is a
  known backlog item, not a guarantee.
- Context/token-savings metrics use a `bytes/4` approximation pending real provider telemetry.
- Config is JSON-first: `.ai-review.json` / `ai-review.json` / `--config`. Regenerate the
  published schema with `bun run schema:config`.
