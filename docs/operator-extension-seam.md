# Operator-extension seam — design note & #16 disposition

> **Status: decision of record (M017 S01, #16).** This note settles the design the rest of
> M017 builds against: it records the **#16 disposition** (defer the Cloudflare plugin
> lifecycle; adopt the minimal explicit-load seam) and the two semantic questions the
> "great defaults, swappable" shape raises — **(a) the merge/override rule** and **(b) the
> role-union question**. It is design-on-paper: S02 (#175) commits the public API surface and
> S03 (#143) wires the loader. Framing lives in `docs/milestones/M017-ROADMAP.md` (slice S01).

## What this seam is

The factory ships a pre-built set of **trusted** reviewer definitions
(`TRUSTED_REVIEWER_DEFINITIONS` in `src/runner/reviewer-definitions.ts`) that work zero-config on
install. Today an adopter's only extension surface is `.ai-review.json` — enable/disable those
*trusted* roles, set paths and policy. There is **no way to add a custom reviewer without
forking**, and the core is "never forked."

The operator-extension seam closes that gap *minimally*: an adopter, acting as the **trusted
operator in their own CI**, supplies their own `ReviewerDefinition[]` by **explicit path** — they
run alongside, or override, the trusted set — while reviewed-repo content stays locked out exactly
as today. The seam serves three operator postures on top of the trusted default:

1. **out-of-box** — supply nothing; the trusted set is the default (unchanged).
2. **extend** — add custom reviewers *alongside* the built-ins.
3. **swap/override** — replace a specific built-in reviewer (or the whole set) with the
   operator's own.

## #16 disposition — defer the plugin lifecycle

**#16 asks:** adopt the Cloudflare-style `ReviewPlugin` lifecycle (`bootstrap` concurrent/non-fatal
· `configure` sequential/fatal · `postConfigure` async) + a `ConfigureContext` where plugins
*contribute* config that a thin assembler merges — or keep the current **imperative** adapter
composition in `src/runner/run-review.ts` / `src/runner/config.ts`?

**Decision: keep imperative composition; defer the plugin lifecycle. M017 ships the minimal
explicit-load reviewer seam instead.** This re-affirms #16's own decision-of-record and the #143
assessment: the typed adapter boundaries already deliver the *isolation* value at current scale;
the lifecycle's payoff (concurrent bootstrap, fatal-vs-non-fatal ordering, `postConfigure` remote
fetch) only materializes with **multiple independent config contributors**, none of which exist.
Building it now is premature abstraction.

**Triggers to revisit #16 (build the lifecycle when ANY one lands)** — unchanged from the issue:
a second AI provider or a third VCS adapter; a compliance/policy or AGENTS.md plugin that needs to
*inject prompt sections + permissions* (note: a compliance *reviewer definition* is **not** a
config contributor and does not trip this); or the #15 runtime model-routing control plane (its
natural home is `postConfigure`). Until then #16 stays open as the decision record.

**Why the reviewer seam is not the plugin system.** The seam supplies *one* kind of artifact
(`ReviewerDefinition[]`) into an *already-parameterized* selector — it adds no lifecycle, no
contribution/assembler indirection, and no new config-merge ordering. It is the cheaper imperative
answer to the *specific* adopter demand (BYO reviewer), not a general plugin contract.

## The socket is already half-built

The reviewer selector is **already parameterized** — the missing half is the operator-facing way
to *supply, merge, and gate* a custom set:

- `selectTrustedReviewerDefinitions({ config, risk, definitions? })` already takes an optional
  `definitions?: readonly ReviewerDefinition[]`, defaulting to `TRUSTED_REVIEWER_DEFINITIONS`.
  Passing a set **already performs a full replace** (`input.definitions ?? TRUSTED…`).
- `findUnsupportedReviewerPolicyEntries({ config, definitions? })` already detects a
  `reviewerPolicy` entry that enables a role with **no backing definition** — the validation hook a
  custom-role world needs.
- `reviewerPolicy` is already typed `Record<string, "enabled" | "disabled" | "full_only">`
  (`src/contracts/review.ts`) — it already accepts **any** role key, so a custom role needs no
  contract change to be enableable.

