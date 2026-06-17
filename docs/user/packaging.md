# Packaging

The prototype distribution target is a Bun-backed npm tarball. The project is licensed Apache-2.0. Registry publishing is intentionally blocked for now by `private: true` until the final package name and access policy are decided. For the internal/self-managed GitLab beta, tarball/release-asset distribution is the supported adoption path; public npm is not part of the beta channel.

The package exposes a single CLI bin:

```bash
ai-code-review
```

The bin points at `src/cli.ts` and uses a Bun shebang, so runtime environments must install Bun before invoking the package. CI templates install the package with:

```bash
bun add --global "$AI_REVIEW_PACKAGE"
ai-code-review run ...
```

Until the package is published under its final name, set `AI_REVIEW_PACKAGE` to the exact immutable tarball source CI should install. For an internal GitLab beta, use a versioned self-managed GitLab release asset or generic package file URL, not `latest`, `main`, or an unpinned branch.

Example internal beta source:

```yaml
AI_REVIEW_PACKAGE: https://gitlab.example.com/<your-org>/dev-tools/ai-code-review-factory/-/releases/v0.1.0/downloads/ai-code-review-factory-0.1.0.tgz
```

## Package identity and publish blockers

Current package identity:

- npm package name: `ai-code-review-factory`
- version: `0.1.0`
- bin: `ai-code-review` → `./src/cli.ts`
- repository: `https://github.com/briggsd/ai-code-review-factory`
- license/access stance: Apache-2.0 licensed; package stays `private: true` until a registry-publish decision is made

Before public registry publish, decide:

1. whether the package name remains `ai-code-review-factory` or moves to a scoped/final name,
2. whether `private: true` should be removed,
3. whether `publishConfig.access` should be set for scoped public packages.

## Install source strategy

Current supported adoption source:

1. **Preferred for the internal/self-managed GitLab beta:** an immutable internal npm tarball URL, such as a versioned self-managed GitLab release asset or generic package file produced from `npm pack`.
2. **Preferred before public registry publish in other environments:** an immutable npm tarball URL, for example a release asset produced from `npm pack`.
3. **Preferred after registry publish:** an exact package version such as `ai-code-review-factory@0.1.0` or a scoped final package name.
4. **Internal smoke only:** a Git source pinned to a full Git commit SHA. Do not pin adopter CI to mutable branches or floating tags.

Do not use mutable install sources such as `main`, `latest`, or an unpinned Git branch for adopter CI. The package source should be reproducible from the CI logs, and the installed CLI should be treated as the reviewed repository's review toolchain, not as source checked out from the PR/MR under review.

For the end-to-end adopter checklist and live-tested/deferred matrix, see [Adoption guide](adoption.md).

## Smoke test the package artifact

Run:

```bash
bun run pack:smoke
bun run smoke:external-package
```

The `pack:smoke` script:

1. runs `npm pack` into a temporary directory,
2. verifies the tarball contains runtime assets and adopter-facing docs under `docs/user/`,
3. verifies it excludes repository-local internals such as `docs/developer/`, `docs/milestones/`, `test/`, `.github/`, and `continue.md`,
4. extracts the tarball, and
5. runs the packaged CLI's `schemas` command with Bun.

The `smoke:external-package` script simulates an adopter environment by packing the current project, installing the tarball into an isolated Bun global directory, and invoking the installed `ai-code-review` binary from a temporary working directory. It always runs `schemas` plus a fixture-backed dry-run through the installed CLI. The fixture dry-run also verifies the installed package writes `.ai-review/context/change-context.json`, writes per-file patch artifacts, records `patchPath` references without inline patch bodies, and persists context artifact byte metrics in run state.

To add a live provider-backed dry-run, set:

```bash
AI_REVIEW_EXTERNAL_SMOKE_PROVIDER=github \
AI_REVIEW_EXTERNAL_SMOKE_REPO=owner/name \
AI_REVIEW_EXTERNAL_SMOKE_CHANGE_ID=123 \
AI_REVIEW_EXTERNAL_SMOKE_HEAD_SHA=<optional-head-sha> \
AI_REVIEW_GITHUB_TOKEN=<read-token> \
bun run smoke:external-package
```

Use `AI_REVIEW_EXTERNAL_SMOKE_PROVIDER=gitlab`, `AI_REVIEW_EXTERNAL_SMOKE_REPO=group/project`, and `AI_REVIEW_GITLAB_TOKEN` for GitLab.

These smoke scripts are intentionally separate from `bun run check` because packaging validates the artifact and adopter-install boundary, not just source correctness.

## Current package contents

The package `files` allowlist includes:

- `.ai-review.schema.json`
- `README.md`
- `docs/user/`
- `examples/ci/`
- `examples/fixtures/`
- `research/`
- `scripts/`
- `src/`
- `tsconfig.json`

Only adopter-facing documentation is shipped: `docs/user/` is included, while `docs/developer/` and `docs/milestones/` stay outside the package. The allowlist prevents developer internals, milestone history, test suite files, workflow smoke internals, and handoff notes from leaking into the distributable artifact.

## Not yet done

- Published npm package name/license/access policy.
- Container image wrapper.
- GitHub Action wrapper.
- GitLab component wrapper.
