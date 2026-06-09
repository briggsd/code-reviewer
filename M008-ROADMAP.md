# M008 Roadmap — Robust, observable review runs

## Vision

Make review execution resilient enough for live adopters and observable enough for future optimization work. A single reviewer failure should not collapse an entire run, and the persisted trace/run artifacts should explain what happened, how long each phase took, which agents succeeded or failed, and what token/cost footprint each agent produced.

## Why this milestone is first

This milestone is sequenced ahead of the prompt-quality (M009) and shared-context (M010) work on purpose. **Observability is the instrument we measure all later quality work with.** The vault principle "trace quality caps improvement quality" applies directly: until durations, token/cost, and per-agent outcomes are actually in the trace, we cannot tell whether a new reviewer prompt or a path-based context layout improved review quality or just changed it — every later optimization would be vibes, not measurement. Resilience belongs here too because the system is already running live real-Pi reviews (see `continue.md`), so the `Promise.all` single-failure collapse and unobservable latency are biting today, not hypothetically. M008 turns the trace into a trustworthy measurement substrate so M009–M011 are evaluable.

## Source Issues

- GitHub #12 — Resilience floor: per-reviewer isolation, error classification, bounded retries
- GitHub #18 — Observability: fix Layer-2 trace defects

## Live self-review inputs

The live system already reviews its own PRs and produces findings about itself. These are S0x inputs to this milestone, not separate work. From the PR #9 real Pi review:

- `overallMs` only wraps the runtime coordinator call path rather than the whole run — feeds S04/S05 (isolation + retry budget scope).
- JSON-repair heuristics in the Pi runtime — relevant to S03 error classification (`schema_invalid`/`truncated`).
- Timeout documentation gaps — fold into S06 verification/docs.

Triage live self-review findings into the relevant slice rather than tracking them as a parallel backlog.

## Success Criteria

- Reviewer fan-out is isolated: one reviewer failure degrades that reviewer to unavailable instead of failing the whole review run.
- Per-reviewer failures emit structured `agent.failed` trace events with a stable error classification.
- Retry behavior is bounded by attempt count and remaining overall run budget.
- A silent reviewer (no output for an inactivity window) is killed early and marked errored, rather than burning the full per-reviewer timeout.
- Lifecycle trace timestamps are stamped at event emission time, not copied from run start.
- Run artifacts expose phase durations, overall duration, per-agent token/cost metrics, and run-level totals.
- Existing dry-run, summary publish, GitHub, and GitLab paths keep their current safety posture.

## Slices

- [x] **S01: Correct lifecycle timestamps and phase durations** `risk:low` `depends:[]` `issues:[#18]`
  > Quick win, do first: a localized fix in `run-review.ts`, and the foundation every later slice's durations depend on.
  > After this: `review.started`, `context.built`, `risk.assessed`, `coordinator.completed`, publish, and failure events carry real emission timestamps, and `run.json`/trace artifacts expose fetch/context/risk/coordinator/publish/overall durations where available.

- [x] **S02: Token and cost metrics in trace artifacts** `risk:medium` `depends:[]` `issues:[#18]`
  > After this: reviewer/coordinator `TokenUsage` is emitted on completion events and aggregated into a run-level metrics block with input/output/cache read/cache write/estimated cost totals.

- [x] **S03: Error classification contract** `risk:medium` `depends:[]` `issues:[#12,#18]`
  > After this: runtime errors are classified into stable categories such as `retryable_transient`, `rate_limited`, `auth`, `context_overflow`, `schema_invalid`, `timeout`, `truncated`, `unsafe_fork`, and `unknown`, without leaking secrets.

