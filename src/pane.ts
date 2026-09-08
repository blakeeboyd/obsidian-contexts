import { App, ItemView, Keymap, Menu, Modal, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type { EditDelta } from "./recorder";
import { fmtClock, fmtDeltaVerbose, fmtDur, fmtTime, relDay, relTime } from "./format";
import type ContextsPlugin from "./main";
import {
  MIN_RELATED_SCORE,
  PairScore,
  Session,
  UNRELATED_WEIGHT,
  allRelationships,
  applyRenames,
  coalesceTrail,
  groupSessions,
  healRenames,
  isStint,
  relatedTo,
  trailFor,
  unrelatedPairs,
} from "./views";

export const CONTEXTS_VIEW_TYPE = "contexts-pane";

/** One relationship row: clickable names, score meta, dismiss/restore action. Shared by pane and modal. */
function renderPairRow(plugin: ContextsPlugin, container: HTMLElement, p: PairScore, onToggled?: () => void): void {
  const row = container.createDiv({ cls: "contexts-row" });
  const title = row.createDiv({ cls: "contexts-row-title" });
  const base = (path: string) => path.split("/").pop()?.replace(/\.md$/, "") ?? path;
  const nameSpan = (path: string) => {
    const el = title.createSpan({ text: base(path), cls: "contexts-link" });
    el.setAttribute("title", path);
    el.addEventListener("click", (evt) => {
      evt.stopPropagation();
      const file = plugin.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) void plugin.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
    });
  };
  nameSpan(p.a);
  title.createSpan({ text: " ↔ " });
  nameSpan(p.b);
  const meta = p.dismissed
    ? `${p.dismissedAt ? `hidden ${fmtTime(p.dismissedAt)}` : "hidden"} · ${p.sharedSessions} shared`
    : `${p.score.toFixed(2)} · ${p.sharedSessions} shared · ${relTime(p.lastAt)}`;
  row.createDiv({ text: meta, cls: "contexts-row-meta" });
  const btn = row.createDiv({ cls: "contexts-row-action" });
  setIcon(btn, p.dismissed ? "rotate-ccw" : "x");
  btn.setAttribute("title", p.dismissed ? "Restore the connection" : "Not related: weight near zero");
  btn.addEventListener("click", (evt) => {
    evt.stopPropagation();
    plugin.markRelated(p.a, p.b, p.dismissed);
    p.dismissed = !p.dismissed;
    p.score = p.dismissed ? p.rawScore * UNRELATED_WEIGHT : p.rawScore;
    onToggled?.();
  });
}

