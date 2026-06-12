import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import {
  createDefaultReviewConfig,
  decideCiOutcome,
  DummyAgentRuntime,
  formatReviewSummaryMarkdown,
  GitHubVcsAdapter,
  GitLabVcsAdapter,
  loadReviewFixture,
  runReviewFromChange,
} from "../src/index.ts";
import type { ChangeRef, FetchLike, GitLabFetchLike } from "../src/index.ts";

describe("adapter-backed review composition", () => {
  test("GitHub adapter output feeds review runner, prior state, markdown, and CI decision", async () => {
    const seed = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const adapter = new GitHubVcsAdapter({ fetch: githubFixtureFetch() });
    const ref: ChangeRef = {
      provider: "github",
      repository: {
        provider: "github",
        owner: "example",
        name: "payments-api",
        slug: "example/payments-api",
      },
      changeId: "42",
      headSha: "unknown",
    };
    const [metadata, diff, priorState] = await Promise.all([
      adapter.getChange(ref),
      adapter.getDiff(ref),
      adapter.getPriorReviewState(ref),
    ]);
    const config = {
      ...createDefaultReviewConfig(),
      mode: "blocking" as const,
      failOn: ["critical" as const],
    };
    const runtime = new DummyAgentRuntime({ defaultFindings: seed.fakeFindings ?? [] });

    const result = await runReviewFromChange({
      runId: "adapter-github",
      metadata,
      diff,
      config,
      ...(priorState !== undefined ? { priorState } : {}),
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });
    const markdown = formatReviewSummaryMarkdown(result.summary);
    const decision = decideCiOutcome(result.summary, config);

    expect(result.context.metadata.webUrl).toBe("https://github.com/example/payments-api/pull/42");
    expect(result.context.diff.files.map((file) => file.path)).toContain("src/auth/accounts.ts");
    expect(result.context.priorState?.previousRunId).toBe("prior-github-run");
    expect(result.context.priorState?.findings.map((finding) => finding.stableId)).toEqual(["fnd_prior_github"]);
    expect(result.summary.decision).toBe("significant_concerns");
    expect(markdown).toContain("Account lookup misses authorization");
    expect(decision.exitCode).toBe(1);
  });

  test("GitLab adapter output feeds review runner, prior state, markdown, and CI decision", async () => {
    const seed = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const adapter = new GitLabVcsAdapter({ fetch: gitlabFixtureFetch() });
    const ref: ChangeRef = {
      provider: "gitlab",
      repository: {
        provider: "gitlab",
        owner: "example",
        name: "payments-api",
        slug: "example/payments-api",
      },
      changeId: "7",
      headSha: "unknown",
    };
    const [metadata, diff, priorState] = await Promise.all([
      adapter.getChange(ref),
      adapter.getDiff(ref),
      adapter.getPriorReviewState(ref),
    ]);
    const config = {
      ...createDefaultReviewConfig(),
      mode: "blocking" as const,
      failOn: ["critical" as const],
    };
    // The GitLab fixture diff is trivial-tier (≤5 files, ≤25 lines, no sensitive paths).
    // On trivial tier only code_quality runs, so use code_quality-labelled findings.
    const gitlabFindings = (seed.fakeFindings ?? []).map((f) => ({ ...f, reviewer: "code_quality" as const }));
    const runtime = new DummyAgentRuntime({ defaultFindings: gitlabFindings });

    const result = await runReviewFromChange({
      runId: "adapter-gitlab",
      metadata,
      diff,
      config,
      ...(priorState !== undefined ? { priorState } : {}),
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });
    const markdown = formatReviewSummaryMarkdown(result.summary);
    const decision = decideCiOutcome(result.summary, config);

    expect(result.context.metadata.webUrl).toBe("https://gitlab.com/example/payments-api/-/merge_requests/7");
    expect(result.context.diff.files.map((file) => file.path)).toContain("src/auth/accounts.ts");
    expect(result.context.priorState?.previousRunId).toBe("prior-gitlab-run");
    expect(result.context.priorState?.findings.map((finding) => finding.stableId)).toEqual(["fnd_prior_gitlab"]);
    expect(result.summary.decision).toBe("significant_concerns");
    expect(markdown).toContain("Account lookup misses authorization");
    expect(decision.exitCode).toBe(1);
  });
});

function githubFixtureFetch(): FetchLike {
  return async (input) => {
    const url = String(input);

    if (url === "https://api.github.com/repos/example/payments-api/pulls/42") {
      return jsonResponse(await readFixture("github", "pull.json"));
    }

    if (url === "https://api.github.com/repos/example/payments-api/pulls/42/files?per_page=100") {
      return jsonResponse(await readFixture("github", "files-page-1.json"), {
        link: '<https://api.github.com/repositories/1/pulls/42/files?per_page=100&page=2>; rel="next"',
      });
    }

    if (url === "https://api.github.com/repositories/1/pulls/42/files?per_page=100&page=2") {
      return jsonResponse(await readFixture("github", "files-page-2.json"));
    }

    if (url === "https://api.github.com/repos/example/payments-api/issues/42/comments?per_page=100") {
      return jsonResponse([{
        id: 123,
        body: [
          "<!-- ai-code-review-factory",
          JSON.stringify({
            schemaVersion: 1,
            runId: "prior-github-run",
            headSha: "old-github-head",
            findingIds: ["fnd_prior_github"],
          }),
          "-->",
        ].join("\n"),
      }]);
    }

    return notFound(url);
  };
}

function gitlabFixtureFetch(): GitLabFetchLike {
  return async (input) => {
    const url = String(input);

    if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7") {
      return jsonResponse(await readFixture("gitlab", "merge-request.json"));
    }

    if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/changes") {
      return jsonResponse(await readFixture("gitlab", "changes.json"));
    }

    if (url === "https://gitlab.com/api/v4/projects/example%2Fpayments-api/merge_requests/7/notes") {
      return jsonResponse([{
        id: 123,
        body: [
          "<!-- ai-code-review-factory",
          JSON.stringify({
            schemaVersion: 1,
            runId: "prior-gitlab-run",
            headSha: "old-gitlab-head",
            findingIds: ["fnd_prior_gitlab"],
          }),
          "-->",
        ].join("\n"),
      }]);
    }

    return notFound(url);
  };
}

async function readFixture(provider: "github" | "gitlab", filename: string): Promise<unknown> {
  return JSON.parse(await readFile(`test/fixtures/${provider}/${filename}`, "utf8")) as unknown;
}

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    statusText: "OK",
    headers,
  });
}

function notFound(url: string): Response {
  return new Response(JSON.stringify({ message: `unexpected url: ${url}` }), {
    status: 404,
    statusText: "Not Found",
  });
}
