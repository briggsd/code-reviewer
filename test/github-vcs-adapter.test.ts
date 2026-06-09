import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { GitHubVcsAdapter, loadReviewFixture, runReview } from "../src/index.ts";
import type { ChangeRef, FetchLike } from "../src/index.ts";

const changeRef: ChangeRef = {
  provider: "github",
  repository: {
    provider: "github",
    owner: "example",
    name: "payments-api",
    slug: "example/payments-api",
  },
  changeId: "42",
  headSha: "headsha123",
};

describe("GitHubVcsAdapter", () => {
  test("normalizes GitHub pull request metadata", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      token: "test-token",
      fetch: fixtureFetch(fetchCalls),
    });

    const change = await adapter.getChange(changeRef);

    expect(change.provider).toBe("github");
    expect(change.repository.slug).toBe("example/payments-api");
    expect(change.repository.webUrl).toBe("https://github.com/example/payments-api");
    expect(change.changeId).toBe("42");
    expect(change.headSha).toBe("headsha123");
    expect(change.baseSha).toBe("basesha456");
    expect(change.sourceBranch).toBe("feature/account-lookup");
    expect(change.targetBranch).toBe("main");
    expect(change.title).toBe("Harden account lookup");
    expect(change.description).toBe("Adds account lookup with stricter auth checks.");
    expect(change.author).toEqual({
      id: "123",
      username: "octo-dev",
      webUrl: "https://github.com/octo-dev",
    });
    expect(change.labels).toEqual(["security", "api"]);
    expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/example/payments-api/pulls/42");
    expect((fetchCalls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  });

  test("normalizes paginated GitHub changed files", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: fixtureFetch(fetchCalls),
    });

    const diff = await adapter.getDiff(changeRef);

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/example/payments-api/pulls/42/files?per_page=100",
      "https://api.github.com/repositories/1/pulls/42/files?per_page=100&page=2",
    ]);
    expect(diff.files.map((file) => file.path)).toEqual([
      "src/auth/accounts.ts",
      "src/billing/invoice.ts",
      "assets/logo.png",
      "package-lock.json",
      "src/large-generated.ts",
    ]);
    expect(diff.files[1]).toMatchObject({
      path: "src/billing/invoice.ts",
      oldPath: "src/billing/invoices.ts",
      status: "renamed",
      additions: 4,
      deletions: 2,
    });
    expect(diff.files[2]).toMatchObject({
      path: "assets/logo.png",
      isBinary: true,
    });
    expect(diff.files[3]).toMatchObject({
      path: "package-lock.json",
      isLockfile: true,
    });
    expect(diff.files[4]?.patch).toBeUndefined();
    expect(diff.truncated).toBe(true);
    expect(diff.truncationReason).toBe("One or more GitHub file patches were omitted by the API.");
    expect(diff.totalAdditions).toBe(1148);
    expect(diff.totalDeletions).toBe(1026);
  });

  test("publishes a summary comment to the pull request issue timeline", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      token: "write-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/repos/example/payments-api/issues/17/comments") {
          return jsonResponse({
            id: 987,
            html_url: "https://github.com/example/payments-api/pull/17#issuecomment-987",
          }, {}, 201);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const review = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    const result = await adapter.publishSummary({
      change: fixture.metadata,
      summary: review.summary,
      hiddenMetadata: {
        runId: review.context.runId,
      },
    });

    const requestBody = JSON.parse(String(calls[0]?.init?.body)) as { body: string };
    expect(calls[0]?.url).toBe("https://api.github.com/repos/example/payments-api/issues/17/comments");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer write-token");
    expect((calls[0]?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(requestBody.body).toContain("Account lookup misses authorization");
    expect(requestBody.body).toContain("<!-- ai-code-review-factory");
    expect(requestBody.body).toContain("fixture-auth-pr");
    expect(result).toEqual({
      provider: "github",
      summaryCommentId: "987",
      summaryUrl: "https://github.com/example/payments-api/pull/17#issuecomment-987",
      postedInlineCount: 0,
      failedInlineCount: 0,
    });
  });

  test("throws a clear error on GitHub API failures", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () => new Response(JSON.stringify({ message: "bad credentials" }), {
        status: 401,
        statusText: "Unauthorized",
      }),
    });

    await expect(adapter.getChange(changeRef)).rejects.toThrow("GitHub API request failed: 401 Unauthorized");
  });
});

function fixtureFetch(calls: Array<{ url: string; init?: RequestInit }>): FetchLike {
  return async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });

    if (url === "https://api.github.com/repos/example/payments-api/pulls/42") {
      return jsonResponse(await readFixture("pull.json"));
    }

    if (url === "https://api.github.com/repos/example/payments-api/pulls/42/files?per_page=100") {
      return jsonResponse(await readFixture("files-page-1.json"), {
        link: '<https://api.github.com/repositories/1/pulls/42/files?per_page=100&page=2>; rel="next", <https://api.github.com/repositories/1/pulls/42/files?per_page=100&page=2>; rel="last"',
      });
    }

    if (url === "https://api.github.com/repositories/1/pulls/42/files?per_page=100&page=2") {
      return jsonResponse(await readFixture("files-page-2.json"));
    }

    return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
      status: 404,
      statusText: "Not Found",
    });
  };
}

async function readFixture(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(`test/fixtures/github/${filename}`, "utf8")) as unknown;
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers,
  });
}
