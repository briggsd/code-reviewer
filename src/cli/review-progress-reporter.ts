import type { RuntimeEvent } from "../contracts/index.ts";

/**
 * Surfaces review liveness to the operator (#41). A multi-minute Pi run prints nothing
 * between start and the final summary, so a silent terminal looks frozen. The runtime
 * already emits `heartbeat` events on a timer (`BunPiProcessRunner`) plus
 * `agent.started`/`agent.completed`/`agent.failed`; this consumer turns them into a
 * periodic human line.
 *
 * Two invariants:
 * - Lines go to a caller-supplied `write` (stderr by default), NEVER stdout, so a
 *   `--format json` stdout payload stays byte-for-byte clean.
 * - Reviewers fan out in parallel, so their heartbeat timers fire near-simultaneously
 *   (one event per outstanding reviewer per tick). `throttleMs` collapses that same-tick
 *   burst into a single line while still letting the next genuine tick (≥ the heartbeat
 *   interval later) through.
 */
export interface ReviewProgressReporterOptions {
  /** Sink for a single progress line (no trailing newline). Defaults to stderr. */
  write?: (line: string) => void;
  /** Clock source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Minimum gap between emitted lines. Smaller than the runtime's minimum heartbeat
   * interval (5s) so a parallel-reviewer burst collapses but real ticks pass.
   */
  throttleMs?: number;
}

interface HeartbeatPayload {
  type?: unknown;
  elapsedMs?: unknown;
}

export class ReviewProgressReporter {
  private readonly write: (line: string) => void;
  private readonly now: () => number;
  private readonly throttleMs: number;

  private readonly startedReviewers = new Set<string>();
  private readonly finishedReviewers = new Set<string>();
  private dispatchedReviewerCount: number | undefined;
  private coordinatorRunning = false;
  private wallStartMs: number | undefined;
  private lastEmitMs: number | undefined;

  constructor(options: ReviewProgressReporterOptions = {}) {
    this.write = options.write ?? ((line) => process.stderr.write(`${line}\n`));
    this.now = options.now ?? (() => Date.now());
    this.throttleMs = options.throttleMs ?? 2_000;
  }

  handle(event: RuntimeEvent): void {
    if (this.wallStartMs === undefined) {
      this.wallStartMs = this.now();
    }

    if (event.type === "agent.started") {
      if (event.role === "coordinator") {
        this.coordinatorRunning = true;
        const reviewerCount = event.data?.reviewerCount;
        if (typeof reviewerCount === "number") {
          this.dispatchedReviewerCount = reviewerCount;
          this.emit(`⏳ review started — dispatching ${reviewerCount} reviewers`);
        }
      } else if (event.role !== undefined) {
        this.startedReviewers.add(event.role);
      }
      return;
    }

    if (event.type === "agent.completed" || event.type === "agent.failed") {
      if (event.role === "coordinator") {
        this.coordinatorRunning = false;
      } else if (event.role !== undefined) {
        // A failed reviewer is no longer outstanding — treat it the same as completed so it
        // drops off the liveness line rather than appearing stuck forever.
        this.finishedReviewers.add(event.role);
      }
      return;
    }

    if (this.isHeartbeat(event)) {
      this.maybeEmitLiveness();
    }
  }

  private isHeartbeat(event: RuntimeEvent): boolean {
    if (event.type !== "runtime.event") {
      return false;
    }
    const inner = event.data?.event as HeartbeatPayload | undefined;
    return inner?.type === "heartbeat";
  }

  private maybeEmitLiveness(): void {
    if (this.lastEmitMs !== undefined && this.now() - this.lastEmitMs < this.throttleMs) {
      return;
    }

    // Nothing meaningful until at least one reviewer has been observed. Event ordering across
    // parallel processes is not contractually guaranteed, so a heartbeat could in principle
    // arrive before the first agent.started — skip rather than print a garbled
    // "still reviewing —  (0/0 reviewers done)" line, and never claim "synthesizing" before
    // any reviewer has actually run.
    if (this.startedReviewers.size === 0) {
      return;
    }

    const outstanding = [...this.startedReviewers]
      .filter((role) => !this.finishedReviewers.has(role))
      .sort();
    const elapsedSec = Math.round((this.now() - (this.wallStartMs ?? this.now())) / 1_000);

    if (outstanding.length === 0) {
      // All observed reviewers finished → coordinator synthesis phase (the coordinator's
      // agent.started precedes reviewer dispatch, so it is running by now). If for any reason
      // it is not flagged running, stay silent rather than print an empty reviewer list.
      if (this.coordinatorRunning) {
        this.emit(`⏳ synthesizing review — coordinator running, ${elapsedSec}s elapsed`);
      }
      return;
    }

    const total = Math.max(this.dispatchedReviewerCount ?? 0, this.startedReviewers.size);
    const done = this.finishedReviewers.size;
    this.emit(
      `⏳ still reviewing — ${outstanding.join(", ")} (${done}/${total} reviewers done), ${elapsedSec}s elapsed`,
    );
  }

  private emit(line: string): void {
    this.write(line);
    this.lastEmitMs = this.now();
  }
}
