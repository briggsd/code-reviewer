import { describe, expect, test } from "bun:test";
import type { Finding, ReviewerRunResult } from "../src/index.ts";
import {
  COMPREHENSION_ROLE,
  comprehensionReviewerRan,
  createPublishHiddenMetadata,
  DummyAgentRuntime,
  deriveGateDecision,
  formatReviewSummaryMarkdown,
  normalizeReviewFixture,
  runReview,
  selectComprehensionGateFindings,
} from "../src/index.ts";

function finding(severity: Finding["severity"], reviewer = COMPREHENSION_ROLE): Finding {
  return {
    reviewer,
    severity,
    category: "comprehension",
    title: `${severity} gap`,
    body: "A senior engineer cannot explain this without running it.",
    confidence: "high",
    evidence: ["The changed control flow has no explanation."],
    recommendation: "Document the intent.",
  };
}

function reviewerResult(role: string, findings: Finding[]): ReviewerRunResult {
  return { runId: "r", agentRunId: `r:${role}`, role, findings };
}

describe("deriveGateDecision (#26)", () => {
  test("no comprehension findings → allow", () => {
    expect(deriveGateDecision([])).toBe("allow");
  });

  test("only suggestions → warn", () => {
    expect(deriveGateDecision([finding("suggestion"), finding("suggestion")])).toBe("warn");
  });

  test("any warning → block", () => {
    expect(deriveGateDecision([finding("suggestion"), finding("warning")])).toBe("block");
  });

  test("any critical → block", () => {
    expect(deriveGateDecision([finding("critical")])).toBe("block");
  });

  test("fails toward surfacing: an unrecognized severity yields warn, never silent allow", () => {
    const weird = { ...finding("suggestion"), severity: "info" as Finding["severity"] };
    expect(deriveGateDecision([weird])).toBe("warn");
  });
});

describe("comprehensionReviewerRan (#26)", () => {
  test("true only when a result carries the dispatched comprehension role (not a label)", () => {
    // A non-comprehension run never shows a verdict, even if a finding is mislabeled comprehension.
    expect(
      comprehensionReviewerRan([
        reviewerResult("security", [finding("warning", COMPREHENSION_ROLE)]),
      ]),
    ).toBe(false);
    expect(comprehensionReviewerRan([reviewerResult(COMPREHENSION_ROLE, [])])).toBe(true);
  });
});

