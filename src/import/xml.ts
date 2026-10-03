// Just enough XML reading for an EPUB's container and package documents.
//
// Those are small, machine-written files with a fixed vocabulary, and the
// tests run without a DOM, so a scanner over the text does the job without a
// parser dependency. Namespace prefixes are ignored: `dc:title` and `title`
// are the same element here, which is how EPUBs in the wild need reading.

export interface XmlElement {
  /** Local name, lower-cased, without its namespace prefix. */
  name: string;
  /** Attribute names lower-cased and without prefix; values entity-decoded. */
  attrs: Record<string, string>;
  /** Text content with tags stripped and entities decoded, trimmed. */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return (colon >= 0 ? qualified.slice(colon + 1) : qualified).toLowerCase();
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = match[1];
    if (!name) continue;
    attrs[localName(name)] = decodeEntities(match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function textOf(inner: string): string {
  const withoutCdata = inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, body: string) =>
    body.replace(/&/g, "&amp;").replace(/</g, "&lt;"),
  );
  return decodeEntities(withoutCdata.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** Every element with this local name, in document order. Nested same-name elements are not supported. */
export function findElements(xml: string, name: string): XmlElement[] {
  const wanted = name.toLowerCase();
  const found: XmlElement[] = [];
  const open = /<([\w:.-]+)((?:\s+[^>]*?)?)(\/?)>/g;
  for (let match = open.exec(xml); match !== null; match = open.exec(xml)) {
    const qualified = match[1] ?? "";
    if (localName(qualified) !== wanted) continue;
    const attrs = parseAttrs(match[2] ?? "");
    if (match[3] === "/") {
      found.push({ name: wanted, attrs, text: "" });
      continue;
    }
    const close = xml.indexOf(`</${qualified}>`, open.lastIndex);
    const inner = close >= 0 ? xml.slice(open.lastIndex, close) : "";
    found.push({ name: wanted, attrs, text: textOf(inner) });
    if (close >= 0) open.lastIndex = close;
  }
  return found;
}
