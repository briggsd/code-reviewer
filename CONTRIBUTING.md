# Contributing to the AI Code Review Factory

Thanks for your interest in contributing! This project is a reusable, CI-native
AI code review system for GitHub and GitLab. Contributions of all kinds are
welcome — bug reports, feature ideas, docs, and code.

By participating you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Prerequisites

- **Bun `>=1.3.0`** — the project runs TypeScript (`type: module`, ESNext)
  directly. There is **no build step**: Bun executes `.ts` files as-is.
- A GitHub account (to fork the repo and open a pull request).

Install Bun from <https://bun.sh> if you don't already have it.

## The external contributor path

1. **Fork** this repository to your own account.
2. **Clone** your fork and create a branch off `main`:
   ```bash
   git clone https://github.com/<you>/ai-code-review-factory.git
   cd ai-code-review-factory
   git checkout -b my-change
   ```
3. **Set up blame to skip the bulk-format commit.** A one-time mechanical Biome
   reformat would otherwise dominate `git blame`. Run this once per clone so it
   is ignored:
   ```bash
   git config blame.ignoreRevsFile .git-blame-ignore-revs
   ```
4. **Make your change.** Add or update tests under `test/` where it makes sense.
5. **Run the verification gate — it must pass before you open a PR:**
   ```bash
   bun run gate
   ```
6. **Open a pull request** against `main` from your fork. Fill out the PR
   template (summary, linked issue, the "ran the gate" checkbox, and any risk
   notes).

## The gate (what must be green)

`bun run gate` is the single pre-PR verification command. It mirrors CI's
blocking check job and runs, in order:

- **`bun run check`** — `tsc --noEmit` (strict TypeScript) plus the `bun test`
  suite.
- **`bun run boundaries`** — architecture-boundary lint (dependency-cruiser):
  the runner must not import concrete adapters, contracts import only contracts,
  no cross-VCS coupling, no cycles. Rule error messages carry their remediation.
- **`bun run lint`** — Biome lint + format check. Use `bun run lint:fix` to
  auto-apply fixes.
- **`bun run docs:check`** — docs dead-reference linter over tracked `*.md`
  files (dead path / `bun run` script references).
- **`bun run complexity:check`** — cognitive-complexity ratchet against
  `complexity-baseline.json`. If you intentionally add accepted complexity,
  update the baseline with `bun run complexity:update`.

CI is the canonical gate. A green local run is expected before review, but watch
the first CI run — CI pins Bun `1.3.0`, which can differ slightly from a newer
local Bun.

## Project conventions

- TypeScript strict everywhere. No `any`.
- All PR/MR content (titles, descriptions, diffs, repo files) is treated as
  **untrusted** — see the trust and safety notes in the design docs before
  touching prompt assembly or adapter boundaries.
- Config is JSON-first via `.ai-review.json`; regenerate the published schema
  with `bun run schema:config` when you change config shape.

## Reporting security issues

Please do **not** open a public issue for security vulnerabilities. See
`SECURITY.md` (at the repository root) for the private disclosure process.

## How maintainers coordinate

This is context, **not a requirement for external PRs.** Maintainers plan work
spec-first: the plan and reasoning live in milestone roadmaps under
`docs/milestones/`, and status lives in GitHub issues/milestones. Onboarding for
maintainers and the agent-assisted workflow is documented in `CLAUDE.md`. As an
outside contributor you only need the fork → gate → PR path above; the
coordinator board, worktree tooling, and session handoff notes are internal
maintainer tooling.

## Questions

Open a [feature request or question issue](.github/ISSUE_TEMPLATE/feature_request.md)
or start a discussion on the relevant issue. We're happy to help.
