// Finding the reader that is showing a given book note. Both sidebar panes
// need it, and neither should reach into the reader's internals to get it.

import type { App, TFile } from "obsidian";
import { READER_VIEW_TYPE, ReaderView } from "../reader/reader-view";

export function activeReaderFor(app: App, file: TFile): ReaderView | null {
  for (const leaf of app.workspace.getLeavesOfType(READER_VIEW_TYPE)) {
    const view = leaf.view;
    if (view instanceof ReaderView && view.file === file) return view;
  }
  return null;
}

export function revealReader(app: App, view: ReaderView): void {
  app.workspace.setActiveLeaf(view.leaf, { focus: true });
}
