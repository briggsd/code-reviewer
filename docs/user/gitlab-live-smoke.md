# GitLab live smoke

Use this smoke to prove the GitLab adapter against a real merge request. The script is disabled by default and exits without network access unless `AI_REVIEW_LIVE_GITLAB=1` is set.

## What it verifies

The smoke can verify, depending on flags:

- merge request metadata fetch,
- merge request diff fetch,
- dummy-runtime review execution,
- `.ai-review` artifact generation,
- optional summary note publishing with `--publish-summary`,
- idempotent update of the existing AI review summary note on rerun.

GitLab inline discussions remain deferred; this smoke does not attempt inline discussion publishing.

## Prerequisites

Use a same-project merge request that is safe for trusted write-back testing. Do not run this smoke with write tokens on untrusted fork MRs. For self-managed GitLab, set `AI_REVIEW_GITLAB_API_BASE_URL` to the instance API v4 URL, such as `https://gitlab.example.com/api/v4`; in GitLab CI the equivalent built-in variable is `$CI_API_V4_URL`.

Required environment:

```bash
export AI_REVIEW_LIVE_GITLAB=1
export AI_REVIEW_GITLAB_REPO="group/project"          # URL-encoded project path is not needed; the CLI encodes it
export AI_REVIEW_GITLAB_CHANGE_ID="123"              # MR IID, not global project ID
export AI_REVIEW_GITLAB_TOKEN="..."                  # or GITLAB_TOKEN
```

Optional environment:

```bash
export AI_REVIEW_GITLAB_HEAD_SHA="..."               # defaults to unknown; set for stricter traceability
export AI_REVIEW_GITLAB_API_BASE_URL="https://gitlab.example.com/api/v4"
export AI_REVIEW_GITLAB_OUTPUT_DIR=".ai-review-gitlab-smoke"
export AI_REVIEW_GITLAB_SEED_FIXTURE="examples/fixtures/auth-pr.json"
export AI_REVIEW_GITLAB_RUNTIME="dummy"
export AI_REVIEW_GITLAB_PUBLISH_SUMMARY=1             # opt into write-back
```

Token guidance:

- Read-only dry-run needs enough access to read the target project, MR metadata, and MR diffs.
- Summary publishing needs permission to create/update MR notes.
- Prefer a narrowly scoped project/group token for the smoke.
- Never expose the token to fork MR pipelines or untrusted code execution.

## Self-managed GitLab readiness profile

For a representative self-managed-GitLab beta smoke, create or reuse a low-risk same-project MR on the self-managed instance and run the smoke twice: first dry-run, then summary publish twice to prove idempotent updates.

```bash
export AI_REVIEW_LIVE_GITLAB=1
export AI_REVIEW_GITLAB_API_BASE_URL="https://gitlab.example.com/api/v4"
export AI_REVIEW_GITLAB_REPO="group/project"
export AI_REVIEW_GITLAB_CHANGE_ID="123"
export AI_REVIEW_GITLAB_HEAD_SHA="$(git rev-parse HEAD)" # or the MR head SHA from GitLab
export AI_REVIEW_GITLAB_TOKEN="..."
export AI_REVIEW_GITLAB_OUTPUT_DIR=".ai-review-gitlab-smoke"
export AI_REVIEW_GITLAB_RUNTIME="dummy"
```

Readiness checks:

1. Run `bun run smoke:gitlab` and confirm metadata/diff fetch plus `.ai-review-gitlab-smoke/` artifacts.
2. Run `AI_REVIEW_GITLAB_PUBLISH_SUMMARY=1 bun run smoke:gitlab` and record the `summaryCommentId` from `trace.jsonl`.
3. Rerun the same publish command against the same MR and confirm the same `summaryCommentId` is reused.
4. Inspect the MR notes and verify exactly one AI review summary note exists after the rerun.
5. Record the GitLab instance URL, project path, MR IID, head SHA, tarball/source commit SHA, and note ID in beta rollout notes.

Keep the smoke on `dummy` runtime until token boundaries and summary-note behavior are proven. Add Pi/model credentials only in a trusted follow-up job.

## Commands

Dry-run provider smoke:

```bash
bun run smoke:gitlab
```

Summary publish smoke:

```bash
AI_REVIEW_GITLAB_PUBLISH_SUMMARY=1 bun run smoke:gitlab
```

Rerun the summary publish smoke against the same MR to verify the adapter updates the existing AI review note instead of creating a duplicate.

## Expected evidence

A successful run prints `GitLab live smoke passed` and writes artifacts under `AI_REVIEW_GITLAB_OUTPUT_DIR` or a temporary directory. Inspect:

```text
<output>/runs/<runId>/trace.jsonl
<output>/runs/<runId>/run.json
<output>/runs/<runId>/summary.json
<output>/changes/gitlab/<encoded-repo-slug>/<encoded-change-id>/latest.json
```

For publish runs, `trace.jsonl` should include a `publisher.completed` event with `provider: "gitlab"` and a stable `summaryCommentId`. On rerun, the same bot note should be updated rather than duplicated. For self-managed beta readiness, verify exactly one AI review summary note exists on the MR after the rerun.

## Current status

M005 S05 live smoke completed against `test-group-zinga/general` MR #3 on GitLab.com:

- created a same-project temporary smoke MR with a one-file change,
- dry-run smoke fetched MR metadata/diff and completed review artifacts successfully,
- summary publish smoke posted GitLab note `3437836767`,
- rerunning summary publish updated the same note ID `3437836767` instead of creating a duplicate,
- verified exactly one AI review summary note existed after rerun,
- closed the temporary smoke MR after verification.
