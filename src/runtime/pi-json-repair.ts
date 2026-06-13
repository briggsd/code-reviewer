/**
 * Pure, hand-rolled JSON parse and repair for LLM prose output.
 *
 * This is a leaf module with no imports from the rest of src/runtime — it is
 * safe to import from any layer. The three exported entry points are used by
 * reviewer-output-validation.ts; the repair helpers are module-internal.
 */

// The #119 fix: a budget cap so a pathological quote-list that would require more
// than MAX_UNESCAPED_QUOTE_REPAIRS repairs is rejected rather than silently mis-parsed.
const MAX_UNESCAPED_QUOTE_REPAIRS = 20;

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const candidate = extractFencedJson(trimmed) ?? trimmed;

  try {
    return parseJsonCandidate(candidate);
  } catch {
    const objectStart = candidate.indexOf("{");
    const objectEnd = candidate.lastIndexOf("}");
    if (objectStart !== -1 && objectEnd > objectStart) {
      return parseJsonCandidate(candidate.slice(objectStart, objectEnd + 1));
    }

    const arrayStart = candidate.indexOf("[");
    const arrayEnd = candidate.lastIndexOf("]");
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      return parseJsonCandidate(candidate.slice(arrayStart, arrayEnd + 1));
    }

    throw new Error("Pi output did not contain valid JSON");
  }
}

export function parseJsonCandidate(candidate: string): unknown {
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    const backtickRepaired = repairEscapedMarkdownBackticks(candidate);
    if (backtickRepaired !== candidate) {
      try {
        return JSON.parse(backtickRepaired) as unknown;
      } catch {
        // Keep trying narrowly-scoped repairs below, but preserve the original error
        // if none of the repair attempts produce valid JSON.
      }
    }

    const quoteRepair = repairUnescapedStringQuotes(backtickRepaired);
    if (quoteRepair.repairCount > MAX_UNESCAPED_QUOTE_REPAIRS) {
      throw new Error("Pi output did not contain valid JSON after bounded quote repair");
    }
    if (quoteRepair.text !== backtickRepaired) {
      try {
        return JSON.parse(quoteRepair.text) as unknown;
      } catch {
        throw error;
      }
    }

    throw error;
  }
}

export function extractFencedJson(trimmed: string): string | undefined {
  // Locate a fenced code block ANYWHERE in the output, not only at the start: models sometimes
  // emit a prose preamble before the fenced JSON (e.g. "I have enough to validate… Summary: …"),
  // and that preamble can itself contain `{`/`}` in inline code. Anchoring only to ^ missed those
  // and the downstream `indexOf("{")` fallback would then slice from a brace in the prose, yielding
  // a "JSON Parse error: Expected '}'". Prefer an explicitly json-labelled fence; fall back to a
  // bare fence. The fence must start at a line boundary so a ``` inside a JSON string value is not
  // mistaken for a block delimiter.
  const opening = trimmed.match(/(?:^|\n)```json[^\n]*\n/i) ?? trimmed.match(/(?:^|\n)```[^\n]*\n/);
  if (opening?.index === undefined) {
    return undefined;
  }

  const body = trimmed.slice(opening.index + opening[0].length);
  // Closing fence: the last line that begins with ```. Using the LAST occurrence keeps extraction
  // robust to a ``` appearing inside a JSON string value or to trailing prose after the block.
  const lastClose = body.lastIndexOf("\n```");
  if (lastClose === -1) {
    return undefined;
  }

  return body.slice(0, lastClose).trim();
}

function repairEscapedMarkdownBackticks(candidate: string): string {
  // Some models emit fenced JSON whose string fields escape Markdown code ticks as \`,
  // which is not a valid JSON escape sequence. Keep this repair intentionally narrow:
  // do not strip arbitrary backslashes because recommendations can legitimately contain
  // regexes, shell snippets, or paths where a backslash is meaningful. Only remove the
  // final backslash from an odd-length run immediately before a backtick.
  const repaired: string[] = [];
  let trailingBackslashes = 0;

  for (const character of candidate) {
    if (character === "`" && trailingBackslashes % 2 === 1) {
      repaired.pop();
    }

    repaired.push(character);
    trailingBackslashes = character === "\\" ? trailingBackslashes + 1 : 0;
  }

  return repaired.join("");
}

