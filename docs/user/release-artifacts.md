# Release artifacts

A tagged release publishes the package to the **public npm registry** (via trusted publishing) and attaches an **immutable tarball** to a GitHub Release. For the internal/self-managed GitLab beta — or any environment that cannot reach public npm — the pinned tarball URL remains a supported alternative.

## Release workflow

`.github/workflows/release-package.yml` builds an npm tarball artifact from the trusted checkout. It runs on two triggers, with two distinct paths split across four jobs:

- **`workflow_dispatch`** — maintainer pre-release validation: the `pack` job builds the tarball and a dispatch-only `holdout-gate` job runs the secret-consuming live holdout quality gate. No GitHub Release is created. This is where provider secrets are used.
- **Push of a `v*` tag** — the publish path: the `pack` job builds the tarball, then a tag-only `release` job attaches it to a **GitHub Release** and a tag-only `npm-publish` job publishes it to the **public npm registry** (see [Release readiness](release-readiness.md) for the dispatch-then-tag SOP). The holdout gate does **not** run on a tag push, so **no provider secrets are consumed by a tag push** (#297); npm auth is short-lived OIDC, not a stored token.

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

On a `v*` tag push, a separate tag-only `release` job creates a GitHub Release for the tag and attaches the tarball via `gh release create` (a CLI run-step, not a third-party action, so no SHA pin is needed). The release runs only after the `pack` build job succeeds. It does **not** attach a quality stamp — no stamp is generated on the tag path; quality is validated separately via a `workflow_dispatch` run before tagging (see [Release readiness](release-readiness.md)).

The `pack` build job is least-privilege (`contents: read`); `contents: write` is confined to the tag-only `release` job, which uses the built-in `GITHUB_TOKEN`. A separate tag-only `npm-publish` job (`id-token: write`) downloads the `pack`-validated tarball and publishes it to the public npm registry via **trusted publishing** (short-lived OIDC — no stored npm token).

## How adopters should pin it

General adopters install the exact published version from npm — `bun add @briggsd/code-reviewer@X.Y.Z` — or pin `AI_REVIEW_PACKAGE` to that version. For environments that cannot reach public npm (a self-managed GitLab beta, air-gapped CI), set `AI_REVIEW_PACKAGE` to an immutable URL for the tarball instead:

```yaml
env:
  AI_REVIEW_PACKAGE: https://gitlab.example.com/<your-org>/dev-tools/code-reviewer/-/releases/vX.Y.Z/downloads/briggsd-code-reviewer-X.Y.Z.tgz
```

For a self-managed GitLab beta, host the tarball as an internal release asset or generic package file reachable by beta CI runners. Keep the URL versioned and immutable, and record the tarball filename plus source commit SHA in the beta rollout notes. Do not use mutable branches, floating tags, or `latest` for adopter CI. The installed review toolchain must be reproducible from CI logs.

## Registry publishing

The package publishes to the public npm registry as `@briggsd/code-reviewer` on every `v*` tag push, with these settings:

- scope access: public (`publishConfig.access: "public"`),
- provenance: generated automatically under trusted publishing,
- auth: GitHub Actions OIDC (trusted publisher), no stored npm token.

The first-ever publish was done manually to create the package and register the trusted publisher; see [Release readiness](release-readiness.md) for the one-time setup and the per-release SOP.
