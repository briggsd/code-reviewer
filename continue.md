# Continue — AI Code Review Factory

## Last action

Continued S11/M001: hardened runtime integration, config model, and packageability before broader CI distribution.

Docs read before implementation:

- Pi main README: modes, project trust, CLI flags, JSON/RPC modes.
- `docs/sdk.md`: SDK/session concepts, ResourceLoader behavior, tools, events.
- `docs/rpc.md`: strict JSONL framing, RPC commands/events, no generic readline warning.
- `docs/json.md`: JSON event stream mode and event shapes.

Decision made:

- Use a subprocess/JSON-mode Pi adapter for the spike, not the SDK yet.
- Rationale: process isolation, no SDK/session objects leaking above `AgentRuntime`, simpler Bun integration, and easy hardening with `--no-context-files --no-extensions --no-skills --no-prompt-templates --no-approve --no-session`.

Added:

- `src/runner/config.ts`
  - JSON-first project config loading from explicit `--config`, `.ai-review.json`, or `ai-review.json`.
  - Shared config normalization/merge logic, including nested reviewer policy, timeouts, and model routing.
- `ReviewConfig.modelRouting`
  - Default model selection plus role-specific overrides.
  - Runtime inputs now receive selected coordinator/reviewer models from config instead of hard-coded dummy roles.
- `createRuntimeToolPolicy()`
  - Explicit safety-mode-to-tool-policy mapping for `trusted`, `untrusted_read_only`, `privileged_metadata_only`, and `manual_privileged`.
- `test/runner.test.ts`
  - Config loading test.
  - Role-specific model routing test.
  - Safety-mode tool policy mapping test.
- `scripts/pi-live-smoke.ts` and `docs/pi-live-smoke.md`
  - Opt-in Pi/model smoke test guarded by `AI_REVIEW_LIVE_PI=1`.
  - Default `bun run smoke:pi` exits without network/model access.
- GitHub/GitLab summary publishing
  - `GitHubVcsAdapter.publishSummary()` posts a markdown issue comment to the PR timeline.
  - `GitLabVcsAdapter.publishSummary()` posts a markdown note to the MR timeline.
  - CLI `--publish-summary` calls provider publishing explicitly after review completion.
- Streaming Pi JSONL parsing
  - `BunPiProcessRunner` now parses stdout incrementally and calls `PiProcessRunInput.onEvent` as each JSONL event arrives.
  - `PiAgentRuntime` forwards streamed events immediately and falls back to forwarding returned events for fake/non-streaming process runners.
- Publishing orchestration helper
  - `src/publisher/publish-summary.ts` centralizes summary publishing, hidden metadata generation, and `publisher.completed` trace emission.
  - CLI `--publish-summary` now uses this helper instead of inline trace/publish logic.
  - `test/publisher.test.ts` covers successful publish trace emission, failure behavior, and hidden metadata shape.
- Config schema/docs
  - `src/schemas/review-config.ts` exports a JSON Schema for `.ai-review.json` partial config files.
  - `bun run src/cli.ts schemas` now prints finding/reviewer/coordinator output schemas plus the config schema.
  - `docs/configuration.md` documents config loading, merge behavior, fields, and safety caveat.
  - `.ai-review.schema.json` is checked in for editor/tool integrations.
  - `scripts/write-config-schema.ts` and `bun run schema:config` regenerate the checked-in schema artifact.
- CI starter templates
  - `examples/ci/github-actions-ai-review.yml` provides read-only dry-run and guarded same-repo publish jobs.
  - `examples/ci/gitlab-ai-review.yml` provides MR dry-run and guarded same-project publish jobs.
  - Templates now install the packaged CLI with `bun add --global "$AI_REVIEW_PACKAGE"` and run `ai-code-review run`, not `bun run src/cli.ts`.
  - `docs/ci-templates.md` documents how to adapt the package source and the safety stance.
  - `test/ci-templates.test.ts` checks the templates preserve read/write separation and provider command wiring while avoiding repo-local source commands/project dependency installs.
