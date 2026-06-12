import { expect, test } from "bun:test";
import { assessThinReview } from "../src/runner/thin-review.ts";

// trivial tier → never thin regardless of tokens
test("assessThinReview: trivial tier is never thin (0 tokens, 5 files)", () => {
  const result = assessThinReview({ riskTier: "trivial", reviewedFileCount: 5, outputTokens: 0 });
  expect(result.thin).toBe(false);
  expect(result.expectedFloor).toBe(0);
  expect(result.outputTokens).toBe(0);
});

test("assessThinReview: trivial tier is never thin (undefined tokens)", () => {
  const result = assessThinReview({ riskTier: "trivial", reviewedFileCount: 3, outputTokens: undefined });
  expect(result.thin).toBe(false);
  expect(result.expectedFloor).toBe(0);
  expect(result.outputTokens).toBe(0);
});

// small clean lite (1 file, 150 tokens) → NOT thin (floor = 0 + 60*1 = 60)
test("assessThinReview: small lite diff (1 file, 150 tokens) is NOT thin", () => {
  const result = assessThinReview({ riskTier: "lite", reviewedFileCount: 1, outputTokens: 150 });
  expect(result.thin).toBe(false);
  expect(result.expectedFloor).toBe(60);
  expect(result.outputTokens).toBe(150);
});

// larger lite (6 files, 150 tokens) → thin (floor = 0 + 60*6 = 360)
test("assessThinReview: larger lite diff (6 files, 150 tokens) IS thin", () => {
  const result = assessThinReview({ riskTier: "lite", reviewedFileCount: 6, outputTokens: 150 });
  expect(result.thin).toBe(true);
  expect(result.expectedFloor).toBe(360);
  expect(result.outputTokens).toBe(150);
});

// full tier, near-empty (1 file, 150 tokens) → thin (floor = 300 + 60*1 = 360)
test("assessThinReview: full tier near-empty (1 file, 150 tokens) IS thin", () => {
  const result = assessThinReview({ riskTier: "full", reviewedFileCount: 1, outputTokens: 150 });
  expect(result.thin).toBe(true);
  expect(result.expectedFloor).toBe(360);
  expect(result.outputTokens).toBe(150);
});

// full tier, engaged (2 files, 2000 tokens) → NOT thin (floor = 300 + 60*2 = 420)
test("assessThinReview: full tier engaged (2 files, 2000 tokens) is NOT thin", () => {
  const result = assessThinReview({ riskTier: "full", reviewedFileCount: 2, outputTokens: 2000 });
  expect(result.thin).toBe(false);
  expect(result.expectedFloor).toBe(420);
  expect(result.outputTokens).toBe(2000);
});

// outputTokens: undefined → resolves to 0 → thin for non-trivial (floor > 0)
test("assessThinReview: undefined outputTokens resolves to 0 and is thin for non-trivial", () => {
  const result = assessThinReview({ riskTier: "full", reviewedFileCount: 1, outputTokens: undefined });
  expect(result.thin).toBe(true);
  expect(result.outputTokens).toBe(0);
  expect(result.expectedFloor).toBe(360);
});

test("assessThinReview: undefined outputTokens, lite tier with files → thin", () => {
  const result = assessThinReview({ riskTier: "lite", reviewedFileCount: 3, outputTokens: undefined });
  expect(result.thin).toBe(true);
  expect(result.outputTokens).toBe(0);
  expect(result.expectedFloor).toBe(180);
});

// flatFloor option: overrides contextual (lite 1 file 200 tokens, floor=250 → thin)
test("assessThinReview: flatFloor overrides contextual floor (lite 1 file, 200 tokens, flatFloor=250)", () => {
  const result = assessThinReview(
    { riskTier: "lite", reviewedFileCount: 1, outputTokens: 200 },
    { flatFloor: 250 },
  );
  expect(result.thin).toBe(true); // 200 < 250
  expect(result.expectedFloor).toBe(250);
});

// flatFloor: trivial still exempt even with flatFloor set
test("assessThinReview: flatFloor still exempts trivial tier", () => {
  const result = assessThinReview(
    { riskTier: "trivial", reviewedFileCount: 5, outputTokens: 10 },
    { flatFloor: 250 },
  );
  expect(result.thin).toBe(false);
  expect(result.expectedFloor).toBe(0);
});

// flatFloor: invalid (NaN/negative) override is ignored → falls through to contextual floor,
// so a bad override can't silently disable detection.
test("assessThinReview: NaN flatFloor is ignored and falls back to the contextual floor", () => {
  const result = assessThinReview(
    { riskTier: "full", reviewedFileCount: 1, outputTokens: 100 },
    { flatFloor: NaN },
  );
  expect(result.expectedFloor).toBe(360); // contextual: 300 + 60*1, NOT NaN
  expect(result.thin).toBe(true); // 100 < 360 (would be false if NaN floor leaked through)
});

test("assessThinReview: negative flatFloor is ignored and falls back to the contextual floor", () => {
  const result = assessThinReview(
    { riskTier: "lite", reviewedFileCount: 4, outputTokens: 100 },
    { flatFloor: -1 },
  );
  expect(result.expectedFloor).toBe(240); // contextual: 60*4
  expect(result.thin).toBe(true); // 100 < 240
});

// expectedFloor value spot-checks
test("assessThinReview: expectedFloor is correct for full tier 3 files", () => {
  const result = assessThinReview({ riskTier: "full", reviewedFileCount: 3, outputTokens: 5000 });
  expect(result.expectedFloor).toBe(480); // 300 + 60*3
  expect(result.thin).toBe(false);
});

test("assessThinReview: expectedFloor is correct for lite tier 4 files", () => {
  const result = assessThinReview({ riskTier: "lite", reviewedFileCount: 4, outputTokens: 100 });
  expect(result.expectedFloor).toBe(240); // 0 + 60*4
  expect(result.thin).toBe(true); // 100 < 240
});

// Guard: NaN fileCount → treated as 0
test("assessThinReview: NaN reviewedFileCount is clamped to 0", () => {
  const result = assessThinReview({ riskTier: "lite", reviewedFileCount: NaN, outputTokens: 50 });
  expect(result.expectedFloor).toBe(0); // 0 + 60*0
  expect(result.thin).toBe(false); // 50 >= 0
});

// Guard: negative fileCount → clamped to 0
test("assessThinReview: negative reviewedFileCount is clamped to 0", () => {
  const result = assessThinReview({ riskTier: "full", reviewedFileCount: -5, outputTokens: 100 });
  expect(result.expectedFloor).toBe(300); // 300 + 60*0
  expect(result.thin).toBe(true); // 100 < 300
});
