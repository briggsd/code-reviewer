# Re-review state

Re-review support starts with stable finding IDs and parseable prior summary metadata. Inline comment/discussion resolution is still deferred, but every completed review summary now has deterministic finding IDs that future re-review logic can compare across runs.

## Stable finding IDs

`assignStableFindingIds()` runs before a review summary is returned or persisted. It preserves IDs supplied by a runtime/adapter and generates missing IDs with `createStableFindingId()`.

The generated ID uses a SHA-256 hash over normalized:

- reviewer,
- category,
- location path/line/range/side.

`title` and `body` are **intentionally excluded** (see #31): they are model-authored free text that the LLM rewords on every run, so hashing them produced a fresh ID per run and silently defeated recurring-finding suppression. The hash therefore avoids title, body, severity, confidence, evidence, and recommendation — all of which may change while the underlying issue remains the same.

The ID format is:

```text
fnd_<16 hex chars>          # first finding at a given reviewer+category+location
fnd_<16 hex chars>#<N>      # Nth (N ≥ 2) finding colliding on the same signals within one summary
```

Because identity is keyed only on reviewer+category+location, two *distinct* findings sharing those signals collide on one base ID. `assignStableFindingIds()` disambiguates them with a `#N` ordinal so the re-review index never silently drops one. The ordinal is assigned in a deterministic content order (not the model's emission order), so an unchanged diff re-yields the same IDs; downstream tools should treat the full string (including any `#N`) as an opaque key. The ordinal is run-stable as long as the colliding group's membership is unchanged — adding or removing a co-located sibling can shift the remaining ordinals, an accepted limitation since identical-on-every-stable-signal findings can't be told apart without their volatile prose.

> **Migration note:** finding IDs produced before #31 folded title/body into the hash. On the first re-review after deploying this change, previously-stored IDs will not match the new scheme, so that run sees a one-time reset (all prior findings classified `fixed`, all current ones `new`). Treat the first post-deploy re-review as a clean-slate baseline.

> **Migration note (location backfill, #87):** the location-backfill stage now derives a `path|line|side`
> location from `quotedCode` for findings the model left unlocated, *before* `assignStableFindingIds()` runs.
> Those findings previously hashed with `unknown-location`; after backfill they hash at their real
> coordinates, producing a different stable ID. So on the first re-review after deploying this change, any
> previously-unlocated-but-now-backfilled finding gets a one-time reset (prior instance classified `fixed`,
> current one `new`) — same shape and audience as the #31 reset above. Treat that first run as a clean-slate
> baseline for those findings.

## Hidden summary metadata

Published summary comments/notes include hidden metadata with `schemaVersion: 1` and `findingIds`:

```json
{
  "schemaVersion": 1,
  "runId": "run-123",
  "headSha": "abc123",
  "provider": "github",
  "repository": "example/repo",
  "changeId": "17",
  "findingIds": ["fnd_0123456789abcdef"]
}
```

The metadata is parsed by `parseSummaryHiddenMetadata()` and converted to a minimal `PriorReviewState` by `createPriorReviewStateFromMetadata()`. GitHub and GitLab adapters use this to recover prior run IDs, prior head SHA, and prior stable finding IDs from existing bot summary comments/notes.

The metadata is not the canonical state store; CI artifacts and any future external state backend should still persist full summaries. When only summary metadata is available, prior findings are represented as placeholder findings keyed by stable ID until full prior summary details are loaded.

## Runner context

Provider-backed runs now call `VcsAdapter.getPriorReviewState()` while fetching change metadata and diff. When prior metadata exists, `runReviewFromChange()` carries it into `ReviewContext.priorState` before agents run.

The context-building trace includes `priorFindingCount` so artifacts show whether a re-review had prior state available.

## New, recurring, and fixed classification

When `ReviewContext.priorState` is present, the runner attaches `summary.reReview` after stable IDs are assigned:

- `newFindingIds`: current finding IDs that were not in prior state.
- `recurringFindingIds`: current finding IDs that were also in prior state.
- `fixedFindingIds`: prior finding IDs that are absent from the current review.
- `classifications`: per-ID records with status `new`, `recurring`, or `fixed`, plus current/prior finding details where available.

Summary markdown renders a **Re-review status** section with the new/recurring/fixed counts. Fixed findings are reported in the summary only; provider threads are not resolved yet.

## Fixture

`examples/fixtures/re-review-pr.json` demonstrates the intended state shape:

- one recurring auth finding with the same stable ID in `priorState.findings` and `fakeFindings`,
- one fixed prior finding present only in `priorState.findings`,
- a second-run head SHA so tests can distinguish prior and current review state.

Run it locally with:

```bash
bun run src/cli.ts run --fixture examples/fixtures/re-review-pr.json --format markdown
```

The output should include a **Re-review status** section with one recurring finding and one fixed prior finding.

## Future inline/discussion consumption

Future inline publishers and discussion resolvers must preserve these invariants:

- Only resolve provider threads for IDs in `fixedFindingIds` after a fresh provider diff/head check.
- Never resolve a thread using summary text alone; use stable ID state plus provider thread/comment mapping.
- Treat placeholder prior findings from summary metadata as enough for classification, but not enough for destructive provider actions.
- Keep summary publishing as the fallback when inline coordinates or discussion IDs are missing.
- Run `evaluateInlinePublishReadiness()` before posting any new inline comments.

## Future re-review flow

1. Load prior bot summary metadata from the provider.
2. Carry the resulting `PriorReviewState` into `ReviewContext.priorState`.
3. Load prior full summary state from artifacts or a real state store where available.
4. Generate stable IDs for the current run.
5. Compare current IDs to prior IDs.
6. Classify findings as new, recurring, or absent/fixed.
7. Publish summary updates first; resolve inline discussions only after provider-specific safety gates are implemented.
