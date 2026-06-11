import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { reviewConfigSchema } from "../src/index.ts";

describe("config schema artifact", () => {
  // The checked-in .ai-review.schema.json is generated from reviewConfigSchema (which in turn
  // single-sources its `thinking` enum from THINKING_LEVELS). This gate keeps the committed
  // artifact from drifting — adding/removing a level without regenerating fails here, so the
  // shipped schema, the runtime validator, and the TS type can never disagree (#45 re-review).
  test(".ai-review.schema.json is up to date (run `bun run schema:config` if this fails)", async () => {
    const committed = await readFile(".ai-review.schema.json", "utf8");
    expect(committed).toBe(`${JSON.stringify(reviewConfigSchema, null, 2)}\n`);
  });
});
