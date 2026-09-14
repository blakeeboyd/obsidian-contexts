import { ItemView, Keymap, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type ContextsPlugin from "./main";
import { PALETTE, UNASSIGNED_COLOR } from "./braid";
import { fmtDur } from "./format";
import { HoverTip } from "./tip";
import {
  CognitionGraph,
  MapPos,
  applyErasures,
  applyRenames,
  assignContexts,
  buildCognitionGraph,
  contextNames,
  contextRuns,
  excludeFolders,
  fileContexts,
  forceTick,
  groupSessions,
  healRenames,
  seedPos,
  unrelatedPairs,
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

const R_MIN = 5;
const R_MAX = 18;
const LABELED = 30; // labels only on the heaviest nodes; hover carries the rest

/**
 * The cognition map: the spatial view of the working set. Nodes are files
 * sized by engaged time (edits boosted), colored by dominant context with the
 * braid's palette; edges are the graded behavioral evidence. A small force
 * simulation settles positions, which persist across re-renders so the map
 * is a stable place, not a reshuffle.
 */
export class MapView extends ItemView {
  private mapScope: MapScope = "day";
  private ctxChoice: string | null = null;
  private selected: string | null = null;
  private pos = new Map<string, MapPos>();
  private tips = new HoverTip();
  private raf = 0;
  private alpha = 0;

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
    cancelAnimationFrame(this.raf);
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

  async render(): Promise<void> {
    cancelAnimationFrame(this.raf);
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
        void this.render();
      });
    }
    header.createSpan({
      text: "click a node for its detail · ⌘-click opens the file",
      cls: "contexts-braid-hint",
    });

    const now = Date.now();
    const sessions = groupSessions(relEvents, gapMs);
    const scopeArg: { from?: number; to?: number; ctx?: string } = {};
    if (this.mapScope === "session" && sessions.length) scopeArg.from = sessions[sessions.length - 1].start;
    else if (this.mapScope === "day") scopeArg.from = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
    else if (this.mapScope === "context") scopeArg.ctx = this.ctxChoice ?? names[0] ?? "";
    const graph = buildCognitionGraph(relEvents, now, scopeArg, gapMs, undefined, unrelatedPairs(relEvents));
    if (!graph.nodes.length) {
      contentEl.createDiv({ text: "Nothing in this scope yet. Work in some notes and come back.", cls: "contexts-empty" });
      return;
    }

    // Context colors: same palette, same first-appearance order as the braid's bands.
    const bandOrder: string[] = [];
    for (const r of contextRuns(sessions, assignContexts(relEvents))) if (!bandOrder.includes(r.ctx)) bandOrder.push(r.ctx);
    const colored = bandOrder.filter((c) => c !== "");
    const colorOf = (ctx: string) => {
      if (ctx === "") return UNASSIGNED_COLOR;
      const i = colored.indexOf(ctx);
      return PALETTE[(i === -1 ? colored.length : i) % PALETTE.length];
    };

    const maxW = graph.nodes[0].weight || 1;
    const rOf = new Map(graph.nodes.map((n) => [n.path, R_MIN + (R_MAX - R_MIN) * Math.sqrt(n.weight / maxW)]));
    const maxScore = graph.edges[0]?.score || 1;

    // Seed new nodes, keep the rest where they settled.
    for (const n of graph.nodes) if (!this.pos.has(n.path)) this.pos.set(n.path, seedPos(n.path));

    const main = contentEl.createDiv({ cls: "contexts-braid-main" });
    const svg = main.createSvg("svg", { cls: "contexts-map-svg" });
    svg.addEventListener("click", (evt) => {
      if (evt.target === svg && this.selected) {
        this.selected = null;
        void this.render();
      }
    });

    const edgeEls: { el: SVGLineElement; a: string; b: string }[] = [];
    for (const e of graph.edges) {
      const line = svg.createSvg("line", { cls: "contexts-map-edge" });
      if (e.kind === "peek") line.addClass("is-peek");
      line.style.strokeWidth = `${0.6 + 2 * (e.score / maxScore)}px`;
      line.style.opacity = `${0.25 + 0.45 * (e.score / maxScore)}`;
      edgeEls.push({ el: line, a: e.a, b: e.b });
    }
    const nodeEls: { g: SVGGElement; path: string }[] = [];
    graph.nodes.forEach((n, i) => {
      const g = svg.createSvg("g", { cls: "contexts-map-node" });
      if (n.path === this.selected) g.addClass("is-selected");
      const r = rOf.get(n.path)!;
      const circle = g.createSvg("circle", { attr: { r } });
      circle.style.fill = colorOf(n.ctx);
      circle.style.fillOpacity = `${0.45 + 0.55 * Math.sqrt(n.weight / maxW)}`;
      const base = n.path.split("/").pop()?.replace(/\.md$/, "") ?? n.path;
      if (i < LABELED || n.path === this.selected) {
        g.createSvg("text", { attr: { x: r + 4, y: 3 }, cls: "contexts-map-label" }).textContent = base;
      }
      this.tips.attach(
        g,
        `${n.path} · ${fmtDur(n.dur)} engaged · ${n.visits} visit${n.visits === 1 ? "" : "s"} · ${n.edits} edit${n.edits === 1 ? "" : "s"}${n.ctx ? ` · ${n.ctx}` : ""}`
      );
      g.addEventListener("click", (evt) => this.nodeClick(evt, n.path));
      nodeEls.push({ g, path: n.path });
    });

    const paths = graph.nodes.map((n) => n.path);
    const radius = (p: string) => rOf.get(p) ?? R_MIN;
    const draw = () => {
      for (const { el, a, b } of edgeEls) {
        const pa = this.pos.get(a)!;
        const pb = this.pos.get(b)!;
        el.setAttribute("x1", pa.x.toFixed(1));
        el.setAttribute("y1", pa.y.toFixed(1));
        el.setAttribute("x2", pb.x.toFixed(1));
        el.setAttribute("y2", pb.y.toFixed(1));
      }
      for (const { g, path } of nodeEls) {
        const p = this.pos.get(path)!;
        g.setAttribute("transform", `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
      }
      // Auto-fit: the viewBox tracks the settled bounds. No pan/zoom until
      // the node cap makes fit-to-all unreadable.
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of paths) {
        const n = this.pos.get(p)!;
        const r = radius(p) + 30;
        x0 = Math.min(x0, n.x - r);
        y0 = Math.min(y0, n.y - r);
        x1 = Math.max(x1, n.x + r + 90); // room for labels
        y1 = Math.max(y1, n.y + r);
      }
      svg.setAttribute("viewBox", `${x0.toFixed(0)} ${y0.toFixed(0)} ${Math.max(x1 - x0, 200).toFixed(0)} ${Math.max(y1 - y0, 200).toFixed(0)}`);
    };

    // Settle incrementally: hot start only when new nodes arrived, warm otherwise.
    this.alpha = graph.nodes.some((n) => this.pos.get(n.path)!.vx === 0 && this.pos.get(n.path)!.vy === 0) ? 1 : 0.3;
    const step = () => {
      forceTick(paths, graph.edges, this.pos, this.alpha, radius);
      draw();
      this.alpha *= 0.96;
      if (this.alpha > 0.02) this.raf = requestAnimationFrame(step);
    };
    draw();
    this.raf = requestAnimationFrame(step);

    if (this.selected) {
      const sel = graph.nodes.find((n) => n.path === this.selected);
      if (sel) this.renderDetail(main, relEvents, graph, sel.path, colorOf, sel);
      else this.selected = null;
    }
  }

  /** The node detail, braid-register: identity, contexts, stats, strongest neighbors. */
  private renderDetail(
    main: HTMLElement,
    relEvents: Parameters<typeof fileContexts>[0],
    graph: CognitionGraph,
    path: string,
    colorOf: (ctx: string) => string,
    node: { dur: number; visits: number; edits: number }
  ): void {
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
      text: `${fmtDur(node.dur)} engaged · ${node.visits} visit${node.visits === 1 ? "" : "s"} · ${node.edits} edit${node.edits === 1 ? "" : "s"} in scope`,
      cls: "contexts-braid-detail-stats",
    });
    const openLink = head.createDiv({ text: "Open file", cls: "contexts-braid-detail-open" });
    openLink.addEventListener("click", (evt) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
    });

    const list = panel.createDiv({ cls: "contexts-braid-detail-list" });
    const neighbors = graph.edges
      .filter((e) => e.a === path || e.b === path)
      .map((e) => ({ other: e.a === path ? e.b : e.a, score: e.score, kind: e.kind }))
      .slice(0, 20);
    if (!neighbors.length) {
      list.createDiv({ text: "No graded evidence links this file yet.", cls: "contexts-empty" });
      return;
    }
    list.createDiv({ cls: "contexts-braid-detail-day" }).createSpan({ text: "Related" });
    for (const nb of neighbors) {
      const row = list.createDiv({ cls: "contexts-braid-detail-row contexts-map-related" });
      row.createSpan({ text: nb.other.split("/").pop()?.replace(/\.md$/, "") ?? nb.other });
      row.createSpan({ text: `${nb.kind} · ${nb.score.toFixed(1)}`, cls: "contexts-braid-detail-meta" });
      this.tips.attach(row, nb.other);
      row.addEventListener("click", (evt) => this.nodeClick(evt, nb.other));
    }
  }
}
