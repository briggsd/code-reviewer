import type { JsonValue } from "../contracts/common.ts";
import type { TelemetryEvent } from "../contracts/telemetry.ts";
import { NON_REAL_RUNTIME_KINDS } from "../runtime/runtime-kind.ts";

const NON_REAL_RUNTIME_KIND_SET: ReadonlySet<string> = new Set(NON_REAL_RUNTIME_KINDS);

export interface AgentTokenAggregate {
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalEstimatedCostUsd: number;
}

export interface RunMetricsRollup {
  runCount: number;
  runtimeCounts: Record<string, number>;
  riskTierCounts: Record<string, number>;
  decisionCounts: Record<string, number>;
  findings: {
    total: number;
    byReviewer: Record<string, number>;
  };
  retries: {
    agentRetryCount: number;
    agentRetryCountsByRole: Record<string, number>;
    failureRetryCount: number;
    failureRetryCountsByRole: Record<string, number>;
    failureCount: number;
    retryableFailureCount: number;
  };
  tokens: {
    totalAgentCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
    totalEstimatedCostUsd: number;
    byRole: Record<string, AgentTokenAggregate>;
  };
  yield: {
    findingsPerRun: number;
    inputTokensPerFinding: number | null;
    outputTokensPerFinding: number | null;
    costPerFindingUsd: number | null;
  };
}

interface RunMetricsEventData extends Record<string, JsonValue> {
  runtime?: string;
  riskTier?: string;
  decision?: string;
  findingCount?: number;
  findingsByReviewer?: Record<string, JsonValue>;
  tokens?: Record<string, JsonValue>;
  agents?: Array<Record<string, JsonValue>>;
  failures?: Array<Record<string, JsonValue>>;
}

type RunMetricsEvent = TelemetryEvent & { data: RunMetricsEventData };

