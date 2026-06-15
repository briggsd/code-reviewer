import { describe, expect, test } from "bun:test";
import type { DocInput, KnownFacts } from "../src/docs-check/index.ts";
import { checkDocs, extractReferences, normalizePathToken } from "../src/docs-check/index.ts";

const FACTS: KnownFacts = {
  existingPaths: new Set([
    "src",
    "src/cli.ts",
    "src/runner",
    "src/runner/run-review.ts",
    "src/runner/tier-profile.ts",
    "docs",
    "docs/developer/architecture.md",
    "examples",
    "examples/fixtures",
    "examples/fixtures/auth-pr.json",
    ".github",
    ".github/workflows",
    ".github/workflows/ci.yml",
  ]),
  scriptNames: new Set(["check", "gate", "docs:check", "telemetry:rollup"]),
  envVarNames: new Set(["AI_REVIEW_FIXTURE", "AI_REVIEW_OUTPUT_DIR"]),
};

function live(text: string, path = "docs/test.md"): DocInput {
  return { path, text, scope: "live" };
}

describe("extractReferences", () => {
  test("extracts repo paths from inline code spans (require a slash)", () => {
    const refs = extractReferences("See `src/runner/run-review.ts` and `package.json`.");
    // package.json has no slash → not an inline path candidate
    expect(refs.inlinePaths.map((r) => r.raw)).toEqual(["src/runner/run-review.ts"]);
  });

  test("extracts markdown link targets but skips anchors and URLs", () => {
    const refs = extractReferences(
      "[a](docs/developer/architecture.md) [b](#section) [c](https://example.com/x)",
    );
    expect(refs.linkPaths.map((r) => r.raw)).toEqual(["docs/developer/architecture.md"]);
  });

  test("ignores paths inside fenced code blocks but keeps bun run / env there", () => {
    const text = ["```bash", "cat src/some/import-path.ts", "bun run gate", "```"].join("\n");
    const refs = extractReferences(text);
    expect(refs.inlinePaths).toHaveLength(0); // fenced path not extracted
    expect(refs.scripts.map((r) => r.raw)).toEqual(["gate"]); // bun run still seen
  });

  test("distinguishes `bun run <script>` from a file-path argument", () => {
    const refs = extractReferences("Run `bun run check` or `bun run src/cli.ts run`.");
    expect(refs.scripts.map((r) => r.raw)).toEqual(["check"]); // src/cli.ts is a path arg, not a script
  });

  test("rejects scoped npm packages, action refs, and placeholders as paths", () => {
    const refs = extractReferences(
      "`@anthropic-ai/sdk` `actions/checkout@v4` `docs/milestones/M0xx-ROADMAP.md` `auth/**`",
    );
    expect(refs.inlinePaths).toHaveLength(0);
  });

  test("reports an unclosed fence and stops extracting paths after it", () => {
    const text = ["before `src/a/x.ts`", "```bash", "code here", "after `src/b/y.ts`"].join("\n");
    const refs = extractReferences(text);
    expect(refs.unclosedFence).toBe(true);
    // the path before the unclosed fence is still seen; the one after is blanked
    expect(refs.inlinePaths.map((r) => r.raw)).toEqual(["src/a/x.ts"]);
  });

  test("a balanced fence is not reported as unclosed", () => {
    const refs = extractReferences(["```", "x", "```", "after `src/b/y.ts`"].join("\n"));
    expect(refs.unclosedFence).toBe(false);
    expect(refs.inlinePaths.map((r) => r.raw)).toEqual(["src/b/y.ts"]);
  });

  test("a 3-backtick line inside a 4-backtick fence does not close it", () => {
    // CommonMark: closer must match the opener's char and be >= its length.
    const refs = extractReferences(["````", "```", "still fenced `src/a/x.ts`", "````"].join("\n"));
    expect(refs.unclosedFence).toBe(false); // the 4-backtick line closes it
    expect(refs.inlinePaths).toHaveLength(0); // the path stayed inside the fence
  });

  test("an info-string line (```python) inside a fence is not a closer", () => {
    const refs = extractReferences(["```", "```python", "`src/a/x.ts`", "```"].join("\n"));
    expect(refs.unclosedFence).toBe(false);
    expect(refs.inlinePaths).toHaveLength(0); // path stayed fenced, not leaked out
  });

  test("ignores image targets (![alt](path)) — not a reference-check target", () => {
    const refs = extractReferences(
      "![diagram](docs/img/d.png) and [real](docs/developer/architecture.md)",
    );
    expect(refs.linkPaths.map((r) => r.raw)).toEqual(["docs/developer/architecture.md"]);
  });

  test("reports the opening line of an unclosed fence, not line 1", () => {
    const refs = extractReferences(["# title", "intro", "```bash", "x"].join("\n"));
    expect(refs.unclosedFence).toBe(true);
    expect(refs.unclosedFenceLine).toBe(3);
  });

  test("extracts AI_REVIEW_* env var tokens", () => {
    const refs = extractReferences("Set `AI_REVIEW_FIXTURE` and AI_REVIEW_OUTPUT_DIR.");
    expect(refs.envVars.map((r) => r.raw).sort()).toEqual([
      "AI_REVIEW_FIXTURE",
      "AI_REVIEW_OUTPUT_DIR",
    ]);
  });
});

