# Agent Runtime Comparison: OpenCode vs Pi

## Reader and post-read action

**Reader:** an engineer choosing the first agent runtime adapter for Code Reviewer.

**After reading, they should be able to:** decide whether the MVP should start with an OpenCode adapter, a Pi adapter, or a runtime-neutral interface with both implementations behind it.

## Executive recommendation

Build the review factory around a runtime-neutral `AgentRuntime` interface. Do **not** couple the architecture directly to either OpenCode or Pi.

For the first implementation, there are two reasonable paths:

1. **Cloudflare-parity path:** start with OpenCode because the source architecture is already proven on OpenCode, and OpenCode has first-class concepts for server-backed sessions, agents, SDK control, and plugins.
2. **Pi-native path:** start with Pi because this project is being designed inside a Pi-heavy workflow, Pi has a typed SDK, RPC mode, JSON event streams, dynamic tools, extension hooks, provider registration, sandbox/permission examples, and enough surface to reproduce the architecture without forking Pi internals.

My recommendation for this repo: **implement the runtime boundary first, then make Pi the first local adapter unless we discover an OpenCode-specific feature we cannot cheaply reproduce.** Pi gives us more direct control in a Node/TypeScript codebase, and the architecture already needs custom orchestration, CI/VCS adapters, safety modes, and telemetry regardless of runtime.

## What Cloudflare used OpenCode for

From Cloudflare’s writeup, OpenCode provided these load-bearing capabilities:

- A coding-agent runtime that Cloudflare already used internally.
- Open source implementation they could inspect and patch upstream.
- SDK/server-first architecture for programmatic sessions.
- Ability to spawn a coordinator process and sub-reviewer sessions.
- JSONL output from the coordinator process.
- Config generated into an `opencode.json` file.
- Agents with distinct prompts, models, and tool access.
- A runtime plugin exposing `spawn_reviewers` to the coordinator.

The key point: Cloudflare’s value did not come from OpenCode alone. It came from the custom factory around it: plugin assembly, risk tiers, context files, reviewer prompts, coordinator judgment, circuit breakers, model routing, telemetry, and re-review state.

## What Pi offers for the same role

Pi is a minimal terminal coding harness designed to be extended rather than forked. Relevant capabilities:

- **Programmatic SDK:** `createAgentSession()` and `createAgentSessionRuntime()` can embed Pi in a Node/TypeScript application.
- **Headless subprocess integration:** `pi --mode rpc` provides a JSONL RPC protocol over stdin/stdout; `pi --mode json` emits session events as JSON lines.
- **Extensions:** TypeScript modules can register tools, commands, event hooks, providers, UI, and tool guards.
- **Custom tools:** tools can be passed through the SDK or registered by extensions with schemas, progress updates, custom rendering, and error signaling.
- **Event stream:** Pi emits lifecycle, message, tool execution, compaction, retry, and extension error events.
- **Provider flexibility:** built-in provider list includes Anthropic, OpenAI, Google, Cloudflare AI Gateway, Cloudflare Workers AI, OpenRouter, Kimi, and others; extensions can register providers dynamically.
- **Tool control:** sessions can run with selected tools, no tools, no built-ins, or custom tools only.
- **Security extension points:** tool calls can be blocked or mutated, built-in tools can be overridden, and example extensions demonstrate permission gates, protected paths, SSH/remote execution, sandboxed bash, and subagents.
- **Session persistence:** sessions are JSONL files with tree structure; SDK can also use in-memory sessions for short-lived review runs.

Pi deliberately does **not** ship subagents, plan mode, or permission popups as core features. The design stance is to build those via extensions or SDK integration. For this project, that is acceptable because the review factory already needs custom orchestration and policy.

## Capability comparison

