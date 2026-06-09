import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  BunPiProcessRunner,
  JsonlTraceSink,
  loadReviewFixture,
  PiAgentRuntime,
  runReview,
} from "../src/index.ts";
import type { PiProcessRunInput, PiProcessRunner, PiProcessRunResult, RuntimeEvent } from "../src/index.ts";

class FakePiProcessRunner implements PiProcessRunner {
  readonly calls: PiProcessRunInput[] = [];

  async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    this.calls.push(input);

    const output = input.role === "coordinator"
      ? {
        decision: "significant_concerns",
        outcome: "fail",
        title: "AI review found significant concerns",
        body: "Coordinator consolidated one critical finding.",
        findings: [securityFinding()],
        risk: input.prompt.includes("sensitive_paths")
          ? {
            tier: "full",
            reason: "Security or production-sensitive paths changed.",
            matchedRules: ["sensitive_paths"],
            sensitivePaths: ["auth/accounts.ts"],
            reviewedFileCount: 1,
            ignoredFileCount: 0,
          }
          : {
            tier: "lite",
            reason: "Fake coordinator fallback risk.",
            matchedRules: [],
            sensitivePaths: [],
            reviewedFileCount: 0,
            ignoredFileCount: 0,
          },
      }
      : {
        findings: input.role === "security" ? [securityFinding()] : [],
      };
    const finalText = JSON.stringify(output);

    return {
      finalText,
      events: [
        { type: "agent_start" },
        {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: finalText }],
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { total: 0.001 },
            },
          },
        },
        { type: "agent_end", messages: [] },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        estimatedCostUsd: 0.001,
      },
      rawOutput: "",
    };
  }
}

class RecoverableSchemaPiProcessRunner implements PiProcessRunner {
  readonly calls: PiProcessRunInput[] = [];

  async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    this.calls.push(input);

    const recoverableFinding = {
      ...securityFinding(),
      evidence: "The accountId comes from request query parameters.",
      location: {
        path: "auth/accounts.ts",
        line: 23,
      },
    };
    const finalText = JSON.stringify(input.role === "security"
      ? { findings: [recoverableFinding] }
      : input.role === "coordinator"
        ? {
          decision: "significant_concerns",
          outcome: "fail",
          title: "AI review found significant concerns",
          body: "Coordinator consolidated one finding.",
          findings: [omitEvidence(securityFinding())],
          risk: {
            tier: "full",
            reason: "Security or production-sensitive paths changed.",
            matchedRules: ["sensitive_paths"],
            sensitivePaths: ["auth/accounts.ts"],
            reviewedFileCount: 1,
            ignoredFileCount: 0,
          },
        }
        : { findings: [] });

    return {
      finalText,
      events: [],
      rawOutput: finalText,
    };
  }
}

class InvalidJsonPiProcessRunner implements PiProcessRunner {
  async run(_input: PiProcessRunInput): Promise<PiProcessRunResult> {
    return {
      finalText: "not json",
      events: [],
      rawOutput: "not json",
    };
  }
}

class FencedJsonWithInvalidBacktickEscapePiProcessRunner implements PiProcessRunner {
  async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    const escapedFinding = {
      ...securityFinding(),
      severity: "suggestion" as const,
      category: "docs",
      title: "Escaped backtick suggestion",
      body: "The model escaped markdown backticks.",
      location: "docs/example.md",
      confidence: "medium" as const,
      evidence: "Recommendation contains invalid JSON backtick escapes.",
      recommendation: "Replace `foo` with `bar`.",
    };
    const output = input.role === "coordinator"
      ? {
        decision: "approved_with_comments",
        outcome: "pass",
        title: "AI review found suggestions",
        body: "Coordinator preserved one suggestion.",
        findings: [escapedFinding],
        risk: {
          tier: "lite",
          reason: "Fake coordinator fallback risk.",
          matchedRules: [],
          sensitivePaths: [],
          reviewedFileCount: 0,
          ignoredFileCount: 0,
        },
      }
      : input.role === "security"
        ? { findings: [escapedFinding] }
        : { findings: [] };
    const shouldFenceAndEscape = input.role === "coordinator" || input.role === "security";
    const jsonText = JSON.stringify(output, null, 2);
    const finalText = shouldFenceAndEscape
      ? `\`\`\`json\n${jsonText.replace(/`/g, "\\`")}\n\`\`\``
      : jsonText;

    return {
      finalText,
      events: [],
      rawOutput: finalText,
    };
  }
}

