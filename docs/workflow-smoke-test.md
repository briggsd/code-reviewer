# Workflow smoke test

This file exists to create a small same-repository pull request that exercises the prototype GitHub Actions workflow.

Expected workflow behavior for this PR:

- `AI review dry run` fetches pull request metadata and changed files through the GitHub API.
- The runner uses `--runtime dummy`, so no model provider or Pi credentials are required.
- The workflow uploads `.ai-review/` artifacts.
- `AI review publish summary` runs because the PR branch is in the same repository.
- The publish job posts a summary comment using `--publish-summary`.

If this works, the next smoke step is to switch a controlled branch to `--runtime pi` with explicitly configured model credentials.

Live smoke started: 2026-06-09T11:18:26Z
