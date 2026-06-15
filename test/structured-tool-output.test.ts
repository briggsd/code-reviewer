import { describe, expect, test } from "bun:test";
import {
  parseReviewerToolArgs,
  readToolCallArgs,
  SUBMIT_FINDINGS_TOOL_NAME,
} from "../src/runtime/structured-tool-output.ts";

// A single valid finding shaped exactly as the `submit_findings` schema produces it.
function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reviewer: "correctness",
    severity: "warning",
    category: "logic",
    title: "Off-by-one in loop bound",
    body: "The loop reads one element past the end.",
    confidence: "high",
    evidence: ["the index runs to <= length"],
    recommendation: "Use < length.",
    ...overrides,
  };
}

// A `--mode json` event stream carrying one submit_findings tool call.
function eventStreamWith(args: unknown, toolName = SUBMIT_FINDINGS_TOOL_NAME): unknown[] {
  return [
    { type: "session", id: "abc" },
    { type: "message_start", message: { role: "user" } },
    { type: "tool_execution_start", toolCallId: "toolu_1", toolName, args },
    { type: "tool_execution_end", toolCallId: "toolu_1", toolName, result: "ok", isError: false },
    { type: "message_end", message: { role: "assistant", stopReason: "tool_use" } },
  ];
}

describe("readToolCallArgs", () => {
  test("returns the args of a matching tool_execution_start event", () => {
    const args = { findings: [] };
    const result = readToolCallArgs(eventStreamWith(args), SUBMIT_FINDINGS_TOOL_NAME);
    expect(result).toEqual({ status: "found", args });
  });

  // "first valid call wins": when multiple calls both succeed, return the first one's args.
  // This preserves first-wins determinism on the happy path (with paired end events).
  test("is first-valid-wins when the tool is called more than once (both accepted)", () => {
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "toolu_A",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: { findings: [1] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "toolu_A",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        isError: false,
      },
      {
        type: "tool_execution_start",
        toolCallId: "toolu_B",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: { findings: [2] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "toolu_B",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        isError: false,
      },
    ];
    const result = readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME);
    expect(result).toEqual({ status: "found", args: { findings: [1] } });
  });

  // #244 regression: the first call's end has isError: true (TypeBox-rejected partial args);
  // a later call is accepted by Pi — readToolCallArgs must return the later (valid) call's args.
  test("#244 regression: skips TypeBox-rejected first call (isError:true) and returns the later accepted call", () => {
    const partialArgs = { findings: [] }; // partial/incomplete — Pi rejected it
    const validArgs = { findings: [validFinding()] }; // complete — Pi accepted it
    const events = [
      // First call: Pi rejected (TypeBox validation failed)
      {
        type: "tool_execution_start",
        toolCallId: "toolu_1",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: partialArgs,
      },
      {
        type: "tool_execution_end",
        toolCallId: "toolu_1",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        isError: true,
      },
      // Second call: Pi accepted
      {
        type: "tool_execution_start",
        toolCallId: "toolu_2",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: validArgs,
      },
      {
        type: "tool_execution_end",
        toolCallId: "toolu_2",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        isError: false,
      },
    ];
    const result = readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME);
    expect(result).toEqual({ status: "found", args: validArgs });
  });

  // All calls rejected (all end events have isError:true) → absent, caller falls back to prose.
  test("returns absent when all calls were TypeBox-rejected (isError:true)", () => {
    const events = [
      {
        type: "tool_execution_start",
        toolCallId: "toolu_1",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: { findings: [1] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "toolu_1",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        isError: true,
      },
      {
        type: "tool_execution_start",
        toolCallId: "toolu_2",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: { findings: [2] },
      },
      {
        type: "tool_execution_end",
        toolCallId: "toolu_2",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        isError: true,
      },
    ];
    expect(readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME)).toEqual({ status: "absent" });
  });

  test("ignores tool_execution_start events for other tools", () => {
    const events = [
      { type: "tool_execution_start", toolName: "read", args: { path: "x" } },
      { type: "tool_execution_start", toolName: "bash", args: { cmd: "ls" } },
    ];
    expect(readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME)).toEqual({ status: "absent" });
  });

  test("ignores non-start events that carry the tool name (end, update)", () => {
    const events = [
      { type: "tool_execution_end", toolName: SUBMIT_FINDINGS_TOOL_NAME, result: "ok" },
      {
        type: "tool_execution_update",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: { findings: [] },
      },
    ];
    expect(readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME)).toEqual({ status: "absent" });
  });

  test("returns absent when the tool was never called (prose path → caller falls back)", () => {
    const events = [
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "text" }] } },
    ];
    expect(readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME)).toEqual({ status: "absent" });
  });

  test("ignores malformed events without crashing", () => {
    const events = [
      null,
      "a string",
      42,
      ["an array"],
      {}, // no type
      { type: "tool_execution_start" }, // no toolName
      { type: "tool_execution_start", toolName: SUBMIT_FINDINGS_TOOL_NAME, args: { findings: [] } },
    ];
    expect(readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME)).toEqual({
      status: "found",
      args: { findings: [] },
    });
  });

  test("preserves args verbatim even when the payload is malformed (validation is separate)", () => {
    const events = [
      { type: "tool_execution_start", toolName: SUBMIT_FINDINGS_TOOL_NAME, args: "not an object" },
    ];
    expect(readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME)).toEqual({
      status: "found",
      args: "not an object",
    });
  });
});

