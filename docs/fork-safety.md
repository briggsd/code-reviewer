# Public repository fork safety

## Recommended default

For public repositories, default to **read-only analysis on `pull_request` plus artifacts/status only for fork PRs**.

That means:

- Run the AI review job from the normal `pull_request` / merge request pipeline context.
- Use read-only repository and PR/MR permissions.
- Do not expose model provider secrets or write tokens to fork PRs.
- Do not publish comments from the fork-triggered job.
- Upload `.ai-review/` as a CI artifact and use the CI status as the merge signal.

Use summary publishing only in a separate job that is guarded to same-repository/same-project changes, or after an explicit maintainer approval flow.

## Why this is the default

Fork PR/MR content is untrusted. Titles, descriptions, diffs, project config, and checked-out files can contain prompt injection or malicious code. The review factory can fetch metadata and diffs through provider APIs without executing project code, so privileged credentials should not be present in jobs that process untrusted fork content.

## Trusted operator resources vs reviewed-repo resources

The review factory has two resource layers:

- **Trusted operator resources** are shipped with or configured by the review factory operator. Examples include reviewer definitions, coordinator rubrics, runtime defaults, CI templates, and centrally managed model credentials. These resources can shape prompts and runtime behavior.
- **Reviewed-repo resources** come from the repository or change being reviewed. Examples include PR/MR titles, descriptions, comments, project config, diffs, checked-out files, and project-local agent instructions or extensions. Treat them as untrusted input unless the CI policy explicitly says the job is trusted.

The invariant for CI is: **reviewed-repo Pi resources stay disabled by default**. A reviewed repository must not be allowed to smuggle trusted instructions through project-local context files, skills, prompt templates, extensions, or approval/session state. The Pi adapter's CI invocation keeps those resource loaders off; only factory-controlled reviewer/coordinator instructions should act as trusted prompt authority.

Project config may select policy within the supported schema, but it is not a permission boundary and it does not make reviewed-repo content trusted. Use a separate maintainer-approved privileged mode if a job intentionally wants to load repository-local agent resources.

### Reviewer-label enforcement

Reviewer-definitions are the only trusted prompt authority, but a reviewer's *output* is still model-authored and untrusted — a prompt-injected diff can make it self-label a finding with another role (e.g. `security`) or emit a chosen finding `id`. The Pi runtime keeps identity factory-owned in two places:

- **Finding ids** are dropped centrally in `validateFinding` (the single chokepoint for all Pi findings, specialist *and* coordinator). `assignStableFindingIds` then recomputes the stable id from the corrected fields, so a model-supplied id can never win — closing the path where a spoofed id matching another finding's hash would corrupt re-review classification.
- **Reviewer role** is asserted at the specialist boundary (`enforceReviewerRole`): each finding's `reviewer` must equal the role the slot was dispatched under, is normalized back on mismatch, and a bounded `reviewerRoleAdjustments` entry is written to the `agent.output` trace so spoofing attempts are observable. The coordinator path is deliberately exempt from *role* normalization — it legitimately attributes consolidated findings across multiple roles. Tightening the coordinator's own emitted labels (it already sees normalized specialist inputs) is tracked separately.

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
