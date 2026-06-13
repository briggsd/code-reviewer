import type { TelemetryEvent, TelemetryTransport } from "../contracts/index.ts";

// Fan a single event out to several transports.
//
// Lets the CLI keep the durable JSONL artifact (the source of truth `telemetry:rollup`/
// `:analyze` still read) AND mirror events to a remote endpoint, without run-review needing to
// know about more than one sink. Order matters: pass the durable JSONL transport FIRST as the
// primary.
//
// send() awaits ONLY the primary and treats the secondaries as fire-and-forget — each gets a
// `.catch` so a rejection is swallowed (never an unhandled rejection) and is not awaited. So a
// slow or failing remote can neither block nor fail the durable write: the wrapping
// NonBlockingTelemetrySink's per-send delivery timeout effectively gates the primary alone,
// and remote delivery is best-effort (its failures never touch the sink's accounting). This is
// the deliberate trade for fail-open: the remote leg has no delivery guarantee.
export class TeeTelemetryTransport implements TelemetryTransport {
  private readonly primary: TelemetryTransport;
  private readonly secondaries: readonly TelemetryTransport[];

  constructor(primary: TelemetryTransport, ...secondaries: TelemetryTransport[]) {
    this.primary = primary;
    this.secondaries = secondaries;
  }

  async send(event: TelemetryEvent): Promise<void> {
    for (const secondary of this.secondaries) {
      // Fire-and-forget: swallow rejections so a flaky mirror endpoint never surfaces an
      // unhandled rejection and never delays or fails the durable primary write below.
      void secondary.send(event).catch(() => {});
    }
    await this.primary.send(event);
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
