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
- **`docs/extending.md`** is the test-infra index + integration recipes — **cite it in every
  spec** (it's the #1 lever for clean completion: which capture fake/fixture to use, where to assert).

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
  `AI_REVIEW_REAL_REVIEW_ENABLED=true`, ~4–8 min). Apply the real/hold/defer triage + noise-floor
  stop. It has repeatedly pushed **allowlisting** where denylist+sanitize is correct for
  extensibility — hold that line.
- **Codex auth backup:** ChatGPT auth at `~/.codex/auth.json.bak-chatgpt`; `gpt-5-codex` needs
  API-key auth (restore the backup when done).
- **Don't `git add -A`** when committing delegated work — it has swept `M009-SUMMARY.md` in.

## Planning & handoff (spec-driven)
- Plan lives in `M0xx-ROADMAP.md`; **status lives in GitHub** (don't mirror checkboxes). Each
  actionable slice = one GitHub issue. **Update `continue.md`** (last/next action, threads,
  Do-not list) before you stop.
