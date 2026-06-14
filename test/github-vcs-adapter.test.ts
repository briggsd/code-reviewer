import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ChangeMetadata, ChangeRef, FetchLike, Finding } from "../src/index.ts";
import { GitHubVcsAdapter, loadReviewFixture, runReview } from "../src/index.ts";

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

// ChangeMetadata used by readBaseBranchFile tests (includes targetBranch).
const changeMetadata: ChangeMetadata = {
  provider: "github",
  repository: {
    provider: "github",
    owner: "example",
    name: "payments-api",
    slug: "example/payments-api",
  },
  changeId: "42",
  headSha: "headsha123",
  baseSha: "basesha456",
  targetBranch: "main",
  title: "Test PR",
  author: { username: "octo-dev" },
  labels: [],
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
    expect((fetchCalls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
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

        if (url === "https://api.github.com/user") {
          return jsonResponse({ id: 99, login: "ai-review-bot" });
        }

        if (
          url ===
          "https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100"
        ) {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/repos/example/payments-api/issues/17/comments") {
          return jsonResponse(
            {
              id: 987,
              html_url: "https://github.com/example/payments-api/pull/17#issuecomment-987",
            },
            {},
            201,
          );
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

    // No existing summary → a fresh comment is POSTed. Look up by method (the /user + comments-GET
    // calls run concurrently, so positional indexing is non-deterministic).
    const postCall = calls.find(
      (c) => c.url.endsWith("/issues/17/comments") && c.init?.method === "POST",
    );
    const requestBody = JSON.parse(String(postCall?.init?.body)) as { body: string };
    expect(postCall).toBeDefined();
    expect((postCall?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer write-token",
    );
    expect((postCall?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
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

        // Bot identity endpoint (#84)
        if (url === "https://api.github.com/user") {
          return jsonResponse({ id: 99, login: "bot-user" });
        }

        if (
          url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100"
        ) {
          return jsonResponse([]);
        }

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments") {
          return jsonResponse(
            {
              id: 456,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r456",
            },
            {},
            201,
          );
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

    // Use URL/method-based lookup rather than positional index since GET /user is now
    // fetched concurrently with the comments list (Promise.all in findExistingInlineComments).
    const postCall = calls.find(
      (c) =>
        c.url === "https://api.github.com/repos/example/payments-api/pulls/17/comments" &&
        c.init?.method === "POST",
    );
    const requestBody = JSON.parse(String(postCall?.init?.body)) as Record<string, unknown>;
    expect(calls.map((c) => c.url)).toContain(
      "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100",
    );
    expect(postCall?.url).toBe(
      "https://api.github.com/repos/example/payments-api/pulls/17/comments",
    );
    expect(postCall?.init?.method).toBe("POST");
    expect((postCall?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer write-token",
    );
    expect(requestBody).toMatchObject({
      commit_id: "abc123",
      path: "src/auth/accounts.ts",
      line: 27,
      side: "RIGHT",
    });
    expect(String(requestBody.body)).toContain("### AI review: 🚨 Critical · authorization");
    expect(String(requestBody.body)).toContain("**Account lookup misses authorization**");
    expect(String(requestBody.body)).toContain("<summary>Evidence</summary>");
    expect(String(requestBody.body)).toContain(
      "- The handler reads accountId and returns data without an ownership check.",
    );
    expect(String(requestBody.body)).toContain("**Recommendation**");
    expect(String(requestBody.body)).toContain(
      "CI status and the summary comment remain authoritative",
    );
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
      summaryFallbackCount: 0,
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
        if (
          url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100"
        ) {
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
    expect(result.findings[1]?.reason).toContain(
      "GitHub API request failed: 422 Unprocessable Entity",
    );
  });

  test("skips duplicate inline comments for the same finding and head sha", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // Bot identity endpoint — must return the same id as the comment's user.id (#84)
        if (url === "https://api.github.com/user") {
          return jsonResponse({ id: 99, login: "bot-user" });
        }

        if (
          url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100"
        ) {
          return jsonResponse([
            {
              id: 456,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r456",
              // Author id must match the bot id returned by GET /user (#84)
              user: { id: 99, login: "bot-user" },
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

    // Both GET /user and the comments list are fetched; order may vary due to Promise.all.
    expect(calls.map((call) => call.url)).toContain("https://api.github.com/user");
    expect(calls.map((call) => call.url)).toContain(
      "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100",
    );
    expect(result).toEqual({
      provider: "github",
      attemptedInlineCount: 1,
      postedInlineCount: 0,
      skippedInlineCount: 1,
      failedInlineCount: 0,
      summaryFallbackCount: 0,
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

        if (
          url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100"
        ) {
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
          return jsonResponse(
            {
              id: 789,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r789",
            },
            {},
            201,
          );
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

    // GET /user is now fetched alongside the comments list; use contains checks rather than
    // an exact ordered list (#84). The /user call returns 404 here → botId undefined → dedup
    // map is empty (safe-on-failure); the finding is still posted.
    expect(calls.map((call) => call.url)).toContain(
      "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100",
    );
    expect(calls.map((call) => call.url)).toContain(
      "https://api.github.com/repos/example/payments-api/pulls/17/comments",
    );
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

        if (
          url ===
          "https://api.github.com/repos/example/payments-api/issues/42/comments?per_page=100"
        ) {
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
    expect(state?.findings.map((finding) => finding.stableId)).toEqual([
      "fnd_auth_1",
      "fnd_auth_2",
    ]);
    expect(state?.hiddenMetadata?.repository).toBe("example/payments-api");
  });

  test("updates an existing summary comment instead of posting a duplicate", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/user") {
          return jsonResponse({ id: 99, login: "ai-review-bot" });
        }

        if (
          url ===
          "https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100"
        ) {
          return jsonResponse([
            { id: 111, body: "unrelated comment", user: { id: 99, login: "ai-review-bot" } },
            // The existing summary comment must be BOT-authored (id 99) to be recognized.
            {
              id: 222,
              body: "<!-- ai-code-review-factory\n{}\n-->",
              user: { id: 99, login: "ai-review-bot" },
            },
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

    // The bot-authored summary comment is updated in place (PATCH to comment 222), not duplicated.
    const patchCall = calls.find(
      (c) => c.url.endsWith("/issues/comments/222") && c.init?.method === "PATCH",
    );
    const requestBody = JSON.parse(String(patchCall?.init?.body)) as { body: string };
    expect(patchCall).toBeDefined();
    expect(requestBody.body).toContain("<!-- ai-code-review-factory");
    expect(result.summaryCommentId).toBe("222");
  });

  test("ignores a planted non-bot summary marker and posts a fresh comment (#84)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      token: "write-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/user") {
          return jsonResponse({ id: 99, login: "ai-review-bot" });
        }
        if (
          url ===
          "https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100"
        ) {
          // An attacker (user id 42, NOT the bot 99) planted a comment carrying our marker.
          return jsonResponse([
            {
              id: 999,
              body: "<!-- ai-code-review-factory\n{}\n-->",
              user: { id: 42, login: "attacker" },
            },
          ]);
        }
        if (url === "https://api.github.com/repos/example/payments-api/issues/17/comments") {
          return jsonResponse(
            {
              id: 987,
              html_url: "https://github.com/example/payments-api/pull/17#issuecomment-987",
            },
            {},
            201,
          );
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

    // The planted comment must NOT be edited (no PATCH to comments/999); a fresh comment is POSTed.
    expect(calls.some((c) => c.url.endsWith("/issues/comments/999"))).toBe(false);
    expect(
      calls.some((c) => c.url.endsWith("/issues/17/comments") && c.init?.method === "POST"),
    ).toBe(true);
    expect(result.summaryCommentId).toBe("987");
  });

  test("GET /user 403 (Actions installation token) → existing github-actions[bot] summary is updated in place", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      token: "installation-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // GITHUB_TOKEN cannot call GET /user — the adapter must fall back to the
        // well-known github-actions[bot] id instead of posting a duplicate.
        if (url === "https://api.github.com/user") {
          return jsonResponse({ message: "Resource not accessible by integration" }, {}, 403);
        }
        if (
          url ===
          "https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100"
        ) {
          return jsonResponse([
            {
              id: 222,
              body: "<!-- ai-code-review-factory\n{}\n-->",
              user: { id: 41898282, login: "github-actions[bot]" },
            },
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

    const patchCall = calls.find(
      (c) => c.url.endsWith("/issues/comments/222") && c.init?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    expect(
      calls.some((c) => c.url.endsWith("/issues/17/comments") && c.init?.method === "POST"),
    ).toBe(false);
    expect(result.summaryCommentId).toBe("222");
  });

  test("GET /user 403 + planted non-Actions marker → fresh comment is POSTed (#84 defense preserved)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      token: "installation-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://api.github.com/user") {
          return jsonResponse({ message: "Resource not accessible by integration" }, {}, 403);
        }
        if (
          url ===
          "https://api.github.com/repos/example/payments-api/issues/17/comments?per_page=100"
        ) {
          // Attacker-authored marker comment: the actions-bot fallback id must NOT match user id 42.
          return jsonResponse([
            {
              id: 999,
              body: "<!-- ai-code-review-factory\n{}\n-->",
              user: { id: 42, login: "attacker" },
            },
          ]);
        }
        if (url === "https://api.github.com/repos/example/payments-api/issues/17/comments") {
          return jsonResponse(
            {
              id: 987,
              html_url: "https://github.com/example/payments-api/pull/17#issuecomment-987",
            },
            {},
            201,
          );
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

    expect(calls.some((c) => c.url.endsWith("/issues/comments/999"))).toBe(false);
    expect(
      calls.some((c) => c.url.endsWith("/issues/17/comments") && c.init?.method === "POST"),
    ).toBe(true);
    expect(result.summaryCommentId).toBe("987");
  });

  test("throws a clear error on GitHub API failures", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "bad credentials" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
    });

    await expect(adapter.getChange(changeRef)).rejects.toThrow(
      "GitHub API request failed: 401 Unauthorized",
    );
  });

  test("readBaseBranchFile returns decoded UTF-8 content from base64 contents API response", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fileContent = '{"conventions":["no direct db access in controllers"]}';
    const base64Content = Buffer.from(fileContent).toString("base64");
    const adapter = new GitHubVcsAdapter({
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        fetchCalls.push({ url, ...(init !== undefined ? { init } : {}) });
        return jsonResponse({ content: base64Content, encoding: "base64", type: "file" });
      },
    });

    const result = await adapter.readBaseBranchFile(changeMetadata, ".ai-review.json");

    expect(result).toBe(fileContent);
    // URL must include ?ref=main (the base branch), not the head sha
    const contentsUrl = fetchCalls[0]?.url ?? "";
    expect(contentsUrl).toContain("?ref=main");
    expect(contentsUrl).toContain("/contents/.ai-review.json");
    expect(contentsUrl).not.toContain(changeMetadata.headSha);
    // Authorization header must be set
    expect((fetchCalls[0]?.init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-token",
    );
  });

  test("readBaseBranchFile returns undefined on a 404 (file absent on base branch)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          statusText: "Not Found",
        }),
    });

    const result = await adapter.readBaseBranchFile(changeMetadata, ".ai-review.json");

    expect(result).toBeUndefined();
  });

  test("readBaseBranchFile returns undefined (does not throw) on a non-404 error — best-effort read", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () =>
        new Response("upstream boom", { status: 500, statusText: "Internal Server Error" }),
    });

    // A transient/auth error must degrade to "no base conventions", never fail the review.
    const result = await adapter.readBaseBranchFile(changeMetadata, ".ai-review.json");

    expect(result).toBeUndefined();
  });

  test("readBaseBranchFile uses targetBranch as the ref query param", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        fetchCalls.push({ url, ...(init !== undefined ? { init } : {}) });
        return jsonResponse({ content: Buffer.from("{}").toString("base64"), encoding: "base64" });
      },
    });
    const metaWithSlashBranch = { ...changeMetadata, targetBranch: "release/v2" };

    await adapter.readBaseBranchFile(metaWithSlashBranch, ".ai-review.json");

    const url = fetchCalls[0]?.url ?? "";
    expect(url).toContain("?ref=release%2Fv2");
  });

  // --- Author-trust / dedup security tests (#84) ---

  test("planted marker from a non-bot author does NOT suppress the finding (finding is posted)", async () => {
    // A comment with valid dedup metadata but authored by a different user (id 42) must not
    // suppress the finding even though the metadata matches — only bot-authored markers count.
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // Bot user id is 99; the existing comment was authored by user 42 (not the bot).
        if (url === "https://api.github.com/user") {
          return jsonResponse({ id: 99, login: "bot-user" });
        }

        if (
          url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100"
        ) {
          return jsonResponse([
            {
              id: 456,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r456",
              user: { id: 42, login: "attacker" },
              body: [
                "### AI review: planted",
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

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments") {
          return jsonResponse(
            {
              id: 789,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r789",
            },
            {},
            201,
          );
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
          location: { path: "src/auth/accounts.ts", line: 27, side: "RIGHT" },
          confidence: "high",
          evidence: ["The handler reads accountId and returns data without an ownership check."],
          recommendation: "Verify account ownership before returning account data.",
        },
      ],
    });

    // Finding must be posted despite the planted marker — the planted author (42) ≠ bot (99).
    expect(result.postedInlineCount).toBe(1);
    expect(result.skippedInlineCount).toBe(0);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_auth_missing_owner_check",
      disposition: "posted",
      providerCommentId: "789",
    });
    // The POST must have been issued.
    const postCalls = calls.filter((c) => c.init?.method === "POST");
    expect(postCalls).toHaveLength(1);
  });

  test("bot-authored duplicate is still skipped (no regression on existing dedup)", async () => {
    // Existing comment has the same findingId+headSha AND is authored by the bot (id 99) —
    // the finding must still be suppressed to avoid duplicate inline comments.
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);

        if (url === "https://api.github.com/user") {
          return jsonResponse({ id: 99, login: "bot-user" });
        }

        if (
          url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100"
        ) {
          return jsonResponse([
            {
              id: 456,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r456",
              user: { id: 99, login: "bot-user" },
              body: [
                "### AI review: existing bot comment",
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
          location: { path: "src/auth/accounts.ts", line: 27, side: "RIGHT" },
          confidence: "high",
          evidence: ["The handler reads accountId and returns data without an ownership check."],
          recommendation: "Verify account ownership before returning account data.",
        },
      ],
    });

    expect(result.postedInlineCount).toBe(0);
    expect(result.skippedInlineCount).toBe(1);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_auth_missing_owner_check",
      disposition: "skipped",
      reason: "duplicate_inline_comment",
      providerCommentId: "456",
    });
  });

  // ---------------------------------------------------------------------------
  // getChangedPathsSince tests
  // ---------------------------------------------------------------------------

  test("getChangedPathsSince: a non-SHA-shaped sinceSha is rejected without an API call", async () => {
    let called = false;
    const adapter = new GitHubVcsAdapter({
      fetch: async () => {
        called = true;
        return jsonResponse({ status: "ahead", files: [], total_commits: 0 });
      },
    });
    // "oldsha" contains non-hex chars → rejected by the SHA-shape guard (untrusted input).
    const result = await adapter.getChangedPathsSince(changeRef, "oldsha");
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  test("getChangedPathsSince: status 'ahead' with 2 files → isAncestor true, changedPaths populated", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (
          url ===
          "https://api.github.com/repos/example/payments-api/compare/0123456789abcdef0123456789abcdef01234567...headsha123"
        ) {
          return jsonResponse({
            status: "ahead",
            files: [{ filename: "src/auth/accounts.ts" }, { filename: "src/billing/invoice.ts" }],
            total_commits: 2,
          });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result).toBeDefined();
    expect(result?.isAncestor).toBe(true);
    expect(result?.changedPaths).toEqual(["src/auth/accounts.ts", "src/billing/invoice.ts"]);
  });

  test("getChangedPathsSince: status 'identical' → isAncestor true, empty changedPaths", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/compare/")) {
          return jsonResponse({ status: "identical", files: [], total_commits: 0 });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result?.isAncestor).toBe(true);
    expect(result?.changedPaths).toEqual([]);
  });

  test("getChangedPathsSince: status 'diverged' → isAncestor false (force-push/rebase)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/compare/")) {
          return jsonResponse({
            status: "diverged",
            files: [{ filename: "src/auth/accounts.ts" }],
            total_commits: 1,
          });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result?.isAncestor).toBe(false);
    // Not an ancestor → changedPaths is emptied (the delta is meaningless on a force-push/rebase).
    expect(result?.changedPaths).toEqual([]);
  });

  test("getChangedPathsSince: 'behind' status → isAncestor false", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/compare/")) {
          return jsonResponse({ status: "behind", files: [], total_commits: 0 });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result?.isAncestor).toBe(false);
    expect(result?.changedPaths).toEqual([]);
  });

  test("getChangedPathsSince: fetch throws → returns undefined (best-effort, never throws)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () => {
        throw new Error("network error");
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result).toBeUndefined();
  });

  test("getChangedPathsSince: non-2xx response → returns undefined", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          statusText: "Not Found",
        }),
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result).toBeUndefined();
  });

  test("getChangedPathsSince: 300 files → returns undefined (truncation safety)", async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `src/file${i}.ts` }));
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/compare/")) {
          return jsonResponse({ status: "ahead", files, total_commits: 50 });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    // 300 files at the cap → truncation risk → must return undefined
    expect(result).toBeUndefined();
  });

  test("getChangedPathsSince: 299 files → returns them (not truncated)", async () => {
    const files = Array.from({ length: 299 }, (_, i) => ({ filename: `src/file${i}.ts` }));
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/compare/")) {
          return jsonResponse({ status: "ahead", files, total_commits: 10 });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result).toBeDefined();
    expect(result?.changedPaths).toHaveLength(299);
    expect(result?.isAncestor).toBe(true);
  });

  test("getChangedPathsSince: missing files field → empty changedPaths", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/compare/")) {
          // files field absent from response
          return jsonResponse({ status: "ahead", total_commits: 0 });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(
      changeRef,
      "0123456789abcdef0123456789abcdef01234567",
    );

    expect(result?.isAncestor).toBe(true);
    expect(result?.changedPaths).toEqual([]);
  });

  test("bot-identity resolution failure → no suppression (safe-on-failure)", async () => {
    // GET /user returns non-2xx → botId = undefined → dedup map is empty → finding is posted
    // even if an existing comment has matching metadata. This is the safe direction: a duplicate
    // comment is always preferable to silently suppressing a real finding (#84).
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitHubVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // Simulate a 401 on GET /user — identity cannot be resolved.
        if (url === "https://api.github.com/user") {
          return new Response(JSON.stringify({ message: "Bad credentials" }), {
            status: 401,
            statusText: "Unauthorized",
          });
        }

        if (
          url === "https://api.github.com/repos/example/payments-api/pulls/17/comments?per_page=100"
        ) {
          return jsonResponse([
            {
              id: 456,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r456",
              user: { id: 99, login: "bot-user" },
              body: [
                "### AI review: would-be duplicate",
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

        if (url === "https://api.github.com/repos/example/payments-api/pulls/17/comments") {
          return jsonResponse(
            {
              id: 789,
              html_url: "https://github.com/example/payments-api/pull/17#discussion_r789",
            },
            {},
            201,
          );
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
          location: { path: "src/auth/accounts.ts", line: 27, side: "RIGHT" },
          confidence: "high",
          evidence: ["The handler reads accountId and returns data without an ownership check."],
          recommendation: "Verify account ownership before returning account data.",
        },
      ],
    });

    // Identity unknown → dedup map empty → finding posted (not suppressed).
    expect(result.postedInlineCount).toBe(1);
    expect(result.skippedInlineCount).toBe(0);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_auth_missing_owner_check",
      disposition: "posted",
    });
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

function jsonResponse(
  value: unknown,
  headers: Record<string, string> = {},
  status = 200,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers,
  });
}
