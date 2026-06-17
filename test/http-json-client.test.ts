import { describe, expect, test } from "bun:test";
import type { FetchLike } from "../src/vcs/shared/http-json-client.ts";
import { HttpJsonClient } from "../src/vcs/shared/http-json-client.ts";

// Helper: build a FetchLike that returns different bodies based on the requested URL.
function makeFetch(responses: Record<string, { status: number; body: unknown }>): FetchLike {
  return async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = responses[url];
    if (entry === undefined) {
      throw new Error(`unexpected fetch to: ${url}`);
    }
    return new Response(JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function makeClient(fetchImpl: FetchLike, providerNoun = "Bitbucket"): HttpJsonClient {
  return new HttpJsonClient({
    baseUrl: "https://api.bitbucket.org/2.0",
    fetchImpl,
    providerNoun,
    headers: () => ({ Authorization: "Bearer test-token" }),
  });
}

describe("HttpJsonClient.requestAllPagesCursor", () => {
  test("follows the next URL from the body and returns concatenated values in order", async () => {
    const page1Values = [{ id: 1 }, { id: 2 }];
    const page2Values = [{ id: 3 }];

    const fetch = makeFetch({
      "https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests": {
        status: 200,
        body: {
          values: page1Values,
          next: "https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests?page=2",
        },
      },
      "https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests?page=2": {
        status: 200,
        body: { values: page2Values },
      },
    });

    const client = makeClient(fetch);
    const result = await client.requestAllPagesCursor<{ id: number }>(
      "/repositories/acme/widgets/pullrequests",
    );

    expect(result).toEqual([...page1Values, ...page2Values]);
  });

  test("stops after a single page when next is absent", async () => {
    const page1Values = [{ id: 10 }];

    const fetch = makeFetch({
      "https://api.bitbucket.org/2.0/repos/items": {
        status: 200,
        body: { values: page1Values },
      },
    });

    const client = makeClient(fetch);
    const result = await client.requestAllPagesCursor<{ id: number }>("/repos/items");

    expect(result).toEqual(page1Values);
  });

  test("rejects a cross-origin next cursor instead of sending credentials to a foreign host", async () => {
    const fetch = makeFetch({
      "https://api.bitbucket.org/2.0/repos/items": {
        status: 200,
        body: {
          values: [{ id: 1 }],
          // A malicious/MITM'd response points the cursor at a different host.
          next: "https://evil.example.com/2.0/repos/items?page=2",
        },
      },
    });

    const client = makeClient(fetch);

    await expect(client.requestAllPagesCursor("/repos/items")).rejects.toMatchObject({
      name: "HttpRequestError",
    });
    await expect(client.requestAllPagesCursor("/repos/items")).rejects.toThrow(/cross-origin/);
  });

  test("throws HttpRequestError on a non-ok response, carrying the status code", async () => {
    const fetch = makeFetch({
      "https://api.bitbucket.org/2.0/protected": {
        status: 403,
        body: { error: { message: "Access denied" } },
      },
    });

    const client = makeClient(fetch, "Bitbucket");

    await expect(client.requestAllPagesCursor("/protected")).rejects.toMatchObject({
      name: "HttpRequestError",
      status: 403,
    });
  });

  test("error message contains the provider noun injected at construction time", async () => {
    const fetch = makeFetch({
      "https://api.bitbucket.org/2.0/items": {
        status: 401,
        body: {},
      },
    });

    const client = makeClient(fetch, "MyProvider");

    await expect(client.requestAllPagesCursor("/items")).rejects.toThrow(
      /MyProvider API request failed/,
    );
  });
});
