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
    const findings = [
      makeFinding({ title: "Finding A" }),
      makeFinding({ title: "Finding B" }),
    ];

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

  test("stableFindingId mismatch → finding is unchanged", () => {
    const finding = makeFinding({ id: "fnd_abc123", location: { path: "src/auth.ts" } });
    const ack = makeAck({ path: "src/**", stableFindingId: "fnd_different" });

    const result = applyAcknowledgements([finding], [ack], NOW);

    expect(result.acknowledgedCount).toBe(0);
    expect(result.findings[0]).toBe(finding);
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
    const findings: Finding[] = [
      makeFinding({ location: { path: "src/auth.ts" } }),
    ];
    const acks: Acknowledgement[] = [makeAck({ path: "src/**" })];
    const findingsBefore = [...findings];
    const acksBefore = [...acks];

    applyAcknowledgements(findings, acks, NOW);

    expect(findings).toEqual(findingsBefore);
    expect(acks).toEqual(acksBefore);
  });
});
