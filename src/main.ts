import { App, EventRef, FuzzySuggestModal, MarkdownView, Menu, Modal, Notice, Platform, Plugin, SuggestModal, TFile, parseYaml, setIcon } from "obsidian";
import { fmtEvent, fmtTime } from "./format";
import { EventLog, getDeviceId, migrateLogDir } from "./log";
import { ContextsBlock } from "./dayblock";
import { dailyMarkdown, upsertDaySection } from "./daily";
import { CONTEXTS_VIEW_TYPE, ContextsPane, RelationshipsModal } from "./pane";
import { BRAID_VIEW_TYPE, BraidView } from "./braid";
import { MAP_VIEW_TYPE, MapView } from "./map";
import {
  LeaveReason,
  LogEvent,
  OpenMethod,
  Opened,
  Recorder,
  Snapshot,
  extractFootnotes,
  extractFormatting,
  extractHeadings,
  countMath,
  countTables,
  emptySnapshot,
  extractBlockIds,
  extractCallouts,
  extractCode,
  extractComments,
  extractHighlights,
  extractRefs,
  extractStruck,
  extractTags,
  extractTasks,
  extractUrls,
  firstSeenCounts,
  sectionAtLine,
  fmTagList,
  isSpan,
  stripCodeFences,
} from "./recorder";
import { ContextsSettingTab, ContextsSettings, DEFAULT_SETTINGS } from "./settings";
import {
  ANON_CONTEXT_RE,
  ContextSet,
  STARTER_SIGILS,
  allRelationships,
  allSigils,
  applyErasures,
  applyRenames,
  assignContexts,
  contextFileSets,
  contextNames,
  currentContext,
  evictedFrom,
  fileContexts,
  excludeFolders,
  fileRunStart,
  groupSessions,
  knownLinks,
  peekEvents,
  derivedLabel,
  pinnedSigils,
  recentSigils,
  topFiles,
  healRenames,
  relatedTo,
  unrelatedPairs,
} from "./views";

// The braid view is parked for the beta; the map covers its ground for now.
const BRAID_ENABLED = false;

// A modify event on a path this soon after its span closed is the editor's
// trailing autosave, not an external edit.
const RECENT_DEACT_GRACE_MS = 3000;
// One extmod per path per window; AI and sync writes arrive in bursts.
const EXTMOD_COALESCE_MS = 15_000;
// A plugin-write announcement older than this can't explain the current modify.
const PLUGIN_WRITE_WINDOW_MS = 15_000;
const IDLE_CHECK_MS = 60_000;
// A link click older than this can't explain the current activation.
const LINK_OPEN_WINDOW_MS = 3000;
// One peek per link pair per window; re-hovering the same link is one read.
const PEEK_COALESCE_MS = 60_000;

export default class ContextsPlugin extends Plugin {
  settings: ContextsSettings = DEFAULT_SETTINGS;
  /** The last markdown file that was active; sticky while focus is in a sidebar. */
  lastActiveMdPath: string | null = null;
  private recorder = new Recorder();
  private log!: EventLog;
  // Serializes all recorder/log operations so async snapshots never interleave.
  private queue: Promise<void> = Promise.resolve();
  private lastActivity = Date.now();
  private idleClosed = false;
  private recentDeact = new Map<string, number>();
  private lastExtmod = new Map<string, number>();
  // In-memory copy of the log so views never wait on file IO after first load.
  private events: LogEvent[] | null = null;
  // Set when a link click routed through openLinkText; consumed by the next activation.
  private pendingLinkFrom: { from: string; t: number } | null = null;
  // The last open-capable UI surface the user touched (explorer click, search click, modal selection).
  private lastUiOpen: { via: OpenMethod; t: number } | null = null;
  // Plugin-write contract: writers announce themselves before writing
  // (app.workspace.trigger("contexts:plugin-write", path, writer)), and the
  // matching modify/create is attributed instead of logged anonymously.
  // Provenance: cwagner223355/obsidian-recent-edits.
  private pendingPluginWrite = new Map<string, { writer: string; t: number }>();
  private lastPeek = new Map<string, number>();
  // When the current file activated (the open span's start), for covers.
  private lastActivationAt: number | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.capture = Object.assign({}, DEFAULT_SETTINGS.capture, this.settings.capture);
    // A restart ends the sitting too: the veil lifts on load unless it's set to keep.
    if (this.settings.veil && this.settings.veilLifts !== "keep") {
      this.settings.veil = false;
      await this.saveData(this.settings);
    }
    this.addSettingTab(new ContextsSettingTab(this.app, this));

    // The log lives IN the vault (visible folder) so vault sync carries it
    // between devices: Obsidian Sync moves a plugin's code and data.json but
    // NOT arbitrary files in the plugin folder, which is why shards written
    // under the plugin dir never crossed devices. Legacy shards migrate on
    // load. Requires Sync's "all other types" toggle for .jsonl.
    await migrateLogDir(this.app.vault.adapter, `${this.manifest.dir}/log`, this.settings.logFolder);
    this.log = new EventLog(this.app.vault.adapter, this.settings.logFolder, getDeviceId());

