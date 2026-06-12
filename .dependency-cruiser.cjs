/**
 * Architecture-boundary rules (#27). These mechanize the load-bearing invariants from
 * docs/architecture.md (design principles #2/#3): deterministic core depends on contracts,
 * never on concrete adapters. Every rule carries a remediation message so an agent (or
 * human) can self-correct from the error output alone.
 *
 * Run: `bun run boundaries` (blocking in CI's check job; deliberately NOT folded into
 * `bun run check`, which stays exactly tsc + test per CLAUDE.md).
 */
module.exports = {
  forbidden: [
    {
      name: "runner-no-concrete-adapters",
      severity: "error",
      comment:
        "src/runner is the deterministic orchestration core. It must depend on the interfaces in " +
        "src/contracts, never on a concrete adapter (vcs/runtime/publisher/ci). Inject the adapter " +
        "through the runner's options/params instead (see how RunReviewOptions carries `runtime`). " +
        "See docs/architecture.md 'Adapters at the edges'.",
      from: { path: "^src/runner" },
      to: {
        path: "^src/(vcs|publisher|ci|runtime)",
        // Pure leaf utilities without adapter coupling — allowed pending relocation to a
        // shared module (triaged in #27): text escaping + telemetry-tag sanitizers.
        pathNot: [
          "^src/publisher/markdown-escape\\.ts$",
          "^src/runtime/runtime-kind\\.ts$",
        ],
      },
    },
    {
      name: "contracts-stay-pure",
      severity: "error",
      comment:
        "src/contracts defines the adapter interfaces and shared types; it must not import from " +
        "any implementation layer. Move shared types INTO contracts (or a contracts sibling) " +
        "rather than importing them from runner/adapters. See docs/architecture.md " +
        "'Adapters at the edges'.",
      from: { path: "^src/contracts" },
      to: { path: "^src/(?!contracts)" },
    },
    {
      name: "no-cross-vcs-coupling",
      severity: "error",
      comment:
        "VCS adapters must not import each other — provider-specific coupling stays behind the " +
        "VcsAdapter contract. Shared rendering/dedup logic belongs in src/publisher (see " +
        "inline-comment-markdown.ts, extracted for exactly this reason in #82).",
      from: { path: "^src/vcs/github" },
      to: { path: "^src/vcs/gitlab" },
    },
    {
      name: "no-cross-vcs-coupling-reverse",
      severity: "error",
      comment:
        "VCS adapters must not import each other — provider-specific coupling stays behind the " +
        "VcsAdapter contract. Shared rendering/dedup logic belongs in src/publisher.",
      from: { path: "^src/vcs/gitlab" },
      to: { path: "^src/vcs/github" },
    },
    {
      name: "no-circular",
      severity: "error",
      comment:
        "Circular dependency. Break the cycle by moving the shared piece into src/contracts (types) " +
        "or a leaf utility module, or by inverting the dependency through an interface.",
      from: {},
      to: { circular: true },
    },
  ],
  required: [
    {
      name: "pi-runtime-routes-prompt-boundary",
      severity: "error",
      comment:
        "The Pi runtime assembles prompts from untrusted PR/MR content, so it must route that " +
        "content through src/runtime/prompt-boundary.ts (stringifyPromptData / sanitization) " +
        "before prompt assembly (design principle #6). If this import disappeared, prompt " +
        "assembly has likely bypassed the sanitization boundary — restore it, do not inline " +
        "ad-hoc escaping.",
      module: { path: "^src/runtime/pi-agent-runtime\\.ts$" },
      to: { path: "^src/runtime/prompt-boundary\\.ts$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      extensions: [".ts", ".js", ".json"],
    },
  },
};
