# Telemetry export

## Export schema: `ai-review.rollup_export.v1`

`createRollupExport` (in `src/state/rollup-export.ts`) builds a schema-versioned,
counts-only export record from a stream of telemetry events. The exported shape is:

```ts
{
  schemaVersion: "ai-review.rollup_export.v1",
  generatedAt: string,           // ISO-8601, caller-supplied
  runCount: number,
  sourceEventTypes: string[],    // sorted, deduplicated
  repositories: string[],        // unique shape-bounded repository slugs
  droppedRepositoryCount?: number, // only present when > 0
  sanitizedAggregateKeyCount?: number, // only present when > 0 — aggregate keys folded into __other__
  rollup: RunMetricsRollup,      // aggregate with all Record keys shape-bounded
}
```

The function is pure (no I/O, no `Date.now()`). Scripts supply `new Date().toISOString()`.

### Allowlist-by-construction principle

The export is safe by construction, not by audit:

1. **Event type filter.** Only events whose `type` is in `EXPORTABLE_EVENT_TYPES` contribute
   to the export. Foreign event types are dropped entirely — none of their fields ever reach
   the output.

2. **Aggregate counts only.** `rollupRunMetrics` collapses raw event data into counts and
   numeric aggregates. No raw field values (diff text, finding bodies, prompt fragments)
   survive into `RunMetricsRollup`.

3. **Shape-bounded aggregate keys.** Every `Record<string, …>` key in the rollup
   (`runtimeCounts`, `riskTierCounts`, `decisionCounts`, `findings.byReviewer`,
   `retries.*ByRole`, `tokens.byRole`) is checked against a conservative identifier
   pattern before the export is assembled. Keys that fail are merged into the
   `"__other__"` bucket (a name that itself fails the pattern, so no legitimate key can
   collide with it) and counted in `sanitizedAggregateKeyCount`, so counts are preserved
   but no free text, newlines, prompt fragments, or secret-shaped strings can reach an
   export destination.

4. **Shape-bounded repository slugs.** Repository slugs are checked against a
   `owner/repo`-shaped pattern; non-conforming values are dropped (not replaced) and
   counted in `droppedRepositoryCount` for observability.

## Identifier policy (M008)

M008 rule: telemetry and exports carry **counts, shape-bounded keys, and stable
identifiers only** — never raw prompts, diff text, finding bodies, or user-controlled
content.

**Allowed stable identifiers:**
- Repository slug (`owner/repo`) — collected into `repositories`.
- `changeId`, `headSha`, and `runId` are also allowed as stable identifiers within events
  (e.g. `ai_review.run_event` subtypes) but are **not carried into the rollup-level
  export** — the export is aggregate-only.
- When a stable identifier (including `runId`) is used as a `Record` **key** in an
  aggregate, it must satisfy the aggregate-key pattern below (letter-first); identifiers
  that can start with a digit (UUIDs, timestamp prefixes) must be prefixed (e.g. `run-`)
  or their counts silently fold into `__other__`.

**Never permitted:**
- Branch names, PR/MR titles, author names — controlled by fork contributors (principle 6).
- Finding bodies, quoted code, diff text — free-form reviewer or model output.
- Prompt fragments, model instructions — operator secrets.
- Any content derived from untrusted PR/MR input.

## Shape-bound rule for aggregate keys

Aggregate keys are bounded by the pattern `/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/`.

This is intentionally **not a closed value set**. Any well-formed future runtime kind
(e.g. `codex`, `gemini`) or reviewer role (e.g. `compliance_v2`, `security.advanced`)
passes automatically without requiring a schema change. What the pattern rejects is free
text (spaces, newlines), long strings (> 64 chars), and special-character sequences that
appear in prompt-injection payloads or secret strings — not unknown-but-valid identifiers.

Keys that fail the pattern are merged into a single `"__other__"` bucket per aggregate
map (the bucket name starts with `_`, so it fails the pattern itself — a legitimate
runtime kind or reviewer role literally named `other` is preserved untouched and can
never be confused with sanitized overflow). Counts are never lost; only their
association with a potentially-poisoned key is severed. The total number of folded keys
is reported in `sanitizedAggregateKeyCount` so operators can see the boundary fired
without learning the rejected content.

