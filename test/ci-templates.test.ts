import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("CI starter templates", () => {
  test("GitHub Actions template separates read-only dry run from guarded write-back", async () => {
    const workflow = await readFile("examples/ci/github-actions-ai-review.yml", "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain("AI_REVIEW_PACKAGE: @briggsd/code-reviewer@0.1.0");
    expect(workflow).toContain('bun add --global "$AI_REVIEW_PACKAGE"');
    expect(workflow).toContain("code-reviewer run");
    expect(workflow).toContain("--provider github");
    expect(workflow).toContain("--publish-summary");
    expect(workflow).not.toContain("--publish-inline");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true");
    expect(workflow).not.toContain("bun run src/cli.ts");
    expect(workflow).not.toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("@earendil-works/pi-coding-agent");
  });

  test("GitHub Actions wrapper template keeps dry-run and guarded write-back explicit", async () => {
    const workflow = await readFile("examples/ci/github-actions-ai-review-action.yml", "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(workflow).toContain(
      "uses: briggsd/code-reviewer@REPLACE_WITH_FULL_COMMIT_SHA_OR_IMMUTABLE_TAG",
    );
    expect(workflow).toContain("package-source: ${{ env.AI_REVIEW_PACKAGE }}");
    expect(workflow).toContain('publish-summary: "true"');
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).not.toContain("bun run src/cli.ts");
    expect(workflow).not.toContain("bun install --frozen-lockfile");
    expect(workflow).not.toContain('publish-inline: "true"');
  });

  test("GitLab CI single-job template is internal-only and fails safe on fork MRs", async () => {
    const pipeline = await readFile("examples/ci/gitlab-ai-review-single-job.yml", "utf8");

    // Same-project guard is non-negotiable — job must not run on fork pipelines
    expect(pipeline).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID");
    // Uses write token (single combined job)
    expect(pipeline).toContain("$GITLAB_TOKEN_WRITE");
    // Runs review and publishes in one pass
    expect(pipeline).toContain("--publish-summary");
    expect(pipeline).toContain("--ci-exit");
    // Is a single review job — no separate dry-run job key
    expect(pipeline).not.toContain("ai_review_dry_run:");
    // Mutable image tags (not SHA-pinned) per examples/ci/ convention
    expect(pipeline).not.toContain("@sha256:");
    expect(pipeline).toContain("oven/bun:1.3");
    expect(pipeline).toContain("--provider gitlab");
    expect(pipeline).toContain('--api-base-url "${AI_REVIEW_GITLAB_API_BASE_URL:-$CI_API_V4_URL}"');
    expect(pipeline).toContain("--output-dir .ai-review");
    expect(pipeline).toContain('bun add --global "$AI_REVIEW_PACKAGE"');
    expect(pipeline).toContain("@earendil-works/pi-coding-agent");
    expect(pipeline).toContain("node:22-bookworm-slim");
    expect(pipeline).toContain("JOB-TOKEN");
  });

  test("Bitbucket Pipelines template separates dry run from secured-variable publish step", async () => {
    const pipeline = await readFile("examples/ci/bitbucket-pipelines.yml", "utf8");

    // Must target the pull-requests trigger
    expect(pipeline).toContain("pull-requests:");
    // Provider flag
    expect(pipeline).toContain("--provider bitbucket");
    // Bitbucket env vars wired to CLI flags
    expect(pipeline).toContain("BITBUCKET_REPO_FULL_NAME");
    expect(pipeline).toContain("BITBUCKET_PR_ID");
    // Both steps
    expect(pipeline).toContain("--runtime dummy");
    expect(pipeline).toContain("--publish-summary");
    expect(pipeline).toContain("--ci-exit");
    // Token variable
    expect(pipeline).toContain("AI_REVIEW_BITBUCKET_TOKEN");
    // Mutable image tag preserved (adoption-template convention, NOT SHA-pinned)
    expect(pipeline).toContain("image: oven/bun:1.3");
    expect(pipeline).not.toContain("@sha256:");
    // Uses installed CLI, not the dev source tree
    expect(pipeline).not.toContain("bun run src/cli.ts");
    expect(pipeline).not.toContain("bun install --frozen-lockfile");
    // Fork-safety: comment must document the secured-variable / fork boundary
    expect(pipeline).toContain("secured");
    expect(pipeline).toContain("fork");
    // Pi runtime note present
    expect(pipeline).toContain("@earendil-works/pi-coding-agent");
    expect(pipeline).toContain("node:22-bookworm-slim");
  });

  test("GitLab CI template separates MR dry run from same-project write-back", async () => {
    const pipeline = await readFile("examples/ci/gitlab-ai-review.yml", "utf8");

    expect(pipeline).toContain("Internal/self-managed GitLab beta template");
    expect(pipeline).toContain('$CI_PIPELINE_SOURCE == "merge_request_event"');
    expect(pipeline).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID");
    expect(pipeline).toContain("GITLAB_TOKEN_READ");
    expect(pipeline).toContain("GITLAB_TOKEN_WRITE");
    expect(pipeline).toContain(
      "AI_REVIEW_PACKAGE: https://gitlab.example.com/api/v4/projects/<project-id>/packages/generic/code-reviewer/0.2.0/code-reviewer.tgz",
    );
    expect(pipeline).not.toContain("AI_REVIEW_PACKAGE: @briggsd/code-reviewer@0.1.0");
    expect(pipeline).toContain('AI_REVIEW_GITLAB_API_BASE_URL: "$CI_API_V4_URL"');
    expect(pipeline).toContain("AI_REVIEW_DRY_RUN_RUNTIME: dummy");
    expect(pipeline).toContain("AI_REVIEW_PUBLISH_RUNTIME: dummy");
    expect(pipeline).toContain("interruptible: true");
    expect(pipeline).toContain("expire_in: 14 days");
    expect(pipeline).toContain("artifacts: false");
    expect(pipeline).toContain('bun add --global "$AI_REVIEW_PACKAGE"');
    expect(pipeline).toContain("code-reviewer run");
    expect(pipeline).toContain("--provider gitlab");
    expect(pipeline).toContain('--api-base-url "${AI_REVIEW_GITLAB_API_BASE_URL:-$CI_API_V4_URL}"');
    expect(pipeline).toContain('--runtime "$AI_REVIEW_DRY_RUN_RUNTIME"');
    expect(pipeline).toContain('--runtime "$AI_REVIEW_PUBLISH_RUNTIME"');
    expect(pipeline).toContain("--publish-summary");
    expect(pipeline).not.toContain("--publish-inline");
    expect(pipeline).toContain(".ai-review/");
    expect(pipeline).not.toContain("bun run src/cli.ts");
    expect(pipeline).not.toContain("bun install --frozen-lockfile");
    expect(pipeline).toContain("@earendil-works/pi-coding-agent");
    expect(pipeline).toContain("node:22-bookworm-slim");
    expect(pipeline).toContain("JOB-TOKEN");
  });
});
