import type { JsonSchema } from "./review-output.ts";

const severitySchema = {
  type: "string",
  enum: ["critical", "warning", "suggestion"],
} as const satisfies JsonSchema;

const modelSelectionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    provider: { type: "string" },
    model: { type: "string" },
    tier: { type: "string", enum: ["top", "standard", "light"] },
    temperature: { type: "number" },
    maxOutputTokens: { type: "number", minimum: 1 },
  },
  required: ["provider", "model"],
} as const satisfies JsonSchema;

export const reviewConfigSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ai-code-review-factory.local/schemas/review-config.json",
  title: "AI code review project config",
  description: "JSON project config loaded from .ai-review.json, ai-review.json, or --config.",
  type: "object",
  additionalProperties: false,
  properties: {
    mode: {
      type: "string",
      enum: ["advisory", "blocking"],
    },
    failOn: {
      type: "array",
      items: severitySchema,
    },
    sensitivePaths: {
      type: "array",
      items: { type: "string" },
    },
    ignoredPaths: {
      type: "array",
      items: { type: "string" },
    },
    reviewerPolicy: {
      type: "object",
      additionalProperties: {
        type: "string",
        enum: ["enabled", "disabled", "full_only"],
      },
    },
    timeouts: {
      type: "object",
      additionalProperties: false,
      properties: {
        reviewerMs: { type: "number", minimum: 1 },
        coordinatorMs: { type: "number", minimum: 1 },
        overallMs: { type: "number", minimum: 1 },
      },
    },
    modelRouting: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: modelSelectionSchema,
        roles: {
          type: "object",
          additionalProperties: modelSelectionSchema,
        },
      },
    },
    projectInstructionsPath: { type: "string" },
    extra: {
      type: "object",
      additionalProperties: true,
    },
  },
} as const satisfies JsonSchema;
