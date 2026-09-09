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
  embeds: string[];
  blockIds: string[];
  tags: string[];
  headings: string[];
  highlights: string[];
  footnotes: string[];
  tasksOpen: string[];
  tasksDone: string[];
  urls: string[];
  callouts: string[];
  comments: string[];
  struck: string[];
  codeLangs: string[];
  codeBlocks: number;
  math: number;
  tables: number;
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
  urlsAdded?: string[];
  urlsRemoved?: string[];
  embedsAdded?: string[];
  embedsRemoved?: string[];
  blockIdsAdded?: string[];
  blockIdsRemoved?: string[];
  calloutsAdded?: string[];
  calloutsRemoved?: string[];
  commentsAdded?: string[];
  commentsRemoved?: string[];
  struckAdded?: string[];
  struckRemoved?: string[];
  codeLangsAdded?: string[];
  codeLangsRemoved?: string[];
  codeBlocks?: number; // net count changes
  math?: number;
  tables?: number;
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

/**
 * Wikilink references at full precision: subpaths kept ([[Note#Heading]],
 * [[Note#^block]] — WHICH part was cited), embeds separated from links
 * (transclusion is incorporation, not mention). ponytail: markdown-style
 * [text](file.md) links are not parsed; this vault's convention is wikilinks.
 */
export function extractRefs(content: string): { links: string[]; embeds: string[] } {
  const links: string[] = [];
  const embeds: string[] = [];
  for (const m of content.matchAll(/(!)?\[\[([^\][|\n]+?)(?:\|[^\][\n]*)?\]\]/g)) {
    const target = m[2].trim();
    if (target) (m[1] ? embeds : links).push(target);
  }
  return { links, embeds };
}

/** Kept for callers that want every referenced target regardless of kind. */
export function extractLinks(content: string): string[] {
  const { links, embeds } = extractRefs(content);
  return [...links, ...embeds];
}

/** Callouts as "type: title" identifiers ([!question] Question 1 → "question: Question 1"). */
export function extractCallouts(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/^>\s*\[!([\w-]+)\][+-]?[ \t]*(.*)$/gm)) {
    out.push(clip(`${m[1].toLowerCase()}: ${m[2]}`.replace(/:\s*$/, "")));
  }
  return out;
}

/** Obsidian %%comments%% — private annotations, clipped like highlights. */
export function extractComments(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/%%([\s\S]*?)%%/g)) {
    const t = m[1].trim();
    if (t) out.push(clip(t));
  }
  return out;
}

/** ~~struck~~ text: striking is a judgment act, kin to task completion. */
export function extractStruck(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/~~([^~\n]+)~~/g)) out.push(clip(m[1]));
  return out;
}

