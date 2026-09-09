import { describe, expect, it } from "vitest";
import { LogEvent, SpanEvent } from "./recorder";
import {
  MIN_RELATED_SCORE,
  Stint,
  allRelationships,
  applyRenames,
  assignContexts,
  coalesceTrail,
  contextFileSets,
  contextNames,
  currentContext,
  excludeFolders,
  fileContexts,
  fileInterest,
  groupSessions,
  derivedLabel,
  guessContext,
  healRenames,
  knownLinks,
  peekEvents,
  topFiles,
  isStint,
  mergeDeltas,
  pairKey,
  relatedTo,
  trailFor,
  unrelatedPairs,
} from "./views";

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

describe("applyRenames with firstseen", () => {
  it("keeps a firstseen baseline attached through a rename", () => {
    const counts = { words: 5, links: 1, tags: 0, headings: 0, highlights: 0, footnotes: 0, tasksOpen: 0, tasksDone: 0 };
    const events: LogEvent[] = [
      { t: 0, type: "firstseen", path: "A.md", counts },
      span("A.md", MIN),
      { t: 10 * MIN, type: "rename", from: "A.md", to: "B.md" },
    ];
    const out = applyRenames(events);
    expect(out[0]).toMatchObject({ type: "firstseen", path: "B.md" });
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

  it("grades temporal adjacency: a direct switch far outscores same-session distance", () => {
    // Adjacent.md right after Me.md; Distant.md 25 minutes later in the same session.
    const events = [span("Me.md", 0), span("Adjacent.md", 6 * MIN), span("Distant.md", 30 * MIN)];
    const related = relatedTo("Me.md", groupSessions(events, 60 * MIN), 40 * MIN);
    const adjacent = related.find((r) => r.path === "Adjacent.md")!;
    const distant = related.find((r) => r.path === "Distant.md")!;
    expect(adjacent.score).toBeGreaterThan(MIN_RELATED_SCORE);
    expect(distant.score).toBeLessThan(MIN_RELATED_SCORE); // falls under the display floor
    expect(adjacent.score).toBeGreaterThan(distant.score * 5);
  });

  it("a followed link outranks any incidental co-presence", () => {
    const clicked: SpanEvent = { ...span("Target.md", 12 * MIN), from: "Me.md" };
    const events = [span("Me.md", 0), span("Bystander.md", 6 * MIN), clicked];
    const related = relatedTo("Me.md", groupSessions(events, 60 * MIN), 20 * MIN);
    expect(related[0].path).toBe("Target.md");
    expect(related[0].score).toBeGreaterThan(related.find((r) => r.path === "Bystander.md")!.score);
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

  it("merges edit deltas keeping gross activity, not net effect", () => {
    const trail = [
      { ...span("A.md", 0), edit: { words: 10, linksAdded: ["X"] } },
      { ...span("A.md", 6 * MIN), edit: { words: -3, linksAdded: ["Y"], linksRemoved: ["X"] } },
    ];
    const stint = coalesceTrail(trail, 30 * MIN)[0] as Stint;
    // X shows on both sides (added AND removed); words split by direction.
    expect(stint.edit).toEqual({
      wordsAdded: 10,
      wordsRemoved: 3,
      linksAdded: ["X", "Y"],
      linksRemoved: ["X"],
    });
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

  it("shows word movement in both directions even when the net is zero", () => {
    expect(mergeDeltas([{ words: 5 }, { words: -5 }])).toEqual({ wordsAdded: 5, wordsRemoved: 5 });
    expect(mergeDeltas([])).toBeUndefined();
  });
});

describe("declared contexts", () => {
  it("tracks the current context and clears on empty", () => {
    const events: LogEvent[] = [
      { t: 1, type: "context", name: "degree-design" },
      { t: 2, type: "context", name: "teaching" },
    ];
    expect(currentContext(events)).toBe("teaching");
    expect(currentContext([...events, { t: 3, type: "context", name: "" }])).toBeNull();
    expect(contextNames(events)).toEqual(["teaching", "degree-design"]);
  });

  it("assigns spans to the context declared at their start", () => {
    const events: LogEvent[] = [
      span("Before.md", 0),
      { t: 10 * MIN, type: "context", name: "alpha" },
      span("During.md", 20 * MIN),
      { t: 30 * MIN, type: "context", name: "" },
      span("After.md", 40 * MIN),
    ];
    const assigned = assignContexts(events);
    expect(assigned.get(events[0] as SpanEvent)).toBeUndefined();
    expect(assigned.get(events[2] as SpanEvent)).toBe("alpha");
    expect(assigned.get(events[4] as SpanEvent)).toBeUndefined();
  });

  it("passes context events through renames and folder exclusion untouched", () => {
    const events: LogEvent[] = [
      { t: 1, type: "context", name: "alpha" },
      span("A.md", 2),
      { t: 10 * MIN, type: "rename", from: "A.md", to: "B.md" },
    ];
    const out = excludeFolders(applyRenames(events), ["secret"]);
    expect(out[0]).toMatchObject({ type: "context", name: "alpha" });
  });
});

describe("fileContexts", () => {
  it("lists every thread a file was visited under, weighted by engaged time", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      span("Bridge.md", MIN),
      { t: 20 * MIN, type: "context", name: "beta" },
      span("Bridge.md", 30 * MIN),
      span("Bridge.md", 40 * MIN),
    ];
    const threads = fileContexts(events, "Bridge.md");
    expect(threads.map((th) => th.name)).toEqual(["beta", "alpha"]); // beta has more engaged time
    expect(threads).toHaveLength(2);
  });
});

describe("guessContext", () => {
  it("recognizes a return to a known context and stays quiet otherwise", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      span("A.md", MIN),
      span("B.md", 10 * MIN),
      { t: 20 * MIN, type: "context", name: "" },
      // later: back in alpha's files with no declaration
      span("A.md", 100 * MIN),
      span("B.md", 110 * MIN),
    ];
    expect(guessContext(events, 120 * MIN)?.name).toBe("alpha");
    // Working in unknown files: nothing to recognize.
    const foreign = ["V.md", "W.md", "X.md", "Y.md", "Z.md"].map((p, i) => span(p, (130 + i * 10) * MIN));
    expect(guessContext([...events, ...foreign], 200 * MIN)).toBeNull();
  });

  it("never suggests the context already declared", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      span("A.md", MIN),
      span("B.md", 10 * MIN),
    ];
    expect(guessContext(events, 20 * MIN)).toBeNull();
  });
});

