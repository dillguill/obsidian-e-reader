// One card: a cover, the configured properties beneath it, and this plugin's
// overlays. Layout comes from styles.css; nothing here hardcodes size.
//
// The overlays only appear when they say something. An unread book is a
// clean cover; a book in progress gets a fade along the bottom carrying its
// percentage and a thin bar; a finished one gets a small check.
import type { App, BasesEntry, BasesPropertyId, BasesViewConfig } from "obsidian";
import { setIcon } from "obsidian";
import { decideProgressOverlay, decideReadStateOverlay } from "./overlay";
import { placeholderHue, placeholderTitle } from "./placeholder";
import type { LibraryViewConfig } from "./view-config";

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
  // The placeholder is drawn underneath, so a cover that fails to load
  // falls back to it rather than to an empty box.
  renderPlaceholder(cover, entry.file.basename);
  const image = raw(entry, cfg.imageProperty);
  if (image !== null) {
    const img = cover.createEl("img", {
      cls: cfg.imageFitContain ? "ereader-cover__img is-contain" : "ereader-cover__img",
      attr: { src: coverSrc(app, entry, image), alt: "", loading: "lazy", decoding: "async" },
    });
    img.setCssStyles({
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      objectFit: cfg.imageFitContain ? "contain" : "cover",
      display: "block",
    });
    img.addEventListener("load", () => cover.addClass("has-image"), { once: true });
    img.addEventListener("error", () => img.remove(), { once: true });
  }

  const progressRaw = raw(entry, cfg.progressProperty);
  const readState = decideReadStateOverlay(cfg.progressProperty, progressRaw);
  const progress = decideProgressOverlay(cfg.progressProperty, progressRaw);
  if (readState.kind === "read-state" && readState.state === "finished") {
    const badge = cover.createDiv({ cls: "ereader-badge", attr: { "aria-label": "Finished", title: "Finished" } });
    setIcon(badge, "check");
  } else if (readState.kind === "read-state" && readState.state === "reading" && progress.kind === "progress") {
    const percent = Math.round(progress.percent);
    const el = cover.createDiv({ cls: "ereader-progress", attr: { "aria-label": `${percent}% read` } });
    el.createDiv({ cls: "ereader-progress__label", text: `${percent}%` });
    const track = el.createDiv({ cls: "ereader-progress__track" });
    track.createDiv({ cls: "ereader-progress__fill" }).setCssStyles({ width: `${progress.percent}%` });
  }

  // Only what the view is configured to display. Nothing is forced.
  for (const propertyId of basesConfig.getOrder()) {
    const text = raw(entry, propertyId);
    if (text === null) continue;
    card.createDiv({ cls: "ereader-line", text });
  }

  return card;
}

function renderPlaceholder(cover: HTMLElement, basename: string): void {
  const hue = placeholderHue(basename);
  const el = cover.createDiv({ cls: "ereader-cover__placeholder" });
  el.setCssProps({ "--ereader-cover-hue": `${hue}` });
  el.createDiv({ cls: "ereader-cover__placeholder-title", text: placeholderTitle(basename) });
}
