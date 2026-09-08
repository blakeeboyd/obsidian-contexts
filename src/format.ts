import { EditDelta, LogEvent, isSpan } from "./recorder";

export function fmtTime(t: number): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** Time of day only (HH:MM), for lists where the date is already established. */
export function fmtClock(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function relTime(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/** Compact one-line summary of an edit delta: "+12w, links +1/-0, hl +2/-0". */
export function fmtDelta(e: EditDelta): string {
  const parts: string[] = [];
  if (e.wordsAdded) parts.push(`+${e.wordsAdded}w`);
  if (e.wordsRemoved) parts.push(`-${e.wordsRemoved}w`);
  if (e.words && !e.wordsAdded && !e.wordsRemoved) parts.push(`${e.words > 0 ? "+" : ""}${e.words}w`);
  if (e.linksAdded || e.linksRemoved)
    parts.push(`links +${e.linksAdded?.length ?? 0}/-${e.linksRemoved?.length ?? 0}`);
  if (e.tagsAdded || e.tagsRemoved)
    parts.push(`tags +${e.tagsAdded?.length ?? 0}/-${e.tagsRemoved?.length ?? 0}`);
  if (e.headingsAdded || e.headingsRemoved)
    parts.push(`headings +${e.headingsAdded?.length ?? 0}/-${e.headingsRemoved?.length ?? 0}`);
  else if (e.headingsChanged) parts.push("headings");
  if (e.highlightsAdded || e.highlightsRemoved)
    parts.push(`hl +${e.highlightsAdded?.length ?? 0}/-${e.highlightsRemoved?.length ?? 0}`);
  if (e.footnotesAdded || e.footnotesRemoved)
    parts.push(`fn +${e.footnotesAdded?.length ?? 0}/-${e.footnotesRemoved?.length ?? 0}`);
  if (e.bold) parts.push(`bold ${e.bold > 0 ? "+" : ""}${e.bold}`);
  if (e.italic) parts.push(`italic ${e.italic > 0 ? "+" : ""}${e.italic}`);
  if (e.fmChanged) {
    const keys = Array.isArray(e.fmChanged) ? e.fmChanged : Object.keys(e.fmChanged);
    parts.push(`fm: ${keys.join(",")}`);
  }
  return parts.join(", ");
}

/** Full detail of a delta, one item per line: the actual names, text, and values. */
export function fmtDeltaVerbose(e: EditDelta): string {
  const lines: string[] = [];
  const num = (n: number) => `${n > 0 ? "+" : ""}${n}`;
  if (e.wordsAdded || e.wordsRemoved) {
    const parts = [];
    if (e.wordsAdded) parts.push(`+${e.wordsAdded}`);
    if (e.wordsRemoved) parts.push(`-${e.wordsRemoved}`);
    lines.push(`words ${parts.join(" / ")}`);
  } else if (e.words) lines.push(`words ${num(e.words)}`);
  const list = (label: string, added?: string[], removed?: string[]) => {
    if (added?.length) lines.push(`${label} added: ${added.join(", ")}`);
    if (removed?.length) lines.push(`${label} removed: ${removed.join(", ")}`);
  };
  list("links", e.linksAdded, e.linksRemoved);
  list("tags", e.tagsAdded, e.tagsRemoved);
  list("headings", e.headingsAdded, e.headingsRemoved);
  if (e.headingsChanged) lines.push("headings reordered");
  list("highlights", e.highlightsAdded, e.highlightsRemoved);
  list("footnotes", e.footnotesAdded, e.footnotesRemoved);
  if (e.bold) lines.push(`bold ${num(e.bold)}`);
  if (e.italic) lines.push(`italic ${num(e.italic)}`);
  if (e.fmChanged) {
    if (Array.isArray(e.fmChanged)) lines.push(`frontmatter: ${e.fmChanged.join(", ")}`);
    else
      for (const [k, [before, after]] of Object.entries(e.fmChanged))
        lines.push(`frontmatter ${k}: ${before ?? "(none)"} → ${after ?? "(none)"}`);
  }
  return lines.join("\n");
}

export function fmtEvent(ev: LogEvent): string {
  if (!isSpan(ev)) {
    const desc =
      ev.type === "rename" ? `renamed: ${ev.from} → ${ev.to}`
      : ev.type === "delete" ? `deleted: ${ev.path}`
      : ev.type === "create" ? `created: ${ev.path}`
      : `external edit: ${ev.path}`;
    return `${fmtTime(ev.t)}           ${desc}`;
  }
  const delta = ev.edit ? fmtDeltaVerbose(ev.edit).split("\n").join("; ") : "";
  const edit = delta ? `  (${delta})` : "";
  return `${fmtTime(ev.start)}  ${fmtDur(ev.dur).padStart(5)}  ${ev.path}${edit}`;
}
