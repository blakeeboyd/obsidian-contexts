// Test-only stand-in for the types-only `obsidian` package (no runtime
// entry), aliased in vitest.config.ts so modules that import it can load
// under vitest. Only names touched at module evaluation need to exist.
export class MarkdownRenderChild {}
export class AbstractInputSuggest {}
export class PluginSettingTab {}
export class MarkdownView {}
export class TFolder {}
export const Platform = { isMobile: false };
export class ItemView {}
export class Modal {}
export class FuzzySuggestModal {}
export class SuggestModal {}
export class Plugin {}
export class App {}
export class TFile {}
export class WorkspaceLeaf {}
export class Menu {}
export class Notice {}
export const Keymap = { isModifier: () => false, isModEvent: () => false };
export function setIcon(): void {}
// Minimal flat key: value parser — enough YAML for frontmatter tests.
export function parseYaml(s: string): unknown {
  const out: Record<string, unknown> = {};
  for (const line of String(s).split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
