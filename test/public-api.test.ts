import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DefineReviewerInput, ReviewerDefinition, Severity } from "../src/public.ts";
import { createReviewerDefinition, defineReviewer } from "../src/public.ts";

describe("public API surface (src/public.ts)", () => {
  test("createReviewerDefinition is an alias for defineReviewer (same function reference)", () => {
    expect(createReviewerDefinition).toBe(defineReviewer);
  });

  test("defineReviewer builds a valid ReviewerDefinition with a free-form role", () => {
    const input: DefineReviewerInput = {
      role: "accessibility",
      displayName: "Accessibility",
      version: "accessibility.v1",
      summary: "Review changed UI for accessibility regressions.",
      flag: ["Missing ARIA labels on interactive elements.", "Colour-contrast regressions."],
      doNotFlag: ["Style preferences unrelated to accessibility."],
      allowedSeverities: ["warning", "suggestion"],
      severityCalibration: [
        "warning: concrete accessibility regression blocking assistive-technology users.",
        "suggestion: improvement with clear benefit but not blocking.",
      ],
      outputExpectations: ["Name the WCAG criterion and the changed element that triggers it."],
    };

    const result: ReviewerDefinition = defineReviewer(input);

    expect(result.role).toBe("accessibility");
    expect(result.source).toBe("trusted_operator");
    expect(result.displayName).toBe("Accessibility");
    expect(result.version).toBe("accessibility.v1");
    expect(result.summary).toBe("Review changed UI for accessibility regressions.");
    expect(result.guidance.flag).toEqual(input.flag);
    expect(result.guidance.allowedSeverities).toEqual(["warning", "suggestion"]);

    // sharedMandatoryRules must be injected and contain the untrusted-data rule
    expect(result.guidance.sharedMandatoryRules.length).toBeGreaterThan(0);
    const hasUntrustedDataRule = result.guidance.sharedMandatoryRules.some((rule) =>
      rule.includes("untrusted data"),
    );
    expect(hasUntrustedDataRule).toBe(true);
  });

  test("defineReviewer trims role whitespace and preserves trimmed value", () => {
    const result = defineReviewer({
      role: "  my_custom_role  ",
      displayName: "Custom",
      version: "1.0",
      summary: "A custom reviewer.",
      flag: [],
      doNotFlag: [],
      allowedSeverities: ["warning"],
      severityCalibration: [],
      outputExpectations: [],
    });
    expect(result.role).toBe("my_custom_role");
  });

  test("defineReviewer throws for reserved role 'coordinator'", () => {
    expect(() =>
      defineReviewer({
        role: "coordinator",
        displayName: "Coordinator",
        version: "1.0",
        summary: "Should be rejected.",
        flag: [],
        doNotFlag: [],
        allowedSeverities: ["warning"],
        severityCalibration: [],
        outputExpectations: [],
      }),
    ).toThrow(/coordinator.*reserved/i);
  });

  test("defineReviewer throws for empty/whitespace role", () => {
    expect(() =>
      defineReviewer({
        role: "",
        displayName: "Empty",
        version: "1.0",
        summary: "Should be rejected.",
        flag: [],
        doNotFlag: [],
        allowedSeverities: ["warning"],
        severityCalibration: [],
        outputExpectations: [],
      }),
    ).toThrow(/role.*non-empty/i);

    expect(() =>
      defineReviewer({
        role: "   ",
        displayName: "Whitespace",
        version: "1.0",
        summary: "Should be rejected.",
        flag: [],
        doNotFlag: [],
        allowedSeverities: ["warning"],
        severityCalibration: [],
        outputExpectations: [],
      }),
    ).toThrow(/role.*non-empty/i);
  });

  test("defineReviewer throws for empty allowedSeverities", () => {
    expect(() =>
      defineReviewer({
        role: "test_role",
        displayName: "Test",
        version: "1.0",
        summary: "Should be rejected.",
        flag: [],
        doNotFlag: [],
        allowedSeverities: [],
        severityCalibration: [],
        outputExpectations: [],
      }),
    ).toThrow(/allowedSeverities.*non-empty/i);
  });

  test("defineReviewer throws for an invalid severity value", () => {
    expect(() =>
      defineReviewer({
        role: "test_role",
        displayName: "Test",
        version: "1.0",
        summary: "Should be rejected.",
        flag: [],
        doNotFlag: [],
        allowedSeverities: ["blocker"] as unknown as Severity[],
        severityCalibration: [],
        outputExpectations: [],
      }),
    ).toThrow(/invalid value.*blocker/i);
  });

  test("package.json exports['.'] points to a file that exists", async () => {
    interface PkgExports {
      exports?: Record<string, string>;
    }
    const manifest = JSON.parse(await readFile("package.json", "utf8")) as PkgExports;
    const target = manifest.exports?.["."] ?? "";
    expect(target).toBe("./src/public.ts");
    const resolved = join(import.meta.dir, "..", target);
    expect(existsSync(resolved)).toBe(true);
  });
});
