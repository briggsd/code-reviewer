# Packaging

The package is published to the public npm registry as `@briggsd/code-reviewer`, licensed Apache-2.0. It is bun-native: the CLI runs TypeScript directly through Bun with no build step, so any environment that runs the bin must have [Bun](https://bun.sh) `>=1.3.0` installed.

Install with:

```bash
bun add @briggsd/code-reviewer
```

Or install globally:

```bash
bun add --global @briggsd/code-reviewer
```

The package exposes a single CLI bin:

```bash
code-reviewer
```

The bin points at `src/cli.ts` and uses a Bun shebang. CI templates install the package with:

```bash
bun add --global "$AI_REVIEW_PACKAGE"
code-reviewer run ...
```

For internal or air-gapped environments, set `AI_REVIEW_PACKAGE` to the exact immutable tarball source CI should install. For an internal GitLab beta, use a versioned self-managed GitLab release asset or generic package file URL, not `latest`, `main`, or an unpinned branch.

Example internal beta source:

```yaml
AI_REVIEW_PACKAGE: https://gitlab.example.com/<your-org>/dev-tools/code-reviewer/-/releases/vX.Y.Z/downloads/briggsd-code-reviewer-X.Y.Z.tgz
```

## Package identity and publish config

Current package identity:

- npm package name: `@briggsd/code-reviewer`
- version: `0.3.0`
- bin: `code-reviewer` → `./src/cli.ts`
- repository: `https://github.com/briggsd/code-reviewer`
- license: Apache-2.0 licensed; scoped public via `publishConfig.access: public`

The package is published with npm provenance from the tag-push CI job via **trusted publishing** (OIDC — no stored npm token; `npm publish --provenance --access public`). The `private` field is absent from `package.json`; `publishConfig.access` is set to `"public"` to ensure the scoped package publishes publicly.

## Install source strategy

Supported adoption sources in priority order:

1. **Preferred for general adopters:** an exact npm package version, installed with `bun add @briggsd/code-reviewer@0.3.0` (pin the version; drop the `@0.3.0` only to track latest).
2. **Preferred for the internal/self-managed GitLab beta:** an immutable internal npm tarball URL, such as a versioned self-managed GitLab release asset or generic package file produced from `npm pack`.
3. **Immutable tarball URL:** a release asset produced from `npm pack`, for environments that need a pinned artifact outside the registry.
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
3. verifies it excludes repository-local internals such as `docs/developer/`, `test/`, `.github/`, and `continue.md`,
4. extracts the tarball, and
5. runs the packaged CLI's `schemas` command with Bun.

The `smoke:external-package` script simulates an adopter environment by packing the current project, installing the tarball into an isolated Bun global directory, and invoking the installed `code-reviewer` binary from a temporary working directory. It always runs `schemas` plus a fixture-backed dry-run through the installed CLI. The fixture dry-run also verifies the installed package writes `.ai-review/context/change-context.json`, writes per-file patch artifacts, records `patchPath` references without inline patch bodies, and persists context artifact byte metrics in run state.

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
- `scripts/`
- `src/`
- `tsconfig.json`

Only adopter-facing documentation is shipped: `docs/user/` is included, while `docs/developer/` stays outside the package. The allowlist prevents developer internals, test suite files, workflow smoke internals, and handoff notes from leaking into the distributable artifact.

## Not yet done

- Container image wrapper.
- GitHub Action wrapper.
- GitLab component wrapper.
