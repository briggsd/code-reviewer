#!/usr/bin/env bun

import { join } from "node:path";
import {
  createDefaultReviewConfig,
  createRunId,
  decideCiOutcome,
  DummyAgentRuntime,
  FileSystemReviewStateStore,
  formatReviewSummaryMarkdown,
  GitHubVcsAdapter,
  GitLabVcsAdapter,
  JsonlTelemetryTransport,
  JsonlTraceSink,
  LocalCiAdapter,
  NonBlockingTelemetrySink,
  PiAgentRuntime,
  publishReviewInlineFindings,
  publishReviewSummary,
  createTelemetryFailureTraceLogger,
  loadGitDiffChange,
  loadProjectReviewConfig,
  loadReviewFixture,
  reviewConfigSchema,
  reviewOutputSchemas,
  runReview,
  runReviewFromChange,
} from "./index.ts";
import { parseRunPublishOptions } from "./cli/run-options.ts";
import type { ChangeRef, DiffSummary, Finding, GitRunner, PriorReviewState, ReviewConfig, ReviewFixture, ChangeMetadata, VcsAdapter } from "./index.ts";

const gitRunner: GitRunner = async (args) => {
  const proc = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  // Drain stdout and stderr concurrently: reading stdout to completion before
  // touching stderr can deadlock when git fills the stderr pipe buffer.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }

  return stdout;
};

const command = Bun.argv[2] ?? "help";

