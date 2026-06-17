import { describe, expect, test } from "bun:test";
import type { ChangeMetadata, ChangeRef, FetchLike, Finding, ReviewSummary } from "../src/index.ts";
import { BitbucketVcsAdapter } from "../src/index.ts";

const changeRef: ChangeRef = {
  provider: "bitbucket",
  repository: {
    provider: "bitbucket",
    owner: "acme-org",
    name: "payments-api",
    slug: "acme-org/payments-api",
  },
  changeId: "42",
  headSha: "abc123def456",
};

// Minimal unified diff with two files for getDiff tests.
const SAMPLE_DIFF = `diff --git a/src/auth/accounts.ts b/src/auth/accounts.ts
index 1111111..2222222 100644
--- a/src/auth/accounts.ts
+++ b/src/auth/accounts.ts
@@ -1,4 +1,5 @@
 export function lookup(id: string) {
-  return db.find(id);
+  const record = db.find(id);
+  if (!record) throw new Error("not found");
+  return record;
 }
diff --git a/src/billing/invoice.ts b/src/billing/invoice.ts
index 3333333..4444444 100644
--- a/src/billing/invoice.ts
+++ b/src/billing/invoice.ts
@@ -1,3 +1,4 @@
 export function bill(amount: number) {
-  process(amount);
+  validate(amount);
+  process(amount);
 }
`;

// Hidden-metadata block matching the format used by the GitHub/GitLab adapters and
// parseSummaryHiddenMetadata. This is what the bot writes as an HTML comment in its
// PR comment body when it posts a review summary.
function makeBotCommentBody(runId: string, headSha: string, findingIds: string[]): string {
  return [
    "<!-- ai-code-review-factory",
    JSON.stringify({
      schemaVersion: 1,
      runId,
      headSha,
      provider: "bitbucket",
      repository: "acme-org/payments-api",
      changeId: "42",
      findingIds,
    }),
    "-->",
  ].join("\n");
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    headers: { "Content-Type": "application/json" },
  });
}

// ------ getChange tests ------

