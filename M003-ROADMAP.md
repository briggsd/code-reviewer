# M003 Roadmap — External package and live runtime adoption smoke

## Vision

Prove the review factory can be adopted like a real tool, not just run from this checkout. Before inline publishing adds line-level write-back complexity, validate the packaged CLI, realistic installer paths, live provider-backed operation, and the Pi runtime path with enough observability to debug failures from CI artifacts.

## Success Criteria

- The temporary install/pinning strategy for adopters is explicit and reproducible.
- A fresh external-style environment can install `ai-code-review` and run provider-backed dry-run without repository-local source commands.
- A controlled live Pi/runtime smoke path exercises real model output while preserving project-resource isolation.
- Runtime/model/schema failures produce actionable trace/artifact evidence.
- Adoption docs distinguish what has been live-tested from deferred channels like containers, GitHub Action wrappers, GitLab components, and inline publishing.

## Slices

- [x] **S01: Package install source strategy** `risk:medium` `depends:[]`
  > After this: adopters know exactly how to pin/install the CLI for now: tarball, Git ref, registry package, or a staged combination.

- [x] **S02: External-style packaged install smoke** `risk:medium` `depends:[S01]`
  > After this: a fresh temp/adopter environment installs `ai-code-review` and runs a provider-backed dry-run without using repo-local `bun run src/cli.ts`.

- [x] **S03: Live Pi runtime smoke path** `risk:high` `depends:[S02]`
  > After this: one controlled PR can run `--runtime pi` with real model output and verify schema handling plus project-resource isolation.

- [ ] **S04: Runtime failure observability** `risk:medium` `depends:[S03]`
  > After this: failed Pi/model/schema runs leave enough trace and artifact detail to diagnose from CI without blindly rerunning.

- [ ] **S05: Adoption docs/checklist update** `risk:low` `depends:[S02,S03,S04]`
  > After this: docs tell another repository exactly how to adopt safely and what has or has not been live-tested.

## Key Risks

- The current Bun-backed TypeScript bin may be awkward for adopters unless Bun installation and package pinning are documented precisely.
- Installing from a mutable Git ref can make CI results non-reproducible.
- Pi live runs may fail due to provider credentials, model configuration, schema drift, or runtime output that unit tests cannot simulate.
- CI artifacts may omit the exact prompt/output/error context needed to debug runtime failures.
- Live model credentials must never be exposed to untrusted fork PR/MR code.

## Proof Strategy

- Add tests or scripts that lock the selected install source guidance and packaged install behavior.
- Use a temporary external-style install root for package smoke rather than relying on the current checkout.
- Run provider-backed dry-runs through the installed `ai-code-review` binary.
- Exercise the opt-in Pi path only in trusted/manual contexts with explicit credentials.
- Inspect produced artifacts/traces for enough information to diagnose failures.

## Verification Classes

- **Static:** TypeScript compile, docs/link tests, package metadata tests.
- **Package:** npm pack/tarball install, installed CLI `schemas`, installed CLI provider dry-run.
- **Integration:** provider-backed GitHub/GitLab dry-run using the package entrypoint and fake/dummy runtime.
- **Live trusted:** controlled GitHub PR with summary-only write-back and optional Pi runtime credentials.
- **Failure-mode:** forced invalid runtime/schema output or simulated process failure with artifact/trace assertions.

## Definition of Done

- S01–S05 boxes complete.
- `bun run check`, `bun run pack:smoke`, and the external-style packaged install smoke pass.
- At least one live trusted provider workflow has run from the package entrypoint or a documented equivalent install source.
- Pi live smoke is either successfully run in a trusted context or explicitly documented as blocked by missing credentials/configuration.
- Runtime failure traces/artifacts are sufficient for a future agent to diagnose the failure mode.
- Inline publishing remains deferred and summary publishing remains the only default write-back path.

## Requirement Coverage

- **Adopter install reproducibility:** S01, S02, S05
- **Package confidence:** S02, S05
- **Real runtime confidence:** S03, S04
- **Safety posture:** S03, S05
- **Operational debugging:** S04
- **Future inline publishing readiness:** S03, S04, S05

## Boundary Map

- S01 produces the install-source decision consumed by S02 and S05.
- S02 consumes the package artifact contract from M001 and produces an external-style smoke path consumed by S03 and S05.
- S03 consumes the packaged/adopter execution path plus existing Pi runtime adapter and produces live model/runtime evidence consumed by S04.
- S04 consumes runtime traces, process output handling, schema validation, and state artifact layout; it produces failure diagnostics expectations consumed by S05.
- S05 consumes S01–S04 decisions/evidence and updates README, packaging, release readiness, and CI adoption guidance.
