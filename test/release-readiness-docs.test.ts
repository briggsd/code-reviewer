import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("release readiness documentation", () => {
  test("documents verification, packaging, safety, and release blockers", async () => {
    const guide = await readFile("docs/user/release-readiness.md", "utf8");

    expect(guide).toContain("bun run check");
    expect(guide).toContain("bun run pack:smoke");
    expect(guide).toContain("bun run smoke:external-package");
    expect(guide).toContain("bun run smoke:action-wrapper");
    expect(guide).toContain("bun run smoke:pi");
    expect(guide).toContain("Bun-backed npm tarball/package");
    expect(guide).toContain("AI_REVIEW_PACKAGE");
    expect(guide).toContain("Keep dry-run and publish jobs separate");
    expect(guide).toContain("Model/runtime credentials: trusted jobs only");
    expect(guide).toContain("evaluateInlinePublishReadiness()");
  });

  test("README links to the release readiness checklist", async () => {
    const readme = await readFile("README.md", "utf8");

    expect(readme).toContain("[Release readiness](docs/user/release-readiness.md)");
  });
});
