import { describe, expect, test } from "bun:test";
import {
  extractFencedJson,
  parseJsonCandidate,
  parseJsonObject,
} from "../src/runtime/pi-json-repair.ts";

// Focused unit tests for the pi-json-repair leaf module (#155).
// All three exported functions are pure string → value transforms with no network or fixture
// dependencies. The end-to-end parse/repair path is also exercised by test/pi-runtime.test.ts
// (via FakePiProcessRunner); this suite covers the unit-level behaviors directly.

describe("parseJsonObject", () => {
  test("parses a clean JSON object", () => {
    const result = parseJsonObject('{"findings": [], "decision": "approved"}');
    expect(JSON.stringify(result)).toBe('{"findings":[],"decision":"approved"}');
  });

  test("parses a clean JSON array", () => {
    const result = parseJsonObject('[{"a": 1}, {"b": 2}]');
    expect(Array.isArray(result)).toBe(true);
    expect(JSON.stringify(result)).toBe('[{"a":1},{"b":2}]');
  });

  test("extracts fenced JSON block when present", () => {
    const input = 'Some preamble text\n```json\n{"key": "value"}\n```\n';
    const result = parseJsonObject(input);
    expect(JSON.stringify(result)).toBe('{"key":"value"}');
  });

  test("falls back to {…} slice when there is leading and trailing prose", () => {
    const input = 'Here is the result: {"findings": []} done.';
    const result = parseJsonObject(input) as Record<string, unknown>;
    expect(Array.isArray(result["findings"])).toBe(true);
  });

  test("falls back to […] slice when there is a bare top-level array with prose", () => {
    const input = "Result: [1, 2, 3] end";
    const result = parseJsonObject(input);
    expect(JSON.stringify(result)).toBe("[1,2,3]");
  });

  test("throws when no JSON can be extracted", () => {
    expect(() => parseJsonObject("This is not JSON at all.")).toThrow(
      "Pi output did not contain valid JSON",
    );
  });
});

describe("parseJsonCandidate", () => {
  test("parses a clean JSON string directly", () => {
    const result = parseJsonCandidate('{"foo": "bar"}');
    expect(JSON.stringify(result)).toBe('{"foo":"bar"}');
  });

  test("repairs escaped markdown backticks (\\` is not a valid JSON escape)", () => {
    // A model may emit: {"body": "use \`npm install\`"} — the \` is invalid JSON
    const input = '{"body": "use \\`npm install\\`"}';
    const result = parseJsonCandidate(input) as Record<string, unknown>;
    expect(result["body"]).toBe("use `npm install`");
  });

  test("repairs unescaped inner quotes in an object value (the #119 quote-list case)", () => {
    // Model emits: {"description": "the branch is "ahead" or "behind" the base"}
    // The inner quotes around "ahead" and "behind" are prose, not JSON string delimiters.
    const input = '{"description": "the branch is \\"ahead\\" or \\"behind\\" the base"}';
    // This is already valid JSON (pre-escaped) — confirm it parses cleanly.
    const result = parseJsonCandidate(input) as Record<string, unknown>;
    expect(result["description"]).toBe('the branch is "ahead" or "behind" the base');
  });

  test("repairs unescaped inner quotes using the quote-repair path", () => {
    // Simulate a model that outputs quotes unescaped inside an object string value.
    // The repair heuristic should escape the inner quotes.
    // Note: repair only runs when JSON.parse first throws, so we need genuinely unescaped quotes.
    const raw = '{"body": "the state is "active" when enabled"}';
    // JSON.parse throws on this; the repair should fix it
    const result = parseJsonCandidate(raw) as Record<string, unknown>;
    expect(typeof result["body"]).toBe("string");
    expect((result["body"] as string).includes("active")).toBe(true);
  });

  test("throws when input is malformed beyond repair budget", () => {
    // Craft a string with > 20 unescaped quotes that the repair would try to fix.
    // Use an object value with many prose "words" in quotes.
    const manyQuotes = Array.from({ length: 25 }, (_, i) => `"word${i}"`).join(", ");
    const raw = `{"body": ${manyQuotes}}`;
    expect(() => parseJsonCandidate(raw)).toThrow();
  });
});

describe("extractFencedJson", () => {
  test("extracts content from a json-labeled fence", () => {
    const input = 'Some text\n```json\n{"key": "value"}\n```\nMore text';
    const result = extractFencedJson(input);
    expect(result).toBe('{"key": "value"}');
  });

  test("extracts content from a bare fence (no language label)", () => {
    const input = 'Intro\n```\n{"a": 1}\n```\n';
    const result = extractFencedJson(input);
    expect(result).toBe('{"a": 1}');
  });

  test("prefers a json-labeled fence over a bare fence by regex priority, not document order", () => {
    // The bare fence appears FIRST and the json-labeled fence SECOND, yet the json-labeled
    // block is the one extracted: extractFencedJson tries the json regex before the bare regex
    // (priority is by attempt order, `json ?? bare`), independent of where each fence sits in
    // the document.
    const input = '```\nnot this\n```\n\n```json\n{"pick": "me"}\n```\n';
    const result = extractFencedJson(input);
    expect(result).toContain("pick");
    expect(result).not.toContain("not this");
  });

  test("returns undefined when no fence is present", () => {
    const input = '{"key": "value"}';
    const result = extractFencedJson(input);
    expect(result).toBeUndefined();
  });

  test("returns undefined when fence has no closing delimiter", () => {
    const input = '```json\n{"unclosed": true}';
    const result = extractFencedJson(input);
    expect(result).toBeUndefined();
  });
});
