# M002 Roadmap — Re-review state foundation

## Vision

Make a second review of the same PR/MR aware of the first one. Before adding inline comments or discussion resolution, the runner needs stable finding identities, parseable prior bot metadata, and explicit state transitions for fixed/still-present/acknowledged/disputed findings.

## Success Criteria

- Every finding in a completed review has a deterministic stable ID unless an adapter/runtime supplied one explicitly.
- Summary hidden metadata includes enough finding identity information to seed future re-review.
- Provider adapters can parse prior bot summary metadata from existing comments/notes.
- Re-review logic can classify prior findings as still present or absent without relying on comment text as the only source of truth.
- Existing summary-only publishing remains idempotent and safe.

## Slices

- [x] **S01: Stable finding IDs** `risk:medium` `depends:[]`
  > After this: all review summaries include deterministic finding IDs derived from reviewer/category/location, and published hidden metadata records those IDs. (title/body were removed from the hash in #31 — model prose is volatile and broke recurrence matching.)

- [x] **S02: Prior summary metadata parser** `risk:medium` `depends:[S01]`
  > After this: GitHub/GitLab adapters can recover prior run metadata from existing bot summary comments/notes instead of only finding the comment to update.

- [x] **S03: Prior state loading path** `risk:medium` `depends:[S02]`
  > After this: provider-backed review runs can load `PriorReviewState` into `ReviewContext.priorState` before agents run.

- [x] **S04: Fixed-vs-still-present summary classification** `risk:high` `depends:[S03]`
  > After this: summaries can distinguish new, recurring, and fixed prior findings using stable IDs, without resolving provider threads yet.

- [x] **S05: Re-review docs and fixtures** `risk:low` `depends:[S04]`
  > After this: docs and fixtures explain how re-review state works and how future inline/discussion resolution should consume it.

## Key Risks

- IDs may churn if generated from volatile text or line numbers only.
- Prior comments can be edited by humans or malformed.
- Summary metadata should remain hidden and parseable without making comments the canonical state store.
- Re-review classification can accidentally hide a serious recurring issue if matching is too loose.

## Proof Strategy

- Unit tests for deterministic ID generation and preservation of runtime-supplied IDs.
- Adapter tests for prior metadata parsing from existing bot comments/notes.
- Runner tests for prior state reaching `ReviewContext`.
- Summary tests for new/recurring/fixed classification.

## Verification Classes

- **Static:** TypeScript compile and existing tests.
- **Unit:** stable ID generation and metadata parser tests.
- **Adapter:** fake GitHub/GitLab comment/note responses.
- **Integration:** fixture-backed re-review with prior state.

## Definition of Done

- S01–S05 complete.
- `bun run check` and `bun run pack:smoke` pass.
- Existing summary publishing still updates prior bot summary comments/notes idempotently.
- No inline comments/discussions are published by default.

## Boundary Map

- S01 produces stable `Finding.id` values consumed by all later slices.
- S02 consumes hidden metadata and provider comment/note APIs to produce prior run metadata.
- S03 consumes adapter prior metadata and injects it into `ReviewContext.priorState`.
- S04 consumes prior state plus current stable IDs to classify findings.
- S05 captures the invariants future inline publishers and discussion resolvers must preserve.
