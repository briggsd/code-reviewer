# Getting started for adopters

This guide is the short path for wiring Code Reviewer into an existing
GitHub or GitLab repository. It assumes you want CI to run the packaged review
runner on pull requests or merge requests, keep the factory core unmodified, and
control repo-specific behavior through a small `.ai-review.json`.

For the deeper operator checklist and live-tested/deferred matrix, see the
[Adoption guide](adoption.md). For the mental model behind the workflow, see
[How it works for adopters](how-it-works.md).

## 1. Choose the install source

Pin the review runner to an immutable package source. Good choices are:

- an exact registry package version,
- an immutable npm tarball URL,
- a full Git commit SHA for internal smoke only.

Do not pin adopter CI to `main`, floating tags, `latest`, or a checkout of the
runner repository. The CI templates pass this source as `AI_REVIEW_PACKAGE` and
install it with:

```bash
bun add --global "$AI_REVIEW_PACKAGE"
```

Until the final public package is published, use the immutable internal tarball
or exact source your factory operator provides. More detail is in
[CI templates](ci-templates.md).

## 2. Add minimal project config

Create `.ai-review.json` at the repository root. A conservative starting point is
advisory mode: the review still runs and publishes artifacts, but findings do not
fail the required CI check while you calibrate reviewer behavior.

```json
{
  "mode": "advisory"
}
```

When you are ready to make the review a merge gate, switch to blocking mode:

```json
{
  "mode": "blocking",
  "failOn": ["critical"]
}
```

`failOn` is evaluated in blocking mode; advisory mode keeps findings visible
without failing the required CI check.

Most projects should start with the built-in reviewers and defaults. Add
`sensitivePaths`, `ignoredPaths`, reviewer policy, timeouts, or model routing only
when you have a concrete reason. Config arrays replace the built-in defaults, so
read [Project configuration](configuration.md) before overriding them.

If the reviewer keeps flagging something intentional in this repo — a maintainer-run
script, a deliberate pattern, a known exception — add a `conventions` array to
`.ai-review.json` to tell the reviewers about it. For example:

```json
{
  "conventions": ["scripts/* are maintainer-run tools; don't apply an untrusted-input threat model"]
}
```

Conventions shape what reviewers generate rather than filtering output after the fact, so treat
them as advisory rather than a guaranteed suppression. See the [`conventions` field
reference](configuration.md#fields) for bounds and trust notes.

## 3. Wire CI

Start from the template for your platform:

- GitHub raw CLI: [examples/ci/github-actions-ai-review.yml](../../examples/ci/github-actions-ai-review.yml)
- GitHub Action wrapper: [examples/ci/github-actions-ai-review-action.yml](../../examples/ci/github-actions-ai-review-action.yml)
- GitLab CI: [examples/ci/gitlab-ai-review.yml](../../examples/ci/gitlab-ai-review.yml)

The recommended CI shape is two jobs:

1. **Dry run:** read-only permissions, runs on every PR/MR, writes `.ai-review/`
   artifacts, and does not publish comments.
2. **Trusted publish:** same-repository/same-project guard, write permission, and
   `--publish-summary`.

Keep the runtime as `dummy` until the install, metadata fetch, diff fetch, and
artifact upload all work. Then enable `pi` only in trusted jobs that have the Pi
CLI and model credentials available. Installing Pi means the `@earendil-works/pi-coding-agent` CLI plus a provider API key — see [Enabling the Pi runtime](ci-templates.md#enabling-the-pi-runtime). The templates are explained in
[CI templates](ci-templates.md), and the `uses:` wrapper is documented in
[GitHub Action wrapper](github-action-wrapper.md).

## 4. Keep fork safety defaults

For public repositories and fork-capable projects, keep fork-triggered jobs
read-only:

- no model/provider secrets,
- no write token,
- no summary or inline publishing,
- no project dependency install or project scripts from the PR/MR checkout.

Use `.ai-review/runs` artifacts and the CI status as the fork PR signal. Publish
comments only from a separate same-repository/same-project job, or from an
explicitly approved privileged reporter flow. See
[Public repository fork safety](fork-safety.md) for the permission matrix and
trace-redaction guidance.

## 5. Open a smoke PR

Open a small PR/MR that changes a low-risk file such as documentation. On the
first run, verify:

- the review job installs the pinned package source,
- `.ai-review/runs` artifacts are uploaded even if the review fails,
- `run.json`, `summary.json`, and `trace.jsonl` are present,
- the dry-run job uses read-only permissions and does not publish,
- the trusted publish job is skipped for forks and runs only for same-repo or
  same-project changes,
- the CI status behaves as expected for your current `mode`.

After the smoke PR is stable, switch trusted jobs from `dummy` to `pi`, add model
credentials only there, and rerun the same kind of small change before scaling to
larger diffs.
