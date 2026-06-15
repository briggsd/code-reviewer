import { describe, expect, test } from "bun:test";
import type { Finding, ReviewSummary } from "../src/index.ts";
import {
  createStableFindingId,
  formatReviewSummaryMarkdown,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";

// ---------------------------------------------------------------------------
// Clock helper (mirrors evidence-grounding-spine.test.ts)
// ---------------------------------------------------------------------------

function createIncrementingClock(startIso: string): () => Date {
  const startMs = Date.parse(startIso);
  let tick = 0;
  return () => {
    const date = new Date(startMs + tick * 10);
    tick += 1;
    return date;
  };
}

// ---------------------------------------------------------------------------
// Cross-field consistency invariant (#209)
// ---------------------------------------------------------------------------

/**
 * Assert that all structurally-coupled finding-derived summary fields are mutually consistent.
 * Applied to every scenario — this single guard covers every future finding-derived field.
 */
function assertCrossFieldConsistency(summary: ReviewSummary): void {
  // title ⇔ findings: assert ONE of the three title shapes createSummaryTitle can emit, picked by
  // the shown count + decision — never a silent skip (a guard that quietly asserts nothing is the
  // suppression anti-pattern this slice exists to kill). The significant_concerns title carries no
  // count, so an unconditional `found N` match would wrongly fail there — hence the branch.
  if (summary.findings.length === 0) {
    expect(summary.title).toBe("AI review found no blocking issues");
  } else if (summary.decision === "significant_concerns") {
    expect(summary.title).toBe("AI review found significant concerns");
  } else {
    const titleCount = summary.title.match(/found (\d+) finding/);
    expect(titleCount).not.toBeNull();
    expect(Number(titleCount?.[1])).toBe(summary.findings.length);
  }
  // findingIds ⇔ findings: every shown finding has a non-empty, unique stable id
  const ids = summary.findings.map((f) => f.id);
  expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  // withheld is DISJOINT from shown (excluded from gate/title/findingIds) — by stable id
  const shownStableIds = new Set(summary.findings.map((f) => createStableFindingId(f)));
  for (const w of summary.groundingWithheld ?? [])
    expect(shownStableIds.has(createStableFindingId(w))).toBe(false);
  // body ⇔ findings: in this dummy-runtime harness the body always originates from
  // createSummaryBody (the deterministic `Findings: N` line) on EVERY path — drop, no-drop, and
  // ack (which appends to that base body) — so the count line is always present and this check
  // never silently no-ops. Assert presence + agreement unconditionally.
  const bodyCount = summary.body.match(/Findings:\s*(\d+)/);
  expect(bodyCount).not.toBeNull();
  expect(Number(bodyCount?.[1])).toBe(summary.findings.length);
  // low-confidence note appears IFF something was withheld — both directions asserted, so a note
  // that drifts out of agreement with the withheld count (either way) fails the test.
  const withheldCount = summary.groundingWithheld?.length ?? 0;
  const lowConfNote = summary.body.match(/_(\d+) finding\(s\) shown at low confidence/);
  if (withheldCount > 0) {
    expect(lowConfNote).not.toBeNull();
    expect(Number(lowConfNote?.[1])).toBe(withheldCount);
  } else {
    expect(lowConfNote).toBeNull();
  }
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// The auth-pr fixture patch contains:
//   +  return db.accounts.findById(accountId);   ← GROUNDED (in diff)
// "return db.accounts.deleteEverything();"        ← FABRICATED (not in diff)

function makeGroundedFinding(overrides?: Partial<Finding>): Finding {
  return {
    reviewer: "security",
    severity: "warning",
    category: "auth",
    title: "Grounded finding",
    body: "body",
    confidence: "high",
    evidence: ["some evidence"],
    recommendation: "fix it",
    location: { path: "auth/accounts.ts" },
    quotedCode: ["return db.accounts.findById(accountId);"],
    ...overrides,
  };
}

function makeFabricatedFinding(overrides?: Partial<Finding>): Finding {
  return {
    reviewer: "security",
    severity: "critical",
    category: "auth",
    title: "Fabricated finding",
    body: "body",
    confidence: "high",
    evidence: ["fabricated evidence"],
    recommendation: "fix it",
    location: { path: "auth/accounts.ts" },
    quotedCode: ["return db.accounts.deleteEverything();"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("cross-field consistency invariant (#209)", () => {
  test("withholds-none: 2 grounded findings → groundingWithheld empty/absent, all fields consistent", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    // Self-guard: grounded quote must be in the fixture diff
    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).toContain("return db.accounts.findById(accountId);");
    expect(fixturePatches).not.toContain("deleteEverything");

    const grounded1 = makeGroundedFinding({ title: "Grounded finding 1" });
    const grounded2 = makeGroundedFinding({
      title: "Grounded finding 2",
      severity: "suggestion",
      category: "code_quality",
    });
    fixture.fakeFindings = [grounded1, grounded2];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-14T10:00:00.000Z"),
    });

    const { summary } = result;

    // Cross-field invariant
    assertCrossFieldConsistency(summary);

    // Scenario-specific sanity
    expect(summary.findings).toHaveLength(2);
    expect(summary.groundingWithheld ?? []).toHaveLength(0);
    // Both grounded → no grounding note in body
    expect(summary.body).not.toContain("low confidence");
  });

  test("withholds-some: 1 grounded + 1 fabricated → 1 shown, 1 withheld, all fields consistent", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).toContain("return db.accounts.findById(accountId);");
    expect(fixturePatches).not.toContain("deleteEverything");

    const grounded = makeGroundedFinding();
    const fabricated = makeFabricatedFinding();
    fixture.fakeFindings = [grounded, fabricated];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-14T10:01:00.000Z"),
    });

    const { summary } = result;

    // Cross-field invariant
    assertCrossFieldConsistency(summary);

    // Scenario-specific sanity
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]?.title).toBe("Grounded finding");
    expect(summary.groundingWithheld).toHaveLength(1);
    expect(summary.groundingWithheld?.[0]?.title).toBe("Fabricated finding");
    // title count must agree with shown (1), not total (2)
    expect(summary.title).toContain("1 finding");
    // decision reflects only the grounded "warning" (not the fabricated "critical")
    expect(summary.decision).toBe("approved_with_comments");
    expect(summary.outcome).toBe("pass");
  });

  test("withholds-all: all findings fabricated → findings empty, all withheld, all fields consistent", async () => {
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).not.toContain("deleteEverything");

    const fabricated1 = makeFabricatedFinding({ title: "Fabricated critical 1" });
    const fabricated2 = makeFabricatedFinding({
      title: "Fabricated critical 2",
      severity: "warning",
      category: "code_quality",
    });
    fixture.fakeFindings = [fabricated1, fabricated2];

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-14T10:02:00.000Z"),
    });

    const { summary } = result;

    // Cross-field invariant
    assertCrossFieldConsistency(summary);

    // Scenario-specific sanity
    expect(summary.findings).toHaveLength(0);
    expect(summary.groundingWithheld).toHaveLength(2);
    const withheldTitles = summary.groundingWithheld?.map((f) => f.title) ?? [];
    expect(withheldTitles).toContain("Fabricated critical 1");
    expect(withheldTitles).toContain("Fabricated critical 2");
    // 0 shown → approved
    expect(summary.decision).toBe("approved");
    expect(summary.outcome).toBe("pass");
    // title must not say "N findings"
    expect(summary.title).not.toMatch(/found \d+ finding/);

    // Rendered-comment snapshot (Change 5)
    const md = formatReviewSummaryMarkdown(summary);
    expect(md).toMatchSnapshot();
  });

  test("acknowledgement path: acked finding stays shown but off the gate → both rebuild sites consistent", async () => {
    // The three scenarios above all leave acknowledgedCount=0, so they only exercise the
    // grounding-drop call site of rebuildSummaryForFindings. This scenario adds an acknowledge
    // ack so the SECOND call site (the post-acknowledgement branch) runs — extending the
    // cross-field invariant guard to both reconciliation sites (#209's stated goal).
    const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");

    const fixturePatches = fixture.diff.files.map((f) => f.patch ?? "").join("\n");
    expect(fixturePatches).toContain("return db.accounts.findById(accountId);");

    // A grounded finding (no grounding drop) so ONLY the ack-path rebuild fires.
    const grounded = makeGroundedFinding({ severity: "critical", category: "auth" });
    fixture.fakeFindings = [grounded];
    fixture.config = {
      ...fixture.config,
      acknowledgements: [
        {
          path: "auth/**",
          mode: "acknowledge",
          reason: "tracked in TICKET-209; under remediation",
        },
      ],
    };

    const result = await runReview({
      fixture,
      clock: createIncrementingClock("2026-06-14T10:03:00.000Z"),
    });

    const { summary } = result;

    // Cross-field invariant — over the ack-path-assembled summary
    assertCrossFieldConsistency(summary);

    // Scenario-specific sanity: the acked finding is still SHOWN (annotated), but the gate
    // excludes it, so title count (shown=1) and decision (gated=0 → approved) come from the
    // helper's split findings/gateFindings params — exactly the asymmetry that could drift.
    expect(summary.findings).toHaveLength(1);
    expect(summary.findings[0]?.acknowledged).toEqual({
      reason: "tracked in TICKET-209; under remediation",
    });
    expect(summary.title).toContain("1 finding");
    expect(summary.decision).toBe("approved");
    expect(summary.outcome).toBe("pass");
    expect(summary.body).toContain("1 finding(s) acknowledged by project acknowledgements");
  });
});
