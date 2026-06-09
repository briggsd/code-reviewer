import { describe, expect, test } from "bun:test";
import { classifyReviewError } from "../src/index.ts";

describe("review error classification", () => {
  test("classifies stable retryable and non-retryable categories", () => {
    expect(classifyReviewError(new Error("Pi process timed out after 300000ms"))).toMatchObject({
      category: "timeout",
      retryable: true,
    });
    expect(classifyReviewError(new Error("HTTP 429: rate limit exceeded"))).toMatchObject({
      category: "rate_limited",
      retryable: true,
    });
    expect(classifyReviewError(new Error("step_finish reason:\"length\" output truncated"))).toMatchObject({
      category: "truncated",
      retryable: true,
    });
    expect(classifyReviewError(new Error("context length exceeded: too many tokens"))).toMatchObject({
      category: "context_overflow",
      retryable: false,
    });
    expect(classifyReviewError(new Error("401 unauthorized invalid token"))).toMatchObject({
      category: "auth",
      retryable: false,
    });
    expect(classifyReviewError(new Error("Pi reviewer output did not contain a findings array"))).toMatchObject({
      category: "schema_invalid",
      retryable: false,
    });
    expect(classifyReviewError(new Error("503 service unavailable"))).toMatchObject({
      category: "retryable_transient",
      retryable: true,
    });
    expect(classifyReviewError(new Error("unsafe fork attempted privileged write-back"))).toMatchObject({
      category: "unsafe_fork",
      retryable: false,
    });
  });

  test("does not echo raw error text or secrets in classification reasons", () => {
    const classification = classifyReviewError(new Error("401 unauthorized token sk-live-secret-value"));

    expect(classification.category).toBe("auth");
    expect(classification.reason).toBe("authentication or authorization failed");
    expect(classification.reason).not.toContain("sk-live-secret-value");
  });

  test("classifies status-like error objects", () => {
    expect(classifyReviewError({ status: 503, message: "upstream unavailable" })).toMatchObject({
      category: "retryable_transient",
      retryable: true,
    });
    expect(classifyReviewError({ statusCode: 403, message: "forbidden" })).toMatchObject({
      category: "auth",
      retryable: false,
    });
  });
});
