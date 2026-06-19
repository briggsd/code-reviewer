import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64"];

interface ParsedArgs {
  targets: string[];
  outdir: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv: first two elements are bun + script path; rest are user args
  const args = argv.slice(2);
  const targets: string[] = [];
  let outdir = "dist";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--target") {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error("--target requires a value");
      }
      targets.push(next);
      i++;
    } else if (arg === "--outdir") {
      const next = args[i + 1];
      if (next === undefined) {
        throw new Error("--outdir requires a value");
      }
      outdir = next;
      i++;
    }
  }

  return {
    targets: targets.length > 0 ? targets : DEFAULT_TARGETS,
    outdir,
  };
}

function shortName(target: string): string {
  if (target === "host") {
    return "host";
  }
  // Strip "bun-" prefix: "bun-linux-x64" → "linux-x64"
  return target.startsWith("bun-") ? target.slice(4) : target;
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

async function compileBinary(
  target: string,
  outdir: string,
): Promise<{ path: string; size: number }> {
  const name = `code-reviewer-${shortName(target)}`;
  const outfile = join(outdir, name);

  const command: string[] = ["bun", "build", "--compile"];
  if (target !== "host") {
    command.push("--target", target);
  }
  command.push("src/cli.ts", "--outfile", outfile);

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

  const info = await stat(outfile);
  return { path: outfile, size: info.size };
}

const { targets, outdir } = parseArgs(Bun.argv);

await mkdir(outdir, { recursive: true });

const results: Array<{ target: string; path: string; size: number }> = [];

for (const target of targets) {
  const { path, size } = await compileBinary(target, outdir);
  results.push({ target, path, size });
  console.log(`${target} -> ${path} (${humanSize(size)})`);
}

const n = results.length;
console.log(`compiled ${n} binar${n === 1 ? "y" : "ies"} to ${outdir}`);