describe("selectComprehensionGateFindings (#26)", () => {
  test("keeps comprehension-attributed findings and drops acknowledged + other-role ones", () => {
    const acked: Finding = { ...finding("warning"), acknowledged: { reason: "known" } };
    const selected = selectComprehensionGateFindings([
      finding("suggestion"),
      acked,
      finding("warning", "security"),
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.severity).toBe("suggestion");
  });

  test("attributes by label — over-counting bound is intentional (observability-only)", () => {
    // A finding the model labels `comprehension` is counted regardless of which reviewer truly
    // produced it. This is the accepted, documented over-counting bound: it can skew the verdict
    // but never CI (decideCiOutcome reads all findings by severity, not by this label).
    const mislabeledFromAnotherReviewer = finding("warning", COMPREHENSION_ROLE);
    expect(selectComprehensionGateFindings([mislabeledFromAnotherReviewer])).toHaveLength(1);
    // And a genuine comprehension gap mislabeled to another role is under-counted (skews allow).
    expect(selectComprehensionGateFindings([finding("warning", "security")])).toHaveLength(0);
  });
});

describe("comprehension gate end-to-end (#26)", () => {
  // Lite tier (2 files / 30 lines, no sensitive path) so the opt-in comprehension reviewer is
  // selected (the trivial roleCap would exclude it).
  function liteComprehensionFixture() {
    return normalizeReviewFixture({
      config: { reviewerPolicy: { comprehension: "enabled" } },
      metadata: {
        provider: "local",
        repository: { provider: "local", name: "demo", slug: "demo" },
        changeId: "local",
        headSha: "abc123",
        title: "Moderate change",
        author: { username: "dev" },
        labels: [],
      },
      diff: {
        files: [
          { path: "src/a.ts", status: "modified", additions: 20, deletions: 0, isBinary: false },
          { path: "src/b.ts", status: "modified", additions: 10, deletions: 0, isBinary: false },
        ],
        totalAdditions: 30,
        totalDeletions: 0,
        truncated: false,
      },
    });
  }

  test("a comprehension suggestion surfaces a `warn` verdict in summary, render, and metadata", async () => {
    const runtime = new DummyAgentRuntime({
      findingsByRole: { [COMPREHENSION_ROLE]: [finding("suggestion")] },
    });
    const result = await runReview({
      fixture: liteComprehensionFixture(),
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(result.summary.gateDecision).toBe("warn");
    expect(formatReviewSummaryMarkdown(result.summary)).toContain("🚦 Comprehension gate: `warn`");

    const metadata = createPublishHiddenMetadata(
      "run-1",
      {
        provider: "local",
        repository: { provider: "local", name: "demo", slug: "demo" },
        changeId: "local",
        headSha: "abc123",
        title: "Moderate change",
        author: { username: "dev" },
        labels: [],
      },
      result.summary,
    );
    expect(metadata.gateDecision).toBe("warn");
  });

  test("an acknowledged comprehension finding is excluded from the verdict (post-ack consistency)", async () => {
    // Two comprehension findings: a `warning` on src/a.ts (acknowledged) and a `suggestion` on
    // src/b.ts (not). Raw derivation would see the warning and say `block`; the post-ack verdict
    // excludes the acknowledged warning, leaving only the suggestion → `warn`.
    const located = (severity: Finding["severity"], path: string): Finding => ({
      ...finding(severity),
      location: { path, line: 1, side: "RIGHT" },
    });
    const fixture = normalizeReviewFixture({
      ...liteComprehensionFixture(),
      config: {
        reviewerPolicy: { comprehension: "enabled" },
        acknowledgements: [
          { path: "src/a.ts", mode: "acknowledge", reason: "known gap, accepted" },
        ],
      },
    });
    const runtime = new DummyAgentRuntime({
      findingsByRole: {
        [COMPREHENSION_ROLE]: [located("warning", "src/a.ts"), located("suggestion", "src/b.ts")],
      },
    });

    const result = await runReview({
      fixture,
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(result.summary.gateDecision).toBe("warn");
  });

  test("a comprehension finding withheld by grounding does not inflate the verdict", async () => {
    // The reviewer emits a `warning` whose quotedCode cites code absent from the diff; grounding
    // withholds it from the summary. The verdict is computed from the gated set, so it stays `allow`
    // (consistent with the displayed findings) rather than a phantom `block`.
    const grounded: Finding = {
      ...finding("warning"),
      location: { path: "src/a.ts", line: 1, side: "RIGHT" },
      quotedCode: ["const neverInThisDiff = true;"],
    };
    const runtime = new DummyAgentRuntime({
      findingsByRole: { [COMPREHENSION_ROLE]: [grounded] },
    });
    const result = await runReview({
      fixture: liteComprehensionFixture(),
      runtime,
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(result.summary.findings).toHaveLength(0);
    expect(result.summary.gateDecision).toBe("allow");
  });

  test("full_only on a lite-tier diff produces no verdict (roster cap excludes it)", async () => {
    // The documented cost-bounding config: `full_only` runs only on full-tier diffs, so on a
    // lite-tier diff the comprehension reviewer never dispatches and no verdict is shown.
    const fixture = normalizeReviewFixture({
      ...liteComprehensionFixture(),
      config: { reviewerPolicy: { comprehension: "full_only" } },
    });
    const result = await runReview({
      fixture,
      runtime: new DummyAgentRuntime({
        findingsByRole: { [COMPREHENSION_ROLE]: [finding("warning")] },
      }),
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(result.summary.gateDecision).toBeUndefined();
    expect(formatReviewSummaryMarkdown(result.summary)).not.toContain("Comprehension gate");
  });

  test("no verdict when the comprehension reviewer is not enabled", async () => {
    const fixture = liteComprehensionFixture();
    const without = normalizeReviewFixture({
      ...fixture,
      config: { reviewerPolicy: { comprehension: "disabled" } },
    });
    const result = await runReview({
      fixture: without,
      runtime: new DummyAgentRuntime(),
      now: new Date("2026-06-09T00:00:00.000Z"),
    });

    expect(result.summary.gateDecision).toBeUndefined();
    expect(formatReviewSummaryMarkdown(result.summary)).not.toContain("Comprehension gate");
  });
});