describe("peeks", () => {
  it("scores a peeked pair below a traversal, from either side", () => {
    const peek: LogEvent = { t: 10 * MIN, type: "peek", path: "Target.md", from: "Source.md" };
    const clicked: SpanEvent = { ...span("Clicked.md", 20 * MIN), from: "Source.md" };
    const events: LogEvent[] = [span("Source.md", 0), peek, clicked];
    const sessions = groupSessions(events);
    const related = relatedTo("Source.md", sessions, 30 * MIN, undefined, undefined, undefined, peekEvents(events));
    const peeked = related.find((r) => r.path === "Target.md")!;
    const traversed = related.find((r) => r.path === "Clicked.md")!;
    expect(peeked.score).toBeGreaterThan(0);
    expect(traversed.score).toBeGreaterThan(peeked.score);
    // And the audit view agrees.
    const pairs = allRelationships(sessions, 30 * MIN, undefined, undefined, undefined, peekEvents(events));
    expect(pairs.some((p) => p.a === "Source.md" && p.b === "Target.md" && p.score > 0)).toBe(true);
  });

  it("is dropped from relations when either side is excluded, and rename-resolves its path", () => {
    const events: LogEvent[] = [
      { t: 0, type: "peek", path: "Target.md", from: "secret/Diary.md" },
      { t: MIN, type: "peek", path: "Old.md", from: "Source.md" },
      { t: 2 * MIN, type: "rename", from: "Old.md", to: "New.md" },
    ];
    expect(peekEvents(excludeFolders(events, ["secret"])).map((p) => p.path)).toEqual(["Old.md"]);
    expect(peekEvents(applyRenames(events)).map((p) => p.path)).toEqual(["Target.md", "New.md"]);
  });
});

