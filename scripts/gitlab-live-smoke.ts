#!/usr/bin/env bun

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const enabled = process.env.AI_REVIEW_LIVE_GITLAB === "1";

if (!enabled) {
  console.log("GitLab live smoke skipped: set AI_REVIEW_LIVE_GITLAB=1 to run against a real merge request.");
  process.exit(0);
}

const repo = requiredEnv("AI_REVIEW_GITLAB_REPO");
const changeId = requiredEnv("AI_REVIEW_GITLAB_CHANGE_ID");
const token = process.env.AI_REVIEW_GITLAB_TOKEN ?? process.env.GITLAB_TOKEN;
if (token === undefined || token.length === 0) {
  throw new Error("GitLab live smoke requires AI_REVIEW_GITLAB_TOKEN or GITLAB_TOKEN");
}

const headSha = process.env.AI_REVIEW_GITLAB_HEAD_SHA ?? "unknown";
const apiBaseUrl = process.env.AI_REVIEW_GITLAB_API_BASE_URL;
const runtime = process.env.AI_REVIEW_GITLAB_RUNTIME ?? "dummy";
const seedFixture = process.env.AI_REVIEW_GITLAB_SEED_FIXTURE;
const publishSummary = process.env.AI_REVIEW_GITLAB_PUBLISH_SUMMARY === "1";
const outputDirectory = process.env.AI_REVIEW_GITLAB_OUTPUT_DIR ?? await mkdtemp(join(tmpdir(), "ai-review-gitlab-live-"));

const args = [
  "run",
  "src/cli.ts",
  "run",
  "--provider",
  "gitlab",
  "--repo",
  repo,
  "--change-id",
  changeId,
  "--head-sha",
  headSha,
  "--runtime",
  runtime,
  "--output-dir",
  outputDirectory,
  "--format",
  "json",
];

if (apiBaseUrl !== undefined && apiBaseUrl.length > 0) {
  args.push("--api-base-url", apiBaseUrl);
}

if (seedFixture !== undefined && seedFixture.length > 0) {
  args.push("--seed-fixture", seedFixture);
}

if (publishSummary) {
  args.push("--publish-summary");
}

console.log(`GitLab live smoke starting for ${repo}!${changeId}`);
console.log(`output directory: ${outputDirectory}`);
console.log(`publish summary: ${publishSummary ? "yes" : "no"}`);

const subprocess = Bun.spawn(["bun", ...args], {
  env: {
    ...process.env,
    AI_REVIEW_GITLAB_TOKEN: token,
  },
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await subprocess.exited;
if (exitCode !== 0) {
  throw new Error(`GitLab live smoke failed with exit code ${exitCode}`);
}

console.log("GitLab live smoke passed");

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`GitLab live smoke requires ${name}`);
  }

  return value;
}
