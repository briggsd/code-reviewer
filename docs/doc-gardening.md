# Doc gardening / knowledge-flywheel

Keeping agent-facing docs fresh is not cosmetic. Stale docs are *actively harmful*:
an agent loads outdated guidance and confidently does the wrong thing (context rot).
Telemetry across our own self-reviews showed the documentation reviewer producing
**52% of all findings** — shipping features makes docs stale faster than anything else,
and a full-tier LLM reviewer is an expensive way to rediscover that on every PR.

This page is the gardening playbook (closes #92 and #29): the deterministic checks that
catch the mechanical part cheaply, plus the recurring human/agent pass for the rest.

## Deterministic checks (`scripts/check-docs.ts`)

Pure rules live in `src/docs-check/` (unit-tested over plain strings, no IO); the CLI
wrapper `scripts/check-docs.ts` does the git/filesystem reads. Fast and no-network.

```bash
bun run docs:check    # BLOCKING — dead path / `bun run` script references → exit 1
bun run docs:stale    # ADVISORY — env-var / oversized-doc / repo-map / unclosed-fence drift → exit 0
bun run scripts/check-docs.ts --mode=all   # both, for local use
```

Every tracked `*.md` file is scanned. Reference extraction is deliberately narrow to keep
the **blocking** check free of false positives:

- **Path references** come only from inline code spans and markdown link targets — fenced
  code blocks are stripped first, so imports / `uses:` action refs / YAML never leak in as
  a "path". An inline-code path is checked only when it contains a `/` *and* its first
  segment is a real top-level repo entry (so `Bun.argv`, `@anthropic-ai/sdk`, and
  `actions/checkout@v4` are ignored, while `src/runner/run-review.ts` is validated).
  Markdown link targets resolve relative to the doc's own directory.
- **Script references** are the token after `bun run` (scanned across fences, since the
  canonical examples live in ```` ```bash ```` blocks); a token with a slash or dot is a
  file-path argument, not a `package.json` script.
- **Env-var references** are `AI_REVIEW_*` tokens, validated against a broad source-of-truth
  grep over `src`, `scripts`, `test`, `evals`, `.github`, and all tracked `*.yml`/`*.yaml`
  files (git's bare `*.yml` pathspec matches by basename across the tree, which includes
  `action.yml` at the repo root).

### What is blocking vs advisory, and why

| Check | Severity | Rationale |
| --- | --- | --- |
| Dead path reference | **blocking** | Authoritative source (the filesystem); near-zero false positives. |
| Dead `bun run` script | **blocking** | Authoritative source (`package.json` scripts). |
| Unknown `AI_REVIEW_*` env var | advisory | Adoption docs legitimately show *user-namespace* example vars (e.g. `secrets.AI_REVIEW_TOKEN`); a blocking check would false-positive on them. |
| Oversized live doc (> 200 lines) | advisory | A staleness smell, not an error. |
| `src/<dir>/` missing from the CLAUDE.md repo map | advisory | Catches a new module the map forgot. |
| Unclosed ```` ``` ```` code fence | advisory | The rest of the doc is treated as fenced, so references after it are not validated — close the fence. |

**Milestone docs (`docs/milestones/**`) are historical records** — append-only snapshots of
past state that reference paths which legitimately no longer exist. They are exempt from the
blocking path/script rules (the env-var advisory still applies).

The blocking half runs in CI's `check` job and in `bun run gate`; the advisory half runs in
CI's `quality` job (continue-on-error). Adding a check to `gate` means a feature PR that moves
a file or renames a script must update the docs in the same change — staleness becomes a
failing check, not a future LLM finding.

Note one coverage caveat: an **unclosed code fence** blanks the rest of a doc, so dead
references after it are silently skipped by the *blocking* check. Because that signal is
advisory, it does **not** surface in `bun run docs:check` / `gate` output (only in
`docs:stale` / the quality job) — so a fence typo can mask a real dead reference in the
blocking workflow. Run `bun run docs:stale` (or `--mode=all`) if a doc's references seem
under-checked, and keep fences balanced.

## The recurring gardening pass

The linter only catches *mechanical* staleness (dead refs). Semantic rot — a doc that
describes a shipped capability as "deferred", a non-goals list naming a feature that now
exists, duplicated/contradictory guidance — still needs a periodic read-through. Run it as a
manual `/loop` or a scheduled pass.

What to do:

- Read `docs/`, the `CLAUDE.md` map, and the roadmaps; reconcile claims against the code.
- Prune obsolete/duplicated content; fold recurring review findings back into `CLAUDE.md`,
  the reviewer definitions, or a lint rule (close the flywheel).
- Open **small, scoped** fix-up PRs — one concern per PR, easy to review and revert.

What **not** to touch:

- **`continue.md`** is LOCAL/UNTRACKED machine-only session state (gitignored) — never commit
  it, never treat it as a doc to publish.
- **Eval scenarios under `evals/`** are a holdout set. Do not tune docs/prompts against them.
- Milestone summaries are history; correct them only for factual errors, not to rewrite the past.

## Deferred

- **#29 S04 — reference-load signal.** Tracking which docs are actually read during agent
  sessions (a usefulness proxy; zero-reference docs become deletion candidates) needs session
  telemetry we don't yet collect. Deferred until that signal exists.
