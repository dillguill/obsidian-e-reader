// Vendored engines are loaded by URL, not by a relative specifier: a
// relative `./vendor/...` import inside the bundle resolves against
// app://obsidian.md/ rather than the plugin folder, which fails. Obsidian
// hands out a loadable URL for a vault path via the adapter.
import type { App } from "obsidian";

let resolve: ((relativePath: string) => string) | null = null;

/** Called once on plugin load, with the plugin's own directory. */
export function initVendorPaths(app: App, pluginDir: string): void {
  resolve = (relativePath) => app.vault.adapter.getResourcePath(`${pluginDir}/vendor/${relativePath}`);
}

/** Absolute, loadable URL for a file under `vendor/`. */
export function vendorUrl(relativePath: string): string {
  if (!resolve) throw new Error("Vendor paths not initialised; call initVendorPaths() on plugin load.");
  return resolve(relativePath);
}
