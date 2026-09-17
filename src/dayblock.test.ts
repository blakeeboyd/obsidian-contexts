import { describe, expect, it } from "vitest";
import { parseProps, resolveOver } from "./dayblock";

const day = (iso: string) => new Date(`${iso}T00:00:00`).getTime();
const DAY = 24 * 3600_000;

describe("parseProps", () => {
  it("parses every property and defaults view to list", () => {
    const p = parseProps("view: map\nover: week\ncontext: context 3, grant\ndevice: iPhone\ngroup: day");
    expect(p).toEqual({ view: "map", over: "week", contexts: ["context 3", "grant"], devices: ["iPhone"], group: "day" });
    expect(parseProps("").view).toBe("list");
  });

  it("keeps the legacy spellings: a bare date line is the span, and pace: aliases over:", () => {
    expect(parseProps("2026-09-14").over).toBe("2026-09-14");
    expect(parseProps("pace: week").over).toBe("week");
  });

  it("accepts bracketed lists and ignores unknown values", () => {
    expect(parseProps("context: [a, b]").contexts).toEqual(["a", "b"]);
    expect(parseProps("view: braid").view).toBe("list");
    expect(parseProps("group: fortnight").group).toBeNull();
  });
});

describe("resolveOver", () => {
  const anchor = day("2026-09-16"); // a Wednesday

  it("date literals pin a single day at session grain", () => {
    const w = resolveOver("2026-09-14", anchor, [], 60_000);
    expect(w.from).toBe(day("2026-09-14"));
    expect(w.to).toBe(day("2026-09-15") - 1);
    expect(w.grain).toBe("session");
  });

  it("ranges are inclusive at day grain", () => {
    const w = resolveOver("2026-09-01..2026-09-14", anchor, [], 60_000);
    expect(w.from).toBe(day("2026-09-01"));
    expect(w.to).toBe(day("2026-09-15") - 1);
    expect(w.grain).toBe("day");
  });

  it("week anchors to the Monday of the note's day; month to its calendar month — grain one step down", () => {
    const week = resolveOver("week", anchor, [], 60_000);
    expect(week.from).toBe(day("2026-09-14")); // Monday of that week
    expect(week.to).toBe(day("2026-09-21") - 1);
    expect(week.grain).toBe("day");
    const month = resolveOver("month", anchor, [], 60_000);
    expect(month.from).toBe(day("2026-09-01"));
    expect(month.grain).toBe("week");
    expect(resolveOver("all", anchor, [], 60_000)).toEqual({ grain: "month" });
  });

  it("the bare block is the note's day; relative words resolve at read time", () => {
    const bare = resolveOver(null, anchor, [], 60_000);
    expect(bare.from).toBe(anchor);
    expect(bare.to).toBe(anchor + DAY - 1);
    expect(bare.grain).toBe("session");
    const today = resolveOver("today", anchor, [], 60_000);
    const n = new Date();
    expect(today.from).toBe(new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime());
  });
});
