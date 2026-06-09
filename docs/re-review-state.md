# Re-review state

Re-review support starts with stable finding IDs. Inline comment/discussion resolution is still deferred, but every completed review summary now has deterministic finding IDs that future re-review logic can compare across runs.

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

The metadata is a seed for future prior-state parsing. It is not the canonical state store; CI artifacts and any future external state backend should still persist full summaries.

## Future re-review flow

1. Load prior bot summary metadata from the provider.
2. Load prior full summary state from artifacts or a real state store where available.
3. Generate stable IDs for the current run.
4. Compare current IDs to prior IDs.
5. Classify findings as new, recurring, or absent/fixed.
6. Publish summary updates first; resolve inline discussions only after provider-specific safety gates are implemented.
