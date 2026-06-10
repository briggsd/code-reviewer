# M013 Roadmap Stub — Agent-ready codebase

> Stub status: tentative. Sourced from an agent-readiness audit of this repo against the `~/vault/Intelligence` agentic-engineering corpus (agentic-sdlc-guidelines, dark-code-and-comprehension-gate, knowledge-flywheel, harness-engineering-codex-agent-first, scenarios-holdout-evaluation-pattern). Build out incrementally; S01 is high-leverage and unblocks the rest.

## Vision

Make this repository legible and verifiable for the AI coding agents that work in it. The codebase is strong on the build/test/guardrail substrate but light on the agent-facing context and feedback-loop layer — exactly the layer the corpus argues is the real differentiator ("spec-driven → self-describing context → comprehension gate"). This milestone closes that gap: a single onboarding map, mechanically enforced architecture boundaries, a pre-PR comprehension gate that dogfoods our own runner, an outer holdout evaluation set, and a loop that keeps the context corpus fresh.

## Source Issues

- GitHub #25 — Root CLAUDE.md agent-onboarding map (table of contents into /docs)
- GitHub #27 — Mechanize architecture invariants via boundary lint (remediation-in-error-message)
- GitHub #26 — Comprehension gate (fresh-agent pre-PR review w/ allow/warn/block) — dogfood our own runner
- GitHub #28 — Holdout scenario eval set (behavioral, satisfaction-scored, separate from impl tests)
- GitHub #29 — Doc-gardening / knowledge-flywheel loop: keep agent-facing context fresh
- GitHub #32 — `validateFinding` asserts reviewer label matches dispatched role (dogfood-surfaced)
- GitHub #33 — Restructure review summary: group by reviewer, severity badges, progressive disclosure (dogfood-surfaced)

These issues are this milestone's work items; **live status is the GitHub milestone "M013 — Agent-ready codebase,"** not this file. The slices below are the plan and rationale behind those issues.

## Tentative Success Criteria

- A fresh agent can onboard from one ≤250-line `CLAUDE.md` that maps to the canonical `/docs`, the M0xx workflow, and the trust boundaries — without reconstructing the mental model from a dozen files.
- Load-bearing architecture invariants (adapter direction, prompt-boundary sanitization, structured logging) are enforced mechanically in `bun run check`, with remediation instructions in the error message so an agent self-corrects.
- A pre-PR comprehension gate produces a standardized Q&A plus an `allow`/`warn`/`block` decision, reusing the existing reviewer/decision-policy/publisher machinery; advisory by default, blocking opt-in per project config.
- A holdout scenario eval set lives outside the implementation, scores review quality by satisfaction fraction over K runs, and includes at least one clean diff that must not be over-flagged.
- A freshness loop fails on dead doc references and flags likely-stale guidance, keeping the context corpus from rotting.
- The default `bun run check` stays fast, fake, and no-network; live/model-dependent additions (comprehension gate, evals) are separate opt-in gated commands like the existing smoke scripts.

## Cross-Milestone Boundary

- **#29 vs M012 "AGENTS.md freshness reviewer."** M013 S05 is the lightweight, in-repo, mechanical freshness check — a standalone `docs:check` script (dead-reference linter + staleness heuristics) that is also wired into `bun run check`. The M012 candidate workstream is the heavier agentic reviewer escalation (a full reviewer detecting instruction rot across package manager / test framework / build tooling). Ship the mechanical floor here; promote the agentic version under M012 only on a concrete trigger.
- **#26 comprehension gate** reuses, and pressure-tests, the portable reviewer/coordinator contract from M009 S03 and the CI decision policy from M008. It is the same "deterministic orchestration, agentic judgment" seam, pointed inward at our own diffs.

## Slices

> **Status lives in GitHub** — milestone [M013 — Agent-ready codebase] (progress bar) plus each issue's open/closed state. This section is the **plan and rationale**, not a tracker: it is *not* hand-updated when an issue closes, and carries no `[x]`/`[ ]` checkboxes. Each slice maps 1:1 to a Source Issue above; `risk:`/`depends:` are plan metadata (`depends:` references other slices, not a hard data dependency unless stated).

- **S01 — Root CLAUDE.md onboarding map** → #25 · `risk:low` · `depends:[]`
  > A ≤250-line `CLAUDE.md` at repo root — stack/run commands, the real `src/` map, the 7 design principles, trust boundaries, the M0xx + `continue.md` workflow, and known gotchas — pointing to `/docs` rather than duplicating it.