    this.registerView(CONTEXTS_VIEW_TYPE, (leaf) => new ContextsPane(leaf, this));
    this.registerView(BRAID_VIEW_TYPE, (leaf) => new BraidView(leaf, this));
    this.registerView(MAP_VIEW_TYPE, (leaf) => new MapView(leaf, this));
    this.registerHoverLinkSource(CONTEXTS_VIEW_TYPE, { display: "Muninn", defaultMod: true });
    // One block, three spellings: `muninn` is the block; `contexts` and
    // `contexts-day` stay working aliases from before the rename.
    for (const lang of ["muninn", "contexts", "contexts-day"]) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => {
        ctx.addChild(new ContextsBlock(this, el, source, ctx.sourcePath));
      });
    }
    this.patchOpenLinkText();
    this.patchSuggestModal();

    // Plugin-write contract (custom event, untyped in the API).
    const ws = this.app.workspace as unknown as {
      on(name: string, cb: (path: string, writer: string) => void): EventRef;
    };
    // Both spellings honored: "muninn:plugin-write" and the pre-rename name.
    for (const evName of ["muninn:plugin-write", "contexts:plugin-write"]) {
      this.registerEvent(
        ws.on(evName, (path, writer) => {
          if (typeof path === "string" && typeof writer === "string" && writer) {
            this.pendingPluginWrite.set(path, { writer, t: Date.now() });
          }
        })
      );
    }

    // A hover preview is a link followed with the eyes: log the peek,
    // keyed to the previewed file with the source as its from.
    const wsHover = this.app.workspace as unknown as {
      on(name: "hover-link", cb: (data: { linktext?: unknown; sourcePath?: unknown }) => void): EventRef;
    };
    this.registerEvent(
      wsHover.on("hover-link", (data) => {
        if (!this.settings.capture.hovers) return;
        const linktext = data?.linktext;
        const sourcePath = data?.sourcePath;
        if (typeof linktext !== "string" || !linktext || typeof sourcePath !== "string" || !sourcePath) return;
        const dest = this.app.metadataCache.getFirstLinkpathDest(linktext.split("#")[0], sourcePath);
        if (!dest || dest.extension !== "md" || dest.path === sourcePath) return;
        if (!this.tracked(dest.path)) return;
        const now = Date.now();
        const key = `${sourcePath}\u0000${dest.path}`;
        if (now - (this.lastPeek.get(key) ?? 0) < PEEK_COALESCE_MS) return;
        this.lastPeek.set(key, now);
        this.enqueue(async () => {
          // The peek may be the record's first contact with this file: the
          // baseline is captured through the reader's eyes, before any later
          // edits can blur what the file looked like when first met.
          await this.ensureBaseline(dest);
          await this.record({ t: now, type: "peek", path: dest.path, from: sourcePath });
        });
      })
    );

    // Classify open-capable surfaces by where the mouse went down; the next
    // activation within the window inherits the hint.
    this.registerDomEvent(
      document,
      "mousedown",
      (evt) => {
        const el = evt.target instanceof Element ? evt.target : null;
        if (!el) return;
        if (el.closest(".nav-files-container")) this.lastUiOpen = { via: "explorer", t: Date.now() };
        else if (el.closest('.workspace-leaf-content[data-type="search"]'))
          this.lastUiOpen = { via: "search", t: Date.now() };
      },
      { capture: true }
    );
    this.addRibbonIcon("footprints", "Open Muninn pane", () => void this.activatePane());
    this.addRibbonIcon("waypoints", "Open file map", () => void this.activateFullView(MAP_VIEW_TYPE));
    this.addCommand({
      id: "open-pane",
      name: "Open pane",
      callback: () => void this.activatePane(),
    });
    // The braid is parked for the beta (Blake, 2026-09-17): the view stays
    // registered so a saved layout holding one still opens, but it has no
    // entry point. Flip to bring it back.
    if (BRAID_ENABLED) {
      this.addCommand({
        id: "open-braid",
        name: "Open braid",
        callback: () => void this.activateBraid(),
      });
    }
    this.addCommand({
      id: "open-map",
      name: "Open file map",
      callback: () => void this.activateFullView(MAP_VIEW_TYPE),
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => {
          this.bumpActivity();
          this.enqueue(() => this.onActiveChange());
          // The pane follows the main area even when nothing records (a tiny
          // span discarded, or switching between full views): general mode
          // over a braid/map tab, file mode over a note.
          for (const leaf of this.app.workspace.getLeavesOfType(CONTEXTS_VIEW_TYPE)) {
            const view = leaf.view as unknown as { render?: () => Promise<void> };
            if (typeof view.render === "function") void view.render();
          }
          this.updateContextBars();
        })
      );
      this.registerEvent(this.app.workspace.on("layout-change", () => this.updateContextBars()));
      this.updateContextBars();
      // App loses/regains focus: close the span so time in other apps is not
      // counted as engagement, reopen it on return.
      this.registerDomEvent(window, "blur", () => this.enqueue(() => this.closeSpan(undefined, "blur")));
      this.registerDomEvent(window, "focus", () => this.enqueue(() => this.onActiveChange()));

      // Activity signals for idle detection: cheap assignments, nothing more.
      for (const evName of ["keydown", "mousedown", "mousemove", "wheel"] as const) {
        this.registerDomEvent(window, evName, () => this.bumpActivity());
      }
      this.registerInterval(window.setInterval(() => this.checkIdle(), IDLE_CHECK_MS));

      // Registered after layout-ready so the vault-load flood of create events is not logged.
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && file.extension === "md" && this.settings.capture.externalEdits && this.tracked(file.path)) {
            const ev: LogEvent = { t: Date.now(), type: "create", path: file.path };
            const by = this.consumeWriter(file.path);
            if (by) ev.by = by;
            this.enqueue(async () => {
              // A newborn from the Web Clipper is born FULL with the
              // clipper's source-URL frontmatter — unlike a user's note,
              // born empty and grown inside a span. Announced writers
              // (the plugin-write contract) take precedence.
              // ponytail: a clipper that creates empty then fills would be
              // missed; extend the check to the follow-up extmod if one
              // ever shows up in practice.
              if (!ev.by) {
                try {
                  const content = await this.app.vault.read(file);
                  if (looksClipped(content)) ev.by = "clipper";
                } catch {
                  // deleted or unreadable between events: create stays unattributed
                }
              }
              await this.record(ev);
            });
          }
        })
      );

      this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));

      // Capture the file already open at startup.
      this.enqueue(() => this.onActiveChange());
    });

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.recorder.handleRename(oldPath, file.path);
          if (this.lastActiveMdPath === oldPath) this.lastActiveMdPath = file.path;
          if (this.tracked(file.path)) {
            this.enqueue(() => this.record({ t: Date.now(), type: "rename", from: oldPath, to: file.path }));
          }
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          if (this.recorder.activePath === file.path) this.recorder.abandon();
          if (this.tracked(file.path)) {
            this.enqueue(() => this.record({ t: Date.now(), type: "delete", path: file.path }));
          }
        }
      })
    );

    this.addCommand({
      id: "dump-recent-history",
      name: "Dump recent history",
      callback: () => void this.dumpHistory(),
    });

    this.addCommand({
      id: "declare-context",
      name: "Declare context",
      callback: () => void this.openContextModal(),
    });

    this.addCommand({
      id: "new-context",
      name: "New context",
      callback: () => {
        void (async () => {
          const names = contextNames(await this.getEvents());
          this.declareContext(`context ${nextContextIndex(names)}`);
        })();
      },
    });

    this.addCommand({
      id: "remove-from-context",
      name: "Remove current file from a context",
      callback: () => void this.openEvictModal(),
    });

    this.addCommand({
      id: "rename-context",
      name: "Rename context",
      callback: () => {
        void (async () => {
          const events = await this.getEvents();
          const names = contextNames(events);
          if (!names.length) {
            new Notice("Muninn: no contexts to rename yet.");
            return;
          }
          new RenameContextModal(this.app, this, names, contextFileSets(events), allSigils(events)).open();
        })();
      },
    });

    this.addCommand({
      id: "insert-day-summary",
      name: "Insert or update day summary in current note",
      callback: () => void this.insertDaySummary(),
    });

    this.addCommand({
      id: "show-relationships",
      name: "Show all relationships",
      callback: () => void this.showRelationships(),
    });

    this.addCommand({
      id: "flush-span",
      name: "Flush current stint to the log",
      // Deterministic capture point: close the open span, write it, reopen.
      // The reopened span coalesces with the closed one at display grain, so
      // views don't show a seam. Run before plugin reloads (onunload's close
      // is fire-and-forget) or anything else that might eat the open span.
      callback: () => {
        this.enqueue(async () => {
          await this.closeSpan();
          await this.onActiveChange();
        });
      },
    });

    this.addCommand({
      id: "add-note",
      name: "Add note to the trail",
      // The waypoint: near-zero ceremony — one command, tiny input, Enter.
      // Attached to the file in front of the user; context is derived at read time.
      callback: () => {
        new NameModal(this.app, "Note to the trail:", "", (text) => {
          text = text.trim();
          if (!text) return;
          const ev: LogEvent = { t: Date.now(), type: "note", text };
          const path = this.recorder.activePath ?? this.lastActiveMdPath;
          if (path) ev.path = path;
          this.enqueue(() => this.record(ev));
        }).open();
      },
    });

    this.addCommand({
      id: "toggle-pause",
      name: "Pause/resume recording",
      callback: () => {
        this.setPaused(!this.settings.paused);
        new Notice(`Muninn: recording ${this.settings.paused ? "paused" : "resumed"}`);
      },
    });

    this.addCommand({
      id: "toggle-veil",
      name: "Toggle the veil (record but show nothing)",
      callback: () => this.setVeil(!this.settings.veil),
    });
  }

  /**
   * Declare (or clear, with "") the current context — a logged event like
   * everything else. A manual declaration made while a file is open covers
   * back to that file's opening in this sitting (Blake's rule), so the file
   * carries no residue of the context it was merely born under.
   */
  declareContext(name: string, via?: "guess" | "auto", quiet = false): void {
    const now = Date.now();
    const ev: LogEvent = { t: now, type: "context", name };
    if (via) ev.via = via;
    if (via !== "auto") {
      const path = this.recorder.activePath ?? this.lastActiveMdPath;
      if (path) {
        const runStart = fileRunStart(applyErasures(applyRenames(this.events ?? [])), path, this.settings.sessionGapMin * 60_000, now);
        const openSpan = this.recorder.activePath === path ? this.lastActivationAt : null;
        const covers = Math.min(runStart ?? Infinity, openSpan ?? Infinity);
        if (covers < now) ev.covers = covers;
      }
    }
    this.enqueue(() => this.record(ev));
    if (!quiet) new Notice(name ? `Context: ${name}` : "Context cleared");
  }

  /**
   * A file remembers where it lives: opening one whose home context differs
   * from the current state ENTERS that context — even from an explicit
   * no-context (the clear governs what CONTEXTLESS files do, not homed
   * ones). The toast informs; Undo restores what was before, including the
   * cleared state. Backdated to the activation instant so the triggering
   * span joins the home context; via:"auto" marks it for calibration.
   */
  private maybeOfferHomeContext(path: string, activatedAt: number): void {
    // A bridge never pulls, in or out: opening the daily note mid-context
    // must not yank you to wherever the note spent the most time.
    if (this.isBridge(path)) return;
    void (async () => {
      const events = await this.getEvents();
      // A manual declaration is FRESH until the user has worked in a
      // different file after it: clicking back into the body of the same
      // file (or reopening it) must never overturn what they just chose.
      // Membership can't protect here — declare, click into the editor,
      // and no span has ENDED under the new context yet, so the file
      // "belongs" only to the old one (the 2026-09-09 one-second yank).
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if ("type" in ev && ev.type === "context") {
          if (ev.via !== "auto") return; // fresh manual declaration stands
          break;
        }
        if (isSpan(ev) && ev.path !== path) break; // worked elsewhere since: normal rules
      }
      const relEvents = excludeFolders(applyErasures(applyRenames(healRenames(events))), this.settings.excludedFolders);
      const threads = fileContexts(relEvents, path);
      const home = threads[0];
      const ctx = currentContext(relEvents);
      // Already among the file's contexts: the user's declared position
      // stands. Auto-switch exists to enter a file's world when you're
      // OUTSIDE it — yanking to the engaged-time winner while you're in
      // another context the file also lives in fought every deliberate
      // "I moved this file to context 2" (2026-09-09).
      if (ctx && threads.some((c) => c.name === ctx)) return;
      if (!home) {
        // The symmetric case: a file the user declared OUT of the current
        // context, with no home elsewhere. Opening it means entering the
        // nothing it lives in — move to no-context, same toast, same Undo.
        if (!ctx || !evictedFrom(relEvents, path).has(ctx)) return;
        const ev: LogEvent = { t: activatedAt, type: "context", name: "", via: "auto" };
        this.enqueue(() => this.record(ev));
        this.switchToast(`No context (this file was removed from ${ctx}). `, ctx);
        return;
      }
      if (home.name === ctx) return;
      const ev: LogEvent = { t: activatedAt, type: "context", name: home.name, via: "auto" };
      this.enqueue(() => this.record(ev));
      this.switchToast(`Context: ${home.name} (this file's home). `, ctx ?? "");
    })();
  }

  /** The informing toast for an automatic context move: text plus a one-click Undo restoring the prior state. */
  private switchToast(text: string, restoreTo: string): void {
    const frag = document.createDocumentFragment();
    frag.append(text);
    const link = document.createElement("a");
    link.textContent = "Undo";
    link.addEventListener("click", () => this.declareContext(restoreTo));
    frag.append(link);
    new Notice(frag, 6000);
  }

  /**
   * The correction menu shared by braid pills and pane trail stints: move
   * these spans to another context, unassign them, or evict the file from
   * the context for all time.
   */
  openSpanMenu(evt: MouseEvent, ctx: string, path: string, from: number, to: number): void {
    evt.preventDefault();
    void (async () => {
      const relEvents = excludeFolders(await this.getEvents(), this.settings.excludedFolders);
      const names = contextNames(relEvents);
      const ctxSets = contextFileSets(relEvents);
      // Anonymous "context N" labels say nothing; show the face's top file.
      const face = (name: string): string => {
        const set = ctxSets.get(name);
        const label = set && ANON_CONTEXT_RE.test(name) ? derivedLabel(set, 1) : "";
        return label ? `${name} · ${label}` : name;
      };
      const menu = new Menu();
      const base = path.split("/").pop()?.replace(/\.md$/, "");
      // The state line: what these visits belong to right now, especially
      // "No context" — the mover needs to see what they're moving from.
      menu.addItem((i) =>
        i.setTitle(ctx ? `In ${face(ctx)}` : "No context").setIcon(ctx ? "compass" : "circle-off").setDisabled(true)
      );
      menu.addSeparator();
      for (const name of names) {
        if (name === ctx) continue;
        menu.addItem((i) =>
          i.setTitle(`Move to ${face(name)}`).setIcon("compass").onClick(() => this.reassignSpans(path, name, from, to))
        );
      }
      if (ctx) {
        menu.addItem((i) =>
          i.setTitle("No context").setIcon("circle-off").onClick(() => this.reassignSpans(path, "", from, to))
        );
        menu.addSeparator();
        menu.addItem((i) =>
          i
            .setTitle(`Remove ${base} from ${face(ctx)} everywhere`)
            .setIcon("scissors")
            .onClick(() => this.evictFromContext(ctx, path))
        );
      }
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Delete these visits from the record")
          .setIcon("trash-2")
          .onClick(() => this.eraseSpans(path, from, to))
      );
      menu.showAtMouseEvent(evt);
    })();
  }

  /**
   * Read-time deletion: these visits vanish from every view. The append-only
   * log keeps them under an erase tombstone, so hand-removing the tombstone
   * line from the shard restores them.
   */
  eraseSpans(path: string, from: number, to: number): void {
    this.enqueue(() => this.record({ t: Date.now(), type: "erase", path, from, to }));
    new Notice(`Deleted visits: ${path.split("/").pop()}`);
  }

  /** Retroactive per-file correction from the braid: these spans belong to `name` ("" = none), whatever was declared. */
  reassignSpans(path: string, name: string, from: number, to: number): void {
    this.enqueue(() => this.record({ t: Date.now(), type: "reassign", path, name, from, to }));
    const base = path.split("/").pop();
    new Notice(name ? `Moved to ${name}: ${base}` : `Unassigned: ${base}`);
  }

  /** The user's judgment that a file does not belong to a context: a logged evict event, honored at read time for all of the file's spans there. */
  evictFromContext(name: string, path: string): void {
    this.enqueue(() => this.record({ t: Date.now(), type: "evict", name, path }));
    new Notice(`Removed from ${name}: ${path.split("/").pop()}`);
  }

  async openEvictModal(): Promise<void> {
    const path = this.lastActiveMdPath;
    if (!path) {
      new Notice("Muninn: open a file first.");
      return;
    }
    const relEvents = excludeFolders(applyErasures(applyRenames(healRenames(await this.getEvents()))), this.settings.excludedFolders);
    const threads = fileContexts(relEvents, path);
    if (!threads.length) {
      new Notice("Muninn: this file belongs to no context.");
      return;
    }
    new EvictModal(this.app, this, path, threads.map((t) => t.name)).open();
  }

  /** Rename a context: a logged relabel event, mapped old name → new at read time. */
  relabelContext(from: string, to: string): void {
    to = to.trim();
    if (!to || to === from) return;
    this.enqueue(() => this.record({ t: Date.now(), type: "relabel", from, to }));
    new Notice(`Context renamed: ${from} → ${to}`);
  }

  /** Pin a context's sigil: a logged event riding the identity pass, so renames carry it. */
  setSigil(name: string, sigil: string): void {
    this.enqueue(() => this.record({ t: Date.now(), type: "sigil", name, sigil }));
  }

  /** The name-and-sigil modal for one context, shared by the rename command and the rail's right-click. */
  async openRenameFor(name: string): Promise<void> {
    const events = await this.getEvents();
    // Renaming an anonymous context starts from the derived label: one Enter
    // adopts the suggestion, and adopting pins it.
    const set = contextFileSets(events).get(name);
    const suggestion = set && ANON_CONTEXT_RE.test(name) ? derivedLabel(set) : "";
    // The sigil event must land BEFORE the relabel (both enqueue FIFO): it
    // addresses the context by its current name, which the rename retires.
    new NameModal(this.app, `Rename "${name}" to:`, suggestion || name, (to) => this.relabelContext(name, to), {
      value: allSigils(events).get(name) ?? "",
      pinned: pinnedSigils(events).get(name) ?? "",
      recent: recentSigils(events),
      onPick: (s) => this.setSigil(name, s),
      onClearName: ANON_CONTEXT_RE.test(name) ? undefined : () => void this.clearContextName(name),
    }).open();
  }

  /** Un-name a context: relabel it to the next free anonymous "context N", so the derived label takes over again. */
  async clearContextName(name: string): Promise<void> {
    const names = contextNames(excludeFolders(await this.getEvents(), this.settings.excludedFolders));
    this.relabelContext(name, `context ${nextContextIndex(names)}`);
  }

  /** Merge one context into another: a relabel onto an existing name, which the identity pass merges. */
  async openMergeModal(from: string): Promise<void> {
    const events = excludeFolders(await this.getEvents(), this.settings.excludedFolders);
    const names = contextNames(events).filter((n) => n !== from);
    if (!names.length) {
      new Notice("Muninn: no other context to merge into.");
      return;
    }
    new PickContextModal(this.app, names, `Merge "${from}" into…`, (to) => this.relabelContext(from, to)).open();
  }

  /** The one-click anonymous mint: declare the next "context N". */
  async mintAnonContext(): Promise<void> {
    const names = contextNames(excludeFolders(await this.getEvents(), this.settings.excludedFolders));
    this.declareContext(`context ${nextContextIndex(names)}`);
  }

  async openContextModal(): Promise<void> {
    if (this.settings.veil) {
      new Notice("Muninn: veiled — lift the veil to switch context.");
      return;
    }
    // Excluded files can't belong to contexts, so the faces skip them.
    const relEvents = excludeFolders(await this.getEvents(), this.settings.excludedFolders);
    new ContextModal(this.app, this, contextNames(relEvents), currentContext(relEvents), contextFileSets(relEvents), allSigils(relEvents)).open();
  }

  /** User feedback on a pair: related=false demotes it in scoring (never deletes); true restores. */
  markRelated(a: string, b: string, related: boolean): void {
    const [x, y] = a < b ? [a, b] : [b, a];
    this.enqueue(() => this.record({ t: Date.now(), type: related ? "relate" : "unrelate", a: x, b: y }));
  }

  /** Pause closes the open span immediately; resume reopens one for the current file. */
  setPaused(v: boolean): void {
    if (this.settings.paused === v) return;
    this.settings.paused = v;
    this.enqueue(() => (v ? this.closeSpan(undefined, "pause") : this.onActiveChange()));
    void this.saveSettings();
  }

  /**
   * Link clicks (editor, preview, backlinks pane) route through
   * Workspace.openLinkText with the source file's path. Intercepting it is
   * how a span learns it was opened by FOLLOWING a link — an interaction the
   * static link graph can't see. ponytail: quick switcher, file explorer,
   * and commands aren't distinguished; absence of `from` covers them all.
   */
  private patchOpenLinkText(): void {
    const plugin = this;
    const proto = Object.getPrototypeOf(this.app.workspace) as {
      openLinkText: (this: unknown, linktext: string, sourcePath: string, ...rest: unknown[]) => unknown;
    };
    const orig = proto.openLinkText;
    proto.openLinkText = function (linktext: string, sourcePath: string, ...rest: unknown[]) {
      if (sourcePath) plugin.pendingLinkFrom = { from: sourcePath, t: Date.now() };
      return orig.call(this, linktext, sourcePath, ...rest);
    };
    this.register(() => {
      proto.openLinkText = orig;
    });
  }

  /**
   * Quick switcher (and every other suggest modal — command palette included)
   * confirms selection through SuggestModal.selectSuggestion, keyboard and
   * click alike. A file activation right after one is an open via that modal.
   */
  private patchSuggestModal(): void {
    const plugin = this;
    const proto = SuggestModal.prototype as unknown as {
      selectSuggestion: (this: unknown, ...args: unknown[]) => unknown;
    };
    const orig = proto.selectSuggestion;
    proto.selectSuggestion = function (...args: unknown[]) {
      plugin.lastUiOpen = { via: "switcher", t: Date.now() };
      return orig.apply(this, args);
    };
    this.register(() => {
      proto.selectSuggestion = orig;
    });
  }

  /**
   * First contact captures the baseline: if no firstseen or create exists for
   * this path (rename-resolved), snapshot the file and log one. Peeks and
   * extmods do NOT count as known — a file only glimpsed or externally
   * written still needs its initial state captured, whichever contact comes
   * first (activation, hover preview, external edit). Returns true when a
   * baseline was just written. ponytail: linear scan per contact; index if
   * the log grows large.
   */
  private async ensureBaseline(file: TFile, snap?: Snapshot): Promise<boolean> {
    const events = applyRenames(await this.getEvents());
    const known = events.some(
      (ev) => "type" in ev && (ev.type === "firstseen" || ev.type === "create") && ev.path === file.path
    );
    if (known) return false;
    const s = snap ?? (file.extension === "md" ? await this.snapshot(file, false) : emptySnapshot());
    await this.record({
      t: Date.now(),
      type: "firstseen",
      path: file.path,
      ctime: file.stat.ctime,
      counts: firstSeenCounts(s),
      links: [...new Set([...s.links, ...s.embeds])],
      tags: s.tags,
    });
    return true;
  }

  /**
   * False only while recording is paused. Excluded folders are still logged:
   * exclusion is a read-time line that keeps their files out of contexts and
   * relatedness while their own trail stays recorded and visible.
   */
  private tracked(_path: string): boolean {
    return !this.settings.paused;
  }

  onunload() {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.barsToken++; // cancel any in-flight bar rebuild
    for (const el of Array.from(document.querySelectorAll(".contexts-header-ctx"))) el.remove();
    // Fire-and-forget: usually completes before the process is gone, and the
    // reader survives a truncated final line if it doesn't.
    this.enqueue(() => this.closeSpan(undefined, "quit"));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshPane();
  }

  /** Persist without re-rendering: for UI state (block heights) no view needs to react to. */
  async saveSettingsQuiet() {
    await this.saveData(this.settings);
  }

  /** The full event history (all devices' shards), loaded once and kept current in memory. */
  async getEvents(): Promise<LogEvent[]> {
    if (!this.events) this.events = await this.log.readAll();
    return this.events;
  }

  private async record(ev: LogEvent): Promise<void> {
    // The veil stamps only behavioral events (visits, peeks, creates,
    // notes); structural events must stay visible or the views' plumbing
    // (renames, baselines, declarations) breaks. Spans stamp at CLOSE time,
    // and setVeil flushes the open span at each toggle, so no span
    // straddles the boundary.
    if (this.settings.veil && (isSpan(ev) || ev.type === "peek" || ev.type === "create" || ev.type === "note")) {
      ev.veiled = true;
    }
    // Tag the in-memory copy so live events match read-tagged ones; append's
    // serializer strips the field (the shard filename is the persisted truth).
    ev.device = getDeviceId();
    this.events?.push(ev);
    await this.log.append(ev);
    this.refreshPane();
  }

  /**
   * The veil: keep recording, show nothing. The boundary is flushed crisp —
   * the open span closes under the OLD state before the flip, so a sitting
   * never straddles the veil.
   */
  setVeil(v: boolean): void {
    if (this.settings.veil === v) return;
    this.enqueue(async () => {
      await this.closeSpan();
      this.settings.veil = v;
      await this.saveSettings(); // refreshPane rides along: views + chip update
      await this.onActiveChange();
    });
    // The header button already shows the state where it's on; the toast
    // only earns its place where it isn't.
    const mode = this.settings.contextBar;
    const barShowing = mode === "always" || (mode === "mobile" && Platform.isMobile);
    if (!barShowing) new Notice(v ? "Muninn: veiled — recording continues, nothing will show" : "Muninn: veil lifted");
  }

  /** A device's display name (settings), falling back to its id. */
  deviceLabel(id: string): string {
    return this.settings.deviceNames[id] || id;
  }

  /** The id of THIS device, for views that only label foreign events. */
  localDeviceId(): string {
    return getDeviceId();
  }

  /** Device ids with shards on disk, for the settings naming UI. */
  listDevices(): Promise<string[]> {
    return this.log.listDevices();
  }

  /** Move the log to another in-vault folder: migrate the files, repoint the writer, reload the views. */
  async setLogFolder(folder: string): Promise<void> {
    folder = folder.trim().replace(/\/+$/, "");
    if (!folder || folder === this.settings.logFolder) return;
    const old = this.settings.logFolder;
    await migrateLogDir(this.app.vault.adapter, old, folder);
    this.settings.logFolder = folder;
    await this.saveSettings();
    this.log = new EventLog(this.app.vault.adapter, folder, getDeviceId());
    this.events = null; // re-read from the new location on next use
    new Notice(`Muninn: log moved to ${folder}`);
  }

  private dayBlocks = new Set<ContextsBlock>();
  private refreshTimer: number | null = null;

  /** The plugin's own views announce the opens they cause, so the record knows the arrival surface. */
  noteUiOpen(via: OpenMethod): void {
    this.lastUiOpen = { via, t: Date.now() };
  }

  /**
   * A bridge file (daily note, inbox) inherits every context it's visited
   * under but never pulls the declaration when opened — it bridges contexts
   * instead of belonging to one. Marked by folder (settings) or frontmatter
   * `context-role: bridge`.
   */
  isBridge(path: string): boolean {
    if (this.settings.bridgeFolders.some((f) => f && (path === f || path.startsWith(f + "/")))) return true;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.["context-role"] === "bridge";
  }

  registerDayBlock(block: ContextsBlock): void {
    this.dayBlocks.add(block);
  }

  unregisterDayBlock(block: ContextsBlock): void {
    this.dayBlocks.delete(block);
  }

  /**
   * Coalesced view refresh. A folder delete fires one vault event per file,
   * and rendering pane + braid + map + day blocks on EVERY logged event ran
   * the full heal/apply/assign pipeline N × views times in a burst — enough
   * to freeze the app. One trailing render per burst is indistinguishable
   * to the eye and O(1) instead of O(N).
   */
  private refreshPane(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      // A restored-but-unvisited tab holds a deferred placeholder view with
      // no render(); it draws itself when revealed, so skipping it is correct.
      for (const type of [CONTEXTS_VIEW_TYPE, BRAID_VIEW_TYPE, MAP_VIEW_TYPE]) {
        for (const leaf of this.app.workspace.getLeavesOfType(type)) {
          const view = leaf.view as unknown as { render?: () => Promise<void> };
          if (typeof view.render === "function") void view.render();
        }
      }
      for (const block of this.dayBlocks) void block.render();
      this.updateContextBars();
    }, 250);
  }

  /**
   * The context chip: the declared context in each markdown view's header
   * row, leftmost among the view actions (beside the reading-mode toggle),
   * one tap to switch — the phone's stand-in for the sidebar pane's compass
   * line. Rebuilt whole on every refresh (a few leaves at most); the guard
   * token keeps overlapping async rebuilds from doubling the chips.
   */
  private barsToken = 0;
  updateContextBars(): void {
    const mode = this.settings.contextBar;
    const show = mode === "always" || (mode === "mobile" && Platform.isMobile);
    const token = ++this.barsToken;
    void (async () => {
      let ctx: string | null = null;
      let sigil: string | undefined;
      if (show) {
        const relEvents = excludeFolders(await this.getEvents(), this.settings.excludedFolders);
        ctx = currentContext(relEvents);
        if (ctx) sigil = allSigils(relEvents).get(ctx);
      }
      if (token !== this.barsToken) return; // a newer rebuild superseded this one
      for (const el of Array.from(document.querySelectorAll(".contexts-header-ctx"))) el.remove();
      if (!show) return;
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        // Into the view header's action row, first child = leftmost action,
        // so it sits just left of the reading-mode toggle (Blake's spot).
        const actions = leaf.view.containerEl.querySelector(".view-header .view-actions");
        if (!actions) continue;
        const bar = createDiv({ cls: ["clickable-icon", "view-action", "contexts-header-ctx"] });
        // An excluded file has no context BY BEING excluded (the pane's
        // compass-line rule): this leaf's chip says so instead of implying
        // the current declaration covers it.
        const path = (leaf.view as MarkdownView).file?.path;
        const excludedBy = path ? this.settings.excludedFolders.find((f) => path === f || path.startsWith(f + "/")) : undefined;
        if (this.settings.veil) {
          // Veiled: the chip becomes the lit pill, and one tap lifts the veil
          // (leaving should be the easy direction). The picker stays shut —
          // a declaration is a visible, timestamped act.
          bar.addClass("is-veiled");
          setIcon(bar.createSpan({ cls: "contexts-chip-icon" }), "venetian-mask");
          bar.createSpan({ text: "Veiled", cls: "contexts-header-ctx-name" });
          bar.setAttribute("aria-label", "In Veiled Mode, actions are recorded but do not appear in your trail and will not appear in the map or any other views. Click to lift the veil.");
        } else if (excludedBy) {
          bar.addClass("is-excluded");
          setIcon(bar.createSpan({ cls: "contexts-chip-icon" }), "eye-off");
          bar.createSpan({ text: "Excluded", cls: "contexts-header-ctx-name" });
          bar.setAttribute("aria-label", `In the excluded folder "${excludedBy}": the trail is recorded, but this file joins no context`);
        } else {
          setIcon(bar.createSpan({ cls: "contexts-chip-icon" }), "compass");
          bar.createSpan({
            text: ctx ? `${sigil ? `${sigil} ` : ""}${ctx}` : "No context",
            cls: "contexts-header-ctx-name",
          });
          bar.setAttribute("aria-label", "Declare or switch context");
        }
        bar.addEventListener("click", () => (this.settings.veil ? this.setVeil(false) : void this.openContextModal()));
        actions.insertAdjacentElement("afterbegin", bar);
      }
    })();
  }

  /**
   * The durable fallback to the live block: write the day's record as real
   * markdown (real wikilinks, so the note gains graph edges to the files)
   * between comment markers in the ACTIVE note. Date from the note's
   * filename, else today. Re-running replaces the marked region.
   */
  private async insertDaySummary(): Promise<void> {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (!file) {
      new Notice("Muninn: open the note to insert into first.");
      return;
    }
    const iso = file.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const events = applyErasures(applyRenames(healRenames(await this.getEvents())));
    const body = dailyMarkdown(events, dayStart, dayStart + 24 * 3600_000, this.settings.sessionGapMin * 60_000);
    await this.app.vault.process(file, (content) => upsertDaySection(content, body));
    new Notice("Muninn: day summary inserted.");
  }

  private async activatePane(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CONTEXTS_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: CONTEXTS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  /** Braid and map are full views: they open as main-area tabs, not sidebar panes. */
  async activateFullView(type: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type)[0];
    const leaf = existing ?? this.app.workspace.getLeaf(true);
    if (!existing) await leaf.setViewState({ type, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private activateBraid(): Promise<void> {
    return this.activateFullView(BRAID_VIEW_TYPE);
  }

  /**
   * Retroactive claims from the braid's seam drag: each becomes a context
   * event stamped now but covering back to `covers`, and the live current
   * declaration is restored afterward so moving history never moves the
   * present. Assignment ties on equal effective time resolve to the later
   * append (assignContexts' sort is stable), which lets a correction win.
   */
  retroDeclare(claims: { name: string; covers: number }[]): void {
    if (!claims.length) return;
    this.enqueue(async () => {
      const prev = currentContext(excludeFolders(await this.getEvents(), this.settings.excludedFolders)) ?? "";
      const t = Date.now();
      for (const c of claims) await this.record({ t, type: "context", name: c.name, covers: c.covers });
      if (claims[claims.length - 1].name !== prev) await this.record({ t, type: "context", name: prev });
    });
    new Notice("Muninn: boundary moved");
  }

  private enqueue(op: () => Promise<void>): void {
    this.queue = this.queue.then(op).catch((e) => console.error("Muninn:", e));
  }

  private bumpActivity(): void {
    this.lastActivity = Date.now();
    if (this.idleClosed) {
      this.idleClosed = false;
      this.enqueue(() => this.onActiveChange());
    }
  }

  /** No input for the timeout: close the span back-dated to the last real activity. */
  private checkIdle(): void {
    const timeoutMs = this.settings.idleTimeoutMin * 60_000;
    if (!timeoutMs || !this.recorder.activePath) return;
    if (Date.now() - this.lastActivity < timeoutMs) return;
    this.idleClosed = true;
    const end = this.lastActivity;
    this.enqueue(() => this.closeSpan(end, "idle"));
    // Going idle ends the sitting: a session-scoped veil lifts with it.
    if (this.settings.veil && this.settings.veilLifts === "session") this.setVeil(false);
  }

  private onModify(file: unknown): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (file.path === this.recorder.activePath) {
      this.bumpActivity();
      return;
    }
    if (!this.settings.capture.externalEdits || !this.tracked(file.path)) return;
    const now = Date.now();
    if (now - (this.recentDeact.get(file.path) ?? 0) < RECENT_DEACT_GRACE_MS) return;
    if (now - (this.lastExtmod.get(file.path) ?? 0) < EXTMOD_COALESCE_MS) return;
    this.lastExtmod.set(file.path, now);
    const by = this.consumeWriter(file.path);
    this.enqueue(async () => {
      // First contact via external write: capture the (post-write) baseline.
      // The pre-write state is unknowable — the watcher fires after the fact.
      const fresh = await this.ensureBaseline(file);
      const ev: LogEvent = { t: now, type: "extmod", path: file.path };
      if (by) ev.by = by;
      // Record WHAT changed, not just that something did: diff the file's
      // live links against the log's reconstructed belief. Links only — the
      // one signal reconstructible from the log without stored snapshots.
      if (!fresh && this.settings.capture.links) {
        try {
          const refs = extractRefs(stripCodeFences(await this.app.vault.cachedRead(file)));
          const current = new Set([...refs.links, ...refs.embeds]);
          const known = knownLinks(applyErasures(applyRenames(await this.getEvents())), file.path);
          const added = [...current].filter((l) => !known.has(l));
          const removed = [...known].filter((l) => !current.has(l));
          if (added.length || removed.length) {
            ev.edit = {};
            if (added.length) ev.edit.linksAdded = added;
            if (removed.length) ev.edit.linksRemoved = removed;
          }
        } catch (e) {
          console.error("Muninn: extmod link diff failed", e);
        }
      }
      await this.record(ev);
    });
  }

  /** The announced writer for a path, if the announcement is still fresh; consumes it. */
  private consumeWriter(path: string): string | undefined {
    const p = this.pendingPluginWrite.get(path);
    if (!p) return undefined;
    this.pendingPluginWrite.delete(path);
    return Date.now() - p.t < PLUGIN_WRITE_WINDOW_MS ? p.writer : undefined;
  }

  /** The active leaf changed: close the previous span, open one for the new file (markdown only). */
  private async onActiveChange(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    let file = view?.file && view.file.extension === "md" ? view.file : null;
    if (file) this.lastActiveMdPath = file.path;
    // Canvas files get bare activation spans: presence tracked, never diffed.
    if (!file && this.settings.capture.canvas) {
      const lv = this.app.workspace.getMostRecentLeaf()?.view;
      if (lv?.getViewType() === "canvas") {
        const cf = (lv as unknown as { file?: TFile }).file;
        if (cf instanceof TFile) file = cf;
      }
    }
    if ((file?.path ?? null) === this.recorder.activePath) return;
    await this.closeSpan();
    if (file && this.tracked(file.path)) {
      const snap = file.extension === "md" ? await this.snapshot(file, false) : emptySnapshot();
      await this.ensureBaseline(file, snap);
      const ctime = this.settings.capture.ctime ? file.stat.ctime : undefined;
      const activatedAt = Date.now();
      this.lastActivationAt = activatedAt;
      this.recorder.activate(file.path, snap, activatedAt, ctime, this.consumeOpened(file.path));
      this.maybeOfferHomeContext(file.path, activatedAt);
    }
    this.refreshPane(); // also on file-less changes, so closing the last note updates the pane
  }

  /** How this activation came about: a followed link beats a UI-surface hint; both windows are short. */
  private consumeOpened(path: string): Opened | undefined {
    const link = this.pendingLinkFrom;
    const ui = this.lastUiOpen;
    this.pendingLinkFrom = null;
    this.lastUiOpen = null;
    const now = Date.now();
    if (link && now - link.t < LINK_OPEN_WINDOW_MS && link.from !== path) return { via: "link", from: link.from };
    if (ui && now - ui.t < LINK_OPEN_WINDOW_MS) return { via: ui.via };
    return undefined;
  }

  private async closeSpan(end?: number, left: LeaveReason = "switch"): Promise<void> {
    const path = this.recorder.activePath;
    if (!path) return;
    // "switch" means the user moved on; if the file is no longer open in any
    // leaf, they didn't switch away from it — they closed it.
    if (left === "switch" && !this.isOpenAnywhere(path)) left = "close";
    const file = this.app.vault.getAbstractFileByPath(path);
    const after = file instanceof TFile && file.extension === "md" ? await this.snapshot(file, true) : null;
    const section = file instanceof TFile && this.settings.capture.section ? this.activeSection(file) : undefined;
    const ev = this.recorder.deactivate(after, end ?? Date.now(), left, section);
    this.recentDeact.set(path, Date.now());
    if (ev) await this.record(ev);
  }

  /** The heading section holding the cursor in the file's open editor, if any. */
  private activeSection(file: TFile): string | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) {
        return sectionAtLine(view.editor.getValue(), view.editor.getCursor().line);
      }
    }
    return undefined;
  }

  private isOpenAnywhere(path: string): boolean {
    for (const type of ["markdown", "canvas"]) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        if ((leaf.view as unknown as { file?: TFile }).file?.path === path) return true;
      }
    }
    return false;
  }

  /**
   * The file's current text from a live editor buffer, or null if no loaded
   * editor holds it. ONLY safe at deactivation: during a file switch the
   * view's `file` points at the new file before the buffer content swaps, so
   * an activation-time read can return the PREVIOUS file's text and poison
   * the snapshot (spans then "diff" two different files). At close the file
   * was demonstrably loaded for the whole span, and the buffer is what
   * cachedRead misses: keystrokes not yet autosaved when the user tabs away.
   */
  private liveContent(file: TFile): string | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === file.path) {
        const text = view.editor.getValue();
        // Empty buffer for a non-empty file: the editor hasn't loaded it yet.
        if (text === "" && file.stat.size > 0) return null;
        return text;
      }
    }
    return null;
  }

  /**
   * Disabled capture signals are skipped entirely, not computed and discarded.
   * Everything parses straight from the content in hand; the metadata cache is
   * not consulted, since it lags behind unsaved keystrokes. `atClose` decides
   * the source: live buffer at deactivation, disk at activation (see liveContent).
   */
  private async snapshot(file: TFile, atClose: boolean): Promise<Snapshot> {
    const c = this.settings.capture;
    const content = (atClose ? this.liveContent(file) : null) ?? (await this.app.vault.cachedRead(file));
    const body = stripCodeFences(content);
    const fmRaw = c.frontmatter || c.tags ? frontmatterOf(content) : {};
    const fmt = c.formatting ? extractFormatting(content) : { bold: 0, italic: 0 };
    const tasks = c.tasks ? extractTasks(body) : { open: [], done: [] };
    const fm: Record<string, string> = {};
    if (c.frontmatter) {
      for (const [k, v] of Object.entries(fmRaw)) fm[k] = JSON.stringify(v) ?? "";
    }
    const refs = c.links ? extractRefs(body) : { links: [], embeds: [] };
    const code = c.code ? extractCode(content) : { count: 0, langs: [] };
    return {
      words: c.words ? content.split(/\s+/).filter(Boolean).length : 0,
      links: refs.links,
      embeds: refs.embeds,
      blockIds: c.blockIds ? extractBlockIds(content) : [],
      tags: c.tags ? extractTags(body, fmTagList(fmRaw)) : [],
      headings: c.headings ? extractHeadings(body) : [],
      highlights: c.highlights ? extractHighlights(content) : [],
      footnotes: c.footnotes ? extractFootnotes(content) : [],
      tasksOpen: tasks.open,
      tasksDone: tasks.done,
      urls: c.urls ? extractUrls(content) : [],
      callouts: c.callouts ? extractCallouts(content) : [],
      comments: c.comments ? extractComments(content) : [],
      struck: c.strikethrough ? extractStruck(content) : [],
      codeLangs: code.langs,
      codeBlocks: code.count,
      math: c.math ? countMath(body) : 0,
      tables: c.tables ? countTables(body) : 0,
      bold: fmt.bold,
      italic: fmt.italic,
      fm,
    };
  }

  private async showRelationships(): Promise<void> {
    const events = excludeFolders(applyErasures(applyRenames(healRenames(await this.getEvents()))), this.settings.excludedFolders);
    const sessions = groupSessions(events, this.settings.sessionGapMin * 60_000);
    const pairs = allRelationships(
      sessions,
      Date.now(),
      this.settings.halfLifeDays * 24 * 3600_000,
      unrelatedPairs(events),
      contextFileSets(events),
      peekEvents(events),
      assignContexts(events)
    );
    new RelationshipsModal(this.app, this, pairs).open();
  }

  private async dumpHistory(): Promise<void> {
    const events = applyErasures(applyRenames(healRenames(await this.getEvents())));
    if (!events.length) {
      new HistoryModal(this.app, "No events recorded yet. Work in some notes and come back.").open();
      return;
    }
    const spans = events.filter(isSpan);
    const files = new Set(spans.map((s) => s.path));
    const sessions = groupSessions(events, this.settings.sessionGapMin * 60_000);
    const header = `${events.length} events · ${files.size} files · ${sessions.length} sessions · since ${fmtTime(events[0].t)}\n`;

    let related = "";
    const activePath = this.recorder.activePath;
    if (activePath) {
      const halfLife = this.settings.halfLifeDays * 24 * 3600_000;
      // Relations always compute over the excluded stream (dump shows the full one).
      const relEvents = excludeFolders(events, this.settings.excludedFolders);
      const relSessions = groupSessions(relEvents, this.settings.sessionGapMin * 60_000);
      const top = relatedTo(activePath, relSessions, Date.now(), halfLife, undefined, contextFileSets(relEvents), peekEvents(relEvents), assignContexts(relEvents)).slice(0, 10);
      if (top.length) {
        related =
          `\nRelated to ${activePath}:\n` +
          top
            .map((r) => `  ${r.score.toFixed(2)}  ${r.path}  (${r.sharedSessions} shared, last ${fmtTime(r.lastAt)})`)
            .join("\n") +
          "\n";
      }
    }

    const body = events.slice(-100).reverse().map(fmtEvent).join("\n");
    new HistoryModal(this.app, header + related + "\n" + body).open();
  }
}

