# Internal/self-managed GitLab beta onboarding

Use this guide to onboard the first internal/self-managed GitLab beta repositories. The beta channel is intentionally internal-only: install the packaged CLI from an immutable internal tarball URL, keep the package `private: true` and `UNLICENSED`, and do not depend on public npm.

## Prerequisites

- A self-managed GitLab project with merge request pipelines enabled.
- A beta tarball produced from a trusted checkout with `npm pack` or the manual release artifact workflow.
- An immutable internal tarball URL reachable by CI runners, for example a GitLab release asset or generic package file.
- Bun-capable CI image access. The starter template uses `oven/bun:1.3`.
- A low-risk same-project merge request for the first smoke.

## CI variables

Configure these project or group CI/CD variables before enabling write-back:

| Variable | Required for | Suggested protection | Notes |
|---|---|---|---|
| `AI_REVIEW_PACKAGE` | dry-run + publish | unprotected is acceptable if the URL is read-only | Immutable internal tarball URL for the tested beta build. Do not use `main`, floating tags, or `latest`. |
| `AI_REVIEW_GITLAB_API_BASE_URL` | dry-run + publish | unprotected | Defaults to `$CI_API_V4_URL`; override only if the instance requires a custom API endpoint. |
| `GITLAB_TOKEN_READ` | dry-run | masked | Token with enough access to read project metadata, MR metadata, and MR diffs. |
| `GITLAB_TOKEN_WRITE` | publish | masked, protected when branch policy allows | Token with permission to create/update merge request notes. Only used by the same-project publish job. |
| Pi/model credentials | trusted publish or later model-backed jobs | masked + protected | Do not add until dummy-runtime summary publishing is stable. Treat them like write tokens. |

Do not rely on `CI_JOB_TOKEN` for summary publishing unless the target GitLab instance policy is explicitly verified. Use separate read and write token variables so the dry-run path can stay less privileged.

## Onboard one beta repository

1. Copy `examples/ci/gitlab-ai-review.yml` into the target repository's `.gitlab-ci.yml`, or include the same jobs in an existing pipeline.
2. Replace the sample `AI_REVIEW_PACKAGE` with the immutable internal tarball URL for the tested beta build.
3. Keep `AI_REVIEW_GITLAB_API_BASE_URL: "$CI_API_V4_URL"` unless the self-managed instance requires an explicit `https://gitlab.example.com/api/v4` endpoint.
4. Keep both runtime variables at `dummy` for the first rollout:

   ```yaml
   AI_REVIEW_DRY_RUN_RUNTIME: dummy
   AI_REVIEW_PUBLISH_RUNTIME: dummy
   ```

5. Add only `GITLAB_TOKEN_READ` and run a merge request pipeline. Verify the `ai_review_dry_run` job uploads `.ai-review/` artifacts.
6. Add `GITLAB_TOKEN_WRITE` and enable the guarded publish job. It should run only when:

   ```text
   $CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID
   ```

7. Rerun the same MR pipeline and confirm the bot updates one existing AI review summary note instead of creating duplicates.
8. Run the [GitLab live smoke](gitlab-live-smoke.md) self-managed readiness profile against a representative self-managed-GitLab MR and record the stable summary note ID.
9. After dummy summary publishing is stable, consider switching only trusted jobs to `AI_REVIEW_PUBLISH_RUNTIME: pi` and adding Pi/model credentials.

## Inspect artifacts

Every job should upload `.ai-review/` even on failure. Start with these files:

```text
.ai-review/runs/<runId>/run.json
.ai-review/runs/<runId>/summary.json
.ai-review/runs/<runId>/trace.jsonl
.ai-review/changes/gitlab/<encoded-repo-slug>/<encoded-change-id>/latest.json
```

What to check:

- `run.json.status` and `run.json.error` explain terminal failures.
- `summary.json` contains the rendered decision and findings used for CI exit behavior.
- `trace.jsonl` should end with `review.completed` for successful reviews or `review.failed` for runtime/model/schema failures.
- Publish runs should include `publisher.completed` with `provider: "gitlab"` and a stable `summaryCommentId`.

## Debug common failures

| Symptom | Likely cause | Next step |
|---|---|---|
| `bun add --global "$AI_REVIEW_PACKAGE"` fails | Tarball URL unreachable from runner, auth required, or mutable/incorrect URL | Verify runner network access and replace with the exact internal release asset/generic package file URL. |
| GitLab API 401/403 | Token missing, wrong scope, or unavailable to this pipeline context | Check `GITLAB_TOKEN_READ`/`GITLAB_TOKEN_WRITE` masking/protection and project membership. |
| GitLab API 404 | Wrong `CI_PROJECT_PATH`, MR IID, or API base URL | Confirm `$CI_API_V4_URL`, `$CI_PROJECT_PATH`, and `$CI_MERGE_REQUEST_IID` in job logs. |
| Publish job does not run | MR is from a fork/different source project or rules do not match | This is expected for untrusted/fork-like MRs; keep artifacts/status only. |
| Duplicate summary notes | Prior metadata not found or a different bot/token authored prior notes | Rerun with the same bot identity and inspect existing note hidden metadata. |
| `review.failed` in trace | Runtime/model/schema error | Inspect `run.json.error` and the final trace events before rerunning. |

## Secret rotation

- Rotate beta tokens after live smoke or if a token was pasted outside the secret store.
- Prefer project/group tokens with the minimum role and scope accepted by the self-managed GitLab instance.
- Keep read and write tokens separate; rotating the write token should not break dry-run artifact jobs.
- After rotation, rerun a dry-run and a same-project publish smoke to confirm both token paths.
- Remove tokens from beta repos that are no longer participating.

## Rollback

To disable write-back without removing dry-run coverage, remove or unset `GITLAB_TOKEN_WRITE` or temporarily disable `ai_review_publish_summary`. To disable all beta activity, remove the copied jobs or set rules so they do not match merge request pipelines.

## Non-goals for this beta

- No public npm release.
- No package license/access change.
- No privileged fork/fork-like write-back.
- No floating refs, `main`, or `latest` install sources.

GitLab inline discussions are now available (experimental) via `--publish-inline` using the same
`GITLAB_TOKEN_WRITE` variable described above, behind the readiness gates — see
[Inline publishing](inline-publishing.md) for the MVP limitations. A live smoke against a real beta
MR has not been run yet, so keep it opt-in.
