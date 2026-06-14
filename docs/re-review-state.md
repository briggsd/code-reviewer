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

## Incremental re-review (#46)

On a re-push, the runner can narrow the reviewed diff to only the files changed since the last reviewed head (`previousHeadSha`), instead of spending the full reviewer budget on the entire PR diff again.

### Eligibility

A re-review runs incrementally when all of the following hold:

1. A `PriorReviewState` is available with a `previousHeadSha`.
2. The current `headSha` differs from `previousHeadSha` (same head → full review, `same_head`).
3. `VcsAdapter.getChangedPathsSince(ref, previousHeadSha)` returns a `ChangedPathsSince` object (adapter supports it and no error occurred; otherwise → full review, `delta_unavailable`).
4. `isAncestor` is `true` — the prior head is still a clean ancestor of the current head (i.e., a fast-forward push; `false` means a rebase or force-push → full review, `base_changed`).

### Fallback rules (HARD — correctness over savings)

Any of these conditions forces a full review:

- No `PriorReviewState`, or `previousHeadSha` absent (`no_prior_state`). Note this reason is
  reachable in `decideIncrementalReview` but is NOT surfaced via the `review.incremental` trace
  event: the CLI only computes a plan (and emits the event) when prior state with a
  `previousHeadSha` exists, so the emitted reasons are `incremental`/`same_head`/`delta_unavailable`/`base_changed`.
- Same head SHA (`same_head`).
- Adapter returns `undefined` — unsupported provider, network error, or ≥300 files (300 or more) in the delta (truncation risk) (`delta_unavailable`).
- `isAncestor === false` — rebase / force-push detected (`base_changed`).

### Carry-forward correctness

A prior finding absent from the current run is called **fixed** only when its file was **actually re-reviewed this push**. Under an incremental plan:

- If the prior finding's `location.path` is in the delta (`reviewedPaths`) and the finding is absent → classified `fixed`.
- If the prior finding's `location.path` is NOT in the delta, or its path is unknown → classified `carried_forward` (still-open; not re-evaluated).

Carried-forward findings are never silently dropped: they appear in `carriedForwardFindingIds` in `ReReviewSummary` and the **Re-review status** section of the summary markdown lists their count and known file paths.

A full review (`reviewedPaths` undefined) treats every absent prior finding as `fixed`, matching the pre-#46 behavior — no regression.

> **Note:** carried-forward findings are not persisted into the new hidden metadata — on the
> following push they are no longer in prior state (see **Trust boundary & limitations** below).
> Teams relying on `carriedForwardFindingCount` across multiple incremental pushes should be aware
> of this single-hop gap until multi-hop persistence is implemented.

### Trust boundary & limitations

- **`findingPaths` is untrusted input.** Prior state loaded from a PR/MR summary comment is
  reviewed-repo content that a comment editor could tamper with (the same trust model the
  `findingIds` array has always had — see [Fork safety](fork-safety.md)). It influences only
  re-review **classification** (new/recurring/fixed/carried_forward), which is analytics —
  it never affects the CI gate, decision, or outcome. `parseSummaryHiddenMetadata` accepts a
  `findingPaths` value only when it has a safe repo-relative shape (no absolute path, no `..`
  traversal, no control characters, bounded length); a rejected entry leaves that prior finding
  path-less, which carry-forward classifies as `carried_forward` (the safe direction — a prior
  finding is never auto-marked `fixed` from tampered metadata). `getChangedPathsSince` likewise
  rejects a `sinceSha` that is not commit-SHA-shaped before calling the compare API.
- **Cross-push persistence is single-hop.** A run publishes hidden metadata for the findings of
  *that run* only. In incremental mode a carried-forward finding (on a file outside the delta) is
  reported in the current run's **Re-review status**, but because it is not among the current
  run's findings it is not re-written into the new metadata — so on the *next* push it is no
  longer in prior state. The CI gate is unaffected (it is computed from the current run's
  findings), and a later full review re-reviews every file. Multi-hop carry-forward persistence
  (unioning carried-forward IDs/paths into the published metadata) is a possible follow-up.

### `findingPaths` metadata (schemaVersion 2)

To enable carry-forward classification across runs that rely only on summary metadata (no full artifact), the hidden metadata block now includes `findingPaths` at schemaVersion 2:

