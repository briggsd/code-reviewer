# Packaging

The prototype distribution target is a Bun-backed npm tarball. The package exposes a single CLI bin:

```bash
ai-code-review
```

The bin points at `src/cli.ts` and uses a Bun shebang, so runtime environments must install Bun before invoking the package.

## Smoke test the package artifact

Run:

```bash
bun run pack:smoke
```

The smoke script:

1. runs `npm pack` into a temporary directory,
2. verifies the tarball contains runtime/docs assets that adopters need,
3. verifies it excludes repository-local internals such as `test/`, `.github/`, and `continue.md`,
4. extracts the tarball, and
5. runs the packaged CLI's `schemas` command with Bun.

This is intentionally separate from `bun run check` because packaging validates the artifact boundary, not just source correctness.

## Current package contents

The package `files` allowlist includes:

- `.ai-review.schema.json`
- `README.md`
- `docs/`
- `examples/ci/`
- `examples/fixtures/`
- `research/`
- `scripts/`
- `src/`
- `tsconfig.json`

The allowlist prevents test fixtures, workflow smoke internals, and handoff notes from leaking into the distributable artifact.

## Not yet done

- Published npm package name/access policy.
- Container image wrapper.
- GitHub Action wrapper.
- GitLab component wrapper.