describe("normalizePathToken", () => {
  test("strips trailing slash, anchor, and line/col suffixes", () => {
    expect(normalizePathToken("src/runner/")).toBe("src/runner");
    expect(normalizePathToken("src/cli.ts:42:7")).toBe("src/cli.ts");
    expect(normalizePathToken("docs/x.md#heading")).toBe("docs/x.md");
  });
});

describe("checkDocs — blocking dead references", () => {
  test("flags a repo-anchored inline path that does not exist", () => {
    const report = checkDocs([live("See `src/runner/gone.ts`.")], FACTS);
    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0]?.reference).toBe("src/runner/gone.ts");
  });

  test("passes an inline path that exists", () => {
    const report = checkDocs([live("See `src/runner/run-review.ts`.")], FACTS);
    expect(report.blocking).toHaveLength(0);
  });

  // Regression: the placeholder filter once matched "nn" inside "ru-nn-er", silently
  // skipping every src/runner/* path. The check must actually validate them.
  test("does NOT silently skip src/runner/* paths (vacuous-pass guard)", () => {
    const refs = extractReferences("`src/runner/run-review.ts`");
    expect(refs.inlinePaths.map((r) => r.raw)).toEqual(["src/runner/run-review.ts"]);
    const dead = checkDocs([live("`src/runner/run-review.ts` `src/runner/missing.ts`")], FACTS);
    expect(dead.blocking.map((f) => f.reference)).toEqual(["src/runner/missing.ts"]);
  });

  test("ignores paths whose first segment is not a real top-level repo entry", () => {
    // publisher/ (really src/publisher) and external tool paths are not flagged
    const report = checkDocs([live("`publisher/markdown-escape.ts` `node_modules/x/y.js`")], FACTS);
    expect(report.blocking).toHaveLength(0);
  });

  test("flags a broken markdown link resolved relative to the doc dir", () => {
    const report = checkDocs(
      [{ path: "docs/guide.md", text: "[x](missing.md)", scope: "live" }],
      FACTS,
    );
    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0]?.message).toContain("docs/missing.md");
  });

  test("resolves an existing link relative to the doc dir", () => {
    const report = checkDocs(
      [{ path: "docs/developer/guide.md", text: "[x](architecture.md)", scope: "live" }],
      FACTS,
    );
    expect(report.blocking).toHaveLength(0);
  });

  test("skips link targets that escape the repo root", () => {
    const report = checkDocs(
      [{ path: "docs/guide.md", text: "[x](../../outside.md)", scope: "live" }],
      FACTS,
    );
    expect(report.blocking).toHaveLength(0);
  });

  // A link into an untracked/gitignored/generated area (parent dir absent from the
  // repo) must NOT block — mirrors the inline-path precision guard.
  test("skips a link whose resolved parent directory is not tracked", () => {
    const report = checkDocs(
      [{ path: "docs/guide.md", text: "[logo](assets/img/logo.png)", scope: "live" }],
      FACTS,
    );
    expect(report.blocking).toHaveLength(0);
  });

  test("resolves a root-anchored (/-prefixed) link against the repo root", () => {
    const ok = checkDocs(
      [{ path: "docs/guide.md", text: "[x](/docs/developer/architecture.md)", scope: "live" }],
      FACTS,
    );
    expect(ok.blocking).toHaveLength(0);
    const dead = checkDocs(
      [{ path: "docs/guide.md", text: "[x](/docs/nonexistent.md)", scope: "live" }],
      FACTS,
    );
    expect(dead.blocking).toHaveLength(1);
    expect(dead.blocking[0]?.message).toContain("docs/nonexistent.md");
  });

  test("does not treat a markdown link written inside backticks as a real link", () => {
    const report = checkDocs(
      [{ path: "docs/guide.md", text: "Write `[x](docs/nope.md)` for a link.", scope: "live" }],
      FACTS,
    );
    expect(report.blocking).toHaveLength(0);
  });

  test("flags a `bun run` script not in package.json, passes a known one", () => {
    const report = checkDocs([live("`bun run nope` then `bun run check`")], FACTS);
    expect(report.blocking).toHaveLength(1);
    expect(report.blocking[0]?.reference).toBe("nope");
  });

  test("historical docs are exempt from blocking path/script rules", () => {
    const report = checkDocs(
      [
        {
          path: "docs/milestones/M001-ROADMAP.md",
          text: "`src/runner/gone.ts`",
          scope: "historical",
        },
      ],
      FACTS,
    );
    expect(report.blocking).toHaveLength(0);
  });
});

