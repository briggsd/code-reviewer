import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("repository AI review workflow", () => {
  test("keeps dummy PR review default and gates real Pi review to same-repo PRs", async () => {
    const workflow = await readFile(".github/workflows/ai-review.yml", "utf8");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("AI review dry run");
    expect(workflow).toContain("--runtime dummy");
    expect(workflow).toContain("AI_REVIEW_REAL_REVIEW_ENABLED != 'true'");
    expect(workflow).toContain("AI review publish real Pi summary");
    expect(workflow).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository && vars.AI_REVIEW_REAL_REVIEW_ENABLED == 'true'",
    );
    expect(workflow).toContain("pull-requests: write");
    expect(workflow).toContain("npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
    expect(workflow).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(workflow).toContain(
      "GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GOOGLE_GENERATIVE_AI_API_KEY }}",
    );
    expect(workflow).toContain("AI_REVIEW_PI_PROVIDER: ${{ vars.AI_REVIEW_PI_PROVIDER }}");
    expect(workflow).toContain("AI_REVIEW_PI_MODEL: ${{ vars.AI_REVIEW_PI_MODEL }}");
    expect(workflow).toContain("--runtime pi");
    expect(workflow).toContain('--pi-provider "${AI_REVIEW_PI_PROVIDER:-anthropic}"');
    expect(workflow).toContain('--pi-model "${AI_REVIEW_PI_MODEL:-claude-sonnet-4-6}"');
    expect(workflow).toContain("--publish-summary");
    expect(workflow).toContain("name: ai-review-real-${{ github.event.pull_request.number }}");
    expect(workflow).not.toContain("pull_request_target:");
    // Artifact path scoped to runs/ only (drops context/ with PR diff + metadata)
    expect(workflow).toContain("path: .ai-review/runs");
    // Real-review job redacts operator prompts + model output by default
    expect(workflow).toContain('REDACT_ARGS=("--redact-trace")');
    expect(workflow).toContain('"${REDACT_ARGS[@]}"');
    // Toggle branch: only AI_REVIEW_EXPOSE_TRACE_PROMPTS=true drops the flag
    expect(workflow).toContain("AI_REVIEW_EXPOSE_TRACE_PROMPTS");
    expect(workflow).toContain('[ "${AI_REVIEW_EXPOSE_TRACE_PROMPTS}" = "true" ]');
    expect(workflow).toContain("REDACT_ARGS=()");
    // Bare whole-tree upload path is gone
    expect(workflow).not.toContain("path: .ai-review\n");

    // Redaction is scoped to the trusted-real-review job ONLY (the dummy jobs
    // emit no message_start/message_end, so they neither need nor get the flag).
    const realReviewJob = workflow.slice(workflow.indexOf("  trusted-real-review:"));
    const beforeRealReview = workflow.slice(0, workflow.indexOf("  trusted-real-review:"));
    expect(realReviewJob).toContain('REDACT_ARGS=("--redact-trace")');
    expect(realReviewJob).toContain('"${REDACT_ARGS[@]}"');
    expect(beforeRealReview).not.toContain("--redact-trace");
  });
});
