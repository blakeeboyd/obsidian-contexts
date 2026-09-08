import { EditDelta, LogEvent, isSpan } from "./recorder";

export function fmtTime(t: number): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
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
  if (e.words) parts.push(`${e.words > 0 ? "+" : ""}${e.words}w`);
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

export function fmtEvent(ev: LogEvent): string {
  if (!isSpan(ev)) {
    const desc =
      ev.type === "rename" ? `renamed: ${ev.from} → ${ev.to}`
      : ev.type === "delete" ? `deleted: ${ev.path}`
      : ev.type === "create" ? `created: ${ev.path}`
      : `external edit: ${ev.path}`;
    return `${fmtTime(ev.t)}           ${desc}`;
  }
  const delta = ev.edit ? fmtDelta(ev.edit) : "";
  const edit = delta ? `  (${delta})` : "";
  return `${fmtTime(ev.start)}  ${fmtDur(ev.dur).padStart(5)}  ${ev.path}${edit}`;
}
