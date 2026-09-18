import { AbstractInputSuggest, App, Modal, PluginSettingTab, Setting, TFile, TFolder } from "obsidian";
import type ContextsPlugin from "./main";

/** Folder-path autocomplete for a text input (the Foliate taxa-folder pattern). */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  constructor(app: App, private input: HTMLInputElement, private onPick: (path: string) => void) {
    super(app, input);
  }

  getSuggestions(query: string): TFolder[] {
    const q = query.toLowerCase();
    const folders = this.app.vault
      .getAllLoadedFiles()
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/" && f.path.toLowerCase().includes(q));
    return folders.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 50);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    el.setText(folder.path);
  }

  selectSuggestion(folder: TFolder): void {
    this.input.value = folder.path;
    this.onPick(folder.path);
    this.close();
  }
}

/** Folder-or-file autocomplete: folders first, then markdown files. */
class PathSuggest extends AbstractInputSuggest<string> {
  constructor(app: App, private input: HTMLInputElement, private onPick: (path: string) => void) {
    super(app, input);
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    const all = this.app.vault.getAllLoadedFiles();
    const folders = all
      .filter((f): f is TFolder => f instanceof TFolder && f.path !== "/" && f.path.toLowerCase().includes(q))
      .map((f) => f.path)
      .sort();
    const files = all
      .filter((f): f is TFile => f instanceof TFile && f.extension === "md" && f.path.toLowerCase().includes(q))
      .map((f) => f.path)
      .sort();
    return [...folders, ...files].slice(0, 50);
  }

  renderSuggestion(path: string, el: HTMLElement): void {
    el.setText(path);
  }

  selectSuggestion(path: string): void {
    this.input.value = path;
    this.onPick(path);
    this.close();
  }
}

/**
 * Manage one scope list (folders and single files alike — the matchers
 * treat an exact path as itself) in a modal, so the settings page stays a
 * two-line summary instead of an open-ended list.
 */
