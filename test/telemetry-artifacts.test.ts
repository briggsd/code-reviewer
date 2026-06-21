import { describe, expect, test } from "bun:test";
import { filterTelemetryEvents, parseCommonTelemetryArgs } from "../scripts/telemetry-artifacts.ts";
import type { TelemetryEvent } from "../src/contracts/telemetry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
  defaultRunLimit: 20,
  defaultOutput: "out.json",
  usage: "Usage: test",
};

/**
 * Build a minimal TelemetryEvent for filter tests. Only the fields the filter
 * reads (`timestamp`, `data.repository`) need to be realistic.
 */
function makeEvent(timestamp: string, repository?: string): TelemetryEvent {
  const event: TelemetryEvent = { type: "ai_review.run_metrics", timestamp };
  if (repository !== undefined) {
    event.data = { repository };
  }
  return event;
}

// ---------------------------------------------------------------------------
// parseCommonTelemetryArgs — new flags
// ---------------------------------------------------------------------------

describe("parseCommonTelemetryArgs — new flags", () => {
  test("--since parses into options.since", () => {
    const { options, rest } = parseCommonTelemetryArgs(
      ["--since", "2026-06-15T00:00:00Z"],
      TEST_CONFIG,
    );
    expect(options.since).toBe("2026-06-15T00:00:00Z");
    expect(rest).toEqual([]);
  });

  test("--until parses into options.until", () => {
    const { options } = parseCommonTelemetryArgs(["--until", "2026-06-21"], TEST_CONFIG);
    expect(options.until).toBe("2026-06-21");
  });

  test("--since with garbage date throws a clear error", () => {
    expect(() => parseCommonTelemetryArgs(["--since", "not-a-date"], TEST_CONFIG)).toThrow(
      "--since requires an ISO date",
    );
  });

  test("--until with garbage date throws a clear error", () => {
    expect(() => parseCommonTelemetryArgs(["--until", "yesterday"], TEST_CONFIG)).toThrow(
      "--until requires an ISO date",
    );
  });

  test("--since missing value throws", () => {
    expect(() => parseCommonTelemetryArgs(["--since"], TEST_CONFIG)).toThrow(
      "--since requires an ISO date",
    );
  });

  test("single --repository parses into options.includeRepositories", () => {
    const { options } = parseCommonTelemetryArgs(["--repository", "org/repo"], TEST_CONFIG);
    expect(options.includeRepositories).toEqual(["org/repo"]);
    expect(options.excludeRepositories).toBeUndefined();
  });

  test("repeated --repository accumulates into array", () => {
    const { options } = parseCommonTelemetryArgs(
      ["--repository", "org/a", "--repository", "org/b"],
      TEST_CONFIG,
    );
    expect(options.includeRepositories).toEqual(["org/a", "org/b"]);
  });

  test("single --exclude-repository parses into options.excludeRepositories", () => {
    const { options } = parseCommonTelemetryArgs(
      ["--exclude-repository", "org/factory"],
      TEST_CONFIG,
    );
    expect(options.excludeRepositories).toEqual(["org/factory"]);
    expect(options.includeRepositories).toBeUndefined();
  });

  test("repeated --exclude-repository accumulates into array", () => {
    const { options } = parseCommonTelemetryArgs(
      ["--exclude-repository", "org/a", "--exclude-repository", "org/b"],
      TEST_CONFIG,
    );
    expect(options.excludeRepositories).toEqual(["org/a", "org/b"]);
  });

  test("--repository and --exclude-repository together throw mutual-exclusion error", () => {
    expect(() =>
      parseCommonTelemetryArgs(
        ["--repository", "org/a", "--exclude-repository", "org/b"],
        TEST_CONFIG,
      ),
    ).toThrow("--repository and --exclude-repository are mutually exclusive");
  });

  test("unrelated args (threshold overrides) flow back via rest", () => {
    const { options, rest } = parseCommonTelemetryArgs(
      ["--since", "2026-06-01", "--max-grounding-drop", "0.25"],
      TEST_CONFIG,
    );
    expect(options.since).toBe("2026-06-01");
    // --max-grounding-drop is a quality-report-specific flag; it must come back in rest
    expect(rest).toEqual(["--max-grounding-drop", "0.25"]);
  });

  test("--dataset and --runs mutual exclusion still works alongside new flags", () => {
    expect(() =>
      parseCommonTelemetryArgs(
        ["--dataset", "fleet.jsonl", "--runs", "10", "--since", "2026-01-01"],
        TEST_CONFIG,
      ),
    ).toThrow("--dataset and --runs are mutually exclusive");
  });
});

// ---------------------------------------------------------------------------
// filterTelemetryEvents — date-window filter
// ---------------------------------------------------------------------------