describe("derivedLabel", () => {
  it("names a context by its most-engaged files and drifts as engagement shifts", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "context 1" },
      span("notes/Minor.md", MIN, 2 * MIN),
      span("plans/Big Plan.md", 10 * MIN, 20 * MIN),
      span("notes/Also Big.md", 40 * MIN, 15 * MIN),
    ];
    const set = contextFileSets(events).get("context 1")!;
    expect(derivedLabel(set)).toBe("Big Plan + Also Big");
    expect(topFiles(set)).toEqual(["plans/Big Plan.md", "notes/Also Big.md", "notes/Minor.md"]);
    // More engagement in another file reorders the label: the name is derived, never frozen.
    const more = [...events, span("notes/Minor.md", 70 * MIN, 40 * MIN)];
    expect(derivedLabel(contextFileSets(more).get("context 1")!)).toBe("Minor + Big Plan");
  });
});

describe("knownLinks", () => {
  it("replays baseline plus adds and removes from spans and extmods", () => {
    const events: LogEvent[] = [
      { t: 0, type: "firstseen", path: "A.md", counts: { words: 0, links: 1, tags: 0, headings: 0, highlights: 0, footnotes: 0, tasksOpen: 0, tasksDone: 0 }, links: ["Base"], tags: [] },
      { ...span("A.md", MIN), edit: { linksAdded: ["FromSpan"], linksRemoved: ["Base"] } },
      { t: 20 * MIN, type: "extmod", path: "A.md", edit: { linksAdded: ["FromAI"] } },
      { ...span("B.md", 30 * MIN), edit: { linksAdded: ["OtherFile"] } },
    ];
    expect([...knownLinks(events, "A.md")].sort()).toEqual(["FromAI", "FromSpan"]);
  });

  it("starts empty for a created file and resets on re-create", () => {
    const events: LogEvent[] = [
      { t: 0, type: "create", path: "A.md" },
      { ...span("A.md", MIN), edit: { linksAdded: ["X"] } },
      { t: 20 * MIN, type: "delete", path: "A.md" },
      { t: 30 * MIN, type: "create", path: "A.md" },
    ];
    expect(knownLinks(events, "A.md").size).toBe(0);
  });
});

describe("relabeledDecls", () => {
  it("rewrites declarations to the final label everywhere", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "context 1" },
      span("A.md", MIN),
      { t: 20 * MIN, type: "relabel", from: "context 1", to: "grant" },
      { t: 30 * MIN, type: "context", name: "grant" },
      span("B.md", 31 * MIN),
    ];
    expect(currentContext(events)).toBe("grant");
    expect(contextNames(events)).toEqual(["grant"]);
    const sets = contextFileSets(events);
    expect(sets.size).toBe(1);
    expect([...sets.get("grant")!.files]).toEqual(["A.md", "B.md"]);
  });

  it("collapses a relabel chain", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "context 1" },
      span("A.md", MIN),
      { t: 10 * MIN, type: "relabel", from: "context 1", to: "draft" },
      { t: 20 * MIN, type: "relabel", from: "draft", to: "final" },
    ];
    expect(currentContext(events)).toBe("final");
    expect(fileContexts(events, "A.md")[0].name).toBe("final");
  });

  it("treats a relabeled-away name declared later as a fresh context", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "context 1" },
      span("Old.md", MIN),
      { t: 10 * MIN, type: "relabel", from: "context 1", to: "grant" },
      { t: 20 * MIN, type: "context", name: "context 1" },
      span("New.md", 21 * MIN),
    ];
    const sets = contextFileSets(events);
    expect([...sets.get("grant")!.files]).toEqual(["Old.md"]);
    expect([...sets.get("context 1")!.files]).toEqual(["New.md"]);
  });

  it("merges when relabeling onto an existing name", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "grant" },
      span("A.md", MIN),
      { t: 10 * MIN, type: "context", name: "context 2" },
      span("B.md", 11 * MIN),
      { t: 20 * MIN, type: "relabel", from: "context 2", to: "grant" },
    ];
    const sets = contextFileSets(events);
    expect(sets.size).toBe(1);
    expect([...sets.get("grant")!.files].sort()).toEqual(["A.md", "B.md"]);
  });

  it("ignores a relabel of a name never declared", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      { t: MIN, type: "relabel", from: "ghost", to: "beta" },
    ];
    expect(currentContext(events)).toBe("alpha");
    expect(contextNames(events)).toEqual(["alpha"]);
  });
});

