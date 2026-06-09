# M007 Roadmap — Fortis self-managed GitLab beta readiness

## Vision

Prepare AI Code Review Factory for a first internal beta in Fortis self-managed GitLab without making a public package or registry release. A Fortis-like adopter should be able to install an immutable internal tarball, run safe merge request dry-runs, enable same-project summary notes, and debug failures with clear operator guidance.

## Success Criteria

- GitLab CI examples work for self-managed GitLab by using the instance-provided API v4 URL instead of assuming GitLab.com.
- Beta install guidance keeps the package private/unlicensed and uses an immutable pinned tarball artifact rather than public npm.
- A Fortis-style GitLab MR pipeline template separates read-only dry-run from guarded same-project write-back.
- Operator docs cover onboarding one repo, token scopes/variables, secret safety, smoke testing, artifact inspection, failure debugging, and token rotation.
- Self-managed GitLab smoke guidance verifies metadata/diff fetch plus summary note create/update behavior.
- Verification proves the beta path does not rely on mutable refs, public npm, or privileged fork/fork-like pipelines.

## Slices

- [x] **S01: Self-managed GitLab CI contract** `risk:high` `depends:[]`
  > After this: GitLab templates and docs pass the API v4 base URL explicitly from CI so self-managed GitLab is not GitLab.com-assumed.

- [x] **S02: Pinned internal tarball beta install path** `risk:medium` `depends:[]`
  > After this: docs and templates show an immutable internal tarball install path while keeping `private: true` and `UNLICENSED` unchanged.

- [x] **S03: Fortis-style GitLab MR pipeline template** `risk:high` `depends:[S01,S02]`
  > After this: a beta repo can copy one GitLab CI example with dry-run artifacts and guarded same-project summary publishing.

- [x] **S04: Beta operator onboarding guide** `risk:medium` `depends:[S03]`
  > After this: first-repo onboarding has token scopes, CI variables, artifact inspection, failure debugging, and rotation guidance.

- [x] **S05: Self-managed GitLab smoke/readiness profile** `risk:medium` `depends:[S01,S03]`
  > After this: maintainers can run a documented smoke against a Fortis-like MR and verify summary-note create/update behavior.

- [ ] **S06: M007 verification sweep** `risk:medium` `depends:[S02,S04,S05]`
  > After this: tests, package smoke, and docs checks prove beta adoption works without public npm or mutable refs.

## Key Risks

- GitLab.com assumptions can hide in templates, smoke scripts, docs, and tests even if the adapter supports custom API URLs.
- Self-managed GitLab instances may have custom hostnames, TLS/proxy requirements, token policies, or MR pipeline settings that differ from GitLab.com.
- Beta docs could accidentally imply a public npm release, mutable `main` installs, or floating package versions.
- Write tokens and model credentials must not be exposed to fork-like or untrusted merge request pipelines.
- Summary note publishing must remain UX-only; CI status remains the merge gate.

## Proof Strategy

- Template tests assert GitLab CI passes an API base URL from `$CI_API_V4_URL` or an explicit override into `ai-code-review run --api-base-url`.
- Docs tests assert self-managed GitLab setup, immutable tarball pinning, and no public release requirement.
- Existing adapter tests continue to cover GitLab API URL construction and summary note update behavior.
- Live smoke docs explain how to run against a self-managed MR with `AI_REVIEW_GITLAB_API_BASE_URL` and `AI_REVIEW_GITLAB_PUBLISH_SUMMARY=1`.
- Package smoke verifies the packed CLI still includes beta docs/templates.

## Verification Classes

- **Static:** TypeScript compile, CLI/help tests, and docs/template assertions.
- **Template:** GitLab CI structure checks for API base URL, dry-run/write-back separation, tokens, artifacts, and no inline publishing.
- **Package:** `bun run pack:smoke` and `bun run smoke:external-package` where applicable.
- **Live trusted:** optional self-managed GitLab MR smoke using a Fortis-like project and maintainer-provided tokens.

## Definition of Done

- S01–S06 boxes complete.
- `bun run check` passes.
- `bun run pack:smoke` passes.
- GitLab beta docs do not require public npm, package license/access changes, or mutable refs.
- GitLab templates keep dry-run and publish jobs separate and same-project guarded.
- Self-managed smoke instructions include create/update verification for exactly one AI summary note.

## Requirement Coverage

- **Self-managed GitLab support:** S01, S03, S05
- **Internal beta distribution:** S02, S03, S06
- **Adopter safety:** S03, S04, S06
- **Operator readiness:** S04, S05
- **No public release:** S02, S06

## Boundary Map

- S01 consumes the existing `--api-base-url` CLI/provider contract and produces a self-managed GitLab CI invariant consumed by S03 and S05.
- S02 consumes M006 package artifact work and produces internal tarball install guidance consumed by S03, S04, and S06.
- S03 consumes S01 and S02 to produce the copyable Fortis-style MR pipeline.
- S04 consumes S03 pipeline shape and produces first-repo operator guidance.
- S05 consumes S01 and S03 to produce a self-managed live smoke profile and readiness checklist.
- S06 consumes S02, S04, and S05 to verify the milestone end-to-end.
