# Project configuration

The runner loads JSON config from an explicit `--config <path>` first. If no path is provided, it looks for `.ai-review.json` or `ai-review.json` in the current working directory.

Config files are partial overrides over the built-in defaults, but **the merge depth differs by field type**:

- **Object maps are merged** with the defaults key-by-key: `reviewerPolicy`, `timeouts`, and `modelRouting`. You can set just one key and the rest of the object keeps its default. **Exception:** `modelRouting.byTier` is replaced **wholesale** when an override supplies it (not deep-merged per tier) — so in a layered setup (org-level base + project override), a project `byTier` shadows the base's `byTier` entirely rather than merging into it. `modelRouting.default`/`roles` still merge key-by-key as above.
- **Arrays are replaced wholesale**, not merged: `failOn`, `sensitivePaths`, `ignoredPaths`, and `generatedFileMarkers`. If you specify one of these, your array becomes the *entire* value — the built-in defaults for that field are dropped.

> **Footgun — re-list the defaults you still want.** Because `sensitivePaths` replaces rather than appends, a config that sets `sensitivePaths` to only its own project paths **silently drops the built-in `auth/**`, `crypto/**`, `migrations/**`, `.github/workflows/**`, and `.gitlab-ci.yml`** escalations. Security- and pipeline-sensitive changes would then tier as `lite` with no warning. To *add* paths, copy the defaults into your array and append yours (see the example below, which re-lists every default before adding project paths). The same applies to `ignoredPaths`, `failOn`, and `generatedFileMarkers` (overriding it without re-listing `// @generated` silently drops that default). The built-in defaults are printed by `bun run src/cli.ts schemas` and live in `src/runner/default-config.ts`.

Print the machine-readable schemas with:

```bash
bun run src/cli.ts schemas
```

The returned `config` schema describes `.ai-review.json`. A checked-in copy is available at `.ai-review.schema.json` for editor/tool integrations. Regenerate it with:

```bash
bun run schema:config
```

## Example

