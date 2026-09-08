/**
 * The recorder is a pure state machine: it holds at most one open activation
 * span (the note currently in front of the user) and turns deactivations into
 * log events. No Obsidian imports, so it is testable as plain data-in/data-out.
 */

/**
 * What we remember about a file at the moment it becomes active. Disabled
 * capture signals arrive as empty values and simply never produce a delta.
 */
export interface Snapshot {
  words: number;
  links: string[];
  tags: string[];
  headings: string[];
  highlights: string[];
  footnotes: string[];
  tasksOpen: string[];
  tasksDone: string[];
  bold: number;
  italic: number;
  fm: Record<string, string>; // frontmatter, values pre-stringified for cheap compare
}

/** What changed while the file was active. Only present fields changed. */
export interface EditDelta {
  words?: number;
  /** Merge-level only (stint summaries): gross word movement, summed from per-visit nets. */
  wordsAdded?: number;
  wordsRemoved?: number;
  linksAdded?: string[];
  linksRemoved?: string[];
  tagsAdded?: string[];
  tagsRemoved?: string[];
  headingsAdded?: string[];
  headingsRemoved?: string[];
  headingsChanged?: true; // reorder only (nothing added or removed); also the pre-2026-09-08 log shape
  highlightsAdded?: string[];
  highlightsRemoved?: string[];
  footnotesAdded?: string[];
  footnotesRemoved?: string[];
  tasksAdded?: string[];
  tasksCompleted?: string[];
  tasksReopened?: string[];
  tasksRemoved?: string[];
  bold?: number; // net count change
  italic?: number;
  /** Frontmatter changes: key → [before, after] (null = absent). Pre-2026-09-08 logs hold a bare key list. */
  fmChanged?: string[] | Record<string, [string | null, string | null]>;
}

// Captured highlight/footnote text is truncated so one long annotation can't bloat the log.
const MAX_CAPTURE_CHARS = 120;

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_CAPTURE_CHARS ? t.slice(0, MAX_CAPTURE_CHARS) : t;
}

/**
 * These extractors parse straight from text rather than Obsidian's metadata
 * cache: the cache lags behind unsaved keystrokes, so a cache-based snapshot
 * at deactivation loses edits made just before tabbing away.
 */

/** ponytail: fenced blocks only (``` / ~~~); an unclosed fence leaves its tail unstripped. */
export function stripCodeFences(content: string): string {
  return content.replace(/^[ \t]*(?:```|~~~).*\n[\s\S]*?^[ \t]*(?:```|~~~).*$/gm, "");
}

/** Wikilink and embed targets: [[Target]], [[Target#h|alias]], ![[Target]]. ponytail: markdown-style [text](file.md) links are not parsed; this vault's convention is wikilinks. */
export function extractLinks(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/\[\[([^\][|#\n]+)(?:#[^\][|\n]*)?(?:\|[^\][\n]*)?\]\]/g)) {
    const target = m[1].trim();
    if (target) out.push(target);
  }
  return out;
}

/** Inline #tags plus pre-normalized frontmatter tags, deduplicated, all #-prefixed. */
export function extractTags(content: string, fmTags: string[] = []): string[] {
  const out = new Set<string>(fmTags);
  for (const m of content.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_/-]+)/gmu)) out.add("#" + m[1]);
  return [...out];
}

