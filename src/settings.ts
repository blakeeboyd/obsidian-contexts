import { App, PluginSettingTab, Setting } from "obsidian";
import type ContextsPlugin from "./main";

export interface CaptureSettings {
  words: boolean;
  links: boolean;
  tags: boolean;
  headings: boolean;
  highlights: boolean;
  footnotes: boolean;
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
}

export const DEFAULT_SETTINGS: ContextsSettings = {
  capture: {
    words: true,
    links: true,
    tags: true,
    headings: true,
    highlights: true,
    footnotes: true,
    formatting: true,
    frontmatter: true,
    ctime: true,
    externalEdits: true,
  },
  idleTimeoutMin: 15,
  sessionGapMin: 30,
  halfLifeDays: 30,
};

const CAPTURE_LABELS: Record<keyof CaptureSettings, [string, string]> = {
  words: ["Word count", "Net words added or removed while a note is active."],
  links: ["Links", "Wikilinks and embeds added or removed."],
  tags: ["Tags", "Tags added or removed, including frontmatter tags."],
  headings: ["Headings", "Whether a note's outline changed."],
  highlights: ["Highlights", "==Highlighted== text added or removed, with the text itself."],
  footnotes: ["Footnotes", "Footnotes added or removed, with their text."],
  formatting: ["Bold and italics", "Net change in bold and italic emphasis counts."],
  frontmatter: ["Frontmatter fields", "Which frontmatter keys changed (not their values)."],
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
