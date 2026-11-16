# Decision record — composing several overlays

**Task 59. No code changed.** Today exactly one `BinCodeMap` renders and everything else is a
lookup or metadata. E142 permits many overlays per `SubstrateMap`; this note decides what "many"
should mean on screen, and why the two obvious answers are wrong.

Sources read directly:

| Source | Where |
|---|---|
| §13, §13.1–13.4, Table 9 | `pdf/txt/Scan-SEMI-E142-0225.txt` |
| R2-1.2 "Managing the Map Lifecycle" | page 33 |
| `OverlayType`, `OverlayKey`, `SubstrateMap/Overlay` cardinality | `Schema/E142/E142-1-V0125-Schema.xsd` |

---

## 1. What the standard actually permits

**§13.1** — *"The Overlay object is an array of data that corresponds to the dimensions on the Layout
to which the containing SubstrateMap is assigned. An Overlay object may have one or more
ReferenceDevice objects and either a BinCodeMap object, a DeviceIdMap object, a list of one or more
TransferMaps, or a list of one or more DeviceDataMaps."* `quoted from E142-0225`

Two facts in one sentence, and both constrain the design:

1. **An overlay carries exactly one KIND** — the `xs:choice` this package has been navigating since
 Phase 9. So "several overlays" does not mean "several kinds layered together"; it means several
 `Overlay` elements, each of one kind.
2. **Every overlay corresponds to the SAME Layout dimensions.** Not "may"; the sentence defines an
 Overlay as an array over the containing `SubstrateMap`'s assigned layout. There is one lattice
 per `SubstrateMap`, and every overlay is an array over it. `[A]`

The schema adds the cardinality: `<xs:element name="Overlay" ... minOccurs="0" maxOccurs="unbounded"/>`
declared by the XSD, and `OverlayKey` is an `xs:key` over (`@MapName`, `@MapVersion`) — so overlays are
distinguished by that pair and no two may share it.

**Table 9** on `MapName`: *"A name that describes the purpose of the bin codes in the map. Possible
examples include: 'CellStatus', 'DefectCode', 'MarkGrade', 'PackageGrade', 'SortGrade', 'DeviceId',
'Transfer'."* `quoted from E142-0225`

That list is the strongest hint in the document about intent, and it is worth reading carefully:
`CellStatus`, `DefectCode`, `MarkGrade`, `PackageGrade`, `SortGrade` are **five different judgements
about the same die**, not five parts of one picture. A die is `SortGrade=1` *and* `DefectCode=07`
*and* `PackageGrade=B`. They coexist; they do not compose into a single colour.

**R2-1.2** describes the other axis: the same `MapName` at `MapVersion=1` downloaded to equipment and
`MapVersion=2` uploaded back. Two overlays that are the same measurement **at different times**.

So E142 has two orthogonal reasons for several overlays — different *judgements* (by `MapName`) and
different *revisions* (by `MapVersion`) — and neither is a rendering layer.

---

## 2. The decision: base layer + ordered decorations

**One `BinCodeMap` overlay is the BASE. It owns the fill of every cell. Other overlays contribute
per-cell MARKS on top — a corner triangle, a border, a glyph — never a fill.** `[B]`

The base is chosen exactly as it is today: `E142OverlayName` / `E142OverlayVersion`, falling back to
the first renderable overlay. Decorations are a new, ordered list of overlay names; the order is the
z-order, and it is the caller's, not the document's.

Why this and not the alternatives is §3. What it buys, stated first:

- **One colour system.** `StatusColorMapping` maps a bin code to a fill. It stays exactly as it is,
 scoped to the base layer, and decorations get their own small vocabulary of marks. No second
 colour model, no blending, no opacity stack to reason about.
- **It composes with Phases 8–10 unchanged.** A cell already reports `binCode`, `lid`, `deviceId`,
 five transfer fields and `deviceData`. Decorations add to that list; they do not reinterpret it.
- **It is honest about the data.** Five judgements about one die *are* five separate facts. A badge
 per fact says so; a blended colour claims they are one measurement.

---

## 3. Rejected alternatives

### (a) STACK — several `BinCodeMap`s as z-ordered layers with per-layer opacity

Rejected. `[A]` on the reasoning, since the objection is not aesthetic.

