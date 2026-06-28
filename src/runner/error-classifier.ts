import type { ReviewErrorClassification } from "../contracts/index.ts";

/**
 * Returns true when a failure classification signals a provider-health problem where switching to
 * a different provider may succeed. Covers rate-limit (429) and transient service failures
 * (502/503/504/overloaded). Intentionally excludes `timeout` and `truncated` — those indicate a
 * slow or oversized response that provider B won't fix — and all non-retryable categories, where
 * a failback hop would not help. Does NOT add new category values to the union.
 */
export function isFailbackEligible(c: ReviewErrorClassification): boolean {
  return c.category === "rate_limited" || c.category === "retryable_transient";
}

export function classifyReviewError(error: unknown): ReviewErrorClassification {
  const text = collectErrorText(error).toLowerCase();
  const status = collectHttpStatus(error);

  if (matchesAny(text, ["unsafe fork", "untrusted fork", "fork pipeline", "pull_request_target"])) {
    return nonRetryable(
      "unsafe_fork",
      "privileged credentials were blocked for an untrusted change context",
    );
  }

  // Terminal provider rejections (bad request, quota/billing exhaustion, unknown
  // model) are not retryable and must be classified before the 429 rate-limit and
  // transient "try again" branches below: an OpenAI insufficient_quota is itself a
  // 429, and an out-of-usage message can read "...keep going" / "try again".
  // Retrying these only burns budget. Generic/unknown provider envelopes (handled
  // lower) stay below the transient branch so an overloaded_error still retries.
  // Billing/credit/quota exhaustion is the most actionable triage signal in this branch
  // (operator response is "top up the account", not "debug a code bug"), so detect it FIRST
  // and give it a distinct operator-facing reason. The remaining terminal rejections
  // (malformed request, unknown model) keep the generic reason. Both stay
  // `provider_error`/non-retryable — only the `reason` string differs by group. Reasons are
  // fixed literals (no raw-error interpolation) so they never echo provider text or secrets.
  if (
    matchesAny(text, [
      "out of extra usage",
      "out of usage",
      "insufficient_quota",
      "quota exceeded",
      "billing",
      "credit",
    ])
  ) {
    return nonRetryable("provider_error", "provider quota or billing exhausted");
  }

  if (matchesAny(text, ["invalid_request_error", "model not found", "invalid model"])) {
    return nonRetryable("provider_error", "provider rejected the request");
  }

  if (
    status === 429 ||
    matchesAny(text, ["rate limit", "rate_limit", "too many requests", "http 429", "status 429"])
  ) {
    return retryable("rate_limited", "provider or runtime rate limit");
  }

  if (
    matchesAny(text, [
      "timed out",
      "timeout",
      "aborted",
      "aborterror",
      "deadline exceeded",
      "no output",
      "inactive",
      "inactivity",
    ])
  ) {
    return retryable("timeout", "runtime exceeded a timeout or inactivity budget");
  }

  if (
    matchesAny(text, [
      "truncated",
      "length limit",
      "finish reason length",
      'finish_reason":"length',
      'reason":"length',
      "max output tokens",
      "max_output_tokens",
    ])
  ) {
    return retryable("truncated", "model output ended because of a length limit");
  }

  if (
    matchesAny(text, [
      "context overflow",
      "context length",
      "context window",
      "prompt too long",
      "too many tokens",
      "maximum context",
      "input is too long",
    ])
  ) {
    // The patch-admission gate (#145) is the PRIMARY mitigation for oversized diffs: it demotes
    // files gracefully before the model call, so normal large PRs never reach here. This
    // context_overflow path is the SAFETY NET for genuine model-side overflows AFTER degradation —
    // it is intentionally non-retryable (retrying would just overflow again).
    return nonRetryable("context_overflow", "prompt or context exceeded the model limit");
  }

  if (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    matchesAny(text, [
      "service unavailable",
      "bad gateway",
      "gateway timeout",
      "overloaded",
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

  if (
    status === 401 ||
    status === 403 ||
    matchesAny(text, [
      "unauthorized",
      "forbidden",
      "authentication",
      "api key",
      "invalid key",
      "invalid token",
      "permission denied",
      "credentials",
    ])
  ) {
    return nonRetryable("auth", "authentication or authorization failed");
  }

  // Generic provider error envelopes whose type wasn't matched above. Kept below
  // the transient branch so a retryable envelope (e.g. overloaded_error) is not
  // swept up here.
  if (matchesAny(text, ["providerruntimeerror", "provider error"])) {
    return nonRetryable("provider_error", "provider returned an error envelope");
  }

  if (
    matchesAny(text, [
      "schema",
      "valid json",
      "invalid json",
      "did not contain valid json",
      "expected json object",
      "invalid finding",
      "output did not contain",
      "structured output",
    ])
  ) {
    return nonRetryable("schema_invalid", "model output failed the structured response contract");
  }

  return nonRetryable("unknown", "unclassified runtime failure");
}

function retryable(
  category: ReviewErrorClassification["category"],
  reason: string,
): ReviewErrorClassification {
  return { category, retryable: true, reason };
}

function nonRetryable(
  category: ReviewErrorClassification["category"],
  reason: string,
): ReviewErrorClassification {
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
