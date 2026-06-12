import type {
  AgentRuntime,
  CoordinatorRunInput,
  CoordinatorRunResult,
  Finding,
  ReviewerRunInput,
  ReviewerRunResult,
  RuntimeEvent,
  RuntimeEventSubscription,
} from "../contracts/index.ts";
import { summarizeReview } from "../runner/run-review.ts";

export interface DummyAgentRuntimeOptions {
  findingsByRole?: Record<string, Finding[]>;
  defaultFindings?: Finding[];
  timestamp?: string;
}

export class DummyAgentRuntime implements AgentRuntime {
  readonly name = "dummy";

  private readonly findingsByRole: Record<string, Finding[]>;
  private readonly defaultFindings: Finding[];
  private readonly timestamp: string | undefined;
  private readonly listenersByRunId = new Map<string, Set<(event: RuntimeEvent) => void>>();
  private readonly cancelledRunIds = new Set<string>();

  constructor(options: DummyAgentRuntimeOptions = {}) {
    this.findingsByRole = options.findingsByRole ?? {};
    this.defaultFindings = options.defaultFindings ?? [];
    this.timestamp = options.timestamp;
  }

  async runCoordinator(input: CoordinatorRunInput): Promise<CoordinatorRunResult> {
    this.assertNotCancelled(input.runId);
    const agentRunId = `${input.runId}:coordinator`;

    this.emit({
      type: "agent.started",
      runId: input.runId,
      agentRunId,
      role: "coordinator",
      timestamp: this.now(),
      data: {
        reviewerCount: input.selectedReviewers.length,
        runtime: this.name,
      },
    });

    const reviewerResults = await Promise.all(
      input.selectedReviewers.map((reviewer) => this.runReviewer(reviewer)),
    );
    const findings = reviewerResults.flatMap((result) => result.findings);
    const summary = summarizeReview(input.context, findings);

    // No reviewer-failure guard here (unlike PiAgentRuntime): reviewers run via Promise.all,
    // so any failure throws before this point — zero findings can only mean all succeeded empty.
    const shortCircuited = input.shortCircuitOnZeroFindings === true && findings.length === 0;

    this.emit({
      type: "agent.output",
      runId: input.runId,
      agentRunId,
      role: "coordinator",
      timestamp: this.now(),
      data: {
        decision: summary.decision,
        outcome: summary.outcome,
        findingCount: findings.length,
        ...(shortCircuited ? { shortCircuited: true } : {}),
      },
    });
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    };

    this.emit({
      type: "agent.completed",
      runId: input.runId,
      agentRunId,
      role: "coordinator",
      timestamp: this.now(),
      data: {
        reviewerCount: reviewerResults.length,
        usage,
        ...(shortCircuited ? { shortCircuited: true } : {}),
      },
    });

    return {
      runId: input.runId,
      agentRunId,
      summary,
      reviewerResults,
      rawOutput: JSON.stringify(summary),
      usage,
      ...(shortCircuited ? { coordinatorShortCircuited: true } : {}),
    };
  }

  async runReviewer(input: ReviewerRunInput): Promise<ReviewerRunResult> {
    this.assertNotCancelled(input.runId);
    const agentRunId = `${input.runId}:${input.role}`;

    this.emit({
      type: "agent.started",
      runId: input.runId,
      agentRunId,
      role: input.role,
      timestamp: this.now(),
      data: {
        assignedFileCount: input.assignedFiles?.length ?? input.context.diff.files.length,
        runtime: this.name,
      },
    });

    const findings = this.findingsForRole(input.role);

    this.emit({
      type: "agent.output",
      runId: input.runId,
      agentRunId,
      role: input.role,
      timestamp: this.now(),
      data: {
        findingCount: findings.length,
      },
    });
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    };

    this.emit({
      type: "agent.completed",
      runId: input.runId,
      agentRunId,
      role: input.role,
      timestamp: this.now(),
      data: {
        findingCount: findings.length,
        usage,
      },
    });

    return {
      runId: input.runId,
      agentRunId,
      role: input.role,
      findings,
      rawOutput: JSON.stringify({ findings }),
      usage,
    };
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
    this.cancelledRunIds.add(runId);
  }

  private findingsForRole(role: string): Finding[] {
    const roleFindings = this.findingsByRole[role];
    if (roleFindings !== undefined) {
      return roleFindings;
    }

    return this.defaultFindings.filter((finding) => finding.reviewer === role);
  }

  private assertNotCancelled(runId: string): void {
    if (this.cancelledRunIds.has(runId)) {
      const agentRunId = `${runId}:cancelled`;
      this.emit({
        type: "agent.failed",
        runId,
        agentRunId,
        timestamp: this.now(),
        message: "Run was cancelled",
      });
      throw new Error(`Dummy runtime run ${runId} was cancelled`);
    }
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
