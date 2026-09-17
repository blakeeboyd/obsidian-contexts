/**
 * The ```contexts``` code block (```contexts-day``` kept as a working alias):
 * a live rendering of a slice of the record, embedded in any note. A query,
 * not a document — nothing is written, nothing goes stale; the block
 * re-renders as events land. All properties optional:
 *
 *   view: map            # list | map            (default list; braid later)
 *   over: week           # session | today | yesterday | week | month | all
 *                        #   | 2026-09-14 | 2026-09-01..2026-09-14
 *   context: context 3   # filter; comma list; "none" = no context
 *   device: iPhone       # filter; user device names honored
 *   group: day           # grain override (session | day | week | month)
 *
 * ("over" names the time span shown; "pace" — the word the design session
 * used — is accepted as a silent alias, but pace is a rate, not a span.)
 * Bare block = one day, all contexts: in a note whose filename carries a
 * date, the NOTE's day (template blocks in daily notes work forever),
 * otherwise today. Relative words resolve at read time; date literals pin.
 * Interaction: hover cards, click-to-open, drag to pan, ⌘/ctrl-wheel or
 * pinch to zoom, double-click to refit; plain scroll stays with the note.
 * The corner "open in File Map" affordance is the door to the deep dive.
 * Provenance: Blake's codebox-mirror idea; Dataview's block-as-query pattern.
 */
import { MarkdownRenderChild, setIcon } from "obsidian";
import { fmtClock, fmtDelta, fmtDur, relDay } from "./format";
import type ContextsPlugin from "./main";
import { MAP_VIEW_TYPE, drawForest } from "./map";
import { HoverTip } from "./tip";
import {
  NavGroup,
  allSigils,
  applyErasures,
  applyRenames,
  assignContexts,
  buildNavForest,
  excludeFolders,
  groupSessions,
  healRenames,
  mergeDeltas,
} from "./views";
import { EditDelta, LogEvent, isSpan } from "./recorder";

const DAY_MS = 24 * 3600_000;

export interface BlockProps {
  view: "list" | "map";
  over: string | null;
  contexts: string[] | null;
  devices: string[] | null;
  group: NavGroup | null;
}

export function parseProps(source: string): BlockProps {
  const p: BlockProps = { view: "list", over: null, contexts: null, devices: null, group: null };
  const list = (val: string) =>
    val
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (!m) {
      // Legacy contexts-day body: a bare date line is the span.
      if (/^\d{4}-\d{2}-\d{2}/.test(line)) p.over = line;
      continue;
    }
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "view" && (val === "list" || val === "map")) p.view = val;
    else if (key === "over" || key === "pace") p.over = val;
    else if (key === "context") p.contexts = list(val);
    else if (key === "device") p.devices = list(val);
    else if (key === "group" && ["session", "day", "week", "month"].includes(val)) p.group = val as NavGroup;
  }
  return p;
}

/**
 * The span shown → time window + grain "one step down": today → session
 * trees, week → day trees, month → week trees, all → month trees.
 * Calendar-anchored to the note's day where a calendar unit is named.
 */
export function resolveOver(
  over: string | null,
  anchorDay: number,
  events: LogEvent[],
  gapMs: number
): { from?: number; to?: number; grain: NavGroup } {
  const dayEnd = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
  };
  const range = over?.match(/^(\d{4}-\d{2}-\d{2})\s*\.\.\s*(\d{4}-\d{2}-\d{2})$/);
  if (range) {
    const a = new Date(`${range[1]}T00:00:00`).getTime();
    const b = new Date(`${range[2]}T00:00:00`).getTime();
    return { from: Math.min(a, b), to: dayEnd(Math.max(a, b)), grain: "day" };
  }
  if (over && /^\d{4}-\d{2}-\d{2}$/.test(over)) {
    const a = new Date(`${over}T00:00:00`).getTime();
    return { from: a, to: dayEnd(a), grain: "session" };
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const a = new Date(anchorDay);
  switch (over) {
    case "session": {
      const sessions = groupSessions(events, gapMs);
      return { from: sessions.length ? sessions[sessions.length - 1].start : today, grain: "session" };
    }
    case "today":
      return { from: today, to: dayEnd(today), grain: "session" };
    case "yesterday": {
      const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime();
      return { from: y, to: dayEnd(y), grain: "session" };
    }
    case "week": {
      const mon = new Date(a.getFullYear(), a.getMonth(), a.getDate() - ((a.getDay() + 6) % 7));
      return {
        from: mon.getTime(),
        to: new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7).getTime() - 1,
        grain: "day",
      };
    }
    case "month":
      return {
        from: new Date(a.getFullYear(), a.getMonth(), 1).getTime(),
        to: new Date(a.getFullYear(), a.getMonth() + 1, 1).getTime() - 1,
        grain: "week",
      };
    case "all":
      return { grain: "month" };
    default:
      // Bare block: the note's day.
      return { from: anchorDay, to: dayEnd(anchorDay), grain: "session" };
  }
}

