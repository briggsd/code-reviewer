import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { GitHubVcsAdapter, loadReviewFixture, runReview } from "../src/index.ts";
import type { ChangeRef, FetchLike, Finding } from "../src/index.ts";

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

        if (url === "https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100") {
          return jsonResponse([]);
        }

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

    const requestBody = JSON.parse(String(calls[1]?.init?.body)) as { body: string };
    expect(calls[0]?.url).toBe("https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100");
    expect(calls[1]?.url).toBe("https://api.github.com/repos/example/payments-api/issues/17/comments");
    expect(calls[1]?.init?.method).toBe("POST");
    expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer write-token");
    expect((calls[1]?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
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

  test("publishes inline review comments using GitHub pull request coordinates", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      token: "write-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100") {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments") {
          return jsonResponse({
            id: 456,
            html_url: "https://github.com/example/payments-api/pull/17#discussion_r456",
          }, {}, 201);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const finding = {
      id: "fnd_auth_missing_owner_check",
      reviewer: "security",
      severity: "critical",
      category: "authorization",
      title: "Account lookup misses authorization",
      body: "The changed account lookup returns records without verifying ownership.",
      location: {
        path: "src/auth/accounts.ts",
        line: 27,
        side: "RIGHT" as const,
      },
      confidence: "high" as const,
      evidence: ["The handler reads accountId and returns data without an ownership check."],
      recommendation: "Verify account ownership before returning account data.",
    } satisfies Finding;

    const result = await adapter.publishInlineFindings({
      change: fixture.metadata,
      findings: [finding],
      runId: "run-inline-polish",
    });

    const requestBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(calls[0]?.url).toBe("https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100");
    expect(calls[1]?.url).toBe("https://api.github.com/repos/example/payments-api/pulls/17/comments");
    expect(calls[1]?.init?.method).toBe("POST");
    expect((calls[1]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer write-token");
    expect(requestBody).toMatchObject({
      commit_id: "abc123",
      path: "src/auth/accounts.ts",
      line: 27,
      side: "RIGHT",
    });
    expect(String(requestBody.body)).toContain("### AI review: 🚨 Critical · authorization");
    expect(String(requestBody.body)).toContain("**Account lookup misses authorization**");
    expect(String(requestBody.body)).toContain("<summary>Evidence</summary>");
    expect(String(requestBody.body)).toContain("- The handler reads accountId and returns data without an ownership check.");
    expect(String(requestBody.body)).toContain("**Recommendation**");
    expect(String(requestBody.body)).toContain("CI status and the summary comment remain authoritative");
    expect(String(requestBody.body)).toContain("<!-- ai-code-review-factory-inline");
    expect(String(requestBody.body)).toContain("fnd_auth_missing_owner_check");
    expect(String(requestBody.body)).toContain("abc123");
    expect(String(requestBody.body)).toContain("example/payments-api");
    expect(String(requestBody.body)).toContain("run-inline-polish");
    expect(result).toEqual({
      provider: "github",
      attemptedInlineCount: 1,
      postedInlineCount: 1,
      skippedInlineCount: 0,
      failedInlineCount: 0,
      findings: [
        {
          findingId: "fnd_auth_missing_owner_check",
          disposition: "posted",
          providerCommentId: "456",
          url: "https://github.com/example/payments-api/pull/17#discussion_r456",
        },
      ],
    });
  });

  test("records skipped and failed inline review comment outcomes", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100") {
          return jsonResponse([]);
        }

        return new Response(JSON.stringify({ message: "validation failed" }), {
          status: 422,
          statusText: "Unprocessable Entity",
        });
      },
    });
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const result = await adapter.publishInlineFindings({
      change: fixture.metadata,
      findings: [
        {
          id: "missing-coordinates",
          reviewer: "security",
          severity: "warning",
          category: "test",
          title: "Missing coordinates",
          body: "No line coordinate was provided.",
          confidence: "medium",
          evidence: [],
          recommendation: "Add a line coordinate.",
        },
        {
          id: "provider-failure",
          reviewer: "security",
          severity: "warning",
          category: "test",
          title: "Provider failure",
          body: "GitHub rejects this comment.",
          location: {
            path: "src/auth/accounts.ts",
            line: 27,
            side: "RIGHT",
          },
          confidence: "medium",
          evidence: [],
          recommendation: "Handle provider failures.",
        },
      ],
    });

    expect(result.postedInlineCount).toBe(0);
    expect(result.skippedInlineCount).toBe(1);
    expect(result.failedInlineCount).toBe(1);
    expect(result.findings.map((finding) => finding.disposition)).toEqual(["skipped", "failed"]);
    expect(result.findings[1]?.reason).toContain("GitHub API request failed: 422 Unprocessable Entity");
  });

  test("skips duplicate inline comments for the same finding and head sha", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100") {
          return jsonResponse([
            {
              id: 456,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r456",
              body: [
                "### AI review: Account lookup misses authorization",
                "",
                "<!-- ai-code-review-factory-inline",
                JSON.stringify({
                  schemaVersion: 1,
                  findingId: "fnd_auth_missing_owner_check",
                  headSha: "abc123",
                }),
                "-->",
              ].join("\n"),
            },
          ]);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const result = await adapter.publishInlineFindings({
      change: fixture.metadata,
      findings: [
        {
          id: "fnd_auth_missing_owner_check",
          reviewer: "security",
          severity: "critical",
          category: "authorization",
          title: "Account lookup misses authorization",
          body: "The changed account lookup returns records without verifying ownership.",
          location: {
            path: "src/auth/accounts.ts",
            line: 27,
            side: "RIGHT",
          },
          confidence: "high",
          evidence: ["The handler reads accountId and returns data without an ownership check."],
          recommendation: "Verify account ownership before returning account data.",
        },
      ],
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100",
    ]);
    expect(result).toEqual({
      provider: "github",
      attemptedInlineCount: 1,
      postedInlineCount: 0,
      skippedInlineCount: 1,
      failedInlineCount: 0,
      findings: [
        {
          findingId: "fnd_auth_missing_owner_check",
          disposition: "skipped",
          reason: "duplicate_inline_comment",
          providerCommentId: "456",
          url: "https://github.com/example/payments-api/pull/17#discussion_r456",
        },
      ],
    });
  });

  test("ignores malformed inline metadata and still publishes new comments", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100") {
          return jsonResponse([
            {
              id: 111,
              body: "<!-- ai-code-review-factory-inline\nnot-json\n-->",
            },
            {
              id: 222,
              body: [
                "<!-- ai-code-review-factory-inline",
                JSON.stringify({ schemaVersion: 1, findingId: "same-finding-without-head" }),
                "-->",
              ].join("\n"),
            },
          ]);
        }

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments") {
          return jsonResponse({
            id: 789,
            html_url: "https://github.com/example/payments-api/pull/17#discussion_r789",
          }, {}, 201);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const result = await adapter.publishInlineFindings({
      change: fixture.metadata,
      findings: [
        {
          id: "same-finding-without-head",
          reviewer: "security",
          severity: "warning",
          category: "metadata",
          title: "Malformed metadata should not block publishing",
          body: "Older or malformed inline metadata is ignored for duplicate suppression.",
          location: {
            path: "src/auth/accounts.ts",
            line: 27,
            side: "RIGHT",
          },
          confidence: "medium",
          evidence: [],
          recommendation: "Publish the new comment with complete metadata.",
        },
      ],
    });

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100",
      "https://api.github.com/repos/example/payments-api/pulls/17/comments",
    ]);
    expect(result.postedInlineCount).toBe(1);
    expect(result.skippedInlineCount).toBe(0);
    expect(result.findings[0]).toMatchObject({
      findingId: "same-finding-without-head",
      disposition: "posted",
      providerCommentId: "789",
    });
  });

  test("loads prior review state from existing summary comment metadata", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);

        if (url === "https://api.github.com/repos/example/payments-api/issues/42/comments?per_page=100") {
          return jsonResponse([
            { id: 111, body: "unrelated comment" },
            {
              id: 222,
              body: [
                "<!-- ai-code-review-factory",
                JSON.stringify({
                  schemaVersion: 1,
                  runId: "prior-run",
                  headSha: "old-head",
                  provider: "github",
                  repository: "example/payments-api",
                  changeId: "42",
                  findingIds: ["fnd_auth_1", "fnd_auth_2"],
                }),
                "-->",
              ].join("\n"),
            },
          ]);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const state = await adapter.getPriorReviewState(changeRef);

    expect(state?.previousRunId).toBe("prior-run");
    expect(state?.previousHeadSha).toBe("old-head");
    expect(state?.findings.map((finding) => finding.stableId)).toEqual(["fnd_auth_1", "fnd_auth_2"]);
    expect(state?.hiddenMetadata?.repository).toBe("example/payments-api");
  });

  test("updates an existing summary comment instead of posting a duplicate", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100") {
          return jsonResponse([
            { id: 111, body: "unrelated comment" },
            { id: 222, body: "<!-- ai-code-review-factory\n{}\n-->" },
          ]);
        }

        if (url === "https://api.github.com/repos/example/payments-api/issues/comments/222") {
          return jsonResponse({
            id: 222,
            html_url: "https://github.com/example/payments-api/pull/17#issuecomment-222",
          });
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
    });

    const requestBody = JSON.parse(String(calls[1]?.init?.body)) as { body: string };
    expect(calls[1]?.url).toBe("https://api.github.com/repos/example/payments-api/issues/comments/222");
    expect(calls[1]?.init?.method).toBe("PATCH");
    expect(requestBody.body).toContain("<!-- ai-code-review-factory");
    expect(result.summaryCommentId).toBe("222");
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