describe("BitbucketVcsAdapter.getChange", () => {
  test("maps PR metadata correctly", async () => {
    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: async (input) => {
        const url = String(input);
        if (
          url === "https://api.bitbucket.org/2.0/repositories/acme-org/payments-api/pullrequests/42"
        ) {
          return jsonResponse({
            id: 42,
            title: "Harden account lookup",
            description: "Fallback description",
            summary: { raw: "Adds stricter auth checks." },
            author: {
              uuid: "{user-uuid-123}",
              nickname: "octo-dev",
              display_name: "Octo Dev",
            },
            source: {
              branch: { name: "feature/account-lookup" },
              commit: { hash: "abc123def456" },
            },
            destination: {
              branch: { name: "main" },
              commit: { hash: "base789sha" },
              repository: {
                full_name: "acme-org/payments-api",
                links: { html: { href: "https://bitbucket.org/acme-org/payments-api" } },
              },
            },
            links: {
              html: { href: "https://bitbucket.org/acme-org/payments-api/pull-requests/42" },
            },
            created_on: "2026-06-01T10:00:00.000Z",
            updated_on: "2026-06-02T11:00:00.000Z",
          });
        }
        return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
          status: 404,
          statusText: "Not Found",
        });
      },
    });

    const change = await adapter.getChange(changeRef);

    expect(change.provider).toBe("bitbucket");
    expect(change.repository.slug).toBe("acme-org/payments-api");
    expect(change.repository.owner).toBe("acme-org");
    expect(change.repository.name).toBe("payments-api");
    expect(change.repository.webUrl).toBe("https://bitbucket.org/acme-org/payments-api");
    expect(change.changeId).toBe("42");
    expect(change.headSha).toBe("abc123def456");
    expect(change.baseSha).toBe("base789sha");
    expect(change.sourceBranch).toBe("feature/account-lookup");
    expect(change.targetBranch).toBe("main");
    expect(change.title).toBe("Harden account lookup");
    // description comes from summary.raw, not description field
    expect(change.description).toBe("Adds stricter auth checks.");
    expect(change.author.username).toBe("octo-dev");
    expect(change.author.id).toBe("{user-uuid-123}");
    // Bitbucket PRs have no labels
    expect(change.labels).toEqual([]);
    expect(change.webUrl).toBe("https://bitbucket.org/acme-org/payments-api/pull-requests/42");
    expect(change.createdAt).toBe("2026-06-01T10:00:00.000Z");
    expect(change.updatedAt).toBe("2026-06-02T11:00:00.000Z");
  });

  test("falls back to description field when summary.raw is absent", async () => {
    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/pullrequests/42")) {
          return jsonResponse({
            id: 42,
            title: "Fix bug",
            description: "Plain description fallback",
            author: { uuid: "{uuid-1}", nickname: "dev1" },
            source: { branch: { name: "fix/bug" }, commit: { hash: "headsha" } },
            destination: { branch: { name: "main" }, commit: { hash: "basesha" } },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const change = await adapter.getChange(changeRef);
    expect(change.description).toBe("Plain description fallback");
  });

  test("falls back to description when summary.raw is empty/whitespace (not just absent)", async () => {
    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/pullrequests/42")) {
          return jsonResponse({
            id: 42,
            title: "Fix bug",
            description: "Plain description fallback",
            summary: { raw: "   " },
            author: { uuid: "{uuid-1}", nickname: "dev1" },
            source: { branch: { name: "fix/bug" }, commit: { hash: "headsha" } },
            destination: { branch: { name: "main" }, commit: { hash: "basesha" } },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const change = await adapter.getChange(changeRef);
    expect(change.description).toBe("Plain description fallback");
  });

  test("falls back to display_name then uuid when nickname is absent", async () => {
    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/pullrequests/42")) {
          return jsonResponse({
            id: 42,
            title: "No nickname",
            author: { uuid: "{uuid-fallback}", display_name: "Display Name" },
            source: { branch: { name: "feat/x" }, commit: { hash: "headsha" } },
            destination: { branch: { name: "main" }, commit: { hash: "basesha" } },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const change = await adapter.getChange(changeRef);
    // nickname absent → display_name is used
    expect(change.author.username).toBe("Display Name");
  });

  test("sends Authorization: Bearer header with token", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const adapter = new BitbucketVcsAdapter({
      token: "my-access-token",
      fetch: async (input, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        const url = String(input);
        if (url.includes("/pullrequests/42")) {
          return jsonResponse({
            id: 42,
            title: "Auth check",
            author: { uuid: "{u}", nickname: "dev" },
            source: { branch: { name: "feat" }, commit: { hash: "hh" } },
            destination: { branch: { name: "main" }, commit: { hash: "bb" } },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    await adapter.getChange(changeRef);
    expect(capturedHeaders?.Authorization).toBe("Bearer my-access-token");
  });

  test("throws on non-2xx API response", async () => {
    const adapter = new BitbucketVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "Not Found" } }), {
          status: 404,
          statusText: "Not Found",
        }),
    });

    await expect(adapter.getChange(changeRef)).rejects.toThrow(
      "Bitbucket API request failed: 404 Not Found",
    );
  });
});

// ------ getDiff tests ------

describe("BitbucketVcsAdapter.getDiff", () => {
  test("parses raw unified diff into files with additions and deletions", async () => {
    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: async (input) => {
        const url = String(input);
        if (url.includes("/diff")) {
          // Return raw text (NOT JSON)
          return new Response(SAMPLE_DIFF, {
            status: 200,
            statusText: "OK",
          });
        }
        return new Response("not found", { status: 404 });
      },
    });

    const diff = await adapter.getDiff(changeRef);

    expect(diff.files).toHaveLength(2);
    expect(diff.files[0]?.path).toBe("src/auth/accounts.ts");
    expect(diff.files[0]?.additions).toBe(3);
    expect(diff.files[0]?.deletions).toBe(1);
    expect(diff.files[1]?.path).toBe("src/billing/invoice.ts");
    expect(diff.files[1]?.additions).toBe(2);
    expect(diff.files[1]?.deletions).toBe(1);
    expect(diff.totalAdditions).toBe(5);
    expect(diff.totalDeletions).toBe(2);
    expect(diff.truncated).toBe(false);
  });

  test("requests the diff URL with auth headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    const adapter = new BitbucketVcsAdapter({
      token: "diff-token",
      fetch: async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(SAMPLE_DIFF, { status: 200 });
      },
    });

    await adapter.getDiff(changeRef);

    expect(capturedUrl).toBe(
      "https://api.bitbucket.org/2.0/repositories/acme-org/payments-api/pullrequests/42/diff",
    );
    expect(capturedHeaders?.Authorization).toBe("Bearer diff-token");
  });

  test("throws HttpRequestError on non-2xx diff response", async () => {
    const adapter = new BitbucketVcsAdapter({
      fetch: async () => new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    });

    await expect(adapter.getDiff(changeRef)).rejects.toThrow(
      "Bitbucket API request failed: 401 Unauthorized",
    );
  });

  test("handles an empty diff (no changed files)", async () => {
    const adapter = new BitbucketVcsAdapter({
      fetch: async () => new Response("", { status: 200 }),
    });

    const diff = await adapter.getDiff(changeRef);
    expect(diff.files).toHaveLength(0);
    expect(diff.totalAdditions).toBe(0);
    expect(diff.totalDeletions).toBe(0);
    expect(diff.truncated).toBe(false);
  });
});

