# Extending & testing — integration recipes + test-infra index

A fast-start map for adding to this codebase (for humans, agents, and delegated subagents).
CLAUDE.md is the high-level map; this is the **how-to-extend-and-test** level. Keep entries
short and current; verify file:line against the code before relying on them.

## Test-infra index (the failure locus — name these in any spec)

Tests live in `test/` (bun:test), fixtures in `examples/fixtures/`. Default suite is
fake/no-network. Gate: `bun run check` (`bunx tsc --noEmit && bun test`).

| To assert on… | Use | Where |
|---|---|---|
| **Reviewer/coordinator prompt text** | `FakePiProcessRunner` → `runner.calls[].prompt` / `.role`; wrap in `PiAgentRuntime({ processRunner })` + `runReview` | `test/pi-runtime.test.ts` |
| **Emitted telemetry events** (`run_metrics`) | `RecordingTelemetrySink` → `.events[].data`; `runReview({ telemetrySink })` | `test/state.test.ts` |
| **Emitted trace events** (`RuntimeEvent`s) | `RecordingTraceSink` → `.events[]`; `runReview({ traceSink })` | `test/state.test.ts` |
| **Config load/normalize** | `normalizeReviewConfig(override, base?, source?)` directly | `src/runner/config.ts` |
| **A whole review run** | `loadReviewFixture("examples/fixtures/auth-pr.json")`; set `fixture.config` for per-run config; `runReview({ fixture, runtime, … })` | `src/index.ts` |
| **A forced failure path** | a runtime that throws (see `FailingRuntime`) | `test/state.test.ts` |

Gotchas:
- `buildReviewerPrompt` / `buildCoordinatorPrompt` / `formatReviewerContextPrompt` are
  **module-private** in `pi-agent-runtime.ts` — assert end-to-end via `FakePiProcessRunner`,
  don't export them.
- The **dummy runtime builds no text prompts** — prompt-injection coverage needs the Pi path.
- After any change to `src/schemas/review-config.ts`, run `bun run schema:config` to
  regenerate `.ai-review.schema.json` — `test/schema-artifact.test.ts` fails on drift.

## Key landmarks (the spine)

- **Lifecycle:** `src/runner/run-review.ts` → `runReview()` (the spine; `runReviewFromChange` wraps it).
- **Telemetry event:** `createRunMetricsTelemetryEvent(...)` in `run-review.ts` builds the `data` record.
- **Prompts:** `buildReviewerPrompt` / `buildCoordinatorPrompt` in `src/runtime/pi-agent-runtime.ts`.
- **Untrusted-content sanitizer:** `stringifyPromptData` / `sanitizePromptData` in `src/runtime/prompt-boundary.ts`.
- **Config:** type `ReviewConfig` (`src/contracts/review.ts`); load/merge `src/runner/config.ts`;
  defaults `src/runner/default-config.ts`; schema `src/schemas/review-config.ts` (+ `JsonSchema` type in `review-output.ts`).
- **Shared kind constants/sanitizers:** `src/runtime/runtime-kind.ts` (`resolveRuntimeKind`, `sanitizeJobKind`, `NON_REAL_RUNTIME_KINDS`).
- **CLI flags:** `src/cli.ts` (`readFlag`/`hasFlag` + `printHelp`); options shapes in `run-review.ts`.

## Integration recipes

**Add a `run_metrics` telemetry field** (e.g. `runtime` #48, `jobKind` #58):
1. Add the source (a CLI flag and/or `RunReviewOptions` field). 2. Resolve/sanitize it ONCE
near the top of `runReview` (mirror `resolveRuntimeKind`). 3. Pass it into **both** the
completed and failed `createRunMetricsTelemetryEvent(...)` calls; add it to that function's
input type; emit into `data` (conditionally `if (input.x !== undefined)` for optional fields).
4. Test via `RecordingTelemetrySink` (present when set, absent when not). **Counts/metadata
only (M008)** — never diff text, finding bodies, prompts, or secrets.

**Add a config field** (e.g. `conventions` #60):
`ReviewConfig` (contracts) → normalize + **bound** it in `normalizeReviewConfig` → default in
`createDefaultReviewConfig` → add property to `reviewConfigSchema` (it's
`additionalProperties: false`, so this is mandatory) → `bun run schema:config` → test normalize.

**Add a CLI flag** (e.g. `--job-kind` #58, `--redact-trace` #57):
Parse in `src/cli.ts` (`readFlag`/`hasFlag`) → thread into `runReview`/`runReviewFromChange`
options (conditional spread) → update `printHelp` for all three `run` forms.

**Inject text into reviewer/coordinator prompts** (e.g. `conventions` #60):
Render in `buildReviewerPrompt` / `buildCoordinatorPrompt`. **Anything from the reviewed repo
(config, PR metadata, diff) is untrusted (principle #6)** → route it through
`stringifyPromptData` as inert data under a fixed trusted label; NEVER concatenate it into the
trusted instruction lines. Reviewer-definitions (`reviewer-definitions.ts`) are the only
trusted prompt source.

## Trust quick-reference

- Trusted: factory-owned reviewer-definitions. Untrusted: everything from the reviewed repo
  (config incl. `.ai-review.json`, titles/descriptions/comments, diff, repo files).
- Telemetry/rollups: counts/identifiers only (M008). Trace artifacts can leak operator
  prompts — see `RedactingTraceSink` (#57).
- CI status is the canonical merge gate; comments/reviews are UX.
