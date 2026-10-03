import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractIsbn, opfPathFromContainer, parseOpf, readEpubMetadata } from "../../src/import/epub-metadata";
import { decodeEntities, findElements } from "../../src/import/xml";

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const OPF3 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">urn:isbn:978-0-441-17271-9</dc:identifier>
    <dc:title>Dune &amp; Other Sands</dc:title>
    <dc:creator id="c1">Frank Herbert</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>1965-08-01</dc:date>
    <dc:publisher>Chilton</dc:publisher>
    <dc:subject>Science fiction</dc:subject>
    <dc:subject>Deserts</dc:subject>
    <dc:description>&lt;p&gt;A desert &lt;em&gt;planet&lt;/em&gt;.&lt;/p&gt;</dc:description>
    <meta property="dcterms:modified">2020-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="img" href="images/cover%20art.jpg" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine><itemref idref="nav"/></spine>
</package>`;

const OPF2 = `<package version="2.0"><metadata>
  <dc:title>Emma</dc:title>
  <dc:creator opf:role="aut">Jane Austen</dc:creator>
  <dc:creator opf:role="edt">Some Editor</dc:creator>
  <dc:identifier opf:scheme="ISBN">0141439580</dc:identifier>
  <meta name="cover" content="cover-id"/>
</metadata><manifest>
  <item id="cover-id" href="../Images/front.png" media-type="image/png"/>
</manifest></package>`;

describe("xml helpers", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#233; &#x2014;")).toBe("a & b <c> é —");
  });

  it("finds elements regardless of namespace prefix, with attributes and text", () => {
    const [el] = findElements(`<x:item a:id="1" href='b'>t<b>x</b></x:item>`, "item");
    expect(el).toEqual({ name: "item", attrs: { id: "1", href: "b" }, text: "tx" });
  });

  it("does not match a longer element name", () => {
    expect(findElements(`<itemref idref="x"/>`, "item")).toEqual([]);
  });
});

describe("EPUB package metadata", () => {
  it("reads the package path from the container", () => {
    expect(opfPathFromContainer(CONTAINER)).toBe("OEBPS/content.opf");
  });

  it("reads an EPUB 3 package", () => {
    const opf = parseOpf(OPF3, "OEBPS/content.opf");
    expect(opf).toMatchObject({
      title: "Dune & Other Sands",
      authors: ["Frank Herbert"],
      language: "en",
      published: "1965-08-01",
      publisher: "Chilton",
      isbn: "9780441172719",
      subjects: ["Science fiction", "Deserts"],
      description: "A desert planet.",
      cover: { path: "OEBPS/images/cover art.jpg", mediaType: "image/jpeg" },
    });
  });

  it("reads an EPUB 2 package, keeping only authors and resolving a parent-relative cover", () => {
    const opf = parseOpf(OPF2, "OPS/Text/content.opf");
    expect(opf.authors).toEqual(["Jane Austen"]);
    expect(opf.isbn).toBe("0141439580");
    expect(opf.cover).toEqual({ path: "OPS/Images/front.png", mediaType: "image/png" });
  });

  it("recognises ISBN-10 and ISBN-13 and rejects anything else", () => {
    expect(extractIsbn("urn:isbn:0-14-143958-X")).toBe("014143958X");
    expect(extractIsbn("978 0 14 143958 7")).toBe("9780141439587");
    expect(extractIsbn("urn:uuid:1234")).toBeNull();
  });

  it("reads metadata and cover bytes out of a real archive", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file("META-INF/container.xml", CONTAINER);
    zip.file("OEBPS/content.opf", OPF3);
    zip.file("OEBPS/images/cover art.jpg", new Uint8Array([1, 2, 3]));
    const data = await zip.generateAsync({ type: "arraybuffer" });
    const meta = await readEpubMetadata(data, "fallback");
    expect(meta.title).toBe("Dune & Other Sands");
    expect(meta.cover?.extension).toBe("jpg");
    expect(new Uint8Array(meta.cover?.data ?? new ArrayBuffer(0))).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("falls back to the file name when the archive has no package", async () => {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    const meta = await readEpubMetadata(await zip.generateAsync({ type: "arraybuffer" }), "My Book");
    expect(meta).toEqual({ title: "My Book", authors: [], subjects: [] });
  });
});
