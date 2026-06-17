#!/usr/bin/env bun

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "ai-review-action-wrapper-smoke-"));
const packDirectory = join(temp, "pack");
const outputDirectory = join(temp, "output");
const bunInstall = join(temp, "bun-global");

try {
  await Bun.$`mkdir -p ${packDirectory} ${outputDirectory} ${bunInstall}`;
  await Bun.$`npm pack --pack-destination ${packDirectory}`.cwd(root).quiet();
  const tarballs = (await readdir(packDirectory)).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one package tarball, found ${tarballs.length}`);
  }

  const tarball = join(packDirectory, tarballs[0] as string);
  const install = Bun.spawn(["bun", "add", "--global", tarball], {
    cwd: temp,
    env: {
      ...process.env,
      BUN_INSTALL: bunInstall,
      PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const installExit = await install.exited;
  if (installExit !== 0) {
    throw new Error(
      `action wrapper smoke install failed: ${await new Response(install.stderr).text()}`,
    );
  }

  const fixture = resolve(root, "examples/fixtures/auth-pr.json");
  const run = Bun.spawn(
    [
      join(bunInstall, "bin", "code-reviewer"),
      "run",
      "--fixture",
      fixture,
      "--runtime",
      "dummy",
      "--output-dir",
      outputDirectory,
      "--format",
      "json",
      "--ci-exit",
    ],
    {
      cwd: temp,
      env: {
        ...process.env,
        BUN_INSTALL: bunInstall,
        PATH: `${join(bunInstall, "bin")}:${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [runExit, stdout, stderr] = await Promise.all([
    run.exited,
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
  ]);
  if (runExit !== 1) {
    throw new Error(
      `expected fixture policy exit code 1 from blocking fixture, got ${runExit}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
  if (!stdout.includes("Account lookup misses authorization")) {
    throw new Error("action wrapper smoke did not produce expected fixture finding");
  }

  console.log(
    `action wrapper smoke passed: installed ${tarballs[0]} and ran packaged code-reviewer`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
