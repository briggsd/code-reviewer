import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentRole,
  AgentRuntime,
  CoordinatorRunInput,
  CoordinatorRunResult,
  JsonValue,
  ReviewErrorClassification,
  ReviewerRunFailure,
  ReviewerRunInput,
  ReviewerRunResult,
  RuntimeEvent,
  RuntimeEventSubscription,
  RuntimeToolPolicy,
  ThinkingLevel,
  TokenUsage,
} from "../contracts/index.ts";
import { classifyReviewError } from "../runner/error-classifier.ts";
import {
  getEffectiveTimeouts,
  scaleTimeoutForRiskTier,
  summarizeReview,
} from "../runner/run-review.ts";
import {
  enforceReviewerAllowedSeverities,
  enforceReviewerRole,
  parseCoordinatorOutput,
  parseCoordinatorToolArgs,
  parseReviewerOutput,
} from "./reviewer-output-validation.ts";
import {
  buildCoordinatorPrompt,
  buildReviewerPrompt,
  createReviewerPromptMetrics,
} from "./reviewer-prompt.ts";
import {
  parseReviewerToolArgs,
  readToolCallArgs,
  SUBMIT_FINDINGS_TOOL_NAME,
  SUBMIT_REVIEW_TOOL_NAME,
} from "./structured-tool-output.ts";

// Absolute path to the factory-owned `submit_findings` Pi extension (M015 S03, #126). Resolved
// relative to this module so it works both from source (`src/runtime` -> `../../scripts`) and from
// the published package, which ships `src/` and `scripts/` as siblings (package.json `files`).
// Passed to every reviewer `pi` run as `--extension <path>` so the structured tool is the primary
// delivery path; the file is TRUSTED, factory-owned, and loaded only via this explicit `-e` while
// `--no-extensions` keeps reviewed-repo extension discovery off (fork-safe — see docs/fork-safety.md).
const SUBMIT_FINDINGS_EXTENSION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../scripts/pi-extensions/submit-findings-extension.ts",
);

/**
 * Default `pi` base argv for a reviewer/coordinator run. Exported so the `--extension` wiring (a
 * published-layout-relative path that would silently break on relocation) is testable. The
 * explicit `--extension` still loads under `--no-extensions`, which keeps reviewed-repo extension
 * discovery OFF — only the trusted factory file runs (fork-safe). Tool callability is further gated
 * per run by the `--tools` allowlist (see `requiredTools`), so loading the extension for the
 * coordinator is inert until S04 allowlists `submit_findings` there too.
 */
export function defaultPiBaseArgs(): string[] {
  return [
    "--mode",
    "json",
    // Non-interactive: process the prompt and exit. With no positional message, `pi` reads the
    // prompt from STDIN — see `BunPiProcessRunner.run`, which pipes it there instead of via argv.
    "--print",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    SUBMIT_FINDINGS_EXTENSION_PATH,
  ];
}

export interface PiProcessRunInput {
  runId: string;
  agentRunId: string;
  role: AgentRole | string;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  inactivityTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  toolPolicy: RuntimeToolPolicy;
  /**
   * Tool names that MUST be allowlisted for this run regardless of the read/shell/write policy
   * (M015 S03, #126). The reviewer path passes `[submit_findings]` so the structured terminal tool
   * is always callable — `pi`'s `--tools` allowlist (and `--no-tools`) otherwise gate extension
   * tools too, so without this an inline-fallback reviewer (`--no-tools`) could never call it.
   */
  requiredTools?: readonly string[];
  model?: {
    provider: string;
    model: string;
    thinking?: ThinkingLevel;
  };
  onEvent?: (event: unknown) => void;
}

export interface PiProcessRunResult {
  finalText: string;
  events: unknown[];
  usage?: TokenUsage;
  rawOutput: string;
  rawError?: string;
}

export interface PiProcessRunner {
  run(input: PiProcessRunInput): Promise<PiProcessRunResult>;
  cancel?(runId: string): Promise<void>;
}

export interface PiReviewerRetryPolicy {
  maxAttempts?: number;
  minimumRemainingMs?: number;
}

class ProviderRuntimeError extends Error {
  readonly providerErrorType: string;
  readonly status?: number;

  constructor(input: { providerErrorType: string; message: string; status?: number }) {
    super(`Provider error (${input.providerErrorType}): ${input.message}`);
    this.name = "ProviderRuntimeError";
    this.providerErrorType = input.providerErrorType;
    if (input.status !== undefined) {
      this.status = input.status;
    }
  }
}

export interface PiAgentRuntimeOptions {
  processRunner?: PiProcessRunner;
  command?: string;
  /**
   * Override the `pi` base argv (defaults to {@link defaultPiBaseArgs}). When targeting a real `pi`
   * binary, a custom array MUST include `--print`: as of M015 S03 (#126) the prompt is piped via
   * STDIN, not argv, and `pi` reads stdin only under `--print`. Omitting it leaves `pi` without a
   * prompt (empty/hung run). It SHOULD also include `--extension <submit-findings path>` for the
   * structured reviewer path, or reviewers fall back to prose-parse. (A custom non-`pi` test binary
   * that reads stdin directly does not need `--print`.)
   */
  baseArgs?: string[];
  defaultModel?: {
    provider: string;
    model: string;
  };
  /**
   * Force `pi` to authenticate with this API key via the explicit `--api-key` flag (#42).
   * Without it, `pi` prefers a stored OAuth credential (`~/.pi/agent/auth.json`) over the
   * forwarded `ANTHROPIC_API_KEY` env var, so a funded key can be silently ignored in favor
   * of an interactive login. The flag takes precedence over any stored OAuth. The value goes
   * into the spawned process argv only — never into trace/telemetry (which carry events, not
   * the command line). Ignored when a custom `processRunner` is supplied.
   */
  piApiKey?: string;
  timestamp?: string;
  reviewerRetryPolicy?: PiReviewerRetryPolicy;
}

