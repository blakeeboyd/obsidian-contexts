import { describe, expect, it } from "vitest";
import type { DataAdapter } from "obsidian";
import { EventLog } from "./log";
import type { SpanEvent } from "./recorder";

/** Minimal in-memory stand-in for the vault adapter. */
function fakeAdapter(files: Record<string, string>): DataAdapter {
  return {
    exists: async (p: string) => p in files || Object.keys(files).some((f) => f.startsWith(p + "/")),
    list: async (p: string) => ({
      files: Object.keys(files).filter((f) => f.startsWith(p + "/")),
      folders: [],
    }),
    read: async (p: string) => files[p],
    append: async (p: string, text: string) => {
      files[p] = (files[p] ?? "") + text;
    },
    mkdir: async () => {},
  } as unknown as DataAdapter;
}

const ev = (t: number, path: string): string =>
  JSON.stringify({ t, path, start: t - 1000, dur: 1000 } satisfies SpanEvent) + "\n";

describe("EventLog.readAll", () => {
  it("merges shards from multiple devices in timestamp order", async () => {
    const files = {
      "log/mac-2026-09.jsonl": ev(100, "A.md") + ev(300, "C.md"),
      "log/ipad-2026-09.jsonl": ev(200, "B.md"),
    };
    const log = new EventLog(fakeAdapter(files), "log", "mac");
    const events = await log.readAll();
    expect(events.map((e) => e.t)).toEqual([100, 200, 300]);
  });

  it("skips corrupt and truncated lines", async () => {
    const files = {
      "log/mac-2026-09.jsonl": ev(100, "A.md") + '{"t":200,"path":"trunc' + "\n" + ev(300, "B.md"),
    };
    const log = new EventLog(fakeAdapter(files), "log", "mac");
    const events = await log.readAll();
    expect(events.map((e) => e.t)).toEqual([100, 300]);
  });

  it("returns empty when no log directory exists", async () => {
    const log = new EventLog(fakeAdapter({}), "log", "mac");
    expect(await log.readAll()).toEqual([]);
  });

  it("round-trips an append", async () => {
    const files: Record<string, string> = {};
    const log = new EventLog(fakeAdapter(files), "log", "mac");
    await log.append({ t: Date.UTC(2026, 8, 7), path: "A.md", start: 0, dur: 5000 });
    const events = await log.readAll();
    expect(events).toHaveLength(1);
    expect((events[0] as SpanEvent).path).toBe("A.md");
  });
});
