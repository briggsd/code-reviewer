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

  test("is first-wins when the tool is called more than once", () => {
    const events = [
      {
        type: "tool_execution_start",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: { findings: [1] },
      },
      {
        type: "tool_execution_start",
        toolName: SUBMIT_FINDINGS_TOOL_NAME,
        args: { findings: [2] },
      },
    ];
    const result = readToolCallArgs(events, SUBMIT_FINDINGS_TOOL_NAME);
    expect(result).toEqual({ status: "found", args: { findings: [1] } });
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
  test("validates a findings array into Finding[]", () => {
    const findings = parseReviewerToolArgs({ findings: [validFinding()] });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
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
    expect(parseReviewerToolArgs({ findings: [] })).toEqual([]);
  });

  test("drops a model-emitted finding id (#31/#32 trust boundary)", () => {
    const [finding] = parseReviewerToolArgs({
      findings: [validFinding({ id: "attacker-chosen-id" })],
    });
    expect(finding).not.toHaveProperty("id");
  });

  test("keeps a valid location and drops one missing a string path", () => {
    const [withLocation] = parseReviewerToolArgs({
      findings: [validFinding({ location: { path: "src/a.ts", line: 3 } })],
    });
    expect(withLocation?.location).toEqual({ path: "src/a.ts", line: 3 });

    const [withoutLocation] = parseReviewerToolArgs({
      findings: [validFinding({ location: { line: 3 } })],
    });
    expect(withoutLocation).not.toHaveProperty("location");
  });

  test("normalizes quotedCode and a string evidence value", () => {
    const [finding] = parseReviewerToolArgs({
      findings: [validFinding({ evidence: "single string", quotedCode: ["  padded line  "] })],
    });
    expect(finding?.evidence).toEqual(["single string"]);
    expect(finding?.quotedCode).toEqual(["padded line"]);
  });

  test("throws when args is not an object", () => {
    expect(() => parseReviewerToolArgs(null)).toThrow();
    expect(() => parseReviewerToolArgs([validFinding()])).toThrow();
  });

  test("throws when findings is missing or not an array", () => {
    expect(() => parseReviewerToolArgs({})).toThrow(/findings array/);
    expect(() => parseReviewerToolArgs({ findings: "nope" })).toThrow(/findings array/);
  });

  test("throws when a finding is missing a required field", () => {
    const { recommendation, ...incomplete } = validFinding();
    expect(() => parseReviewerToolArgs({ findings: [incomplete] })).toThrow(/invalid finding/);
  });

  // `evidence` is a required, non-empty string array in the schema, so a null or non-string-scalar
  // value is malformed and must be rejected (NOT leniently coerced to []). `undefined`/absent is the
  // only "empty is ok" case (covered by validFinding's default). This pins that boundary.
  test("rejects a null or non-string-scalar evidence value", () => {
    expect(() => parseReviewerToolArgs({ findings: [validFinding({ evidence: null })] })).toThrow(
      /invalid finding/,
    );
    expect(() => parseReviewerToolArgs({ findings: [validFinding({ evidence: 42 })] })).toThrow(
      /invalid finding/,
    );
  });

  test("throws on an invalid severity/confidence enum value", () => {
    expect(() =>
      parseReviewerToolArgs({ findings: [validFinding({ severity: "blocker" })] }),
    ).toThrow();
    expect(() =>
      parseReviewerToolArgs({ findings: [validFinding({ confidence: "certain" })] }),
    ).toThrow();
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
    const findings = parseReviewerToolArgs(result.args);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.severity)).toEqual(["warning", "critical"]);
  });
});
