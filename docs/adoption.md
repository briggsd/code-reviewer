# Adoption guide

Use this guide when wiring AI Code Review Factory into another repository.

## Recommended adoption path

1. **Pin the package source.** Set `AI_REVIEW_PACKAGE` to an immutable npm tarball URL, an exact registry package version, or a full Git commit SHA for internal smoke only. Do not use `main`, floating tags, `latest`, or a checkout of the runner repository as the adopter install source.
2. **Start with dry-run only.** Copy `examples/ci/github-actions-ai-review.yml` or `examples/ci/gitlab-ai-review.yml`, keep `--runtime dummy`, and verify `.ai-review/` artifacts upload successfully.
3. **Enable same-repo/same-project summary publishing.** Keep dry-run and publish jobs separate. Only the guarded publish job should use write permissions and `--publish-summary`.
4. **Switch to Pi only in trusted jobs.** After summary-only dummy runs are stable, replace `--runtime dummy` with `--runtime pi` in a trusted job that can install Pi and access model credentials.
5. **Inspect failure artifacts before rerunning.** For failed runtime/model/schema runs, inspect `.ai-review/runs/<runId>/run.json` and `trace.jsonl`. Runtime failures should persist `run.json.error` and end the trace with `review.failed`.

## Minimal GitHub shape

```yaml
env:
  AI_REVIEW_PACKAGE: https://example.invalid/ai-code-review-factory-0.1.0.tgz

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

Use the full template in `examples/ci/github-actions-ai-review.yml` for the separate guarded publish job.

## What has been live-tested

- **GitHub same-repository summary publishing:** PR #2 verified dry-run, artifact upload, same-repo summary publishing, and idempotent update of a single bot summary comment.
- **GitHub re-review metadata:** seeded provider-backed publishes against PR #2 verified new, recurring, and fixed finding classification from hidden metadata.
- **Packaged external install:** `bun run smoke:external-package` verifies isolated Bun global install plus installed `ai-code-review` execution; a live GitHub provider-backed variant has run successfully.
- **Packaged Pi runtime:** `AI_REVIEW_LIVE_PI=1 bun run smoke:pi` has run successfully through the packed CLI and Pi JSON mode, producing `run.json`, `summary.json`, and `trace.jsonl` artifacts.
- **Failure observability:** tests simulate runtime failure and assert persisted `run.json.error` plus a terminal `review.failed` trace event.

## Not yet live-tested or intentionally deferred

- **Inline comments/discussions:** deferred. `evaluateInlinePublishReadiness()` exists, but default write-back remains summary-only.
- **GitLab live publishing:** adapters and templates are covered by tests, but no live GitLab MR smoke has been recorded in this repository yet.
- **Container image, GitHub Action wrapper, GitLab component wrapper:** deferred until the CLI/package interface and safety controls stabilize.
- **Fork privileged write-back:** not enabled by default. Fork PRs/MRs should remain artifact/status-only unless a separate approved privileged reporter flow is designed.

## Adoption checklist

- [ ] Bun is installed before `bun add --global "$AI_REVIEW_PACKAGE"`.
- [ ] `AI_REVIEW_PACKAGE` is immutable or exact-version pinned.
- [ ] Dry-run and publish jobs are separate.
- [ ] Fork PR/MR jobs do not receive write tokens or model/runtime credentials.
- [ ] `.ai-review/` artifacts upload even on failure.
- [ ] Summary publishing updates an existing bot comment/note instead of duplicating it.
- [ ] Pi/model credentials are only available in trusted jobs.
- [ ] Runtime failures leave `run.json.error` and `trace.jsonl` ending in `review.failed`.
- [ ] Inline publishing remains disabled unless a future milestone explicitly enables it behind readiness gates.