```json
{
  "schemaVersion": 2,
  "runId": "run-123",
  "headSha": "abc123",
  "provider": "github",
  "repository": "example/repo",
  "changeId": "17",
  "findingIds": ["fnd_0123456789abcdef"],
  "findingPaths": {
    "fnd_0123456789abcdef": "src/auth/accounts.ts"
  }
}
```

`findingPaths` maps each finding's stable ID to its `location.path`. Only findings with both a non-empty ID and a path appear. The field is omitted entirely when there are no such findings. On parsing, non-string values are filtered out defensively. Placeholder prior findings (`createPlaceholderFinding`) now set `location: { path }` from `findingPaths`, enabling correct carry-forward classification even when the full prior summary is unavailable.

### `findingReviewers` metadata (schemaVersion 3)

To fix `acceptanceByReviewer` attribution collapsing to a single bucket, the hidden metadata block now includes `findingReviewers` at schemaVersion 3:

```json
{
  "schemaVersion": 3,
  "runId": "run-123",
  "headSha": "abc123",
  "provider": "github",
  "repository": "example/repo",
  "changeId": "17",
  "findingIds": ["fnd_0123456789abcdef"],
  "findingPaths": {
    "fnd_0123456789abcdef": "src/auth/accounts.ts"
  },
  "findingReviewers": {
    "fnd_0123456789abcdef": "security"
  }
}
```

`findingReviewers` maps each finding's stable ID to its reviewer role (the `AgentRole | string` value from the finding). Only findings with a non-empty ID appear. The field is omitted entirely when there are no such findings. On parsing, only non-empty string values with bounded length (≤ 64) and no control characters are accepted; rejected entries fall back to `"unknown"` — a distinct bucket from the real `"custom"` AgentRole an operator extension could emit. Parsers built on schemaVersion ≤ 2 ignore the unknown `findingReviewers` key (backward-compatible additive field).

### `review.incremental` trace event

Whenever `runReview` has an `incremental` plan (regardless of mode), it emits a `review.incremental` trace event at run completion:

```json
{
  "type": "review.incremental",
  "runId": "run-123",
  "timestamp": "2026-06-13T00:00:00.000Z",
  "data": {
    "mode": "incremental",
    "reason": "incremental",
    "reviewedFileCount": 1,
    "carriedForwardFindingCount": 0
  }
}
```

`mode` is `incremental` or `full`; `reason` is one of `incremental` / `same_head` /
`delta_unavailable` / `base_changed` (the `no_prior_state` reason exists in
`decideIncrementalReview` but is never emitted via this event — see the fallback rules above).

The `run_metrics` telemetry event also includes an `incremental` block when the plan is present.

### GitHub vs GitLab

- **GitHub**: `getChangedPathsSince` is implemented using `GET /repos/{owner}/{repo}/compare/{sinceSha}...{headSha}`. Returns `undefined` on any error or when ≥300 files are returned (truncation safety). This is the supported incremental path.
- **GitLab**: `getChangedPathsSince` is implemented using the compare API (`GET /projects/{id}/repository/compare?from=…&to=…&straight=true`). GitLab's compare response has no GitHub-style `status` field, so ancestry is **derived**: a reverse compare (`headSha..sinceSha`) whose commit set is empty proves `sinceSha` is a clean ancestor of head (a plain fast-forward re-push) → `isAncestor: true`; a non-empty set or a `compare_timeout` means a force-push/rebase or unconfirmable history → `isAncestor: false` (full-review fallback, the safe direction). When ancestry holds, a forward compare (`sinceSha..headSha`) yields the changed paths (`new_path`, falling back to `old_path` for deletions). Returns `undefined` on any error, on a forward `compare_timeout`, or when ≥300 files are returned (truncation safety) — same correctness-over-savings guards as GitHub (#115).

## Hidden summary metadata

Published summary comments/notes include hidden metadata with `schemaVersion: 3` and `findingIds` (and optionally `findingPaths` and `findingReviewers`). At schemaVersion 2 (legacy), `findingReviewers` is absent and placeholder findings use reviewer `"unknown"`; at schemaVersion 1 (legacy), `findingPaths` is also absent and placeholder findings have no `location`; incremental re-review falls back to full review or carries forward all prior findings conservatively. (The `schemaVersion: 2` example in the `findingPaths` section above shows the v2 shape for reference.)

