# Re-review state

Re-review support starts with stable finding IDs and parseable prior summary metadata. Inline comment/discussion resolution is still deferred, but every completed review summary now has deterministic finding IDs that future re-review logic can compare across runs.

## Stable finding IDs

`assignStableFindingIds()` runs before a review summary is returned or persisted. It preserves IDs supplied by a runtime/adapter and generates missing IDs with `createStableFindingId()`.

The generated ID uses a SHA-256 hash over normalized:

- reviewer,
- category,
- location path/line/range/side,
- title,
- body.

The ID format is:

```text
fnd_<16 hex chars>
```

This intentionally avoids using severity, confidence, evidence, or recommendation text because those may change while the underlying issue remains the same.

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

## Future re-review flow

1. Load prior bot summary metadata from the provider.
2. Carry the resulting `PriorReviewState` into `ReviewContext.priorState`.
3. Load prior full summary state from artifacts or a real state store where available.
4. Generate stable IDs for the current run.
5. Compare current IDs to prior IDs.
6. Classify findings as new, recurring, or absent/fixed.
7. Publish summary updates first; resolve inline discussions only after provider-specific safety gates are implemented.
