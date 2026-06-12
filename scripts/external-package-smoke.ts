import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const tempDirectory = await mkdtemp(join(tmpdir(), "ai-review-external-package-"));
const bunInstallDirectory = join(tempDirectory, "bun-install");
const adopterDirectory = join(tempDirectory, "adopter-repo");
const installedCli = join(bunInstallDirectory, "bin", "ai-code-review");

try {
  const pack = await run(["npm", "pack", "--json", "--pack-destination", tempDirectory]);
  const packed = JSON.parse(pack.stdout) as Array<{ filename: string }>;
  const artifact = packed[0];
  if (artifact === undefined) {
    throw new Error("npm pack did not report an artifact");
  }

  const tarball = join(tempDirectory, artifact.filename);
  if (!existsSync(tarball)) {
    throw new Error(`expected tarball to exist: ${tarball}`);
  }

  await run(["mkdir", "-p", adopterDirectory]);
  await run(["bun", "add", "--global", tarball], {
    env: {
      ...process.env,
      BUN_INSTALL: bunInstallDirectory,
    },
  });

  if (!existsSync(installedCli)) {
    throw new Error(`expected installed CLI to exist: ${installedCli}`);
  }

  const schemas = await run([installedCli, "schemas"], { cwd: adopterDirectory });
  const parsedSchemas = JSON.parse(schemas.stdout) as { config?: unknown; finding?: unknown };
  if (parsedSchemas.config === undefined || parsedSchemas.finding === undefined) {
    throw new Error("installed CLI schemas output is missing expected schemas");
  }

  const fixturePath = join(adopterDirectory, "adopter-fixture.json");
  await writeFile(fixturePath, JSON.stringify(createAdopterFixture(), null, 2));
  const fixtureOutputDirectory = join(adopterDirectory, ".ai-review-fixture");
  const fixtureRun = await run(
    [
      installedCli,
      "run",
      "--fixture",
      fixturePath,
      "--runtime",
      "dummy",
      "--output-dir",
      fixtureOutputDirectory,
    ],
    { cwd: adopterDirectory },
  );
  assertSummary(JSON.parse(fixtureRun.stdout) as unknown, "fixture");
  await assertContextArtifacts({
    adopterDirectory,
    outputDirectory: fixtureOutputDirectory,
    runId: "adopter-smoke",
  });

  const provider = process.env.AI_REVIEW_EXTERNAL_SMOKE_PROVIDER;
  if (provider === undefined || provider.length === 0) {
    console.log(
      `external package smoke passed: ${artifact.filename}; provider dry-run skipped ` +
        "(set AI_REVIEW_EXTERNAL_SMOKE_PROVIDER, AI_REVIEW_EXTERNAL_SMOKE_REPO, and AI_REVIEW_EXTERNAL_SMOKE_CHANGE_ID)",
    );
  } else {
    await runProviderSmoke(provider);
    console.log(`external package smoke passed: ${artifact.filename}; provider=${provider}`);
  }
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

async function runProviderSmoke(provider: string): Promise<void> {
  if (provider !== "github" && provider !== "gitlab") {
    throw new Error("AI_REVIEW_EXTERNAL_SMOKE_PROVIDER must be github or gitlab");
  }

  const repo = requiredEnv("AI_REVIEW_EXTERNAL_SMOKE_REPO");
  const changeId = requiredEnv("AI_REVIEW_EXTERNAL_SMOKE_CHANGE_ID");
  const headSha = process.env.AI_REVIEW_EXTERNAL_SMOKE_HEAD_SHA;
  const providerOutputDirectory = join(adopterDirectory, ".ai-review-provider");
  const command = [
    installedCli,
    "run",
    "--provider",
    provider,
    "--repo",
    repo,
    "--change-id",
    changeId,
    "--runtime",
    "dummy",
    "--output-dir",
    providerOutputDirectory,
  ];

  if (headSha !== undefined && headSha.length > 0) {
    command.push("--head-sha", headSha);
  }

  const result = await run(command, { cwd: adopterDirectory });
  assertSummary(JSON.parse(result.stdout) as unknown, "provider");
}

function createAdopterFixture(): unknown {
  return {
    runId: "adopter-smoke",
    metadata: {
      provider: "github",
      repository: {
        provider: "github",
        owner: "example",
        name: "adopter-repo",
        slug: "example/adopter-repo",
        defaultBranch: "main",
      },
      changeId: "1",
      headSha: "adopter-head",
      baseSha: "adopter-base",
      sourceBranch: "feature/smoke",
      targetBranch: "main",
      title: "External package smoke",
      author: {
        username: "adopter",
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

async function assertContextArtifacts(input: {
  adopterDirectory: string;
  outputDirectory: string;
  runId: string;
}): Promise<void> {
  const sharedContextPath = join(
    input.adopterDirectory,
    ".ai-review",
    "context",
    "change-context.json",
  );
  if (!existsSync(sharedContextPath)) {
    throw new Error(`fixture run did not write shared context: ${sharedContextPath}`);
  }

  const sharedContext = JSON.parse(await readFile(sharedContextPath, "utf8")) as {
    diff?: { files?: Array<{ path?: string; patch?: string; patchPath?: string }> };
  };
  const file = sharedContext.diff?.files?.[0];
  if (file?.path !== "README.md" || file.patch !== undefined || file.patchPath === undefined) {
    throw new Error("shared context did not contain patchPath-only README.md metadata");
  }

  const patchPath = isAbsolute(file.patchPath)
    ? file.patchPath
    : join(input.adopterDirectory, file.patchPath);
  if (!existsSync(patchPath)) {
    throw new Error(`fixture run did not write patch artifact: ${patchPath}`);
  }
  const patch = await readFile(patchPath, "utf8");
  if (!patch.includes("Smoke line")) {
    throw new Error("patch artifact did not contain fixture patch contents");
  }

  const runRecord = JSON.parse(
    await readFile(join(input.outputDirectory, "runs", input.runId, "run.json"), "utf8"),
  ) as { metrics?: { context?: { patchFileCount?: number; artifactBytes?: number } } };
  if (
    runRecord.metrics?.context?.patchFileCount !== 1 ||
    (runRecord.metrics.context.artifactBytes ?? 0) <= 0
  ) {
    throw new Error("run metrics did not record context artifact bytes");
  }
}

function assertSummary(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} run did not output a JSON object`);
  }

  if (typeof value.title !== "string" || !Array.isArray(value.findings) || !isRecord(value.risk)) {
    throw new Error(`${label} run output is not a review summary`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`missing required env var ${name}`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

async function run(
  command: string[],
  options: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const subprocess = Bun.spawn(command, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
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