describe("checkDocs — advisories", () => {
  test("flags an env var absent from the source-of-truth, passes a known one", () => {
    const report = checkDocs([live("`AI_REVIEW_FIXTURE` and `AI_REVIEW_BOGUS`")], FACTS);
    expect(report.advisory.map((f) => f.reference)).toContain("AI_REVIEW_BOGUS");
    expect(report.advisory.map((f) => f.reference)).not.toContain("AI_REVIEW_FIXTURE");
  });

  test("env-var advisory fires even in historical docs", () => {
    const report = checkDocs(
      [{ path: "docs/milestones/M001-ROADMAP.md", text: "`AI_REVIEW_BOGUS`", scope: "historical" }],
      FACTS,
    );
    expect(report.advisory.map((f) => f.reference)).toContain("AI_REVIEW_BOGUS");
  });

  test("flags an oversized live doc but not an oversized historical doc", () => {
    const longText = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const report = checkDocs(
      [
        { path: "docs/big.md", text: longText, scope: "live" },
        { path: "docs/milestones/M001-ROADMAP.md", text: longText, scope: "historical" },
      ],
      FACTS,
      { oversizedLineThreshold: 50 },
    );
    const oversized = report.advisory.filter((f) => f.message.includes("lines"));
    expect(oversized.map((f) => f.doc)).toEqual(["docs/big.md"]);
  });

  test("flags a src/<dir>/ module missing from the CLAUDE.md repo map", () => {
    const facts: KnownFacts = {
      ...FACTS,
      existingPaths: new Set([...FACTS.existingPaths, "src/newmod", "src/newmod/thing.ts"]),
    };
    const report = checkDocs(
      [{ path: "CLAUDE.md", text: "map mentions runner/ but not the new module", scope: "live" }],
      facts,
    );
    const mapFindings = report.advisory.filter((f) => f.reference.startsWith("src/"));
    expect(mapFindings.map((f) => f.reference)).toContain("src/newmod/");
    expect(mapFindings.map((f) => f.reference)).not.toContain("src/runner/");
  });

  // A bare `dir/` substring inside an unrelated word (e.g. `task-runner/`) must NOT
  // count as the module being mentioned in the map.
  test("repo-map mention requires a token boundary, not a mid-word substring", () => {
    const report = checkDocs(
      [{ path: "CLAUDE.md", text: "see the task-runner/ helper", scope: "live" }],
      FACTS,
    );
    const mapFindings = report.advisory.filter((f) => f.reference.startsWith("src/"));
    expect(mapFindings.map((f) => f.reference)).toContain("src/runner/");
  });

  test("flags an unclosed code fence as an advisory on a live doc", () => {
    const report = checkDocs([live("intro\n```bash\nnever closed")], FACTS);
    expect(report.advisory.some((f) => f.message.includes("unclosed"))).toBe(true);
  });
});
