import { describe, expect, test } from "bun:test";
import type { Acknowledgement, Finding } from "../src/contracts/index.ts";
import { applyAcknowledgements } from "../src/runner/acknowledgements.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    reviewer: "code_quality",
    severity: "warning",
    category: "correctness",
    title: "Test finding",
    body: "body text",
    confidence: "high",
    evidence: ["some evidence"],
    recommendation: "fix it",
    ...overrides,
  };
}

function makeAck(overrides: Partial<Acknowledgement> = {}): Acknowledgement {
  return {
    path: "src/**",
    mode: "acknowledge",
    reason: "Known issue; tracked in #42",
    ...overrides,
  };
}

const NOW = new Date("2026-06-11T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyAcknowledgements", () => {
  test("no acknowledgements → all findings unchanged, counts 0", () => {
    const findings = [makeFinding({ title: "Finding A" }), makeFinding({ title: "Finding B" })];

    const result = applyAcknowledgements(findings, [], NOW);

    expect(result.findings).toHaveLength(2);
    expect(result.acknowledgedCount).toBe(0);
    expect(result.suppressedCount).toBe(0);
    expect(result.findings[0]).toBe(findings[0]);
    expect(result.findings[1]).toBe(findings[1]);
  });

  test("path-glob match → finding is annotated + kept, acknowledgedCount increases", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    const ack = makeAck({ path: "src/**", mode: "acknowledge", reason: "tracked" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.findings).toHaveLength(1);
    expect(result.acknowledgedCount).toBe(1);
    expect(result.suppressedCount).toBe(0);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: "tracked" });
    // Original finding must not be mutated
    expect(finding.acknowledged).toBeUndefined();
  });

  test("path-glob mismatch → finding is unchanged", () => {
    const finding = makeFinding({ location: { path: "lib/utils.ts" } });
    const ack = makeAck({ path: "src/**" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.findings).toHaveLength(1);
    expect(result.acknowledgedCount).toBe(0);
    expect(result.findings[0]).toBe(finding);
    expect(result.findings[0]?.acknowledged).toBeUndefined();
  });

  test("category mismatch → finding is unchanged (ack has category, finding has different one)", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" }, category: "security" });
    const ack = makeAck({ path: "src/**", category: "performance" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.findings).toHaveLength(1);
    expect(result.acknowledgedCount).toBe(0);
    expect(result.findings[0]).toBe(finding);
  });

  test("category match → finding is acknowledged", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" }, category: "auth" });
    const ack = makeAck({ path: "src/**", category: "auth" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: ack.reason });
  });

  test("stableFindingId match (set finding.id) → finding is acknowledged", () => {
    const finding = makeFinding({ id: "fnd_abc123", location: { path: "src/auth.ts" } });
    const ack = makeAck({ path: "src/**", stableFindingId: "fnd_abc123" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: ack.reason });
  });

  test("stableFindingId mismatch while pinned ID is still live → finding is unchanged (sibling precision)", () => {
    // The pinned ID "fnd_different" is present on another finding in the current set,
    // so we stay in exact-match mode — "fnd_abc123" must NOT be acknowledged.
    const findingA = makeFinding({ id: "fnd_abc123", location: { path: "src/auth.ts" } });
    const findingWithPinnedId = makeFinding({
      id: "fnd_different",
      location: { path: "src/other.ts" },
    });
    const ack = makeAck({ path: "src/**", stableFindingId: "fnd_different" });

    const result = applyAcknowledgements([findingA, findingWithPinnedId], [ack], NOW);

    // Only the finding that carries the exact pinned ID is acknowledged
    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.id).toBe("fnd_abc123");
    expect(result.findings[0]?.acknowledged).toBeUndefined();
    expect(result.findings[1]?.acknowledged).toBeDefined();
  });

  test("suppress on a non-security finding → removed, suppressedCount increases", () => {
    const finding = makeFinding({ reviewer: "code_quality", location: { path: "src/util.ts" } });
    const ack = makeAck({ path: "src/**", mode: "suppress" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.findings).toHaveLength(0);
    expect(result.suppressedCount).toBe(1);
    expect(result.acknowledgedCount).toBe(0);
  });

  test("suppress on a reviewer:'security' finding → downgraded to acknowledge (kept + annotated, NOT removed)", () => {
    const finding = makeFinding({ reviewer: "security", location: { path: "src/auth.ts" } });
    const ack = makeAck({ path: "src/**", mode: "suppress", reason: "accepted risk" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    // Must be kept (security guard)
    expect(result.findings).toHaveLength(1);
    expect(result.suppressedCount).toBe(0);
    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: "accepted risk" });
  });

  test("expired ack (expires strictly before today) → inactive, finding unchanged", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    // NOW is 2026-06-11; expires 2026-06-10 is before today → inactive
    const ack = makeAck({ path: "src/**", expires: "2026-06-10" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(0);
    expect(result.findings[0]).toBe(finding);
  });

  test("ack expires exactly today → active (not yet expired)", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    // expires === today: active (boundary condition; expiry is exclusive)
    const ack = makeAck({ path: "src/**", expires: "2026-06-11" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: ack.reason });
  });

  test("ack expires in the future → active", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    const ack = makeAck({ path: "src/**", expires: "2027-01-01" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
  });

  test("finding with no location.path → only a broad glob (e.g. '**') can match", () => {
    const findingNoPath = makeFinding();
    const ackBroad = makeAck({ path: "**" });
    const ackNarrow = makeAck({ path: "src/**" });

    const broadResult = applyAcknowledgements([findingNoPath], [ackBroad], NOW);
    const narrowResult = applyAcknowledgements([findingNoPath], [ackNarrow], NOW);

    expect(broadResult.acknowledgedCount).toBe(1);
    expect(narrowResult.acknowledgedCount).toBe(0);
  });

  test("order of findings is preserved", () => {
    const f1 = makeFinding({ title: "First", location: { path: "src/a.ts" } });
    const f2 = makeFinding({ title: "Second", location: { path: "lib/b.ts" } });
    const f3 = makeFinding({ title: "Third", location: { path: "src/c.ts" } });
    // Only src/** matches f1 and f3
    const ack = makeAck({ path: "src/**", mode: "acknowledge" });

    const result = applyAcknowledgements([f1, f2, f3], [ack], NOW);

    expect(result.findings.map((f) => f.title)).toEqual(["First", "Second", "Third"]);
    expect(result.findings[0]?.acknowledged).toBeDefined();
    expect(result.findings[1]?.acknowledged).toBeUndefined();
    expect(result.findings[2]?.acknowledged).toBeDefined();
    expect(result.acknowledgedCount).toBe(2);
  });

  test("first active matching ack is used (not subsequent ones)", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    const ack1 = makeAck({ path: "src/**", reason: "first reason" });
    const ack2 = makeAck({ path: "src/**", reason: "second reason" });

    const result = applyAcknowledgements([finding], [ack1, ack2], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: "first reason" });
  });

  test("inputs are not mutated", () => {
    const findings: Finding[] = [makeFinding({ location: { path: "src/auth.ts" } })];
    const acks: Acknowledgement[] = [makeAck({ path: "src/**" })];
    const findingsBefore = [...findings];
    const acksBefore = [...acks];

    applyAcknowledgements(findings, acks, NOW);

    expect(findings).toEqual(findingsBefore);
    expect(acks).toEqual(acksBefore);
  });

  // -------------------------------------------------------------------------
  // verdict surfacing (#256, M023 S04)
  // -------------------------------------------------------------------------

  test("verdict: 'dismissed' on ack is surfaced on finding.acknowledged (#256)", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      verdict: "dismissed",
      reason: "wrong call",
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({
      reason: "wrong call",
      verdict: "dismissed",
    });
  });

  test("verdict: 'acknowledged' on ack is surfaced on finding.acknowledged (#256)", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      verdict: "acknowledged",
      reason: "tracked",
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({
      reason: "tracked",
      verdict: "acknowledged",
    });
  });

  test("no verdict on ack → finding.acknowledged has no verdict property (back-compat, #256)", () => {
    const finding = makeFinding({ location: { path: "src/auth.ts" } });
    const ack = makeAck({ path: "src/**", mode: "acknowledge", reason: "legacy ack" });
    // Ensure no verdict key on the ack
    expect(ack.verdict).toBeUndefined();

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    const acknowledged = result.findings[0]?.acknowledged;
    expect(acknowledged).toEqual({ reason: "legacy ack" });
    // Explicitly check no verdict leaks in
    expect(acknowledged).not.toHaveProperty("verdict");
  });

  test("security finding with dismissed suppress ack → downgraded to acknowledge, verdict surfaced", () => {
    const finding = makeFinding({ reviewer: "security", location: { path: "src/auth.ts" } });
    const ack = makeAck({
      path: "src/**",
      mode: "suppress",
      verdict: "dismissed",
      reason: "accepted risk",
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    // Security guard: suppress → acknowledge; verdict is still surfaced
    expect(result.acknowledgedCount).toBe(1);
    expect(result.suppressedCount).toBe(0);
    expect(result.findings[0]?.acknowledged).toEqual({
      reason: "accepted risk",
      verdict: "dismissed",
    });
  });

  // -------------------------------------------------------------------------
  // Tolerant stableFindingId matching (#346, M032 S01)
  // -------------------------------------------------------------------------

  test("durability: ack pinned to drifted ID matches when no current finding carries that ID", () => {
    // The logical finding existed as "fnd_A" last run; this run the model assigned "fnd_B".
    // No finding in the current set carries "fnd_A" anymore → relax to path+category.
    const finding = makeFinding({
      id: "fnd_B",
      location: { path: "src/auth.ts" },
      category: "correctness",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      reason: "tracked in #42",
      stableFindingId: "fnd_A",
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: "tracked in #42" });
  });

  test("precision: ack pinned to fnd_X only acknowledges fnd_X, not sibling fnd_Y (both present)", () => {
    // Two findings on same path+category but distinct IDs — fnd_X is still live in the set,
    // so the ack must not spill onto fnd_Y.
    const findingX = makeFinding({
      id: "fnd_X",
      location: { path: "src/auth.ts" },
      category: "correctness",
      title: "Finding X",
    });
    const findingY = makeFinding({
      id: "fnd_Y",
      location: { path: "src/auth.ts" },
      category: "correctness",
      title: "Finding Y",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      reason: "tracked in #42",
      stableFindingId: "fnd_X",
    });

    const result = applyAcknowledgements([findingX, findingY], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    // fnd_X is acknowledged
    const acknowledgedFinding = result.findings.find((f) => f.id === "fnd_X");
    expect(acknowledgedFinding?.acknowledged).toEqual({ reason: "tracked in #42" });
    // fnd_Y is NOT acknowledged
    const sibling = result.findings.find((f) => f.id === "fnd_Y");
    expect(sibling?.acknowledged).toBeUndefined();
  });

  test("no stableFindingId on ack → path+category match still works (no behavior change)", () => {
    const finding = makeFinding({
      id: "fnd_abc",
      location: { path: "src/auth.ts" },
      category: "correctness",
    });
    // ack has no stableFindingId — should match on path alone (category not set either)
    const ack = makeAck({ path: "src/**", mode: "acknowledge", reason: "legacy ack" });
    expect(ack.stableFindingId).toBeUndefined();

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: "legacy ack" });
  });

  // -------------------------------------------------------------------------
  // Round-2 hardening: suppress stays exact; security never relaxes; scoped presence (#346)
  // -------------------------------------------------------------------------

  test("suppress stays exact: drifted ID is NOT suppressed (finding re-surfaces)", () => {
    // The logical finding was "fnd_A" last run; this run the model assigned "fnd_B".
    // mode:"suppress" must NOT relax — "fnd_A" is absent, so the finding re-surfaces.
    const finding = makeFinding({
      id: "fnd_B",
      location: { path: "src/util.ts" },
      reviewer: "code_quality",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "suppress",
      reason: "noise suppression",
      stableFindingId: "fnd_A",
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.suppressedCount).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toBe(finding);
  });

  test("suppress-spill guard: broad-glob suppress ack with absent ID does not suppress any findings", () => {
    // A broad suppress ack with a now-absent pinned ID must NOT spill onto unrelated findings
    // of differing categories under that path — this prevents over-broad silent suppression.
    const findingA = makeFinding({
      id: "fnd_X",
      location: { path: "src/auth.ts" },
      category: "security",
      reviewer: "security",
    });
    const findingB = makeFinding({
      id: "fnd_Y",
      location: { path: "src/util.ts" },
      category: "correctness",
      reviewer: "code_quality",
    });
    const findingC = makeFinding({
      id: "fnd_Z",
      location: { path: "src/perf.ts" },
      category: "performance",
      reviewer: "code_quality",
    });
    // Broad suppress ack pinned to an ID that is absent from the current set
    const ack = makeAck({
      path: "src/**",
      mode: "suppress",
      reason: "old suppression",
      stableFindingId: "fnd_GONE",
    });

    const result = applyAcknowledgements([findingA, findingB, findingC], [ack], NOW);

    // suppress must NOT relax — none of the findings should be suppressed
    expect(result.suppressedCount).toBe(0);
    expect(result.findings).toHaveLength(3);
    expect(result.findings.every((f) => f.acknowledged === undefined)).toBe(true);
  });

  test("security never relaxes: drifted security finding is NOT absorbed by acknowledge ack", () => {
    // Even in acknowledge mode, a security finding with a drifted ID must NOT be relaxed-matched.
    // The drifted security finding re-surfaces for manual review.
    const finding = makeFinding({
      id: "fnd_newSecId",
      location: { path: "src/auth.ts" },
      reviewer: "security",
      category: "security",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      reason: "reviewed and accepted",
      stableFindingId: "fnd_oldSecId", // absent from current set
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    // Security findings must not relax — the finding re-surfaces
    expect(result.acknowledgedCount).toBe(0);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.acknowledged).toBeUndefined();
  });

  test("presence-check scoping: pinned ID outside ack path does not disable acknowledge durability", () => {
    // The pinned ID "fnd_A" is absent under src/** (the ack's path) but happens to exist on an
    // unrelated finding in lib/**. The global-set approach would have seen it as "still live" and
    // kept the ack in exact mode, silently breaking durability. The scoped check must NOT see it.
    const driftedFinding = makeFinding({
      id: "fnd_B",
      location: { path: "src/auth.ts" },
      category: "correctness",
    });
    const unrelatedFinding = makeFinding({
      id: "fnd_A", // same as pinned ID, but lives outside the ack's src/** path
      location: { path: "lib/utils.ts" },
      category: "correctness",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      reason: "tracked in #42",
      stableFindingId: "fnd_A",
    });

    const result = applyAcknowledgements([driftedFinding, unrelatedFinding], [ack], NOW);

    // fnd_A is outside src/**, so the scoped presence check returns false → durability kicks in.
    // The drifted src/ finding should be acknowledged (path+category relaxed match).
    expect(result.acknowledgedCount).toBe(1);
    const ackFinding = result.findings.find((f) => f.id === "fnd_B");
    expect(ackFinding?.acknowledged).toEqual({ reason: "tracked in #42" });
    // The unrelated lib/ finding is unchanged
    const unrelatedResult = result.findings.find((f) => f.id === "fnd_A");
    expect(unrelatedResult?.acknowledged).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Round-3 hardening: fan-out prevention + single-match durability (#346)
  // -------------------------------------------------------------------------

  test("fan-out prevented: drifted ID with ≥2 path+category matches → NONE acknowledged", () => {
    // A pinned ID has drifted away, and there are two findings on the same path+category.
    // Relaxation must NOT fire (ambiguous) — the ack fans out to neither sibling.
    // The operator must update the stableFindingId to re-pin to the intended finding.
    const findingX = makeFinding({
      id: "fnd_X",
      location: { path: "src/auth.ts" },
      category: "correctness",
      title: "Finding X",
    });
    const findingY = makeFinding({
      id: "fnd_Y",
      location: { path: "src/auth.ts" },
      category: "correctness",
      title: "Finding Y",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      reason: "tracked in #42",
      stableFindingId: "fnd_GONE", // absent from current set; both X and Y match path+category
    });

    const result = applyAcknowledgements([findingX, findingY], [ack], NOW);

    // Ambiguous: two path+category matches — relaxation must not fire
    expect(result.acknowledgedCount).toBe(0);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]?.acknowledged).toBeUndefined();
    expect(result.findings[1]?.acknowledged).toBeUndefined();
  });

  test("single-match durability preserved: drifted ID + exactly one path+category match → acknowledged", () => {
    // Exactly one finding exists matching path+category, and the pinned ID has drifted.
    // Relaxation MUST fire (unambiguous: this is the drifted finding).
    // This is the core durability guarantee from round 1 — must remain green.
    const finding = makeFinding({
      id: "fnd_NEW",
      location: { path: "src/auth.ts" },
      category: "correctness",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      reason: "tracked in #42",
      stableFindingId: "fnd_OLD", // absent — exactly one path+category match in scope
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({ reason: "tracked in #42" });
  });

  test("dismissed verdict with drifted ID + single path+category match → acknowledged with verdict", () => {
    // Verdict surfacing must work through the relaxation path (round-3 single-match case).
    const finding = makeFinding({
      id: "fnd_NEW",
      location: { path: "src/auth.ts" },
      category: "correctness",
    });
    const ack = makeAck({
      path: "src/**",
      mode: "acknowledge",
      verdict: "dismissed",
      reason: "wrong call",
      stableFindingId: "fnd_OLD", // absent — exactly one path+category match
    });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(1);
    expect(result.findings[0]?.acknowledged).toEqual({
      reason: "wrong call",
      verdict: "dismissed",
    });
  });

  test("fan-out: ≥2 matches across different paths (same category, broad glob) → NONE acknowledged", () => {
    // Even with a broad glob, if multiple findings match path+category, relaxation must not fire.
    const findingA = makeFinding({
      id: "fnd_A",
      location: { path: "src/a.ts" },
      category: "performance",
      title: "Finding A",
    });
    const findingB = makeFinding({
      id: "fnd_B",
      location: { path: "src/b.ts" },
      category: "performance",
      title: "Finding B",
    });
    const ack = makeAck({
      path: "src/**",
      category: "performance",
      mode: "acknowledge",
      reason: "accepted",
      stableFindingId: "fnd_GONE",
    });

    const result = applyAcknowledgements([findingA, findingB], [ack], NOW);

    // Both match path+category → fan-out guard fires → neither is acknowledged
    expect(result.acknowledgedCount).toBe(0);
    expect(result.findings[0]?.acknowledged).toBeUndefined();
    expect(result.findings[1]?.acknowledged).toBeUndefined();
  });
});
