// Provider-neutral HTTP/JSON client used by both the GitHub and GitLab VCS adapters.
// The two adapters' private `request<T>` methods were byte-identical except for the
// provider noun in the error string — this module eliminates that duplication (#156).
// The provider noun, base URL, fetch implementation, and header factory are all injected
// as constructor parameters so this module stays neutral: it must never import a concrete
// provider adapter (enforced by the `vcs-shared-stays-neutral` boundary rule).

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Thrown on a non-2xx response. Carries the numeric HTTP `status` so callers can branch on it
 * structurally (e.g. the publisher's summary-fallback policy) instead of parsing the message
 * string — the message format is for humans and must not be a machine contract.
 */
export class HttpRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

export interface HttpJsonClientOptions {
  baseUrl: string;
  fetchImpl: FetchLike;
  providerNoun: string;
  /** Returns the headers for a request. `hasJsonBody` is true when a JSON body is present. */
  headers: (hasJsonBody?: boolean) => HeadersInit;
}

export class HttpJsonClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly providerNoun: string;
  private readonly headersFn: (hasJsonBody?: boolean) => HeadersInit;

  constructor(options: HttpJsonClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.providerNoun = options.providerNoun;
    this.headersFn = options.headers;
  }

  async request<T>(
    pathOrUrl: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const response = await this.fetchImpl(url, {
      ...(options.method !== undefined ? { method: options.method } : {}),
      headers: this.headersFn(options.body !== undefined),
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    if (!response.ok) {
      throw new HttpRequestError(
        `${this.providerNoun} API request failed: ${response.status} ${response.statusText} for ${url}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  async requestAllPages<T>(path: string): Promise<T[]> {
    let nextUrl: string | undefined = `${this.baseUrl}${path}?per_page=100`;
    const results: T[] = [];

    while (nextUrl !== undefined) {
      const response = await this.fetchImpl(nextUrl, {
        headers: this.headersFn(),
      });

      if (!response.ok) {
        throw new HttpRequestError(
          `${this.providerNoun} API request failed: ${response.status} ${response.statusText} for ${nextUrl}`,
          response.status,
        );
      }

      const page = (await response.json()) as T[];
      results.push(...page);
      nextUrl = parseNextLink(response.headers.get("link"));
    }

    return results;
  }

  // Complements requestAllPages (Link-header paging, used by GitHub and GitLab).
  // Bitbucket Cloud carries the next-page cursor as a `next` URL in the JSON body
  // rather than an RFC-5988 `Link` header. Each response is `{ values: T[]; next?: string }`;
  // the `next` field, when present, is an absolute URL that already encodes its own
  // cursor query parameters. Pagination stops when `next` is absent.
  //
  // Security: `next` is untrusted response-body data, and every request attaches the
  // injected Authorization header. A response that points `next` at a foreign host would
  // otherwise leak the bearer credential there, so each cursor URL is required to share an
  // origin with the configured `baseUrl` before it is followed — a cross-origin (or malformed)
  // cursor throws loudly rather than silently truncating the result set.
  async requestAllPagesCursor<T>(path: string): Promise<T[]> {
    const expectedOrigin = new URL(this.baseUrl).origin;
    let nextUrl: string | undefined = `${this.baseUrl}${path}`;
    const results: T[] = [];

    while (nextUrl !== undefined) {
      const response = await this.fetchImpl(nextUrl, {
        headers: this.headersFn(),
      });

      if (!response.ok) {
        throw new HttpRequestError(
          `${this.providerNoun} API request failed: ${response.status} ${response.statusText} for ${nextUrl}`,
          response.status,
        );
      }

      const page = (await response.json()) as { values: T[]; next?: string };
      results.push(...page.values);
      nextUrl = page.next;

      if (nextUrl !== undefined && originOf(nextUrl) !== expectedOrigin) {
        throw new HttpRequestError(
          `${this.providerNoun} API returned a cross-origin pagination cursor (${nextUrl}); refusing to send credentials to a host the response chose`,
          0,
        );
      }
    }

    return results;
  }
}

// Module-private helper — returns the origin (scheme + host + port) of an absolute URL,
// or undefined when the value is not a parseable absolute URL. Used to reject body-supplied
// pagination cursors that do not match the configured API origin before the credentialed
// request is sent (see requestAllPagesCursor).
function originOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
}

// Module-private helper — parses an RFC 5988 `Link` response header to extract the URL for
// the next page of results (rel="next"). Both GitHub and GitLab emit this header, so the
// helper stays provider-neutral. Returns undefined when there is no next page (last page
// reached or no Link header present).
function parseNextLink(linkHeader: string | null): string | undefined {
  if (linkHeader === null) {
    return undefined;
  }

  for (const part of linkHeader.split(",")) {
    const [urlPart, relPart] = part.split(";").map((value) => value.trim());
    if (relPart === 'rel="next"' && urlPart?.startsWith("<") && urlPart.endsWith(">")) {
      return urlPart.slice(1, -1);
    }
  }

  return undefined;
}