try {
  if (command === "schemas") {
    console.log(JSON.stringify({ ...reviewOutputSchemas, config: reviewConfigSchema }, null, 2));
  } else if (command === "run") {
    await runCommand(Bun.argv.slice(3));
  } else {
    printHelp();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exit(1);
}

type ReviewSource =
  | { kind: "fixture"; fixture: ReviewFixture; config: ReviewConfig; fakeFindings: Finding[] }
  | {
      kind: "change";
      metadata: ChangeMetadata;
      diff: DiffSummary;
      config: ReviewConfig;
      priorState?: PriorReviewState;
      fakeFindings: Finding[];
      adapter?: VcsAdapter;
    };

async function runCommand(args: string[]): Promise<void> {
  const source = await loadReviewSource(args);
  const outputDirectory = readFlag(args, "--output-dir");
  const runtimeName = readFlag(args, "--runtime");
  const outputFormat = readFlag(args, "--format") ?? "json";
  const piProvider = readFlag(args, "--pi-provider");
  const piModel = readFlag(args, "--pi-model");
  const ciExit = hasFlag(args, "--ci-exit");
  const publishOptions = parseRunPublishOptions(args);
  if (runtimeName !== undefined && runtimeName !== "dummy" && runtimeName !== "pi") {
    throw new Error(`unsupported runtime: ${runtimeName}`);
  }
  if (outputFormat !== "json" && outputFormat !== "markdown") {
    throw new Error(`unsupported format: ${outputFormat}`);
  }
  if ((piProvider === undefined) !== (piModel === undefined)) {
    throw new Error("--pi-provider and --pi-model must be provided together");
  }

  const now = new Date();
  const runId = source.kind === "fixture" ? source.fixture.runId ?? createRunId(now) : createRunId(now);
  const tracePath = outputDirectory === undefined ? undefined : join(outputDirectory, "runs", runId, "trace.jsonl");
  const telemetryPath = outputDirectory === undefined ? undefined : join(outputDirectory, "runs", runId, "telemetry.jsonl");
  const traceSink = tracePath === undefined ? undefined : new JsonlTraceSink(tracePath);
  const telemetrySink = telemetryPath === undefined
    ? undefined
    : new NonBlockingTelemetrySink({
      transport: new JsonlTelemetryTransport(telemetryPath),
      ...(traceSink !== undefined ? { onFailure: createTelemetryFailureTraceLogger({ traceSink, runId }) } : {}),
    });
  const stateStore = outputDirectory === undefined ? undefined : new FileSystemReviewStateStore(outputDirectory);
  const runtime = runtimeName === "dummy"
    ? new DummyAgentRuntime({ defaultFindings: source.fakeFindings })
    : runtimeName === "pi"
      ? new PiAgentRuntime({
        ...(piProvider !== undefined && piModel !== undefined
          ? { defaultModel: { provider: piProvider, model: piModel } }
          : {}),
      })
      : undefined;

  try {
    const result = source.kind === "fixture"
      ? await runReview({
        fixture: { ...source.fixture, runId },
        now,
        ...(stateStore !== undefined ? { stateStore } : {}),
        ...(traceSink !== undefined ? { traceSink } : {}),
        ...(tracePath !== undefined ? { tracePath } : {}),
        ...(telemetrySink !== undefined ? { telemetrySink } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
      })
      : await runReviewFromChange({
        runId,
        metadata: source.metadata,
        diff: source.diff,
        config: source.config,
        ...(source.priorState !== undefined ? { priorState: source.priorState } : {}),
        fakeFindings: source.fakeFindings,
        now,
        ...(stateStore !== undefined ? { stateStore } : {}),
        ...(traceSink !== undefined ? { traceSink } : {}),
        ...(tracePath !== undefined ? { tracePath } : {}),
        ...(telemetrySink !== undefined ? { telemetrySink } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
      });

    if (publishOptions.publishInline) {
      if (source.kind !== "change" || source.adapter === undefined) {
        throw new Error("--publish-inline requires --provider github|gitlab");
      }
      if (source.adapter.provider !== "github") {
        throw new Error("--publish-inline currently supports github only");
      }

      await publishReviewInlineFindings({
        adapter: source.adapter,
        change: result.context.metadata,
        diff: result.context.diff,
        summary: result.summary,
        runId,
        ...(traceSink !== undefined ? { traceSink } : {}),
      });
    }

    if (publishOptions.publishSummary) {
      if (source.kind !== "change" || source.adapter === undefined) {
        throw new Error("--publish-summary requires --provider github|gitlab");
      }

      await publishReviewSummary({
        adapter: source.adapter,
        change: result.context.metadata,
        summary: result.summary,
        runId,
        ...(traceSink !== undefined ? { traceSink } : {}),
      });
    }

    if (outputFormat === "markdown") {
      console.log(formatReviewSummaryMarkdown(result.summary));
    } else {
      console.log(JSON.stringify(result.summary, null, 2));
    }

    if (ciExit) {
      const decision = decideCiOutcome(result.summary, source.config);
      await new LocalCiAdapter().emitDecision(decision);
      process.exitCode = decision.exitCode;
    }
  } finally {
    await telemetrySink?.close();
    await traceSink?.close();
  }
}

async function loadReviewSource(args: string[]): Promise<ReviewSource> {
  const configPath = readFlag(args, "--config");
  const fixturePath = readFlag(args, "--fixture");
  if (fixturePath !== undefined) {
    const fixture = await loadReviewFixture(fixturePath);
    const config = await loadProjectReviewConfig({
      ...(configPath !== undefined ? { path: configPath } : {}),
      base: fixture.config,
    });
    return {
      kind: "fixture",
      fixture: { ...fixture, config },
      config,
      fakeFindings: fixture.fakeFindings ?? [],
    };
  }

  if (hasFlag(args, "--git-diff")) {
    const base = readFlag(args, "--base");
    const changeId = readFlag(args, "--change-id");
    const seedFixturePath = readFlag(args, "--seed-fixture");
    const seedFixture = seedFixturePath === undefined ? undefined : await loadReviewFixture(seedFixturePath);
    const config = await loadProjectReviewConfig({
      ...(configPath !== undefined ? { path: configPath } : {}),
      base: seedFixture?.config ?? createDefaultReviewConfig(),
    });
    const { metadata, diff } = await loadGitDiffChange(
      {
        ...(base !== undefined ? { base } : {}),
        ...(changeId !== undefined ? { changeId } : {}),
      },
      gitRunner,
    );

    return {
      kind: "change",
      metadata,
      diff,
      config,
      fakeFindings: seedFixture?.fakeFindings ?? [],
    };
  }

  const provider = readFlag(args, "--provider");
  if (provider !== "github" && provider !== "gitlab") {
    throw new Error("run requires --fixture <path>, --git-diff, or --provider github|gitlab");
  }

  const repo = requiredFlag(args, "--repo");
  const changeId = requiredFlag(args, "--change-id");
  const headSha = readFlag(args, "--head-sha") ?? "unknown";
  const seedFixturePath = readFlag(args, "--seed-fixture");
  const seedFixture = seedFixturePath === undefined ? undefined : await loadReviewFixture(seedFixturePath);
  const config = await loadProjectReviewConfig({
    ...(configPath !== undefined ? { path: configPath } : {}),
    base: seedFixture?.config ?? createDefaultReviewConfig(),
  });
  const token = readProviderToken(provider, args);
  const apiBaseUrl = readFlag(args, "--api-base-url");
  const ref: ChangeRef = {
    provider,
    repository: {
      provider,
      name: repo.includes("/") ? repo.split("/").at(-1) ?? repo : repo,
      slug: repo,
      ...(repo.includes("/") ? { owner: repo.split("/")[0] } : {}),
    },
    changeId,
    headSha,
  };
  const adapter = provider === "github"
    ? new GitHubVcsAdapter({ token, ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}) })
    : new GitLabVcsAdapter({ token, ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}) });
  const [metadata, diff, priorState] = await Promise.all([
    adapter.getChange(ref),
    adapter.getDiff(ref),
    adapter.getPriorReviewState(ref),
  ]);

  return {
    kind: "change",
    metadata,
    diff,
    config,
    ...(priorState !== undefined ? { priorState } : {}),
    fakeFindings: seedFixture?.fakeFindings ?? [],
    adapter,
  };
}

