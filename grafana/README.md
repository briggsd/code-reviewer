# Grafana dashboards

Importable Grafana dashboards over the telemetry this project ships to Loki
(`AI_REVIEW_LOKI_URL`, see [docs/telemetry-export.md](../docs/telemetry-export.md)).

## `dashboards/ai-review-telemetry.json`

Six sections over the `ai_review.run_metrics` and `ai_review.run_event` streams:

- **Run health & volume** — total runs, completion rate (`run.completed` / `run.start`),
  pass rate, break-glass overrides, runs-over-time by outcome, decision breakdown, runs by tier.
- **Cost & tokens** — cost over time by tier, token volume (output / cache read / cache write),
  total + average cost per run. (Cost uses the `bytes/4` approximation — see CLAUDE.md.)
- **Latency by tier** — average and p95 `durationMs` split by trivial / lite / full.
- **Review quality** — findings by severity, the re-review correction signal
  (new / recurring / fixed / withheld), and a raw `run_metrics` drilldown.
- **Re-review dynamics** — findings by reviewer (real-Pi) and re-review rounds per PR.
- **Reviewer reliability (failures)** — runs that carried a reviewer failure (`data.failures[]`):
  count, run rate, failback-exhausted runs, a by-category timeseries, and a failures drilldown.
  Distinct from `outcome=fail` (a blocking *finding*, not a reviewer crashing). **Array caveat:**
  `data.failures` is an array with no scalar count, so these panels key off the *first* failure
  (`data_failures_0_*`) — they count runs-with-a-failure and categorize by the first failure, not
  total failures across the array. Expand the drilldown to see every failed reviewer per run. A
  clean total-failures / per-category-sum chart would need a scalar summary emitted from
  `run-metrics.ts` (`data.failureCount` / `data.failuresByCategory`).

Two template variables: **datasource** (pick your Loki source on import) and
**tier** (multi-select risk-tier filter, defaults to All).

### Import (manual)

Grafana → Dashboards → New → Import → upload the JSON → pick your Loki datasource.

### Push (API)

Idempotent (matched by dashboard `uid: ai-review-telemetry`); secrets stay in your shell:

```bash
GRAFANA_URL=https://grafana.example.com \
GRAFANA_TOKEN=glsa_xxx \
./grafana/push-dashboard.sh
```

`GRAFANA_TOKEN` is a service-account token with **Dashboards: write**.
Optional `GRAFANA_FOLDER_UID` targets a folder (defaults to General/root).
The script needs `bash`, `curl`, and `python3` (it builds the create/update envelope) on PATH.

## Backfilling history (`telemetry:backfill-loki`)

The live runner ships telemetry to Loki only for runs executed after the exporter is configured.
To populate a dashboard with the *full* PR-review evolution, replay the telemetry already captured
in past CI artifacts:

Requires authed `gh` (artifact download) and the same `AI_REVIEW_LOKI_{URL, BASIC_AUTH|AUTHORIZATION}`
env vars the live exporter uses — the script aborts with `AI_REVIEW_LOKI_URL is not set` otherwise.

```bash
bun run telemetry:backfill-loki --runs 100 --dry-run   # preview event count + type breakdown
bun run telemetry:backfill-loki --runs 100             # ship
```

It collects `telemetry.jsonl` from `ai-review.yml` CI artifacts (authed `gh`) and replays each event
through the **same** pipeline the runner uses — `CountsOnlyTelemetryTransport` (the #50 egress
boundary) → `createLokiTelemetryTransport` — preserving each event's original timestamp. It is
idempotent: `--skip-present` (default on) skips events already in Loki, keyed by
`runId+type+timestamp+subtype`, so re-runs ship only genuinely-missing events.

### Gotcha 1 — Loki rejects "out-of-order" history

Loki rejects an entry that is older than ~1h behind the newest timestamp already in its *exact*
stream (`entry too far behind`). Replaying old history into a stream that already holds newer live
events therefore fails. The script routes backfilled events into a **dedicated label namespace** so
they land in fresh streams where an ascending replay is always accepted:

```bash
bun run telemetry:backfill-loki --runs 100 --label backfill=ci
```

Dashboard panels do **not** pin the `backfill` label, so they aggregate live + backfilled streams
transparently. (The clean alternative — delete the streams and re-ship from empty — needs the Loki
delete API, which requires `compactor.retention_enabled: true` on the server; it is off on the
current hosted instance, so the label approach is the working path.)

### Gotcha 2 — Grafana 13 + Loki instant queries → use barchart, not pie/bargauge

Grafana 13's **pie** and **bar gauge** panels cannot consume a Loki *instant* `sum by (label)(…)`
result: Loki returns one frame per series (`[Time, label, Value]`), which those panels collapse to a
single `Value #A`. The "current total grouped by a label" panels here (Decisions, Runs by tier, p95)
therefore use a **bar chart** with a `labelsToFields` transformation and `xField` set to the label —
the only config that renders one named bar per group. `legendFormat` is *not* applied to Loki instant
queries, so don't rely on it for naming. Range/timeseries panels are unaffected (they honor labels).

## Notes on the LogQL

- `riskTier`, `decision`, `outcome` are indexed stream labels — panels group on them directly.
- Numeric fields live in the log line and are extracted with `| json`, which flattens nested
  JSON with `_` (so `data.tokens.estimatedCostUsd` → `data_tokens_estimatedCostUsd`).
- A run that lacks a given key (e.g. a severity bucket with no findings) is simply dropped from
  that series — expect gaps, not zeros.
