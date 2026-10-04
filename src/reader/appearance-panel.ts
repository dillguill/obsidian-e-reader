// The reading-settings panel: theme, font, size, spacing, margins and the
// rest, opened from the toolbar's "Aa" button.
//
// A dropdown menu holds a list of checked items well, but not a dozen
// settings in five groups, and not on a phone. Dedicated reading apps settled
// on a small panel of segmented choices for exactly this, so that is what
// this is. It holds no state: the view hands it rows describing the current
// settings, and rebuilds them after every change.

import type { Component } from "obsidian";
import { setIcon } from "obsidian";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** Extra class on the option, for the theme swatches and font previews. */
  cls?: string;
}

export type PanelRow =
  | {
      kind: "choice";
      label: string;
      options: readonly ChoiceOption<string>[];
      value: string;
      onChange(value: string): void | Promise<void>;
    }
  | { kind: "toggle"; label: string; value: boolean; onChange(value: boolean): void | Promise<void> }
  | {
      kind: "stepper";
      label: string;
      valueLabel: string;
      canDecrease: boolean;
      canIncrease: boolean;
      onStep(direction: 1 | -1): void | Promise<void>;
    }
  | { kind: "action"; label: string; icon: string; checked: boolean; onClick(): void | Promise<void> };

export class AppearancePanel {
  private readonly el: HTMLElement;
  private rows: (() => PanelRow[]) | null = null;
  private anchorEl: HTMLElement | null = null;

  constructor(hostEl: HTMLElement, component: Component) {
    this.el = hostEl.createDiv({ cls: "ereader-panel ereader-appearance", attr: { role: "dialog", "aria-label": "Reading settings" } });
    this.el.hide();
    // A press anywhere else closes it, the way a popover does. The press on
    // the button that opened it is left to that button, which toggles.
    component.registerDomEvent(hostEl.doc, "pointerdown", (event: PointerEvent) => {
      if (!this.isOpen()) return;
      const target = event.target as Node | null;
      if (target && (this.el.contains(target) || this.anchorEl?.contains(target))) return;
      this.hide();
    });
  }

  isOpen(): boolean {
    return this.rows !== null;
  }

  /** Opens with rows read from `rows`, which is called again after every change. */
  open(rows: () => PanelRow[], anchorEl: HTMLElement): void {
    this.rows = rows;
    this.anchorEl = anchorEl;
    this.render();
    this.el.show();
  }

  hide(): void {
    this.rows = null;
    this.el.hide();
  }

  toggle(rows: () => PanelRow[], anchorEl: HTMLElement): void {
    if (this.isOpen()) this.hide();
    else this.open(rows, anchorEl);
  }

  /** Re-reads the rows, for a change made from somewhere other than the panel. */
  refresh(): void {
    if (this.isOpen()) this.render();
  }

  private render(): void {
    const rows = this.rows?.() ?? [];
    this.el.empty();
    for (const row of rows) {
      const rowEl = this.el.createDiv({ cls: `ereader-panel__row is-${row.kind}` });
      if (row.kind !== "action") rowEl.createDiv({ cls: "ereader-panel__label", text: row.label });
      switch (row.kind) {
        case "choice": {
          const group = rowEl.createDiv({ cls: "ereader-panel__choices", attr: { role: "radiogroup", "aria-label": row.label } });
          for (const option of row.options) {
            const selected = option.value === row.value;
            const button = group.createEl("button", {
              cls: `ereader-panel__choice ${option.cls ?? ""}`.trim(),
              text: option.label,
              attr: { role: "radio", "aria-checked": String(selected) },
            });
            button.toggleClass("is-active", selected);
            button.addEventListener("click", () => this.change(() => row.onChange(option.value)));
          }
          break;
        }
        case "toggle": {
          const toggle = rowEl.createDiv({ cls: "checkbox-container", attr: { role: "switch", tabindex: "0" } });
          toggle.toggleClass("is-enabled", row.value);
          toggle.setAttr("aria-checked", String(row.value));
          toggle.setAttr("aria-label", row.label);
          const flip = (): void => this.change(() => row.onChange(!row.value));
          toggle.addEventListener("click", flip);
          toggle.addEventListener("keydown", (event: KeyboardEvent) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            flip();
          });
          break;
        }
        case "stepper": {
          const group = rowEl.createDiv({ cls: "ereader-panel__stepper" });
          const less = group.createEl("button", { cls: "ereader-panel__step", text: "A−", attr: { "aria-label": `Smaller ${row.label.toLowerCase()}` } });
          less.disabled = !row.canDecrease;
          less.addEventListener("click", () => this.change(() => row.onStep(-1)));
          group.createSpan({ cls: "ereader-panel__value", text: row.valueLabel });
          const more = group.createEl("button", { cls: "ereader-panel__step is-large", text: "A+", attr: { "aria-label": `Larger ${row.label.toLowerCase()}` } });
          more.disabled = !row.canIncrease;
          more.addEventListener("click", () => this.change(() => row.onStep(1)));
          break;
        }
        case "action": {
          const button = rowEl.createEl("button", { cls: "ereader-panel__action" });
          setIcon(button.createSpan({ cls: "ereader-panel__action-icon" }), row.icon);
          button.createSpan({ text: row.label });
          const check = button.createSpan({ cls: "ereader-panel__action-check" });
          if (row.checked) setIcon(check, "check");
          button.addEventListener("click", () => this.change(() => row.onClick()));
          break;
        }
      }
    }
  }

  /** Applies a change and redraws, so the panel always shows what is now in force. */
  private change(apply: () => void | Promise<void>): void {
    void Promise.resolve(apply()).then(() => this.refresh());
  }
}