function repairUnescapedStringQuotes(candidate: string): { text: string; repairCount: number } {
  // Live model output can occasionally include prose quotes inside a JSON string without escaping
  // them. Treat a quote inside a string as a closing delimiter only when the surrounding structure
  // proves it ends the value. We track the enclosing container (object vs array) because the
  // disambiguation differs: inside an OBJECT a value string is only ever followed by `}` or
  // `,"<key>":`, so a prose list like `"ahead", "behind"` (each `",` mimicking a terminator) must
  // be escaped; inside an ARRAY a `,`/`]` after the quote really does separate/close elements.
  const repaired: string[] = [];
  const containerStack: Array<"object" | "array"> = [];
  let inString = false;
  let escaped = false;
  let repairCount = 0;

  for (let index = 0; index < candidate.length; index += 1) {
    const character = candidate[index] ?? "";

    if (!inString) {
      if (character === "{") {
        containerStack.push("object");
      } else if (character === "[") {
        containerStack.push("array");
      } else if (character === "}" || character === "]") {
        containerStack.pop();
      }
      if (character === '"') {
        inString = true;
      }
      repaired.push(character);
      continue;
    }

    if (escaped) {
      repaired.push(character);
      escaped = false;
      continue;
    }

    if (character === "\\") {
      repaired.push(character);
      escaped = true;
      continue;
    }

    if (character === '"') {
      // Default to "object" when the stack is empty (malformed top-level): the object rule is the
      // stricter, escape-leaning direction, which is the safe bias for an ambiguous quote.
      const container = containerStack[containerStack.length - 1] ?? "object";
      if (isLikelyJsonStringTerminator(candidate, index, container)) {
        inString = false;
        repaired.push(character);
      } else {
        repaired.push('\\"');
        repairCount += 1;
      }
      continue;
    }

    repaired.push(character);
  }

  return { text: repaired.join(""), repairCount };
}

function isLikelyJsonStringTerminator(
  candidate: string,
  quoteIndex: number,
  container: "object" | "array",
): boolean {
  for (let index = quoteIndex + 1; index < candidate.length; index += 1) {
    const character = candidate[index] ?? "";
    if (/\s/.test(character)) {
      continue;
    }

    // `:` ends a key string; `}`/`]` close the value's container. These are unambiguous.
    if (character === ":" || character === "}" || character === "]") {
      return true;
    }

    if (character === ",") {
      // Inside an array, an element is a VALUE: the quote really closed it only when the next
      // token begins a JSON value (the next element). Prose inside an element — e.g.
      // `["the API returns "ahead", but only when…"]` — fails this (`b` is not a value start), so
      // the inner quote is escaped. This is the original (correct) array behavior; do not make it
      // unconditional or it regresses `string[]` fields like `quotedCode` that hold verbatim code.
      if (container === "array") {
        return nextNonSpaceStartsJsonValue(candidate, index + 1);
      }
      // Inside an object, a value string is followed by `,` only when the NEXT token is another
      // key (`"<name>":`). A prose list like `means "foo", but …` or `"ahead", "behind"` fails
      // this — the next quoted token is followed by `,`/prose, not `:` — so the quote is a nested
      // prose quote that must be escaped, not the string end. Without this the repair would close
      // the string at `foo"` and the trailing prose becomes invalid JSON (the PR #98 / #115 cases).
      return nextTokenIsObjectKey(candidate, index + 1);
    }

    return false;
  }

  return true;
}

function nextNonSpaceStartsJsonValue(candidate: string, from: number): boolean {
  for (let index = from; index < candidate.length; index += 1) {
    const character = candidate[index] ?? "";
    if (/\s/.test(character)) {
      continue;
    }

    return (
      character === '"' ||
      character === "{" ||
      character === "[" ||
      character === "-" ||
      /[0-9]/.test(character) ||
      candidate.startsWith("true", index) ||
      candidate.startsWith("false", index) ||
      candidate.startsWith("null", index)
    );
  }

  // Nothing but whitespace after the comma (e.g. a trailing comma before the close): treat the
  // quote as a real terminator rather than escaping it.
  return true;
}

// True when the text at `from` is a JSON object key: a quoted string whose next non-whitespace
// character is `:`. Used to confirm that a `,` after a string really begins the next key/value
// pair (a real terminator) rather than continuing a prose list inside the current value.
function nextTokenIsObjectKey(candidate: string, from: number): boolean {
  let index = from;
  while (index < candidate.length && /\s/.test(candidate[index] ?? "")) {
    index += 1;
  }
  if ((candidate[index] ?? "") !== '"') {
    return false;
  }
  index += 1;
  // Walk to the closing quote of the candidate key, honoring backslash escapes.
  while (index < candidate.length) {
    const character = candidate[index] ?? "";
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') {
      index += 1;
      break;
    }
    index += 1;
  }
  while (index < candidate.length && /\s/.test(candidate[index] ?? "")) {
    index += 1;
  }
  return (candidate[index] ?? "") === ":";
}
