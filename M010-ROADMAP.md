# M010 Roadmap Stub — Shared context files and token economics

> Stub status: tentative. Build this out after prompt modules exist, because prompt shape and context shape should be designed together.

## Vision

Stop embedding the full diff in every reviewer prompt. Write shared change context and per-file patches once, pass stable file paths/references to reviewers, and measure the token/cost savings.

## Source Issue

- GitHub #11 — Shared context files passed by path

## Tentative Success Criteria

- `ReviewContext.contextDirectory` is actively populated with shared context and per-file patch artifacts.
- Reviewer prompts receive context references/paths and only the patches they need, rather than the full diff duplicated in every prompt.
- Prompt layout keeps large shared prefixes stable where possible for provider prompt caching.
- Trace/run metrics expose context bytes and per-reviewer token deltas so savings are measurable.
- Package smoke proves context artifacts work from an adopter-like install, not only a source checkout.

## Tentative Slices

- [x] **S01: Shared context writer** `risk:high` `depends:[]` `issues:[#11]`
  > After this: the runner writes a shared change-context file plus per-file patch files under `contextDirectory` with safe paths and deterministic names.
  > Implemented: `writeReviewContextArtifacts` writes `change-context.json` plus `patches/*.patch`, adds `patchPath` references to filtered changed files, strips patch bodies from the shared context JSON, and exposes artifact byte counts on `ReviewContext.contextArtifacts` plus `context.built` trace data.

- [x] **S02: Reviewer context assignment by reference** `risk:high` `depends:[S01]` `issues:[#11]`
  > After this: reviewer inputs carry selected context references instead of embedding the entire diff payload.
  > Implemented: `ReviewerRunInput.contextReferences` now carries the shared context path, patch directory, and assigned file metadata without inline patch bodies. The runner builds references from assigned files and existing `patchPath`s while keeping full `ReviewContext` available as the fallback compatibility channel until S03 changes prompt rendering.

- [x] **S03: Runtime prompt rendering for path-based context** `risk:high` `depends:[S02]` `issues:[#11]`
  > After this: Pi prompts instruct reviewers to read trusted context files by path while reviewed-repo Pi resources remain disabled.
  > Implemented: Pi reviewer prompts now prefer `contextReferences` and instruct reviewers to read only the trusted shared context/patch paths while treating file contents as untrusted reviewed-repo data. When read tools are unavailable, prompts fall back to inline context data for compatibility.

- [x] **S04: Token/cost measurement for context savings** `risk:medium` `depends:[S03]` `issues:[#11]`
  > After this: traces expose context bytes and per-reviewer token usage before/after path-based context.
  > Implemented: run metrics now include context artifact byte counts, reviewer results/agent metrics can carry prompt metrics, and Pi reviewer runs report prompt bytes, context payload bytes, inline-diff bytes, context mode, and estimated input tokens saved by path references.

- [ ] **S05: Package/docs verification sweep** `risk:medium` `depends:[S01,S03,S04]` `issues:[#11]`
  > After this: docs explain context artifact behavior and package smoke verifies the files are present and consumable.

## Open Design Questions

- How much diff filtering belongs in the runner vs reviewer-domain modules?
- Should reviewers get all patch file paths or only files selected by risk/domain routing?
- What is the fallback when a runtime cannot read local context files by path?
