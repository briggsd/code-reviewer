import { describe, expect, test } from "bun:test";

import { assertHttpUrl, parseBasicAuth } from "../src/cli/telemetry-auth.ts";

describe("parseBasicAuth", () => {
  test("returns undefined when unset/empty (feature not configured)", () => {
    expect(parseBasicAuth(undefined)).toBeUndefined();
    expect(parseBasicAuth("")).toBeUndefined();
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
