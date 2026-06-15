# CI templates

The templates in `examples/ci/` are starting points for wiring the runner into PR/MR pipelines.

The raw CLI examples use the packaged CLI entrypoint:

```bash
bun add --global "$AI_REVIEW_PACKAGE"
ai-code-review run ...
```

`AI_REVIEW_PACKAGE` is the packaged CLI source passed to `bun add --global`. GitHub templates may show the eventual exact registry shape, while the GitLab beta template defaults to an internal immutable tarball URL placeholder. Until the package is published under the final name, use an immutable npm tarball URL, exact registry version, or full Git commit SHA for internal smoke. Do not pin adopter CI to mutable branches, floating tags, `latest`, or the runner repository checkout.

For self-managed GitLab, keep `AI_REVIEW_GITLAB_API_BASE_URL` pointed at the instance API v4 endpoint. The GitLab template defaults it to `$CI_API_V4_URL`, which GitLab sets to the current instance's API URL, and passes it to the CLI with `--api-base-url` so the runner does not assume GitLab.com. Replace the sample `https://gitlab.example.com/.../ai-code-review-factory-0.1.0.tgz` package URL with the Fortis/internal tarball URL for the tested beta build.

The templates check out repository contents only so project-local config such as `.ai-review.json` can be read. They do **not** run `bun install` or any project dependency install from the pull/merge request checkout.

For adopters who prefer `uses:` syntax, `examples/ci/github-actions-ai-review-action.yml` uses the thin [GitHub Action wrapper](github-action-wrapper.md). The wrapper still installs and runs the packaged CLI.

For the full adopter sequence and live-tested/deferred matrix, see the [Adoption guide](adoption.md). For public repositories and forks, use the default strategy in [Public repository fork safety](fork-safety.md): read-only dry-run artifacts/status for fork PRs, and write-back only in same-repository/same-project or explicitly approved privileged jobs.

## GitHub Actions

Raw CLI template: `examples/ci/github-actions-ai-review.yml`

Action wrapper template: `examples/ci/github-actions-ai-review-action.yml`

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

This is the copy-paste starting point for the Fortis/self-managed GitLab beta. Replace the sample `AI_REVIEW_PACKAGE` value with the immutable internal tarball URL for the beta build. The template keeps runtime selection explicit with `AI_REVIEW_DRY_RUN_RUNTIME` and `AI_REVIEW_PUBLISH_RUNTIME`, both defaulting to `dummy` until a trusted Pi/model-backed job is intentionally enabled.

It defines two jobs:

1. `ai_review_dry_run`
   - Runs for merge request pipelines.
   - Uses a read token variable (`GITLAB_TOKEN_READ`).
   - Installs the packaged CLI from the pinned internal tarball URL with `bun add --global "$AI_REVIEW_PACKAGE"`.
   - Passes `--api-base-url "${AI_REVIEW_GITLAB_API_BASE_URL:-$CI_API_V4_URL}"` for GitLab.com or self-managed GitLab.
   - Runs `--runtime "$AI_REVIEW_DRY_RUN_RUNTIME"`, defaulting to `dummy`.
   - Writes `.ai-review/` artifacts that are retained for 14 days.
   - Does not publish notes.

2. `ai_review_publish_summary`
   - Runs only for same-project merge requests:
     `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID`.
   - Uses a write token variable (`GITLAB_TOKEN_WRITE`).
   - Installs the same packaged CLI.
   - Does not download dry-run artifacts; it reruns the packaged CLI from the same pinned source.
   - Passes the same GitLab API base URL as the dry-run job.
   - Runs `--runtime "$AI_REVIEW_PUBLISH_RUNTIME"`, defaulting to `dummy`.
   - Calls `--publish-summary`.

For a real model-backed review, replace `--runtime dummy` with `--runtime pi` and provide Pi/model credentials through protected or appropriately scoped CI variables.

## Safety stance

- CI status is the canonical merge blocker; summary comments/notes are UX.
- Do not execute untrusted fork code in privileged jobs.
- Keep write-back in a separate same-repo/same-project guarded job.
- Do not run project dependency installation from an untrusted PR/MR checkout in the review job.
- Treat project config and PR/MR content as untrusted input unless the pipeline policy says otherwise.
- Upload `.ai-review/` artifacts on failure; runtime/model/schema failures should leave `run.json.error` and a terminal `review.failed` trace event.
