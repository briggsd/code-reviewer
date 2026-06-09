# Inline publishing

Inline comments are now available as an **experimental, opt-in GitHub-only** path. Summary comments remain the default write-back UX and CI status remains the canonical merge gate.

By default, `ai-code-review run` does not publish inline comments. Provider-backed runs only attempt line-level comments when `--publish-inline` is supplied explicitly.

```bash
AI_REVIEW_GITHUB_TOKEN=... ai-code-review run \
  --provider github \
  --repo owner/name \
  --change-id 123 \
  --head-sha <current-pr-head-sha> \
  --runtime dummy \
  --publish-summary \
  --publish-inline \
  --output-dir .ai-review
```

## Current support matrix

| Provider | Summary publishing | Inline publishing |
|---|---:|---:|
| GitHub | Supported with `--publish-summary` | Experimental with `--publish-inline` |
| GitLab | Supported with `--publish-summary` | Deferred |

GitLab inline discussions are deliberately deferred because GitLab diff positions require provider-specific diff refs and discussion semantics that are separate from the GitHub review comment API.

## Safety gates

Before any inline publisher posts a finding, `publishReviewInlineFindings()` calls `evaluateInlinePublishReadiness()` from `src/publisher/inline-readiness.ts`.

The readiness gate takes:

- current `ChangeMetadata`, including the provider head SHA,
- the provider `DiffSummary`, including per-file patches,
- findings proposed for inline publication,
- optional `expectedHeadSha` used when those findings were generated.

The gate blocks inline publishing when any of these are true:

- the review was generated for a stale head SHA,
- the provider diff is truncated/overflowed,
- the finding has no location,
- the finding has no explicit line or side,
- the file is not present in the provider diff,
- the file is binary,
- the provider omitted patch text,
- the finding points to the right side of a deleted file,
- the finding points to the left side of an added file,
- the requested line is not present in the provider patch hunk.

This is intentionally conservative. A blocked inline finding remains visible in the summary comment and trace output; the whole review should not fail only because inline coordinates are unsafe.

## Duplicate prevention

GitHub inline comments include hidden metadata:

```text
<!-- ai-code-review-factory-inline
{"schemaVersion":1,"findingId":"...","headSha":"..."}
-->
```

Before posting, the GitHub adapter fetches existing pull request review comments and skips a finding when the same `findingId` has already been posted for the same `headSha`. The skipped outcome records `duplicate_inline_comment` with the existing provider comment ID/URL.

Duplicate suppression is intentionally scoped to the exact same head SHA and stable finding ID. Older comments without `headSha`, malformed hidden metadata, or comments from a different head are ignored for duplicate matching so they do not block a fresh, fully tagged inline comment.

## Trace output

Inline publishing writes a `publisher.completed` trace event with:

- `publisher: "inline"`,
- attempted/posted/skipped/failed inline counts,
- `inlineFindings`, a deterministic per-finding list of `findingId`, `disposition`, provider comment IDs/URLs, and failure/skip reasons,
- skipped inline reasons, including readiness-gate reasons such as `line_not_in_patch`.

Summary publishing still writes its own `publisher.completed` event and remains idempotent via the summary hidden metadata.

## CI stance

The starter CI templates do **not** pass `--publish-inline`. Keep dry-run and publish jobs separate, and enable inline publishing only in same-repository/same-project trusted write-back jobs after summary-only publishing is stable.

Inline comments are human-facing review UX, not the merge blocker. CI status from `--ci-exit` remains authoritative.

## Live smoke status

M004 same-repository GitHub smoke ran against PR #4 with a synthetic seeded finding on `src/cli/run-options.ts:9`:

1. default CI/template runs do not publish inline comments because templates do not pass `--publish-inline`,
2. explicit `--publish-inline` posted one readiness-approved GitHub review comment,
3. rerunning against the same head/finding recorded `duplicate_inline_comment` instead of posting another review comment,
4. the summary comment was updated idempotently and inline skipped reasons were visible in `trace.jsonl`.
