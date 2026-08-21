// A typed event channel between the reader and the sidebar panes.
//
// Obsidian's Events base class is public API, so this stays inside the
// plugin's own object rather than piggy-backing a string event name onto
// the workspace bus (which would collide with, and be observable by, every
// other plugin in the vault).

import type { EventRef } from "obsidian";
import { Events } from "obsidian";
import type { Locator } from "./types";

export class ReaderEvents extends Events {
  /** The reader moved. `filePath` identifies the book note being read. */
  emitPosition(filePath: string, locator: Locator | null): void {
    this.trigger("position", filePath, locator);
  }

  onPosition(callback: (filePath: string, locator: Locator | null) => void): EventRef {
    return this.on("position", callback as (...data: unknown[]) => unknown);
  }
}
