import type { TelemetryEvent, TelemetryTransport } from "../contracts/index.ts";

// The generic remote TelemetryTransport that issue #51 specs — an authenticated HTTP POST of a
// telemetry event to an adopter-owned endpoint, behind the unchanged TelemetryTransport
// contract. This is the layered core: a vendor exporter (e.g. Loki) composes this engine with
// its own body formatter via formatRequest, rather than reimplementing auth/POST/error handling.
//
//   • This is ONLY the wire engine. The NonBlockingTelemetrySink owns queue/backpressure/
//     timeout/fail-open; the CountsOnlyTelemetryTransport decorator owns the #50 egress
//     boundary. send() just POSTs the already-projected event and throws on a non-2xx so the
//     sink records the failure and the review run continues.
//   • Default body format is one NDJSON line — exactly #51's "newline-delimited run_metrics
//     JSON". A formatRequest hook lets a vendor variant (e.g. Loki) override the wire shape.

export interface HttpTelemetryRequest {
  body: string;
  contentType: string;
}

export interface HttpTelemetryTransportOptions {
  /** Full POST URL. Vendor variants pre-compose any required path suffix. */
  url: string;
  /** Raw Authorization header value (e.g. `Bearer …`). Wins over basicAuth when both are set. */
  authorization?: string;
  /** Basic auth (e.g. Grafana Cloud: user = numeric instance ID, password = API token). */
  basicAuth?: { user: string; token: string };
  /** Turn an event into a request body. Defaults to one NDJSON line (the #51 spec shape). */
  formatRequest?: (event: TelemetryEvent) => HttpTelemetryRequest;
  /** Per-request abort timeout (ms). Bounds a hung connection. Default 10s. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpTelemetryTransport implements TelemetryTransport {
  private readonly url: string;
  private readonly authorization: string | undefined;
  private readonly formatRequest: (event: TelemetryEvent) => HttpTelemetryRequest;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  // In-flight request controllers. The tee fires send() off without awaiting, so close() must
  // be able to abort anything still running (and its abort timer) — otherwise a slow/unreachable
  // endpoint keeps the event loop alive (up to timeoutMs) after the run finishes on an
  // interactive (non-process.exit) path.
  private readonly inFlight = new Set<AbortController>();
  private closed = false;

  constructor(options: HttpTelemetryTransportOptions) {
    this.url = options.url;
    this.authorization = resolveAuthorization(options);
    this.formatRequest = options.formatRequest ?? defaultNdjsonFormat;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
  }

  async send(event: TelemetryEvent): Promise<void> {
    // Once closed (run finished), drop late events rather than starting a request that would
    // re-populate inFlight and outlive the run.
    if (this.closed) {
      return;
    }

    // Bound a hung connection — the tee fires this off without awaiting, so nothing else would
    // otherwise time it out. clearTimeout in finally so a settled request leaves no live timer.
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // formatRequest is INSIDE the try so a throwing formatter (e.g. a vendor variant rejecting
      // a malformed event) surfaces as a rejected send() — caught by the sink / tee `.catch` —
      // rather than a synchronous throw that bypasses fail-open. The timer/inFlight cleanup in
      // `finally` runs either way.
      const request = this.formatRequest(event);
      const headers: Record<string, string> = { "content-type": request.contentType };
      if (this.authorization !== undefined) {
        headers.authorization = this.authorization;
      }

      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers,
        body: request.body,
        signal: controller.signal,
        // A telemetry POST must not be redirected — following a 3xx would let the endpoint
        // bounce us to an arbitrary host (e.g. a metadata service) at runtime, after the
        // startup denylist already passed. Treat any redirect as an error.
        redirect: "error",
      });

      // Drain/cancel the body so the socket returns to the pool (Bun/undici hold the connection
      // open until the body is consumed). We only ever read the status line, never the body.
      await response.body?.cancel();

      if (!response.ok) {
        // Throw so NonBlockingTelemetrySink classifies this as a transport_error and the run
        // continues (telemetry is non-blocking). Surface ONLY the status line — the response
        // BODY is remote-server-controlled content and this Error reaches the operator's
        // persistent trace artifact via the sink's onFailure logger, so reflecting it verbatim
        // would leak whatever the endpoint returns (info-disclosure). Status is deterministic.
        throw new Error(`HTTP telemetry push failed (${response.status} ${response.statusText})`);
      }
    } finally {
      clearTimeout(timer);
      this.inFlight.delete(controller);
    }
  }

  /**
   * Abort any in-flight requests so a pending fire-and-forget send (and its abort timer) can
   * never keep the event loop alive past run completion. Aborting rejects the send's `fetch`,
   * which runs its `finally` (clearing the timer); the tee swallows that rejection.
   */
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.inFlight) {
      controller.abort();
    }
  }
}

/** #51's default wire shape: newline-delimited JSON, one event per line. */
function defaultNdjsonFormat(event: TelemetryEvent): HttpTelemetryRequest {
  return { body: `${JSON.stringify(event)}\n`, contentType: "application/x-ndjson" };
}

export function resolveAuthorization(options: {
  authorization?: string;
  basicAuth?: { user: string; token: string };
}): string | undefined {
  if (options.authorization !== undefined) {
    return options.authorization;
  }
  if (options.basicAuth !== undefined) {
    const encoded = Buffer.from(
      `${options.basicAuth.user}:${options.basicAuth.token}`,
      "utf8",
    ).toString("base64");
    return `Basic ${encoded}`;
  }
  return undefined;
}
