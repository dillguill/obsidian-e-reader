# Contract: OPDS 1.2 Catalog Client

**Scope**: OPDS 1.2 Atom feeds only. OPDS 2.0 is out of scope and must be reported as unsupported at
configuration time (FR-030b).

**Transport**: Obsidian `requestUrl` — not `fetch` — so the same code path works on desktop and
mobile and bypasses CORS (Principle IV).

## Consumed subset

| Element | Use |
|---|---|
| `feed > entry` | One catalog item |
| `title`, `author/name`, `summary`/`content` | Metadata (FR-013) |
| `dc:identifier`, `dc:issued`, `dc:publisher`, `dc:language` | Metadata |
| `link[rel="http://opds-spec.org/acquisition*"]` | Downloadable file; `type` selects EPUB or PDF |
| `link[rel="http://opds-spec.org/image"]` / `.../thumbnail` | Cover |
| `link[rel="subsection"]` | Navigation feed |
| `link[rel="next"]` | Paging (FR-030a) |
| `link[rel="search"]` → OpenSearch description | Catalog search (FR-030a) |

## Behaviour

- **Parse failure** ⇒ report unsupported, naming the reason (FR-030b, FR-035).
- **Errors** distinguish unreachable host, rejected credential, and unparseable response (FR-035).
- **Download** is atomic: write to a temporary location, then create the book note and move the file
  into place. Any failure or cancellation leaves neither partial file nor orphaned note (FR-033).
- **Duplicates**: warn before writing anything when a matching book exists (FR-034).
- **Credentials** are never persisted to the vault (FR-031a) and require an encrypted connection
  (FR-031c).

**First implementation task**: assess foliate-js's bundled OPDS client against this subset before
writing a parser (R5).