**Alpha-compositing two bin codes produces a colour that means nothing.** `StatusColorMapping` is a
lookup from a bin code to a colour; there is no algebra on the results. 60% of "Pass green" over
"Fail red" is a brown that maps back to no bin code at all, and an operator reading it cannot
recover either input. The control would be generating a value the document never contained and the
legend cannot explain.

The failure is worse than uninformative — it is **plausible**. A blended colour looks like a
deliberate status, so it will be read as one.

Two further problems, either fatal on its own:

- **There is no z-order in the document.** Overlay order in the file is not declared to mean
 anything, and `OverlayKey` is (`MapName`, `MapVersion`) — a *set*, not a sequence. A stack would
 have to invent the ordering, and the picture would change with the file's element order.
- **Opacity is not in E142 anywhere.** Per-layer opacity is a rendering concept with no document to
 drive it, so every value would be a UI preference masquerading as data.

### (b) SWITCH — one active overlay, the rest merely selectable

Rejected, though it is what exists today and it is not *wrong*. `[B]`

Switching is already available and stays: `E142OverlayName` picks the base. But as the whole answer
it fails the use case the standard's own `MapName` list describes. An operator asking "which of these
failed dies also has a defect code?" cannot answer it by flipping between two views — the question
is about **coincidence**, and coincidence is exactly what a view showing one layer at a time
destroys. Human short-term memory does not diff two 600 × 600 grids.

Switching is the right primitive and the wrong ceiling.

### (c) FACET — one base plus per-cell badges from the others

**This is the recommendation**, and (b) is its degenerate case with zero decorations. Named here as
"rejected" only to record what it is *not*: it is not a stack, and a decoration must never be
implemented as a translucent fill, which would smuggle (a) back in through the styling.

### (d) MERGE — combine bins into a synthetic code per cell

Rejected without much difficulty. `[A]` It invents bin codes that no `BinDefinitions` declares,
which breaks the legend, the `binQuality` reporting and the `Pick` flag. `BinDefinitionsType`
enumerates the codes a map uses; a synthetic code is by construction not among them.

---

## 4. How a cell with different bins in two layers reports

**`binCode` remains the BASE layer's bin, unchanged.** `[B]` Every existing consumer of
`onItemSelected` keeps working, and the field keeps a single, stable meaning: *the bin of the overlay
that is rendering the fill*.

The other layers report **alongside**, in a new array:

```
onItemSelected (kind: 'cell')
 binCode "1" <- base layer, unchanged
 binQuality "Pass" <- base layer, unchanged
 overlays [ { mapName: "SortGrade", mapVersion: "1", binCode: "1", binQuality: "Pass" },
 { mapName: "DefectCode", mapVersion: "1", binCode: "07", binQuality: null } ]
```

Four rules, each with a reason a reader can attack:

1. **`overlays` includes the base**, as its first entry. A consumer iterating the array should not
 have to special-case the layer that happens to be rendering, and a view that lists "all judgements
 about this die" wants all of them. `[B]`
2. **Entries carry `mapName` AND `mapVersion`.** `OverlayKey` is the pair; `MapName` alone does not
 identify an overlay, and R2-1.2's lifecycle is precisely two overlays sharing a name. Reporting
 only the name would make the download and the upload indistinguishable. `[A]`
3. **A layer that does not cover the cell reports `binCode: null`**, and is still listed. Absent from
 the array would be ambiguous with "that overlay does not exist"; the distinction is the same one
 Tasks 52–54 preserved between `xsi:nil`, `NoValue` and absence. `[B]`
4. **`binCode` is NOT changed to an array.** A breaking change to the most-used field of the
 most-used event, to serve the multi-layer case, would be paid for by every existing single-layer
 view. `[A]` as a compatibility judgement.

---

## 5. How `StatusColorMapping` scopes

**`StatusColorMapping` applies to the BASE layer only, and its meaning is unchanged.** `[B]`

The alternative — a mapping per overlay name — was considered and rejected for now:

- It would require a keyed structure (`{ overlayName: { bin: colour } }`) where today there is a flat
 map, which is a breaking change to a bound attribute.
- Decorations do not take fills, so a per-layer *colour* map has nothing to colour. What a decoration
 needs is a mark **shape** and a small palette, which is a different attribute with a different
 shape.

So: `StatusColorMapping` stays flat and base-scoped. Decoration appearance is a separate attribute
whenever it is implemented, and the two must not be merged — the moment a decoration takes a fill
colour from the same map, alternative (a) is back.

