import type { TelemetryEvent, TelemetryTransport } from "../contracts/index.ts";

// Fan a single event out to several transports.
//
// Lets the CLI keep the durable JSONL artifact (the source of truth `telemetry:rollup`/
// `:analyze` still read) AND mirror events to a remote endpoint, without run-review needing to
// know about more than one sink. Order matters: pass the durable JSONL transport as primary.
//
// send() awaits ONLY the primary and treats the secondaries as fire-and-forget — each gets a
// promise chain so a rejection is reported via onSecondaryOutcome (never an unhandled rejection)
// and is not awaited. So a slow or failing remote can neither block nor fail the durable write:
// the wrapping NonBlockingTelemetrySink's per-send delivery timeout effectively gates the
// primary alone, and remote delivery is best-effort (its failures never touch the sink's
// accounting). This is the deliberate trade for fail-open: the remote leg has no delivery
// guarantee. Secondary outcomes (success or failure) are now reported via onSecondaryOutcome
// rather than silently swallowed, enabling delivery observability.

export interface TeeTelemetryTransportOptions {
  primary: TelemetryTransport;
  secondaries?: readonly TelemetryTransport[];
  /** Notified when each secondary send settles (success or failure) — for delivery observability. */
  onSecondaryOutcome?: (event: TelemetryEvent, result: { ok: boolean; error?: Error }) => void;
}

export class TeeTelemetryTransport implements TelemetryTransport {
  private readonly primary: TelemetryTransport;
  private readonly secondaries: readonly TelemetryTransport[];
  private readonly onSecondaryOutcome:
    | ((event: TelemetryEvent, result: { ok: boolean; error?: Error }) => void)
    | undefined;

  constructor(options: TeeTelemetryTransportOptions) {
    this.primary = options.primary;
    this.secondaries = options.secondaries ?? [];
    this.onSecondaryOutcome = options.onSecondaryOutcome;
  }

  async send(event: TelemetryEvent): Promise<void> {
    for (const secondary of this.secondaries) {
      // Fire-and-forget: report outcomes via onSecondaryOutcome so delivery is observable.
      // Never awaited and never throws — a flaky mirror endpoint can neither delay nor fail
      // the durable primary write below.
      //
      // Two-argument `.then(onFulfilled, onRejected)` — NOT `.then().catch()` — so a throw from
      // the success callback does NOT fall through and re-fire the outcome as `{ ok: false }`
      // (which would mislabel a successful send). reportOutcome isolates each callback in a
      // try/catch so a buggy operator-supplied callback can't surface an unhandled rejection.
      void secondary.send(event).then(
        () => this.reportOutcome(event, { ok: true }),
        (error) =>
          this.reportOutcome(event, {
            ok: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }),
      );
    }
    await this.primary.send(event);
  }

  private reportOutcome(event: TelemetryEvent, result: { ok: boolean; error?: Error }): void {
    try {
      this.onSecondaryOutcome?.(event, result);
    } catch {
      // A buggy callback must never affect delivery or surface an unhandled rejection.
    }
  }

  async close(): Promise<void> {
    const closes = [this.primary, ...this.secondaries]
      .filter(
        (t): t is TelemetryTransport & { close: () => Promise<void> } => t.close !== undefined,
      )
      .map((t) => t.close());
    await Promise.allSettled(closes);
  }
}
