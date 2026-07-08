// Pure config helpers for the remote telemetry transports, extracted from cli.ts so they are
// unit-testable (cli.ts runs argv-dispatch on import, so it can't be imported in a test). No
// adapter imports — env/string/URL resolution only.
//
// EXPORTER NAMESPACE CONVENTION: each remote exporter owns an env namespace
// `AI_REVIEW_<NAME>_{URL,AUTHORIZATION,BASIC_AUTH}` (e.g. AI_REVIEW_TELEMETRY_* for the generic
// HTTP transport, AI_REVIEW_LOKI_* for the Loki variant). `resolveRemoteEndpoint(prefix, env)`
// reads one namespace; a new exporter is just a new prefix. Keeping them separate (rather than
// sharing one auth pair) lets exporters be configured independently — and, later, run together.

/** Config for one remote exporter endpoint, resolved from its env namespace. */
export interface RemoteEndpointConfig {
  url: string;
  authorization?: string;
  basicAuth?: { user: string; token: string };
}

/**
 * Resolve a remote exporter's config from `<prefix>_URL` / `<prefix>_AUTHORIZATION` /
 * `<prefix>_BASIC_AUTH`. Returns `undefined` when `<prefix>_URL` is unset (exporter off).
 * Validates the URL and auth at startup (throwing on misconfiguration). `AUTHORIZATION` takes
 * precedence over `BASIC_AUTH` (the latter is then ignored and not validated).
 */
export function resolveRemoteEndpoint(
  prefix: string,
  env: Record<string, string | undefined>,
): RemoteEndpointConfig | undefined {
  const url = env[`${prefix}_URL`];
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  const authorization = env[`${prefix}_AUTHORIZATION`];
  const hasAuthorization = authorization !== undefined && authorization.length > 0;
  const basicAuth = hasAuthorization
    ? undefined
    : parseBasicAuth(env[`${prefix}_BASIC_AUTH`], `${prefix}_BASIC_AUTH`);
  const hasAuth = hasAuthorization || basicAuth !== undefined;
  assertHttpUrl(url, { hasAuth, varName: `${prefix}_URL` });
  return {
    url,
    ...(hasAuthorization ? { authorization } : {}),
    ...(basicAuth !== undefined ? { basicAuth } : {}),
  };
}

/**
 * Parse a `<prefix>_BASIC_AUTH` ("user:token") value.
 *
 * Returns `undefined` when the variable is unset/empty (feature not configured). When it IS
 * set but malformed (no colon, empty user, or empty token), THROWS — symmetric with
 * `assertHttpUrl` — so an operator's misconfiguration surfaces at startup instead of silently
 * firing unauthenticated requests that 401 at runtime. `varName` names the var in the error.
 */
export function parseBasicAuth(
  raw: string | undefined,
  varName = "AI_REVIEW_TELEMETRY_BASIC_AUTH",
): { user: string; token: string } | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  const separatorIndex = raw.indexOf(":");
  const token = separatorIndex >= 0 ? raw.slice(separatorIndex + 1) : "";
  if (separatorIndex <= 0 || token.length === 0) {
    throw new Error(`${varName} must be "user:token" with a non-empty user and token`);
  }
  return { user: raw.slice(0, separatorIndex), token };
}

/** Config for the Datadog logs-intake exporter, resolved from its env namespace. */
export interface DatadogEndpointConfig {
  url: string;
  apiKey: string;
  service?: string;
}

/**
 * Resolve the Datadog exporter config from AI_REVIEW_DATADOG_{URL,API_KEY,SERVICE}. Returns
 * undefined when _URL is unset (exporter off). The URL is validated via resolveRemoteEndpoint
 * (inherits URL parse + metadata-host denylist). THROWS when _URL is set but _API_KEY is
 * missing/empty (an intake URL with no key is a misconfiguration), and when the URL is plaintext
 * http:// while an API key is present — assertHttpUrl's plaintext-credential guard only sees the
 * AUTHORIZATION/BASIC_AUTH pair, not the DD-API-KEY header seam, so this guard closes that gap.
 */
