import type { ReviewConfig } from "../contracts/index.ts";

export function createDefaultReviewConfig(): ReviewConfig {
  return {
    mode: "advisory",
    failOn: ["critical"],
    sensitivePaths: [
      "auth/**",
      "crypto/**",
      "migrations/**",
      ".github/workflows/**",
      ".gitlab-ci.yml",
    ],
    ignoredPaths: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.min.js",
      "**/*.map",
      "**/bun.lockb",
      "**/package-lock.json",
      "**/pnpm-lock.yaml",
      "**/yarn.lock",
    ],
    reviewerPolicy: {
      code_quality: "enabled",
      security: "enabled",
      documentation: "enabled",
      performance: "full_only",
    },
    timeouts: {
      reviewerMs: 360_000,
      coordinatorMs: 240_000,
      overallMs: 900_000,
    },
    modelRouting: {
      // `thinking: "medium"` bounds reasoning effort below the runtime default to force
      // convergence on full-tier diffs (#45): unbounded, an agent can exhaust its whole
      // budget deliberating without emitting output. Set ONCE on `default` so it applies
      // uniformly to every role via `selectModel` inheritance — role entries omit it and
      // inherit, so a single change here re-tunes all roles. Tune per role/repo via
      // `.ai-review.json` (a role override that sets its own `thinking` wins).
      default: {
        provider: "dummy",
        model: "dummy-standard",
        tier: "standard",
        thinking: "medium",
      },
      roles: {
        coordinator: {
          provider: "dummy",
          model: "dummy-coordinator",
          tier: "top",
        },
        documentation: {
          provider: "dummy",
          model: "dummy-documentation",
          tier: "light",
        },
      },
    },
    conventions: [],
    acknowledgements: [],
    extra: {},
  };
}
