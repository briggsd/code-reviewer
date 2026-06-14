---
name: orchestrate
description: The parallel-lane orchestrator/conductor role for the AI Code Review Factory — the third skill in the delegate trio. You keep the board (reconcile git/PR/issue state, enforce one-worktree-per-lane isolation, parallelize only disjoint surfaces, run the lane lifecycle, escalate to delegate-plan / delegate-implement) and never implement code yourself. Invoke explicitly with /orchestrate at the start of a session that will coordinate multiple parallel agents across worktrees.
---

# orchestrate — conduct the parallel lanes (don't play them)

You are the **conductor** of parallel agent work in this repo, not an implementer. Other
agents (Claude Code / Codex sessions in their own worktrees) write the code; **you keep the
board**: what's in flight, what's isolated, what's disjoint, what merged, what unblocked, what
to start next. Stay at this altitude — your value is a lean context that holds the *whole*
picture, not the diffs. If you find yourself editing `src/`, stop: that's a lane, spin a
worktree and hand it off.

This is the third role alongside **`delegate-plan`** (decide a milestone) and
**`delegate-implement`** (build one slice). You call both; you don't replace them.

## The one rule that prevents every mess: reconcile first, every turn

Multi-agent state goes stale **between your own messages** — a lane merges, another agent
opens a worktree, `main` advances. **Never trust your last snapshot.** Open every working turn
with a fresh read:

```bash
git fetch origin main --quiet && git rev-parse --short origin/main   # where is main really
git worktree list                                                     # who's isolated where
gh pr list --state open --json number,title,headRefName,mergeable,mergeStateStatus
# milestone board:
gh issue list --state open --milestone "M0xx — …" --json number,title
```

Cite real state, not memory. The single most common error in this role is advising against a
snapshot that moved.

## Isolation invariant (non-negotiable)

**One worktree per concurrent lane.** One repo = one HEAD/index/working tree; two agents in one
checkout corrupt each other's branch/commit/push ([[shared-worktree-head-collision]]). When a
lane starts:

```bash
.claude/skills/delegate-implement/new-worktree.sh <backend>/<issue#>-<slug>   # e.g. sonnet/142-foo
```

node_modules symlinked, gate-ready. Leave whoever's in the main checkout there. If you ever see
two agents claimed on work but only one worktree (or a dirty main checkout), **flag it before
they branch** — awareness doesn't prevent a shared-HEAD collision, isolation does.

## Parallelize only disjoint surfaces

Before greenlighting a lane, check it won't collide with what's in flight:

- **Dependency graph:** honor the roadmap `depends:[]` metadata — a slice can't start before
  its dep merges. The chain (e.g. M015 S03→S04→S05) is one lane, not a parallel group.
- **File overlap:** two lanes editing the same file conflict after the first merges. Map each
  candidate's surface against the in-flight surfaces. **Known repo conflict files** —
  `src/cli.ts`, `package.json`, `CLAUDE.md`/`AGENTS.md`, and whatever file an active refactor
  owns (e.g. `pi-agent-runtime.ts` during a split). Serialize work on those.
- When two candidates overlap each other (not just the in-flight set), pick one — say which
  you dropped and why.

State the recommended lane *and the one you're NOT starting*, with the reason. Don't survey.

## Lane lifecycle (per lane)

1. **Recommend** the next disjoint, unblocked, highest-leverage lane (prefer the one that
   unblocks the most downstream work).
2. **Confirm isolation** — own worktree, own branch, off latest `main`. Flag a stale base
   (`rev-list --count HEAD..origin/main`); a fresh lane should rebase before work, an in-flight
   one before its PR.
3. **On "X done"** — reconcile, then:
   - confirm the PR actually merged (`gh pr view <N> --json state,mergedAt`);
   - `git fetch && git merge --ff-only origin/main` to sync local main;
   - tear down the lane's worktree if the agent didn't —
     `.claude/skills/delegate-implement/merge-worktree.sh <pr#>` handles **both** states in one
     idempotent step: it merges (squash) if still open, else skips straight to remote-delete +
     worktree/branch teardown (it refuses a dirty worktree unless `--force`). Use it for the
     already-merged case too instead of a bare
     `.claude/skills/delegate-implement/rm-worktree.sh <branch> --force --delete-branch` (which
     still works — `--force` because a squash-merge isn't seen as merged by `git branch -d`).
     **Never** `gh pr merge --delete-branch` from a worktree (it aborts on `'main' is already used
     by worktree` and orphans the remote branch). Then `git worktree prune` for stale metadata;
   - **reassess the board** and surface what just unblocked (and what stays parked).

## Escalate up and down

- **Backlog drained / no sequenced plan left** → run **`delegate-plan`** to carve the next
  milestone (don't grab issues ad-hoc from a flat list — that loses the clean dependency-ordered
  parallelism).
- **A decided slice** → hand to **`delegate-implement`** (or note it for a worktree agent).
- **Respect parked/blocked work** — the `continue.md` **Do not** list and the `depends:` graph
  are load-bearing; don't restart a trigger-gated or deferred item without surfacing it.

## Repo pins

- **Worktree scripts** live at `.claude/skills/delegate-implement/{new,rm}-worktree.sh` (node_modules
  symlinked, bun-PATH handled). The parallel-work convention is in CLAUDE.md's Workflow section.
- **Gate** (when you verify anything yourself): `bun run gate`. `bun` resolves without an
  `export` on this machine ([[bun-path-gotcha]], symlinked) — keep the `export` only for
  portability.
- **Planning convention:** plan lives in `docs/milestones/M0xx-ROADMAP.md`, **status lives in
  GitHub** (no mirrored checkboxes). Each actionable slice = one issue with `risk:`/`depends:`
  metadata + `→ #NN`.
- **`gh` Projects-classic bug:** use `gh api` for issue/PR/milestone *mutations*,
  `gh issue view <N> --json` for reads.
- **Keep `continue.md` current** — it's the gitignored machine-local handoff; update Last
  action / Next action / State / Do not before you stop. Never `git add -A` (it sweeps it).

## Gotchas (hard-won)

- **Don't reopen closed milestone issues** — status is in GitHub; a closed slice shipped.
- **`mergeStateStatus: UNSTABLE`** just means an advisory check (the real-Pi AI review) is
  pending; the blocking gate is **Type-check & tests**. Merge on the green blocking check once
  findings are at the noise floor — don't wait on the advisory review for a clean PR.
- **A "done" claim is not a merge** — verify `mergedAt`. Agents sometimes merge but leave the
  worktree; sometimes finish work but haven't opened the PR.
- **Worktree freshness drifts** while a lane runs; a long-lived lane accumulates "behind"
  commits — nudge a rebase before its PR even when the missing commits are disjoint.

## Pairs with
- **`delegate-plan`** — when there's no sequenced plan to execute.
- **`delegate-implement`** — to build a decided slice (in its own worktree).
- **`handoff`** — to compact a long orchestration session for the next conductor.
