import { describe, expect, test } from "bun:test";
import type { DiffSummary, Finding } from "../src/contracts/index.ts";
import { backfillFindingLocations } from "../src/runner/location-backfill.ts";

// ---------------------------------------------------------------------------
// Helpers — mirror evidence-grounding.test.ts makeDiff/makeFinding style
// ---------------------------------------------------------------------------

function makeDiff(patch: string, path = "src/db/accounts.ts"): DiffSummary {
  return {
    files: [
      {
        path,
        status: "modified",
        additions: 5,
        deletions: 2,
        isBinary: false,
        patch,
      },
    ],
    totalAdditions: 5,
    totalDeletions: 2,
    truncated: false,
  };
}

/** Build a Finding without a `location` property (no optional key at all). */
function makeNoLocationFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Test finding",
    body: "body text",
    confidence: "high",
    evidence: ["some evidence"],
    recommendation: "fix it",
    ...overrides,
  };
}

/** Build a Finding with a `location` (path only; no line). */
function makePathOnlyFinding(path: string, overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Test finding",
    body: "body text",
    confidence: "high",
    evidence: ["some evidence"],
    recommendation: "fix it",
    location: { path },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("backfillFindingLocations", () => {
  // -------------------------------------------------------------------------
  // Added-line backfill: verify the hunk-offset math
  // -------------------------------------------------------------------------

  test("finding with no location + quotedCode matching an ADDED line → location backfilled to correct absolute new line", () => {
    // Hunk starts at new-side line 20. Patch:
    //   @@ -20,6 +20,8 @@        ← newCursor = 20
    //   -  oldLine();            ← removed, newCursor stays 20
    //    contextLine();          ← context, recorded at newLine=20, newCursor → 21
    //   +  addedLineA();         ← added,   recorded at newLine=21, newCursor → 22
    //   +  addedLineB();         ← added,   recorded at newLine=22, newCursor → 23
    //   +  const result = queryDb(id); ← added, recorded at newLine=23, newCursor → 24
    const patch = [
      "@@ -20,6 +20,8 @@",
      "-  oldLine();",
      " contextLine();",
      "+  addedLineA();",
      "+  addedLineB();",
      "+  const result = queryDb(id);",
    ].join("\n");
    const diff = makeDiff(patch);

    // quotedCode matches the 3rd recorded new-side line (addedLineB at newLine=22)
    const finding = makeNoLocationFinding({
      quotedCode: ["addedLineB();"],
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(1);
    expect(findings).toHaveLength(1);
    const result = findings[0];
    expect(result?.location).toBeDefined();
    expect(result?.location?.path).toBe("src/db/accounts.ts");
    expect(result?.location?.line).toBe(22);
    expect(result?.location?.side).toBe("RIGHT");
  });

  // -------------------------------------------------------------------------
  // Context-line backfill
  // -------------------------------------------------------------------------

  test("finding with quotedCode matching a CONTEXT line → backfilled with context line's new line", () => {
    // @@ -5,4 +5,4 @@ → newCursor = 5
    //  contextLineA();   → newLine=5
    // +addedLine();      → newLine=6
    //  contextLineB();   → newLine=7
    const patch = ["@@ -5,4 +5,4 @@", " contextLineA();", "+addedLine();", " contextLineB();"].join(
      "\n",
    );
    const diff = makeDiff(patch);

    const finding = makeNoLocationFinding({
      quotedCode: ["contextLineB();"],
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(1);
    expect(findings[0]?.location?.line).toBe(7);
    expect(findings[0]?.location?.side).toBe("RIGHT");
  });

  // -------------------------------------------------------------------------
  // Already has a usable line → unchanged
  // -------------------------------------------------------------------------

  test("finding that already has location.line set → unchanged (not a candidate)", () => {
    const patch = "@@ -1,1 +1,1 @@\n+  const x = queryDb(userId);";
    const diff = makeDiff(patch);

    const finding: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Test",
      body: "body",
      confidence: "high",
      evidence: [],
      recommendation: "fix",
      location: { path: "src/db/accounts.ts", line: 42, side: "RIGHT" },
      quotedCode: ["const x = queryDb(userId);"],
    };

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding); // same object reference — not mutated
    expect(findings[0]?.location?.line).toBe(42); // original line unchanged
  });

  test("finding that already has location.startLine set → unchanged (usable via startLine)", () => {
    const patch = "@@ -1,1 +1,1 @@\n+  const x = queryDb(userId);";
    const diff = makeDiff(patch);

    const finding: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "Test",
      body: "body",
      confidence: "high",
      evidence: [],
      recommendation: "fix",
      location: { path: "src/db/accounts.ts", startLine: 10, endLine: 15 },
      quotedCode: ["const x = queryDb(userId);"],
    };

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding);
    expect(findings[0]?.location?.startLine).toBe(10);
  });

  // -------------------------------------------------------------------------
  // No quotedCode → unchanged
  // -------------------------------------------------------------------------

  test("finding with no quotedCode (undefined) → unchanged", () => {
    const patch = "@@ -1,1 +1,1 @@\n+  const x = queryDb(userId);";
    const diff = makeDiff(patch);

    const finding = makeNoLocationFinding(); // no quotedCode

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding);
    expect(findings[0]?.location).toBeUndefined();
  });

  test("finding with empty quotedCode array → unchanged", () => {
    const patch = "@@ -1,1 +1,1 @@\n+  const x = queryDb(userId);";
    const diff = makeDiff(patch);

    const finding = makeNoLocationFinding({ quotedCode: [] });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding);
  });

  // -------------------------------------------------------------------------
  // quotedCode matches nothing in the diff → unchanged
  // -------------------------------------------------------------------------

  test("finding whose quotedCode matches nothing in the diff → unchanged", () => {
    const patch = "@@ -1,1 +1,1 @@\n+  const x = queryDb(userId);";
    const diff = makeDiff(patch);

    const finding = makeNoLocationFinding({
      quotedCode: ["return db.accounts.deleteEverything();"],
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding);
    expect(findings[0]?.location).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Multi-line quotedCode → matches on FIRST physical line
  // -------------------------------------------------------------------------

  test("multi-line quotedCode → matches on its first physical line, lands on that line's number", () => {
    // @@ -10,3 +10,3 @@   newCursor=10
    //  context();           newLine=10
    // +const userId = req.query.userId;    newLine=11
    // +return db.findById(userId);         newLine=12
    const patch = [
      "@@ -10,3 +10,3 @@",
      " context();",
      "+const userId = req.query.userId;",
      "+return db.findById(userId);",
    ].join("\n");
    const diff = makeDiff(patch);

    const finding = makeNoLocationFinding({
      quotedCode: ["const userId = req.query.userId;\nreturn db.findById(userId);"],
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(1);
    // First line of the multi-line quote is "const userId = req.query.userId;" which is at newLine=11
    expect(findings[0]?.location?.line).toBe(11);
    expect(findings[0]?.location?.side).toBe("RIGHT");
  });

  // -------------------------------------------------------------------------
  // Sub-threshold quote → not a candidate
  // -------------------------------------------------------------------------

  test("sub-threshold quote (first line < 8 chars) → not a candidate → unchanged", () => {
    const patch = "@@ -1,2 +1,2 @@\n+foo();\n+bar();";
    const diff = makeDiff(patch);

    // "foo();" is 6 chars — below the 8-char threshold
    const finding = makeNoLocationFinding({
      quotedCode: ["foo();"],
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding);
    expect(findings[0]?.location).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Removed lines do not advance the new-side counter
  // -------------------------------------------------------------------------

  test("removed (-) lines do NOT advance newCursor; quote after a deletion lands on correct absolute line", () => {
    // Hunk starting at new-side line 30:
    //   @@ -30,5 +30,4 @@   newCursor=30
    //    contextBefore();   context  newLine=30, newCursor→31
    //   -removedLineA();    removed  NO record,  newCursor stays 31
    //   -removedLineB();    removed  NO record,  newCursor stays 31
    //   +addedNew();        added    newLine=31,  newCursor→32
    //    contextAfter();    context  newLine=32,  newCursor→33
    //
    // Without correctly handling removed lines, addedNew() would incorrectly
    // land at newLine=33 instead of 31.
    const patch = [
      "@@ -30,5 +30,4 @@",
      " contextBefore();",
      "-removedLineA();",
      "-removedLineB();",
      "+addedNew();",
      " contextAfter();",
    ].join("\n");
    const diff = makeDiff(patch);

    const finding = makeNoLocationFinding({
      quotedCode: ["addedNew();"],
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(1);
    // addedNew() must land at newLine=31, NOT 33 (if removals incorrectly advanced the cursor)
    expect(findings[0]?.location?.line).toBe(31);
  });

  // -------------------------------------------------------------------------
  // backfilledCount reflects the number actually located
  // -------------------------------------------------------------------------

  test("backfilledCount reflects only the findings actually located", () => {
    const patch = [
      "@@ -1,4 +1,4 @@",
      "+const authToken = getToken(req);",
      "+const user = verifyToken(authToken);",
      "+return user.profile;",
    ].join("\n");
    const diff = makeDiff(patch);

    const matchingFinding = makeNoLocationFinding({
      title: "matching",
      quotedCode: ["const authToken = getToken(req);"],
    });
    const noMatchFinding = makeNoLocationFinding({
      title: "no-match",
      quotedCode: ["return db.accounts.deleteEverything();"],
    });
    const noQuoteFinding = makeNoLocationFinding({ title: "no-quote" });
    const alreadyLocated: Finding = {
      reviewer: "security",
      severity: "warning",
      category: "auth",
      title: "already-located",
      body: "body",
      confidence: "high",
      evidence: [],
      recommendation: "fix",
      location: { path: "src/db/accounts.ts", line: 99, side: "RIGHT" },
      quotedCode: ["const authToken = getToken(req);"],
    };

    const { findings, backfilledCount } = backfillFindingLocations(
      [matchingFinding, noMatchFinding, noQuoteFinding, alreadyLocated],
      diff,
    );

    expect(backfilledCount).toBe(1);
    expect(findings).toHaveLength(4);
    // Only matchingFinding should have been backfilled
    expect(findings[0]?.location?.line).toBe(1);
    expect(findings[1]?.location).toBeUndefined(); // no-match unchanged
    expect(findings[2]?.location).toBeUndefined(); // no-quote unchanged
    expect(findings[3]?.location?.line).toBe(99); // already-located unchanged
  });

  // -------------------------------------------------------------------------
  // Order preservation
  // -------------------------------------------------------------------------

  test("finding order is preserved", () => {
    const patch = [
      "@@ -1,3 +1,3 @@",
      "+const firstLine = a();",
      "+const secondLine = b();",
      "+const thirdLine = c();",
    ].join("\n");
    const diff = makeDiff(patch);

    const f1 = makeNoLocationFinding({ title: "first", quotedCode: ["const firstLine = a();"] });
    const f2 = makeNoLocationFinding({ title: "second", quotedCode: ["const secondLine = b();"] });
    const f3 = makeNoLocationFinding({ title: "third", quotedCode: ["const thirdLine = c();"] });

    const { findings, backfilledCount } = backfillFindingLocations([f1, f2, f3], diff);

    expect(backfilledCount).toBe(3);
    expect(findings.map((f) => f.title)).toEqual(["first", "second", "third"]);
    expect(findings[0]?.location?.line).toBe(1);
    expect(findings[1]?.location?.line).toBe(2);
    expect(findings[2]?.location?.line).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Path-only location (no line) is still a candidate
  // -------------------------------------------------------------------------

  test("finding with path-only location (no line) is still a candidate and gets backfilled", () => {
    const patch =
      "@@ -1,1 +1,2 @@\n+const userId = req.params.userId;\n+return db.findById(userId);";
    const diff = makeDiff(patch);

    const finding = makePathOnlyFinding("src/db/accounts.ts", {
      quotedCode: ["const userId = req.params.userId;"],
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(1);
    expect(findings[0]?.location?.path).toBe("src/db/accounts.ts");
    expect(findings[0]?.location?.line).toBe(1);
    expect(findings[0]?.location?.side).toBe("RIGHT");
  });

  test("path-only finding: a same-text line in ANOTHER file does not overwrite the supplied path (#87 review)", () => {
    // file-b is listed FIRST and shares the matching line; the finding's path hint is file-a.
    const sharedLine = "return db.accounts.findById(accountId);";
    const diff: DiffSummary = {
      files: [
        {
          path: "src/file-b.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          patch: `@@ -1,1 +50,1 @@\n+${sharedLine}`,
        },
        {
          path: "src/file-a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          patch: `@@ -1,1 +7,1 @@\n+${sharedLine}`,
        },
      ],
      totalAdditions: 2,
      totalDeletions: 0,
      truncated: false,
    };

    const finding = makePathOnlyFinding("src/file-a.ts", { quotedCode: [sharedLine] });
    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(1);
    // Must keep the reviewer-supplied path (file-a) and its line (7), NOT file-b's (50).
    expect(findings[0]?.location?.path).toBe("src/file-a.ts");
    expect(findings[0]?.location?.line).toBe(7);
  });

  // -------------------------------------------------------------------------
  // Binary files and files with no patch are skipped in the index
  // -------------------------------------------------------------------------

  test("binary files are skipped — their content is not indexed", () => {
    const diff: DiffSummary = {
      files: [
        {
          path: "assets/image.png",
          status: "modified",
          additions: 0,
          deletions: 0,
          isBinary: true,
          patch: "+something",
        },
      ],
      totalAdditions: 0,
      totalDeletions: 0,
      truncated: false,
    };

    const finding = makeNoLocationFinding({ quotedCode: ["something long enough"] });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding);
  });

  test("file with undefined patch is skipped in the index", () => {
    const diff: DiffSummary = {
      files: [
        {
          path: "src/db/accounts.ts",
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

    const finding = makeNoLocationFinding({ quotedCode: ["const x = queryDb(userId);"] });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(0);
    expect(findings[0]).toBe(finding);
  });

  // -------------------------------------------------------------------------
  // Whitespace normalization: a quote with extra spaces still matches
  // -------------------------------------------------------------------------

  test("whitespace-differing quote still locates the line (normalization)", () => {
    const patch = "@@ -1,1 +1,1 @@\n+  const result = queryDb(userId);";
    const diff = makeDiff(patch);

    const finding = makeNoLocationFinding({
      quotedCode: ["const  result  =  queryDb(userId);"], // extra spaces
    });

    const { findings, backfilledCount } = backfillFindingLocations([finding], diff);

    expect(backfilledCount).toBe(1);
    expect(findings[0]?.location?.line).toBe(1);
  });
});
