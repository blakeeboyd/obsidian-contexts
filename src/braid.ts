import { ItemView, Keymap, TFile, WorkspaceLeaf } from "obsidian";
import { LogEvent, SpanEvent, isSpan } from "./recorder";
import type ContextsPlugin from "./main";
import { fmtClock, fmtDur, relDay } from "./format";
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
const LANE_H = 16;
const HULL_PAD = 7;
const BAND_GAP = 18;
const HEADER_H = 26;
const ROPE_H = 18; // hull height at the ropes grain
const BEAD_R = 3.5;
const PILL_H = 7; // strand pill thickness (Notion bar weight)


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

  constructor(leaf: WorkspaceLeaf, private plugin: ContextsPlugin) {
    super(leaf);
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

    const header = contentEl.createDiv({ cls: "contexts-braid-header" });
    for (const g of ["ropes", "strands", "visits"] as Grain[]) {
      const b = header.createEl("button", { text: g });
      if (g === this.grain) b.addClass("mod-cta");
      b.addEventListener("click", () => {
        this.grain = g;
        void this.render();
      });
    }
    header.createSpan({
      text: "drag a seam to move a context boundary",
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
    const ts = buildTimeScale(sessions);

    // Bands: one horizontal lane-group per context, in order of first
    // appearance, so a resumed context lines up with its own past.
    const bandOrder: string[] = [];
    for (const r of ropes) if (!bandOrder.includes(r.ctx)) bandOrder.push(r.ctx);
    const laneOf = new Map<string, Map<string, number>>();
    for (const r of ropes) {
      let lanes = laneOf.get(r.ctx);
      if (!lanes) laneOf.set(r.ctx, (lanes = new Map()));
      for (const sp of r.spans) if (!lanes.has(sp.path)) lanes.set(sp.path, lanes.size);
    }
    const bandY = new Map<string, number>();
    const bandH = new Map<string, number>();
    let y = HEADER_H;
    for (const ctx of bandOrder) {
      bandY.set(ctx, y);
      const h = this.grain === "ropes" ? ROPE_H : laneOf.get(ctx)!.size * LANE_H + HULL_PAD * 2;
      bandH.set(ctx, h);
      y += h + BAND_GAP;
    }
    const colorOf = (ctx: string) =>
      ctx === "" ? UNASSIGNED_COLOR : PALETTE[bandOrder.filter((c) => c !== "").indexOf(ctx) % PALETTE.length];
    const laneY = (ctx: string, path: string) =>
      (bandY.get(ctx) ?? 0) + HULL_PAD + (laneOf.get(ctx)?.get(path) ?? 0) * LANE_H + LANE_H / 2;

    const scroll = contentEl.createDiv({ cls: "contexts-braid-scroll" });
    const svg = scroll.createSvg("svg", {
      attr: { width: ts.width, height: y, viewBox: `0 0 ${ts.width} ${y}` },
      cls: "contexts-braid-svg",
    });

    const title = (el: SVGElement, text: string) => {
      el.createSvg("title").textContent = text;
    };

    // Session headers, hairline hour grid (Notion-register ruler), separators.
    ts.segs.forEach((seg, i) => {
      const label = svg.createSvg("text", {
        attr: { x: seg.x0, y: HEADER_H - 10 },
        cls: "contexts-braid-session-label",
      });
      label.textContent = `${relDay(seg.start)} ${fmtClock(seg.start)}`;
      // Hour ticks with full-height hairlines; the first hour mark that would
      // collide with the session label is skipped.
      const HOUR = 3600_000;
      for (let t = Math.ceil(seg.start / HOUR) * HOUR; t <= seg.end; t += HOUR) {
        const x = scaleX(ts, t);
        svg.createSvg("line", {
          attr: { x1: x, y1: HEADER_H - 6, x2: x, y2: y },
          cls: "contexts-braid-grid",
        });
        if (x - seg.x0 > 44) {
          const tick = svg.createSvg("text", {
            attr: { x: x + 3, y: HEADER_H - 10 },
            cls: "contexts-braid-tick-label",
          });
          tick.textContent = fmtClock(t);
        }
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
      const nx = scaleX(ts, Math.min(now, lastSeg.end));
      svg.createSvg("line", { attr: { x1: nx, y1: HEADER_H - 4, x2: nx, y2: y }, cls: "contexts-braid-now" });
      svg.createSvg("circle", { attr: { cx: nx, cy: HEADER_H - 4, r: 2.5 }, cls: "contexts-braid-now-dot" });
    }

    // Hulls, one per rope; the band label sits at the band's first rope.
    const labeled = new Set<string>();
    for (const r of ropes) {
      const x0 = scaleX(ts, r.start) - HULL_PAD;
      const x1 = scaleX(ts, r.end) + HULL_PAD;
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
      if (!labeled.has(r.ctx)) {
        labeled.add(r.ctx);
        const dot = svg.createSvg("circle", {
          attr: { cx: x0 + 4, cy: by - 8, r: 3.5 },
          cls: "contexts-braid-band-dot",
        });
        dot.style.fill = colorOf(r.ctx);
        const label = svg.createSvg("text", {
          attr: { x: x0 + 11, y: by - 4 },
          cls: "contexts-braid-band-label",
        });
        label.textContent = r.ctx || "(no context)";
      }
    }

    if (this.grain === "ropes") {
      // Outermost zoom: strands dissolve into hulls; edits remain as beads on the midline.
      for (const r of ropes) {
        const midY = bandY.get(r.ctx)! + ROPE_H / 2;
        for (const sp of r.spans) {
          if (!sp.edit) continue;
          const bead = svg.createSvg("circle", {
            attr: { cx: scaleX(ts, sp.t), cy: midY, r: BEAD_R },
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
          const cy = laneY(r.ctx, path);
          const segments = this.grain === "visits" ? spans.map((sp) => [sp.start, sp.t] as const) : [[spans[0].start, spans[spans.length - 1].t] as const];
          let lastX = 0;
          for (const [t0, t1] of segments) {
            // Thin tinted pill (Notion's bar weight), not a wire.
            const px0 = scaleX(ts, t0);
            const pw = Math.max(scaleX(ts, t1) - px0, 4);
            const pill = svg.createSvg("rect", {
              attr: { x: px0, y: cy - PILL_H / 2, width: pw, height: PILL_H, rx: PILL_H / 2 },
              cls: "contexts-braid-strand",
            });
            pill.style.fill = colorOf(r.ctx);
            title(pill, `${path} · ${fmtClock(t0)} → ${fmtClock(t1)}`);
            pill.addEventListener("click", (evt) => {
              const file = this.app.vault.getAbstractFileByPath(path);
              if (file instanceof TFile) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
            });
            lastX = Math.max(lastX, px0 + pw);
          }
          // Beads: edits. Junction rings: arrivals via a followed link.
          for (const sp of spans) {
            if (sp.via === "link") {
              const ring = svg.createSvg("circle", {
                attr: { cx: scaleX(ts, sp.start), cy, r: BEAD_R + 1.5 },
                cls: "contexts-braid-ring",
              });
              ring.style.stroke = colorOf(r.ctx);
              title(ring, `arrived via link${sp.from ? ` from ${sp.from.split("/").pop()}` : ""}`);
            }
            if (sp.edit) {
              const bead = svg.createSvg("circle", {
                attr: { cx: scaleX(ts, sp.t), cy, r: BEAD_R },
                cls: "contexts-braid-bead",
              });
              bead.style.fill = colorOf(r.ctx);
              title(bead, `edited · ${fmtClock(sp.t)}`);
            }
          }
          // File label beside the strand's end (Notion puts titles next to
          // short bars; lanes are per-file, so labels never stack vertically).
          const label = svg.createSvg("text", {
            attr: { x: lastX + 6, y: cy + 3.5 },
            cls: "contexts-braid-strand-label",
          });
          label.textContent = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
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
          const cx = scaleX(ts, ev.t);
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
      const seamX = (scaleX(ts, a.end) + scaleX(ts, b.start)) / 2;
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
          const newT = invertX(ts, seamX + (uv.clientX - startClientX));
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
  }
}