| Dimension | OpenCode | Pi | Implication for review factory |
|---|---|---|---|
| Production precedent | Cloudflare used it for the source system | No evidence from this capture of equivalent production review deployment | OpenCode has direct precedent; Pi must be validated by prototype |
| Programmatic control | Type-safe JS/TS SDK for OpenCode server | TypeScript SDK plus RPC and JSON modes | Both satisfy the core requirement |
| Agent/session model | Primary agents and subagents are first-class concepts | Agent sessions are first-class; subagents are built via SDK/extension/subprocess patterns | OpenCode may require less adapter code for sub-reviewers; Pi gives more explicit control |
| Config model | `opencode.json`, agents/plugins/config hierarchy | settings, context files, extensions, skills, prompts, SDK resource loader | Both can support generated per-run config |
| Plugin/extension system | Plugins hook OpenCode events and can interact with SDK client | Extensions register tools, commands, providers, and event hooks; can override tools | Both support custom runtime behavior |
| JSONL/event stream | Cloudflare used OpenCode JSONL output | Pi JSON mode and RPC mode emit JSONL events | Both fit our trace architecture |
| Tool gating | OpenCode has permission APIs and agent tool restrictions | Pi can set active tools, override tools, block tool calls, sandbox bash | Both viable; Pi gating likely lives in our adapter/extension code |
| Provider/model routing | OpenCode config and provider support | Built-in many providers plus `registerProvider`; model can be changed via SDK/RPC | Both viable; factory should own model routing above runtime |
| Structured output | OpenCode SDK supports structured output tool/schema patterns | Pi can define a final structured-output custom tool with `terminate: true` | Both viable |
| Sandboxing | Not evaluated here beyond OpenCode permissions | Pi examples include sandboxed bash and remote tool operations | Pi has clear extension examples for local sandbox control |
| CI friendliness | Proven by Cloudflare via child process + plugin | Pi supports print/json/RPC modes and SDK embedding | Both viable |
| Local interactive usage | Terminal, desktop, IDE extension | Terminal TUI; local commands/extensions | Both can support local `/fullreview`-style mode |
| Philosophy | More built-in agent concepts | Minimal core, build features as extensions | OpenCode may be faster for Cloudflare-shaped replication; Pi may be better for custom harness sovereignty |

## Architecture mapping

### OpenCode adapter shape

The OpenCode adapter would mirror Cloudflare closely:

```text
Review runner
  → generate opencode config
  → start coordinator session/process
  → coordinator calls spawn_reviewers plugin tool
  → plugin starts OpenCode reviewer sessions via SDK
  → stream JSONL events
  → collect structured reviewer outputs
  → coordinator returns final decision
```

Benefits:

- Closest to the source architecture.
- Agent and plugin concepts align directly with Cloudflare’s implementation.
- Lower uncertainty if reproducing the Cloudflare pattern is the primary objective.

Costs/risks:

- The rest of our architecture still needs custom VCS, CI, state, security, and telemetry code.
- We inherit OpenCode config/plugin conventions as a first-class dependency.
- If our own workflows are Pi-centered, we may duplicate harness customization already available in Pi.

### Pi adapter shape

The Pi adapter can be implemented in one of two ways.

**SDK-first adapter:**

```text
Review runner
  → create coordinator AgentSession with custom tools
  → coordinator calls spawn_reviewers custom tool
  → spawn_reviewers creates reviewer AgentSessions in memory or via runtime
  → subscribe to session events for JSONL trace
  → collect structured-output tool calls from reviewers
  → coordinator produces final decision
```

**Subprocess adapter:**

```text
Review runner
  → spawn `pi --mode json -p --no-session` for each reviewer
  → pass reviewer prompt/config through flags/files
  → parse JSONL events
  → collect final assistant output or structured-output tool result
  → coordinator runs as another Pi session/process
```

Benefits:

- Strong TypeScript SDK for direct embedding.
- Easy to add custom tools for `spawn_reviewers`, structured output, VCS lookups, trace writing, and policy checks.
- Existing extension hooks can implement permissions, sandboxing, provider routing, and tool restrictions.
- RPC mode gives process isolation if same-process SDK coupling becomes risky.