S03 (#143) adds the loader (CLI `--reviewers <path>` and/or a config field), parses/validates the
operator set, **merges it with the trusted set per rule (a) below**, and passes the result into the
existing `definitions` parameter.

## Trust boundary — explicit load, never discovery (reuse the proven pattern)

The seam reuses the fork-safety invariant verbatim (`docs/fork-safety.md`): the distinction is
**discovery vs explicit load**, not "no extensions at all." The Pi adapter already runs
`--no-extensions` (kills reviewed-repo extension *discovery*) and **separately** loads exactly one
factory-owned extension by explicit path (`--extension …/submit-findings-extension.ts`, M015 S03
#126). Operator reviewer definitions load the same way: **explicit operator-supplied path, resolved
in the trusted operator's CI, never auto-discovered from the reviewed repo.** Because it mirrors the
existing lockout shape, it cannot weaken it:

- A **reviewed repo cannot smuggle a reviewer in** — there is no discovery path; only an
  operator-supplied explicit `--reviewers`/config path is honored.
- Operator reviewer **definitions** are trusted (same tier as `TRUSTED_REVIEWER_DEFINITIONS`); their
  **output** is still untrusted and re-validated through `validateFinding` and pinned by
  `enforceReviewerRole` exactly as today (see (b)).
- The seam is **open by construction** (bring-your-own; denylist + sanitize), never an allowlist of
  factory-blessed reviewers — honoring the extensibility philosophy and the CLAUDE.md Do-not on
  allowlisting extension points.

## (a) Merge/override rule — **merge-by-role, operator-wins, + explicit full-replace**

**Decision.** The merged reviewer set is computed by **keying on `role` and letting operator
definitions win on collision** (last-writer-wins), with **full-replace available as an explicit
opt-in mode**. `role` is the identity key. One rule expresses all three postures:

```
merged = byRole(TRUSTED_REVIEWER_DEFINITIONS, ...operatorDefinitions)   // operator wins on role collision

  out-of-box : operatorDefinitions = []          -> TRUSTED…                       (unchanged default)
  extend     : role "my_a11y" (new role)         -> TRUSTED… + my_a11y             (append)
  swap       : role "security" (operator-defined) -> operator's security replaces the built-in
  replace    : mode "replace"                     -> operatorDefinitions only       (socket's `definitions ?? TRUSTED…`)
```

- **extend / swap** are the *default* merge mode: a new role appends; a role that collides with a
  built-in replaces it. The operator never edits factory code to do either.
- **full-replace** is a *separate, explicit* mode (e.g. a `replace`/`mode` flag on the loader),
  because it is a sharper, all-or-nothing posture the socket already supports directly via
  `definitions ?? TRUSTED…`. Keeping it opt-in avoids an operator accidentally dropping the trusted
  set by supplying one reviewer.

**Why this rule and not the alternatives.**

- **vs full-replace-only** (use the socket as-is): to *extend* by one reviewer the operator would
  have to re-list all built-ins plus theirs — a copy that silently drifts as the factory's trusted
  set evolves on upgrade. The trusted set is a shared asset every adopter inherits; forcing operators
  to copy it defeats "great defaults."
- **vs union/extend-only** (append, collision = error): cannot express the **swap/override** posture
  the milestone requires — the operator could add but never replace a built-in reviewer (only
  suppress it via `reviewerPolicy` disable). Role-keyed last-writer-wins gives swap for free.

**Interaction with `reviewerPolicy`.** Merge composes *before* policy selection. `reviewerPolicy`
still independently enables/disables any role in the merged set (a swapped-in `security` is governed
by `reviewerPolicy.security` just like the built-in was). The two levers are orthogonal: merge
decides *which definition* owns a role; policy decides *whether that role runs* at the current tier.

## (b) Role-union question — **free-form, operator-keyed roles (open by construction)**

**Decision.** Custom roles are **free-form**: a custom reviewer declares any `role` string, and it
is valid simply by being **present in the merged definition set** — there is no registry or enum to
register against. The operator enables it via `reviewerPolicy[role]`, which is already
`Record<string, …>`. **`validateFinding` stays unchanged.**

- **Valid roles = the roles present in the merged definition set**, computed per (a) — not a fixed
  allowlist. This is the same shape the socket already validates: `findUnsupportedReviewerPolicyEntries`
  flags a `reviewerPolicy` entry whose role has no backing definition, so an operator who enables a
  role they never supplied gets a clear "no reviewer definition" signal rather than a silent no-op.
- **Reserved-name guard.** The `ReviewerDefinition.role` contract already excludes `coordinator`
  (`Exclude<AgentRole, "coordinator"> | string`). The loader should reject an operator definition
  that claims `coordinator`, so an operator reviewer can never shadow the fusion role. This is the
  *only* reserved name; everything else is open.

**Why free-form and not registered.** A registered/enum role model is an **allowlist** — it would
force operators to register a role before authoring against it, contradicting the extensibility
philosophy and the CLAUDE.md Do-not on allowlisting extension points. The factory's value here is
"bring your own," not "pick from our list."

**Why the `validateFinding`-accepts-any-string gap does not block this.** The CLAUDE.md known gap is
that `validateFinding` accepts any `reviewer` string on model output. That gap is **already
mitigated at the specialist boundary** and the mitigation extends to custom roles for free:

- `enforceReviewerRole(findings, dispatchedRole)` (`src/runtime/reviewer-output-validation.ts`)
  **pins** each finding's `reviewer` to the role its slot was *dispatched under* — for a custom
  reviewer, that dispatched role **is** the operator's free-form role. A prompt-injected diff cannot
  make a custom reviewer self-label as `security`; the label is factory-controlled, normalized on
  mismatch, and the attempt is recorded in `reviewerRoleAdjustments` on the trace.
- Finding **ids** are still dropped in `validateFinding` and recomputed by `assignStableFindingIds`,
  unchanged.

So the operator role string is trusted *as a definition* (it came from the trusted operator's
explicit load) and *pinned on output* (the model can't spoof it). No change to `validateFinding` is
needed to make free-form roles safe; the seam inherits the existing identity guarantees.

## What this note settles for S02/S03

- **S02 (#175)** commits the public API surface: the package root import (`ai-code-review-factory`,
  mapped via `package.json` `"exports": { ".": "./src/public.ts" }`) exposes the functions
  `defineReviewer` / `createReviewerDefinition` (alias) and the types `ReviewerDefinition`,
  `DefineReviewerInput` (the `defineReviewer` argument shape), and `Severity` (referenced by
  `allowedSeverities`). Role is free-form (operator-keyed); only `"coordinator"` is reserved.
  `private: true` is unchanged.
- **S03 (#143)** wires the loader: parse/validate operator `ReviewerDefinition[]` from an explicit
  path, apply the **merge-by-role, operator-wins** rule (with an explicit **full-replace** mode),
  guard the reserved `coordinator` role, and pass the merged set into
  `selectTrustedReviewerDefinitions({ definitions })`. Reviewed-repo lockout intact (explicit-load
  only); operator-authored reviewer output still flows through `validateFinding` + `enforceReviewerRole`.
- **S04 (#176)** documents the worked "author + load a custom reviewer in your CI without forking"
  recipe and the operator-vs-reviewed-repo trust boundary for this seam.
