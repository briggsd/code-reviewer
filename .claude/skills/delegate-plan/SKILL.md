---
name: delegate-plan
description: Spec-driven strategic/milestone planning loop tuned for the AI Code Review Factory repo — Claude grounds in the codebase + existing decision records, surfaces the genuine forks, pressure-tests its own plan, then emits an M0xx roadmap stub in house style, files the GitHub milestone + per-slice issues, and updates continue.md. Use for high-level/strategic planning, not implementation ("let's step back and plan", "high level planning session", "plan the next milestone / M0xx", "design the next era", "delegate-plan"). For implementing a decided slice, use delegate-implement instead.
---

# delegate-plan (AI Code Review Factory)

The planning counterpart to **delegate-implement**. That skill offloads *typing a decided
slice*; this one runs the *deciding* — strategic/milestone planning grounded in this repo's
spec-driven M0xx convention. Output is a roadmap stub + filed issues + a clean `continue.md`
handoff, never code. When a fork is genuinely the user's to make, recommend then ask
(`AskUserQuestion`) — don't decide for them; when it's a fact you can verify, verify it.

## The loop

1. **Recon before opining (don't re-derive).** Read `continue.md` first (last/next action,
   open threads, **Do not** list), then the relevant `docs/milestones/M0xx-ROADMAP.md`
   (+`-SUMMARY.md`), the contracts/docs the topic touches, and any **decision record** that
   already weighed this (`docs/runtime-comparison.md`, architecture.md, prior summaries).
   Reconcile `continue.md` against real state — `git log --oneline -5`, `git status`, open
   PRs/issues — it's a snapshot and goes stale (a shipped PR or a parallel agent's commit
   may have moved things). Cite `file:line`; don't assert from memory.
   **Lift to the consumer altitude before deciding anything.** Ask *who runs this once
   shipped* — the vision (CLAUDE.md:1) is a multi-repo shared runner installed across many
   repos, configured per-project, the core never forked. Current artifact state can pull you
   the wrong way (`package.json` `private:true`/v0.x, `release-package.yml` tarball-only, no
   adopters yet) — that reads as "internal prototype" but the *intent* is a published product.
   For any capability you're planning, check whether decisions change at the **publish/adopter
   boundary**: who configures it (`.ai-review.json` vs trusted factory code), where quality/
   telemetry/secrets cross from factory to adopter or back, and whether the gate belongs at a
   PR or at *publish*. Missing this altitude once produced a "factory-internal / dogfood-only"
   plan that had to be re-scoped when external adopters were named.

2. **Surface the genuine forks, then ask.** Pull up to the altitude where the decision
   actually branches. Present 2-4 *real* strategic options (not a survey), give a
   recommendation, and resolve via `AskUserQuestion`. One decision per question; the choice
   must change what happens next, not be a default you could pick yourself.

3. **Pressure-test — don't rubber-stamp your own plan.** Check the plan against the repo's
   own decision records and the **Do-not** list *before* writing it up. Cheaply verify the
   load-bearing claim (grep the dependency, read the contract, check the installed package's
   docs/examples) — feasibility is often already settled in-repo, and a 5-minute offline
   check beats a wrong premise. Re-scope the goal honestly when evidence shifts it (e.g.
   "delete the path" → "demote it" once you learn it can't be forced). Size to the evidence:
   prefer a 3-slice focused effort over a 6-slice milestone unless the scope earns it.

4. **Emit the roadmap stub in house style.** `docs/milestones/M0xx-ROADMAP.md`, modelled on
   **M013-ROADMAP.md** (the reference format). Required shape:
   - `> Stub status: tentative.` header naming the source/trigger of the plan.
   - **Vision · The gap, precisely · Decision · Source Issues · Success Criteria ·
     Cross-Milestone Boundary · Slices · Decision record.**
   - Slices as `- **S0N — title** → #NN · risk:low|med|high · depends:[S0M]` + a `>` rationale
     blockquote. **No `[x]`/`[ ]` checkboxes.** "Status lives in GitHub" disclaimer above the
     slice list — the roadmap is plan+rationale, never hand-updated when an issue closes.
   - Run `bun run docs:check` after writing (milestone docs are exempt from *blocking*, but
     keep dead refs at zero anyway).

5. **File the milestone + per-slice issues.** One GitHub issue per actionable slice.
   `gh api repos/:owner/:repo/milestones -f title="M0xx — …" -f state=open -f description=…`,
   then `gh issue create --milestone "M0xx — …" --label … ` per slice. Backfill the real
   issue numbers into the roadmap (`#TBD` → `#NN`, both Source Issues and slice headers).
   Labels here: `resilience` / `security` / `observability` / `enhancement` /
   `priority:high|medium|low`.

6. **Hand off.** Prepend a new `## Last action` block to `continue.md` (push the prior one to
   `## Previous action`); update the title line, **Next action**, **State**, and **Do not**
   (add the new milestone + closed-issue guards). `continue.md` is gitignored machine-local
   state — no commit, but it's **unrecoverable**, so don't clobber it; edit in place.

## Repo pins
- **House-style reference:** `docs/milestones/M013-ROADMAP.md`. CLAUDE.md's "How work is
  planned here" is the canonical convention (plan in roadmap, status in GitHub, no mirrored
  checkboxes, `risk:`/`depends:` slice metadata, `→ #NN` issue links).
- **`gh` Projects-classic bug:** `gh pr edit` / `gh issue view` (no `--json`) error on
  `projectCards`. Use `gh api` for milestone/issue *mutations* and `gh issue view <N> --json`
  for reads. `gh issue create` and `gh issue comment` work directly.
- **Sequencing reality:** flag slices that touch a file a parallel agent is editing
  (`pi-agent-runtime.ts`, `cli.ts`, `package.json`/`CLAUDE.md`) — they conflict after the
  first PR merges. State the order/gate in the roadmap's **Sequencing** note; re-check before
  picking up.
- **Don't `git add -A`** if you do commit the roadmap — stage the explicit
  `docs/milestones/M0xx-ROADMAP.md` path; `continue.md` is gitignored and must never be swept in.

## Boundaries to respect while planning (from CLAUDE.md / Do-not)
- **Don't plan against the holdout.** `evals/` scenarios are a true holdout (#28) — a plan may
  *gate* on them, never *tune reviewer-definitions to pass them*.
- **Counts-only telemetry** (M008): no diff/finding/prompt/secret text in any proposed rollup.
- **Fork-safety + real-Pi default-off gate + CI-as-canonical-gate** are non-negotiable design
  principles — a plan that weakens them needs an explicit, surfaced user decision.
- Escalations/runtime swaps stay **behind the `AgentRuntime` seam**; don't propose changes that
  leak adapter concerns above the contract line or allowlist extensibility points to closed sets.

## Pairs with
- **`grill-me`** — run it on a draft plan to stress-test before filing.
- **`delegate-implement`** — hands the filed slices off to an implementer.
- **`handoff`** — compact a long planning session if you're switching agents mid-stream.
