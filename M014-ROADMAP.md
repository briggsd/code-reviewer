# M014 Roadmap Stub — Telemetry egress and CI collection

> Stub status: tentative. Sourced from a dogfooding gap: PR review runs in CI emit rich
> `ai_review.run_metrics` telemetry, but it never leaves the runner in a usable form, so
> we cannot gather the cross-run signal needed to improve the reviewers. Picks up the
> **"hosted telemetry backends"** line explicitly *deferred from M011*
> (`M011-ROADMAP.md:56`). Build after M011 #20 analytics shape stabilizes; S01/S02 are the
> easy, high-leverage v1.

## Vision

Make review telemetry usable off the CI runner without weakening fail-open delivery or
the trust boundary, and do it in the cheapest order: **artifact-first now, remote
centralization later.** M011 built the in-process `TelemetrySink` and routes run-level
metrics into it; M011 #20 builds the analytics *aggregation* that consumes
`run.json`/metrics. Neither makes the data reachable across runs in CI. The events already
land in a local JSONL file (`src/state/jsonl-telemetry-transport.ts`) that CI uploads as a
per-PR artifact — so v1 needs **no new transport code**, only (a) capturing the *real* run
reliably and (b) a puller that aggregates the artifacts into one dataset. A remote
`TelemetryTransport` adapter for true centralization is phase 2, behind the same seam.

## The gap, precisely

- **Data is ready, delivery is not.** `ai_review.run_metrics` (`run-review.ts:557–617`)
  already carries findings by severity/reviewer, decision/outcome, per-agent token usage
  and prompt metrics, attempt/retry counts, failure categories, re-review new/recurring/
  fixed counts, and context-savings bytes — all counts and metadata, no raw diff or
  finding text.
- **The artifact exists but isn't a dataset.** `.ai-review` → `actions/upload-artifact`
  → per-PR zips. The CI workflow now emits three names: `ai-review-<n>` (dry-run,
  `--runtime dummy`), `ai-review-trusted-<n>` (trusted-publish, also dummy), and
  `ai-review-real-<n>` (trusted-real-review, `--runtime pi`). To learn anything across
  PRs you download and unzip N artifacts by hand. There is no aggregation and no puller,
  so the puller must fetch the whole set and filter by telemetry, not by artifact name.
- **Capture is wrong by default.** The default same-repo path runs `--runtime dummy` (the
  `dry-run` job in `.github/workflows/ai-review.yml`), whose telemetry is deterministic
  noise; real signal only exists when `AI_REVIEW_REAL_REVIEW_ENABLED=true`. S01 fixed the
  `trusted-publish` job to upload `ai-review-trusted-<n>` instead of dropping its
  telemetry, but it still tags events as dummy runtime noise.

## Decision: artifact-first v1, remote phase 2

- **v1 destination = the CI artifact**, which already lives inside the repo's GitHub
  trust domain — zero new infra, zero new transport code, immediate access.
- **The work that makes it useful is the puller**, not the upload: a script that pulls
  `telemetry.jsonl` across recent runs and rolls up `run_metrics` into one
  counts-only dataset.
- **Remote centralization is a later adapter** behind the unchanged `TelemetryTransport`
  seam (HTTP POST first, OTLP later) — promoted only when artifact retention, cross-repo
  fan-in, or query latency becomes the actual bottleneck.

## Source Issues

- GitHub #48 — Reliable real-run telemetry artifact capture (fix dummy-vs-real + `trusted-publish`)
- GitHub #49 — Cross-run aggregation puller → rolled-up `run_metrics` dataset
- GitHub #50 — Counts-only schema + boundary for any shared rollup
- GitHub #51 — Remote `TelemetryTransport` adapter for centralization (phase 2)

These issues are this milestone's work items; **live status is the GitHub milestone
"M014 — Telemetry egress & CI collection,"** not this file. The slices below are the plan
and rationale behind those issues.

## Tentative Success Criteria

- A real Pi review run in CI reliably captures `ai_review.run_metrics` into a
  stably-named artifact; dummy dry-run telemetry is tagged and excludable.
- A maintainer can run one puller command to produce a single rolled-up, counts-only
  dataset from the last N runs — no manual zip archaeology.
- v1 adds no new network path: with nothing configured, runtime behavior is
  byte-identical to today, and delivery still cannot fail the review job.
- Any rollup that is shared beyond the repo carries counts/metadata and stable
  identifiers only; a test asserts no diff text, finding bodies, prompts, or secrets.
- The destination choice (artifact now, remote later) is recorded, with the trigger that
  would promote phase 2.

## Telemetry field update

