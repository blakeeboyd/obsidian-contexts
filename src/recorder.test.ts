import { describe, expect, it } from "vitest";
import {
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

  it("reports frontmatter key changes without values", () => {
    const before = snap({ fm: { status: '"draft"', file_type: '"note"' } });
    const after = snap({ fm: { status: '"done"', file_type: '"note"', domains: '["x"]' } });
    expect(diffSnapshots(before, after)?.fmChanged).toEqual(["domains", "status"]);
  });

  it("reports formatting and word deltas", () => {
    const d = diffSnapshots(snap({ words: 10, bold: 1 }), snap({ words: 14, bold: 3, italic: 1 }));
    expect(d).toEqual({ words: 4, bold: 2, italic: 1 });
  });
});
