import { describe, expect, it } from "vitest";
import { LogEvent, SpanEvent } from "./recorder";
import { NavNode, applyErasures, buildNavForest, layoutNavTree } from "./views";

const MIN = 60_000;

function span(path: string, start: number, dur = 5 * MIN, extra: Partial<SpanEvent> = {}): SpanEvent {
  return { t: start + dur, path, start, dur, ...extra };
}

describe("buildNavForest", () => {
  it("roots at the session's first note; link arrivals parent to the source, others to the predecessor", () => {
    const events: LogEvent[] = [
      span("Daily.md", 0),
      span("A.md", 5 * MIN, 5 * MIN, { via: "link", from: "Daily.md" }),
      span("B.md", 10 * MIN, 5 * MIN, { via: "link", from: "A.md" }),
      span("C.md", 15 * MIN), // no from: opened while B was in front
    ];
    const trees = buildNavForest(events, {});
    expect(trees).toHaveLength(1);
    const root = trees[0].root;
    expect(root.path).toBe("Daily.md");
    expect(root.children.map((n) => n.path)).toEqual(["A.md"]);
    expect(root.children[0].children.map((n) => n.path)).toEqual(["B.md"]);
    expect(trees[0].parentOf.get("C.md")).toBe("B.md");
    // Arrival kind survives onto the node: followed link vs mere sequence.
    expect(root.via).toBeUndefined();
    expect(root.children[0].via).toBe("link");
    const c = root.children[0].children[0].children[0];
    expect(c.via).toBe("seq");
  });

  it("marks files created in the sitting and resolves written links to placed nodes", () => {
    const events: LogEvent[] = [
      span("Daily.md", 0, 5 * MIN, { edit: { linksAdded: ["Projects/New Note", "Nowhere"] } }),
      { t: 5 * MIN + 10_000, type: "create", path: "New Note.md" },
      span("New Note.md", 5 * MIN + 11_000),
    ];
    const trees = buildNavForest(events, {});
    const born = trees[0].root.children[0];
    expect(born.path).toBe("New Note.md");
    expect(born.created).toBe(true);
    expect(trees[0].root.created).toBeUndefined();
    // "Projects/New Note" resolves by basename; "Nowhere" points at no node.
    expect(trees[0].links).toEqual([{ from: "Daily.md", to: "New Note.md", kind: "linked" }]);
    expect(born.lastAt).toBe(born.firstAt + 5 * MIN);
  });

  it("keeps first placement on revisits and records later arrivals as secondary links", () => {
    const events: LogEvent[] = [
      span("Daily.md", 0),
      span("A.md", 5 * MIN),
      span("B.md", 10 * MIN),
      span("A.md", 15 * MIN, 5 * MIN, { via: "link", from: "B.md" }), // back to A from B
      span("A.md", 20 * MIN), // re-span of A itself: no self-link
    ];
    const trees = buildNavForest(events, {});
    const root = trees[0].root;
    expect(root.children.map((n) => n.path)).toEqual(["A.md"]); // A stays where it first landed
    const a = root.children[0];
    expect(a.visits).toBe(3);
    expect(trees[0].links).toEqual([{ from: "B.md", to: "A.md", kind: "revisit" }]);
  });

  it("splits sessions into separate trees and windows the scope", () => {
    const events: LogEvent[] = [
      span("Morning.md", 0),
      span("Evening.md", 500 * MIN),
      span("Note.md", 505 * MIN),
    ];
    const trees = buildNavForest(events, {});
    expect(trees.map((t) => t.root.path)).toEqual(["Morning.md", "Evening.md"]);
    const windowed = buildNavForest(events, { from: 400 * MIN });
    expect(windowed.map((t) => t.root.path)).toEqual(["Evening.md"]);
  });

  it("marks edits and adds peeks between placed files as dashed links", () => {
    const events: LogEvent[] = [
      span("Daily.md", 0, 5 * MIN, { edit: { wordsAdded: 12 } }),
      span("A.md", 5 * MIN),
      { t: 11 * MIN, type: "peek", path: "Daily.md", from: "A.md" },
      span("B.md", 12 * MIN),
    ];
    const trees = buildNavForest(events, {});
    expect(trees[0].root.edits).toBe(1);
    expect(trees[0].links).toEqual([{ from: "A.md", to: "Daily.md", kind: "peek" }]);
  });

  it("scopes by context per SPAN, skipping excursions and badging the return", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "ctx1" },
      span("A.md", 1 * MIN),
      span("Other.md", 6 * MIN),
      span("Stray.md", 11 * MIN),
      span("B.md", 16 * MIN),
      { t: 30 * MIN, type: "reassign", path: "Other.md", name: "", from: 0, to: 30 * MIN },
      { t: 31 * MIN, type: "reassign", path: "Stray.md", name: "", from: 0, to: 30 * MIN },
    ];
    const trees = buildNavForest(events, { ctx: "ctx1" });
    expect(trees[0].root.path).toBe("A.md");
    // The moved-out visits vanish; B chains to the previous in-context file.
    expect(trees[0].parentOf.get("B.md")).toBe("A.md");
    expect([...trees[0].parentOf.keys()]).toEqual(["A.md", "B.md"]);
    // The return carries the excursion's shape, not its files.
    const b = trees[0].root.children[0];
    expect(b.away).toEqual({ times: 1, dur: 10 * MIN, files: 2 });
    expect(trees[0].root.away).toBeUndefined();
  });

  it("removes a file entirely once every span is moved out of the context", () => {
    const events: LogEvent[] = [
      { t: 0, type: "context", name: "ctx1" },
      span("A.md", 1 * MIN),
      span("Subwoofer.md", 6 * MIN),
      { t: 29 * MIN, type: "context", name: "ctx2" }, // reassign targets must already exist
      { t: 30 * MIN, type: "reassign", path: "Subwoofer.md", name: "ctx2", from: 0, to: 20 * MIN },
    ];
    const trees = buildNavForest(events, { ctx: "ctx1" });
    expect([...trees[0].parentOf.keys()]).toEqual(["A.md"]);
  });

  it("groups trees by day or by Monday-start week", () => {
    const mon = new Date(2026, 0, 5, 9).getTime(); // Mon Jan 5 2026
    const tue = new Date(2026, 0, 6, 9).getTime();
    const nextMon = new Date(2026, 0, 12, 9).getTime();
    const events: LogEvent[] = [
      span("MonA.md", mon),
      span("MonB.md", mon + 300 * MIN), // same day, separate inferred session
      span("Tue.md", tue),
      span("Next.md", nextMon),
    ];
    expect(buildNavForest(events, {}).length).toBe(4);
    const byDay = buildNavForest(events, {}, undefined, "day");
    expect(byDay.map((t) => t.root.path)).toEqual(["MonA.md", "Tue.md", "Next.md"]);
    expect(byDay[0].parentOf.get("MonB.md")).toBe("MonA.md"); // the day's movement is one tree
    const byWeek = buildNavForest(events, {}, undefined, "week");
    expect(byWeek.map((t) => t.root.path)).toEqual(["MonA.md", "Next.md"]);
  });

  it("groups by month", () => {
    const events: LogEvent[] = [
      span("Jan.md", new Date(2026, 0, 5, 9).getTime()),
      span("JanLater.md", new Date(2026, 0, 20, 9).getTime()),
      span("Feb.md", new Date(2026, 1, 2, 9).getTime()),
    ];
    const byMonth = buildNavForest(events, {}, undefined, "month");
    expect(byMonth.map((t) => t.root.path)).toEqual(["Jan.md", "Feb.md"]);
  });
});