function readProviderToken(provider: "github" | "gitlab", args: string[]): string {
  const tokenEnv = readFlag(args, "--token-env");
  const value = tokenEnv !== undefined
    ? process.env[tokenEnv]
    : provider === "github"
      ? process.env.AI_REVIEW_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
      : process.env.AI_REVIEW_GITLAB_TOKEN ?? process.env.GITLAB_TOKEN;

  if (value === undefined || value.length === 0) {
    const defaults = provider === "github"
      ? "AI_REVIEW_GITHUB_TOKEN or GITHUB_TOKEN"
      : "AI_REVIEW_GITLAB_TOKEN or GITLAB_TOKEN";
    throw new Error(`provider mode requires a read token in ${tokenEnv ?? defaults}`);
  }

  return value;
}

function requiredFlag(args: string[], name: string): string {
  const value = readFlag(args, name);
  if (value === undefined) {
    throw new Error(`missing required flag ${name}`);
  }

  return value;
}

function readFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function printHelp(): void {
  console.log("ai-code-review-factory");
  console.log("");
  console.log("Commands:");
  console.log("  schemas                              Print reviewer/coordinator output schemas");
  console.log("  run --fixture <path> [--config <path>] [--output-dir] [--runtime dummy|pi]");
  console.log("      [--format json|markdown] [--ci-exit] [--pi-provider <name> --pi-model <id>]");
  console.log("  run --git-diff [--base <ref>] [--change-id <id>] [--config <path>] [--seed-fixture <path>]");
  console.log("      [--runtime dummy|pi] [--output-dir <path>] [--format json|markdown] [--ci-exit]");
  console.log("      [--pi-provider <name> --pi-model <id>]");
  console.log("                                       Review local git changes; no publish.");
  console.log("                                       --base default HEAD = uncommitted changes only; pass --base <branch>");
  console.log("                                       for committed branch work. Untracked files need `git add -N` first.");
  console.log("  run --provider github|gitlab --repo <owner/name> --change-id <id>");
  console.log("      [--head-sha <sha>] [--api-base-url <url>] [--seed-fixture <path>] [--config <path>] [--runtime dummy|pi]");
  console.log("      [--output-dir <path>] [--format json|markdown] [--publish-summary] [--publish-inline] [--ci-exit]");
  console.log("      [--pi-provider <name> --pi-model <id>]");
  console.log("                                       Run deterministic local review");
}