describe("evict", () => {
  it("removes the file from the context everywhere, past and future spans alike", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      span("Keeper.md", MIN),
      span("Test.md", 10 * MIN),
      { t: 20 * MIN, type: "evict", name: "alpha", path: "Test.md" },
      span("Test.md", 30 * MIN), // revisit after eviction: still out
    ];
    const sets = contextFileSets(events);
    expect([...sets.get("alpha")!.files]).toEqual(["Keeper.md"]);
    expect(fileContexts(events, "Test.md")).toEqual([]);
    expect(fileContexts(events, "Keeper.md")[0].name).toBe("alpha");
  });

  it("follows relabels: eviction from the old name holds under the new one", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "context 1" },
      span("Test.md", MIN),
      { t: 10 * MIN, type: "evict", name: "context 1", path: "Test.md" },
      { t: 20 * MIN, type: "relabel", from: "context 1", to: "grant" },
    ];
    expect(contextFileSets(events).get("grant")).toBeUndefined();
    expect(fileContexts(events, "Test.md")).toEqual([]);
  });

  it("ignores an eviction naming an unknown context", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      span("A.md", MIN),
      { t: 10 * MIN, type: "evict", name: "ghost", path: "A.md" },
    ];
    expect([...contextFileSets(events).get("alpha")!.files]).toEqual(["A.md"]);
  });
});

describe("shared declared context in scoring", () => {
  it("boosts pairs the user assigned to the same context", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      span("Me.md", MIN),
      span("Partner.md", 90 * MIN), // far apart in time: adjacency alone is weak
      span("Bystander.md", 95 * MIN),
      { t: 200 * MIN, type: "context", name: "" },
    ];
    const sessions = groupSessions(events, 300 * MIN);
    const ctx = contextFileSets(events);
    const related = relatedTo("Me.md", sessions, 210 * MIN, undefined, undefined, ctx);
    const partner = related.find((r) => r.path === "Partner.md")!;
    const bystander = related.find((r) => r.path === "Bystander.md")!;
    // Both got the context bonus (all three share "alpha"), so both clear the floor;
    // the point is the bonus lifts far-apart-in-time companions the user grouped.
    expect(partner.score).toBeGreaterThan(MIN_RELATED_SCORE);
    expect(bystander.score).toBeGreaterThan(MIN_RELATED_SCORE);
  });

  it("applies the same bonus in allRelationships so the audit view agrees", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "alpha" },
      span("Me.md", MIN),
      span("Partner.md", 90 * MIN),
      { t: 200 * MIN, type: "context", name: "" },
    ];
    const sessions = groupSessions(events, 300 * MIN);
    const ctx = contextFileSets(events);
    const without = allRelationships(sessions, 210 * MIN)[0];
    const withCtx = allRelationships(sessions, 210 * MIN, undefined, undefined, ctx)[0];
    expect(withCtx.score).toBeGreaterThan(without.score);
  });
});

