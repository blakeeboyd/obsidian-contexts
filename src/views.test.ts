import { describe, expect, it } from "vitest";
import { LogEvent, SpanEvent } from "./recorder";
import { Stint, applyRenames, coalesceTrail, groupSessions, healRenames, isStint, mergeDeltas, relatedTo, trailFor } from "./views";

const MIN = 60_000;

function span(path: string, start: number, dur = 5 * MIN, ctime?: number): SpanEvent {
  const ev: SpanEvent = { t: start + dur, path, start, dur };
  if (ctime !== undefined) ev.ctime = ctime;
  return ev;
}

describe("applyRenames", () => {
  it("resolves a rename chain to the final name", () => {
    const events: LogEvent[] = [
      span("A.md", 0),
      { t: 10 * MIN, type: "rename", from: "A.md", to: "B.md" },
      span("B.md", 20 * MIN),
      { t: 30 * MIN, type: "rename", from: "B.md", to: "C.md" },
    ];
    const out = applyRenames(events).filter((e) => !("type" in e)) as SpanEvent[];
    expect(out.map((s) => s.path)).toEqual(["C.md", "C.md"]);
  });

  it("settles a rename-back cycle on the final name", () => {
    const events: LogEvent[] = [
      span("A.md", 0),
      { t: 10 * MIN, type: "rename", from: "A.md", to: "B.md" },
      { t: 11 * MIN, type: "rename", from: "B.md", to: "A.md" },
      span("A.md", 20 * MIN),
    ];
    const out = applyRenames(events).filter((e) => !("type" in e)) as SpanEvent[];
    expect(out.map((s) => s.path)).toEqual(["A.md", "A.md"]);
  });

  it("does not conflate a new file created at a renamed-away path", () => {
    const events: LogEvent[] = [
      span("A.md", 0),
      { t: 10 * MIN, type: "rename", from: "A.md", to: "B.md" },
      span("A.md", 20 * MIN), // a NEW file at the old path
    ];
    const out = applyRenames(events).filter((e) => !("type" in e)) as SpanEvent[];
    expect(out.map((s) => s.path)).toEqual(["B.md", "A.md"]);
  });

  it("frees a deleted path for a fresh identity", () => {
    const events: LogEvent[] = [
      span("A.md", 0),
      { t: 10 * MIN, type: "delete", path: "A.md" },
      span("A.md", 20 * MIN),
      { t: 30 * MIN, type: "rename", from: "A.md", to: "B.md" },
    ];
    const out = applyRenames(events).filter((e) => !("type" in e)) as SpanEvent[];
    // The deleted file keeps its name; only the successor follows the rename.
    expect(out.map((s) => s.path)).toEqual(["A.md", "B.md"]);
  });
});

describe("healRenames", () => {
  it("synthesizes a rename when spans move between paths sharing a ctime", () => {
    const events: LogEvent[] = [span("A.md", 0, 5 * MIN, 42), span("B.md", 20 * MIN, 5 * MIN, 42)];
    const out = applyRenames(healRenames(events)).filter((e) => !("type" in e)) as SpanEvent[];
    expect(out.map((s) => s.path)).toEqual(["B.md", "B.md"]);
  });

  it("drops the spurious delete logged for the old name", () => {
    const events: LogEvent[] = [
      span("A.md", 0, 5 * MIN, 42),
      { t: 10 * MIN, type: "delete", path: "A.md" },
      span("B.md", 20 * MIN, 5 * MIN, 42),
    ];
    const healed = healRenames(events);
    expect(healed.some((e) => "type" in e && e.type === "delete")).toBe(false);
    const out = applyRenames(healed).filter((e) => !("type" in e)) as SpanEvent[];
    expect(out.map((s) => s.path)).toEqual(["B.md", "B.md"]);
  });

  it("does not duplicate an explicitly logged rename", () => {
    const events: LogEvent[] = [
      span("A.md", 0, 5 * MIN, 42),
      { t: 10 * MIN, type: "rename", from: "A.md", to: "B.md" },
      span("B.md", 20 * MIN, 5 * MIN, 42),
    ];
    expect(healRenames(events)).toEqual(events);
  });

  it("leaves interleaved same-ctime spans alone", () => {
    const events: LogEvent[] = [
      span("A.md", 0, 5 * MIN, 42),
      span("B.md", 20 * MIN, 5 * MIN, 42),
      span("A.md", 40 * MIN, 5 * MIN, 42),
    ];
    expect(healRenames(events)).toEqual(events);
  });

  it("ignores spans with different or missing ctimes", () => {
    const events: LogEvent[] = [span("A.md", 0, 5 * MIN, 42), span("B.md", 20 * MIN, 5 * MIN, 43), span("C.md", 40 * MIN)];
    expect(healRenames(events)).toEqual(events);
  });

  it("heals a chain across three names", () => {
    const events: LogEvent[] = [
      span("A.md", 0, 5 * MIN, 42),
      span("B.md", 20 * MIN, 5 * MIN, 42),
      span("C.md", 40 * MIN, 5 * MIN, 42),
    ];
    const out = applyRenames(healRenames(events)).filter((e) => !("type" in e)) as SpanEvent[];
    expect(out.map((s) => s.path)).toEqual(["C.md", "C.md", "C.md"]);
  });
});

