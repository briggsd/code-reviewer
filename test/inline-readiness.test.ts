import { describe, expect, test } from "bun:test";
import type { ChangeMetadata, DiffSummary, Finding } from "../src/index.ts";
import { evaluateInlinePublishReadiness } from "../src/index.ts";

const change: ChangeMetadata = {
  provider: "github",
  repository: {
    provider: "github",
    owner: "example",
    name: "demo",
    slug: "example/demo",
  },
  changeId: "7",
  headSha: "head-1",
  title: "Example PR",
  author: { username: "laszlo" },
  labels: [],
};

const diff: DiffSummary = {
  totalAdditions: 2,
  totalDeletions: 1,
  truncated: false,
  files: [
    {
      path: "src/auth.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      isBinary: false,
      patch: [
        "@@ -10,4 +10,5 @@ export function check(user) {",
        " const account = getAccount();",
        "-return account.owner === user.id;",
        "+if (!user) return false;",
        "+return account.owner === user.id;",
        " }",
      ].join("\n"),
    },
  ],
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Auth check changed",
    body: "The auth check changed and needs attention.",
    location: {
      path: "src/auth.ts",
      line: 12,
      side: "RIGHT",
    },
    confidence: "high",
    evidence: ["The patch changes the auth return path."],
    recommendation: "Verify the new auth behavior.",
    ...overrides,
  };
}

describe("inline publishing readiness", () => {
  test("allows findings with fresh head sha and verified right-side patch coordinates", () => {
    const readiness = evaluateInlinePublishReadiness({
      change,
      diff,
      findings: [finding()],
      expectedHeadSha: "head-1",
    });

    expect(readiness.canPublishInline).toBe(true);
    expect(readiness.readyFindings).toHaveLength(1);
    expect(readiness.blockedFindings).toHaveLength(0);
  });

  test("blocks all findings when the review was generated for a stale head sha", () => {
    const readiness = evaluateInlinePublishReadiness({
      change,
      diff,
      findings: [finding()],
      expectedHeadSha: "older-head",
    });

    expect(readiness.canPublishInline).toBe(false);
    expect(readiness.blockedFindings[0]?.reasons).toContain("stale_head_sha");
  });

  test("blocks truncated diffs even when an individual coordinate looks valid", () => {
    const readiness = evaluateInlinePublishReadiness({
      change,
      diff: { ...diff, truncated: true, truncationReason: "provider omitted patch data" },
      findings: [finding()],
      expectedHeadSha: "head-1",
    });

    expect(readiness.canPublishInline).toBe(false);
    expect(readiness.blockedFindings[0]?.reasons).toContain("diff_truncated");
  });

  test("requires explicit line and side coordinates", () => {
    const readiness = evaluateInlinePublishReadiness({
      change,
      diff,
      findings: [finding({ location: { path: "src/auth.ts" } })],
      expectedHeadSha: "head-1",
    });

    expect(readiness.canPublishInline).toBe(false);
    expect(readiness.blockedFindings[0]?.reasons).toContain("missing_line");
    expect(readiness.blockedFindings[0]?.reasons).toContain("missing_side");
  });

  test("blocks coordinates that are not present in the provider patch", () => {
    const readiness = evaluateInlinePublishReadiness({
      change,
      diff,
      findings: [finding({ location: { path: "src/auth.ts", line: 99, side: "RIGHT" } })],
      expectedHeadSha: "head-1",
    });

    expect(readiness.canPublishInline).toBe(false);
    expect(readiness.blockedFindings[0]?.reasons).toContain("line_not_in_patch");
  });

  test("blocks missing patches and deleted-file right-side comments", () => {
    const readiness = evaluateInlinePublishReadiness({
      change,
      diff: {
        ...diff,
        files: [
          {
            path: "src/old-auth.ts",
            status: "deleted",
            additions: 0,
            deletions: 10,
            isBinary: false,
          },
        ],
      },
      findings: [finding({ location: { path: "src/old-auth.ts", line: 3, side: "RIGHT" } })],
      expectedHeadSha: "head-1",
    });

    expect(readiness.canPublishInline).toBe(false);
    expect(readiness.blockedFindings[0]?.reasons).toContain("patch_missing");
    expect(readiness.blockedFindings[0]?.reasons).toContain("deleted_file_right_side");
  });
});