describe("parseReviewerToolArgs", () => {
  test("validates a findings array and returns ParsedReviewerOutput", () => {
    const result = parseReviewerToolArgs({ findings: [validFinding()] });
    expect(result.findings).toHaveLength(1);
    expect(result.droppedFindingCount).toBe(0);
    expect(result.findings[0]).toMatchObject({
      reviewer: "correctness",
      severity: "warning",
      category: "logic",
      title: "Off-by-one in loop bound",
      confidence: "high",
      evidence: ["the index runs to <= length"],
      recommendation: "Use < length.",
    });
  });

  test("accepts an empty findings array (clean diff)", () => {
    expect(parseReviewerToolArgs({ findings: [] })).toEqual({
      findings: [],
      droppedFindingCount: 0,
    });
  });

  test("drops a model-emitted finding id (#31/#32 trust boundary)", () => {
    const { findings } = parseReviewerToolArgs({
      findings: [validFinding({ id: "attacker-chosen-id" })],
    });
    expect(findings[0]).not.toHaveProperty("id");
  });

  test("keeps a valid location and drops one missing a string path", () => {
    const { findings: withLocationArr } = parseReviewerToolArgs({
      findings: [validFinding({ location: { path: "src/a.ts", line: 3 } })],
    });
    expect(withLocationArr[0]?.location).toEqual({ path: "src/a.ts", line: 3 });

    const { findings: withoutLocationArr } = parseReviewerToolArgs({
      findings: [validFinding({ location: { line: 3 } })],
    });
    expect(withoutLocationArr[0]).not.toHaveProperty("location");
  });

  test("normalizes quotedCode and a string evidence value", () => {
    const { findings } = parseReviewerToolArgs({
      findings: [validFinding({ evidence: "single string", quotedCode: ["  padded line  "] })],
    });
    expect(findings[0]?.evidence).toEqual(["single string"]);
    expect(findings[0]?.quotedCode).toEqual(["padded line"]);
  });

  test("throws when args is not an object", () => {
    expect(() => parseReviewerToolArgs(null)).toThrow();
    expect(() => parseReviewerToolArgs([validFinding()])).toThrow();
  });

  test("throws when findings is missing or not an array", () => {
    expect(() => parseReviewerToolArgs({})).toThrow(/findings array/);
    expect(() => parseReviewerToolArgs({ findings: "nope" })).toThrow(/findings array/);
  });

  test("drops a single invalid finding (missing required field) and throws all-dropped", () => {
    const { recommendation, ...incomplete } = validFinding();
    expect(() => parseReviewerToolArgs({ findings: [incomplete] })).toThrow(
      /all findings failed validation/,
    );
  });

  // `evidence` is a required, non-empty string array in the schema, so a null or non-string-scalar
  // value is malformed and must be rejected (NOT leniently coerced to []). `undefined`/absent is the
  // only "empty is ok" case (covered by validFinding's default). This pins that boundary.
  test("rejects a null or non-string-scalar evidence value (all-dropped throws)", () => {
    expect(() => parseReviewerToolArgs({ findings: [validFinding({ evidence: null })] })).toThrow(
      /all findings failed validation/,
    );
    expect(() => parseReviewerToolArgs({ findings: [validFinding({ evidence: 42 })] })).toThrow(
      /all findings failed validation/,
    );
  });

  test("throws all-dropped on an invalid severity/confidence enum value (single-element)", () => {
    expect(() =>
      parseReviewerToolArgs({ findings: [validFinding({ severity: "blocker" })] }),
    ).toThrow(/all findings failed validation/);
    expect(() =>
      parseReviewerToolArgs({ findings: [validFinding({ confidence: "certain" })] }),
    ).toThrow(/all findings failed validation/);
  });

  // Tolerant drop: one invalid + one valid → keep valid, count the drop, no throw.
  test("drops one invalid finding and keeps the valid one (droppedFindingCount: 1)", () => {
    const { recommendation, ...incomplete } = validFinding();
    const result = parseReviewerToolArgs({
      findings: [incomplete, validFinding({ severity: "critical" })],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe("critical");
    expect(result.droppedFindingCount).toBe(1);
  });

  // All-invalid non-empty array: no findings survive → throws, no false-approve.
  test("throws when all findings in a non-empty array are invalid (no false-approve)", () => {
    const { recommendation, ...incomplete } = validFinding();
    expect(() => parseReviewerToolArgs({ findings: [incomplete, incomplete] })).toThrow(
      /all findings failed validation/,
    );
  });

  // Clean passthrough: N valid findings → droppedFindingCount: 0.
  test("passes through N valid findings with droppedFindingCount: 0", () => {
    const result = parseReviewerToolArgs({
      findings: [
        validFinding(),
        validFinding({ severity: "critical" }),
        validFinding({ severity: "suggestion" }),
      ],
    });
    expect(result.findings).toHaveLength(3);
    expect(result.droppedFindingCount).toBe(0);
  });
});

describe("readToolCallArgs + parseReviewerToolArgs (end to end)", () => {
  test("reads a fixture event stream and returns validated findings", () => {
    const args = { findings: [validFinding(), validFinding({ severity: "critical" })] };
    const result = readToolCallArgs(eventStreamWith(args), SUBMIT_FINDINGS_TOOL_NAME);
    expect(result.status).toBe("found");
    if (result.status !== "found") {
      throw new Error("expected found");
    }
    const { findings } = parseReviewerToolArgs(result.args);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.severity)).toEqual(["warning", "critical"]);
  });
});
