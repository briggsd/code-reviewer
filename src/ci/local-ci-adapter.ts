import type { CiAdapter, CiDecision, DetectedCiEnvironment, SafetyMode } from "../contracts/index.ts";

export interface LocalCiAdapterOptions {
  stdout?: Pick<typeof console, "log">;
  stderr?: Pick<typeof console, "error">;
}

export class LocalCiAdapter implements CiAdapter {
  readonly name = "local";

  private readonly stdout: Pick<typeof console, "log">;
  private readonly stderr: Pick<typeof console, "error">;

  constructor(options: LocalCiAdapterOptions = {}) {
    this.stdout = options.stdout ?? console;
    this.stderr = options.stderr ?? console;
  }

  detect(): DetectedCiEnvironment {
    return {
      provider: "local",
      raw: {},
    };
  }

  inferSafetyMode(_environment: DetectedCiEnvironment): SafetyMode {
    return "trusted";
  }

  async emitDecision(decision: CiDecision): Promise<void> {
    const message = `AI review CI decision: ${decision.outcome} (${decision.reason})`;
    if (decision.outcome === "fail") {
      this.stderr.error(message);
    } else {
      this.stdout.log(message);
    }
  }
}