// ------ getPriorReviewState tests ------

describe("BitbucketVcsAdapter.getPriorReviewState", () => {
  function makeFetchWithComments(
    botUuid: string | undefined,
    comments: Array<{
      id: number;
      contentRaw?: string;
      userUuid?: string;
    }>,
  ): FetchLike {
    return async (input) => {
      const url = String(input);

      if (url === "https://api.bitbucket.org/2.0/user") {
        if (botUuid === undefined) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            statusText: "Unauthorized",
          });
        }
        return jsonResponse({ uuid: botUuid, nickname: "ai-review-bot" });
      }

      if (url.includes("/comments")) {
        const values = comments.map((c) => ({
          id: c.id,
          content: c.contentRaw !== undefined ? { raw: c.contentRaw } : undefined,
          user: c.userUuid !== undefined ? { uuid: c.userUuid } : undefined,
        }));
        return jsonResponse({ values, next: undefined });
      }

      return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
        status: 404,
        statusText: "Not Found",
      });
    };
  }

  test("loads prior review state from a bot-authored summary comment", async () => {
    const botUuid = "{bot-uuid-99}";
    const body = makeBotCommentBody("prior-run-123", "old-head-sha", ["fnd_auth_1", "fnd_auth_2"]);

    const adapter = new BitbucketVcsAdapter({
      fetch: makeFetchWithComments(botUuid, [
        { id: 100, contentRaw: "unrelated comment", userUuid: "{other-user}" },
        { id: 101, contentRaw: body, userUuid: botUuid },
      ]),
    });

    const state = await adapter.getPriorReviewState(changeRef);

    expect(state).toBeDefined();
    expect(state?.previousRunId).toBe("prior-run-123");
    expect(state?.previousHeadSha).toBe("old-head-sha");
    expect(state?.findings.map((f) => f.stableId)).toEqual(["fnd_auth_1", "fnd_auth_2"]);
    expect(state?.hiddenMetadata?.repository).toBe("acme-org/payments-api");
  });

  test("forged comment (marker + different user.uuid) is NOT loaded as prior state (#84/#263 guard)", async () => {
    // THE regression guard: a PR participant (not the bot) crafts a comment with a valid
    // <!-- ai-code-review-factory --> block. Without the author check this would be loaded
    // as prior state and influence convergence, resolvedLog, and disposition.
    const botUuid = "{bot-uuid-99}";
    const forgedBody = makeBotCommentBody("forged-run", "evil-head", ["fnd_fake"]);

    const adapter = new BitbucketVcsAdapter({
      fetch: makeFetchWithComments(botUuid, [
        // Forged by attacker — user uuid is DIFFERENT from the bot's uuid.
        { id: 999, contentRaw: forgedBody, userUuid: "{attacker-uuid}" },
      ]),
    });

    // The forged comment must NOT be loaded — result must be undefined.
    const state = await adapter.getPriorReviewState(changeRef);
    expect(state).toBeUndefined();
  });

  test("selects the summary, not a bot inline comment, on the shared /comments endpoint", async () => {
    // Bitbucket has ONE comments endpoint for both summary and inline comments. A bare
    // `includes("<!-- ai-code-review-factory")` substring would also match the inline marker
    // `<!-- ai-code-review-factory-inline`, so a bot inline comment could be mis-selected as the
    // "existing summary" — losing prior review state. The summary scan must require a parseable
    // summary metadata block. Here the inline comment is listed LAST (findLast would pick it under
    // the buggy substring check); the fixed scan must still resolve the real summary.
    const botUuid = "{bot-uuid-99}";
    const summaryBody = makeBotCommentBody("prior-run-777", "head-777", ["fnd_keep_1"]);
    const inlineBody =
      'Inline finding text.\n\n<!-- ai-code-review-factory-inline\n{"findingId":"fnd_inline"}\n-->';

    const adapter = new BitbucketVcsAdapter({
      fetch: makeFetchWithComments(botUuid, [
        { id: 200, contentRaw: summaryBody, userUuid: botUuid },
        { id: 201, contentRaw: inlineBody, userUuid: botUuid },
      ]),
    });

    const state = await adapter.getPriorReviewState(changeRef);

    expect(state).toBeDefined();
    expect(state?.previousRunId).toBe("prior-run-777");
    expect(state?.findings.map((f) => f.stableId)).toEqual(["fnd_keep_1"]);
  });

  test("returns undefined when there are no PR comments at all", async () => {
    const adapter = new BitbucketVcsAdapter({
      fetch: makeFetchWithComments("{bot-uuid}", []),
    });

    const state = await adapter.getPriorReviewState(changeRef);
    expect(state).toBeUndefined();
  });

  test("returns undefined (safe-on-failure) when bot uuid cannot be resolved", async () => {
    // If GET /user fails (401), getPriorReviewState must return undefined
    // rather than falling back to author-blind metadata selection.
    const body = makeBotCommentBody("prior-run", "head-sha", ["fnd_1"]);
    const adapter = new BitbucketVcsAdapter({
      // botUuid=undefined → /user returns 401
      fetch: makeFetchWithComments(undefined, [{ id: 1, contentRaw: body, userUuid: "{bot}" }]),
    });

    const state = await adapter.getPriorReviewState(changeRef);
    expect(state).toBeUndefined();
  });

  test("selects the LAST bot-authored comment when multiple exist (findLast behaviour)", async () => {
    const botUuid = "{bot-uuid}";
    const firstBody = makeBotCommentBody("run-1", "head-sha-1", ["fnd_old"]);
    const secondBody = makeBotCommentBody("run-2", "head-sha-2", ["fnd_new"]);

    const adapter = new BitbucketVcsAdapter({
      fetch: makeFetchWithComments(botUuid, [
        { id: 1, contentRaw: firstBody, userUuid: botUuid },
        { id: 2, contentRaw: secondBody, userUuid: botUuid },
      ]),
    });

    const state = await adapter.getPriorReviewState(changeRef);
    // The last bot comment wins.
    expect(state?.previousRunId).toBe("run-2");
    expect(state?.previousHeadSha).toBe("head-sha-2");
  });

  test("mixed: bot comment then forged comment → bot's is selected (not the later forged one)", async () => {
    const botUuid = "{bot-uuid-99}";
    const realBody = makeBotCommentBody("real-run", "real-head", ["fnd_real"]);
    const forgedBody = makeBotCommentBody("forged-run", "forged-head", ["fnd_fake"]);

    const adapter = new BitbucketVcsAdapter({
      fetch: makeFetchWithComments(botUuid, [
        { id: 1, contentRaw: realBody, userUuid: botUuid },
        // Later forged comment — attacker posted AFTER the bot's genuine comment.
        { id: 2, contentRaw: forgedBody, userUuid: "{attacker-uuid}" },
      ]),
    });

    const state = await adapter.getPriorReviewState(changeRef);
    // Must load the bot's comment (id 1), not the later forged one (id 2).
    expect(state?.previousRunId).toBe("real-run");
    expect(state?.previousHeadSha).toBe("real-head");
    expect(state?.findings.map((f) => f.stableId)).toEqual(["fnd_real"]);
  });
});

