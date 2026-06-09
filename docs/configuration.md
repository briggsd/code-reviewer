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
    "overallMs": 660000
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
  - Defaults were raised after PR #9 live Pi smoke exposed model-backed review latency. Lower them for tighter CI budgets or raise them for slower self-hosted/model paths.
- `modelRouting.default`: fallback model for roles without an override.
- `modelRouting.roles`: role-specific model selections.
- `projectInstructionsPath`: reserved path for trusted project instructions.
- `extra`: extension point for future adapter-specific config.

## Safety note

Project config is not a permission boundary. Runtime tool policy is derived from the runner's safety mode, not from untrusted PR/MR content. The Pi adapter still disables project-local Pi resources by default in CI-oriented invocation.
