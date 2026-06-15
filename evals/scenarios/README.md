# `evals/scenarios/` — the SEALED HOLDOUT

> **This directory is the locked holdout. It is GATE-ONLY. Do not iterate against it.**

These scenarios measure review quality on diffs the reviewer has **never been tuned to
pass**. That property is the entire value of the set: it is the only honest signal that a
reviewer-definition change has not regressed quality for the external adopters who inherit
`src/runner/reviewer-definitions.ts` unchanged. The release gate (M016 S02, #130) runs this
directory; a regression below threshold blocks the release.

## Hard rules (holdout discipline — #28)

1. **Never tune `src/runner/reviewer-definitions.ts` or the coordinator prompt to make a
   scenario here pass.** If a holdout scenario underperforms, that is a *signal to
   investigate*, not a fixture to memorize. Tuning against the holdout turns the gate into a
   memorization check and destroys it.
2. **Never read these scenarios as a target while editing reviewer prompts.** Treat the
   contents as unseen.
3. **Never promote a `evals/scenarios-dev/` scenario into this directory after it has been
   tuned against.** A dev scenario that the reviewer was adjusted to pass is, by definition,
   no longer unseen — copying it here re-contaminates the holdout. To strengthen the holdout,
   author a genuinely **new** scenario from scratch (new fixture, never used as a tuning
   target).

## Where new scenarios are born

New behavioral cases are distilled into **`evals/scenarios-dev/`** (the iteration split) via
the improvement playbook (M016 S05, #133). The dev split is the legal material you may read,
grow, and tune against. This holdout grows only with fresh, never-tuned scenarios.

## Mechanical guard

`test/evals-scoring.test.ts` asserts the holdout and dev splits are **disjoint by scenario
name and by fixture path** — so a tuned dev scenario cannot be silently copied in. The
re-authored-from-scratch case is covered by the documented discipline above (it is
indistinguishable from a new scenario at the file level, and that is the point).

See **`docs/developer/evals.md`** for the harness, scoring, and how to add a scenario.