- `ai-review.run_metrics.v1` now emits a `runtime` field on both completed and failed
  runs. The value is the sanitized runtime name; today that yields `"pi"`,
  `"dummy"`, `"deterministic"`, and any future real runtime identifier.
- Downstream aggregation should exclude `NON_REAL_RUNTIME_KINDS`
  (`"dummy"`, `"deterministic"`) when calculating production signal, relying on the
  telemetry tag rather than artifact naming.

## Cross-Milestone Boundary

- **vs M011 #20 / S06 (analytics aggregation).** M011 builds the aggregation logic that
  *reads* run metrics; M014 makes those metrics reachable across runs in CI. S06's
  "maintainers can inspect … by reviewer and risk tier" is only true off a single
  checkout once M014's capture + puller land. Acceptance-rate caveats from
  `M011-ROADMAP.md:26` still apply — collection does not make thin samples trustworthy.
- **vs M011 deferral.** M011 deferred "hosted telemetry backends" and "full dashboards."
  M014 v1 deliberately does *not* add a backend — it reuses the artifact. The remote
  adapter (phase 2) is still adopter-owned egress, not a hosted service or dashboard.

## Slices

> **Status lives in GitHub** once issues are filed. This section is the plan and
> rationale, not a tracker (no `[x]`/`[ ]` checkboxes). `risk:`/`depends:` are plan
> metadata; `depends:` references other slices unless a hard data dependency is stated.

- **S01 — Reliable real-run telemetry artifact capture** → #48 · `risk:low` · `depends:[]`
  > Ensure the real Pi review run's `run_metrics` is always uploaded under a stable
  > artifact name; fix `trusted-publish` so its local telemetry is not silently dropped;
  > tag every event with the runtime kind so dummy dry-run noise is filterable. No new
  > transport code — reuses `JsonlTelemetryTransport` + `upload-artifact`.

- **S02 — Cross-run aggregation puller** → #49 · `risk:medium` · `depends:[S01]`
  > A `gh`/artifacts-API script that downloads `telemetry.jsonl` across the last N runs
  > and rolls up `run_metrics` (by reviewer, risk tier, decision, retries, cost/yield)
  > into one counts-only dataset. This is the slice that actually delivers "access."
  > Opt-in, run-on-demand; no change to the review hot path.

- **S03 — Counts-only schema and boundary for shared rollups** → #50 · `risk:medium` · `depends:[S02]`
  > A schema-versioned, allowlisted rollup record plus a test asserting no raw diff,
  > finding body, prompt text, repo file content, or secret can appear in a rollup that
  > leaves the repo trust domain. Reaffirms the M008 rule (`M008-ROADMAP.md:63`) and
  > documents the identifier policy (repo + change id are stable identifiers) and the
  > fork/untrusted caveat. Lower urgency while the dataset stays inside the repo artifact;
  > load-bearing the moment a rollup is exported.

- **S04 — Remote `TelemetryTransport` adapter (phase 2)** → #51 · `risk:medium` · `depends:[S01]`
  > Authenticated HTTP POST of newline-delimited `run_metrics` JSON to an adopter-owned
  > endpoint, tee'd alongside the local transport behind the unchanged
  > `TelemetryTransport` contract; reuses the sink's timeout/queue/drop semantics so
  > delivery stays fail-open. OTLP is a later second adapter. **Not in v1** — promote on a
  > concrete trigger (artifact retention loss, cross-repo fan-in, query latency).

## Key design decisions (proposed)

- **Cheapest path that yields a dataset.** v1 is capture-correctness + a puller, not a new
  backend. The artifact already exists and is in the repo trust domain; the missing piece
  is aggregation.
- **Same seam for phase 2.** When remote centralization is warranted, it slots in as a
  `TelemetryTransport` adapter tee'd with the local one — no churn to the v1 artifact path.
- **Fail-open by construction.** The non-blocking sink already bounds the queue, times out
  delivery, and drops on backpressure without failing the job (design principle 7); v1
  adds no blocking path, and phase 2 must not either.
- **Counts-only is enforced, not assumed** — and becomes load-bearing exactly when a
  rollup or remote payload crosses the repo trust boundary; the egress test is the guard.

## Deferred From This Stub

- Hosted telemetry service, dashboards, querying UI, and alerting (stay in M011's deferral).
- OTLP/vendor-specific exporters beyond the eventual generic HTTP adapter.
- Automated reviewer tuning driven by the collected metrics (M011 deferral; also gated by
  the longitudinal-acceptance caveat in `M011-ROADMAP.md:26`).
- Backfill/replay of telemetry from historical artifact zips predating S01's stable naming.
