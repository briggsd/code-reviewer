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

## Reserved event vocabulary: `ai_review.run_event` (#20 / #22)

`EXPORTABLE_EVENT_TYPES` includes `ai_review.run_event` today even though the type is not
yet emitted. This ensures that future `run_event` emission lands **inside** this egress
boundary from day one — no boundary gap between emission and export gating.

Planned subtypes (counts/identifiers only — never free text):

| Subtype | Planned payload |
|---|---|
| `run.start` | runId, repository slug, changeId, riskTier, selectedReviewerRoles (array), modelIds (array) |
| `run.completed` | decision, outcome, durationMs, findings by severity/reviewer (counts), token totals |
| `run.correction` | cross-push correction counts keyed by runId (keys must be letter-first — prefix digit-leading runIds, see identifier policy) |
| `run.override` | break-glass override marker (#22 phase 2), stable identifiers and timestamps only |

`ai_review.run_event` events are not yet aggregated into `rollup` — that is #20's slice.
They do contribute their type to `sourceEventTypes` when present.

Future `run_event` implementations must stay inside this boundary: counts, stable
identifiers, shape-bounded keys only (M008). Do not add free-text fields.
