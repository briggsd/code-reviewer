# Release artifacts

This project currently supports immutable tarball release artifacts, not registry publishing. Registry publishing remains blocked until package name, license, and access policy are finalized. For the Fortis/self-managed GitLab beta, the release channel is an internal pinned tarball URL; public npm is intentionally out of scope.

## Manual GitHub workflow

`.github/workflows/release-package.yml` is manual-only (`workflow_dispatch`) and builds an npm tarball artifact from the trusted checkout.

The workflow:

1. checks out trusted source with `persist-credentials: false`,
2. installs Bun 1.3.0,
3. installs dependencies with `bun install --frozen-lockfile`,
4. optionally runs `bun run check`,
5. always runs `bun run pack:smoke`,
6. creates `dist/*.tgz` with `npm pack`,
7. uploads the tarball as a GitHub Actions artifact named with the source commit SHA.

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
