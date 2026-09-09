import { AbstractInputSuggest, App, PluginSettingTab, Setting, TFolder } from "obsidian";
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
      .setName("Excluded folders")
      .setDesc("Files in these folders are still recorded and keep their own trail, but stay out of contexts and relatedness.")
      .addButton((b) =>
        b.setButtonText("Add folder").onClick(async () => {
          this.plugin.settings.excludedFolders.push("");
          await this.plugin.saveSettings();
          this.display();
        })
      );

    this.plugin.settings.excludedFolders.forEach((folder, i) => {
      const save = async (v: string) => {
        this.plugin.settings.excludedFolders[i] = v.trim().replace(/\/+$/, "");
        await this.plugin.saveSettings();
      };
      new Setting(containerEl)
        .addSearch((search) => {
          search.setPlaceholder("Folder path").setValue(folder).onChange(save);
          new FolderSuggest(this.app, search.inputEl, (path) => void save(path));
        })
        .addExtraButton((b) =>
          b.setIcon("trash").setTooltip("Remove").onClick(async () => {
            this.plugin.settings.excludedFolders.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          })
        );
    });

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
