# How it works for adopters

AI Code Review Factory is a CI-native review runner. Adopting projects install
the packaged runner in their PR/MR pipeline and configure project policy with
`.ai-review.json`; they do not fork the factory core.

## Review lifecycle

A pull request or merge request starts a CI job. The job runs `ai-code-review`,
which fetches change metadata and diffs through the GitHub or GitLab API,
filters low-signal files, classifies the change by risk tier, builds shared
context artifacts, runs the configured reviewers, synthesizes a summary, writes
artifacts, and optionally publishes a summary comment or note.

At adopter altitude, the flow is:

```text
PR/MR event
  -> CI job
  -> ai-code-review runner
  -> VCS metadata and diff fetch
  -> diff filtering and risk tiering
  -> specialist reviewers and coordinator
  -> artifacts, CI status, optional comment UX
```

The important boundary is that CI owns enforcement. Summary comments, notes, and
inline feedback are user experience; the required CI status is the merge gate.

## Gate policy

Project config chooses fail-open or fail-closed behavior:

- `mode: "advisory"` keeps the job non-blocking for findings, useful during
  rollout and calibration.
- `mode: "blocking"` makes configured severities fail CI.
- `failOn` chooses which severities fail in blocking mode, commonly
  `["critical"]` to start.

Reviewer/runtime failures have their own policy described in
[Project configuration](configuration.md). In general, the runner tries to make
degraded review visible in the summary and artifacts rather than letting teams
mistake a partial review for a clean pass.

## Reviewer and model routing

The factory ships trusted reviewer definitions for roles such as code quality,
security, documentation, and performance, plus opt-in roles. The risk tier
controls how much review runs: trivial changes get a small reviewer set, while
larger or sensitive changes get broader review and larger budgets.

Adopters can tune:

- reviewer enablement with `reviewerPolicy`,
- sensitive path escalation with `sensitivePaths`,
- model/provider selection with `modelRouting`,
- wall-clock ceilings with `timeouts`,
- patch admission limits with `patchBudgets`.

Use the defaults first, then tune based on real runs. The field reference and
routing examples live in [Project configuration](configuration.md).

## Public and private repositories

Private repositories and same-repository PRs can usually run a dry-run job plus a
guarded publish job. The publish job should have the least write permission
needed to update a summary comment or note, and model credentials should be
available only where the runtime needs them.

Public repositories and fork-capable projects need a stricter default: fork
PRs/MRs should run read-only analysis with no write token, no model secrets, and
no comment publishing. The review job can still produce CI artifacts and a status
signal without executing project code or exposing privileged credentials. If a
team wants comments on forks, use a separate approved reporter flow that reads
validated artifacts rather than giving the fork-triggered job secrets.

See [Public repository fork safety](fork-safety.md) for the recommended
permission matrix, trace-redaction behavior, and safe rollout sequence.

## What adopters own

Adopters own the CI wiring, package pin, `.ai-review.json`, secrets placement,
branch-protection settings, and any operator-supplied reviewer modules. The
factory owns the runner, built-in reviewer definitions, prompt boundaries,
structured output validation, publishing adapters, telemetry shape, and safety
defaults. Keeping that split intact is what lets many repositories upgrade the
same shared review system without carrying local forks.

