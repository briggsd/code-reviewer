# Public repository fork safety

## Recommended default

For public repositories, default to **read-only analysis on `pull_request` plus artifacts/status only for fork PRs**.

That means:

- Run the AI review job from the normal `pull_request` / merge request pipeline context.
- Use read-only repository and PR/MR permissions.
- Do not expose model provider secrets or write tokens to fork PRs.
- Do not publish comments from the fork-triggered job.
- Upload `.ai-review/runs` as a CI artifact (counts-only telemetry + run/summary/redacted trace) and use the CI status as the merge signal. The PR diff and metadata under `.ai-review/context/` are deliberately not uploaded.

Use summary publishing only in a separate job that is guarded to same-repository/same-project changes, or after an explicit maintainer approval flow.

## Why this is the default

Fork PR/MR content is untrusted. Titles, descriptions, diffs, project config, and checked-out files can contain prompt injection or malicious code. The review factory can fetch metadata and diffs through provider APIs without executing project code, so privileged credentials should not be present in jobs that process untrusted fork content.

## Trace redaction in CI artifacts

`trace.jsonl` reproduces, verbatim, both the operator reviewer-definition system prompts and
the embedded untrusted PR context (Pi `message_start` events) **and** the model's reply text,
which can quote diff excerpts including secrets (Pi `message_end` and streamed
`content_block_*` / `message_delta` events). To keep downloadable CI artifacts safe, the
real-review job passes **`--redact-trace` by default**, which replaces the text `content` of
both `message_start` and `message_end` events with a redaction marker while preserving the
event envelope and numeric token-usage metadata.

Only the `trusted-real-review` (Pi) job redacts, because it is the only job whose runtime
emits `message_start` / `message_end` events. The `dry-run` and `trusted-publish` jobs use the
dummy runtime, which emits no such events, so their traces carry no prompt or model-output text.

**Exposing the full trace for troubleshooting.** Set the repository variable
`AI_REVIEW_EXPOSE_TRACE_PROMPTS=true` to drop `--redact-trace` for the real-review job and write
the **unredacted** trace. This exposes the operator prompts, the embedded PR diff/metadata
(`message_start.content`), and the model output — enable it only when you accept that wider
egress for the artifact's audience. `--redact-trace` is a plain CLI flag, so any direct
`bun run src/cli.ts run` invocation (local debugging, non-GitHub CI) can pass or omit it the
same way; omitting it writes the full prompt and reply text to `trace.jsonl`.

**Artifact scope.** CI artifacts are scoped to `.ai-review/runs` (counts-only telemetry +
`run.json` / `summary.json` + the redacted trace); the PR diff and metadata under
`.ai-review/context/` (`patches/*.patch`, `change-context.json`) are deliberately excluded from
every artifact upload. Operators who copied an earlier version of the workflow template should
update all three `upload-artifact` `path:` values from `.ai-review` to `.ai-review/runs` and add
`--redact-trace` (or the `AI_REVIEW_EXPOSE_TRACE_PROMPTS` toggle) to the real-review invocation;
the old layout uploaded the full `.ai-review/` tree with unredacted prompts and PR diffs.

## Trusted operator resources vs reviewed-repo resources

The review factory has two resource layers:

- **Trusted operator resources** are shipped with or configured by the review factory operator. Examples include reviewer definitions, coordinator rubrics, runtime defaults, CI templates, and centrally managed model credentials. These resources can shape prompts and runtime behavior.
- **Reviewed-repo resources** come from the repository or change being reviewed. Examples include PR/MR titles, descriptions, comments, project config, diffs, checked-out files, and project-local agent instructions or extensions. Treat them as untrusted input unless the CI policy explicitly says the job is trusted.

The invariant for CI is: **reviewed-repo Pi resources stay disabled by default**. A reviewed repository must not be allowed to smuggle trusted instructions through project-local context files, skills, prompt templates, extensions, or approval/session state. The Pi adapter's CI invocation keeps those resource loaders off; only factory-controlled reviewer/coordinator instructions should act as trusted prompt authority.

