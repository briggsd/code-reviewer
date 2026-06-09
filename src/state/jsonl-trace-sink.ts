import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RuntimeEvent, TraceSink } from "../contracts/index.ts";

export class JsonlTraceSink implements TraceSink {
  readonly path: string;

  private initialized = false;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async write(event: RuntimeEvent): Promise<void> {
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
