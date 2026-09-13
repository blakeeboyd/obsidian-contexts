import { ItemView, Keymap, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { LogEvent, SpanEvent, isSpan } from "./recorder";
import type ContextsPlugin from "./main";
import { fmtClock, fmtDelta, fmtDur, relDay } from "./format";
import {
  Rope,
  SESSION_GAP_PX,
  applyRenames,
  assignContexts,
  buildTimeScale,
  contextRuns,
  excludeFolders,
  groupSessions,
  healRenames,
  invertX,
  scaleX,
  seamClaims,
} from "./views";

export const BRAID_VIEW_TYPE = "contexts-braid";

// Layout constants (pure scale constants live in views.ts).
const LANE_H = 20;
const HULL_PAD = 7;
const BAND_GAP = 26;
const HEADER_H = 26;
const ROPE_H = 18; // hull height at the ropes grain
const BEAD_R = 3.5;
const PILL_H = 7; // strand pill thickness (Notion bar weight)
// A band shows its face — the most-engaged files — and folds the tail
// behind "+K more". Every file in every context is a wall, not a view.
const FACE_LANES = 8;


/** Semantic zoom: ropes → strands → visits (groupSessions → per-rope strands → raw spans). */
export type Grain = "ropes" | "strands" | "visits";


// Context hulls cycle through Obsidian's extended palette; unassigned is gray.
const PALETTE = [
  "var(--color-blue)",
  "var(--color-purple)",
  "var(--color-green)",
  "var(--color-orange)",
  "var(--color-pink)",
  "var(--color-cyan)",
  "var(--color-yellow)",
  "var(--color-red)",
];
const UNASSIGNED_COLOR = "var(--text-faint)";

/**
 * The braid: the full-view trail visualization. Hull = context, strand =
 * file; reading is the strand's quiet run, acts are the beads on it.
 * Static SVG from the real log, re-rendered on every event.
 */
export class BraidView extends ItemView {
  private grain: Grain = "strands";
  private dragging = false;
  private renderQueued = false;
  // One shared styled hover card; SVG <title> gives the OS's slow unstyled tooltip.
  private tipEl: HTMLElement | null = null;
  // Horizontal position, kept across the re-renders every logged event triggers.
  private scrollX: number | null = null;
  // A thread: one file's presence in one context. Click selects; ⌘-click opens the file.
  private selected: { ctx: string; path: string } | null = null;
  // Bands the user has expanded past their face.
  private expandedBands = new Set<string>();
  // Horizontal zoom: multiplies the base px-per-minute. Buttons and ⌘/pinch-scroll.
  private zoom = 1;
  // Set when zooming: keep this time at this viewport x across the re-render.
  private anchor: { t: number; viewX: number } | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ContextsPlugin) {
    super(leaf);
  }

  private zoomScroll: HTMLElement | null = null;
  private zoomInvert: ((x: number) => number) | null = null;

  /** Zoom about an anchor: the time under `viewX` (viewport center when null) stays put. */
  private zoomBy(factor: number, viewX: number | null): void {
    const next = Math.min(16, Math.max(0.2, this.zoom * factor));
    if (next === this.zoom) return;
    if (this.zoomScroll && this.zoomInvert) {
      const vx = viewX ?? this.zoomScroll.clientWidth / 2;
      this.anchor = { t: this.zoomInvert(this.zoomScroll.scrollLeft + vx), viewX: vx };
    }
    this.zoom = next;
    void this.render();
  }

  /** Plain click selects the thread; ⌘-click opens the file (new tab, Obsidian convention). */
  private threadClick(evt: MouseEvent, ctx: string, path: string): void {
    if (Keymap.isModifier(evt, "Mod")) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
      return;
    }
    this.selected = this.selected?.ctx === ctx && this.selected.path === path ? null : { ctx, path };
    void this.render();
  }

  async onClose(): Promise<void> {
    this.tipEl?.remove();
    this.tipEl = null;
  }

  private tip(el: Element, text: string): void {
    el.addEventListener("pointerenter", (evt) => {
      const t = this.tipEl ?? (this.tipEl = document.body.createDiv({ cls: "contexts-braid-tip" }));
      t.setText(text);
      t.style.display = "block";
      this.moveTip(evt as PointerEvent);
    });
    el.addEventListener("pointermove", (evt) => this.moveTip(evt as PointerEvent));
    el.addEventListener("pointerleave", () => this.hideTip());
  }

  private hideTip(): void {
    if (this.tipEl) this.tipEl.style.display = "none";
  }

  private moveTip(evt: PointerEvent): void {
    if (!this.tipEl) return;
    const pad = 12;
    const w = this.tipEl.offsetWidth;
    let x = evt.clientX + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    this.tipEl.style.left = `${x}px`;
    this.tipEl.style.top = `${Math.min(evt.clientY + pad, window.innerHeight - this.tipEl.offsetHeight - 8)}px`;
  }

  getViewType(): string {
    return BRAID_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Context braid";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    if (this.dragging) {
      this.renderQueued = true;
      return;
    }
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("contexts-braid-view");
    this.hideTip(); // the elements holding its leave-listener are gone

    const header = contentEl.createDiv({ cls: "contexts-braid-header" });
    const seg = header.createDiv({ cls: "contexts-braid-seg" });
    for (const g of ["ropes", "strands", "visits"] as Grain[]) {
      const b = seg.createEl("button", { text: g[0].toUpperCase() + g.slice(1), cls: "contexts-braid-seg-btn" });
      if (g === this.grain) b.addClass("is-active");
      b.addEventListener("click", () => {
        this.grain = g;
        void this.render();
      });
    }
    const zoomWrap = header.createDiv({ cls: "contexts-braid-zoom" });
    const zoomBtn = (icon: string, label: string, factor: number) => {
      const b = zoomWrap.createEl("button", { cls: "contexts-braid-seg-btn" });
      setIcon(b, icon);
      b.setAttribute("aria-label", label);
      b.addEventListener("click", () => this.zoomBy(factor, null));
      return b;
    };
    zoomBtn("zoom-out", "Zoom out", 1 / 1.5);
    zoomBtn("zoom-in", "Zoom in", 1.5);
    header.createSpan({
      text: "click a strand for its thread · \u2318-click opens the file · drag a seam to move a boundary · \u2318-scroll zooms",
      cls: "contexts-braid-hint",
    });

    const s = this.plugin.settings;
    const gapMs = s.sessionGapMin * 60_000;
    const events = applyRenames(healRenames(await this.plugin.getEvents()));
    const relEvents = excludeFolders(events, s.excludedFolders);
    const sessions = groupSessions(relEvents, gapMs);
    if (!sessions.length) {
      contentEl.createDiv({ text: "Nothing recorded yet. Work in some notes and come back.", cls: "contexts-empty" });
      return;
    }
    const ctxOf = assignContexts(relEvents);
    const ropes = contextRuns(sessions, ctxOf);
    const pxPerMin = 3 * this.zoom;
    const ts = buildTimeScale(sessions, pxPerMin);
    const sx = (t: number) => scaleX(ts, t, pxPerMin);

    // Bands: one horizontal lane-group per context, in order of first
    // appearance, so a resumed context lines up with its own past.
    const bandOrder: string[] = [];
    for (const r of ropes) if (!bandOrder.includes(r.ctx)) bandOrder.push(r.ctx);
    // Lanes ranked by engaged time in the band; only the face gets lanes.
    const engaged = new Map<string, Map<string, number>>();
    for (const r of ropes) {
      let per = engaged.get(r.ctx);
      if (!per) engaged.set(r.ctx, (per = new Map()));
      for (const sp of r.spans) per.set(sp.path, (per.get(sp.path) ?? 0) + sp.dur);
    }
    const laneOf = new Map<string, Map<string, number>>();
    const hiddenCount = new Map<string, number>();
    for (const ctx of bandOrder) {
      const ranked = [...engaged.get(ctx)!.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
      const shown = this.expandedBands.has(ctx) ? ranked.slice() : ranked.slice(0, FACE_LANES);
      // The selected thread always keeps its lane, face or not.
      if (this.selected?.ctx === ctx && ranked.includes(this.selected.path) && !shown.includes(this.selected.path)) {
        shown.push(this.selected.path);
      }
      hiddenCount.set(ctx, ranked.length - shown.length);
      laneOf.set(ctx, new Map(shown.map((p, i) => [p, i])));
    }
    const bandY = new Map<string, number>();
    const bandH = new Map<string, number>();
    let y = HEADER_H;
    for (const ctx of bandOrder) {
      bandY.set(ctx, y);
      const foldRow = this.grain !== "ropes" && (hiddenCount.get(ctx)! > 0 || this.expandedBands.has(ctx)) ? LANE_H : 0;
      const h = this.grain === "ropes" ? ROPE_H : laneOf.get(ctx)!.size * LANE_H + HULL_PAD * 2 + foldRow;
      bandH.set(ctx, h);
      y += h + BAND_GAP;
    }
    const colorOf = (ctx: string) =>
      ctx === "" ? UNASSIGNED_COLOR : PALETTE[bandOrder.filter((c) => c !== "").indexOf(ctx) % PALETTE.length];
    const laneY = (ctx: string, path: string) =>
      (bandY.get(ctx) ?? 0) + HULL_PAD + (laneOf.get(ctx)?.get(path) ?? 0) * LANE_H + LANE_H / 2;

    // One scroll container for both axes; the rail sticks to the left edge
    // so row names stay pinned while the timeline scrolls (the left-rail
    // pattern every reference shares: Notion, Asana, Toggl). The thread
    // detail docks to the right of it.
    const main = contentEl.createDiv({ cls: "contexts-braid-main" });
    const scroll = main.createDiv({ cls: "contexts-braid-scroll" });
    scroll.addEventListener("scroll", () => (this.scrollX = scroll.scrollLeft));
    this.zoomScroll = scroll;
    this.zoomInvert = (x: number) => invertX(ts, x, pxPerMin);
    scroll.addEventListener(
      "wheel",
      (evt: WheelEvent) => {
        // Pinch arrives as ctrl+wheel; ⌘-wheel is the pointer-mouse spelling.
        if (!evt.ctrlKey && !evt.metaKey) return;
        evt.preventDefault();
        this.zoomBy(evt.deltaY < 0 ? 1.25 : 0.8, evt.clientX - scroll.getBoundingClientRect().left);
      },
      { passive: false }
    );
    const body = scroll.createDiv({ cls: "contexts-braid-body" });
    const rail = body.createDiv({ cls: "contexts-braid-rail" });
    rail.style.height = `${y}px`;
    for (const ctx of bandOrder) {
      const by = bandY.get(ctx)!;
      const bandRow = rail.createDiv({ cls: "contexts-braid-rail-band" });
      bandRow.style.top = `${by - 19}px`;
      bandRow.createSpan({ cls: "contexts-braid-rail-dot" }).style.background = colorOf(ctx);
      bandRow.createSpan({ text: ctx || "(no context)" });
      if (this.grain === "ropes") continue;
      for (const [path, lane] of laneOf.get(ctx)!) {
        const row = rail.createDiv({
          cls: "contexts-braid-rail-file",
          text: path.split("/").pop()?.replace(/\.md$/, "") ?? path,
        });
        if (this.selected?.ctx === ctx && this.selected.path === path) row.addClass("is-selected");
        row.style.top = `${by + HULL_PAD + lane * LANE_H}px`;
        this.tip(row, path);
        row.addEventListener("click", (evt) => this.threadClick(evt, ctx, path));
      }
      const hidden = hiddenCount.get(ctx)!;
      if (hidden > 0 || this.expandedBands.has(ctx)) {
        const fold = rail.createDiv({
          cls: "contexts-braid-rail-fold",
          text: hidden > 0 ? `+${hidden} more` : "show less",
        });
        fold.style.top = `${by + HULL_PAD + laneOf.get(ctx)!.size * LANE_H}px`;
        fold.addEventListener("click", () => {
          if (this.expandedBands.has(ctx)) this.expandedBands.delete(ctx);
          else this.expandedBands.add(ctx);
          void this.render();
        });
      }
    }
    const svg = body.createSvg("svg", {
      attr: { width: ts.width, height: y, viewBox: `0 0 ${ts.width} ${y}` },
      cls: "contexts-braid-svg",
    });

    const title = (el: Element, text: string) => this.tip(el, text);

    // Session headers, hairline hour grid (Notion-register ruler), separators.
    // One shared cursor keeps every ruler label (session and tick alike)
    // from overlapping its neighbor when short sessions crowd together.
    let lastLabelEnd = -Infinity;
    const rulerLabel = (x: number, text: string, cls: string): void => {
      if (x < lastLabelEnd + 8) return;
      const el = svg.createSvg("text", { attr: { x, y: HEADER_H - 10 }, cls });
      el.textContent = text;
      lastLabelEnd = x + text.length * 5.5;
    };
    ts.segs.forEach((seg, i) => {
      rulerLabel(seg.x0, `${relDay(seg.start)} ${fmtClock(seg.start)}`, "contexts-braid-session-label");
      const HOUR = 3600_000;
      for (let t = Math.ceil(seg.start / HOUR) * HOUR; t <= seg.end; t += HOUR) {
        const x = sx(t);
        svg.createSvg("line", {
          attr: { x1: x, y1: HEADER_H - 6, x2: x, y2: y },
          cls: "contexts-braid-grid",
        });
        rulerLabel(x + 3, fmtClock(t), "contexts-braid-tick-label");
      }
      if (i > 0) {
        svg.createSvg("line", {
          attr: { x1: seg.x0 - SESSION_GAP_PX / 2, y1: 0, x2: seg.x0 - SESSION_GAP_PX / 2, y2: y },
          cls: "contexts-braid-separator",
        });
      }
    });

    // Now: a red hairline with a dot at the top (Notion's today marker),
    // only while the record's edge is actually near the present.
    const now = Date.now();
    const lastSeg = ts.segs[ts.segs.length - 1];
    if (now <= lastSeg.end + gapMs) {
      const nx = sx(Math.min(now, lastSeg.end));
      svg.createSvg("line", { attr: { x1: nx, y1: HEADER_H - 4, x2: nx, y2: y }, cls: "contexts-braid-now" });
      svg.createSvg("circle", { attr: { cx: nx, cy: HEADER_H - 4, r: 2.5 }, cls: "contexts-braid-now-dot" });
    }

    // Hulls, one per rope; naming lives in the rail.
    for (const r of ropes) {
      const x0 = sx(r.start) - HULL_PAD;
      const x1 = sx(r.end) + HULL_PAD;
      const by = bandY.get(r.ctx)!;
      const bh = bandH.get(r.ctx)!;
      // Quiet hull: a background wash with no stroke — the context's color
      // lives in its identity dot and in the strand pills, not in the frame.
      const hull = svg.createSvg("rect", {
        attr: { x: x0, y: by, width: Math.max(x1 - x0, 8), height: bh, rx: 6 },
        cls: "contexts-braid-hull",
      });
      hull.style.fill = colorOf(r.ctx);
      const engaged = r.spans.reduce((sum, sp) => sum + sp.dur, 0);
      title(hull, `${r.ctx || "(no context)"} · ${fmtClock(r.start)} → ${fmtClock(r.end)} · ${fmtDur(engaged)} engaged`);
    }

    if (this.grain === "ropes") {
      // Outermost zoom: strands dissolve into hulls; edits remain as beads on the midline.
      for (const r of ropes) {
        const midY = bandY.get(r.ctx)! + ROPE_H / 2;
        for (const sp of r.spans) {
          if (!sp.edit) continue;
          const bead = svg.createSvg("circle", {
            attr: { cx: sx(sp.t), cy: midY, r: BEAD_R },
            cls: "contexts-braid-bead",
          });
          bead.style.fill = colorOf(r.ctx);
          title(bead, `${sp.path.split("/").pop()} · edited ${fmtClock(sp.t)}`);
        }
      }
    } else {
      // Strand segments: one quiet run per file per rope at the strands
      // grain, each visit separately at the visits grain.
      for (const r of ropes) {
        const byFile = new Map<string, SpanEvent[]>();
        for (const sp of r.spans) {
          let list = byFile.get(sp.path);
          if (!list) byFile.set(sp.path, (list = []));
          list.push(sp);
        }
        for (const [path, spans] of byFile) {
          if (!laneOf.get(r.ctx)?.has(path)) continue; // folded into "+K more"
          const cy = laneY(r.ctx, path);
          const segments = this.grain === "visits" ? spans.map((sp) => [sp.start, sp.t] as const) : [[spans[0].start, spans[spans.length - 1].t] as const];
          for (const [t0, t1] of segments) {
            // Thin tinted pill (Notion's bar weight), not a wire.
            const px0 = sx(t0);
            const pw = Math.max(sx(t1) - px0, 4);
            const pill = svg.createSvg("rect", {
              attr: { x: px0, y: cy - PILL_H / 2, width: pw, height: PILL_H, rx: PILL_H / 2 },
              cls: "contexts-braid-strand",
            });
            pill.style.fill = colorOf(r.ctx);
            pill.style.stroke = colorOf(r.ctx);
            if (this.selected?.ctx === r.ctx && this.selected.path === path) pill.addClass("is-selected");
            title(pill, `${path} · ${fmtClock(t0)} → ${fmtClock(t1)}`);
            pill.addEventListener("click", (evt) => this.threadClick(evt, r.ctx, path));
          }
          // Beads: edits. Junction rings: arrivals via a followed link.
          for (const sp of spans) {
            if (sp.via === "link") {
              const ring = svg.createSvg("circle", {
                attr: { cx: sx(sp.start), cy, r: BEAD_R + 1.5 },
                cls: "contexts-braid-ring",
              });
              ring.style.stroke = colorOf(r.ctx);
              title(ring, `arrived via link${sp.from ? ` from ${sp.from.split("/").pop()}` : ""}`);
            }
            if (sp.edit) {
              const bead = svg.createSvg("circle", {
                attr: { cx: sx(sp.t), cy, r: BEAD_R },
                cls: "contexts-braid-bead",
              });
              bead.style.fill = colorOf(r.ctx);
              title(bead, `edited · ${fmtClock(sp.t)}`);
            }
          }
        }
      }

      // Off-strand acts: external edits (red diamonds), peeks (dotted wisps),
      // waypoint notes (amber beads). Drawn when the containing rope has a
      // lane for the file. ponytail: acts outside any rope's time range are
      // not drawn; they stay in the pane trail.
      const ropeAt = (t: number) => ropes.find((r) => t >= r.start - gapMs / 2 && t <= r.end + gapMs / 2);
      for (const ev of relEvents) {
        if (isSpan(ev)) continue;
        if (ev.type === "extmod" || ev.type === "peek" || ev.type === "note") {
          const r = ropeAt(ev.t);
          if (!r) continue;
          const path = "path" in ev ? ev.path : undefined;
          const cx = sx(ev.t);
          if (ev.type === "note") {
            const cy = path && laneOf.get(r.ctx)?.has(path) ? laneY(r.ctx, path) : bandY.get(r.ctx)! + bandH.get(r.ctx)! / 2;
            const bead = svg.createSvg("rect", {
              attr: { x: cx - BEAD_R, y: cy - BEAD_R, width: BEAD_R * 2, height: BEAD_R * 2, rx: 1.5 },
              cls: "contexts-braid-note",
            });
            title(bead, `${ev.by ? `note by ${ev.by}` : "note"} · ${fmtClock(ev.t)} · ${ev.text}`);
          } else if (path && laneOf.get(r.ctx)?.has(path)) {
            const cy = laneY(r.ctx, path);
            if (ev.type === "extmod") {
              const d = BEAD_R + 1;
              const diamond = svg.createSvg("path", {
                attr: { d: `M ${cx} ${cy - d} L ${cx + d} ${cy} L ${cx} ${cy + d} L ${cx - d} ${cy} Z` },
                cls: "contexts-braid-extmod",
              });
              title(diamond, `${ev.by ? `edit by ${ev.by}` : "external edit"} · ${fmtClock(ev.t)}`);
            } else {
              const wisp = svg.createSvg("circle", {
                attr: { cx, cy, r: BEAD_R },
                cls: "contexts-braid-peek",
              });
              title(wisp, `previewed from ${ev.from.split("/").pop()} · ${fmtClock(ev.t)}`);
            }
          }
        }
      }
    }

    // Seams: the draggable boundary between adjacent ropes in one session.
    // Dropping the handle appends retroactive claims (seamClaims) and the
    // whole braid reassigns at read time.
    for (let i = 0; i < ropes.length - 1; i++) {
      const a = ropes[i];
      const b = ropes[i + 1];
      if (a.si !== b.si) continue;
      const yTop = Math.min(bandY.get(a.ctx)!, bandY.get(b.ctx)!);
      const yBot = Math.max(bandY.get(a.ctx)! + bandH.get(a.ctx)!, bandY.get(b.ctx)! + bandH.get(b.ctx)!);
      const seamX = (sx(a.end) + sx(b.start)) / 2;
      const line = svg.createSvg("line", {
        attr: { x1: seamX, y1: yTop - 4, x2: seamX, y2: yBot + 4 },
        cls: "contexts-braid-seam",
      });
      title(line, `seam: ${a.ctx || "(no context)"} → ${b.ctx || "(no context)"} — drag to move the boundary`);
      line.addEventListener("pointerdown", (evt: PointerEvent) => {
        evt.preventDefault();
        this.dragging = true;
        line.setPointerCapture(evt.pointerId);
        const startClientX = evt.clientX;
        const move = (mv: PointerEvent) => {
          const dx = mv.clientX - startClientX;
          line.setAttribute("x1", String(seamX + dx));
          line.setAttribute("x2", String(seamX + dx));
        };
        const up = (uv: PointerEvent) => {
          line.removeEventListener("pointermove", move);
          line.removeEventListener("pointerup", up);
          this.dragging = false;
          const newT = invertX(ts, seamX + (uv.clientX - startClientX), pxPerMin);
          const claims = seamClaims(a, b, newT);
          if (claims.length) this.plugin.retroDeclare(claims);
          else if (this.renderQueued) {
            this.renderQueued = false;
            void this.render();
          } else {
            line.setAttribute("x1", String(seamX));
            line.setAttribute("x2", String(seamX));
          }
        };
        line.addEventListener("pointermove", move);
        line.addEventListener("pointerup", up);
      });
    }

    if (this.selected) this.renderDetail(main, relEvents, ctxOf, colorOf(this.selected.ctx));

    // Open at the record's recent end (every reference opens at today);
    // afterwards the user's own scroll position survives re-renders, and a
    // zoom keeps its anchor time under the same viewport x.
    requestAnimationFrame(() => {
      if (this.anchor) {
        scroll.scrollLeft = sx(this.anchor.t) - this.anchor.viewX;
        this.scrollX = scroll.scrollLeft;
        this.anchor = null;
      } else {
        scroll.scrollLeft = this.scrollX ?? scroll.scrollWidth;
      }
    });
  }

  /**
   * The thread detail: one file's presence in one context, newest first —
   * every visit with its changes, plus the acts around it (notes, external
   * edits, previews, creation, first contact).
   */
  private renderDetail(main: HTMLElement, relEvents: LogEvent[], ctxOf: Map<SpanEvent, string>, color: string): void {
    const sel = this.selected!;
    const panel = main.createDiv({ cls: "contexts-braid-detail" });
    const head = panel.createDiv({ cls: "contexts-braid-detail-head" });
    const nameRow = head.createDiv({ cls: "contexts-braid-detail-name" });
    nameRow.createSpan({ text: sel.path.split("/").pop()?.replace(/\.md$/, "") ?? sel.path });
    const close = head.createDiv({ cls: "contexts-braid-detail-close" });
    setIcon(close, "x");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => {
      this.selected = null;
      void this.render();
    });
    const ctxRow = head.createDiv({ cls: "contexts-braid-detail-ctx" });
    ctxRow.createSpan({ cls: "contexts-braid-rail-dot" }).style.background = color;
    ctxRow.createSpan({ text: sel.ctx || "(no context)" });
    head.createDiv({ text: sel.path, cls: "contexts-braid-detail-path" });

    const spans = relEvents.filter(isSpan).filter((sp) => sp.path === sel.path && (ctxOf.get(sp) ?? "") === sel.ctx);
    const acts = relEvents.filter(
      (ev): ev is Exclude<LogEvent, SpanEvent> =>
        !isSpan(ev) &&
        "path" in ev &&
        ev.path === sel.path &&
        (ev.type === "note" || ev.type === "extmod" || ev.type === "peek" || ev.type === "create" || ev.type === "firstseen")
    );
    const engaged = spans.reduce((sum, sp) => sum + sp.dur, 0);
    const edits = spans.filter((sp) => sp.edit).length;
    head.createDiv({
      text: `${fmtDur(engaged)} engaged · ${spans.length} visit${spans.length === 1 ? "" : "s"} · ${edits} edit${edits === 1 ? "" : "s"}`,
      cls: "contexts-braid-detail-stats",
    });
    const openLink = head.createDiv({ text: "Open file", cls: "contexts-braid-detail-open" });
    openLink.addEventListener("click", (evt) => {
      const file = this.app.vault.getAbstractFileByPath(sel.path);
      if (file instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
    });

    const list = panel.createDiv({ cls: "contexts-braid-detail-list" });
    let lastDay = "";
    const dayHeaderFor = (t: number, container: HTMLElement) => {
      const d = relDay(t);
      if (d !== lastDay) {
        lastDay = d;
        container.createDiv({ text: d, cls: "contexts-braid-detail-day" });
      }
    };
    const items: { t: number; kind: "span" | "act"; span?: SpanEvent; act?: Exclude<LogEvent, SpanEvent> }[] = [
      ...spans.map((sp) => ({ t: sp.start, kind: "span" as const, span: sp })),
      ...acts.map((ev) => ({ t: ev.t, kind: "act" as const, act: ev })),
    ]
      .sort((a, b) => b.t - a.t)
      .slice(0, 80);
    if (!items.length) list.createDiv({ text: "No events in this thread.", cls: "contexts-empty" });
    for (const item of items) {
      dayHeaderFor(item.t, list);
      const row = list.createDiv({ cls: "contexts-braid-detail-row" });
      if (item.kind === "span" && item.span) {
        const sp = item.span;
        row.createSpan({ text: fmtClock(sp.start), cls: "contexts-braid-detail-time" });
        row.createSpan({ text: sp.edit ? "edited" : "read", cls: sp.edit ? "contexts-braid-detail-kind is-edit" : "contexts-braid-detail-kind" });
        row.createSpan({ text: fmtDur(sp.dur), cls: "contexts-braid-detail-dur" });
        if (sp.edit) row.createDiv({ text: fmtDelta(sp.edit), cls: "contexts-braid-detail-delta" });
        const meta: string[] = [];
        if (sp.via === "link" && sp.from) meta.push(`via link from ${sp.from.split("/").pop()?.replace(/\.md$/, "")}`);
        else if (sp.via) meta.push(`via ${sp.via}`);
        if (sp.section) meta.push(`§ ${sp.section}`);
        if (meta.length) row.createDiv({ text: meta.join(" · "), cls: "contexts-braid-detail-meta" });
      } else if (item.act) {
        const ev = item.act;
        row.createSpan({ text: fmtClock(ev.t), cls: "contexts-braid-detail-time" });
        const label =
          ev.type === "note" ? (ev.by ? `note (${ev.by})` : "note")
          : ev.type === "extmod" ? (ev.by ? `edit by ${ev.by}` : "external edit")
          : ev.type === "peek" ? "previewed"
          : ev.type === "create" ? (ev.by ? `created by ${ev.by}` : "created")
          : "first seen";
        row.createSpan({ text: label, cls: `contexts-braid-detail-kind is-${ev.type}` });
        if (ev.type === "note") row.createDiv({ text: ev.text, cls: "contexts-braid-detail-note" });
        if (ev.type === "extmod" && ev.edit) row.createDiv({ text: fmtDelta(ev.edit), cls: "contexts-braid-detail-delta" });
        if (ev.type === "peek") row.createDiv({ text: `from ${ev.from.split("/").pop()?.replace(/\.md$/, "")}`, cls: "contexts-braid-detail-meta" });
      }
    }
  }
}
