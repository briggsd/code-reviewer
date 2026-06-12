import type { JsonValue } from "./common.ts";

export interface TelemetryEvent {
  type: string;
  timestamp: string;
  runId?: string;
  data?: Record<string, JsonValue>;
}

export interface TelemetryDeliveryError {
  name: string;
  message: string;
  stack?: string;
}

export type TelemetryDeliveryFailureReason =
  | "queue_full"
  | "delivery_timeout"
  | "transport_error"
  | "closed";

export interface TelemetryDeliveryFailure {
  reason: TelemetryDeliveryFailureReason;
  event?: TelemetryEvent;
  error?: TelemetryDeliveryError;
  queueSize: number;
  deliveredCount: number;
  failedCount: number;
  droppedCount: number;
  timestamp: string;
}

export interface TelemetryFlushResult {
  deliveredCount: number;
  failedCount: number;
  droppedCount: number;
  pendingCount: number;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;

  flush(): Promise<TelemetryFlushResult>;

  close(): Promise<TelemetryFlushResult>;
}

export interface TelemetryTransport {
  send(event: TelemetryEvent): Promise<void>;

  close?(): Promise<void>;
}