interface PartialCoordinatorSnapshot {
  input: CoordinatorRunInput;
  agentRunId: string;
  reviewerResults: ReviewerRunResult[];
  reviewerFailures: ReviewerRunFailure[];
}

export class PiAgentRuntime implements AgentRuntime {
  readonly name = "pi";

  private readonly processRunner: PiProcessRunner;
  private readonly defaultModel: { provider: string; model: string } | undefined;
  private readonly timestamp: string | undefined;
  private readonly reviewerRetryPolicy: Required<PiReviewerRetryPolicy>;
  private readonly reviewerBudgetStarts = new WeakMap<ReviewerRunInput, number>();
  private readonly listenersByRunId = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private readonly partialCoordinatorSnapshots = new Map<string, PartialCoordinatorSnapshot>();

  constructor(options: PiAgentRuntimeOptions = {}) {
    this.processRunner =
      options.processRunner ??
      new BunPiProcessRunner({
        ...(options.command !== undefined ? { command: options.command } : {}),
        ...(options.baseArgs !== undefined ? { baseArgs: options.baseArgs } : {}),
        ...(options.piApiKey !== undefined ? { apiKey: options.piApiKey } : {}),
      });
    this.defaultModel = options.defaultModel;
    this.timestamp = options.timestamp;
    this.reviewerRetryPolicy = {
      maxAttempts: options.reviewerRetryPolicy?.maxAttempts ?? 2,
      minimumRemainingMs: options.reviewerRetryPolicy?.minimumRemainingMs ?? 120_000,
    };
  }

  async runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult> {
    const agentRunId = `${input.runId}:pi:coordinator`;
    const snapshot: PartialCoordinatorSnapshot = {
      input,
      agentRunId,
      reviewerResults: [],
      reviewerFailures: [],
    };
    this.partialCoordinatorSnapshots.set(input.runId, snapshot);
    this.emitAgentEvent("agent.started", input.runId, agentRunId, "coordinator", {
      reviewerCount: input.selectedReviewers.length,
      runtime: this.name,
    });

    try {
      const reviewerBudgetStartedAt = Date.now();
      const reviewerSettled = await Promise.allSettled(
        input.selectedReviewers.map(async (reviewer) => {
          this.reviewerBudgetStarts.set(reviewer, reviewerBudgetStartedAt);
          try {
            const result = await this.runReviewer(reviewer);
            snapshot.reviewerResults.push(result);
            return {
              reviewer,
              result,
            };
          } catch (error) {
            const effectiveModel = this.modelArgs(reviewer.model).model?.model;
            const failure = createReviewerFailure(
              input.runId,
              `${input.runId}:pi:${reviewer.role}`,
              reviewer.role,
              error,
            );
            snapshot.reviewerFailures.push(
              effectiveModel !== undefined ? { ...failure, effectiveModel } : failure,
            );
            throw error;
          } finally {
            this.reviewerBudgetStarts.delete(reviewer);
          }
        }),
      );
      const fanOutMs = Date.now() - reviewerBudgetStartedAt;
      const reviewerResults = reviewerSettled.flatMap((settled) =>
        settled.status === "fulfilled" ? [settled.value.result] : [],
      );
      const reviewerFailures = reviewerSettled.flatMap((settled, index): ReviewerRunFailure[] => {
        if (settled.status === "fulfilled") {
          return [];
        }

        const reviewer = input.selectedReviewers[index];
        if (reviewer === undefined) {
          return [];
        }

        const effectiveModel = this.modelArgs(reviewer.model).model?.model;
        const failure = createReviewerFailure(
          input.runId,
          `${input.runId}:pi:${reviewer.role}`,
          reviewer.role,
          settled.reason,
        );
        return [effectiveModel !== undefined ? { ...failure, effectiveModel } : failure];
      });
      snapshot.reviewerResults = reviewerResults;
      snapshot.reviewerFailures = reviewerFailures;

      if (reviewerResults.length === 0 && input.selectedReviewers.length > 0) {
        // Every dispatched reviewer failed. Only degrade to a published `review_failed` notice (#120)
        // when EVERY failure is a CONTENT failure — an unparseable / truncated / oversized model
        // response for this diff (the #119/#115 class), where the right outcome is a posted failure
        // routed through the fail-open/closed CI policy. If ANY failure is OPERATIONAL (provider /
        // auth / rate-limit / etc.), keep crashing loudly (exit 1, no summary) so an infrastructure
        // outage alarms instead of being silently fail-opened. Default is to crash: an unrecognized
        // category is treated as operational until it is explicitly deemed degradable.
        const allContentFailures =
          reviewerFailures.length > 0 &&
          reviewerFailures.every((failure) =>
            isDegradableReviewerFailureCategory(failure.errorClassification.category),
          );
        if (allContentFailures) {
          return this.buildAllReviewersFailedResult(input, agentRunId, reviewerFailures, fanOutMs);
        }

        const firstFailure = reviewerSettled.find((settled) => settled.status === "rejected");
        if (firstFailure?.status === "rejected") {
          throw firstFailure.reason;
        }
        throw new Error("All selected reviewers failed before coordinator synthesis");
      }

      // Short-circuit: skip coordinator synthesis when the flag is set, all reviewers
      // succeeded, and every reviewer produced zero findings.
      if (
        input.shortCircuitOnZeroFindings === true &&
        reviewerFailures.length === 0 &&
        reviewerResults.every((result) => result.findings.length === 0)
      ) {
        const summary = summarizeReview(input.context, []);
        this.emitAgentEvent("agent.output", input.runId, agentRunId, "coordinator", {
          decision: summary.decision,
          outcome: summary.outcome,
          findingCount: 0,
          shortCircuited: true,
        });
        this.emitAgentEvent("agent.completed", input.runId, agentRunId, "coordinator", {
          reviewerCount: reviewerResults.length,
          failedReviewerCount: 0,
          shortCircuited: true,
        });
        return {
          runId: input.runId,
          agentRunId,
          summary,
          reviewerResults,
          coordinatorShortCircuited: true,
          fanOutMs,
        };
      }

      const coordinatorPrompt = buildCoordinatorPrompt(input, reviewerResults, reviewerFailures);
      const resolvedModel = this.modelArgs(input.model);
      const effectiveModel = resolvedModel.model?.model;
      let streamedEventCount = 0;
      const fusionStartedAt = Date.now();
      const processResult = await this.processRunner.run({
        runId: input.runId,
        agentRunId,
        role: "coordinator",
        prompt: coordinatorPrompt,
        cwd: input.context.workingDirectory,
        timeoutMs: input.timeoutMs,
        heartbeatIntervalMs: defaultHeartbeatIntervalMs(input.timeoutMs),
        toolPolicy: input.toolPolicy,
        // The coordinator delivers its fused summary via the factory-owned submit_review tool;
        // allowlist it so it stays callable even when the read/shell/write policy emits --no-tools.
        requiredTools: [SUBMIT_REVIEW_TOOL_NAME],
        onEvent: (event) => {
          streamedEventCount += 1;
          this.forwardPiEvent(input.runId, agentRunId, "coordinator", event);
        },
        ...resolvedModel,
      });
      const fusionMs = Date.now() - fusionStartedAt;
      if (streamedEventCount === 0) {
        this.forwardPiEvents(input.runId, agentRunId, "coordinator", processResult.events);
      }

      assertNotTruncatedOutput(processResult.events, agentRunId);
      const allowedReviewerRoles = [
        "coordinator",
        ...input.selectedReviewers.map((reviewer) => reviewer.role),
      ];
      // Structured submit_review tool is the PRIMARY coordinator path (M015 S04, #127); prose +
      // repair is the instruct-only fallback. structuredOutput records which path ran (the
      // production hit-rate the S05 retire-repair decision uses). Invalid tool args THROW (no
      // silent prose re-parse), exactly like the reviewer path.
      const toolArgs = readToolCallArgs(processResult.events, SUBMIT_REVIEW_TOOL_NAME);
      const structuredOutput = toolArgs.status === "found";
      const parsed = structuredOutput
        ? parseCoordinatorToolArgs(toolArgs.args, allowedReviewerRoles, input.context.risk)
        : parseCoordinatorOutput(processResult.finalText, allowedReviewerRoles);
      const summary =
        parsed?.summary ??
        summarizeReview(
          input.context,
          reviewerResults.flatMap((result) => result.findings),
        );

      this.emitAgentEvent("agent.output", input.runId, agentRunId, "coordinator", {
        decision: summary.decision,
        outcome: summary.outcome,
        findingCount: summary.findings.length,
        structuredOutput,
        failedReviewerCount: reviewerFailures.length,
        ...(parsed !== undefined && parsed.reviewerRoleAdjustments.length > 0
          ? {
              reviewerRoleAdjustmentCount: parsed.reviewerRoleAdjustments.length,
              reviewerRoleAdjustments: parsed.reviewerRoleAdjustments,
            }
          : {}),
      });
      this.emitAgentEvent("agent.completed", input.runId, agentRunId, "coordinator", {
        reviewerCount: reviewerResults.length,
        failedReviewerCount: reviewerFailures.length,
        ...(processResult.usage !== undefined ? { usage: processResult.usage } : {}),
      });

      return {
        runId: input.runId,
        agentRunId,
        summary,
        reviewerResults,
        ...(reviewerFailures.length > 0 ? { reviewerFailures } : {}),
        rawOutput: processResult.finalText,
        ...(processResult.usage !== undefined ? { usage: processResult.usage } : {}),
        structuredOutput,
        ...(effectiveModel !== undefined ? { effectiveModel } : {}),
        fanOutMs,
        fusionMs,
      };
    } finally {
      if (this.partialCoordinatorSnapshots.get(input.runId) === snapshot) {
        this.partialCoordinatorSnapshots.delete(input.runId);
      }
    }
  }