```json
{
  "mode": "blocking",
  "failOn": ["critical", "warning"],
  "sensitivePaths": [
    "auth/**",
    "crypto/**",
    "migrations/**",
    ".github/workflows/**",
    ".gitlab-ci.yml",
    "src/billing/**"
  ],
  "ignoredPaths": [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.min.js"
  ],
  "reviewerPolicy": {
    "code_quality": "enabled",
    "security": "enabled",
    "documentation": "enabled",
    "performance": "full_only"
  },
  "timeouts": {
    "reviewerMs": 480000,
    "coordinatorMs": 240000,
    "overallMs": 900000
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

### Enabling the opt-in reviewers

`release`, `compliance`, and `comprehension` are all off by default. To turn them on, set their
`reviewerPolicy` keys and (for compliance) supply the policy text the reviewer checks against.
`comprehension` is best set to `full_only` to bound cost (it then runs only on full-tier diffs;
it is excluded on trivial diffs by the roster cap regardless):

```json
{
  "reviewerPolicy": {
    "release": "enabled",
    "compliance": "enabled",
    "comprehension": "full_only"
  },
  "compliancePolicy": [
    "All network egress must route through the telemetry transport boundary.",
    "No new runtime dependency without an ADR."
  ]
}
```

Note the two fields resolve from different sources, which matters on the PR that first adds them:
`reviewerPolicy` is read from the running config (head-inclusive in CI), so the compliance reviewer
becomes **active immediately on the enabling PR** — but `compliancePolicy` is read from the base
branch (see the field note below), which still lacks it until merge, so on that first PR the reviewer
runs **inert** (zero findings). It only checks real rules once both are on the protected branch.
Unlike `compliance`, `release` has **no inert period** — it runs and can emit `critical` the moment
you enable it, including on the enabling PR itself. On a repo with rollout-risky diffs already in
flight, that can fail the enabling PR's gate immediately in blocking mode. Enable it in advisory mode
first (`mode: "advisory"`, or temporarily `failOn: []`) to audit existing findings, then switch to
blocking. Review your `failOn` (default `["critical"]`) before enabling any of these opt-in roles (`release`, `compliance`, `comprehension`) in blocking mode — each can emit `critical`.

(The base-branch timing above is the **GitHub provider** path. On the local runner / `--git-diff`
path there is no PR head and `resolveBaseConfig` is not called, so `compliancePolicy` is read straight
from your local config — which is exactly how you can test policy rules locally before merging them.)

## Fields

- `mode`: `advisory` or `blocking`.
  - **Reviewer-failure (degraded) policy (#212):** these are two *separate* behaviors with different thresholds.
    - **Banner — any failure.** When **one or more** reviewers fail in an otherwise *completing* run (e.g. timeouts or invalid output, after failback is exhausted), the published summary is marked with a `⚠️ Degraded review — N of M reviewers failed` banner naming the failed roles — so the surviving findings are never mistaken for a clean full review. This fires for a **minority** failure too (banner shown, CI outcome unchanged).
    - **CI escalation — strict majority only.** When a **strict majority** of the attempted reviewers fail *and* the run would otherwise **pass**, the outcome is escalated like `review_failed`: in **blocking** mode it becomes `fail` (fail-closed); in **advisory** mode it becomes `neutral` (fail-open, **exit code stays 0** — only the `outcome` field changes from `pass` to `neutral`). This is **escalation-only**: a real blocking finding from a surviving reviewer still fails regardless, and a minority of failed reviewers never changes the outcome.

    The per-run reviewer-failure rate (any failure) is tracked as the `reviewerFailureRate` quality metric (see `docs/review-quality-loop.md`).
- `failOn`: finding severities that fail CI in blocking mode. Default: `["critical"]` (the built-in defaults are printed by `bun run src/cli.ts schemas` and live in `src/runner/default-config.ts`).
- `sensitivePaths`: glob-like path patterns that escalate risk.
- `ignoredPaths`: glob-like path patterns filtered out before review.
- `generatedFileMarkers`: content markers (default just `// @generated`) that flag a generated file by its **patch head** (first 4 KB, case-insensitive, **added lines only**), in addition to path globs. Applied **after** the `sensitivePaths` short-circuit, so a marked migration/auth file is still reviewed. A hit counts as a `generated` ignore. **Replaced wholesale** on override; set to `[]` to disable content-marker detection entirely. `/* eslint-disable */` is **not** a default (it is routine atop hand-written/legacy files, so it is a low-precision generated signal and an easy review-bypass lever) — add it explicitly if your generators emit it. Only added inline patch text is scanned, so a marker on a deleted/context line, outside the diff hunks, or in an offloaded large-diff patch is not detected (a file is dropped only when a marker is actually added).
  - **Trust note:** because markers are matched on PR-author-authored diff text, an author can in principle add a marker to suppress review of a file — the same author-influenceable surface as naming a file to match an `ignoredPaths` glob. `sensitivePaths` (which short-circuits before marker detection) is the protection for security-critical files, and every dropped file is recorded by path in the `context.built` trace, so a suppression is auditable rather than silent.