const CLEAR_CONTEXT = "— no context —";
const NEW_CONTEXT = "+ new context";
const VEIL = "veil - actions are recorded but do not appear in the trail";

/** Next free "context N" index for the one-click, no-naming path. */
function nextContextIndex(names: string[]): number {
  let max = 0;
  for (const n of names) {
    const m = ANON_CONTEXT_RE.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max + 1;
}

/**
 * Pick an existing context (shown with its face: the files that define it),
 * mint an anonymous "context N" with one click, type a name, or clear.
 * Naming is optional — a context's identity is its cluster, not its label.
 */
class ContextModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private plugin: ContextsPlugin,
    private names: string[],
    private current: string | null,
    private ctxSets: Map<string, ContextSet>,
    private sigils: Map<string, string>
  ) {
    super(app);
    this.setPlaceholder(this.current ? `Context: ${this.current} — switch to…` : "Declare a context…");
  }

  getItems(): string[] {
    // Fixed actions FIRST: with many contexts they'd otherwise sink below
    // the fold. Typing still filters straight to any of them.
    const items: string[] = [];
    const typed = this.inputEl?.value.trim();
    if (typed && !this.names.includes(typed)) items.push(typed);
    if (this.current) items.push(CLEAR_CONTEXT);
    items.push(NEW_CONTEXT, VEIL, ...this.names);
    return items;
  }

  getItemText(item: string): string {
    return item;
  }

  renderSuggestion(match: { item: string }, el: HTMLElement): void {
    renderContextRow(el, match.item, this.ctxSets, this.sigils);
    // A rule under the last fixed action, where the contexts begin.
    if (match.item === VEIL && this.names.length) el.addClass("contexts-picker-divider");
  }

  onChooseItem(item: string): void {
    if (item === VEIL) {
      this.plugin.setVeil(true);
    } else if (item === NEW_CONTEXT) {
      this.plugin.declareContext(`context ${nextContextIndex(this.names)}`);
    } else {
      this.plugin.declareContext(item === CLEAR_CONTEXT ? "" : item);
    }
  }
}

