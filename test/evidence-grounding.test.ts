import { describe, expect, test } from "bun:test";
import type { DiffSummary, Finding } from "../src/contracts/index.ts";
import { assessFindingGrounding } from "../src/runner/evidence-grounding.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDiff(patch: string): DiffSummary {
  return {
    files: [
      {
        path: "auth/accounts.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        isBinary: false,
        patch,
      },
    ],
    totalAdditions: 1,
    totalDeletions: 0,
    truncated: false,
  };
}

function makeFinding(overrides: Partial<Finding>): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Test finding",
    body: "body text",
    confidence: "high",
    evidence: ["some evidence"],
    recommendation: "fix it",
    location: { path: "auth/accounts.ts" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assessFindingGrounding", () => {
  test("finding with quotedCode matching a patch line → grounded", () => {
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({
      quotedCode: ["return db.accounts.findById(accountId);"],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
    expect(result.grounded[0]).toBe(finding);
  });

  test("finding with quotedCode NOT in any patch (fabricated) → dropped", () => {
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({
      severity: "critical",
      quotedCode: ["return db.accounts.deleteEverything();"],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(0);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toBe(finding);
  });

  test("fabricated quote containing U+200B → dropped (U+200B not in \\s, so not collapsed)", () => {
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    // U+200B (zero-width space) is intentionally not matched by \s+ normalization
    const finding = makeFinding({
      quotedCode: ["return​db.accounts.findById(accountId);"],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.dropped).toHaveLength(1);
    expect(result.grounded).toHaveLength(0);
  });

  test("finding with no quotedCode (undefined) → always kept (safety case)", () => {
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    // Evidence is prose, not in the diff — still kept
    const finding = makeFinding({
      evidence: ["This evidence text is definitely not in the diff at all."],
    });
    // no quotedCode property

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("finding with empty quotedCode array → always kept", () => {
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({ quotedCode: [] });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("finding with quotedCode entries all < 8 chars → always kept (sub-threshold)", () => {
    const diff = makeDiff("+  foo();");
    const finding = makeFinding({ quotedCode: ["foo()", "bar"] }); // both < 8 chars

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("finding with multiple quotedCode entries where ≥1 grounds → kept", () => {
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({
      quotedCode: [
        "return db.accounts.deleteEverything();", // fabricated
        "return db.accounts.findById(accountId);", // real
      ],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("whitespace-differing quote still grounds (normalization)", () => {
    // Patch has single spaces; quote has extra internal whitespace
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({
      quotedCode: ["return  db.accounts.findById(accountId);"], // extra space
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("corpus built from + prefixed lines matches quote without the +", () => {
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({
      quotedCode: ["return db.accounts.findById(accountId);"],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.dropped).toHaveLength(0);
  });

  test("diff scaffolding lines (@@, diff , index , --- , +++ ) are not matched", () => {
    // Trying to ground on the @@ header should fail (it's excluded from corpus)
    const diff = makeDiff(
      "@@ -20,6 +20,20 @@ export async function getAccount(req) {\n+  return real.code();",
    );
    const finding = makeFinding({
      quotedCode: ["-20,6 +20,20 @@ export async function getAccount"],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.dropped).toHaveLength(1);
    expect(result.grounded).toHaveLength(0);
  });

  test("removed (-) lines are included → a finding quoting a dangerous deletion grounds (kept)", () => {
    // A reviewer flagging a removed security check legitimately quotes the deleted line. The corpus
    // includes removed lines so that finding is NOT false-dropped (keeping is the safe direction).
    const diff = makeDiff("-  verifyToken(req);\n+  return db.accounts.findById(accountId);");
    const quotesRemoved = makeFinding({ quotedCode: ["verifyToken(req);"] });
    const quotesAdded = makeFinding({ quotedCode: ["return db.accounts.findById(accountId);"] });

    const result = assessFindingGrounding([quotesRemoved, quotesAdded], diff);

    expect(result.grounded).toContain(quotesRemoved);
    expect(result.grounded).toContain(quotesAdded);
    expect(result.dropped).toHaveLength(0);
  });

  test("multi-line quotedCode matches across lines (whole-corpus normalization); fabricated multi-line is dropped", () => {
    const diff = makeDiff(
      "+  const accountId = req.query.accountId;\n+  return db.accounts.findById(accountId);",
    );
    // A real multi-line span — its internal newline is collapsed to a space by normalize().
    const realSpan = makeFinding({
      quotedCode: [
        "const accountId = req.query.accountId;\n  return db.accounts.findById(accountId);",
      ],
    });
    const fabricatedSpan = makeFinding({
      quotedCode: ["const token = req.headers.auth;\n  return verifyAndLoad(token);"],
    });

    const result = assessFindingGrounding([realSpan, fabricatedSpan], diff);

    expect(result.grounded).toContain(realSpan);
    expect(result.dropped).toContain(fabricatedSpan);
  });

  test("truncated diff → findings with ungroundable quotedCode are kept (never drop on a partial corpus)", () => {
    const diff: DiffSummary = {
      ...makeDiff("+  something();"),
      truncated: true,
      truncationReason: "diff too large",
    };
    const finding = makeFinding({ quotedCode: ["return db.accounts.deleteEverything();"] });

    const result = assessFindingGrounding([finding], diff);

    expect(result.dropped).toHaveLength(0);
    expect(result.grounded).toContain(finding);
  });

  test("empty diff (no changed files) → grounding drops nothing", () => {
    // With no changed files, auth/accounts.ts is not in the changed-file set.
    // So findings pointing at it are not eligible to be dropped — they are always kept.
    const emptyDiff: DiffSummary = {
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    };
    const withQuote = makeFinding({ quotedCode: ["return db.accounts.findById(accountId);"] });
    const withoutQuote = makeFinding({});

    const result = assessFindingGrounding([withQuote, withoutQuote], emptyDiff);

    expect(result.dropped).toHaveLength(0);
    expect(result.grounded).toHaveLength(2);
    expect(result.grounded).toContain(withQuote);
    expect(result.grounded).toContain(withoutQuote);
  });

  test("file with undefined patch is skipped in corpus", () => {
    const diff: DiffSummary = {
      files: [
        {
          path: "auth/accounts.ts",
          status: "modified",
          additions: 0,
          deletions: 0,
          isBinary: false,
          // patch: undefined
        },
      ],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    };
    const finding = makeFinding({
      quotedCode: ["return db.accounts.findById(accountId);"],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.dropped).toHaveLength(1);
  });

  test("order of grounded findings is preserved", () => {
    const diff = makeDiff(
      "+  return db.accounts.findById(accountId);\n+  const x = doSomething();",
    );
    const f1 = makeFinding({
      title: "first",
      quotedCode: ["return db.accounts.findById(accountId);"],
    });
    const f2 = makeFinding({ title: "second", quotedCode: ["const x = doSomething();"] });
    const f3 = makeFinding({ title: "third" }); // no quotedCode

    const result = assessFindingGrounding([f1, f2, f3], diff);

    expect(result.grounded.map((f) => f.title)).toEqual(["first", "second", "third"]);
    expect(result.dropped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Changed-file scope gate (#73): findings NOT on a changed file are always kept
  // -------------------------------------------------------------------------

  test("staleness finding on an unchanged file → always kept (scope gate)", () => {
    // The diff only changes auth/accounts.ts; docs/reviewer-conventions.md is unchanged.
    // A staleness finding about docs is legitimate even if its quotedCode isn't in the diff.
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const staleness = makeFinding({
      location: { path: "docs/reviewer-conventions.md" },
      quotedCode: ["acknowledgements are NOT yet implemented"],
    });

    const result = assessFindingGrounding([staleness], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.grounded[0]).toBe(staleness);
    expect(result.dropped).toHaveLength(0);
  });

  test("no-location finding → always kept (scope gate)", () => {
    // A finding with no location is architectural / absence-style — cannot be scoped to a changed file.
    // Build directly (omitting location) — exactOptionalPropertyTypes prevents passing location: undefined
    // via makeFinding's Partial<Finding> overrides.
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const noLocation: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Test finding",
      body: "body text",
      confidence: "high",
      evidence: ["some evidence"],
      recommendation: "fix it",
      quotedCode: ["acknowledgements are NOT yet implemented"],
      // no location property
    };

    const result = assessFindingGrounding([noLocation], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.grounded[0]).toBe(noLocation);
    expect(result.dropped).toHaveLength(0);
  });

  test("fabrication on a changed file is still dropped (regression guard)", () => {
    // The scope gate only affects eligibility; if location.path IS a changed file,
    // the existing quote-match logic still drops fabricated quotes.
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const fabrication = makeFinding({
      location: { path: "auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"],
    });

    const result = assessFindingGrounding([fabrication], diff);

    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toBe(fabrication);
    expect(result.grounded).toHaveLength(0);
  });

  test("path normalization: leading ./ on location.path matches changed file → dropped (fabrication)", () => {
    // auth/accounts.ts is changed; ./auth/accounts.ts should normalize to the same path.
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const fabrication = makeFinding({
      location: { path: "./auth/accounts.ts" },
      quotedCode: ["return db.accounts.deleteEverything();"],
    });

    const result = assessFindingGrounding([fabrication], diff);

    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toBe(fabrication);
    expect(result.grounded).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // #207: no-quote carve-out — findings with no quotedCode always land in grounded
  // ---------------------------------------------------------------------------

  test("no-quote carve-out: finding on a CHANGED file with quotedCode undefined → grounded (full confidence eligible)", () => {
    // A finding that cites a changed file but has no quotedCode. Even though the file
    // is changed, there is no fabricated-location risk without a checkable quote.
    // It must land in `grounded` so it CAN block the CI gate (#207 explicit carve-out).
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({
      location: { path: "auth/accounts.ts" },
      // quotedCode intentionally omitted (undefined)
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.grounded[0]).toBe(finding);
    expect(result.dropped).toHaveLength(0);
  });

  test("no-quote carve-out: finding on a CHANGED file with quotedCode: [] → grounded", () => {
    // Same carve-out but with an explicit empty array rather than undefined.
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const finding = makeFinding({
      location: { path: "auth/accounts.ts" },
      quotedCode: [],
    });

    const result = assessFindingGrounding([finding], diff);

    expect(result.grounded).toHaveLength(1);
    expect(result.grounded[0]).toBe(finding);
    expect(result.dropped).toHaveLength(0);
  });

  test("partition unchanged (#207): ungrounded-with-quote finding still lands in dropped", () => {
    // The #207 reframe changes what the CALLER does with `dropped` (down-weight instead of
    // discard), but the partition itself is unchanged — an ungrounded quote still goes to dropped.
    const diff = makeDiff("+  return db.accounts.findById(accountId);");
    const fabricated = makeFinding({
      location: { path: "auth/accounts.ts" },
      quotedCode: ["db.dropTable('users');"], // not in diff
    });

    const result = assessFindingGrounding([fabricated], diff);

    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]).toBe(fabricated);
    expect(result.grounded).toHaveLength(0);
  });
});
