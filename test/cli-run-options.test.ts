import { describe, expect, test } from "bun:test";
import {
  conventionApiKeyEnvVar,
  parseRunPublishOptions,
  resolveConventionApiKey,
  resolveRuntimeName,
} from "../src/cli/run-options.ts";

describe("CLI run publish options", () => {
  test("keeps summary and inline publishing disabled by default", () => {
    expect(parseRunPublishOptions(["--fixture", "examples/fixtures/auth-pr.json"])).toEqual({
      publishSummary: false,
      publishInline: false,
      forceReview: false,
    });
  });

  test("parses summary and inline publishing independently", () => {
    expect(parseRunPublishOptions(["--publish-summary"])).toEqual({
      publishSummary: true,
      publishInline: false,
      forceReview: false,
    });
    expect(parseRunPublishOptions(["--publish-inline"])).toEqual({
      publishSummary: false,
      publishInline: true,
      forceReview: false,
    });
    expect(parseRunPublishOptions(["--publish-summary", "--publish-inline"])).toEqual({
      publishSummary: true,
      publishInline: true,
      forceReview: false,
    });
  });

  test("parses --force-review flag", () => {
    expect(parseRunPublishOptions(["--force-review"])).toEqual({
      publishSummary: false,
      publishInline: false,
      forceReview: true,
    });
    expect(parseRunPublishOptions(["--publish-summary", "--force-review"])).toEqual({
      publishSummary: true,
      publishInline: false,
      forceReview: true,
    });
  });
});

describe("resolveRuntimeName (#407 auto-infer)", () => {
  test("explicit --runtime always wins over the signal", () => {
    expect(resolveRuntimeName("pi", true, false)).toBe("pi");
    expect(resolveRuntimeName("pi", false, false)).toBe("pi");
    expect(resolveRuntimeName("dummy", false, false)).toBe("dummy");
  });

  test("explicit --runtime dummy + a real model/auth signal is rejected loudly", () => {
    expect(() => resolveRuntimeName("dummy", true, false)).toThrow("cannot be combined");
  });

  test("unset --runtime + a real model/auth signal infers pi (regardless of --git-diff)", () => {
    expect(resolveRuntimeName(undefined, true, false)).toBe("pi");
    expect(resolveRuntimeName(undefined, true, true)).toBe("pi");
  });

  test("unset --runtime + no signal preserves the prior default", () => {
    expect(resolveRuntimeName(undefined, false, true)).toBe("dummy"); // --git-diff default
    expect(resolveRuntimeName(undefined, false, false)).toBeUndefined(); // deterministic fake
  });

  test("an unsupported explicit runtime passes through (cli.ts validates it separately)", () => {
    expect(resolveRuntimeName("foo", false, false)).toBe("foo");
  });
});

describe("conventionApiKeyEnvVar (#407)", () => {
  test("maps known providers to their conventional env var", () => {
    expect(conventionApiKeyEnvVar("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(conventionApiKeyEnvVar("openai")).toBe("OPENAI_API_KEY");
    expect(conventionApiKeyEnvVar("google")).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });

  test("returns undefined for an unmapped provider", () => {
    expect(conventionApiKeyEnvVar("exotic")).toBeUndefined();
  });
});

describe("resolveConventionApiKey (#407 env-key forward)", () => {
  test("forwards the convention env var when pi is selected via --model with no explicit key", () => {
    expect(
      resolveConventionApiKey({
        runtimeName: "pi",
        fromModelFlag: true,
        provider: "anthropic",
        env: { ANTHROPIC_API_KEY: "sk-x" },
      }),
    ).toBe("sk-x");
  });

  test("returns undefined when the convention env var is unset or empty (pi uses its own auth)", () => {
    expect(
      resolveConventionApiKey({
        runtimeName: "pi",
        fromModelFlag: true,
        provider: "anthropic",
        env: {},
      }),
    ).toBeUndefined();
    expect(
      resolveConventionApiKey({
        runtimeName: "pi",
        fromModelFlag: true,
        provider: "anthropic",
        env: { ANTHROPIC_API_KEY: "" },
      }),
    ).toBeUndefined();
  });

  test("throws for a --model provider with no known convention (must pass --api-key)", () => {
    expect(() =>
      resolveConventionApiKey({
        runtimeName: "pi",
        fromModelFlag: true,
        provider: "exotic",
        env: {},
      }),
    ).toThrow("no conventional API-key env var");
  });

  test("does not apply for non-pi runtime, the deprecated --pi-* path, or a missing provider", () => {
    const key = { ANTHROPIC_API_KEY: "sk-x" };
    expect(
      resolveConventionApiKey({
        runtimeName: "dummy",
        fromModelFlag: true,
        provider: "anthropic",
        env: key,
      }),
    ).toBeUndefined();
    expect(
      resolveConventionApiKey({
        runtimeName: "pi",
        fromModelFlag: false, // deprecated --pi-provider path keeps pi's native env/OAuth resolution
        provider: "anthropic",
        env: key,
      }),
    ).toBeUndefined();
    expect(
      resolveConventionApiKey({
        runtimeName: "pi",
        fromModelFlag: true,
        provider: undefined,
        env: key,
      }),
    ).toBeUndefined();
  });
});