- M001 packageability roadmap and packageable MVP hardening slices
  - `M001-ROADMAP.md` captures the packageable MVP hardening slices; S01 through S06 are complete.
  - `package.json` now has an explicit `files` allowlist and `pack:smoke` script.
  - `scripts/package-smoke.ts` validates npm tarball contents, excludes repo-local internals, extracts the tarball, and runs the packaged CLI `schemas` command.
  - `docs/packaging.md` documents the Bun-backed npm tarball stance and CI package install shape.
  - `test/packaging.test.ts` locks package metadata and allowlist expectations.
  - `docs/fork-safety.md` documents the public-repo fork default, permission matrix, token/model-secret boundaries, and `pull_request_target` caveat.
  - `test/fork-safety-docs.test.ts` locks the fork-safety guidance links and key assertions.
  - `src/publisher/inline-readiness.ts` adds conservative preflight gates for future inline publishing: stale head SHA, truncated diff, missing location/line/side, missing patch, binary files, invalid deleted/added side, and line-not-in-patch.
  - `docs/inline-publishing.md`, `test/inline-readiness.test.ts`, and `test/inline-publishing-docs.test.ts` document and verify the deferred inline publishing stance.
  - `.github/workflows/pi-live-smoke.yml` adds a manual-only, default-branch-guarded Pi live smoke path. It defaults to no-op (`run_live_pi: false`) and only uses provider secrets in a maintainer-triggered workflow.
  - `scripts/pi-live-smoke.ts` now treats blank workflow inputs as omitted provider/model overrides.
  - `test/pi-live-smoke-workflow.test.ts` locks the manual-only workflow safety properties.
  - `docs/release-readiness.md` provides the release checklist covering verification, packaging, CI adoption, secrets, smoke testing, and release blockers.
  - `test/release-readiness-docs.test.ts` locks release checklist coverage.
