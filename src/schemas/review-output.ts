export type JsonSchema = {
  readonly $schema?: string;
  readonly $id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string | readonly string[];
  readonly enum?: readonly string[];
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly minimum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly maxLength?: number;
};

const findingLocationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    line: { type: "number", minimum: 1 },
    startLine: { type: "number", minimum: 1 },
    endLine: { type: "number", minimum: 1 },
    side: { type: "string", enum: ["LEFT", "RIGHT"] },
  },
  required: ["path"],
} as const satisfies JsonSchema;

export const findingOutputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ai-code-review-factory.local/schemas/finding-output.json",
  title: "Normalized review finding",
  type: "object",
  additionalProperties: false,
  properties: {
    reviewer: { type: "string" },
    severity: { type: "string", enum: ["critical", "warning", "suggestion"] },
    category: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    location: findingLocationSchema,
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    quotedCode: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    recommendation: { type: "string" },
  },
  required: [
    "reviewer",
    "severity",
    "category",
    "title",
    "body",
    "confidence",
    "evidence",
    "recommendation",
  ],
} as const satisfies JsonSchema;

export const reviewerOutputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ai-code-review-factory.local/schemas/reviewer-output.json",
  title: "Reviewer structured output",
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: findingOutputSchema,
    },
  },
  required: ["findings"],
} as const satisfies JsonSchema;

export const coordinatorOutputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://ai-code-review-factory.local/schemas/coordinator-output.json",
  title: "Coordinator structured output",
  type: "object",
  additionalProperties: false,
  properties: {
    decision: {
      type: "string",
      enum: [
        "approved",
        "approved_with_comments",
        "minor_issues",
        "significant_concerns",
        "review_failed",
      ],
    },
    outcome: { type: "string", enum: ["pass", "fail", "neutral", "skipped"] },
    title: { type: "string" },
    body: { type: "string" },
    findings: {
      type: "array",
      items: findingOutputSchema,
    },
  },
  required: ["decision", "outcome", "title", "body", "findings"],
} as const satisfies JsonSchema;

export const reviewOutputSchemas = {
  finding: findingOutputSchema,
  reviewer: reviewerOutputSchema,
  coordinator: coordinatorOutputSchema,
} as const;