export function resolveDatadogEndpoint(
  env: Record<string, string | undefined>,
): DatadogEndpointConfig | undefined {
  const endpoint = resolveRemoteEndpoint("AI_REVIEW_DATADOG", env);
  if (endpoint === undefined) {
    return undefined;
  }
  const apiKey = env.AI_REVIEW_DATADOG_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      "AI_REVIEW_DATADOG_URL is set but AI_REVIEW_DATADOG_API_KEY is missing or empty — " +
        "a Datadog intake URL requires an API key",
    );
  }
  // assertHttpUrl (inside resolveRemoteEndpoint) only refuses plaintext http:// when the
  // AUTHORIZATION/BASIC_AUTH pair is set — it does NOT see the DD-API-KEY header seam. Guard
  // it here so the API key can never leave over plaintext http.
  if (new URL(endpoint.url).protocol === "http:") {
    throw new Error(
      "AI_REVIEW_DATADOG_URL uses http:// but an API key is present — refusing to send " +
        "credentials in plaintext; use https://",
    );
  }
  const service = env.AI_REVIEW_DATADOG_SERVICE;
  return {
    url: endpoint.url,
    apiKey,
    ...(service !== undefined && service.length > 0 ? { service } : {}),
  };
}

// Well-known cloud instance-metadata endpoints. No telemetry collector legitimately lives
// here, and in cloud CI these vend IAM credentials — so they are denied outright. This is a
// NARROW denylist: ordinary private/RFC1918 addresses and DNS names (internal/cluster-local
// collectors) remain valid destinations — only these specific metadata hosts are refused.
//
// The WHATWG URL parser canonicalizes IPv4 encodings for us — decimal (2852039166), hex
// (0xA9FEA9FE), and octal all normalize to "169.254.169.254", and every IPv4-mapped IPv6 form
// normalizes to "::ffff:a9fe:a9fe" — so the set only needs each canonical form once.
//
// Best-effort, by design: the URL is operator-trusted configuration (not attacker input) and
// the telemetry POST never reads/forwards the response body, so this guards against an operator
// misconfiguration rather than an exfiltration vector. It is not a hardened SSRF boundary.
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  "169.254.169.254", // AWS / Azure IMDS (IPv4; also covers decimal/hex/octal encodings)
  "::ffff:a9fe:a9fe", // …and the IPv4-mapped IPv6 forms of the same address
  "fd00:ec2::254", // AWS IMDSv2 (IPv6)
  "metadata.google.internal", // GCP metadata
]);

/**
 * Validate a remote telemetry URL. Throws (hard startup error) unless it parses as an
 * `http(s)` URL that is not a cloud metadata endpoint, and — when auth is configured — is
 * `https`.
 *
 * `varName` names the env var in error messages (e.g. `AI_REVIEW_TELEMETRY_URL` or
 * `AI_REVIEW_LOKI_URL`) so the operator sees the variable they actually set.
 *
 * Host policy: only the specific cloud metadata hosts above are denied. Private/RFC1918 and
 * DNS-named internal collectors are still allowed — the URL is operator-trusted configuration,
 * and blanket SSRF host-blocking would break the common fleet-internal-collector deployment.
 *
 * Credential policy: plain `http://` is allowed for a no-auth internal collector, but rejected
 * when auth is configured so credentials are never transmitted in plaintext.
 */
export function assertHttpUrl(
  raw: string,
  options?: { hasAuth?: boolean; varName?: string },
): void {
  const varName = options?.varName ?? "AI_REVIEW_TELEMETRY_URL";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // Do NOT echo the raw value — it may contain embedded `user:pass@` credentials.
    throw new Error(`${varName} is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${varName} must use http(s), got ${JSON.stringify(parsed.protocol)}`);
  }
  // Normalize before the denylist lookup: strip IPv6 brackets, a trailing FQDN dot
  // ("metadata.google.internal." resolves identically), and case.
  const host = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    throw new Error(`${varName} must not target a cloud metadata endpoint: ${host}`);
  }
  // Credentials must never go over plaintext http — whether configured via the auth env vars
  // (hasAuth) OR embedded directly in the URL as `user:pass@host` (which bypasses hasAuth).
  const hasCredentials =
    options?.hasAuth === true || parsed.username !== "" || parsed.password !== "";
  if (hasCredentials && parsed.protocol === "http:") {
    throw new Error(
      `${varName} uses http:// but credentials are present — refusing to send ` +
        "credentials in plaintext; use https://",
    );
  }
}