describe("PiAgentRuntime", () => {
  test("runs coordinator and reviewers through a fake Pi process runner", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const runner = new FakePiProcessRunner();
    const runtime = new PiAgentRuntime({
      processRunner: runner,
      timestamp: "2026-06-09T00:00:00.000Z",
    });

    const result = await runReview({
      fixture,
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(result.coordinatorResult?.agentRunId).toBe("fixture-auth-pr:pi:coordinator");
    expect(result.coordinatorResult?.reviewerResults.map((reviewer) => reviewer.role)).toEqual([
      "code_quality",
      "security",
      "documentation",
      "performance",
    ]);
    expect(result.coordinatorResult?.reviewerResults.find((reviewer) => reviewer.role === "security")?.findings).toHaveLength(1);
    expect(result.summary.decision).toBe("significant_concerns");
    expect(result.summary.outcome).toBe("fail");
    expect(runner.calls.map((call) => call.role)).toEqual([
      "code_quality",
      "security",
      "documentation",
      "performance",
      "coordinator",
    ]);
    expect(runner.calls.find((call) => call.role === "security")?.prompt).toContain("Return ONLY valid JSON");
  });

  test("forwards Pi JSON events into the existing trace stream", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-pi-runtime-"));

    try {
      const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
      const tracePath = join(outputDirectory, "trace.jsonl");
      const traceSink = new JsonlTraceSink(tracePath);
      const runtime = new PiAgentRuntime({
        processRunner: new FakePiProcessRunner(),
        timestamp: "2026-06-09T00:00:00.000Z",
      });

      await runReview({
        fixture,
        runtime,
        traceSink,
        now: new Date("2026-06-09T00:00:00.000Z"),
      });
      await traceSink.close();

      const events = (await readFile(tracePath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as RuntimeEvent);

      expect(events.map((event) => event.type)).toContain("runtime.event");
      expect(events.map((event) => `${event.type}:${event.role}`)).toContain("agent.started:coordinator");
      expect(events.map((event) => `${event.type}:${event.role}`)).toContain("agent.completed:security");
      expect(events.at(-1)?.type).toBe("review.completed");
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("BunPiProcessRunner streams JSONL events before the subprocess exits", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "ai-review-pi-stream-"));

    try {
      const scriptPath = join(outputDirectory, "fake-pi.ts");
      await writeFile(scriptPath, [
        "const finalText = JSON.stringify({ findings: [] });",
        "console.log(JSON.stringify({ type: \"agent_start\" }));",
        "await new Promise((resolve) => setTimeout(resolve, 50));",
        "console.log(JSON.stringify({ type: \"message_end\", message: { role: \"assistant\", content: [{ type: \"text\", text: finalText }], usage: { input: 1, output: 2 } } }));",
      ].join("\n"));
      const runner = new BunPiProcessRunner({
        command: "bun",
        baseArgs: ["run", scriptPath],
      });
      const streamedEvents: unknown[] = [];
      let completed = false;

      const resultPromise = runner.run({
        runId: "streaming-run",
        agentRunId: "streaming-run:pi:security",
        role: "security",
        prompt: "Return findings JSON.",
        cwd: process.cwd(),
        timeoutMs: 5_000,
        toolPolicy: {
          allowRead: false,
          allowWrite: false,
          allowShell: false,
          allowedTools: [],
          deniedTools: [],
        },
        onEvent: (event) => streamedEvents.push(event),
      }).then((result) => {
        completed = true;
        return result;
      });

      await waitUntil(() => streamedEvents.length > 0);
      expect(completed).toBe(false);

      const result = await resultPromise;

      expect(streamedEvents).toHaveLength(2);
      expect((streamedEvents[0] as { type?: string }).type).toBe("agent_start");
      expect(result.finalText).toBe("{\"findings\":[]}");
      expect(result.usage).toEqual({
        inputTokens: 1,
        outputTokens: 2,
      });
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("normalizes recoverable reviewer schema drift from live model output", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const runner = new RecoverableSchemaPiProcessRunner();
    const runtime = new PiAgentRuntime({ processRunner: runner });

    const result = await runReview({
      fixture,
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    const securityResult = result.coordinatorResult?.reviewerResults.find((reviewer) => reviewer.role === "security");
    expect(securityResult?.findings[0]?.evidence).toEqual(["The accountId comes from request query parameters."]);
    expect(securityResult?.findings[0]?.location).toEqual({
      path: "auth/accounts.ts",
      line: 23,
    });
    expect(result.summary.findings[0]?.evidence).toEqual([]);
  });

  test("repairs invalid markdown backtick escapes in fenced reviewer JSON", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const runtime = new PiAgentRuntime({ processRunner: new FencedJsonWithInvalidBacktickEscapePiProcessRunner() });

    const result = await runReview({
      fixture,
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    const securityResult = result.coordinatorResult?.reviewerResults.find((reviewer) => reviewer.role === "security");
    expect(securityResult?.findings[0]?.recommendation).toBe("Replace `foo` with `bar`.");
  });

  test("rejects invalid structured reviewer output", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const runtime = new PiAgentRuntime({ processRunner: new InvalidJsonPiProcessRunner() });

    await expect(runReview({
      fixture,
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    })).rejects.toThrow("Pi output did not contain valid JSON");
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}


function omitEvidence(finding: ReturnType<typeof securityFinding>) {
  const { evidence: _evidence, ...withoutEvidence } = finding;

  return withoutEvidence;
}

function securityFinding() {
  return {
    reviewer: "security",
    severity: "critical",
    category: "auth",
    title: "Account lookup misses authorization",
    body: "The lookup uses a request supplied accountId without proving the caller can access it.",
    location: {
      path: "auth/accounts.ts",
      line: 23,
      side: "RIGHT",
    },
    confidence: "high",
    evidence: ["The accountId comes from request query parameters."],
    recommendation: "Check account ownership before returning account data.",
  };
}
