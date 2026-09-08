import { ItemView, Keymap, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { EditDelta } from "./recorder";
import { fmtClock, fmtDeltaVerbose, fmtDur, fmtTime, relTime } from "./format";
import type ContextsPlugin from "./main";
import { Session, applyRenames, coalesceTrail, groupSessions, healRenames, isStint, relatedTo, trailFor } from "./views";

export const CONTEXTS_VIEW_TYPE = "contexts-pane";

const RELATED_LIMIT = 15;
const TRAIL_LIMIT = 30;
// The no-note fallback view. ponytail: a full session browser (own tab,
// per-session drill-down) is ticket 05.0302; this is the lazy version.
const SESSION_LIMIT = 5;
const FILES_PER_SESSION = 12;

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

    const s = this.plugin.settings;
    const events = applyRenames(healRenames(await this.plugin.getEvents()));
    const sessions = groupSessions(events, s.sessionGapMin * 60_000);

    // Sticky path only counts while a note is actually open somewhere;
    // close all notes and the pane falls back to the sessions view.
    const anyNoteOpen = this.app.workspace.getLeavesOfType("markdown").length > 0;
    const path = anyNoteOpen ? this.plugin.lastActiveMdPath : null;
    if (!path) {
      this.renderSessions(contentEl, sessions);
      return;
    }

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
        if (ev.edit) this.renderSummary(row.createDiv({ cls: "contexts-trail-delta" }), ev.edit);
        // Click to expand: every visit, chronological — time, length, what changed then.
        const details = row.createDiv({ cls: "contexts-trail-details" });
        details.createDiv({
          text: `${fmtClock(ev.start)} → ${fmtClock(ev.end)} · ${fmtDur(ev.dur)} engaged · ${ev.count} visit${ev.count === 1 ? "" : "s"}`,
          cls: "contexts-details-header",
        });
        const visits = s.trailDetailNewestFirst ? [...ev.spans].reverse() : ev.spans;
        for (let i = 0; i < visits.length; ) {
          const span = visits[i];
          const line = details.createDiv({ cls: "contexts-span-line" });
          line.createDiv({ text: fmtClock(span.start), cls: "contexts-span-time" });
          if (span.edit) {
            line.createDiv({ text: fmtDur(span.dur), cls: "contexts-span-time" });
            this.renderDelta(line.createDiv({ cls: "contexts-span-delta" }), span.edit, path);
            i++;
          } else {
            // Consecutive read-only visits collapse to one line; they're context, not content.
            let j = i;
            let readDur = 0;
            while (j < visits.length && !visits[j].edit) readDur += visits[j++].dur;
            line.createDiv({ text: fmtDur(readDur), cls: "contexts-span-time" });
            line.createDiv({ text: j - i > 1 ? `read ×${j - i}` : "read", cls: "contexts-span-read" });
            i = j;
          }
        }
        details.hidden = true;
        row.addClass("contexts-expandable");
        row.addEventListener("click", () => (details.hidden = !details.hidden));
      } else {
        const [icon, label] =
          ev.type === "create" ? ["file-plus", "created"]
          : ev.type === "delete" ? ["file-x", "deleted"]
          : ev.type === "extmod" ? ["bot", "edited externally (AI, sync, script)"]
          : ["arrow-right-left", "renamed"];
        const line = row.createDiv({ cls: "contexts-event-line contexts-trail-delta" });
        line.createSpan({ text: `${fmtTime(ev.t)} · ` });
        setIcon(line.createSpan({ cls: "contexts-chip-icon" }), icon);
        line.setAttribute("title", label);
        line.setAttribute("aria-label", label);
      }
    }
  }

  /** No note open: show the last few sessions and the files each touched. */
  private renderSessions(contentEl: HTMLElement, sessions: Session[]): void {
    contentEl.createDiv({ text: "Recent sessions", cls: "contexts-title" });
    if (!sessions.length) {
      contentEl.createDiv({ text: "Nothing recorded yet. Work in some notes and come back.", cls: "contexts-empty" });
      return;
    }
    for (const sess of sessions.slice(-SESSION_LIMIT).reverse()) {
      const engaged = sess.spans.reduce((sum, sp) => sum + sp.dur, 0);
      contentEl.createDiv({
        text: `${fmtTime(sess.start)} → ${fmtClock(sess.end)} · ${fmtDur(engaged)} engaged`,
        cls: "contexts-section",
      });
      for (const f of sess.files.slice(0, FILES_PER_SESSION)) {
        const row = contentEl.createDiv({ cls: "contexts-row" });
        row.createDiv({ text: f.split("/").pop()?.replace(/\.md$/, "") ?? f });
        row.setAttribute("aria-label", f);
        row.addEventListener("click", (evt) => this.openPath(f, evt));
      }
      if (sess.files.length > FILES_PER_SESSION) {
        contentEl.createDiv({ text: `+${sess.files.length - FILES_PER_SESSION} more`, cls: "contexts-empty" });
      }
    }
  }

  /**
   * The collapsed scan layer: icon+count chips instead of words. Expansions
   * keep full words — icons where you scan, prose where you read. Every chip
   * carries a tooltip so the glyphs stay learnable.
   */
  private renderSummary(el: HTMLElement, e: EditDelta): void {
    const chip = (icon: string, text: string, label: string) => {
      const c = el.createSpan({ cls: "contexts-chip" });
      setIcon(c.createSpan({ cls: "contexts-chip-icon" }), icon);
      c.createSpan({ text });
      c.setAttribute("title", label);
      c.setAttribute("aria-label", label);
    };
    const pm = (a?: unknown[], r?: unknown[]) => `+${a?.length ?? 0}/-${r?.length ?? 0}`;
    const num = (n: number) => `${n > 0 ? "+" : ""}${n}`;
    if (e.wordsAdded || e.wordsRemoved) chip("pencil", `+${e.wordsAdded ?? 0}/-${e.wordsRemoved ?? 0}`, "words");
    else if (e.words) chip("pencil", num(e.words), "words");
    if (e.linksAdded || e.linksRemoved) chip("link", pm(e.linksAdded, e.linksRemoved), "links");
    if (e.tagsAdded || e.tagsRemoved) chip("tag", pm(e.tagsAdded, e.tagsRemoved), "tags");
    if (e.headingsAdded || e.headingsRemoved) chip("heading", pm(e.headingsAdded, e.headingsRemoved), "headings");
    else if (e.headingsChanged) chip("heading", "~", "headings reordered");
    if (e.highlightsAdded || e.highlightsRemoved)
      chip("highlighter", pm(e.highlightsAdded, e.highlightsRemoved), "highlights");
    if (e.footnotesAdded || e.footnotesRemoved) chip("asterisk", pm(e.footnotesAdded, e.footnotesRemoved), "footnotes");
    if (e.tasksAdded || e.tasksRemoved) chip("check-square", pm(e.tasksAdded, e.tasksRemoved), "tasks added/removed");
    if (e.tasksCompleted) chip("check", `${e.tasksCompleted.length}`, "tasks completed");
    if (e.tasksReopened) chip("undo-2", `${e.tasksReopened.length}`, "tasks reopened");
    if (e.bold) chip("bold", num(e.bold), "bold");
    if (e.italic) chip("italic", num(e.italic), "italic");
    if (e.fmChanged) {
      const n = Array.isArray(e.fmChanged) ? e.fmChanged.length : Object.keys(e.fmChanged).length;
      chip("braces", `${n}`, "frontmatter fields");
    }
  }

  /** A visit's changes: link names render as clickable links to their files; everything else as text. */
  private renderDelta(el: HTMLElement, edit: EditDelta, sourcePath: string): void {
    const linkLine = (label: string, targets?: string[]) => {
      if (!targets?.length) return;
      const div = el.createDiv();
      div.createSpan({ text: `${label}: ` });
      targets.forEach((target, idx) => {
        if (idx) div.createSpan({ text: ", " });
        const link = div.createSpan({ text: target, cls: "contexts-link" });
        link.addEventListener("click", (evt) => {
          evt.stopPropagation(); // don't collapse the row
          const dest = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
          if (dest) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(dest);
        });
      });
    };
    for (const part of fmtDeltaVerbose(edit).split("\n")) {
      if (part.startsWith("links added:")) linkLine("links added", edit.linksAdded);
      else if (part.startsWith("links removed:")) linkLine("links removed", edit.linksRemoved);
      else el.createDiv({ text: part });
    }
  }

  private openPath(path: string, evt: MouseEvent): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
    }
  }
}
