import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("Fortis GitLab beta onboarding documentation", () => {
  test("documents self-managed GitLab beta onboarding, operations, and safety", async () => {
    const guide = await readFile("docs/fortis-gitlab-beta.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const adoption = await readFile("docs/adoption.md", "utf8");

    expect(readme).toContain("[Fortis GitLab beta onboarding](docs/fortis-gitlab-beta.md)");
    expect(adoption).toContain("[Fortis GitLab beta onboarding](fortis-gitlab-beta.md)");

    expect(guide).toContain("Fortis self-managed GitLab beta onboarding");
    expect(guide).toContain("immutable internal tarball URL");
    expect(guide).toContain("private: true");
    expect(guide).toContain("UNLICENSED");
    expect(guide).toContain("AI_REVIEW_PACKAGE");
    expect(guide).toContain("AI_REVIEW_GITLAB_API_BASE_URL");
    expect(guide).toContain("GITLAB_TOKEN_READ");
    expect(guide).toContain("GITLAB_TOKEN_WRITE");
    expect(guide).toContain("$CI_API_V4_URL");
    expect(guide).toContain("$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID");
    expect(guide).toContain("AI_REVIEW_DRY_RUN_RUNTIME: dummy");
    expect(guide).toContain("AI_REVIEW_PUBLISH_RUNTIME: dummy");
    expect(guide).toContain("run.json.error");
    expect(guide).toContain("trace.jsonl");
    expect(guide).toContain("publisher.completed");
    expect(guide).toContain("summaryCommentId");
    expect(guide).toContain("Secret rotation");
    expect(guide).toContain("No public npm release");
    expect(guide).toContain("No GitLab inline discussions");
    expect(guide).toContain("No privileged fork/fork-like write-back");
  });
});
