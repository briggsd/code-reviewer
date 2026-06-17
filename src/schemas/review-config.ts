import { THINKING_LEVELS } from "../contracts/common.ts";
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
    thinking: { type: "string", enum: THINKING_LEVELS },
  },
  required: ["provider", "model"],
} as const satisfies JsonSchema;

export const reviewConfigSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://code-reviewer.local/schemas/review-config.json",
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
    generatedFileMarkers: {
      type: "array",
      maxItems: 50,
      items: { type: "string", maxLength: 500 },
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
        byTier: {
          type: "object",
          additionalProperties: false,
          properties: {
            trivial: {
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
            lite: {
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
            full: {
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
          },
        },
      },
    },
    conventions: {
      type: "array",
      maxItems: 50,
      items: { type: "string", maxLength: 500 },
    },
    compliancePolicy: {
      type: "array",
      maxItems: 50,
      items: { type: "string", maxLength: 500 },
    },
    acknowledgements: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", maxLength: 500 },
          category: { type: "string", maxLength: 200 },
          stableFindingId: { type: "string", maxLength: 100 },
          mode: { type: "string", enum: ["acknowledge", "suppress"] },
          verdict: { type: "string", enum: ["dismissed", "acknowledged"] },
          reason: { type: "string", maxLength: 500 },
          expires: { type: "string", maxLength: 200 },
        },
        required: ["path", "mode", "reason"],
      },
    },
    patchBudgets: {
      type: "object",
      additionalProperties: false,
      properties: {
        trivial: { type: "number", minimum: 1 },
        lite: { type: "number", minimum: 1 },
        full: { type: "number", minimum: 1 },
      },
    },
    extra: {
      type: "object",
      additionalProperties: true,
    },
  },
} as const satisfies JsonSchema;
