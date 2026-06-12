import type { JsonValue, RuntimeEvent, TraceSink } from "../contracts/index.ts";

const REDACTION_MARKER = "[redacted]";

/**
 * A `TraceSink` decorator that redacts prompt/message text content from
 * `runtime.event` trace entries that wrap Pi `message_start` / `message_end`
 * events.
 *
 * The event envelope (type, runId, agentRunId, role, timestamp) and any
 * numeric metadata (e.g. token-usage fields on `message_end`) are preserved.
 * All other event types pass through unchanged.
 *
 * This makes persisted trace artifacts artifact-safe: operator reviewer-
 * definition system-prompt text is not included in downloadable CI artifacts.
 */
export class RedactingTraceSink implements TraceSink {
  private readonly inner: TraceSink;

  constructor(inner: TraceSink) {
    this.inner = inner;
  }

  async write(event: RuntimeEvent): Promise<void> {
    await this.inner.write(redactEvent(event));
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

function redactEvent(event: RuntimeEvent): RuntimeEvent {
  if (event.type !== "runtime.event" || event.data === undefined) {
    return event;
  }

  const piEvent = event.data.event;
  if (typeof piEvent !== "object" || piEvent === null || Array.isArray(piEvent)) {
    return event;
  }

  const piRecord = piEvent as Record<string, JsonValue>;
  const piEventType = piRecord.type;

  if (piEventType !== "message_start" && piEventType !== "message_end") {
    return event;
  }

  const message = piRecord.message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return event;
  }

  const messageRecord = message as Record<string, JsonValue>;
  const redactedMessage = redactMessageContent(messageRecord);

  return {
    ...event,
    data: {
      ...event.data,
      event: {
        ...piRecord,
        message: redactedMessage,
      },
    },
  };
}

/**
 * Return a copy of the message with its `content` (the prompt or reply text)
 * replaced by the redaction marker. Applies identically to `message_start` and
 * `message_end`; all other fields — including numeric `usage` — are preserved.
 */
function redactMessageContent(messageRecord: Record<string, JsonValue>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};

  for (const [key, value] of Object.entries(messageRecord)) {
    if (key === "content") {
      result[key] = REDACTION_MARKER;
    } else {
      result[key] = value;
    }
  }

  return result;
}
