import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("release artifact workflow", () => {
  test("dispatch + tag triggers, builds an npm tarball, no registry publish", async () => {
    const workflow = await readFile(".github/workflows/release-package.yml", "utf8");
    const guide = await readFile("docs/user/release-artifacts.md", "utf8");
    const readme = await readFile("README.md", "utf8");
    const readiness = await readFile("docs/user/release-readiness.md", "utf8");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("pull_request:");
    // Tag push (vX.Y.Z) is the release trigger; the build job stays least-privilege.
    expect(workflow).toContain("push:");
    expect(workflow).toMatch(/tags:\s*\n\s*-\s*"v\*"/);
    expect(workflow).toContain("contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run check");
    expect(workflow).toContain("bun run pack:smoke");
    expect(workflow).toContain("npm pack --pack-destination dist");
    // Actions are SHA-pinned repo-wide (#96); the trailing comment preserves the version tag.
    expect(workflow).toMatch(/actions\/upload-artifact@[0-9a-f]{40} # v4/);
    expect(workflow).not.toContain("npm publish");

    // Three jobs: pack (both triggers, no secrets), holdout-gate (dispatch-only, secrets),
    // release (tag-only, publishes the tarball).
    expect(workflow).toContain("holdout-gate:");
    // The secret-consuming holdout gate runs ONLY on workflow_dispatch.
    expect(workflow).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain("bun run evals --gate");

    // Tag-only GitHub Release: confined contents: write, gh CLI run-step (no third-party action).
    expect(workflow).toContain("contents: write");
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(workflow).not.toContain("needs: holdout-gate");

    // Scope the release-job dependency/trigger assertions to the `release:` YAML block, not the
    // whole file. holdout-gate ALSO declares `needs: pack`, so a whole-file toContain would pass
    // even if `needs: pack` were dropped from `release` specifically. Slice from `\n  release:`
    // (a top-level job key) to the next top-level job key or EOF, then assert within that slice.
    const releaseBlockStart = workflow.indexOf("\n  release:");
    expect(releaseBlockStart).toBeGreaterThan(-1);
    const afterRelease = workflow.slice(releaseBlockStart + 1);
    const nextJobMatch = afterRelease.slice("  release:".length).search(/\n {2}[a-z][\w-]*:\n/);
    const releaseBlock =
      nextJobMatch === -1
        ? afterRelease
        : afterRelease.slice(0, "  release:".length + nextJobMatch);
    // The release job depends on `pack` only — NOT the dispatch-only holdout-gate, which is
    // skipped on a tag push (depending on a skipped job would skip release). This must FAIL if
    // `needs: pack` is removed from the `release` job.
    expect(releaseBlock).toContain("needs: pack");
    // The release job is tag-only.
    expect(releaseBlock).toContain("startsWith(github.ref, 'refs/tags/v')");
    // The publish-only tag path attaches the tarball but NOT a fresh quality stamp.
    expect(workflow).not.toContain("dist/quality-stamp.json \\");

    // #297 regression lock: the provider API-key secrets must live ONLY inside the
    // dispatch-gated holdout-gate job, never on any tag-push-reachable code path. Assert the
    // secrets appear only after the holdout-gate job declaration and before the release job.
    const holdoutIdx = workflow.indexOf("holdout-gate:");
    const releaseIdx = workflow.indexOf("\n  release:");
    expect(holdoutIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(holdoutIdx);
    for (const key of [
      "secrets.ANTHROPIC_API_KEY",
      "secrets.OPENAI_API_KEY",
      "secrets.GOOGLE_GENERATIVE_AI_API_KEY",
    ]) {
      const at = workflow.indexOf(key);
      expect(at).toBeGreaterThan(holdoutIdx);
      expect(at).toBeLessThan(releaseIdx);
      // Each secret is referenced exactly once (no leak into pack/release).
      expect(workflow.indexOf(key)).toBe(workflow.lastIndexOf(key));
    }

    expect(readme).toContain("[Release artifacts](docs/user/release-artifacts.md)");
    expect(guide).toContain("does **not** publish to npm");
    expect(guide).toContain("contents: read");
    expect(guide).toContain("immutable URL");
    expect(guide).toContain("internal/self-managed GitLab beta");
    expect(guide).toContain(
      "https://gitlab.example.com/<your-org>/dev-tools/code-reviewer/-/releases/v0.1.0/downloads/briggsd-code-reviewer-0.1.0.tgz",
    );
    expect(readiness).toContain("manual release artifact workflow");
  });
});
