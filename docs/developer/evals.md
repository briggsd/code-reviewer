# Holdout scenario eval harness

> **Adopter note:** For release and smoke guidance, use [Release readiness](../user/release-readiness.md) and [Pi live smoke test](../user/pi-live-smoke.md); eval authoring details stay here.

## What it is

The holdout eval harness is the **outer verification layer** for the review factory — a set of
behavioral scenarios that score *the quality of the review the factory produces* on known diffs.
It lives outside the `test/` implementation tests and measures satisfaction over K runs, because
the real Pi/model runtime is non-deterministic.

Unlike `test/` (which tests orchestration correctness, config, and deterministic paths), the eval
harness asks: "Does the model actually catch this SQL injection? Does it correctly stay quiet on a
cosmetic-only diff?" These questions cannot be answered by unit tests with a dummy runtime.

## Holdout / dev split (M016 S01, #129 — read before touching scenarios)

The scenarios are split into two directories with **opposite** disciplines. Read which one you
are touching:

| Directory | Role | May you read/tune against it? |
|---|---|---|
| `evals/scenarios/` | **Sealed holdout** — the quality gate (the release gate, M016 S02 #130, runs it) | **No.** Gate-only; treat as unseen. |
| `evals/scenarios-dev/` | **Dev split** — the improvement loop's iteration material | **Yes.** Grow it, tune reviewer-defs against it. |

**Reviewer prompts in `src/runner/reviewer-definitions.ts` MUST NOT be tuned against the
holdout (`evals/scenarios/`).** If a holdout scenario underperforms, that is a signal to
investigate — not a fixture to memorize. Tuning against the holdout turns the eval into a
memorization check and destroys it. The dev split exists precisely so there is *legal* material
to iterate against without contaminating the gate.

**The one-way door (the hard rule).** A scenario in `evals/scenarios-dev/` that you have tuned
reviewer-definitions against may **never** be promoted/copied into `evals/scenarios/` — it is no
longer unseen, so promoting it silently re-contaminates the holdout. To strengthen the holdout,
author a brand-new scenario from scratch (new fixture, never used as a tuning target) directly
in `evals/scenarios/`. This is mechanically guarded against the obvious copy vector:
`test/evals-scoring.test.ts` asserts the two splits are **disjoint by scenario name and fixture
path** (a tuned dev scenario can't be copied in under the same name/fixture). The
re-authored-from-scratch case is covered by this documented discipline — at the file level it is
indistinguishable from a genuinely new scenario, which is why the human rule still matters. Each
directory's `README.md` restates the rule at the point of use.

The `evals/` directory is kept SEPARATE from `examples/fixtures/` for this reason. Examples
fixtures may have `fakeFindings` for deterministic testing; holdout and dev fixtures never do — a
real runtime must actually review them.

**Holdout discipline**: scenarios are chosen to reflect *diverse behavioral properties* (recall,
precision, severity calibration, noise guard). They should be hard for the model to "memorize"
but easy for a human to validate.

## Scenario reliability taxonomy

Use this taxonomy to name what a scenario is primarily testing. Each scenario should name **one
primary reliability dimension** in its description or authoring notes, even if its criteria also
exercise secondary dimensions. This keeps failures diagnosable: a regression should answer
"which reliability property moved?" before anyone reaches for reviewer-definition changes.

| Dimension | Scenario asks |
|---|---|
| **Recall** | Does the reviewer catch real defects or security issues that should block or warn? |
| **Precision** | Does the reviewer stay quiet on benign changes? |
| **Severity calibration** | Is `suggestion` / `warning` / `critical` stable, meaningful, and proportional to the risk? |
| **Role calibration** | Does the right reviewer own the finding instead of another role raising it by accident? |
| **Signal-to-noise** | Does the review avoid suggestion floods on low-risk diffs? |
| **Grounding/completeness** | Do valid findings include enough evidence/location signal to survive deterministic suppression and grounding gates? |
| **Survival under stress** | Do reviewers still deliver useful output under large diffs, tight budgets, or time pressure? |
| **Convention memory** | Do known false positives and explicit declines stop recurring after the dev loop teaches the reviewer? |

Scenario criteria should encode the narrowest observable behavior for the primary dimension. For
example, a recall scenario usually needs a `has_finding` criterion for the missed concept and a
non-approved decision. A precision scenario should usually stay narrow with `no_findings_at_or_above`
plus an approved decision, so unrelated suggestion noise does not mask whether the target behavior
regressed.

### Authoring contract

- Name one primary reliability dimension for every scenario. Put it in the `description` when
  authoring JSON; for existing scenarios, the tables below document the current category without
  changing the sealed files.
- Keep precision scenarios narrow. Do not add broad, unrelated criteria that make ordinary
  suggestion chatter look like a failure of the precision behavior under test.
- Prefer `textIncludes` over `pathIncludes` when testing whether a bug was caught. Use
  `pathIncludes` only when the scenario explicitly tests structured location quality.
- Distinguish **dev-split tuning scenarios** from **publish-gate holdout scenarios** before
  writing or reading scenario material.
- Tune reviewer definitions only against `evals/scenarios-dev/`. Never tune against
  `evals/scenarios/`.
- Never promote, copy, or re-author a tuned dev scenario into the sealed holdout. Strengthen the
  holdout only with a fresh, never-tuned scenario written directly for the gate.
- Keep reviewed-repo content untrusted when discussing or distilling scenarios. Telemetry and
  release artifacts stay counts/scores only: no diffs, finding bodies, prompts, or secrets.

## File layout

```
evals/
  fixtures/        — PR fixtures (real diffs, NO fakeFindings) for both splits
  scenarios/       — SEALED HOLDOUT scenarios (gate-only; see scenarios/README.md)
  scenarios-dev/   — DEV split scenarios (iteration material; see scenarios-dev/README.md)
src/evals/
  types.ts    — EvalCriterion + EvalScenario TypeScript types
  score.ts    — pure scoring functions (no I/O, no network)
  index.ts    — barrel export
scripts/evals.ts  — gated runner (I/O + subprocess; mirrors scripts/pi-live-smoke.ts)
test/evals-scoring.test.ts  — unit tests for scorer + holdout/dev disjointness guard (runs in bun run check)
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
| `--scenarios <dir>` | `evals/scenarios` | Directory of scenario JSON files (the sealed holdout by default; pass `evals/scenarios-dev` for the dev split) |
| `--gate` | off | Exit nonzero if any scenario fails threshold |
| `--keep-summaries <dir>` | off | Trusted-local debugging only: preserve raw per-run `summary.json` files in the given directory; rejected when CI is detected via `CI` or a known runner env var |

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

The live holdout eval is wired as a **required step** in `.github/workflows/release-package.yml`
before `npm pack`. A holdout regression (any scenario below threshold, or an empty holdout) blocks
the gate and prevents the tarball from being created. This ensures no tarball ships if the holdout
regresses.

#### `--stamp <path>` flag

Pass `--stamp dist/quality-stamp.json` to emit a machine-readable quality stamp alongside the gate
result. The stamp uses the schema `ai-review.quality_stamp.v2` and contains **counts/scores only**
— per-scenario satisfaction, per-run satisfaction numbers, min/max/variance/flaky diagnostics,
per-criterion pass rates, threshold, pass/fail, and run count; plus aggregate passed/total/mean and
a `blocked` boolean. No raw summaries, finding bodies, diffs, prompts, or review output are
included.

Migration note for v2 consumers: all v1 fields are preserved, and v2 adds score-only reliability
diagnostics (`runSatisfactions`, `minSatisfaction`, `maxSatisfaction`, `variance`, `flaky`, and
`perCriterion`). Consumers that only read existing fields can continue to do so, but strict
`schemaVersion` checks must accept `ai-review.quality_stamp.v2`.

`scenarios` lists **every** scenario that ran (not just the passing ones), so a `blocked: true`
stamp shows exactly which scenario(s) regressed:

```json
{
  "schemaVersion": "ai-review.quality_stamp.v2",
  "generatedAt": "2026-01-01T00:00:00.000Z",
  "commit": "abc123",
  "runtime": "pi",
  "model": null,
  "runs": 3,
  "threshold": 0.8,
  "passed": 1,
  "total": 2,
  "meanSatisfaction": 0.65,
  "blocked": true,
  "scenarios": [
    {
      "name": "auth-sqli",
      "satisfaction": 1.0,
      "threshold": 0.8,
      "passed": true,
      "runSatisfactions": [1.0, 1.0, 1.0],
      "minSatisfaction": 1.0,
      "maxSatisfaction": 1.0,
      "variance": 0,
      "flaky": false,
      "perCriterion": [
        {
          "label": "flags SQL injection",
          "passRate": 1.0,
          "critical": true,
          "requiredPassRate": 1.0,
          "passed": true
        }
      ],
      "runCount": 3
    },
    {
      "name": "logic-bug",
      "satisfaction": 0.3,
      "threshold": 0.8,
      "passed": false,
      "runSatisfactions": [0, 0.5, 0.4],
      "minSatisfaction": 0,
      "maxSatisfaction": 0.5,
      "variance": 0.0467,
      "flaky": true,
      "perCriterion": [],
      "runCount": 3
    }
  ]
}
```

The `blocked` field mirrors the gate decision: `true` means the release gate would block (any
scenario failed, or the holdout was empty). The stamp is uploaded as a release artifact alongside
the tarball so it serves as a cross-version stability signal.

`--keep-summaries <dir>` is deliberately separate from `--stamp`: it preserves raw `summary.json`
files for trusted local debugging only. Those summaries can contain finding bodies and other raw
review text, so the runner rejects this flag when CI is detected via `CI` or a known runner env var
(`GITHUB_ACTIONS`, `GITLAB_CI`, `CIRCLECI`, `BUILDKITE`, or `TF_BUILD`); do not use it in
release/fleet workflows and do not upload its directory as a CI artifact. When the flag is omitted,
the runner deletes its temporary per-run directories as before.

### Advisory PR signal (dummy runtime, free)

`.github/workflows/reviewer-eval-signal.yml` runs automatically on pull requests that touch
`src/runner/reviewer-definitions.ts`, `src/evals/**`, `evals/**`, or `scripts/evals.ts`
(and self-triggers on changes to the workflow file itself).

**What it catches:** harness/scenario/fixture/scorer/CLI regressions. The workflow runs
`bun run evals --runtime dummy --scenarios <dir>` over both splits (that runner internally drives
the `bun run src/cli.ts run --runtime dummy` path per scenario). If a change breaks scenario JSON
loading, a fixture, the scorer (`src/evals/`), or that CLI path, the dummy eval crashes (nonzero
exit) and the advisory step flags it. To reproduce an advisory failure locally, run that same
`bun run evals --runtime dummy --scenarios evals/scenarios` (and `… evals/scenarios-dev`).

**What it does NOT catch:** reviewer quality. The dummy runtime ignores reviewer prompts and emits
no model findings — it cannot measure whether a reviewer catches a real bug. That is the live
release holdout gate (M016 S02, `release-package.yml`).

**Key properties:**
- **Free** — dummy runtime only; no tokens, no network, no provider keys or secrets.
- **Advisory / non-blocking** — the eval step uses `continue-on-error: true` so a harness crash
  never blocks the PR.
- **Deterministic result** — the dummy runtime produces "2/5 passed" over the holdout split
  (`evals/scenarios`) and "2/7 passed" over the dev split (`evals/scenarios-dev`): recall scenarios
  score 0 with no findings, precision scenarios pass. Both are expected and are NOT failures (these
  baselines shift as scenarios are added/removed). Only a harness crash (nonzero exit) is the
  negative signal. `--gate` is never used here because it would always "fail" under dummy.

For the full improvement loop — hypothesis → dev scenario → reviewer-definition tuning → holdout
release gate — see `review-quality-loop.md`. For scenario vocabulary and the authoring
rules, see [Scenario reliability taxonomy](#scenario-reliability-taxonomy).

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

A scenario **passes** if `scenario_satisfaction >= threshold` and every criterion-level gate passes.

The scorer also returns `runSatisfactions`, `minSatisfaction`, `maxSatisfaction`, `variance`, and
`flaky` for each scenario. `flaky` means the repeated runs did not all produce the same satisfaction
score. Reliability work should look at these fields before changing reviewer definitions:
low satisfaction with low variance is a stable miss, while high variance or a `flaky` marker means
the behavior is unstable and may need clearer reviewer guidance, narrower criteria, or more runs.

### Criterion kinds

| Kind | Passes when |
|---|---|
| `has_finding` | ∃ finding matching all provided filters (reviewer, severity, category, pathIncludes, textIncludes) |
| `no_findings_at_or_above` | No finding at or above the given severity rank |
| `max_findings` | At most `count` findings at or above `atOrAbove` severity |
| `decision_in` | `summary.decision` is one of the listed values |
| `outcome_is` | `summary.outcome` equals the given value |
| `reviewer_not_failed` | `summary.degraded?.failedRoles` does not include the named reviewer, matched case-insensitively; absent `degraded` passes |
| `partial_by_size` | `summary.partialBySize` is present and any provided count minimums are met (`minDroppedFileCount`, `minAdmittedFileCount`) |

Severity rank: `critical` (3) > `warning` (2) > `suggestion` (1).
`minSeverity` in `has_finding` matches the given level OR higher.

### Per-criterion pass rates

The runner also reports, for each criterion, the fraction of runs where it was met.
This is useful for diagnosing flaky criteria (high variance between runs).

Criteria may also carry optional pass-rate gates:

```json
{
  "kind": "has_finding",
  "label": "flags SQL injection at critical severity",
  "minSeverity": "critical",
  "textIncludes": "inject",
  "critical": true
}
```

`critical: true` is shorthand for a criterion-level gate with a default required pass rate of `1.0`
(every run must meet it). `minPassRate` sets an explicit gate such as `0.8` whether or not
`critical` is present; when both are specified, `minPassRate` is the explicit requirement and
overrides the `critical` default. These gates are evaluated in addition to the scenario mean
threshold, so a scenario can fail because a gated criterion is unreliable even when the average
satisfaction is high enough.

## Existing scenario categories

> These five live in `evals/scenarios/` (the sealed holdout). The dev split
> (`evals/scenarios-dev/`) grows via the improvement playbook (M016 S05). The primary dimensions
> below are documentation labels only; this table does not change the scenario JSON contract.

### Sealed holdout

| Scenario | Primary dimension | What it tests | Key criteria |
|---|---|---|---|
| `auth-sqli` | Recall | Catches SQL injection in an auth path | `has_finding` minSeverity=critical, textIncludes=inject; decision security-concern; outcome=fail |
| `clean-refactor` | Precision | Stays quiet on a benign constant extraction | `no_findings_at_or_above` warning; decision=approved/approved_with_comments; threshold=0.9 |
| `hardcoded-secret` | Recall | Catches a hardcoded credential while limiting extra noise | `has_finding` minSeverity=warning, textIncludes=secret; max 5 findings total |
| `logic-bug` | Recall | Catches an off-by-one plus inverted boundary check | `has_finding` minSeverity=warning, textIncludes=pagination; decision not approved |
| `noisy-benign` | Signal-to-noise | Stays mostly quiet on formatting-only churn | `no_findings_at_or_above` warning; max 3 suggestions |

### Dev split

| Scenario | Primary dimension | What it tests | Key criteria |
|---|---|---|---|
| `bounded-accumulator` | Convention memory | Preserves the declined convention that a closed RiskTier-union accumulator does not need TTL/size-cap warnings | `no_findings_at_or_above` warning; decision=approved/approved_with_comments; threshold=0.9 |
| `ci-template-mutable-actions` | Convention memory | Preserves the adopter-template convention that readable mutable action tags are allowed even though factory-owned workflows are SHA-pinned | `no_findings_at_or_above` warning; decision=approved/approved_with_comments; threshold=0.9 |
| `untrusted-runtime-output-validation` | Recall | Catches casts of untrusted model/subprocess-shaped JSON into review contracts without validation | `has_finding` minSeverity=warning, textIncludes=validate; decision in [approved_with_comments, minor_issues, significant_concerns, review_failed]; threshold=1.0 |
| `quality-stamp-schema-rename` | Recall | Catches silent serialized contract drift in the persisted release quality stamp | `has_finding` minSeverity=warning, textIncludes=schemaVersion; decision in [approved_with_comments, minor_issues, significant_concerns, review_failed]; threshold=1.0 |
| `timeout-fallback-integration-coverage` | Recall | Catches degraded timeout fallback changes that only add helper-level tests instead of integration/policy coverage | `has_finding` minSeverity=warning, textIncludes=timeout; decision in [approved_with_comments, minor_issues, significant_concerns, review_failed]; threshold=1.0 |
| `large-diff-code-quality-delivery` | Survival under stress | Full-tier dev stress scenario for #238: large fixture/generated/test-data bulk is visibly demoted while `code_quality` completes and an admitted discount logic bug remains catchable by live runs | `reviewer_not_failed` for code_quality, critical; `partial_by_size` minDroppedFileCount=1 minAdmittedFileCount=1; `has_finding` reviewer=code_quality minSeverity=warning textIncludes=discount; decision in [approved_with_comments, minor_issues, significant_concerns, review_failed]; threshold=1.0 |
| `full-file-grounding-precision` | Grounding/completeness | Full changed-file grounding precision scenario for #239: a small patch has real unchanged surrounding code available through `changedFileContents`, so valid out-of-hunk evidence can survive without putting full file bodies into prompt artifacts | `has_finding` minSeverity=warning textIncludes=owner; decision in [approved_with_comments, minor_issues, significant_concerns, review_failed]; threshold=1.0 |

> **Criterion authoring lesson (from the first live pi run).** Prefer `textIncludes` (searches a
> finding's title/body/recommendation/evidence/quotedCode) over `pathIncludes` to detect *whether a
> bug was caught*. `location.path` is **optional in the finding contract and the model populates it
> inconsistently** — a `pathIncludes` criterion can score 0% even when the reviewer raised exactly the
> right finding (observed on the SQLi + pagination scenarios: both were caught, but the findings
> carried no `location.path`). Use `pathIncludes` only when you specifically want to assert the
> structured location is present.

## Adding a new scenario

See **`review-quality-loop.md`** for the end-to-end improvement loop: how a quality-report
hypothesis becomes an investigation, then a distilled dev scenario, then a tuning change, then a
holdout-gated release.

Use the [Scenario reliability taxonomy](#scenario-reliability-taxonomy) before writing criteria:
pick one primary dimension, then encode the smallest observable behavior that proves or falsifies it.

**First decide which split.** Iterating on review quality? Add it to the **dev split**
(`evals/scenarios-dev/`) — that is the material you may tune against. Adding a fresh, never-tuned
regression case to the gate? Add it to the **holdout** (`evals/scenarios/`) and never look at it
as a tuning target. Never move a tuned dev scenario into the holdout (the one-way door above).

1. Create a fixture in `evals/fixtures/<name>.json` — same shape as `examples/fixtures/auth-pr.json`
   but WITHOUT `fakeFindings`. The fixture name **must be distinct** from every holdout fixture
   (the disjointness guard rejects a shared fixture across the two splits).
2. Validate it loads (applies to both splits): `bun run src/cli.ts run --fixture evals/fixtures/<name>.json --runtime dummy --output-dir /tmp/eval-check`
3. Create `evals/scenarios/<name>.json` **or** `evals/scenarios-dev/<name>.json` with `name`,
   `description`, `fixture`, and `criteria`. The `description` should name the scenario's primary
   reliability dimension, such as "Recall: catches..." or "Precision: stays quiet...".
4. Confirm the harness picks it up: `bun run evals --runtime dummy` (holdout, default) or
   `bun run evals --runtime dummy --scenarios evals/scenarios-dev` (dev split).
5. **Holdout only:** do **not** adjust `reviewer-definitions.ts` to make a holdout scenario
   pass — that breaks holdout discipline. (Tuning against a *dev* scenario is the intended loop.)

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
