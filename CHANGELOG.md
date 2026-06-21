# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `vX.Y.Z` tag; see
[Release readiness](docs/user/release-readiness.md) for the version/tag/release SOP.

## [Unreleased]

### Added
- `telemetry:analyze` and `telemetry:quality` accept ingestion filters: `--since <ISO>` / `--until
  <ISO>` (date window on the event timestamp) and `--repository <slug>` / `--exclude-repository
  <slug>` (repeatable, mutually exclusive). These let an operator compute rates over an adopter-only
  slice (e.g. `--exclude-repository <factory-repo>`) or a post-fix window, the inputs needed to
  calibrate `telemetry:quality` thresholds (#391).

### Changed
- `telemetry:quality` threshold `maxGroundingDropRate` raised 0.15 → 0.35, calibrated against a
  100-run **factory-dogfood** sample (CI artifacts are all the factory repo; the adopter-only
  baseline still needs the Loki fleet dataset — both calibrated thresholds are repo-agnostic):
  the run-level grounding-drop rate fires on by-design healthy demotion (#207) while the meaningful
  finding-level `maxGroundingWithholdRate` stays the precision signal. `maxReviewerFailureRate`
  kept at 0.10 (validated — recent post-fix rate 2%). Every `DEFAULT_QUALITY_THRESHOLDS` default is
  now documented with its basis (#391).

### Fixed
- GitHub Action wrapper (`action.yml`) and the `examples/ci/github-actions-ai-review.yml` template
  failed to load: the `package-source` / `AI_REVIEW_PACKAGE` default was an unquoted YAML scalar
  starting with `@` (a reserved indicator), which is invalid YAML, so the manifest could not be
  parsed before any input override applied. The defaults are now quoted and pinned to a published
  version, and a test scans every manifest for unquoted reserved-indicator scalars.

### Changed
- Renamed the package to `@briggsd/code-reviewer` and the CLI bin to `code-reviewer`; the hidden review-summary metadata marker changed from `ai-code-review-factory` to `code-reviewer` (existing open PRs will get one fresh summary comment instead of an in-place update on the first review after upgrade).

### Added

- Grounding-withheld findings are now tracked across re-review rounds (#392). Each withheld finding
  receives a `stableFindingId` (same algorithm as blocking findings). The id, path, and reviewer
  role are persisted in hidden summary metadata as `withheldFindingIds`, `withheldFindingPaths`, and
  `withheldFindingReviewers` (schemaVersion bumped 8 → 9; additive, backward-compatible). On the
  next re-review round, `PriorReviewState.withheldFindings` is reconstructed from metadata and
  `run_metrics.withheldDispositions` emits counts-only disposition counts (`promoted`,
  `stillWithheld`, `resolved`, `carriedForward`). Withheld finding titles are intentionally not
  persisted (model-authored content, M008 egress boundary). Assigning stable IDs to withheld
  findings also refines summary rendering: a finding resolved in an earlier round that recurs this
  round only as a withheld (low-confidence) finding is now correctly excluded from the "Resolved
  over this PR" history (previously withheld findings had no id, so the existing exclusion was
  dormant).

- `--git-diff` runs now accept `--include-untracked` to include untracked, non-gitignored files in
  the local review. When set, each untracked file is momentarily marked intent-to-add (`git add -N`)
  so `git diff` renders it as all-additions, then the index is restored to exactly the state found
  (the restore always runs and is never swallowed; on a diff failure the original error is preserved
  as the cause). File selection uses `--exclude-standard`, which honours the project's `.gitignore`
  (and `.git/info/exclude` / global gitignore) — gitignore build-artifact paths before enabling the
  flag in large repos. Default behavior is unchanged — untracked files remain invisible without the
  flag. (#382, M034)

- Bitbucket Cloud is now a supported VCS provider. Pass `--provider bitbucket` with a Bearer
  access token in `AI_REVIEW_BITBUCKET_TOKEN` (or `BITBUCKET_TOKEN`) — a Bitbucket Cloud
  repository or workspace access token; App Passwords / Basic auth are not supported — to run a
  review against a Bitbucket Cloud pull request. The adapter implements PR metadata/diff/prior-state read and
  summary + inline comment publishing against Bitbucket Cloud REST API 2.0 (`content.raw`
  comment field; inline anchor `{ path, to }` for RIGHT/new-side lines and `{ path, from }` for
  LEFT/old-side lines). `ProviderKind` was widened with `"bitbucket"` — this change is additive
  and backward-compatible; `run.json` consumers doing exhaustive matching on the `provider` field
  should treat it as open-ended. (#361, M033)

- Local `--git-diff` runs now print a one-line run-health header above the markdown tail:
  `[ai-review] Run health: degraded=false (0 reviewers failed) · N grounded / M withheld`. It
  makes the grounded findings (in `summary.json`) vs withheld low-confidence findings (rendered
  but non-blocking) count explicit, and states reviewer-failure health affirmatively on clean
  runs. Appears only in `--output markdown` mode (the default); the `--output json` stdout is
  unchanged, so scripted consumers are unaffected. (#380, #381, M034)

### Fixed

- Re-review summaries now recover real finding titles from hidden summary metadata into placeholder
  findings, so the resolved-log and re-review status sections show the original title (e.g.
  "Auth token not rotated") instead of the generic `Prior finding fnd_…` placeholder (#333).
- Resolved-log accumulation deduplicates against the current round's `fixed` and `withheld`
  finding IDs before appending, preventing stale resolved entries from re-appearing in
  the log when a finding bounces between states across rounds (#332).
- Hidden summary metadata serialization now unicode-escapes `>` (→ `\u003e`) at the write
  site, preventing a model-authored `findingTitles` value containing `-->` from prematurely
  closing the HTML comment block and injecting Markdown into the rendered summary. Mirrors the
  same defence already applied to inline comments (#82). The `parseSummaryHiddenMetadata`
  round-trip is unaffected (JSON.parse decodes `>` back to `\u003e`).

### Added

- Hidden-metadata `schemaVersion` bumped 7→8 for the additive `findingTitles` field (stable
  finding ID → model-authored title map). Backward-compatible: schemaVersion ≤ 7 parsers
  ignore the field; when absent, placeholder findings fall back to `Prior finding ${stableId}`.

- `acknowledgements`: durable `stableFindingId` matching across finding-ID drift — when a pinned
  ID is absent from the current run (the model re-assigned an ID), `acknowledge`-mode acks now
  relax to path+category so the ack stays active across model-volatile ID churn (#346). Safety
  guardrails: relaxation requires **exactly one** path+category-matching finding in scope (prevents
  fan-out to unintended siblings when ≥2 findings share the same path+category); `suppress`-mode
  acks do **not** relax on a drifted ID (the finding re-surfaces visibly rather than risk silently
  hiding a different finding under a broad glob); security findings (`reviewer: "security"`) never
  relax regardless of mode; and the pinned-ID presence check is scoped to path (and optional
  category) matching findings (prevents an unrelated global ID collision from disabling durability). Per-ack scope is
  precomputed once (O(N·A)) rather than rescanned per finding.

### Added

- `EscapedString` branded string type returned by `escapeMarkdown` and `codeSpan`; renderer
  helpers that accept untrusted text can declare parameters as `EscapedString` so the TypeScript
  compiler rejects plain `string` values at call sites (#310).
- `codeSpan(value)` — CommonMark §6.11-safe code-span builder that widens the backtick fence
  for embedded backtick runs; pads content that starts or ends with a backtick (to separate it
  from the fence delimiter) and content that both starts and ends with a space (to prevent §6.11
  space-stripping); and yields an empty string for empty input (no code span emitted). Returns
  `EscapedString` so the output is accepted in escaped-text slots without a second round of
  escaping (#310).
- `escapeMarkdown` return type narrowed to `EscapedString` (backward-compatible at runtime;
  only the TypeScript type changes) (#310).

## [0.1.0]

Initial pre-registry baseline of the Code Reviewer.

### Added

- CI-native AI code review runner for GitHub and GitLab, configured per repository via a
  small `.ai-review.json` (the factory core is never forked per project).
- Risk-tiered review: trivial/lite/full classification drives the reviewer roster and model
  strength, with a coordinator agent fanning out to specialist reviewers and fusing results.
- Deterministic orchestration (diff fetch/filter, fan-out, timeout/retry, state, write-back)
  with agentic judgment confined to bounded reviewer contracts.
- Trust boundary for untrusted PR/MR content (titles, descriptions, comments, diffs)
  centrally sanitized before prompt assembly; only factory-owned reviewer definitions run.
- Non-blocking telemetry and JSONL traces, with rollup/analysis/quality tooling over run
  metrics (token/cost/cache, per-tier and per-reviewer segmentation).
- Apache-2.0 license.
- Pre-registry distribution as a Bun-backed npm tarball plus a quality stamp, built by the
  release artifact workflow; registry publish is deferred and `private: true` is intentional.

[Unreleased]: https://github.com/briggsd/code-reviewer/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/briggsd/code-reviewer/releases/tag/v0.1.0