  // Builds the degraded result returned when every dispatched reviewer failed (#120). The summary
  // is `review_failed`/`fail` with a body naming the failed roles and their error categories (no raw
  // error messages — those can echo untrusted model output). reviewerResults is empty by definition;
  // reviewerFailures carries the per-reviewer classifications for telemetry.
  private buildAllReviewersFailedResult(
    input: CoordinatorRunInput,
    agentRunId: string,
    reviewerFailures: ReviewerRunFailure[],
    fanOutMs: number,
  ): CoordinatorRunResult {
    const base = summarizeReview(input.context, []);
    const failureLines = reviewerFailures
      .map(
        (failure) =>
          // role and errorName are sanitized into backtick code spans; category is a closed enum.
          `- \`${sanitizeForBodyCodeSpan(failure.role)}\`: \`${sanitizeForBodyCodeSpan(failure.errorName)}\` (${failure.errorClassification.category})`,
      )
      .join("\n");
    const body = `The code review could not be completed: all ${reviewerFailures.length} selected reviewer(s) failed before coordinator synthesis, so no findings were produced. This is a review failure, not an approval — your fail-open/fail-closed CI policy governs whether it blocks the merge.\n\nFailed reviewers:\n${failureLines}`;

    this.emitAgentEvent("agent.output", input.runId, agentRunId, "coordinator", {
      decision: "review_failed",
      outcome: "fail",
      findingCount: 0,
      failedReviewerCount: reviewerFailures.length,
      allReviewersFailed: true,
    });
    this.emitAgentEvent("agent.completed", input.runId, agentRunId, "coordinator", {
      reviewerCount: 0,
      failedReviewerCount: reviewerFailures.length,
    });

    return {
      runId: input.runId,
      agentRunId,
      summary: {
        ...base,
        decision: "review_failed",
        outcome: "fail",
        title: "Review could not complete — all reviewers failed",
        body,
      },
      reviewerResults: [],
      ...(reviewerFailures.length > 0 ? { reviewerFailures } : {}),
      partial: {
        reason: "all_reviewers_failed",
      },
      rawOutput: '{"partial":true,"reason":"all_reviewers_failed"}',
      // Fan-out ran (every reviewer was dispatched, then failed) — record its span even on the
      // degraded path; fusionMs stays undefined since synthesis never ran (#196).
      fanOutMs,
    };
  }

