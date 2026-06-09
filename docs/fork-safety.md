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

Do not assume `CI_JOB_TOKEN` can publish comments/notes. Use separate read and write token variables such as `GITLAB_TOKEN_READ` and `GITLAB_TOKEN_WRITE`, and keep write tokens protected/scoped.

## Model/runtime secrets

Treat model credentials like write tokens. They should not be available in fork-triggered jobs unless the runtime is guaranteed not to execute project code, not to load project-local agent instructions as trusted instructions, and not to expose tools that can exfiltrate secrets.

The current Pi runtime adapter disables project-local Pi resources by default, but fork pipelines should still avoid privileged credentials unless using an explicitly approved privileged mode.

## Safe rollout sequence

1. Start with dry-run artifacts/status only for all PRs/MRs.
2. Enable same-repo/same-project summary publishing after idempotent summary updates are verified.
3. Add model-backed review secrets only to trusted jobs.
4. Consider a two-stage reporter for forks if comment UX is required.
5. Defer inline comments/discussions until line-coordinate and stale-diff gates are implemented.
