import { App, ItemView, Keymap, Menu, Modal, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import { isSpan } from "./recorder";
import type { EditDelta, LogEvent, PeekEvent, SpanEvent } from "./recorder";
import { fmtClock, fmtDeltaVerbose, fmtDur, fmtTime, relDay, relTime } from "./format";
import { BRAID_VIEW_TYPE } from "./braid";
import { MAP_VIEW_TYPE } from "./map";
import type ContextsPlugin from "./main";
import {
  ContextSet,
  MIN_RELATED_SCORE,
  PairScore,
  Session,
  UNRELATED_WEIGHT,
  allRelationships,
  allSigils,
  applyErasures,
  applyRenames,
  coalesceTrail,
  assignContexts,
  contextFileSets,
  currentContext,
  evictedFrom,
  fileContexts,
  excludeFolders,
  fileInterest,
  groupSessions,
  guessContext,
  healRenames,
  isStint,
  peekEvents,
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
    const exists = !!plugin.app.vault.getAbstractFileByPath(path);
    const el = title.createSpan({ text: base(path), cls: exists ? "contexts-link" : "contexts-gone-name" });
    el.setAttribute("title", exists ? path : `${path} (no longer exists)`);
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
    ? `${p.dismissedAt ? `hidden ${fmtTime(p.dismissedAt)}` : "hidden"} · ${p.sharedSessions} session${p.sharedSessions === 1 ? "" : "s"}`
    : `${p.score.toFixed(2)} · ${p.sharedSessions} session${p.sharedSessions === 1 ? "" : "s"} · ${relTime(p.lastAt)}`;
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
const ACTIVE_FILES_LIMIT = 8;

export class ContextsPane extends ItemView {
  // Transient: survives the pane's frequent re-renders, resets with the session.
  private relationshipsOpen = false;
  // Which session groups the user has expanded, keyed by session start time.
  private openSessions = new Set<number>();
  // Focusing the pane closes the active file's span, which logs an event,
  // which re-renders the pane — destroying the element mid-click (mousedown
  // and mouseup must land on the same node). Hold renders while a pointer is
  // down inside the pane; flush on release.
  private pointerHeld = false;
  private renderQueued = false;

  constructor(leaf: WorkspaceLeaf, private plugin: ContextsPlugin) {
    super(leaf);
    // Primary button only: a right-click's pointerup is swallowed by the
    // context menu it opens, so arming the hold on it froze the pane until
    // the next real click (renders queued forever).
    this.registerDomEvent(this.containerEl, "pointerdown", (evt) => {
      if (evt.button === 0) this.pointerHeld = true;
    });
    const release = () => {
      this.pointerHeld = false;
      if (this.renderQueued) {
        this.renderQueued = false;
        void this.render();
      }
    };
    this.registerDomEvent(window, "pointerup", release);
    this.registerDomEvent(window, "pointercancel", release);
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
    // Everything is logged; exclusion is a read-time privacy line for
    // RELATIONS only. Excluded files keep their own trail and show in day
    // views, but cannot belong to contexts or relatedness — so the full
    // stream feeds trails, and the excluded stream feeds everything that
    // connects files to each other.
    const events = applyErasures(applyRenames(healRenames(await this.plugin.getEvents())));
    const relEvents = excludeFolders(events, s.excludedFolders);
    const sessions = groupSessions(relEvents, s.sessionGapMin * 60_000);

    // Sticky path only counts while a note is actually open somewhere AND
    // the main area isn't showing an empty "New tab" or one of this plugin's
    // own full views (braid, file map) — there the pane goes general: the
    // user is looking at the whole record, not at a file.
    const anyNoteOpen = this.app.workspace.getLeavesOfType("markdown").length > 0;
    const mainType = this.app.workspace.getMostRecentLeaf()?.view.getViewType();
    const mainIsGeneral = mainType === "empty" || mainType === BRAID_VIEW_TYPE || mainType === MAP_VIEW_TYPE;
    const path = anyNoteOpen && !mainIsGeneral ? this.plugin.lastActiveMdPath : null;
    const excludedBy = path ? s.excludedFolders.find((f) => path === f || path.startsWith(f + "/")) : undefined;

    // The declared context, always visible, one click to switch — the cheap
    // gesture the declared-context model depends on. An excluded file has no
    // context BY BEING excluded, so the line says so instead of implying the
    // current declaration covers it.
    const ctx = currentContext(relEvents);
    // Sigil before name on the highest-traffic surface: the glyph is the
    // primary identity mark, the name confirms it.
    const sigils = allSigils(relEvents);
    const sig = (name: string) => (sigils.get(name) ? `${sigils.get(name)} ` : "");
    // An evicted file under the declared context reads as a contradiction
    // without the parenthetical: the declaration stands, the file is out.
    const evicted = path ? evictedFrom(relEvents, path) : new Set<string>();
    const ctxLine = contentEl.createDiv({ cls: "contexts-reveal contexts-expandable contexts-context" });
    setIcon(ctxLine.createSpan({ cls: "contexts-chip-icon" }), "compass");
    ctxLine.createSpan({
      text: excludedBy
        ? "No context: excluded file"
        : ctx
        ? `Context: ${sig(ctx)}${ctx}${evicted.has(ctx) ? " (this file removed)" : ""}`
        : "No context declared",
    });
    ctxLine.setAttribute("title", "Click to declare or switch context");
    ctxLine.addEventListener("click", () => void this.plugin.openContextModal());

    // The guess, offered quietly: recognition of a return to a known context.
    // Click confirms (logged as a confirmed guess — calibration data); ignoring costs nothing.
    const guess = guessContext(relEvents, Date.now(), s.halfLifeDays * 24 * 3600_000);
    if (guess && !excludedBy) {
      const guessLine = contentEl.createDiv({ cls: "contexts-reveal contexts-expandable contexts-context" });
      setIcon(guessLine.createSpan({ cls: "contexts-chip-icon" }), "sparkles");
      guessLine.createSpan({ text: `Working in ${sig(guess.name)}${guess.name}?` });
      guessLine.setAttribute("title", "Click to confirm the guessed context");
      guessLine.addEventListener("click", () => this.plugin.declareContext(guess.name, "guess"));
    }

    if (!path) {
      this.renderActiveFiles(contentEl, events);
      this.renderSessions(contentEl, groupSessions(events, s.sessionGapMin * 60_000));
      return;
    }

    const basename = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
    contentEl.createDiv({ text: basename, cls: "contexts-title" });

    // Excluded files are still logged and their trail still shows; what they
    // lose is membership — no contexts, no relatedness. Say so.
    if (excludedBy) {
      contentEl.createDiv({
        text: `In the excluded folder "${excludedBy}": the trail is recorded and shown, but this file stays out of contexts and relatedness.`,
        cls: "contexts-empty",
      });
    }

    if (!excludedBy) {
      // The threads this file belongs to: its context memberships, by engaged time.
      const threads = fileContexts(relEvents, path);
      if (threads.length) {
        contentEl.createDiv({
          text: `threads: ${threads.map((th) => `${sig(th.name)}${th.name} (${fmtDur(th.dur)})`).join(" · ")}`,
          cls: "contexts-row-meta",
        });
      }

      // Related now: the co-activation ranking for this file.
      contentEl.createDiv({ text: "Related now", cls: "contexts-section" });
      const halfLife = s.halfLifeDays * 24 * 3600_000;
      const dismissed = unrelatedPairs(relEvents);
      const ctxOfSpans = assignContexts(relEvents);
      // Dismissed pairs leave the list outright (the user said "not related");
      // pairs below the evidence floor never enter it (relatedness is a
      // conclusion, not a default — same-session alone doesn't clear the bar).
      const related = relatedTo(path, sessions, Date.now(), halfLife, dismissed, contextFileSets(relEvents), peekEvents(relEvents), ctxOfSpans)
        .filter((r) => !r.dismissed && r.score >= MIN_RELATED_SCORE)
        .slice(0, RELATED_LIMIT);
      if (!related.length) {
        contentEl.createDiv({
          text: `Nothing yet. ${sessions.length} session${sessions.length === 1 ? "" : "s"} recorded; companionship accumulates as you work.`,
          cls: "contexts-empty",
        });
      }
      for (const r of related) {
        this.fileRow(contentEl, r.path, `${r.sharedSessions} session${r.sharedSessions === 1 ? "" : "s"} · ${relTime(r.lastAt)}`, {
          icon: "x",
          tooltip: "Not related: keep tracking, but weight this connection near zero",
          onClick: () => this.plugin.markRelated(path, r.path, false),
        });
      }
      this.renderHiddenConnections(contentEl, sessions, dismissed, path, contextFileSets(relEvents), peekEvents(relEvents), ctxOfSpans);
    }

    // Trail: this file's own history, newest first.
    contentEl.createDiv({ text: "Trail", cls: "contexts-section" });
    // Every visit came from somewhere: join each span to the previous active
    // file (same session), so arrivals show even without a link click.
    const ctxOf = assignContexts(relEvents);
    const spansSorted = events.filter(isSpan).slice().sort((a, b) => a.start - b.start);
    const cameFrom = new Map<SpanEvent, string>();
    for (let i = 1; i < spansSorted.length; i++) {
      const prev = spansSorted[i - 1];
      const cur = spansSorted[i];
      if (prev.path !== cur.path && cur.start - prev.t <= s.sessionGapMin * 60_000) cameFrom.set(cur, prev.path);
    }
    const trail = coalesceTrail(trailFor(path, events), s.sessionGapMin * 60_000).slice(-TRAIL_LIMIT).reverse();
    if (!trail.length) {
      contentEl.createDiv({ text: "No history yet for this file.", cls: "contexts-empty" });
    }
    for (const ev of trail) {
      // Relatedness feedback and context declarations are not any single file's trail.
      if (!isStint(ev) && (ev.type === "unrelate" || ev.type === "relate" || ev.type === "context" || ev.type === "relabel" || ev.type === "sigil")) continue;
      const row = contentEl.createDiv({ cls: "contexts-trail-row" });
      if (isStint(ev)) {
        const stints = ev.count > 1 ? ` · ${ev.count} stints` : "";
        const stintCtx = ctxOf.get(ev.spans[0]);
        // Icons in the scan layer, words in the read layer: a pencil stint
        // changed the file, a book stint only read it.
        const line = row.createDiv({ cls: "contexts-event-line" });
        setIcon(line.createSpan({ cls: "contexts-chip-icon" }), ev.edit ? "pencil" : "book-open");
        // A stint from another device says so; local stints stay quiet.
        const local = this.plugin.localDeviceId();
        const devices = [...new Set(ev.spans.map((sp) => sp.device).filter((d): d is string => !!d && d !== local))];
        const devText = devices.length ? ` · ${devices.map((d) => this.plugin.deviceLabel(d)).join(", ")}` : "";
        line.createSpan({ text: `${fmtTime(ev.start)} · ${fmtDur(ev.dur)}${stints}${stintCtx ? ` · ${stintCtx}` : ""}${devText}` });
        if (ev.edit) this.renderSummary(row.createDiv({ cls: "contexts-trail-delta" }), ev.edit);
        // The same correction menu as the braid's pills: right-click a stint
        // to move its visits to another context. Excluded files have no
        // membership to correct.
        if (!excludedBy) {
          row.addEventListener("contextmenu", (evt) =>
            this.plugin.openSpanMenu(evt, stintCtx ?? "", path, ev.start, ev.end)
          );
        }
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
            this.arrivalLine(deltaEl, span, cameFrom.get(span));
            if (span.section) deltaEl.createDiv({ text: `§ ${span.section}`, cls: "contexts-via" });
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
            // Arrival belongs to the chronologically first span of the run,
            // exit to the last — which end of the iteration those are depends
            // on the display order.
            const chronoFirst = s.trailDetailNewestFirst ? visits[j - 1] : span;
            const chronoLast = s.trailDetailNewestFirst ? span : visits[j - 1];
            this.arrivalLine(readEl, chronoFirst, cameFrom.get(chronoFirst));
            const secs = [...new Set(visits.slice(i, j).map((v) => v.section).filter((x): x is string => !!x))];
            if (secs.length) {
              readEl.createDiv({
                text: `§ ${secs.slice(0, 3).join(", ")}${secs.length > 3 ? ` +${secs.length - 3}` : ""}`,
                cls: "contexts-via",
              });
            }
            this.leftLine(readEl, chronoLast.left);
            i = j;
          }
        }
        details.hidden = true;
        row.addClass("contexts-expandable");
        row.addEventListener("click", () => (details.hidden = !details.hidden));
      } else {
        const [icon, label] =
          ev.type === "create" ? ["file-plus", ev.by ? `created by ${ev.by}` : "created"]
          : ev.type === "delete" ? ["file-x", "deleted"]
          : ev.type === "extmod" ? ["bot", ev.by ? `edited by ${ev.by}` : "edited externally (AI, sync, script)"]
          : ev.type === "firstseen" ? ["eye", "first seen by Contexts"]
          : ev.type === "peek" ? ["glasses", `previewed from ${ev.from.split("/").pop()?.replace(/\.md$/, "") ?? ev.from}`]
          : ev.type === "evict" ? ["scissors", `removed from ${ev.name}`]
          : ev.type === "note" ? ["message-circle", ev.by ? `note by ${ev.by}` : "waypoint note"]
          : ev.type === "reassign" ? ["shuffle", ev.name ? `moved to ${ev.name}` : "unassigned"]
          : ["arrow-right-left", "renamed"];
        const line = row.createDiv({ cls: "contexts-event-line contexts-trail-delta" });
        line.createSpan({ text: `${fmtTime(ev.t)} · ` });
        setIcon(line.createSpan({ cls: "contexts-chip-icon" }), icon);
        line.setAttribute("title", label);
        line.setAttribute("aria-label", label);
        // A waypoint's text IS the event: it reads inline, no expansion needed.
        if (ev.type === "note") line.createSpan({ text: ` ${ev.text}`, cls: "contexts-note-text" });
        // An external edit that knows what changed shows it, same as a stint.
        if (ev.type === "extmod" && ev.edit) this.renderSummary(row.createDiv({ cls: "contexts-trail-delta" }), ev.edit);
        // Same drill-down as stints: icon scans, the expansion spells it out.
        const details = row.createDiv({ cls: "contexts-trail-details" });
        details.createDiv({ text: `${fmtTime(ev.t)} · ${label}`, cls: "contexts-details-header" });
        details.createDiv({ text: ev.type === "rename" ? `${ev.from} → ${ev.to}` : ev.type === "note" ? ev.text : ev.path });
        if (ev.type === "extmod" && ev.edit) this.renderDelta(details.createDiv({ cls: "contexts-trail-delta" }), ev.edit, ev.path);
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
    // Files older than the plugin still have a birth: show the filesystem's
    // creation date when no create was ever logged. Labeled as the
    // filesystem's word — a synced copy's ctime is its arrival on this
    // device, not necessarily the true origin.
    if (!trail.some((ev) => !isStint(ev) && ev.type === "create")) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) {
        const row = contentEl.createDiv({ cls: "contexts-trail-row" });
        const line = row.createDiv({ cls: "contexts-event-line contexts-trail-delta" });
        line.createSpan({ text: `${fmtTime(f.stat.ctime)} · ` });
        setIcon(line.createSpan({ cls: "contexts-chip-icon" }), "file-plus");
        line.createSpan({ text: " created (filesystem date)" });
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
    path: string,
    ctxSets: Map<string, ContextSet>,
    peeks: PeekEvent[],
    ctxOf: Map<SpanEvent, string>
  ): void {
    if (!dismissed.size) return;
    const s = this.plugin.settings;
    // Full evidence, so a hidden pair's score here agrees with the audit modal.
    const pairs = allRelationships(sessions, Date.now(), s.halfLifeDays * 24 * 3600_000, dismissed, ctxSets, peeks, ctxOf).filter(
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
    // History is real whether or not the file survived; a dead companion is
    // shown honestly rather than offering a door that opens nowhere.
    const exists = !!this.app.vault.getAbstractFileByPath(path);
    if (!exists) row.addClass("contexts-gone");
    row.createDiv({ text: path.split("/").pop()?.replace(/\.md$/, "") ?? path, cls: "contexts-row-title" });
    const metaLine = row.createDiv({ cls: "contexts-row-meta contexts-row-metaline" });
    if (!exists) metaLine.createSpan({ text: "no longer exists · ", cls: "contexts-row-folder" });
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

  /** Per-file attention ranking (Mylyn-style DOI): where attention has been living lately. */
  private renderActiveFiles(contentEl: HTMLElement, events: LogEvent[]): void {
    const halfLife = this.plugin.settings.halfLifeDays * 24 * 3600_000;
    const hot = [...fileInterest(events, Date.now(), halfLife).entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, ACTIVE_FILES_LIMIT);
    if (!hot.length) return;
    contentEl.createDiv({ text: "Active files", cls: "contexts-section" });
    // Ranked by interest; the score itself stays internal.
    for (const [f] of hot) {
      this.fileRow(contentEl, f, "");
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
      // Collapsed by default: a summary line per session, files on demand.
      const open = this.openSessions.has(sess.start);
      const header = contentEl.createDiv({ cls: "contexts-section contexts-expandable contexts-session-header" });
      const caret = header.createSpan({ cls: "contexts-chip-icon" });
      setIcon(caret, open ? "chevron-down" : "chevron-right");
      header.createSpan({
        text: `${relDay(sess.start)} · ${fmtClock(sess.start)} → ${fmtClock(sess.end)} · ${fmtDur(engaged)} · ${sess.files.length} file${sess.files.length === 1 ? "" : "s"}`,
      });
      const list = contentEl.createDiv();
      list.hidden = !open;
      header.addEventListener("click", () => {
        const nowOpen = list.hidden;
        list.hidden = !nowOpen;
        if (nowOpen) this.openSessions.add(sess.start);
        else this.openSessions.delete(sess.start);
        setIcon(caret, nowOpen ? "chevron-down" : "chevron-right");
      });
      for (const f of sess.files.slice(0, FILES_PER_SESSION)) {
        this.fileRow(list, f, "");
      }
      if (sess.files.length > FILES_PER_SESSION) {
        list.createDiv({ text: `+${sess.files.length - FILES_PER_SESSION} more`, cls: "contexts-empty" });
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
    if (e.urlsAdded || e.urlsRemoved) chip("globe", pm(e.urlsAdded, e.urlsRemoved), "external links");
    if (e.embedsAdded || e.embedsRemoved) chip("layers", pm(e.embedsAdded, e.embedsRemoved), "embeds");
    if (e.blockIdsAdded || e.blockIdsRemoved) chip("anchor", pm(e.blockIdsAdded, e.blockIdsRemoved), "block IDs");
    if (e.calloutsAdded || e.calloutsRemoved) chip("info", pm(e.calloutsAdded, e.calloutsRemoved), "callouts");
    if (e.commentsAdded || e.commentsRemoved) chip("percent", pm(e.commentsAdded, e.commentsRemoved), "comments");
    if (e.struckAdded || e.struckRemoved) chip("strikethrough", pm(e.struckAdded, e.struckRemoved), "strikethrough");
    if (e.codeBlocks || e.codeLangsAdded || e.codeLangsRemoved) chip("code", num(e.codeBlocks ?? 0), "code blocks");
    if (e.math) chip("sigma", num(e.math), "math");
    if (e.tables) chip("table", num(e.tables), "tables");
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

  /**
   * How the visit began: "via link from X" when a link was followed, else
   * "from X" (the previous active file) plus the UI surface when known.
   */
  private arrivalLine(el: HTMLElement, span: SpanEvent, cameFrom?: string): void {
    const surface =
      span.via === "explorer" ? "via file explorer"
      : span.via === "search" ? "via search"
      : span.via === "switcher" ? "via quick switcher"
      : span.via && span.via !== "link" ? `via ${span.via}`
      : "";
    const fromPath = span.from ?? cameFrom;
    if (!fromPath && !surface) return;
    const div = el.createDiv({ cls: "contexts-via" });
    if (fromPath) {
      div.createSpan({ text: span.from ? "via link from " : "from " });
      const name = fromPath.split("/").pop()?.replace(/\.md$/, "") ?? fromPath;
      const link = div.createSpan({ text: name, cls: "contexts-link" });
      link.setAttribute("title", fromPath);
      link.addEventListener("click", (evt) => {
        evt.stopPropagation();
        this.openPath(fromPath, evt);
      });
      if (surface) div.createSpan({ text: ` · ${surface}` });
    } else {
      div.createSpan({ text: surface });
    }
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
        // Targets may carry a #subpath; resolve on the file part.
        const dest = this.app.metadataCache.getFirstLinkpathDest(target.split("#")[0], sourcePath);
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
      else if (part.startsWith("external links added:")) this.urlLine(el, "external links added", edit.urlsAdded ?? []);
      else if (part.startsWith("external links removed:"))
        this.urlLine(el, "external links removed", edit.urlsRemoved ?? []);
      else if (part.startsWith("embeds added:")) this.linkLine(el, "embeds added", edit.embedsAdded ?? [], sourcePath);
      else if (part.startsWith("embeds removed:"))
        this.linkLine(el, "embeds removed", edit.embedsRemoved ?? [], sourcePath);
      else el.createDiv({ text: part });
    }
  }

  /** External URLs as real anchors: click opens in the browser. */
  private urlLine(el: HTMLElement, label: string, urls: string[]): void {
    if (!urls.length) return;
    const div = el.createDiv();
    div.createSpan({ text: `${label}: ` });
    urls.forEach((url, idx) => {
      if (idx) div.createSpan({ text: ", " });
      const a = div.createEl("a", { text: url, href: url, cls: "contexts-link" });
      a.addEventListener("click", (evt) => evt.stopPropagation());
    });
  }

  private openPath(path: string, evt: MouseEvent): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
    }
  }
}
