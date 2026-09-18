/**
 * The Norn icon: a braid, three strands in one — the three sisters, the
 * three tenses of the record (what has come to pass, what is becoming,
 * what shall be), and the braid the plugin draws.
 *
 * Braid by Amrita Mayuri, from the Noun Project (CC BY 3.0):
 * https://thenounproject.com/icon/braid-679417/
 *
 * addIcon takes the inner markup only (no enclosing <svg>) on a 100x100
 * viewBox, which this already is; fill="currentColor" lets the glyph follow
 * the theme, accent and all, like the built-in Lucide icons.
 */
import { addIcon } from "obsidian";

export const NORN_ICON = "norn-braid";

const BRAID = `<path fill="currentColor" d="m56.395 60.801-36.699 36.699c-2.5352-2.7812-3.9023-6.4297-3.8203-10.191 0.085938-3.7617 1.6133-7.3438 4.2695-10.008l26.402-26.379z"/><path fill="currentColor" d="m68.094 49.078-36.699-36.699 9.8711-9.8789 26.379 26.379c2.6562 2.6641 4.1836 6.25 4.2695 10.012 0.082032 3.7617-1.2852 7.4102-3.8203 10.188z"/><path fill="currentColor" d="m83.234 66.051-9.8789 9.8789-26.379-26.379c-2.6562-2.668-4.1797-6.2539-4.2578-10.016-0.082031-3.7617 1.2891-7.4062 3.8281-10.184z"/>`;

/** Register the icon under NORN_ICON. Call before anything references the name. */
export function registerNornIcon(): void {
  addIcon(NORN_ICON, BRAID);
}
