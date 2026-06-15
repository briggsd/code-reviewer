# `evals/scenarios-dev/` — the DEV iteration split

> **This is the legal iteration material. You MAY read, grow, and tune against these.**

This directory holds the scenarios the review-quality improvement loop (M016) works against.
Unlike the sealed holdout in **`evals/scenarios/`**, these are *meant* to be looked at: you
distill a real miss or false-positive into a dev scenario, then adjust
`src/runner/reviewer-definitions.ts` / the coordinator prompt until it passes. That is the
intended workflow — it is **not** a holdout-discipline violation here.

Scenarios arrive via the improvement playbook (M016 S05, #133): a wild miss surfaced by the
telemetry quality report (M016 S04, #132) is reproduced as a fixture + criteria here, then used
to drive a reviewer-definition change.

## Hard rule (the one-way door)

**Once you have tuned reviewer-definitions against a scenario in this directory, it may NEVER
be promoted/copied into `evals/scenarios/` (the holdout).** A tuned scenario is no longer
unseen; moving it into the holdout silently re-contaminates the gate (destroys holdout
discipline, #28). To strengthen the holdout, author a brand-new scenario from scratch (new
fixture, never used as a tuning target) directly in `evals/scenarios/`.

This rule is mechanically enforced against the obvious copy vector:
`test/evals-scoring.test.ts` asserts the holdout and dev splits are **disjoint by scenario
name and by fixture path**. Re-authoring a tuned scenario under a new name + new fixture would
slip past the test but is forbidden by the discipline above — at the file level it is
indistinguishable from a legitimately new scenario, which is exactly why the human rule
matters.

## Adding a dev scenario

Same shape as the holdout (see **`docs/developer/evals.md`** → "Adding a new scenario"), but the fixture
**must be distinct** from every holdout fixture (the disjointness guard enforces this):

1. Create a fixture in `evals/fixtures/<name>.json` (real diff, **no** `fakeFindings`), with a
   name that does not collide with any holdout fixture.
2. Create `evals/scenarios-dev/<name>.json` referencing it, with behavioral `criteria`.
3. Run it: `bun run evals --runtime dummy --scenarios evals/scenarios-dev` (shape check), then
   the real signal with `AI_REVIEW_LIVE_EVAL=1 bun run evals --scenarios evals/scenarios-dev`.

`bun run evals` with no `--scenarios` flag defaults to the holdout (`evals/scenarios`), which
is what the release gate uses — always pass `--scenarios evals/scenarios-dev` to iterate here.
