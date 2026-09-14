/**
 * One shared styled hover card per view (SVG <title> gives the OS's slow
 * unstyled tooltip; this is the Notion-register replacement). Create one per
 * ItemView, attach() to elements, hide() on re-render, destroy() on close.
 */
export class HoverTip {
  private el: HTMLElement | null = null;

  attach(target: Element, text: string): void {
    target.addEventListener("pointerenter", (evt) => {
      const t = this.el ?? (this.el = document.body.createDiv({ cls: "contexts-braid-tip" }));
      t.setText(text);
      t.style.display = "block";
      this.move(evt as PointerEvent);
    });
    target.addEventListener("pointermove", (evt) => this.move(evt as PointerEvent));
    target.addEventListener("pointerleave", () => this.hide());
  }

  hide(): void {
    if (this.el) this.el.style.display = "none";
  }

  destroy(): void {
    this.el?.remove();
    this.el = null;
  }

  private move(evt: PointerEvent): void {
    if (!this.el) return;
    const pad = 12;
    const w = this.el.offsetWidth;
    let x = evt.clientX + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    this.el.style.left = `${x}px`;
    this.el.style.top = `${Math.min(evt.clientY + pad, window.innerHeight - this.el.offsetHeight - 8)}px`;
  }
}
