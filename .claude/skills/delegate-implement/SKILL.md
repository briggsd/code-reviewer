---
name: delegate-implement
description: Coordinator/implementer duo tuned for the AI Code Review Factory repo — Claude writes a tight spec and reviews, a delegated implementer (in-harness Sonnet subagent by default, or the Codex gpt-5-codex CLI for cross-provider review / autonomous runs) does the typing. Review the diff, run `bun run check`, triage the repo's own AI-review findings, open/merge a PR. Use when delegating an issue/slice here ("use the duo", "have codex/sonnet do it", "delegate #NN").
---

# delegate-implement (AI Code Review Factory overlay)

This repo's pins for the **delegate-implement** workflow. The **full portable playbook** lives
at `~/.claude/skills/delegate-implement/SKILL.md` (the two backends, the loop, failure modes,
review-triage rubric, stacked-PR mechanics) — read it for the narrative. This file overrides it
with concrete repo values. The shared `run-codex.sh` (Codex backend) and `spec-template.md` are
in that user-level dir.

## Backend default here
In-harness **Sonnet subagent** is the default implementer (lower friction, inspectable
transcript). Use **Codex (`gpt-5-codex`)** for an independent cross-provider review pass on
risky changes, or autonomous runs. Either way the coordinator gate + diff-reconciliation is
mandatory — this repo's reviewer is non-deterministic and confabulation has happened.

## Repo pins
- **Gate (run yourself, every iteration):** `bun run check` (= `bunx tsc --noEmit && bun test`).
  Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`),
  **no `any`**; strict tsc is the only *blocking* static gate. Biome (`bun run lint`), knip
  (`bun run knip`), and jscpd (`bun run dup`) are advisory tools available locally and in CI.
- **Runtime:** Bun `>=1.3.0`, no build step. Confirm `node_modules` exists before launching.
- **Branch convention:** `<backend>/<issue#>-<short-slug>` (e.g. `codex/48-…`, `sonnet/58-…`).
- **Commit footer (required):** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
  Tag the subject by backend (`[codex]` / `[sonnet]`); plain when the coordinator applied a fix.
