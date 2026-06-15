# Release readiness checklist

Use this checklist before publishing or handing the runner to another repository. Pair it with the [Adoption guide](adoption.md), which documents the recommended adopter path, live-tested evidence, and deferred channels.

## Required verification

Run from a clean checkout:

```bash
bun run check
bun run pack:smoke
bun run smoke:external-package
bun run smoke:action-wrapper
bun run smoke:pi
```

Expected results:

- `bun run check` passes TypeScript and the unit test suite.
- `bun run pack:smoke` validates tarball contents and packaged CLI schema execution.
- `bun run smoke:external-package` validates isolated Bun global install and installed `ai-code-review` execution; provider-backed dry-run runs only when `AI_REVIEW_EXTERNAL_SMOKE_PROVIDER`, repo/change env vars, and a provider token are set.
- `bun run smoke:action-wrapper` validates the package install/run boundary used by the composite GitHub Action wrapper.
- `bun run smoke:pi` exits 0 without model/network access unless `AI_REVIEW_LIVE_PI=1` is explicitly set.

## Version and artifact

- Choose the package version in `package.json`.
- Registry publish is currently blocked until the package name, license, and access policy are finalized; see [Packaging](packaging.md) and [Release artifacts](release-artifacts.md).
- Confirm the package `files` allowlist still excludes `.github/`, `test/`, local run artifacts, and handoff notes.
- Run `npm pack --dry-run --json` if you need to inspect the full file list manually.
- Run `bun run smoke:external-package` with live provider env vars before handing a package source to another repository.
- Keep `AI_REVIEW_PACKAGE` in CI templates pinned to an immutable internal tarball URL, exact package version, or full Git commit SHA for internal smoke only. For the Fortis/self-managed GitLab beta, prefer a versioned internal tarball URL and do not require public npm.
- Do not use mutable install sources such as `main`, floating tags, or `latest` in adopter CI.

## Cutting a tagged GitHub Release

The supported beta distribution is a **GitHub Release** carrying the tarball and quality stamp.
There is **no registry publish** this round: `private: true` stays in `package.json` and no `npm
publish` / registry login exists in any workflow. That deferral is intentional — registry
semantics (final name/scope, access policy, provenance) are not yet finalized; see
[Release artifacts](release-artifacts.md).