// How much of a context's face shows in a modal row.
const FACE_FILES = 5;

/**
 * A context row: its name, a derived label for anonymous contexts (the
 * evolving stand-in for a real name, recomputed from the cluster every
 * render), and its face — the files that define it, most-engaged first.
 */
function renderContextRow(
  el: HTMLElement,
  name: string,
  ctxSets: Map<string, ContextSet>,
  sigils?: Map<string, string>
): void {
  const set = ctxSets.get(name);
  const title = el.createDiv();
  const sigil = sigils?.get(name);
  if (sigil) title.createSpan({ text: sigil, cls: "contexts-sigil" });
  title.createSpan({ text: name });
  if (set && ANON_CONTEXT_RE.test(name)) {
    const label = derivedLabel(set);
    if (label) title.createSpan({ text: ` · ${label}`, cls: "contexts-derived-label" });
  }
  if (set?.files.size) {
    const ranked = topFiles(set);
    const face = ranked
      .slice(0, FACE_FILES)
      .map((p) => p.split("/").pop()?.replace(/\.md$/, "") ?? p)
      .join(", ");
    el.createDiv({
      text: ranked.length > FACE_FILES ? `${face} +${ranked.length - FACE_FILES}` : face,
      cls: "contexts-row-meta",
    });
  }
}

