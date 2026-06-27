# Release readiness checklist

Use this checklist before publishing or handing the runner to another repository. Pair it with the [Adoption guide](adoption.md), which documents the recommended adopter path, live-tested evidence, and deferred channels.

## Release cadence

Releases are **time-boxed weekly**. Merge to `main` continuously; once a week, if
`CHANGELOG.md`'s `## [Unreleased]` section has any entries and the live holdout quality
gate passes, cut a release. A quiet week with an empty `[Unreleased]` cuts nothing — the
timer is a ceiling on how long shipped work waits, not a mandate to tag every week.

Pick the version from the `[Unreleased]` contents under [SemVer](https://semver.org): any
`Added`/`feat` entry makes it a minor (`0.X+1.0`); a `Fixed`-only batch is a patch
(`0.X.Y+1`). The changelog stays current per-PR (each change lands with its own entry), so
cutting is just promotion + bump + gate + tag — never a reconstruction.

A regression test (`test/packaging.test.ts`) enforces the version↔changelog invariant: it
fails the gate if `package.json`'s version lacks **both** a matching dated
`## [X.Y.Z] - YYYY-MM-DD` section **and** a corresponding reference-link definition at the
foot of `CHANGELOG.md` (`[X.Y.Z]: https://github.com/briggsd/code-reviewer…`). This is the
forcing function — it is impossible to bump the version for a release without fully
promoting the changelog, which is how `v0.2.0`/`v0.3.0`/`v0.3.1` silently fell three
releases behind before it existed.

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
- `bun run smoke:external-package` validates isolated Bun global install and installed `code-reviewer` execution; provider-backed dry-run runs only when `AI_REVIEW_EXTERNAL_SMOKE_PROVIDER`, repo/change env vars, and a provider token are set.
- `bun run smoke:action-wrapper` validates the package install/run boundary used by the composite GitHub Action wrapper.
- `bun run smoke:pi` exits 0 without model/network access unless `AI_REVIEW_LIVE_PI=1` is explicitly set.

## Version and artifact

- Choose the package version in `package.json`.
- Registry publish is enabled via the tag-push CI job, which runs `npm publish` with provenance after `bun run check` and `pack:smoke` pass; see [Packaging](packaging.md) and [Release artifacts](release-artifacts.md).
- Confirm the package `files` allowlist ships adopter-facing docs under `docs/user/` and still excludes `docs/developer/`, `.github/`, `test/`, local run artifacts, and handoff notes.
- Run `npm pack --dry-run --json` if you need to inspect the full file list manually.
- Run `bun run smoke:external-package` with live provider env vars before handing a package source to another repository.
- Keep `AI_REVIEW_PACKAGE` in CI templates pinned to an immutable internal tarball URL, exact package version, or full Git commit SHA for internal smoke only. For the internal/self-managed GitLab beta, prefer a versioned internal tarball URL produced by the manual release artifact workflow.
- Do not use mutable install sources such as `main`, floating tags, or `latest` in adopter CI.

## Cutting a tagged GitHub Release

**Prerequisite (one-time):** the npm package must already exist and this workflow must be
registered as its **trusted publisher** on npmjs (package → Settings → Trusted Publisher → GitHub
Actions: repo `briggsd/code-reviewer`, workflow `release-package.yml`). Because a trusted publisher
is configured on an existing package's settings page, the **first-ever publish is done manually**
(`npm login` + `npm publish --access public`) to create the package; every tagged release after
that publishes automatically via CI. No npm token is stored in the repo — CI authenticates with
short-lived OIDC. If the trusted publisher is not configured, the `npm-publish` job fails; the
`release` (GitHub Release) job is independent and still succeeds.

The supported distribution is a **GitHub Release** carrying the tarball AND a publish to the
**public npm registry**. A `v*` tag push triggers both: `npm publish` (with provenance, via
trusted-publishing OIDC) of the `pack`-validated tarball, plus `gh release create` to attach the
tarball to a GitHub Release.

**No provider API keys — and no stored npm token — are consumed on the tag path (#297 preserved).**
npm auth is a short-lived OIDC token, not a long-lived credential. Provider secrets (Anthropic,
OpenAI, Google) remain confined to the dispatch-only holdout quality gate and are never reachable
from a tag push.

The secret-consuming live holdout quality gate runs **only on `workflow_dispatch`** (the validation
step below) — it is not reachable from a tag push, so pushing a `v*` tag can never consume
provider API keys (#297).

A **tag ruleset** is still worth configuring as the **who-can-release** control. GitHub deprecated
the classic "tag protection rules" feature in favor of repository **rulesets** (Settings → Rules →
Rulesets → new **tag** ruleset). Configure it with target tag pattern `v*`, the **Restrict
creations** rule (optionally **Restrict deletions** / **Restrict updates** too), and a bypass list
limited to the release maintainers. It enforces *who* can trigger a publish; the #297 provider-key
invariant is enforced by the workflow itself.

**SOP-bypass risk:** without this ruleset, any collaborator with write access can push a `v*` tag
directly and the workflow will publish a GitHub Release and npm package that **never passed the live
holdout quality gate** (the gate runs only on the dispatch path, step 4). This is the accepted
trade-off of the publish-only tag design from #297: the tag path does not re-run the gate, so the
ruleset is the only thing gating *who* can trigger a publish. Treat the tag ruleset as a
release-process control, not a safety control.

Releases are version-tag driven. The version convention is a `vX.Y.Z` git tag matching the
`package.json` `version`. The supported flow is **two steps: dispatch to validate, then tag to
publish.** To cut a release:

1. **Bump the version.** Set `package.json` `version` to the new `X.Y.Z`, and update the concrete
   version pins that must track it: the `package-source` default in `action.yml`, the
   `AI_REVIEW_PACKAGE` default in `examples/ci/github-actions-ai-review.yml`, and the version
   references in `docs/user/packaging.md`. (A pin left on an unpublished version makes the action
   wrapper install a 404.)
2. **Update the changelog.** In [`CHANGELOG.md`](../../CHANGELOG.md), promote the `## [Unreleased]`
   entries into a new dated `## [X.Y.Z] - YYYY-MM-DD` section and refresh the comparison links at
   the bottom. The release-hygiene test in `test/packaging.test.ts` blocks the gate until this
   section exists for the version in `package.json`, so step 1 and step 2 must land together.
3. **Land the bump** on the default branch (normal PR + merge).
4. **Validate quality (dispatch).** Manually run `.github/workflows/release-package.yml` via
   **workflow_dispatch** against the merged commit. This builds the tarball **and** runs the
   **live holdout quality gate** (the only place provider secrets are used), uploading
   `dist/quality-stamp.json`. It also runs a `npm publish --dry-run` of the built tarball to
   validate the publish command resolves and packs correctly — catching a regression like the
   `./`-less path misparse from #401 here, before the immutable tag, not on it. Confirm the
   gate passes before tagging. This is the gate for the release; it is not bypassed — it just
   runs here, not on the tag push.

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

6. **Workflow publishes.** The `v*` tag push triggers the workflow: the `pack` job first guards
   that the tag matches `package.json` `version` (failing fast on a mismatch, which blocks both
   publishes), then builds the `npm pack` tarball. A tag-only `release` job creates a GitHub
   Release with that tarball attached via `gh release create`, and a tag-only `npm-publish` job
   downloads the same validated tarball and runs `npm publish dist/*.tgz --provenance --access
   public` via trusted-publishing OIDC to publish to the public npm registry. The `release` and
   `npm-publish` jobs both depend on `pack` but run independently of each other. The holdout gate
   does **not** run on this path — quality was validated in step 4.

Adopters can then install the exact published version (`bun add @briggsd/code-reviewer@X.Y.Z`) or
pin `AI_REVIEW_PACKAGE` to the immutable Release asset URL — never a mutable branch, floating tag,
or `latest`.

**Partial-publish recovery.** The `release` and `npm-publish` jobs are independent, so one can
succeed while the other fails (e.g. a GitHub Release is created but the npm publish errors). The
tag is already consumed, so do **not** re-tag. Instead:

- **`npm-publish` failed, `release` succeeded:** re-run just the failed `npm-publish` job from the
  Actions UI — it re-downloads the same `pack`-validated tarball artifact (kept 14 days) and
  republishes via OIDC. If the artifact has expired, publish that exact version manually from a
  clean checkout of the tag (`git checkout vX.Y.Z && npm publish --access public`).
- **`release` failed, `npm-publish` succeeded:** the npm version is immutable and already public;
  create the missing GitHub Release manually with `gh release create vX.Y.Z` against the same tag.

## Channel decision

Current supported channel:

- **Bun-backed npm tarball/package** — install with `bun add @briggsd/code-reviewer` (general adopters) or `bun add --global "$AI_REVIEW_PACKAGE"` for pinned/internal sources. Run `code-reviewer`. For the internal/self-managed GitLab beta, use an immutable internal tarball URL produced from `npm pack` and hosted as an internal release asset or generic package file.

Install-source priority:

1. Exact npm package version after publish (e.g. `bun add @briggsd/code-reviewer@X.Y.Z`).
2. Immutable internal tarball URL for the internal/self-managed GitLab beta.
3. Immutable tarball URL for air-gapped or non-registry environments.
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
- The npm trusted publisher is not configured (or the package does not yet exist) when cutting a tagged release — the `npm-publish` job will fail.
- Package contents include developer docs, milestone history, tests, workflow internals, local artifacts, or handoff notes.
- CI templates require `bun run src/cli.ts` from the runner repository.
- Fork PR/MR docs imply write tokens or model secrets are available to untrusted code.
- Inline comments/discussions are enabled without passing `evaluateInlinePublishReadiness()`.
