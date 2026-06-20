#!/usr/bin/env bun

import { join } from "node:path";
import { finalizeCiExit } from "./cli/ci-exit.ts";
import { ReviewProgressReporter } from "./cli/review-progress-reporter.ts";
import {
  applyGitDiffDefault,
  formatConventionsHint,
  formatLocalRunHealthHeader,
  parseDisabledProviders,
  parseReviewersOption,
  parseRunPublishOptions,
} from "./cli/run-options.ts";
import { resolveRemoteEndpoint } from "./cli/telemetry-auth.ts";
import type {
  BreakGlassOverride,
  ChangedFile,
  ChangeMetadata,
  ChangeRef,
  DiffSummary,
  Finding,
  GitRunner,
  IncrementalReviewPlan,
  PriorReviewState,
  ResolvedBaseConfig,
  ReviewConfig,
  ReviewerDefinition,
  ReviewFixture,
  RuntimeEventSubscription,
  TelemetryEvent,
  VcsAdapter,
} from "./index.ts";
import {
  BitbucketVcsAdapter,
  CountsOnlyTelemetryTransport,
  createDefaultReviewConfig,
  createLokiTelemetryTransport,
  createRemoteDeliveryTraceLogger,
  createRunId,
  createTelemetryFailureTraceLogger,
  DummyAgentRuntime,
  decideCiOutcome,
  decideIncrementalReview,
  FileSystemReviewStateStore,
  formatReviewSummaryMarkdown,
  GitHubVcsAdapter,
  GitLabVcsAdapter,
  HttpTelemetryTransport,
  JsonlTelemetryTransport,
  JsonlTraceSink,
  LocalCiAdapter,
  loadGitDiffChange,
  loadOperatorReviewerDefinitions,
  loadProjectReviewConfig,
  loadReviewFixture,
  mergeReviewerDefinitions,
  NonBlockingTelemetrySink,
  PiAgentRuntime,
  publishReviewInlineFindings,
  publishReviewSummary,
  RedactingTraceSink,
  resolveBaseConfig,
  reviewConfigSchema,
  reviewOutputSchemas,
  runReview,
  runReviewFromChange,
  TeeTelemetryTransport,
  type TelemetryTransport,
} from "./index.ts";

const HEAD_CONTENT_FETCH_CONCURRENCY = 8;

// Build the telemetry transport: a durable JSONL file (always) plus an optional remote mirror.
// The remote is default-off; unset = byte-identical behavior. Each exporter owns its own env
// namespace `AI_REVIEW_<NAME>_{URL,AUTHORIZATION,BASIC_AUTH}` (see resolveRemoteEndpoint):
//   • AI_REVIEW_TELEMETRY_* → generic authenticated NDJSON HTTP POST (#51 send-side).
//   • AI_REVIEW_LOKI_*      → Grafana Loki push-API variant (push straight to Loki, no
//     promtail/Alloy hop). Composes the same HTTP core via createLokiTelemetryTransport.
// Loki takes precedence if more than one is configured. (Adding a future exporter = a new
// namespace here; multiples could later be tee'd together rather than precedence-selected.)
//
// JSONL is the PRIMARY tee leg (durable artifact `telemetry:rollup`/`:analyze` read) and stays
// local/unwrapped. The remote leg is wrapped in CountsOnlyTelemetryTransport so every egressed
// payload passes the #50 counts-only boundary; a flaky remote can never fail the durable write.
function buildTelemetryTransport(
  telemetryPath: string,
  onSecondaryOutcome?: (event: TelemetryEvent, result: { ok: boolean; error?: Error }) => void,
): TelemetryTransport {
  const jsonl = new JsonlTelemetryTransport(telemetryPath);
  const remote = buildRemoteTelemetryTransport();
  if (remote === undefined) {
    return jsonl;
  }
  return new TeeTelemetryTransport({
    primary: jsonl,
    secondaries: [new CountsOnlyTelemetryTransport(remote)],
    ...(onSecondaryOutcome !== undefined ? { onSecondaryOutcome } : {}),
  });
}