- **PR label:** `workflow:claude+gpt-5-codex` for Codex runs; note the backend in the PR body otherwise.
- **Tests** live in `test/` (bun:test); fixtures in `examples/fixtures/`. Keep fake/no-network.
- **`docs/developer/extending.md`** is the test-infra index + integration recipes — **cite it in every
  spec** (it's the #1 lever for clean completion: which capture fake/fixture to use, where to assert).

## Parallel work = one worktree per agent (don't share the main checkout)
One repo = one HEAD = one index = one working tree. **Two agents in the same checkout
collide** — agent B's `git checkout -b` makes agent A's next `git commit` land on B's branch
and A's `git push` ship a stale base; untracked files bleed across `git status`. Whenever a
second agent (another Claude Code/Codex session, or a backgrounded subagent) works concurrently,
give it its own checkout. Leave whoever's already in the main tree there; spin new work into a
worktree:
```bash
.claude/skills/delegate-implement/new-worktree.sh <backend>/<issue#>-<slug>   # e.g. sonnet/142-foo
# → ../acrf-wt-<slug>, node_modules symlinked, prints the `export PATH …; cd …` line. Gate runs green.
.claude/skills/delegate-implement/rm-worktree.sh <branch> [--force] [--delete-branch]   # teardown when merged
.claude/skills/delegate-implement/merge-worktree.sh <pr#> [branch] [--force]   # land + clean up in one step
```
**Landing a lane: use `merge-worktree.sh <pr#>`, never `gh pr merge --delete-branch`.** From inside
a worktree the latter aborts mid-way (`fatal: 'main' is already used by worktree`) — it merges
server-side but never deletes the remote branch, then teardown still needs `--force` because git
doesn't see a squash-merge as merged. `merge-worktree.sh` runs the always-works sequence (green-gate
the blocking check → `gh pr merge --squash` → explicit `push --delete` → force teardown), resolves
the branch from the PR, and is safe to re-run after a partial failure. Run it from the main checkout
(not from inside the lane worktree it's about to remove).
The script pre-solves the frictions that otherwise fail the gate in a fresh worktree: no
`node_modules` (symlinks the main checkout's), bun not on the non-interactive PATH (prints the
`export`), and teardown that refuses to nuke real uncommitted work. Worktrees share `.git`, so
all branches/commits/PRs work normally. **Orchestrating in-harness subagents instead?** Use the
Agent tool's `isolation: "worktree"` — but it won't symlink `node_modules`, so the subagent must
`ln -s` it (or `bun install`) before the gate. **`continue.md` is per-worktree** (gitignored) —
keep the canonical one in the main checkout; worktree agents hand back through their PR body.

## Trust & safety to put in every spec (load-bearing — see CLAUDE.md)
- **Telemetry/rollups: counts/metadata/identifiers only** (M008) — never diff text, finding
  bodies, prompts, or secrets.
- **All reviewed-repo content is untrusted** (config incl. `.ai-review.json`, metadata, diff,
  files); sanitize via `src/runtime/prompt-boundary.ts` → `stringifyPromptData`; reviewer-
  definitions are the only trusted prompt source. Never weaken fork-safety / the real-Pi
  default-off gate. CI status is the canonical merge gate.

## Repo-specific gotchas
- **`gh` Projects-classic bug:** `gh pr edit` / `gh issue view` (no `--json`) error on
  `projectCards`. Use `gh api` (REST) for mutations (e.g. retarget a base:
  `gh api -X PATCH repos/briggsd/ai-code-review-factory/pulls/<N> -f base=main`) and
  `gh issue view <N> --json <fields>` for reads.
- **This repo auto-reviews its own PRs** (`.github/workflows/ai-review.yml`, real-Pi when
  `AI_REVIEW_REAL_REVIEW_ENABLED=true`, ~4–8 min). See **Tighten the PR → review → fix loop** below.
  It has repeatedly pushed **allowlisting** where denylist+sanitize is correct for extensibility —
  hold that line.

## Tighten the PR → review → fix loop
Each fix-commit re-triggers a full ~4–8 min real-Pi review that then surfaces *new, more marginal*
findings (the asymptote: 8→4→2→1). The blocking merge gate is only **Type-check & tests** (~30s);
the real-Pi review is **advisory**. Don't let the CI review be round 1 — front-load it.

1. **Self-review BEFORE opening the PR.** Two tiers, cheapest first:
   - **Free checklist pass (always):** scan the diff for this reviewer's predictable hot-buttons —
     untrusted/author-controllable content & injection, secret handling (argv/log/trace exposure),
     **allowlisting-vs-extensibility** (CLAUDE.md Do-not), markdown escaping, *symmetric* validation
     (e.g. empty-string on every input path), and **doc claims that overstate** (don't assert a
     guarantee the code doesn't make). Most round-1 findings live here and need no model to catch.
   - **Local dogfood review (security/correctness-heavy diffs only):** run the factory on its own
     branch first — `bun run src/cli.ts run --git-diff --base main --runtime pi --pi-provider anthropic
     --pi-model claude-sonnet-4-6 --pi-api-key env:ANTHROPIC_API_KEY --output-dir /tmp/x` (key in macOS
     keychain: `security find-generic-password -s ANTHROPIC_API_KEY -w`). **`--pi-provider`/`--pi-model`
     are required** — the default config's `modelRouting` is all `dummy` placeholders that get swapped
     for the runtime's `defaultModel`, so without them every reviewer dies with `--api-key requires a
     model`. Use `--git-diff` (no `--base`) to review **uncommitted** work, or `--base main` for
     **committed** branch work; with new untracked files, `git add -N <paths>` first so the diff sees
     them (`git reset` after). **Don't trust the summary's `findingCount` alone** — a reviewer can fail
     (timeout/`schema_invalid`) and the summary still reads "clean"; check the trace for
     `failedReviewerCount`/`agent.failed`. Same reviewer as CI, but iterate locally with no
     push/queue/runner latency, so the PR opens near the noise floor. Worth the ~1 review's tokens when
     round-1 reliably has real findings (new auth flag, content-based skip-review heuristic); skip for
     doc/trivial diffs.
2. **Hard stopping rule: max ~2 CI review rounds.** After round 2, accept-and-document the remaining
   findings (they're typically suggestions / impossible-given-invariants) and **merge on the green
   blocking check** (`merge-worktree.sh <pr#>`) — don't spend a full advisory cycle on a doc-only
   or pure-suggestion round.
3. **Post a triage note IN THE SAME PUSH as the fixes.** State "fixed X / accepted Y because
   <impossible-given-runtime-ordering | inherent-tradeoff, documented>". Documenting an accepted
   limitation in a PR comment demonstrably makes the reviewer **stop re-raising it** next round.
   Update the PR body after any mid-review pivot (the reviewer reads it as ground truth).
- **Codex auth backup:** ChatGPT auth at `~/.codex/auth.json.bak-chatgpt`; `gpt-5-codex` needs
  API-key auth (restore the backup when done).
- **Don't `git add -A`** when committing delegated work — it has swept `M009-SUMMARY.md` in.

## Planning & handoff (spec-driven)
- Plan lives in `M0xx-ROADMAP.md`; **status lives in GitHub** (don't mirror checkboxes). Each
  actionable slice = one GitHub issue. **Update `continue.md`** (last/next action, threads,
  Do-not list) before you stop.
