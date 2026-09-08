import { describe, expect, it } from "vitest";
import {
  Recorder,
  Snapshot,
  diffSnapshots,
  extractFootnotes,
  extractFormatting,
  extractHighlights,
} from "./recorder";

function snap(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    words: 0,
    links: [],
    tags: [],
    headings: [],
    highlights: [],
    footnotes: [],
    bold: 0,
    italic: 0,
    fm: {},
    ...partial,
  };
}

describe("extractors", () => {
  it("finds highlights", () => {
    expect(extractHighlights("a ==big idea== and ==another== here")).toEqual(["big idea", "another"]);
  });

  it("finds footnote definitions and inline footnotes", () => {
    const text = "claim.[^1]\n\n[^1]: the source\n\nand inline.^[quick aside]";
    expect(extractFootnotes(text)).toEqual(["the source", "quick aside"]);
  });

  it("counts bold and italic without conflating them", () => {
    const { bold, italic } = extractFormatting("**strong** and *soft* and _also_ and **more**");
    expect(bold).toBe(2);
    expect(italic).toBe(2);
  });
});

describe("diffSnapshots", () => {
  it("returns undefined when nothing changed", () => {
    expect(diffSnapshots(snap({ words: 5 }), snap({ words: 5 }))).toBeUndefined();
  });

  it("reports frontmatter changes with before and after values", () => {
    const before = snap({ fm: { status: '"draft"', file_type: '"note"' } });
    const after = snap({ fm: { status: '"done"', file_type: '"note"', domains: '["x"]' } });
    expect(diffSnapshots(before, after)?.fmChanged).toEqual({
      domains: [null, '["x"]'],
      status: ['"draft"', '"done"'],
    });
  });

  it("reports which headings were added or removed", () => {
    const d = diffSnapshots(snap({ headings: ["Intro", "Old"] }), snap({ headings: ["Intro", "New"] }));
    expect(d).toEqual({ headingsAdded: ["New"], headingsRemoved: ["Old"] });
  });

  it("flags a pure heading reorder without add/remove lists", () => {
    const d = diffSnapshots(snap({ headings: ["A", "B"] }), snap({ headings: ["B", "A"] }));
    expect(d).toEqual({ headingsChanged: true });
  });

  it("reports formatting and word deltas", () => {
    const d = diffSnapshots(snap({ words: 10, bold: 1 }), snap({ words: 14, bold: 3, italic: 1 }));
    expect(d).toEqual({ words: 4, bold: 2, italic: 1 });
  });
});

describe("Recorder minimum span", () => {
  it("drops a sub-minimum span with no edit", () => {
    const r = new Recorder();
    r.activate("A.md", snap({ words: 10 }), 0);
    expect(r.deactivate(snap({ words: 10 }), 1000)).toBeNull();
  });

  it("keeps a sub-minimum span that changed the file", () => {
    const r = new Recorder();
    r.activate("A.md", snap({ words: 10 }), 0);
    const ev = r.deactivate(snap({ words: 7 }), 1000);
    expect(ev?.edit).toEqual({ words: -3 });
    expect(ev?.dur).toBe(1000);
  });
});