// ------ provider field ------

describe("BitbucketVcsAdapter", () => {
  test("provider field is 'bitbucket'", () => {
    const adapter = new BitbucketVcsAdapter({ token: "tok" });
    expect(adapter.provider).toBe("bitbucket");
  });
});

// ------ publishSummary tests ------

const BOT_UUID = "{bot-uuid-pub}";

const CHANGE_META: ChangeMetadata = {
  provider: "bitbucket",
  repository: {
    provider: "bitbucket",
    owner: "acme-org",
    name: "payments-api",
    slug: "acme-org/payments-api",
  },
  changeId: "42",
  headSha: "abc123def456",
  baseSha: "base789sha",
  title: "Harden account lookup",
  author: { username: "octo-dev" },
  labels: [],
};

const MINIMAL_SUMMARY: ReviewSummary = {
  decision: "approved",
  outcome: "pass",
  title: "All checks passed",
  body: "No findings.",
  findings: [],
  risk: {
    tier: "trivial",
    reason: "Small diff",
    matchedRules: [],
    sensitivePaths: [],
    reviewedFileCount: 1,
    ignoredFileCount: 0,
  },
};

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Auth check changed",
    body: "The auth check changed.",
    confidence: "high",
    evidence: ["Evidence item."],
    recommendation: "Verify the new auth behavior.",
    ...overrides,
  };
}

