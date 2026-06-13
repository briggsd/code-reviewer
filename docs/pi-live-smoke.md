# Pi live smoke test

The normal test suite never calls Pi, a model provider, or the network. It uses fake process runners for the Pi adapter.

Use the live smoke test only when you intentionally want to verify the packaged `ai-code-review` CLI, local `pi` CLI, provider credentials, JSON-mode adapter, trace writing, and structured output prompts end-to-end.

## Run

```bash
# Safe default: exits 0 without calling Pi/model.
bun run smoke:pi

# Opt in to a real Pi/model run using Pi's configured default model.
AI_REVIEW_LIVE_PI=1 bun run smoke:pi

# Or force a provider/model for this smoke run.
AI_REVIEW_LIVE_PI=1 \
AI_REVIEW_PI_PROVIDER=anthropic \
AI_REVIEW_PI_MODEL=claude-sonnet-4-6 \
bun run smoke:pi
```

Optional output directory override:

```bash
AI_REVIEW_LIVE_PI=1 AI_REVIEW_SMOKE_OUTPUT_DIR=.ai-review-smoke bun run smoke:pi
```

Artifacts are written under:

```text
<output>/runs/<runId>/trace.jsonl
<output>/runs/<runId>/run.json
<output>/runs/<runId>/summary.json # only present after successful summary creation
```

On runtime/model/schema failure after context construction, `run.json` is still written with `error`, `completedAt`, `context`, and `tracePath`, and `trace.jsonl` ends with a structured `review.failed` event containing `phase: "agent_runtime"`, the error name, and the error message. Inspect those artifacts before rerunning; they should identify whether the failure was a Pi process error, timeout, malformed JSON, or unrecoverable schema drift.

When enabled, the script packs the current trusted checkout with `npm pack`, installs the tarball into an isolated Bun global directory, creates an adopter-like temporary working directory, and invokes the installed `ai-code-review run --runtime pi` binary. The temporary adopter directory includes an `AGENTS.md` trap file; the Pi adapter's `--no-context-files --no-extensions --no-skills --no-prompt-templates --no-approve --no-session` flags are expected to keep project-local (reviewed-repo) resources out of the model context. Note the distinction (M015 S03, #126): `--no-extensions` turns off reviewed-repo extension *discovery*, but the adapter *separately* loads one trusted, factory-owned extension by explicit path (`--extension <submit-findings path>`) — an explicit `-e`/`--extension` still loads under `--no-extensions`. So "no extensions" means "no reviewed-repo extensions," not "no extensions at all" — see `docs/fork-safety.md`.

## What it exercises

- Packaged `ai-code-review` binary execution
- `PiAgentRuntime`
- `BunPiProcessRunner`
- `pi --mode json --print` (prompt piped via STDIN, not argv — M015 S03, #126)
- default CI-hardening flags: `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-context-files`, plus an explicit `--extension <factory submit-findings path>` (the one trusted extension, loaded under `--no-extensions`)
- untrusted read-only runtime tool policy
- reviewer `submit_findings` tool-call delivery (the structured **primary** path, M015 S03 #126): the happy-path signal is `structuredOutput: true` on the reviewer `agent.output` event, with findings read straight from the tool args (no `JSON.parse`/repair)
- coordinator `submit_review` tool-call delivery (the structured **primary** path, M015 S04 #127): the happy-path signal is `structuredOutput: true` on the coordinator `agent.output` event; `risk` is sourced from context, not the model
- the prose-parse fallback (`structuredOutput: false`) for both reviewer and coordinator, exercised only when the instruct-only tool call is absent — including a narrow repair for model-emitted invalid JSON escape sequences inside fenced JSON strings (the two-character sequence backslash-backtick: `` \` ``)
- streaming JSONL event forwarding into the trace sink
- JSONL trace and filesystem state artifacts

The generated smoke fixture disables documentation and performance reviewers to keep the run small while still exercising multiple reviewer subprocesses plus the coordinator.

## GitHub Actions opt-in workflow

This repository includes `.github/workflows/pi-live-smoke.yml` as a disabled-by-default maintainer smoke path.

Safety properties:

- It only uses `workflow_dispatch`; it does not run on `pull_request`.
- The job is guarded to `refs/heads/main` so secrets are not exposed to arbitrary branch workflow edits.
- The `run_live_pi` input defaults to `false`; the default run exercises the no-op safety path.
- The workflow installs Pi with `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
- The enabled path installs and runs the packed `ai-code-review` CLI rather than calling `bun run src/cli.ts`.
- Provider secrets are only referenced by this manual workflow job.

To run a real live smoke in GitHub Actions:

1. Configure the relevant provider secret, for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`.
2. Open **Actions → Pi Live Smoke → Run workflow** from `main`.
3. Set `run_live_pi` to `true`.
4. Optionally set both `pi_provider` and `pi_model`; leave both blank to use Pi defaults.

Do not copy this workflow to `pull_request` or `pull_request_target`. If model secrets are needed, keep the workflow manual or otherwise guarded to trusted code.