/** Step one of a rename: pick which context. The face disambiguates anonymous "context N" labels. */
class RenameContextModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private plugin: ContextsPlugin,
    private names: string[],
    private ctxSets: Map<string, ContextSet>,
    private sigils: Map<string, string>
  ) {
    super(app);
    this.setPlaceholder("Rename which context?");
  }

  getItems(): string[] {
    return this.names;
  }

  getItemText(item: string): string {
    return item;
  }

  renderSuggestion(match: { item: string }, el: HTMLElement): void {
    renderContextRow(el, match.item, this.ctxSets, this.sigils);
  }

  onChooseItem(item: string): void {
    void this.plugin.openRenameFor(item);
  }
}

/** Pick one context by name — the merge target picker and any future "which context?" question. */
class PickContextModal extends FuzzySuggestModal<string> {
  constructor(app: App, private names: string[], placeholder: string, private onPick: (name: string) => void) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): string[] {
    return this.names;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.onPick(item);
  }
}

/** Pick which context the current file should be removed from. */
class EvictModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private plugin: ContextsPlugin,
    private path: string,
    private names: string[]
  ) {
    super(app);
    this.setPlaceholder(`Remove "${this.path.split("/").pop()?.replace(/\.md$/, "")}" from which context?`);
  }

  getItems(): string[] {
    return this.names;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.plugin.evictFromContext(item, this.path);
  }
}