describe("fileInterest", () => {
  it("ranks by recency-decayed visits with edits boosted", () => {
    const HOUR = 3600_000;
    const events: LogEvent[] = [
      span("Old.md", 0),
      span("Read.md", 40 * HOUR),
      { ...span("Edited.md", 40 * HOUR + 10 * MIN), edit: { words: 5 } },
    ];
    const doi = fileInterest(events, 41 * HOUR, 30 * 24 * HOUR);
    expect(doi.get("Edited.md")!).toBeGreaterThan(doi.get("Read.md")!);
    expect(doi.get("Read.md")!).toBeGreaterThan(doi.get("Old.md")! * 0.9);
  });
});

describe("excludeFolders", () => {
  it("drops events for excluded files, strips them as traversal sources, keeps the rest", () => {
    const linked: SpanEvent = { ...span("Keep.md", 20 * MIN), from: "secret/Diary.md" };
    const events: LogEvent[] = [
      span("Keep.md", 0),
      span("secret/Diary.md", 6 * MIN),
      { t: 12 * MIN, type: "extmod", path: "secret/Diary.md" },
      linked,
      { t: 30 * MIN, type: "unrelate", a: "Keep.md", b: "secret/Diary.md" },
    ];
    const out = excludeFolders(events, ["secret"]);
    expect(out).toHaveLength(2);
    expect(out.every((ev) => "path" in ev && ev.path === "Keep.md")).toBe(true);
    expect((out[1] as SpanEvent).from).toBeUndefined(); // mention stripped, span kept
  });

  it("returns events untouched with no excluded folders", () => {
    const events = [span("A.md", 0)];
    expect(excludeFolders(events, [])).toBe(events);
  });
});

describe("relatedness feedback", () => {
  it("keeps the latest unrelate/relate verdict per pair", () => {
    const events: LogEvent[] = [
      { t: 1, type: "unrelate", a: "A.md", b: "B.md" },
      { t: 2, type: "unrelate", a: "A.md", b: "C.md" },
      { t: 3, type: "relate", a: "A.md", b: "B.md" },
    ];
    const set = unrelatedPairs(events);
    expect(set.has(pairKey("A.md", "C.md"))).toBe(true);
    expect(set.has(pairKey("B.md", "A.md"))).toBe(false);
  });

  it("demotes a dismissed pair far below an undismissed one", () => {
    const events = [span("Me.md", 0), span("Buddy.md", 6 * MIN), span("Noise.md", 12 * MIN)];
    const dismissed = new Map([[pairKey("Me.md", "Noise.md"), 15 * MIN]]);
    const related = relatedTo("Me.md", groupSessions(events), 20 * MIN, undefined, dismissed);
    expect(related[0].path).toBe("Buddy.md");
    expect(related[1].path).toBe("Noise.md");
    expect(related[1].dismissed).toBe(true);
    expect(related[1].score).toBeLessThan(related[0].score * 0.1);
  });

  it("ranks all pairs globally with dismissed ones demoted but present", () => {
    const events = [span("A.md", 0), span("B.md", 6 * MIN), span("C.md", 12 * MIN)];
    const dismissed = new Map([[pairKey("A.md", "C.md"), 18 * MIN]]);
    const pairs = allRelationships(groupSessions(events), 20 * MIN, undefined, dismissed);
    expect(pairs).toHaveLength(3); // AB, AC, BC
    const ac = pairs.find((p) => p.dismissed);
    expect(ac?.a).toBe("A.md");
    expect(ac?.b).toBe("C.md");
    expect(ac?.score).toBeCloseTo(ac!.rawScore * 0.05);
    expect(pairs[pairs.length - 1]).toBe(ac); // demotion sinks it to the bottom
  });

  it("follows renames on both sides of the pair", () => {
    const events: LogEvent[] = [
      { t: 1, type: "unrelate", a: "A.md", b: "B.md" },
      { t: 2, type: "rename", from: "A.md", to: "A2.md" },
      { t: 3, type: "rename", from: "B.md", to: "B2.md" },
    ];
    const set = unrelatedPairs(applyRenames(events));
    expect(set.has(pairKey("A2.md", "B2.md"))).toBe(true);
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
