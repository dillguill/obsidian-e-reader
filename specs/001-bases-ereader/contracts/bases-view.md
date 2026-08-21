# Contract: Library Bases View

**Verified against `obsidian` 1.13.1 typings.** All Bases symbols are `@since 1.10.0`.

## Registration

```ts
this.registerBasesView('ereader-library', {
  name: 'Library',
  icon: 'library-big',
  factory: (controller, containerEl) => new LibraryView(controller, containerEl),
  options: (config) => [ /* see below */ ],
});
```

```ts
registerBasesView(viewId: string, registration: BasesViewRegistration): boolean

interface BasesViewRegistration {
  name: string;
  icon: IconName;
  factory: BasesViewFactory;                                // (controller, containerEl) => BasesView
  options?: (config: BasesViewConfig) => BasesAllOptions[];
}
```

`registerBasesView` returns `boolean` — a false return means registration failed and must be handled,
not ignored.

## View implementation

```ts
abstract class BasesView extends Component {
  abstract type: string;
  app: App;
  config: BasesViewConfig;
  allProperties: BasesPropertyId[];
  data: BasesQueryResult;
  protected constructor(controller: QueryController);
  abstract onDataUpdated(): void;
  createFileForView(baseFileName?, frontmatterProcessor?): Promise<void>;
}
```

`onDataUpdated()` takes **no argument** — read `this.data`. It fires on every query change.

## Reading data

| Source | Use |
|---|---|
| `this.data.data: BasesEntry[]` | Ungrouped, already sorted and limited |
| `this.data.groupedData: BasesEntryGroup[]` | **Preferred.** Honours the reader's groupBy; a single empty-keyed group when none is set (FR-007a) |
| `this.data.properties: BasesPropertyId[]` | Visible properties chosen by the reader |
| `entry.file: TFile` | The book note |
| `entry.getValue(id): Value \| null` | Property value. Errors arrive as `ErrorValue`, so check before rendering |
| `this.config.getOrder()` / `getSort()` / `getDisplayName(id)` | Display order, sort, labels |

## View options — all native primitives (FR-008c)

Declared in `registration.options`; Bases renders and persists them. Every `BasesOption` carries
`key`, `type`, `displayName`, and optional `shouldHide()`.

| Key | Primitive | Purpose |
|---|---|---|
| `coverProperty` | `BasesPropertyOption` | Card image source, `default: 'note.cover'` (FR-003a) |
| `progressProperty` | `BasesPropertyOption` | Progress source (FR-005) |
| `readStateProperty` | `BasesPropertyOption` | Read-state source (FR-004) |
| `progressDisplay` | `BasesDropdownOption` | `{ bar: 'Bar', percent: 'Percentage' }` (FR-005) |
| `tileSize` | `BasesSliderOption` | `min: 80, max: 240, step: 10, default: 140, instant: true` (FR-008b) |

`BasesPropertyOption.filter` narrows the property picker to plausible candidates. The plugin draws
**no settings UI of its own** for view configuration.

## Prohibitions

- No filtering, sorting, searching, or grouping in view code — Bases owns all four (FR-002).
- No vault writes (FR-037).
- No enforcement of the marker property; it is a filter in the `.base` file (FR-006).

## Rendering model

The view is **the built-in Cards view's presentation, plus overlays for the properties it scopes.**

| Concern | Owner |
|---|---|
| Card layout, sizing, grouped presentation, cover loading, no-results behaviour | Follow the built-in Cards view (FR-008a) |
| Displayed properties from `config.getOrder()` | Render as Cards renders them (FR-005a) |
| **Read-state overlay** | This view, when `readStateProperty` is bound and the entry has a value (FR-004) |
| **Progress overlay** | This view, when `progressProperty` is bound and the entry has a value (FR-005) |
| Card image, including missing and unresolvable values | Cards view, via a property option defaulting to `cover` (FR-003a, FR-008) |
| Open on selection, honouring modifiers | This view (FR-007) |

**Conditional, never inferred**: an unbound property or an entry with no value renders **no overlay**.
The view must not derive a read state from a missing progress value, or vice versa.

**Default overlay rendering** must be distinguishable by more than colour (FR-008d). Beyond that,
appearance is left to themes and CSS.

**Not exported, so not inheritable**: the typings expose no concrete Bases view implementation —
no `CardsView`, and `QueryController` is opaque. The factory receives a bare `containerEl`. Matching
the Cards view therefore means reusing Obsidian's CSS variables and class conventions, not
subclassing. Consequently the DOM is the plugin's, and keyboard and focus behaviour must be
implemented rather than inherited.