class ScopeModal extends Modal {
  constructor(
    app: App,
    private plugin: ContextsPlugin,
    private title: string,
    private paths: string[],
    private onChange: () => void
  ) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.title);
    // Legacy "Add folder" rows left empty strings behind; drop them once.
    for (let i = this.paths.length - 1; i >= 0; i--) if (!this.paths[i]) this.paths.splice(i, 1);
    this.renderList();
  }

  private renderList(): void {
    const el = this.contentEl;
    el.empty();
    const addRow = el.createDiv({ cls: "contexts-scope-add" });
    const input = addRow.createEl("input", { type: "text", cls: "contexts-name-input" });
    input.placeholder = "Add a folder or note…";
    const commit = async (v: string) => {
      v = v.trim().replace(/\/+$/, "");
      if (!v || this.paths.includes(v)) return;
      this.paths.push(v);
      await this.plugin.saveSettings();
      this.onChange();
      this.renderList();
    };
    new PathSuggest(this.app, input, (p) => void commit(p));
    input.addEventListener("keydown", (evt) => {
      if (evt.key === "Enter") void commit(input.value);
    });
    input.focus();
    for (let i = 0; i < this.paths.length; i++) {
      new Setting(el).setName(this.paths[i]).addExtraButton((b) =>
        b.setIcon("trash").setTooltip("Remove").onClick(async () => {
          this.paths.splice(i, 1);
          await this.plugin.saveSettings();
          this.onChange();
          this.renderList();
        })
      );
    }
    if (!this.paths.length) el.createDiv({ text: "Nothing here yet.", cls: "contexts-empty" });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export interface CaptureSettings {
  words: boolean;
  links: boolean;
  tags: boolean;
  headings: boolean;
  highlights: boolean;
  footnotes: boolean;
  tasks: boolean;
  urls: boolean;
  blockIds: boolean;
  section: boolean;
  callouts: boolean;
  comments: boolean;
  strikethrough: boolean;
  code: boolean;
  math: boolean;
  tables: boolean;
  canvas: boolean;
  hovers: boolean;
  formatting: boolean;
  frontmatter: boolean;
  ctime: boolean;
  externalEdits: boolean;
}

export interface ContextsSettings {
  capture: CaptureSettings;
  idleTimeoutMin: number; // 0 disables idle detection
  sessionGapMin: number;
  halfLifeDays: number;
  trailDetailNewestFirst: boolean;
  paused: boolean;
  excludedFolders: string[]; // normalized: trimmed, no trailing slash
  // Bridge files (daily notes, inboxes): they inherit every context they're
  // visited under, but opening one never pulls the declaration — they
  // bridge contexts instead of belonging to one.
  bridgeFolders: string[];
  // Display names for device ids ("Mac", "iPhone"); the log stays one
  // logical stream, this is how a stint's hands get a human name.
  deviceNames: Record<string, string>;
  // In-vault folder holding the log shards, so vault sync carries them
  // between devices (Obsidian Sync does not sync extra plugin-folder files).
  logFolder: string;
  // The context chip in each note's header row (beside the reading-mode
  // toggle): the declared context, one tap to switch. The phone has no room
  // for the sidebar pane, so "mobile" is the default.
  contextBar: "off" | "mobile" | "always";
  // User-dragged heights for embedded map blocks, keyed by note path plus
  // block body — remembered across sessions without ever editing the note.
  blockHeights: Record<string, number>;
}

export const DEFAULT_SETTINGS: ContextsSettings = {
  capture: {
    words: true,
    links: true,
    tags: true,
    headings: true,
    highlights: true,
    footnotes: true,
    tasks: true,
    urls: true,
    blockIds: true,
    section: true,
    callouts: true,
    comments: true,
    strikethrough: true,
    code: true,
    math: true,
    tables: true,
    canvas: true,
    hovers: true,
    formatting: true,
    frontmatter: true,
    ctime: true,
    externalEdits: true,
  },
  idleTimeoutMin: 15,
  sessionGapMin: 30,
  halfLifeDays: 30,
  trailDetailNewestFirst: true,
  paused: false,
  excludedFolders: [],
  bridgeFolders: [],
  deviceNames: {},
  logFolder: "Contexts Log",
  contextBar: "mobile",
  blockHeights: {},
};

const CAPTURE_LABELS: Record<keyof CaptureSettings, [string, string]> = {
  words: ["Word count", "Net words added or removed while a note is active."],
  links: ["Links", "Wikilinks and embeds added or removed."],
  tags: ["Tags", "Tags added or removed, including frontmatter tags."],
  headings: ["Headings", "Headings added or removed, with their text."],
  highlights: ["Highlights", "==Highlighted== text added or removed, with the text itself."],
  footnotes: ["Footnotes", "Footnotes added or removed, with their text."],
  tasks: ["Tasks", "Checkbox tasks added, completed, reopened, or removed, with their text."],
  urls: ["External links", "Web URLs added or removed — when a resource entered which note."],
  blockIds: ["Block IDs", "^block-ids added or removed — the moment a passage becomes citable."],
  section: ["Section attention", "Which heading section the cursor was in when a visit ended."],
  callouts: ["Callouts", "Callouts added or removed, by type and title."],
  comments: ["Comments", "%%comments%% added or removed, text clipped. These are private annotations; the log syncs with your vault."],
  strikethrough: ["Strikethrough", "~~Struck~~ text added or removed — striking is a judgment act."],
  code: ["Code blocks", "Fenced block count and which languages appear."],
  math: ["Math", "Net change in LaTeX math regions."],
  tables: ["Tables", "Net change in table count."],
  canvas: ["Canvas files", "Activation spans for .canvas files (no content deltas)."],
  hovers: ["Link previews", "Peeks: a link read through its hover popover without being opened."],
  formatting: ["Bold and italics", "Net change in bold and italic emphasis counts."],
  frontmatter: ["Frontmatter fields", "Which frontmatter keys changed, with their before and after values."],
  ctime: ["Creation time", "Stamp each span with the file's creation time, the anchor for healing renames made outside Obsidian."],
  externalEdits: ["Creations and external edits", "Log file creations, and edits made while a file is not active in the editor (AI, sync, scripts)."],
};

export class ContextsSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ContextsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Recording").setHeading();

    new Setting(containerEl)
      .setName("Pause recording")
      .setDesc("Stop logging entirely until turned back on. Paused time simply won't exist in the record.")
      .addToggle((t) => t.setValue(this.plugin.settings.paused).onChange((v) => this.plugin.setPaused(v)));

    new Setting(containerEl)
      .setName("Log folder")
      .setDesc(
        "In-vault folder holding the event log shards, so vault sync carries them between devices. With Obsidian Sync, enable \"Sync all other types\" on every device or the .jsonl shards stay local. Changing this moves the files."
      )
      .addSearch((search) => {
        search.setPlaceholder("Folder path").setValue(this.plugin.settings.logFolder);
        new FolderSuggest(this.app, search.inputEl, (path) => void this.plugin.setLogFolder(path));
        search.inputEl.addEventListener("blur", () => void this.plugin.setLogFolder(search.inputEl.value));
      });

    // Both lists take folders AND single files (the matcher treats an exact
    // path as itself); managed in a modal so the settings page stays short.
    const scopeRow = (name: string, desc: string, paths: string[]) => {
      const count = () =>
        paths.filter(Boolean).length === 0
          ? "Nothing yet"
          : `${paths.filter(Boolean).length} folder${paths.filter(Boolean).length === 1 ? "" : "s"} and files`;
      const row = new Setting(containerEl).setName(name).setDesc(desc);
      const counter = row.descEl.createDiv({ text: count(), cls: "contexts-scope-count" });
      row.addButton((b) =>
        b.setButtonText("Manage…").onClick(() => {
          new ScopeModal(this.app, this.plugin, name, paths, () => counter.setText(count())).open();
        })
      );
    };

    scopeRow(
      "Excluded from contexts",
      "Folders and files that are still recorded and keep their own trail, but stay out of contexts and relatedness — the privacy line.",
      this.plugin.settings.excludedFolders
    );

    scopeRow(
      "Bridge files",
      "Folders and files (daily notes, inboxes) that inherit every context they're visited under, but never switch your context when opened. Frontmatter `context-role: bridge` marks a single file the same way.",
      this.plugin.settings.bridgeFolders
    );

    new Setting(containerEl)
      .setName("Device names")
      .setDesc(
        "Each device writes its own log shard; the views merge them into one history. Name the ids so a stint reads \"iPhone\" instead of a random id."
      )
      .setHeading();
    const deviceEl = containerEl.createDiv();
    void (async () => {
      for (const id of await this.plugin.listDevices()) {
        new Setting(deviceEl)
          .setName(id === this.plugin.localDeviceId() ? `${id} (this device)` : id)
          .addText((t) =>
            t
              .setPlaceholder("Name")
              .setValue(this.plugin.settings.deviceNames[id] ?? "")
              .onChange(async (v) => {
                if (v.trim()) this.plugin.settings.deviceNames[id] = v.trim();
                else delete this.plugin.settings.deviceNames[id];
                await this.plugin.saveSettings();
              })
          );
      }
    })();

    new Setting(containerEl).setName("Capture").setHeading()
      .setDesc("Everything is on by default. Turning a signal off skips its work entirely; it stops being recorded from that moment on.");

    for (const key of Object.keys(CAPTURE_LABELS) as (keyof CaptureSettings)[]) {
      const [name, desc] = CAPTURE_LABELS[key];
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(this.plugin.settings.capture[key]).onChange(async (v) => {
            this.plugin.settings.capture[key] = v;
            await this.plugin.saveSettings();
          })
        );
    }

    new Setting(containerEl).setName("Display").setHeading();

    new Setting(containerEl)
      .setName("Context chip in the note header")
      .setDesc("The declared context in each note's header row, beside the reading-mode toggle; tap it to switch. Made for the phone, where the sidebar pane is out of reach.")
      .addDropdown((d) =>
        d
          .addOption("off", "Off")
          .addOption("mobile", "Mobile only")
          .addOption("always", "All devices")
          .setValue(this.plugin.settings.contextBar)
          .onChange(async (v) => {
            this.plugin.settings.contextBar = v as ContextsSettings["contextBar"];
            await this.plugin.saveSettings();
            this.plugin.updateContextBars();
          })
      );

    new Setting(containerEl)
      .setName("Newest visits first")
      .setDesc("Inside an expanded session, list visits from newest to oldest. Off lists them chronologically.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.trailDetailNewestFirst).onChange(async (v) => {
          this.plugin.settings.trailDetailNewestFirst = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Time").setHeading();

    new Setting(containerEl)
      .setName("Idle timeout (minutes)")
      .setDesc("With no typing, clicking, or scrolling for this long, the open span is closed back-dated to the last activity. 0 disables.")
      .addSlider((s) =>
        s.setLimits(0, 60, 5).setValue(this.plugin.settings.idleTimeoutMin).setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.idleTimeoutMin = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Session gap (minutes)")
      .setDesc("A pause longer than this starts a new session. Sessions are derived at read time, so changing it regroups all history.")
      .addSlider((s) =>
        s.setLimits(5, 120, 5).setValue(this.plugin.settings.sessionGapMin).setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.sessionGapMin = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Related-files half-life (days)")
      .setDesc("How fast old companionship fades in the related-files ranking. It decays, but never reaches zero.")
      .addSlider((s) =>
        s.setLimits(7, 180, 1).setValue(this.plugin.settings.halfLifeDays).setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.halfLifeDays = v;
            await this.plugin.saveSettings();
          })
      );
  }
}
