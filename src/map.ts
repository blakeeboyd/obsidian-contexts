import { ItemView, Keymap, Menu, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ContextsPlugin from "./main";
import { PALETTE, UNASSIGNED_COLOR } from "./braid";
import { fmtClock, fmtDur, relDay } from "./format";
import { HoverTip } from "./tip";
import {
  NAV_H_GAP,
  NAV_ROW_H,
  NavNode,
  NavTree,
  applyErasures,
  applyRenames,
  assignContexts,
  buildNavForest,
  contextNames,
  contextRuns,
  excludeFolders,
  fileContexts,
  groupSessions,
  healRenames,
  layoutNavTree,
} from "./views";

export const MAP_VIEW_TYPE = "contexts-map";

/** Scope: which slice of the record the map draws. */
type MapScope = "session" | "day" | "context" | "all";
const SCOPES: { key: MapScope; label: string }[] = [
  { key: "session", label: "Session" },
  { key: "day", label: "Today" },
  { key: "context", label: "Context" },
  { key: "all", label: "All" },
];

const LEFT_X = 110; // room for session labels left of each root
const TREE_GAP = 56;
const NODE_H = 24;
const MAX_LABEL_W = 180;

/**
 * The cognition map: how the user moved through the work. One tree per
 * session, rooted at the session's first note, children in visit order —
 * what was opened from where, what was written (edited files read bold),
 * with the trail to the current file lit in the accent color. Secondary
 * arrivals and peeks are the quiet cross-curves.
 */
export class MapView extends ItemView {
  private mapScope: MapScope = "day";
  private ctxChoice: string | null = null;
  // The most recent session reads first: today's map starts with now.
  private newestFirst = true;
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
    return "Cognition map";
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
      if (file instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
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
    for (const { key, label } of SCOPES) {
      if (key === "context" && !names.length) continue;
      const b = seg.createEl("button", { text: label, cls: "contexts-braid-seg-btn" });
      if (key === this.mapScope) b.addClass("is-active");
      b.addEventListener("click", () => {
        this.mapScope = key;
        this.manualVB = null; // a new scope is a new picture; refit
        void this.render();
      });
    }
    if (this.mapScope === "context" && names.length) {
      const pick = header.createEl("select", { cls: "contexts-map-select" });
      for (const name of names) pick.createEl("option", { text: name, value: name });
      pick.value = this.ctxChoice && names.includes(this.ctxChoice) ? this.ctxChoice : names[0];
      this.ctxChoice = pick.value;
      pick.addEventListener("change", () => {
        this.ctxChoice = pick.value;
        this.manualVB = null;
        void this.render();
      });
    }
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
    orderBtn.setAttribute("aria-label", "Session order");
    orderBtn.addEventListener("click", (evt) => {
      const menu = new Menu();
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
      pick("Newest session first", true);
      pick("Oldest session first", false);
      menu.showAtMouseEvent(evt);
    });
    header.createSpan({
      text: "click a note for its detail · ⌘-click opens it · ⌘-scroll zooms · drag pans",
      cls: "contexts-braid-hint",
    });

    const scopeArg: { from?: number; to?: number; ctx?: string } = {};
    if (this.mapScope === "session") {
      const sessions = groupSessions(relEvents, gapMs);
      if (sessions.length) scopeArg.from = sessions[sessions.length - 1].start;
    } else if (this.mapScope === "day") scopeArg.from = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    else if (this.mapScope === "context") scopeArg.ctx = this.ctxChoice ?? names[0] ?? "";
    const trees = buildNavForest(relEvents, scopeArg, gapMs);
    if (this.newestFirst) trees.reverse();
    if (!trees.length) {
      contentEl.createDiv({ text: "Nothing in this scope yet. Work in some notes and come back.", cls: "contexts-empty" });
      return;
    }

    // Context colors: same palette, same first-appearance order as the braid's bands.
    const bandOrder: string[] = [];
    for (const r of contextRuns(groupSessions(relEvents, gapMs), assignContexts(relEvents))) {
      if (!bandOrder.includes(r.ctx)) bandOrder.push(r.ctx);
    }
    const colored = bandOrder.filter((c) => c !== "");
    const colorOf = (ctx: string) => {
      if (ctx === "") return UNASSIGNED_COLOR;
      const i = colored.indexOf(ctx);
      return PALETTE[(i === -1 ? colored.length : i) % PALETTE.length];
    };

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
    const placements: { tree: NavTree; pos: Map<NavNode, { x: number; y: number; w: number }> }[] = [];
    const latestNode = new Map<string, { tree: NavTree; node: NavNode }>();
    let yCursor = 0;
    for (const tree of trees) {
      const { pos, height } = layoutNavTree(tree.root, widthOf, LEFT_X, yCursor);
      placements.push({ tree, pos });
      for (const n of pos.keys()) latestNode.set(n.path, { tree, node: n });
      yCursor += height + TREE_GAP;
    }

    // The trail: root → the file the user is in right now, in its latest tree.
    const current = this.plugin.lastActiveMdPath;
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

    const main = contentEl.createDiv({ cls: "contexts-braid-main" });
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

    // A soft S-curve with horizontal tangents: the Tangent connector.
    const curve = (x1: number, y1: number, x2: number, y2: number) => {
      const mx = (x1 + x2) / 2;
      return `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${mx.toFixed(1)} ${y1.toFixed(1)}, ${mx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
    };

    for (const { tree, pos } of placements) {
      const at = new Map<string, { x: number; y: number; w: number }>();
      for (const [n, p] of pos) at.set(n.path, p);
      const onTrail = (path: string) => tree === trailTree && trail.has(path);

      // Session label, left of the root: the day, then the clock.
      const rootPos = pos.get(tree.root)!;
      const label = svg.createSvg("text", {
        attr: { x: LEFT_X - 14, y: rootPos.y - 2, "text-anchor": "end" },
        cls: "contexts-map-session",
      });
      label.createSvg("tspan", { attr: { x: LEFT_X - 14 } }).textContent = relDay(tree.start);
      label.createSvg("tspan", { attr: { x: LEFT_X - 14, dy: 13 }, cls: "contexts-map-session-time" }).textContent =
        fmtClock(tree.start);

      // Tree edges first (under the nodes), then secondary curves, then nodes.
      const drawEdges = (n: NavNode) => {
        const pp = pos.get(n)!;
        for (const c of n.children) {
          const cp = pos.get(c)!;
          const path = svg.createSvg("path", {
            attr: { d: curve(pp.x + pp.w, pp.y, cp.x, cp.y) },
            cls: "contexts-map-edge",
          });
          if (onTrail(n.path) && onTrail(c.path) && trailTree!.parentOf.get(c.path) === n.path) path.addClass("is-trail");
          drawEdges(c);
        }
      };
      drawEdges(tree.root);
      for (const link of tree.links) {
        const fp = at.get(link.from);
        const tp = at.get(link.to);
        if (!fp || !tp) continue;
        svg.createSvg("path", {
          attr: { d: curve(fp.x + fp.w, fp.y, tp.x, tp.y) },
          cls: ["contexts-map-edge", `is-${link.kind}`],
        });
      }
      for (const [n, p] of pos) {
        const g = svg.createSvg("g", { cls: "contexts-map-nav" });
        if (n.edits) g.addClass("is-edited");
        if (onTrail(n.path)) g.addClass("is-trail");
        if (n.path === current && tree === trailTree) g.addClass("is-current");
        if (n.path === this.selected) g.addClass("is-selected");
        const h = heightOf(n.path);
        g.createSvg("rect", { attr: { x: p.x, y: p.y - h / 2, width: p.w, height: h, rx: 6 } });
        g.createSvg("circle", { attr: { cx: p.x + 12, cy: p.y, r: 3 }, cls: "contexts-map-nav-dot" }).style.fill =
          colorOf(n.ctx);
        const lines = linesOf(n.path);
        const text = g.createSvg("text", { cls: "contexts-map-nav-label" });
        if (lines.length === 1) {
          text.createSvg("tspan", { attr: { x: p.x + 21, y: p.y + 4 } }).textContent = lines[0];
        } else {
          text.createSvg("tspan", { attr: { x: p.x + 21, y: p.y - 3 } }).textContent = lines[0];
          text.createSvg("tspan", { attr: { x: p.x + 21, y: p.y + 10 } }).textContent = lines[1];
        }
        this.tips.attach(
          g,
          `${n.path} · ${fmtClock(n.firstAt)} · ${fmtDur(n.dur)} engaged · ${n.visits} visit${n.visits === 1 ? "" : "s"} · ${
            n.edits ? `${n.edits} edit${n.edits === 1 ? "" : "s"}` : "read only"
          }${n.ctx ? ` · ${n.ctx}` : ""}`
        );
        g.addEventListener("click", (evt) => this.nodeClick(evt, n.path));
      }
    }

    // Auto-fit bounds; the viewBox follows them until a zoom or pan freezes a manual viewport.
    let x1 = 0;
    for (const { pos } of placements) for (const p of pos.values()) x1 = Math.max(x1, p.x + p.w);
    this.fitVB = { x: 0, y: -NAV_ROW_H, w: Math.max(x1 + 40, 400), h: Math.max(yCursor - TREE_GAP + NAV_ROW_H * 2, 200) };
    this.applyVB();

    if (this.selected) {
      const found = latestNode.get(this.selected);
      if (found) this.renderDetail(main, relEvents, found.tree, found.node, colorOf);
      else this.selected = null;
    }
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
    for (const t of fileContexts(relEvents, path)) {
      const ctxRow = head.createDiv({ cls: "contexts-braid-detail-ctx" });
      ctxRow.createSpan({ cls: "contexts-braid-rail-dot" }).style.background = colorOf(t.name);
      ctxRow.createSpan({ text: `${t.name || "(no context)"} · ${fmtDur(t.dur)}` });
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
      if (file instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
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
        row(l.kind, other, l.kind === "peek" ? "peeked" : l.to === path ? "returned from" : "returned to");
      }
    }
    if (!parent && !node.children.length && !also.length) {
      list.createDiv({ text: "The session started here and stayed.", cls: "contexts-empty" });
    }
  }
}