function buildRemoteTelemetryTransport(): TelemetryTransport | undefined {
  // Loki takes precedence when both are configured — it is the more specific endpoint.
  const loki = resolveRemoteEndpoint("AI_REVIEW_LOKI", process.env);
  if (loki !== undefined) {
    // Low-cardinality labels only — everything else stays in the log line, queried via `| json`.
    return createLokiTelemetryTransport({
      url: loki.url,
      labelFromData: ["riskTier", "decision", "outcome"],
      ...(loki.authorization !== undefined ? { authorization: loki.authorization } : {}),
      ...(loki.basicAuth !== undefined ? { basicAuth: loki.basicAuth } : {}),
    });
  }

  const generic = resolveRemoteEndpoint("AI_REVIEW_TELEMETRY", process.env);
  if (generic !== undefined) {
    return new HttpTelemetryTransport({
      url: generic.url,
      ...(generic.authorization !== undefined ? { authorization: generic.authorization } : {}),
      ...(generic.basicAuth !== undefined ? { basicAuth: generic.basicAuth } : {}),
    });
  }

  return undefined;
}

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
      changedFileContents?: Record<string, string>;
      adapter?: VcsAdapter;
      conventionsResolution?: ResolvedBaseConfig;
      breakGlassOverride?: BreakGlassOverride;
      incremental?: IncrementalReviewPlan;
    };

