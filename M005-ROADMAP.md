# M005 Roadmap — Inline UX hardening and GitLab live confidence

## Vision

Make the experimental GitHub inline comments feel production-grade enough for trusted adopters, while reducing provider risk by proving the GitLab summary path in a live merge-request-style smoke. Keep summary comments and CI status authoritative; inline comments remain opt-in UX.

## Success Criteria

- GitHub inline comments have clearer human-facing formatting with severity/category/confidence, evidence, recommendation, and stable hidden metadata.
- Inline publishing outcomes are easy to inspect from traces/artifacts and do not hide skipped findings.
- Duplicate suppression remains stable across reruns and is documented as same-head/same-finding suppression, not canonical state.
- GitLab live smoke setup is documented with exact prerequisites, commands, and safety posture.
- A real GitLab MR smoke is run if credentials/project access are available; otherwise the blocker is explicit and documented.
- Default CI templates remain summary-only and fork-safe.

## Slices

- [x] **S01: Inline comment body and metadata polish** `risk:medium` `depends:[]`
  > After this: GitHub inline comments render a concise, scannable body with stable hidden metadata fields for finding/head/provider/run context, covered by adapter tests.

- [x] **S02: Inline outcome artifact hardening** `risk:medium` `depends:[S01]`
  > After this: inline publishing results are persisted or summarized in a deterministic artifact/trace shape so adopters can inspect posted/skipped/failed findings without scraping comments.

- [x] **S03: Inline rerun UX hardening** `risk:medium` `depends:[S01,S02]`
  > After this: duplicate-skip behavior is clearer in traces/docs and the adapter handles malformed/older inline metadata without noisy failures.

- [x] **S04: GitLab live smoke harness and docs** `risk:medium` `depends:[]`
  > After this: there is a repeatable GitLab smoke command/script or documented procedure for read-only dry-run and summary publish against a real MR, with required token scopes and fork-safety caveats.

- [x] **S05: GitLab live smoke execution** `risk:high` `depends:[S04]`
  > After this: either a real GitLab MR smoke has verified metadata/diff fetch, summary note publish, and idempotent update, or the exact missing credential/project blocker is documented.

## Key Risks

- Inline comments can become too verbose and annoy reviewers.
- Hidden metadata can accidentally expose sensitive details; keep it minimal and review-run scoped.
- Trace/artifact outcome data can drift from provider reality if publish failures are aggregated poorly.
- GitLab token scopes and MR permissions vary by project and may block live smoke.
- GitLab live smoke must not require running untrusted fork code with write tokens.

## Proof Strategy

- Adapter tests for inline markdown body, hidden metadata, duplicate parsing, malformed metadata handling, and API failures.
- Publisher tests for outcome trace/artifact shape.
- Docs tests for opt-in inline stance, GitLab smoke prerequisites, and default template safety.
- Local package checks before any live smoke.
- Live GitLab smoke only with explicit credentials/project access and a same-project MR.

## Verification Classes

- **Static:** TypeScript compile and contract tests.
- **Unit:** inline body/metadata formatting and outcome aggregation.
- **Adapter:** fake GitHub/GitLab API responses for comment/note behavior.
- **Package:** `bun run pack:smoke` and `bun run smoke:external-package`.
- **Live trusted:** real GitLab MR smoke if credentials/project are available.

## Definition of Done

- S01–S05 boxes complete or S05 is explicitly blocked with documented missing prerequisites.
- `bun run check`, `bun run pack:smoke`, and `bun run smoke:external-package` pass.
- GitHub inline comments remain opt-in via `--publish-inline`.
- GitLab inline discussions remain deferred unless a later milestone explicitly implements them.
- Default GitHub/GitLab CI templates still do not publish inline comments.
- GitLab live smoke evidence or blocker is captured in docs.

## Requirement Coverage

- **Inline UX hardening:** S01, S02, S03
- **Duplicate/rerun trust:** S03
- **GitLab live confidence:** S04, S05
- **Safety/default posture:** S02, S04, S05

## Boundary Map

- S01 improves GitHub adapter formatting and metadata consumed by S03 duplicate handling.
- S02 consumes publisher outcomes and produces durable inspection signals consumed by docs/adopters.
- S03 consumes S01 metadata and S02 outcome conventions to improve rerun behavior.
- S04 produces the GitLab smoke procedure consumed by S05.
- S05 consumes S04 prerequisites and records live evidence or a concrete blocker.