/** Frontmatter `tags`/`tag` values (array or comma string) normalized to #-prefixed strings. */
export function fmTagList(fm: Record<string, unknown>): string[] {
  const raw = fm.tags ?? fm.tag;
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return arr.map((t) => "#" + String(t).trim().replace(/^#/, "")).filter((t) => t !== "#");
}

/**
 * Checkbox tasks by status: `[ ]` is open, any other status char ([x], [X],
 * [/], [-], ...) counts as done. ponytail: editing a task's text reads as
 * removed + added; custom statuses aren't distinguished from plain checks.
 */
export function extractTasks(content: string): { open: string[]; done: string[] } {
  const open: string[] = [];
  const done: string[] = [];
  for (const m of content.matchAll(/^[ \t]*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(\S.*)$/gm)) {
    (m[1] === " " ? open : done).push(clip(m[2]));
  }
  return { open, done };
}

export function extractHeadings(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*$/gm)) out.push(m[1]);
  return out;
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

const BOLD_RE = /(\*\*|__)(?!\s)[^\n]*?\1/g;

/** ponytail: naive emphasis counts; nested or ambiguous markup miscounts are acceptable. */
export function extractFormatting(content: string): { bold: number; italic: number } {
  const bold = (content.match(BOLD_RE) ?? []).length;
  const stripped = content.replace(BOLD_RE, "");
  const italic = (stripped.match(/([*_])(?!\s)[^\n*_]*?\1/g) ?? []).length;
  return { bold, italic };
}

/** One activation span: the file was in front of the user from start to t. */
export interface SpanEvent {
  t: number; // deactivation timestamp (ms epoch)
  path: string;
  start: number;
  dur: number;
  ctime?: number; // file creation time, the identity anchor for healing external renames
  /** The file this one was opened FROM via a clicked link — the user followed a connection. Absent = opened some other way. */
  from?: string;
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

export interface CreateEvent {
  t: number;
  type: "create";
  path: string;
}

/**
 * A file changed while NOT active in the editor: something other than the
 * user's typing wrote it (AI via MCP, sync, a script, another plugin).
 * Attribution to a specific agent is a future integration; the fact that
 * it happened is recorded now.
 */
export interface ExtModEvent {
  t: number;
  type: "extmod";
  path: string;
}

/**
 * Written once, the first time Contexts meets a file that predates its
 * record: the trail's floor. Counts only, never content — the vault holds
 * the substance; this just says how much was already there.
 */
export interface FirstSeenEvent {
  t: number;
  type: "firstseen";
  path: string;
  ctime?: number;
  counts: {
    words: number;
    links: number;
    tags: number;
    headings: number;
    highlights: number;
    footnotes: number;
    tasksOpen: number;
    tasksDone: number;
  };
  /** Identifiers, not content: what the file was already connected to when first seen. */
  links?: string[];
  tags?: string[];
}

export type LogEvent = SpanEvent | RenameEvent | DeleteEvent | CreateEvent | ExtModEvent | FirstSeenEvent;

/** Baseline counts from a snapshot (zeros for signals whose capture is off). */
export function firstSeenCounts(snap: Snapshot): FirstSeenEvent["counts"] {
  return {
    words: snap.words,
    links: snap.links.length,
    tags: snap.tags.length,
    headings: snap.headings.length,
    highlights: snap.highlights.length,
    footnotes: snap.footnotes.length,
    tasksOpen: snap.tasksOpen.length,
    tasksDone: snap.tasksDone.length,
  };
}

export function isSpan(ev: LogEvent): ev is SpanEvent {
  return !("type" in ev);
}

// ponytail: spans shorter than this are navigation flicks, not engagement.
// A span that changed the file is exempt: a one-second edit is still an edit.
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
  const [hAdded, hRemoved] = diffList(before.headings, after.headings);
  if (hAdded.length) delta.headingsAdded = hAdded.map(clip);
  if (hRemoved.length) delta.headingsRemoved = hRemoved.map(clip);
  if (!hAdded.length && !hRemoved.length && before.headings.join("\n") !== after.headings.join("\n")) {
    delta.headingsChanged = true; // pure reorder
  }
  const [hlAdded, hlRemoved] = diffList(before.highlights, after.highlights);
  if (hlAdded.length) delta.highlightsAdded = hlAdded;
  if (hlRemoved.length) delta.highlightsRemoved = hlRemoved;
  const [fnAdded, fnRemoved] = diffList(before.footnotes, after.footnotes);
  if (fnAdded.length) delta.footnotesAdded = fnAdded;
  if (fnRemoved.length) delta.footnotesRemoved = fnRemoved;
  const beforeAll = new Set([...before.tasksOpen, ...before.tasksDone]);
  const afterAll = new Set([...after.tasksOpen, ...after.tasksDone]);
  const openBefore = new Set(before.tasksOpen);
  const doneBefore = new Set(before.tasksDone);
  const tasksAdded = [...afterAll].filter((t) => !beforeAll.has(t));
  const tasksRemoved = [...beforeAll].filter((t) => !afterAll.has(t));
  const tasksCompleted = after.tasksDone.filter((t) => openBefore.has(t));
  const tasksReopened = after.tasksOpen.filter((t) => doneBefore.has(t));
  if (tasksAdded.length) delta.tasksAdded = tasksAdded;
  if (tasksCompleted.length) delta.tasksCompleted = tasksCompleted;
  if (tasksReopened.length) delta.tasksReopened = tasksReopened;
  if (tasksRemoved.length) delta.tasksRemoved = tasksRemoved;
  if (after.bold !== before.bold) delta.bold = after.bold - before.bold;
  if (after.italic !== before.italic) delta.italic = after.italic - before.italic;
  const fmChanged: Record<string, [string | null, string | null]> = {};
  for (const k of [...new Set([...Object.keys(before.fm), ...Object.keys(after.fm)])].sort()) {
    if (before.fm[k] !== after.fm[k]) {
      fmChanged[k] = [before.fm[k] != null ? clip(before.fm[k]) : null, after.fm[k] != null ? clip(after.fm[k]) : null];
    }
  }
  if (Object.keys(fmChanged).length) delta.fmChanged = fmChanged;
  return Object.keys(delta).length ? delta : undefined;
}

export class Recorder {
  private current: { path: string; start: number; snap: Snapshot; ctime?: number; from?: string } | null = null;

  get activePath(): string | null {
    return this.current?.path ?? null;
  }

  activate(path: string, snap: Snapshot, now: number, ctime?: number, from?: string): void {
    this.current = { path, start: now, snap, ctime, from };
  }

  /**
   * Close the open span. `after` is the file's state at deactivation, or null
   * when it can't be read (file deleted, plugin unloading in a hurry).
   * `end` defaults to now; an idle-close passes the last-activity time so
   * absent minutes are not credited as engagement.
   * Returns the event to log, or null if nothing was open or the span was
   * too short to count.
   */
  deactivate(after: Snapshot | null, end: number): SpanEvent | null {
    const cur = this.current;
    this.current = null;
    if (!cur) return null;
    const dur = end - cur.start;
    const edit = after ? diffSnapshots(cur.snap, after) : undefined;
    if (dur < MIN_SPAN_MS && !edit) return null;
    const ev: SpanEvent = { t: end, path: cur.path, start: cur.start, dur };
    if (cur.ctime !== undefined) ev.ctime = cur.ctime;
    if (cur.from !== undefined) ev.from = cur.from;
    if (edit) ev.edit = edit;
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