Costs/risks:

- Subagent orchestration is not built into Pi core; we must own it.
- We need to define structured output and reviewer lifecycle ourselves.
- We need to validate that Pi event streams expose all cost/cache/model usage we need for telemetry in our target providers.
- Pi’s project trust/context-file behavior must be carefully controlled in CI so untrusted repo files do not silently become privileged instructions.

## Required `AgentRuntime` interface

The runtime boundary should hide OpenCode/Pi differences.

```typescript
interface AgentRuntime {
  runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult>;
  runReviewer(input: ReviewerRunInput): Promise<ReviewerRunResult>;
  streamEvents(runId: string, onEvent: (event: RuntimeEvent) => void): void;
  cancel(runId: string): Promise<void>;
}
```

The concrete adapter must support:

- role-specific system prompts,
- selected model/provider,
- selected tool set,
- working directory / context directory,
- timeout and cancellation,
- JSONL event emission,
- structured final output,
- token/cost usage extraction where available,
- raw trace persistence.

Do not leak OpenCode `session` objects or Pi `AgentSession` objects above this interface.

## Security comparison

Both runtimes can be safe or unsafe depending on how we invoke them. The factory’s security boundary must sit above the runtime.

Rules that apply to both:

- Do not execute untrusted fork code in privileged CI.
- Keep provider secrets out of untrusted jobs.
- Treat PR/MR text, comments, diffs, and repo files as untrusted prompt content.
- Sanitize prompt boundary markers.
- Restrict tools by safety mode.
- Prefer read-only tools for untrusted mode.
- Use CI status as the deterministic gate.

Pi-specific caution: Pi loads `AGENTS.md`/`CLAUDE.md`, project settings, and project extensions only for trusted projects in normal operation. In CI, the adapter should explicitly control resource loading and avoid trusting project-local extensions from the reviewed repository unless the repository is trusted and same-org.

OpenCode-specific caution: OpenCode project config, agents, plugins, and tools can be loaded from project directories/config. The adapter should similarly control which config is accepted from reviewed code versus central trusted config.

## Recommendation by phase

### Phase 1 MVP

Use the runtime-neutral interface and implement **one** adapter.

Preferred first adapter for this workspace: **Pi SDK adapter**.

Why:

- We can keep implementation in TypeScript.
- We can run coordinator/reviewers as in-memory or short-lived Pi sessions.
- We can define custom structured-output and `spawn_reviewers` tools directly.
- We can use selected tool sets and extension hooks for safety.
- We already have local Pi docs/examples and operational familiarity.

### Phase 1 acceptance criteria for Pi adapter

Before committing to Pi long-term, the prototype must prove:

- Coordinator can spawn at least two reviewers concurrently.
- Reviewers can run with distinct prompts, models, and tool sets.
- Reviewer outputs can be forced into validated JSON.
- JSONL traces include enough lifecycle and usage data.
- Timeouts and cancellation work reliably.
- Untrusted mode can disable bash/write/edit and ignore project-local extensions/settings.
- Cost/token usage can be extracted or estimated.

### Phase 2 comparison spike

Build a thin OpenCode adapter only if one of these happens:

- Pi adapter cannot produce reliable structured outputs.
- Pi adapter lacks required usage/cost telemetry.
- Pi concurrent session behavior is too heavy or unstable.
- OpenCode’s native agent/subagent/session model materially reduces complexity.
- We want close compatibility with Cloudflare’s exact implementation style.

## Decision record

Current decision: **runtime-neutral architecture, Pi-first prototype.**

Status: provisional. Revisit after the Phase 1 Pi adapter spike.

## Sources

- Cloudflare source article: https://blog.cloudflare.com/ai-code-review/
- OpenCode docs reviewed: SDK, agents, config, plugins.
- Pi docs reviewed: README, SDK, extensions, RPC mode, JSON mode, subagent and sandbox examples.