describe("groupSessions", () => {
  it("splits on gaps longer than the session gap", () => {
    const events = [span("A.md", 0), span("B.md", 6 * MIN), span("C.md", 60 * MIN)];
    const sessions = groupSessions(events, 30 * MIN);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].files).toEqual(["A.md", "B.md"]);
    expect(sessions[1].files).toEqual(["C.md"]);
  });

  it("keeps files unique and in first-touched order", () => {
    const events = [span("A.md", 0), span("B.md", 6 * MIN), span("A.md", 12 * MIN)];
    const sessions = groupSessions(events, 30 * MIN);
    expect(sessions[0].files).toEqual(["A.md", "B.md"]);
    expect(sessions[0].spans).toHaveLength(3);
  });

  it("handles empty and single-span logs", () => {
    expect(groupSessions([])).toEqual([]);
    expect(groupSessions([span("A.md", 0)])).toHaveLength(1);
  });
});

describe("relatedTo", () => {
  const DAY = 24 * 3600_000;
  it("ranks a recent companion above an old frequent one", () => {
    const now = 100 * DAY;
    // Old.md shared two sessions long ago; New.md shared one yesterday.
    const events = [
      span("Me.md", 0),
      span("Old.md", 6 * MIN),
      span("Me.md", 2 * DAY),
      span("Old.md", 2 * DAY + 6 * MIN),
      span("Me.md", 99 * DAY),
      span("New.md", 99 * DAY + 6 * MIN),
    ];
    const related = relatedTo("Me.md", groupSessions(events), now, 30 * DAY);
    expect(related[0].path).toBe("New.md");
    expect(related[1].path).toBe("Old.md");
    expect(related[1].sharedSessions).toBe(2);
  });

  it("excludes the file itself and never forgets entirely", () => {
    const now = 1000 * DAY;
    const events = [span("Me.md", 0), span("Other.md", 6 * MIN)];
    const related = relatedTo("Me.md", groupSessions(events), now, 30 * DAY);
    expect(related).toHaveLength(1);
    expect(related[0].path).toBe("Other.md");
    expect(related[0].score).toBeGreaterThan(0);
  });
});

describe("coalesceTrail", () => {
  it("merges adjacent spans into one stint with summed engaged time", () => {
    const trail = [span("A.md", 0, 2 * MIN), span("A.md", 5 * MIN, 3 * MIN), span("A.md", 10 * MIN, MIN)];
    const out = coalesceTrail(trail, 30 * MIN);
    expect(out).toHaveLength(1);
    const stint = out[0] as Stint;
    expect(stint.count).toBe(3);
    expect(stint.dur).toBe(6 * MIN); // engaged time, not the 11-minute wall-clock spread
    expect(stint.start).toBe(0);
    expect(stint.end).toBe(11 * MIN);
  });

  it("splits stints on gaps and keeps other events as their own rows", () => {
    const trail: LogEvent[] = [
      span("A.md", 0),
      { t: 10 * MIN, type: "extmod", path: "A.md" },
      span("A.md", 20 * MIN),
      span("A.md", 120 * MIN),
    ];
    const out = coalesceTrail(trail, 30 * MIN);
    expect(out.map((i) => (isStint(i) ? "stint" : i.type))).toEqual(["stint", "extmod", "stint", "stint"]);
  });

  it("merges edit deltas across a stint's spans", () => {
    const trail = [
      { ...span("A.md", 0), edit: { words: 10, linksAdded: ["X"] } },
      { ...span("A.md", 6 * MIN), edit: { words: -3, linksAdded: ["Y"], linksRemoved: ["X"] } },
    ];
    const stint = coalesceTrail(trail, 30 * MIN)[0] as Stint;
    expect(stint.edit).toEqual({ words: 7, linksAdded: ["Y"] }); // X added then removed nets out
  });
});

describe("mergeDeltas", () => {
  it("keeps first-before and last-after for frontmatter, dropping keys that net out", () => {
    const merged = mergeDeltas([
      { fmChanged: { status: ['"draft"', '"review"'], tier: [null, '"1"'] } },
      { fmChanged: { status: ['"review"', '"done"'], tier: ['"1"', null] } },
    ]);
    expect(merged).toEqual({ fmChanged: { status: ['"draft"', '"done"'] } });
  });

  it("returns undefined when everything cancels", () => {
    expect(mergeDeltas([{ words: 5 }, { words: -5 }])).toBeUndefined();
    expect(mergeDeltas([])).toBeUndefined();
  });
});

describe("trailFor", () => {
  it("returns a file's spans and deletion under its resolved name", () => {
    const events: LogEvent[] = [
      span("A.md", 0),
      { t: 10 * MIN, type: "rename", from: "A.md", to: "B.md" },
      span("B.md", 20 * MIN),
      span("Other.md", 26 * MIN),
    ];
    const trail = trailFor("B.md", applyRenames(events));
    expect(trail).toHaveLength(2);
  });
});
