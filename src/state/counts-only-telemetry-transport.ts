import type { TelemetryEvent, TelemetryTransport } from "../contracts/index.ts";
import { projectEventForEgress } from "./rollup-export.ts";

// The #50 egress boundary as a TelemetryTransport decorator. Wraps any remote transport so
// events are projected through projectEventForEgress (type allowlist + key shape-bounding)
// BEFORE they leave the process. Local JSONL stays in the repo trust domain and is NOT wrapped
// — the boundary is load-bearing only at egress (#50). #51 AC #5: "Payload obeys the #50
// counts-only boundary."
//
// Non-exportable event types project to null and are silently dropped (never sent). See
// projectEventForEgress for the enforced-vs-deferred boundary scope.
export class CountsOnlyTelemetryTransport implements TelemetryTransport {
  private readonly inner: TelemetryTransport;

  constructor(inner: TelemetryTransport) {
    this.inner = inner;
  }

  async send(event: TelemetryEvent): Promise<void> {
    const projected = projectEventForEgress(event);
    if (projected === null) {
      return;
    }
    await this.inner.send(projected);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
