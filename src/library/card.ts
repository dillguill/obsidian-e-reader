// One card: a cover, the configured properties beneath it, and this plugin's
// two overlays. Layout comes from styles.css; nothing here hardcodes size.
import type { App, BasesEntry, BasesPropertyId, BasesViewConfig } from "obsidian";
import { setIcon } from "obsidian";
import type { ReadState } from "../core/types";
import { decideProgressOverlay, decideReadStateOverlay } from "./overlay";
import type { LibraryViewConfig } from "./view-config";

const READ_STATE_ICON: Record<ReadState, string> = {
  unread: "circle",
  reading: "circle-dot",
  finished: "check-circle",
};

/** `ErrorValue` is referenced in the API docs but not exported, so it cannot be instanceof-checked. */
function raw(entry: BasesEntry, propertyId: BasesPropertyId | null): string | null {
  if (propertyId === null) return null;
  const value = entry.getValue(propertyId);
  if (value === null || value === undefined) return null;
  if (value.constructor?.name === "ErrorValue") return null;
  const text = value.toString();
  return text.trim() === "" ? null : text;
}

function coverSrc(app: App, entry: BasesEntry, value: string): string {
  const dest = app.metadataCache.getFirstLinkpathDest(value.replace(/^\[\[|\]\]$/g, ""), entry.file.path);
  return dest ? app.vault.getResourcePath(dest) : value;
}

export function renderCard(
  app: App,
  entry: BasesEntry,
  basesConfig: BasesViewConfig,
  cfg: LibraryViewConfig,
): HTMLElement {
  const card = createDiv({ cls: "ereader-card", attr: { tabindex: "0", role: "button" } });
  // Sized inline so the card renders even if the stylesheet has not loaded.
  const coverHeight = Math.round(cfg.cardSize * cfg.imageAspectRatio);
  card.setCssStyles({ display: "flex", flexDirection: "column", gap: "6px", cursor: "pointer" });

  const cover = card.createDiv({ cls: "ereader-cover" });
  cover.setCssStyles({
    position: "relative",
    width: "100%",
    height: `${coverHeight}px`,
    background: "var(--background-modifier-border)",
    borderRadius: "6px",
    overflow: "hidden",
  });
  const image = raw(entry, cfg.imageProperty);
  if (image !== null) {
    const img = cover.createEl("img", {
      cls: cfg.imageFitContain ? "ereader-cover__img is-contain" : "ereader-cover__img",
      attr: { src: coverSrc(app, entry, image), alt: "" },
    });
    img.setCssStyles({
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: cfg.imageFitContain ? "contain" : "cover",
      display: "block",
    });
    img.addEventListener("error", () => img.remove(), { once: true });
  }

  const readState = decideReadStateOverlay(cfg.progressProperty, raw(entry, cfg.progressProperty));
  if (readState.kind === "read-state") {
    const badge = cover.createDiv({
      cls: ["ereader-badge", `is-${readState.state}`],
      attr: { "aria-label": readState.state, title: readState.state },
    });
    setIcon(badge, READ_STATE_ICON[readState.state]);
  }

  const progress = decideProgressOverlay(cfg.progressProperty, raw(entry, cfg.progressProperty), cfg.progressDisplay);
  if (progress.kind === "progress") {
    const el = cover.createDiv({ cls: "ereader-progress" });
    if (progress.display === "bar") {
      el.createDiv({ cls: "ereader-progress__fill" }).setCssStyles({ width: `${progress.percent}%` });
    } else {
      el.addClass("is-percent");
      el.setText(`${Math.round(progress.percent)}%`);
    }
  }

  // Only what the view is configured to display. Nothing is forced.
  for (const propertyId of basesConfig.getOrder()) {
    const text = raw(entry, propertyId);
    if (text === null) continue;
    card.createDiv({ cls: "ereader-line", text });
  }

  return card;
}
