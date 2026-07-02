import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("CLI CI exit behavior", () => {
  test("returns a non-zero OS exit code for fail-closed review failures", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--ci-exit",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AI review CI decision: fail");
  });

  test("returns zero for advisory fail-open review failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ai-review-cli-exit-"));
    const configPath = join(directory, "advisory.json");
    await writeFile(configPath, JSON.stringify({ mode: "advisory" }));

    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--config",
      configPath,
      "--runtime",
      "dummy",
      "--ci-exit",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("AI review CI decision: pass");
  });

  // Regression for the partial-timeout fail-closed bug (PR #43 review): when the
  // overall timeout returns a `review_failed` partial while an outstanding child
  // handle is still alive at shutdown, the OS exit code must be 1. The old
  // deferred `process.exitCode = code` force-exited 0 in this exact condition,
  // which the dummy-runtime tests above cannot reproduce (no outstanding handle).
  test("returns a non-zero OS exit code when a partial timeout fails with a live subprocess handle", async () => {
    const proc = Bun.spawn(["bun", "run", "test/support/partial-timeout-cli-harness.ts"], {
      stdout: "pipe",
      stderr: "pipe",
      env: processEnvWithoutColor(),
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

    expect(stderr).toContain("decision=review_failed");
    expect(stderr).toContain("summary.title=Partial");
    expect(exitCode).toBe(1);
  });
});

describe("CLI Pi auth + progress flags", () => {
  test("rejects a real auth flag under an explicit --runtime dummy (#42/#407)", async () => {
    // #407: auto-infer replaced the old "--pi-api-key requires --runtime pi" error. An explicit
    // --runtime dummy with a real auth flag is now rejected loudly (it would run a fake review).
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--pi-api-key",
      "sk-ant-should-not-be-used",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--runtime dummy cannot be combined with");
    // The rejected key value must never be echoed back.
    expect(result.stderr).not.toContain("sk-ant-should-not-be-used");
    expect(result.stdout).toBe("");
  });

  test("errors when --pi-api-key env:NAME points at an unset variable (#42)", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "pi",
      "--pi-api-key",
      "env:AI_REVIEW_TEST_MISSING_KEY",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("AI_REVIEW_TEST_MISSING_KEY is empty or unset");
  });

  test("rejects an empty bare --pi-api-key value (#42)", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "pi",
      "--pi-api-key",
      "",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--pi-api-key value must not be empty");
  });

  test("--progress keeps the stdout JSON summary byte-for-byte clean (#41)", async () => {
    const result = await runCli([
      "run",
      "--fixture",
      "examples/fixtures/auth-pr.json",
      "--runtime",
      "dummy",
      "--progress",
    ]);

    expect(result.exitCode).toBe(0);
    // stdout must remain parseable JSON — progress lines go to stderr only.
    const parsed = JSON.parse(result.stdout) as { decision?: unknown };
    expect(parsed.decision).toBeDefined();
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