/** Build a fake-fetch that handles /user, /comments (GET paginated), and POST/PUT to /comments */
function makePublishFetch(options: {
  botUuid: string;
  existingComments?: Array<{ id: number; contentRaw?: string; userUuid?: string }>;
  onPost?: (url: string, body: unknown) => { id: number; links?: { html?: { href?: string } } };
  onPut?: (url: string, body: unknown) => { id: number; links?: { html?: { href?: string } } };
}): FetchLike {
  const { botUuid, existingComments = [], onPost, onPut } = options;

  return async (input, init) => {
    const url = String(input);
    const method = init?.method?.toUpperCase() ?? "GET";

    if (url === "https://api.bitbucket.org/2.0/user") {
      return new Response(JSON.stringify({ uuid: botUuid }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/comments") && method === "GET") {
      const values = existingComments.map((c) => ({
        id: c.id,
        content: c.contentRaw !== undefined ? { raw: c.contentRaw } : undefined,
        user: c.userUuid !== undefined ? { uuid: c.userUuid } : undefined,
      }));
      return new Response(JSON.stringify({ values, next: undefined }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/comments") && method === "POST") {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown;
      const result = onPost ? onPost(url, parsed) : { id: 999 };
      return new Response(JSON.stringify(result), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/comments") && method === "PUT") {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as unknown;
      const result = onPut ? onPut(url, parsed) : { id: 888 };
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ message: `unexpected: ${method} ${url}` }), {
      status: 404,
    });
  };
}

describe("BitbucketVcsAdapter.publishSummary", () => {
  test("no existing bot comment → POSTs a new comment with content.raw", async () => {
    let capturedMethod: string | undefined;
    let capturedBody: unknown;

    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: makePublishFetch({
        botUuid: BOT_UUID,
        existingComments: [],
        onPost: (_url, body) => {
          capturedMethod = "POST";
          capturedBody = body;
          return {
            id: 701,
            links: {
              html: {
                href: "https://bitbucket.org/acme-org/payments-api/pull-requests/42/_/diff#comment-701",
              },
            },
          };
        },
      }),
    });

    const result = await adapter.publishSummary({
      change: CHANGE_META,
      summary: MINIMAL_SUMMARY,
    });

    expect(capturedMethod).toBe("POST");
    // body must use content.raw (not body) field
    expect((capturedBody as { content?: { raw?: string } }).content?.raw).toBeDefined();
    expect(result.provider).toBe("bitbucket");
    expect(result.summaryCommentId).toBe("701");
    expect(result.summaryUrl).toContain("comment-701");
    expect(result.postedInlineCount).toBe(0);
    expect(result.failedInlineCount).toBe(0);
  });

  test("existing bot comment (matching uuid + marker) → PUTs to that comment id (update not create)", async () => {
    const existingBody = makeBotCommentBody("prior-run-pub", "old-head-sha", []);
    let capturedMethod: string | undefined;
    let capturedPutUrl: string | undefined;

    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: makePublishFetch({
        botUuid: BOT_UUID,
        existingComments: [{ id: 555, contentRaw: existingBody, userUuid: BOT_UUID }],
        onPut: (url, _body) => {
          capturedMethod = "PUT";
          capturedPutUrl = url;
          return { id: 555 };
        },
      }),
    });

    const result = await adapter.publishSummary({
      change: CHANGE_META,
      summary: MINIMAL_SUMMARY,
    });

    expect(capturedMethod).toBe("PUT");
    // URL should include the comment id 555
    expect(capturedPutUrl).toContain("/comments/555");
    expect(result.summaryCommentId).toBe("555");
  });
});

