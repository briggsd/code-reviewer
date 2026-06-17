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
- Prompt assembly lives in `src/runtime/reviewer-prompt.ts` (split out of `pi-agent-runtime.ts`,
  #155). `buildReviewerPrompt` / `buildCoordinatorPrompt` are exported for the runtime to consume
  and can be **unit-tested by importing that module directly** (the `structured-tool-output.ts`
  pattern); they are deliberately NOT in the `src/runtime` public barrel. `formatReviewerContextPrompt`
  stays module-private there — cover it end-to-end via `FakePiProcessRunner`.
- The **dummy runtime builds no text prompts** — prompt-injection coverage needs the Pi path.
- After any change to `src/schemas/review-config.ts`, run `bun run schema:config` to
  regenerate `.ai-review.schema.json` — `test/schema-artifact.test.ts` fails on drift.

## Key landmarks (the spine)

- **Lifecycle:** `src/runner/run-review.ts` → `runReview()` (the spine; `runReviewFromChange` wraps it).
- **Telemetry event:** `createRunMetricsTelemetryEvent(...)` in `src/runner/run-metrics.ts` builds the `data` record (called from `emitCompletedRunMetrics`/`emitFailedRunMetrics` in `run-review.ts`).
- **Prompts:** `buildReviewerPrompt` / `buildCoordinatorPrompt` in `src/runtime/reviewer-prompt.ts`;
  reviewer/coordinator output parsing + role/severity enforcement in
  `src/runtime/reviewer-output-validation.ts`; the JSON parse/repair leaf in `src/runtime/pi-json-repair.ts`.
- **Untrusted-content sanitizer:** `stringifyPromptData` / `sanitizePromptData` in `src/runtime/prompt-boundary.ts`.
- **Config:** type `ReviewConfig` (`src/contracts/review.ts`); load/merge `src/runner/config.ts`;
  defaults `src/runner/default-config.ts`; schema `src/schemas/review-config.ts` (+ `JsonSchema` type in `review-output.ts`).
- **Shared kind constants/sanitizers:** `src/runtime/runtime-kind.ts` (`resolveRuntimeKind`, `sanitizeJobKind`, `NON_REAL_RUNTIME_KINDS`).
- **CLI flags:** `src/cli.ts` (`readFlag`/`hasFlag` + `printHelp`); options shapes in `run-review.ts`.

## Integration recipes

**Add a `run_metrics` telemetry field** (e.g. `runtime` #48, `jobKind` #58):
1. Add the source (a CLI flag and/or `RunReviewOptions` field). 2. Resolve/sanitize it ONCE
near the top of `runReview` (mirror `resolveRuntimeKind`). 3. Pass it into **both** the
completed and failed `createRunMetricsTelemetryEvent(...)` calls (in `emitCompletedRunMetrics`/
`emitFailedRunMetrics` in `run-review.ts`); add it to that function's input type and emit into
`data` (both in `src/runner/run-metrics.ts`; conditionally `if (input.x !== undefined)` for optional fields).
4. Test via `RecordingTelemetrySink` (present when set, absent when not). **Counts/metadata
only (M008)** — never diff text, finding bodies, prompts, or secrets.

Current optional blocks in `run_metrics.data`: `grounding` (dropped count), `locationBackfill`
(backfilled count), `acknowledgements` (ack/suppressed counts), `thinReview` (#91 — emitted
only when flagged; `{ flagged: true, outputTokens, expectedFloor }`). Corresponding trace
marker: `review.thin_detected` (emitted only when flagged).

The thin-review **contextual floor** (`src/runner/thin-review.ts`):
`expectedFloor = trivial→0 (never flagged), lite→60×reviewedFileCount, full→300+60×reviewedFileCount`;
a run is thin when total output tokens are below it. `telemetry:analyze` uses this same floor
by default (it reads `reviewedFileCount` off each event), so spine and analyze agree. This
signal is **informational-only** — it never affects the run decision, outcome, or CI status.
Two overrides: `--thin-floor N` forces a flat floor for all **non-trivial** events (trivial-tier
runs are always exempt); and **legacy** events predating #91 (no `reviewedFileCount`) fall back
to the old flat 250-token floor, so historical analyze output stays comparable across the #91
boundary rather than silently dropping to a 0-floor on the lite tier.

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

## Adopter recipe: author a custom reviewer & load it **without forking** (M017)

This is the operator-extension seam (S03 #143). An adopter — acting as the **trusted operator
in their own CI** — registers extra reviewer definitions by an explicit `--reviewers <path>`
they control. The factory core is never forked; on upgrade you keep the factory's built-in
reviewers and your custom ones merge on top. The reviewed repo can never inject a reviewer:
the path is operator-supplied and resolved in the trusted CI, never discovered from the
reviewed repo (same lockout shape as the Pi `--extension`; see `../user/fork-safety.md` →
"Operator reviewer extensions" and `operator-extension-seam.md` for the full design).

**1. Author the module** against the public API. The package root export
(`ai-code-review-factory`, mapped to `src/public.ts`) exposes `defineReviewer`
(alias `createReviewerDefinition`) and the `DefineReviewerInput` / `ReviewerDefinition` /
`Severity` types. `defineReviewer` validates the input and injects the trusted shared
mandatory rules (anti-prompt-injection plus cross-cutting soundness constraints — e.g. the
false-absence rule) and `source: "trusted_operator"` for you — you supply only the
judgment-shaping fields:

```ts
// my-reviewers.ts
import { defineReviewer } from "ai-code-review-factory";

export default [   // or: `export const reviewers = [ … ]` — both names are accepted
  defineReviewer({
    role: "accessibility",              // any non-empty role except the reserved "coordinator"
    displayName: "Accessibility",
    version: "accessibility.v1",
    summary: "Flags a11y regressions in UI changes.",
    flag: ["Missing alt text, unlabeled controls, color-only signals."],
    doNotFlag: ["Pure backend changes.", "Style nits."],
    allowedSeverities: ["warning", "suggestion"],   // subset of critical|warning|suggestion
    severityCalibration: ["warning: a concrete barrier for assistive tech."],
    outputExpectations: ["Cite the element and the WCAG criterion."],
  }),
];
```

The module must export (as `default` or a named `reviewers`) **either** an array of
`ReviewerDefinition` **or** `{ definitions, replace? }`. With `replace: true` the operator set
fully supplants the factory's trusted set; the default merges by role (see step 3). The
full-replace object form (note: the key is `definitions`, and `replace` sits beside it):

```ts
// full-replace: discard the factory's built-in reviewers, run only these
export default {
  definitions: [defineReviewer({ /* … */ })],
  replace: true,
};
```

**2. Load it in your CI** — applies to every `run` form:

```bash
ai-code-review run --reviewers ./my-reviewers.ts   # + your usual flags
```

**3. Merge semantics** (`mergeReviewerDefinitions`, operator-wins by role): a new role
**appends** (extend); a role colliding with a built-in **replaces** that built-in (swap);
`{ definitions, replace: true }` discards the trusted set entirely. The reserved `coordinator`
role is rejected, and duplicate roles within your module are an error. A custom reviewer is
trusted-operator tier for *prompting*, but its **output is still model-authored and untrusted**
— re-validated through `validateFinding` and pinned to its dispatched role by
`enforceReviewerRole`, exactly like the built-ins (it cannot self-label findings as another role).

Test landmarks: `loadOperatorReviewerDefinitions` / `mergeReviewerDefinitions`
(`src/runner/operator-reviewers.ts`, `src/runner/reviewer-definitions.ts`), covered in
`test/operator-reviewers.test.ts`; the public surface is locked by `test/public-api.test.ts`.

## Adding a VCS adapter

The Bitbucket Cloud adapter (M033, `src/vcs/bitbucket/bitbucket-vcs-adapter.ts`) is the worked reference for this recipe.

**1. Implement `VcsAdapter`** (`src/contracts/adapters.ts`). The interface has four required methods and five optional ones:

- Required: `getChange`, `getDiff`, `getPriorReviewState`, `publishSummary`
- Optional: `publishInlineFindings`, `readBaseBranchFile`, `readChangeFileAtHead`, `detectBreakGlassOverride`, `getChangedPathsSince`

Start with the required four (metadata fetch, diff fetch, prior-state read, summary publish), then add optional methods as needed. The M033 slices grouped these as read/publish/trust to keep PRs reviewable.

**2. Reuse shared building blocks** — do not reinvent:

- **Unified diff parsing:** `parseUnifiedDiff` from `src/shared/unified-diff.ts`. It lives in `src/shared/` (not `src/vcs/shared/`) because `src/runner` also calls it via `context-artifacts.ts`; any diff parser shared with the runner must live there, not in `src/vcs/shared/`.
- **HTTP client:** `HttpJsonClient` (and `HttpRequestError`) from `src/vcs/shared/http-json-client.ts`. Use `requestAllPagesCursor` for cursor-based pagination (Bitbucket uses `next` links) and `requestAllPages` for offset/Link-header pagination (GitHub/GitLab).
- **Summary metadata:** `parseSummaryHiddenMetadata` and `createPriorReviewStateFromMetadata` from `src/publisher/summary-metadata.ts`. Parse the hidden `<!-- ai-code-review-factory -->` block from the existing PR/MR comment to reconstruct prior review state.
- **Summary and inline formatters:** `formatReviewSummaryMarkdown` from `src/publisher/summary-markdown.ts` and `formatInlineFindingComment` / `inlineCommentKey` / `parseInlineCommentMetadata` from `src/publisher/inline-comment-markdown.ts`.
- **Break-glass detection:** `src/vcs/break-glass-marker.ts` — `breakGlassMatchesHead`, `mapBitbucketPermission` (or the GitHub/GitLab equivalents), and the provider-specific `TRUSTED_PERMISSIONS` set.

**3. Widen `ProviderKind`** in `src/contracts/common.ts`. Add the new literal to the union. That type is the single source of truth for valid provider values across the CLI, adapters, telemetry, and CI output.

**4. Wire the CLI** in `src/cli.ts`:

- Add the new provider string to the `--provider` validation block.
- Instantiate the adapter in the provider switch (alongside the GitHub/GitLab cases).
- Add `readProviderToken` handling for the new `AI_REVIEW_<PROVIDER>_TOKEN` env var.
- Add the publish guard if the provider requires one (e.g. the Bitbucket token doubles as read+write; the guard logic lives near the `--publish-summary` check).

**5. Add a CI template** at `examples/ci/<provider>-pipelines.yml` (or equivalent filename). Mirror the two-step dry-run/publish fork-safety design. Document the provider's fork isolation mechanism — Bitbucket uses secured variables withheld from fork-PR pipelines; GitHub uses a job-level `if:` guard; GitLab uses `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID`. Use a mutable image tag (e.g. `oven/bun:1.3`) per the adoption-template convention; `test/ci-templates.test.ts` locks this.

**6. Add `test/ci-templates.test.ts` coverage** for the new template. Assert at minimum: the PR/MR trigger, `--provider <name>`, `--publish-summary`, `--runtime dummy`, `--ci-exit`, the provider token variable, the provider env vars wired to CLI flags, the mutable image tag, and the absence of `bun run src/cli.ts`. Assert a stable fork-safety substring from the comment block.

**7. Architecture boundary constraint.** A VCS adapter (`src/vcs/<provider>/`) must not import another VCS adapter or anything from `src/runner/`. Shared helpers that both an adapter and the runner need belong in `src/shared/` (not `src/vcs/shared/`), because `src/runner` cannot import `src/vcs/**` (enforced by `bun run boundaries`). Parser/helper code that only adapters share can live in `src/vcs/shared/`. Run `bun run boundaries` after wiring and fix any violation before opening a PR.

## Trust quick-reference

- Trusted: factory-owned reviewer-definitions. Untrusted: everything from the reviewed repo
  (config incl. `.ai-review.json`, titles/descriptions/comments, diff, repo files).
- Telemetry/rollups: counts/identifiers only (M008). Trace artifacts can leak operator
  prompts — see `RedactingTraceSink` (#57).
- CI status is the canonical merge gate; comments/reviews are UX.
