import { App, MarkdownView, Modal, Plugin, TFile, getAllTags } from "obsidian";
import { fmtEvent, fmtTime } from "./format";
import { EventLog, getDeviceId } from "./log";
import { CONTEXTS_VIEW_TYPE, ContextsPane } from "./pane";
import {
  LogEvent,
  Recorder,
  Snapshot,
  extractFootnotes,
  extractFormatting,
  extractHighlights,
  isSpan,
} from "./recorder";
import { ContextsSettingTab, ContextsSettings, DEFAULT_SETTINGS } from "./settings";
import { applyRenames, groupSessions, relatedTo } from "./views";

// A modify event on a path this soon after its span closed is the editor's
// trailing autosave, not an external edit.
const RECENT_DEACT_GRACE_MS = 3000;
// One extmod per path per window; AI and sync writes arrive in bursts.
const EXTMOD_COALESCE_MS = 15_000;
const IDLE_CHECK_MS = 60_000;

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

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.capture = Object.assign({}, DEFAULT_SETTINGS.capture, this.settings.capture);
    this.addSettingTab(new ContextsSettingTab(this.app, this));

    this.log = new EventLog(this.app.vault.adapter, `${this.manifest.dir}/log`, getDeviceId());

    this.registerView(CONTEXTS_VIEW_TYPE, (leaf) => new ContextsPane(leaf, this));
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
      this.registerDomEvent(window, "blur", () => this.enqueue(() => this.closeSpan()));
      this.registerDomEvent(window, "focus", () => this.enqueue(() => this.onActiveChange()));

      // Activity signals for idle detection: cheap assignments, nothing more.
      for (const evName of ["keydown", "mousedown", "mousemove", "wheel"] as const) {
        this.registerDomEvent(window, evName, () => this.bumpActivity());
      }
      this.registerInterval(window.setInterval(() => this.checkIdle(), IDLE_CHECK_MS));

      // Registered after layout-ready so the vault-load flood of create events is not logged.
      this.registerEvent(
        this.app.vault.on("create", (file) => {
          if (file instanceof TFile && file.extension === "md" && this.settings.capture.externalEdits) {
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
          this.enqueue(() => this.record({ t: Date.now(), type: "rename", from: oldPath, to: file.path }));
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          if (this.recorder.activePath === file.path) this.recorder.abandon();
          this.enqueue(() => this.record({ t: Date.now(), type: "delete", path: file.path }));
        }
      })
    );

    this.addCommand({
      id: "dump-recent-history",
      name: "Dump recent history",
      callback: () => void this.dumpHistory(),
    });
  }

  onunload() {
    // Fire-and-forget: usually completes before the process is gone, and the
    // reader survives a truncated final line if it doesn't.
    this.enqueue(() => this.closeSpan());
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

  private refreshPane(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CONTEXTS_VIEW_TYPE)) {
      void (leaf.view as ContextsPane).render();
    }
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
    this.enqueue(() => this.closeSpan(end));
  }

  private onModify(file: unknown): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    if (file.path === this.recorder.activePath) {
      this.bumpActivity();
      return;
    }
    if (!this.settings.capture.externalEdits) return;
    const now = Date.now();
    if (now - (this.recentDeact.get(file.path) ?? 0) < RECENT_DEACT_GRACE_MS) return;
    if (now - (this.lastExtmod.get(file.path) ?? 0) < EXTMOD_COALESCE_MS) return;
    this.lastExtmod.set(file.path, now);
    this.enqueue(() => this.record({ t: now, type: "extmod", path: file.path }));
  }

  /** The active leaf changed: close the previous span, open one for the new file (markdown only). */
  private async onActiveChange(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file && view.file.extension === "md" ? view.file : null;
    if (file) this.lastActiveMdPath = file.path;
    if ((file?.path ?? null) === this.recorder.activePath) return;
    await this.closeSpan();
    if (file) {
      const snap = await this.snapshot(file);
      const ctime = this.settings.capture.ctime ? file.stat.ctime : undefined;
      this.recorder.activate(file.path, snap, Date.now(), ctime);
      this.refreshPane();
    }
  }

  private async closeSpan(end?: number): Promise<void> {
    const path = this.recorder.activePath;
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    const after = file instanceof TFile ? await this.snapshot(file) : null;
    const ev = this.recorder.deactivate(after, end ?? Date.now());
    this.recentDeact.set(path, Date.now());
    if (ev) await this.record(ev);
  }

  /** Disabled capture signals are skipped entirely, not computed and discarded. */
  private async snapshot(file: TFile): Promise<Snapshot> {
    const c = this.settings.capture;
    const content = await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const fmt = c.formatting ? extractFormatting(content) : { bold: 0, italic: 0 };
    const fm: Record<string, string> = {};
    if (c.frontmatter && cache?.frontmatter) {
      for (const [k, v] of Object.entries(cache.frontmatter)) {
        if (k !== "position") fm[k] = JSON.stringify(v) ?? "";
      }
    }
    return {
      words: c.words ? content.split(/\s+/).filter(Boolean).length : 0,
      links: c.links ? [...(cache?.links ?? []), ...(cache?.embeds ?? [])].map((l) => l.link) : [],
      tags: c.tags && cache ? getAllTags(cache) ?? [] : [],
      headings: c.headings ? cache?.headings?.map((h) => h.heading) ?? [] : [],
      highlights: c.highlights ? extractHighlights(content) : [],
      footnotes: c.footnotes ? extractFootnotes(content) : [],
      bold: fmt.bold,
      italic: fmt.italic,
      fm,
    };
  }

  private async dumpHistory(): Promise<void> {
    const events = applyRenames(await this.getEvents());
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
