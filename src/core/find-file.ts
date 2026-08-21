// Obsidian's Vault only tracks extensions it knows about, so a .epub is
// absent from `vault.getFiles()` and unreachable by link resolution — that is
// why attachment lookups for EPUBs failed no matter which vault API was used.
// The adapter is the raw filesystem underneath and has no such filter.
import type { App } from "obsidian";

/** Vault-relative paths of every file with one of the given extensions. Cached per session. */
let cache: string[] | null = null;

export function clearFileIndexCache(): void {
  cache = null;
}

async function listAllFiles(app: App): Promise<string[]> {
  if (cache) return cache;
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const listing = await app.vault.adapter.list(dir);
    found.push(...listing.files);
    for (const child of listing.folders) {
      if (child.startsWith(".")) continue; // skip .obsidian, .trash and friends
      await walk(child);
    }
  };
  await walk("");
  cache = found;
  return found;
}

/**
 * Finds a vault file by exact path or, failing that, by filename. Returns a
 * vault-relative path suitable for `adapter.readBinary`.
 */
export async function findFileByName(app: App, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate.includes("/") && (await app.vault.adapter.exists(candidate))) return candidate;
  }
  const wanted = new Set(candidates.map((c) => (c.split("/").pop() ?? c).toLowerCase()));
  for (const path of await listAllFiles(app)) {
    const name = (path.split("/").pop() ?? path).toLowerCase();
    if (wanted.has(name)) return path;
  }
  return null;
}
