/**
 * Factory-owned Pi extension — `submit_findings` structured-output terminal tool (M015 S01, #124).
 *
 * Purpose: let a reviewer agent HAND BACK its findings through a schema-validated tool call
 * instead of emitting JSON-shaped prose that the adapter has to parse + repair. The validated
 * tool args surface in Pi's `--mode json` event stream as
 *   {"type":"tool_execution_start","toolName":"submit_findings","args":{...}}
 * which the spike harness (and, later, the production reader in S02/S03) reads directly — no
 * `repairUnescapedStringQuotes`, no `JSON.parse` of model prose on the happy path.
 *
 * Trust / fork-safety: this file is TRUSTED, factory-owned code. It is loaded ONLY via an
 * explicit `pi -e <this path>` while `--no-extensions` keeps reviewed-repo extension discovery
 * OFF (Pi's loader documents "explicit -e paths still work" under `--no-extensions`). It must
 * never be loaded from a reviewed repo. See docs/fork-safety.md.
 *
 * It is intentionally OUTSIDE `src/**` (and so outside `tsc --noEmit` / `bun run check`): it is
 * never imported by our TypeScript. Pi loads it with its own `jiti` loader, which aliases
 * `@earendil-works/pi-coding-agent` + `typebox` to Pi's bundled copies regardless of where this
 * file lives — so it does NOT need either as a dependency of this repo.
 *
 * The schema below MIRRORS `reviewerOutputSchema` in `src/schemas/review-output.ts`. The spike
 * keeps a hand-written TypeBox copy (Pi requires a TypeBox `TSchema` for `parameters`) and the
 * harness independently re-validates captured args against the canonical JSON Schema, so any
 * drift between the two surfaces is caught by the measurement, not hidden.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const findingSchema = Type.Object(
  {
    reviewer: Type.String({ description: "Reviewer role that produced this finding." }),
    severity: Type.Union(
      [Type.Literal("critical"), Type.Literal("warning"), Type.Literal("suggestion")],
      { description: "Finding severity." },
    ),
    category: Type.String({ description: "Short finding category, e.g. security, performance." }),
    title: Type.String({ description: "One-line finding title." }),
    body: Type.String({ description: "Full finding explanation." }),
    location: Type.Optional(
      Type.Object(
        {
          path: Type.String({ description: "Changed-file path the finding refers to." }),
          line: Type.Optional(Type.Integer({ minimum: 1 })),
          startLine: Type.Optional(Type.Integer({ minimum: 1 })),
          endLine: Type.Optional(Type.Integer({ minimum: 1 })),
          side: Type.Optional(Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")])),
        },
        { additionalProperties: false },
      ),
    ),
    confidence: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")], {
      description: "Honest confidence in the finding.",
    }),
    evidence: Type.Array(Type.String(), {
      minItems: 1,
      description: "Concrete evidence statements grounding the finding.",
    }),
    quotedCode: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
        description:
          "Exact changed line(s) copied verbatim from the diff. Omit for findings about absent code.",
      }),
    ),
    recommendation: Type.String({ description: "Concrete recommended fix." }),
  },
  { additionalProperties: false },
);

const submitFindingsParameters = Type.Object(
  {
    findings: Type.Array(findingSchema, {
      description: "All findings for this review. Use an empty array when the diff is clean.",
    }),
  },
  { additionalProperties: false },
);

const submitFindingsTool = defineTool({
  name: "submit_findings",
  label: "Submit Findings",
  description:
    "Return your final code-review findings as validated structured data. Call this exactly once, as your LAST action, to deliver the review. Pass an empty findings array if the diff has no issues.",
  promptSnippet:
    "Deliver your review by calling submit_findings as your final, terminating action.",
  promptGuidelines: [
    "When you have finished reviewing, call submit_findings exactly once to return your findings — this is how the review is delivered.",
    "submit_findings must be your FINAL action. Do not emit any assistant prose or JSON instead of, or in addition to, calling it.",
    "If the diff is clean, still call submit_findings with an empty findings array — do not answer in prose.",
  ],
  parameters: submitFindingsParameters,

  // `terminate: true` ends the agent turn on this tool call, so there is no extra LLM round-trip
  // and no trailing prose for the adapter to mis-parse. The returned `details` echo the validated
  // args; the spike reads them off the `tool_execution_start` event rather than from `execute`.
  async execute(_toolCallId, params) {
    const count = params.findings.length;
    return {
      content: [
        {
          type: "text" as const,
          text: `Recorded ${count} finding${count === 1 ? "" : "s"}.`,
        },
      ],
      details: params,
      terminate: true,
    };
  },
});

export default function (pi: ExtensionAPI): void {
  pi.registerTool(submitFindingsTool);
}
