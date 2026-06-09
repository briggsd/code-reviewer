import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("GitLab live smoke documentation", () => {
  test("documents opt-in GitLab smoke prerequisites and safety posture", async () => {
    const guide = await readFile("docs/gitlab-live-smoke.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const script = await readFile("scripts/gitlab-live-smoke.ts", "utf8");

    expect(readme).toContain("[GitLab live smoke](docs/gitlab-live-smoke.md)");
    expect(readme).toContain("smoke:gitlab");
    expect(guide).toContain("AI_REVIEW_LIVE_GITLAB=1");
    expect(guide).toContain("AI_REVIEW_GITLAB_REPO");
    expect(guide).toContain("AI_REVIEW_GITLAB_CHANGE_ID");
    expect(guide).toContain("AI_REVIEW_GITLAB_PUBLISH_SUMMARY=1");
    expect(guide).toContain("Do not run this smoke with write tokens on untrusted fork MRs");
    expect(guide).toContain("GitLab inline discussions remain deferred");
    expect(guide).toContain("M005 S05 live smoke completed");
    expect(guide).toContain("test-group-zinga/general");
    expect(guide).toContain("summary publish smoke posted GitLab note `3437836767`");
    expect(guide).toContain("closed the temporary smoke MR");
    expect(script).toContain("GitLab live smoke skipped");
    expect(script).toContain("AI_REVIEW_LIVE_GITLAB");
  });
});
