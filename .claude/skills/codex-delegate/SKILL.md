---
name: codex-delegate
description: Delegate an implementation task to the Codex CLI (gpt-5-codex) while Claude coordinates, tuned for the AI Code Review Factory repo. Write a spec, run codex non-interactively, review the diff, run `bun run check`, triage the repo's own AI-review findings, and open/merge a PR. Use when the user wants Codex to implement an issue/slice here while keeping Claude's context lean ("use the codex duo", "have codex do it", "delegate #NN to gpt-5-codex").
---

# codex-delegate (AI Code Review Factory overlay)

This repo's pins for the **codex-delegate** workflow. The **full portable playbook** lives at
`~/.claude/skills/codex-delegate/SKILL.md` (the loop, failure modes, review-triage rubric,
stacked-PR mechanics) — read it for the narrative. This file overrides it with concrete
repo values. The shared `run-codex.sh` and `spec-template.md` are in that user-level dir.

## Repo pins

- **Gate (run yourself, every iteration):** `bun run check` (= `bunx tsc --noEmit && bun test`).
  Strict TS everywhere: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, **no `any`**. There's no linter — strict tsc is the only static gate.
- **Runtime:** Bun `>=1.3.0`, no build step (Bun runs `.ts` directly). Confirm `node_modules`
  exists before launching (Codex runs the gate offline under `workspace-write`).
- **Branch convention:** `codex/<issue#>-<short-slug>` (e.g. `codex/48-telemetry-artifact-capture`).
- **Commit footer (required):** end every commit message with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. Tag the subject
  `[codex]` when Codex authored the change; plain when you applied the fix directly.
- **PR label:** add `workflow:claude+gpt-5-codex` to PRs/issues from this workflow.
- **Tests** live in `test/` (bun:test); fixtures in `examples/fixtures/`. Keep them
  fake/no-network — the default suite never hits the network.

## Trust & safety boundaries to put in every spec (load-bearing — see CLAUDE.md)

- **Telemetry is counts/metadata/identifiers only** (the M008 boundary): never diff text,
  finding bodies, prompts, repo file content, or secrets.
- **All PR/MR content is untrusted**; user-controlled metadata is sanitized in
  `src/runtime/prompt-boundary.ts`. Reviewer-definitions are the only trusted prompt source.
- Never weaken fork-safety: reviewed-repo Pi/project resources stay disabled in CI; never
  expose provider secrets or disable the real-Pi default-off gate.
- CI status is the canonical merge gate; comments/reviews are UX only.

## Repo-specific gotchas

- **`gh` Projects-classic bug:** `gh pr edit` and `gh issue view` (no `--json`) hit a
  `repository...projectCards` GraphQL deprecation error on this repo. Workarounds: use
  `gh api` (REST) for mutations (e.g. retarget a PR base:
  `gh api -X PATCH repos/briggsd/ai-code-review-factory/pulls/<N> -f base=main`) and
  `gh issue view <N> --json <fields>` for reads.
- **This repo auto-reviews its own PRs** (`.github/workflows/ai-review.yml`, real-Pi review
  when `AI_REVIEW_REAL_REVIEW_ENABLED=true`, ~4–8 min). Expect a findings comment per push.
  The reviewer is **non-deterministic** and trends toward "must-find-something" — apply the
  real/hold/defer triage and the noise-floor stop rule from the portable playbook. It has
  repeatedly pushed allowlisting where denylist+sanitize is correct for extensibility —
  hold that line.
- **Codex auth backup:** ChatGPT-account auth saved at `~/.codex/auth.json.bak-chatgpt`;
  restore with `cp ~/.codex/auth.json.bak-chatgpt ~/.codex/auth.json` when done dogfooding
  the API-key auth that `gpt-5-codex` requires.

## Planning & handoff (this repo is spec-driven)

- Plan lives in `M0xx-ROADMAP.md` (vision/sequencing/slices); **status lives in GitHub**
  (milestone bar + issue state) — don't mirror checkboxes into roadmaps.
- Each actionable slice = one GitHub issue in the matching milestone.
- **Update `continue.md`** (the session handoff: last/next action, open threads, Do-not list)
  before you stop.