  getPartialCoordinatorResult(runId: string): CoordinatorRunResult | undefined {
    const snapshot = this.partialCoordinatorSnapshots.get(runId);
    if (snapshot === undefined || snapshot.reviewerResults.length === 0) {
      return undefined;
    }

    const reviewerResults = snapshot.reviewerResults.slice();
    const reviewerFailures = snapshot.reviewerFailures.slice();
    const summary = summarizeReview(
      snapshot.input.context,
      reviewerResults.flatMap((result) => result.findings),
    );

    return {
      runId,
      agentRunId: snapshot.agentRunId,
      summary: {
        ...summary,
        decision: "review_failed",
        outcome: "fail",
        title: `Partial ${summary.title.charAt(0).toLowerCase()}${summary.title.slice(1)}`,
        body: `Partial review due to overall timeout. Completed reviewer findings are included; unfinished reviewers and coordinator synthesis were not completed.\n\n${summary.body}`,
      },
      reviewerResults,
      ...(reviewerFailures.length > 0 ? { reviewerFailures } : {}),
      partial: {
        reason: "overall_timeout",
      },
      rawOutput: '{"partial":true,"reason":"overall_timeout"}',
    };
  }

  async runReviewer(input: ReviewerRunInput): Promise<ReviewerRunResult> {
    const agentRunId = `${input.runId}:pi:${input.role}`;
    const startedAt = Date.now();
    const budgetStartedAt = this.reviewerBudgetStarts.get(input) ?? startedAt;
    const maxAttempts = normalizeRetryAttemptCount(this.reviewerRetryPolicy.maxAttempts);
    this.emitAgentEvent("agent.started", input.runId, agentRunId, input.role, {
      assignedFileCount: input.assignedFiles?.length ?? input.context.diff.files.length,
      runtime: this.name,
      maxAttempts,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        let streamedEventCount = 0;
        const prompt = buildReviewerPrompt(input);
        const promptMetrics = createReviewerPromptMetrics(input, prompt);
        const resolvedModel = this.modelArgs(input.model);
        const effectiveModel = resolvedModel.model?.model;
        const processResult = await this.processRunner.run({
          runId: input.runId,
          agentRunId,
          role: input.role,
          prompt,
          cwd: input.context.workingDirectory,
          timeoutMs: input.timeoutMs,
          heartbeatIntervalMs: defaultHeartbeatIntervalMs(input.timeoutMs),
          toolPolicy: input.toolPolicy,
          // The reviewer delivers findings via the factory-owned `submit_findings` tool; allowlist
          // it so it is callable even when the read/shell/write policy would emit `--no-tools`.
          requiredTools: [SUBMIT_FINDINGS_TOOL_NAME],
          onEvent: (event) => {
            streamedEventCount += 1;
            this.forwardPiEvent(input.runId, agentRunId, input.role, event);
          },
          ...resolvedModel,
        });
        if (streamedEventCount === 0) {
          this.forwardPiEvents(input.runId, agentRunId, input.role, processResult.events);
        }

        assertNotTruncatedOutput(processResult.events, agentRunId);
        // Structured tool is the PRIMARY path (M015 S03, #126): when the reviewer called
        // `submit_findings`, read the validated args off the event stream — no `JSON.parse`, no
        // `repairUnescapedStringQuotes`. Pi is instruct-only (no forced `tool_choice`), so the call
        // is never guaranteed; when it is absent we fall back to parsing the model's prose (which
        // still routes through the retained quote-repair). `structuredOutput` records which path ran
        // so the production hit-rate is observable — the evidence S05 uses to retire repair. A tool
        // call WITH invalid args is NOT silently re-parsed from prose: `parseReviewerToolArgs` throws
        // (re-validating every finding), surfacing schema drift as a classified failure.
        const toolArgs = readToolCallArgs(processResult.events, SUBMIT_FINDINGS_TOOL_NAME);
        const structuredOutput = toolArgs.status === "found";
        // The structured tool path re-validates and THROWS on any invalid arg (no silent drop), so
        // its drop count is always 0. The prose fallback drops corrupt/invalid findings tolerantly
        // and reports how many — surfaced as `droppedFindingCount` telemetry (M015 S05, #128).
        const { findings: parsedFindings, droppedFindingCount } = structuredOutput
          ? { findings: parseReviewerToolArgs(toolArgs.args), droppedFindingCount: 0 }
          : parseReviewerOutput(processResult.finalText);
        const roleEnforcement = enforceReviewerRole(parsedFindings, input.role);
        const severityEnforcement = enforceReviewerAllowedSeverities(
          roleEnforcement.findings,
          input.reviewerDefinition.guidance.allowedSeverities,
        );
        const findings = severityEnforcement.findings;
        const retryCount = attempt - 1;

        this.emitAgentEvent("agent.output", input.runId, agentRunId, input.role, {
          findingCount: findings.length,
          attempt,
          retryCount,
          structuredOutput,
          // Surfaced only on a partial drop so a silently-discarded finding (e.g. a prompt-injected
          // finding with an out-of-enum severity) is observable instead of hidden behind the
          // survivor count (M015 S05, #128).
          ...(droppedFindingCount > 0 ? { droppedFindingCount } : {}),
          ...(roleEnforcement.adjustments.length > 0
            ? {
                reviewerRoleAdjustmentCount: roleEnforcement.adjustments.length,
                reviewerRoleAdjustments: roleEnforcement.adjustments,
              }
            : {}),
          ...(severityEnforcement.adjustments.length > 0
            ? {
                severityAdjustmentCount: severityEnforcement.adjustments.length,
                severityAdjustments: severityEnforcement.adjustments,
              }
            : {}),
        });
        this.emitAgentEvent("agent.completed", input.runId, agentRunId, input.role, {
          findingCount: findings.length,
          attemptCount: attempt,
          retryCount,
          promptMetrics,
          ...(processResult.usage !== undefined ? { usage: processResult.usage } : {}),
        });

        const durationMs = Date.now() - startedAt;
        return {
          runId: input.runId,
          agentRunId,
          role: input.role,
          findings,
          rawOutput: processResult.finalText,
          ...(processResult.usage !== undefined ? { usage: processResult.usage } : {}),
          promptMetrics,
          attemptCount: attempt,
          retryCount,
          structuredOutput,
          ...(effectiveModel !== undefined ? { effectiveModel } : {}),
          durationMs,
        };
      } catch (error) {
        const retryCount = attempt - 1;
        const failure = createReviewerFailure(
          input.runId,
          agentRunId,
          input.role,
          error,
          Date.now() - startedAt,
          {
            attemptCount: attempt,
            retryCount,
          },
        );
        const effectiveTimeouts = getEffectiveTimeouts(input.context);
        const willRetry = shouldRetryReviewerFailure({
          classification: failure.errorClassification,
          attempt,
          maxAttempts,
          elapsedMs: Date.now() - budgetStartedAt,
          nextAttemptTimeoutMs: input.timeoutMs,
          coordinatorTimeoutMs: effectiveTimeouts.coordinatorMs,
          overallTimeoutMs: effectiveTimeouts.overallMs,
          // Scale the reserve by the same risk tier as the reviewer/coordinator/overall
          // budgets. Without this the unscaled floor would exceed the scaled overall
          // budget on smaller tiers and silently suppress all retries (e.g. trivial).
          minimumRemainingMs: scaleTimeoutForRiskTier(
            this.reviewerRetryPolicy.minimumRemainingMs,
            input.context.risk.tier,
          ),
        });
        this.emitAgentEvent("agent.failed", input.runId, agentRunId, input.role, {
          errorName: failure.errorName,
          errorMessage: failure.errorMessage,
          errorClassification: failure.errorClassification,
          errorCategory: failure.errorClassification.category,
          retryable: failure.errorClassification.retryable,
          durationMs: failure.durationMs ?? 0,
          attempt,
          maxAttempts,
          retryCount,
          willRetry,
        });

        if (!willRetry) {
          annotateRetryMetadata(error, {
            attemptCount: attempt,
            retryCount,
          });
          throw error;
        }
      }
    }

    throw new Error(`Pi reviewer retry loop exhausted unexpectedly for ${agentRunId}`);
  }

