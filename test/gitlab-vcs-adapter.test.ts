import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { GitLabVcsAdapter, loadReviewFixture, runReview } from "../src/index.ts";
import type { ChangeMetadata, ChangeRef, GitLabFetchLike } from "../src/index.ts";

const changeRef: ChangeRef = {
  provider: "gitlab",
  repository: {
    provider: "gitlab",
    owner: "example",
    name: "payments-api",
    slug: "example/payments-api",
    webUrl: "https://gitlab.com/example/payments-api",
    defaultBranch: "main",
  },
  changeId: "7",
  headSha: "headsha123",
};

// ChangeMetadata used by readBaseBranchFile tests (includes targetBranch).
const changeMetadata: ChangeMetadata = {
  provider: "gitlab",
  repository: {
    provider: "gitlab",
    owner: "example",
    name: "payments-api",
    slug: "example/payments-api",
    webUrl: "https://gitlab.com/example/payments-api",
    defaultBranch: "main",
  },
  changeId: "7",
  headSha: "headsha123",
  baseSha: "basesha456",
  targetBranch: "main",
  sourceBranch: "feature/account-lookup",
  title: "Harden account lookup",
  author: { username: "gitlab-dev" },
  labels: [],
};

describe("GitLabVcsAdapter", () => {
  test("normalizes GitLab merge request metadata", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitLabVcsAdapter({
      token: "test-token",
      fetch: fixtureFetch(fetchCalls),
    });

    const change = await adapter.getChange(changeRef);

    expect(change.provider).toBe("gitlab");
    expect(change.repository.slug).toBe("example/payments-api");
    expect(change.repository.webUrl).toBe("https://gitlab.com/example/payments-api");
    expect(change.changeId).toBe("7");
    expect(change.headSha).toBe("headsha123");
    expect(change.baseSha).toBe("basesha456");
    expect(change.sourceBranch).toBe("feature/account-lookup");
    expect(change.targetBranch).toBe("main");
    expect(change.title).toBe("Harden account lookup");
    expect(change.description).toBe("Adds account lookup with stricter auth checks.");
    expect(change.author).toEqual({
      id: "123",
      username: "gitlab-dev",
      displayName: "GitLab Dev",
      webUrl: "https://gitlab.com/gitlab-dev",
    });
    expect(change.labels).toEqual(["security", "api"]);
    expect(fetchCalls[0]?.url).toBe("https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7");
    expect((fetchCalls[0]?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("test-token");
  });

  test("normalizes GitLab merge request changes", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitLabVcsAdapter({
      fetch: fixtureFetch(fetchCalls),
    });

    const diff = await adapter.getDiff(changeRef);

    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/changes",
    ]);
    expect(diff.files.map((file) => file.path)).toEqual([
      "src/auth/accounts.ts",
      "src/billing/invoice.ts",
      "assets/logo.png",
      "package-lock.json",
      "src/generated/client.ts",
      "src/removed.ts",
    ]);
    expect(diff.files[0]).toMatchObject({
      status: "modified",
      additions: 2,
      deletions: 1,
      isBinary: false,
    });
    expect(diff.files[1]).toMatchObject({
      path: "src/billing/invoice.ts",
      oldPath: "src/billing/invoices.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
    });
    expect(diff.files[2]).toMatchObject({
      path: "assets/logo.png",
      isBinary: true,
    });
    expect(diff.files[3]).toMatchObject({
      path: "package-lock.json",
      isLockfile: true,
    });
    expect(diff.files[4]).toMatchObject({
      path: "src/generated/client.ts",
      isGenerated: true,
    });
    expect(diff.files[5]).toMatchObject({
      status: "deleted",
      additions: 0,
      deletions: 2,
    });
    expect(diff.truncated).toBe(true);
    expect(diff.truncationReason).toBe("One or more GitLab merge request diffs were omitted or marked overflow/collapsed.");
    expect(diff.totalAdditions).toBe(4);
    expect(diff.totalDeletions).toBe(5);
  });

  test("publishes a summary note to the merge request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitLabVcsAdapter({
      token: "write-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes" && init?.method === undefined) {
          return jsonResponse([]);
        }

        if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes") {
          return jsonResponse({
            id: 654,
            web_url: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_654",
          }, 201);
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
      change: {
        ...fixture.metadata,
        provider: "gitlab",
        repository: changeRef.repository,
        changeId: "7",
      },
      summary: review.summary,
      hiddenMetadata: {
        runId: review.context.runId,
      },
    });

    const requestBody = JSON.parse(String(calls[1]?.init?.body)) as { body: string };
    expect(calls[0]?.url).toBe("https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes");
    expect(calls[1]?.url).toBe("https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes");
    expect(calls[1]?.init?.method).toBe("POST");
    expect((calls[1]?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("write-token");
    expect((calls[1]?.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(requestBody.body).toContain("Account lookup misses authorization");
    expect(requestBody.body).toContain("<!-- ai-code-review-factory");
    expect(requestBody.body).toContain("fixture-auth-pr");
    expect(result).toEqual({
      provider: "gitlab",
      summaryCommentId: "654",
      summaryUrl: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_654",
      postedInlineCount: 0,
      failedInlineCount: 0,
    });
  });

  test("loads prior review state from existing summary note metadata", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);

        if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes") {
          return jsonResponse([
            { id: 111, body: "unrelated note" },
            {
              id: 222,
              body: [
                "<!-- ai-code-review-factory",
                JSON.stringify({
                  schemaVersion: 1,
                  runId: "prior-run",
                  headSha: "old-head",
                  provider: "gitlab",
                  repository: "example/payments-api",
                  changeId: "7",
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

  test("updates an existing summary note instead of posting a duplicate", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes" && init?.method === undefined) {
          return jsonResponse([
            { id: 111, body: "unrelated note" },
            { id: 222, body: "<!-- ai-code-review-factory\n{}\n-->" },
          ]);
        }

        if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes/222") {
          return jsonResponse({
            id: 222,
            web_url: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_222",
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
      change: {
        ...fixture.metadata,
        provider: "gitlab",
        repository: changeRef.repository,
        changeId: "7",
      },
      summary: review.summary,
    });

    const requestBody = JSON.parse(String(calls[1]?.init?.body)) as { body: string };
    expect(calls[1]?.url).toBe("https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes/222");
    expect(calls[1]?.init?.method).toBe("PUT");
    expect(requestBody.body).toContain("<!-- ai-code-review-factory");
    expect(result.summaryCommentId).toBe("222");
  });

  test("throws a clear error on GitLab API failures", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () => new Response(JSON.stringify({ message: "401 Unauthorized" }), {
        status: 401,
        statusText: "Unauthorized",
      }),
    });

    await expect(adapter.getChange(changeRef)).rejects.toThrow("GitLab API request failed: 401 Unauthorized");
  });

  test("readBaseBranchFile returns decoded UTF-8 content from base64 repository-files API response", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fileContent = '{"conventions":["no direct db access in controllers"]}';
    const base64Content = Buffer.from(fileContent).toString("base64");
    const adapter = new GitLabVcsAdapter({
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        fetchCalls.push({ url, ...(init !== undefined ? { init } : {}) });
        return jsonResponse({ content: base64Content, encoding: "base64" });
      },
    });

    const result = await adapter.readBaseBranchFile(changeMetadata, ".ai-review.json");

    expect(result).toBe(fileContent);
    // URL must use GitLab repository-files path and encode the ref — not the head sha
    const filesUrl = fetchCalls[0]?.url ?? "";
    expect(filesUrl).toContain("/repository/files/");
    expect(filesUrl).toContain("?ref=main");
    expect(filesUrl).not.toContain(changeMetadata.headSha);
    // PRIVATE-TOKEN auth header must be set
    expect((fetchCalls[0]?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("test-token");
  });

  test("readBaseBranchFile returns undefined on a 404 (file absent on base branch)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () => new Response(JSON.stringify({ message: "404 File Not Found" }), {
        status: 404,
        statusText: "Not Found",
      }),
    });

    const result = await adapter.readBaseBranchFile(changeMetadata, ".ai-review.json");

    expect(result).toBeUndefined();
  });

  test("readBaseBranchFile returns undefined (does not throw) on a non-404 error — best-effort read", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () => new Response("upstream boom", { status: 500, statusText: "Internal Server Error" }),
    });

    // A transient/auth error must degrade to "no base conventions", never fail the review.
    const result = await adapter.readBaseBranchFile(changeMetadata, ".ai-review.json");

    expect(result).toBeUndefined();
  });

  test("readBaseBranchFile uses targetBranch as the ref query param, URL-encoded", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        fetchCalls.push({ url, ...(init !== undefined ? { init } : {}) });
        return jsonResponse({ content: Buffer.from("{}").toString("base64"), encoding: "base64" });
      },
    });
    const metaWithSlashBranch = { ...changeMetadata, targetBranch: "release/v2" };

    await adapter.readBaseBranchFile(metaWithSlashBranch, ".ai-review.json");

    // Slashes in branch names must be percent-encoded in the ref param
    const url = fetchCalls[0]?.url ?? "";
    expect(url).toContain("?ref=release%2Fv2");
  });
});

function fixtureFetch(calls: Array<{ url: string; init?: RequestInit }>): GitLabFetchLike {
  return async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });

    if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7") {
      return jsonResponse(await readFixture("merge-request.json"));
    }

    if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/changes") {
      return jsonResponse(await readFixture("changes.json"));
    }

    return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
      status: 404,
      statusText: "Not Found",
    });
  };
}

async function readFixture(filename: string): Promise<unknown> {
  return JSON.parse(await readFile(`test/fixtures/gitlab/${filename}`, "utf8")) as unknown;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
  });
}
