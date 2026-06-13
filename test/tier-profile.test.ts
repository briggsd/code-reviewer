import { describe, expect, test } from "bun:test";
import type {
  AgentRuntime,
  CoordinatorRunInput,
  CoordinatorRunResult,
  PiProcessRunInput,
  PiProcessRunner,
  PiProcessRunResult,
  ReviewerRunInput,
  ReviewerRunResult,
  RiskAssessment,
  RuntimeEvent,
  RuntimeEventSubscription,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TraceSink,
} from "../src/index.ts";
import {
  DummyAgentRuntime,
  findUnsupportedReviewerPolicyEntries,
  getTierProfile,
  loadReviewFixture,
  normalizeReviewFixture,
  PiAgentRuntime,
  runReview,
  selectTrustedReviewerDefinitions,
  TRUSTED_REVIEWER_DEFINITIONS,
} from "../src/index.ts";
import { normalizeReviewConfig } from "../src/runner/config.ts";
import { summarizeReview } from "../src/runner/run-review.ts";

// ---------------------------------------------------------------------------
// Profile value tests (locks the declared table)
// ---------------------------------------------------------------------------

describe("getTierProfile", () => {
  test("trivial profile matches spec", () => {
    const profile = getTierProfile("trivial");
    expect(profile.tier).toBe("trivial");
    expect(profile.timeoutScale).toBe(0.25);
    expect(profile.denyContextTools).toBe(true);
    expect(profile.shortCircuitCoordinatorOnZeroFindings).toBe(true);
    expect(profile.reviewerRoleCap).toEqual(["code_quality"]);
  });

  test("lite profile matches spec", () => {
    const profile = getTierProfile("lite");
    expect(profile.tier).toBe("lite");
    expect(profile.timeoutScale).toBe(0.5);
    expect(profile.denyContextTools).toBe(true);
    expect(profile.shortCircuitCoordinatorOnZeroFindings).toBe(true);
    expect(profile.reviewerRoleCap).toBe("all_enabled");
  });

  test("full profile matches spec", () => {
    const profile = getTierProfile("full");
    expect(profile.tier).toBe("full");
    expect(profile.timeoutScale).toBe(1);
    expect(profile.denyContextTools).toBe(false);
    expect(profile.shortCircuitCoordinatorOnZeroFindings).toBe(false);
    expect(profile.reviewerRoleCap).toBe("all_enabled");
  });

  test("profiles are frozen (immutable)", () => {
    const profile = getTierProfile("trivial");
    expect(Object.isFrozen(profile)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// selectTrustedReviewerDefinitions with tier cap
// ---------------------------------------------------------------------------

describe("selectTrustedReviewerDefinitions tier cap", () => {
  // Default config: code_quality=enabled, security=enabled, documentation=enabled, performance=full_only

  function makeRisk(tier: "trivial" | "lite" | "full"): RiskAssessment {
    return {
      tier,
      reason: "test",
      matchedRules: [],
      sensitivePaths: [],
      reviewedFileCount: 1,
      ignoredFileCount: 0,
    };
  }

  const defaultConfig = normalizeReviewConfig({});

  test("trivial tier → only code_quality (security+documentation enabled in config but capped out; performance excluded by full_only)", () => {
    const definitions = selectTrustedReviewerDefinitions({
      config: defaultConfig,
      risk: makeRisk("trivial"),
    });
    expect(definitions.map((d) => d.role)).toEqual(["code_quality"]);
  });

  test("lite tier → code_quality + security + documentation (unchanged; all_enabled cap; performance still full_only)", () => {
    const definitions = selectTrustedReviewerDefinitions({
      config: defaultConfig,
      risk: makeRisk("lite"),
    });
    expect(definitions.map((d) => d.role)).toEqual(["code_quality", "security", "documentation"]);
  });

  test("full tier → all four (unchanged; all_enabled cap; performance enabled by full_only)", () => {
    const definitions = selectTrustedReviewerDefinitions({
      config: defaultConfig,
      risk: makeRisk("full"),
    });
    expect(definitions.map((d) => d.role)).toEqual([
      "code_quality",
      "security",
      "documentation",
      "performance",
    ]);
  });

  test("release + compliance (#23) are opt-in: absent by default, present once enabled", () => {
    // Default config does not enable the new roles → they never appear, even at full tier.
    expect(
      selectTrustedReviewerDefinitions({ config: defaultConfig, risk: makeRisk("full") }).map(
        (d) => d.role,
      ),
    ).not.toContain("release");

    const opted = normalizeReviewConfig({
      reviewerPolicy: { release: "enabled", compliance: "enabled" },
    });
    const roles = selectTrustedReviewerDefinitions({
      config: opted,
      risk: makeRisk("full"),
    }).map((d) => d.role);
    expect(roles).toContain("release");
    expect(roles).toContain("compliance");
    // Enabling them does not flag them as unsupported (they have trusted definitions).
    expect(findUnsupportedReviewerPolicyEntries({ config: opted })).toHaveLength(0);
  });

  test("trivial with code_quality disabled → empty array", () => {
    const config = normalizeReviewConfig({
      reviewerPolicy: {
        code_quality: "disabled",
        security: "enabled",
        documentation: "enabled",
        performance: "full_only",
      },
    });
    const definitions = selectTrustedReviewerDefinitions({
      config,
      risk: makeRisk("trivial"),
    });
    expect(definitions).toHaveLength(0);
  });

  test("cap never re-enables a disabled role (trivial + code_quality explicitly disabled)", () => {
    const config = normalizeReviewConfig({
      reviewerPolicy: {
        code_quality: "disabled",
        security: "enabled",
        documentation: "enabled",
        performance: "disabled",
      },
    });
    const definitions = selectTrustedReviewerDefinitions({
      config,
      risk: makeRisk("trivial"),
    });
    // code_quality is in the cap but disabled in config → stays excluded
    expect(definitions).toHaveLength(0);
  });

  test("custom definitions list is filtered by both config policy and tier cap", () => {
    const customDefs = [
      { ...TRUSTED_REVIEWER_DEFINITIONS[0]!, role: "code_quality" },
      { ...TRUSTED_REVIEWER_DEFINITIONS[1]!, role: "security" },
    ];
    const definitions = selectTrustedReviewerDefinitions({
      config: defaultConfig,
      risk: makeRisk("trivial"),
      definitions: customDefs,
    });
    expect(definitions.map((d) => d.role)).toEqual(["code_quality"]);
  });
});

// ---------------------------------------------------------------------------
// Pi runtime short-circuit
// ---------------------------------------------------------------------------

class CapturingPiProcessRunner implements PiProcessRunner {
  readonly calls: PiProcessRunInput[] = [];

  async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    this.calls.push(input);
    const output =
      input.role === "coordinator"
        ? {
            decision: "approved",
            outcome: "pass",
            title: "AI review found no blocking issues",
            body: "Coordinator synthesized.",
            findings: [],
            risk: {
              tier: "trivial",
              reason: "test",
              matchedRules: [],
              sensitivePaths: [],
              reviewedFileCount: 1,
              ignoredFileCount: 0,
            },
          }
        : { findings: [] };
    const finalText = JSON.stringify(output);
    return {
      finalText,
      events: [
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
            usage: { input: 5, output: 3, cost: { total: 0.001 } },
          },
        },
      ],
      usage: { inputTokens: 5, outputTokens: 3, estimatedCostUsd: 0.001 },
      rawOutput: finalText,
    };
  }
}

class FindingReviewerPiProcessRunner extends CapturingPiProcessRunner {
  override async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    this.calls.push(input);
    const finding = {
      reviewer: "code_quality",
      severity: "suggestion",
      category: "maintainability",
      title: "Refactor opportunity",
      body: "Consider extracting the logic.",
      confidence: "medium",
      evidence: ["The changed code could be simpler."],
      recommendation: "Extract to a helper function.",
    };
    const output =
      input.role === "coordinator"
        ? {
            decision: "approved_with_comments",
            outcome: "pass",
            title: "AI review found 1 finding",
            body: "Coordinator consolidated.",
            findings: [finding],
            risk: {
              tier: "trivial",
              reason: "test",
              matchedRules: [],
              sensitivePaths: [],
              reviewedFileCount: 1,
              ignoredFileCount: 0,
            },
          }
        : { findings: [finding] };
    const finalText = JSON.stringify(output);
    return {
      finalText,
      events: [],
      rawOutput: finalText,
    };
  }
}

class FailingReviewerPiProcessRunner extends CapturingPiProcessRunner {
  override async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    this.calls.push(input);
    if (input.role === "code_quality") {
      throw new Error("Reviewer process failed");
    }
    return super.run(input);
  }
}

