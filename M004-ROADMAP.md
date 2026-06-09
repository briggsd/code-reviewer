# M004 Roadmap — Inline publishing MVP

## Vision

Add safe, opt-in line-level publishing for findings without weakening the summary-first safety model. The first inline publishing milestone should make GitHub review comments useful for humans while preserving CI status and summary comments as the canonical review result.

## Success Criteria

- Inline publishing is disabled by default and requires an explicit CLI flag.
- GitHub inline comments are published only for findings that pass `evaluateInlinePublishReadiness()`.
- Unsafe findings remain visible in the summary and trace/artifacts instead of disappearing.
- Summary publishing remains idempotent and continues to include hidden metadata for re-review state.
- Inline publishing avoids obvious duplicate comments on reruns of the same head/finding.
- GitLab inline discussions remain deferred unless explicitly added in a later slice/milestone.

## Slices

- [x] **S01: Inline publish contract and CLI flag** `risk:medium` `depends:[]`
  > After this: `--publish-inline` is parsed separately from `--publish-summary`, and provider publishing inputs/results can represent attempted/skipped/posted inline findings without changing default behavior.

- [x] **S02: GitHub inline comment adapter** `risk:high` `depends:[S01]`
  > After this: the GitHub adapter can post one review comment for a ready finding on the current PR diff using provider line/side coordinates.

- [x] **S03: Readiness-gated inline orchestration** `risk:high` `depends:[S02]`
  > After this: inline publishing evaluates every finding, publishes only ready findings, records skipped reasons, and keeps all findings in the summary.

- [x] **S04: Duplicate prevention for reruns** `risk:medium` `depends:[S03]`
  > After this: rerunning on the same head/finding does not create obvious duplicate inline comments.

- [x] **S05: Inline publishing docs and live smoke** `risk:medium` `depends:[S04]`
  > After this: docs explain the opt-in GitHub-only inline path, deferred GitLab scope, safety gates, and a same-repo live smoke verifies no default inline publishing plus guarded inline behavior.

## Key Risks

- GitHub line coordinates differ between file-level patches and review comment API expectations.
- Stale head SHA or truncated diffs can place comments on the wrong code.
- Duplicate comments can create noisy PR UX and erode trust.
- Inline comments might be mistaken for the canonical merge gate; CI status and summary must remain authoritative.
- Fork PRs must not receive privileged write-back or model credentials.

## Proof Strategy

- Unit tests for CLI flag parsing and inline publish orchestration.
- Adapter tests using fake GitHub API responses for review comment creation and duplicate lookup.
- Readiness tests reusing existing stale/truncated/coordinate gates.
- Summary tests proving skipped inline findings remain visible.
- Live same-repository GitHub smoke with `--publish-inline` only after unit/adapter coverage passes.

## Verification Classes

- **Static:** TypeScript compile and contract tests.
- **Unit:** readiness-gated orchestration and skipped/posted counts.
- **Adapter:** fake GitHub review comments API, duplicate detection, API failure behavior.
- **Integration:** provider-backed run with fake/dummy runtime and seeded findings.
- **Live trusted:** same-repo GitHub PR smoke with explicitly enabled inline publishing.

## Definition of Done

- S01–S05 boxes complete.
- `bun run check`, `bun run pack:smoke`, and `bun run smoke:external-package` pass.
- Default CI templates still do not publish inline comments.
- `--publish-inline` is GitHub-only or clearly errors for unsupported providers.
- Inline publishing never bypasses `evaluateInlinePublishReadiness()`.
- Summary comments remain idempotent and summary-first.

## Requirement Coverage

- **Opt-in behavior:** S01, S05
- **GitHub inline UX:** S02, S03, S04
- **Safety gates:** S03, S05
- **Duplicate prevention:** S04
- **Docs/live confidence:** S05

## Boundary Map

- S01 produces CLI/contract support consumed by S02 and S03.
- S02 consumes GitHub diff/comment APIs and produces provider-level inline posting consumed by S03.
- S03 consumes `evaluateInlinePublishReadiness()` and provider inline support to produce safe orchestration and trace results.
- S04 consumes stable finding IDs plus prior inline metadata/comment lookup to suppress duplicates.
- S05 consumes S01–S04 behavior and updates README, inline publishing docs, adoption docs, and live smoke notes.
