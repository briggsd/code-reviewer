import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempDirectory = await mkdtemp(join(tmpdir(), "ai-review-pack-"));

try {
  const pack = await run(["npm", "pack", "--json", "--pack-destination", tempDirectory]);
  const packed = JSON.parse(pack.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
  const artifact = packed[0];
  if (artifact === undefined) {
    throw new Error("npm pack did not report an artifact");
  }

  const files = artifact.files.map((file) => file.path).sort();
  assertIncludes(files, "package.json");
  assertIncludes(files, "src/cli.ts");
  assertIncludes(files, "src/index.ts");
  assertIncludes(files, "README.md");
  assertIncludes(files, ".ai-review.schema.json");
  assertIncludes(files, "examples/ci/github-actions-ai-review.yml");
  assertIncludes(files, "examples/ci/gitlab-ai-review.yml");
  assertExcludesPrefix(files, "test/");
  assertExcludesPrefix(files, ".github/");
  assertExcludes(files, "continue.md");

  const tarball = join(tempDirectory, artifact.filename);
  if (!existsSync(tarball)) {
    throw new Error(`expected tarball to exist: ${tarball}`);
  }

  await run(["tar", "-xzf", tarball, "-C", tempDirectory]);
  const cli = join(tempDirectory, "package", "src", "cli.ts");
  const schemas = await run(["bun", cli, "schemas"]);
  const parsed = JSON.parse(schemas.stdout) as { config?: unknown; finding?: unknown };
  if (parsed.config === undefined || parsed.finding === undefined) {
    throw new Error("packaged CLI schemas output is missing expected schemas");
  }

  console.log(`package smoke passed: ${artifact.filename} (${files.length} files)`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}

function assertIncludes(files: string[], path: string): void {
  if (!files.includes(path)) {
    throw new Error(`package is missing expected file: ${path}`);
  }
}

function assertExcludes(files: string[], path: string): void {
  if (files.includes(path)) {
    throw new Error(`package includes unexpected file: ${path}`);
  }
}

function assertExcludesPrefix(files: string[], prefix: string): void {
  const match = files.find((file) => file.startsWith(prefix));
  if (match !== undefined) {
    throw new Error(`package includes unexpected ${prefix} file: ${match}`);
  }
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