/** Build a trivial-tier fixture from a small non-sensitive diff */
function trivialFixture(config?: Record<string, unknown>) {
  return normalizeReviewFixture({
    ...(config !== undefined ? { config } : {}),
    metadata: {
      provider: "local",
      repository: { provider: "local", name: "demo", slug: "demo" },
      changeId: "local",
      headSha: "abc123",
      title: "Small tweak",
      author: { username: "dev" },
      labels: [],
    },
    diff: {
      files: [
        {
          path: "src/util.ts",
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
}

/** Build a lite-tier fixture: 2 files / 30 changed lines (> trivial's 25-line cap, no sensitive paths) */
function liteFixture() {
  return normalizeReviewFixture({
    metadata: {
      provider: "local",
      repository: { provider: "local", name: "demo", slug: "demo" },
      changeId: "local",
      headSha: "abc123",
      title: "Moderate change",
      author: { username: "dev" },
      labels: [],
    },
    diff: {
      files: [
        { path: "src/a.ts", status: "modified", additions: 15, deletions: 0, isBinary: false },
        { path: "src/b.ts", status: "modified", additions: 15, deletions: 0, isBinary: false },
      ],
      totalAdditions: 30,
      totalDeletions: 0,
      truncated: false,
    },
  });
}

describe("Pi runtime short-circuit", () => {
  test("(a) flag=true + all reviewers zero findings → coordinator NOT spawned; result has coordinatorShortCircuited=true; summary=approved; agent.completed carries shortCircuited=true", async () => {
    const runner = new CapturingPiProcessRunner();
    const runtime = new PiAgentRuntime({
      processRunner: runner,
      reviewerRetryPolicy: { maxAttempts: 1 },
    });
    const fixture = trivialFixture();

    const capturedEvents: RuntimeEvent[] = [];
    const traceSink: TraceSink = {
      async write(event) {
        capturedEvents.push(event);
      },
      async close() {},
    };

    const result = await runReview({
      fixture,
      runtime,
      traceSink,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    // Coordinator process must NOT have been spawned
    expect(runner.calls.some((c) => c.role === "coordinator")).toBe(false);
    // Result carries the short-circuit marker
    expect(result.coordinatorResult?.coordinatorShortCircuited).toBe(true);
    // Decision is approved (zero findings)
    expect(result.summary.decision).toBe("approved");
    // The agent.completed event for coordinator carries shortCircuited: true
    const coordinatorCompleted = capturedEvents.find(
      (e) => e.type === "agent.completed" && e.role === "coordinator",
    );
    expect(coordinatorCompleted?.data?.shortCircuited).toBe(true);
  });

  test("(b) flag=true + one reviewer has a finding → coordinator IS spawned; no short-circuit marker", async () => {
    const runner = new FindingReviewerPiProcessRunner();
    const runtime = new PiAgentRuntime({
      processRunner: runner,
      reviewerRetryPolicy: { maxAttempts: 1 },
    });
    const fixture = trivialFixture();

    const result = await runReview({ fixture, runtime, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(runner.calls.some((c) => c.role === "coordinator")).toBe(true);
    expect(result.coordinatorResult?.coordinatorShortCircuited).toBeUndefined();
  });

  test("(c) flag=true + ALL reviewers fail → runtime throws before short-circuit; coordinator not spawned", async () => {
    const runner = new FailingReviewerPiProcessRunner();
    const runtime = new PiAgentRuntime({
      processRunner: runner,
      reviewerRetryPolicy: { maxAttempts: 1 },
    });
    const fixture = trivialFixture();

    // Trivial tier dispatches only code_quality and the runner fails it, so the
    // all-reviewers-failed guard throws before the short-circuit check is reached.
    let threw = false;
    try {
      await runReview({ fixture, runtime, now: new Date("2026-06-09T00:00:00.000Z") });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(runner.calls.some((c) => c.role === "coordinator")).toBe(false);
  });

  test("(c2) flag=true + MIXED failure (one reviewer fails, others succeed with zero findings) → coordinator IS spawned", async () => {
    // Lite tier dispatches code_quality + security + documentation; fail only security.
    // The reviewerFailures guard must suppress the short-circuit and run the coordinator.
    const runner = new (class extends CapturingPiProcessRunner {
      override async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
        if (input.role === "security") {
          this.calls.push(input);
          throw new Error("Reviewer process failed");
        }
        return super.run(input);
      }
    })();
    const runtime = new PiAgentRuntime({
      processRunner: runner,
      reviewerRetryPolicy: { maxAttempts: 1 },
    });
    const fixture = liteFixture();

    const result = await runReview({ fixture, runtime, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(runner.calls.some((c) => c.role === "coordinator")).toBe(true);
    expect(result.coordinatorResult?.coordinatorShortCircuited).toBeUndefined();
  });

  test("(e) empty reviewer roster (trivial + code_quality disabled) → deterministic approved summary, no agents spawned", async () => {
    // Deliberate behavior (locked here): the trivial cap excludes security/documentation and
    // config disables code_quality, so NO reviewers dispatch and the short-circuit returns a
    // deterministic approved summary without any model call. Pre-cap semantics were equivalent
    // (a coordinator fusing zero reviewer results also approved); this skips the wasted call.
    // Documented as a footgun in docs/configuration.md.
    const runner = new CapturingPiProcessRunner();
    const runtime = new PiAgentRuntime({
      processRunner: runner,
      reviewerRetryPolicy: { maxAttempts: 1 },
    });
    const fixture = trivialFixture({ reviewerPolicy: { code_quality: "disabled" } });

    const result = await runReview({
      fixture,
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(runner.calls).toHaveLength(0);
    expect(result.summary.decision).toBe("approved");
    expect(result.coordinatorResult?.coordinatorShortCircuited).toBe(true);
    expect(result.coordinatorResult?.reviewerResults).toHaveLength(0);
  });

  test("(d) flag absent (full tier) → coordinator IS spawned even with zero findings", async () => {
    const runner = new CapturingPiProcessRunner();
    const runtime = new PiAgentRuntime({
      processRunner: runner,
      reviewerRetryPolicy: { maxAttempts: 1 },
    });
    // auth-pr.json → full tier (sensitive path), shortCircuitOnZeroFindings not set
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    await runReview({ fixture, runtime, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(runner.calls.some((c) => c.role === "coordinator")).toBe(true);
    // Full tier never sets the flag so there's no short-circuit marker even if all findings are empty
  });
});

// ---------------------------------------------------------------------------
// Spine plumbing via DummyAgentRuntime
// ---------------------------------------------------------------------------

class RecordingTraceSink implements TraceSink {
  readonly events: RuntimeEvent[] = [];
  async write(event: RuntimeEvent): Promise<void> {
    this.events.push(event);
  }
  async close(): Promise<void> {}
}

class RecordingTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
  async flush(): Promise<TelemetryFlushResult> {
    return { deliveredCount: this.events.length, failedCount: 0, droppedCount: 0, pendingCount: 0 };
  }
  async close(): Promise<TelemetryFlushResult> {
    return this.flush();
  }
}

describe("spine plumbing: coordinator short-circuit observability", () => {
  test("trivial-tier run with zero findings emits coordinator.completed trace with coordinatorShortCircuited=true and run_metrics with coordinatorShortCircuited=true", async () => {
    const fixture = trivialFixture();
    const runtime = new DummyAgentRuntime();
    const traceSink = new RecordingTraceSink();
    const telemetrySink = new RecordingTelemetrySink();

    await runReview({
      fixture,
      runtime,
      traceSink,
      telemetrySink,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    const coordinatorCompleted = traceSink.events.find((e) => e.type === "coordinator.completed");
    expect(coordinatorCompleted?.data?.coordinatorShortCircuited).toBe(true);

    const runMetrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(runMetrics?.data?.coordinatorShortCircuited).toBe(true);
  });

  test("lite-tier run with zero findings emits coordinatorShortCircuited=true", async () => {
    // A diff with 2 files / 10 lines → lite tier (> trivial threshold of 5 files / 25 lines? No, <= 5 files and <= 25 lines = trivial)
    // To get lite: need > 5 files OR > 25 lines but <= 50 files and <= 500 lines
    const fixture = normalizeReviewFixture({
      metadata: {
        provider: "local",
        repository: { provider: "local", name: "demo", slug: "demo" },
        changeId: "local",
        headSha: "abc123",
        title: "Moderate change",
        author: { username: "dev" },
        labels: [],
      },
      diff: {
        files: [
          { path: "src/a.ts", status: "modified", additions: 15, deletions: 0, isBinary: false },
          { path: "src/b.ts", status: "modified", additions: 15, deletions: 0, isBinary: false },
        ],
        totalAdditions: 30,
        totalDeletions: 0,
        truncated: false,
      },
    });
    const runtime = new DummyAgentRuntime();
    const traceSink = new RecordingTraceSink();
    const telemetrySink = new RecordingTelemetrySink();

    await runReview({
      fixture,
      runtime,
      traceSink,
      telemetrySink,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    // Verify the fixture classified as lite
    const riskEvent = traceSink.events.find((e) => e.type === "risk.assessed");
    expect(riskEvent?.data?.tier).toBe("lite");

    const coordinatorCompleted = traceSink.events.find((e) => e.type === "coordinator.completed");
    expect(coordinatorCompleted?.data?.coordinatorShortCircuited).toBe(true);

    const runMetrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(runMetrics?.data?.coordinatorShortCircuited).toBe(true);
  });

  test("full-tier run does NOT emit coordinatorShortCircuited (not set on either trace or telemetry)", async () => {
    // auth-pr.json triggers full tier via sensitive path
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const runtime = new DummyAgentRuntime();
    const traceSink = new RecordingTraceSink();
    const telemetrySink = new RecordingTelemetrySink();

    await runReview({
      fixture,
      runtime,
      traceSink,
      telemetrySink,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    const riskEvent = traceSink.events.find((e) => e.type === "risk.assessed");
    expect(riskEvent?.data?.tier).toBe("full");

    const coordinatorCompleted = traceSink.events.find((e) => e.type === "coordinator.completed");
    expect(coordinatorCompleted?.data?.coordinatorShortCircuited).toBeUndefined();

    const runMetrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(runMetrics?.data?.coordinatorShortCircuited).toBeUndefined();
  });

  test("trivial-tier run with findings (via DummyAgentRuntime) does NOT short-circuit coordinator", async () => {
    // code_quality is the only role on trivial; give it a finding
    const fixture = trivialFixture();
    const finding = {
      reviewer: "code_quality",
      severity: "suggestion" as const,
      category: "maintainability",
      title: "Refactor opportunity",
      body: "Consider extracting.",
      confidence: "medium" as const,
      evidence: ["changed code"],
      recommendation: "Extract helper.",
    };
    const runtime = new DummyAgentRuntime({ findingsByRole: { code_quality: [finding] } });
    const traceSink = new RecordingTraceSink();
    const telemetrySink = new RecordingTelemetrySink();

    await runReview({
      fixture,
      runtime,
      traceSink,
      telemetrySink,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    const coordinatorCompleted = traceSink.events.find((e) => e.type === "coordinator.completed");
    expect(coordinatorCompleted?.data?.coordinatorShortCircuited).toBeUndefined();

    const runMetrics = telemetrySink.events.find((e) => e.type === "ai_review.run_metrics");
    expect(runMetrics?.data?.coordinatorShortCircuited).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Timeout scale and tool policy (via existing infrastructure)
// ---------------------------------------------------------------------------

describe("timeout scale and tool policy delegate to tier profile", () => {
  // These are already covered by existing runner.test.ts and pi-runtime.test.ts,
  // but we add a minimal smoke test to confirm the profile is the source of truth.
  test("trivial shortCircuitOnZeroFindings flag is set on coordinator input for trivial tier", async () => {
    const fixture = trivialFixture();
    const capturedInput: CoordinatorRunInput[] = [];

    class InputCapturingRuntime implements AgentRuntime {
      readonly name = "input-capturing";

      async runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult> {
        capturedInput.push(input);
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
          rawOutput: '{"findings":[]}',
        };
      }

      streamEvents(
        _runId: string,
        _onEvent: (event: RuntimeEvent) => void,
      ): RuntimeEventSubscription {
        return { unsubscribe: () => {} };
      }

      async cancel(_runId: string): Promise<void> {}
    }

    await runReview({
      fixture,
      runtime: new InputCapturingRuntime(),
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(capturedInput[0]?.shortCircuitOnZeroFindings).toBe(true);
  });

  test("full tier does NOT set shortCircuitOnZeroFindings on coordinator input", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const capturedInput: CoordinatorRunInput[] = [];

    class InputCapturingRuntime implements AgentRuntime {
      readonly name = "input-capturing";

      async runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult> {
        capturedInput.push(input);
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
          rawOutput: '{"findings":[]}',
        };
      }

      streamEvents(
        _runId: string,
        _onEvent: (event: RuntimeEvent) => void,
      ): RuntimeEventSubscription {
        return { unsubscribe: () => {} };
      }

      async cancel(_runId: string): Promise<void> {}
    }

    await runReview({
      fixture,
      runtime: new InputCapturingRuntime(),
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect("shortCircuitOnZeroFindings" in (capturedInput[0] ?? {})).toBe(false);
  });
});
