/**
 * Tests for deriveWithheldDispositions and computeWithheldDispositions (#392).
 *
 * Covers all 4 disposition outcomes:
 *   1. promoted      — prior withheld id in currentBlockingIds
 *   2. stillWithheld — prior withheld id in currentWithheldIds
 *   3. resolved      — file reviewed, id in neither set (full review or file in reviewedPaths)
 *   4. carriedForward — file not reviewed this round (incremental, path not in reviewedPaths)
 */

import { describe, expect, test } from "bun:test";
import type { PriorFindingState } from "../src/contracts/index.ts";
import {
  computeWithheldDispositions,
  deriveWithheldDispositions,
  type WithheldDisposition,
  type WithheldDispositionCounts,
} from "../src/runner/withheld-disposition.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePriorWithheld(overrides: {
  stableId: string;
  path?: string;
  reviewer?: string;
}): PriorFindingState {
  return {
    stableId: overrides.stableId,
    finding: {
      id: overrides.stableId,
      reviewer: overrides.reviewer ?? "security",
      severity: "warning",
      category: "auth",
      title: `Prior withheld ${overrides.stableId}`,
      body: "body",
      confidence: "low",
      evidence: [],
      recommendation: "fix it",
      ...(overrides.path !== undefined ? { location: { path: overrides.path } } : {}),
    },
    status: "open",
    lastSeenHeadSha: "old-head",
  };
}

// ---------------------------------------------------------------------------
// deriveWithheldDispositions — case 1: promoted
// ---------------------------------------------------------------------------

describe("deriveWithheldDispositions — promoted", () => {
  test("prior withheld id in currentBlockingIds → promoted", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_w1", path: "src/auth.ts" })];
    const blocking = new Set(["fnd_w1"]);
    const withheld = new Set<string>();
    const result = deriveWithheldDispositions(prior, blocking, withheld, undefined);
    expect(result.get("fnd_w1")).toBe<WithheldDisposition>("promoted");
  });

  test("promoted takes precedence over stillWithheld (id in both sets)", () => {
    // Theoretically impossible, but precedence must be deterministic: promoted wins.
    const prior = [makePriorWithheld({ stableId: "fnd_both", path: "src/foo.ts" })];
    const blocking = new Set(["fnd_both"]);
    const withheld = new Set(["fnd_both"]);
    const result = deriveWithheldDispositions(prior, blocking, withheld, undefined);
    expect(result.get("fnd_both")).toBe<WithheldDisposition>("promoted");
  });
});

// ---------------------------------------------------------------------------
// deriveWithheldDispositions — case 2: stillWithheld
// ---------------------------------------------------------------------------

describe("deriveWithheldDispositions — stillWithheld", () => {
  test("prior withheld id in currentWithheldIds → stillWithheld", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_w2", path: "src/tokens.ts" })];
    const blocking = new Set<string>();
    const withheld = new Set(["fnd_w2"]);
    const result = deriveWithheldDispositions(prior, blocking, withheld, undefined);
    expect(result.get("fnd_w2")).toBe<WithheldDisposition>("stillWithheld");
  });
});

// ---------------------------------------------------------------------------
// deriveWithheldDispositions — case 3: resolved
// ---------------------------------------------------------------------------

describe("deriveWithheldDispositions — resolved", () => {
  test("full review (reviewedPaths=undefined), id not in blocking/withheld → resolved", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_w3", path: "src/auth.ts" })];
    const blocking = new Set<string>();
    const withheld = new Set<string>();
    const result = deriveWithheldDispositions(prior, blocking, withheld, undefined);
    expect(result.get("fnd_w3")).toBe<WithheldDisposition>("resolved");
  });

  test("incremental review, path in reviewedPaths, id not in blocking/withheld → resolved", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_w4", path: "src/auth.ts" })];
    const blocking = new Set<string>();
    const withheld = new Set<string>();
    const reviewedPaths = new Set(["src/auth.ts", "src/tokens.ts"]);
    const result = deriveWithheldDispositions(prior, blocking, withheld, reviewedPaths);
    expect(result.get("fnd_w4")).toBe<WithheldDisposition>("resolved");
  });

  test("finding with no path, full review → resolved (no path means file implicitly reviewed)", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_nopath" })]; // no path
    const blocking = new Set<string>();
    const withheld = new Set<string>();
    const result = deriveWithheldDispositions(prior, blocking, withheld, undefined);
    expect(result.get("fnd_nopath")).toBe<WithheldDisposition>("resolved");
  });
});

// ---------------------------------------------------------------------------
// deriveWithheldDispositions — case 4: carriedForward
// ---------------------------------------------------------------------------

describe("deriveWithheldDispositions — carriedForward", () => {
  test("incremental review, path NOT in reviewedPaths → carriedForward", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_w5", path: "src/auth.ts" })];
    const blocking = new Set<string>();
    const withheld = new Set<string>();
    const reviewedPaths = new Set(["src/other.ts"]); // auth.ts not reviewed
    const result = deriveWithheldDispositions(prior, blocking, withheld, reviewedPaths);
    expect(result.get("fnd_w5")).toBe<WithheldDisposition>("carriedForward");
  });

  test("incremental review, finding has no path → carriedForward (path unknown, not in reviewedPaths)", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_nopathincr" })]; // no path
    const blocking = new Set<string>();
    const withheld = new Set<string>();
    const reviewedPaths = new Set(["src/other.ts"]); // reviewedPaths defined, but no path on finding
    const result = deriveWithheldDispositions(prior, blocking, withheld, reviewedPaths);
    expect(result.get("fnd_nopathincr")).toBe<WithheldDisposition>("carriedForward");
  });
});

