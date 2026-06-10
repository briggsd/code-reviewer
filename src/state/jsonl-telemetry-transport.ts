import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TelemetryEvent, TelemetryTransport } from "../contracts/index.ts";

export class JsonlTelemetryTransport implements TelemetryTransport {
  readonly path: string;

  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async send(event: TelemetryEvent): Promise<void> {
    this.pendingWrite = this.pendingWrite.then(async () => {
      await this.ensureInitialized();
      await appendFile(this.path, `${JSON.stringify(event)}\n`, "utf8");
    });

    await this.pendingWrite;
  }

  async close(): Promise<void> {
    await this.pendingWrite;
    await this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await mkdir(dirname(this.path), { recursive: true });
    this.initialized = true;
  }
}
