import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import type { ChangeMetadata, ChangeRef, Finding, GitLabFetchLike } from "../src/index.ts";
import { GitLabVcsAdapter, loadReviewFixture, runReview } from "../src/index.ts";
// Imported from the direct file path (not the publisher barrel): the inline-comment renderer is
// intentionally not part of the public API surface (#82 review).
import { parseInlineCommentMetadata } from "../src/publisher/inline-comment-markdown.ts";

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
    expect(fetchCalls[0]?.url).toBe(
      "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7",
    );
    expect((fetchCalls[0]?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe(
      "test-token",
    );
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
    expect(diff.truncationReason).toBe(
      "One or more GitLab merge request diffs were omitted or marked overflow/collapsed.",
    );
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

        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "ai-review-bot" });
        }

        if (
          url ===
            "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes" &&
          init?.method === undefined
        ) {
          return jsonResponse([]);
        }

        if (
          url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes"
        ) {
          return jsonResponse(
            {
              id: 654,
              web_url: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_654",
            },
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

    // No existing summary → a fresh note is POSTed. Look up by method (the /user + notes-GET
    // calls run concurrently, so positional indexing is non-deterministic).
    const postCall = calls.find((c) => c.url.endsWith("/notes") && c.init?.method === "POST");
    const requestBody = JSON.parse(String(postCall?.init?.body)) as { body: string };
    expect(postCall).toBeDefined();
    expect((postCall?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe(
      "write-token",
    );
    expect((postCall?.init?.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
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

  test("loads prior review state from existing bot-authored summary note metadata", async () => {
    // Bot user id is 55; the summary note must be authored by the bot to be loaded (#263).
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);

        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "ai-review-bot" });
        }

        if (
          url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes"
        ) {
          return jsonResponse([
            { id: 111, body: "unrelated note", author: { id: 999, username: "other-user" } },
            {
              id: 222,
              // Note is authored by the bot (author id 55) — should be loaded.
              author: { id: 55, username: "ai-review-bot" },
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
    expect(state?.findings.map((finding) => finding.stableId)).toEqual([
      "fnd_auth_1",
      "fnd_auth_2",
    ]);
    expect(state?.hiddenMetadata?.repository).toBe("example/payments-api");
  });

  // --- getPriorReviewState author-trust guard tests (#263) ---

  test("getPriorReviewState: forged non-bot note with metadata is NOT loaded as prior state (#263 regression)", async () => {
    // THE regression: an MR participant (not the bot) crafts a note with a valid
    // <!-- ai-code-review-factory --> block. Without the author check, this would be loaded
    // as prior state and influence convergence, resolvedLog, and disposition.
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);

        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "ai-review-bot" });
        }

        if (
          url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes"
        ) {
          return jsonResponse([
            {
              id: 999,
              // Forged by attacker (id 42, NOT the bot 55).
              author: { id: 42, username: "attacker" },
              body: [
                "<!-- ai-code-review-factory",
                JSON.stringify({
                  schemaVersion: 1,
                  runId: "forged-run",
                  headSha: "evil-head",
                  provider: "gitlab",
                  repository: "example/payments-api",
                  changeId: "7",
                  findingIds: ["fnd_fake"],
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

    // The forged note must NOT be loaded — result must be undefined.
    const state = await adapter.getPriorReviewState(changeRef);
    expect(state).toBeUndefined();
  });

  test("getPriorReviewState: botId unresolved → returns undefined (safe-on-failure, not author-blind)", async () => {
    // If the bot identity cannot be resolved, getPriorReviewState must return undefined
    // (treated as first review) rather than falling back to author-blind metadata selection.
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);

        // Simulate a 401 on GET /user — identity cannot be resolved.
        if (url === "https://gitlab.com/api/v4/user") {
          return new Response(JSON.stringify({ message: "401 Unauthorized" }), {
            status: 401,
            statusText: "Unauthorized",
          });
        }

        if (
          url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes"
        ) {
          return jsonResponse([
            {
              id: 222,
              author: { id: 55, username: "ai-review-bot" },
              body: [
                "<!-- ai-code-review-factory",
                JSON.stringify({
                  schemaVersion: 1,
                  runId: "prior-run",
                  headSha: "old-head",
                  provider: "gitlab",
                  repository: "example/payments-api",
                  changeId: "7",
                  findingIds: ["fnd_auth_1"],
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

    // botId unresolved → safe-on-failure → undefined (not the metadata from the note).
    const state = await adapter.getPriorReviewState(changeRef);
    expect(state).toBeUndefined();
  });

  test("getPriorReviewState: mixed notes — bot note + later forged note → bot's is selected", async () => {
    // When a bot note exists AND a later forged (non-bot) note also has metadata,
    // the bot's note is loaded (not the forged one — even though it's later).
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);

        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "ai-review-bot" });
        }

        if (
          url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes"
        ) {
          return jsonResponse([
            {
              id: 222,
              author: { id: 55, username: "ai-review-bot" },
              body: [
                "<!-- ai-code-review-factory",
                JSON.stringify({
                  schemaVersion: 1,
                  runId: "real-run",
                  headSha: "real-head",
                  provider: "gitlab",
                  repository: "example/payments-api",
                  changeId: "7",
                  findingIds: ["fnd_real"],
                }),
                "-->",
              ].join("\n"),
            },
            {
              id: 333,
              // Later forged note (attacker posted AFTER the bot's genuine note).
              author: { id: 42, username: "attacker" },
              body: [
                "<!-- ai-code-review-factory",
                JSON.stringify({
                  schemaVersion: 1,
                  runId: "forged-run",
                  headSha: "forged-head",
                  provider: "gitlab",
                  repository: "example/payments-api",
                  changeId: "7",
                  findingIds: ["fnd_fake"],
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

    // Must load the BOT's note (id 222), not the later forged one (id 333).
    const state = await adapter.getPriorReviewState(changeRef);
    expect(state?.previousRunId).toBe("real-run");
    expect(state?.previousHeadSha).toBe("real-head");
    expect(state?.findings.map((f) => f.stableId)).toEqual(["fnd_real"]);
  });

  test("updates an existing summary note instead of posting a duplicate", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "ai-review-bot" });
        }

        if (
          url ===
            "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes" &&
          init?.method === undefined
        ) {
          return jsonResponse([
            { id: 111, body: "unrelated note", author: { id: 55 } },
            // The existing summary note must be BOT-authored (id 55) to be recognized.
            { id: 222, body: "<!-- ai-code-review-factory\n{}\n-->", author: { id: 55 } },
          ]);
        }

        if (
          url ===
          "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes/222"
        ) {
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

    // The bot-authored summary note is updated in place (PUT to note 222), not duplicated.
    const putCall = calls.find((c) => c.url.endsWith("/notes/222") && c.init?.method === "PUT");
    const requestBody = JSON.parse(String(putCall?.init?.body)) as { body: string };
    expect(putCall).toBeDefined();
    expect(requestBody.body).toContain("<!-- ai-code-review-factory");
    expect(result.summaryCommentId).toBe("222");
  });

  test("ignores a planted non-bot summary marker and posts a fresh note (#84)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const adapter = new GitLabVcsAdapter({
      token: "write-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "ai-review-bot" });
        }
        if (
          url ===
            "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes" &&
          init?.method === undefined
        ) {
          // An attacker (author id 42, NOT the bot 55) planted a note carrying our marker.
          return jsonResponse([
            { id: 999, body: "<!-- ai-code-review-factory\n{}\n-->", author: { id: 42 } },
          ]);
        }
        if (
          url ===
            "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes" &&
          init?.method === "POST"
        ) {
          return jsonResponse(
            {
              id: 654,
              web_url: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_654",
            },
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
      change: {
        ...fixture.metadata,
        provider: "gitlab",
        repository: changeRef.repository,
        changeId: "7",
      },
      summary: review.summary,
    });

    // The planted note must NOT be edited (no PUT to /notes/999); a fresh note is POSTed instead.
    expect(calls.some((c) => c.url.endsWith("/notes/999"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/notes") && c.init?.method === "POST")).toBe(true);
    expect(result.summaryCommentId).toBe("654");
  });

  test("throws a clear error on GitLab API failures", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "401 Unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
    });

    await expect(adapter.getChange(changeRef)).rejects.toThrow(
      "GitLab API request failed: 401 Unauthorized",
    );
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
    expect((fetchCalls[0]?.init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe(
      "test-token",
    );
  });

  test("readBaseBranchFile returns undefined on a 404 (file absent on base branch)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "404 File Not Found" }), {
          status: 404,
          statusText: "Not Found",
        }),
    });

    const result = await adapter.readBaseBranchFile(changeMetadata, ".ai-review.json");

    expect(result).toBeUndefined();
  });

  test("readBaseBranchFile returns undefined (does not throw) on a non-404 error — best-effort read", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () =>
        new Response("upstream boom", { status: 500, statusText: "Internal Server Error" }),
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

  test("readChangeFileAtHead fetches head content at headSha and decodes base64", async () => {
    let seenUrl = "";
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        seenUrl = String(input);
        return jsonResponse({
          encoding: "base64",
          content: Buffer.from("export const headOnly = true;\n", "utf8").toString("base64"),
        });
      },
    });

    const result = await adapter.readChangeFileAtHead(changeMetadata, "src/auth/accounts.ts");

    expect(seenUrl).toBe(
      "https://gitlab.com/api/v4/projects/example%2Fpayments-api/repository/files/src%2Fauth%2Faccounts.ts?ref=headsha123",
    );
    expect(result).toBe("export const headOnly = true;\n");
  });

  test("readChangeFileAtHead returns undefined on non-OK and malformed base64", async () => {
    const nonOk = new GitLabVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "not found" }), {
          status: 404,
          statusText: "Not Found",
        }),
    });
    await expect(nonOk.readChangeFileAtHead(changeMetadata, "src/missing.ts")).resolves.toBe(
      undefined,
    );

    const malformed = new GitLabVcsAdapter({
      fetch: async () => jsonResponse({ encoding: "base64", content: "not base64!!!" }),
    });
    await expect(
      malformed.readChangeFileAtHead(changeMetadata, "src/auth/accounts.ts"),
    ).resolves.toBe(undefined);
  });

  // Inline diff-discussion tests (Part B — #82)

  const inlineDiffRefs = { base_sha: "base-abc", start_sha: "start-abc", head_sha: "head-abc" };

  const inlineChangeMetadata: ChangeMetadata = {
    ...changeMetadata,
    headSha: "head-abc",
    baseSha: "base-abc",
  };

  const readyFinding: Finding = {
    id: "fnd_inline_test",
    reviewer: "security",
    severity: "critical",
    category: "authorization",
    title: "Account lookup misses authorization",
    body: "The changed account lookup returns records without verifying ownership.",
    location: {
      path: "src/app.ts",
      line: 42,
      side: "RIGHT",
    },
    confidence: "high",
    evidence: ["The handler reads accountId and returns data without an ownership check."],
    recommendation: "Verify account ownership before returning account data.",
  };

  test("posts a ready finding as a GitLab diff discussion with the correct position (RIGHT → new_line)", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";

    const adapter = new GitLabVcsAdapter({
      token: "write-token",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // MR GET for diff_refs
        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        // Discussions GET for dedup
        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([]);
        }

        // Discussion POST
        if (url === `${mrPath}/discussions` && init?.method === "POST") {
          return jsonResponse(
            {
              id: "disc-hash-1",
              notes: [
                {
                  id: 101,
                  web_url: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_101",
                },
              ],
            },
            201,
          );
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
      runId: "run-gl-inline-1",
    });

    // Assert the POST went to the discussions endpoint
    const postCall = calls.find(
      (c) => c.url === `${mrPath}/discussions` && c.init?.method === "POST",
    );
    expect(postCall).toBeDefined();

    const requestBody = JSON.parse(String(postCall?.init?.body)) as {
      body: string;
      position: Record<string, unknown>;
    };

    // Position must carry all three SHAs and the correct text position
    expect(requestBody.position).toMatchObject({
      position_type: "text",
      base_sha: "base-abc",
      start_sha: "start-abc",
      head_sha: "head-abc",
      old_path: "src/app.ts",
      new_path: "src/app.ts",
      new_line: 42,
    });
    // RIGHT side → new_line present, old_line absent
    expect(requestBody.position.old_line).toBeUndefined();

    // Body must contain escaped finding content and the dedup metadata
    expect(requestBody.body).toContain("### AI review: 🚨 Critical · authorization");
    expect(requestBody.body).toContain("**Account lookup misses authorization**");
    expect(requestBody.body).toContain("<!-- ai-code-review-factory-inline");
    expect(requestBody.body).toContain("fnd_inline_test");

    // Outcome counts
    expect(result).toMatchObject({
      provider: "gitlab",
      attemptedInlineCount: 1,
      postedInlineCount: 1,
      skippedInlineCount: 0,
      failedInlineCount: 0,
    });
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "posted",
      providerCommentId: "101",
      url: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_101",
    });
  });

  test("LEFT side maps to old_line (not new_line) in the GitLab position object", async () => {
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const leftFinding: Finding = {
      ...readyFinding,
      id: "fnd_left_side",
      location: { path: "src/app.ts", line: 10, side: "LEFT" },
    };

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([]);
        }

        if (url === `${mrPath}/discussions` && init?.method === "POST") {
          return jsonResponse({ id: "disc-hash-2", notes: [{ id: 202 }] }, 201);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    await adapter.publishInlineFindings({ change: inlineChangeMetadata, findings: [leftFinding] });

    const postCall = calls.find((c) => c.init?.method === "POST");
    const requestBody = JSON.parse(String(postCall?.init?.body)) as {
      position: Record<string, unknown>;
    };

    // LEFT side → old_line present, new_line absent
    expect(requestBody.position.old_line).toBe(10);
    expect(requestBody.position.new_line).toBeUndefined();
  });

  test("deduplicates: skips posting when the same findingId+headSha already exists in discussions", async () => {
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const existingNoteBody = [
      "### AI review: existing",
      "",
      "<!-- ai-code-review-factory-inline",
      JSON.stringify({ schemaVersion: 1, findingId: "fnd_inline_test", headSha: "head-abc" }),
      "-->",
    ].join("\n");

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // Bot identity endpoint — must return the same id as the note's author.id (#84)
        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "bot-user" });
        }

        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([
            {
              id: "disc-existing",
              notes: [
                {
                  id: 777,
                  body: existingNoteBody,
                  // Author id must match the bot id returned by GET /user (#84)
                  author: { id: 55, username: "bot-user" },
                },
              ],
            },
          ]);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
    });

    // No POST should have been issued
    const postUrls = calls.filter((c) => c.init?.method === "POST").map((c) => c.url);
    expect(postUrls).toEqual([]);

    expect(result).toMatchObject({
      provider: "gitlab",
      postedInlineCount: 0,
      skippedInlineCount: 1,
    });
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "skipped",
      reason: "duplicate_inline_comment",
      providerCommentId: "777",
    });
  });

  test("skips a finding that is missing a side (missing GitLab inline comment coordinates)", async () => {
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    // location has a line but no side
    const noSideFinding: Finding = {
      ...readyFinding,
      id: "fnd_no_side",
      location: { path: "src/app.ts", line: 5, side: undefined as unknown as "LEFT" },
    };

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([]);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [noSideFinding],
    });

    const postUrls = calls.filter((c) => c.init?.method === "POST").map((c) => c.url);
    expect(postUrls).toEqual([]);

    expect(result.skippedInlineCount).toBe(1);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_no_side",
      disposition: "skipped",
      reason: "missing_inline_coordinates",
    });
  });

  test("records a failed outcome when the POST response has no notes (wrong-entity guard)", async () => {
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }
        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([]);
        }
        if (url === `${mrPath}/discussions` && init?.method === "POST") {
          // Discussion created but with an empty notes array — we must NOT report the discussion
          // hash as a note id; surface a failed outcome instead.
          return jsonResponse({ id: "disc-hash-empty", notes: [] }, 201);
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
    });

    expect(result.postedInlineCount).toBe(0);
    expect(result.failedInlineCount).toBe(1);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "failed",
      reason: "missing_discussion_note",
    });
    // The discussion hash must NOT leak as a providerCommentId.
    expect(result.findings[0]?.providerCommentId).toBeUndefined();
  });

  test("HTML-comment injection: a finding id containing '-->' is unicode-escaped and still round-trips", async () => {
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const evilFinding: Finding = { ...readyFinding, id: "fnd--><script>evil" };

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });
        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }
        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([]);
        }
        if (url === `${mrPath}/discussions` && init?.method === "POST") {
          return jsonResponse({ id: "disc-hash-evil", notes: [{ id: 303 }] }, 201);
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    await adapter.publishInlineFindings({ change: inlineChangeMetadata, findings: [evilFinding] });

    const postCall = calls.find((c) => c.init?.method === "POST");
    const body = (JSON.parse(String(postCall?.init?.body)) as { body: string }).body;

    // The raw '-->' from the id must NOT appear before the legitimate comment terminator — assert
    // the metadata block does not contain the injected closer, and that '>' was unicode-escaped.
    const metadataBlock =
      /<!-- ai-code-review-factory-inline\n([\s\S]*?)\n-->/.exec(body)?.[1] ?? "";
    // Only '>' is escaped (enough to prevent the '-->' closer); '<' is harmless inside a comment.
    expect(metadataBlock).not.toContain("-->");
    expect(metadataBlock).toContain("fnd--\\u003e<script\\u003eevil");
    // Dedup parsing still recovers the original id (the escape round-trips via JSON.parse).
    expect(parseInlineCommentMetadata(body)?.findingId).toBe("fnd--><script>evil");
  });

  test("records a failed outcome when the GitLab discussions API returns an error", async () => {
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);

        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([]);
        }

        // POST fails
        return new Response(JSON.stringify({ message: "validation failed" }), {
          status: 422,
          statusText: "Unprocessable Entity",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
    });

    expect(result.failedInlineCount).toBe(1);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "failed",
    });
    expect(result.findings[0]?.reason).toContain(
      "GitLab API request failed: 422 Unprocessable Entity",
    );
  });

  test("returns all findings as skipped/missing_diff_refs when the MR has no diff_refs", async () => {
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // MR GET returns no diff_refs
        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
          });
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
    });

    // No discussions GET, no POST should have been issued
    const discussionCalls = calls.filter((c) => c.url.endsWith("/discussions"));
    expect(discussionCalls).toHaveLength(0);

    expect(result).toMatchObject({
      provider: "gitlab",
      attemptedInlineCount: 1,
      postedInlineCount: 0,
      skippedInlineCount: 1,
      failedInlineCount: 0,
    });
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "skipped",
      reason: "missing_diff_refs",
    });
  });

  // --- Author-trust / dedup security tests (#84) ---

  test("planted marker from a non-bot author does NOT suppress the finding (finding is posted)", async () => {
    // A note with valid dedup metadata but authored by a different user (id 42, not the bot 55)
    // must not suppress the finding — only bot-authored notes count (#84).
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const plantedNoteBody = [
      "### AI review: planted",
      "",
      "<!-- ai-code-review-factory-inline",
      JSON.stringify({ schemaVersion: 1, findingId: "fnd_inline_test", headSha: "head-abc" }),
      "-->",
    ].join("\n");

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // Bot user id is 55; the existing note was authored by user 42 (not the bot).
        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "bot-user" });
        }

        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([
            {
              id: "disc-planted",
              notes: [
                {
                  id: 777,
                  body: plantedNoteBody,
                  author: { id: 42, username: "attacker" },
                },
              ],
            },
          ]);
        }

        if (url === `${mrPath}/discussions` && init?.method === "POST") {
          return jsonResponse(
            {
              id: "disc-new",
              notes: [
                {
                  id: 888,
                  web_url: "https://gitlab.com/example/payments-api/-/merge_requests/7#note_888",
                },
              ],
            },
            201,
          );
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
    });

    // Finding must be posted despite the planted marker — planted author (42) ≠ bot (55).
    expect(result.postedInlineCount).toBe(1);
    expect(result.skippedInlineCount).toBe(0);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "posted",
      providerCommentId: "888",
    });
    const postCalls = calls.filter((c) => c.init?.method === "POST");
    expect(postCalls).toHaveLength(1);
  });

  test("bot-authored duplicate is still skipped (no regression on existing dedup)", async () => {
    // Existing note has the same findingId+headSha AND is authored by the bot (id 55) —
    // the finding must still be suppressed to avoid duplicate inline comments.
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const existingNoteBody = [
      "### AI review: existing bot note",
      "",
      "<!-- ai-code-review-factory-inline",
      JSON.stringify({ schemaVersion: 1, findingId: "fnd_inline_test", headSha: "head-abc" }),
      "-->",
    ].join("\n");

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        if (url === "https://gitlab.com/api/v4/user") {
          return jsonResponse({ id: 55, username: "bot-user" });
        }

        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([
            {
              id: "disc-existing",
              notes: [
                {
                  id: 777,
                  body: existingNoteBody,
                  author: { id: 55, username: "bot-user" },
                },
              ],
            },
          ]);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
    });

    expect(result.postedInlineCount).toBe(0);
    expect(result.skippedInlineCount).toBe(1);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "skipped",
      reason: "duplicate_inline_comment",
      providerCommentId: "777",
    });
    const postCalls = calls.filter((c) => c.init?.method === "POST");
    expect(postCalls).toHaveLength(0);
  });

  test("bot-identity resolution failure → no suppression (safe-on-failure)", async () => {
    // GET /user returns non-2xx → botId = undefined → dedup map is empty → finding is posted
    // even if an existing note has matching metadata and looks like a bot note. This is the
    // safe direction: a duplicate comment is always preferable to suppressing a real finding (#84).
    const mrPath = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7";
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const existingNoteBody = [
      "### AI review: would-be duplicate",
      "",
      "<!-- ai-code-review-factory-inline",
      JSON.stringify({ schemaVersion: 1, findingId: "fnd_inline_test", headSha: "head-abc" }),
      "-->",
    ].join("\n");

    const adapter = new GitLabVcsAdapter({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ url, ...(init !== undefined ? { init } : {}) });

        // Simulate a 401 on GET /user — identity cannot be resolved.
        if (url === "https://gitlab.com/api/v4/user") {
          return new Response(JSON.stringify({ message: "401 Unauthorized" }), {
            status: 401,
            statusText: "Unauthorized",
          });
        }

        if (url === mrPath && init?.method === undefined) {
          return jsonResponse({
            iid: 7,
            title: "t",
            source_branch: "s",
            target_branch: "main",
            author: { username: "u" },
            labels: [],
            diff_refs: inlineDiffRefs,
          });
        }

        if (url === `${mrPath}/discussions` && init?.method === undefined) {
          return jsonResponse([
            {
              id: "disc-existing",
              notes: [
                {
                  id: 777,
                  body: existingNoteBody,
                  author: { id: 55, username: "bot-user" },
                },
              ],
            },
          ]);
        }

        if (url === `${mrPath}/discussions` && init?.method === "POST") {
          return jsonResponse({ id: "disc-new", notes: [{ id: 888 }] }, 201);
        }

        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: inlineChangeMetadata,
      findings: [readyFinding],
    });

    // Identity unknown → dedup map empty → finding posted (not suppressed).
    expect(result.postedInlineCount).toBe(1);
    expect(result.skippedInlineCount).toBe(0);
    expect(result.findings[0]).toMatchObject({
      findingId: "fnd_inline_test",
      disposition: "posted",
      providerCommentId: "888",
    });
  });

  // ---------------------------------------------------------------------------
  // getChangedPathsSince tests (#115 — GitLab compare-API incremental delta)
  // ---------------------------------------------------------------------------

  // A valid commit-SHA-shaped previousHeadSha (passes the untrusted-input guard).
  const validSinceSha = "0123456789abcdef0123456789abcdef01234567";
  const reverseCompareUrl = `https://gitlab.com/api/v4/projects/example%2Fpayments-api/repository/compare?from=headsha123&to=${validSinceSha}&straight=true`;
  const forwardCompareUrl = `https://gitlab.com/api/v4/projects/example%2Fpayments-api/repository/compare?from=${validSinceSha}&to=headsha123&straight=true`;

  test("getChangedPathsSince: a non-SHA-shaped sinceSha is rejected without an API call", async () => {
    let called = false;
    const adapter = new GitLabVcsAdapter({
      fetch: async () => {
        called = true;
        return jsonResponse({ commits: [], diffs: [] });
      },
    });
    // "oldsha" contains non-hex chars → rejected by the SHA-shape guard (untrusted input).
    const result = await adapter.getChangedPathsSince(changeRef, "oldsha");
    expect(result).toBeUndefined();
    expect(called).toBe(false);
  });

  test("getChangedPathsSince: clean ancestor (no reverse commits) with 2 files → isAncestor true, changedPaths populated", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          // sinceSha has no commits unreachable from head → clean fast-forward.
          return jsonResponse({ commits: [], diffs: [] });
        }
        if (url === forwardCompareUrl) {
          return jsonResponse({
            commits: [{ id: "abc" }, { id: "def" }],
            diffs: [
              { old_path: "src/auth/accounts.ts", new_path: "src/auth/accounts.ts" },
              { old_path: "src/billing/invoice.ts", new_path: "src/billing/invoice.ts" },
            ],
          });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);

    expect(result).toBeDefined();
    expect(result?.isAncestor).toBe(true);
    expect(result?.changedPaths).toEqual(["src/auth/accounts.ts", "src/billing/invoice.ts"]);
  });

  test("getChangedPathsSince: ancestor with empty forward diff → isAncestor true, empty changedPaths", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          return jsonResponse({ commits: [], diffs: [] });
        }
        if (url === forwardCompareUrl) {
          return jsonResponse({ commits: [], diffs: [] });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);

    expect(result?.isAncestor).toBe(true);
    expect(result?.changedPaths).toEqual([]);
  });

  test("getChangedPathsSince: force-push/rebase (reverse commits non-empty) → isAncestor false, forward compare skipped", async () => {
    const urls: string[] = [];
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        urls.push(url);
        if (url === reverseCompareUrl) {
          // sinceSha has a commit NOT reachable from head → diverged (force-push/rebase).
          return jsonResponse({ commits: [{ id: "orphan" }], diffs: [] });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);

    expect(result?.isAncestor).toBe(false);
    // Not an ancestor → changedPaths emptied (the delta is meaningless on a force-push/rebase).
    expect(result?.changedPaths).toEqual([]);
    // The forward compare is skipped once ancestry is disproven (no wasted call).
    expect(urls).toEqual([reverseCompareUrl]);
  });

  test("getChangedPathsSince: reverse compare_timeout → isAncestor false (ancestry unconfirmable)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          // A timed-out compare cannot confirm the commit set is empty → treat as non-ancestor.
          return jsonResponse({ commits: [], diffs: [], compare_timeout: true });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);

    expect(result?.isAncestor).toBe(false);
    expect(result?.changedPaths).toEqual([]);
  });

  test("getChangedPathsSince: deletion diff falls back to old_path", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          return jsonResponse({ commits: [], diffs: [] });
        }
        if (url === forwardCompareUrl) {
          return jsonResponse({
            commits: [{ id: "abc" }],
            // A deletion: new_path absent → fall back to old_path; an empty path is dropped.
            diffs: [
              { old_path: "src/legacy/removed.ts" },
              { old_path: "", new_path: "" },
              { new_path: "src/new.ts" },
            ],
          });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);

    expect(result?.isAncestor).toBe(true);
    expect(result?.changedPaths).toEqual(["src/legacy/removed.ts", "src/new.ts"]);
  });

  test("getChangedPathsSince: forward compare_timeout → returns undefined (truncation safety)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          return jsonResponse({ commits: [], diffs: [] });
        }
        if (url === forwardCompareUrl) {
          return jsonResponse({ commits: [], diffs: [], compare_timeout: true });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);
    expect(result).toBeUndefined();
  });

  test("getChangedPathsSince: 300 forward diffs → returns undefined (file-cap safety)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          return jsonResponse({ commits: [], diffs: [] });
        }
        if (url === forwardCompareUrl) {
          const diffs = Array.from({ length: 300 }, (_, i) => ({ new_path: `src/file-${i}.ts` }));
          return jsonResponse({ commits: [{ id: "abc" }], diffs });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);
    expect(result).toBeUndefined();
  });

  test("getChangedPathsSince: 299 forward diffs → returned (not truncated)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          return jsonResponse({ commits: [], diffs: [] });
        }
        if (url === forwardCompareUrl) {
          const diffs = Array.from({ length: 299 }, (_, i) => ({ new_path: `src/file-${i}.ts` }));
          return jsonResponse({ commits: [{ id: "abc" }], diffs });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);
    expect(result?.changedPaths).toHaveLength(299);
    expect(result?.isAncestor).toBe(true);
  });

  test("getChangedPathsSince: fetch throws → returns undefined (best-effort, never throws)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () => {
        throw new Error("network error");
      },
    });
    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);
    expect(result).toBeUndefined();
  });

  test("getChangedPathsSince: non-2xx response → returns undefined", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "not found" }), {
          status: 404,
          statusText: "Not Found",
        }),
    });
    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);
    expect(result).toBeUndefined();
  });

  test("getChangedPathsSince: missing diffs field → empty changedPaths", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === reverseCompareUrl) {
          return jsonResponse({ commits: [] });
        }
        if (url === forwardCompareUrl) {
          return jsonResponse({ commits: [{ id: "abc" }] });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const result = await adapter.getChangedPathsSince(changeRef, validSinceSha);
    expect(result?.isAncestor).toBe(true);
    expect(result?.changedPaths).toEqual([]);
  });
});

function fixtureFetch(calls: Array<{ url: string; init?: RequestInit }>): GitLabFetchLike {
  return async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init !== undefined ? { init } : {}) });

    if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7") {
      return jsonResponse(await readFixture("merge-request.json"));
    }

    if (
      url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/changes"
    ) {
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
