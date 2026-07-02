import { describe, expect, test } from "bun:test";

// Tests for the generic --model / --api-key flags (M035 S01, #406) and the
// deprecated --pi-* aliases. All offline — no network, no real provider.

describe("CLI --model flag parsing", () => {
  test("--model anthropic/claude-sonnet-4-6 parses without error", async () => {
    // A valid --model value must pass arg validation. The --model split runs in runCommand
    // BEFORE runtime construction, so --runtime dummy exercises the identical parse path while
    // staying hermetic — --runtime pi would spawn the real `pi` subprocess (a live call if a
    // provider key is present in the environment), which the no-network test rule forbids.
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--model",
      "anthropic/claude-sonnet-4-6",
    ]);

    // Arg-parse error should not appear.
    expect(result.stderr).not.toContain("--model must be");
    expect(result.stderr).not.toContain("--model cannot be combined");
  });

  test("--model with no slash fails with descriptive error", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--model",
      "anthropic-claude-sonnet-4-6",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--model must be <provider>/<model>");
  });

  test("--model with empty provider (leading slash) fails fast", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--model",
      "/claude-sonnet-4-6",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--model must be <provider>/<model>");
  });

  test("--model with empty model (trailing slash) fails fast", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--model",
      "anthropic/",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--model must be <provider>/<model>");
  });

  test("--model with a second slash keeps the rest as the model id (first-slash split)", async () => {
    // anthropic/foo/bar -> provider=anthropic, model=foo/bar — must NOT hit the parse error.
    // --runtime dummy keeps this hermetic (see the first test's note on avoiding a pi spawn).
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--model",
      "anthropic/foo/bar",
    ]);

    expect(result.stderr).not.toContain("--model must be <provider>/<model>");
    expect(result.stderr).not.toContain("--model cannot be combined");
  });

  test("--model combined with --pi-provider produces a conflict error", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "pi",
      "--model",
      "anthropic/claude-sonnet-4-6",
      "--pi-provider",
      "anthropic",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--model cannot be combined with --pi-provider/--pi-model");
  });
});

describe("CLI --api-key flag", () => {
  test("--api-key combined with --pi-api-key produces a conflict error", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "pi",
      "--api-key",
      "key-a",
      "--pi-api-key",
      "key-b",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--api-key cannot be combined with --pi-api-key");
  });

  test("--api-key under an explicit --runtime dummy is rejected loudly (#407)", async () => {
    // #407: auto-infer replaced the old "--api-key requires --runtime pi" error. An explicit
    // --runtime dummy with a real auth flag would run a fake review, so it is rejected loudly.
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--api-key",
      "sk-ant-test",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--runtime dummy cannot be combined with");
    // Key value must never be echoed.
    expect(result.stderr).not.toContain("sk-ant-test");
  });

  test("--api-key env:SOMEVAR unset produces error mentioning --api-key and the var name", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "pi",
      "--api-key",
      "env:AI_REVIEW_TEST_MISSING_KEY_GENERIC",
    ]);

    expect(result.exitCode).not.toBe(0);
    // Error must name --api-key (not --pi-api-key) and the variable.
    expect(result.stderr).toContain("--api-key");
    expect(result.stderr).toContain("AI_REVIEW_TEST_MISSING_KEY_GENERIC");
    expect(result.stderr).not.toContain("--pi-api-key");
  });
});

describe("CLI --pi-* deprecation warning", () => {
  test("--pi-provider and --pi-model emit a deprecation warning to stderr", async () => {
    // The deprecation note is emitted before runtime resolution. --runtime dummy + a --pi-* signal
    // is itself rejected loudly (#407), so this never reaches runtime construction — hermetic, and
    // the warning still surfaces before the error.
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--pi-provider",
      "anthropic",
      "--pi-model",
      "claude-sonnet-4-6",
    ]);

    // The deprecation note must appear regardless of whether the run itself succeeded.
    expect(result.stderr).toContain("deprecated");
  });
});

describe("CLI runtime auto-infer (#407)", () => {
  // These prove --runtime is auto-inferred to pi from a real model/auth flag. Each uses an input
  // that ERRORS before PiAgentRuntime is constructed, so no real `pi` subprocess is ever spawned
  // (a live call / hang would otherwise result when a provider key is present in the environment).
  test("--pi-api-key with no --runtime infers pi (old 'requires --runtime pi' wart is gone)", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--pi-api-key",
      "env:AI_REVIEW_TEST_MISSING_KEY_407",
    ]);

    expect(result.exitCode).not.toBe(0);
    // Auto-infer selected pi, so resolution proceeds to the key step and fails on the unset env
    // var — NOT on the removed "requires --runtime pi" guard.
    expect(result.stderr).toContain("is empty or unset");
    expect(result.stderr).not.toContain("requires --runtime pi");
  });

  test("--model with no --runtime infers pi; an unknown provider requires an explicit --api-key", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--model",
      "exotic/some-model",
    ]);

    expect(result.exitCode).not.toBe(0);
    // Auto-infer selected pi; the convention env-key lookup has no entry for 'exotic', so it fails
    // fast asking for an explicit --api-key (before any pi spawn).
    expect(result.stderr).toContain("no conventional API-key env var");
    expect(result.stderr).not.toContain("requires --runtime pi");
  });
});

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: processEnvWithoutColor(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  return { exitCode, stdout, stderr };
}

function processEnvWithoutColor(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NO_COLOR: "1",
  };
}
