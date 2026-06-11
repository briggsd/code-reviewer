# Holdout scenario eval harness

## What it is

The holdout eval harness is the **outer verification layer** for the review factory — a set of
behavioral scenarios that score *the quality of the review the factory produces* on known diffs.
It lives outside the `test/` implementation tests and measures satisfaction over K runs, because
the real Pi/model runtime is non-deterministic.

Unlike `test/` (which tests orchestration correctness, config, and deterministic paths), the eval
harness asks: "Does the model actually catch this SQL injection? Does it correctly stay quiet on a
cosmetic-only diff?" These questions cannot be answered by unit tests with a dummy runtime.

## Holdout hygiene (critical — read before touching scenarios)

**Reviewer prompts in `src/runner/reviewer-definitions.ts` MUST NOT be tuned against these
scenarios.** If you add a new scenario, do not look at it as a target and adjust prompts to make
it pass — that invalidates the holdout and turns the eval into a memorization check.

The `evals/` directory is kept SEPARATE from `examples/fixtures/` for this reason. Examples
fixtures may have `fakeFindings` for deterministic testing; holdout fixtures never do — a real
runtime must actually review them.

**Holdout discipline**: scenarios are chosen to reflect *diverse behavioral properties* (recall,
precision, severity calibration, noise guard). They should be hard for the model to "memorize"
but easy for a human to validate.

## File layout

```
evals/
  fixtures/   — holdout PR fixtures (real diffs, NO fakeFindings)
  scenarios/  — scenario definitions (reference a fixture + behavioral criteria)
src/evals/
  types.ts    — EvalCriterion + EvalScenario TypeScript types
  score.ts    — pure scoring functions (no I/O, no network)
  index.ts    — barrel export
scripts/evals.ts  — gated runner (I/O + subprocess; mirrors scripts/pi-live-smoke.ts)
test/evals-scoring.test.ts  — unit tests for scorer (runs in bun run check)
```

## How to run

### Dummy runtime (no tokens, validates fixture shapes only)

```bash
bun run evals --runtime dummy
```

The dummy runtime emits no real findings. This only validates that fixtures load and the harness
runs end-to-end — it tells you nothing about model quality.

### Pi runtime (real model, gated)

```bash
AI_REVIEW_LIVE_EVAL=1 bun run evals
```

Optional flags:

| Flag | Default | Description |
|---|---|---|
| `--runtime dummy\|pi` | `pi` | Runtime to use |
| `--runs K` | 3 (pi), 1 (dummy) | Runs per scenario |
| `--threshold T` | 0.8 | Minimum satisfaction to pass (0.0–1.0) |
| `--scenarios <dir>` | `evals/scenarios` | Directory of scenario JSON files |
| `--gate` | off | Exit nonzero if any scenario fails threshold |

Optional env vars (must be paired):
```bash
AI_REVIEW_PI_PROVIDER=anthropic AI_REVIEW_PI_MODEL=claude-sonnet-4-6 AI_REVIEW_LIVE_EVAL=1 bun run evals
```

### Gated CI gate (fail the build if quality regresses)

```bash
AI_REVIEW_LIVE_EVAL=1 bun run evals --runs 5 --gate
```

`--gate` causes the process to exit nonzero if ANY scenario fails its threshold. Without `--gate`,
the runner is always informational (exit 0), safe to run without blocking a release.

## How scoring works

### Satisfaction fraction

Each scenario has a list of `EvalCriterion`. On each run, every criterion is evaluated as
**true/false** against the `ReviewSummary` produced by the CLI. The **run satisfaction** is the
fraction of criteria that were true:

```
run_satisfaction = met_criteria / total_criteria   (or 1.0 if no criteria)
```

Over K runs, the **scenario satisfaction** is the mean:

```
scenario_satisfaction = mean(run_satisfaction over K runs)
```

A scenario **passes** if `scenario_satisfaction >= threshold`.

### Criterion kinds

| Kind | Passes when |
|---|---|
| `has_finding` | ∃ finding matching all provided filters (reviewer, severity, category, pathIncludes, textIncludes) |
| `no_findings_at_or_above` | No finding at or above the given severity rank |
| `max_findings` | At most `count` findings at or above `atOrAbove` severity |
| `decision_in` | `summary.decision` is one of the listed values |
| `outcome_is` | `summary.outcome` equals the given value |

Severity rank: `critical` (3) > `warning` (2) > `suggestion` (1).
`minSeverity` in `has_finding` matches the given level OR higher.

### Per-criterion pass rates

The runner also reports, for each criterion, the fraction of runs where it was met.
This is useful for diagnosing flaky criteria (high variance between runs).

## The 5 seed scenarios

| Scenario | What it tests | Key criteria |
|---|---|---|
| `auth-sqli` | Recall: catches SQL injection in auth path | `has_finding` minSeverity=critical, pathIncludes=auth, textIncludes=inject; outcome=fail |
| `clean-refactor` | **Precision** (most important): no over-flagging of benign constant extraction | `no_findings_at_or_above` warning; decision=approved/approved_with_comments; threshold=0.9 |
| `hardcoded-secret` | Recall: catches hardcoded credential | `has_finding` minSeverity=warning, textIncludes=secret; max 5 findings total |
| `noisy-benign` | Signal-to-noise: quiet on formatting-only diff | `no_findings_at_or_above` warning; max 3 suggestions |
| `logic-bug` | Recall: catches off-by-one + inverted boundary check | `has_finding` minSeverity=warning, pathIncludes=pagination; decision not approved |

## Adding a new scenario

1. Create a fixture in `evals/fixtures/<name>.json` — same shape as `examples/fixtures/auth-pr.json`
   but WITHOUT `fakeFindings`.
2. Validate it loads: `bun run src/cli.ts run --fixture evals/fixtures/<name>.json --runtime dummy --output-dir /tmp/eval-check`
3. Create `evals/scenarios/<name>.json` with `name`, `description`, `fixture`, and `criteria`.
4. Run `bun run evals --runtime dummy` to confirm the harness picks it up.
5. **Do not** adjust `reviewer-definitions.ts` to make the new scenario pass — that breaks holdout discipline.

## Known limitations / coverage gaps

- **Safety mode.** Holdout fixtures use `safetyMode: "trusted"` (the same default as every
  `examples/fixtures/` dev fixture). `safetyMode` governs the runtime **tool policy** (repo-crawl
  access), not prompt-injection sanitization — untrusted metadata/diff is sanitized in
  `prompt-boundary.ts` regardless of mode. Since the synthetic fixtures have no backing repo to crawl,
  the mode has no effect on finding quality here. Consequence: the harness does **not** exercise the
  untrusted-input tool-policy path (`untrusted_read_only` / `privileged_metadata_only`); it measures
  review *quality*, not safety-boundary enforcement. Add dedicated safety-posture coverage separately
  if that path needs eval signal.
- **Serial execution.** Scenarios and their K runs execute sequentially, so wall-clock grows as
  O(scenarios × runs) model calls. This is intentional for the opt-in MVP (simpler, avoids provider
  rate-limit bursts); parallelizing with a bounded concurrency is a future enhancement.
- **First-page dedup / single run dir** are not relevant here (each run uses a fresh output dir).
