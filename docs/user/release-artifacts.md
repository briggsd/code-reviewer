# Release artifacts

This project currently supports immutable tarball release artifacts, not registry publishing. Registry publishing remains blocked until package name, license, and access policy are finalized. For the Fortis/self-managed GitLab beta, the release channel is an internal pinned tarball URL; public npm is intentionally out of scope.

## Release workflow

`.github/workflows/release-package.yml` builds an npm tarball artifact from the trusted checkout. It runs on two triggers, with two distinct paths split across three jobs:

- **`workflow_dispatch`** — maintainer pre-release validation: the `pack` job builds the tarball and a dispatch-only `holdout-gate` job runs the secret-consuming live holdout quality gate. No GitHub Release is created. This is where provider secrets are used.
- **Push of a `v*` tag** — the **publish-only, secret-free** path: the `pack` job builds the tarball and a tag-only `release` job attaches it to a **GitHub Release** for the tag (see [Release readiness](release-readiness.md) for the dispatch-then-tag SOP). The holdout gate does **not** run on a tag push, so **no provider secrets are consumed by a tag push** (#297).

**Provider secrets are dispatch-only.** The live holdout quality gate performs real model calls, so at least one
of `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY` must be configured as a
repository secret matching the selected provider. Those secrets are referenced **only in the
`holdout-gate` job**, which is gated to `workflow_dispatch` (`if: github.event_name ==
'workflow_dispatch'`) — they are unreachable from any tag-push code path. The optional
`pi_provider` / `pi_model` dispatch inputs pin the provider/model (leave blank for Pi defaults;
they must be set together); `eval_runs` (default `3`, capped at 50) sets runs per scenario.

The `pack` job (both triggers):

1. checks out trusted source with `persist-credentials: false`,
2. installs Bun 1.3.0,
3. installs dependencies with `bun install --frozen-lockfile`,
4. installs the Pi CLI (`npm install -g --ignore-scripts @earendil-works/pi-coding-agent`),
5. runs `bun run check` — **always** on a `v*` tag push (a real release must pass the check
   suite); on a `workflow_dispatch` it is gated by the `run_checks` input (default `true`) for
   ad-hoc artifact builds (`if: startsWith(github.ref, 'refs/tags/v') || inputs.run_checks`),
6. always runs `bun run pack:smoke`,
7. creates `dist/*.tgz` with `npm pack`,
8. uploads the tarball (only) as a GitHub Actions artifact named with the source commit SHA. No provider secrets are used in `pack`.

The `holdout-gate` job (**`workflow_dispatch` only**) runs the **live holdout quality gate** (`bun run evals --gate --runs "$EVAL_RUNS" --stamp dist/quality-stamp.json`) — this step is **required** (no `continue-on-error`); if any holdout scenario regresses below threshold (or the holdout is empty), the gate exits nonzero and the job fails. It uploads `dist/quality-stamp.json` as a `quality-stamp-${{ github.sha }}` artifact. This is the only job that references the provider secrets.

The `release` job (**`v*` tag push only**) downloads the tarball artifact and runs `gh release create` to publish a GitHub Release for the tag with the tarball attached. It `needs: pack` only (not `holdout-gate`, which is skipped on a tag push). No fresh quality stamp is generated on the tag path.

The quality stamp (`ai-review.quality_stamp.v2`) contains per-scenario satisfaction scores, a
`blocked` boolean, per-run satisfaction distributions, min/max/variance diagnostics, flaky
markers, and per-criterion pass-rate results. It is produced by the dispatch-only `holdout-gate`
job and uploaded as a standalone validation artifact. See `../developer/evals.md` for the stamp schema,
v1-to-v2 migration note, and the `--stamp` flag documentation.

On a `v*` tag push, a separate tag-only `release` job creates a GitHub Release for the tag and attaches the tarball via `gh release create` (a CLI run-step, not a third-party action, so no SHA pin is needed). The release runs only after the `pack` build job succeeds. It does **not** attach a quality stamp — no stamp is generated on the publish-only tag path; quality is validated separately via a `workflow_dispatch` run before tagging (see [Release readiness](release-readiness.md)).

It does **not** publish to npm and adds no registry step; `private: true` stays in `package.json`. The `pack` build job is least-privilege (`contents: read`); `contents: write` is confined to the tag-only `release` job, which uses the built-in `GITHUB_TOKEN` and is the only place a write token is exercised.

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