/** The full ranked audit of every pair the log knows, via "Contexts: Show all relationships". */
export class RelationshipsModal extends Modal {
  constructor(app: App, private plugin: ContextsPlugin, private pairs: PairScore[]) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Contexts: all relationships");
    this.renderList();
  }

  private renderList(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (!this.pairs.length) {
      contentEl.createDiv({ text: "No co-activations recorded yet.", cls: "contexts-empty" });
      return;
    }
    const list = contentEl.createDiv({ cls: "contexts-rel-list" });
    const sorted = [...this.pairs].sort((a, b) => b.score - a.score);
    const shown = sorted.slice(0, 200);
    for (const p of sorted.slice(200)) if (p.dismissed) shown.push(p); // hidden pairs always auditable
    for (const p of shown) renderPairRow(this.plugin, list, p, () => this.renderList());
    if (sorted.length > shown.length) {
      list.createDiv({ text: `top ${shown.length} of ${sorted.length}`, cls: "contexts-empty" });
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const RELATED_LIMIT = 15;
const TRAIL_LIMIT = 30;
// The no-note fallback view. ponytail: a full session browser (own tab,
// per-session drill-down) is ticket 05.0302; this is the lazy version.
const SESSION_LIMIT = 5;
const FILES_PER_SESSION = 12;
const RELATIONSHIPS_LIMIT = 30;

export class ContextsPane extends ItemView {
  // Transient: survives the pane's frequent re-renders, resets with the session.
  private relationshipsOpen = false;
  // Focusing the pane closes the active file's span, which logs an event,
  // which re-renders the pane — destroying the element mid-click (mousedown
  // and mouseup must land on the same node). Hold renders while a pointer is
  // down inside the pane; flush on release.
  private pointerHeld = false;
  private renderQueued = false;

  constructor(leaf: WorkspaceLeaf, private plugin: ContextsPlugin) {
    super(leaf);
    this.registerDomEvent(this.containerEl, "pointerdown", () => (this.pointerHeld = true));
    this.registerDomEvent(window, "pointerup", () => {
      this.pointerHeld = false;
      if (this.renderQueued) {
        this.renderQueued = false;
        void this.render();
      }
    });
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
    if (this.pointerHeld) {
      this.renderQueued = true;
      return;
    }
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("contexts-pane");

    const s = this.plugin.settings;
    const events = applyRenames(healRenames(await this.plugin.getEvents()));
    const sessions = groupSessions(events, s.sessionGapMin * 60_000);

    // Sticky path only counts while a note is actually open somewhere AND
    // the main area isn't showing an empty "New tab" — close everything (or
    // open a fresh tab) and the pane falls back to the sessions view.
    const anyNoteOpen = this.app.workspace.getLeavesOfType("markdown").length > 0;
    const mainIsEmpty = this.app.workspace.getMostRecentLeaf()?.view.getViewType() === "empty";
    const path = anyNoteOpen && !mainIsEmpty ? this.plugin.lastActiveMdPath : null;
    if (!path) {
      this.renderSessions(contentEl, sessions);
      return;
    }

    const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
    contentEl.createDiv({ text: basename, cls: "contexts-title" });

    // Related now: the co-activation ranking for this file.
    contentEl.createDiv({ text: "Related now", cls: "contexts-section" });
    const halfLife = s.halfLifeDays * 24 * 3600_000;
    const dismissed = unrelatedPairs(events);
    // Dismissed pairs leave the list outright (the user said "not related");
    // pairs below the evidence floor never enter it (relatedness is a
    // conclusion, not a default — same-session alone doesn't clear the bar).
    const related = relatedTo(path, sessions, Date.now(), halfLife, dismissed)
      .filter((r) => !r.dismissed && r.score >= MIN_RELATED_SCORE)
      .slice(0, RELATED_LIMIT);
    if (!related.length) {
      contentEl.createDiv({
        text: `Nothing yet. ${sessions.length} session${sessions.length === 1 ? "" : "s"} recorded; companionship accumulates as you work.`,
        cls: "contexts-empty",
      });
    }
    for (const r of related) {
      this.fileRow(contentEl, r.path, `${r.sharedSessions} shared · ${relTime(r.lastAt)}`, {
        icon: "x",
        tooltip: "Not related: keep tracking, but weight this connection near zero",
        onClick: () => this.plugin.markRelated(path, r.path, false),
      });
    }
    this.renderHiddenConnections(contentEl, sessions, dismissed, path);

    // Trail: this file's own history, newest first.
    contentEl.createDiv({ text: "Trail", cls: "contexts-section" });
    const trail = coalesceTrail(trailFor(path, events), s.sessionGapMin * 60_000).slice(-TRAIL_LIMIT).reverse();
    if (!trail.length) {
      contentEl.createDiv({ text: "No history yet for this file.", cls: "contexts-empty" });
    }
    for (const ev of trail) {
      // Relatedness feedback is pair-scoped, not part of any single file's trail.
      if (!isStint(ev) && (ev.type === "unrelate" || ev.type === "relate")) continue;
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
            const deltaEl = line.createDiv({ cls: "contexts-span-delta" });
            this.viaLine(deltaEl, span.via, span.from);
            this.renderDelta(deltaEl, span.edit, path);
            this.leftLine(deltaEl, span.left);
            i++;
          } else {
            // Consecutive read-only visits collapse to one line; they're context, not content.
            let j = i;
            let readDur = 0;
            while (j < visits.length && !visits[j].edit) readDur += visits[j++].dur;
            line.createDiv({ text: fmtDur(readDur), cls: "contexts-span-time" });
            const readEl = line.createDiv({ cls: "contexts-span-read" });
            readEl.createSpan({ text: j - i > 1 ? `read ×${j - i}` : "read" });
            this.viaLine(readEl, span.via, span.from);
            this.leftLine(readEl, visits[j - 1].left);
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
          : ev.type === "firstseen" ? ["eye", "first seen by Contexts"]
          : ["arrow-right-left", "renamed"];
        const line = row.createDiv({ cls: "contexts-event-line contexts-trail-delta" });
        line.createSpan({ text: `${fmtTime(ev.t)} · ` });
        setIcon(line.createSpan({ cls: "contexts-chip-icon" }), icon);
        line.setAttribute("title", label);
        line.setAttribute("aria-label", label);
        // Same drill-down as stints: icon scans, the expansion spells it out.
        const details = row.createDiv({ cls: "contexts-trail-details" });
        details.createDiv({ text: `${fmtTime(ev.t)} · ${label}`, cls: "contexts-details-header" });
        details.createDiv({ text: ev.type === "rename" ? `${ev.from} → ${ev.to}` : ev.path });
        if (ev.type === "firstseen") {
          const c = ev.counts;
          if (ev.ctime) details.createDiv({ text: `created ${fmtTime(ev.ctime)}` });
          details.createDiv({
            text: `already had: ${c.words} words · ${c.headings} headings · ${c.highlights} highlights · ${c.footnotes} footnotes · ${c.tasksOpen + c.tasksDone} tasks`,
          });
          if (ev.links?.length) {
            details.createDiv({ text: `links (${ev.links.length}):` });
            for (const target of ev.links) {
              const line = details.createDiv({ cls: "contexts-baseline-item" });
              const link = line.createSpan({ text: target, cls: "contexts-link" });
              link.addEventListener("click", (evt) => {
                evt.stopPropagation();
                const dest = this.app.metadataCache.getFirstLinkpathDest(target, ev.path);
                if (dest) void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(dest);
              });
            }
          }
          if (ev.tags?.length) this.tagLine(details, "tags", ev.tags);
        }
        details.hidden = true;
        row.addClass("contexts-expandable");
        row.addEventListener("click", () => (details.hidden = !details.hidden));
      }
    }
  }

  /**
   * A clickable two-line file row: title, then muted folder path with
   * right-aligned meta. Hover shows Obsidian's page preview; right-click
   * opens the native file menu.
   */
  /**
   * The pane surfaces only what the user hid: dismissed pairs, restorable.
   * Scoped to the current file — a pair between two other files has no
   * business at the bottom of this file's pane. The global view lives only
   * behind the "Show all relationships" command.
   */
  private renderHiddenConnections(
    contentEl: HTMLElement,
    sessions: Session[],
    dismissed: Map<string, number>,
    path: string
  ): void {
    if (!dismissed.size) return;
    const s = this.plugin.settings;
    const pairs = allRelationships(sessions, Date.now(), s.halfLifeDays * 24 * 3600_000, dismissed).filter(
      (p) => p.dismissed && (p.a === path || p.b === path)
    );
    if (!pairs.length) return;
    const label = (open: boolean) => (open ? "Hide hidden connections" : `See hidden connections (${pairs.length})`);
    const toggle = contentEl.createDiv({ cls: "contexts-reveal contexts-expandable" });
    setIcon(toggle.createSpan({ cls: "contexts-chip-icon" }), "eye-off");
    toggle.createSpan({ text: label(this.relationshipsOpen) });
    const list = contentEl.createDiv();
    list.hidden = !this.relationshipsOpen;
    toggle.addEventListener("click", () => {
      this.relationshipsOpen = !this.relationshipsOpen;
      list.hidden = !this.relationshipsOpen;
      toggle.lastChild!.textContent = label(this.relationshipsOpen);
    });
    for (const p of pairs) renderPairRow(this.plugin, list, p);
  }

  private fileRow(
    container: HTMLElement,
    path: string,
    meta: string,
    action?: { icon: string; tooltip: string; onClick: () => void }
  ): void {
    const row = container.createDiv({ cls: "contexts-row" });
    row.createDiv({ text: path.split("/").pop()?.replace(/\.md$/, "") ?? path, cls: "contexts-row-title" });
    const metaLine = row.createDiv({ cls: "contexts-row-meta contexts-row-metaline" });
    // Middle-truncate deep paths to one line: firstfolder/…/lastfolder/
    const segs = path.split("/").slice(0, -1);
    const folder =
      segs.length === 0 ? "/"
      : segs.length <= 2 ? segs.join("/") + "/"
      : `${segs[0]}/…/${segs[segs.length - 1]}/`;
    metaLine.createSpan({ text: folder, cls: "contexts-row-folder" });
    if (meta) metaLine.createSpan({ text: meta, cls: "contexts-row-when" });
    if (action) {
      const btn = row.createDiv({ cls: "contexts-row-action" });
      setIcon(btn, action.icon);
      btn.setAttribute("title", action.tooltip);
      btn.setAttribute("aria-label", action.tooltip);
      btn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        action.onClick();
      });
    }
    row.setAttribute("aria-label", path);
    row.addEventListener("click", (evt) => this.openPath(path, evt));
    const hover = (evt: MouseEvent) => {
      this.app.workspace.trigger("hover-link", {
        event: evt,
        source: CONTEXTS_VIEW_TYPE,
        hoverParent: this,
        targetEl: row,
        linktext: path,
      });
    };
    row.addEventListener("mouseover", hover);
    // mouseover alone misses "hover first, THEN press Cmd" — re-trigger while
    // the modifier is down so the mod-gated preview actually appears.
    row.addEventListener("mousemove", (evt) => {
      if (Keymap.isModifier(evt, "Mod")) hover(evt);
    });
    row.addEventListener("contextmenu", (evt) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return;
      evt.preventDefault();
      const menu = new Menu();
      this.app.workspace.trigger("file-menu", menu, file, CONTEXTS_VIEW_TYPE);
      menu.showAtMouseEvent(evt);
    });
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
        text: `${relDay(sess.start)} · ${fmtClock(sess.start)} → ${fmtClock(sess.end)} · ${fmtDur(engaged)} engaged`,
        cls: "contexts-section",
      });
      for (const f of sess.files.slice(0, FILES_PER_SESSION)) {
        this.fileRow(contentEl, f, "");
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

  /** How the visit ended — shown only when it wasn't a plain switch to another file. */
  private leftLine(el: HTMLElement, left?: string): void {
    if (!left || left === "switch") return;
    const label =
      left === "close" ? "closed the file"
      : left === "blur" ? "left the app"
      : left === "idle" ? "went idle"
      : left === "quit" ? "quit Obsidian"
      : left === "pause" ? "recording paused"
      : left;
    el.createDiv({ text: label, cls: "contexts-via" });
  }

  /** How the visit began: "via link from X" (clickable), or the UI surface it was opened through. */
  private viaLine(el: HTMLElement, via?: string, fromPath?: string): void {
    if (fromPath) {
      const div = el.createDiv({ cls: "contexts-via" });
      div.createSpan({ text: "via link from " });
      const name = fromPath.split("/").pop()?.replace(/\.md$/, "") ?? fromPath;
      const link = div.createSpan({ text: name, cls: "contexts-link" });
      link.setAttribute("title", fromPath);
      link.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.openPath(fromPath, evt);
      });
      return;
    }
    if (!via) return;
    const label =
      via === "explorer" ? "via file explorer"
      : via === "search" ? "via search"
      : via === "switcher" ? "via quick switcher"
      : `via ${via}`;
    el.createDiv({ text: label, cls: "contexts-via" });
  }

  /** A line of clickable link names: "label: A, B, C" where each name opens its file. */
  private linkLine(el: HTMLElement, label: string, targets: string[], sourcePath: string): void {
    if (!targets.length) return;
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
  }

  /** Tags open Obsidian's search for the tag, like a tag in a document body. */
  private tagLine(el: HTMLElement, label: string, tags: string[]): void {
    if (!tags.length) return;
    const div = el.createDiv();
    div.createSpan({ text: `${label}: ` });
    tags.forEach((tag, idx) => {
      if (idx) div.createSpan({ text: ", " });
      const span = div.createSpan({ text: tag, cls: "contexts-link" });
      span.setAttribute("title", `Search ${tag}`);
      span.addEventListener("click", (evt) => {
        evt.stopPropagation();
        // ponytail: internal global-search API — the same thing a body tag click uses.
        const search = (
          this.app as unknown as {
            internalPlugins?: {
              getPluginById?: (id: string) => { instance?: { openGlobalSearch?: (q: string) => void } } | null;
            };
          }
        ).internalPlugins?.getPluginById?.("global-search")?.instance;
        search?.openGlobalSearch?.(`tag:${tag}`);
      });
    });
  }

  /** A visit's changes: link names render as clickable links, tags as search links; everything else as text. */
  private renderDelta(el: HTMLElement, edit: EditDelta, sourcePath: string): void {
    for (const part of fmtDeltaVerbose(edit).split("\n")) {
      if (part.startsWith("links added:")) this.linkLine(el, "links added", edit.linksAdded ?? [], sourcePath);
      else if (part.startsWith("links removed:")) this.linkLine(el, "links removed", edit.linksRemoved ?? [], sourcePath);
      else if (part.startsWith("tags added:")) this.tagLine(el, "tags added", edit.tagsAdded ?? []);
      else if (part.startsWith("tags removed:")) this.tagLine(el, "tags removed", edit.tagsRemoved ?? []);
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
