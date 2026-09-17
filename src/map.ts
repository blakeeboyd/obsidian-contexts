import { App, ItemView, Keymap, Menu, Modal, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { isSpan } from "./recorder";
import type { LogEvent } from "./recorder";
import type ContextsPlugin from "./main";
import { PALETTE, UNASSIGNED_COLOR } from "./braid";
import { fmtClock, fmtDur, relDay } from "./format";
import { HoverTip } from "./tip";
import {
  NAV_H_GAP,
  NAV_ROW_H,
  NavGroup,
  NavNode,
  NavTree,
  allSigils,
  applyErasures,
  applyRenames,
  assignContexts,
  buildNavForest,
  contextFileSets,
  contextNames,
  contextRuns,
  currentContext,
  excludeFolders,
  fileContexts,
  groupSessions,
  guessContext,
  healRenames,
  layoutNavTree,
  localDay,
  pairKey,
  topFiles,
} from "./views";

export const MAP_VIEW_TYPE = "contexts-map";

/** Scope: which TIME slice the map draws. Context filtering is the rail's solo, which composes with any of these. */
type MapScope = "session" | "day" | "range" | "all";
const SCOPES: { key: MapScope; label: string }[] = [
  { key: "session", label: "Session" },
  { key: "day", label: "Today" },
  { key: "range", label: "Range" },
  { key: "all", label: "All" },
];

/**
 * The range picker: start and end day, offered ONLY from days that actually
 * hold recorded activity — a calendar full of dead days would be noise.
 */
class RangeModal extends Modal {
  constructor(
    app: App,
    private days: number[], // local-midnight timestamps of active days, ascending
    private initial: { from: number; to: number } | null,
    private onPick: (from: number, to: number) => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Show activity between");
    const fmt = (t: number) =>
      new Date(t).toLocaleDateString(undefined, { weekday: "short", month: "numeric", day: "numeric", year: "2-digit" });
    const mk = (label: string, value: number) => {
      const row = this.contentEl.createDiv({ cls: "contexts-map-range-row" });
      row.createSpan({ text: label });
      const sel = row.createEl("select", { cls: "contexts-map-select" });
      for (const day of this.days) sel.createEl("option", { text: fmt(day), value: String(day) });
      sel.value = String(value);
      return sel;
    };
    const start = mk("From", this.initial?.from ?? this.days[0]);
    const end = mk("To", this.initial ? this.initial.to : this.days[this.days.length - 1]);
    const btn = this.contentEl.createEl("button", { text: "Show", cls: "mod-cta" });
    btn.addEventListener("click", () => {
      const a = Number(start.value);
      const b = Number(end.value);
      this.close();
      this.onPick(Math.min(a, b), Math.max(a, b));
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

const LEFT_X = 110; // room for session labels left of each root
const TREE_GAP = 56;
const NODE_H = 24;
const MAX_LABEL_W = 180;

/**
 * The file map: how the user moved through the work. One tree per
 * session, rooted at the session's first note, children in visit order —
 * what was opened from where, what was written (edited files read bold),
 * with the trail to the current file lit in the accent color. Secondary
 * arrivals and peeks are the quiet cross-curves.
 */
export class MapView extends ItemView {
  private mapScope: MapScope = "day";
  // The solo rail's view filter: which contexts to SEE ("" = no context).
  // Ephemeral by design — a lens, not a setting. If the same set gets soloed
  // daily, that's the endeavors signal; notice it, don't pre-build it.
  private soloed = new Set<string>();
  private railOpen = true;
  // The most recent session reads first: today's map starts with now.
  private newestFirst = true;
  // Tree granularity: a tree per inferred session, per day, or per week.
  // Day is the default: the map's founding image is the day's movement.
  private groupBy: NavGroup = "day";
  // Declutter: read-only LEAVES shrink to unlabeled dots. Hiding them would
  // lie about the path (children would hang from a step never taken), and a
  // read-only file that led somewhere is a waypoint that keeps its label —
  // the clutter is labels on drive-by leaves, not reading itself.
  private compactReads = false;
  // Engagement wash: each pill tinted its context color, deeper with more
  // engaged time, so the worked-in files catch the eye first.
  private showEngagement = true;
  // Range scope: chosen start/end days (local midnights), from the picker.
  private range: { from: number; to: number } | null = null;
  // Device filter: null = all devices (the default and the merged truth).
  private deviceFilter: string | null = null;
  private selected: string | null = null;
  private tips = new HoverTip();
  private svgEl: SVGSVGElement | null = null;
  // Auto-fit bounds; the untouched view tracks them.
  private fitVB = { x: 0, y: -30, w: 400, h: 200 };
  // A zoom or pan freezes the viewport here (kept across re-renders); Fit clears it.
  private manualVB: { x: number; y: number; w: number; h: number } | null = null;

  constructor(leaf: WorkspaceLeaf, private plugin: ContextsPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return MAP_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "File map";
  }

  getIcon(): string {
    return "waypoints";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    this.tips.destroy();
  }

  /** Plain click selects the node; ⌘-click opens the file (Obsidian convention, same as the braid). */
  private nodeClick(evt: MouseEvent, path: string): void {
    if (Keymap.isModifier(evt, "Mod")) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        this.plugin.noteUiOpen("map"); // the record should know arrivals from the map
        void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
      }
      return;
    }
    this.selected = this.selected === path ? null : path;
    void this.render();
  }

  private applyVB(): void {
    const vb = this.manualVB ?? this.fitVB;
    this.svgEl?.setAttribute("viewBox", `${vb.x.toFixed(1)} ${vb.y.toFixed(1)} ${vb.w.toFixed(1)} ${vb.h.toFixed(1)}`);
  }

  /** Client px → viewBox coordinates (getScreenCTM handles the meet letterboxing). */
  private clientToVB(x: number, y: number): DOMPoint | null {
    const m = this.svgEl?.getScreenCTM();
    return m ? new DOMPoint(x, y).matrixTransform(m.inverse()) : null;
  }

  /** Zoom about an anchor: the point under the cursor (viewport center when null) stays put. */
  private zoomBy(factor: number, clientX: number | null, clientY: number | null): void {
    const svg = this.svgEl;
    if (!svg) return;
    const cur = this.manualVB ?? this.fitVB;
    // Clamp relative to fit: 16x in, 2x out — beyond fit there is only void.
    const w = Math.min(Math.max(cur.w / factor, this.fitVB.w / 16), this.fitVB.w * 2);
    if (w === cur.w) return;
    const rect = svg.getBoundingClientRect();
    const p = this.clientToVB(clientX ?? rect.left + rect.width / 2, clientY ?? rect.top + rect.height / 2);
    if (!p) return;
    const k = w / cur.w;
    this.manualVB = { x: p.x - (p.x - cur.x) * k, y: p.y - (p.y - cur.y) * k, w, h: cur.h * k };
    this.applyVB();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("contexts-braid-view");
    this.tips.hide();

    const s = this.plugin.settings;
    const gapMs = s.sessionGapMin * 60_000;
    const events = applyErasures(applyRenames(healRenames(await this.plugin.getEvents())));
    const relEvents = excludeFolders(events, s.excludedFolders);
    const names = contextNames(relEvents);

    // Header: scope control in the braid's segmented register.
    const header = contentEl.createDiv({ cls: "contexts-braid-header" });
    const seg = header.createDiv({ cls: "contexts-braid-seg" });
    // Days that actually hold activity, for the range picker.
    const activeDays = [...new Set(relEvents.filter(isSpan).map((sp) => localDay(sp.start)))].sort((a, b) => a - b);
    for (const { key, label } of SCOPES) {
      const b = seg.createEl("button", { text: label, cls: "contexts-braid-seg-btn" });
      if (key === this.mapScope) b.addClass("is-active");
      b.addEventListener("click", () => {
        if (key === "range") {
          // Range always goes through the picker; clicking again re-opens it.
          if (!activeDays.length) return;
          new RangeModal(this.app, activeDays, this.range, (from, to) => {
            this.range = { from, to };
            this.mapScope = "range";
            this.manualVB = null;
            void this.render();
          }).open();
          return;
        }
        this.mapScope = key;
        this.manualVB = null; // a new scope is a new picture; refit
        void this.render();
      });
    }
    const railBtn = header.createEl("button", { cls: "contexts-braid-seg-btn" });
    setIcon(railBtn, "panel-left");
    railBtn.setAttribute("aria-label", this.railOpen ? "Hide context rail" : "Show context rail");
    if (this.railOpen) railBtn.addClass("is-active");
    railBtn.addEventListener("click", () => {
      this.railOpen = !this.railOpen;
      void this.render();
    });
    const zoomWrap = header.createDiv({ cls: "contexts-braid-zoom" });
    const zoomBtn = (icon: string, label: string, onClick: () => void) => {
      const b = zoomWrap.createEl("button", { cls: "contexts-braid-seg-btn" });
      setIcon(b, icon);
      b.setAttribute("aria-label", label);
      b.addEventListener("click", onClick);
    };
    zoomBtn("zoom-out", "Zoom out", () => this.zoomBy(1 / 1.5, null, null));
    zoomBtn("zoom-in", "Zoom in", () => this.zoomBy(1.5, null, null));
    zoomBtn("maximize", "Fit", () => {
      this.manualVB = null;
      this.applyVB();
    });
    const orderBtn = header.createEl("button", { cls: "contexts-braid-seg-btn contexts-map-order" });
    setIcon(orderBtn, this.newestFirst ? "arrow-down-wide-narrow" : "arrow-up-narrow-wide");
    orderBtn.setAttribute("aria-label", "Grouping and order");
    // Devices seen in the record, for the filter (shown only when plural).
    const deviceIds = [...new Set(relEvents.filter(isSpan).map((sp) => sp.device).filter((d): d is string => !!d))];
    orderBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
      if (deviceIds.length > 1) {
        const dev = (label: string, id: string | null) =>
          menu.addItem((i) =>
            i
              .setTitle(label)
              .setChecked(this.deviceFilter === id)
              .onClick(() => {
                if (this.deviceFilter === id) return;
                this.deviceFilter = id;
                this.manualVB = null;
                void this.render();
              })
          );
        dev("All devices", null);
        for (const id of deviceIds) dev(this.plugin.deviceLabel(id), id);
        menu.addSeparator();
      }
      const group = (label: string, g: NavGroup) =>
        menu.addItem((i) =>
          i
            .setTitle(label)
            .setChecked(this.groupBy === g)
            .onClick(() => {
              if (this.groupBy === g) return;
              this.groupBy = g;
              this.manualVB = null; // a new grain is a new picture; refit
              void this.render();
            })
        );
      group("A tree per session", "session");
      group("A tree per day", "day");
      group("A tree per week", "week");
      group("A tree per month", "month");
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Show engagement")
          .setChecked(this.showEngagement)
          .onClick(() => {
            this.showEngagement = !this.showEngagement;
            void this.render();
          })
      );
      menu.addItem((i) =>
        i
          .setTitle("Compact brief and read-only visits")
          .setChecked(this.compactReads)
          .onClick(() => {
            this.compactReads = !this.compactReads;
            this.manualVB = null;
            void this.render();
          })
      );
      menu.addSeparator();
      const pick = (label: string, newest: boolean) =>
        menu.addItem((i) =>
          i
            .setTitle(label)
            .setChecked(this.newestFirst === newest)
            .onClick(() => {
              if (this.newestFirst === newest) return;
              this.newestFirst = newest;
              this.manualVB = null; // the stack reordered; refit
              void this.render();
            })
        );
      pick("Newest first", true);
      pick("Oldest first", false);
      menu.showAtMouseEvent(evt);
    });
    header.createSpan({
      // An active device filter announces itself; a silent filter reads as missing data.
      text: `${this.deviceFilter ? `${this.plugin.deviceLabel(this.deviceFilter)} only · ` : ""}click a note for its detail · ⌘-click opens it · ⌘-scroll zooms · drag pans`,
      cls: "contexts-braid-hint",
    });

    // The device filter drops behavioral events (visits, peeks, creates)
    // from other devices; structural events (declarations, corrections,
    // renames) always apply — they're judgments about the vault, not acts
    // on a particular machine.
    const mapEvents = this.deviceFilter
      ? relEvents.filter((ev) => {
          if (isSpan(ev)) return ev.device === this.deviceFilter;
          if ("type" in ev && (ev.type === "peek" || ev.type === "create")) return ev.device === this.deviceFilter;
          return true;
        })
      : relEvents;
    const scopeArg: { from?: number; to?: number; ctx?: Set<string> } = {};
    if (this.mapScope === "session") {
      const sessions = groupSessions(mapEvents, gapMs);
      if (sessions.length) scopeArg.from = sessions[sessions.length - 1].start;
    } else if (this.mapScope === "day") scopeArg.from = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    else if (this.mapScope === "range" && this.range) {
      scopeArg.from = this.range.from;
      // End day inclusive: up to the local midnight after it.
      const d = new Date(this.range.to);
      scopeArg.to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
    }
    // Solo composes with any time scope: the soloed set is what you SEE.
    // A soloed name renamed or merged away is pruned, not left to blank the map.
    for (const n of this.soloed) if (n && !names.includes(n)) this.soloed.delete(n);
    if (this.soloed.size) scopeArg.ctx = new Set(this.soloed);
    const trees = buildNavForest(mapEvents, scopeArg, gapMs, this.groupBy);
    if (this.newestFirst) trees.reverse();

    const colorOf = makeColorOf(relEvents, gapMs);
    // Sigil where the color dot sits, color kept as reinforcement (symbol
    // sigils take the context color as fill; emoji carry their own).
    const sigils = allSigils(relEvents);

    // The rail renders before the empty check: with a solo active and no
    // matching work, the way back to all is the rail itself.
    const main = contentEl.createDiv({ cls: "contexts-braid-main" });
    if (this.railOpen) this.renderRail(main, relEvents, mapEvents, scopeArg, colorOf, sigils);
    if (!trees.length) {
      main.createDiv({ text: "Nothing in this scope yet. Work in some notes and come back.", cls: "contexts-empty" });
      return;
    }

    const svg = main.createSvg("svg", { cls: "contexts-map-svg" });
    this.svgEl = svg;
    let panned = false;
    svg.addEventListener("click", (evt) => {
      if (evt.target === svg && this.selected && !panned) {
        this.selected = null;
        void this.render();
      }
    });
    svg.addEventListener(
      "wheel",
      (evt: WheelEvent) => {
        evt.preventDefault();
        if (evt.ctrlKey || evt.metaKey) {
          // Pinch arrives as ctrl+wheel; ⌘-wheel is the pointer-mouse
          // spelling. Continuous: the factor follows the actual delta, so a
          // gentle pinch zooms gently and a wheel notch stays moderate.
          this.zoomBy(Math.exp(-evt.deltaY * 0.004), evt.clientX, evt.clientY);
          return;
        }
        // Plain two-finger scroll pans the canvas, in viewBox units.
        const cur = this.manualVB ?? (this.manualVB = { ...this.fitVB });
        const scale = cur.w / svg.clientWidth;
        cur.x += evt.deltaX * scale;
        cur.y += evt.deltaY * scale;
        this.applyVB();
      },
      { passive: false }
    );
    // Background drag pans. Keeping the grabbed point under the cursor each
    // move makes the pan exact at any zoom; a pan freezes the auto-fit.
    svg.addEventListener("pointerdown", (evt: PointerEvent) => {
      if (evt.button !== 0 || evt.target !== svg) return;
      const grab = this.clientToVB(evt.clientX, evt.clientY);
      if (!grab) return;
      panned = false;
      svg.setPointerCapture(evt.pointerId);
      const move = (mv: PointerEvent) => {
        const p = this.clientToVB(mv.clientX, mv.clientY);
        if (!p) return;
        const cur = this.manualVB ?? (this.manualVB = { ...this.fitVB });
        cur.x += grab.x - p.x;
        cur.y += grab.y - p.y;
        panned = true;
        this.applyVB();
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

    const drawing = drawForest({
      svg,
      trees,
      groupBy: this.groupBy,
      colorOf,
      sigils,
      tips: this.tips,
      deviceLabel: (id) => this.plugin.deviceLabel(id),
      localDevice: this.plugin.localDeviceId(),
      currentPath: this.plugin.lastActiveMdPath,
      selected: this.selected,
      compactReads: this.compactReads,
      showEngagement: this.showEngagement,
      soloedSize: this.soloed.size,
      onNodeClick: (evt, path) => this.nodeClick(evt, path),
      onNodeMenu: (evt, n) => this.plugin.openSpanMenu(evt, n.ctx, n.path, n.firstAt, n.lastAt),
    });
    this.fitVB = drawing.fit;
    this.applyVB();

    if (this.selected) {
      const found = drawing.latestNode.get(this.selected);
      if (found) this.renderDetail(main, relEvents, found.tree, found.node, colorOf);
      else this.selected = null;
    }
  }

  /**
   * The solo rail: every context as a mixer row — SOLO is what you see (an
   * ephemeral view filter), ARM is where new work goes (the declaration,
   * marked with the compass). Rows sort by recency and fade continuously
   * with inactivity — a pace gradient, not a dormant gate: a stale context
   * is quiet and low but never behind a door.
   */
  private renderRail(
    main: HTMLElement,
    relEvents: LogEvent[],
    mapEvents: LogEvent[],
    window: { from?: number; to?: number },
    colorOf: (ctx: string) => string,
    sigils: Map<string, string>
  ): void {
    const s = this.plugin.settings;
    const rail = main.createDiv({ cls: "contexts-map-rail" });
    // Recency is all-time (the fade); engaged time is windowed to the
    // current view (the number on the row). Both honor the device filter.
    const ctxOf = assignContexts(mapEvents);
    const rows = new Map<string, { win: number; lastAt: number }>();
    for (const name of contextNames(relEvents)) rows.set(name, { win: 0, lastAt: 0 });
    rows.set("", { win: 0, lastAt: 0 });
    for (const ev of mapEvents) {
      if (!isSpan(ev)) continue;
      const name = ctxOf.get(ev) ?? "";
      let r = rows.get(name);
      if (!r) rows.set(name, (r = { win: 0, lastAt: 0 }));
      r.lastAt = Math.max(r.lastAt, ev.t);
      if ((window.from === undefined || ev.t >= window.from) && (window.to === undefined || ev.t <= window.to)) r.win += ev.dur;
    }
    const current = currentContext(relEvents);
    const halfLifeMs = s.halfLifeDays * 24 * 3600_000;
    const guess = guessContext(relEvents, Date.now(), halfLifeMs);
    const ctxSets = contextFileSets(relEvents);
    const ordered = [...rows.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt);
    for (const [name, r] of ordered) {
      const row = rail.createDiv({ cls: "contexts-map-rail-row" });
      // The activity fade, continuous with inactivity; never below legible.
      const weight = r.lastAt ? Math.pow(2, -(Date.now() - r.lastAt) / halfLifeMs) : 0;
      row.style.opacity = (0.35 + 0.65 * weight).toFixed(2);
      if (this.soloed.has(name)) row.addClass("is-soloed");
      row.createSpan({ text: sigils.get(name) ?? "", cls: "contexts-sigil" });
      row.createSpan({ cls: "contexts-braid-rail-dot" }).style.background = colorOf(name);
      row.createSpan({ text: name || "(no context)", cls: "contexts-map-rail-name" });
      if (name && name === current) {
        const armed = row.createSpan({ cls: "contexts-map-rail-armed" });
        setIcon(armed, "compass");
        armed.setAttribute("aria-label", "Armed: new work goes here");
      }
      // The guess-glint: recognition of a return, moved in from the pane.
      // Click confirms the declaration; ignoring costs nothing.
      if (guess && name === guess.name && guess.name !== current) {
        const glint = row.createSpan({ cls: "contexts-map-rail-glint" });
        setIcon(glint, "sparkles");
        glint.setAttribute("aria-label", `Working in ${name}? Click to confirm`);
        glint.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.plugin.declareContext(name, "guess");
        });
      }
      if (r.win > 0) row.createSpan({ text: fmtDur(r.win), cls: "contexts-map-rail-time" });
      const set = ctxSets.get(name);
      if (set) {
        // Hover: the context's face — the files that define it.
        this.tips.attach(row, (el) => {
          el.createDiv({ text: name || "(no context)", cls: "contexts-tip-name" });
          const files = topFiles(set).slice(0, 5).map((p) => p.split("/").pop()?.replace(/\.md$/, "") ?? p);
          el.createDiv({ text: files.join(", "), cls: "contexts-tip-meta" });
        });
      }
      row.addEventListener("click", (evt) => {
        // Click grammar: click solos; shift-click adds/removes from the set;
        // ⌘-click or re-clicking the sole soloed row goes back to all.
        if (Keymap.isModifier(evt, "Mod")) this.soloed.clear();
        else if (evt.shiftKey) {
          if (this.soloed.has(name)) this.soloed.delete(name);
          else this.soloed.add(name);
        } else if (this.soloed.size === 1 && this.soloed.has(name)) this.soloed.clear();
        else this.soloed = new Set([name]);
        this.manualVB = null;
        void this.render();
      });
      if (name) {
        row.addEventListener("contextmenu", (evt) => {
          const menu = new Menu();
          menu.addItem((i) => i.setTitle("Declare (work here now)").setIcon("compass").onClick(() => this.plugin.declareContext(name)));
          menu.addItem((i) => i.setTitle("Rename / set sigil…").setIcon("pencil").onClick(() => void this.plugin.openRenameFor(name)));
          menu.addItem((i) => i.setTitle("Merge into…").setIcon("merge").onClick(() => void this.plugin.openMergeModal(name)));
          menu.showAtMouseEvent(evt);
        });
      }
    }
    const newBtn = rail.createEl("button", { text: "+ New context", cls: "contexts-map-rail-new" });
    newBtn.addEventListener("click", () => void this.plugin.mintAnonContext());
  }

  /** The node detail, braid-register: identity, contexts, stats, and the movement around it. */
  private renderDetail(
    main: HTMLElement,
    relEvents: Parameters<typeof fileContexts>[0],
    tree: NavTree,
    node: NavNode,
    colorOf: (ctx: string) => string
  ): void {
    const path = node.path;
    const panel = main.createDiv({ cls: "contexts-braid-detail" });
    const head = panel.createDiv({ cls: "contexts-braid-detail-head" });
    const nameRow = head.createDiv({ cls: "contexts-braid-detail-name" });
    nameRow.createSpan({ text: path.split("/").pop()?.replace(/\.md$/, "") ?? path });
    const close = head.createDiv({ cls: "contexts-braid-detail-close" });
    setIcon(close, "x");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => {
      this.selected = null;
      void this.render();
    });
    // A file with no memberships still gets a row — "(no context)" is a
    // state the user may want to correct, not an absence to hide.
    const threads = fileContexts(relEvents, path);
    const ctxRows = threads.length ? threads : [{ name: "", dur: 0 }];
    const sigils = allSigils(relEvents);
    for (const t of ctxRows) {
      const ctxRow = head.createDiv({ cls: ["contexts-braid-detail-ctx", "contexts-map-ctx-row"] });
      ctxRow.createSpan({ cls: "contexts-braid-rail-dot" }).style.background = colorOf(t.name);
      const sig = sigils.get(t.name);
      if (sig) ctxRow.createSpan({ text: sig, cls: "contexts-sigil" });
      ctxRow.createSpan({ text: t.name ? `${t.name} · ${fmtDur(t.dur)}` : "(no context)" });
      this.tips.attach(ctxRow, "Move or correct this file's visits");
      ctxRow.addEventListener("click", (evt) => this.plugin.openSpanMenu(evt, t.name, path, node.firstAt, node.lastAt));
    }
    head.createDiv({ text: path, cls: "contexts-braid-detail-path" });
    head.createDiv({
      text: `${fmtDur(node.dur)} engaged · ${node.visits} visit${node.visits === 1 ? "" : "s"} · ${node.edits} edit${
        node.edits === 1 ? "" : "s"
      } this session`,
      cls: "contexts-braid-detail-stats",
    });
    const openLink = head.createDiv({ text: "Open file", cls: "contexts-braid-detail-open" });
    openLink.addEventListener("click", (evt) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        this.plugin.noteUiOpen("map");
        void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
      }
    });

    const list = panel.createDiv({ cls: "contexts-braid-detail-list" });
    const row = (label: string, target: string, meta?: string) => {
      const r = list.createDiv({ cls: ["contexts-braid-detail-row", "contexts-map-related"] });
      r.createSpan({ text: target.split("/").pop()?.replace(/\.md$/, "") ?? target });
      r.createSpan({ text: meta ?? label, cls: "contexts-braid-detail-meta" });
      this.tips.attach(r, target);
      r.addEventListener("click", (evt) => this.nodeClick(evt, target));
    };
    const parent = tree.parentOf.get(path);
    if (parent) {
      list.createDiv({ cls: "contexts-braid-detail-day" }).createSpan({ text: "Came from" });
      row("came from", parent, fmtClock(node.firstAt));
    }
    if (node.children.length) {
      list.createDiv({ cls: "contexts-braid-detail-day" }).createSpan({ text: "Opened from here" });
      for (const c of node.children) row("opened", c.path, fmtClock(c.firstAt));
    }
    const also = tree.links.filter((l) => l.to === path || l.from === path);
    if (also.length) {
      list.createDiv({ cls: "contexts-braid-detail-day" }).createSpan({ text: "Also crossed" });
      for (const l of also) {
        const other = l.to === path ? l.from : l.to;
        const meta =
          l.kind === "peek"
            ? "peeked"
            : l.kind === "linked"
            ? l.from === path
              ? "link written to"
              : "link written from"
            : l.to === path
            ? "returned from"
            : "returned to";
        row(l.kind, other, meta);
      }
    }
    if (!parent && !node.children.length && !also.length) {
      list.createDiv({ text: "The session started here and stayed.", cls: "contexts-empty" });
    }
  }
}

