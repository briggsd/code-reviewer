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
    expect(classifyReviewError(new Error("ProviderRuntimeError Provider error (invalid_request_error): You're out of extra usage."))).toMatchObject({
      category: "provider_error",
      retryable: false,
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
    expect(classifyReviewError({ status: 429, message: "provider rate_limit_error" })).toMatchObject({
      category: "rate_limited",
      retryable: true,
    });
    expect(classifyReviewError({ status: 400, message: "Provider error (invalid_request_error): model not found" })).toMatchObject({
      category: "provider_error",
      retryable: false,
    });
    expect(classifyReviewError({ statusCode: 403, message: "forbidden" })).toMatchObject({
      category: "auth",
      retryable: false,
    });
  });

  test("terminal quota/billing rejections win over rate-limit and transient branches", () => {
    // OpenAI insufficient_quota is itself a 429 — must be terminal, not rate_limited.
    expect(classifyReviewError({ status: 429, message: "Provider error (insufficient_quota): You exceeded your current quota" })).toMatchObject({
      category: "provider_error",
      retryable: false,
    });
    // An out-of-usage message can contain transient-sounding words ("try again").
    expect(classifyReviewError(new Error("Provider error (invalid_request_error): out of usage, add more and try again"))).toMatchObject({
      category: "provider_error",
      retryable: false,
    });
    // A genuinely transient overloaded envelope must still retry.
    expect(classifyReviewError(new Error("Provider error (overloaded_error): the model is overloaded"))).toMatchObject({
      category: "retryable_transient",
      retryable: true,
    });
  });
});
