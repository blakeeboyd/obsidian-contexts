import { describe, expect, it } from "vitest";
import { LogEvent, SpanEvent } from "./recorder";
import { Rope, Session, applyRenames, assignContexts, buildTimeScale, contextRuns, groupSessions, invertX, scaleX, seamClaims } from "./views";

const MIN = 60_000;

function span(path: string, start: number, dur = 5 * MIN): SpanEvent {
  return { t: start + dur, path, start, dur };
}

function sess(spans: SpanEvent[]): Session {
  return {
    start: spans[0].start,
    end: spans[spans.length - 1].t,
    spans,
    files: [...new Set(spans.map((s) => s.path))],
  };
}

describe("time scale", () => {
  it("compresses inter-session gaps and round-trips x ↔ t inside a session", () => {
    const s1 = sess([span("A.md", 0), span("B.md", 10 * MIN)]);
    const s2 = sess([span("C.md", 500 * MIN)]);
    const ts = buildTimeScale([s1, s2], 2, 30);
    // Session 2 starts a fixed gap after session 1's 15-minute extent, not 500 minutes later.
    expect(ts.segs[1].x0 - ts.segs[0].x0).toBe(15 * 2 + 30);
    const t = 7 * MIN;
    expect(invertX(ts, scaleX(ts, t, 2), 2)).toBeCloseTo(t);
  });

  it("snaps gap positions to the closer session boundary", () => {
    const s1 = sess([span("A.md", 0)]);
    const s2 = sess([span("B.md", 500 * MIN)]);
    const ts = buildTimeScale([s1, s2], 2, 30);
    const endX1 = scaleX(ts, s1.end, 2);
    expect(invertX(ts, endX1 + 2, 2)).toBe(s1.end);
    expect(invertX(ts, ts.segs[1].x0 - 2, 2)).toBe(s2.start);
  });
});

describe("contextRuns", () => {
  it("groups consecutive same-context spans and never crosses sessions", () => {
    const a1 = span("A.md", 0);
    const a2 = span("B.md", 10 * MIN);
    const b1 = span("C.md", 20 * MIN);
    const next = span("A.md", 500 * MIN);
    const ctxOf = new Map<SpanEvent, string>([
      [a1, "one"],
      [a2, "one"],
      [b1, "two"],
      [next, "one"],
    ]);
    const runs = contextRuns([sess([a1, a2, b1]), sess([next])], ctxOf);
    expect(runs.map((r) => [r.ctx, r.spans.length, r.si])).toEqual([
      ["one", 2, 0],
      ["two", 1, 0],
      ["one", 1, 1],
    ]);
  });
});

describe("seamClaims", () => {
  const a1 = span("A.md", 0);
  const a2 = span("B.md", 10 * MIN);
  const b1 = span("C.md", 20 * MIN);
  const b2 = span("D.md", 30 * MIN);
  const ropeA: Rope = { ctx: "one", si: 0, spans: [a1, a2], start: a1.start, end: a2.t };
  const ropeB: Rope = { ctx: "two", si: 0, spans: [b1, b2], start: b1.start, end: b2.t };

  it("drag left: the tail of a joins b, and assignment honors it end to end", () => {
    const claims = seamClaims(ropeA, ropeB, 8 * MIN);
    expect(claims).toEqual([{ name: "two", covers: a2.t }]);
    // Round-trip through assignContexts, the way retroDeclare writes it.
    const events = [
      { t: 1, type: "context" as const, name: "one" },
      a1,
      a2,
      { t: b1.start, type: "context" as const, name: "two" },
      b1,
      b2,
      ...claims.map((c) => ({ t: 100 * MIN, type: "context" as const, name: c.name, covers: c.covers })),
    ];
    const ctxOf = assignContexts(events);
    expect(ctxOf.get(a1)).toBe("one");
    expect(ctxOf.get(a2)).toBe("two");
    expect(ctxOf.get(b1)).toBe("two");
  });

  it("drag right: the head of b joins a, b re-claims its kept tail", () => {
    const claims = seamClaims(ropeA, ropeB, 26 * MIN);
    expect(claims).toEqual([
      { name: "one", covers: b1.t },
      { name: "two", covers: b2.t },
    ]);
    const events = [
      { t: 1, type: "context" as const, name: "one" },
      a1,
      a2,
      { t: b1.start, type: "context" as const, name: "two" },
      b1,
      b2,
      ...claims.map((c) => ({ t: 100 * MIN, type: "context" as const, name: c.name, covers: c.covers })),
    ];
    const ctxOf = assignContexts(events);
    expect(ctxOf.get(b1)).toBe("one");
    expect(ctxOf.get(b2)).toBe("two");
  });

  it("no spans crossed: no claims", () => {
    expect(seamClaims(ropeA, ropeB, ropeB.start)).toEqual([]);
  });

  it("reassign moves one file's spans in one stretch, overriding declarations and evicts", () => {
    const a = span("A.md", 0);
    const b = span("B.md", 10 * MIN);
    const later = span("A.md", 20 * MIN);
    const events: LogEvent[] = [
      { t: 1, type: "context", name: "one" },
      a,
      b,
      later,
      // "two" must exist (be declared) for evicts and reassigns to name it.
      { t: 29 * MIN, type: "context", name: "two" },
      { t: 29 * MIN + 1, type: "context", name: "one" },
      { t: 30 * MIN, type: "evict", name: "two", path: "A.md" },
      // The stretch covering only the first A visit moves to two — despite the evict, the later correction wins.
      { t: 40 * MIN, type: "reassign", path: "A.md", name: "two", from: 0, to: 6 * MIN },
    ];
    const ctxOf = assignContexts(events);
    expect(ctxOf.get(a)).toBe("two");
    expect(ctxOf.get(b)).toBe("one");
    expect(ctxOf.get(later)).toBe("one"); // outside the range: untouched
  });

  it("reassign to '' unassigns; reassigns follow relabels and renames", () => {
    const a = span("Old.md", 0);
    const b = span("Old.md", 10 * MIN);
    const events: LogEvent[] = [
      { t: 1, type: "context", name: "one" },
      a,
      b,
      { t: 20 * MIN, type: "reassign", path: "Old.md", name: "", from: 0, to: 6 * MIN },
      { t: 21 * MIN, type: "reassign", path: "Old.md", name: "one", from: 8 * MIN, to: 16 * MIN },
      { t: 22 * MIN, type: "relabel", from: "one", to: "won" },
      { t: 23 * MIN, type: "rename", from: "Old.md", to: "New.md" },
    ];
    const resolved = applyRenames(events);
    const ctxOf = assignContexts(resolved);
    const spans = resolved.filter((ev): ev is SpanEvent => !("type" in ev));
    expect(ctxOf.get(spans[0] as SpanEvent)).toBeUndefined(); // unassigned
    expect(ctxOf.get(spans[1] as SpanEvent)).toBe("won"); // reassign rode the relabel
    expect((spans[0] as SpanEvent).path).toBe("New.md"); // and the rename
  });

  it("the braid's grains agree with the log", () => {
    const events = [span("A.md", 0), span("A.md", 6 * MIN), span("B.md", 500 * MIN)];
    const sessions = groupSessions(events);
    expect(sessions.length).toBe(2);
    const runs = contextRuns(sessions, assignContexts(events));
    expect(runs.length).toBe(2); // unassigned runs, one per session
    expect(runs[0].ctx).toBe("");
  });
});
