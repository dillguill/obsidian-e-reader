// The copy and export actions every highlight offers, in the reader's menu
// and the Highlights pane's alike.

import { type App, type Menu, Notice, type TFile } from "obsidian";
import type { HighlightSettings } from "../settings/settings-model";
import type { Entry } from "./entry";
import { exportHighlightNote } from "./export-note";
import { entryCopy, entryLink } from "./links";

function copy(text: string): void {
  void navigator.clipboard.writeText(text).then(
    () => new Notice("Copied."),
    () => new Notice("E-Reader: could not copy to the clipboard."),
  );
}

export function addCopyItems(menu: Menu, app: App, book: TFile, entry: Entry, settings: HighlightSettings): void {
  menu.addItem((item) => item.setTitle("Copy as quote").setIcon("quote").onClick(() => copy(entryCopy(app, book, entry, false))));
  menu.addItem((item) =>
    item.setTitle("Copy as callout").setIcon("message-square-quote").onClick(() => copy(entryCopy(app, book, entry, true))),
  );
  menu.addItem((item) => item.setTitle("Copy link").setIcon("link").onClick(() => copy(entryLink(app, book, entry))));
  menu.addItem((item) =>
    item
      .setTitle("Export as note")
      .setIcon("file-plus")
      .onClick(async () => {
        try {
          const file = await exportHighlightNote(app, book, entry, settings);
          await app.workspace.getLeaf("tab").openFile(file);
        } catch (error) {
          console.error("[e-reader] could not export a highlight", error);
          new Notice("E-Reader: could not export that highlight — see the console.");
        }
      }),
  );
}
