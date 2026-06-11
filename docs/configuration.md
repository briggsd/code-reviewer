# Project configuration

The runner loads JSON config from an explicit `--config <path>` first. If no path is provided, it looks for `.ai-review.json` or `ai-review.json` in the current working directory.

Config files are partial overrides over the built-in defaults. Nested objects such as `reviewerPolicy`, `timeouts`, and `modelRouting` are merged with defaults.

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
    ".github/workflows/**"
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
    "reviewerMs": 360000,
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

## Fields

- `mode`: `advisory` or `blocking`.
- `failOn`: finding severities that fail CI in blocking mode.
- `sensitivePaths`: glob-like path patterns that escalate risk.
- `ignoredPaths`: glob-like path patterns filtered out before review.
- `reviewerPolicy`: role name to `enabled`, `disabled`, or `full_only`.
- `timeouts`: reviewer/coordinator/overall budgets in milliseconds.
  - Reviewer agents run in parallel; the coordinator runs after all reviewers complete.
  - `overallMs` is an enforced wall-clock ceiling for the whole runtime phase and should be at least `reviewerMs + coordinatorMs` plus headroom.
  - The default full-tier budget is 15 minutes: 6 minutes per reviewer attempt, 4 minutes for coordinator synthesis, plus 5 minutes of wall-clock headroom for model latency and one early retry.
  - Retryable reviewer failures are retried only when the remaining full/lite/trivial wall-clock budget can still cover another reviewer attempt, the coordinator budget, and a retry reserve. The reserve is an internal headroom buffer (not a `.ai-review.json` field; default 2 minutes at full tier) that is scaled by the same risk tier as the other budgets, so the guard inequality is `overallMs - elapsed >= reviewerMs + coordinatorMs + reserve`, all terms at the active tier.
  - The configured values are full-review ceilings. Effective limits are scaled by risk tier: full uses 100%, lite uses 50%, and trivial uses 25%. At the default config the resulting overall ceilings are full 15 min, lite 7.5 min (450000 ms), and trivial 3.75 min (225000 ms); the per-reviewer/coordinator budgets and the retry reserve scale identically.
  - Defaults were raised after PR #9 live Pi smoke and later full-tier dogfooding exposed model-backed review latency. Lower them for tighter CI budgets or raise them for slower self-hosted/model paths.
- `modelRouting.default`: fallback model for roles without an override. May itself carry a `thinking` bound (see below) that then applies to every role lacking its own.
- `modelRouting.roles`: role-specific model selections.
- `modelRouting.*.thinking` (valid on both `modelRouting.default` and any entry under `modelRouting.roles`): optional reasoning-effort bound — `off`/`minimal`/`low`/`medium`/`high`/`xhigh` (the Pi adapter passes it as `pi --thinking`; other runtimes translate the same resolved value). It is a task property, not part of the model identity. The runtime-agnostic orchestration layer resolves it before any adapter runs, so the bound behaves identically across runtimes. **Precedence:** a per-role `thinking` wins; a role that omits `thinking` inherits `modelRouting.default.thinking` (this single property inherits even when the role overrides its model — unlike `provider`/`model`/`tier`, which are object-level and do not merge). The shipped defaults set `medium` at `modelRouting.default`, so **every role is bounded to `medium`** unless it sets its own level — and because the default is the single source, raising or lowering `modelRouting.default.thinking` re-tunes every inheriting role at once. This is the primary lever against full-tier non-convergence — at the unbounded default an agent can exhaust its whole budget deliberating over a large diff without emitting output (the #45 dogfood failure mode). Lower it to force earlier commitment; raise it per role for harder review surfaces.

  Note the named levels are discrete bounds, distinct from *no bound*: `off` still emits `--thinking off` (a real, very-low level), and `xhigh` is the highest *named* level. The runtime runs at its own (unbounded) default **only when no level is resolved at all** — i.e. when neither the role nor `modelRouting.default` sets `thinking`. Consequently, once a default level is in effect, an individual role cannot revert to the runtime's unbounded default (inheritance has no per-role opt-out); it can only pick a different named level. Running fully unbounded requires unsetting `modelRouting.default.thinking` in the base config.

  > **Upgrading from a release before the `thinking` default:** prior versions ran at the runtime's default (unbounded) reasoning level — no `--thinking` flag. After upgrading, every role defaults to `thinking: "medium"` even if you do not touch `.ai-review.json`, so you may observe different finding patterns or timings. To restore the old (unbounded) behavior, **unset `thinking` at `modelRouting.default`** in the base config — omitting it everywhere makes the runtime pass no bound. (A `.ai-review.json` override cannot un-set an inherited level; it can only choose a different one.) Setting `thinking: "high"`/`"xhigh"` only loosens the bound to a discrete level; it does not remove it. Set `"low"` to tighten further.
- `projectInstructionsPath`: reserved path for trusted project instructions.
- `extra`: extension point for future adapter-specific config.

## Tuning the review: scope, effort, and budget

Review cost and quality are governed by three independent levers. The Fields section above is the per-key reference; this section is the mental model — what each lever does, why the defaults are set where they are, and how they interact.

1. **Scope — how much review runs.** The risk classifier sorts each change into `trivial`/`lite`/`full` from its reviewed file and changed-line counts, with any `sensitivePaths` match short-circuiting straight to `full`. The tier then selects which specialist reviewers run (combined with `reviewerPolicy`, where `full_only` reserves a role such as `performance` for full-tier diffs), scales the time budgets (full 100% / lite 50% / trivial 25%), and tightens tool policy (lite/trivial deny repo-crawl tools). The tier thresholds themselves are currently hardcoded in the classifier (`trivial` ≤ 5 files and ≤ 25 lines; `full` > 50 files or > 500 lines or any sensitive path; else `lite`) — recalibrated deliberately in #21. `sensitivePaths` is the configurable input here, and it always escalates.

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

## Safety note

Project config is not a permission boundary. Runtime tool policy is derived from the runner's safety mode and then tightened by risk tier, not from untrusted PR/MR content. Lite and trivial reviews run from supplied diff/context artifacts and deny repo-crawling read tools (`read`, `grep`, `find`, `ls`) plus shell/write tools (`bash`, `write`, `edit`), including when `manual_privileged` would otherwise allow shell access. The `privileged_metadata_only` safety mode already denies all tools and is unaffected by tier. Full reviews may receive read/grep/find/ls access when the safety mode allows it. The Pi adapter still disables project-local Pi resources by default in CI-oriented invocation.
