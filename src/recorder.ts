/**
 * The recorder is a pure state machine: it holds at most one open activation
 * span (the note currently in front of the user) and turns deactivations into
 * log events. No Obsidian imports, so it is testable as plain data-in/data-out.
 */

/** What we remember about a file at the moment it becomes active. */
export interface Snapshot {
  words: number;
  links: string[];
  tags: string[];
  headings: string[];
  highlights: string[];
  footnotes: string[];
}

/** What changed while the file was active. Only present fields changed. */
export interface EditDelta {
  words?: number;
  linksAdded?: string[];
  linksRemoved?: string[];
  tagsAdded?: string[];
  tagsRemoved?: string[];
  headingsChanged?: true;
  highlightsAdded?: string[];
  highlightsRemoved?: string[];
  footnotesAdded?: string[];
  footnotesRemoved?: string[];
}

// Captured highlight/footnote text is truncated so one long annotation can't bloat the log.
const MAX_CAPTURE_CHARS = 120;

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_CAPTURE_CHARS ? t.slice(0, MAX_CAPTURE_CHARS) : t;
}

/** ==marked text==. ponytail: a highlight containing a bare `=` is missed; linear regex over ReDoS risk. */
export function extractHighlights(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/==([^=\n]+)==/g)) out.push(clip(m[1]));
  return out;
}

/** Footnote definitions (`[^id]: text`, first line) and inline footnotes (`^[text]`). */
export function extractFootnotes(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^\[\^[^\]]+\]:[ \t]*(.*)$/gm)) out.push(clip(m[1]));
  for (const m of content.matchAll(/\^\[([^\]]+)\]/g)) out.push(clip(m[1]));
  return out;
}

/** One activation span: the file was in front of the user from start to t. */
export interface SpanEvent {
  t: number; // deactivation timestamp (ms epoch)
  path: string;
  start: number;
  dur: number;
  edit?: EditDelta;
}

/** Renames must be logged or a file's trail breaks permanently. */
export interface RenameEvent {
  t: number;
  type: "rename";
  from: string;
  to: string;
}

export interface DeleteEvent {
  t: number;
  type: "delete";
  path: string;
}

export type LogEvent = SpanEvent | RenameEvent | DeleteEvent;

export function isSpan(ev: LogEvent): ev is SpanEvent {
  return !("type" in ev);
}

// ponytail: spans shorter than this are navigation flicks, not engagement.
export const MIN_SPAN_MS = 2000;

function diffList(before: string[], after: string[]): [string[], string[]] {
  const b = new Set(before);
  const a = new Set(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const x of a) if (!b.has(x)) added.push(x);
  for (const x of b) if (!a.has(x)) removed.push(x);
  return [added, removed];
}

export function diffSnapshots(before: Snapshot, after: Snapshot): EditDelta | undefined {
  const delta: EditDelta = {};
  if (after.words !== before.words) delta.words = after.words - before.words;
  const [linksAdded, linksRemoved] = diffList(before.links, after.links);
  if (linksAdded.length) delta.linksAdded = linksAdded;
  if (linksRemoved.length) delta.linksRemoved = linksRemoved;
  const [tagsAdded, tagsRemoved] = diffList(before.tags, after.tags);
  if (tagsAdded.length) delta.tagsAdded = tagsAdded;
  if (tagsRemoved.length) delta.tagsRemoved = tagsRemoved;
  if (before.headings.join("\n") !== after.headings.join("\n")) delta.headingsChanged = true;
  const [hlAdded, hlRemoved] = diffList(before.highlights, after.highlights);
  if (hlAdded.length) delta.highlightsAdded = hlAdded;
  if (hlRemoved.length) delta.highlightsRemoved = hlRemoved;
  const [fnAdded, fnRemoved] = diffList(before.footnotes, after.footnotes);
  if (fnAdded.length) delta.footnotesAdded = fnAdded;
  if (fnRemoved.length) delta.footnotesRemoved = fnRemoved;
  return Object.keys(delta).length ? delta : undefined;
}

export class Recorder {
  private current: { path: string; start: number; snap: Snapshot } | null = null;

  get activePath(): string | null {
    return this.current?.path ?? null;
  }

  activate(path: string, snap: Snapshot, now: number): void {
    this.current = { path, start: now, snap };
  }

  /**
   * Close the open span. `after` is the file's state at deactivation, or null
   * when it can't be read (file deleted, plugin unloading in a hurry).
   * Returns the event to log, or null if nothing was open or the span was
   * too short to count.
   */
  deactivate(after: Snapshot | null, now: number): SpanEvent | null {
    const cur = this.current;
    this.current = null;
    if (!cur) return null;
    const dur = now - cur.start;
    if (dur < MIN_SPAN_MS) return null;
    const ev: SpanEvent = { t: now, path: cur.path, start: cur.start, dur };
    if (after) {
      const edit = diffSnapshots(cur.snap, after);
      if (edit) ev.edit = edit;
    }
    return ev;
  }

  /** Keep the open span's identity across a rename of the active file. */
  handleRename(from: string, to: string): void {
    if (this.current?.path === from) this.current.path = to;
  }

  /** Drop the open span without recording (active file was deleted). */
  abandon(): void {
    this.current = null;
  }
}
