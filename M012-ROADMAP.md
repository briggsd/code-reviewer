# M012 Roadmap Stub — Deferred platform architecture and later inspiration gaps

> Stub status: parking lot. These are real gaps, but current issues label them low priority or decision-only. Revisit when adoption pressure creates a concrete trigger.

## Vision

Track the larger architecture and later-phase inspiration gaps without prematurely abstracting the small-team implementation.

## Source Issues

- GitHub #15 — Tracking: correctly-deferred inspiration gaps
- GitHub #16 — Decision: plugin lifecycle + `ConfigureContext` assembler vs imperative adapter composition

## Candidate Workstreams

- **Plugin lifecycle / ConfigureContext decision** `issues:[#16]`
  - Scope here is the **full-lifecycle escalation only**. The near-term form of #16 is already resolved in M009 S03: the portable reviewer/coordinator contract is the plugin API, realized natively per adapter. This workstream covers only adopting a Cloudflare-style `bootstrap`/`configure`/`postConfigure` lifecycle on top of that contract.
  - Trigger: second AI provider, third VCS adapter, compliance/policy plugin, AGENTS.md reviewer, or runtime model-routing control plane.
  - First step if adopted: refactor existing GitHub/GitLab/Pi/model-routing composition into contributing plugins without adding new behavior.

- **Runtime model-routing control plane** `issues:[#15]`
  - Deferred until static `modelRouting` config is insufficient.
  - Natural home if plugin lifecycle exists: `postConfigure` fetch/merge of remote overrides.

- **AGENTS.md freshness reviewer** `issues:[#15]`
  - Deferred until prompt quality and shared-context work are stable.
  - Should detect instruction rot around package manager, test framework, build tooling, and CI commands.

- **Inline re-review actions** `issues:[#15]`
  - Deferred until inline publishing is mature enough to auto-resolve fixed threads, re-emit unfixed findings, honor won't-fix, and rebut disagreement.

- **Advanced resilience** `issues:[#12,#15]`
  - Circuit breakers, model-family failback chains, and probe-after-cooldown remain out of M008.

## Tentative Success Criteria Before Promoting This Stub

- A concrete adopter or implementation pressure triggers one of the workstreams above.
- M008–M011 have clarified the real seams for runtime, prompt, telemetry, and analytics contracts.
- The milestone can be narrowed to one coherent outcome instead of a grab bag.

## Current Recommendation

Do not implement this milestone yet. Keep #15/#16 open as strategic tracking/decision issues and promote a narrower M012 only when one trigger becomes unavoidable.
