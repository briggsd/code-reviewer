import { describe, expect, test } from "bun:test";
import type { ChangeRef } from "../src/index.ts";
import { GitHubVcsAdapter } from "../src/index.ts";

const changeRef: ChangeRef = {
  provider: "github",
  repository: {
    provider: "github",
    owner: "example",
    name: "payments-api",
    slug: "example/payments-api",
  },
  changeId: "42",
  headSha: "abc1234def567890",
};

const commentsUrl =
  "https://api.github.com/repos/example/payments-api/issues/42/comments?per_page=100";

describe("GitHubVcsAdapter.detectBreakGlassOverride", () => {
  test("OWNER comment with 'break glass' → returns {commentId, authorAssociation:'OWNER'}", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            {
              id: 101,
              body: "break glass abc1234def56",
              author_association: "OWNER",
            },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "101", authorAssociation: "OWNER" });
  });

  test("MEMBER comment with 'break glass' → returns authorAssociation:'MEMBER'", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            {
              id: 202,
              body: "break glass abc1234def56\n\nSee incident #42.",
              author_association: "MEMBER",
            },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "202", authorAssociation: "MEMBER" });
  });

  test("COLLABORATOR comment → returns authorAssociation:'COLLABORATOR'", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            { id: 303, body: "break glass abc1234def56", author_association: "COLLABORATOR" },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "303", authorAssociation: "COLLABORATOR" });
  });

  test("CONTRIBUTOR comment with 'break glass' → undefined (untrusted association)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            { id: 404, body: "break glass abc1234def56", author_association: "CONTRIBUTOR" },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("NONE association → undefined (untrusted)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            { id: 505, body: "break glass abc1234def56", author_association: "NONE" },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("comment missing author_association → undefined", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([{ id: 606, body: "break glass abc1234def56" }]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("comment containing bot marker '<!-- code-reviewer' even by OWNER → undefined (bot comment excluded)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            {
              id: 707,
              body: "break glass abc1234def56\n<!-- code-reviewer\n{}\n-->",
              author_association: "OWNER",
            },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("most-recent qualifying comment wins when several qualify", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            { id: 100, body: "break glass abc1234def56", author_association: "OWNER" },
            { id: 200, body: "some other comment", author_association: "OWNER" },
            { id: 300, body: "break glass abc1234def56", author_association: "MEMBER" },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    // Comment 300 is the last qualifying comment
    expect(result).toEqual({ commentId: "300", authorAssociation: "MEMBER" });
  });

  test("no qualifying comments → undefined", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            { id: 111, body: "looks good to me", author_association: "OWNER" },
            { id: 222, body: "break glass abc1234def56", author_association: "CONTRIBUTOR" },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("empty comments list → undefined", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("fetch throws → returns undefined (best-effort, never throws)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () => {
        throw new Error("network failure");
      },
    });

    // Must not throw — best-effort detection degrades to undefined.
    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("fetch returns non-2xx error response → returns undefined (best-effort)", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "Unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("'break-glass' hyphenated form is also recognized", async () => {
    const adapter = new GitHubVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === commentsUrl) {
          return jsonResponse([
            { id: 808, body: "break-glass abc1234def56", author_association: "OWNER" },
          ]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "808", authorAssociation: "OWNER" });
  });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
  });
}

function notFound(url: string): Response {
  return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
    status: 404,
    statusText: "Not Found",
  });
}