```json
{
  "schemaVersion": 3,
  "runId": "run-123",
  "headSha": "abc123",
  "provider": "github",
  "repository": "example/repo",
  "changeId": "17",
  "findingIds": ["fnd_0123456789abcdef"],
  "findingPaths": {
    "fnd_0123456789abcdef": "src/auth/accounts.ts"
  },
  "findingReviewers": {
    "fnd_0123456789abcdef": "security"
  }
}
```

The metadata is parsed by `parseSummaryHiddenMetadata()` and converted to a minimal `PriorReviewState` by `createPriorReviewStateFromMetadata()`. GitHub and GitLab adapters use this to recover prior run IDs, prior head SHA, and prior stable finding IDs from existing bot summary comments/notes.

The metadata is not the canonical state store; CI artifacts and any future external state backend should still persist full summaries. When only summary metadata is available, prior findings are represented as placeholder findings keyed by stable ID until full prior summary details are loaded.

## Runner context

Provider-backed runs now call `VcsAdapter.getPriorReviewState()` while fetching change metadata and diff. When prior metadata exists, `runReviewFromChange()` carries it into `ReviewContext.priorState` before agents run.

The context-building trace includes `priorFindingCount` so artifacts show whether a re-review had prior state available.

## New, recurring, fixed, and withheld classification

When `ReviewContext.priorState` is present, the runner attaches `summary.reReview` after stable IDs are assigned:

- `newFindingIds`: current finding IDs that were not in prior state.
- `recurringFindingIds`: current finding IDs that were also in prior state.
- `fixedFindingIds`: prior finding IDs that are absent from the current review **and were not withheld by evidence grounding this run**.
- `withheldFindingIds`: prior finding IDs absent from the current review **because evidence grounding dropped the matching finding this run** (its `quotedCode` could not be located in the changed files). The finding was not necessarily resolved — it was withheld for lack of grounding evidence, so it is excluded from `fixedFindingIds` and reported separately (#69).
- `classifications`: per-ID records with status `new`, `recurring`, `fixed`, or `withheld`, plus current/prior finding details where available. `withheld` entries carry `priorFinding`/`lastSeenHeadSha` (like `fixed`) and no current `finding`.

Summary markdown renders a **Re-review status** section with the new/recurring/fixed/withheld counts (withheld and fixed each also list their IDs when non-empty). Fixed findings are reported in the summary only; provider threads are not resolved yet.

> **Withheld matching is best-effort (#69).** A withheld finding is matched to its prior-state entry by recomputing `createStableFindingId()` on the grounding-dropped finding. This matches only when the recomputed ID equals the stored prior ID. It will *not* match when the prior ID was derived from a backfilled location (a line `quotedCode` resolved in the prior diff but not this one — a dropped finding can't be re-backfilled, since its quote is absent from the current diff) or carried a collision ordinal (`#N`). In those cases the prior finding stays in `fixedFindingIds` — the pre-#69 behavior, so there is no regression; withheld simply does not fire. This is acceptable because the classification is analytics/signal-accuracy only: `withheldFindingIds`/`fixedFindingIds` never affect the CI gate, decision, or outcome.

## Fixture

`examples/fixtures/re-review-pr.json` demonstrates the intended state shape:

- one recurring auth finding with the same stable ID in `priorState.findings` and `fakeFindings`,
- one fixed prior finding present only in `priorState.findings`,
- a second-run head SHA so tests can distinguish prior and current review state.

Run it locally with:

```bash
bun run src/cli.ts run --fixture examples/fixtures/re-review-pr.json --format markdown
```

The output should include a **Re-review status** section with one recurring finding and one fixed prior finding. The fixture does not yet demonstrate a `withheld` finding — `withheld` counts appear only when evidence grounding drops a finding that also existed in prior state (a finding whose `quotedCode` grounded in a prior run but no longer matches the current diff).

## Future inline/discussion consumption

Future inline publishers and discussion resolvers must preserve these invariants:

- Only resolve provider threads for IDs in `fixedFindingIds` after a fresh provider diff/head check.
- **Never resolve a provider thread for an ID in `withheldFindingIds`.** The finding was suppressed by evidence grounding this run and may reappear on a later run once grounding evidence is present; resolving its thread would prematurely hide a real issue. Only `fixedFindingIds` are thread-resolution candidates.
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
6. Classify findings as new, recurring, fixed, or withheld (grounding-suppressed — absent this run because evidence grounding dropped them).
7. Publish summary updates first; resolve inline discussions only after provider-specific safety gates are implemented.
