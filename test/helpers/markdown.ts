import type { EscapedString } from "../../src/publisher/markdown-escape.ts";

/** Test-only: cast a known-safe literal to EscapedString for assertions. NOT for production — performs no escaping. */
export function raw(trustedLiteral: string): EscapedString {
  return trustedLiteral as EscapedString;
}