The distinction is *discovery* vs *explicit load*, not "no extensions at all." The Pi adapter passes `--no-extensions` (which turns off reviewed-repo extension **discovery**) and **separately** loads exactly one trusted, factory-owned extension by explicit path: `--extension <…>/scripts/pi-extensions/submit-findings-extension.ts` (M015 S03, #126). The repo-relative source location is shown here for reference; the literal CLI argument is an **absolute** path resolved from the installed module location at runtime, so that is what appears in a `ps` / `/proc/<pid>/cmdline` listing. Pi's loader honors an explicit `-e`/`--extension` path even under `--no-extensions`, so this loads the factory's two trusted structured-output tools — `submit_findings` (reviewer) and `submit_review` (coordinator, M015 S04, #127) — without re-opening discovery of repo-local extensions. The file is shipped with the package and never read from the reviewed repo, so it stays on the trusted-operator side of the boundary. Reviewer and coordinator output is still re-validated through `validateFinding` / `parseCoordinatorToolArgs` after delivery (Pi output is untrusted regardless of delivery channel).

Project config may select policy within the supported schema, but it is not a permission boundary and it does not make reviewed-repo content trusted. Use a separate maintainer-approved privileged mode if a job intentionally wants to load repository-local agent resources.

### Reviewer-label enforcement

Reviewer-definitions are the only trusted prompt authority, but a reviewer's *output* is still model-authored and untrusted — a prompt-injected diff can make it self-label a finding with another role (e.g. `security`) or emit a chosen finding `id`. The Pi runtime keeps identity factory-owned in two places:

- **Finding ids** are dropped centrally in `validateFinding` (the single chokepoint for all Pi findings, specialist *and* coordinator). `assignStableFindingIds` then recomputes the stable id from the corrected fields, so a model-supplied id can never win — closing the path where a spoofed id matching another finding's hash would corrupt re-review classification.
- **Reviewer role** is asserted at the specialist boundary (`enforceReviewerRole`): each finding's `reviewer` must equal the role the slot was dispatched under, is normalized back on mismatch, and a bounded `reviewerRoleAdjustments` entry is written to the `agent.output` trace so spoofing attempts are observable.
- **Coordinator reviewer labels** are membership-checked against `coordinator` plus the specialist roles dispatched for that run. In-set labels are preserved because the coordinator legitimately attributes consolidated findings across roles. Out-of-set labels are normalized to `coordinator`, with a bounded `reviewerRoleAdjustments` entry, so published summaries and stable finding IDs cannot be keyed on an arbitrary model-emitted role.

## Permission matrix

| Scenario | Trigger/context | Checkout allowed? | Secrets/model credentials? | VCS write token? | Publish summary? |
|---|---|---:|---:|---:|---:|
| Public fork dry run | `pull_request` / MR pipeline | Yes, for config only; do not run project install/scripts | No | No | No |
| Same-repo PR/MR publish | Same-repository/same-project guard | Yes | Yes, if needed by runtime | Yes, least privilege | Yes, summary only |
| Two-stage reporter | Unprivileged artifact then trusted reporter | Reporter reads validated artifact only | Reporter only | Reporter only | Yes, summary only |
| Manual privileged run | Maintainer-approved workflow | Yes, if reviewer accepts risk | Yes | Yes | Yes |

## GitHub Actions guidance

Use `pull_request` for the default dry-run job with:

```yaml
permissions:
  contents: read
  pull-requests: read
```

Keep write-back in a separate job guarded with:

```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
permissions:
  contents: read
  pull-requests: write
```

Avoid using `pull_request_target` for the review runner unless the job is metadata-only and never checks out or executes the PR head. `pull_request_target` runs with privileged base-repository context, so combining it with untrusted checkout or project scripts can expose secrets.

## GitLab guidance

Run the dry-run job in merge request pipelines with a read token. Keep summary publishing in a separate same-project guarded job:

```yaml
rules:
  - if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID'
```

Do not assume `CI_JOB_TOKEN` can publish comments/notes. Use separate read and write token variables such as `GITLAB_TOKEN_READ` and `GITLAB_TOKEN_WRITE`, and keep write tokens protected/scoped. On self-managed GitLab, pass the instance API endpoint from `$CI_API_V4_URL` (or an explicitly configured `AI_REVIEW_GITLAB_API_BASE_URL`) to `ai-code-review run --api-base-url`; do not let templates silently fall back to GitLab.com.

## Model/runtime secrets

Treat model credentials like write tokens. They should not be available in fork-triggered jobs unless the runtime is guaranteed not to execute project code, not to load project-local agent instructions as trusted instructions, and not to expose tools that can exfiltrate secrets.

The current Pi runtime adapter disables project-local Pi resources by default, but fork pipelines should still avoid privileged credentials unless using an explicitly approved privileged mode.

## Safe rollout sequence

1. Start with dry-run artifacts/status only for all PRs/MRs.
2. Enable same-repo/same-project summary publishing after idempotent summary updates are verified.
3. Add model-backed review secrets only to trusted jobs.
4. Consider a two-stage reporter for forks if comment UX is required.
5. Defer inline comments/discussions until line-coordinate and stale-diff gates are implemented.
