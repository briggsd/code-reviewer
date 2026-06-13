import { describe, expect, test } from "bun:test";

import { assertHttpUrl, parseBasicAuth, resolveRemoteEndpoint } from "../src/cli/telemetry-auth.ts";

describe("parseBasicAuth", () => {
  test("returns undefined when unset/empty (feature not configured)", () => {
    expect(parseBasicAuth(undefined)).toBeUndefined();
    expect(parseBasicAuth("")).toBeUndefined();
  });

  test("names the given var in its error", () => {
    expect(() => parseBasicAuth("nocolon", "AI_REVIEW_LOKI_BASIC_AUTH")).toThrow(
      /AI_REVIEW_LOKI_BASIC_AUTH must be/,
    );
  });

  test("parses a well-formed user:token", () => {
    expect(parseBasicAuth("12345:secret")).toEqual({ user: "12345", token: "secret" });
  });

  test("keeps colons inside the token", () => {
    expect(parseBasicAuth("user:a:b:c")).toEqual({ user: "user", token: "a:b:c" });
  });

  test("throws on a colon-free value (would otherwise send unauthenticated)", () => {
    expect(() => parseBasicAuth("mytoken")).toThrow(/user:token/);
  });

  test("throws on an empty user or empty token", () => {
    expect(() => parseBasicAuth(":token")).toThrow(/user:token/);
    expect(() => parseBasicAuth("user:")).toThrow(/user:token/);
  });
});

describe("assertHttpUrl", () => {
  test("accepts http and https", () => {
    expect(() => assertHttpUrl("https://collector.example.com/ingest")).not.toThrow();
    expect(() => assertHttpUrl("http://10.0.0.5:3100/ingest")).not.toThrow();
  });

  test("rejects non-http(s) schemes", () => {
    expect(() => assertHttpUrl("file:///etc/passwd")).toThrow(/http\(s\)/);
    expect(() => assertHttpUrl("ftp://example.com")).toThrow(/http\(s\)/);
  });

  test("rejects an unparseable URL", () => {
    expect(() => assertHttpUrl("not a url")).toThrow(/not a valid URL/);
  });

  test("rejects cloud metadata endpoints", () => {
    expect(() => assertHttpUrl("http://169.254.169.254/latest/meta-data/")).toThrow(/metadata/);
    expect(() => assertHttpUrl("http://metadata.google.internal/")).toThrow(/metadata/);
  });

  test("rejects metadata IP across IPv4 encodings the URL parser canonicalizes", () => {
    expect(() => assertHttpUrl("http://2852039166/")).toThrow(/metadata/); // decimal
    expect(() => assertHttpUrl("http://0xA9FEA9FE/")).toThrow(/metadata/); // hex
  });

  test("rejects IPv4-mapped IPv6 forms of the metadata address", () => {
    expect(() => assertHttpUrl("http://[::ffff:169.254.169.254]/")).toThrow(/metadata/);
    expect(() => assertHttpUrl("http://[::ffff:a9fe:a9fe]/")).toThrow(/metadata/);
    expect(() => assertHttpUrl("http://[fd00:ec2::254]/")).toThrow(/metadata/);
  });

  test("rejects a trailing-dot FQDN form of a metadata host", () => {
    expect(() => assertHttpUrl("http://metadata.google.internal./")).toThrow(/metadata/);
  });

  test("names the configured env var in error messages (Loki path)", () => {
    expect(() => assertHttpUrl("ftp://x", { varName: "AI_REVIEW_LOKI_URL" })).toThrow(
      /AI_REVIEW_LOKI_URL must use http/,
    );
    expect(() =>
      assertHttpUrl("http://169.254.169.254/", { varName: "AI_REVIEW_LOKI_URL" }),
    ).toThrow(/AI_REVIEW_LOKI_URL must not target/);
    expect(() =>
      assertHttpUrl("http://collector/ingest", { hasAuth: true, varName: "AI_REVIEW_LOKI_URL" }),
    ).toThrow(/AI_REVIEW_LOKI_URL uses http/);
  });

  test("rejects plain http when auth is configured (no plaintext credentials)", () => {
    expect(() => assertHttpUrl("http://collector.internal/ingest", { hasAuth: true })).toThrow(
      /plaintext/,
    );
    // ...but allows plain http with no auth (internal no-auth collector).
    expect(() =>
      assertHttpUrl("http://collector.internal/ingest", { hasAuth: false }),
    ).not.toThrow();
    // ...and allows https with auth.
    expect(() =>
      assertHttpUrl("https://collector.example.com/ingest", { hasAuth: true }),
    ).not.toThrow();
  });

  test("rejects URL-embedded credentials over plaintext http (bypasses hasAuth)", () => {
    // hasAuth is false (no auth env vars), but the URL itself carries credentials.
    expect(() => assertHttpUrl("http://user:pass@collector.internal/ingest")).toThrow(/plaintext/);
    // Same credentials over https are fine.
    expect(() => assertHttpUrl("https://user:pass@collector.example.com/ingest")).not.toThrow();
  });

  test("does not echo the raw URL (which may contain credentials) on parse failure", () => {
    try {
      assertHttpUrl("ht!tp://user:secret@host");
      throw new Error("expected assertHttpUrl to throw");
    } catch (error) {
      expect((error as Error).message).not.toContain("secret");
    }
  });
});

describe("resolveRemoteEndpoint", () => {
  test("returns undefined when the namespace's _URL is unset", () => {
    expect(resolveRemoteEndpoint("AI_REVIEW_LOKI", {})).toBeUndefined();
    expect(resolveRemoteEndpoint("AI_REVIEW_LOKI", { AI_REVIEW_LOKI_URL: "" })).toBeUndefined();
  });

  test("reads URL + basic auth from the given namespace", () => {
    const config = resolveRemoteEndpoint("AI_REVIEW_LOKI", {
      AI_REVIEW_LOKI_URL: "https://logs.example.net",
      AI_REVIEW_LOKI_BASIC_AUTH: "12345:key",
      // A different namespace's vars must be ignored.
      AI_REVIEW_TELEMETRY_BASIC_AUTH: "should:ignore",
    });
    expect(config).toEqual({
      url: "https://logs.example.net",
      basicAuth: { user: "12345", token: "key" },
    });
  });

  test("AUTHORIZATION takes precedence; BASIC_AUTH is then ignored and not validated", () => {
    const config = resolveRemoteEndpoint("AI_REVIEW_LOKI", {
      AI_REVIEW_LOKI_URL: "https://logs.example.net",
      AI_REVIEW_LOKI_AUTHORIZATION: "Bearer xyz",
      AI_REVIEW_LOKI_BASIC_AUTH: "malformed-no-colon", // would throw if validated
    });
    expect(config).toEqual({ url: "https://logs.example.net", authorization: "Bearer xyz" });
  });

  test("validates the URL under the namespace's var name", () => {
    expect(() =>
      resolveRemoteEndpoint("AI_REVIEW_LOKI", { AI_REVIEW_LOKI_URL: "http://169.254.169.254/" }),
    ).toThrow(/AI_REVIEW_LOKI_URL must not target/);
  });

  test("throws on a malformed BASIC_AUTH naming the namespace's var", () => {
    expect(() =>
      resolveRemoteEndpoint("AI_REVIEW_LOKI", {
        AI_REVIEW_LOKI_URL: "https://logs.example.net",
        AI_REVIEW_LOKI_BASIC_AUTH: "nocolon",
      }),
    ).toThrow(/AI_REVIEW_LOKI_BASIC_AUTH must be/);
  });
});
