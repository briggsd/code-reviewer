# Workflow smoke test

This file exists to create small same-repository pull requests that exercise the prototype GitHub Actions workflow and provider write-back paths.

Expected default workflow behavior for PRs:

- `AI review dry run` fetches pull request metadata and changed files through the GitHub API.
- The runner uses `--runtime dummy`, so no model provider or Pi credentials are required.
- The workflow uploads `.ai-review/` artifacts.
- `AI review publish summary` runs because the PR branch is in the same repository when real review is not enabled.
- The dummy publish job posts or updates a summary comment using `--publish-summary`.
- The checked-in workflow and starter CI templates do **not** pass `--publish-inline` by default.

## Real Pi review on same-repository PRs

The repository workflow includes a guarded `AI review publish real Pi summary` job. It is disabled by default and replaces the dummy publish job only when this repository variable is set:

```text
AI_REVIEW_REAL_REVIEW_ENABLED=true
```

Required setup:

1. Add at least one model provider secret, for example `ANTHROPIC_API_KEY`.
2. Optionally add repository variables `AI_REVIEW_PI_PROVIDER` and `AI_REVIEW_PI_MODEL`; if omitted, the workflow uses `anthropic` and `claude-sonnet-4-6`.
3. Keep the job guarded to same-repository PRs:
   `github.event.pull_request.head.repo.full_name == github.repository`.

When enabled, the real job installs Pi with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, runs `ai-code-review` with `--runtime pi`, publishes the summary with `--publish-summary`, and uploads `.ai-review/` artifacts as `ai-review-real-<pr-number>`.

Do not move the real job to `pull_request_target` or expose model secrets to fork PRs.

Inline publishing smoke criteria for M004:

- Run a trusted same-repository GitHub PR with an explicit `--publish-inline` invocation.
- Confirm only readiness-approved findings produce GitHub pull request review comments.
- Confirm rerunning the same head/finding reports `duplicate_inline_comment` instead of posting a duplicate inline comment.
- Confirm skipped inline findings remain in the summary and trace output.

Historical smoke notes:

- Real Pi review smoke started: 2026-06-09T17:52:56Z (PR #9) after enabling `AI_REVIEW_REAL_REVIEW_ENABLED=true` and configuring `ANTHROPIC_API_KEY`; confirmed real Pi summary publishing ran with `claude-sonnet-4-6` and uploaded artifacts as `ai-review-real-9`.
- Live smoke started: 2026-06-09T11:18:26Z
- PR #1 verified summary-only workflow behavior, artifact upload, and summary comment idempotency.
- PR #4 verified explicit GitHub inline publishing with a seeded finding on `src/cli/run-options.ts:9`: first run posted one inline review comment, rerun on the same head skipped it with `duplicate_inline_comment`, and the summary comment was updated instead of duplicated.