- `reviewerPolicy`: role name to `enabled`, `disabled`, or `full_only`. Shipped role keys: `code_quality`, `security`, `documentation`, `performance`, and the three opt-in roles `release`, `compliance`, and `comprehension` (all default `disabled` — see below). A key that is not a shipped role is ignored (traced `no_trusted_reviewer_definition`), so a typo like `change_management` silently does nothing. The risk tier additionally caps the reviewer roster: trivial tier restricts to `code_quality` only, regardless of which roles are `enabled` in config. `reviewerPolicy` cannot re-enable a role excluded by the tier cap, and the cap cannot re-enable a role set to `disabled` in config. Lite and full tiers are uncapped. **Footgun:** disabling `code_quality` leaves trivial-tier runs with no reviewers at all — the run returns a deterministic `approved` summary without any model call (recorded as `coordinatorShortCircuited` with zero reviewer results).
  - `release` (Release / change management, opt-in): flags deployment/rollout/migration and production-safety risks. Along with `security` and `compliance`, **it can emit `critical`** — operators running blocking mode with the default `failOn: ["critical"]` should expect rollout risks to fail the gate once they enable it.
  - `compliance` (Compliance / policy, opt-in): checks the diff against `compliancePolicy` (below). It **can also emit `critical`** (for high-confidence policy violations governing security/privacy/regulatory/production-safety obligations), so enabling it in blocking mode with the default `failOn: ["critical"]` will gate on those. It is **inert without `compliancePolicy` text** — enabling the role but supplying no policy produces no findings.
  - `comprehension` (Comprehension gate, opt-in): a pre-review readiness check — a reviewer that works through a fixed 6-question rubric (dependency choices, failure modes, security implications, separation of concerns, downstream breakage, comprehensibility) and flags **unresolved comprehension gaps** ("dark code" a senior engineer couldn't explain without running it). It runs as a specialist in the normal fan-out, so it is excluded on `trivial` by the roster cap (`full_only` is the recommended setting to bound cost). Its findings produce a deterministic **gate verdict** `summary.gateDecision`: `allow` (no gaps), `warn` (suggestions only), `block` (any warning/critical) — rendered as a one-line `🚦 Comprehension gate` note and stored in the hidden metadata. The verdict reflects the findings that still count after acknowledgements, so it never contradicts a passing CI on an acknowledged gap. The verdict is observability only; **CI pass/fail stays governed by `mode`/`failOn` over the findings** (advisory by default, blocking opt-in — no separate gate switch). Like `release` and `compliance`, **it can emit `critical`** — running blocking mode with the default `failOn: ["critical"]` will fail the gate on a trust-boundary or production-safety comprehension gap once you enable it.
- `conventions`: array of prose strings telling the reviewer about this repo's expected exceptions
  (e.g. "scripts/* are maintainer-run tools; don't apply an untrusted-input threat model"). Rendered
  as inert, sanitized untrusted data in the reviewer/coordinator prompts (never as instructions).
  **In the GitHub provider path these are read from the base/target branch, not the PR head** (a PR
  cannot grant itself an exception); see `docs/reviewer-conventions.md`. Bounded: ≤50 entries, ≤500
  chars each.
- `compliancePolicy`: array of prose rules the **compliance reviewer** checks the diff against (e.g.
  "All network egress must route through the telemetry transport boundary"; "No new runtime
  dependency without an ADR"). Only consumed when `reviewerPolicy.compliance` is `enabled`/`full_only` (the reviewer is
  opt-in, default `disabled`). The policy text is **reviewed-repo content → untrusted, data-only**:
  read from the **base branch in the GitHub provider path**, quoted as inert sanitized data exclusively
  in the compliance reviewer's prompt, and never treated as instructions or trusted runtime config.
  Unlike `conventions` — which are advisory and fall back to local/head config when a *VCS adapter*
  can't read the base branch — `compliancePolicy` is authority-like (it defines what counts as a
  violation), so in the provider path it is **never carried from the PR head**: a VCS adapter without
  base-branch reads resolves it to empty and the compliance reviewer is simply inert until base reads
  land for that adapter. (This base-vs-head trust gate applies only to the provider path; the local
  runner / `--git-diff` path has no PR head and reads `compliancePolicy` directly from your local
  config — the way to test policy rules before merging.) The reviewer flags only evidenced
  violations and never invents rules absent from this text. **Trust assumption:** base-branch write
  access is operator-trusted — `stringifyPromptData` makes the policy text *structurally* inert
  (fences, nesting, control bytes), but a semantically directive entry ("flag everything as critical")
  is only countered by the prompt framing and the reviewer's `doNotFlag` rule, the same instruction-
  layer control (and same limitation) as `conventions`; it is not a hard parse-level filter. Bounded: ≤50
  entries, ≤500 chars each.
