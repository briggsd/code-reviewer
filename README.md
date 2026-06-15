# AI Code Review Factory

Reusable CI-native AI code review system for GitHub and GitLab projects.

This repository starts as an architecture/design workspace. The implementation target is a shared review runner that can be installed across multiple repositories, triggered by pull/merge request CI, and configured per project without forking the core system.

## Documents

- [Architecture](docs/architecture.md) — system design, lifecycle, components, security model, and MVP plan.
- [Runtime comparison](docs/runtime-comparison.md) — OpenCode vs Pi as the review factory agent runtime.
- [Configuration](docs/configuration.md) — `.ai-review.json` fields, merging behavior, and schema command.
- [Adoption guide](docs/adoption.md) — recommended install path, live-tested evidence, deferred channels, and adopter checklist.
- [Fortis GitLab beta onboarding](docs/fortis-gitlab-beta.md) — self-managed GitLab beta setup, variables, debugging, and token rotation.
- [CI templates](docs/ci-templates.md) — GitHub Actions and GitLab CI starter templates.
- [GitHub Action wrapper](docs/github-action-wrapper.md) — thin `uses:` wrapper around the packaged CLI.
- [Fork safety](docs/fork-safety.md) — public-repo fork strategy and secret/write-token boundaries.
- [Security policy](SECURITY.md) — how to privately report a vulnerability, supported versions, and disclosure posture.
- [Operator-extension seam](docs/operator-extension-seam.md) — M017 design note + #16 disposition: the explicit-load BYO-reviewer seam, the merge-by-role override rule, and free-form operator-keyed roles.
- [Inline publishing](docs/inline-publishing.md) — experimental opt-in GitHub inline comments with conservative readiness gates.
- [Packaging](docs/packaging.md) — package artifact contents and smoke test.
- [Release artifacts](docs/release-artifacts.md) — manual immutable tarball artifact workflow.
- [Workflow smoke test](docs/workflow-smoke-test.md) — notes for the first same-repo GitHub Actions smoke PR.
- [Pi live smoke test](docs/pi-live-smoke.md) — opt-in local and GitHub Actions Pi/model smoke instructions.
- [GitLab live smoke](docs/gitlab-live-smoke.md) — opt-in real GitLab MR smoke for metadata/diff and summary publishing.
- [Release readiness](docs/release-readiness.md) — checklist for verification, packaging, CI adoption, and release blockers.
- [Re-review state](docs/re-review-state.md) — stable finding IDs and hidden metadata for future incremental review.
- [Research findings](research/ci-vcs-runtime-findings.md) — CI/VCS/runtime questions researched before drafting the architecture.
- [Evals](docs/evals.md) — holdout scenario eval harness: behavioral scoring, holdout hygiene, and how to run.
- [Telemetry export](docs/telemetry-export.md) — export schema (`ai-review.rollup_export.v1`), identifier policy, shape-bounded key rule, and reserved `ai_review.run_event` vocabulary (#20/#22).
- [Review-quality loop](docs/review-quality-loop.md) — the manual improvement playbook: telemetry hypothesis queue → investigate → distill a dev scenario → tune-against-dev → holdout-gate → ship (M016).
- [Doc gardening](docs/doc-gardening.md) — keeping agent-facing docs fresh: the `bun run docs:check` dead-reference linter, staleness advisories, and the recurring gardening pass (#92/#29).

## Development

The implementation is a Bun-friendly TypeScript CLI/package. Bun can run TypeScript directly and gives us `Bun.spawn` for future Pi/OpenCode subprocess adapters without adding a build step during the prototype.

```bash
bun run check
bun run pack:smoke # validates npm tarball contents and packaged CLI execution
bun run smoke:external-package # installs the tarball into an isolated Bun global dir and runs installed ai-code-review
bun run smoke:pi # exits 0 unless AI_REVIEW_LIVE_PI=1 is set
bun run smoke:gitlab # exits 0 unless AI_REVIEW_LIVE_GITLAB=1 is set
bun run src/cli.ts schemas # includes structured output schemas and .ai-review.json config schema
bun run schema:config # regenerate .ai-review.schema.json
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --output-dir .ai-review
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --runtime dummy --output-dir .ai-review
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --format markdown
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --ci-exit

# Read-only provider-backed metadata/diff fetches require an explicit token env var.
AI_REVIEW_GITHUB_TOKEN=... bun run src/cli.ts run --provider github --repo owner/name --change-id 123 --runtime dummy
AI_REVIEW_GITLAB_TOKEN=... bun run src/cli.ts run --provider gitlab --repo group/project --change-id 123 --runtime dummy

# Explicit GitHub/GitLab summary publishing.
AI_REVIEW_GITHUB_TOKEN=... bun run src/cli.ts run --provider github --repo owner/name --change-id 123 --runtime dummy --publish-summary
AI_REVIEW_GITLAB_TOKEN=... bun run src/cli.ts run --provider gitlab --repo group/project --change-id 123 --runtime dummy --publish-summary

# Experimental GitHub-only inline publishing. Summary publishing remains the default write-back UX.
AI_REVIEW_GITHUB_TOKEN=... bun run src/cli.ts run --provider github --repo owner/name --change-id 123 --runtime dummy --publish-summary --publish-inline

# Experimental Pi runtime spike. Uses Pi JSON mode with project-local resources disabled.
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --runtime pi --pi-provider anthropic --pi-model claude-sonnet-4-6

# Project config is JSON-first for the prototype. By default the CLI looks for
# .ai-review.json or ai-review.json in the current directory; pass --config to be explicit.
bun run src/cli.ts run --fixture examples/fixtures/auth-pr.json --config .ai-review.json --runtime dummy
```

Example `.ai-review.json`:

```json
{
  "mode": "blocking",
  "failOn": ["critical", "warning"],
  "reviewerPolicy": {
    "performance": "enabled"
  },
  "modelRouting": {
    "default": {
      "provider": "pi",
      "model": "claude-haiku",
      "tier": "light"
    },
    "roles": {
      "coordinator": {
        "provider": "pi",
        "model": "claude-opus",
        "tier": "top"
      },
      "security": {
        "provider": "pi",
        "model": "claude-sonnet",
        "tier": "standard"
      }
    }
  }
}
```

## Current implementation

- Fixture-backed local runner with filtered diff/risk classification.
- JSON-first project config loading from `.ai-review.json`, `ai-review.json`, or `--config`.
- Role-specific model routing and explicit safety-mode runtime tool policy mapping.
- Opt-in Pi live smoke script that runs through the packaged CLI when enabled; default tests remain fake/no-network/no-model.
- GitHub/GitLab summary comment publishing behind explicit `--publish-summary`, with hidden metadata and `publisher.completed` tracing.
- JSONL trace and filesystem state artifacts.
- Deterministic dummy agent runtime for coordinator/reviewer lifecycle tests.
- Experimental Pi subprocess/JSON-mode runtime adapter behind `AgentRuntime`, with streaming JSONL trace forwarding.
- GitHub VCS adapter MVP for PR metadata and changed-file diff fetching.
- GitLab VCS adapter MVP for MR metadata and changed-file diff fetching, with an opt-in live smoke harness.
- CI decision policy and markdown summary formatter.
- Package artifact allowlist, external packaged install smoke, and adoption guide for the Bun-backed CLI tarball.
- Distribution-facing CI templates that install the package and run `ai-code-review` instead of repository-local source commands.
- Experimental GitHub-only inline publishing behind explicit `--publish-inline`, gated by stale-head/diff/line-coordinate readiness checks and same-head duplicate suppression.
- Disabled-by-default GitHub Actions Pi live smoke workflow for trusted maintainer runs.
- Disabled-by-default same-repository GitHub PR real-review job using Pi/model credentials behind `AI_REVIEW_REAL_REVIEW_ENABLED=true`.
- Release readiness checklist for package verification, CI adoption, secrets, and release blockers.
- Stable finding IDs in completed summaries and hidden summary metadata.
- Prior summary metadata parsing from existing GitHub comments and GitLab notes.
- Provider-backed runs carry prior review state into `ReviewContext.priorState`.
- Re-review summaries classify findings as new, recurring, fixed, or withheld (grounding-suppressed); see `examples/fixtures/re-review-pr.json` for a fixture-backed example.
- Runtime/model/schema failures persist `run.json.error` and a terminal `review.failed` trace event after context construction.

## Design stance

- Deterministic code owns orchestration, state, policy, and CI integration.
- LLM agents own judgment-heavy review work.
- The core is provider-agnostic; GitHub, GitLab, model providers, and agent runtimes are adapters.
- Current runtime direction: runtime-neutral interface with a Pi-first prototype, while preserving an OpenCode adapter path.
- CI status is the canonical merge blocker; PR/MR comments are the human-facing review UX.
- Untrusted fork code is never executed in a privileged CI context.
