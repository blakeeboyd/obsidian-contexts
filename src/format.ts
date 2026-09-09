import { EditDelta, LogEvent, isSpan } from "./recorder";

export function fmtTime(t: number): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** "Today", "Yesterday", or M/D for older dates. */
export function relDay(t: number, now = Date.now()): string {
  const d = new Date(t);
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const n = new Date(now);
  const today = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (day === today) return "Today";
  if (today - day <= 24 * 3600_000) return "Yesterday";
  return `${d.getMonth() + 1}/${d.getDate()}`;
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
  if (e.wordsAdded || e.wordsRemoved)
    parts.push(`words +${e.wordsAdded ?? 0}/-${e.wordsRemoved ?? 0}`);
  else if (e.words) parts.push(`${e.words > 0 ? "+" : ""}${e.words}w`);
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
  if (e.tasksAdded || e.tasksRemoved)
    parts.push(`tasks +${e.tasksAdded?.length ?? 0}/-${e.tasksRemoved?.length ?? 0}`);
  if (e.tasksCompleted) parts.push(`done ${e.tasksCompleted.length}`);
  if (e.tasksReopened) parts.push(`reopened ${e.tasksReopened.length}`);
  if (e.urlsAdded || e.urlsRemoved) parts.push(`urls +${e.urlsAdded?.length ?? 0}/-${e.urlsRemoved?.length ?? 0}`);
  if (e.embedsAdded || e.embedsRemoved)
    parts.push(`embeds +${e.embedsAdded?.length ?? 0}/-${e.embedsRemoved?.length ?? 0}`);
  if (e.blockIdsAdded || e.blockIdsRemoved)
    parts.push(`ids +${e.blockIdsAdded?.length ?? 0}/-${e.blockIdsRemoved?.length ?? 0}`);
  if (e.calloutsAdded || e.calloutsRemoved)
    parts.push(`callouts +${e.calloutsAdded?.length ?? 0}/-${e.calloutsRemoved?.length ?? 0}`);
  if (e.commentsAdded || e.commentsRemoved)
    parts.push(`comments +${e.commentsAdded?.length ?? 0}/-${e.commentsRemoved?.length ?? 0}`);
  if (e.struckAdded || e.struckRemoved)
    parts.push(`struck +${e.struckAdded?.length ?? 0}/-${e.struckRemoved?.length ?? 0}`);
  if (e.codeLangsAdded || e.codeLangsRemoved)
    parts.push(`langs +${e.codeLangsAdded?.length ?? 0}/-${e.codeLangsRemoved?.length ?? 0}`);
  if (e.codeBlocks) parts.push(`code ${e.codeBlocks > 0 ? "+" : ""}${e.codeBlocks}`);
  if (e.math) parts.push(`math ${e.math > 0 ? "+" : ""}${e.math}`);
  if (e.tables) parts.push(`tables ${e.tables > 0 ? "+" : ""}${e.tables}`);
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
  if (e.wordsAdded || e.wordsRemoved) lines.push(`words +${e.wordsAdded ?? 0}/-${e.wordsRemoved ?? 0}`);
  else if (e.words) lines.push(`words ${num(e.words)}`);
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
  if (e.tasksAdded?.length) lines.push(`tasks added: ${e.tasksAdded.join(", ")}`);
  if (e.tasksCompleted?.length) lines.push(`tasks completed: ${e.tasksCompleted.join(", ")}`);
  if (e.tasksReopened?.length) lines.push(`tasks reopened: ${e.tasksReopened.join(", ")}`);
  if (e.tasksRemoved?.length) lines.push(`tasks removed: ${e.tasksRemoved.join(", ")}`);
  if (e.urlsAdded?.length) lines.push(`external links added: ${e.urlsAdded.join(", ")}`);
  if (e.urlsRemoved?.length) lines.push(`external links removed: ${e.urlsRemoved.join(", ")}`);
  if (e.embedsAdded?.length) lines.push(`embeds added: ${e.embedsAdded.join(", ")}`);
  if (e.embedsRemoved?.length) lines.push(`embeds removed: ${e.embedsRemoved.join(", ")}`);
  if (e.blockIdsAdded?.length) lines.push(`block ids added: ${e.blockIdsAdded.join(", ")}`);
  if (e.blockIdsRemoved?.length) lines.push(`block ids removed: ${e.blockIdsRemoved.join(", ")}`);
  if (e.calloutsAdded?.length) lines.push(`callouts added: ${e.calloutsAdded.join(", ")}`);
  if (e.calloutsRemoved?.length) lines.push(`callouts removed: ${e.calloutsRemoved.join(", ")}`);
  if (e.commentsAdded?.length) lines.push(`comments added: ${e.commentsAdded.join(", ")}`);
  if (e.commentsRemoved?.length) lines.push(`comments removed: ${e.commentsRemoved.join(", ")}`);
  if (e.struckAdded?.length) lines.push(`struck: ${e.struckAdded.join(", ")}`);
  if (e.struckRemoved?.length) lines.push(`unstruck: ${e.struckRemoved.join(", ")}`);
  if (e.codeLangsAdded?.length) lines.push(`code languages added: ${e.codeLangsAdded.join(", ")}`);
  if (e.codeLangsRemoved?.length) lines.push(`code languages removed: ${e.codeLangsRemoved.join(", ")}`);
  if (e.codeBlocks) lines.push(`code blocks ${num(e.codeBlocks)}`);
  if (e.math) lines.push(`math ${num(e.math)}`);
  if (e.tables) lines.push(`tables ${num(e.tables)}`);
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
      : ev.type === "create" ? `created${ev.by ? ` by ${ev.by}` : ""}: ${ev.path}`
      : ev.type === "firstseen" ? `first seen: ${ev.path} (${ev.counts.words}w, ${ev.counts.links} links)`
      : ev.type === "unrelate" ? `marked unrelated: ${ev.a} ✗ ${ev.b}`
      : ev.type === "relate" ? `relation restored: ${ev.a} + ${ev.b}`
      : ev.type === "context" ? (ev.name ? `context → ${ev.name}` : "context cleared")
      : ev.type === "relabel" ? `context renamed: ${ev.from} → ${ev.to}`
      : ev.type === "peek" ? `peeked: ${ev.path} ← ${ev.from}`
      : `${ev.by ? `edit by ${ev.by}` : "external edit"}: ${ev.path}${ev.edit ? ` (${fmtDeltaVerbose(ev.edit).split("\n").join("; ")})` : ""}`;
    return `${fmtTime(ev.t)}           ${desc}`;
  }
  const delta = ev.edit ? fmtDeltaVerbose(ev.edit).split("\n").join("; ") : "";
  const edit = delta ? `  (${delta})` : "";
  const from = ev.from ? `  ← ${ev.from}` : ev.via ? `  ←[${ev.via}]` : "";
  const left = ev.left && ev.left !== "switch" ? `  [${ev.left}]` : "";
  return `${fmtTime(ev.start)}  ${fmtDur(ev.dur).padStart(5)}  ${ev.path}${from}${left}${edit}`;
}
