import { describe, expect, test } from "bun:test";
import {
  DETERMINISTIC_RUNTIME_KIND,
  resolveRuntimeKind,
  sanitizeJobKind,
} from "../src/runtime/runtime-kind.ts";

describe("resolveRuntimeKind", () => {
  test("returns deterministic for missing runtime name", () => {
    expect(resolveRuntimeKind(undefined)).toBe(DETERMINISTIC_RUNTIME_KIND);
  });

  test("returns deterministic for empty or whitespace-only names", () => {
    expect(resolveRuntimeKind("")).toBe(DETERMINISTIC_RUNTIME_KIND);
    expect(resolveRuntimeKind("   ")).toBe(DETERMINISTIC_RUNTIME_KIND);
  });

  test("passes through a normal runtime name", () => {
    expect(resolveRuntimeKind("pi")).toBe("pi");
  });

  test("sanitizes control characters and caps length", () => {
    const noisyName = `  suspicious\nruntime${"x".repeat(70)}  `;

    expect(resolveRuntimeKind(noisyName)).toBe(`suspiciousruntime${"x".repeat(47)}`);
  });

  test("trims spaces left behind after control-character removal", () => {
    // The leading control char shields the space from the first trim(); without a
    // second trim after stripping it, the result would be " pi" and fail to match.
    expect(resolveRuntimeKind("\x01 pi")).toBe("pi");
  });
});

describe("sanitizeJobKind", () => {
  test("returns undefined for undefined input", () => {
    expect(sanitizeJobKind(undefined)).toBeUndefined();
  });

  test("returns undefined for empty or whitespace-only strings", () => {
    expect(sanitizeJobKind("")).toBeUndefined();
    expect(sanitizeJobKind("   ")).toBeUndefined();
  });

  test("passes through normal job kind strings", () => {
    expect(sanitizeJobKind("dry-run")).toBe("dry-run");
    expect(sanitizeJobKind("publish")).toBe("publish");
    expect(sanitizeJobKind("real-review")).toBe("real-review");
  });

  test("trims leading and trailing whitespace", () => {
    expect(sanitizeJobKind("  dry-run  ")).toBe("dry-run");
  });

  test("strips control characters and caps length at 64", () => {
    const long = `job${"x".repeat(70)}`;
    expect(sanitizeJobKind(long)).toBe(`job${"x".repeat(61)}`);
    expect(sanitizeJobKind("bad\x00kind")).toBe("badkind");
  });
});
