# Workflow smoke test

This file exists to create small same-repository pull requests that exercise the prototype GitHub Actions workflow and provider write-back paths.

Expected default workflow behavior for PRs:

- `AI review dry run` fetches pull request metadata and changed files through the GitHub API.
- The runner uses `--runtime dummy`, so no model provider or Pi credentials are required.
- The workflow uploads `.ai-review/` artifacts.
- `AI review publish summary` runs because the PR branch is in the same repository.
- The publish job posts or updates a summary comment using `--publish-summary`.
- The checked-in workflow and starter CI templates do **not** pass `--publish-inline` by default.

Inline publishing smoke criteria for M004:

- Run a trusted same-repository GitHub PR with an explicit `--publish-inline` invocation.
- Confirm only readiness-approved findings produce GitHub pull request review comments.
- Confirm rerunning the same head/finding reports `duplicate_inline_comment` instead of posting a duplicate inline comment.
- Confirm skipped inline findings remain in the summary and trace output.

Historical smoke notes:

- Live smoke started: 2026-06-09T11:18:26Z
- PR #1 verified summary-only workflow behavior, artifact upload, and summary comment idempotency.
- PR #4 verified explicit GitHub inline publishing with a seeded finding on `src/cli/run-options.ts:9`: first run posted one inline review comment, rerun on the same head skipped it with `duplicate_inline_comment`, and the summary comment was updated instead of duplicated.
