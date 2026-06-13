import { describe, expect, test } from "bun:test";
import {
  breakGlassMatchesHead,
  GITHUB_TRUSTED_ASSOCIATIONS,
  GITLAB_MIN_TRUSTED_ACCESS_LEVEL,
  mapGitLabAccessLevel,
} from "../src/vcs/break-glass-marker.ts";

// Full head SHA used throughout; the marker may name any ≥12-char prefix of it.
const HEAD = "abc1234def5678901234567890abcdef12345678";

describe("breakGlassMatchesHead", () => {
  // --- Positive cases (marker names a matching commit prefix) ---

  test("'break glass <12-char prefix>' → true", () => {
    expect(breakGlassMatchesHead("break glass abc1234def56", HEAD)).toBe(true);
  });

  test("'break-glass <prefix>' (hyphen form) → true", () => {
    expect(breakGlassMatchesHead("break-glass abc1234def56", HEAD)).toBe(true);
  });

  test("full 40-char SHA → true", () => {
    expect(breakGlassMatchesHead(`break glass ${HEAD}`, HEAD)).toBe(true);
  });

  test("uppercase marker + uppercase SHA → true (case-insensitive)", () => {
    expect(breakGlassMatchesHead("BREAK GLASS ABC1234DEF56", HEAD)).toBe(true);
  });

  test("leading/trailing whitespace + collapsed internal whitespace → true", () => {
    expect(breakGlassMatchesHead("  break   glass   abc1234def56  ", HEAD)).toBe(true);
  });

  test("marker on first line, incident notes below → true (leading line only)", () => {
    expect(breakGlassMatchesHead("break glass abc1234def56\n\nProduction incident.", HEAD)).toBe(
      true,
    );
  });

  test("leading empty lines before the marker are skipped → true", () => {
    expect(breakGlassMatchesHead("\n\nbreak glass abc1234def56", HEAD)).toBe(true);
  });

  // --- Negative cases ---

  test("bare 'break glass' without a SHA → false", () => {
    expect(breakGlassMatchesHead("break glass", HEAD)).toBe(false);
  });

  test("SHA prefix that does NOT match the head → false", () => {
    expect(breakGlassMatchesHead("break glass deadbeefcafe", HEAD)).toBe(false);
  });

  test("commit prefix shorter than 12 chars → false (too weak)", () => {
    expect(breakGlassMatchesHead("break glass abc1234def5", HEAD)).toBe(false);
  });

  test("trailing content after the SHA → false (whole line must match)", () => {
    expect(breakGlassMatchesHead("break glass abc1234def56 please", HEAD)).toBe(false);
  });

  test("headSha 'unknown' → false (nothing to bind to)", () => {
    expect(breakGlassMatchesHead("break glass abc1234def56", "unknown")).toBe(false);
  });

  test("undefined/empty head → false", () => {
    expect(breakGlassMatchesHead("break glass abc1234def56", undefined)).toBe(false);
    expect(breakGlassMatchesHead("break glass abc1234def56", "")).toBe(false);
  });

  test("undefined / null / empty body → false", () => {
    expect(breakGlassMatchesHead(undefined, HEAD)).toBe(false);
    expect(breakGlassMatchesHead(null, HEAD)).toBe(false);
    expect(breakGlassMatchesHead("", HEAD)).toBe(false);
  });

  test("marker not on the first line → false", () => {
    expect(breakGlassMatchesHead("Approved.\nbreak glass abc1234def56", HEAD)).toBe(false);
  });

  test("'please break glass abc1234def56' → false (not the whole line)", () => {
    expect(breakGlassMatchesHead("please break glass abc1234def56", HEAD)).toBe(false);
  });

  test("bot footer mentioning break glass → false (first line is not the marker)", () => {
    const botBody = [
      "<!-- ai-code-review-factory",
      "{}",
      "-->",
      "",
      "break glass abc1234def56",
    ].join("\n");
    expect(breakGlassMatchesHead(botBody, HEAD)).toBe(false);
  });
});

describe("GITHUB_TRUSTED_ASSOCIATIONS", () => {
  test("OWNER is trusted", () => {
    expect(GITHUB_TRUSTED_ASSOCIATIONS.has("OWNER")).toBe(true);
  });

  test("MEMBER is trusted", () => {
    expect(GITHUB_TRUSTED_ASSOCIATIONS.has("MEMBER")).toBe(true);
  });

  test("COLLABORATOR is trusted", () => {
    expect(GITHUB_TRUSTED_ASSOCIATIONS.has("COLLABORATOR")).toBe(true);
  });

  test("CONTRIBUTOR is NOT trusted", () => {
    expect(GITHUB_TRUSTED_ASSOCIATIONS.has("CONTRIBUTOR")).toBe(false);
  });

  test("NONE is NOT trusted", () => {
    expect(GITHUB_TRUSTED_ASSOCIATIONS.has("NONE")).toBe(false);
  });
});

describe("GITLAB_MIN_TRUSTED_ACCESS_LEVEL", () => {
  test("threshold is 30 (Developer)", () => {
    expect(GITLAB_MIN_TRUSTED_ACCESS_LEVEL).toBe(30);
  });

  test("Developer (30) meets the threshold", () => {
    expect(30 >= GITLAB_MIN_TRUSTED_ACCESS_LEVEL).toBe(true);
  });

  test("Reporter (20) does not meet the threshold", () => {
    expect(20 >= GITLAB_MIN_TRUSTED_ACCESS_LEVEL).toBe(false);
  });

  test("Guest (10) does not meet the threshold", () => {
    expect(10 >= GITLAB_MIN_TRUSTED_ACCESS_LEVEL).toBe(false);
  });
});

describe("mapGitLabAccessLevel", () => {
  test("50 (Owner) → OWNER", () => {
    expect(mapGitLabAccessLevel(50)).toBe("OWNER");
  });

  test("56 (above Owner) → OWNER", () => {
    expect(mapGitLabAccessLevel(56)).toBe("OWNER");
  });

  test("40 (Maintainer) → MEMBER", () => {
    expect(mapGitLabAccessLevel(40)).toBe("MEMBER");
  });

  test("45 (between Maintainer and Owner) → MEMBER", () => {
    expect(mapGitLabAccessLevel(45)).toBe("MEMBER");
  });

  test("30 (Developer) → COLLABORATOR", () => {
    expect(mapGitLabAccessLevel(30)).toBe("COLLABORATOR");
  });

  test("35 (between Developer and Maintainer) → COLLABORATOR", () => {
    expect(mapGitLabAccessLevel(35)).toBe("COLLABORATOR");
  });
});