- [x] **S04: Per-reviewer isolation and `agent.failed` events** `risk:high` `depends:[S03]` `issues:[#12,#18]`
  > After this: reviewer fan-out uses settled results, successful reviewers still feed the coordinator, failed reviewers are preserved as unavailable/error metadata, and every failed reviewer emits `agent.failed` with classification and elapsed time.
  > **Inactivity watchdog (from the Cloudflare primary source):** in addition to the per-reviewer/coordinator/overall timeouts, add a no-output watchdog that kills a session after an inactivity window (Cloudflare uses 60s) and marks it errored with a `timeout`/inactivity classification. Catches silently-crashed sessions that would otherwise burn the full `reviewerMs` (360s) before timing out.

- [x] **S05: Bounded retries within the run budget** `risk:high` `depends:[S03,S04]` `issues:[#12]`
  > After this: retryable reviewer failures can retry under a small bounded policy, but retries stop when attempts are exhausted or the remaining overall review budget is too low.

- [x] **S06: Robustness/observability verification sweep** `risk:medium` `depends:[S01,S02,S04,S05]` `issues:[#12,#18]`
  > After this: tests cover partial reviewer failure, retry/no-retry classification, duration monotonicity, token/cost aggregation, and persisted trace/run artifact shape.

## Key Risks

- `Promise.allSettled` can accidentally weaken fail-closed behavior if coordinator inputs do not distinguish "clean reviewer" from "reviewer unavailable".
- Retry logic can extend runs beyond CI budgets if it ignores the overall timeout.
- Error classification can overfit current Pi stderr/output shapes; keep unknown classification explicit and safe.
- Token/cost telemetry must never include provider secrets, raw prompts, or user-controlled content beyond stable identifiers/counts.
- Duration assertions can be flaky if tests depend on wall-clock timing instead of injectable clocks or coarse monotonic checks.

## Proof Strategy

- Unit tests for error classification with representative transient/auth/schema/timeout/truncation cases.
- Runtime tests where one reviewer fails and other reviewer findings still reach the coordinator.
- Trace tests assert `agent.completed`, `agent.failed`, lifecycle timestamps, elapsed durations, and token/cost fields.
- Retry tests assert retryable errors retry only within attempt/time budgets and non-retryable errors do not retry.
- Existing package and CI-template checks remain green to prove no adoption-surface regression.

## Verification Classes

- **Static:** TypeScript compile and schema/type tests.
- **Unit:** classifier, retry policy, metrics aggregation, duration calculations.
- **Runtime:** fake `AgentRuntime`/Pi process behavior for success, partial failure, truncation, and timeout.
- **Trace/artifact:** JSONL and `run.json` shape assertions.
- **Package:** `bun run check`; package smoke if touched files affect distribution.

## Definition of Done

- S01–S06 boxes complete.
- `bun run check` passes.
- A partial reviewer failure produces a passing/degraded review run when at least one reviewer succeeds and policy allows continuation.
- `agent.failed` is emitted for failed reviewers and `agent.completed` includes token/cost metrics for successful agents.
- `run.json` contains overall duration, phase durations, per-agent metrics, run totals, and failure classifications.
- Out-of-scope resilience features remain explicitly deferred: circuit breakers, model-family failback chains, probe-after-cooldown, non-blocking telemetry sink, heartbeat, and product analytics dashboards.

## Requirement Coverage

- **Reviewer isolation:** S03, S04
- **Retry floor:** S03, S05
- **Trace correctness:** S01, S04, S06
- **Token/cost visibility:** S02, S06
- **Adopter safety:** S04, S05, S06

## Boundary Map

- S01 fixes lifecycle timing and produces duration fields consumed by S06 and later telemetry work (#19/#20).
- S02 exposes token/cost metrics consumed by S06 and later analytics work (#19/#20).
- S03 defines classification consumed by reviewer isolation, retry, `agent.failed`, and later truncation/telemetry work.
- S04 consumes S03 to preserve partial reviewer outcomes for the coordinator and trace layer.
- S05 consumes S03/S04 to add the minimum retry floor without introducing full circuit breakers.
- S06 consumes all prior slices to lock the artifact contract before later telemetry/product analytics milestones.
