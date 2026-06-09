# Pi live smoke test

The normal test suite never calls Pi, a model provider, or the network. It uses fake process runners for the Pi adapter.

Use the live smoke test only when you intentionally want to verify the local `pi` CLI, provider credentials, JSON-mode adapter, trace writing, and structured output prompts end-to-end.

## Run

```bash
# Safe default: exits 0 without calling Pi/model.
bun run smoke:pi

# Opt in to a real Pi/model run using Pi's configured default model.
AI_REVIEW_LIVE_PI=1 bun run smoke:pi

# Or force a provider/model for this smoke run.
AI_REVIEW_LIVE_PI=1 \
AI_REVIEW_PI_PROVIDER=anthropic \
AI_REVIEW_PI_MODEL=claude-sonnet-4-5 \
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
<output>/runs/<runId>/summary.json
```

## What it exercises

- `PiAgentRuntime`
- `BunPiProcessRunner`
- `pi --mode json`
- default CI-hardening flags: `--no-session --no-approve --no-extensions --no-skills --no-prompt-templates --no-context-files`
- read-only runtime tool policy
- reviewer structured output parsing
- coordinator summary parsing/fallback
- streaming JSONL event forwarding into the trace sink
- JSONL trace and filesystem state artifacts

The smoke fixture disables documentation and performance reviewers to keep the run small while still exercising multiple reviewer subprocesses plus the coordinator.
