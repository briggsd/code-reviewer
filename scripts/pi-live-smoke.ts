#!/usr/bin/env bun

import { join } from "node:path";
import {
  FileSystemReviewStateStore,
  JsonlTraceSink,
  PiAgentRuntime,
  formatReviewSummaryMarkdown,
  loadReviewFixture,
  runReview,
} from "../src/index.ts";

const enabled = process.env.AI_REVIEW_LIVE_PI === "1";

if (!enabled) {
  console.log("Skipping Pi live smoke test.");
  console.log("Set AI_REVIEW_LIVE_PI=1 to run it against your configured Pi provider/model.");
  console.log("Optional: AI_REVIEW_PI_PROVIDER=<provider> AI_REVIEW_PI_MODEL=<model> AI_REVIEW_SMOKE_OUTPUT_DIR=<dir>");
  process.exit(0);
}

const provider = process.env.AI_REVIEW_PI_PROVIDER;
const model = process.env.AI_REVIEW_PI_MODEL;
if ((provider === undefined) !== (model === undefined)) {
  throw new Error("AI_REVIEW_PI_PROVIDER and AI_REVIEW_PI_MODEL must be provided together");
}

const now = new Date();
const runId = `pi-live-${now.toISOString().replaceAll(/[:.]/g, "-")}`;
const outputDirectory = process.env.AI_REVIEW_SMOKE_OUTPUT_DIR ?? ".ai-review-smoke";
const tracePath = join(outputDirectory, "runs", runId, "trace.jsonl");
const traceSink = new JsonlTraceSink(tracePath);
const stateStore = new FileSystemReviewStateStore(outputDirectory);
const fixture = await loadReviewFixture("examples/fixtures/auth-pr.json");
const runtime = new PiAgentRuntime({
  ...(provider !== undefined && model !== undefined
    ? { defaultModel: { provider, model } }
    : {}),
});

try {
  const result = await runReview({
    fixture: {
      ...fixture,
      runId,
      config: {
        ...fixture.config,
        reviewerPolicy: {
          ...fixture.config.reviewerPolicy,
          documentation: "disabled",
          performance: "disabled",
        },
      },
    },
    now,
    stateStore,
    traceSink,
    tracePath,
    runtime,
  });

  console.log(formatReviewSummaryMarkdown(result.summary));
  console.log("");
  console.log(`Pi live smoke completed. Artifacts: ${outputDirectory}/runs/${runId}`);
} finally {
  await traceSink.close();
}
