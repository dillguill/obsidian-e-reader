// The bar that appears over a selection: one swatch per highlight type, and
// Copy.
//
// It replaces highlight mode and the toolbar's highlight button. Those asked
// the reader to decide what a drag would become BEFORE making it, and on a
// touchscreen to select, then reach for the toolbar; the popup asks after,
// next to the words, which is how the established readers do it.
//
// The popup holds the selection it was opened for. Pressing a button outside
// the text can collapse the live selection on the way in, so the click acts
// on that snapshot rather than reading the document again.

import type { Component } from "obsidian";
import { setIcon, setTooltip } from "obsidian";
import type { AnnotationType } from "../settings/settings-model";
import type { EngineSelection } from "./engine";
import { type Box, placePopup } from "./popup-position";

/** How long after a release a press still counts, so a touch's late click lands first. */
const PRESS_RELEASE_MS = 400;

/**
 * Where the popup goes: floating beside the selection, or docked along the
 * bottom of the reader. A touchscreen docks it, because iOS and Android draw
 * their own selection menu right beside the selection and a page cannot hide
 * it; two menus at the same spot covered each other.
 */
export type PopupPlacement = "above" | "below" | "docked";

export interface SelectionPopupCallbacks {
  highlight(type: string, selection: EngineSelection): void;
  copy(selection: EngineSelection): void;
}

export class SelectionPopup {
  private readonly el: HTMLElement;
  private selection: EngineSelection | null = null;
  /**
   * Set while a press on the popup is in progress. On a touchscreen that
   * press can clear the live selection before its click arrives, and the
   * selection-change handler must not take that as a reason to close.
   */
  private pressed = false;

  constructor(
    private readonly hostEl: HTMLElement,
    component: Component,
    private readonly callbacks: SelectionPopupCallbacks,
  ) {
    this.el = hostEl.createDiv({ cls: "ereader-popup", attr: { role: "toolbar", "aria-label": "Selection" } });
    this.el.hide();

    // Pressing a button must not take focus or the selection away from the
    // text, or the selection the reader can still see vanishes underneath
    // the popup before the click lands.
    component.registerDomEvent(this.el, "mousedown", (event: MouseEvent) => event.preventDefault());
    component.registerDomEvent(this.el, "pointerdown", () => {
      this.pressed = true;
    });
    // A press that never becomes a click (dragged off, cancelled) must not
    // leave the popup pinned open.
    const release = (): void => {
      window.setTimeout(() => {
        this.pressed = false;
      }, PRESS_RELEASE_MS);
    };
    component.registerDomEvent(this.el, "pointerup", release);
    component.registerDomEvent(this.el, "pointercancel", release);
    component.registerDomEvent(this.el, "click", (event: MouseEvent) => {
      this.pressed = false;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
      const selection = this.selection;
      if (!target || !selection) return;
      event.preventDefault();
      if (target.dataset["action"] === "copy") this.callbacks.copy(selection);
      else if (target.dataset["type"] !== undefined) this.callbacks.highlight(target.dataset["type"], selection);
    });
  }

  /** Whether a press on the popup itself is under way. */
  isPressed(): boolean {
    return this.pressed;
  }

  /** The selection the popup is open for, or null when it is closed. */
  current(): EngineSelection | null {
    return this.selection;
  }

  /**
   * Opens over `anchor` for `selection`. `types` is empty when the open file
   * cannot take highlights, which leaves Copy on its own.
   */
  show(selection: EngineSelection, anchor: Box, types: readonly AnnotationType[], placement: PopupPlacement): void {
    this.selection = selection;
    this.el.empty();
    for (const type of types) {
      const swatch = this.el.createEl("button", {
        cls: "ereader-popup__swatch",
        attr: { "data-action": "highlight", "data-type": type.name, "aria-label": `Highlight as ${type.name}` },
      });
      swatch.style.backgroundColor = type.color;
      setTooltip(swatch, type.name);
    }
    if (types.length > 0) this.el.createDiv({ cls: "ereader-popup__divider" });
    const copy = this.el.createEl("button", {
      cls: "clickable-icon ereader-popup__button",
      attr: { "data-action": "copy", "aria-label": "Copy" },
    });
    setIcon(copy, "copy");
    setTooltip(copy, "Copy");

    this.el.show();
    this.place(anchor, placement);
  }

  /** Moves the open popup to follow its selection; closes it once that has scrolled away. */
  reposition(anchor: Box | null, placement: PopupPlacement): void {
    // A docked bar does not follow the selection; it closes when the
    // selection is cleared, which the view handles.
    if (!this.selection || placement === "docked") return;
    if (!anchor) {
      this.hide();
      return;
    }
    this.place(anchor, placement);
  }

  hide(): void {
    this.selection = null;
    this.el.hide();
  }

  private place(anchor: Box, placement: PopupPlacement): void {
    this.el.toggleClass("is-docked", placement === "docked");
    if (placement === "docked") {
      // Laid out by styles.css; clear whatever a floating placement left.
      this.el.setCssStyles({ left: "", top: "" });
      return;
    }
    const bounds = this.hostEl.getBoundingClientRect();
    const at = placePopup(anchor, bounds, { width: this.el.offsetWidth, height: this.el.offsetHeight }, placement);
    if (!at) {
      this.hide();
      return;
    }
    this.el.setCssStyles({ left: `${at.left}px`, top: `${at.top}px` });
  }
}