- **S02 — Boundary lint with remediation messages** → #27 · `risk:medium` · `depends:[]`
  > `bun run check` fails when runner/contract code imports a concrete adapter, or when prompt assembly bypasses `prompt-boundary.ts`, each with a remediation message naming the fix. Adapter-direction rule first (highest value).

- **S03 — Comprehension gate reviewer + decision policy** → #26 · `risk:high` · `depends:[S02]`
  > A trusted `comprehension` reviewer definition answers the standardized rubric (dependency choices, failure modes, security implications, separation of concerns, downstream breakage, comprehensibility) and emits `allow`/`warn`/`block`; the CI decision policy maps the decision (advisory by default); the Q&A renders into the summary. Runs deterministically on a fixture via the dummy runtime. (`depends:[S02]` encodes the sequencing preference — S03 exercises the boundaries S02 protects mechanically — not a hard data dependency.)

- **S04 — Holdout scenario eval set** → #28 · `risk:medium` · `depends:[]`
  > An opt-in `bun run evals` runs ≥5 behavioral scenarios (including a clean diff that must not be over-flagged) through the CLI, scores findings against declared criteria with statistical (K-run) satisfaction, and stores scenarios under `evals/` separate from `examples/fixtures/` to preserve holdout hygiene.

- **S05 — Doc-gardening / knowledge-flywheel loop** → #29 · `risk:low` · `depends:[S01]`
  > A standalone `docs:check` script (also invoked from `bun run check`) fails on dead path/script/env-var references across `*.md`, warns on oversized/likely-stale docs and run-instruction drift, and a written gardening playbook defines the recurring pass. Reference-load tracking is deferred to telemetry/M011.

- **S06 — Reviewer-label assertion** → #32 · `risk:low` · `depends:[]`
  > `validateFinding` asserts `finding.reviewer === reviewerDefinition.role` at the specialist boundary (normalize or reject on mismatch); coordinator multi-role path untouched. Closes label-spoofing and stabilizes the finding identity. Surfaced by the PR #30 dogfood; lands before S03 (which adds a third label-emitting reviewer).

- **S07 — Review summary layout** → #33 · `risk:medium` · `depends:[]`
  > Restructure `summary-markdown.ts`: group findings by reviewer with severity-count badges, a top synthesis line, one-line findings, and progressive disclosure (`<details>` collapses the Why/Evidence prose). Directly fixes the output verbosity #28 measures.

[M013 — Agent-ready codebase]: https://github.com/briggsd/ai-code-review-factory/milestones

## Sequencing

S01 (CLAUDE.md, #25) shipped first and gives every later slice a map. The rest fall into four waves — within a wave, slices are independent and can run in parallel:

- **Wave 1 — foundation (cheap, unblocks the rest):** S02 boundary lint (#27) · S06 reviewer-label assertion (#32). Both are small, mechanical, and protect work the later waves build on; S06 also stabilizes finding identity (compounds M011 #31) and must precede S03's new reviewer.
- **Wave 2 — output quality:** S07 summary layout (#33) → then S04 holdout evals (#28), so the eval asserts the restructured layout. S04 is also best done after M011 **#31** (re-review recurrence) so its re-review scenario is meaningful.
- **Wave 3 — the big feature:** S03 comprehension gate (#26, `risk:high`) — after Wave 1 (needs S02's boundaries in place and S06's label guard, since it adds a third label-emitting reviewer).
- **Wave 4 — finish:** S05 doc-gardening (#29), once there is enough corpus to be worth gardening.

Shortest path to value: **#27 + #32 → #33 → #26**, with #28 and #29 trailing.

## Deferred From This Stub

- Full knowledge-flywheel automation (a scheduled doc-gardening agent that opens fix-up PRs) — start with the manual playbook + mechanical checks; automate on a proven trigger.
- Reference-load instrumentation (which docs are actually read in agent sessions) — depends on the M011 telemetry substrate.
- Agent attribution metadata in build artifacts (AI-involvement classification) — real per the corpus, but low priority at current scale; revisit if the project goes multi-contributor or regulated.
- The heavier M012 "AGENTS.md freshness reviewer" agentic escalation (see Cross-Milestone Boundary).