## Migration from the pre-v1 rollup output

Before this schema, `bun run telemetry:rollup` wrote a **raw `RunMetricsRollup`** to the
output file — no schema version, all aggregate fields at the top level. Downstream
parsers must update their field paths:

- `$.runCount` stays `$.runCount` (also mirrored inside the envelope).
- Every other rollup field moves under `.rollup`: `$.runtimeCounts` →
  `$.rollup.runtimeCounts`, `$.findings.byReviewer` → `$.rollup.findings.byReviewer`, etc.
- New top-level fields: `schemaVersion` (check it!), `generatedAt`, `sourceEventTypes`,
  `repositories`, optional `droppedRepositoryCount` / `sanitizedAggregateKeyCount`.
- Aggregate keys are now shape-bounded: model-authored reviewer labels (or any key with
  spaces/special characters) that previously appeared verbatim will surface as
  `__other__` after the upgrade — check `sanitizedAggregateKeyCount` if expected keys
  seem to be missing.

## Event vocabulary: `ai_review.run_event` (#20 / #22)

`EXPORTABLE_EVENT_TYPES` includes `ai_review.run_event`. The type is actively emitted
as of issue #20 (S04–S06). Each run_event carries `type: "ai_review.run_event"`, a
`runId` (stable identifier), `timestamp` (ISO-8601), and a `data` block with
`schemaVersion: "ai-review.run_event.v1"` plus subtype-specific fields.

### Emitted subtypes

