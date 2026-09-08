/**
 * Markdown rendering of one day's record, with REAL wikilinks — used by the
 * marker-insertion command so a daily note gains genuine graph edges to the
 * files it touched. The live view is the ```contexts-day``` block; this is
 * the durable fallback, written between HTML comment markers in the note.
 * Provenance: Blake (marker insertion preferred over plugin-owned files).
 */
import { fmtClock, fmtDeltaVerbose, fmtDur } from "./format";
import { EditDelta, LogEvent, isSpan } from "./recorder";
import { groupSessions, mergeDeltas } from "./views";

export const DAY_MARKER_START = "<!-- contexts-day:start -->";
export const DAY_MARKER_END = "<!-- contexts-day:end -->";

const wikilink = (path: string) => `[[${path.replace(/\.md$/, "")}]]`;

export function dailyMarkdown(events: LogEvent[], dayStart: number, dayEnd: number, gapMs: number): string {
  const dayEvents = events.filter((ev) => ev.t >= dayStart && ev.t < dayEnd);
  if (!dayEvents.length) return "_Nothing recorded this day._";
  const lines: string[] = [];
  for (const sess of groupSessions(dayEvents, gapMs)) {
    const engaged = sess.spans.reduce((sum, sp) => sum + sp.dur, 0);
    lines.push(`**${fmtClock(sess.start)} → ${fmtClock(sess.end)}** · ${fmtDur(engaged)}`);
    for (const f of sess.files) {
      const spans = sess.spans.filter((sp) => sp.path === f);
      const dur = spans.reduce((sum, sp) => sum + sp.dur, 0);
      const edit = mergeDeltas(spans.map((sp) => sp.edit).filter((e): e is EditDelta => !!e));
      const summary = edit ? ` — ${fmtDeltaVerbose(edit).split("\n").join("; ")}` : "";
      lines.push(`- ${wikilink(f)} (${fmtDur(dur)})${summary}`);
    }
    lines.push("");
  }
  const extmods = new Map<string, number>();
  for (const ev of dayEvents) {
    if ("type" in ev && ev.type === "extmod") extmods.set(ev.path, (extmods.get(ev.path) ?? 0) + 1);
  }
  const switches = dayEvents.filter(
    (ev): ev is Extract<LogEvent, { type: "context" }> => "type" in ev && ev.type === "context"
  );
  for (const ev of switches) {
    lines.push(`- ${fmtClock(ev.t)} context → ${ev.name || "(cleared)"}`);
  }
  if (switches.length) lines.push("");
  const created = dayEvents.filter((ev) => "type" in ev && ev.type === "create");
  if (created.length || extmods.size) {
    for (const ev of created) if ("path" in ev) lines.push(`- created ${wikilink(ev.path)}`);
    for (const [p, n] of extmods) lines.push(`- ${wikilink(p)} edited externally${n > 1 ? ` ×${n}` : ""}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Replace the marked region in `content`, or append one if no markers exist. */
export function upsertDaySection(content: string, body: string): string {
  const section = `${DAY_MARKER_START}\n${body}\n${DAY_MARKER_END}`;
  const start = content.indexOf(DAY_MARKER_START);
  const end = content.indexOf(DAY_MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return content.slice(0, start) + section + content.slice(end + DAY_MARKER_END.length);
  }
  return `${content.trimEnd()}\n\n${section}\n`;
}
