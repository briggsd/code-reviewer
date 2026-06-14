// Provider-neutral HTTP/JSON client used by both the GitHub and GitLab VCS adapters.
// The two adapters' private `request<T>` methods were byte-identical except for the
// provider noun in the error string — this module eliminates that duplication (#156).
// The provider noun, base URL, fetch implementation, and header factory are all injected
// as constructor parameters so this module stays neutral: it must never import a concrete
// provider adapter (enforced by the `vcs-shared-stays-neutral` boundary rule).

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

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
      throw new Error(
        `${this.providerNoun} API request failed: ${response.status} ${response.statusText} for ${url}`,
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
        throw new Error(
          `${this.providerNoun} API request failed: ${response.status} ${response.statusText} for ${nextUrl}`,
        );
      }

      const page = (await response.json()) as T[];
      results.push(...page);
      nextUrl = parseNextLink(response.headers.get("link"));
    }

    return results;
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
