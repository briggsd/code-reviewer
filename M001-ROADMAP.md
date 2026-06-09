# M001 Roadmap — Packageable MVP hardening

## Vision

Make the current AI Code Review Factory prototype repeatable outside this checkout: a team can install/run the CLI from a packaged artifact, wire it into GitHub Actions or GitLab CI, and trust the safety defaults before we add inline comments or a richer control plane.

## Success Criteria

- A distributable CLI package contains only intentional runtime/docs assets and can print schemas from the packed tarball.
- CI templates reference the distribution shape instead of repository-local `bun run src/cli.ts` commands.
- GitHub and GitLab summary publishing remain safe, idempotent, and summary-only.
- Fork/public-repo modes are documented as safe defaults, not footnotes.
- An opt-in live Pi/model smoke path exists without making normal CI depend on model access.

## Slices

- [x] **S01: Package tarball smoke path** `risk:medium` `depends:[]`
  > After this: `bun run pack:smoke` creates an npm tarball, proves only intentional files are included, and runs the packaged CLI schema command.

- [x] **S02: Distribution-facing CI commands** `risk:medium` `depends:[S01]`
  > After this: GitHub/GitLab templates use the package/CLI entrypoint shape instead of prototype-local `bun run src/cli.ts` commands, while tests preserve read/write separation.

- [x] **S03: Public-repo fork strategy guide** `risk:high` `depends:[S02]`
  > After this: docs give a concrete recommended default for forks and show which jobs may use secrets/write tokens.

- [ ] **S04: Inline publishing readiness gate** `risk:high` `depends:[S03]`
  > After this: the codebase has explicit line-coordinate and stale-diff checks that can block inline comment/discussion publishing until safe, even if implementation remains deferred.

- [ ] **S05: Opt-in live runtime CI smoke** `risk:medium` `depends:[S01,S03]`
  > After this: a disabled-by-default workflow path documents and verifies how maintainers can run Pi/model smoke without exposing secrets to untrusted PR code.

- [ ] **S06: Release readiness checklist** `risk:low` `depends:[S02,S03,S05]`
  > After this: maintainers have a concise checklist for versioning, packing, smoke testing, and choosing npm/container/action release channels.

## Key Risks

- Packaged TypeScript CLI depends on Bun being present in the runtime environment.
- CI examples may accidentally imply privileged write-back is safe for forks.
- Package artifacts can include internal handoff/test files unless the manifest is explicit.
- Inline comments can create duplicate/noisy/stale feedback if line mapping is not proven.

## Proof Strategy

- Unit tests for package manifest invariants and CI template command wiring.
- `bun run pack:smoke` for tarball contents and packaged CLI execution.
- Existing `bun run check` for type/test regression coverage.
- Live GitHub workflow smoke remains opt-in and documented separately.

## Verification Classes

- **Static:** TypeScript compile, package manifest tests, template tests.
- **Package:** npm dry-run pack, tar extraction, packaged CLI schema execution.
- **Integration:** Existing fake-provider/fake-runtime adapter composition tests.
- **Live optional:** Pi/model and provider-backed workflow smoke only with explicit environment/secrets.

## Definition of Done

- All S01–S06 boxes complete.
- `bun run check` and `bun run pack:smoke` pass from a clean checkout.
- README points new adopters to packaging, configuration, and CI docs.
- Summary publishing remains the only write-back path enabled by templates.

## Requirement Coverage

- **Packageability:** S01, S02, S06
- **CI adoption:** S02, S03, S05
- **Safety posture:** S03, S04, S05
- **Future inline comments:** S04
- **Operational confidence:** S01, S05, S06

## Boundary Map

- S01 produces a verified package artifact contract consumed by S02 and S06.
- S02 consumes the CLI package shape and updates `examples/ci/*` plus template tests.
- S03 consumes CI template behavior and produces fork-safety guidance consumed by S05.
- S04 consumes `Finding.location` and provider diff metadata invariants; it produces an explicit precondition for future inline publishers.
- S05 consumes S01 package execution and S03 fork-safety guidance for opt-in live runtime smoke.
- S06 consumes all release/distribution decisions and turns them into an operator checklist.
