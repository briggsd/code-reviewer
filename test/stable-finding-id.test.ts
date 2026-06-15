import { describe, expect, test } from "bun:test";
import type { Finding, ReviewSummary } from "../src/index.ts";
import {
  assignStableFindingIds,
  createStableFindingId,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";

const baseFinding: Finding = {
  reviewer: "security",
  severity: "critical",
  category: "auth",
  title: "Account lookup misses authorization",
  body: "The new lookup uses a request-supplied accountId without proving the caller can access that account.",
  location: {
    path: "./auth/accounts.ts",
    line: 23,
    side: "RIGHT",
  },
  confidence: "high",
  evidence: ["The patch returns db.accounts.findById(accountId) directly."],
  recommendation: "Check account ownership before returning account data.",
};

describe("stable finding IDs", () => {
  test("does not crash when a finding location is missing a string path", () => {
    // Defensive regression: fixture / prior-state findings bypass validateFinding, so a
    // location object without a string `path` reaching normalizePath used to throw.
    const id = createStableFindingId({
      ...baseFinding,
      location: { line: 5 } as unknown as NonNullable<Finding["location"]>,
    });
    expect(id).toMatch(/^fnd_[a-f0-9]{16}$/);
  });

  test("generates deterministic IDs from reviewer, category, and location", () => {
    const first = createStableFindingId(baseFinding);
    const second = createStableFindingId({
      ...baseFinding,
      location: {
        path: "auth/accounts.ts",
        line: 23,
        side: "RIGHT",
      },
    });

    expect(first).toMatch(/^fnd_[a-f0-9]{16}$/);
    expect(second).toBe(first);
    expect(
      createStableFindingId({
        ...baseFinding,
        location: {
          path: "auth/accounts.ts",
          line: 24,
          side: "RIGHT",
        },
      }),
    ).not.toBe(first);
  });

  test("ignores reworded title/body so a recurring finding keeps its ID (issue #31)", () => {
    const first = createStableFindingId(baseFinding);
    const rewordedByModel = createStableFindingId({
      ...baseFinding,
      title: "Authorization check missing on account lookup",
      body: "Caller can pass any accountId; ownership is never verified before the record is returned.",
    });

    expect(rewordedByModel).toBe(first);
  });

  test("distinguishes findings that differ only in reviewer or category", () => {
    const base = createStableFindingId(baseFinding);

    expect(createStableFindingId({ ...baseFinding, reviewer: "correctness" })).not.toBe(base);
    expect(createStableFindingId({ ...baseFinding, category: "authz" })).not.toBe(base);
  });

  test("preserves IDs supplied by runtimes or adapters", () => {
    const summary: ReviewSummary = {
      decision: "significant_concerns",
      outcome: "fail",
      title: "Finding",
      body: "Review body",
      risk: {
        tier: "full",
        reason: "Sensitive auth change",
        matchedRules: ["sensitive_paths"],
        sensitivePaths: ["auth/accounts.ts"],
        reviewedFileCount: 1,
        ignoredFileCount: 0,
      },
      findings: [{ ...baseFinding, id: "runtime-provided-id" }],
    };

    expect(assignStableFindingIds(summary).findings[0]?.id).toBe("runtime-provided-id");
  });

  const collidingSummary = (findings: Finding[]): ReviewSummary => ({
    decision: "significant_concerns",
    outcome: "fail",
    title: "Finding",
    body: "Review body",
    risk: {
      tier: "full",
      reason: "Sensitive auth change",
      matchedRules: ["sensitive_paths"],
      sensitivePaths: ["auth/accounts.ts"],
      reviewedFileCount: 1,
      ignoredFileCount: 0,
    },
    findings,
  });

  test("disambiguates findings that collide on reviewer+category+location within a summary", () => {
    const ids = assignStableFindingIds(
      collidingSummary([
        { ...baseFinding, title: "First concern" },
        { ...baseFinding, title: "Second concern at same spot" },
      ]),
    ).findings.map((finding) => finding.id);

    expect(new Set(ids).size).toBe(2);
    expect(ids).toContain(createStableFindingId(baseFinding));
    expect(ids).toContain(`${createStableFindingId(baseFinding)}#2`);
  });

  test("assigns collision ordinals by content, independent of emission order", () => {
    const a = { ...baseFinding, title: "Alpha concern" };
    const b = { ...baseFinding, title: "Beta concern" };

    const forward = assignStableFindingIds(collidingSummary([a, b])).findings;
    const reversed = assignStableFindingIds(collidingSummary([b, a])).findings;

    // Same content → same ID regardless of which order the model emitted them.
    const idOf = (findings: typeof forward, title: string) =>
      findings.find((f) => f.title === title)?.id;
    expect(idOf(forward, "Alpha concern")).toBe(idOf(reversed, "Alpha concern"));
    expect(idOf(forward, "Beta concern")).toBe(idOf(reversed, "Beta concern"));
  });

  test("generated collision ordinals never duplicate a pre-assigned ID", () => {
    const baseId = createStableFindingId(baseFinding);
    const ids = assignStableFindingIds(
      collidingSummary([
        { ...baseFinding, id: `${baseId}#2`, title: "Pre-assigned at the ordinal slot" },
        { ...baseFinding, title: "Generated one" },
        { ...baseFinding, title: "Generated two" },
      ]),
    ).findings.map((finding) => finding.id);

    // Three distinct IDs: the reserved `#2` is skipped, so generated findings
    // take the base ID and `#3` rather than silently colliding.
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain(`${baseId}#2`);
    expect(ids).toContain(baseId);
    expect(ids).toContain(`${baseId}#3`);
  });

  test("runner assigns stable IDs to completed summaries", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
    const result = await runReview({ fixture, now: new Date("2026-06-09T00:00:00.000Z") });

    expect(result.summary.findings[0]?.id).toMatch(/^fnd_[a-f0-9]{16}$/);
  });

  // --- #148 line-drift regression tests ---

  const lineSpecificFinding: Finding = {
    ...baseFinding,
    quotedCode: ["const user = db.accounts.findById(accountId);"],
  };

  test("#148 regression: line drift does not re-mint finding identity (same quotedCode, different line/endLine → same ID)", () => {
    // Simulates an earlier-hunk shift: the flagged code is unchanged but its
    // absolute line number moved (e.g. lines 23→45 after a preceding hunk grew).
    const atLine23 = createStableFindingId({
      ...lineSpecificFinding,
      location: { path: "auth/accounts.ts", line: 23, endLine: 23, side: "RIGHT" },
    });
    const atLine45 = createStableFindingId({
      ...lineSpecificFinding,
      location: { path: "auth/accounts.ts", line: 45, endLine: 45, side: "RIGHT" },
    });

    // Core invariant: same flagged content at different line numbers → same ID.
    expect(atLine23).toMatch(/^fnd_[a-f0-9]{16}$/);
    expect(atLine45).toBe(atLine23);
  });

  test("#148 content sensitivity: different quotedCode produces different IDs", () => {
    const findingA = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["const user = db.accounts.findById(accountId);"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });
    const findingB = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["const user = db.accounts.findByEmail(email);"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });

    expect(findingA).not.toBe(findingB);
  });

  test("#148 architectural fallback unchanged: no quotedCode still keys on line numbers (different lines → different IDs)", () => {
    // Absence/architectural findings have no quotedCode — they must remain
    // line-sensitive because they have no content anchor.
    const atLine10 = createStableFindingId({
      ...baseFinding,
      // baseFinding has no quotedCode — fallback path
      location: { path: "auth/accounts.ts", line: 10, endLine: 10, side: "RIGHT" },
    });
    const atLine20 = createStableFindingId({
      ...baseFinding,
      location: { path: "auth/accounts.ts", line: 20, endLine: 20, side: "RIGHT" },
    });

    expect(atLine10).not.toBe(atLine20);
  });

  test("#148 whitespace tolerance: quotedCode differing only in indentation produces the same ID", () => {
    const compact = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["const user = db.accounts.findById(accountId);"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });
    const indented = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["  const user = db.accounts.findById(accountId);  "],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });
    // Multi-line indentation tolerance: leading spaces on each line are also trimmed.
    const multiLineIndented = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["  const user = db.accounts.findById(accountId);"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });

    expect(compact).toBe(indented);
    expect(compact).toBe(multiLineIndented);
  });

  test("#148 case sensitivity: quotedCode differing only in identifier case produces different IDs", () => {
    // Security path: a stableFindingId-pinned acknowledgement must NOT absorb a
    // case-variant new finding (e.g. admin vs Admin are distinct in source code).
    const lowercase = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["const admin = checkRole()"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });
    const capitalized = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["const Admin = checkRole()"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });

    expect(lowercase).not.toBe(capitalized);
  });

  test("#148 multi-line vs single-line: different quotedCode arrangements produce different IDs", () => {
    // ["const x =", "1;"] must not hash identically to ["const x = 1;"].
    const multiLine = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["const x =", "1;"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });
    const singleLine = createStableFindingId({
      ...lineSpecificFinding,
      quotedCode: ["const x = 1;"],
      location: { path: "auth/accounts.ts", line: 23, side: "RIGHT" },
    });

    expect(multiLine).not.toBe(singleLine);
  });
});
