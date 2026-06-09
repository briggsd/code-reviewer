# M006 Roadmap — Release distribution and GitHub Action wrapper

## Vision

Turn the now live-smoked CLI into an adoption-ready distribution surface. The package should be releasable as a reproducible artifact, and GitHub adopters should have a thin wrapper option that exposes the same safety controls without hiding the CLI contract.

## Success Criteria

- Package metadata is publish-ready or intentionally blocked with explicit remaining decisions.
- Release artifacts can be produced reproducibly from a trusted checkout.
- A GitHub Action wrapper exists as a thin shell around `ai-code-review run`, not a parallel implementation.
- The wrapper preserves the summary-first, CI-status-authoritative, fork-safe default posture.
- Docs explain when to use raw CLI templates vs the GitHub Action wrapper.
- Package and action smoke paths verify the install/run boundary from an adopter-like context.

## Slices

- [x] **S01: Publish-ready package metadata** `risk:medium` `depends:[]`
  > After this: package metadata documents the intended package name, license/access stance, bin, files, and publish blockers; tests lock the publish-relevant fields.

- [x] **S02: Release artifact workflow design** `risk:medium` `depends:[S01]`
  > After this: docs and/or a guarded workflow define how to produce immutable npm tarball release assets from a trusted tag or manual trigger.

- [x] **S03: GitHub Action wrapper contract** `risk:medium` `depends:[S01]`
  > After this: an `action.yml` wrapper exposes inputs for package source, provider/repo/change/head/runtime/output flags, summary/inline opt-ins, and runs the packaged CLI.

- [x] **S04: GitHub Action wrapper docs and template** `risk:medium` `depends:[S03]`
  > After this: adopters can choose either the existing raw CLI workflow or the action wrapper, with the same fork/write-token safety boundaries.

- [x] **S05: Wrapper/package smoke** `risk:high` `depends:[S02,S03,S04]`
  > After this: local/unit checks plus a same-repo GitHub smoke prove the wrapper path installs the package and runs a dry-run/publish job without relying on repo-local source commands.

## Key Risks

- Publishing a package before the final name/license/access policy is chosen can create churn for adopters.
- A wrapper can accidentally obscure dangerous defaults, especially write-back and fork handling.
- GitHub Action inputs can drift from CLI flags if the wrapper becomes too clever.
- Release artifacts must be immutable and reproducible; mutable package sources undermine CI trust.
- The wrapper must not run untrusted PR code with write tokens or model credentials.

## Proof Strategy

- Package metadata tests for name/version/private/license/bin/files/scripts.
- Docs tests for release artifact guidance, immutable source rules, and wrapper-vs-CLI selection.
- Wrapper structure tests that assert the action shells out to `ai-code-review run` and exposes explicit publish flags.
- CI template tests that ensure raw templates remain summary-only and wrapper templates keep guarded write-back.
- Live same-repository GitHub smoke once wrapper support is implemented.

## Verification Classes

- **Static:** TypeScript compile and metadata/docs tests.
- **Package:** `bun run pack:smoke` and `bun run smoke:external-package`.
- **Action wrapper:** structural tests over `action.yml` and example workflows.
- **Live trusted:** same-repo GitHub PR smoke using the wrapper path if feasible.

## Definition of Done

- S01–S05 boxes complete, or release publication is explicitly blocked by a documented name/license/access decision.
- `bun run check`, `bun run pack:smoke`, and `bun run smoke:external-package` pass.
- Existing raw GitHub/GitLab templates still work and remain fork-safe.
- Wrapper docs do not imply inline comments or summary publishing are defaults.
- Release docs tell adopters how to pin an immutable package source.

## Requirement Coverage

- **Releasable package:** S01, S02, S05
- **GitHub Action wrapper:** S03, S04, S05
- **Adopter safety:** S02, S04, S05
- **Immutable distribution:** S01, S02

## Boundary Map

- S01 establishes package metadata consumed by release artifacts and wrapper install defaults.
- S02 consumes S01 metadata and produces release artifact guidance/workflow consumed by adopters.
- S03 consumes the CLI contract and package install path to produce a thin action wrapper.
- S04 consumes S03 wrapper shape and updates docs/templates.
- S05 consumes S02–S04 and records verification evidence.
