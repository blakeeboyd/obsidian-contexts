/**
 * Derived views: everything the plugin knows beyond the raw log is computed
 * here, as pure functions over event arrays. Nothing in this file is
 * persisted; change a parameter and every view rebuilds from the log.
 */
import { LogEvent, SpanEvent, isSpan } from "./recorder";

export const DEFAULT_SESSION_GAP_MS = 30 * 60_000;
export const DEFAULT_HALF_LIFE_MS = 30 * 24 * 3600_000;

/**
 * Rewrite span/delete paths to each file's final name so a whole trail keys
 * on one path. A chronological identity pass handles chains (A→B→C),
 * rename-backs (A→B, B→A), and reuse of a renamed-away path by a new file:
 * each event is tagged with the identity live at its path at that moment,
 * then written out under that identity's last known name.
 */
export function applyRenames(events: LogEvent[]): LogEvent[] {
  if (!events.some((ev) => "type" in ev && ev.type === "rename")) return events;
  const liveId = new Map<string, number>();
  const nameOf = new Map<number, string>();
  let nextId = 0;
  const idAt = (path: string): number => {
    let id = liveId.get(path);
    if (id === undefined) {
      id = nextId++;
      liveId.set(path, id);
      nameOf.set(id, path);
    }
    return id;
  };
  const eventIds: (number | null)[] = events.map((ev) => {
    if (isSpan(ev) || ev.type === "create" || ev.type === "extmod") return idAt(ev.path);
    if (ev.type === "rename") {
      const id = idAt(ev.from);
      liveId.delete(ev.from);
      liveId.set(ev.to, id);
      nameOf.set(id, ev.to);
      return null;
    }
    const id = idAt(ev.path); // delete: tag it, then free the path for reuse
    liveId.delete(ev.path);
    return id;
  });
  return events.map((ev, i) => {
    const id = eventIds[i];
    if (id === null) return ev;
    const path = nameOf.get(id)!;
    return path === (ev as Exclude<LogEvent, { type: "rename" }>).path ? ev : { ...ev, path };
  });
}

export interface Session {
  start: number;
  end: number;
  spans: SpanEvent[];
  files: string[]; // unique paths, in first-touched order
}

/** Group spans into sessions: a gap longer than gapMs between spans starts a new one. */
export function groupSessions(events: LogEvent[], gapMs = DEFAULT_SESSION_GAP_MS): Session[] {
  const spans = events.filter(isSpan).slice().sort((a, b) => a.start - b.start);
  const sessions: Session[] = [];
  for (const span of spans) {
    const cur = sessions[sessions.length - 1];
    if (cur && span.start - cur.end <= gapMs) {
      cur.spans.push(span);
      cur.end = Math.max(cur.end, span.t);
    } else {
      sessions.push({ start: span.start, end: span.t, spans: [span], files: [] });
    }
  }
  for (const s of sessions) {
    const seen = new Set<string>();
    for (const span of s.spans) {
      if (!seen.has(span.path)) {
        seen.add(span.path);
        s.files.push(span.path);
      }
    }
  }
  return sessions;
}

export interface RelatedFile {
  path: string;
  score: number;
  sharedSessions: number;
  lastAt: number; // end of the most recent shared session
}

/**
 * Files that co-activate with `path`, ranked by an exponentially decayed sum
 * over shared sessions: recent companionship outweighs old, but old never
 * quite vanishes.
 */
export function relatedTo(
  path: string,
  sessions: Session[],
  now: number,
  halfLifeMs = DEFAULT_HALF_LIFE_MS
): RelatedFile[] {
  const acc = new Map<string, RelatedFile>();
  for (const s of sessions) {
    if (!s.files.includes(path)) continue;
    const weight = Math.pow(0.5, (now - s.end) / halfLifeMs);
    for (const f of s.files) {
      if (f === path) continue;
      const entry = acc.get(f) ?? { path: f, score: 0, sharedSessions: 0, lastAt: 0 };
      entry.score += weight;
      entry.sharedSessions += 1;
      entry.lastAt = Math.max(entry.lastAt, s.end);
      acc.set(f, entry);
    }
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/** A single file's history: spans, creation, external edits, deletion (paths pre-resolved via applyRenames). */
export function trailFor(path: string, events: LogEvent[]): LogEvent[] {
  return events.filter((ev) => "path" in ev && ev.path === path);
}