/**
 * Step two: type the new name. Enter confirms, Escape cancels. With `sigil`
 * options the modal also carries the Foliate-style sigil picker: a small
 * glyph field beside the name, a grid of candidates (recent emoji first,
 * then the starter set) below, and the OS emoji palette free in the field.
 * Only a TOUCHED sigil records — renaming alone never pins a placeholder.
 */
export class NameModal extends Modal {
  constructor(
    app: App,
    private title: string,
    private initial: string,
    private onSubmit: (value: string) => void,
    private sigil?: { value: string; pinned: string; recent: string[]; onPick: (s: string) => void; onClearName?: () => void }
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.title);
    const row = this.contentEl.createDiv({ cls: "contexts-name-row" });
    let sigilInput: HTMLInputElement | undefined;
    let touched = false;
    if (this.sigil) {
      sigilInput = row.createEl("input", { type: "text", value: this.sigil.value, cls: "contexts-sigil-input" });
      sigilInput.setAttribute("aria-label", "Sigil");
      sigilInput.addEventListener("input", () => (touched = true));
    }
    const input = row.createEl("input", {
      type: "text",
      value: this.initial,
      cls: "contexts-name-input",
    });
    const submit = () => {
      this.close();
      if (this.sigil && sigilInput) {
        const s = sigilInput.value.trim();
        // Adopting the placeholder pins it too; unchanged-from-pinned is a no-op.
        if (touched && s !== this.sigil.pinned) this.sigil.onPick(s); // "" unpins: back to the placeholder
      }
      this.onSubmit(input.value);
    };
    const onEnter = (evt: KeyboardEvent) => {
      if (evt.key === "Enter") submit();
    };
    input.addEventListener("keydown", onEnter);
    sigilInput?.addEventListener("keydown", onEnter);
    if (this.sigil) {
      const grid = this.contentEl.createDiv({ cls: "contexts-sigil-grid" });
      for (const s of [...new Set([...this.sigil.recent, ...STARTER_SIGILS])]) {
        const b = grid.createEl("button", { text: s, cls: "contexts-sigil-choice" });
        if (s === this.sigil.value) b.addClass("is-current");
        b.addEventListener("click", () => {
          sigilInput!.value = s;
          touched = true;
          grid.querySelector(".is-current")?.removeClass("is-current");
          b.addClass("is-current");
          input.focus();
        });
      }
      // Clear: unpin the sigil, back to a starter placeholder.
      const clearSigil = grid.createEl("button", { text: "clear", cls: ["contexts-sigil-choice", "contexts-sigil-clear"] });
      clearSigil.setAttribute("aria-label", "Clear the sigil (back to a placeholder)");
      clearSigil.addEventListener("click", () => {
        sigilInput!.value = "";
        touched = true;
        grid.querySelector(".is-current")?.removeClass("is-current");
        input.focus();
      });
      if (this.sigil.onClearName) {
        // Clear name: back to anonymous, with a live derived label.
        const clearName = this.contentEl.createEl("button", { text: "Clear name (make anonymous)", cls: "contexts-clear-name" });
        clearName.addEventListener("click", () => {
          this.close();
          this.sigil!.onClearName!();
        });
      }
    }
    input.focus();
    input.select();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/**
 * The Web Clipper's signature on a newborn file: source-URL frontmatter
 * (`source`/`url`/`clipped`) plus a body of real length — born full, not
 * born empty. The word floor keeps template-created notes that merely
 * carry a source field from wearing the label.
 */
export function looksClipped(content: string): boolean {
  const fm = frontmatterOf(content);
  const src = [fm["source"], fm["url"], fm["clipped"]].flat();
  if (!src.some((v) => typeof v === "string" && /^https?:\/\//.test(v))) return false;
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return (body.match(/\S+/g)?.length ?? 0) >= 20;
}

function frontmatterOf(content: string): Record<string, unknown> {
  const m = content.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return {};
  try {
    return (parseYaml(m[1]) as Record<string, unknown>) ?? {};
  } catch {
    return {}; // mid-keystroke YAML is often invalid; an empty read beats a throw
  }
}

class HistoryModal extends Modal {
  constructor(app: App, private text: string) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText("Muninn: recent history");
    this.contentEl.createEl("pre", { text: this.text, cls: "contexts-history" });
  }

  onClose() {
    this.contentEl.empty();
  }
}
