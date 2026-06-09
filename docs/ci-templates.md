# CI templates

The templates in `examples/ci/` are starting points for wiring the runner into PR/MR pipelines.

Current caveat: the project is still a prototype package. The examples run `bun run src/cli.ts` from this repository. Once distribution is finalized, replace that command with the published npm package, container image, GitHub Action, or GitLab component.

## GitHub Actions

Template: `examples/ci/github-actions-ai-review.yml`

It defines two jobs:

1. `dry-run`
   - Runs on every PR event.
   - Uses read permissions only: `contents: read`, `pull-requests: read`.
   - Fetches PR metadata/diff through the GitHub API.
   - Writes `.ai-review/` artifacts.
   - Does not publish comments.

2. `trusted-publish`
   - Runs only for same-repository PRs:
     `github.event.pull_request.head.repo.full_name == github.repository`.
   - Uses `pull-requests: write`.
   - Calls `--publish-summary`.

For a real model-backed review, replace `--runtime dummy` with `--runtime pi` and ensure the CI image can run the `pi` CLI plus whatever provider credentials Pi needs.

## GitLab CI

Template: `examples/ci/gitlab-ai-review.yml`

It defines two jobs:

1. `ai_review_dry_run`
   - Runs for merge request pipelines.
   - Uses a read token variable (`GITLAB_TOKEN_READ`).
   - Writes `.ai-review/` artifacts.
   - Does not publish notes.

2. `ai_review_publish_summary`
   - Runs only for same-project merge requests:
     `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID`.
   - Uses a write token variable (`GITLAB_TOKEN_WRITE`).
   - Calls `--publish-summary`.

For a real model-backed review, replace `--runtime dummy` with `--runtime pi` and provide Pi/model credentials through protected or appropriately scoped CI variables.

## Safety stance

- CI status is the canonical merge blocker; summary comments/notes are UX.
- Do not execute untrusted fork code in privileged jobs.
- Keep write-back in a separate same-repo/same-project guarded job.
- Treat project config and PR/MR content as untrusted input unless the pipeline policy says otherwise.
