# Adoption guide

Use this guide when wiring AI Code Review Factory into another repository. For the Fortis/self-managed GitLab beta operator checklist, see [Fortis GitLab beta onboarding](fortis-gitlab-beta.md).

## Recommended adoption path

1. **Pin the package source.** Set `AI_REVIEW_PACKAGE` to an immutable npm tarball URL, an exact registry package version, or a full Git commit SHA for internal smoke only. For the Fortis/self-managed GitLab beta, prefer a versioned internal tarball URL and keep the package private/`UNLICENSED`; public npm is not required. Do not use `main`, floating tags, `latest`, or a checkout of the runner repository as the adopter install source.
2. **Start with dry-run only.** Copy `examples/ci/github-actions-ai-review.yml`, `examples/ci/github-actions-ai-review-action.yml`, or the Fortis/self-managed GitLab beta template at `examples/ci/gitlab-ai-review.yml`, keep the runtime variables at `dummy`, and verify `.ai-review/` artifacts upload successfully. For self-managed GitLab, keep `AI_REVIEW_GITLAB_API_BASE_URL` set to `$CI_API_V4_URL` or your explicit `https://gitlab.example.com/api/v4` endpoint.
3. **Enable same-repo/same-project summary publishing.** Keep dry-run and publish jobs separate. Only the guarded publish job should use write permissions and `--publish-summary`.
4. **Optionally enable GitHub inline publishing in the guarded write-back job.** Only after summary publishing is stable, add `--publish-inline` for same-repository GitHub PRs. Keep the default dry-run job inline-free.
5. **Switch to Pi only in trusted jobs.** After summary-only dummy runs are stable, replace `--runtime dummy` with `--runtime pi` in a trusted job that can install Pi and access model credentials.
6. **Inspect failure artifacts before rerunning.** For failed runtime/model/schema runs, inspect `.ai-review/runs/<runId>/run.json` and `trace.jsonl`. Runtime failures should persist `run.json.error` and end the trace with `review.failed`.

## Minimal GitHub shape

```yaml
env:
  AI_REVIEW_PACKAGE: https://gitlab.example.com/fortis/dev-tools/ai-code-review-factory/-/releases/v0.1.0/downloads/ai-code-review-factory-0.1.0.tgz

jobs:
  dry-run:
    permissions:
      contents: read
      pull-requests: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.0
      - run: bun add --global "$AI_REVIEW_PACKAGE"
      - run: |
          ai-code-review run \
            --provider github \
            --repo "${{ github.repository }}" \
            --change-id "${{ github.event.pull_request.number }}" \
            --head-sha "${{ github.event.pull_request.head.sha }}" \
            --runtime dummy \
            --output-dir .ai-review \
            --ci-exit
```

Use the full raw CLI template in `examples/ci/github-actions-ai-review.yml` or the wrapper template in `examples/ci/github-actions-ai-review-action.yml` for the separate guarded publish job. The wrapper is documented in [GitHub Action wrapper](github-action-wrapper.md).

## What has been live-tested

- **GitHub same-repository summary publishing:** PR #2 verified dry-run, artifact upload, same-repo summary publishing, and idempotent update of a single bot summary comment.
- **GitHub re-review metadata:** seeded provider-backed publishes against PR #2 verified new, recurring, and fixed finding classification from hidden metadata.
- **Packaged external install:** `bun run smoke:external-package` verifies isolated Bun global install plus installed `ai-code-review` execution; a live GitHub provider-backed variant has run successfully.
- **Packaged Pi runtime:** `AI_REVIEW_LIVE_PI=1 bun run smoke:pi` has run successfully through the packed CLI and Pi JSON mode, producing `run.json`, `summary.json`, and `trace.jsonl` artifacts.
- **Failure observability:** tests simulate runtime failure and assert persisted `run.json.error` plus a terminal `review.failed` trace event.
- **GitHub inline publishing:** unit/adapter coverage verifies readiness gating, GitHub review comment creation, skipped reasons, and duplicate suppression. Live smoke status is tracked in `docs/inline-publishing.md` and `docs/workflow-smoke-test.md`.
- **GitLab live summary publishing:** M005 smoke against `test-group-zinga/general` MR #3 verified metadata/diff fetch, summary note publish, and idempotent update of one GitLab note.

## Not yet live-tested or intentionally deferred

- **GitLab inline discussions:** deferred. `evaluateInlinePublishReadiness()` exists, but GitLab diff discussion posting is not implemented yet.
- **Container image, GitHub Action wrapper, GitLab component wrapper:** deferred until the CLI/package interface and safety controls stabilize.
- **Fork privileged write-back:** not enabled by default. Fork PRs/MRs should remain artifact/status-only unless a separate approved privileged reporter flow is designed.

## Adoption checklist

- [ ] Bun is installed before `bun add --global "$AI_REVIEW_PACKAGE"`.
- [ ] `AI_REVIEW_PACKAGE` is an immutable internal tarball URL or exact-version pinned package source.
- [ ] Self-managed GitLab jobs pass `--api-base-url` from `$CI_API_V4_URL` or an explicit `AI_REVIEW_GITLAB_API_BASE_URL`.
- [ ] Dry-run and publish jobs are separate.
- [ ] GitLab beta templates keep `AI_REVIEW_DRY_RUN_RUNTIME` and `AI_REVIEW_PUBLISH_RUNTIME` explicit, defaulting to `dummy` until trusted model-backed jobs are approved.
- [ ] Fork PR/MR jobs do not receive write tokens or model/runtime credentials.
- [ ] `.ai-review/` artifacts upload even on failure.
- [ ] Summary publishing updates an existing bot comment/note instead of duplicating it.
- [ ] Pi/model credentials are only available in trusted jobs.
- [ ] Runtime failures leave `run.json.error` and `trace.jsonl` ending in `review.failed`.
- [ ] Inline publishing remains disabled by default; if enabled, it is GitHub-only, same-repo/trusted, and uses `--publish-inline` behind readiness gates.
