import { ItemView, Keymap, TFile, WorkspaceLeaf } from "obsidian";
import { fmtDelta, fmtDur, fmtTime, relTime } from "./format";
import type ContextsPlugin from "./main";
import { applyRenames, coalesceTrail, groupSessions, healRenames, isStint, relatedTo, trailFor } from "./views";

export const CONTEXTS_VIEW_TYPE = "contexts-pane";

const RELATED_LIMIT = 15;
const TRAIL_LIMIT = 30;

export class ContextsPane extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: ContextsPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return CONTEXTS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Contexts";
  }

  getIcon(): string {
    return "footprints";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async render(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("contexts-pane");

    const path = this.plugin.lastActiveMdPath;
    if (!path) {
      contentEl.createDiv({ text: "Open a note to see its context.", cls: "contexts-empty" });
      return;
    }

    const s = this.plugin.settings;
    const events = applyRenames(healRenames(await this.plugin.getEvents()));
    const sessions = groupSessions(events, s.sessionGapMin * 60_000);

    const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
    contentEl.createDiv({ text: basename, cls: "contexts-title" });

    // Related now: the co-activation ranking for this file.
    contentEl.createDiv({ text: "Related now", cls: "contexts-section" });
    const halfLife = s.halfLifeDays * 24 * 3600_000;
    const related = relatedTo(path, sessions, Date.now(), halfLife).slice(0, RELATED_LIMIT);
    if (!related.length) {
      contentEl.createDiv({
        text: `Nothing yet. ${sessions.length} session${sessions.length === 1 ? "" : "s"} recorded; companionship accumulates as you work.`,
        cls: "contexts-empty",
      });
    }
    for (const r of related) {
      const row = contentEl.createDiv({ cls: "contexts-row" });
      row.createDiv({ text: r.path.split("/").pop()?.replace(/\.md$/, "") ?? r.path });
      row.createDiv({
        text: `${r.sharedSessions} shared session${r.sharedSessions === 1 ? "" : "s"} · ${relTime(r.lastAt)}`,
        cls: "contexts-row-meta",
      });
      row.setAttribute("aria-label", r.path);
      row.addEventListener("click", (evt) => this.openPath(r.path, evt));
    }

    // Trail: this file's own history, newest first.
    contentEl.createDiv({ text: "Trail", cls: "contexts-section" });
    const trail = coalesceTrail(trailFor(path, events), s.sessionGapMin * 60_000).slice(-TRAIL_LIMIT).reverse();
    if (!trail.length) {
      contentEl.createDiv({ text: "No history yet for this file.", cls: "contexts-empty" });
    }
    for (const ev of trail) {
      const row = contentEl.createDiv({ cls: "contexts-trail-row" });
      if (isStint(ev)) {
        const stints = ev.count > 1 ? ` · ${ev.count} stints` : "";
        row.createDiv({ text: `${fmtTime(ev.start)} · ${fmtDur(ev.dur)}${stints}` });
        const delta = ev.edit ? fmtDelta(ev.edit) : "";
        if (delta) row.createDiv({ text: delta, cls: "contexts-trail-delta" });
      } else {
        const label =
          ev.type === "create" ? "created"
          : ev.type === "delete" ? "deleted"
          : ev.type === "extmod" ? "edited externally"
          : "renamed";
        row.createDiv({ text: `${fmtTime(ev.t)} · ${label}`, cls: "contexts-trail-delta" });
      }
    }
  }

  private openPath(path: string, evt: MouseEvent): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
    }
  }
}