| Subtype | Emitted | Payload (counts/identifiers only) |
|---|---|---|
| `run.start` | Every run (before agents execute) | `event`, `schemaVersion`, `repository` (slug), `changeId`, `riskTier`, `selectedReviewerRoles` (string array), `modelIds` (unique sorted string array — **configured intent**, from `.ai-review.json` / default config) |
| `run.completed` | Completed runs only (not failed) | `event`, `schemaVersion`, `repository`, `riskTier`, `decision`, `outcome`, `durationMs`, `findingCount`, `findingsBySeverity` (counts), `findingsByReviewer` (counts), `tokens?` (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`estimatedCostUsd` numbers — present only when the run has token metrics) |
| `run.correction` | Completed runs with a prior-state comparison or acknowledged findings | `event`, `schemaVersion`, `repository`, `riskTier`, `newFindingCount`, `recurringFindingCount`, `fixedFindingCount`, `withheldFindingCount`, `acceptanceByReviewer` (per-reviewer counts: accepted/notAccepted/rejected/withheldExcluded) |
| `run.override` | A run for which a trusted commenter posted a `break glass <head-sha>` PR/MR comment (#22 phase 2) | `event`, `schemaVersion`, `repository`, `changeId`, `riskTier`, `overrideCommentId` (stable identifier of the triggering comment — the audit pointer; never an author name), `authorAssociation` (coarse role category that authorized it — one of `OWNER`/`MEMBER`/`COLLABORATOR`, the same three values for both GitHub and GitLab: GitLab Developer/Maintainer/Owner access maps to COLLABORATOR/MEMBER/OWNER. Like `riskTier`, not an author name) |
| `run.prior_decision_respected` | A merge-state observation for a prior review run (#257) | `event`, `schemaVersion`, `repository`, `changeId`, `riskTier`, `priorDecision`, `priorOutcome?`, `priorBlocked?`, `merged`, `overrideRecorded`. The event uses the prior run's `runId` and carries no PR title/body, comments, author names, branch names, finding text, or override reasons. When `priorBlocked` is absent, `telemetry:analyze` falls back to `priorOutcome: "fail"` or a `priorDecision` of `review_required`, `significant_concerns`, or `review_failed`; explicit `priorBlocked: false` is authoritative. |

The `run.override` event records that a human break-glass override occurred and points at the
triggering comment by stable id. The **override rate** (override events / started runs, and per
tier) is the quality signal — a rising rate means the bot is misfiring. The override identity and
rationale stay in the PR/MR comment itself, not in telemetry (M008).

**`modelIds` vs `effectiveModelIds` (#189):** the `run.start` run_event subtype's `modelIds`
records the *configured intent* — the model strings from `.ai-review.json` or the default config
(e.g. `"dummy-standard"` placeholders). The Pi runtime swaps dummy placeholders for the real model
at startup; the separate **`ai_review.run_metrics`** event (not a `run_event` subtype above) carries
`effectiveModelIds` — the *runtime-resolved* identifiers actually used (deduped, sorted; absent for
runtimes that resolve no real model), plus per-agent `effectiveModel` on its `agents` / `failures`
entries. Use `effectiveModelIds` for per-model cost/token segmentation.

**Latency decomposition (#196):** `ai_review.run_metrics.durationsMs` decomposes the otherwise
opaque `coordinatorMs` (which wraps reviewer fan-out *and* coordinator fusion) into `fanOutMs`
(first reviewer dispatched → all reviewers settled) and `fusionMs` (the post-fan-out synthesis
call; absent on short-circuit / all-reviewers-failed runs that run no synthesis). Each `agents[]`
entry also carries a per-agent `durationMs` (a reviewer's full wall-clock incl. retries; for the
coordinator entry, its fusion call). All are Pi-only numbers (M008-safe). `telemetry:analyze`
surfaces `fanOutMsPerRun` / `fusionMsPerRun` per tier — both averaged over *all* runs in the tier,
so they are a per-run decomposition that composes against `coordinatorMs`, not a per-fan-out /
per-synthesis average. Fan-out runs on every path, so `fanOutMsPerRun` only reads 0 for pre-#196
events that lack the field; `fusionMsPerRun` additionally reads 0 for short-circuit /
all-reviewers-failed runs (no synthesis ran). **Segment by date when mixing pre- and post-#196
data**, or the historical runs deflate the averages.

**Residual-defect counts (#261):** completed `ai_review.run_metrics` events include an optional
counts-only `residualDefects` block when at least one count is > 0. The block measures findings
that SHIPPED despite quality gates — the complement to caught-count signals (grounding.droppedFindingCount,
locationBackfill.backfilledCount, thinReview), so caught + leaked = gate recall observable from telemetry:

- `unlocatedShipped` — findings published with no location at all (after backfill, still unlocated).
- `noSuggestionShipped` — findings published with an empty `recommendation` (no actionable fix text).
- `offDiffCitationShipped` — findings published whose `location.path` cites a file outside the
  changed-file set. These are findings the grounding scope-gate carve-out always keeps (off-diff
  staleness findings like "you forgot to update docs/X" are legitimately off-diff; a rising rate
  signals reviewers may be citing non-changed files erroneously).

The block carries only integers (counts-only, M008). It is absent when all three counts are 0.
`telemetry:analyze` surfaces per-run leak rates for each count
(`unlocatedLeakRate`, `noSuggestionLeakRate`, `offDiffCitationLeakRate`) in the `residualDefects`
section. `telemetry:quality` surfaces these as thresholded hypotheses (a rising rate signals
degradation).

The analysis `residualDefects` block is present only when at least one run leaked (i.e., emitted a
`residualDefects` block). `residualDefects.runCount` is the **total number of completed runs** in
the analysis — the leak-rate denominator — so rates trend toward 0 as gates hold.
`residualDefects.defectiveRunCount` is how many of those runs had ≥1 leak (emitted a block); it is
always ≤ `runCount`.

**Fusion efficacy (#258):** completed `ai_review.run_metrics` events with coordinator reviewer
results include a counts-only `fusion` block:

- `rawFindingCount` — total raw findings from completed reviewer results before coordinator fusion.
- `survivingFindingCount` — final summary findings after coordinator fusion.
- `rawMinusSurvivingCount` — `max(rawFindingCount - survivingFindingCount, 0)`, the currently
  observable net loss/compaction count. This includes normal deduplication and is **not** true
  drop attribution.
- `attributionComplete` — currently `false`; the runner does not yet preserve a trusted raw-to-final
  finding mapping.
- `rawByReviewer` — stable-sorted raw finding counts by dispatched reviewer role, omitted when
  there are no reviewer-role counts.
- `mergedCount` — currently `0`; the contracts do not preserve a trusted raw-to-final finding
  mapping, so duplicate/overlap attribution is not observable yet.
- `droppedCount` — currently `0`; reserved for future attribution-complete true discarded-only
  findings.

The block carries only counts and reviewer role identifiers. It never includes raw finding ids,
titles, bodies, evidence, locations, recommendations, diff text, or prompts.

**Convergence/flap efficacy (#260):** completed `ai_review.run_metrics` events with re-review
state include a counts-only `convergence` block:

- `maxRecurrenceDepth` — the largest consecutive open-round count among current findings.
- `flappingFindingCount` — current findings that are new relative to the immediately prior open
  set but whose stable ID appears in prior resolved history.
- `currentFindingCount` — current findings measured in the convergence block; denominator for
  the pooled flap rate.

The block carries only integers. It never includes finding IDs, titles, bodies, evidence,
locations, paths, diff text, prompts, or secrets. The ID-keyed recurrence-depth map is persisted
only in hidden summary metadata so a later round can update the aggregate counts.

### Acceptance mapping (run.correction)

The `acceptanceByReviewer` field maps reviewer role identifiers (model-authored) to
acceptance counts derived from the re-review classification:

| Re-review status | Acceptance bucket | Attributed to |
|---|---|---|
| `fixed` | `accepted` | `priorFinding.reviewer` (or `"unknown"` when absent) |
| `recurring` | `notAccepted` | current `finding.reviewer` |
| `withheld` | `withheldExcluded` | `priorFinding.reviewer` (or `"unknown"` when absent) |
| `acknowledged` (developer won't-fix) | `rejected` | current `finding.reviewer` |

Counts only — never reasons, finding bodies, or free text.

**Acknowledged-only shape:** when a run has acknowledged findings but no prior-state
comparison, `run.correction` is still emitted with all four finding-count fields at `0`;
the only signal is the `rejected` bucket in `acceptanceByReviewer`. Consumers must not
guard on non-zero finding counts before reading `acceptanceByReviewer`.

### Rollup and analyze behavior

`ai_review.run_event` events **are NOT aggregated into the `rollup` field** of
`RollupExport` — the rollup remains run_metrics-only. They do contribute their type to
`sourceEventTypes` and their `repository` slug to `repositories` when present.

At the `telemetry:analyze` level (`src/state/run-metrics-analyze.ts`), run_event events
are matched to real-runtime runs by `runId`: orphan run_events (whose `runId` does not
appear in any analyzed run_metrics event) are ignored. The `runEvents` section of
`RunMetricsAnalysis` exposes:

- `startCount`, `completedCount`, `correctionCount` — matched event counts per subtype.
- `completionRate` — `completedCount / startCount` (`null` when `startCount` is 0).
- `overrideCount` / `overrideRate` — matched `run.override` events and
  `overrideCount / startCount` (`null` when `startCount` is 0).
- `mergeDespiteFail` — pooled plus per-repository/per-tier counts for prior blocking
  runs: blocking observations, merged blocking observations, and merged-without-override
  observations. `mergeDespiteFailRate = mergeDespiteFailCount / priorBlockedObservationCount`
  (`null` when there are no blocking observations). The formatted `telemetry:analyze` output
  labels `mergeDespiteFailCount` as `Ignored`.
  `run.prior_decision_respected` uses the prior review run's `runId`, so it is counted only
  when that prior run's real-runtime `run_metrics` event is also present in the analyzed export.
  Non-real runtimes such as `dummy` are excluded from analysis, so their observations are treated
  as orphans even when present. Rolling or time-bounded exports that include the observation but
  omit the prior run treat it as an orphan, so this rate can silently undercount near export-window
  boundaries.
- `acceptanceByReviewer` / `acceptanceByTier` — accumulated acceptance counts
  (`accepted` / `notAccepted` / `rejected` / `withheldExcluded`), each entry with an
  optional pre-computed `acceptanceRate = accepted / (accepted + notAccepted + rejected)`
  (omitted when the denominator is 0; `withheldExcluded` is deliberately NOT in the
  denominator — withheld findings carry no acceptance signal).
- `correctionRunCount` — the number of correction events that actually carried
  acceptance data (the statistical basis of the rates; can be lower than
  `correctionCount`).
- `directional: true` — the acceptance signal is longitudinal/directional, not a
  per-PR score.

When a `runId` is used as a `Record` key in a future aggregate, it must satisfy the
aggregate-key pattern (letter-first): runIds that can start with a digit (UUIDs,
timestamp prefixes) must be prefixed (e.g. `run-`) — otherwise their counts silently
fold into `__other__`. The current design avoids runId-keyed aggregates entirely.

Future `run_event` implementations must stay inside this boundary: counts, stable
identifiers, shape-bounded keys only (M008). Do not add free-text fields.

### Quality report (hypothesis queue)

`buildQualityReport` (in `src/state/quality-report.ts`) converts a `RunMetricsAnalysis`
into a **hypothesis queue**: the set of segments (overall / per-tier / per-reviewer /
per-severity) whose metrics breach a quality threshold. This is an advisory report — it does
not gate CI or block any run.

Run it with `bun run telemetry:quality` (writes `telemetry-quality-report.json` and prints
the human-readable table). An optional `workflow_dispatch`-only GitHub Actions workflow
(`.github/workflows/telemetry-quality-report.yml`) runs the same command and uploads the
JSON as an artifact.

#### Metrics and default thresholds

| Metric | Source field | Threshold | Direction | Default |
|---|---|---|---|---|
| `groundingDropRate` | `analysis.rates.groundingDropRunRate` | `maxGroundingDropRate` | above → bad | 0.15 |
| `groundingWithholdRate` | `analysis.rates.groundingWithholdFindingRate` | `maxGroundingWithholdRate` | above → bad | 0.30 |
| `diffFilterDropRate` | `analysis.rates.diffFilterDropRate` | `maxDiffFilterDropRate` | above → bad | 0.50 |
| `patchAdmissionDegradedRate` | `analysis.rates.patchAdmissionDegradedRate` | `maxPatchAdmissionDegradedRate` | above → bad | 0.20 |
| `deletionPruningRate` | `analysis.rates.deletionPruningRate` | `maxDeletionPruningRate` | above → bad | 0.30 |
| `proseFindingDropRate` | `analysis.rates.proseFindingDropRate` | `maxProseFindingDropRate` | above → bad | 0.10 |
| `fusionRawMinusSurvivingRate` | `analysis.rates.fusionRawMinusSurvivingRate` | descriptive only | n/a | n/a |
| `fusionDropRate` | `analysis.rates.fusionDropRate` | `maxFusionDropRate` | above → bad | 0.30 (not yet active; requires `attributionComplete: true`) |
| `convergenceFlapRate` | `analysis.convergence.flapRate` | `maxConvergenceFlapRate` | above → bad | 0.20 |
| `maxRecurrenceDepth` | `analysis.convergence.maxRecurrenceDepth` | `maxRecurrenceDepth` | above → bad | 3 |
| `thinReviewRate` (overall + per-tier) | `analysis.rates.thinReviewRate` (overall) / `analysis.byTier[tier].thinReviewRate` (per tier) | `maxThinReviewRate` | above → bad | 0.20 |
| `overrideRate` | `analysis.runEvents?.overrideRate` | `maxOverrideRate` | above → bad | 0.10 |
| `acceptanceRate` | `acceptanceByReviewer[r].acceptanceRate` or `acceptanceByTier[t].acceptanceRate` | `minAcceptanceRate` | below → bad | 0.50 |
| `withholdRate` | computed from `withheldExcluded / total` per reviewer/tier | `maxWithholdRate` | above → bad | 0.30 |
| `severityDismissRate` | computed from `analysis.dispositions.bySeverity[s].dismissed / (fixed + ignored + dismissed)` | `maxSeverityDismissRate` | above → bad | 0.50 |
| `completionRate` | `analysis.runEvents?.completionRate` | `minCompletionRate` | below → bad | 0.90 |
| `unlocatedLeakRate` | `analysis.residualDefects?.unlocatedLeakRate` | `maxUnlocatedLeakRate` | above → bad | 0.20 |
| `noSuggestionLeakRate` | `analysis.residualDefects?.noSuggestionLeakRate` | `maxNoSuggestionLeakRate` | above → bad | 0.10 |
| `offDiffCitationLeakRate` | `analysis.residualDefects?.offDiffCitationLeakRate` | `maxOffDiffCitationLeakRate` | above → bad | 0.30 |

The `minSampleSize` threshold (default 5) marks any hypothesis whose denominator is below
that value as `lowConfidence: true` — it is still surfaced, but flagged for low statistical
confidence.

`overrideRate`, `completionRate`, `acceptanceRate`, and `withholdRate` are only evaluated
when `runEvents` is present in the analysis. `groundingDropRate`, `groundingWithholdRate`,
`diffFilterDropRate`, `patchAdmissionDegradedRate`, `deletionPruningRate`, and
`thinReviewRate` are evaluated from `run_metrics` when their denominators are present.
`proseFindingDropRate` is evaluated from counts-only `agent.output` trace events whose `runId`
matches a real-runtime `run_metrics` event. No-data denominators are skipped rather than
reported as breaches. `fusionDropRate` is finding-level (`droppedCount / rawFindingCount`),
pooled only across completed runs whose fusion block has `attributionComplete: true`; current
`attributionComplete: false` raw-minus-surviving telemetry is descriptive and is not thresholded
by the quality report. A true-drop sample denominator of 0 is treated as no data and skipped by
the quality report.

`convergenceFlapRate` is finding-level (`flappingFindingCount / currentFindingCount`) pooled
across runs with a convergence block. `maxRecurrenceDepth` is count-valued, not a percentage, and
uses the number of runs with convergence data as its confidence sample size.

`thinReviewRate` is reported from run_metrics at both the overall level
(`rates.thinReviewRate`) and per tier (`byTier[tier].thinReviewRate`), so a single report can
surface both an `overall` and a `tier:<name>` thin-review hypothesis. `groundingWithholdRate` is
finding-level (demoted ÷ produced, pooled across runs); `groundingDropRate` is run-level
(fraction of runs with any demoted finding) — they are complementary signals.

#### Counts-only constraint (M008)

The quality report inherits the M008 boundary from its input (`RunMetricsAnalysis`): it
carries only rates, counts, segment keys (tier names, reviewer role identifiers), and
threshold numbers. It never includes finding bodies, diff text, prompt fragments, or any
user-controlled content. No new content fields may be added to `QualityReport` or
`QualityHypothesis`.

#### Dogfood boundary

The quality report operates on local artifacts only — the `telemetry:quality` command calls
`collectTelemetryEvents` (the same `gh`-based artifact collector used by `telemetry:analyze`),
or reads a local fleet-dataset JSONL via `--dataset` (#198), and writes its output locally.
Do not add network ingestion or remote export to this module.
Remote send-side egress lives in the transport layer (#51, below); factory-side fleet fan-in
(S06 #136) is the receive counterpart.

## Remote telemetry transport (#51, send-side)

Telemetry is written to a local JSONL artifact by default. To **also** mirror events to a remote
collector (e.g. a fleet-wide aggregation endpoint), configure an exporter. The remote leg is
**default-off** (no exporter configured = byte-identical behavior), **fail-open** (a slow or
failing endpoint never blocks or fails the review), and **counts-only** — every egressed event
passes the same `rollup-export.ts` boundary (type allowlist + key/slug/envelope shape-bounding)
before leaving the process. The boundary also makes remote telemetry **real-runtime-only**: a
`run_metrics` event whose `runtime` is a non-real kind (`dummy` / `deterministic`) is dropped
(#194), so the #131 dry-run smoke job's deterministic 0-token noise never reaches a collector or
the fleet dataset (the job still runs; only its remote telemetry is suppressed; local JSONL keeps
it). The same projection runs on fleet ingest, so the drop also applies "never trust the sender"
on receive.

**Exporter env namespaces.** Each exporter owns an `AI_REVIEW_<NAME>_{URL,AUTHORIZATION,BASIC_AUTH}`
namespace, so exporters are configured independently (no shared/ambiguous auth). Setting an
exporter's `_URL` enables it; Loki takes precedence if more than one is configured.

| Exporter | `…_URL` | Auth (`…_AUTHORIZATION` / `…_BASIC_AUTH`) |
| --- | --- | --- |
| Generic HTTP | `AI_REVIEW_TELEMETRY_URL` — `http(s)` URL; events POSTed as newline-delimited JSON. | `AI_REVIEW_TELEMETRY_AUTHORIZATION` / `AI_REVIEW_TELEMETRY_BASIC_AUTH` |
| Grafana Loki | `AI_REVIEW_LOKI_URL` — the **base** Loki URL (e.g. `https://logs-prod-012.grafana.net`); `/loki/api/v1/push` is appended and events use Loki's `{streams:[…]}` envelope. | `AI_REVIEW_LOKI_AUTHORIZATION` / `AI_REVIEW_LOKI_BASIC_AUTH` |

Within a namespace: `…_AUTHORIZATION` is a raw `Authorization` header (e.g. `Bearer <token>`);
`…_BASIC_AUTH` is a `user:token` pair (e.g. a Grafana Cloud `<instance-id>:<api-token>`) sent as
`Basic`. When both are set, `…_AUTHORIZATION` takes precedence and `…_BASIC_AUTH` is **ignored and
not validated** (so a stale value from a credential rotation won't abort the run). A *set* but
malformed `…_BASIC_AUTH` (no colon, empty user, or empty token) is a hard startup error.

The Loki variant labels each stream by `service`, `event_type`, and a low-cardinality allowlist
(`riskTier`, `decision`, `outcome`); the full counts-only event is the log line, queryable with
LogQL `| json`. It reuses the generic transport's POST / redirect / timeout / fail-open behavior
— only the wire shape and env namespace differ.

The local JSONL artifact remains the primary, durable record regardless of remote configuration.
Each remote request has a ~10-second abort timeout so a hung connection cannot outlive the run.
The POST does **not** follow redirects (`redirect: "error"`, a runtime SSRF guard) — point the
`…_URL` at the final endpoint; a collector behind an HTTP→HTTPS redirect will record delivery
failures.

**Delivery flush + observability.** Telemetry is emitted at the end of a run, so on close the
transport gives in-flight remote pushes a bounded grace period (~2s) to drain before aborting any
stragglers — end-of-run events flush instead of being cut off, without ever blocking the run past
that bound. Each remote delivery outcome is recorded to the run's local `trace.jsonl` as a
`runtime.event` (`telemetry.remote_delivered` / `telemetry.remote_failed`, carrying the telemetry
event type and — on failure — the status line only, never response bodies or secrets), so you can
audit what reached the remote without guessing. These records live in `trace.jsonl` alongside the
`telemetry.jsonl` artifact (both are written under `--output-dir`), so whenever the remote leg is
active the delivery outcomes are captured.

**Fail-open vs. startup validation.** "Fail-open" describes *runtime* delivery: once configured,
a slow or failing endpoint never blocks or fails the review. It does **not** mean misconfiguration
is ignored — for the configured exporter's namespace, the following are **hard startup errors
that abort the run**: a non-`http(s)` `…_URL`; a URL pointing at a cloud metadata endpoint
(`169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`); a plain `http://` URL when
credentials are present (in `…_AUTHORIZATION`/`…_BASIC_AUTH` **or** embedded as `user:pass@host` —
credentials must not be sent in plaintext, use `https://`); or a malformed `…_BASIC_AUTH` (not
`user:token`, and only when no `…_AUTHORIZATION` is set). Plain `http://` is allowed only for a
no-auth internal collector. Set these only after verifying the values in CI; a bad value fails
fast rather than silently sending nowhere.

**Counts-only scope.** The egress projection enforces the type allowlist, key shape-bounding,
repo-slug shape, and top-level envelope (`runId`/`timestamp`) shape. Value-level free-text
allowlisting is not yet enforced (documented in `projectEventForEgress`); today's exportable
events are counts-only by construction, and fleet receive (#136) re-applies the full boundary,
so this is defense-in-depth rather than the sole guard.

Vendor-specific exporters (e.g. a Loki push-API body shape) are a later second adapter that
composes the same generic HTTP core via its `formatRequest` hook — out of #51's scope.

## Own-fleet fan-in (#136, receive-side)

The receive counterpart of the #51 send side. The factory owner runs a fleet of repos that each
POST counts-only `run_metrics` (the #51 transport); fleet fan-in **accepts** those payloads and
folds them into the **same dataset the quality report reads**, so the hypothesis queue reflects the
whole owner fleet — not just this repo's PRs.

`ingestFleetPayload` (in `src/state/fleet-ingest.ts`) is the pure ingestion function; the
`bun run telemetry:ingest` CLI (`scripts/telemetry-ingest.ts`) authenticates, calls it, and appends
the accepted events to the fleet dataset JSONL (`.ai-review-fleet/telemetry.jsonl` by default).

That dataset is the JSONL store the quality/analyze pipeline consumes: it carries the same
`ai_review.run_metrics` events `analyzeRunMetrics` / `buildQualityReport` read, so feeding it through
those functions pools the fleet's runs into the hypothesis-queue segments. Point the collectors at it
with `bun run telemetry:quality --dataset .ai-review-fleet/telemetry.jsonl` (and likewise
`telemetry:analyze --dataset <path>`, #198): the `--dataset` flag reads the local JSONL directly via
`readTelemetryEvents` instead of collecting from CI artifacts via `gh` (`collectTelemetryEvents`), and is
mutually exclusive with `--runs`. The report is identical whether it is built from the fleet dataset or
from CI artifacts — both paths feed the same `analyzeRunMetrics` / `buildQualityReport`.

### Boundaries (load-bearing)

1. **Own-fleet only — authenticated by a single shared secret.** `AI_REVIEW_FLEET_INGEST_SECRET`
   holds the factory-side secret; the sender presents it via `AI_REVIEW_FLEET_INGEST_SECRET_PRESENTED`,
   compared **timing-safely**. Both are read from the **environment only** — there is deliberately no
   `--secret` CLI flag, so the credential never lands in the process table, shell history, or CI logs.
   One shared secret
   authenticates the whole owner fleet by design (same owner, same trust domain); rotation revokes
   the fleet at once. **Open third-party contribution to the factory signal is explicitly out of
   scope** — a hostile sender could skew quality hypotheses (the poisoning vector). Adopters who
   want their own telemetry point #51 at *their own* private backend; that path never reaches the
   factory.

2. **Counts-only enforced ON RECEIVE — never trust the sender to have filtered.** Every received
   event is re-run through the send-side boundary (`projectEventForEgress`: type allowlist + key
   shape-bounding); a non-exportable type or malformed envelope is **rejected entirely** (its
   fields never land). Fleet fan-in additionally closes the **value-level** gap that
   `projectEventForEgress` documents-but-defers: any string value in a `run_metrics` `data` block
   that is not an allowlisted, shape-conforming stable identifier (`runtime`, `repository`,
   `riskTier`, `decision`, `outcome`, `changeId`, `headSha`) is **dropped on receive**. So a payload
   carrying stray non-count fields (finding bodies, diff text, prompt fragments, secrets — M008/#50)
   is shape-bound away before it reaches the dataset. The CLI prints a counts-only summary
   (`acceptedCount` / `rejectedEventCount` / `shapeBoundEventCount` / `malformedLineCount` /
   shape-bounded `repositories`) — never the rejected content.

3. **Fail-open / non-blocking (inherited).** Ingestion is decoupled from any repo's review: an
   ingestion outage never blocks or fails a review. The module is pure (no network, no clock); the
   CLI owns I/O and lifecycle, mirroring the `rollup-export.ts` ↔ scripts split.
