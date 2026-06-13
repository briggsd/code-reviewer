# AI Code Review Factory Architecture

## Reader and post-read action

**Reader:** an engineer building or operating a shared AI code review system across multiple GitHub and GitLab repositories.

**After reading, they should be able to:** implement the MVP review runner, wire it into GitHub Actions or GitLab CI, and understand which parts must remain pluggable for multi-project use.

## Purpose

The AI Code Review Factory provides a fast first-pass review for pull requests and merge requests. It should catch concrete correctness, security, performance, documentation, and release-risk issues before a human reviewer spends full attention.

The system is designed for many projects, not one repository. Project teams should adopt it through CI configuration and small project-local config files. The core review runner should not be forked per project.

## Non-goals

- Replace human code review entirely.
- Execute arbitrary untrusted code in privileged CI.
- Build a model-specific system that only works with one LLM provider or one agent CLI.
- Optimize for every possible review category in the MVP.
- Store secrets or long-lived project state inside PR/MR comments only.

## Design principles

1. **CI status is the canonical gate.** Comments and reviews are UX. A required CI job status is the reliable cross-platform merge blocker.
2. **Adapters at the edges.** GitHub, GitLab, agent runtimes, model providers, state stores, and telemetry sinks are adapter boundaries. Mechanically enforced (#27) by `bun run boundaries` (dependency-cruiser, `.dependency-cruiser.cjs`, blocking in CI): the runner must not import concrete adapters (this rule alone exempts two pure leaf utilities pending relocation: `publisher/markdown-escape.ts`, `runtime/runtime-kind.ts`), contracts import only contracts (no exemptions), VCS adapters never import each other, no dependency cycles, and the Pi runtime must keep routing `prompt-boundary.ts`. Each rule's error message states the remediation.
3. **Deterministic orchestration, agentic judgment.** Code controls fetching, filtering, fan-out, timeouts, retries, state, and publishing. Agents judge code risks inside bounded contracts.
4. **Specialize by risk and domain.** Small changes get cheap review. Risky changes get more agents and stronger models.
5. **Share context deliberately.** Multi-agent review must not duplicate the full PR/MR context into every prompt.
6. **Treat all PR/MR content as untrusted.** Titles, descriptions, comments, diffs, and repository files can contain prompt injection or malicious code.
7. **Fail behavior is policy.** Projects choose fail-open or fail-closed, but the runner must make that choice explicit.

### Break-glass / human override

The supported override today is a repo admin overriding the required CI check — the standard merge-gate bypass available in GitHub (branch protection → "Require status checks → allow administrator override") and GitLab (protected branch maintainer override). This is intentionally **admin-only** and is **not yet recorded as a review-level telemetry event** (accepted tradeoff at the small-team stage); the summary comment's "Break glass" footer links here. The footer is rendered on **every** summary comment, including approved reviews (collapsed inside `<details>` so it adds no noise), and its link is currently a fixed canonical URL to this repository's copy of this document — self-managed deployments inherit that link (not yet configurable).

Phase 2 (issue #22) — **implemented**: a per-developer `break glass` comment trigger on the PR/MR causes the run to emit the reserved `run.override` telemetry event and produce a **non-blocking CI status** for that run, so the merge can proceed without an admin check bypass. ("Non-blocking" here means the review job exits 0, so the required check **passes** — it renders as a green success, not a distinct grey "neutral" state.) Override rate (overall and per risk tier) is surfaced by `bun run telemetry:analyze`. The admin-required-check override remains the enforcement primitive for organization-level governance; the per-developer trigger is an auditable, measured escape hatch.

**How to trigger.** Post a **regular PR/MR conversation comment** (the "Leave a comment" box — not a code-review/inline comment, which the runner does not scan) whose **first line** is exactly:

```
break glass <head-sha>
```

(`break-glass <head-sha>` is also accepted). `<head-sha>` must be a **≥12-char** prefix of the commit being reviewed — **pasting the full 40-char commit SHA is recommended** (a short prefix is grindable; 12 hex chars / 48 bits is the enforced minimum). The override is **bound to that commit**, so it does NOT carry over to a later push (which would contain code the override author never saw); a new head needs a fresh comment. The comment author must be **trusted**: GitHub `author_association` ∈ {OWNER, MEMBER, COLLABORATOR}, or GitLab project access ≥ Developer (30). Comments from untrusted authors, a bare `break glass` without a matching SHA, a prefix under 12 chars, or the marker buried below the first line are all silently ignored. After posting, **re-run the review job** (e.g. re-push or re-trigger the workflow) so the runner re-reads comments and applies the override.

**Troubleshooting / limitations.** Detection is best-effort: any API error (e.g. insufficient token scope, transient failure) degrades silently to "no override" rather than failing the review. If a break-glass is unexpectedly ignored, check (1) the first line is exactly `break glass <sha>` with a ≥12-char prefix of the *current* head, (2) the author's association/access level, and (3) the token scope. On **GitLab**, the runner reads a single page of MR notes, so on a very busy MR (many notes) a break-glass comment may not be seen — post it recently and re-trigger, or use the admin override.

## System overview

A pull request or merge request triggers CI. CI starts the review runner with metadata identifying the repository, change ID, commit SHA, provider, and desired policy. The runner fetches change metadata and diff information through a VCS adapter, filters noisy files, classifies the risk tier, builds shared context, then asks a coordinator agent to orchestrate specialist reviewers.

Specialist reviewers run concurrently. Each reviewer has a narrow domain, scoped context, a structured output contract, and explicit instructions about what not to flag. The coordinator consolidates findings, removes duplicates and nitpicks, verifies uncertain claims when needed, and produces a final review decision.

The publisher adapter posts the result back to GitHub or GitLab and sets the CI outcome. Telemetry and trace events are written throughout the run.

```text
PR/MR event
  → CI job
  → review runner
  → VCS adapter fetches metadata, diff, comments, prior bot state
  → diff filter + risk classifier
  → shared context builder
  → coordinator agent
  → specialist reviewer fan-out
  → coordinator fusion/judgment
  → publisher posts review UX
  → CI status passes/fails/skips
  → telemetry/state persisted
```

## Core components

### Review runner

The review runner is the executable launched by CI. It owns the top-level workflow:

1. Detect CI environment.
2. Load project config.
3. Authenticate to the VCS provider.
4. Fetch PR/MR metadata, commits, diff, comments, and prior bot state.
5. Filter diff noise.
6. Classify risk.
7. Build shared context files.
8. Select agents and model tiers.
9. Run the coordinator and reviewers.
10. Publish comments/reviews/discussions.
11. Emit the final CI status.
12. Persist traces and state.

The runner should be usable both in CI and locally. Local mode uses the same review lifecycle but reads working-tree diffs instead of PR/MR metadata. The `--git-diff` CLI source (`src/runner/git-diff-source.ts`) implements this: it builds the same `ChangeMetadata` + `DiffSummary` from `git diff` (working tree vs `--base`, default `HEAD`) under `provider: "local"`, so a developer can review uncommitted changes — and capture telemetry/traces via `--output-dir` — before opening a PR. There is no adapter, so publishing is unavailable in this mode. (Untracked files are not included unless intent-added with `git add -N`.)

### VCS adapters

VCS adapters normalize GitHub and GitLab into one internal interface.

Required capabilities:

- Identify change ID, source branch, target branch, and head SHA.
- Fetch title, description, author, labels, and comments.
- Fetch changed files and patch/diff content.
- Fetch prior bot comments and inline review/discussion IDs.
- Publish summary comments.
- Publish inline findings where line mapping is available.
- Request changes / approve / resolve discussions where supported.

GitHub-specific notes:

- Pull request reviews support `APPROVE`, `REQUEST_CHANGES`, and `COMMENT`.
- Inline comments require commit SHA, path, line, and side coordinates.
- `Pull requests: write` permission is required for review/comment write-back.
- Required CI status should be the enforcement primitive.

GitLab-specific notes:

- Merge request discussions are the primary inline feedback primitive.
- Diff discussions require base/head/start SHAs plus old/new path and line coordinates.
- Approval API exists, but the bot user must be an eligible approver.
- Required pipeline success should be the enforcement primitive.

### CI adapters

CI adapters normalize the environment variables and token behavior for GitHub Actions and GitLab CI.

GitHub Actions responsibilities:

- Support same-repo PR workflows through `pull_request`.
- Support safe fork workflows without exposing secrets to untrusted code.
- Set minimal permissions, typically `contents: read` and `pull-requests: write` for trusted write-back.
- Optionally support a GitHub App token when `GITHUB_TOKEN` cannot satisfy required permissions.

GitLab CI responsibilities:

- Run for merge request pipelines with rules matching `CI_PIPELINE_SOURCE == "merge_request_event"`.
- Use project/group access tokens or bot tokens for write-back when `CI_JOB_TOKEN` is insufficient.
- Respect protected variable and protected runner rules.
- Treat fork MR parent-project pipelines as privileged and unsafe unless untrusted code is not executed.

### Diff and context builder

The context builder transforms raw VCS data into structured inputs for agents.

Outputs:

- Change metadata summary.
- File list with added/removed lines.
- Per-file patch files.
- Shared PR/MR context file.
- Prior review state.
- Project instructions.
- Risk-tier result.

Rules:

- Do not embed full diffs into every prompt.
- Store large context once and pass paths or stable references.
- Sanitize user-controlled prompt boundary tags.
- Mark title, body, comments, and diff content as untrusted data.
- Preserve enough context for reviewers to inspect relevant files.

Current artifact layout:

```text
.ai-review/context/
  change-context.json
  patches/
    0001-<safe-path-hint>-<hash>.patch
```

`change-context.json` contains run metadata, risk, prior state, and changed-file metadata with `patchPath` references. It intentionally omits inline patch bodies. Patch files are written once under `patches/` using deterministic safe names. Reviewer inputs carry `contextReferences` pointing at the shared context and assigned patch files; Pi reviewer prompts prefer those references and only fall back to inline diff payloads when read tools are unavailable.

The runner records context artifact byte counts in run metrics. Pi reviewer results also include prompt metrics for path-reference mode versus inline fallback estimates, so operators can measure whether shared context is reducing prompt payload size.

### Diff filter

The diff filter removes files that usually add cost without review value:

- lock files,
- vendored dependencies,
- generated source where safe,
- minified assets,
- source maps,
- binary files,
- large generated snapshots.

The filter must support project overrides. Some generated files are semantically important. Database migrations are the canonical example: they may be generated, but they change production schema and should be reviewed.

### Risk classifier

The risk classifier decides how much review compute to spend.

Initial tiers:

| Tier | Typical trigger | Agents | Default behavior |
|---|---|---:|---|
| Trivial | ordinary small changes of up to 5 files and 25 changed lines, no sensitive paths | 1–2 | code_quality specialist only; coordinator skipped when it produces zero findings |
| Lite | modest changes in ordinary files | 4 by default (uncapped) | all config-enabled roles (default: code quality + security + documentation); coordinator skipped when all specialists produce zero findings |
| Full | more than 50 files, more than 500 changed lines, or sensitive paths | 5 by default (uncapped) | all config-enabled specialists incl. `full_only` roles; coordinator synthesis always runs |

Security-sensitive paths always escalate to full review. Examples: authentication, authorization, crypto, secrets, policy, billing, migrations, deployment, CI, and permission boundaries.

Risk tier maps to runtime behavior through a single declarative table in `src/runner/tier-profile.ts` (issues #100/#101). All tier→behavior consumers — reviewer selection, timeout scaling, tool policy, and coordinator short-circuit — read from `getTierProfile()` rather than carrying their own tier checks. The profile fields are:

- **`reviewerRoleCap`**: trivial limits the reviewer roster to `["code_quality"]`; lite and full are uncapped (`"all_enabled"`). The cap intersects with config `reviewerPolicy` — it never re-enables a disabled role, nor does config enable a role the cap excludes. Security review is deliberately waived at trivial tier (telemetry showed it produced empty passes on every trivial run): sensitive paths always escalate to full, and `sensitivePaths` is the lever to widen that escalation for paths a project considers security-relevant.
- **`shortCircuitCoordinatorOnZeroFindings`**: trivial and lite skip the coordinator synthesis call when all dispatched reviewers succeed with zero findings. A deterministic approved summary is returned and the short-circuit is recorded in the `coordinator.completed` trace event and `run_metrics` telemetry (`coordinatorShortCircuited: true`). Full tier always runs the coordinator.
- **`timeoutScale`**: full=1, lite=0.5, trivial=0.25. Configured timeout values are full-review ceilings; effective limits are scaled by the active tier. Retryable reviewer failures are retried only when the remaining effective tier budget can still cover another reviewer attempt, the coordinator budget, and the retry reserve; the reserve is scaled by the same risk tier as those budgets so retry headroom stays proportional on lite and trivial runs instead of an unscaled floor swallowing the shrunken budget.
- **`denyContextTools`**: trivial and lite reviewers rely on supplied diff/context artifacts and deny repo-crawling read tools (`read`, `grep`, `find`, `ls`) plus shell/write tools (`bash`, `write`, `edit`); full reviews may use read/grep/find/ls when the selected safety mode allows them.

If the overall runtime timeout fires after one or more reviewers have completed, the runner may publish a clearly marked partial summary from those completed reviewer findings instead of discarding them. The partial result always carries `decision: "review_failed"` and `outcome: "fail"` regardless of completed-reviewer findings, so existing fail-open/fail-closed CI policy applies unchanged. A run with no completed reviewer output still fails normally.

**Failure mode — all reviewers fail (#120).** If *every* dispatched reviewer fails, the coordinator has nothing to synthesize, and the behavior splits by failure cause:

- **Content failures** (the model ran but its output was unusable for this diff — `schema_invalid`, `truncated`, `context_overflow`, or an otherwise-`unknown` parse failure) **degrade to a published `review_failed`/`fail` summary**, mirroring the timeout partial above. The summary body names the failed roles and their error categories, and the fail-open/fail-closed CI policy governs whether it blocks the merge. The run still has a failing outcome, but the PR carries a visible "review could not complete" notice instead of a silent missing comment.
- **Operational failures** (the review could not run — `provider_error`/quota-billing, `auth`, `rate_limited`, `retryable_transient`, `timeout`, `unsafe_fork`) keep **crashing the run loudly** (non-zero exit, no summary posted, `review.failed` trace with the error classification). This is deliberate: silently degrading an outage to a `review_failed` notice would let a fail-**open** repo pass merges through during a billing/auth incident. An infrastructure failure should alarm, not fail-open.

The split is an explicit allowlist (`DEGRADABLE_REVIEWER_FAILURE_CATEGORIES` in `pi-agent-runtime.ts`); an unrecognized category defaults to operational (crash), the safe direction. If *any* reviewer in an all-fail set hit an operational error, the whole run crashes by re-throwing the first failed reviewer's underlying error — so the operational crash surfaces as that error's own message (the provider/auth/rate-limit text) in the coordinator job log, not a generic sentinel. To triage a crash, read that re-thrown message, plus the `agent.failed` events on every reviewer step and the `review.failed` trace's `errorCategory`. Because model generation is non-deterministic, re-running is safe and often succeeds for content-triggered failures.

For observability, the degraded content path emits a coordinator `agent.output` (`decision: "review_failed"`, `allReviewersFailed: true`) and `agent.completed`, and the returned `CoordinatorRunResult` carries `partial.reason: "all_reviewers_failed"` (the same `partial` channel the overall-timeout path uses with `"overall_timeout"`). This is an internal runtime contract — adopters still consume `run.json` / `summary.json` / hidden metadata, where the degraded run appears as a normal completed run with a `review_failed` summary.

The implemented defaults deliberately widen trivial from the original 2-file cap to 5 files / 25 changed lines so ordinary small PRs do not over-spend lite-tier compute. The full file threshold is 50 files, matching the Cloudflare source's file-count trigger while keeping our 500-line guard. The MVP should still make thresholds configurable; today these defaults are hardcoded in the classifier.

### Agent runtime adapter

The system should not hard-code one agent runtime into the architecture. Define an `AgentRuntime` boundary.

Required capabilities:

- Start coordinator session.
- Start reviewer sessions concurrently.
- Stream structured events.
- Enforce timeout and cancellation.
- Expose scoped tool permissions.
- Return structured findings.
- Preserve enough trace data for debugging.

OpenCode is a strong first runtime because it supports programmatic sessions and JSONL output. The architecture should still allow later adapters for direct model APIs, Claude CLI, Codex CLI, or another harness.

**Pi runtime auth precedence (#42).** `pi` resolves credentials in the order `--api-key` flag > stored OAuth (`~/.pi/agent/auth.json`, e.g. an interactive Claude login) > provider env var (`ANTHROPIC_API_KEY`). Because a stored OAuth credential outranks a forwarded env key, simply exporting `ANTHROPIC_API_KEY` can silently run a review against an interactive login instead of the intended (funded) key. To pin auth explicitly, pass `--pi-api-key <key|env:NAME>` (requires `--runtime pi`; the flag is rejected otherwise); it forces `pi --api-key …`, overriding any stored OAuth. The `env:NAME` form (read from the named environment variable) is preferred so the secret stays out of the calling shell's history. The resolved key never enters trace or telemetry output, which carry events and counts, not the command line. It is, however, forwarded into the spawned `pi` argv — that is inherent to pi's `--api-key` override mechanism, and the value IS visible in the child process's command line (`ps` / `/proc/<pid>/cmdline`) for the lifetime of the run. `env:NAME` does not change that; on shared or multi-tenant runners, rely on host-level isolation rather than assuming the flag hides the secret from process introspection.

**Review liveness (#41).** A long-running review otherwise prints nothing between start and the final summary, which reads as a frozen terminal. The runtime emits periodic `heartbeat` events (alongside `agent.started`/`agent.completed`); the CLI consumes them — for any runtime that streams events, not just Pi — via a progress reporter that writes a periodic liveness line to **stderr**, never stdout, so a `--format json` payload stays clean. Progress is on by default for an interactive terminal or a CI job (so the job log shows liveness) and off for plain non-TTY pipes; `--progress` / `--no-progress` override.

### Model router

The model router maps each agent role to a provider/model tier.

Initial model tiers:

- **Top tier:** coordinator and final judgment.
- **Standard tier:** code quality, security, and performance.
- **Light tier:** documentation, release notes, instruction freshness, and text-heavy checks.

The router should support:

- project overrides,
- role-specific model assignments,
- provider disable switches,
- model failback chains,
- cost ceilings,
- dry-run mode.

### State store

The state store tracks prior reviews and supports incremental re-review.

MVP state can live in VCS-native artifacts:

- previous bot summary comment,
- hidden metadata block in bot comment,
- CI artifact with normalized findings,
- inline comment/discussion IDs.

Production state should use a real backing store:

- review run table,
- finding table,
- VCS comment/discussion mapping,
- token/cost records,
- model health state,
- project config snapshots,
- audit trail.

The runner should depend on a `ReviewStateStore` interface from day one.

### Telemetry sink

Telemetry must never block CI completion. If telemetry fails, review should continue and the failure should be logged.

Minimum metrics:

- review started/completed/failed,
- duration,
- risk tier,
- selected agents,
- model/provider per agent,
- token input/output/cache read/cache write where available,
- cost estimate,
- findings by severity and reviewer,
- final decision,
- override/break-glass usage,
- retry/failback counts,
- failure classification.

The trace stream should be JSONL so a partial run is still inspectable after failure.

## Review lifecycle

### 1. Trigger

The review starts from one of three triggers:

- PR/MR opened or updated.
- Manual CI dispatch / pipeline run.
- Local developer command.

The trigger supplies provider, repository, change ID, head SHA, and run mode.

### 2. Safety mode selection

The runner chooses a safety mode before reading code or using secrets.

| Mode | Use case | Allowed actions |
|---|---|---|
| Trusted | same-repo branch or trusted internal MR | read repo, write comments, use configured model secrets, optionally run safe commands |
| Untrusted read-only | fork PR/MR without write token | fetch metadata/diff, run static review with no secrets, emit artifact/status only |
| Privileged metadata-only | fork PR/MR with write-back needed | use privileged token but do not checkout or execute PR head code; fetch diff through API |
| Manual privileged | maintainer-approved run | write comments and use secrets after explicit approval |

Default: untrusted contributions must not execute code in a privileged context.

### 3. Fetch metadata and diff

The VCS adapter fetches:

- title and description,
- author and labels,
- source/target branches,
- head SHA,
- file list,
- patch/diff content,
- existing bot comments,
- unresolved bot threads,
- user replies to prior findings.

### 4. Filter and classify

The diff filter removes noise. The risk classifier chooses trivial, lite, or full review.

The classifier output includes an explanation so users can understand why the system spent more or less compute.

### 5. Build shared context

The context builder writes:

- shared change context,
- per-file patches,
- project instructions,
- prior findings,
- user reply summary.

Reviewers receive references to this context and only read what they need.

### 6. Coordinator starts

The coordinator receives:

- normalized MR/PR metadata,
- risk tier,
- selected reviewers,
- shared context location,
- project policy,
- output schema,
- prior review state.

The coordinator decides when to spawn reviewers and later performs consolidation.

### 7. Specialist reviewers run

Specialist reviewers run concurrently. Each reviewer is selected from a trusted operator-owned reviewer definition contract, not from reviewed-repo resources. Each definition carries:

- stable role and display name,
- trusted source marker (`trusted_operator`),
- domain summary,
- shared mandatory rules,
- what-to-flag list,
- what-not-to-flag list,
- allowed severity values,
- domain-specific severity rubric,
- domain-specific output expectations,
- per-definition content version.

Each runtime adapter then combines that trusted definition with scoped context, structured output schema, and timeout settings native to the runtime. Severity guidance is domain-specific and enforced as policy, not only prompt text: for example, security can emit `critical` for exploitable auth, secret, or privileged-boundary failures, while documentation is limited to `warning`/`suggestion` unless the trusted operator later defines a docs-specific critical bar. If a runtime receives an out-of-policy severity from a reviewer, it clamps to the maximum allowed severity and traces the adjustment.

MVP reviewers:

- code quality,
- security,
- documentation.

Later reviewers:

- performance,
- release/change management — **shipped (#23)**, opt-in (`reviewerPolicy.release`), allows `critical` for production-safety/rollout risks,
- compliance/policy — **shipped (#23)**, opt-in (`reviewerPolicy.compliance`); checks the diff against project-supplied `compliancePolicy` text read from the **base branch** and quoted as untrusted data (never trusted runtime config — see §"Trusted resource boundary"),
- comprehension gate — **shipped (#26)**, opt-in (`reviewerPolicy.comprehension`); a pre-review readiness reviewer that works a fixed 6-question rubric and flags unresolved comprehension gaps ("dark code"). Runs as an in-fan-out specialist (excluded on `trivial` by the roster cap); its findings produce a deterministic `summary.gateDecision` verdict (`allow`/`warn`/`block`) for observability, while CI pass/fail stays governed by the existing `mode`/`failOn` policy over findings (no separate gate mechanism),
- instruction freshness.

### 8. Coordinator consolidates

The coordinator performs:

- root-cause and changed-location deduplication,
- recategorization,
- false-positive filtering,
- nitpick suppression,
- severity normalization,
- source/evidence verification against changed files, metadata, or prior state,
- final decision.

The coordinator must prefer silence over low-confidence noise. A review with one concrete critical finding is better than a review with ten generic suggestions. Deterministic fallback summaries enforce a minimum quality floor: repeated findings are deduplicated, suggestions and a single non-production warning remain `approved_with_comments`, multiple warning patterns become `minor_issues`, and critical or production-safety risks become `significant_concerns`.

### 9. Publish review UX

The publisher posts:

- summary comment,
- inline comments where coordinates are reliable,
- optional approval or request-changes event where supported,
- hidden metadata for future re-review.

If inline coordinates are stale or ambiguous, publish the finding in the summary instead of failing the whole run.

### 10. Set CI outcome

The final CI result is derived from policy:

| Decision | Default CI outcome | Notes |
|---|---|---|
| approved | pass | no blocking findings |
| approved_with_comments | pass | suggestions/warnings without production risk |
| minor_issues | configurable | often pass for advisory mode; fail for strict mode |
| significant_concerns | fail | critical or production-safety risk |
| review_failed | configurable | fail-open for adoption, fail-closed for protected systems |

Projects choose advisory or blocking mode during rollout.

### 11. Persist state

The runner stores:

- normalized findings,
- final decision,
- comment/discussion IDs,
- trace artifact pointer,
- cost metrics,
- model/fallback decisions.

This enables incremental re-review (implemented for GitHub in #46; GitLab pending).

## Agent contracts

### Finding schema

All reviewer agents return findings in a normalized structure.

```json
{
  "reviewer": "security",
  "severity": "critical | warning | suggestion",
  "category": "auth | injection | correctness | performance | docs | release | other",
  "title": "Short concrete finding",
  "body": "Why this matters and what to change",
  "path": "relative/file.ext",
  "line": 123,
  "side": "RIGHT",
  "confidence": "high | medium | low",
  "evidence": ["specific observed fact"],
  "recommendation": "specific fix or mitigation"
}
```

Low-confidence findings should usually be omitted unless they describe a high-impact risk that deserves human attention.

### Severity rubric

- **Critical:** exploitable vulnerability, likely outage, data loss, auth bypass, broken migration, or production-safety risk.
- **Warning:** concrete regression risk, missing validation at a trust boundary, measurable performance concern, incomplete rollout/release step.
- **Suggestion:** useful improvement that should not block merge.

The bot can be wrong: see [Break-glass / human override](#break-glass--human-override) for the supported override path.

### Reviewer prompt pattern

Every reviewer prompt uses the same shape:

1. Role and domain.
2. Inputs available.
3. What to flag.
4. What not to flag.
5. Severity rubric.
6. Output schema.
7. Tool permissions.
8. Stop conditions.

The “what not to flag” section is mandatory. It prevents generic review spam and trains the system toward high-signal output.

### Coordinator contract

The coordinator must:

- call reviewers selected by the risk tier,
- wait for all reviewers or timeout,
- drop duplicate findings,
- drop speculative findings,
- verify uncertain high-severity claims when possible,
- preserve serious minority reports,
- produce one final decision,
- produce a human-readable summary.

## CI integration design

### GitHub Actions

Trusted same-repo PR mode:

```yaml
name: AI Code Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  ai-code-review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Run AI code review
        uses: org/ai-code-review-factory-action@v1
        with:
          mode: blocking
        env:
          AI_REVIEW_TOKEN: ${{ secrets.AI_REVIEW_TOKEN }}
```

Fork-safe options:

1. Use `pull_request` with no secrets and no write-back. Emit only artifacts/status.
2. Use a two-stage flow: unprivileged analysis artifact, privileged reporter validates strict JSON and posts comments.
3. Use `pull_request_target` only for metadata/diff review; do not checkout or execute the PR head.
4. Require maintainer approval before privileged review.

The architecture should support all four, but default documentation should recommend option 1 or 2 for public repositories.

### GitLab CI

Merge request pipeline mode:

```yaml
ai_code_review:
  image: registry.example.com/ai-code-review-factory:latest
  rules:
    - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  script:
    - ai-code-review run --provider gitlab --mode blocking
  variables:
    AI_REVIEW_CONFIG: .ai-review.yml
```

Write-back generally needs a bot/project/group token with sufficient API permissions. `CI_JOB_TOKEN` should not be assumed to support all comment, discussion, and approval operations.

Fork MR parent-project pipelines are privileged. They must not execute untrusted fork code unless a maintainer explicitly approved the run and accepts the risk.

## Security model

### Threats

- Prompt injection in PR/MR title, body, comments, or code diff.
- Secret exfiltration from untrusted fork code.
- Malicious code executed by reviewer tools.
- Cache poisoning in privileged CI contexts.
- Bot token abuse through compromised workflow config.
- Review spam that trains developers to ignore the bot.
- Incorrect blocking due to hallucinated findings.

### Controls

- Treat all VCS content as untrusted data.
- Sanitize prompt boundary tags.
- Use least-privilege tokens.
- Separate read-only analysis from privileged write-back where needed.
- Do not run untrusted code in privileged contexts.
- Disable shell execution for reviewers by default in untrusted mode.
- Require structured output schemas.
- Keep human break-glass override (see [Break-glass / human override](#break-glass--human-override)).
- Use CI status as deterministic enforcement.
- Make fail-open/fail-closed explicit per project.

### Trusted resource boundary

The factory separates **trusted operator resources** from **reviewed-repo resources**. Trusted operator resources are controlled by the review factory maintainer: reviewer definitions, coordinator rubrics, CI defaults, runtime hardening flags, and model credentials. Reviewed-repo resources are supplied by the repository or change under review: metadata, diffs, project config, checked-out files, and project-local agent instructions or extensions.

Only trusted operator resources may define reviewer authority in CI. Reviewed-repo content can be quoted, summarized, filtered, or used as data, but it must not become trusted runtime configuration unless a maintainer explicitly chooses a privileged mode. Reviewer policy in project config may enable or disable trusted factory-provided reviewer roles; it does not define new reviewer prompts. For the Pi runtime, this means reviewed-repo context files, skills, prompt templates, extensions, session state, and approval state remain disabled in CI-oriented runs.

## Resilience design

### Timeouts

- Per reviewer timeout.
- Coordinator timeout.
- Overall review timeout.
- Retry budget cutoff.

### Retry classification

Retryable:

- provider rate limit,
- provider 5xx,
- transient network failure,
- model output truncated by length if enough budget remains.

Not retryable:

- bad credentials,
- invalid project config,
- context overflow from oversized MR,
- schema violation after bounded repair attempts,
- unauthorized VCS write-back,
- unsafe fork mode.

### Fallbacks

- Model fallback within same model family where possible.
- Provider fallback when configured.
- Summary-only publication if inline comments fail.
- Advisory result if blocking decision cannot be published but policy allows fail-open.
- Human escalation when policy requires fail-closed.

## Re-review design

A re-review is not a fresh review. It must know prior findings and user replies.

Rules:

- Fixed finding: omit and resolve matching thread/comment where supported.
- Still present: re-emit and keep thread alive.
- User acknowledged/won’t fix: mark resolved unless risk worsened.
- User disagreed: coordinator evaluates the justification and either resolves or responds.
- New finding: publish normally.

This requires stable finding IDs. Generate IDs from reviewer, category, path, and normalized line/range only — **exclude** title and body, which are model-authored free text that changes between runs and would defeat recurrence matching (see #31). Store VCS comment/discussion IDs in state.

## Observability

### JSONL trace events

Every run emits JSONL events. Event types:

- `review.started`
- `context.built`
- `risk.assessed`
- `agent.started`
- `agent.output`
- `agent.skipped`
- `agent.failed`
- `agent.completed`
- `coordinator.completed`
- `publisher.completed`
- `review.thin_detected` (emitted only when output tokens are below the contextual floor — see `src/runner/thin-review.ts`; counts-only, never text; observability signal only — never affects decision, outcome, or CI status)
- `review.completed`

Each event includes run ID, project ID, change ID, timestamp, and enough metadata to debug without reading the full raw prompt. When project config references an enabled reviewer role with no trusted operator definition, the runner emits `agent.skipped` with `reason: "no_trusted_reviewer_definition"` instead of silently ignoring it.

Pi `agent.output` events may include `reviewerRoleAdjustmentCount` and `reviewerRoleAdjustments` when model-authored finding labels are normalized at a trust boundary. Specialist adjustments use `{ index, emittedReviewer, dispatchedRole, reason: "reviewer_role_mismatch" }`. Coordinator adjustments use `{ index, emittedReviewer, adjustedReviewer: "coordinator", reason: "coordinator_reviewer_not_dispatched" }` when the coordinator emits a reviewer label outside `coordinator` plus the specialist roles dispatched for that run. Operators should treat these as prompt-injection or schema-drift signals and inspect the corresponding raw output before relying on the affected finding attribution.

### Metrics

Track:

- review duration,
- cost by project/risk tier/model/agent,
- findings by severity/reviewer,
- false-positive markers when available,
- comments posted,
- inline comment failures,
- CI pass/fail decisions,
- break-glass count,
- retry/fallback count,
- cache hit rate where provider exposes it.

## Configuration model

Project config should be small and declarative.

Example:

```yaml
mode: advisory # advisory | blocking
fail_on:
  - critical
  - production_safety_risk
risk:
  trivial:
    max_lines: 25
    max_files: 5
  lite:
    max_lines: 500
    max_files: 50
sensitive_paths:
  - auth/**
  - crypto/**
  - migrations/**
  - .github/workflows/**
  - .gitlab-ci.yml
reviewers:
  code_quality: enabled
  security: enabled
  documentation: enabled
  performance: full_only
instructions:
  project_file: AGENTS.md
```

Central config should define model routing, provider settings, telemetry sink, and default reviewer prompts.

## MVP plan

### Phase 1 — minimal useful review

Build:

- review runner,
- GitHub adapter,
- GitLab adapter,
- trusted CI mode,
- diff fetch/filter,
- risk classifier,
- coordinator,
- code quality reviewer,
- security reviewer,
- summary comment publishing,
- CI pass/fail decision,
- JSONL trace artifact.

Skip initially:

- inline comments,
- approval API,
- model control plane,
- persistent database,
- instruction freshness reviewer,
- local TUI command.

### Phase 2 — review quality and re-review

Add:

- inline comments/discussions,
- stable finding IDs,
- prior bot state parsing,
- incremental re-review (**implemented for GitHub** — delta since `previousHeadSha`, carry-forward correctness for off-delta prior findings, safe fallback on unavailable delta / force-push / rebase; **GitLab falls back to full review — parity is a follow-up**),
- docs reviewer,
- warning/suggestion policy tuning,
- summary-only fallback.

### Phase 3 — operations and cost control

Add:

- model router,
- fallback chains,
- circuit breakers,
- telemetry sink,
- cost tracking,
- provider disable switch,
- prompt caching support where available.

### Phase 4 — multi-project maturity

Add:

- central config service,
- project onboarding templates,
- instruction freshness reviewer,
- release/change-management reviewer,
- local developer command,
- dashboard,
- false-positive feedback loop.

## Open decisions

1. First agent runtime adapter: provisional decision is runtime-neutral interface with a Pi-first prototype; see [Agent Runtime Comparison: OpenCode vs Pi](runtime-comparison.md).
2. First implementation language and packaging model: standalone container, GitHub Action, npm package, or all three?
3. Default public-repo fork strategy: read-only analysis, two-stage artifact handoff, or maintainer-approved privileged review?
4. Production state backend: Postgres, SQLite per deployment, object storage, or VCS-only until scale demands more?
5. Whether bot approvals should ever count toward required approvals, or whether CI status should remain the only enforceable signal.

## Reader-test checklist

A new engineer should now be able to answer:

- What starts a review?
- Which component fetches the diff?
- How are GitHub and GitLab kept behind one interface?
- Why is CI status the canonical merge blocker?
- What happens for fork PRs/MRs?
- Which agents run in the MVP?
- How does the coordinator use specialist reviewers?
- How are findings structured?
- What telemetry is required?
- What must be built in Phase 1 versus deferred?

If any answer is unclear during implementation, add it to the relevant section before writing code.

## Source grounding

This design is grounded in:

- Cloudflare’s production writeup: https://blog.cloudflare.com/ai-code-review/
- The previously captured vault notes on Cloudflare’s source article and the IndyDevDan commentary.
- Project research notes: [CI, VCS, runtime, and security interface points](../research/ci-vcs-runtime-findings.md)

### Primary-source deltas (exact values from the Cloudflare article)

Concrete values from the primary source that the vault synthesis abstracted. Recorded here so re-implementers use the real numbers and know where our build deliberately diverges. Tracked in roadmaps M008–M009 and issues #13/#14/#21.

- **Coordinator decision rubric.** only suggestions → `approved_with_comments`; *single* warning with no production risk → `approved_with_comments`; *multiple* warnings suggesting a risk pattern → `minor_issues` (unapprove); critical / production-safety → `significant_concerns` (block). Implemented in M009 S05 for coordinator prompting and deterministic fallback summaries (#13).
- **Prompt-injection.** Cloudflare strips a fixed XML tag set (`mr_input`, `mr_body`, `mr_comments`, `changed_files`, `existing_inline_findings`, `previous_review`, `custom_review_instructions`, `agents_md_template_instructions`) via `/<\/?(?:tag)[^>]*>/gi`. Ours embeds via JSON, so the vector is JSON-structure breakout; `repairUnescapedStringQuotes` is in scope as an attack surface. M009 S02 (#14). As of M015 S03 (#126) the Pi reviewer path delivers findings through the factory's `submit_findings` tool — Pi validates and surfaces the arguments as structured data (`readToolCallArgs`), so the happy path no longer runs `JSON.parse`/`repairUnescapedStringQuotes` at all; prose-parse-plus-repair is retained only as the fallback for runs where the (instruct-only, never-forced) tool call did not happen. As of M015 S04 (#127) the same swap applies to the coordinator: the coordinator delivers its fused summary via the factory-owned `submit_review` tool (primary path); prose-parse-plus-repair is the fallback. `submit_review` deliberately omits `risk` — risk is sourced from the trusted deterministic context (`input.context.risk`), not the model.
- **Risk tiers.** Cloudflare uses `files > 50 || hasSecurityFiles → full`; `lines ≤ 10 && files ≤ 20 → trivial`; `lines ≤ 100 && files ≤ 20 → lite`; else full. Our defaults deliberately use `files ≤ 5 && lines ≤ 25 → trivial`, `files > 50 || lines > 500 || sensitivePaths → full`, else lite. This keeps a tighter trivial file cap than Cloudflare while covering ordinary 3–5 file small PRs that previously over-spent lite-tier compute (#21).
- **Resilience constants.** per-task 5 min (10 for code quality); overall 25 min; retry skipped if < 2 min remain; **inactivity kill at 60s no-output**; circuit-breaker 2-min cooldown + exactly one probe; failback within model family via a flat map (`{"opus-4-7":"opus-4-6","opus-4-6":null}`); coordinator hot-swaps its model on retryable failure. Inactivity watchdog → M008 S04; advanced resilience → M012.
- **Observability signals.** token usage from `step_finish`; truncation = `step_finish` with `reason:"length"` → *retryable*; heartbeat every 30s (`"Model is thinking... (Ns since last output)"`); JSONL flushed every 100 lines / 50ms. M008 S03 + M011 S03.
- **Diff filtering.** content-marker generated detection (`// @generated`) in addition to path globs; **migrations exempt** from generated-filtering. Built (#24): `filterDiff` scans each file's patch head (first 4 KB, case-insensitive, **added lines only**) for the configurable `generatedFileMarkers` set **after** the `sensitivePaths` short-circuit, so a marked migration/auth file is still reviewed; marked files count as `generated` ignores. Scanning only added inline patch text means a marker on a deleted/context line or outside the diff hunks (or an offloaded `patchPath`) is not detected — the safe direction (a file is dropped only when a marker is actually added). `/* eslint-disable */` is intentionally **not** a default marker (low-precision signal + bypass lever). Because markers match author-authored diff text, drops are author-influenceable like path-glob ignores; `sensitivePaths` short-circuits to protect critical files and every drop is named by path in the `context.built` trace for audit.
- **Reported scale.** 131,246 runs / 48,095 MRs / 5,169 repos in 30 days; median 3m39s; cost avg $1.19 / median $0.98 / P99 $4.45; 1.2 findings/review; 85.7% cache hit; trivial $0.20 / lite $0.67 / full $1.68.