  streamEvents(runId: string, onEvent: (event: RuntimeEvent) => void): RuntimeEventSubscription {
    let listeners = this.listenersByRunId.get(runId);
    if (listeners === undefined) {
      listeners = new Set();
      this.listenersByRunId.set(runId, listeners);
    }

    listeners.add(onEvent);

    return {
      unsubscribe: () => {
        listeners?.delete(onEvent);
      },
    };
  }

  async cancel(runId: string): Promise<void> {
    await this.processRunner.cancel?.(runId);
  }

  private modelArgs(inputModel: { provider: string; model: string; thinking?: ThinkingLevel }): {
    model?: { provider: string; model: string; thinking?: ThinkingLevel };
  } {
    // `thinking` is a task property (reasoning bound for this role), not part of the
    // model identity — so it is preserved even when the dummy placeholder model is
    // swapped for the runtime's real default model (#45).
    const thinking = inputModel.thinking !== undefined ? { thinking: inputModel.thinking } : {};
    if (inputModel.provider === "dummy") {
      // Dummy placeholder with no configured default model = no real model to run, so we
      // emit nothing (and the `thinking` bound is necessarily dropped). This path is only
      // reachable in a degenerate setup with no model at all; real-Pi runs always supply a
      // defaultModel via `--pi-model`, which carries the bound through. Locked by a test.
      return this.defaultModel === undefined
        ? {}
        : { model: { ...this.defaultModel, ...thinking } };
    }

    return { model: { provider: inputModel.provider, model: inputModel.model, ...thinking } };
  }

  private forwardPiEvents(
    runId: string,
    agentRunId: string,
    role: AgentRole | string,
    events: unknown[],
  ): void {
    for (const event of events) {
      this.forwardPiEvent(runId, agentRunId, role, event);
    }
  }

  private forwardPiEvent(
    runId: string,
    agentRunId: string,
    role: AgentRole | string,
    event: unknown,
  ): void {
    this.emit({
      type: "runtime.event",
      runId,
      agentRunId,
      role,
      timestamp: this.now(),
      data: {
        runtime: this.name,
        event: sanitizeJsonValue(event),
      },
    });
  }

  private emitAgentEvent(
    type: "agent.started" | "agent.output" | "agent.completed" | "agent.failed",
    runId: string,
    agentRunId: string,
    role: AgentRole | string,
    data?: Record<string, unknown>,
  ): void {
    this.emit({
      type,
      runId,
      agentRunId,
      role,
      timestamp: this.now(),
      ...(data !== undefined ? { data: sanitizeRecord(data) } : {}),
    });
  }

  private emit(event: RuntimeEvent): void {
    const listeners = this.listenersByRunId.get(event.runId);
    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  private now(): string {
    return this.timestamp ?? new Date().toISOString();
  }
}

export interface BunPiProcessRunnerOptions {
  command?: string;
  /**
   * Override the `pi` base argv (defaults to {@link defaultPiBaseArgs}). When targeting a real `pi`
   * binary, a custom array MUST include `--print`: as of M015 S03 (#126) the prompt is piped via
   * STDIN (`run()` sets `stdin`), not argv, and `pi` reads stdin only under `--print` — omitting it
   * leaves `pi` without a prompt (empty/hung run). It SHOULD also include `--extension
   * <submit-findings path>` for the structured reviewer path. (A custom non-`pi` test binary that
   * reads stdin directly does not need `--print`.)
   */
  baseArgs?: string[];
  /** Explicit `pi --api-key` value (#42). Kept off `PiProcessRunInput` so it never reaches traced events. */
  apiKey?: string;
}

export class BunPiProcessRunner implements PiProcessRunner {
  private readonly command: string;
  private readonly baseArgs: string[];
  private readonly apiKey: string | undefined;
  private readonly processesByRunId = new Map<string, { kill: () => void }>();

