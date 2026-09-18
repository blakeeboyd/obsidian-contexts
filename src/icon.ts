/**
 * The Episodic icon: three stepped panels, episodes in a row. The line
 * version, which matches Obsidian's Lucide icons and still reads at
 * ribbon size (the geometry is simple enough).
 *
 * Episode by IconMark, from the Noun Project (CC BY 3.0):
 * https://thenounproject.com/icon/episode-3536466/
 *
 * addIcon takes the inner markup only (no enclosing <svg>) on a 100x100
 * viewBox; fill="currentColor" lets the glyph follow the theme's text and
 * accent colors like the built-in Lucide icons.
 */
import { addIcon } from "obsidian";

export const EPISODIC_ICON = "episodic-episodes";

const EPISODES = `<path fill="currentColor" d="m91 5h-42c-1.1016 0-2 0.89844-2 2v4h-18c-1.1016 0-2 0.89844-2 2v4h-18c-1.1016 0-2 0.89844-2 2v62c0 1.1016 0.89844 2 2 2h18v4c0 1.1016 0.89844 2 2 2h18v4c0 1.1016 0.89844 2 2 2h42c1.1016 0 2-0.89844 2-2v-86c0-1.1016-0.89844-2-2-2zm-64 74h-16v-58h16zm20 6h-16v-70h16zm42 6h-38v-82h38z"/>`;

/** Register the icon under EPISODIC_ICON. Call before anything references the name. */
export function registerEpisodicIcon(): void {
  addIcon(EPISODIC_ICON, EPISODES);
}