- `acknowledgements`: array of structured records accepting a *specific* known finding. Each is
  `{ "path": "<glob>", "category"?: "<cat>", "stableFindingId"?: "fnd_…", "mode": "acknowledge" |
  "suppress", "reason": "<why>", "expires"?: "YYYY-MM-DD" }`. A matching finding (by path glob +
  optional category/stableFindingId) is, for `acknowledge`, **kept and annotated but excluded from
  the CI gate** (surfaced, not hidden); for `suppress`, **removed** — except a security-reviewer
  finding, which is downgraded to `acknowledge` (never silently hidden). An `expires` date in the
  past makes the entry inactive. Like `conventions`, these are read from the **base branch** in the
  provider path. Bounded: ≤100 entries.
  > **⚠️ Upgrading:** earlier releases declared `acknowledgements` but ignored it. After upgrading,
  > acknowledgements on your **base branch** become active and will change which findings reach the
  > gate. Review any pre-configured entries before upgrading. (`reason` is now required.)
- `timeouts`: reviewer/coordinator/overall budgets in milliseconds.
  - Reviewer agents run in parallel; the coordinator runs after all reviewers complete.
  - `overallMs` is an enforced wall-clock ceiling for the whole runtime phase and should be at least `reviewerMs + coordinatorMs` plus headroom.
  - The default full-tier budget is 15 minutes: 8 minutes per reviewer attempt, 4 minutes for coordinator synthesis, plus 3 minutes of wall-clock headroom for model latency and one early retry.
  - Retryable reviewer failures are retried only when the remaining full/lite/trivial wall-clock budget can still cover another reviewer attempt, the coordinator budget, and a retry reserve. The reserve is an internal headroom buffer (not a `.ai-review.json` field; default 2 minutes at full tier) that is scaled by the same risk tier as the other budgets, so the guard inequality is `overallMs - elapsed >= reviewerMs + coordinatorMs + reserve`, all terms at the active tier.
  - The configured values are full-review ceilings. Effective limits are scaled by risk tier: full uses 100%, lite uses 50%, and trivial uses 25%. At the default config the resulting overall ceilings are full 15 min, lite 7.5 min (450000 ms), and trivial 3.75 min (225000 ms); the per-reviewer/coordinator budgets and the retry reserve scale identically.
  - Defaults were raised after PR #9 live Pi smoke and later full-tier dogfooding exposed model-backed review latency. Lower them for tighter CI budgets or raise them for slower self-hosted/model paths.
- `patchBudgets`: per-risk-tier byte budget for the **patch-admission gate** — the soft ceiling on total (post-deletion-pruning) patch bytes admitted into a review before the model call. Object map keyed by tier: `{ "trivial"?: number, "lite"?: number, "full"?: number }`, each a byte count (`minimum: 1`). **Merged key-by-key** like `timeouts`/`reviewerPolicy`: set just one tier and the rest keep their default; an omitted key falls back to the built-in **tier-profile default (trivial 64 KB / lite 512 KB / full 4 MB)**. When a diff exceeds its tier's budget the gate degrades gracefully instead of hard-failing: it ranks changed files smallest-first, admits full patches until the budget, and demotes the overflow to **name + line-stat only** (listed in a `⚠️ Partial review by size` block in the summary). Raise `full` for monorepo-scale diffs; lower a tier if your model's context budget is tight. Example:
  ```json
  "patchBudgets": { "full": 8000000 }
  ```
  (raises only the full-tier budget to ~8 MB; trivial/lite keep their defaults.)
