# Code Reviewer

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Status: prototype](https://img.shields.io/badge/status-prototype-orange.svg)](#project-status)

A CI-native AI code review runner for GitHub and GitLab. Install it once, trigger it from
pull/merge request CI, and configure each repo with a small `.ai-review.json`. You never fork
the core.

Deterministic code owns the boring, safety-critical parts (fetching diffs, filtering, risk
tiering, timeouts, retries, state, publishing, the CI gate). LLM agents handle the judgment:
specialist reviewers fan out by risk and domain, a coordinator fuses their findings. The CI
status is the merge gate; comments are just the human-facing UX.

## Project status

This is a working prototype, not a finished product. It runs real reviews today (GitHub and
GitLab adapters, Pi-backed models, CI templates, summary publishing, incremental re-review),
but a few things are deliberately not done yet:

- **Not on a package registry.** `package.json` keeps `private: true`; there is no `npm publish`.
  You install from a clone or a pinned internal package, not `npm i @briggsd/code-reviewer`.
- **Bun is required to run it.** The CLI runs TypeScript directly through Bun with no build step,
  so any environment that runs the bin needs [Bun](https://bun.sh) `>=1.3.0`.

## Try it in 30 seconds

No tokens, no model API key. Clone, install, run the bundled fixture through the deterministic
dummy runtime:

```bash
git clone https://github.com/briggsd/code-reviewer.git
cd code-reviewer
bun install
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --runtime dummy --format markdown
```

You get a full review summary, including a planted critical finding:

```text
## AI review found significant concerns

🔴 Significant concerns — Risk tier `full` · CI `fail`

Files reviewed: 1 · Findings: 1

### 🔒 security — 🔴 1 critical
- CRITICAL: Account lookup misses authorization (auth/accounts.ts:23)
  Why it matters: the lookup uses a request-supplied accountId without proving the
  caller can access that account.
```

The dummy runtime is deterministic and needs no model, so this is a demo of the pipeline, not a
real model review. To point it at your own edits, change some files in this repo and run:

```bash
bun run review:local   # reviews your uncommitted git diff with the dummy runtime
```

It reads the working-tree diff, so a clean checkout reviews nothing. Run `git add -N <path>`
first if you want brand-new untracked files included.

For a real model-backed review, switch to the Pi runtime and pass a provider/model:

```bash
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json \
  --runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6 \
  --pi-api-key env:ANTHROPIC_API_KEY
```

## Install it in another repo's CI

The real use is running on every PR/MR. The short version:

1. **Pin an install source.** CI installs the runner with `bun add --global "$AI_REVIEW_PACKAGE"`.
   Point `AI_REVIEW_PACKAGE` at an immutable source (a pinned commit or an internal tarball);
   do not use `main`, a branch, or `latest`.
2. **Add `.ai-review.json`** at the repo root. Start in advisory mode so reviews run without
   blocking merges while you calibrate.
3. **Copy a CI template** from [`examples/ci/`](examples/ci/) and keep the runtime on `dummy`
   until install, fetch, and artifact upload all work. Then switch trusted jobs to `pi`.
4. **Keep fork jobs read-only** (no secrets, no write token, no publish).

Full walkthrough with the two-job CI shape and the smoke-PR checklist:
[Getting started](docs/user/getting-started.md).

## Configure

A minimal `.ai-review.json`:

```json
{
  "mode": "advisory"
}
```

Switch to a merge gate when you trust the reviews:

```json
{
  "mode": "blocking",
  "failOn": ["critical"]
}
```

Config arrays replace the built-in defaults rather than merging, so read
[Configuration](docs/user/configuration.md) before overriding `sensitivePaths`, reviewer policy,
or model routing. Regenerate the published JSON schema with `bun run schema:config`.

## How it works

```text
PR/MR event
  -> CI job runs code-reviewer
  -> VCS adapter fetches metadata + diff + prior review state
  -> diff filter -> risk classifier (trivial / lite / full)
  -> shared context -> coordinator -> specialist reviewer fan-out -> coordinator fusion
  -> publisher writes summary + CI status -> traces/state persisted
```

Risk tier decides how much review a change gets: small diffs run cheap, risky ones pull in more
reviewers and stronger models. Re-pushes carry prior state forward, so later rounds classify
findings as new, recurring, fixed, or withheld instead of re-reviewing from scratch. See
[How it works](docs/user/how-it-works.md) and, for the full design,
[Architecture](docs/developer/architecture.md).

## Safety

All PR/MR content (titles, descriptions, comments, diffs, repo files) is treated as untrusted and
sanitized before it reaches a prompt. Only factory-owned reviewer definitions run; reviewed-repo
Pi/project resources stay disabled in CI. Fork PRs never get secrets or a write token by default.
See [Fork safety](docs/user/fork-safety.md) and [Security policy](SECURITY.md) (report
vulnerabilities privately).

## Documentation

**Adopters**
- [Getting started](docs/user/getting-started.md) — install, configure, wire CI, smoke-test a PR/MR.
- [How it works](docs/user/how-it-works.md) — adopter lifecycle, gate policy, reviewer/model routing.
- [Adoption guide](docs/user/adoption.md) — operator checklist, live-tested evidence, rollout.
- [Configuration](docs/user/configuration.md) — `.ai-review.json` fields, merge behavior, schema.
- [CI templates](docs/user/ci-templates.md) — GitHub Actions and GitLab CI starters.
- [GitHub Action wrapper](docs/user/github-action-wrapper.md) — thin `uses:` wrapper.
- [Fork safety](docs/user/fork-safety.md) — fork strategy and secret/write-token boundaries.
- [Inline publishing](docs/user/inline-publishing.md) — experimental GitHub inline comments.
- [Internal/self-managed GitLab beta onboarding](docs/user/internal-gitlab-beta.md) — self-managed setup and tokens.

**Packaging & release**
- [Packaging](docs/user/packaging.md) · [Release artifacts](docs/user/release-artifacts.md) ·
  [Release readiness](docs/user/release-readiness.md)
- Smoke tests: [Workflow](docs/user/workflow-smoke-test.md) · [Pi live](docs/user/pi-live-smoke.md) ·
  [GitLab live smoke](docs/user/gitlab-live-smoke.md)

**Design & internals**
- [Architecture](docs/developer/architecture.md) — system design, lifecycle, security model.
- [Extending and testing](docs/developer/extending.md) — integration recipes + test-infra index.
- [Decision guardrails](docs/developer/decision-guardrails.md) — load-bearing invariants.
- [Reviewer conventions](docs/developer/reviewer-conventions.md) ·
  [Operator-extension seam](docs/developer/operator-extension-seam.md) ·
  [Re-review state](docs/developer/re-review-state.md)
- [Telemetry export](docs/developer/telemetry-export.md) · [Evals](docs/developer/evals.md) ·
  [Runtime comparison](docs/developer/runtime-comparison.md)

## Development

Bun `>=1.3.0`, TypeScript, no build step. Tests are fake and offline by default.

```bash
bun run gate     # full pre-PR gate (tsc + tests + boundaries + lint + docs + complexity + knip)
bun run check    # the tsc + test core
bun test         # bun:test suite
```

Packaging and opt-in live smokes (network/model-gated, off by default):

```bash
bun run pack:smoke              # validate the npm tarball contents + packaged CLI
bun run smoke:external-package  # install the tarball into an isolated Bun dir, run code-reviewer
bun run smoke:gitlab            # live GitLab MR smoke (needs AI_REVIEW_LIVE_GITLAB=1)
```

Run `bun run src/cli.ts run --help` for the full CLI surface (provider fetches, summary/inline
publishing, runtime selection). Contribution guidelines and the security policy are in
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE).
