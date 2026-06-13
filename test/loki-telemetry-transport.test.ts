import { describe, expect, test } from "bun:test";

import type { TelemetryEvent } from "../src/contracts/index.ts";
import { createLokiTelemetryTransport } from "../src/state/loki-telemetry-transport.ts";

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
  data: { riskTier: "full", decision: "comment", findingCount: 3 },
};

describe("createLokiTelemetryTransport", () => {
  test("posts to the Loki push endpoint with the correct stream shape", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createLokiTelemetryTransport({
      url: "https://loki.example.com/",
      labels: { env: "ci" },
      labelFromData: ["riskTier", "decision"],
      fetch: fakeFetch(captured),
    });

    await transport.send(EVENT);

    expect(captured).toHaveLength(1);
    const request = captured[0];
    expect(request?.url).toBe("https://loki.example.com/loki/api/v1/push");
    // Inherits the generic core's hardening (no redirect-following SSRF).
    expect(request?.redirect).toBe("error");

    const body = request?.body as {
      streams: Array<{ stream: Record<string, string>; values: Array<[string, string]> }>;
    };
    expect(body.streams).toHaveLength(1);
    const stream = body.streams[0];

    // Low-cardinality labels: static + event type + allowlisted data fields.
    expect(stream?.stream).toEqual({
      service: "ai-code-review",
      env: "ci",
      event_type: "ai_review.run_metrics",
      riskTier: "full",
      decision: "comment",
    });

    // High-cardinality fields (runId, findingCount) stay in the log line, not the labels.
    const value = stream?.values[0];
    expect(value?.[0]).toBe("1781352000000000000"); // 2026-06-13T12:00:00Z in epoch ns
    expect(JSON.parse(value?.[1] ?? "{}")).toEqual(EVENT);
  });

  test("sets Grafana Cloud basic-auth header", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createLokiTelemetryTransport({
      url: "https://loki.example.com",
      basicAuth: { user: "12345", token: "secret-token" },
      fetch: fakeFetch(captured),
    });

    await transport.send(EVENT);

    const expected = `Basic ${Buffer.from("12345:secret-token", "utf8").toString("base64")}`;
    expect(captured[0]?.headers.authorization).toBe(expected);
  });

  test("raw authorization wins over basicAuth", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createLokiTelemetryTransport({
      url: "https://loki.example.com",
      authorization: "Bearer xyz",
      basicAuth: { user: "12345", token: "secret-token" },
      fetch: fakeFetch(captured),
    });

    await transport.send(EVENT);

    expect(captured[0]?.headers.authorization).toBe("Bearer xyz");
  });

  test("throws on a non-2xx response so the sink records the failure", async () => {
    const transport = createLokiTelemetryTransport({
      url: "https://loki.example.com",
      fetch: fakeFetch([], {
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        body: "rate limited",
      }),
    });

    await expect(transport.send(EVENT)).rejects.toThrow(/HTTP telemetry push failed \(429/);
  });

  test("omits the authorization header when no auth is configured", async () => {
    const captured: CapturedRequest[] = [];
    const transport = createLokiTelemetryTransport({
      url: "https://loki.example.com",
      fetch: fakeFetch(captured),
    });

    await transport.send(EVENT);

    expect(captured[0]?.headers.authorization).toBeUndefined();
  });
});
