import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  createRuntimeToolPolicy,
  loadProjectReviewConfig,
  loadReviewFixture,
  normalizeReviewFixture,
  runReview,
  summarizeReview,
} from "../src/index.ts";
import type {
  AgentRuntime,
  CoordinatorRunInput,
  CoordinatorRunResult,
  ReviewerRunInput,
  ReviewerRunResult,
  RuntimeEvent,
  RuntimeEventSubscription,
} from "../src/index.ts";

describe("fixture local runner", () => {
  test("runs a blocking review from a fixture", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(result.context.runId).toBe("fixture-auth-pr");
    expect(result.context.risk.tier).toBe("full");
    expect(result.summary.decision).toBe("significant_concerns");
    expect(result.summary.outcome).toBe("fail");
    expect(result.summary.findings).toHaveLength(1);
    expect(result.summary.findings[0]?.title).toBe("Account lookup misses authorization");
  });

  test("approves a tiny fixture with no fake findings", async () => {
    const fixture = normalizeReviewFixture({
      metadata: {
        provider: "local",
        repository: {
          provider: "local",
          name: "demo",
          slug: "demo",
        },
        changeId: "local",
        headSha: "abc123",
        title: "Update copy",
        author: {
          username: "dev",
        },
        labels: [],
      },
      diff: {
        files: [
          {
            path: "README.md",
            status: "modified",
            additions: 2,
            deletions: 1,
            isBinary: false,
          },
        ],
        totalAdditions: 2,
        totalDeletions: 1,
        truncated: false,
      },
    });

    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(result.context.runId).toBe("local-2026-06-09T00-00-00-000Z");
    expect(result.context.risk.tier).toBe("trivial");
    expect(result.summary.decision).toBe("approved");
    expect(result.summary.outcome).toBe("pass");
  });

  test("loads project config from .ai-review.json", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-review-config-"));
    await writeFile(join(directory, ".ai-review.json"), JSON.stringify({
      mode: "blocking",
      failOn: ["critical", "warning"],
      reviewerPolicy: {
        performance: "enabled",
      },
      modelRouting: {
        default: {
          provider: "pi",
          model: "claude-haiku",
          tier: "light",
        },
        roles: {
          security: {
            provider: "pi",
            model: "claude-sonnet",
            tier: "top",
          },
        },
      },
    }));

    const config = await loadProjectReviewConfig({ cwd: directory });

    expect(config.mode).toBe("blocking");
    expect(config.failOn).toEqual(["critical", "warning"]);
    expect(config.reviewerPolicy.performance).toBe("enabled");
    expect(config.reviewerPolicy.security).toBe("enabled");
    expect(config.modelRouting.default.model).toBe("claude-haiku");
    expect(config.modelRouting.roles.security?.model).toBe("claude-sonnet");
    expect(config.modelRouting.roles.coordinator?.model).toBe("dummy-coordinator");
  });

  test("passes role-specific model routing to the runtime", async () => {
    const fixture = normalizeReviewFixture({
      metadata: {
        provider: "local",
        repository: {
          provider: "local",
          name: "demo",
          slug: "demo",
        },
        changeId: "local",
        headSha: "abc123",
        title: "Update code",
        author: {
          username: "dev",
        },
        labels: [],
      },
      diff: {
        files: [
          {
            path: "src/auth.ts",
            status: "modified",
            additions: 4,
            deletions: 1,
            isBinary: false,
          },
        ],
        totalAdditions: 4,
        totalDeletions: 1,
        truncated: false,
      },
      config: {
        modelRouting: {
          default: {
            provider: "pi",
            model: "claude-haiku",
            tier: "light",
          },
          roles: {
            coordinator: {
              provider: "pi",
              model: "claude-opus",
              tier: "top",
            },
            security: {
              provider: "pi",
              model: "claude-sonnet",
              tier: "standard",
            },
          },
        },
      },
    });
    const runtime = new RecordingRuntime();

    await runReview({ fixture, runtime, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(runtime.coordinatorInput?.model.model).toBe("claude-opus");
    expect(runtime.coordinatorInput?.selectedReviewers.find((reviewer) => reviewer.role === "security")?.model.model)
      .toBe("claude-sonnet");
    expect(runtime.coordinatorInput?.selectedReviewers.find((reviewer) => reviewer.role === "code_quality")?.model.model)
      .toBe("claude-haiku");
  });

  test("maps safety modes to explicit runtime tool policies", () => {
    expect(createRuntimeToolPolicy("trusted")).toEqual({
      allowRead: true,
      allowWrite: false,
      allowShell: false,
      allowedTools: [],
      deniedTools: ["bash", "write", "edit"],
    });
    expect(createRuntimeToolPolicy("untrusted_read_only")).toEqual({
      allowRead: true,
      allowWrite: false,
      allowShell: false,
      allowedTools: [],
      deniedTools: ["bash", "write", "edit"],
    });
    expect(createRuntimeToolPolicy("privileged_metadata_only")).toEqual({
      allowRead: false,
      allowWrite: false,
      allowShell: false,
      allowedTools: [],
      deniedTools: ["read", "grep", "find", "ls", "bash", "write", "edit"],
    });
  });
});

class RecordingRuntime implements AgentRuntime {
  readonly name = "recording";

  coordinatorInput: CoordinatorRunInput | undefined;

  async runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult> {
    this.coordinatorInput = input;
    return {
      runId: input.runId,
      agentRunId: `${input.runId}:coordinator`,
      summary: summarizeReview(input.context, []),
      reviewerResults: [],
      rawOutput: "{}",
    };
  }

  async runReviewer(input: ReviewerRunInput): Promise<ReviewerRunResult> {
    return {
      runId: input.runId,
      agentRunId: `${input.runId}:${input.role}`,
      role: input.role,
      findings: [],
      rawOutput: "{\"findings\":[]}",
    };
  }

  streamEvents(_runId: string, _onEvent: (event: RuntimeEvent) => void): RuntimeEventSubscription {
    return {
      unsubscribe: () => {},
    };
  }

  async cancel(_runId: string): Promise<void> {}
}