  constructor(options: BunPiProcessRunnerOptions = {}) {
    this.command = options.command ?? "pi";
    this.apiKey = options.apiKey;
    this.baseArgs = options.baseArgs ?? defaultPiBaseArgs();
  }

  async run(input: PiProcessRunInput): Promise<PiProcessRunResult> {
    const args = buildPiProcessArgs(
      this.baseArgs,
      input,
      this.apiKey !== undefined ? { apiKey: this.apiKey } : {},
    );
    const process = Bun.spawn([this.command, ...args], {
      cwd: input.cwd,
      // The prompt embeds the reviewed-repo diff + metadata. It is piped via STDIN (not passed as a
      // positional argv) because argv is world-readable on a shared CI host (`/proc/<pid>/cmdline`,
      // `ps`). `--print` (in baseArgs) makes `pi` read the prompt from stdin; the Uint8Array stdin
      // is written and closed (EOF) so the non-interactive run proceeds and exits.
      stdin: new TextEncoder().encode(input.prompt),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...processEnv(),
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    });
    this.processesByRunId.set(input.runId, { kill: () => process.kill() });

    let timedOut = false;
    let inactivityTimedOut = false;
    const startedAt = Date.now();
    let lastOutputAt = startedAt;
    const inactivityTimeoutMs = input.inactivityTimeoutMs ?? Math.min(60_000, input.timeoutMs);
    const heartbeatIntervalMs =
      input.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs(input.timeoutMs);
    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, input.timeoutMs);
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    const resetInactivityTimer = () => {
      if (inactivityTimer !== undefined) {
        clearTimeout(inactivityTimer);
      }
      inactivityTimer = setTimeout(() => {
        inactivityTimedOut = true;
        process.kill();
      }, inactivityTimeoutMs);
    };
    resetInactivityTimer();
    const heartbeatTimer =
      heartbeatIntervalMs > 0
        ? setInterval(() => {
            input.onEvent?.({
              type: "heartbeat",
              runId: input.runId,
              agentRunId: input.agentRunId,
              role: input.role,
              elapsedMs: Date.now() - startedAt,
              silenceMs: Date.now() - lastOutputAt,
              timeoutMs: input.timeoutMs,
            });
          }, heartbeatIntervalMs)
        : undefined;

    try {
      const [stdout, rawError, exitCode] = await Promise.all([
        readJsonlStream(process.stdout, (event) => {
          lastOutputAt = Date.now();
          resetInactivityTimer();
          input.onEvent?.(event);
        }),
        new Response(process.stderr).text(),
        process.exited,
      ]);

      if (inactivityTimedOut) {
        throw new Error(
          `Pi process produced no output for ${inactivityTimeoutMs}ms for ${input.agentRunId}`,
        );
      }

      if (timedOut) {
        throw new Error(`Pi process timed out after ${input.timeoutMs}ms for ${input.agentRunId}`);
      }

      const providerError =
        extractProviderRuntimeError(stdout.events) ?? extractProviderRuntimeError(rawError);
      if (providerError !== undefined) {
        throw providerError;
      }

      if (exitCode !== 0) {
        throw new Error(
          `Pi process exited ${exitCode} for ${input.agentRunId}: ${rawError.trim()}`,
        );
      }

      const usage = extractUsage(stdout.events);
      return {
        finalText: extractFinalAssistantText(stdout.events),
        events: stdout.events,
        ...(usage !== undefined ? { usage } : {}),
        rawOutput: stdout.rawOutput,
        ...(rawError.length > 0 ? { rawError } : {}),
      };
    } catch (error) {
      process.kill();
      throw error;
    } finally {
      clearTimeout(timer);
      if (inactivityTimer !== undefined) {
        clearTimeout(inactivityTimer);
      }
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
      }
      this.processesByRunId.delete(input.runId);
    }
  }

  async cancel(runId: string): Promise<void> {
    this.processesByRunId.get(runId)?.kill();
  }
}

function createReviewerFailure(
  runId: string,
  agentRunId: string,
  role: AgentRole | string,
  error: unknown,
  durationMs?: number,
  retryMetadata: RetryMetadata = readRetryMetadata(error),
): ReviewerRunFailure {
  const serialized = serializeRuntimeError(error);
  return {
    runId,
    agentRunId,
    role,
    errorName: serialized.name,
    errorMessage: serialized.message,
    errorClassification: classifyReviewError(error),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(retryMetadata.attemptCount !== undefined
      ? { attemptCount: retryMetadata.attemptCount }
      : {}),
    ...(retryMetadata.retryCount !== undefined ? { retryCount: retryMetadata.retryCount } : {}),
  };
}

interface RetryMetadata {
  attemptCount?: number;
  retryCount?: number;
}

function defaultHeartbeatIntervalMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return 60_000;
  }

  return Math.min(60_000, Math.max(5_000, Math.floor(timeoutMs / 4)));
}