- `modelRouting.default`: fallback model for roles without an override. May itself carry a `thinking` bound (see below) that then applies to every role lacking its own.
- `modelRouting.roles`: role-specific model selections.
- `modelRouting.byTier` (optional, #138): per-risk-tier overrides, keyed by tier (`trivial`/`lite`/`full`), each an object with optional `default` and `roles` (same shape as the top-level `default`/`roles`). Lets you route a different model per tier — e.g. a stronger `security` model only on `full`-tier diffs. **Precedence (most specific first):** `byTier.<tier>.roles[role]` → `byTier.<tier>.default` → `roles[role]` → `default`. A tier with no `byTier` entry (or an entry lacking the role) falls back to the top-level `roles`/`default`, so omitting `byTier` entirely preserves the prior behavior. `thinking` inheritance is scoped to the selected candidate: a **tier-scoped** candidate omitting `thinking` inherits `byTier.<tier>.default.thinking` if the tier sets one, else `modelRouting.default.thinking`; a **top-level fallback** candidate (e.g. reached because a tier candidate's provider was disabled) inherits only `modelRouting.default.thinking` — a skipped tier default never bleeds onto it (see the `modelRouting.*.thinking` bullet below for the full rule). Example — upgrade just the `security` reviewer on full-tier diffs:
  ```json
  "modelRouting": {
    "default": { "provider": "pi", "model": "claude-sonnet-4-6" },
    "byTier": { "full": { "roles": { "security": { "provider": "pi", "model": "claude-opus-4-8", "thinking": "high" } } } }
  }
  ```
  > **Operator provider-disable (env, not config) — #138.** To disable a misbehaving provider *without a deploy*, set the **`AI_REVIEW_DISABLED_PROVIDERS`** env var (comma-separated provider names) on the review job — e.g. via a GitHub Actions **repository variable** `vars.AI_REVIEW_DISABLED_PROVIDERS`, wired on the real-Pi job in `ai-review.yml`. `selectModel` skips any candidate whose `provider` is listed and falls through to the next configured candidate (throwing a clear error if every candidate is disabled). This is deliberately an **env var, not an `.ai-review.json` field**: provider-disable is a trusted-operator control and must not be settable from reviewed-repo config (see [fork-safety.md](fork-safety.md)). Cross-provider failback chains (#137) build on this — see the next note.
  > **Cross-provider failback + provider health (#137).** When `modelRouting` resolves **more than one** candidate for a role (via the `byTier` → `roles` → `default` precedence above), those candidates form an implicit **failback chain** — no opt-in. On a provider-health failure the reviewer automatically fails over to the next candidate. What operators should know:
  > - **What triggers a hop:** only `rate_limited` and `retryable_transient` failures (429 / 503 / overloaded) fail over to the next provider. `timeout` and `truncated` retry the **same** model (a different provider won't fix a slow or over-long response); `auth`, `context_overflow`, `provider_error` (quota/billing exhaustion, `model not found` / invalid model), and schema errors are terminal — no hop, no retry. Note that **quota/billing exhaustion classifies as `provider_error`, not `rate_limited`**, so it does *not* currently fail over to another provider even though a separate provider's account might have capacity — treat a quota chain as primary-only for now.
  > - **Budget:** a failback hop **reuses the existing retry budget** (the `timeouts`-gated `maxAttempts`) — it is *not* an extra attempt and it passes the same wall-clock reserve gate, so total model calls per reviewer never exceed the configured attempts.
  > - **Provider health is within-run only:** the first failback-eligible failure from a provider marks it **degraded** for the rest of *that run*, so later reviewers/attempts skip it. This state is **in-memory and per-run** — there is no cross-run circuit breaker, cooldown probe, or durable health file; a provider that flaps recovers full eligibility on the next run.
  > - **Reviewers vs coordinator:** full failover-on-failure (hop to the next provider mid-attempt) applies to **both the reviewer fan-out and the coordinator synthesis** (#217). The coordinator skips providers already degraded during the fan-out (`selectStart`) and also hops to the next chain provider on a synthesis-time failure — adding a second provider to `modelRouting.roles.coordinator` provides coordinator failover the same way it does for reviewers.
  > - **Chain exhaustion stays visible:** when every provider in a multi-candidate chain fails, the reviewer surfaces a classified failure (the real provider error, marked failback-exhausted) — never a silent zero-finding pass; your fail-open/closed policy governs whether it blocks.
  > - **Operator config only:** the chain comes from your trusted `modelRouting`, never from reviewed-repo input — the same trust boundary as provider-disable above.
- `modelRouting.*.thinking` (valid on `modelRouting.default`, any entry under `modelRouting.roles`, and — since #138 — `modelRouting.byTier.<tier>.default` and entries under `modelRouting.byTier.<tier>.roles`): optional reasoning-effort bound — `off`/`minimal`/`low`/`medium`/`high`/`xhigh` (the Pi adapter passes it as `pi --thinking`; other runtimes translate the same resolved value). It is a task property, not part of the model identity. The runtime-agnostic orchestration layer resolves it before any adapter runs, so the bound behaves identically across runtimes. **Precedence:** the *selected* candidate's own `thinking` wins. A candidate that omits `thinking` inherits, in order: `modelRouting.byTier.<tier>.default.thinking` **only when the selected candidate is itself tier-scoped** (per the `byTier` precedence above) **and that tier sets a `default.thinking`**, then `modelRouting.default.thinking`. In other words a tier-scoped candidate with no tier `default.thinking` still falls through to `modelRouting.default.thinking` — it is never left unconstrained by the tier dimension (this single property inherits even when the candidate overrides its model — unlike `provider`/`model`/`tier`, which are object-level and do not merge). A skipped tier candidate (e.g. its provider was disabled, so selection fell through to a top-level role) does **not** leak its tier `thinking` onto the top-level fallback. The shipped defaults set `medium` at `modelRouting.default`, so **every role is bounded to `medium`** unless it sets its own level — and because the default is the single source, raising or lowering `modelRouting.default.thinking` re-tunes every inheriting role at once. This is the primary lever against full-tier non-convergence — at the unbounded default an agent can exhaust its whole budget deliberating over a large diff without emitting output (the #45 dogfood failure mode). Lower it to force earlier commitment; raise it per role for harder review surfaces.

  Note the named levels are discrete bounds, distinct from *no bound*: `off` still emits `--thinking off` (a real, very-low level), and `xhigh` is the highest *named* level. The runtime runs at its own (unbounded) default **only when no level is resolved at all** — i.e. when neither the role nor `modelRouting.default` sets `thinking`. Consequently, once a default level is in effect, an individual role cannot revert to the runtime's unbounded default (inheritance has no per-role opt-out); it can only pick a different named level. Running fully unbounded requires unsetting `modelRouting.default.thinking` in the base config.

  > **Upgrading from a release before the `thinking` default:** prior versions ran at the runtime's default (unbounded) reasoning level — no `--thinking` flag. After upgrading, every role defaults to `thinking: "medium"` even if you do not touch `.ai-review.json`, so you may observe different finding patterns or timings. To restore the old (unbounded) behavior, **unset `thinking` at `modelRouting.default`** in the base config — omitting it everywhere makes the runtime pass no bound. (A `.ai-review.json` override cannot un-set an inherited level; it can only choose a different one.) Setting `thinking: "high"`/`"xhigh"` only loosens the bound to a discrete level; it does not remove it. Set `"low"` to tighten further.
- `projectInstructionsPath`: reserved path for trusted project instructions.
- `extra`: extension point for future adapter-specific config.

## Tuning the review: scope, effort, and budget

Review cost and quality are governed by three independent levers. The Fields section above is the per-key reference; this section is the mental model — what each lever does, why the defaults are set where they are, and how they interact.

1. **Scope — how much review runs.** The risk classifier sorts each change into `trivial`/`lite`/`full` from its reviewed file and changed-line counts, with any `sensitivePaths` match short-circuiting straight to `full`. The tier then selects which specialist reviewers run (governed jointly by `reviewerPolicy` and the tier's role cap: trivial allows only `code_quality`; lite and full are uncapped), scales the time budgets (full 100% / lite 50% / trivial 25%), tightens tool policy (lite/trivial deny repo-crawl tools), and may skip the coordinator synthesis call entirely when all specialists succeed with zero findings (trivial and lite tiers). The tier thresholds themselves are currently hardcoded in the classifier (`trivial` ≤ 5 files and ≤ 25 lines; `full` > 50 files or > 500 lines or any sensitive path; else `lite`) — recalibrated deliberately in #21. `sensitivePaths` is the configurable input here, and it always escalates.

2. **Effort — how hard each agent thinks.** `modelRouting.*.thinking` bounds each role's Pi reasoning level. The defaults set `medium` at `modelRouting.default`, which bounds *every* role (reviewers, coordinator, and any custom role) unless individually overridden. **This is the lever to reach for first when reviews time out — not the budget.** The reason is the #45 failure mode: at the unbounded default level, full-tier reviewers spent their *entire* 6-minute per-reviewer budget deliberating over an 868-line diff and never emitted findings — all four hit the cap, the coordinator never ran, and the run produced no summary. Bounding reviewers to `medium` made the identical fixture converge: reviewers finished in ≤ 4m49s, the coordinator synthesized in 3m39s, and a real 16-finding summary was produced (dogfood verified 2026-06-11). The coordinator was the tightest remaining margin at that point (3m39s of its 4-minute budget), so it is bounded to `medium` as well. Lower a role's level (`medium` → `low`) to force earlier commitment on slow surfaces; raise it where a task genuinely needs deeper reasoning.

3. **Budget — the wall-clock backstop.** `timeouts` (plus the tier-scaled internal retry reserve) bound the worst case and gate retries via `overallMs - elapsed >= reviewerMs + coordinatorMs + reserve`. Crucially, **a budget is a ceiling, not a throttle**: raising it does not make an over-deliberating agent finish — it just lets it run longer before being killed. That is why effort (lever 2) and budget (lever 3) must be tuned *together*; #47 raised `overallMs` to 15 minutes and that only moved the bottleneck onto the per-reviewer cap until #45 bounded reviewer effort.

**Order of operations:** classify → tier selects reviewers, scales budget, sets tool policy → each agent runs at its `thinking` effort → budget caps wall-clock and gates retries.

**Tuning recipes:**
- *Reviews time out or produce no summary* → lower `thinking` (e.g. reviewers `medium` → `low`) before touching budgets.
- *Reviews are too shallow* → raise `thinking` for the relevant role, or enable more reviewers via `reviewerPolicy`.
- *Tighter CI wall-clock* → lower `timeouts`; tier scaling already shrinks small-PR budgets automatically.
- *Watch the margins as you tune:* the #45 dogfood put the coordinator closest to its cap (~3m39s of 4 minutes at default effort), which is why it is also bounded to `medium`. Re-check per-role durations after any change and adjust the offending role's `thinking` (or its budget) from there.

A `thinking` override goes under `modelRouting.default` (all roles) or `modelRouting.roles.<role>` (one role); the per-role value wins. For example, to tighten every role to `low` but keep `security` deeper:

```json
{
  "modelRouting": {
    "default": { "provider": "pi", "model": "claude-haiku", "thinking": "low" },
    "roles": {
      "security": { "provider": "pi", "model": "claude-sonnet", "thinking": "high" }
    }
  }
}
```

## Remote telemetry export (optional)

By default the runner writes counts-only telemetry to a local JSONL artifact only. To **also**
mirror it to a remote collector (e.g. a fleet-wide Grafana/Loki backend), set the exporter's env
vars in your CI — this is **environment configuration, not `.ai-review.json`** (the URL/credentials
are secrets). It is **default-off**: with nothing set, behavior is byte-identical to today.

Each exporter owns an `AI_REVIEW_<NAME>_{URL,AUTHORIZATION,BASIC_AUTH}` namespace. Two are built in:

**Generic HTTP collector** (newline-delimited JSON):
```bash
AI_REVIEW_TELEMETRY_URL=https://collector.example.com/ingest
AI_REVIEW_TELEMETRY_BASIC_AUTH=<user>:<token>          # or AI_REVIEW_TELEMETRY_AUTHORIZATION="Bearer <token>"
```

**Grafana Loki** (push-API; takes precedence if both are set):
```bash
AI_REVIEW_LOKI_URL=https://logs-prod-012.grafana.net   # BASE host; /loki/api/v1/push is appended
AI_REVIEW_LOKI_BASIC_AUTH=<instance-id>:<api-token>     # or AI_REVIEW_LOKI_AUTHORIZATION="Bearer <token>"
```

### Providing these in GitHub Actions — two steps

Adding the values as repository **Secrets/Variables is not enough on its own**: GitHub does not
expose a secret to a workflow step automatically. You must **also map it into the run step's
`env:`** in your workflow YAML — otherwise the runner sees nothing and the remote leg silently
stays off. Both steps are required:

1. Add the repo **Secret** `AI_REVIEW_LOKI_BASIC_AUTH` (credentials → always a Secret) and the
   **Secret or Variable** `AI_REVIEW_LOKI_URL`.
2. Reference them in the `env:` of the step that runs `ai-code-review`:
   ```yaml
   - name: Run review
     env:
       # …existing token/provider env…
       AI_REVIEW_LOKI_URL: ${{ secrets.AI_REVIEW_LOKI_URL || vars.AI_REVIEW_LOKI_URL }}
       AI_REVIEW_LOKI_BASIC_AUTH: ${{ secrets.AI_REVIEW_LOKI_BASIC_AUTH }}
     run: ai-code-review run …
   ```
   (For the **generic HTTP** exporter, map `AI_REVIEW_TELEMETRY_URL` / `AI_REVIEW_TELEMETRY_BASIC_AUTH`
   the same way — the mechanism is identical per namespace.)

Notes specific to GitHub Actions:
- Map it onto a **same-repo-gated** job (one whose `if:` requires
  `pull_request.head.repo.full_name == github.repository`) — that gate is the real protection,
  since the gated job does not run for fork PRs at all. Note the asymmetry if you rely on
  suppression instead: **Secrets** are not provided to `pull_request` runs from forks (the
  credential resolves to empty there), but **Variables ARE visible** to fork PRs — so a URL
  stored as a Variable is not suppressed. Keep the job gated. Prefer the real (`--runtime pi`)
  job; dummy `run_metrics` are also dropped at the egress boundary (#194), so they never reach the
  backend even if telemetry were wired into a dry-run job.
- For `pull_request` events GitHub uses the workflow file from the **base branch**, so a newly
  added mapping only takes effect for PRs opened **after** it merges to your default branch — it
  will not fire on the PR that adds it.

(This repo wires exactly this on its own `trusted-real-review` job in
`.github/workflows/ai-review.yml` — use it as the worked example.)

Rules to know when configuring:
- **HTTPS is required when credentials are set** (plain `http://` + auth is a hard startup error — no plaintext credentials). Plain `http://` is allowed only for a no-auth internal collector.
- `…_AUTHORIZATION` wins over `…_BASIC_AUTH` if both are set (the latter is then ignored).
- `…_BASIC_AUTH` is `user:token`; a malformed value (no colon / empty half) fails fast at startup.
- The URL must not point at a cloud metadata endpoint, and the POST does not follow redirects — point it at the **final** ingest URL.
- Delivery is **fail-open**: a slow or failing remote never blocks or fails the review; the local JSONL artifact is always the durable record.

**Verify it's working.** Run any review with `--output-dir <dir>` and check the run's
`<dir>/runs/<runId>/trace.jsonl` for `telemetry.remote_delivered` (or `telemetry.remote_failed`,
status only) records — one per egressed event — then query your backend (for Loki:
`{service="ai-code-review"}`). Remote `run_metrics` are **real-only by default**: dummy/dry-run
runs are dropped at the egress boundary (#194), so no `runtime` filter is needed to clean them —
add `| json | runtime="pi"` only if you also query `run_event` subtypes (whose dummy orphans are
not egress-filtered). Full reference, label scheme, counts-only guarantees, and the per-exporter
namespace convention: **[Telemetry export](telemetry-export.md)**.

## Safety note

Project config is not a permission boundary. Runtime tool policy is derived from the runner's safety mode and then tightened by risk tier, not from untrusted PR/MR content. Lite and trivial reviews run from supplied diff/context artifacts and deny repo-crawling read tools (`read`, `grep`, `find`, `ls`) plus shell/write tools (`bash`, `write`, `edit`), including when `manual_privileged` would otherwise allow shell access. The `privileged_metadata_only` safety mode already denies all tools and is unaffected by tier. Full reviews may receive read/grep/find/ls access when the safety mode allows it. The Pi adapter still disables project-local Pi resources by default in CI-oriented invocation.