async function runCommand(args: string[]): Promise<void> {
  const source = await loadReviewSource(args);
  if (hasFlag(args, "--git-diff")) {
    for (const line of formatConventionsHint(source.config)) {
      console.error(line); // stderr — a nudge, never stdout (which carries review output)
    }
  }
  const outputDirectory = applyGitDiffDefault(readFlag(args, "--output-dir"), args, ".ai-review");
  const runtimeName = applyGitDiffDefault(readFlag(args, "--runtime"), args, "dummy");
  const jobKind = readFlag(args, "--job-kind");
  const outputFormat = readFlag(args, "--format") ?? "json";
  const piProvider = readFlag(args, "--pi-provider");
  const piModel = readFlag(args, "--pi-model");
  const piApiKeyArg = readFlag(args, "--pi-api-key");
  const ciExit = hasFlag(args, "--ci-exit");
  const redactTrace = hasFlag(args, "--redact-trace");
  const publishOptions = parseRunPublishOptions(args);

  // Operator-extension seam (M017 S03, #143): an operator (the trusted party in their own CI) may
  // supply custom reviewer definitions by an explicit `--reviewers <path>` they control. The module
  // is merged onto the factory's trusted set (merge-by-role/operator-wins, or full-replace when the
  // module opts in). This is explicit operator load, never reviewed-repo discovery — fork-safety
  // (docs/user/fork-safety.md) is unchanged: a reviewed repo cannot smuggle a reviewer in.
  const reviewersPath = parseReviewersOption(args);
  const reviewerDefinitions =
    reviewersPath === undefined ? undefined : await loadMergedReviewerDefinitions(reviewersPath);

  // Operator provider-disable seam (#138): a trusted operator can disable a misbehaving provider
  // by setting AI_REVIEW_DISABLED_PROVIDERS (comma-separated provider names) as a GitHub Actions
  // repository variable. selectModel skips disabled candidates and falls through to the next.
  // Reviewed-repo content never reaches this — env/option only (mirrors reviewerDefinitions seam).
  const disabledProviders = parseDisabledProviders(process.env.AI_REVIEW_DISABLED_PROVIDERS);
  if (runtimeName !== undefined && runtimeName !== "dummy" && runtimeName !== "pi") {
    throw new Error(`unsupported runtime: ${runtimeName}`);
  }
  if (outputFormat !== "json" && outputFormat !== "markdown") {
    throw new Error(`unsupported format: ${outputFormat}`);
  }
  if ((piProvider === undefined) !== (piModel === undefined)) {
    throw new Error("--pi-provider and --pi-model must be provided together");
  }
  if (piApiKeyArg !== undefined && runtimeName !== "pi") {
    throw new Error("--pi-api-key requires --runtime pi");
  }
  // Resolve to the literal key. `env:NAME` indirection keeps the secret out of shell history;
  // a bare value is accepted too. The resolved key is only forwarded into the spawned `pi` argv.
  const piApiKey = piApiKeyArg === undefined ? undefined : resolvePiApiKey(piApiKeyArg);

  const now = new Date();
  const runId =
    source.kind === "fixture" ? (source.fixture.runId ?? createRunId(now)) : createRunId(now);
  const tracePath =
    outputDirectory === undefined ? undefined : join(outputDirectory, "runs", runId, "trace.jsonl");
  const telemetryPath =
    outputDirectory === undefined
      ? undefined
      : join(outputDirectory, "runs", runId, "telemetry.jsonl");
  const rawTraceSink = tracePath === undefined ? undefined : new JsonlTraceSink(tracePath);
  const traceSink =
    rawTraceSink === undefined
      ? undefined
      : redactTrace
        ? new RedactingTraceSink(rawTraceSink)
        : rawTraceSink;
  const telemetrySink =
    telemetryPath === undefined
      ? undefined
      : new NonBlockingTelemetrySink({
          // JSONL stays PRIMARY (durable artifact `telemetry:rollup`/`:analyze` read). When
          // AI_REVIEW_TELEMETRY_URL is set, mirror events to the remote endpoint via a tee; a
          // flaky remote can never block or fail the durable write (see TeeTelemetryTransport).
          transport: buildTelemetryTransport(
            telemetryPath,
            traceSink !== undefined
              ? createRemoteDeliveryTraceLogger({ traceSink, runId })
              : undefined,
          ),
          ...(traceSink !== undefined
            ? { onFailure: createTelemetryFailureTraceLogger({ traceSink, runId }) }
            : {}),
        });
  const stateStore =
    outputDirectory === undefined ? undefined : new FileSystemReviewStateStore(outputDirectory);
  const runtime =
    runtimeName === "dummy"
      ? new DummyAgentRuntime({ defaultFindings: source.fakeFindings })
      : runtimeName === "pi"
        ? new PiAgentRuntime({
            ...(piProvider !== undefined && piModel !== undefined
              ? { defaultModel: { provider: piProvider, model: piModel } }
              : {}),
            ...(piApiKey !== undefined ? { piApiKey } : {}),
          })
        : undefined;
  let ciExitCode: number | undefined;

  // Surface review liveness (#41) so a multi-minute Pi run does not look frozen. Progress
  // lines go to stderr only, so the stdout summary (`--format json`) stays byte-for-byte clean.
  let progressSubscription: RuntimeEventSubscription | undefined;
  if (runtime !== undefined && decideProgressEnabled(args)) {
    const reporter = new ReviewProgressReporter();
    progressSubscription = runtime.streamEvents(runId, (event) => reporter.handle(event));
  }

  // Emit a counts-only trace event for conventions resolution (M008 — no convention text).
  if (
    traceSink !== undefined &&
    source.kind === "change" &&
    source.conventionsResolution !== undefined
  ) {
    await traceSink.write({
      type: "conventions.resolved",
      runId,
      timestamp: now.toISOString(),
      data: {
        source: source.conventionsResolution.source,
        conventionCount: source.conventionsResolution.conventions.length,
        compliancePolicyCount: source.conventionsResolution.compliancePolicy.length,
        acknowledgementCount: source.conventionsResolution.acknowledgements.length,
        baseFileFound: source.conventionsResolution.baseFileFound,
      },
    });
  }

  try {
    const result =
      source.kind === "fixture"
        ? await runReview({
            fixture: { ...source.fixture, runId },
            now,
            ...(stateStore !== undefined ? { stateStore } : {}),
            ...(traceSink !== undefined ? { traceSink } : {}),
            ...(tracePath !== undefined ? { tracePath } : {}),
            ...(telemetrySink !== undefined ? { telemetrySink } : {}),
            ...(runtime !== undefined ? { runtime } : {}),
            ...(jobKind !== undefined ? { jobKind } : {}),
            ...(reviewerDefinitions !== undefined ? { reviewerDefinitions } : {}),
            ...(disabledProviders !== undefined ? { disabledProviders } : {}),
          })
        : await runReviewFromChange({
            runId,
            metadata: source.metadata,
            diff: source.diff,
            config: source.config,
            ...(source.priorState !== undefined ? { priorState: source.priorState } : {}),
            fakeFindings: source.fakeFindings,
            ...(source.changedFileContents !== undefined
              ? { changedFileContents: source.changedFileContents }
              : {}),
            now,
            ...(stateStore !== undefined ? { stateStore } : {}),
            ...(traceSink !== undefined ? { traceSink } : {}),
            ...(tracePath !== undefined ? { tracePath } : {}),
            ...(telemetrySink !== undefined ? { telemetrySink } : {}),
            ...(runtime !== undefined ? { runtime } : {}),
            ...(jobKind !== undefined ? { jobKind } : {}),
            ...(source.breakGlassOverride !== undefined
              ? { breakGlassOverride: source.breakGlassOverride }
              : {}),
            ...(source.incremental !== undefined ? { incremental: source.incremental } : {}),
            ...(reviewerDefinitions !== undefined ? { reviewerDefinitions } : {}),
            ...(disabledProviders !== undefined ? { disabledProviders } : {}),
          });

    if (publishOptions.publishInline) {
      if (source.kind !== "change" || source.adapter === undefined) {
        throw new Error("--publish-inline requires --provider github|gitlab|bitbucket");
      }
      if (source.adapter.provider !== "github" && source.adapter.provider !== "bitbucket") {
        throw new Error("--publish-inline currently supports github and bitbucket only");
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
        throw new Error("--publish-summary requires --provider github|gitlab|bitbucket");
      }

      // Convergence gate (#149 — Tier 1): suppress the summary comment re-post when the
      // finding set is unchanged since the last review. The re-review delta (authoritative,
      // computed in run-review.ts) drives this; --force-review bypasses suppression.
      // CI status/exit is NEVER affected — only the summary comment re-post is suppressed.
      if (result.converged && !publishOptions.forceReview) {
        // Visible suppression message regardless of trace sink: a local run with no
        // --output-dir has no trace sink, so the publisher.skipped trace event would
        // be completely silent. Log to stdout so operators always see suppression.
        console.log(
          "[ai-review] Summary publish suppressed: finding set unchanged since last review (converged). Use --force-review to override.",
        );
        // Emit a visible trace event so suppression is observable, never silent (M008 —
        // counts-only, no finding text). The CI-exit block below still runs unchanged.
        await traceSink?.write({
          type: "publisher.skipped",
          runId,
          timestamp: new Date().toISOString(),
          data: {
            reason: "converged",
            newFindingCount: result.summary.reReview?.newFindingIds.length ?? 0,
            fixedFindingCount: result.summary.reReview?.fixedFindingIds.length ?? 0,
            recurringFindingCount: result.summary.reReview?.recurringFindingIds.length ?? 0,
          },
        });
      } else {
        await publishReviewSummary({
          adapter: source.adapter,
          change: result.context.metadata,
          summary: result.summary,
          runId,
          ...(traceSink !== undefined ? { traceSink } : {}),
        });
      }
    }

    if (outputFormat === "markdown") {
      for (const line of formatLocalRunHealthHeader(result.summary)) {
        console.log(line);
      }
      console.log(formatReviewSummaryMarkdown(result.summary));
    } else {
      console.log(JSON.stringify(result.summary, null, 2));
    }

    if (ciExit) {
      const decision = decideCiOutcome(result.summary, source.config, {
        overridden: source.kind === "change" && source.breakGlassOverride !== undefined,
      });
      await new LocalCiAdapter().emitDecision(decision);
      ciExitCode = decision.exitCode;
    }
  } finally {
    progressSubscription?.unsubscribe();
    await telemetrySink?.close();
    await traceSink?.close();
  }

  // Force the OS exit code after sinks flush. Deferred `process.exitCode` is
  // unreliable when an outstanding handle survives shutdown (see finalizeCiExit).
  finalizeCiExit(ciExitCode);
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
    const seedFixture =
      seedFixturePath === undefined ? undefined : await loadReviewFixture(seedFixturePath);
    const config = await loadProjectReviewConfig({
      ...(configPath !== undefined ? { path: configPath } : {}),
      base: seedFixture?.config ?? createDefaultReviewConfig(),
    });
    const { metadata, diff, changedFileContents } = await loadGitDiffChange(
      {
        ...(base !== undefined ? { base } : {}),
        ...(changeId !== undefined ? { changeId } : {}),
        ...(hasFlag(args, "--include-untracked") ? { includeUntracked: true } : {}),
      },
      gitRunner,
    );

    return {
      kind: "change",
      metadata,
      diff,
      config,
      fakeFindings: seedFixture?.fakeFindings ?? [],
      ...(changedFileContents !== undefined ? { changedFileContents } : {}),
    };
  }

  const provider = readFlag(args, "--provider");
  if (provider !== "github" && provider !== "gitlab" && provider !== "bitbucket") {
    throw new Error(
      "run requires --fixture <path>, --git-diff, or --provider github|gitlab|bitbucket",
    );
  }

  const repo = requiredFlag(args, "--repo");
  const changeId = requiredFlag(args, "--change-id");
  const headSha = readFlag(args, "--head-sha") ?? "unknown";
  const seedFixturePath = readFlag(args, "--seed-fixture");
  const seedFixture =
    seedFixturePath === undefined ? undefined : await loadReviewFixture(seedFixturePath);
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
      name: repo.includes("/") ? (repo.split("/").at(-1) ?? repo) : repo,
      slug: repo,
      ...(repo.includes("/") ? { owner: repo.split("/")[0] } : {}),
    },
    changeId,
    headSha,
  };
  const adapter: VcsAdapter =
    provider === "github"
      ? new GitHubVcsAdapter({ token, ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}) })
      : provider === "gitlab"
        ? new GitLabVcsAdapter({ token, ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}) })
        : new BitbucketVcsAdapter({
            token,
            ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
            ...(process.env["AI_REVIEW_BITBUCKET_BOT_UUID"] !== undefined
              ? { botUuid: process.env["AI_REVIEW_BITBUCKET_BOT_UUID"] }
              : {}),
          });
  const [metadata, diff, priorState, breakGlassOverride] = await Promise.all([
    adapter.getChange(ref),
    adapter.getDiff(ref),
    adapter.getPriorReviewState(ref),
    adapter.detectBreakGlassOverride
      ? adapter.detectBreakGlassOverride(ref)
      : Promise.resolve(undefined),
  ]);

  // Base-branch trust boundary (#60-P2/P3a): conventions and acknowledgements come from the
  // base branch, never the PR head. A PR cannot grant itself an exception; only config already
  // on the protected branch counts. The --git-diff and --fixture paths are local/trusted — left unchanged.
  const resolved = await resolveBaseConfig({ adapter, metadata, config });
  const effectiveConfig = {
    ...config,
    conventions: resolved.conventions,
    compliancePolicy: resolved.compliancePolicy,
    acknowledgements: resolved.acknowledgements,
  };

  // Incremental re-review (#46): when a prior review exists, ask the adapter for the
  // file delta since previousHeadSha (best-effort) and let the deterministic policy
  // decide whether to narrow. Any failure / unsupported adapter / force-push degrades
  // to a full review inside decideIncrementalReview. Uses the authoritative head SHA
  // from the fetched metadata (the --head-sha flag may be a placeholder).
  let incremental: IncrementalReviewPlan | undefined;
  if (priorState?.previousHeadSha !== undefined) {
    const vcs: VcsAdapter = adapter;
    const delta = vcs.getChangedPathsSince
      ? await vcs
          .getChangedPathsSince({ ...ref, headSha: metadata.headSha }, priorState.previousHeadSha)
          .catch(() => undefined)
      : undefined;
    incremental = decideIncrementalReview({ priorState, headSha: metadata.headSha, delta });
  }

  const changedFileContents = await fetchChangedFileContents(adapter, metadata, diff);

  return {
    kind: "change",
    metadata,
    diff,
    config: effectiveConfig,
    ...(priorState !== undefined ? { priorState } : {}),
    fakeFindings: seedFixture?.fakeFindings ?? [],
    ...(changedFileContents !== undefined ? { changedFileContents } : {}),
    adapter,
    conventionsResolution: resolved,
    ...(breakGlassOverride !== undefined ? { breakGlassOverride } : {}),
    ...(incremental !== undefined ? { incremental } : {}),
  };
}