// ------ publishInlineFindings tests ------

describe("BitbucketVcsAdapter.publishInlineFindings", () => {
  test("RIGHT-side finding → POSTs with inline: { path, to } and content.raw", async () => {
    let capturedPostBody: unknown;

    const finding = makeFinding({
      id: "fnd_right_001",
      location: { path: "src/auth.ts", line: 42, side: "RIGHT" },
    });

    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: makePublishFetch({
        botUuid: BOT_UUID,
        existingComments: [],
        onPost: (_url, body) => {
          capturedPostBody = body;
          return { id: 801, links: { html: { href: "https://bitbucket.org/.../comment-801" } } };
        },
      }),
    });

    const result = await adapter.publishInlineFindings({
      change: CHANGE_META,
      findings: [finding],
      runId: "run-inline-test",
    });

    expect(result.provider).toBe("bitbucket");
    expect(result.attemptedInlineCount).toBe(1);
    expect(result.postedInlineCount).toBe(1);
    expect(result.skippedInlineCount).toBe(0);
    expect(result.failedInlineCount).toBe(0);
    expect(result.findings[0]?.disposition).toBe("posted");
    expect(result.findings[0]?.providerCommentId).toBe("801");

    // Verify the POST body shape
    const body = capturedPostBody as {
      content?: { raw?: string };
      inline?: { path?: string; to?: number; from?: number };
    };
    expect(body.content?.raw).toBeDefined();
    expect(body.inline?.path).toBe("src/auth.ts");
    expect(body.inline?.to).toBe(42);
    expect(body.inline?.from).toBeUndefined();
  });

  test("inline POST that errors → disposition 'failed' (counted, does not throw)", async () => {
    const finding = makeFinding({
      id: "fnd_fail_001",
      location: { path: "src/auth.ts", line: 7, side: "RIGHT" },
    });

    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method?.toUpperCase() ?? "GET";
        if (url === "https://api.bitbucket.org/2.0/user") {
          return new Response(JSON.stringify({ uuid: BOT_UUID }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.includes("/comments") && method === "GET") {
          return new Response(JSON.stringify({ values: [], next: undefined }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        // The inline POST fails with a non-2xx → adapter records 'failed', does not throw.
        return new Response(JSON.stringify({ error: { message: "Bad request" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const result = await adapter.publishInlineFindings({
      change: CHANGE_META,
      findings: [finding],
      runId: "run-inline-fail",
    });

    expect(result.attemptedInlineCount).toBe(1);
    expect(result.postedInlineCount).toBe(0);
    expect(result.failedInlineCount).toBe(1);
    expect(result.findings[0]?.disposition).toBe("failed");
  });

  test("LEFT-side finding → POSTs with inline: { path, from }", async () => {
    let capturedPostBody: unknown;

    const finding = makeFinding({
      id: "fnd_left_002",
      location: { path: "src/legacy.ts", line: 10, side: "LEFT" },
    });

    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: makePublishFetch({
        botUuid: BOT_UUID,
        existingComments: [],
        onPost: (_url, body) => {
          capturedPostBody = body;
          return { id: 802 };
        },
      }),
    });

    const result = await adapter.publishInlineFindings({
      change: CHANGE_META,
      findings: [finding],
    });

    const body = capturedPostBody as {
      content?: { raw?: string };
      inline?: { path?: string; to?: number; from?: number };
    };
    expect(body.inline?.from).toBe(10);
    expect(body.inline?.to).toBeUndefined();
    expect(result.postedInlineCount).toBe(1);
  });

  test("finding whose marker already exists on a bot comment → skipped/duplicate_inline_comment", async () => {
    const findingId = "fnd_dup_003";
    const headSha = CHANGE_META.headSha;

    // Build a comment body with the inline marker embedding the finding id + head sha
    const inlineMarkerBody = [
      "### AI review: ⚠️ Warning · auth",
      "",
      "<!-- ai-code-review-factory-inline",
      JSON.stringify({
        schemaVersion: 1,
        provider: "bitbucket",
        repository: "acme-org/payments-api",
        changeId: "42",
        headSha,
        findingId,
        runId: null,
      }).replace(/>/g, "\\u003e"),
      "-->",
    ].join("\n");

    const finding = makeFinding({
      id: findingId,
      location: { path: "src/auth.ts", line: 5, side: "RIGHT" },
    });

    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: makePublishFetch({
        botUuid: BOT_UUID,
        existingComments: [{ id: 900, contentRaw: inlineMarkerBody, userUuid: BOT_UUID }],
      }),
    });

    const result = await adapter.publishInlineFindings({
      change: CHANGE_META,
      findings: [finding],
    });

    expect(result.attemptedInlineCount).toBe(1);
    expect(result.postedInlineCount).toBe(0);
    expect(result.skippedInlineCount).toBe(1);
    expect(result.failedInlineCount).toBe(0);
    const outcome = result.findings[0];
    expect(outcome?.disposition).toBe("skipped");
    expect(outcome?.reason).toBe("duplicate_inline_comment");
    expect(outcome?.providerCommentId).toBe("900");
  });

  test("finding with no inline coordinate → skipped/missing_inline_coordinates", async () => {
    const finding = makeFinding({
      id: "fnd_nocoord_004",
      // no location
    });

    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: makePublishFetch({
        botUuid: BOT_UUID,
        existingComments: [],
      }),
    });

    const result = await adapter.publishInlineFindings({
      change: CHANGE_META,
      findings: [finding],
    });

    expect(result.attemptedInlineCount).toBe(1);
    expect(result.postedInlineCount).toBe(0);
    expect(result.skippedInlineCount).toBe(1);
    expect(result.failedInlineCount).toBe(0);
    expect(result.findings[0]?.disposition).toBe("skipped");
    expect(result.findings[0]?.reason).toBe("missing_inline_coordinates");
  });

  test("mixed findings: counts are consistent (posted + skipped + failed = attempted)", async () => {
    const rightFinding = makeFinding({
      id: "fnd_mixed_ok",
      location: { path: "src/a.ts", line: 1, side: "RIGHT" },
    });
    const noCoordFinding = makeFinding({
      id: "fnd_mixed_no_coord",
      // no location
    });

    let postCount = 0;
    const adapter = new BitbucketVcsAdapter({
      token: "test-token",
      fetch: makePublishFetch({
        botUuid: BOT_UUID,
        existingComments: [],
        onPost: () => {
          postCount += 1;
          return { id: 1000 + postCount };
        },
      }),
    });

    const result = await adapter.publishInlineFindings({
      change: CHANGE_META,
      findings: [rightFinding, noCoordFinding],
    });

    expect(result.attemptedInlineCount).toBe(2);
    expect(result.postedInlineCount).toBe(1);
    expect(result.skippedInlineCount).toBe(1);
    expect(result.failedInlineCount).toBe(0);
    expect(result.postedInlineCount + result.skippedInlineCount + result.failedInlineCount).toBe(
      result.attemptedInlineCount,
    );
  });
});
