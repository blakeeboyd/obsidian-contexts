import { App, MarkdownView, Modal, Plugin, TFile, getAllTags } from "obsidian";
import { EventLog, getDeviceId } from "./log";
import { LogEvent, Recorder, Snapshot, extractFootnotes, extractHighlights, isSpan } from "./recorder";
import { applyRenames, groupSessions, relatedTo } from "./views";

export default class ContextsPlugin extends Plugin {
  private recorder = new Recorder();
  private log!: EventLog;
  // Serializes all recorder/log operations so async snapshots never interleave.
  private queue: Promise<void> = Promise.resolve();

  async onload() {
    this.log = new EventLog(this.app.vault.adapter, `${this.manifest.dir}/log`, getDeviceId());

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(
        this.app.workspace.on("active-leaf-change", () => this.enqueue(() => this.onActiveChange()))
      );
      // App loses/regains focus: close the span so time in other apps is not
      // counted as engagement, reopen it on return.
      this.registerDomEvent(window, "blur", () => this.enqueue(() => this.closeSpan()));
      this.registerDomEvent(window, "focus", () => this.enqueue(() => this.onActiveChange()));
      // Capture the file already open at startup.
      this.enqueue(() => this.onActiveChange());
    });

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && file.extension === "md") {
          this.recorder.handleRename(oldPath, file.path);
          this.enqueue(() => this.log.append({ t: Date.now(), type: "rename", from: oldPath, to: file.path }));
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && file.extension === "md") {
          if (this.recorder.activePath === file.path) this.recorder.abandon();
          this.enqueue(() => this.log.append({ t: Date.now(), type: "delete", path: file.path }));
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

  private enqueue(op: () => Promise<void>): void {
    this.queue = this.queue.then(op).catch((e) => console.error("Contexts:", e));
  }

  /** The active leaf changed: close the previous span, open one for the new file (markdown only). */
  private async onActiveChange(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file && view.file.extension === "md" ? view.file : null;
    if ((file?.path ?? null) === this.recorder.activePath) return;
    await this.closeSpan();
    if (file) {
      const snap = await this.snapshot(file);
      this.recorder.activate(file.path, snap, Date.now());
    }
  }

  private async closeSpan(): Promise<void> {
    const path = this.recorder.activePath;
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    const after = file instanceof TFile ? await this.snapshot(file) : null;
    const ev = this.recorder.deactivate(after, Date.now());
    if (ev) await this.log.append(ev);
  }

  private async snapshot(file: TFile): Promise<Snapshot> {
    const content = await this.app.vault.cachedRead(file);
    const cache = this.app.metadataCache.getFileCache(file);
    const links = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].map((l) => l.link);
    return {
      words: content.split(/\s+/).filter(Boolean).length,
      links,
      tags: cache ? getAllTags(cache) ?? [] : [],
      headings: cache?.headings?.map((h) => h.heading) ?? [],
      highlights: extractHighlights(content),
      footnotes: extractFootnotes(content),
    };
  }

  private async dumpHistory(): Promise<void> {
    const events = applyRenames(await this.log.readAll());
    if (!events.length) {
      new HistoryModal(this.app, "No events recorded yet. Work in some notes and come back.").open();
      return;
    }
    const spans = events.filter(isSpan);
    const files = new Set(spans.map((s) => s.path));
    const sessions = groupSessions(events);
    const header = `${events.length} events · ${files.size} files · ${sessions.length} sessions · since ${fmtTime(events[0].t)}\n`;

    let related = "";
    const activePath = this.recorder.activePath;
    if (activePath) {
      const top = relatedTo(activePath, sessions, Date.now()).slice(0, 10);
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

function fmtTime(t: number): string {
  const d = new Date(t);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function fmtEvent(ev: LogEvent): string {
  if (!isSpan(ev)) {
    return ev.type === "rename"
      ? `${fmtTime(ev.t)}           renamed: ${ev.from} → ${ev.to}`
      : `${fmtTime(ev.t)}           deleted: ${ev.path}`;
  }
  const parts: string[] = [];
  const e = ev.edit;
  if (e) {
    if (e.words) parts.push(`${e.words > 0 ? "+" : ""}${e.words}w`);
    if (e.linksAdded || e.linksRemoved)
      parts.push(`links +${e.linksAdded?.length ?? 0}/-${e.linksRemoved?.length ?? 0}`);
    if (e.tagsAdded || e.tagsRemoved)
      parts.push(`tags +${e.tagsAdded?.length ?? 0}/-${e.tagsRemoved?.length ?? 0}`);
    if (e.headingsChanged) parts.push("headings");
    if (e.highlightsAdded || e.highlightsRemoved)
      parts.push(`hl +${e.highlightsAdded?.length ?? 0}/-${e.highlightsRemoved?.length ?? 0}`);
    if (e.footnotesAdded || e.footnotesRemoved)
      parts.push(`fn +${e.footnotesAdded?.length ?? 0}/-${e.footnotesRemoved?.length ?? 0}`);
  }
  const edit = parts.length ? `  (${parts.join(", ")})` : "";
  return `${fmtTime(ev.start)}  ${fmtDur(ev.dur).padStart(5)}  ${ev.path}${edit}`;
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
