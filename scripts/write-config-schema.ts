#!/usr/bin/env bun

import { writeFile } from "node:fs/promises";
import { reviewConfigSchema } from "../src/index.ts";

const outputPath = Bun.argv[2] ?? ".ai-review.schema.json";
await writeFile(outputPath, `${JSON.stringify(reviewConfigSchema, null, 2)}\n`);
console.log(`Wrote ${outputPath}`);
