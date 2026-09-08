/**
 * The ```contexts-day``` code block: a live rendering of one day's record,
 * embedded in any note (the daily note is the intended home). A query, not a
 * document — nothing is written, nothing goes stale; the block re-renders as
 * events land. Date comes from the block body (YYYY-MM-DD), else the host
 * note's filename, else today.
 * Provenance: Blake's codebox-mirror idea; Dataview's block-as-query pattern.
 */
import { MarkdownRenderChild, setIcon } from "obsidian";
import { fmtClock, fmtDelta, fmtDur } from "./format";
import type ContextsPlugin from "./main";
import { applyRenames, excludeFolders, groupSessions, healRenames, mergeDeltas } from "./views";
import { EditDelta, isSpan } from "./recorder";

export class DayBlock extends MarkdownRenderChild {
  // Expanded session groups, keyed by session start; survives re-renders of this block.
  private openSessions = new Set<number>();

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
  }

  private resolveDayStart(): number {
    const fromSource = this.source.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const fromPath = this.sourcePath.split("/").pop()?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const iso = fromSource ?? fromPath;
    const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  async render(): Promise<void> {
    const el = this.containerEl;
    el.empty();
    el.addClass("contexts-pane", "contexts-day-block");
    const s = this.plugin.settings;
    const events = excludeFolders(applyRenames(healRenames(await this.plugin.getEvents())), s.excludedFolders);
    const dayStart = this.resolveDayStart();
    const dayEnd = dayStart + 24 * 3600_000;
    const dayEvents = events.filter((ev) => ev.t >= dayStart && ev.t < dayEnd);
    if (!dayEvents.length) {
      el.createDiv({ text: "Nothing recorded this day.", cls: "contexts-empty" });
      return;
    }

    const sessions = groupSessions(dayEvents, s.sessionGapMin * 60_000);
    const engagedTotal = sessions.reduce((sum, x) => sum + x.spans.reduce((a, sp) => a + sp.dur, 0), 0);
    const files = new Set(dayEvents.filter(isSpan).map((sp) => sp.path));
    el.createDiv({
      text: `${fmtDur(engagedTotal)} engaged · ${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${files.size} file${files.size === 1 ? "" : "s"}`,
      cls: "contexts-title",
    });

    for (const sess of sessions) {
      const engaged = sess.spans.reduce((sum, sp) => sum + sp.dur, 0);
      const open = this.openSessions.has(sess.start);
      const header = el.createDiv({ cls: "contexts-section contexts-expandable contexts-session-header" });
      const caret = header.createSpan({ cls: "contexts-chip-icon" });
      setIcon(caret, open ? "chevron-down" : "chevron-right");
      header.createSpan({
        text: `${fmtClock(sess.start)} → ${fmtClock(sess.end)} · ${fmtDur(engaged)} · ${sess.files.length} file${sess.files.length === 1 ? "" : "s"}`,
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
        row.createDiv({ text: f.split("/").pop()?.replace(/\.md$/, "") ?? f, cls: "contexts-row-title" });
        const meta = row.createDiv({ cls: "contexts-row-meta contexts-row-metaline" });
        meta.createSpan({
          text: `${fmtDur(dur)} · ${spans.length} visit${spans.length === 1 ? "" : "s"}`,
          cls: "contexts-row-folder",
        });
        if (edit) meta.createSpan({ text: fmtDelta(edit), cls: "contexts-row-when" });
        row.setAttribute("aria-label", f);
        // Opening from the day block IS a link interaction: route through
        // openLinkText so provenance capture sees it.
        row.addEventListener("click", () => {
          void this.plugin.app.workspace.openLinkText(f, this.sourcePath);
        });
      }
    }
  }
}
