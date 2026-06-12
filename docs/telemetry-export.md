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
| `run.start` | Every run (before agents execute) | `event`, `schemaVersion`, `repository` (slug), `changeId`, `riskTier`, `selectedReviewerRoles` (string array), `modelIds` (unique sorted string array) |
| `run.completed` | Completed runs only (not failed) | `event`, `schemaVersion`, `repository`, `riskTier`, `decision`, `outcome`, `durationMs`, `findingCount`, `findingsBySeverity` (counts), `findingsByReviewer` (counts), `tokens?` (`inputTokens`/`outputTokens`/`cacheReadTokens`/`cacheWriteTokens`/`estimatedCostUsd` numbers — present only when the run has token metrics) |
| `run.correction` | Completed runs with a prior-state comparison or acknowledged findings | `event`, `schemaVersion`, `repository`, `riskTier`, `newFindingCount`, `recurringFindingCount`, `fixedFindingCount`, `withheldFindingCount`, `acceptanceByReviewer` (per-reviewer counts: accepted/notAccepted/rejected/withheldExcluded) |
| `run.override` | Reserved (#22 phase 2) | break-glass override marker; stable identifiers and timestamps only |

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
