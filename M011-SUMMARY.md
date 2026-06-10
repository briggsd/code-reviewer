# M011 Summary — Non-blocking telemetry and run-level product analytics

> Status: **in progress.** S01–S03 (issue #19 — telemetry, truncation, heartbeat) shipped;
> S04–S06 (issue #20 — product analytics) remain open. Live status is the GitHub milestone
> "M011." This file is the append-only build record for shipped slices; the plan lives in
> `M011-ROADMAP.md`.

## Shipped (S01–S03 · #19)

- **S01 — Non-blocking TelemetrySink contract.** `TelemetrySink`/`TelemetryTransport` contracts, `NonBlockingTelemetrySink`, bounded queue/drop accounting, per-event delivery timeout, and a trace-stream failure logger; tests cover transport errors, timeouts, and queue overflow.
- **S02 — Metrics record routing.** Runner emits `ai_review.run_metrics` telemetry (`ai-review.run_metrics.v1`); CLI output-dir writes `telemetry.jsonl`; failed telemetry emits are traced without failing review jobs; tests cover versioned metrics routing and JSONL transport.
- **S03 — Truncation detection and heartbeat.** Pi runtime detects model `finish_reason`/`stop_reason` length-limit termination before JSON parsing so it classifies as `truncated`; `BunPiProcessRunner` emits sparse heartbeat events during long quiet model runs.

## Commits

- `742dc17` — Add non-blocking telemetry sink
- `49bbe2c` — Route run metrics to telemetry
- `f652bf5` — Detect truncation and emit Pi heartbeats

## Verification

```bash
bun run check
# 135 pass, 0 fail, 852 expect() calls
```

## Open (S04–S06 · #20)

- **S04** — Minimum viable product analytics events (run start, completion, mid-run/cross-push correction; persisted with run IDs).
- **S05** — Acceptance signal from re-review classification (fixed/recurring/won't-fix → accepted/not-accepted/rejected by reviewer).
- **S06** — Analytics aggregation and docs (completion/acceptance/correction/cost/yield by reviewer and risk tier).

## Follow-ups

- **S05 is blocked in practice by #31.** The acceptance signal is derived from re-review classification, which currently under-counts recurring findings (stable IDs hash volatile model prose). Land #31 before trusting S05's accepted/rejected numbers — otherwise it's the "activity masquerading as outcome" failure the roadmap caveat warns about.
- S05 acceptance is longitudinal regardless: directional only until enough live multi-push re-reviews accrue (see `M011-ROADMAP.md` caveat).
- Reviewer self-labeling (`finding.reviewer`) is unvalidated — now tracked as #32, and it also corrupts the stable ID feeding S05.