/**
 * The map's render core, extracted from the ItemView so the `contexts` code
 * block can draw the same forest into a MarkdownRenderChild container. Pure
 * drawing into cfg.svg: no pan/zoom, no viewBox management, no detail panel
 * — the caller owns interaction. Returns the auto-fit bounds and where each
 * path last appeared (the ItemView's detail panel needs the latter).
 */
export interface ForestDrawing {
  fit: { x: number; y: number; w: number; h: number };
  latestNode: Map<string, { tree: NavTree; node: NavNode }>;
}

/** Context colors: same palette, same first-appearance order as the braid's bands. */
export function makeColorOf(relEvents: LogEvent[], gapMs: number): (ctx: string) => string {
  const bandOrder: string[] = [];
  for (const r of contextRuns(groupSessions(relEvents, gapMs), assignContexts(relEvents))) {
    if (!bandOrder.includes(r.ctx)) bandOrder.push(r.ctx);
  }
  const colored = bandOrder.filter((c) => c !== "");
  return (ctx: string) => {
    if (ctx === "") return UNASSIGNED_COLOR;
    const i = colored.indexOf(ctx);
    return PALETTE[(i === -1 ? colored.length : i) % PALETTE.length];
  };
}

export function drawForest(cfg: {
  svg: SVGSVGElement;
  trees: NavTree[];
  groupBy: NavGroup;
  colorOf: (ctx: string) => string;
  sigils: Map<string, string>;
  tips: HoverTip;
  deviceLabel: (id: string) => string;
  localDevice: string | null;
  currentPath: string | null;
  selected: string | null;
  compactReads: boolean;
  showEngagement: boolean;
  soloedSize: number;
  onNodeClick: (evt: MouseEvent, path: string) => void;
  onNodeMenu?: (evt: MouseEvent, n: NavNode) => void;
}): ForestDrawing {
  const svg = cfg.svg;
  const trees = cfg.trees;
  const colorOf = cfg.colorOf;
  const sigils = cfg.sigils;
  // Label metrics from real text measurement, so columns stagger like
  // Tangent's. Long names wrap to two lines; anything longer ellipsizes
  // (the hover card always carries the full path).
  const canvas = document.createElement("canvas");
  const mctx = canvas.getContext("2d")!;
  mctx.font = `500 12px ${getComputedStyle(document.body).fontFamily}`;
  const baseOf = (path: string) => path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  const fit = (str: string): string => {
    if (mctx.measureText(str).width <= MAX_LABEL_W) return str;
    while (str && mctx.measureText(str + "…").width > MAX_LABEL_W) str = str.slice(0, -1);
    return str + "…";
  };
  const lineCache = new Map<string, string[]>();
  const linesOf = (path: string): string[] => {
    let lines = lineCache.get(path);
    if (lines) return lines;
    const base = baseOf(path);
    if (mctx.measureText(base).width <= MAX_LABEL_W) lines = [base];
    else {
      const words = base.split(" ");
      let l1 = "";
      let i = 0;
      while (i < words.length) {
        const next = l1 ? `${l1} ${words[i]}` : words[i];
        if (l1 && mctx.measureText(next).width > MAX_LABEL_W) break;
        l1 = next;
        i++;
      }
      const l2 = words.slice(i).join(" ");
      lines = l2 ? [fit(l1), fit(l2)] : [fit(l1)];
    }
    lineCache.set(path, lines);
    return lines;
  };
  const widthOf = (path: string) =>
    Math.max(...linesOf(path).map((l) => mctx.measureText(l).width)) + 32;
  const heightOf = (path: string) => (linesOf(path).length > 1 ? 36 : NODE_H);

  // Stack the session trees; remember where every path last appeared for
  // trails and the detail panel (the latest session is the one that counts).
  const COMPACT_W = 16;
  // Brief pass-throughs compact even mid-tree: a dot keeps the chain
  // visible while dropping the label. ponytail: fixed threshold; a
  // settings knob if 30s turns out to be the wrong line.
  const BRIEF_MS = 30_000;
  // Never compacted: a tree's root and its chronologically last file —
  // where the sitting began and where it ended anchor the reading.
  const anchors = new Map<NavTree, Set<string>>();
  const isCompact = (n: NavNode, tree: NavTree) =>
    cfg.compactReads &&
    !n.edits &&
    !n.created &&
    !anchors.get(tree)?.has(n.path) &&
    n.path !== cfg.selected &&
    n.path !== cfg.currentPath &&
    (n.children.length === 0 || n.dur < BRIEF_MS);
  const placements: { tree: NavTree; pos: Map<NavNode, { x: number; y: number; w: number }> }[] = [];
  const latestNode = new Map<string, { tree: NavTree; node: NavNode }>();
  let yCursor = 0;
  for (const tree of trees) {
    const nodeOf = new Map<string, NavNode>();
    let last: NavNode = tree.root;
    const walk = (n: NavNode): void => {
      nodeOf.set(n.path, n);
      if (n.lastAt > last.lastAt) last = n;
      n.children.forEach(walk);
    };
    walk(tree.root);
    anchors.set(tree, new Set([tree.root.path, last.path]));
    const w = (path: string) => {
      const n = nodeOf.get(path);
      return n && isCompact(n, tree) ? COMPACT_W : widthOf(path);
    };
    const { pos, height } = layoutNavTree(tree.root, w, LEFT_X, yCursor);
    placements.push({ tree, pos });
    for (const n of pos.keys()) latestNode.set(n.path, { tree, node: n });
    yCursor += height + TREE_GAP;
  }

  // The trail: root → the file the user is in right now, in its latest tree.
  const current = cfg.currentPath;
  const trail = new Set<string>();
  let trailTree: NavTree | null = null;
  if (current && latestNode.has(current)) {
    trailTree = latestNode.get(current)!.tree;
    let p: string | null | undefined = current;
    while (p) {
      trail.add(p);
      p = trailTree.parentOf.get(p);
    }
  }

  // Engagement scale: global across the forest, so a heavy day doesn't
  // make a light day's files look important by local comparison.
  let maxDur = 1;
  for (const { pos } of placements) for (const n of pos.keys()) maxDur = Math.max(maxDur, n.dur);


  // One arrowhead marker for every edge: fill follows the line's own
  // stroke (context-stroke), and orient=auto flips it on backward curves.
  const marker = svg.createSvg("defs").createSvg("marker", {
    attr: {
      id: "contexts-map-arrow",
      viewBox: "0 0 8 8",
      refX: 7,
      refY: 4,
      // Fixed user-space size: markers otherwise scale with stroke width,
      // so thick (linked, trail) lines grew oversized heads.
      markerUnits: "userSpaceOnUse",
      markerWidth: 8,
      markerHeight: 8,
      orient: "auto-start-reverse",
    },
  });
  marker.createSvg("path", { attr: { d: "M 0 0 L 8 4 L 0 8 z", fill: "context-stroke" } });

  // A soft S-curve with horizontal tangents: the Tangent connector.
  const curve = (x1: number, y1: number, x2: number, y2: number) => {
    const mx = (x1 + x2) / 2;
    return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
  };

  for (const { tree, pos } of placements) {
    const at = new Map<string, { x: number; y: number; w: number }>();
    for (const [n, p] of pos) at.set(n.path, p);
    const onTrail = (path: string) => tree === trailTree && trail.has(path);

    // Tree label, left of the root: when this run of work began.
    const rootPos = pos.get(tree.root)!;
    const label = svg.createSvg("text", {
      attr: { x: LEFT_X - 14, y: rootPos.y - 2, "text-anchor": "end" },
      cls: "contexts-map-session",
    });
    const d = new Date(tree.start);
    const line1 =
      cfg.groupBy === "week"
        ? `Week of ${new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).toLocaleDateString(undefined, { month: "numeric", day: "numeric" })}`
        : cfg.groupBy === "month"
        ? d.toLocaleDateString(undefined, { month: "short", year: "numeric" })
        : relDay(tree.start);
    label.createSvg("tspan", { attr: { x: LEFT_X - 14 } }).textContent = line1;
    const line2 = cfg.groupBy === "week" || cfg.groupBy === "month" ? relDay(tree.start) : fmtClock(tree.start);
    label.createSvg("tspan", { attr: { x: LEFT_X - 14, dy: 13 }, cls: "contexts-map-session-time" }).textContent = line2;

    // Hover wiring: every edge registers with both endpoints, so mousing
    // over a node can light its lines and, slightly, its neighbors.
    const groupOf = new Map<string, SVGGElement>();
    const touching = new Map<string, { el: SVGElement; other: string }[]>();
    const touch = (a: string, b: string, el: SVGElement) => {
      for (const [me, other] of [[a, b], [b, a]] as const) {
        let list = touching.get(me);
        if (!list) touching.set(me, (list = []));
        list.push({ el, other });
      }
    };

    // One line per pair of files, whatever the ties: the tree edge wins,
    // upgraded to the "linked" style when a link was also written; among
    // secondary ties alone, the strongest kind draws. Every tie still
    // shows in the detail panel — this is drawing economy, not data loss.
    const RANK = { linked: 3, revisit: 2, peek: 1 } as const;
    const bestLink = new Map<string, (typeof tree.links)[number]>();
    for (const link of tree.links) {
      const key = pairKey(link.from, link.to);
      const cur = bestLink.get(key);
      if (!cur || RANK[link.kind] > RANK[cur.kind]) bestLink.set(key, link);
    }
    const parentPairs = new Set<string>();
    // A pair tied in both directions gets a head on each end of its one line.
    const dirs = new Set<string>();
    for (const [child, parent] of tree.parentOf) if (parent) dirs.add(`${parent} ${child}`);
    for (const l of tree.links) dirs.add(`${l.from} ${l.to}`);
    const twoWay = (a: string, b: string) => dirs.has(`${a} ${b}`) && dirs.has(`${b} ${a}`);
    // Tree edges first (under the nodes), then secondary curves, then nodes.
    const drawEdges = (n: NavNode) => {
      const pp = pos.get(n)!;
      for (const c of n.children) {
        const cp = pos.get(c)!;
        const key = pairKey(n.path, c.path);
        parentPairs.add(key);
        const path = svg.createSvg("path", {
          attr: { d: curve(pp.x + pp.w, pp.y, cp.x, cp.y) },
          cls: "contexts-map-edge",
        });
        // A followed link reads at full strength; mere sequence is fainter;
        // a pair that was also LINKED in text carries the strongest style.
        if (bestLink.get(key)?.kind === "linked") path.addClass("is-linked");
        else if (c.via === "seq") path.addClass("is-seq");
        if (twoWay(n.path, c.path)) path.addClass("is-two-way");
        if (onTrail(n.path) && onTrail(c.path) && trailTree!.parentOf.get(c.path) === n.path) path.addClass("is-trail");
        touch(n.path, c.path, path);
        drawEdges(c);
      }
    };
    drawEdges(tree.root);
    for (const link of bestLink.values()) {
      if (parentPairs.has(pairKey(link.from, link.to))) continue; // the tree edge already carries this pair
      const fp = at.get(link.from);
      const tp = at.get(link.to);
      if (!fp || !tp) continue;
      const el = svg.createSvg("path", {
        attr: { d: curve(fp.x + fp.w, fp.y, tp.x, tp.y) },
        cls: ["contexts-map-edge", `is-${link.kind}`],
      });
      if (twoWay(link.from, link.to)) el.addClass("is-two-way");
      touch(link.from, link.to, el);
    }
    // Context name once per same-context stretch (chronological order),
    // small above the first node of each run — sigil every node, name once
    // per stretch, color as reinforcement: three channels at three costs.
    const runStart = new Set<NavNode>();
    {
      const ordered = [...pos.keys()].sort((a, b) => a.firstAt - b.firstAt);
      let prev: string | null = null;
      for (const n of ordered) {
        if (n.ctx && n.ctx !== prev) runStart.add(n);
        prev = n.ctx;
      }
    }
    for (const [n, p] of pos) {
      const g = svg.createSvg("g", { cls: "contexts-map-nav" });
      if (n.edits) g.addClass("is-edited");
      if (onTrail(n.path)) g.addClass("is-trail");
      if (n.path === current && tree === trailTree) g.addClass("is-current");
      if (n.path === cfg.selected) g.addClass("is-selected");
      const heat = Math.sqrt(n.dur / maxDur);
      if (isCompact(n, tree)) {
        // A drive-by read: structure without a label. Hover says the rest.
        g.addClass("is-mini");
        const r = cfg.showEngagement ? 4 + 3 * heat : 5;
        g.createSvg("circle", { attr: { cx: p.x + COMPACT_W / 2, cy: p.y, r }, cls: "contexts-map-mini" }).style.fill =
          colorOf(n.ctx);
      } else {
        const h = heightOf(n.path);
        const rect = g.createSvg("rect", { attr: { x: p.x, y: p.y - h / 2, width: p.w, height: h, rx: 6 } });
        // The engagement wash: context color, deeper with engaged time —
        // blended OPAQUE into the background (color-mix, not opacity), so
        // connectors never show through behind the text. The current file
        // keeps its accent wash instead.
        if (cfg.showEngagement && !(n.path === current && tree === trailTree)) {
          const pct = Math.round(5 + 30 * heat);
          rect.style.fill = `color-mix(in srgb, ${colorOf(n.ctx)} ${pct}%, var(--background-primary))`;
        }
        const sig = sigils.get(n.ctx);
        if (sig) {
          const t = g.createSvg("text", {
            attr: { x: p.x + 12, y: p.y + 3, "text-anchor": "middle" },
            cls: "contexts-map-nav-sigil",
          });
          t.textContent = sig;
          t.style.fill = colorOf(n.ctx);
        } else {
          g.createSvg("circle", { attr: { cx: p.x + 12, cy: p.y, r: 3 }, cls: "contexts-map-nav-dot" }).style.fill =
            colorOf(n.ctx);
        }
        const lines = linesOf(n.path);
        const text = g.createSvg("text", { cls: "contexts-map-nav-label" });
        if (lines.length === 1) {
          text.createSvg("tspan", { attr: { x: p.x + 21, y: p.y + 4 } }).textContent = lines[0];
        } else {
          text.createSvg("tspan", { attr: { x: p.x + 21, y: p.y - 3 } }).textContent = lines[0];
          text.createSvg("tspan", { attr: { x: p.x + 21, y: p.y + 10 } }).textContent = lines[1];
        }
        if (n.created) {
          const badge = g.createSvg("g", { cls: "contexts-map-created" });
          badge.createSvg("circle", { attr: { cx: p.x + 2, cy: p.y - h / 2 + 1, r: 5 } });
          badge.createSvg("text", { attr: { x: p.x + 2, y: p.y - h / 2 + 4, "text-anchor": "middle" } }).textContent = "+";
        }
      }
      if (runStart.has(n)) {
        const sub = svg.createSvg("text", {
          attr: { x: p.x, y: p.y - (isCompact(n, tree) ? 12 : heightOf(n.path) / 2 + 5) },
          cls: "contexts-map-ctx-label",
        });
        sub.textContent = n.ctx;
        sub.style.fill = colorOf(n.ctx);
      }
      // Hover card: the name with the sidebar trail's icon vocabulary
      // (pencil = edited, book = read), then one quiet meta line. No path;
      // the detail panel carries it.
      cfg.tips.attach(g, (el) => {
        const name = el.createDiv({ cls: "contexts-tip-name" });
        setIcon(name.createSpan({ cls: "contexts-chip-icon" }), n.edits ? "pencil" : "book-open");
        name.createSpan({ text: baseOf(n.path) });
        const meta: string[] = [fmtClock(n.firstAt), `${fmtDur(n.dur)} engaged`, `${n.visits} visit${n.visits === 1 ? "" : "s"}`];
        if (n.edits) meta.push(`${n.edits} edit${n.edits === 1 ? "" : "s"}`);
        if (n.created) meta.push("created here");
        meta.push(n.ctx ? `${sigils.get(n.ctx) ?? ""} ${n.ctx}`.trim() : "no context");
        const local = cfg.localDevice;
        const devs = [...new Set(n.devices?.filter((d) => d !== local) ?? [])];
        if (devs.length) meta.push(`on ${devs.map((d) => cfg.deviceLabel(d)).join(", ")}`);
        el.createDiv({ text: meta.join(" · "), cls: "contexts-tip-meta" });
      });
      g.addEventListener("click", (evt) => cfg.onNodeClick(evt, n.path));
      // The braid's correction menu, from here: move these visits, evict,
      // unassign, or delete — covering this node's whole stretch.
      if (cfg.onNodeMenu) g.addEventListener("contextmenu", (evt) => cfg.onNodeMenu!(evt, n));
      groupOf.set(n.path, g);
      // The excursion badge: the user left the context and came back here.
      // The elision is the point — the foreign files stay off the map.
      if (n.away) {
        const badge = svg.createSvg("g", { cls: "contexts-map-away" });
        badge.createSvg("circle", { attr: { cx: p.x - 12, cy: p.y, r: 6 } });
        badge.createSvg("text", { attr: { x: p.x - 12, y: p.y + 3, "text-anchor": "middle" } }).textContent = "⋯";
        cfg.tips.attach(
          badge,
          `left ${cfg.soloedSize > 1 ? "the soloed set" : "the context"} ${n.away.times === 1 ? "once" : `${n.away.times}×`} before returning here · ${fmtDur(
            n.away.dur
          )} away · ${n.away.files} file${n.away.files === 1 ? "" : "s"} elsewhere`
        );
      }
    }
    for (const [path, g] of groupOf) {
      const set = (on: boolean) => {
        g.toggleClass("is-hover", on);
        for (const t of touching.get(path) ?? []) {
          t.el.toggleClass("is-hl", on);
          groupOf.get(t.other)?.toggleClass("is-hl", on);
        }
      };
      g.addEventListener("pointerenter", () => set(true));
      g.addEventListener("pointerleave", () => set(false));
    }
  }


  // Auto-fit bounds for the caller's viewBox.
  let x1 = 0;
  for (const { pos } of placements) for (const p of pos.values()) x1 = Math.max(x1, p.x + p.w);
  return {
    fit: { x: 0, y: -NAV_ROW_H, w: Math.max(x1 + 40, 400), h: Math.max(yCursor - TREE_GAP + NAV_ROW_H * 2, 200) },
    latestNode,
  };
}
