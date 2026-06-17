import { describe, expect, test } from "bun:test";
import type { ChangeRef } from "../src/index.ts";
import { GitLabVcsAdapter } from "../src/index.ts";

const changeRef: ChangeRef = {
  provider: "gitlab",
  repository: {
    provider: "gitlab",
    owner: "example",
    name: "payments-api",
    slug: "example/payments-api",
  },
  changeId: "7",
  headSha: "abc1234def567890",
};

const notesUrl = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes";
const membersUrlBase = "https://gitlab.com/api/v4/projects/example%2Fpayments-api/members/all";

describe("GitLabVcsAdapter.detectBreakGlassOverride", () => {
  test("Developer (30) author → returns {commentId, authorAssociation:'COLLABORATOR'}", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([{ id: 501, body: "break glass abc1234def56", author: { id: 10 } }]);
        }
        if (url === `${membersUrlBase}/10`) {
          return jsonResponse({ id: 10, access_level: 30 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "501", authorAssociation: "COLLABORATOR" });
  });

  test("Maintainer (40) author → authorAssociation:'MEMBER'", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([{ id: 502, body: "break glass abc1234def56", author: { id: 20 } }]);
        }
        if (url === `${membersUrlBase}/20`) {
          return jsonResponse({ id: 20, access_level: 40 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "502", authorAssociation: "MEMBER" });
  });

  test("Owner (50) author → authorAssociation:'OWNER'", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([{ id: 503, body: "break glass abc1234def56", author: { id: 30 } }]);
        }
        if (url === `${membersUrlBase}/30`) {
          return jsonResponse({ id: 30, access_level: 50 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "503", authorAssociation: "OWNER" });
  });

  test("Reporter (20) author → undefined (access level below threshold)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([{ id: 504, body: "break glass abc1234def56", author: { id: 40 } }]);
        }
        if (url === `${membersUrlBase}/40`) {
          return jsonResponse({ id: 40, access_level: 20 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("Guest (10) author → undefined", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([{ id: 505, body: "break glass abc1234def56", author: { id: 50 } }]);
        }
        if (url === `${membersUrlBase}/50`) {
          return jsonResponse({ id: 50, access_level: 10 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("system: true note is ignored even if it has the marker", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([
            { id: 506, body: "break glass abc1234def56", author: { id: 60 }, system: true },
          ]);
        }
        // members API should NOT be called — the note is skipped before the lookup
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("bot summary note (contains '<!-- code-reviewer') is ignored by OWNER-level author", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([
            {
              id: 507,
              body: "break glass abc1234def56\n<!-- code-reviewer\n{}\n-->",
              author: { id: 70 },
            },
          ]);
        }
        if (url === `${membersUrlBase}/70`) {
          return jsonResponse({ id: 70, access_level: 50 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("members API returns 404 for the author → that candidate skipped → undefined", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([{ id: 508, body: "break glass abc1234def56", author: { id: 80 } }]);
        }
        if (url === `${membersUrlBase}/80`) {
          return new Response(JSON.stringify({ message: "404 Not Found" }), {
            status: 404,
            statusText: "Not Found",
          });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("most-recent qualifying note wins (notes are reversed, first match returned)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([
            { id: 601, body: "break glass abc1234def56", author: { id: 91 } },
            { id: 602, body: "some other note", author: { id: 91 } },
            { id: 603, body: "break glass abc1234def56", author: { id: 92 } },
          ]);
        }
        if (url === `${membersUrlBase}/91`) {
          return jsonResponse({ id: 91, access_level: 40 });
        }
        if (url === `${membersUrlBase}/92`) {
          return jsonResponse({ id: 92, access_level: 30 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    // Note 603 is last in original order → first in reversed iteration → first match returned
    expect(result).toEqual({ commentId: "603", authorAssociation: "COLLABORATOR" });
  });

  test("no qualifying notes → undefined", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([
            { id: 700, body: "LGTM!", author: { id: 11 } },
            { id: 701, body: "break glass abc1234def56", author: { id: 12 } },
          ]);
        }
        // note 701 author has Reporter access
        if (url === `${membersUrlBase}/12`) {
          return jsonResponse({ id: 12, access_level: 20 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("empty notes list → undefined", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("fetch throws → returns undefined (best-effort, never throws)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () => {
        throw new Error("network failure");
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("notes fetch returns non-2xx → returns undefined (best-effort)", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async () =>
        new Response(JSON.stringify({ message: "401 Unauthorized" }), {
          status: 401,
          statusText: "Unauthorized",
        }),
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("note without author (no id) is skipped silently", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          // Note has no author id at all
          return jsonResponse([{ id: 800, body: "break glass abc1234def56" }]);
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toBeUndefined();
  });

  test("'break-glass' hyphenated form is also recognized", async () => {
    const adapter = new GitLabVcsAdapter({
      fetch: async (input) => {
        const url = String(input);
        if (url === notesUrl) {
          return jsonResponse([{ id: 900, body: "break-glass abc1234def56", author: { id: 99 } }]);
        }
        if (url === `${membersUrlBase}/99`) {
          return jsonResponse({ id: 99, access_level: 50 });
        }
        return notFound(url);
      },
    });

    const result = await adapter.detectBreakGlassOverride(changeRef);

    expect(result).toEqual({ commentId: "900", authorAssociation: "OWNER" });
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
