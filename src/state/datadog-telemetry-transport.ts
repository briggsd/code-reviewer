import type { TelemetryEvent } from "../contracts/index.ts";
import { HttpTelemetryTransport } from "./http-telemetry-transport.ts";

// The Datadog logs-intake variant of the remote telemetry transport, layered on the generic
// HttpTelemetryTransport core. The generic transport (#51) is the default; this variant lets an
// operator whose dashboard is Datadog push straight to Datadog's logs-intake API. Selected via
// AI_REVIEW_DATADOG_URL (see cli.ts buildRemoteTelemetryTransport).
//
//   • Reuses the HTTP core for POST + redirect/timeout/close + fail-open error handling; this
//     file only owns the Datadog wire shape (the one-element JSON-array log body, the intake
//     path, and tag cardinality). Auth rides the HTTP core's `headers` seam as `DD-API-KEY`, NOT
//     `authorization` — Datadog's logs-intake API expects the key in that header, not a Bearer
//     token.
//   • ddtags cardinality discipline: tags MUST stay low-cardinality (Datadog indexes them). We
//     tag by static service + a small allowlist of low-card data fields (e.g. riskTier).
//     High-cardinality fields (per-reviewer counts, tokens, runId) stay in the log LINE, which
//     Datadog indexes fully, so nothing is lost — just not tagged.
//   • Counts-only: the CountsOnlyTelemetryTransport decorator runs BEFORE this, so the event
//     reaching toDatadogLog() has already passed the #50 egress boundary.
//   • Datadog METRICS intake (`/api/v2/series`) is deliberately OUT of scope here — a
//     Datadog-side log pipeline can derive metrics from these logs.

const INTAKE_PATH = "/api/v2/logs";

export interface DatadogTelemetryTransportOptions {
  /** Base URL of the Datadog logs-intake host, WITHOUT the path suffix. */
  url: string;
  /** Datadog API key, sent as the `DD-API-KEY` header (via the HTTP core's headers seam). */
  apiKey: string;
  /** Service field/tag attached to every log. Defaults to "ai-code-review". */
  service?: string;
  /**
   * Keys lifted from event.data into ddtags. ALLOWLIST low-cardinality fields only (e.g.
   * "riskTier", "decision", "outcome"). Non-string or empty values are skipped.
   */
  tagsFromData?: readonly string[];
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/**
 * Build a Datadog-format remote transport by composing the generic HTTP core with a Datadog
 * body formatter. Returns an HttpTelemetryTransport so the layering is explicit: Datadog is a
 * wire shape over the shared engine, not a parallel implementation.
 */
export function createDatadogTelemetryTransport(
  options: DatadogTelemetryTransportOptions,
): HttpTelemetryTransport {
  const service = options.service ?? "ai-code-review";
  const tagsFromData = options.tagsFromData ?? [];

  return new HttpTelemetryTransport({
    url: stripTrailingSlash(options.url) + INTAKE_PATH,
    headers: { "DD-API-KEY": options.apiKey },
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    formatRequest: (event) => ({
      contentType: "application/json",
      body: JSON.stringify([toDatadogLog(event, service, tagsFromData)]),
    }),
  });
}

function toDatadogLog(
  event: TelemetryEvent,
  service: string,
  tagsFromData: readonly string[],
): TelemetryEvent & { ddsource: string; service: string; ddtags: string } {
  // Start with service so ddtags is never an empty string — Datadog log ingestion expects a
  // non-empty tag set.
  const tags: string[] = [`service:${service}`];

  const data = event.data;
  if (data !== undefined) {
    for (const key of tagsFromData) {
      const value = data[key];
      if (typeof value === "string" && value.length > 0) {
        tags.push(`${key}:${value}`);
      }
    }
  }

  return { ...event, ddsource: "ai-code-review", service, ddtags: tags.join(",") };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