async function fetchChangedFileContents(
  adapter: VcsAdapter,
  metadata: ChangeMetadata,
  diff: DiffSummary,
): Promise<Record<string, string> | undefined> {
  if (adapter.readChangeFileAtHead === undefined) {
    return undefined;
  }

  const readChangeFileAtHead = adapter.readChangeFileAtHead.bind(adapter);
  const candidates = diff.files.filter(isHeadContentCandidate);
  const entries = await mapWithConcurrency(
    candidates,
    HEAD_CONTENT_FETCH_CONCURRENCY,
    async (file): Promise<[string, string] | undefined> => {
      const content = await readChangeFileAtHead(metadata, file.path).catch(() => undefined);
      return content === undefined ? undefined : [file.path, content];
    },
  );
  const contents: Record<string, string> = {};
  for (const entry of entries) {
    if (entry !== undefined) {
      contents[entry[0]] = entry[1];
    }
  }

  return Object.keys(contents).length > 0 ? contents : undefined;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index] as T);
    }
  });

  await Promise.all(workers);
  return results;
}

function isHeadContentCandidate(file: ChangedFile): boolean {
  return !file.isBinary && file.status !== "deleted";
}

function readProviderToken(provider: "github" | "gitlab" | "bitbucket", args: string[]): string {
  const tokenEnv = readFlag(args, "--token-env");
  const value =
    tokenEnv !== undefined
      ? process.env[tokenEnv]
      : provider === "github"
        ? (process.env.AI_REVIEW_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN)
        : provider === "gitlab"
          ? (process.env.AI_REVIEW_GITLAB_TOKEN ?? process.env.GITLAB_TOKEN)
          : (process.env.AI_REVIEW_BITBUCKET_TOKEN ?? process.env.BITBUCKET_TOKEN);

  if (value === undefined || value.length === 0) {
    const defaults =
      provider === "github"
        ? "AI_REVIEW_GITHUB_TOKEN or GITHUB_TOKEN"
        : provider === "gitlab"
          ? "AI_REVIEW_GITLAB_TOKEN or GITLAB_TOKEN"
          : "AI_REVIEW_BITBUCKET_TOKEN or BITBUCKET_TOKEN";
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

// Resolve a `--pi-api-key` argument to the literal key. `env:NAME` reads the named env var
// (preferred — keeps the key out of the calling shell's history); any other value is the literal
// key. Never logged. The resolved key is forwarded into the spawned `pi --api-key` argv, which is
// inherent to pi's auth-override mechanism and IS visible in the child process's command line
// (`ps` / `/proc/<pid>/cmdline`) — `env:NAME` does not change that, it only protects shell history.
function resolvePiApiKey(raw: string): string {
  if (raw.startsWith("env:")) {
    const name = raw.slice("env:".length);
    const value = process.env[name];
    if (value === undefined || value.length === 0) {
      throw new Error(`--pi-api-key env:${name} requested but ${name} is empty or unset`);
    }
    return value;
  }

  if (raw.length === 0) {
    throw new Error("--pi-api-key value must not be empty");
  }

  return raw;
}

// Load an operator reviewer-definitions module by explicit path and merge it onto the factory's
// trusted set (M017 S03, #143). Default merge is by-role/operator-wins; the module opts into
// full-replace by exporting `{ definitions, replace: true }`. The reserved `coordinator` role is
// rejected in mergeReviewerDefinitions.
async function loadMergedReviewerDefinitions(
  reviewersPath: string,
): Promise<readonly ReviewerDefinition[]> {
  const extension = await loadOperatorReviewerDefinitions(reviewersPath);
  return mergeReviewerDefinitions({
    operator: extension.definitions,
    replace: extension.replace,
  });
}

// Default progress on for an interactive terminal or a CI job (so the job log shows liveness),
// off for a plain piped/non-TTY context to avoid noise. `--progress` / `--no-progress` override.
function decideProgressEnabled(args: string[]): boolean {
  if (hasFlag(args, "--no-progress")) {
    return false;
  }
  if (hasFlag(args, "--progress")) {
    return true;
  }

  return process.stderr.isTTY === true || isCiEnvironment();
}

function isCiEnvironment(): boolean {
  return (
    process.env.GITHUB_ACTIONS === "true" ||
    process.env.GITLAB_CI === "true" ||
    process.env.CI === "true"
  );
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
  console.log("code-reviewer");
  console.log("");
  console.log("Commands:");
  console.log("  schemas                              Print reviewer/coordinator output schemas");
  console.log("  run --fixture <path> [--config <path>] [--output-dir] [--runtime dummy|pi]");
  console.log(
    "      [--format json|markdown] [--ci-exit] [--job-kind <string>] [--redact-trace] [--pi-provider <name> --pi-model <id>]",
  );
  console.log(
    "      [--pi-api-key <key|env:NAME>] [--progress|--no-progress]   (pi auth precedence: --pi-api-key > stored OAuth > env key)",
  );
  console.log(
    "      [--reviewers <path>]   Operator-supplied reviewer definitions module (explicit load; applies to all run forms; merge-by-role/operator-wins, or full-replace via { definitions, replace:true })",
  );
  console.log(
    "  run --git-diff [--base <ref>] [--change-id <id>] [--include-untracked] [--config <path>] [--seed-fixture <path>]",
  );
  console.log(
    "      [--runtime dummy|pi] [--output-dir <path>] [--format json|markdown] [--ci-exit] [--redact-trace] [--reviewers <path>]",
  );
  console.log(
    "      [--job-kind <string>] [--pi-provider <name> --pi-model <id>] [--pi-api-key <key|env:NAME>] [--progress|--no-progress]",
  );
  console.log("                                       Review local git changes; no publish.");
  console.log(
    "                                       --base default HEAD = uncommitted changes only; pass --base <branch>",
  );
  console.log("                                       for committed branch work.");
  console.log(
    "                                       --include-untracked also reviews new untracked files (excludes .gitignored paths; index restored).",
  );
  console.log("  run --provider github|gitlab --repo <owner/name> --change-id <id>");
  console.log(
    "      [--head-sha <sha>] [--api-base-url <url>] [--seed-fixture <path>] [--config <path>] [--runtime dummy|pi]",
  );
  console.log(
    "      [--output-dir <path>] [--format json|markdown] [--publish-summary] [--publish-inline] [--ci-exit] [--redact-trace]",
  );
  console.log(
    "      [--job-kind <string>] [--pi-provider <name> --pi-model <id>] [--pi-api-key <key|env:NAME>] [--reviewers <path>] [--progress|--no-progress]",
  );
  console.log("                                       Run deterministic local review");
}
