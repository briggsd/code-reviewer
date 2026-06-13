import type {
  TelemetryDeliveryFailure,
  TelemetryDeliveryFailureReason,
  TelemetryEvent,
  TelemetryFlushResult,
  TelemetrySink,
  TelemetryTransport,
  TraceSink,
} from "../contracts/index.ts";

export interface NonBlockingTelemetrySinkOptions {
  transport: TelemetryTransport;
  capacity?: number;
  deliveryTimeoutMs?: number;
  now?: () => Date;
  onFailure?: (failure: TelemetryDeliveryFailure) => void;
}

const DEFAULT_CAPACITY = 100;
const DEFAULT_DELIVERY_TIMEOUT_MS = 1_000;

export function createRemoteDeliveryTraceLogger(options: {
  traceSink: TraceSink;
  runId: string;
  now?: () => Date;
}): (event: TelemetryEvent, result: { ok: boolean; error?: Error }) => void {
  const now = options.now ?? (() => new Date());
  return (event, result) => {
    void options.traceSink
      .write({
        type: "runtime.event",
        runId: options.runId,
        timestamp: now().toISOString(),
        message: `Remote telemetry ${result.ok ? "delivered" : "failed"}`,
        data: {
          event: result.ok ? "telemetry.remote_delivered" : "telemetry.remote_failed",
          telemetryEventType: event.type,
          errorName: result.error?.name ?? null,
          errorMessage: result.error?.message ?? null,
        },
      })
      .catch(() => undefined);
  };
}

export function createTelemetryFailureTraceLogger(options: {
  traceSink: TraceSink;
  runId: string;
}): (failure: TelemetryDeliveryFailure) => void {
  return (failure) => {
    void options.traceSink
      .write({
        type: "runtime.event",
        runId: options.runId,
        timestamp: failure.timestamp,
        message: `Telemetry delivery ${failure.reason}`,
        data: {
          event: "telemetry.delivery_failed",
          reason: failure.reason,
          telemetryEventType: failure.event?.type ?? null,
          queueSize: failure.queueSize,
          deliveredCount: failure.deliveredCount,
          failedCount: failure.failedCount,
          droppedCount: failure.droppedCount,
          errorName: failure.error?.name ?? null,
          errorMessage: failure.error?.message ?? null,
        },
      })
      .catch(() => undefined);
  };
}

export class NonBlockingTelemetrySink implements TelemetrySink {
  private readonly transport: TelemetryTransport;
  private readonly capacity: number;
  private readonly deliveryTimeoutMs: number;
  private readonly now: () => Date;
  private readonly onFailure: (failure: TelemetryDeliveryFailure) => void;
  private readonly queue: TelemetryEvent[] = [];
  private readonly waiters: Array<() => void> = [];

  private draining = false;
  private closed = false;
  private deliveredCount = 0;
  private failedCount = 0;
  private droppedCount = 0;

  constructor(options: NonBlockingTelemetrySinkOptions) {
    this.transport = options.transport;
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.deliveryTimeoutMs = options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.onFailure = options.onFailure ?? (() => {});
  }

  emit(event: TelemetryEvent): void {
    if (this.closed) {
      this.recordFailure("closed", event);
      return;
    }

    if (this.queue.length >= this.capacity) {
      this.droppedCount += 1;
      this.recordFailure("queue_full", event);
      return;
    }

    this.queue.push(event);
    void this.drain();
  }

  async flush(): Promise<TelemetryFlushResult> {
    while (this.draining || this.queue.length > 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    return this.snapshot();
  }

  async close(): Promise<TelemetryFlushResult> {
    this.closed = true;
    const result = await this.flush();

    if (this.transport.close !== undefined) {
      try {
        await withDeliveryTimeout(this.transport.close(), this.deliveryTimeoutMs);
      } catch (error) {
        this.recordFailure(classifyDeliveryFailure(error), undefined, error);
      }
    }

    return this.snapshot(result.pendingCount);
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }

    this.draining = true;

    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift();
        if (event === undefined) {
          continue;
        }

        try {
          await withDeliveryTimeout(this.transport.send(event), this.deliveryTimeoutMs);
          this.deliveredCount += 1;
        } catch (error) {
          this.failedCount += 1;
          this.recordFailure(classifyDeliveryFailure(error), event, error);
        }
      }
    } finally {
      this.draining = false;
      this.resolveWaiters();

      if (this.queue.length > 0) {
        void this.drain();
      }
    }
  }

  private recordFailure(
    reason: TelemetryDeliveryFailureReason,
    event?: TelemetryEvent,
    error?: unknown,
  ): void {
    this.onFailure({
      reason,
      ...(event !== undefined ? { event } : {}),
      ...(error !== undefined ? { error: serializeTelemetryError(error) } : {}),
      queueSize: this.queue.length,
      deliveredCount: this.deliveredCount,
      failedCount: this.failedCount,
      droppedCount: this.droppedCount,
      timestamp: this.now().toISOString(),
    });
  }

  private snapshot(pendingCount = this.queue.length): TelemetryFlushResult {
    return {
      deliveredCount: this.deliveredCount,
      failedCount: this.failedCount,
      droppedCount: this.droppedCount,
      pendingCount,
    };
  }

  private resolveWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }
}

class TelemetryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Telemetry delivery timed out after ${timeoutMs}ms`);
    this.name = "TelemetryTimeoutError";
  }
}

async function withDeliveryTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new TelemetryTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timedOut) {
      promise.catch(() => undefined);
    }
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function classifyDeliveryFailure(error: unknown): TelemetryDeliveryFailureReason {
  return error instanceof TelemetryTimeoutError ? "delivery_timeout" : "transport_error";
}

function serializeTelemetryError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack !== undefined ? { stack: error.stack } : {}),
    };
  }

  return {
    name: "Error",
    message: String(error),
  };
}
