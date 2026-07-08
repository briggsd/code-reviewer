import { describe, expect, test } from "bun:test";

import type { TelemetryEvent } from "../src/contracts/index.ts";
import { createDatadogTelemetryTransport } from "../src/state/datadog-telemetry-transport.ts";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  redirect: RequestRedirect | undefined;
  body: unknown;
}

function fakeFetch(
  captured: CapturedRequest[],
  response: { ok: boolean; status?: number; statusText?: string; body?: string } = { ok: true },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key] = String(value);
    }
    captured.push({
      url: String(input),
      headers,
      redirect: init?.redirect,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(response.body ?? "", {
      status: response.status ?? (response.ok ? 204 : 500),
      statusText: response.statusText ?? "",
    });
  }) as unknown as typeof fetch;
}

const EVENT: TelemetryEvent = {
  type: "ai_review.run_metrics",
  timestamp: "2026-06-13T12:00:00.000Z",
  runId: "run-abc",
  data: { riskTier: "full", decision: "comment", outcome: "success", findingCount: 3 },
};

describe("createDatadogTelemetryTransport", () => {
  test("posts to the Datadog logs-intake endpoint with the correct log shape", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createDatadogTelemetryTransport({
      url: "https://http-intake.logs.datadoghq.com",
      apiKey: "dd-api-key-value",
      tagsFromData: ["riskTier", "decision", "outcome"],
      fetch: fakeFetch(captured),
    });

    await transport.send(EVENT);

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.url).toBe("https://http-intake.logs.datadoghq.com/api/v2/logs");
    // Inherits the generic core's hardening (no redirect-following SSRF).
    expect(request?.redirect).toBe("error");
    expect(request?.headers["content-type"]).toBe("application/json");
    // The core lowercases static header keys, so DD-API-KEY reaches fetch as dd-api-key.
    expect(request?.headers["dd-api-key"]).toBe("dd-api-key-value");

    const body = request?.body as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    const log = body[0];
    expect(log?.ddsource).toBe("ai-code-review");
    expect(log?.service).toBe("ai-code-review");
    expect(log?.type).toBe(EVENT.type);
    expect(log?.timestamp).toBe(EVENT.timestamp);
    expect(log?.runId).toBe(EVENT.runId);
    expect(log?.data).toEqual(EVENT.data);
  });

  test("ddtags contains only allowlisted low-cardinality keys", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createDatadogTelemetryTransport({
      url: "https://http-intake.logs.datadoghq.com",
      apiKey: "dd-api-key-value",
      tagsFromData: ["riskTier", "decision", "outcome"],
      fetch: fakeFetch(captured),
    });

    await transport.send(EVENT);

    const body = captured[0]?.body as Array<Record<string, unknown>>;
    const ddtags = new Set(String(body[0]?.ddtags ?? "").split(","));
    expect(ddtags.has("service:ai-code-review")).toBe(true);
    expect(ddtags.has("riskTier:full")).toBe(true);
    expect(ddtags.has("decision:comment")).toBe(true);
    expect(ddtags.has("outcome:success")).toBe(true);
    // High-cardinality fields stay in the log line, not the tags.
    for (const tag of ddtags) {
      expect(tag.startsWith("runId:")).toBe(false);
      expect(tag.startsWith("findingCount:")).toBe(false);
    }
  });

  test("service override reflects in both the log field and the ddtag", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createDatadogTelemetryTransport({
      url: "https://http-intake.logs.datadoghq.com",
      apiKey: "dd-api-key-value",
      service: "my-svc",
      fetch: fakeFetch(captured),
    });

    await transport.send(EVENT);

    const body = captured[0]?.body as Array<Record<string, unknown>>;
    expect(body[0]?.service).toBe("my-svc");
    const ddtags = new Set(String(body[0]?.ddtags ?? "").split(","));
    expect(ddtags.has("service:my-svc")).toBe(true);
  });

  test("skips a missing allowlisted field", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createDatadogTelemetryTransport({
      url: "https://http-intake.logs.datadoghq.com",
      apiKey: "dd-api-key-value",
      tagsFromData: ["riskTier", "decision", "outcome"],
      fetch: fakeFetch(captured),
    });

    await transport.send({
      ...EVENT,
      data: { riskTier: "full", outcome: "success" },
    });

    const body = captured[0]?.body as Array<Record<string, unknown>>;
    const ddtags = new Set(String(body[0]?.ddtags ?? "").split(","));
    for (const tag of ddtags) {
      expect(tag.startsWith("decision:")).toBe(false);
    }
  });

  test("throws on a non-2xx response so the sink records the failure", async () => {
    const transport = createDatadogTelemetryTransport({
      url: "https://http-intake.logs.datadoghq.com",
      apiKey: "dd-api-key-value",
      fetch: fakeFetch([], {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: "rate limited",
      }),
    });

    await expect(transport.send(EVENT)).rejects.toThrow(/HTTP telemetry push failed \(429/);
  });
});
