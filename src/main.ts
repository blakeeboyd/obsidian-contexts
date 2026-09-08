import { App, FuzzySuggestModal, MarkdownView, Modal, Notice, Plugin, SuggestModal, TFile, parseYaml } from "obsidian";
import { fmtEvent, fmtTime } from "./format";
import { EventLog, getDeviceId } from "./log";
import { DayBlock } from "./dayblock";
import { dailyMarkdown, upsertDaySection } from "./daily";
import { CONTEXTS_VIEW_TYPE, ContextsPane, RelationshipsModal } from "./pane";
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
  allRelationships,
  applyRenames,
  contextNames,
  currentContext,
  excludeFolders,
  groupSessions,
  healRenames,
  relatedTo,
  unrelatedPairs,
} from "./views";

// A modify event on a path this soon after its span closed is the editor's
// trailing autosave, not an external edit.
const RECENT_DEACT_GRACE_MS = 3000;
// One extmod per path per window; AI and sync writes arrive in bursts.
const EXTMOD_COALESCE_MS = 15_000;
const IDLE_CHECK_MS = 60_000;
// A link click older than this can't explain the current activation.
const LINK_OPEN_WINDOW_MS = 3000;

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

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.capture = Object.assign({}, DEFAULT_SETTINGS.capture, this.settings.capture);
    this.addSettingTab(new ContextsSettingTab(this.app, this));

    this.log = new EventLog(this.app.vault.adapter, `${this.manifest.dir}/log`, getDeviceId());

    this.registerView(CONTEXTS_VIEW_TYPE, (leaf) => new ContextsPane(leaf, this));
    this.registerHoverLinkSource(CONTEXTS_VIEW_TYPE, { display: "Contexts", defaultMod: true });
    this.registerMarkdownCodeBlockProcessor("contexts-day", (source, el, ctx) => {
      ctx.addChild(new DayBlock(this, el, source, ctx.sourcePath));
    });
    this.patchOpenLinkText();
    this.patchSuggestModal();

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
    this.addRibbonIcon("footprints", "Open Contexts pane", () => void this.activatePane());
    this.addCommand({
      id: "open-pane",
      name: "Open pane",
      callback: () => void this.activatePane(),
    });

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => {
          this.bumpActivity();
          this.enqueue(() => this.onActiveChange());
        })
      );
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
            this.enqueue(() => this.record({ t: Date.now(), type: "create", path: file.path }));
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
      id: "toggle-pause",
      name: "Pause/resume recording",
      callback: () => {
        this.setPaused(!this.settings.paused);
        new Notice(`Contexts: recording ${this.settings.paused ? "paused" : "resumed"}`);
      },
    });
  }

  /** Declare (or clear, with "") the current context — a logged event like everything else. */
  declareContext(name: string): void {
    this.enqueue(() => this.record({ t: Date.now(), type: "context", name }));
    new Notice(name ? `Context: ${name}` : "Context cleared");
  }

  async openContextModal(): Promise<void> {
    const events = await this.getEvents();
    new ContextModal(this.app, this, contextNames(events), currentContext(events)).open();
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

  /** Any event already mentions this path (under this name). ponytail: linear scan; index if the log grows large. */
  private async isKnown(path: string): Promise<boolean> {
    const events = await this.getEvents();
    return events.some(
      (ev) =>
        ("path" in ev && ev.path === path) ||
        ("type" in ev && ev.type === "rename" && (ev.to === path || ev.from === path))
    );
  }

  /** False when recording is paused or the path sits in an excluded folder. */
  private tracked(path: string): boolean {
    if (this.settings.paused) return false;
    return !this.settings.excludedFolders.some((f) => path === f || path.startsWith(f + "/"));
  }

  onunload() {
    // Fire-and-forget: usually completes before the process is gone, and the
    // reader survives a truncated final line if it doesn't.
    this.enqueue(() => this.closeSpan(undefined, "quit"));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.refreshPane();
  }

  /** The full event history (all devices' shards), loaded once and kept current in memory. */
  async getEvents(): Promise<LogEvent[]> {
    if (!this.events) this.events = await this.log.readAll();
    return this.events;
  }

  private async record(ev: LogEvent): Promise<void> {
    this.events?.push(ev);
    await this.log.append(ev);
    this.refreshPane();
  }

  private dayBlocks = new Set<DayBlock>();

  registerDayBlock(block: DayBlock): void {
    this.dayBlocks.add(block);
  }

  unregisterDayBlock(block: DayBlock): void {
    this.dayBlocks.delete(block);
  }

  private refreshPane(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CONTEXTS_VIEW_TYPE)) {
      void (leaf.view as ContextsPane).render();
    }
    for (const block of this.dayBlocks) void block.render();
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
      new Notice("Contexts: open the note to insert into first.");
      return;
    }
    const iso = file.basename.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const d = iso ? new Date(`${iso}T00:00:00`) : new Date();
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const events = excludeFolders(applyRenames(healRenames(await this.getEvents())), this.settings.excludedFolders);
    const body = dailyMarkdown(events, dayStart, dayStart + 24 * 3600_000, this.settings.sessionGapMin * 60_000);
    await this.app.vault.process(file, (content) => upsertDaySection(content, body));
    new Notice("Contexts: day summary inserted.");
  }

  private async activatePane(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CONTEXTS_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    if (!existing) await leaf.setViewState({ type: CONTEXTS_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private enqueue(op: () => Promise<void>): void {
    this.queue = this.queue.then(op).catch((e) => console.error("Contexts:", e));
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
    this.enqueue(() => this.record({ t: now, type: "extmod", path: file.path }));
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
      // A file with no history predates the record: log its baseline once.
      // Files created while recording already have a create event, so they skip this.
      if (!(await this.isKnown(file.path))) {
        await this.record({
          t: Date.now(),
          type: "firstseen",
          path: file.path,
          ctime: file.stat.ctime,
          counts: firstSeenCounts(snap),
          links: [...new Set([...snap.links, ...snap.embeds])],
          tags: snap.tags,
        });
      }
      const ctime = this.settings.capture.ctime ? file.stat.ctime : undefined;
      this.recorder.activate(file.path, snap, Date.now(), ctime, this.consumeOpened(file.path));
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
    const events = excludeFolders(applyRenames(healRenames(await this.getEvents())), this.settings.excludedFolders);
    const sessions = groupSessions(events, this.settings.sessionGapMin * 60_000);
    const pairs = allRelationships(
      sessions,
      Date.now(),
      this.settings.halfLifeDays * 24 * 3600_000,
      unrelatedPairs(events)
    );
    new RelationshipsModal(this.app, this, pairs).open();
  }

  private async dumpHistory(): Promise<void> {
    const events = excludeFolders(applyRenames(healRenames(await this.getEvents())), this.settings.excludedFolders);
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
      const top = relatedTo(activePath, sessions, Date.now(), halfLife).slice(0, 10);
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

/** Pick an existing context, type a new name, or clear. The cheap gesture the declared-context model depends on. */
class ContextModal extends FuzzySuggestModal<string> {
  constructor(
    app: App,
    private plugin: ContextsPlugin,
    private names: string[],
    private current: string | null
  ) {
    super(app);
    this.setPlaceholder(this.current ? `Context: ${this.current} — switch to…` : "Declare a context…");
  }

  getItems(): string[] {
    const items = this.names.slice();
    const typed = this.inputEl?.value.trim();
    if (typed && !items.includes(typed)) items.unshift(typed);
    if (this.current) items.push(CLEAR_CONTEXT);
    return items;
  }

  getItemText(item: string): string {
    return item;
  }

  onChooseItem(item: string): void {
    this.plugin.declareContext(item === CLEAR_CONTEXT ? "" : item);
  }
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
    this.titleEl.setText("Contexts: recent history");
    this.contentEl.createEl("pre", { text: this.text, cls: "contexts-history" });
  }

  onClose() {
    this.contentEl.empty();
  }
}
