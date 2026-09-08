import { describe, expect, it } from "vitest";
import {
  Recorder,
  extractBlockIds,
  extractRefs,
  sectionAtLine,
  Snapshot,
  diffSnapshots,
  extractFootnotes,
  extractFormatting,
  extractHeadings,
  extractHighlights,
  extractTasks,
  extractUrls,
  extractLinks,
  extractTags,
  fmTagList,
  stripCodeFences,
} from "./recorder";

function snap(partial: Partial<Snapshot> = {}): Snapshot {
  return {
    words: 0,
    links: [],
    embeds: [],
    blockIds: [],
    tags: [],
    headings: [],
    highlights: [],
    footnotes: [],
    tasksOpen: [],
    tasksDone: [],
    urls: [],
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

  it("keeps subpaths, drops aliases, and separates embeds from links", () => {
    const text = "See [[&Jason Fick|Jason]] and [[Note#Heading]] plus ![[image.png]] and [[Zettel#^quote1]].";
    expect(extractRefs(text)).toEqual({
      links: ["&Jason Fick", "Note#Heading", "Zettel#^quote1"],
      embeds: ["image.png"],
    });
    expect(extractLinks(text)).toEqual(["&Jason Fick", "Note#Heading", "Zettel#^quote1", "image.png"]);
  });

  it("finds block IDs at line ends", () => {
    const text = "A quoted passage. ^quote-1\n\nplain line\n^lonely\nnot ^mid line";
    expect(extractBlockIds(text)).toEqual(["^quote-1", "^lonely"]);
  });

  it("finds the heading section containing a line", () => {
    const text = "intro\n# One\nbody\n## Two\ndeep";
    expect(sectionAtLine(text, 4)).toBe("Two");
    expect(sectionAtLine(text, 2)).toBe("One");
    expect(sectionAtLine(text, 0)).toBeUndefined();
  });

  it("finds inline tags and merges frontmatter tags", () => {
    const tags = extractTags("body #status/open and (#music) but not#this", ["#from-fm"]);
    expect(tags.sort()).toEqual(["#from-fm", "#music", "#status/open"]);
  });

  it("normalizes frontmatter tag shapes", () => {
    expect(fmTagList({ tags: ["a", "#b"] })).toEqual(["#a", "#b"]);
    expect(fmTagList({ tags: "x, y" })).toEqual(["#x", "#y"]);
    expect(fmTagList({})).toEqual([]);
  });

  it("finds headings and ignores fenced code", () => {
    const text = "# Top\n\n```\n# not a heading\n[[not a link]]\n```\n\n## Sub\n";
    const body = stripCodeFences(text);
    expect(extractHeadings(body)).toEqual(["Top", "Sub"]);
    expect(extractLinks(body)).toEqual([]);
  });

  it("finds tasks by status, including custom done markers", () => {
    const text = "- [ ] call Nadia\n- [x] send syllabus\n- [/] half done\n1. [ ] numbered task\nnot - [ ] a task";
    expect(extractTasks(text)).toEqual({
      open: ["call Nadia", "numbered task"],
      done: ["send syllabus", "half done"],
    });
  });

  it("diffs tasks into added, completed, reopened, removed", () => {
    const before = snap({ tasksOpen: ["a", "b", "c"], tasksDone: ["d"] });
    const after = snap({ tasksOpen: ["a", "d"], tasksDone: ["b", "e"] });
    expect(diffSnapshots(before, after)).toEqual({
      tasksAdded: ["e"],
      tasksCompleted: ["b"],
      tasksReopened: ["d"],
      tasksRemoved: ["c"],
    });
  });

  it("finds external URLs in markdown links, autolinks, and bare form", () => {
    const text = "See [docs](https://example.com/a) and <https://b.org> plus bare https://c.net/x?y=1 done";
    expect(extractUrls(text)).toEqual(["https://example.com/a", "https://b.org", "https://c.net/x?y=1"]);
  });

  it("diffs URLs into added and removed", () => {
    const d = diffSnapshots(snap({ urls: ["https://old.com"] }), snap({ urls: ["https://new.com"] }));
    expect(d).toEqual({ urlsAdded: ["https://new.com"], urlsRemoved: ["https://old.com"] });
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

describe("Recorder open provenance", () => {
  it("stamps the span with the file it was opened from", () => {
    const r = new Recorder();
    r.activate("B.md", snap(), 0, undefined, { via: "link", from: "A.md" });
    const ev = r.deactivate(snap(), 5000);
    expect(ev?.from).toBe("A.md");
    expect(ev?.via).toBe("link");
  });

  it("records the UI surface when there is no source file", () => {
    const r = new Recorder();
    r.activate("B.md", snap(), 0, undefined, { via: "switcher" });
    const ev = r.deactivate(snap(), 5000);
    expect(ev?.via).toBe("switcher");
    expect(ev?.from).toBeUndefined();
  });

  it("omits provenance when the file was opened another way", () => {
    const r = new Recorder();
    r.activate("B.md", snap(), 0);
    expect(r.deactivate(snap(), 5000)?.via).toBeUndefined();
  });

  it("keeps a sub-minimum glance that arrived via a link", () => {
    const r = new Recorder();
    r.activate("B.md", snap(), 0, undefined, { via: "link", from: "A.md" });
    const ev = r.deactivate(snap(), 1000);
    expect(ev?.from).toBe("A.md");
  });

  it("records the section the visit ended in", () => {
    const r = new Recorder();
    r.activate("B.md", snap(), 0);
    expect(r.deactivate(snap(), 5000, "switch", "Chapter Survey")?.section).toBe("Chapter Survey");
  });

  it("records how the visit ended", () => {
    const r = new Recorder();
    r.activate("B.md", snap(), 0);
    expect(r.deactivate(snap(), 5000, "blur")?.left).toBe("blur");
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
