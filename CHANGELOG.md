# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Releases are cut by pushing a `vX.Y.Z` tag; see
[Release readiness](docs/user/release-readiness.md) for the version/tag/release SOP.

## [Unreleased]

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

Initial pre-registry baseline of the AI Code Review Factory.

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

[Unreleased]: https://github.com/briggsd/ai-code-review-factory/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/briggsd/ai-code-review-factory/releases/tag/v0.1.0