// ---------------------------------------------------------------------------
// deriveWithheldDispositions — empty input
// ---------------------------------------------------------------------------

describe("deriveWithheldDispositions — empty input", () => {
  test("empty priorWithheld → empty map", () => {
    const result = deriveWithheldDispositions([], new Set(["fnd_x"]), new Set<string>(), undefined);
    expect(result.size).toBe(0);
  });

  test("all prior withheld ids in blocking → all promoted", () => {
    const prior = [
      makePriorWithheld({ stableId: "fnd_a", path: "src/a.ts" }),
      makePriorWithheld({ stableId: "fnd_b", path: "src/b.ts" }),
    ];
    const blocking = new Set(["fnd_a", "fnd_b"]);
    const result = deriveWithheldDispositions(prior, blocking, new Set(), undefined);
    expect(result.get("fnd_a")).toBe("promoted");
    expect(result.get("fnd_b")).toBe("promoted");
  });
});

// ---------------------------------------------------------------------------
// computeWithheldDispositions — roll-up counts
// ---------------------------------------------------------------------------

describe("computeWithheldDispositions — roll-up counts", () => {
  test("returns undefined when priorWithheld is empty", () => {
    const counts = computeWithheldDispositions([], new Set(), new Set(), undefined);
    expect(counts).toBeUndefined();
  });

  test("counts each disposition correctly across a mixed set", () => {
    const prior = [
      makePriorWithheld({ stableId: "fnd_promoted", path: "src/a.ts" }),
      makePriorWithheld({ stableId: "fnd_still", path: "src/b.ts" }),
      makePriorWithheld({ stableId: "fnd_resolved", path: "src/c.ts" }),
      makePriorWithheld({ stableId: "fnd_carried", path: "src/d.ts" }),
    ];
    const blocking = new Set(["fnd_promoted"]);
    const withheld = new Set(["fnd_still"]);
    // reviewedPaths covers c.ts but not d.ts
    const reviewedPaths = new Set(["src/a.ts", "src/b.ts", "src/c.ts"]);

    const counts = computeWithheldDispositions(prior, blocking, withheld, reviewedPaths);
    expect(counts).toEqual<WithheldDispositionCounts>({
      promoted: 1,
      stillWithheld: 1,
      resolved: 1,
      carriedForward: 1,
    });
  });

  test("full review (reviewedPaths=undefined): all non-promoted/withheld are resolved, none carriedForward", () => {
    const prior = [
      makePriorWithheld({ stableId: "fnd_still", path: "src/b.ts" }),
      makePriorWithheld({ stableId: "fnd_resolved1", path: "src/c.ts" }),
      makePriorWithheld({ stableId: "fnd_resolved2", path: "src/d.ts" }),
    ];
    const blocking = new Set<string>();
    const withheld = new Set(["fnd_still"]);

    const counts = computeWithheldDispositions(prior, blocking, withheld, undefined);
    expect(counts).toEqual<WithheldDispositionCounts>({
      promoted: 0,
      stillWithheld: 1,
      resolved: 2,
      carriedForward: 0,
    });
  });

  test("all promoted: counts match number of prior withheld findings", () => {
    const prior = [
      makePriorWithheld({ stableId: "fnd_p1", path: "src/a.ts" }),
      makePriorWithheld({ stableId: "fnd_p2", path: "src/b.ts" }),
      makePriorWithheld({ stableId: "fnd_p3", path: "src/c.ts" }),
    ];
    const blocking = new Set(["fnd_p1", "fnd_p2", "fnd_p3"]);

    const counts = computeWithheldDispositions(prior, blocking, new Set(), undefined);
    expect(counts).toEqual<WithheldDispositionCounts>({
      promoted: 3,
      stillWithheld: 0,
      resolved: 0,
      carriedForward: 0,
    });
  });

  test("all carriedForward: incremental review, none of the files reviewed", () => {
    const prior = [
      makePriorWithheld({ stableId: "fnd_c1", path: "src/a.ts" }),
      makePriorWithheld({ stableId: "fnd_c2", path: "src/b.ts" }),
    ];
    const reviewedPaths = new Set(["src/other.ts"]); // neither a.ts nor b.ts reviewed

    const counts = computeWithheldDispositions(prior, new Set(), new Set(), reviewedPaths);
    expect(counts).toEqual<WithheldDispositionCounts>({
      promoted: 0,
      stillWithheld: 0,
      resolved: 0,
      carriedForward: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Pure + deterministic
// ---------------------------------------------------------------------------

describe("withheld-disposition — pure + deterministic", () => {
  test("identical inputs produce identical outputs", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_x", path: "src/x.ts" })];
    const blocking = new Set<string>();
    const withheld = new Set(["fnd_x"]);

    const r1 = computeWithheldDispositions(prior, blocking, withheld, undefined);
    const r2 = computeWithheldDispositions(prior, blocking, withheld, undefined);
    expect(r1).toEqual(r2);
    expect(r1?.stillWithheld).toBe(1);
  });

  test("does not mutate priorWithheld array", () => {
    const prior = [makePriorWithheld({ stableId: "fnd_y", path: "src/y.ts" })];
    const copy = JSON.parse(JSON.stringify(prior)) as PriorFindingState[];
    deriveWithheldDispositions(prior, new Set(), new Set(), undefined);
    expect(prior).toEqual(copy);
  });
});
