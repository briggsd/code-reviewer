/**
 * Tests for deriveDisposition (#256, M023 S04 — the precision keystone).
 *
 * Covers all 5 precedence cases:
 *   1. Ack with verdict "dismissed"                      → dismissed
 *   2. Ack with verdict "acknowledged" or absent verdict → acknowledged
 *   3. Re-review status "fixed" (no ack)                → fixed
 *   4. Re-review status "recurring" (no ack)            → ignored
 *   5. new / withheld / carried_forward                 → undefined (excluded)
 */

import { describe, expect, test } from "bun:test";
import type { Finding, ReReviewFindingClassification } from "../src/contracts/index.ts";
import { deriveDisposition, type FindingDisposition } from "../src/runner/finding-disposition.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "code_quality",
    severity: "warning",
    category: "correctness",
    title: "Test finding",
    body: "some body",
    confidence: "high",
    evidence: ["evidence"],
    recommendation: "fix it",
    location: { path: "src/foo.ts" },
    ...overrides,
  };
}

function makeClassification(
  overrides: Partial<ReReviewFindingClassification>,
): ReReviewFindingClassification {
  return {
    stableId: "sha256-abc123",
    status: "recurring",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Precedence 1: dismissed ack
// ---------------------------------------------------------------------------

describe("deriveDisposition — precedence 1: dismissed ack", () => {
  test("recurring finding with dismissed ack verdict → dismissed", () => {
    const finding = makeFinding({ acknowledged: { reason: "intentional", verdict: "dismissed" } });
    const cls = makeClassification({ status: "recurring", finding });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("dismissed");
  });

  test("fixed finding with dismissed ack on priorFinding → dismissed", () => {
    const priorFinding = makeFinding({
      acknowledged: { reason: "won't-fix", verdict: "dismissed" },
    });
    const cls = makeClassification({ status: "fixed", priorFinding });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("dismissed");
  });
});

// ---------------------------------------------------------------------------
// Precedence 2: acknowledged ack (verdict "acknowledged" or absent)
// ---------------------------------------------------------------------------

describe("deriveDisposition — precedence 2: acknowledged ack", () => {
  test("recurring finding with verdict 'acknowledged' → acknowledged", () => {
    const finding = makeFinding({
      acknowledged: { reason: "known issue", verdict: "acknowledged" },
    });
    const cls = makeClassification({ status: "recurring", finding });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("acknowledged");
  });

  test("recurring finding with ack but no verdict (default) → acknowledged", () => {
    const finding = makeFinding({ acknowledged: { reason: "tracked in #42" } });
    const cls = makeClassification({ status: "recurring", finding });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("acknowledged");
  });

  test("fixed finding with acknowledged ack on priorFinding → acknowledged (ack beats fixed)", () => {
    // Spec precedence: ack (acknowledged/dismissed) > fixed > ignored.
    // A finding that was acked + also resolved: ack wins at precedence 2.
    const priorFinding = makeFinding({
      acknowledged: { reason: "tracked", verdict: "acknowledged" },
    });
    const cls = makeClassification({ status: "fixed", priorFinding });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("acknowledged");
  });
});

// ---------------------------------------------------------------------------
// Precedence 3: fixed (no ack)
// ---------------------------------------------------------------------------

describe("deriveDisposition — precedence 3: fixed", () => {
  test("fixed finding with no ack → fixed", () => {
    const priorFinding = makeFinding();
    const cls = makeClassification({ status: "fixed", priorFinding });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("fixed");
  });

  test("fixed finding with no priorFinding → fixed", () => {
    const cls = makeClassification({ status: "fixed" });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("fixed");
  });
});

// ---------------------------------------------------------------------------
// Precedence 4: recurring, no ack → ignored
// ---------------------------------------------------------------------------

describe("deriveDisposition — precedence 4: ignored", () => {
  test("recurring finding with no ack → ignored", () => {
    const finding = makeFinding(); // no acknowledged field
    const cls = makeClassification({ status: "recurring", finding });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("ignored");
  });

  test("recurring finding with undefined finding → ignored", () => {
    // edge case: classification without a live finding object
    const cls = makeClassification({ status: "recurring" });
    expect(deriveDisposition(cls)).toBe<FindingDisposition>("ignored");
  });
});

// ---------------------------------------------------------------------------
// Precedence 5: excluded statuses → undefined
// ---------------------------------------------------------------------------

describe("deriveDisposition — precedence 5: excluded", () => {
  test("new finding → undefined", () => {
    const finding = makeFinding();
    const cls = makeClassification({ status: "new", finding });
    expect(deriveDisposition(cls)).toBeUndefined();
  });

  test("withheld finding → undefined", () => {
    const priorFinding = makeFinding();
    const cls = makeClassification({ status: "withheld", priorFinding });
    expect(deriveDisposition(cls)).toBeUndefined();
  });

  test("carried_forward finding → undefined", () => {
    const priorFinding = makeFinding();
    const cls = makeClassification({ status: "carried_forward", priorFinding });
    expect(deriveDisposition(cls)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Determinism: same input → same output (pure function)
// ---------------------------------------------------------------------------

describe("deriveDisposition — pure + deterministic", () => {
  test("identical inputs always produce identical outputs", () => {
    const finding = makeFinding({ acknowledged: { reason: "ok", verdict: "dismissed" } });
    const cls = makeClassification({ status: "recurring", finding });
    const r1 = deriveDisposition(cls);
    const r2 = deriveDisposition(cls);
    expect(r1).toBe(r2);
    expect(r1).toBe("dismissed");
  });

  test("does not mutate the classification object", () => {
    const finding = makeFinding();
    const cls = makeClassification({ status: "recurring", finding });
    const clsCopy = JSON.parse(JSON.stringify(cls)) as ReReviewFindingClassification;
    deriveDisposition(cls);
    expect(cls).toEqual(clsCopy);
  });
});

// ---------------------------------------------------------------------------
// Capture fixture: verify the full precedence table in one snapshot
// ---------------------------------------------------------------------------

describe("deriveDisposition — precedence table capture", () => {
  test("all five precedence cases match expected outcomes", () => {
    const dismissedAck = makeFinding({ acknowledged: { reason: "x", verdict: "dismissed" } });
    const acknowledgedAck = makeFinding({ acknowledged: { reason: "x" } }); // no verdict = acknowledged
    const plainFinding = makeFinding();
    const priorFinding = makeFinding();

    const cases: Array<{
      label: string;
      cls: ReReviewFindingClassification;
      expected: FindingDisposition | undefined;
    }> = [
      {
        label: "dismissed-ack recurring",
        cls: makeClassification({ status: "recurring", finding: dismissedAck }),
        expected: "dismissed",
      },
      {
        label: "ack (no verdict) recurring",
        cls: makeClassification({ status: "recurring", finding: acknowledgedAck }),
        expected: "acknowledged",
      },
      {
        label: "fixed (no ack)",
        cls: makeClassification({ status: "fixed", priorFinding }),
        expected: "fixed",
      },
      {
        label: "recurring (no ack)",
        cls: makeClassification({ status: "recurring", finding: plainFinding }),
        expected: "ignored",
      },
      {
        label: "new (excluded)",
        cls: makeClassification({ status: "new", finding: plainFinding }),
        expected: undefined,
      },
    ];

    for (const { label, cls, expected } of cases) {
      expect(deriveDisposition(cls)).toBe(expected);
      // Confirm label is used (satisfies noUnusedLocals-style checks)
      expect(typeof label).toBe("string");
    }
  });
});
