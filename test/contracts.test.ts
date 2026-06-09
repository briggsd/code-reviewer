import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import type { AgentRuntime, ChangeMetadata, Finding, ReviewSummary } from "../src/index.ts";
import { reviewConfigSchema, reviewOutputSchemas } from "../src/index.ts";

describe("contract exports", () => {
  test("finding, reviewer, coordinator, and config schemas are exported", () => {
    expect(Object.keys(reviewOutputSchemas)).toEqual(["finding", "reviewer", "coordinator"]);
    expect(reviewOutputSchemas.finding.required).toContain("severity");
    expect(reviewOutputSchemas.reviewer.required).toEqual(["findings"]);
    expect(reviewOutputSchemas.coordinator.required).toContain("decision");
    expect(reviewConfigSchema.properties?.mode?.enum).toEqual(["advisory", "blocking"]);
    expect("required" in (reviewConfigSchema.properties?.modelRouting ?? {})).toBe(false);
  });

  test("core types can describe a normalized review result", () => {
    const metadata: ChangeMetadata = {
      provider: "github",
      repository: {
        provider: "github",
        owner: "example",
        name: "demo",
        slug: "example/demo",
      },
      changeId: "42",
      headSha: "abc123",
      title: "Tighten auth checks",
      author: {
        username: "laszlo",
      },
      labels: ["security"],
    };

    const finding: Finding = {
      reviewer: "security",
      severity: "critical",
      category: "auth",
      title: "Missing authorization check",
      body: "The changed endpoint accepts authenticated users but does not verify ownership.",
      location: {
        path: "src/auth.ts",
        line: 27,
        side: "RIGHT",
      },
      confidence: "high",
      evidence: ["The handler reads user-controlled accountId without an ownership check."],
      recommendation: "Check account ownership before returning account data.",
    };

    const summary: ReviewSummary = {
      decision: "significant_concerns",
      outcome: "fail",
      title: "AI review found a blocking auth issue",
      body: "One critical finding needs human attention before merge.",
      findings: [finding],
      risk: {
        tier: "full",
        reason: "Security-sensitive auth path changed.",
        matchedRules: ["sensitive_paths"],
        sensitivePaths: ["src/auth.ts"],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
    };

    expect(metadata.repository.slug).toBe("example/demo");
    expect(summary.findings[0]?.severity).toBe("critical");
  });

  test("checked-in config schema artifact matches the exported schema", async () => {
    const artifact = JSON.parse(await readFile(".ai-review.schema.json", "utf8")) as unknown;

    expect(artifact).toEqual(reviewConfigSchema);
  });

  test("agent runtime contract supports coordinator and reviewer boundaries", () => {
    const runtimeName: AgentRuntime["name"] = "dummy";

    expect(runtimeName).toBe("dummy");
  });
});