**The tag-push path is publish-only and secret-free.** A `v*` tag push builds the tarball (no
provider secrets) and attaches it to a GitHub Release. The secret-consuming live holdout quality
gate runs **only on `workflow_dispatch`** (the validation step below) — it is no longer reachable
from a tag push, so pushing a `v*` tag can never consume the three provider API keys (#297).

A **tag ruleset** is still worth configuring as the **who-can-release** control. GitHub deprecated
the classic "tag protection rules" feature in favor of repository **rulesets** (Settings → Rules →
Rulesets → new **tag** ruleset). Configure it with target tag pattern `v*`, the **Restrict
creations** rule (optionally **Restrict deletions** / **Restrict updates** too), and a bypass list
limited to the release maintainers. It is no longer the secret-exposure control — that is enforced
by the workflow, which keeps secrets on the dispatch-only validation job.

**SOP-bypass risk:** without this ruleset, any collaborator with write access can push a `v*` tag
directly and the workflow will publish a GitHub Release that **never passed the live holdout
quality gate** (the gate runs only on the dispatch path, step 4). This is the accepted trade-off of
the publish-only tag design from #297: the tag path is intentionally secret-free and does not
re-run the gate, so the ruleset is the only thing gating *who* can trigger a publish. Treat the tag
ruleset as a release-process control, not a safety control.

Releases are version-tag driven. The version convention is a `vX.Y.Z` git tag matching the
`package.json` `version`. The supported flow is **two steps: dispatch to validate, then tag to
publish.** To cut a release:

1. **Bump the version.** Set `package.json` `version` to the new `X.Y.Z`.
2. **Update the changelog.** In [`CHANGELOG.md`](../../CHANGELOG.md), promote the `## [Unreleased]`
   entries into a new `## [X.Y.Z]` section and refresh the comparison links at the bottom.
3. **Land the bump** on the default branch (normal PR + merge).
4. **Validate quality (dispatch).** Manually run `.github/workflows/release-package.yml` via
   **workflow_dispatch** against the merged commit. This builds the tarball **and** runs the
   **live holdout quality gate** (the only place provider secrets are used), uploading
   `dist/quality-stamp.json`. Confirm the gate passes before tagging. This is the gate for the
   release; it is not bypassed — it just runs here, not on the tag push.

   **Verify the validated commit SHA.** `workflow_dispatch` targets a **branch ref, not a SHA**, so
   if other commits land between this run and the tag, the gate will have validated a *different*
   commit than the one you tag and publish. After the dispatch run completes, open it in the
   Actions UI and confirm its commit SHA matches the exact commit you intend to tag in step 5. The
   safest path is to dispatch from a freshly-pulled `main` with no in-flight merges, then tag that
   same commit immediately. If the SHAs do **not** match (a concurrent merge landed), do not tag —
   re-run the dispatch against `main` after the branch has stabilised and re-verify the SHA before
   proceeding to step 5.
5. **Tag and push to publish.** From the validated commit, create and push the matching annotated
   tag:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

6. **Workflow publishes (no secrets).** The `v*` tag push triggers the workflow's secret-free
   path: the `pack` job builds the `npm pack` tarball, then a tag-only `release` job creates a
   GitHub Release for the tag with the tarball attached via `gh release create`. That `release`
   job is the only one granted `contents: write`; the `pack` job stays `contents: read`. The
   holdout gate does **not** run on this path — quality was validated in step 4.

Adopters then pin `AI_REVIEW_PACKAGE` to the immutable Release asset URL — never a mutable
branch, floating tag, or `latest`.

## Channel decision

Current supported channel:

- **Bun-backed npm tarball/package** — install with `bun add --global "$AI_REVIEW_PACKAGE"`, run `ai-code-review`. For the Fortis/self-managed GitLab beta, use an immutable internal tarball URL produced from `npm pack` and hosted as an internal release asset or generic package file. Before registry publish in any environment, use an immutable tarball URL produced by the manual release artifact workflow, or a full Git commit SHA for internal smoke.

Install-source priority:

1. Immutable internal tarball URL for the Fortis/self-managed GitLab beta.
2. Immutable tarball URL before public registry publish in other environments.
3. Exact registry package version after publish.
4. Full Git commit SHA for internal smoke only.

Deferred channels:

- **Container image** — useful for GitLab and hermetic CI once the runtime environment stabilizes.
- **GitHub Action wrapper** — useful after the CLI package interface stops changing.
- **GitLab component wrapper** — useful after token and fork/MR guidance stabilizes.

Do not publish wrappers that hide the current safety model. The CLI/package path should remain the source of truth until the wrappers can expose the same controls.

## CI adoption checklist

- Use `examples/ci/github-actions-ai-review.yml` or `examples/ci/gitlab-ai-review.yml` as the starting point.
- Keep dry-run and publish jobs separate.
- Keep write-back guarded to same-repository/same-project changes or explicit maintainer approval.
- Do not run project dependency installation from an untrusted PR/MR checkout.
- Use CI status as the merge gate; treat comments/notes as UX only.

## Secrets checklist

- Provider read token: read-only PR/MR metadata and diff access.
- Provider write token: same-repo/same-project summary publishing only.
- Model/runtime credentials: trusted jobs only; treat them like write tokens.
- Pi live smoke secrets: manual `.github/workflows/pi-live-smoke.yml` only, default branch only.

## Smoke after adoption

For a target repository:

1. Run the dry-run job on a low-risk PR/MR and inspect `.ai-review/` artifacts.
2. Enable same-repo/same-project summary publishing and verify the bot updates, not duplicates, the summary.
3. Keep fork PRs/MRs artifact-only unless a two-stage reporter or manual privileged flow is explicitly adopted.
4. Run the optional Pi live smoke only after provider secrets and Pi installation are configured.
5. On failure, inspect `.ai-review/runs/<runId>/run.json` and `trace.jsonl` before rerunning; runtime failures should include `run.json.error` and a terminal `review.failed` trace event.

## Live-tested vs deferred

Live-tested in this repository:

- GitHub same-repository dry-run, artifact upload, and summary publishing/update behavior.
- GitHub hidden-metadata re-review classification for new, recurring, and fixed findings.
- Isolated packaged CLI install and live GitHub provider-backed dry-run.
- Packaged CLI Pi runtime smoke with Pi JSON mode and model output.
- Runtime failure persistence through `run.json.error` and `review.failed` traces.

Deferred or not yet live-recorded:

- Inline comments/discussions.
- Live GitLab MR publishing smoke.
- Container image, GitHub Action wrapper, and GitLab component wrapper.
- Privileged fork write-back flows.

## Release blockers

Do not release if any of these are true:

- `bun run check` fails.
- `bun run pack:smoke` fails.
- Package contents include tests, workflow internals, local artifacts, or handoff notes.
- CI templates require `bun run src/cli.ts` from the runner repository.
- Fork PR/MR docs imply write tokens or model secrets are available to untrusted code.
- Inline comments/discussions are enabled without passing `evaluateInlinePublishReadiness()`.
