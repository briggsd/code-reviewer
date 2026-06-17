# CI templates

The templates in `examples/ci/` are starting points for wiring the runner into PR/MR pipelines.

The raw CLI examples use the packaged CLI entrypoint:

```bash
bun add --global "$AI_REVIEW_PACKAGE"
ai-code-review run ...
```

`AI_REVIEW_PACKAGE` is the packaged CLI source passed to `bun add --global`. GitHub templates may show the eventual exact registry shape, while the GitLab beta template defaults to an internal immutable tarball URL placeholder. Until the package is published under the final name, use an immutable npm tarball URL, exact registry version, or full Git commit SHA for internal smoke. Do not pin adopter CI to mutable branches, floating tags, `latest`, or the runner repository checkout.

For self-managed GitLab, keep `AI_REVIEW_GITLAB_API_BASE_URL` pointed at the instance API v4 endpoint. The GitLab template defaults it to `$CI_API_V4_URL`, which GitLab sets to the current instance's API URL, and passes it to the CLI with `--api-base-url` so the runner does not assume GitLab.com. Replace the sample `https://gitlab.example.com/.../ai-code-review-factory-0.1.0.tgz` package URL with the internal tarball URL for the tested beta build.

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

For a real model-backed review, replace `--runtime dummy` with `--runtime pi` and ensure the CI environment can run the `pi` CLI plus whatever provider credentials Pi needs — see [Enabling the Pi runtime](#enabling-the-pi-runtime).

## GitLab CI

Template: `examples/ci/gitlab-ai-review.yml`

This is the copy-paste starting point for the internal/self-managed GitLab beta. Replace the sample `AI_REVIEW_PACKAGE` value with the immutable internal tarball URL for the beta build. The template keeps runtime selection explicit with `AI_REVIEW_DRY_RUN_RUNTIME` and `AI_REVIEW_PUBLISH_RUNTIME`, both defaulting to `dummy` until a trusted Pi/model-backed job is intentionally enabled.

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

### Why two jobs? (fork-safety design)

The two-job split is intentional, not a misconfiguration. The dry-run job runs on every merge request pipeline — including pipelines triggered by fork contributors — with a read-only token and no model secrets. The publish job runs only for same-project pipelines and holds the write token and any provider credentials. That split keeps privileged secrets out of any job that processes untrusted fork content.

An AI reviewer may flag this as a redundant or duplicate pipeline. It is not. If you want to suppress the finding permanently, add an acknowledgement in `.ai-review.json` — it persists across finding-ID drift (tolerant ack matching, #346):

```json
{
  "acknowledgements": [
    {
      "finding": "two-job gitlab pipeline is intentional fork-safety design",
      "reason": "dry-run/publish split keeps write tokens out of fork pipelines"
    }
  ]
}
```

### Internal/same-project only: single-job variant

For projects that never accept fork MRs, the dry-run is a redundant second pass. The alternative template `examples/ci/gitlab-ai-review-single-job.yml` collapses both jobs into one. It still keeps the same-project guard so the job fails safe — a fork MR just doesn't run, rather than running with a leaked write token. Use this template only for closed internal projects where fork pipelines genuinely never occur. The two-job default remains the hardened choice for any project that could receive fork MRs.

For a real model-backed review, replace `--runtime dummy` with `--runtime pi` and provide Pi/model credentials through protected or appropriately scoped CI variables — see [Enabling the Pi runtime](#enabling-the-pi-runtime).

## Bitbucket Pipelines

Template: `examples/ci/bitbucket-pipelines.yml`

Copy this into your repository's `bitbucket-pipelines.yml`. Replace the `AI_REVIEW_PACKAGE` value with an immutable tarball URL or exact-version pinned package source for the build you have tested.

It defines two steps under `pipelines: pull-requests:`:

1. **AI review dry run**
   - Uses `AI_REVIEW_BITBUCKET_TOKEN` for read access only.
   - Installs the packaged CLI with `bun add --global "$AI_REVIEW_PACKAGE"`.
   - Passes `--repo "$BITBUCKET_REPO_FULL_NAME"`, `--change-id "$BITBUCKET_PR_ID"`, and `--head-sha "$BITBUCKET_COMMIT"`.
   - Runs `--runtime dummy` — no model secrets, no write-back.
   - Writes `.ai-review/` artifacts.

2. **AI review publish summary**
   - Calls `--publish-summary` to write the review comment back to the PR using `AI_REVIEW_BITBUCKET_TOKEN`, which must be configured as a **secured** repository variable.

Both steps need `AI_REVIEW_BITBUCKET_TOKEN`, and because it must be secured (see below), both run on same-repository PRs and fail closed on fork PRs.

### Required variables

`AI_REVIEW_BITBUCKET_TOKEN` — a Bitbucket repository or workspace access token with pull request read access for the dry-run step and comment/write access for the publish step. Configure it under **Repository settings > Repository variables** and mark it **Secured**. App Passwords and HTTP Basic auth are not supported; use a Bearer repository/workspace access token.

Set `AI_REVIEW_PACKAGE` to an immutable tarball URL or exact registry version. Configure it as a plain (non-secured) repository variable or inline in the template.

### Why two steps? (fork-safety design)

Bitbucket withholds secured repository variables from pipelines triggered by pull requests from forked repositories, so `AI_REVIEW_BITBUCKET_TOKEN` is absent in fork-PR builds.

Unlike GitHub (which injects a read-only `GITHUB_TOKEN`) and GitLab (which can supply a separate read token), Bitbucket provides no built-in pipeline token — so both steps need `AI_REVIEW_BITBUCKET_TOKEN`: the dry-run to read the PR, the publish step to write back. Because that token must be secured (it grants write access), a fork PR has it for neither step, and the review does not run — both steps fail closed rather than reading or writing with an exposed credential. This is stricter than the GitHub same-repo `if:` guard and the GitLab `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID` rule, both of which still allow a read-only dry run on fork PRs. On Bitbucket, fork PRs get no automated review unless you deliberately expose a credential to forks, which is not recommended. Same-repo PRs run both steps normally.

Note that cross-repository (fork) pull request pipelines must also be explicitly enabled under **Repository settings > Pull requests**. If that setting is off, fork-PR pipelines do not run at all, which is also safe.

An adopter who never accepts fork PRs can collapse both steps into one by adding `--publish-summary` to the dry-run step and removing the separate publish step. The two-step default is the correct choice for any repository that could receive fork PRs.

### Enabling the Pi runtime on Bitbucket

The Pi CLI requires Node >= 22.19. The `oven/bun:1.3` image ships no Node, so switching to `--runtime pi` on the publish step requires using a Node base image and installing bun on top — the same constraint as the [GitLab Pi path](#enabling-the-pi-runtime). Switch the publish step's `image` to `node:22-bookworm-slim`, add `npm install -g bun` before the bun install, and add `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@<version>`. Set your provider API key (e.g. `ANTHROPIC_API_KEY`) as a secured repository variable and expose it only in the publish step.

## Enabling the Pi runtime

The `dummy` runtime (default) needs no model access. To run a real model-backed review, switch to `--runtime pi`. This requires:

1. **Install the Pi CLI.** The Pi CLI is the `@earendil-works/pi-coding-agent` npm package. Pin the version you have tested, for example `@earendil-works/pi-coding-agent@0.79.4`:

   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.79.4
   ```

   `--ignore-scripts` stops the package's (and its dependencies') `postinstall` scripts from running arbitrary code in a privileged CI runner — keep it whenever you install a third-party CLI in CI. If you adapt the command (e.g. to `bun add --global`, which does not run lifecycle scripts by default), preserve that no-scripts behavior.

2. **Node >= 22.19.** The Pi package declares `engines.node >= 22.19.0`. **The `oven/bun` image ships no Node**, so the GitLab Pi path must swap the base image to a Node image (e.g. `node:22-bookworm-slim`) and install bun on top (`npm install -g bun`). GitHub Actions runners generally ship a recent Node — add `actions/setup-node@v4` with `node-version: 22` if the runner's Node is older than 22.19.

3. **Provider API key.** Pi authenticates via the provider API key matching your `.ai-review.json` `modelRouting` provider — `ANTHROPIC_API_KEY` by default; also `OPENAI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` for those providers. Pass this as a protected/masked CI variable in trusted jobs only.

4. **Trusted jobs only — never forks.** Provider credentials and `--runtime pi` must only appear in same-repo/same-project jobs, never in fork-triggered pipelines. A fork-triggered job with secrets is a security risk.

**Private GitLab package registry.** If the runner tarball lives in a private GitLab package registry, `bun add --global <url>` does not send the required authentication. Fetch with `JOB-TOKEN` first, then install the local file. `CI_JOB_TOKEN` is a scoped GitLab credential, so the snippet below enforces two guards inline before sending it: it asserts `AI_REVIEW_PACKAGE`'s origin matches your GitLab instance (`CI_SERVER_URL`) so the token only ever travels to your own host, and uses `redirect: "error"` so it can't follow a cross-origin redirect:

```bash
bun -e 'const u = new URL(process.env.AI_REVIEW_PACKAGE); if (u.origin !== new URL(process.env.CI_SERVER_URL).origin) throw new Error("untrusted package origin: " + u.origin); const r = await fetch(u, { headers: { "JOB-TOKEN": process.env.CI_JOB_TOKEN }, redirect: "error" }); if (!r.ok) throw new Error("download " + r.status); await Bun.write("/tmp/runner.tgz", await r.arrayBuffer());'
bun add --global /tmp/runner.tgz
```

For a public tarball URL, the plain `bun add --global "$AI_REVIEW_PACKAGE"` is sufficient.

## Safety stance

- CI status is the canonical merge blocker; summary comments/notes are UX.
- Do not execute untrusted fork code in privileged jobs.
- Keep write-back in a separate same-repo/same-project guarded job.
- Do not run project dependency installation from an untrusted PR/MR checkout in the review job.
- Treat project config and PR/MR content as untrusted input unless the pipeline policy says otherwise.
- Upload `.ai-review/` artifacts on failure; runtime/model/schema failures should leave `run.json.error` and a terminal `review.failed` trace event.
