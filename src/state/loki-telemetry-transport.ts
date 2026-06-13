import type { TelemetryEvent } from "../contracts/index.ts";
import { HttpTelemetryTransport } from "./http-telemetry-transport.ts";

// The Grafana Loki push-API variant of the remote telemetry transport, layered on the generic
// HttpTelemetryTransport core. The generic transport (#51) is the default; this variant lets an
// operator whose dashboard is Grafana push straight to Loki's API, skipping a promtail/Alloy
// ingestion hop. Selected via AI_REVIEW_LOKI_URL (see cli.ts buildRemoteTelemetryTransport).
//
//   • Reuses the HTTP core for auth + POST + redirect/timeout/close + fail-open error handling;
//     this file only owns the Loki wire shape (the {streams:[{stream,values}]} envelope, the
//     push path, and label cardinality).
//   • Loki label cardinality: labels MUST stay low-cardinality (Loki indexes them). We label
//     by static service + event type + a small allowlist of low-card data fields (e.g.
//     riskTier). High-cardinality fields (per-reviewer counts, tokens) stay in the log LINE
//     and are extracted at query time with LogQL `| json`.
//   • Counts-only: the CountsOnlyTelemetryTransport decorator runs BEFORE this, so the event
//     reaching toLokiStream() has already passed the #50 egress boundary.

const PUSH_PATH = "/loki/api/v1/push";

export interface LokiTelemetryTransportOptions {
  /** Base URL of the Loki / Grafana Cloud Loki instance, WITHOUT the push-path suffix. */
  url: string;
  /** Static labels attached to every stream. Low-cardinality only (Loki indexes labels). */
  labels?: Record<string, string>;
  /** Grafana Cloud basic auth: user = numeric instance ID, password = API token. */
  basicAuth?: { user: string; token: string };
  /** Raw Authorization header value (e.g. `Bearer …`). Wins over basicAuth when both are set. */
  authorization?: string;
  /**
   * Keys lifted from event.data into Loki labels. ALLOWLIST low-cardinality fields only
   * (e.g. "riskTier", "decision", "outcome"). Non-string values are skipped.
   */
  labelFromData?: readonly string[];
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

interface LokiStream {
  stream: Record<string, string>;
  values: Array<[string, string]>;
}

/**
 * Build a Loki-format remote transport by composing the generic HTTP core with a Loki
 * body formatter. Returns an HttpTelemetryTransport so the layering is explicit: Loki is a
 * wire shape over the shared engine, not a parallel implementation.
 */
export function createLokiTelemetryTransport(
  options: LokiTelemetryTransportOptions,
): HttpTelemetryTransport {
  const staticLabels: Record<string, string> = { service: "ai-code-review", ...options.labels };
  const labelFromData = options.labelFromData ?? [];

  return new HttpTelemetryTransport({
    url: stripTrailingSlash(options.url) + PUSH_PATH,
    ...(options.authorization !== undefined ? { authorization: options.authorization } : {}),
    ...(options.basicAuth !== undefined ? { basicAuth: options.basicAuth } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    formatRequest: (event) => ({
      contentType: "application/json",
      body: JSON.stringify({ streams: [toLokiStream(event, staticLabels, labelFromData)] }),
    }),
  });
}

function toLokiStream(
  event: TelemetryEvent,
  staticLabels: Record<string, string>,
  labelFromData: readonly string[],
): LokiStream {
  const labels: Record<string, string> = { ...staticLabels, event_type: event.type };

  const data = event.data;
  if (data !== undefined) {
    for (const key of labelFromData) {
      const value = data[key];
      if (typeof value === "string" && value.length > 0) {
        labels[key] = value;
      }
    }
  }

  return {
    stream: labels,
    values: [[toLokiTimestampNs(event.timestamp), JSON.stringify(event)]],
  };
}

/** Loki wants the timestamp as a unix-epoch nanosecond string. */
function toLokiTimestampNs(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    // The emitter always supplies an ISO timestamp; a malformed one is a contract violation,
    // so throw and let the sink record the failure rather than silently sending a bad ts.
    throw new Error(`createLokiTelemetryTransport: unparseable event timestamp "${iso}"`);
  }
  return (BigInt(ms) * 1_000_000n).toString();
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
