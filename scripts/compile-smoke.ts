// Compile smoke: proves the compiled binary actually runs.
//
// HOST TARGET ONLY — cross-targets download Bun runtimes over the network
// and must NOT be run in this smoke (they are slow + require network access).
// This smoke compiles with no --target so it is fast and fully offline.

import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirectory = await mkdtemp(join(tmpdir(), "ai-review-compile-"));

try {
  // Compile host binary into temp dir
  const binaryPath = join(tempDirectory, "code-reviewer-host");
  await run(["bun", "build", "--compile", "src/cli.ts", "--outfile", binaryPath]);

  // Assertion a: <binary> schemas → parse stdout JSON, assert config and finding are defined
  const schemas = await run([binaryPath, "schemas"]);
  const parsedSchemas = JSON.parse(schemas.stdout) as {
    config?: unknown;
    finding?: unknown;
  };
  if (parsedSchemas.config === undefined || parsedSchemas.finding === undefined) {
    throw new Error("compiled CLI schemas output is missing expected schemas");
  }

  // Assertion b: <binary> run --fixture <tmp fixture> --runtime dummy --output-dir <tmp out>
  const fixturePath = join(tempDirectory, "smoke-fixture.json");
  await writeFile(fixturePath, JSON.stringify(createSmokeFixture(), null, 2));
  const fixtureOutputDirectory = join(tempDirectory, ".ai-review-fixture");
  const fixtureRun = await run([
    binaryPath,
    "run",
    "--fixture",
    fixturePath,
    "--runtime",
    "dummy",
    "--output-dir",
    fixtureOutputDirectory,
  ]);
  assertSummary(JSON.parse(fixtureRun.stdout) as unknown, "fixture");

  const info = await stat(binaryPath);
  const sizeBytes = info.size;
  const humanSz = humanSize(sizeBytes);
  console.log(`compile smoke passed: code-reviewer-host (${humanSz})`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

function createSmokeFixture(): unknown {
  return {
    runId: "compile-smoke",
    metadata: {
      provider: "github",
      repository: {
        provider: "github",
        owner: "example",
        name: "smoke-repo",
        slug: "example/smoke-repo",
        defaultBranch: "main",
      },
      changeId: "1",
      headSha: "compile-smoke-head",
      baseSha: "compile-smoke-base",
      sourceBranch: "feature/compile-smoke",
      targetBranch: "main",
      title: "Compile smoke",
      author: {
        username: "smoker",
      },
      labels: [],
    },
    diff: {
      files: [
        {
          path: "README.md",
          status: "modified",
          additions: 1,
          deletions: 0,
          isBinary: false,
          patch: "@@ -1 +1,2 @@\n # Example\n+Smoke line",
        },
      ],
      totalAdditions: 1,
      totalDeletions: 0,
      truncated: false,
    },
    config: {
      mode: "blocking",
      failOn: ["critical"],
    },
  };
}

function assertSummary(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} run did not output a JSON object`);
  }

  if (typeof value.title !== "string" || !Array.isArray(value.findings) || !isRecord(value.risk)) {
    throw new Error(`${label} run output is not a review summary`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function humanSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

async function run(command: string[]): Promise<{ stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${exitCode}\n${stderr}\n${stdout}`);
  }

  return { stdout, stderr };
}
