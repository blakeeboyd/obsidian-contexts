import { describe, expect, it } from "vitest";
import { LogEvent, SpanEvent } from "./recorder";
import { DAY_MARKER_END, DAY_MARKER_START, dailyMarkdown, upsertDaySection } from "./daily";

const MIN = 60_000;
const span = (path: string, start: number, edit?: SpanEvent["edit"]): SpanEvent => {
  const ev: SpanEvent = { t: start + 5 * MIN, path, start, dur: 5 * MIN };
  if (edit) ev.edit = edit;
  return ev;
};

describe("dailyMarkdown", () => {
  it("renders sessions with wikilinks and edit summaries", () => {
    const events: LogEvent[] = [
      span("A folder/Note.md", 10 * MIN, { words: 12 }),
      { t: 20 * MIN, type: "extmod", path: "journal/day.md" },
    ];
    const md = dailyMarkdown(events, 0, 24 * 3600_000, 30 * MIN);
    expect(md).toContain("[[A folder/Note]]");
    expect(md).toContain("words +12");
    expect(md).toContain("[[journal/day]] edited externally");
  });

  it("attributes announced plugin writes and keeps mixed writers anonymous", () => {
    const events: LogEvent[] = [
      span("Note.md", 10 * MIN),
      { t: 20 * MIN, type: "extmod", path: "ai/report.md", by: "vault-mcp" },
      { t: 22 * MIN, type: "extmod", path: "sync/other.md", by: "vault-mcp" },
      { t: 40 * MIN, type: "extmod", path: "sync/other.md" }, // second write anonymous: attribution dropped
      { t: 50 * MIN, type: "create", path: "ai/new.md", by: "vault-mcp" },
    ];
    const md = dailyMarkdown(events, 0, 24 * 3600_000, 30 * MIN);
    expect(md).toContain("[[ai/report]] edited by vault-mcp");
    expect(md).toContain("[[sync/other]] edited externally ×2");
    expect(md).toContain("created [[ai/new]] (by vault-mcp)");
  });

  it("says so when the day is empty", () => {
    expect(dailyMarkdown([], 0, 1000, 30 * MIN)).toContain("Nothing recorded");
  });
});

describe("upsertDaySection", () => {
  it("appends markers when absent and replaces between them when present", () => {
    const first = upsertDaySection("# My day\n\nnotes here\n", "BODY1");
    expect(first).toContain(DAY_MARKER_START);
    expect(first).toContain("BODY1");
    const second = upsertDaySection(first, "BODY2");
    expect(second).toContain("BODY2");
    expect(second).not.toContain("BODY1");
    expect(second.indexOf(DAY_MARKER_END)).toBeGreaterThan(second.indexOf("BODY2"));
    expect(second).toContain("notes here"); // user content untouched
  });
});
