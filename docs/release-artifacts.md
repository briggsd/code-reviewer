# Release artifacts

This project currently supports immutable tarball release artifacts, not registry publishing. Registry publishing remains blocked until package name, license, and access policy are finalized. For the Fortis/self-managed GitLab beta, the release channel is an internal pinned tarball URL; public npm is intentionally out of scope.

## Manual GitHub workflow

`.github/workflows/release-package.yml` is manual-only (`workflow_dispatch`) and builds an npm tarball artifact from the trusted checkout.

**Prerequisite:** the live holdout quality gate (step 7) performs real model calls, so at least one
of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` must be configured as a
repository secret matching the selected provider. The gate is **mandatory** (no `continue-on-error`),
so a dispatch with no usable provider credential fails to authenticate and blocks every release. The
optional `pi_provider` / `pi_model` dispatch inputs pin the provider/model (leave blank for Pi
defaults; they must be set together); `eval_runs` (default `3`, capped at 50) sets runs per scenario.

The workflow:

1. checks out trusted source with `persist-credentials: false`,
2. installs Bun 1.3.0,
3. installs dependencies with `bun install --frozen-lockfile`,
4. installs the Pi CLI (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`),
5. optionally runs `bun run check`,
6. always runs `bun run pack:smoke`,
7. runs the **live holdout quality gate** (`bun run evals --gate --runs "$EVAL_RUNS" --stamp dist/quality-stamp.json`) — this step is **required** (no `if:` or `continue-on-error`); if any holdout scenario regresses below threshold (or the holdout is empty), the gate exits nonzero and the pack step never runs,
8. creates `dist/*.tgz` with `npm pack`,
9. uploads the tarball **and** the `dist/quality-stamp.json` as a GitHub Actions artifact named with the source commit SHA.

The quality stamp (`ai-review.quality_stamp.v1`) contains per-scenario satisfaction scores and a
`blocked` boolean. It is uploaded alongside the tarball as a cross-version stability signal.
See `docs/evals.md` for the stamp schema and the `--stamp` flag documentation.

It does **not** publish to npm and does not require write permissions. Workflow permissions are `contents: read` only.

## How adopters should pin it

After a maintainer downloads or attaches the generated tarball to an internal release, adopters should set `AI_REVIEW_PACKAGE` to an immutable URL for that tarball:

```yaml
env:
  AI_REVIEW_PACKAGE: https://gitlab.example.com/fortis/dev-tools/ai-code-review-factory/-/releases/v0.1.0/downloads/ai-code-review-factory-0.1.0.tgz
```

For a self-managed GitLab beta, host the tarball as an internal release asset or generic package file reachable by beta CI runners. Keep the URL versioned and immutable, and record the tarball filename plus source commit SHA in the beta rollout notes. Do not use mutable branches, floating tags, or `latest` for adopter CI. The installed review toolchain must be reproducible from CI logs.

## When registry publishing becomes unblocked

Before publishing to npm, decide:

- final package name or scope,
- license,
- public/private access policy,
- whether `publishConfig.access` is required,
- provenance/signing expectations.

Until then, release artifacts are tarballs only.
