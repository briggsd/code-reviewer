import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ChangeRef,
  PriorFindingState,
  PriorReviewState,
  ReviewRunRecord,
  ReviewStateStore,
  ReviewSummary,
} from "../contracts/index.ts";

export class FileSystemReviewStateStore implements ReviewStateStore {
  readonly rootDirectory: string;

  private runRecords = new Map<string, ReviewRunRecord>();

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  async load(ref: ChangeRef): Promise<PriorReviewState | undefined> {
    const path = this.changeStatePath(ref);

    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as PriorReviewState;
    } catch (error) {
      if (isMissingFileError(error)) {
        return undefined;
      }

      throw error;
    }
  }

  async saveRun(record: ReviewRunRecord): Promise<void> {
    this.runRecords.set(record.runId, record);

    const path = this.runArtifactPath(record.runId, "run.json");
    await writeJsonFile(path, record);
  }

  async saveSummary(runId: string, summary: ReviewSummary): Promise<void> {
    await writeJsonFile(this.runArtifactPath(runId, "summary.json"), summary);

    const record = this.runRecords.get(runId);
    if (record === undefined) {
      return;
    }

    const priorState: PriorReviewState = {
      previousRunId: runId,
      previousHeadSha: record.context.metadata.headSha,
      findings: summary.findings.map((finding, index): PriorFindingState => ({
        stableId: finding.id ?? `${runId}:${index}`,
        finding,
        status: "open",
        lastSeenHeadSha: record.context.metadata.headSha,
      })),
      hiddenMetadata: {
        decision: summary.decision,
        outcome: summary.outcome,
        completedAt: record.completedAt ?? "",
      },
    };

    await writeJsonFile(this.changeStatePath(record.context.metadata), priorState);
  }

  runDirectory(runId: string): string {
    return join(this.rootDirectory, "runs", runId);
  }

  runArtifactPath(runId: string, filename: string): string {
    return join(this.runDirectory(runId), filename);
  }

  changeStatePath(ref: ChangeRef): string {
    return join(
      this.rootDirectory,
      "changes",
      ref.provider,
      encodeURIComponent(ref.repository.slug),
      encodeURIComponent(ref.changeId),
      "latest.json",
    );
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
