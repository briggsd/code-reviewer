# Release readiness checklist

Use this checklist before publishing or handing the runner to another repository.

## Required verification

Run from a clean checkout:

```bash
bun run check
bun run pack:smoke
bun run smoke:pi
```

Expected results:

- `bun run check` passes TypeScript and the unit test suite.
- `bun run pack:smoke` validates tarball contents and packaged CLI schema execution.
- `bun run smoke:pi` exits 0 without model/network access unless `AI_REVIEW_LIVE_PI=1` is explicitly set.

## Version and artifact

- Choose the package version in `package.json`.
- Confirm the package `files` allowlist still excludes `.github/`, `test/`, local run artifacts, and handoff notes.
- Run `npm pack --dry-run --json` if you need to inspect the full file list manually.
- Keep `AI_REVIEW_PACKAGE` in CI templates pinned to a version, tarball URL, registry URL, or Git ref that adopters can reproduce.

## Channel decision

Current supported channel:

- **Bun-backed npm tarball/package** — install with `bun add --global "$AI_REVIEW_PACKAGE"`, run `ai-code-review`.

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

## Release blockers

Do not release if any of these are true:

- `bun run check` fails.
- `bun run pack:smoke` fails.
- Package contents include tests, workflow internals, local artifacts, or handoff notes.
- CI templates require `bun run src/cli.ts` from the runner repository.
- Fork PR/MR docs imply write tokens or model secrets are available to untrusted code.
- Inline comments/discussions are enabled without passing `evaluateInlinePublishReadiness()`.