function normalizeRetryAttemptCount(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

/**
 * Decide whether a retryable reviewer failure may be retried within the remaining
 * wall-clock budget. A retry is only permitted when the budget left in the overall
 * (tier-scaled) ceiling can still cover another reviewer attempt, the coordinator
 * synthesis, and a reserve buffer:
 *
 *   overallTimeoutMs - elapsedMs >= nextAttemptTimeoutMs + coordinatorTimeoutMs + minimumRemainingMs
 *
 * All four budget terms must be expressed in the same risk tier — callers pass
 * tier-scaled values (including a tier-scaled `minimumRemainingMs`) so the reserve
 * stays proportional to the shrunken lite/trivial ceilings rather than dominating them.
 */
function shouldRetryReviewerFailure(input: {
  classification: ReturnType<typeof classifyReviewError>;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  nextAttemptTimeoutMs: number;
  coordinatorTimeoutMs: number;
  overallTimeoutMs: number;
  minimumRemainingMs: number;
}): boolean {
  if (!input.classification.retryable || input.attempt >= input.maxAttempts) {
    return false;
  }

  const retryReserveMs =
    input.nextAttemptTimeoutMs + input.coordinatorTimeoutMs + input.minimumRemainingMs;
  return input.overallTimeoutMs - input.elapsedMs >= retryReserveMs;
}

export { shouldRetryReviewerFailure };

function annotateRetryMetadata(error: unknown, metadata: Required<RetryMetadata>): void {
  if (typeof error !== "object" || error === null) {
    return;
  }

  const target = error as Record<string, unknown>;
  target.aiReviewAttemptCount = metadata.attemptCount;
  target.aiReviewRetryCount = metadata.retryCount;
}

function readRetryMetadata(error: unknown): RetryMetadata {
  if (typeof error !== "object" || error === null) {
    return {};
  }

  const record = error as Record<string, unknown>;
  return {
    ...(typeof record.aiReviewAttemptCount === "number"
      ? { attemptCount: record.aiReviewAttemptCount }
      : {}),
    ...(typeof record.aiReviewRetryCount === "number"
      ? { retryCount: record.aiReviewRetryCount }
      : {}),
  };
}

function serializeRuntimeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}

function extractProviderRuntimeError(input: unknown): ProviderRuntimeError | undefined {
  if (Array.isArray(input)) {
    for (const item of input) {
      const error = extractProviderRuntimeError(item);
      if (error !== undefined) {
        return error;
      }
    }

    return undefined;
  }

  if (typeof input === "string") {
    return extractProviderRuntimeErrorFromText(input);
  }

  if (typeof input !== "object" || input === null) {
    return undefined;
  }

  const record = input as Record<string, unknown>;
  if (record.type !== "error" || typeof record.error !== "object" || record.error === null) {
    return undefined;
  }

  const errorRecord = record.error as Record<string, unknown>;
  const providerErrorType =
    typeof errorRecord.type === "string" ? errorRecord.type : "provider_error";
  const message =
    typeof errorRecord.message === "string"
      ? errorRecord.message
      : "Provider returned an error envelope.";
  const status = typeof record.status === "number" ? record.status : undefined;

  return new ProviderRuntimeError({
    providerErrorType,
    message,
    ...(status !== undefined ? { status } : {}),
  });
}

function extractProviderRuntimeErrorFromText(text: string): ProviderRuntimeError | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart === -1) {
    return undefined;
  }

  const prefix = trimmed.slice(0, jsonStart).trim();
  const status = /^\d{3}$/.test(prefix) ? Number(prefix) : undefined;

  try {
    const error = extractProviderRuntimeError(JSON.parse(trimmed.slice(jsonStart)));
    if (error === undefined || error.status !== undefined || status === undefined) {
      return error;
    }

    return new ProviderRuntimeError({
      providerErrorType: error.providerErrorType,
      message: error.message.replace(/^Provider error \([^)]+\): /, ""),
      status,
    });
  } catch {
    return undefined;
  }
}

function assertNotTruncatedOutput(events: unknown[], agentRunId: string): void {
  const finishReason = findLengthLimitFinishReason(events);
  if (finishReason !== undefined) {
    throw new Error(
      `Pi model output truncated by length limit (${finishReason}) for ${agentRunId}`,
    );
  }
}

function findLengthLimitFinishReason(events: unknown[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const reason = collectFinishReason(events[index]);
    if (reason !== undefined && isLengthLimitFinishReason(reason)) {
      return reason;
    }
  }

  return undefined;
}

function collectFinishReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const directReason = readFinishReason(record);
  if (directReason !== undefined) {
    return directReason;
  }

  for (const field of ["message", "response", "result", "data"]) {
    const nested = record[field];
    if (typeof nested === "object" && nested !== null) {
      const nestedReason = readFinishReason(nested as Record<string, unknown>);
      if (nestedReason !== undefined) {
        return nestedReason;
      }
    }
  }

  return undefined;
}

function readFinishReason(record: Record<string, unknown>): string | undefined {
  for (const field of ["finish_reason", "finishReason", "stop_reason", "stopReason", "reason"]) {
    const value = record[field];
    if (typeof value === "string") {
      return value;
    }
  }

  return undefined;
}

function isLengthLimitFinishReason(reason: string): boolean {
  const normalized = reason.toLowerCase().replaceAll(/[-\s]/g, "_");
  return (
    normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized === "output_token_limit"
  );
}

// Reviewer-failure categories that represent an unusable model RESPONSE for this diff (the model
// ran but its output could not be used) rather than an infrastructure/operational failure. When
// EVERY reviewer fails with one of these, the all-reviewers-failed path degrades to a published
// review_failed notice (#120). Any other category — provider_error, auth, rate_limited,
// retryable_transient, timeout, unsafe_fork — keeps crashing loudly so an outage surfaces instead of
// being silently routed through a fail-open policy. This is an explicit allowlist: an UNRECOGNIZED
// category (one not in this set) defaults to "operational" (crash), the safe direction.
//
// `unknown` is INCLUDED deliberately, with eyes open to the fail-open tradeoff: the parse-crash that
// motivated #120 (raw `JSON Parse error: …` from the model) classifies as `unknown`, not
// `schema_invalid` (the classifier only matches explicit "…valid json…" phrasings). Excluding
// `unknown` would leave the real motivating case crashing. The residual risk — a genuine code bug
// that surfaces as `unknown` degrading to review_failed and passing under fail-OPEN — is bounded:
// under fail-closed it still blocks, and the published body shows the category so it is not silent.
const DEGRADABLE_REVIEWER_FAILURE_CATEGORIES = new Set<ReviewErrorClassification["category"]>([
  "schema_invalid",
  "truncated",
  "context_overflow",
  "unknown",
]);