**Consequence worth stating**: two overlays using the same bin code for different meanings —
`SortGrade` `1` = "pass", `PackageGrade` `1` = "grade A" — do not collide, because only the base is
coloured. Under a per-layer colour map they would collide constantly, since bin codes are short and
`BinDefinitions` is per-`BinCodeMap`.

---

## 6. When layers disagree on lattice size

**They cannot, in a conforming document — and when they do, it is an ERROR for the decoration and
never for the base.** `[A]` on the first half, `[B]` on the handling.

§13.1 defines an Overlay as an array over the dimensions of the layout the *containing SubstrateMap*
is assigned. One `SubstrateMap` has one `LayoutSpecifier`, hence one lattice, and every overlay in it
is an array over that lattice. A `2DArray` overlay whose rows imply 8 × 11 inside a `SubstrateMap`
whose layout declares 4 × 3 is not a second lattice — it is a **malformed overlay**.

That case is already detected: `resolveSerializationDims` compares the observed shape against the
declared one and reports `E142_XML_DIM_MISMATCH`. What Phase 11 adds is what to do about it when the
mismatching overlay is a decoration:

| Situation | Handling |
|---|---|
| BASE disagrees with the layout | Unchanged — today's `E142_XML_DIM_MISMATCH` path. The base owns the geometry. |
| DECORATION disagrees with the base | **Drop that decoration, report it, render the rest.** |
| Decoration is smaller | Still dropped. Overlaying a 3 × 3 onto a 4 × 4 requires choosing a corner, and nothing in the document says which. |

Dropping beats scaling, cropping or aligning, and the reason is the one from Task 49: **a wrong
decoration is invisible.** A dropped one is reported and absent; a cropped one silently marks the
wrong dies, and nothing on screen says so. The same asymmetry that made a dangling `TransferMap`
better omitted than emitted.

**Never derive the lattice from a decoration.** The base and the layout own it. A decoration that
would enlarge the grid is the case that must be refused most firmly, because it changes what every
other layer means.

---

## 7. Grade summary

| Rule | Grade |
|---|---|
| An overlay carries exactly one kind (`xs:choice`) | `[A]` XSD |
| Every overlay is an array over the SAME layout dimensions | `[A]` §13.1 |
| Overlays are keyed by (`MapName`, `MapVersion`), a set not a sequence | `[A]` XSD |
| `MapName`'s examples are parallel judgements, not layers of one picture | `[B]` reading of Table 9 |
| Base layer + ordered decorations | `[B]` design decision |
| Reject stack: blended bin colours mean nothing, and no z-order exists | `[A]` reasoning |
| Reject switch-only: it destroys coincidence, the question layers exist to answer | `[B]` |
| Reject merge: synthetic codes break `BinDefinitions`, `binQuality` and `Pick` | `[A]` |
| `binCode` stays the base layer's, unchanged | `[A]` compatibility |
| `overlays[]` includes the base, first | `[B]` |
| Entries carry name AND version | `[A]` `OverlayKey` |
| A non-covering layer reports `binCode: null` and is still listed | `[B]` |
| `StatusColorMapping` stays flat and base-scoped | `[B]` |
| Decoration appearance is a SEPARATE attribute, never a fill | `[A]` or (a) returns |
| A decoration disagreeing on size is dropped and reported | `[B]` |
| The lattice is never derived from a decoration | `[A]` |

---

## 8. What this implies for the code

- **`E142DecorationOverlayNames`** — an ordered list attribute, default empty. Empty means today's
 behaviour exactly, which is the property that makes this shippable in stages.
- Selection gains `overlays: Array<{ mapName, mapVersion, binCode, binQuality }>` on the cell
 payload, and the same on `SelectedItems`.
- The engine gains a per-decoration cell lookup, built like the device-id / transfer / device-data
 indexes and resolved with the same `__resolveAddressToCell` — LID first, then X/Y. That helper now
 has three callers; a fourth costs nothing.
- Rendering: decorations draw **after** the grid and **before** the origin marker, in the caller's
 list order.
- Corpus obligation under rule 10 when the behaviour lands: two overlays agreeing; two disagreeing on
 one cell; an overlay covering only part of the grid; two overlays sharing a `MapName` with
 different `MapVersion`s (the R2-1.2 lifecycle shape); and a decoration whose dimensions disagree
 with the base. Five cases, none of which the corpus has today — `v0211-multi-overlay.xml` is the
 closest and it exercises selection, not composition.
