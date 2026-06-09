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
      reviewerMs: 240_000,
      coordinatorMs: 240_000,
      overallMs: 540_000,
    },
    modelRouting: {
      default: {
        provider: "dummy",
        model: "dummy-standard",
        tier: "standard",
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
    extra: {},
  };
}
