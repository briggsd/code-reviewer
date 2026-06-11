# Inline publishing

Inline comments are now available as an **experimental, opt-in** path on **GitHub and GitLab**. Summary comments remain the default write-back UX and CI status remains the canonical merge gate.

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
| GitLab | Supported with `--publish-summary` | Experimental with `--publish-inline` |

GitLab inline findings are posted as **MR diff discussions** positioned with the merge request's
`diff_refs` (`base_sha`/`start_sha`/`head_sha`). The same readiness gate and duplicate-prevention
metadata apply as on GitHub. Example (mirrors the GitHub invocation above):

```bash
AI_REVIEW_GITLAB_TOKEN=... ai-code-review run \
  --provider gitlab \
  --repo group/project \
  --change-id 42 \
  --head-sha <current-mr-head-sha> \
  --runtime dummy \
  --publish-summary \
  --publish-inline \
  --output-dir .ai-review
```

### GitLab MVP limitations

Two GitLab-specific constraints are deliberately out of scope for this experimental slice:

- **Renamed files are not supported.** The position sets both `old_path` and `new_path` to the
  finding's reported path, so a finding on a renamed file may be rejected by GitLab (a `failed`
  outcome with a 422) or placed against the wrong path. Findings on non-renamed files are unaffected.
- **Duplicate suppression reads only the first page of MR discussions.** On a merge request with
  many existing discussions (more than one API page), a previously posted inline comment beyond the
  first page may not be detected, so a duplicate could be posted on a subsequent run.

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

Both GitHub and GitLab inline comments embed the same hidden metadata via the shared
`src/publisher/inline-comment-markdown.ts` renderer:

```text
<!-- ai-code-review-factory-inline
{"schemaVersion":1,"findingId":"...","headSha":"..."}
-->
```

Before posting, the adapter fetches existing comments (GitHub: pull request review comments; GitLab:
MR diff discussion notes) and skips a finding when the same `findingId` has already been posted for
the same `headSha` (dedup key `headSha:findingId`). The skipped outcome records
`duplicate_inline_comment` with the existing provider comment ID/URL. The `>` characters in the
embedded JSON are unicode-escaped so a finding field can never prematurely close the HTML comment.

Duplicate suppression is intentionally scoped to the exact same head SHA and stable finding ID. Older comments without `headSha`, malformed hidden metadata, or comments from a different head are ignored for duplicate matching so they do not block a fresh, fully tagged inline comment.

### Author verification (anti-suppression)

Dedup metadata is only trusted on comments/notes **authored by the review bot itself**. Both adapters
resolve the bot identity once via `GET /user` (the token's own user, memoized) and ignore any
comment whose author id is not the bot's. Without this, anyone able to comment on the PR/MR could
plant a comment carrying a matching `findingId`+`headSha` (or, for the summary, the
`<!-- ai-code-review-factory` marker) to make the bot treat a finding as already-posted — silently
suppressing it — or, for the summary, target a comment the bot cannot edit so the update fails. The
same author check guards the **summary**-comment dedup (`findExistingSummaryComment` /
`findExistingSummaryNote`), not just inline.

**Safe-on-failure:** if the bot identity cannot be resolved (a non-2xx `GET /user`), no comment is
trusted for dedup — the worst case becomes a *duplicate* comment (the safe direction), never
suppression. (System notes on GitLab are also skipped — they never carry our metadata.)

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
