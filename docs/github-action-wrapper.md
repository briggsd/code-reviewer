# GitHub Action wrapper

`action.yml` provides a thin GitHub Action wrapper around the packaged `ai-code-review` CLI. It is for adopters who prefer `uses:` syntax over manually installing Bun and running `ai-code-review run` in every workflow.

The wrapper does not implement review logic. It:

1. sets up Bun,
2. installs `inputs.package-source` with `bun add --global`,
3. builds an `ai-code-review run ...` command from explicit inputs,
4. runs the packaged CLI.

## CLI template vs Action wrapper

Use the raw CLI template in `examples/ci/github-actions-ai-review.yml` when you want every install/run command visible in workflow YAML.

Use the Action wrapper template in `examples/ci/github-actions-ai-review-action.yml` when you want less YAML but the same safety posture.

Both paths require:

- immutable `AI_REVIEW_PACKAGE` source,
- dry-run and publish jobs separated,
- write-back guarded to same-repository PRs,
- no model credentials or write tokens for untrusted fork PRs,
- CI status from `--ci-exit` as the merge gate.

## Pinning

Pin both surfaces immutably:

```yaml
env:
  AI_REVIEW_PACKAGE: https://example.invalid/releases/download/v0.1.0/ai-code-review-factory-0.1.0.tgz

steps:
  - uses: briggsd/ai-code-review-factory@<full-commit-sha-or-immutable-tag>
    with:
      package-source: ${{ env.AI_REVIEW_PACKAGE }}
      provider: github
      repo: ${{ github.repository }}
      change-id: ${{ github.event.pull_request.number }}
      head-sha: ${{ github.event.pull_request.head.sha }}
```

Do not pin the action or package source to mutable branches such as `main`, floating tags, or `latest` in adopter CI.

## Inputs

Important inputs:

- `package-source` — immutable package source passed to `bun add --global`.
- `fixture` — optional smoke/local mode; when set, provider targeting inputs are ignored.
- `provider`, `repo`, `change-id`, `head-sha` — provider-backed review target. Required unless `fixture` is set.
- `runtime` — defaults to `dummy`; switch to `pi` only in trusted jobs with model credentials.
- `output-dir` — defaults to `.ai-review`.
- `publish-summary` — defaults to `false`; set to `true` only in guarded write-back jobs.
- `publish-inline` — defaults to `false`; experimental GitHub-only inline publishing.
- `ci-exit` — defaults to `true` so CI status remains authoritative.
- `token-env` — optional explicit token environment variable name if not using provider defaults.

## Safety stance

The wrapper intentionally keeps summary publishing and inline publishing as explicit opt-ins. It does not infer write-back from token availability. Fork PRs should remain dry-run/artifact-only unless a separate privileged reporter flow is designed.

## Smoke test

Run the local wrapper/package smoke with:

```bash
bun run smoke:action-wrapper
```

The script packs the current checkout, installs the tarball into an isolated Bun global directory, and runs the installed `ai-code-review` binary against a fixture. This verifies the same package install/run boundary the composite wrapper uses without requiring provider credentials.