function isDegradableReviewerFailureCategory(
  category: ReviewErrorClassification["category"],
): boolean {
  return DEGRADABLE_REVIEWER_FAILURE_CATEGORIES.has(category);
}

// Sanitize a trusted-but-defensive value (reviewer role, error name) for inline rendering inside a
// backtick code span in summary.body: collapse whitespace/control chars, strip backticks (code-span
// breakout), and bound length. These come from trusted sources, but the renderer does not re-escape
// summary.body, so we keep the assembled markdown safe at the source.
function sanitizeForBodyCodeSpan(value: string): string {
  return value
    .replaceAll(/[\r\n\t`]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

async function readJsonlStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: ((event: unknown) => void) | undefined,
): Promise<{ rawOutput: string; events: unknown[] }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let rawOutput = "";
  let buffer = "";

  const parseLine = (line: string) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.trim().length === 0) {
      return;
    }

    let event: unknown;
    try {
      // Common path: a well-formed JSONL event line parses once here.
      event = JSON.parse(normalized) as unknown;
    } catch (parseError) {
      // Not pure JSON — may be a status-prefixed provider envelope ("400 {...}").
      const providerError = extractProviderRuntimeErrorFromText(normalized);
      if (providerError !== undefined) {
        throw providerError;
      }
      throw parseError;
    }

    // A well-formed `{"type":"error",...}` envelope is a provider error, not an event.
    const providerError = extractProviderRuntimeError(event);
    if (providerError !== undefined) {
      throw providerError;
    }

    events.push(event);
    onEvent?.(event);
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      break;
    }

    const text = decoder.decode(chunk.value, { stream: true });
    rawOutput += text;
    buffer += text;

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      parseLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  const finalText = decoder.decode();
  if (finalText.length > 0) {
    rawOutput += finalText;
    buffer += finalText;
  }
  if (buffer.length > 0) {
    parseLine(buffer);
  }

  return { rawOutput, events };
}

function extractFinalAssistantText(events: unknown[]): string {
  let lastText = "";

  for (const event of events) {
    const record =
      typeof event === "object" && event !== null ? (event as Record<string, unknown>) : undefined;
    if (
      record?.type === "message_end" &&
      typeof record.message === "object" &&
      record.message !== null
    ) {
      const content = (record.message as Record<string, unknown>).content;
      const text = extractTextContent(content);
      if (text.length > 0) {
        lastText = text;
      }
    }
  }

  return lastText;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      if (typeof item !== "object" || item === null) {
        return "";
      }
      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function extractUsage(events: unknown[]): TokenUsage | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const record =
      typeof event === "object" && event !== null ? (event as Record<string, unknown>) : undefined;
    if (
      record?.type !== "message_end" ||
      typeof record.message !== "object" ||
      record.message === null
    ) {
      continue;
    }

    const usage = (record.message as Record<string, unknown>).usage;
    if (typeof usage !== "object" || usage === null) {
      continue;
    }

    const usageRecord = usage as Record<string, unknown>;
    return {
      ...(typeof usageRecord.input === "number" ? { inputTokens: usageRecord.input } : {}),
      ...(typeof usageRecord.output === "number" ? { outputTokens: usageRecord.output } : {}),
      ...(typeof usageRecord.cacheRead === "number"
        ? { cacheReadTokens: usageRecord.cacheRead }
        : {}),
      ...(typeof usageRecord.cacheWrite === "number"
        ? { cacheWriteTokens: usageRecord.cacheWrite }
        : {}),
      ...(typeof usageRecord.cost === "object" &&
      usageRecord.cost !== null &&
      typeof (usageRecord.cost as Record<string, unknown>).total === "number"
        ? { estimatedCostUsd: (usageRecord.cost as Record<string, number>).total }
        : {}),
    };
  }

  return undefined;
}

function toolPolicyArgs(
  policy: RuntimeToolPolicy,
  requiredTools: readonly string[] = [],
): string[] {
  const tools = new Set(policy.allowedTools);
  if (policy.allowRead) {
    for (const tool of ["read", "grep", "find", "ls"]) {
      tools.add(tool);
    }
  }
  if (policy.allowShell) {
    tools.add("bash");
  }
  if (policy.allowWrite) {
    tools.add("write");
    tools.add("edit");
  }
  // requiredTools (e.g. `submit_findings`, M015 S03 #126) are allowlisted unconditionally: a
  // delivery tool must stay callable even under an otherwise-empty policy. Because they keep the
  // set non-empty, the `--no-tools` branch is reached only when NOTHING is requested — preserving
  // the "no policy, no required tools" case while ensuring `--tools <…>` includes them otherwise.
  for (const tool of requiredTools) {
    tools.add(tool);
  }

  return tools.size === 0 ? ["--no-tools"] : ["--tools", [...tools].join(",")];
}

// Pure, testable construction of the `pi` argv. `--thinking` is emitted only when the
// resolved model carries a reasoning bound (#45): omitting it leaves Pi at its default
// level, which is the full-tier reviewer non-convergence we are bounding. `--api-key`
// (#42) forces key-auth over any stored pi OAuth; its value is runner config, never part of the
// traced `PiProcessRunInput`. The prompt is NOT included here: it embeds the reviewed-repo diff
// and is piped via STDIN (`--print`), not argv, since argv is world-readable on a shared host
// (M015 S03, #126). So the argv carries only flags — no reviewed-repo content.
export function buildPiProcessArgs(
  baseArgs: string[],
  input: PiProcessRunInput,
  options: { apiKey?: string } = {},
): string[] {
  return [
    ...baseArgs,
    ...(options.apiKey !== undefined ? ["--api-key", options.apiKey] : []),
    ...toolPolicyArgs(input.toolPolicy, input.requiredTools ?? []),
    ...(input.model !== undefined
      ? ["--provider", input.model.provider, "--model", input.model.model]
      : []),
    ...(input.model?.thinking !== undefined ? ["--thinking", input.model.thinking] : []),
  ];
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeJsonValue(item)]),
  );
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }

  if (typeof value === "object") {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  }

  return String(value);
}
