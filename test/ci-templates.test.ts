import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("CI starter templates", () => {
  test("GitHub Actions template separates read-only dry run from guarded write-back", async () => {
    const workflow = await readFile("examples/ci/github-actions-ai-review.yml", "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("pull-requests: read");
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(workflow).toContain("AI_REVIEW_PACKAGE: ai-code-review-factory@0.1.0");
    expect(workflow).toContain("bun add --global \"$AI_REVIEW_PACKAGE\"");
    expect(workflow).toContain("ai-code-review run");
    expect(workflow).toContain("--provider github");
    expect(workflow).toContain("--publish-summary");
    expect(workflow).toContain("actions/upload-artifact@v4");
    expect(workflow).toContain("include-hidden-files: true");
    expect(workflow).toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true");
    expect(workflow).not.toContain("bun run src/cli.ts");
    expect(workflow).not.toContain("bun install --frozen-lockfile");
  });

  test("GitLab CI template separates MR dry run from same-project write-back", async () => {
    const pipeline = await readFile("examples/ci/gitlab-ai-review.yml", "utf8");

    expect(pipeline).toContain("$CI_PIPELINE_SOURCE == \"merge_request_event\"");
    expect(pipeline).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID");
    expect(pipeline).toContain("GITLAB_TOKEN_READ");
    expect(pipeline).toContain("GITLAB_TOKEN_WRITE");
    expect(pipeline).toContain("AI_REVIEW_PACKAGE: ai-code-review-factory@0.1.0");
    expect(pipeline).toContain("bun add --global \"$AI_REVIEW_PACKAGE\"");
    expect(pipeline).toContain("ai-code-review run");
    expect(pipeline).toContain("--provider gitlab");
    expect(pipeline).toContain("--publish-summary");
    expect(pipeline).toContain(".ai-review/");
    expect(pipeline).not.toContain("bun run src/cli.ts");
    expect(pipeline).not.toContain("bun install --frozen-lockfile");
  });
});