describe("filterTelemetryEvents — date window", () => {
  const earlyEvent = makeEvent("2026-06-01T00:00:00Z");
  const midEvent = makeEvent("2026-06-15T00:00:00Z");
  const lateEvent = makeEvent("2026-06-20T00:00:00Z");
  const events = [earlyEvent, midEvent, lateEvent];

  test("no filters: all events pass", () => {
    expect(filterTelemetryEvents(events, {})).toHaveLength(3);
  });

  test("--since is inclusive (event on boundary is kept)", () => {
    const result = filterTelemetryEvents(events, { since: "2026-06-15T00:00:00Z" });
    expect(result).toEqual([midEvent, lateEvent]);
  });

  test("--until is inclusive (event on boundary is kept)", () => {
    const result = filterTelemetryEvents(events, { until: "2026-06-15T00:00:00Z" });
    expect(result).toEqual([earlyEvent, midEvent]);
  });

  test("--since and --until together narrow to window", () => {
    const result = filterTelemetryEvents(events, {
      since: "2026-06-10T00:00:00Z",
      until: "2026-06-15T23:59:59Z",
    });
    expect(result).toEqual([midEvent]);
  });

  test("event with missing timestamp is dropped when since is set", () => {
    const undatedEvent: TelemetryEvent = { type: "other", timestamp: "not-a-date" };
    const result = filterTelemetryEvents([midEvent, undatedEvent], {
      since: "2026-06-01T00:00:00Z",
    });
    expect(result).toEqual([midEvent]);
  });

  test("event with missing timestamp is dropped when until is set", () => {
    const undatedEvent: TelemetryEvent = { type: "other", timestamp: "bad" };
    const result = filterTelemetryEvents([midEvent, undatedEvent], {
      until: "2026-12-31T00:00:00Z",
    });
    expect(result).toEqual([midEvent]);
  });

  test("event with missing timestamp is NOT dropped when no date filter is set", () => {
    const undatedEvent: TelemetryEvent = { type: "other", timestamp: "bad" };
    const result = filterTelemetryEvents([undatedEvent], {});
    expect(result).toEqual([undatedEvent]);
  });
});

// ---------------------------------------------------------------------------
// filterTelemetryEvents — repository filter
// ---------------------------------------------------------------------------

describe("filterTelemetryEvents — repository filter", () => {
  const eventA = makeEvent("2026-06-01T00:00:00Z", "org/a");
  const eventB = makeEvent("2026-06-01T00:00:00Z", "org/b");
  const eventNoRepo = makeEvent("2026-06-01T00:00:00Z");

  test("include-mode: keeps only matching repos", () => {
    const result = filterTelemetryEvents([eventA, eventB, eventNoRepo], {
      includeRepositories: ["org/a"],
    });
    expect(result).toEqual([eventA]);
  });

  test("include-mode: keeps multiple matching repos", () => {
    const result = filterTelemetryEvents([eventA, eventB, eventNoRepo], {
      includeRepositories: ["org/a", "org/b"],
    });
    expect(result).toEqual([eventA, eventB]);
  });

  test("include-mode: repo-less event is dropped", () => {
    const result = filterTelemetryEvents([eventNoRepo], { includeRepositories: ["org/a"] });
    expect(result).toEqual([]);
  });

  test("exclude-mode: drops matching repos", () => {
    const result = filterTelemetryEvents([eventA, eventB, eventNoRepo], {
      excludeRepositories: ["org/a"],
    });
    expect(result).toEqual([eventB, eventNoRepo]);
  });

  test("exclude-mode: repo-less event is retained", () => {
    const result = filterTelemetryEvents([eventNoRepo], { excludeRepositories: ["org/factory"] });
    expect(result).toEqual([eventNoRepo]);
  });

  test("exclude-mode: non-matching repo is retained", () => {
    const result = filterTelemetryEvents([eventA, eventB], {
      excludeRepositories: ["org/factory"],
    });
    expect(result).toEqual([eventA, eventB]);
  });
});

// ---------------------------------------------------------------------------
// filterTelemetryEvents — filters compose (AND)
// ---------------------------------------------------------------------------

describe("filterTelemetryEvents — filters compose", () => {
  const inWindowMatchRepo = makeEvent("2026-06-15T12:00:00Z", "org/adopter");
  const inWindowWrongRepo = makeEvent("2026-06-15T12:00:00Z", "org/factory");
  const outWindowMatchRepo = makeEvent("2026-05-01T00:00:00Z", "org/adopter");

  const events = [inWindowMatchRepo, inWindowWrongRepo, outWindowMatchRepo];

  test("since + exclude-repository: keeps only events in window AND not excluded", () => {
    const result = filterTelemetryEvents(events, {
      since: "2026-06-01T00:00:00Z",
      excludeRepositories: ["org/factory"],
    });
    expect(result).toEqual([inWindowMatchRepo]);
  });

  test("since + include-repository: keeps only events in window AND matching repo", () => {
    const result = filterTelemetryEvents(events, {
      since: "2026-06-01T00:00:00Z",
      includeRepositories: ["org/adopter"],
    });
    expect(result).toEqual([inWindowMatchRepo]);
  });
});