export function rollupRunMetrics(events: readonly TelemetryEvent[]): RunMetricsRollup {
  const realEvents = events.filter(isRunMetricsEvent);

  const runCount = realEvents.length;
  const runtimeCounts = new Map<string, number>();
  const riskTierCounts = new Map<string, number>();
  const decisionCounts = new Map<string, number>();
  const findingsByReviewer = new Map<string, number>();
  const agentRetryCountsByRole = new Map<string, number>();
  const failureRetryCountsByRole = new Map<string, number>();
  const agentTokenAggregatesByRole = new Map<string, AgentTokenAggregate>();

  let totalFindings = 0;
  let agentRetryCount = 0;
  let failureRetryCount = 0;
  let failureCount = 0;
  let retryableFailureCount = 0;
  let totalAgentCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalEstimatedCostUsd = 0;

  for (const event of realEvents) {
    const data = event.data;

    if (typeof data.runtime === "string") {
      incrementMap(runtimeCounts, data.runtime, 1);
    }

    if (typeof data.riskTier === "string" && data.riskTier.length > 0) {
      incrementMap(riskTierCounts, data.riskTier, 1);
    }

    if (typeof data.decision === "string" && data.decision.length > 0) {
      incrementMap(decisionCounts, data.decision, 1);
    }

    const findingsRecord = data.findingsByReviewer;
    if (findingsRecord !== undefined && isPlainObject(findingsRecord)) {
      for (const [reviewer, count] of Object.entries(findingsRecord)) {
        if (typeof count === "number" && Number.isFinite(count)) {
          incrementMap(findingsByReviewer, reviewer, count);
          totalFindings += count;
        }
      }
    } else if (typeof data.findingCount === "number" && Number.isFinite(data.findingCount)) {
      totalFindings += data.findingCount;
    }

    const tokens = data.tokens;
    if (tokens !== undefined && isPlainObject(tokens)) {
      totalAgentCount += asNumber(tokens.agentCount);
      totalInputTokens += asNumber(tokens.inputTokens);
      totalOutputTokens += asNumber(tokens.outputTokens);
      totalCacheReadTokens += asNumber(tokens.cacheReadTokens);
      totalCacheWriteTokens += asNumber(tokens.cacheWriteTokens);
      totalEstimatedCostUsd += asNumber(tokens.estimatedCostUsd);
    }

    const agents = data.agents;
    if (Array.isArray(agents)) {
      for (const agent of agents) {
        if (!isPlainObject(agent)) {
          continue;
        }

        const roleValue = agent.role;
        const kindValue = agent.kind;
        const role = typeof roleValue === "string" && roleValue.length > 0
          ? roleValue
          : typeof kindValue === "string" && kindValue.length > 0
            ? kindValue
            : "unknown";

        const usageValue = agent.usage;
        if (usageValue !== undefined && isPlainObject(usageValue)) {
          const aggregate = getOrCreateAgentAggregate(agentTokenAggregatesByRole, role);
          aggregate.callCount += 1;
          aggregate.totalInputTokens += asNumber(usageValue.inputTokens);
          aggregate.totalOutputTokens += asNumber(usageValue.outputTokens);
          aggregate.totalCacheReadTokens += asNumber(usageValue.cacheReadTokens);
          aggregate.totalCacheWriteTokens += asNumber(usageValue.cacheWriteTokens);
          aggregate.totalEstimatedCostUsd += asNumber(usageValue.estimatedCostUsd);
        }

        const retryCountValue = agent.retryCount;
        const retryCountNumber = asNumber(retryCountValue);
        if (retryCountNumber > 0) {
          agentRetryCount += retryCountNumber;
          incrementMap(agentRetryCountsByRole, role, retryCountNumber);
        }
      }
    }

    const failures = data.failures;
    if (Array.isArray(failures)) {
      for (const failure of failures) {
        if (!isPlainObject(failure)) {
          continue;
        }

        failureCount += 1;

        const errorClassification = failure.errorClassification;
        if (isPlainObject(errorClassification) && errorClassification.retryable === true) {
          retryableFailureCount += 1;
        }

        const roleValue = failure.role;
        const kindValue = failure.kind;
        const role = typeof roleValue === "string" && roleValue.length > 0
          ? roleValue
          : typeof kindValue === "string" && kindValue.length > 0
            ? kindValue
            : "unknown";

        const retryCountValue = failure.retryCount;
        const retryCountNumber = asNumber(retryCountValue);
        if (retryCountNumber > 0) {
          failureRetryCount += retryCountNumber;
          incrementMap(failureRetryCountsByRole, role, retryCountNumber);
        }
      }
    }
  }

  const findingsTotal = totalFindings;
  const findingsPerRun = runCount === 0 ? 0 : findingsTotal / runCount;
  const inputTokensPerFinding = findingsTotal === 0 ? null : totalInputTokens / findingsTotal;
  const outputTokensPerFinding = findingsTotal === 0 ? null : totalOutputTokens / findingsTotal;
  const costPerFindingUsd = findingsTotal === 0 ? null : totalEstimatedCostUsd / findingsTotal;

  return {
    runCount,
    runtimeCounts: mapToRecord(runtimeCounts),
    riskTierCounts: mapToRecord(riskTierCounts),
    decisionCounts: mapToRecord(decisionCounts),
    findings: {
      total: findingsTotal,
      byReviewer: mapToRecord(findingsByReviewer),
    },
    retries: {
      agentRetryCount,
      agentRetryCountsByRole: mapToRecord(agentRetryCountsByRole),
      failureRetryCount,
      failureRetryCountsByRole: mapToRecord(failureRetryCountsByRole),
      failureCount,
      retryableFailureCount,
    },
    tokens: {
      totalAgentCount,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalEstimatedCostUsd,
      byRole: mapToAgentRecord(agentTokenAggregatesByRole),
    },
    yield: {
      findingsPerRun,
      inputTokensPerFinding,
      outputTokensPerFinding,
      costPerFindingUsd,
    },
  };
}

function isRunMetricsEvent(event: TelemetryEvent): event is RunMetricsEvent {
  if (event.type !== "ai_review.run_metrics") {
    return false;
  }
  if (!isPlainObject(event.data)) {
    return false;
  }
  const runtime = event.data.runtime;
  return typeof runtime === "string" && !NON_REAL_RUNTIME_KIND_SET.has(runtime);
}

function incrementMap(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [key, value] of map.entries()) {
    record[key] = value;
  }
  return record;
}

function mapToAgentRecord(map: Map<string, AgentTokenAggregate>): Record<string, AgentTokenAggregate> {
  const record: Record<string, AgentTokenAggregate> = {};
  for (const [key, value] of map.entries()) {
    record[key] = { ...value };
  }
  return record;
}

function getOrCreateAgentAggregate(map: Map<string, AgentTokenAggregate>, key: string): AgentTokenAggregate {
  let aggregate = map.get(key);
  if (aggregate === undefined) {
    aggregate = {
      callCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalEstimatedCostUsd: 0,
    };
    map.set(key, aggregate);
  }
  return aggregate;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return 0;
}

function isPlainObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
