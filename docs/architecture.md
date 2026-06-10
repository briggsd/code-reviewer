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
2. **Adapters at the edges.** GitHub, GitLab, agent runtimes, model providers, state stores, and telemetry sinks are adapter boundaries.
3. **Deterministic orchestration, agentic judgment.** Code controls fetching, filtering, fan-out, timeouts, retries, state, and publishing. Agents judge code risks inside bounded contracts.
4. **Specialize by risk and domain.** Small changes get cheap review. Risky changes get more agents and stronger models.
5. **Share context deliberately.** Multi-agent review must not duplicate the full PR/MR context into every prompt.
6. **Treat all PR/MR content as untrusted.** Titles, descriptions, comments, diffs, and repository files can contain prompt injection or malicious code.
7. **Fail behavior is policy.** Projects choose fail-open or fail-closed, but the runner must make that choice explicit.

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

The runner should be usable both in CI and locally. Local mode uses the same review lifecycle but reads working-tree diffs instead of PR/MR metadata.

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
| Trivial | very small changes, no sensitive paths | 2 | coordinator + general reviewer |
| Lite | modest changes in ordinary files | 3–4 | coordinator + code quality + docs + optional domain reviewer |
| Full | large changes, many files, or sensitive paths | 6+ | all relevant specialists |

Security-sensitive paths always escalate to full review. Examples: authentication, authorization, crypto, secrets, policy, billing, migrations, deployment, CI, and permission boundaries.

The MVP should make thresholds configurable. Cloudflare’s published thresholds are useful defaults, not universal constants.

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
- release/change management,
- compliance/policy,
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

This enables incremental re-review.

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
- Keep human break-glass override.
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
- `review.completed`

Each event includes run ID, project ID, change ID, timestamp, and enough metadata to debug without reading the full raw prompt. When project config references an enabled reviewer role with no trusted operator definition, the runner emits `agent.skipped` with `reason: "no_trusted_reviewer_definition"` instead of silently ignoring it.

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
    max_lines: 10
    max_files: 20
  lite:
    max_lines: 100
    max_files: 20
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
- incremental re-review,
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
- **Prompt-injection.** Cloudflare strips a fixed XML tag set (`mr_input`, `mr_body`, `mr_comments`, `changed_files`, `existing_inline_findings`, `previous_review`, `custom_review_instructions`, `agents_md_template_instructions`) via `/<\/?(?:tag)[^>]*>/gi`. Ours embeds via JSON, so the vector is JSON-structure breakout; `repairUnescapedStringQuotes` is in scope as an attack surface. M009 S02 (#14).
- **Risk tiers (theirs).** `files > 50 || hasSecurityFiles → full`; `lines ≤ 10 && files ≤ 20 → trivial`; `lines ≤ 100 && files ≤ 20 → lite`; else full. Ours is stricter on trivial (`files ≤ 2 && lines ≤ 20`) and on full (`files > 20 || lines > 500`). Recalibration decision: #21.
- **Resilience constants.** per-task 5 min (10 for code quality); overall 25 min; retry skipped if < 2 min remain; **inactivity kill at 60s no-output**; circuit-breaker 2-min cooldown + exactly one probe; failback within model family via a flat map (`{"opus-4-7":"opus-4-6","opus-4-6":null}`); coordinator hot-swaps its model on retryable failure. Inactivity watchdog → M008 S04; advanced resilience → M012.
- **Observability signals.** token usage from `step_finish`; truncation = `step_finish` with `reason:"length"` → *retryable*; heartbeat every 30s (`"Model is thinking... (Ns since last output)"`); JSONL flushed every 100 lines / 50ms. M008 S03 + M011 S03.
- **Diff filtering.** content-marker generated detection (`// @generated`, `/* eslint-disable */`) in addition to path globs; **migrations exempt** from generated-filtering. Our build covers migrations via `sensitivePaths` short-circuit; content-marker detection is an unbuilt minor enrichment.
- **Reported scale.** 131,246 runs / 48,095 MRs / 5,169 repos in 30 days; median 3m39s; cost avg $1.19 / median $0.98 / P99 $4.45; 1.2 findings/review; 85.7% cache hit; trivial $0.20 / lite $0.67 / full $1.68.
