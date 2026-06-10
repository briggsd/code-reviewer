# M011 Roadmap Stub — Non-blocking telemetry and run-level product analytics

> Active milestone. Live slice status is the GitHub milestone "M011"; the build record for shipped work is `M011-SUMMARY.md`. This file is the plan and rationale.

## Vision

Separate engineering traces from non-blocking telemetry and add the first product-level analytics layer: completion, acceptance, correction, cost, and reviewer yield by run/risk tier.

## Source Issues

- GitHub #19 — Non-blocking TelemetrySink + truncation detection + heartbeat
- GitHub #20 — Run-level product analytics from re-review signal

Live status is the GitHub milestone "M011," not this file. **#19 governs S01–S03; #20 governs S04–S06.**

## Tentative Success Criteria

- Telemetry delivery can fail or time out without failing the review job.
- Metrics records include run duration, risk tier, selected agents, provider/model, tokens/cost/cache, findings by severity/reviewer, decision, retries, and failures.
- Truncation/length-limit termination is a distinct signal from generic failure.
- Slow runs emit a heartbeat signal suitable for logs/UI without spamming.
- Re-review classification contributes acceptance/correction signals by reviewer and risk tier.
- Product analytics remain above the trace layer and consume `run.json`/metrics rather than replacing JSONL traces.
- Acceptance rate is treated as **directional only** until enough live multi-push re-review cycles have accrued (see caveat below).

## Acceptance is longitudinal — a data-accrual caveat, not just a build

The acceptance signal (`fixed`/`recurring`/won't-fix) is inherently longitudinal: it only exists once a PR has **multiple pushes over time**. S04/S05 can ship the plumbing in a sprint, but the metric is not meaningful until a corpus of live multi-push re-reviews exists. Trusting early per-reviewer acceptance numbers is exactly the vault's "AWUs become the new active sessions" failure — activity masquerading as outcome. Until then, report acceptance with run-count context and treat it as directional; do not tune reviewers on thin samples.

## Slices

> **Status lives in GitHub** — milestone [M011 — Non-blocking telemetry & run-level product analytics] plus each issue's state; the build record for shipped slices is in `M011-SUMMARY.md`. This section is the plan and rationale, not a tracker (no `[x]`/`[ ]` checkboxes). Slices group under the two Source Issues: **#19 covers S01–S03**, **#20 covers S04–S06**. `depends:` references other slices.

- **S01 — Non-blocking TelemetrySink contract** → #19 · `risk:high` · `depends:[]`
  > Telemetry has a bounded queue/timeout/fire-and-forget delivery model whose failures are logged but never fail the review.

- **S02 — Metrics record routing** → #19 · `risk:medium` · `depends:[S01]`
  > Run-level metrics from M008 are routed to the telemetry sink with stable schema/versioning.

- **S03 — Truncation detection and heartbeat** → #19 · `risk:medium` · `depends:[S01]`
  > Length-limit termination is classified separately, and slow model runs emit periodic heartbeat events.

- **S04 — Minimum viable product analytics events** → #20 · `risk:medium` · `depends:[S02]`
  > Run start, task completion, and mid-run/cross-push correction events are persisted with run IDs.

- **S05 — Acceptance signal from re-review classification** → #20 · `risk:medium` · `depends:[S04]`
  > `fixed`, `recurring`, and rejected/won't-fix signals map into accepted/not-accepted/rejected metrics by reviewer. Meaningful only once #31 fixes re-review recurrence detection (see Follow-ups in `M011-SUMMARY.md`).

- **S06 — Analytics aggregation and docs** → #20 · `risk:medium` · `depends:[S04,S05]`
  > Maintainers can inspect completion rate, acceptance rate, correction rate, and cost/yield by reviewer and risk tier.

[M011 — Non-blocking telemetry & run-level product analytics]: https://github.com/briggsd/ai-code-review-factory/milestones

## Deferred From This Stub

- Full dashboards, hosted telemetry backends, and alerting.
- Model-family circuit breakers/failback control plane.
- Automated reviewer tuning based on analytics.
