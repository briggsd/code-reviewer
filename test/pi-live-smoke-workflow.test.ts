import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";

describe("Pi live smoke workflow", () => {
  test("is manual-only, default-branch guarded, and disabled by default", async () => {
    const workflow = await readFile(".github/workflows/pi-live-smoke.yml", "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("run_live_pi:");
    expect(workflow).toContain("default: false");
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toContain("AI_REVIEW_LIVE_PI: ${{ inputs.run_live_pi && '1' || '0' }}");
    expect(workflow).toContain("bun run smoke:pi");
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).not.toContain("pull-requests: write");
  });

  test("installs Pi safely and keeps model credentials in the manual smoke job", async () => {
    const workflow = await readFile(".github/workflows/pi-live-smoke.yml", "utf8");

    expect(workflow).toContain("npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
    expect(workflow).toContain("ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}");
    expect(workflow).toContain("OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}");
    expect(workflow).toContain("GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GOOGLE_GENERATIVE_AI_API_KEY }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("if-no-files-found: ignore");
  });

  test("smoke script treats blank workflow inputs as omitted provider/model overrides", async () => {
    const script = await readFile("scripts/pi-live-smoke.ts", "utf8");

    expect(script).toContain("readOptionalEnv(\"AI_REVIEW_PI_PROVIDER\")");
    expect(script).toContain("readOptionalEnv(\"AI_REVIEW_PI_MODEL\")");
    expect(script).toContain("value === undefined || value.length === 0 ? undefined : value");
  });
});
