// Test-only stand-in for the types-only `obsidian` package (no runtime
// entry), aliased in vitest.config.ts so modules that import it can load
// under vitest. Only names touched at module evaluation need to exist.
export class MarkdownRenderChild {}
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
export function parseYaml(): unknown {
  return {};
}
