#!/usr/bin/env bun

/**
 * Deterministic docs-freshness checker (#92 + #29). Reads every tracked `*.md`
 * file and validates its references against the live repo:
 *
 *   bun run docs:check    # blocking: dead path / `bun run` script references → exit 1
 *   bun run docs:stale    # advisory: env-var / oversized-doc / repo-map drift → exit 0
 *   bun run scripts/check-docs.ts --mode=all   # both (local convenience)
 *
 * Pure rules live in src/docs-check; this wrapper only does git/filesystem IO.
 * Fast and no-network by design.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DocFinding, DocInput, KnownFacts } from "../src/docs-check/index.ts";
import { checkDocs } from "../src/docs-check/index.ts";

type Mode = "blocking" | "advisory" | "all";

const usage = `Usage: bun run scripts/check-docs.ts [--mode=blocking|advisory|all]

Validates references in tracked *.md files against the live repository.

  --mode=blocking  (default) report only dead path / script references; exit 1 if any
  --mode=advisory  report only staleness advisories (env vars, oversized docs, repo
                   map, unclosed code fences); exit 0
  --mode=all       report both; exit 1 only on blocking findings
  -h, --help       show this message

Milestone docs (docs/milestones/**) are historical records and are exempt from
the blocking path/script rules.`;

// All git invocations and file reads are anchored to the repo root so the check
// behaves identically regardless of the caller's working directory.
const repoRoot = (() => {
  const result = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    throw new Error(`not inside a git repository: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
})();

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const mode = parseMode(Bun.argv.slice(2));

  const docPaths = gitLines(["ls-files", "*.md"]);
  const docs: DocInput[] = await Promise.all(
    docPaths.map(
      async (path): Promise<DocInput> => ({
        path,
        text: await readFile(join(repoRoot, path), "utf8"),
        scope: path.startsWith("docs/milestones/") ? "historical" : "live",
      }),
    ),
  );

  const facts = buildKnownFacts();
  const report = checkDocs(docs, facts);

  const showBlocking = mode !== "advisory";
  const showAdvisory = mode !== "blocking";

  if (showBlocking) {
    printGroup("Dead references (blocking)", "❌", report.blocking);
  }
  if (showAdvisory) {
    printGroup("Staleness advisories", "⚠️", report.advisory);
  }

  const blockingCount = report.blocking.length;
  const advisoryCount = report.advisory.length;
  console.log(
    `\nChecked ${docs.length} markdown files: ${blockingCount} blocking, ${advisoryCount} advisory.`,
  );

  const failed = showBlocking && blockingCount > 0;
  if (failed) {
    console.log("Fix the dead references above (or update the docs). Run `bun run docs:check`.");
  }
  process.exit(failed ? 1 : 0);
}

function printGroup(title: string, icon: string, findings: readonly DocFinding[]): void {
  if (findings.length === 0) {
    console.log(`✅ ${title}: none`);
    return;
  }
  console.log(`${title}:`);
  const byDoc = new Map<string, DocFinding[]>();
  for (const f of findings) {
    const list = byDoc.get(f.doc) ?? [];
    list.push(f);
    byDoc.set(f.doc, list);
  }
  for (const [doc, list] of [...byDoc.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${doc}`);
    for (const f of list.sort((a, b) => a.line - b.line)) {
      console.log(`    ${icon} L${f.line}: ${f.message}`);
    }
  }
}

function buildKnownFacts(): KnownFacts {
  const trackedFiles = gitLines(["ls-files"]);
  const existingPaths = new Set<string>();
  for (const file of trackedFiles) {
    existingPaths.add(file);
    // add every ancestor directory via an O(depth) running prefix (no slice/join)
    const parts = file.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      if (seg === undefined) continue;
      prefix = prefix.length > 0 ? `${prefix}/${seg}` : seg;
      existingPaths.add(prefix);
    }
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  const scriptNames = new Set<string>(pkg.scripts ? Object.keys(pkg.scripts) : []);

  return { existingPaths, scriptNames, envVarNames: collectEnvVarNames() };
}

/**
 * Source-of-truth for AI_REVIEW_* env vars: every such token referenced in code
 * or CI. Scans src/scripts/test/evals, `.github`, and all tracked *.yml/*.yaml
 * files (git matches the bare `*.yml` pathspec by basename across the tree, which
 * includes `action.yml` at the repo root).
 */
function collectEnvVarNames(): Set<string> {
  const result = Bun.spawnSync(
    [
      "git",
      "grep",
      "-hoIE",
      "AI_REVIEW_[A-Z0-9_]+",
      "--",
      "src",
      "scripts",
      "test",
      "evals",
      ".github",
      "*.yml",
      "*.yaml",
    ],
    { cwd: repoRoot },
  );
  // git grep exits 1 when there are no matches; 0 means matches found. Any other
  // code — including null when git cannot be spawned — is a real failure we must
  // surface (otherwise an empty source-of-truth set floods env-var advisories).
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`git grep failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
  }
  return new Set(
    result.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

function parseMode(argv: readonly string[]): Mode {
  let mode: Mode = "blocking";
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      console.log(usage);
      process.exit(0);
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "blocking" && value !== "advisory" && value !== "all") {
        throw new Error(`--mode must be blocking|advisory|all (got "${value}")`);
      }
      mode = value;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return mode;
}

function gitLines(args: readonly string[]): string[] {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}
