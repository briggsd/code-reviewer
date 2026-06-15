# Release artifacts

This project currently supports immutable tarball release artifacts, not registry publishing. Registry publishing remains blocked until package name, license, and access policy are finalized. For the Fortis/self-managed GitLab beta, the release channel is an internal pinned tarball URL; public npm is intentionally out of scope.

## Release workflow

`.github/workflows/release-package.yml` builds an npm tarball artifact from the trusted checkout. It runs on two triggers:

- **`workflow_dispatch`** — ad-hoc artifact build (no GitHub Release), with the optional inputs below.
- **Push of a `v*` tag** — the release path: it runs the same gated build and then attaches the tarball + quality stamp to a **GitHub Release** for the tag (see [Release readiness](release-readiness.md) for the tag/bump SOP).

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
5. runs `bun run check` — **always** on a `v*` tag push (a real release must pass the check
   suite); on a `workflow_dispatch` it is gated by the `run_checks` input (default `true`) for
   ad-hoc artifact builds (`if: startsWith(github.ref, 'refs/tags/v') || inputs.run_checks`),
6. always runs `bun run pack:smoke`,
7. runs the **live holdout quality gate** (`bun run evals --gate --runs "$EVAL_RUNS" --stamp dist/quality-stamp.json`) — this step is **required** (no `if:` or `continue-on-error`); if any holdout scenario regresses below threshold (or the holdout is empty), the gate exits nonzero and the pack step never runs,
8. creates `dist/*.tgz` with `npm pack`,
9. uploads the tarball **and** the `dist/quality-stamp.json` as a GitHub Actions artifact named with the source commit SHA,
10. on a `v*` tag push only, the `release` job downloads that artifact and runs `gh release create` to publish a GitHub Release for the tag with both files attached.

The quality stamp (`ai-review.quality_stamp.v2`) contains per-scenario satisfaction scores, a
`blocked` boolean, per-run satisfaction distributions, min/max/variance diagnostics, flaky
markers, and per-criterion pass-rate results. It is uploaded alongside the tarball as a
cross-version stability signal. See `docs/evals.md` for the stamp schema, v1-to-v2 migration note,
and the `--stamp` flag documentation.

On a `v*` tag push, a separate tag-only `release` job creates a GitHub Release for the tag and attaches the tarball and `dist/quality-stamp.json` via `gh release create` (a CLI run-step, not a third-party action, so no SHA pin is needed). The release runs only after the build job — and therefore the live holdout quality gate — succeeds.

It does **not** publish to npm and adds no registry step; `private: true` stays in `package.json`. The build job is least-privilege (`contents: read`); `contents: write` is confined to the tag-only `release` job, which uses the built-in `GITHUB_TOKEN` and is the only place a write token is exercised.

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
