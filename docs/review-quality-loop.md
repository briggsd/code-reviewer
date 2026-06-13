# Review-quality loop

The review-quality loop is the **manual playbook** for improving the factory's reviewer
definitions over time. It closes the feedback flywheel from production telemetry → hypothesis
→ investigation → a reproducible dev scenario → tuning → holdout gate → ship.

The constraint that shapes the whole loop: reviewer definitions in
`src/runner/reviewer-definitions.ts` are a **shared asset every adopter inherits** — a
regression in the factory's reviewers degrades all downstream repos on upgrade. Quality is
therefore protected by a factory-internal QA loop whose load-bearing gate sits at the
**publish boundary**, not the per-PR boundary. The loop is intentionally manual-playbook-first
(no auto-tuning agent) per M013 S05's "automate on a proven trigger" principle.

---

## The legal loop (why the naive version is illegal here)

Two constraints rule out the obvious "feed telemetry back to auto-tune prompts" approach:

1. **Holdout discipline** (#28 / `docs/evals.md`) — scenarios are a **gate**, never a
   training signal. Tuning reviewer-definitions against the sealed holdout (`evals/scenarios/`)
   turns the eval into a memorization check and destroys it as a quality gate.
2. **Counts-only telemetry** (M008 / `docs/telemetry-export.md`) — production telemetry
   carries only rates, counts, and shape-bounded keys. There are no finding bodies, diff text,
   or prompt fragments to learn from. It tells you *where* quality is suspect; it cannot tell
   you *what* the findings said.

The legal loop looks like this:

```
quality report surfaces WHERE quality is suspect (segment breaches threshold = hypothesis)
  → investigate on material you MAY read (local dogfood traces + the dev scenario split)
  → distill a real miss / false-positive into a NEW dev scenario
  → change reviewer-definitions against the dev split (iterate until it passes)
  → the SEALED holdout gates it at release (no regression)
  → ship a quality-stamped version
```

---

## Step-by-step

### 1. Generate the quality report

```bash
bun run telemetry:quality --runs 20 --output telemetry-quality-report.json
```

This writes `telemetry-quality-report.json` and prints a hypothesis queue table.
Each row is a **segment** (overall / per-tier / per-reviewer) that breaches a quality
threshold. Cross-reference metric meanings to the table in `docs/telemetry-export.md`
(the "Quality report (hypothesis queue)" section):

| Metric | Direction | Default threshold |
|---|---|---|
| `groundingDropRate` | above → bad | 0.15 |
| `thinReviewRate` | above → bad | 0.20 |
| `overrideRate` | above → bad | 0.10 |
| `acceptanceRate` | below → bad | 0.50 |
| `withholdRate` | above → bad | 0.30 |
| `completionRate` | below → bad | 0.90 |

A breach is a **hypothesis**, not a verdict. Segments with fewer than `minSampleSize` (default 5)
runs are flagged `lowConfidence: true` — surfaced but flagged for low statistical confidence.

### 2. Form a hypothesis

Pick a breaching segment and name the suspected quality failure:

- High `withholdRate` on a reviewer → it may be raising findings developers keep suppressing
  → possible false-positive tendency.
- Low `acceptanceRate` per reviewer or per tier → findings are not landing; similar to
  high `withholdRate` but through the correction path.
- High `groundingDropRate` → the reviewer is raising ungrounded / hallucinated findings that
  the grounding check drops; look at the reviewer's prompt specificity.
- High `overrideRate` → humans are break-glassing the bot; the bot may be misfiring.

### 3. Investigate on LEGAL material only

> **Hard rule.** Investigation MUST happen on material you may legally read:
> local dogfood traces (`.ai-review/` run output, `trace.jsonl`), this repo's own PR review
> history, and the **dev split** (`evals/scenarios-dev/`). NEVER read the sealed holdout
> (`evals/scenarios/`) as part of investigation. NEVER expect finding text or diff content
> from production telemetry — it carries counts only (M008); there is none.

Practical sources:
- **Local dogfood traces:** run the CLI against a real branch with `bun run src/cli.ts run
  --git-diff --runtime pi --output-dir .ai-review`, then read `.ai-review/runs/*/trace.jsonl`
  and `summary.json` to see what the reviewer actually said.
- **This repo's PR review history:** real PR comments where a finding was raised and later
  declined give you the raw behavior.
- **The dev split:** existing `evals/scenarios-dev/*.json` scenarios and their fixtures are
  fair game for investigation.

### 4. Distill into a dev scenario

See the [Scenario-distillation recipe](#scenario-distillation-recipe) section below.

### 5. Change reviewer-definitions against the dev split

Edit `src/runner/reviewer-definitions.ts` or the coordinator prompt to address the suspected
root cause. Iterate with:

```bash
AI_REVIEW_LIVE_EVAL=1 bun run evals --scenarios evals/scenarios-dev
```

(`AI_REVIEW_LIVE_EVAL=1` is required — the default `pi` runtime is gated and this spends
tokens). Keep iterating until the new dev scenario passes its threshold. This is the **only**
place tuning is legal.

### 6. Holdout-gate (no regression)

```bash
AI_REVIEW_LIVE_EVAL=1 bun run evals --gate
```

This runs against the sealed holdout (`evals/scenarios/`). It must still pass — no scenario
may regress below its threshold. The release gate (M016 S02 #130) in
`.github/workflows/release-package.yml` enforces this at the publish boundary so no version
ships a holdout regression.

### 7. Ship quality-stamped

Once the dev split passes AND the holdout does not regress, the change is safe to merge and
publish. The improvement is now part of the shared reviewer definitions that every adopter
inherits on upgrade.

---

## Scenario-distillation recipe

How a wild miss or false-positive from the field becomes a reproducible dev scenario:

**Step 1 — Identify the behavior.**
Decide whether this is a:
- **Miss** — the reviewer should have caught a real bug but didn't → a *recall* scenario
  (criteria: `has_finding` + `decision_in` non-approved).
- **False-positive** — the reviewer raised a finding that is wrong or noise for this repo →
  a *precision* scenario (criteria: `no_findings_at_or_above` + `decision_in` approved).

**Step 2 — Reproduce the minimal diff as a trusted fixture.**
Create `evals/fixtures/<name>.json` — same shape as `examples/fixtures/auth-pr.json` but with
**NO `fakeFindings`** (a real runtime must actually review it). Name must be distinct from every
holdout fixture in `evals/fixtures/` — the disjointness guard in `test/evals-scoring.test.ts`
rejects shared names and fixture paths.

**Step 3 — Write the scenario.**
Create `evals/scenarios-dev/<name>.json` with `name`, `description`, `fixture`, `threshold`,
and `criteria` encoding the **correct** expected outcome:

- Miss → `has_finding` (with `textIncludes` for the key concept)
- FP → `no_findings_at_or_above` + `decision_in` approved / approved_with_comments

Reference the criterion-kinds table in `docs/evals.md`.

> **Criterion authoring lesson.** Prefer `textIncludes` over `pathIncludes` for detecting
> whether a bug was caught. `location.path` is optional in the finding contract and the model
> populates it inconsistently — a `pathIncludes` criterion can score 0% even when the reviewer
> raised exactly the right finding. Use `pathIncludes` only when you specifically want to
> assert the structured location field is present.

**Step 4 — Validate it loads (no tokens).**

```bash
bun run evals --runtime dummy --scenarios evals/scenarios-dev
```

The dummy runtime emits no real findings. This only proves the fixture + scenario shapes load
and the harness picks them up. If it exits nonzero, fix the JSON shape before spending tokens.

**Step 5 — (Next turn) tune reviewer-definitions until the live eval passes.**

```bash
AI_REVIEW_LIVE_EVAL=1 bun run evals --scenarios evals/scenarios-dev
```

This is the token-spending step. Edit `src/runner/reviewer-definitions.ts` and iterate until
the scenario passes its `threshold`. Only then proceed to the holdout gate (Step 6 above).

---

## Hard holdout-discipline rules

> **Warning — read before touching any scenario file.**
>
> - **NEVER tune `reviewer-definitions.ts` against the sealed holdout** (`evals/scenarios/`).
>   That turns the gate into a memorization check and destroys the holdout as a quality signal.
>   Any breach in a holdout scenario is a signal to investigate — not a fixture to optimize for.
>
> - **The one-way door.** A dev scenario you have tuned reviewer-definitions against may
>   **NEVER** be promoted or copied into the holdout (`evals/scenarios/`). It is no longer
>   unseen, so promoting it silently re-contaminates the holdout. To strengthen the holdout,
>   author a **brand-new, never-tuned scenario from scratch** directly in `evals/scenarios/`.
>
> - **The mechanical guard** (`test/evals-scoring.test.ts`) blocks the obvious copy vector:
>   a dev scenario with the same `name` or `fixture` as any holdout scenario fails the gate.
>   Re-authoring from scratch is indistinguishable at the file level — which is why this
>   documented human rule still matters alongside the mechanical guard.

See `docs/evals.md` for the canonical statement and the full holdout/dev split table.

---

## Worked dogfood example (this slice)

This slice (M016 S05 #133) dogfoods the recipe against a documented recurring false-positive
from this repo's own review history.

**The FP:** #162 — Tier-3 declined-conventions. Reviewers were repeatedly demanding TTL or
size-cap configuration on in-memory `Map` structures, even when those maps have **bounded
producers**: the key type is a closed union with a finite value set, so the map can never
grow beyond the union's cardinality.

**Why it is a false positive.** The `Map<RiskTier, number>` pattern appears in
`src/state/run-metrics-analyze.ts` and `src/state/quality-report.ts`. `RiskTier` is a
closed 3-value union (`"trivial" | "lite" | "full"`). The map iterates over that union as
its only producer — it holds at most 3 keys by construction. A "you need a TTL or size cap"
finding is wrong here; no eviction policy is warranted.

**The fixture** (`evals/fixtures/bounded-accumulator.json`) reproduces the minimal diff that
triggers the pattern: a synthetic `tallyByTier` helper that builds a `Map<RiskTier, number>`
from a closed union. `safetyMode: "trusted"`, no `fakeFindings`.

**The scenario** (`evals/scenarios-dev/bounded-accumulator.json`) encodes the correct
precision behavior:

| Criterion | Why |
|---|---|
| `no_findings_at_or_above` warning | A warning-level "add a size cap" finding is the FP to guard against |
| `decision_in` approved / approved_with_comments | A bounded helper should be approved |

These two criteria fully encode the precision goal. An earlier draft also capped suggestion
count (`max_findings`), but that conflates an orthogonal signal-to-noise constraint with the
FP guard and can mask whether the warning-level FP was actually suppressed — so it was dropped
(keep precision scenarios to the criteria that encode the one behavior under test).

**Status.** The scenario has been validated to load via dummy-runtime eval (the output is in
the implementation PR). It currently lives in `evals/scenarios-dev/` awaiting the next turn:
editing `src/runner/reviewer-definitions.ts` to suppress the false-positive, then running
`AI_REVIEW_LIVE_EVAL=1 bun run evals --scenarios evals/scenarios-dev` to confirm the fix. That
is a separate, token-spending step — out of scope for this slice.

---

## Cross-references

- **`docs/evals.md`** — holdout scenario eval harness: scoring, criterion kinds, holdout/dev
  split discipline, and how to add a new scenario.
- **`docs/telemetry-export.md`** — export schema, M008 identifier policy, and the quality-report
  hypothesis-queue section (metric definitions and default thresholds).
- **#159** — declined-finding reviewer memory (recurring suppression tracking).
- **#162** — recurring-findings → conventions (the false-positive this slice distills).
- **#151** — tokenomics (cost impact of reviewer tuning).