describe("layoutNavTree", () => {
  const node = (path: string, children: NavNode[] = []): NavNode => ({
    path,
    firstAt: 0,
    lastAt: 0,
    ctx: "",
    dur: 0,
    visits: 1,
    edits: 0,
    children,
  });

  it("stacks leaves in visit order, centers parents, staggers x by label width", () => {
    const b = node("B.md");
    const c = node("C.md");
    const a = node("A.md", [b, c]);
    const root = node("Root.md", [a]);
    const { pos, height } = layoutNavTree(root, (p) => (p === "Root.md" ? 100 : 50), 10, 0);
    expect(pos.get(b)!.y).toBeLessThan(pos.get(c)!.y);
    expect(pos.get(a)!.y).toBe((pos.get(b)!.y + pos.get(c)!.y) / 2);
    expect(pos.get(root)!.y).toBe(pos.get(a)!.y); // single child: same row
    expect(pos.get(a)!.x).toBeGreaterThan(pos.get(root)!.x + 100); // past the root's label
    expect(pos.get(b)!.x).toBe(pos.get(c)!.x); // siblings share a column
    expect(height).toBeGreaterThan(0);
  });

  it("gives sibling subtrees disjoint row ranges", () => {
    const left = node("L.md", [node("L1.md"), node("L2.md")]);
    const right = node("R.md", [node("R1.md")]);
    const root = node("Root.md", [left, right]);
    const { pos } = layoutNavTree(root, () => 60, 0, 0);
    const leftMax = Math.max(...left.children.map((n) => pos.get(n)!.y), pos.get(left)!.y);
    const rightMin = Math.min(...right.children.map((n) => pos.get(n)!.y), pos.get(right)!.y);
    expect(leftMax).toBeLessThan(rightMin);
  });
});

describe("baseline dedupe (sync lag)", () => {
  it("keeps the earliest firstseen per file, allowing a fresh one after rebirth", () => {
    const fs = (t: number, path: string): LogEvent => ({ t, type: "firstseen", path, counts: { words: 0, links: 0, tags: 0, headings: 0, highlights: 0, footnotes: 0, tasksOpen: 0, tasksDone: 0 } } as LogEvent);
    const events: LogEvent[] = [
      fs(1, "A.md"), // Mac met it first
      fs(2, "A.md"), // phone met it before the shards crossed
      { t: 3, type: "delete", path: "A.md" },
      { t: 4, type: "create", path: "A.md" },
      fs(5, "A.md"), // reborn: a fresh baseline is legitimate
    ];
    const out = applyErasures(events);
    const baselines = out.filter((ev) => "type" in ev && ev.type === "firstseen");
    expect(baselines.map((ev) => ev.t)).toEqual([1, 5]);
  });
});
