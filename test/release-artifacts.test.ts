import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

describe("release artifact workflow", () => {
  test("dispatch + tag triggers, builds an npm tarball, publishes to npm registry on tag", async () => {
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
    // Leading `./` is required: npm >= 11.5 parses a bare `dist/<name>.tgz` (single slash)
    // as a GitHub owner/repo shorthand and tries to git-clone it instead of publishing.
    expect(workflow).toContain("npm publish ./dist/*.tgz --provenance --access public");
    // The pack job fails fast when the pushed vX.Y.Z tag does not match package.json `version`,
    // blocking BOTH publish jobs (they `needs: pack`) — the safeguard against a mislabeled
    // GitHub Release and an immutable, un-revertible npm publish. Lock it against silent removal.
    expect(workflow).toContain("Guard tag matches package.json version");
    expect(workflow).toContain('if [ "$TAG" != "$PKG" ]; then');
    // The OIDC-privileged publish job pins the npm CLI (not @latest) per the pinning discipline,
    // and upgrades it with sudo (the runner's global prefix is root-owned; plain -g hits EACCES).
    expect(workflow).toContain("sudo npm install -g npm@11.5.1");

    // dispatch-only dry-run: validates the publish command resolves/packs before a v* tag is cut.
    expect(workflow).toContain("Validate publish command (dry-run)");
    // Leading `./` is the regression guard — the same `./dist/*.tgz` fix from #401.
    expect(workflow).toContain("npm publish ./dist/*.tgz --dry-run --provenance --access public");
    // Dry-run must live in the `pack` job (dispatch-reachable), not on any tag-push-only job.
    // Assert the dry-run command appears BEFORE the holdout-gate job key.
    const dryRunAt = workflow.indexOf("npm publish ./dist/*.tgz --dry-run");
    expect(dryRunAt).toBeGreaterThan(-1);
    expect(dryRunAt).toBeLessThan(workflow.indexOf("\n  holdout-gate:"));
    // The benign "version already published" tolerance must be present so it can't be silently dropped.
    expect(workflow).toContain("cannot publish over the previously published versions");
    // The dispatch dry-run and the tag-path publish are two independent literals; tie them so they
    // cannot silently diverge (a re-dropped `./` reintroducing #401, or any spec change on one job
    // only). Extract the spec the REAL npm-publish job uses, then assert the dry-run uses the
    // identical spec + `--dry-run`. Drift fails this lock in the blocking gate, not on a live tag.
    const publishMatch = workflow.match(/npm publish (\S+) --provenance --access public/);
    expect(publishMatch).not.toBeNull();
    const publishSpec = publishMatch?.[1] ?? "";
    expect(publishSpec).toBe("./dist/*.tgz");
    expect(workflow).toContain(`npm publish ${publishSpec} --dry-run --provenance --access public`);

    // Four jobs: pack (both triggers, no secrets), holdout-gate (dispatch-only, secrets),
    // release (tag-only, publishes the tarball), npm-publish (tag-only, publishes to npm).
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
    expect(guide).toContain("npm-publish");
    expect(guide).toContain("contents: read");
    expect(guide).toContain("immutable URL");
    expect(guide).toContain("internal/self-managed GitLab beta");
    expect(guide).toContain(
      "https://gitlab.example.com/<your-org>/dev-tools/code-reviewer/-/releases/vX.Y.Z/downloads/briggsd-code-reviewer-X.Y.Z.tgz",
    );
    expect(readiness).toContain("manual release artifact workflow");
  });
});
