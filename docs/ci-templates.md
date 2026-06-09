# CI templates

The templates in `examples/ci/` are starting points for wiring the runner into PR/MR pipelines.

The examples use the packaged CLI entrypoint:

```bash
bun add --global "$AI_REVIEW_PACKAGE"
ai-code-review run ...
```

`AI_REVIEW_PACKAGE` defaults to `ai-code-review-factory@0.1.0` in the templates as the eventual registry shape. Until the package is published under the final name, replace that value with an immutable npm tarball URL, exact registry version, or full Git commit SHA for internal smoke. Do not pin adopter CI to mutable branches, floating tags, `latest`, or the runner repository checkout.

The templates check out repository contents only so project-local config such as `.ai-review.json` can be read. They do **not** run `bun install` or any project dependency install from the pull/merge request checkout.

For the full adopter sequence and live-tested/deferred matrix, see the [Adoption guide](adoption.md). For public repositories and forks, use the default strategy in [Public repository fork safety](fork-safety.md): read-only dry-run artifacts/status for fork PRs, and write-back only in same-repository/same-project or explicitly approved privileged jobs.

## GitHub Actions

Template: `examples/ci/github-actions-ai-review.yml`

It defines two jobs:

1. `dry-run`
   - Runs on every PR event.
   - Uses read permissions only: `contents: read`, `pull-requests: read`.
   - Installs the packaged CLI with `bun add --global "$AI_REVIEW_PACKAGE"`.
   - Fetches PR metadata/diff through the GitHub API.
   - Writes `.ai-review/` artifacts.
   - Does not publish comments.

2. `trusted-publish`
   - Runs only for same-repository PRs:
     `github.event.pull_request.head.repo.full_name == github.repository`.
   - Uses `pull-requests: write`.
   - Installs the same packaged CLI.
   - Calls `--publish-summary`.

For a real model-backed review, replace `--runtime dummy` with `--runtime pi` and ensure the CI environment can run the `pi` CLI plus whatever provider credentials Pi needs.

## GitLab CI

Template: `examples/ci/gitlab-ai-review.yml`

It defines two jobs:

1. `ai_review_dry_run`
   - Runs for merge request pipelines.
   - Uses a read token variable (`GITLAB_TOKEN_READ`).
   - Installs the packaged CLI with `bun add --global "$AI_REVIEW_PACKAGE"`.
   - Writes `.ai-review/` artifacts.
   - Does not publish notes.

2. `ai_review_publish_summary`
   - Runs only for same-project merge requests:
     `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID`.
   - Uses a write token variable (`GITLAB_TOKEN_WRITE`).
   - Installs the same packaged CLI.
   - Calls `--publish-summary`.

For a real model-backed review, replace `--runtime dummy` with `--runtime pi` and provide Pi/model credentials through protected or appropriately scoped CI variables.

## Safety stance

- CI status is the canonical merge blocker; summary comments/notes are UX.
- Do not execute untrusted fork code in privileged jobs.
- Keep write-back in a separate same-repo/same-project guarded job.
- Do not run project dependency installation from an untrusted PR/MR checkout in the review job.
- Treat project config and PR/MR content as untrusted input unless the pipeline policy says otherwise.
- Upload `.ai-review/` artifacts on failure; runtime/model/schema failures should leave `run.json.error` and a terminal `review.failed` trace event.