/** Fenced code blocks: how many, and which languages appear. */
export function extractCode(content: string): { count: number; langs: string[] } {
  let count = 0;
  const langs = new Set<string>();
  let inFence = false;
  for (const line of content.split("\n")) {
    const m = line.match(/^[ \t]*(?:```|~~~)[ \t]*(\S*)/);
    if (!m) continue;
    if (!inFence) {
      count++;
      if (m[1]) langs.add(m[1].toLowerCase());
    }
    inFence = !inFence;
  }
  return { count, langs: [...langs] };
}

/** LaTeX math regions: $$blocks$$ plus $inline$. Net count only. */
export function countMath(content: string): number {
  const blocks = content.match(/\$\$[\s\S]+?\$\$/g) ?? [];
  const stripped = content.replace(/\$\$[\s\S]+?\$\$/g, "");
  const inline = stripped.match(/\$[^$\n]+\$/g) ?? [];
  return blocks.length + inline.length;
}

/** Markdown tables, counted by their separator rows. */
export function countTables(content: string): number {
  return (content.match(/^[ \t]*\|?[ \t:|-]*-[ \t:|-]*\|[ \t:|-]*$/gm) ?? []).length;
}

/** All-zero snapshot for files we track but never diff (canvas). */
export function emptySnapshot(): Snapshot {
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
    callouts: [],
    comments: [],
    struck: [],
    codeLangs: [],
    codeBlocks: 0,
    math: 0,
    tables: 0,
    bold: 0,
    italic: 0,
    fm: {},
  };
}

/**
 * The heading section containing a given line — section-grain attention.
 * ponytail: cursor-at-close is a proxy for where attention lived; per-span
 * section sampling with dwell times is the upgrade path.
 */
export function sectionAtLine(content: string, line: number): string | undefined {
  const lines = content.split("\n");
  for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
    const m = lines[i].match(/^#{1,6}[ \t]+(.+?)[ \t]*$/);
    if (m) return m[1];
  }
  return undefined;
}

/** Block IDs (^id ending a line): the moment a passage becomes citable. */
export function extractBlockIds(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/gm)) out.push(`^${m[1]}`);
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

/**
 * External URLs, wherever they appear: markdown links, autolinks, bare.
 * A pasted URL is a citation event — a resource brought into this thinking
 * at this moment. ponytail: URLs containing parens lose their tail.
 */
export function extractUrls(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/https?:\/\/[^\s)<>\]"']+/g)) out.add(clip(m[0]));
  return [...out];
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
  /** How the file was opened. Absent = untracked surface (ribbon, plugin, programmatic). */
  via?: OpenMethod;
  /** How the visit ended. "switch" = went to another file; "close" = tab closed; "blur" = left the app; plus idle/quit/pause. */
  left?: LeaveReason;
  /** Heading section the cursor was in when the visit ended — section-grain attention. */
  section?: string;
  edit?: EditDelta;
}

export type LeaveReason = "switch" | "close" | "blur" | "idle" | "quit" | "pause";
// ponytail: "switcher" is any SuggestModal selection — quick switcher in
// practice, but command-palette file opens land there too.
export type OpenMethod = "link" | "explorer" | "search" | "switcher";

export interface Opened {
  via: OpenMethod;
  from?: string; // only for via "link"
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
  /** Who created it, when announced via the plugin-write contract. Absent = the user (or an unannounced writer). */
  by?: string;
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
  /** Who wrote it, when the writer announced itself via the plugin-write contract (e.g. "vault-mcp"). Absent = anonymous. */
  by?: string;
  /**
   * What the external edit changed, diffed against the log's reconstructed
   * belief at write time. ponytail: links only — a full delta needs stored
   * per-file snapshots; links are reconstructible from the log alone.
   */
  edit?: EditDelta;
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

/**
 * The user judged two files unrelated despite their co-activation: direct
 * feedback, itself part of the behavioral record. Scoring demotes the pair
 * to near zero but tracking never stops. A later RelateEvent undoes it.
 */
export interface UnrelateEvent {
  t: number;
  type: "unrelate";
  a: string;
  b: string;
}

export interface RelateEvent {
  t: number;
  type: "relate";
  a: string;
  b: string;
}

/**
 * The user declared what they are doing: "from now on I'm in context <name>".
 * Empty name clears. Declaration captures the thing in the user's head that
 * action alone cannot reveal; spans are assigned to contexts at read time.
 */
export interface ContextEvent {
  t: number;
  type: "context";
  name: string;
  /** "guess" = the user confirmed the plugin's suggestion rather than declaring unprompted — calibration data for the guessing loop. */
  via?: "guess";
}

/**
 * A context was renamed: old name maps to new at read time, so anonymous
 * "context N" labels can be christened once a name becomes obvious. The log
 * keeps every declaration under the name in force when it was made; views
 * rewrite through the relabel chain.
 */
export interface RelabelEvent {
  t: number;
  type: "relabel";
  from: string;
  to: string;
}

export type LogEvent =
  | SpanEvent
  | RenameEvent
  | DeleteEvent
  | CreateEvent
  | ExtModEvent
  | FirstSeenEvent
  | UnrelateEvent
  | RelateEvent
  | ContextEvent
  | RelabelEvent;

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
  const [urlsAdded, urlsRemoved] = diffList(before.urls, after.urls);
  if (urlsAdded.length) delta.urlsAdded = urlsAdded;
  if (urlsRemoved.length) delta.urlsRemoved = urlsRemoved;
  const [embedsAdded, embedsRemoved] = diffList(before.embeds, after.embeds);
  if (embedsAdded.length) delta.embedsAdded = embedsAdded;
  if (embedsRemoved.length) delta.embedsRemoved = embedsRemoved;
  const [idsAdded, idsRemoved] = diffList(before.blockIds, after.blockIds);
  if (idsAdded.length) delta.blockIdsAdded = idsAdded;
  if (idsRemoved.length) delta.blockIdsRemoved = idsRemoved;
  const [coAdded, coRemoved] = diffList(before.callouts, after.callouts);
  if (coAdded.length) delta.calloutsAdded = coAdded;
  if (coRemoved.length) delta.calloutsRemoved = coRemoved;
  const [cmAdded, cmRemoved] = diffList(before.comments, after.comments);
  if (cmAdded.length) delta.commentsAdded = cmAdded;
  if (cmRemoved.length) delta.commentsRemoved = cmRemoved;
  const [stAdded, stRemoved] = diffList(before.struck, after.struck);
  if (stAdded.length) delta.struckAdded = stAdded;
  if (stRemoved.length) delta.struckRemoved = stRemoved;
  const [clAdded, clRemoved] = diffList(before.codeLangs, after.codeLangs);
  if (clAdded.length) delta.codeLangsAdded = clAdded;
  if (clRemoved.length) delta.codeLangsRemoved = clRemoved;
  for (const k of ["codeBlocks", "math", "tables"] as const) {
    if (after[k] !== before[k]) delta[k] = after[k] - before[k];
  }
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
  private current: { path: string; start: number; snap: Snapshot; ctime?: number; opened?: Opened } | null = null;

  get activePath(): string | null {
    return this.current?.path ?? null;
  }

  activate(path: string, snap: Snapshot, now: number, ctime?: number, opened?: Opened): void {
    this.current = { path, start: now, snap, ctime, opened };
  }

  /**
   * Close the open span. `after` is the file's state at deactivation, or null
   * when it can't be read (file deleted, plugin unloading in a hurry).
   * `end` defaults to now; an idle-close passes the last-activity time so
   * absent minutes are not credited as engagement.
   * Returns the event to log, or null if nothing was open or the span was
   * too short to count.
   */
  deactivate(after: Snapshot | null, end: number, left?: LeaveReason, section?: string): SpanEvent | null {
    const cur = this.current;
    this.current = null;
    if (!cur) return null;
    const dur = end - cur.start;
    const edit = after ? diffSnapshots(cur.snap, after) : undefined;
    // A short glance is droppable; a glance that edited OR arrived via a
    // followed link is behavior worth keeping.
    if (dur < MIN_SPAN_MS && !edit && cur.opened?.from === undefined) return null;
    const ev: SpanEvent = { t: end, path: cur.path, start: cur.start, dur };
    if (cur.ctime !== undefined) ev.ctime = cur.ctime;
    if (cur.opened) {
      ev.via = cur.opened.via;
      if (cur.opened.from !== undefined) ev.from = cur.opened.from;
    }
    if (left) ev.left = left;
    if (section) ev.section = section;
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
