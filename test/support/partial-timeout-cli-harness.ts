// Regression harness for the PR #43 fail-closed-on-timeout bug.
//
// Drives the REAL partial-timeout path: a real PiAgentRuntime whose reviewers
// complete instantly but whose coordinator holds a live `sleep` child (an
// outstanding OS handle, like the real `pi` subprocess). The overall timeout
// fires, runReview returns a `review_failed` partial summary, and we then run
// the same CI-exit finalization the CLI uses (`finalizeCiExit`).
//
// The point: an outstanding child handle is alive at shutdown. With the correct
// `process.exit(code)` this exits 1; with the old deferred `process.exitCode = code`
// Bun would force-exit 0 (green gate on a failed review). The cli-exit test
// spawns this harness and asserts the OS exit code is 1.

import { finalizeCiExit } from "../../src/cli/ci-exit.ts";
import type { PiProcessRunInput, PiProcessRunResult } from "../../src/index.ts";
import {
  decideCiOutcome,
  normalizeReviewFixture,
  PiAgentRuntime,
  runReview,
} from "../../src/index.ts";

const findingJson = JSON.stringify({
  findings: [
    {
      reviewer: "security",
      severity: "warning",
      category: "correctness",
      title: "Completed reviewer finding",
      body: "The changed code has a concrete review finding.",
      location: { path: "src/example.ts", line: 1, side: "RIGHT" },
      confidence: "high",
      evidence: ["The changed line demonstrates the issue."],
      recommendation: "Fix it before relying on this path.",
    },
  ],
});

// Reviewers resolve instantly; the coordinator spawns a real child and awaits
// it, so a live OS handle is still outstanding when the overall timeout fires.
// Intentionally NO cancel() impl: the child stays alive at process exit, which
// is exactly the condition that defeats a deferred `process.exitCode`.
const processRunner = {
  async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    if (input.role !== "coordinator") {
      return { finalText: findingJson, events: [], rawOutput: findingJson };
    }
    // Ignore stdio so the orphaned child does NOT inherit/hold this process's
    // stderr pipe — otherwise a parent reading our stderr blocks until `sleep`
    // exits. The child is still a live OS handle for the duration of the run.
    Bun.spawn(["sleep", "30"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await new Promise(() => {});
    return { finalText: "{}", events: [], rawOutput: "{}" };
  },
};

const runtime = new PiAgentRuntime({ processRunner: processRunner as never });

const fixture = normalizeReviewFixture({
  runId: "partial-timeout-exit",
  metadata: {
    provider: "local",
    repository: { provider: "local", name: "demo", slug: "demo" },
    changeId: "local",
    headSha: "abc123",
    title: "Update code",
    author: { username: "dev" },
    labels: [],
  },
  // 60 files -> classifies as `full`, so reviewers actually run (and complete),
  // guaranteeing getPartialCoordinatorResult returns a partial (not a throw).
  diff: {
    files: Array.from({ length: 60 }, (_unused, index) => ({
      path: `src/file-${index}.ts`,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      isBinary: false,
    })),
    totalAdditions: 60,
    totalDeletions: 0,
    truncated: false,
  },
  config: {
    mode: "blocking",
    failOn: ["critical"],
    timeouts: { reviewerMs: 5_000, coordinatorMs: 5_000, overallMs: 400 },
  },
});

const result = await runReview({
  fixture,
  runtime: runtime as never,
  now: new Date("2026-06-09T00:00:00.000Z"),
});

// Mirror cli.ts runCommand's CI-exit tail.
console.error(`summary.title=${result.summary.title} decision=${result.summary.decision}`);
const decision = decideCiOutcome(result.summary, result.context.config);
finalizeCiExit(decision.exitCode);
