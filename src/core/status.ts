// A book's statuses (read later, wishlist) as values in one list property,
// which can be the note's tags. Pure: reads and rewrites a raw frontmatter
// value, so the library and the importer agree on what a status looks like.
//
// The other values in that list belong to the reader, not this plugin, so
// they are kept exactly as written; only the status being changed is touched.

/** Where statuses are kept and the values that mean each one. */
export interface StatusSettings {
  /** True keeps statuses in `tags`; false in the list property named below. */
  useTags: boolean;
  /** The list property used when `useTags` is false. */
  property: string;
  readLater: string;
  wishlist: string;
}

/** The frontmatter property statuses are written to. */
export function statusProperty(settings: StatusSettings): string {
  return settings.useTags ? "tags" : settings.property;
}

/** A status value as it is written: tags lose a leading `#` and cannot hold spaces. */
export function normalizeStatus(value: string, useTags: boolean): string {
  const trimmed = value.trim();
  return useTags ? trimmed.replace(/^#+/, "").replace(/\s+/g, "-") : trimmed;
}

/** The entries of a list property, from a list or the comma-separated string Obsidian also accepts. */
export function readStatusList(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return parts
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .map((part) => String(part).trim())
    .filter((part) => part !== "");
}

function sameStatus(entry: string, value: string): boolean {
  return entry.replace(/^#+/, "").toLowerCase() === value.replace(/^#+/, "").toLowerCase();
}

/** Whether the list in `raw` carries `value`, ignoring case and a tag's `#`. */
export function hasStatus(raw: unknown, value: string): boolean {
  if (value.trim() === "") return false;
  return readStatusList(raw).some((entry) => sameStatus(entry, value));
}

/**
 * The list with `value` added or removed, or null when nothing is left and
 * the property should go rather than stay as an empty list.
 */
export function withStatus(raw: unknown, value: string, on: boolean): string[] | null {
  const others = readStatusList(raw).filter((entry) => !sameStatus(entry, value));
  const next = on && value.trim() !== "" ? [...others, value] : others;
  return next.length > 0 ? next : null;
}

/** Adds or removes a status on a note's frontmatter object, in place. */
export function applyStatus(frontmatter: Record<string, unknown>, settings: StatusSettings, value: string, on: boolean): void {
  const property = statusProperty(settings);
  if (property.trim() === "") return;
  const next = withStatus(frontmatter[property], normalizeStatus(value, settings.useTags), on);
  if (next === null) delete frontmatter[property];
  else frontmatter[property] = next;
}
