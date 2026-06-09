import type { ReviewErrorClassification } from "../contracts/index.ts";

export function classifyReviewError(error: unknown): ReviewErrorClassification {
  const text = collectErrorText(error).toLowerCase();
  const status = collectHttpStatus(error);

  if (matchesAny(text, ["unsafe fork", "untrusted fork", "fork pipeline", "pull_request_target"])) {
    return nonRetryable("unsafe_fork", "privileged credentials were blocked for an untrusted change context");
  }

  if (status === 429 || matchesAny(text, ["rate limit", "rate_limit", "too many requests", "http 429", "status 429"])) {
    return retryable("rate_limited", "provider or runtime rate limit");
  }

  if (matchesAny(text, [
    "timed out",
    "timeout",
    "aborted",
    "aborterror",
    "deadline exceeded",
    "no output",
    "inactive",
    "inactivity",
  ])) {
    return retryable("timeout", "runtime exceeded a timeout or inactivity budget");
  }

  if (matchesAny(text, [
    "truncated",
    "length limit",
    "finish reason length",
    "finish_reason\":\"length",
    "reason\":\"length",
    "max output tokens",
    "max_output_tokens",
  ])) {
    return retryable("truncated", "model output ended because of a length limit");
  }

  if (matchesAny(text, [
    "context overflow",
    "context length",
    "context window",
    "prompt too long",
    "too many tokens",
    "maximum context",
    "input is too long",
  ])) {
    return nonRetryable("context_overflow", "prompt or context exceeded the model limit");
  }

  if (status === 401 || status === 403 || matchesAny(text, [
    "unauthorized",
    "forbidden",
    "authentication",
    "api key",
    "invalid key",
    "invalid token",
    "permission denied",
    "credentials",
  ])) {
    return nonRetryable("auth", "authentication or authorization failed");
  }

  if (matchesAny(text, [
    "schema",
    "valid json",
    "invalid json",
    "did not contain valid json",
    "expected json object",
    "invalid finding",
    "output did not contain",
    "structured output",
  ])) {
    return nonRetryable("schema_invalid", "model output failed the structured response contract");
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    matchesAny(text, [
      "service unavailable",
      "bad gateway",
      "gateway timeout",
      "temporarily unavailable",
      "try again",
      "econnreset",
      "etimedout",
      "eai_again",
      "socket hang up",
      "network error",
    ])
  ) {
    return retryable("retryable_transient", "transient provider/runtime failure");
  }

  return nonRetryable("unknown", "unclassified runtime failure");
}

function retryable(category: ReviewErrorClassification["category"], reason: string): ReviewErrorClassification {
  return { category, retryable: true, reason };
}

function nonRetryable(category: ReviewErrorClassification["category"], reason: string): ReviewErrorClassification {
  return { category, retryable: false, reason };
}

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function collectErrorText(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.name, error.message];
    const cause = "cause" in error ? error.cause : undefined;
    if (cause !== undefined) {
      parts.push(collectErrorText(cause));
    }
    appendField(error, parts, "code");
    appendField(error, parts, "status");
    appendField(error, parts, "statusCode");
    return parts.join(" ");
  }

  if (typeof error === "object" && error !== null) {
    const parts: string[] = [];
    appendField(error, parts, "name");
    appendField(error, parts, "message");
    appendField(error, parts, "code");
    appendField(error, parts, "status");
    appendField(error, parts, "statusCode");
    return parts.join(" ");
  }

  return String(error);
}

function collectHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const status = readNumberField(error, "status") ?? readNumberField(error, "statusCode");
  if (status !== undefined) {
    return status;
  }

  if (error instanceof Error && "cause" in error) {
    return collectHttpStatus(error.cause);
  }

  return undefined;
}

function appendField(source: object, parts: string[], field: string): void {
  const value = (source as Record<string, unknown>)[field];
  if (typeof value === "string" || typeof value === "number") {
    parts.push(String(value));
  }
}

function readNumberField(source: object, field: string): number | undefined {
  const value = (source as Record<string, unknown>)[field];
  return typeof value === "number" ? value : undefined;
}
