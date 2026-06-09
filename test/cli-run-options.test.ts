import { describe, expect, test } from "bun:test";
import { parseRunPublishOptions } from "../src/cli/run-options.ts";

describe("CLI run publish options", () => {
  test("keeps summary and inline publishing disabled by default", () => {
    expect(parseRunPublishOptions(["--fixture", "examples/fixtures/auth-pr.json"])).toEqual({
      publishSummary: false,
      publishInline: false,
    });
  });

  test("parses summary and inline publishing independently", () => {
    expect(parseRunPublishOptions(["--publish-summary"])).toEqual({
      publishSummary: true,
      publishInline: false,
    });
    expect(parseRunPublishOptions(["--publish-inline"])).toEqual({
      publishSummary: false,
      publishInline: true,
    });
    expect(parseRunPublishOptions(["--publish-summary", "--publish-inline"])).toEqual({
      publishSummary: true,
      publishInline: true,
    });
  });
});