- Real GitHub workflow smoke test
  - Pushed repo to `https://github.com/briggsd/ai-code-review-factory`.
  - Added `.github/workflows/ai-review.yml` and opened PR #1 from `smoke/github-actions-ai-review`.
  - First live run passed dry-run + publish jobs and posted a summary comment.
  - Fixed hidden `.ai-review` artifact upload by adding `include-hidden-files: true` and opted actions into Node 24 via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`.
  - Second live run passed and uploaded artifact `ai-review-1`.
  - Live smoke exposed duplicate summary comments on each rerun; adapters now update existing bot summary comments/notes instead of posting duplicates.
  - Third live run passed, uploaded artifact `ai-review-1`, and updated the existing bot comment instead of adding a third comment.
  - PR #1 was merged to `main` as merge commit `3a28e0480b32c024620a0ee4e424502ebadf9c43`; local `main` was fast-forwarded to `origin/main`.

Updated:

- `src/contracts/review.ts` — added `ModelRoutingConfig` and `ReviewConfig.modelRouting`.
- `src/runner/default-config.ts` — added dummy default/role model routing.
- `src/runner/fixture.ts` — reuses shared config normalization.
- `src/runner/run-review.ts` — selects models and tool policies from config/safety mode.
- `src/cli.ts` — supports `--config` and auto-loads conventional project config files.
- `README.md` — documented project config, model routing, Pi live smoke, and summary publishing.
- `package.json` — added `smoke:pi` script.

Implemented behavior:

- `PiAgentRuntime.runCoordinator()` runs selected reviewers concurrently, then runs a coordinator Pi prompt over reviewer results.
- `PiAgentRuntime.runReviewer()` runs a role-specific Pi prompt and validates returned findings.
- Default Pi process invocation disables project-local resources to avoid trusting reviewed repository instructions/extensions in CI by default.
- Tool policy is mapped to Pi CLI `--tools` or `--no-tools`.
- Runtime can use Pi's configured default model or a CLI-provided `--pi-provider/--pi-model` override.
- Tests do not invoke live Pi/model; they use an injected fake process runner.

Verification run:

```bash
bun run check
# tsc --noEmit passed
# bun test: 44 pass, 0 fail
# schemas command includes config schema
# bun run schema:config rewrites .ai-review.schema.json without diff
```

Known spike limitations:

- No live model smoke test was run; unit tests verify adapter behavior with a fake process runner. An opt-in smoke script is available.
- Coordinator invalid-shape JSON falls back to deterministic consolidation when valid JSON is present but not a full `ReviewSummary`; invalid JSON still fails. Reviewer invalid JSON/shape fails.
- Model routing above runtime is still primitive; config can route by role and CLI can pass one Pi model override for all roles.
- GitHub/GitLab publishing covers summary comments/notes only; inline comments/discussions are still deferred.

Note: `jq` is not installed in this environment; use Python for JSON assertions in shell checks.

## Current implementation stance

Use TypeScript with Bun for the prototype. Bun runs TS directly and provides `Bun.spawn` for Pi/OpenCode subprocess adapters, while the repo still keeps a normal package/CLI shape. Do not couple higher-level code to Bun-specific process APIs above runtime adapter implementations.

`ReviewContext.diff` represents the filtered/reviewable diff. `RiskAssessment.reviewedFileCount` and `RiskAssessment.ignoredFileCount` preserve the audit counts.

Local artifact layout from `--output-dir`:

```text
<output>/runs/<runId>/trace.jsonl
<output>/runs/<runId>/run.json
<output>/runs/<runId>/summary.json
<output>/changes/<provider>/<encoded-repo-slug>/<encoded-change-id>/latest.json
```

The GitHub adapter covers read-only metadata/diff fetching and explicit summary comment publishing. The GitLab adapter covers read-only metadata/diff fetching and explicit summary note publishing. Inline comments/discussions are deliberately deferred.

## Next action

Continue S11 hardening.

Concrete next steps:

1. Decide next milestone: publish/package channel execution (npm/container/action), or move into Phase 2 review quality/re-review work.
2. If publishing soon, follow `docs/release-readiness.md` and decide final package name/access policy.
3. If improving review UX, start from inline publishing implementation using `evaluateInlinePublishReadiness()` as the required preflight.

## Why

S10 proves the first real runtime adapter shape. Before turning this into live CI write-back, the system needs explicit config and safety policy so provider/runtimes cannot accidentally run with unsafe tools or project-local trust.

## Read first

- `README.md` — project entry point and current commands.
- `docs/runtime-comparison.md` — Pi-first prototype rationale.
- `src/contracts/runtime.ts` — `AgentRuntime` boundary.
- `src/runtime/pi-agent-runtime.ts` — Pi subprocess runtime implementation.
- `test/pi-runtime.test.ts` — fake process runner tests.
- `src/runner/run-review.ts` — runtime integration point.
- Pi docs already read this session: main README, `docs/sdk.md`, `docs/rpc.md`, `docs/json.md`.

## Current files / git state

Remote repo: `https://github.com/briggsd/ai-code-review-factory`.

Local `main` tracks `origin/main` and includes merged PR #1. At the handoff point, only this `continue.md` update is expected after the merge-state refresh; commit it before ending if a perfectly clean working tree is required.

## Open threads

- Decide whether to add a formal `M001-ROADMAP.md` or keep working from `continue.md` + architecture docs.
- Decide first package distribution target after prototype: npm package, container image, GitHub Action, GitLab component, or staged combination.
- Decide public-repo fork strategy default: read-only analysis, two-stage artifact handoff, or maintainer-approved privileged run.
- If using Pi live, explicitly control resource loading in CI so reviewed repositories cannot load untrusted project-local extensions/settings/instructions as privileged instructions. The current Pi subprocess adapter disables these by default.

## Do not

- Do not hard-code Pi or OpenCode above the `AgentRuntime` boundary.
- Do not leak Pi SDK/session objects or Bun-specific `Subprocess` objects above runtime adapter implementations.
- Do not use PR/MR comments as the canonical merge blocker; CI status is the gate.
- Do not run untrusted fork code in a privileged CI context.
- Do not start with the full Cloudflare feature set; Phase 1 is coordinator + code quality/security reviewers + summary publishing + CI status.
