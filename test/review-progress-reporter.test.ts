import { describe, expect, test } from "bun:test";
import { ReviewProgressReporter } from "../src/cli/review-progress-reporter.ts";
import type { RuntimeEvent } from "../src/contracts/index.ts";

/**
 * #41 — the reporter turns runtime heartbeat / agent events into operator-facing liveness
 * lines. It must write ONLY through the injected sink (stderr in production, never stdout)
 * and collapse the parallel-reviewer heartbeat burst into one line per tick.
 */

function heartbeat(role: string, elapsedMs: number): RuntimeEvent {
  return {
    type: "runtime.event",
    runId: "run-1",
    agentRunId: `run-1:pi:${role}`,
    role,
    timestamp: "2026-06-13T00:00:00.000Z",
    data: { runtime: "pi", event: { type: "heartbeat", role, elapsedMs } },
  };
}

function agent(
  type: RuntimeEvent["type"],
  role: string,
  data?: RuntimeEvent["data"],
): RuntimeEvent {
  return {
    type,
    runId: "run-1",
    agentRunId: `run-1:pi:${role}`,
    role,
    timestamp: "2026-06-13T00:00:00.000Z",
    ...(data !== undefined ? { data } : {}),
  };
}

function makeReporter() {
  const lines: string[] = [];
  let nowMs = 0;
  const reporter = new ReviewProgressReporter({
    write: (line) => lines.push(line),
    now: () => nowMs,
    throttleMs: 2_000,
  });
  return {
    reporter,
    lines,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

describe("ReviewProgressReporter", () => {
  test("announces dispatch and renders outstanding reviewers on heartbeat", () => {
    const { reporter, lines, advance } = makeReporter();

    reporter.handle(agent("agent.started", "coordinator", { reviewerCount: 3 }));
    expect(lines).toEqual(["⏳ review started — dispatching 3 reviewers"]);

    reporter.handle(agent("agent.started", "security"));
    reporter.handle(agent("agent.started", "performance"));
    reporter.handle(agent("agent.started", "code_quality"));
    reporter.handle(agent("agent.completed", "security"));

    advance(30_000);
    reporter.handle(heartbeat("performance", 30_000));

    expect(lines.at(-1)).toBe(
      "⏳ still reviewing — code_quality, performance (1/3 reviewers done), 30s elapsed",
    );
  });

  test("collapses a same-tick parallel-reviewer heartbeat burst into one line", () => {
    const { reporter, lines, advance } = makeReporter();
    reporter.handle(agent("agent.started", "coordinator", { reviewerCount: 2 }));
    reporter.handle(agent("agent.started", "security"));
    reporter.handle(agent("agent.started", "performance"));
    const dispatchLines = lines.length;

    advance(30_000);
    // Both reviewers fire heartbeats within the same tick window.
    reporter.handle(heartbeat("security", 30_000));
    reporter.handle(heartbeat("performance", 30_000));

    expect(lines.length - dispatchLines).toBe(1);

    // The next genuine tick (past the throttle window) emits again.
    advance(30_000);
    reporter.handle(heartbeat("security", 60_000));
    expect(lines.length - dispatchLines).toBe(2);
  });

  test("reports coordinator synthesis once all reviewers have finished", () => {
    const { reporter, lines, advance } = makeReporter();
    reporter.handle(agent("agent.started", "coordinator", { reviewerCount: 1 }));
    reporter.handle(agent("agent.started", "security"));
    reporter.handle(agent("agent.completed", "security"));

    advance(45_000);
    reporter.handle(heartbeat("coordinator", 5_000));

    expect(lines.at(-1)).toBe("⏳ synthesizing review — coordinator running, 45s elapsed");
  });

  test("stays silent on a heartbeat that arrives before any agent has started", () => {
    const { reporter, lines, advance } = makeReporter();

    advance(30_000);
    reporter.handle(heartbeat("coordinator", 5_000));

    // No reviewer outstanding and coordinator not yet flagged running → no garbled line.
    expect(lines).toEqual([]);
  });

  test("drops a failed reviewer from the outstanding set", () => {
    const { reporter, lines, advance } = makeReporter();
    reporter.handle(agent("agent.started", "coordinator", { reviewerCount: 2 }));
    reporter.handle(agent("agent.started", "security"));
    reporter.handle(agent("agent.started", "performance"));
    reporter.handle(agent("agent.failed", "security"));

    advance(30_000);
    reporter.handle(heartbeat("performance", 30_000));

    expect(lines.at(-1)).toBe("⏳ still reviewing — performance (1/2 reviewers done), 30s elapsed");
  });

  test("does not claim 'synthesizing' before any reviewer has started", () => {
    const { reporter, lines, advance } = makeReporter();

    // Coordinator announced its dispatch, but no reviewer agent.started has arrived yet.
    reporter.handle(agent("agent.started", "coordinator", { reviewerCount: 2 }));
    const dispatchLines = lines.length;

    advance(30_000);
    reporter.handle(heartbeat("coordinator", 5_000));

    // No reviewer observed → stay silent rather than prematurely report synthesis.
    expect(lines.length).toBe(dispatchLines);
  });

  test("ignores non-heartbeat runtime events", () => {
    const { reporter, lines, advance } = makeReporter();
    reporter.handle(agent("agent.started", "coordinator", { reviewerCount: 1 }));
    const baseline = lines.length;

    advance(30_000);
    reporter.handle({
      type: "runtime.event",
      runId: "run-1",
      timestamp: "2026-06-13T00:00:00.000Z",
      data: { runtime: "pi", event: { type: "assistant_message" } },
    });

    expect(lines.length).toBe(baseline);
  });
});