export class ContextsBlock extends MarkdownRenderChild {
  // Expanded session groups, keyed by session start; survives re-renders of this block.
  private openSessions = new Set<number>();
  // The user has panned/zoomed/clicked this block's map: the gesture hint retires.
  private mapTouched = false;
  private tips = new HoverTip();

  constructor(
    private plugin: ContextsPlugin,
    containerEl: HTMLElement,
    private source: string,
    private sourcePath: string
  ) {
    super(containerEl);
  }

  onload(): void {
    this.plugin.registerDayBlock(this);
    void this.render();
  }

  onunload(): void {
    this.plugin.unregisterDayBlock(this);
    this.tips.destroy();
  }

  /** The note's day (filename date) or today — the bare block's anchor. */
  private anchorDay(): number {
    const iso = this.sourcePath.split("/").pop()?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  async render(): Promise<void> {
    const el = this.containerEl;
    el.empty();
    el.addClass("contexts-pane", "contexts-day-block");
    const s = this.plugin.settings;
    const gapMs = s.sessionGapMin * 60_000;
    const props = parseProps(this.source);
    const events = applyErasures(applyRenames(healRenames(await this.plugin.getEvents())));

    // Device names honored, raw ids too.
    let deviceIds: Set<string> | null = null;
    if (props.devices) {
      deviceIds = new Set(
        props.devices.map(
          (name) =>
            Object.entries(s.deviceNames).find(([, label]) => label.toLowerCase() === name.toLowerCase())?.[0] ?? name
        )
      );
    }
    const devEvents = deviceIds
      ? events.filter((ev) => {
          if (isSpan(ev)) return deviceIds.has(ev.device ?? "");
          if ("type" in ev && (ev.type === "peek" || ev.type === "create")) return deviceIds.has(ev.device ?? "");
          return true;
        })
      : events;

    const ctxSet = props.contexts
      ? new Set(props.contexts.map((n) => (["none", "no context", "(no context)"].includes(n.toLowerCase()) ? "" : n)))
      : null;

    const win = resolveOver(props.over, this.anchorDay(), devEvents, gapMs);
    const grain = props.group ?? win.grain;

    if (props.view === "map" || ctxSet) {
      // Contexts only exist on the excluded-filtered stream.
      const relEvents = excludeFolders(devEvents, s.excludedFolders);
      if (props.view === "map") {
        this.renderMap(el, relEvents, win, grain, ctxSet);
        return;
      }
      const ctxOf = assignContexts(relEvents);
      this.renderList(el, relEvents.filter((ev) => !isSpan(ev) || ctxSet!.has(ctxOf.get(ev) ?? "")), win, gapMs);
      return;
    }
    // The plain list shows everything logged; exclusion only gates contexts.
    this.renderList(el, devEvents, win, gapMs);
  }

  /** The forest, drawn by the File Map's own core — same picture, minimal interaction. */
  private renderMap(
    el: HTMLElement,
    relEvents: LogEvent[],
    win: { from?: number; to?: number },
    grain: NavGroup,
    ctxSet: Set<string> | null
  ): void {
    const s = this.plugin.settings;
    const gapMs = s.sessionGapMin * 60_000;
    const scope: { from?: number; to?: number; ctx?: Set<string> } = { from: win.from, to: win.to };
    if (ctxSet) scope.ctx = ctxSet;
    // Chronological top-down: an embedded block reads like the note around it.
    const trees = buildNavForest(relEvents, scope, gapMs, grain);
    if (!trees.length) {
      el.createDiv({ text: "Nothing recorded here.", cls: "contexts-empty" });
      return;
    }
    const wrap = el.createDiv({ cls: "contexts-block-map" });
    const svg = wrap.createSvg("svg", { cls: ["contexts-map-svg", "contexts-block-map-svg"] });
    const drawing = drawForest({
      svg,
      trees,
      groupBy: grain,
      sigils: allSigils(relEvents),
      tips: this.tips,
      deviceLabel: (id) => this.plugin.deviceLabel(id),
      localDevice: this.plugin.localDeviceId(),
      currentPath: null,
      selected: null,
      compactReads: false,
      showEngagement: true,
      soloedSize: ctxSet?.size ?? 0,
      // No detail panel in a block: click opens the file, routed through
      // openLinkText so provenance capture sees the arrival.
      onNodeClick: (_evt, path) => void this.plugin.app.workspace.openLinkText(path, this.sourcePath),
    });
    // Auto-fit start, then drag to pan, ⌘/ctrl-wheel (and trackpad pinch) to
    // zoom about the cursor, double-click to refit. Plain scroll deliberately
    // stays with the NOTE — an embedded block must not hijack page scroll.
    const fit = drawing.fit;
    let vb = { ...fit };
    const apply = () => svg.setAttribute("viewBox", `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`);
    apply();
    svg.style.aspectRatio = `${fit.w} / ${fit.h}`;
    const toVB = (x: number, y: number): DOMPoint | null => {
      const m = svg.getScreenCTM();
      return m ? new DOMPoint(x, y).matrixTransform(m.inverse()) : null;
    };
    // The hint teaches the gestures once, in the quiet corner, and retires
    // at the first sign the user already knows (any real interaction).
    // Per-block-instance memory: it stays gone across live re-renders.
    let hint: HTMLElement | null = null;
    const touched = () => {
      if (this.mapTouched) return;
      this.mapTouched = true;
      hint?.addClass("is-hidden");
    };
    const zoomAt = (factor: number, cx: number | null, cy: number | null) => {
      // Same clamp as the File Map: 16x in, 2x out from fit.
      const w = Math.min(Math.max(vb.w / factor, fit.w / 16), fit.w * 2);
      if (w === vb.w) return;
      const rect = svg.getBoundingClientRect();
      const p = toVB(cx ?? rect.left + rect.width / 2, cy ?? rect.top + rect.height / 2);
      if (!p) return;
      const k = w / vb.w;
      vb = { x: p.x - (p.x - vb.x) * k, y: p.y - (p.y - vb.y) * k, w, h: vb.h * k };
      apply();
    };
    svg.addEventListener(
      "wheel",
      (evt: WheelEvent) => {
        if (!evt.ctrlKey && !evt.metaKey) return; // plain scroll belongs to the note
        evt.preventDefault();
        touched();
        zoomAt(Math.exp(-evt.deltaY * 0.004), evt.clientX, evt.clientY);
      },
      { passive: false }
    );
    svg.addEventListener("dblclick", () => {
      touched();
      vb = { ...fit };
      apply();
    });
    // Button 0 only, with pointercancel as safety release (a right-click's
    // pointerup is swallowed by the menu it opens).
    svg.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0 || evt.target !== svg) return;
      const grab = toVB(evt.clientX, evt.clientY);
      if (!grab) return;
      touched();
      svg.setPointerCapture(evt.pointerId);
      const move = (mv: PointerEvent) => {
        const p = toVB(mv.clientX, mv.clientY);
        if (!p) return;
        vb = { ...vb, x: vb.x + grab.x - p.x, y: vb.y + grab.y - p.y };
        apply();
      };
      const up = () => {
        svg.removeEventListener("pointermove", move);
        svg.removeEventListener("pointerup", up);
        svg.removeEventListener("pointercancel", up);
      };
      svg.addEventListener("pointermove", move);
      svg.addEventListener("pointerup", up);
      svg.addEventListener("pointercancel", up);
    });
    // Zoom cluster bottom-left, mirroring the File Map header's buttons.
    // stopPropagation everywhere: a click must not also drop the cursor
    // into the block's source (Live Preview).
    const zoomWrap = wrap.createDiv({ cls: "contexts-block-zoom" });
    const zoomBtn = (icon: string, label: string, onClick: () => void) => {
      const b = zoomWrap.createEl("button", { cls: "clickable-icon" });
      setIcon(b, icon);
      b.setAttribute("aria-label", label);
      b.addEventListener("mousedown", (evt) => evt.stopPropagation());
      b.addEventListener("click", (evt) => {
        evt.stopPropagation();
        touched();
        onClick();
      });
    };
    zoomBtn("zoom-out", "Zoom out", () => zoomAt(1 / 1.5, null, null));
    zoomBtn("zoom-in", "Zoom in", () => zoomAt(1.5, null, null));
    zoomBtn("maximize", "Fit", () => {
      vb = { ...fit };
      apply();
    });
    if (!this.mapTouched) {
      hint = wrap.createDiv({
        cls: "contexts-block-hint",
        text: "drag to pan · ⌘-scroll to zoom · double-click to fit · click a note to open",
      });
    }
    // Bottom-right, away from Live Preview's own edit-block pencil at the
    // top-right; stopPropagation keeps the click from also dropping the
    // cursor into the block's source.
    const openBtn = wrap.createDiv({ cls: "contexts-block-open" });
    setIcon(openBtn, "waypoints");
    openBtn.setAttribute("aria-label", "Open in File Map");
    openBtn.addEventListener("mousedown", (evt) => evt.stopPropagation());
    openBtn.addEventListener("click", (evt) => {
      evt.stopPropagation();
      void this.plugin.activateFullView(MAP_VIEW_TYPE);
    });
  }

  /** The session list, the original contexts-day picture, over any window. */
  private renderList(el: HTMLElement, events: LogEvent[], win: { from?: number; to?: number }, gapMs: number): void {
    const winEvents = events.filter(
      (ev) => (win.from === undefined || ev.t >= win.from) && (win.to === undefined || ev.t <= win.to)
    );
    if (!winEvents.length) {
      el.createDiv({ text: "Nothing recorded here.", cls: "contexts-empty" });
      return;
    }

    const sessions = groupSessions(winEvents, gapMs);
    const engagedTotal = sessions.reduce((sum, x) => sum + x.spans.reduce((a, sp) => a + sp.dur, 0), 0);
    const files = new Set(winEvents.filter(isSpan).map((sp) => sp.path));
    el.createDiv({
      text: `${fmtDur(engagedTotal)} engaged · ${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${files.size} file${files.size === 1 ? "" : "s"}${(() => {
        const n = winEvents.filter((ev) => "type" in ev && ev.type === "context").length;
        return n ? ` · ${n} context switch${n === 1 ? "" : "es"}` : "";
      })()}`,
      cls: "contexts-title",
    });

    // Windows longer than a day date their session headers.
    const multiDay = win.from === undefined || win.to === undefined || win.to - win.from > DAY_MS;
    for (const sess of sessions) {
      const engaged = sess.spans.reduce((sum, sp) => sum + sp.dur, 0);
      const open = this.openSessions.has(sess.start);
      const header = el.createDiv({ cls: "contexts-section contexts-expandable contexts-session-header" });
      const caret = header.createSpan({ cls: "contexts-chip-icon" });
      setIcon(caret, open ? "chevron-down" : "chevron-right");
      header.createSpan({
        text: `${multiDay ? `${relDay(sess.start)} · ` : ""}${fmtClock(sess.start)} → ${fmtClock(sess.end)} · ${fmtDur(engaged)} · ${sess.files.length} file${sess.files.length === 1 ? "" : "s"}`,
      });
      const list = el.createDiv();
      list.hidden = !open;
      header.addEventListener("click", () => {
        const nowOpen = list.hidden;
        list.hidden = !nowOpen;
        if (nowOpen) this.openSessions.add(sess.start);
        else this.openSessions.delete(sess.start);
        setIcon(caret, nowOpen ? "chevron-down" : "chevron-right");
      });
      for (const f of sess.files) {
        const spans = sess.spans.filter((sp) => sp.path === f);
        const dur = spans.reduce((sum, sp) => sum + sp.dur, 0);
        const edit = mergeDeltas(spans.map((sp) => sp.edit).filter((e): e is EditDelta => !!e));
        const row = list.createDiv({ cls: "contexts-row" });
        if (!this.plugin.app.vault.getAbstractFileByPath(f)) row.addClass("contexts-gone");
        row.createDiv({ text: f.split("/").pop()?.replace(/\.md$/, "") ?? f, cls: "contexts-row-title" });
        const meta = row.createDiv({ cls: "contexts-row-meta contexts-row-metaline" });
        meta.createSpan({
          text: `${fmtDur(dur)} · ${spans.length} visit${spans.length === 1 ? "" : "s"}`,
          cls: "contexts-row-folder",
        });
        if (edit) meta.createSpan({ text: fmtDelta(edit), cls: "contexts-row-when" });
        row.setAttribute("aria-label", f);
        // Opening from the block IS a link interaction: route through
        // openLinkText so provenance capture sees it.
        row.addEventListener("click", () => {
          void this.plugin.app.workspace.openLinkText(f, this.sourcePath);
        });
      }
    }
  }
}
