# Decision record — LID (location identifier) addressing

**Task 38. No code changed.** This note settles how a LID-addressed map should be resolved to a
lattice, what to do when a map mixes addressing forms, and how `DeviceIdMap` LIDs join to `BinCode`
LIDs — with a grade on every rule, because they are not all equally supported.

Sources read directly, not paraphrased from a summary:

| Source | Where |
|---|---|
| §13.3, §13.4 | `pdf/txt/Scan-SEMI-E142-0225.txt`, page 9 |
| R2-3.2.1, R2-3.2.2, R2-3.3.1, R2-3.3.2 | pages 43–44 |
| Figure R2-22 "Examples of Transfers via TnR" | page 44 — read from a **redraw supplied by the reviewer**; see §6 for provenance |
| `TransferType`, `TransferMapType` | `Schema/E142/E142-1-V0125-Schema.xsd` |
| `BinCodeType`, `DeviceIdType`, `DeviceDataType`, `OverlayType` | `Schema/E142/E142-1-V0125-Schema.xsd` |

---

## 1. What the standard actually fixes

Two sentences carry almost all of it.

**§13.3** — *"The position on the substrate shall be either the X and Y coordinate, or the location
identifier, or both."* `quoted from E142-0225`

A `shall`, and the only one in the LID area. Three addressing forms are permitted per position, and
**"or both" is explicitly legal** — so a document may address the same cell twice, by coordinate and
by name, and a consumer that treats the two as alternatives rather than as co-equal is wrong.

**§13.4** — *"A location identifier is distinct from the DeviceId (identifier on the device) that
might be placed in that position. The location identifier is still present when the device is
removed."* `quoted from E142-0225`

This is the sentence that decides the data model. A LID names a **socket**, not an occupant. It
belongs to the substrate's geometry and outlives whatever sits in it. That rules out the tempting
shortcut of treating LIDs as a device-keyed side table.

The schema adds the structural facts:

```
BinCodeType X? Y? LID? Number? all use="optional"
DeviceIdType X? Y? LID? all use="optional"
DeviceDataType X? Y? LID? all use="optional"
```

`LID` is `xs:string` in all three — **opaque, no lexical structure, no facet, no key or keyref**.
Three consequences that matter more than they look:

1. **A LID is not orderable.** Nothing says `"P0002"` follows `"P0001"`; nothing says a LID is even
 numeric. Any resolution that sorts LIDs is inventing a rule the standard does not have.
2. **A LID is not unique by declaration.** There is no `xs:key` on it anywhere. Duplicates are
 schema-valid.
3. **The three sites are independent.** `BinCodeType` and `DeviceIdType` both carry a `LID` and the
 schema states no relationship between them. The join in §4 below is a *convention*, not a
 constraint the validator enforces.

---

## 2. Resolution strategy — a LID-only map has no intrinsic lattice

This is the core of the task and the answer is a refusal before it is a design.

A `MapType="Coordinate"` payload whose entries carry only `LID` gives a set of named cells with **no
dimensions, no ordering and no adjacency**. `X`/`Y` are what place a cell in the lattice; without
them there is nothing to place. `dimsFromPayload()` — the layoutless fallback — works by taking
`max(X)+1` and `max(Y)+1`, and has nothing to work from here.

So a lattice must be **supplied or derived**, never guessed. Three tiers, in the order a consumer
should try them:

### Tier 1 — `lidOrder`, an explicit caller-supplied order `[A]` as a mechanism, `[C]` as a default

The caller supplies a `dimension` and states that **document order is a row-major fill** of it. Cell
*n* of the document lands at `(n mod cols, floor(n / cols))` in logical coordinates.

`[A]` that this is well defined and unambiguous; `[C]` that any particular document's order means
this. **Document order is not normative** — nothing in E142 says the *n*-th `BinCode` is the *n*-th
position. It is a convention the caller asserts, and the API must make the caller assert it rather
than assuming it. Concretely: `lidOrder` is opt-in, and its absence is an error, not a default.

Why row-major and not column-major: it matches `MapType="2DArray"`, where a `BinCode` element **is**
a row, and consistency inside one package beats a coin toss. `[B]`.

### Tier 2 — the TnR rule, as the documented default for `SubstrateType="TnR"` `[B]`

R2-3.3 is the one place the standard describes how to derive coordinates when the pockets are not
marked:

> R2-3.3.1 — *for X, `0` indicates the location beginning at the first pocket closest to the TnR hub,
> and Xmax indicates the pocket furthest from the hub*
> R2-3.3.2 — *for Y, `0` indicates the first row of pockets, and if there are multiple rows Y
> increases for each successive row*
>
> `quoted from E142-0225`, lightly de-OCR'd: the scan renders "For X" as "For A" and one `0` as the
> letter `O`. The sense is unambiguous from R2-3.3.1's own "Xmax".

So for a tape and reel: **X runs along the tape away from the hub, Y indexes the row.** A single-row
tape is `Y=0` throughout and X is the pocket ordinal.

Graded `[B]`, not `[A]`, for two reasons. It is a `should`, not a `shall`. And it tells you what the
axes *mean* — it does not tell you that the *n*-th `BinCode` element is the *n*-th pocket. Applying
it still requires the Tier-1 assumption about document order; R2-3.3 fixes the axis semantics, not
the mapping from document to lattice.

It is a good default precisely because it is scoped: `SubstrateType="TnR"` is a declared attribute,
so the default fires only where the standard actually discusses it, and a wafer never silently
inherits a tape convention.

### Tier 3 — refuse `[A]`

No `lidOrder`, not a TnR: **report an error naming the missing input.** Not a warning, and not a
1×N fallback.

The reasoning is the one this package has used since Task 11: a guessed lattice is not a degraded
answer, it is a confident wrong one. A 1×N strip renders, looks plausible, and silently asserts an
adjacency the document never stated — an operator reading neighbouring cells as physically adjacent
would be misled by the tool rather than by the data. Refusing is the failure-tolerant option under
standing rule 9, and it is the only tier that cannot produce a wrong picture.

---

## 3. When a map mixes LID-only and X/Y cells

§13.3's "or both" makes four cases reachable **in one `BinCodeMap`**, and the corpus already carries
a fixture with three of them (`v0125-coordinate-lid-mixed.xml`).

| Entry carries | Treatment | Grade |
|---|---|---|
| `X` and `Y`, no `LID` | Placed by coordinate. Today's behaviour. | `[A]` |
| `X`, `Y` **and** `LID` | Placed by coordinate; the LID is an alias for that cell and is retained. **The coordinate wins** — it is the only one of the two that carries position. | `[A]` |
| `LID` only | Not placeable. Retained out-of-band. | `[A]` |
| neither | Address-less; retained, never placed. | `[A]` |

**Coordinate wins over LID, always** — not as a preference but because a LID is a name and a
coordinate is a position; there is no conflict to arbitrate. The one case that *would* be a conflict
— a LID resolving through `lidOrder` to a different cell than the entry's own X/Y — must be a
**warning naming both**, never a silent pick. The document is self-inconsistent and only its author
can say which is right. `[B]`: the standard does not discuss the case, and warn-and-prefer-the-
coordinate is the failure-tolerant reading.

**A mixed map is already not silently downgraded — corrected in Task 39.** An earlier draft of this
note claimed the parser set LID-only entries aside without saying so. It does not. It emits one
aggregate `E142_XML_LID_ONLY_EXCLUDED` warning that counts the entries, lists the first eight LIDs
verbatim, says **where they went** (`carried in the overlay's sparseBinCodes instead`) and grades its
own handling. That is better than the behaviour this note originally asked for, and the entries
themselves are retained on the overlay in document order — nothing is dropped.

What remains open is only a matter of degree: the warning fires for one excluded entry out of a
hundred exactly as it does for ninety-nine out of a hundred, and in the second case the rendered
picture is more absence than data. A **proportional** escalation would be an improvement, not a
correction. `[C]`, and low priority.

---

## 4. How `DeviceIdMap` LIDs join to `BinCode` LIDs — the R2-3.2.2 path

R2-3.2.2 is the only place the standard describes the join, and it does so by example:

> *"In many cases, however, the tape and reel does not have pocket numbers but instead a unique
> pocket identifier (PI). In this case, the traceability is established by recording the PI values
> in a DeviceIdMap for the source, TnR and target substrates."* `quoted from E142-0225`

Read with §13.4, the mechanism is:

```
source substrate TnR target substrate
 DeviceIdMap/Id DeviceIdMap/Id DeviceIdMap/Id
 @LID = socket name -> @LID = pocket id -> @LID = socket name
 text = DeviceId text = DeviceId text = DeviceId
```

The **`DeviceId` is the moving part** and the LID is the fixed one — exactly §13.4's distinction.
Traceability is established by matching the *device* across three substrates; the LID says where it
sat on each. A pocket keeps its PI when the device leaves.

Structurally, `OverlayType` declares an `xs:choice` of `BinCodeMap` / `DeviceIdMap` / `TransferMap` /
`DeviceDataMap`, so **one overlay carries exactly one of them.** A document pairing bin codes with
device ids therefore needs *two overlays* on the same `SubstrateMap`, and the join between them is by
address: same `LID`, or same `(X, Y)`.

### 4a. The transfer record IS the bridge — Figure R2-22

Figure R2-22 shows two arrows through a tape and reel, and their labels are the whole answer:

```
 Transfer(FX, FY, TID) Transfer(FID, TX, TY)
 wafer -------------------> TnR pocket -------------------> target
 from COORDINATES from IDENTIFIER
 to IDENTIFIER to COORDINATES
```

`TransferType` confirms it exactly declared by the XSD — six attributes, **all optional, none coupled**:

```
FX xs:integer FY xs:integer FID xs:string
TX xs:integer TY xs:integer TID xs:string
```

**Each END of a transfer is independently addressed, by a coordinate pair or by an identifier.**
`[A]` — the schema says so and the figure exercises it. `FID` / `TID` are `xs:string` exactly as `LID`
is: the same opaque, unordered, non-unique kind of thing, at transfer scope.

That changes the answer to this section. **The join does not have to be inferred at all when a
`TransferMap` is present** — the document states it. `Transfer(FX=3, FY=7, TID="PKT-0042")` says, in
one element, *the device at wafer (3,7) is now in pocket PKT-0042*. That is the LID-to-coordinate
bridge, written down.

`TransferMapType` names the other end on the map rather than per device:

```
TransferMap @FromSubstrateType @FromSubstrateId @FromSubstrateLayoutSpecifier (all required)
 T* -> TransferType
```

So the figure's two arrows are two `TransferMap`s living on two different substrates: one on the
TnR's overlay with `FromSubstrateType="Wafer"`, one on the target's with `FromSubstrateType="TnR"`.
The chain is walked by following `FromSubstrateId`, not by matching device ids.

**E142 therefore offers three ways to express the same TnR traceability**, and a consumer should
expect any of them:

| Mechanism | Where it is stated | Needs a DeviceId? |
|---|---|---|
| `TransferMap` with `FID` / `TID` | Figure R2-22 | no — the pocket identifier is the key |
| `DeviceIdMap` with the PI recorded per substrate | R2-3.2.2 | **yes** — the DeviceId is the join key |
| Derived `XY` from hub distance and row | R2-3.3 | no — there are no identifiers at all |

They are alternatives, not layers. R2-3.2.2's phrasing — *"in many cases, however"* — makes the
`DeviceIdMap` route the fallback for tapes that carry a PI but no pocket numbers, and R2-3.3 the
fallback for tapes that carry neither.

**Consequence for a reader.** A `TransferMap` is authoritative where it exists and must be preferred
over any inference: it is the producer stating the correspondence rather than a consumer guessing it.
`[A]`.

Rules, and their grades:

1. **Join `BinCode` to `DeviceIdMap/Id` on `LID` when both carry one; otherwise on `(X, Y)`.**
 `[B]` — the natural reading of §13.3 (a position is identified by either form), never stated for
 this pair. **Corroborated by Figure R2-22**, which shows the standard's own worked example
 addressing one end of a relationship by identifier and the other by coordinates, in a single
 record. A consumer that handled only one form could not read the figure's own document.
2. **A LID that appears in one map and not the other is not an error.** The maps are independent
 overlays and either may be sparse. `[B]`.
3. **A LID appearing twice within one `DeviceIdMap` is a warning, not an error.** No `xs:key` exists,
 so duplicates are schema-valid; the first should win and the collision should be reported.
 `[C]` — pure inference, but the alternative (silently taking the last) loses data without saying so.
4. **Never join on `DeviceId`.** §13.4 is explicit that the device identifier is *not* the location
 identifier; the same device legitimately appears under three different LIDs across the transfer
 chain, so a DeviceId join would collapse the very distinction the traceability path depends on.
 `[A]`.

The control's existing `__deviceIdIndex` — `Map<linearCellIndex, deviceId>` — is keyed on the placed
cell, so it already implements rule 1's `(X, Y)` half. Adding the `LID` half is a lookup change, not
a model change.

---

## 5. Grade summary

| Rule | Grade |
|---|---|
| A LID names a location, not a device; it outlives the device | `[A]` §13.4 |
| Three addressing forms, "or both" legal | `[A]` §13.3 |
| A LID is opaque, unordered, non-unique | `[A]` XSD |
| A LID-only map has no intrinsic lattice | `[A]` follows from the XSD |
| `lidOrder` as an explicit, opt-in mechanism | `[A]` mechanism / `[C]` that any document means it |
| Row-major rather than column-major fill | `[B]` consistency with `2DArray` |
| TnR: X away from the hub, Y per row | `[B]` R2-3.3, a `should`, and it fixes axes not order |
| Refuse when neither is available | `[A]` decision, not derivation |
| Coordinate wins over LID for placement | `[A]` |
| Coordinate/LID disagreement warns naming both | `[B]` |
| Warn when a map is mostly LID-only | `[B]` |
| Each transfer END is independently addressed: coordinates or identifier | `[A]` XSD + Figure R2-22 |
| A `TransferMap` states the LID-to-coordinate bridge outright; prefer it over inference | `[A]` |
| Identifier on the TnR side, coordinates on the other — the figure's pairing | `[B]` an example, not a rule |
| Three alternative TnR mechanisms: `TransferMap` / `DeviceIdMap`+PI / derived XY | `[B]` |
| Join on LID, else on (X, Y) | `[B]`, corroborated by Figure R2-22 |
| Missing LID on one side is not an error | `[B]` |
| Duplicate LID within a map warns, first wins | `[C]` |
| Never join on DeviceId | `[A]` §13.4 |

---

## 6. Figure R2-22 — what it shows, and the provenance of this reading

**Provenance, stated because it matters.** Page 44 rasterises correctly at 400 dpi and the figure
occupies the ink band y 682–1348 — a colour drawing of roughly 7 950 ink pixels. It could not be
displayed for reading in this environment, while figures on pages 23, 25 and 41 rendered without
trouble. **The reading below comes from a redraw supplied by the reviewer, not from the original
scan.** A redraw is a transcription and could in principle differ from its source, so it is not
graded `[A]` on its own authority.

It does not need to be. The load-bearing content is the two arrow labels, and both are corroborated
independently of the drawing: `FX`, `FY`, `FID`, `TX`, `TY`, `TID` are exactly the six attributes of
`TransferType` in the vendored XSD, in those spellings. The redraw is consistent with a source I can
check. (The OCR text layer does **not** contain the labels — figure text was not captured — so the
XSD is the only independent corroboration, and it is a good one.)

The redraw itself is kept at `ws/notes/figures/Redraw-Figure-R2-22.png` so this note's evidence
travels with it.

**What the figure shows:**
- a reel labelled **TnR**, with the tape running off it to the right;
- the tape drawn as two registered rows — an upper row of pockets (three plain, one highlighted) and
 a lower row of pocket marks;
- dashed leaders from three marks converging on an enlarged 2D symbol labelled **PI**, i.e. the
 pocket identifier is a machine-readable mark carried *on the tape*, one per pocket;
- an arrow **in** from the upper left, labelled `Transfer(FX,FY,TID)`, landing on the highlighted
 pocket;
- an arrow **out** to the lower right, labelled `Transfer(FID,TX,TY)`.

**What it settles**, and it answers the exact question the previous version of this note left open:
the TnR end of both transfers is addressed by **identifier**, and the non-TnR end by **coordinates**.
Rule 1 of §4 is corroborated rather than contradicted, and §4a above is the substantive gain — the
`TransferMap` record states the LID-to-coordinate correspondence outright, so where one exists there
is nothing for a consumer to infer.

The pairing itself — identifier on the tape side, coordinates on the wafer side — is what the
**example** does, not a rule: `TransferType` permits any combination. `[B]`.

---

## 6a. IMPLEMENTED IN TASK 40 — what shipped, and where it differs from this note

- **Tier 1 is the document's own `<Layout><Dimension>`**, not a new attribute. It was already
 threaded into `buildCoordinatePayload` as `dims`, so "a caller-supplied dimension" needed nothing
 new: the caller is the document. `E142LidOrder` was **not** added.
- **Row-major fill, skipping cells an X/Y entry already claimed.** §13.3 lets one map mix the forms,
 and a LID-only entry landing on a taken cell would make the decoder reject the whole map over an
 ordering detail.
- **Tier 3 (refuse) is a WARNING, not a throw**, and it is deliberately narrow: it fires only when a
 `Coordinate` map has no lattice **and every entry is LID-only**. Any entry with X/Y, or any
 declared dimension, takes the normal path — so nothing that parsed before can regress. The overlay
 yields no payload and is simply not renderable.
- **Per-cell LIDs are exposed** as `DecodedBinPayload.lids` / `GridModel.lids`, a sparse
 `Map<linearIndex, string>` — absent, not empty, when no cell is named. Every cell that carries a
 LID is in it, including those placed by coordinate ("or both").
- **Tier 2 (the TnR default) was NOT implemented.** Nothing needs it yet: a TnR document with a
 `<Layout><Dimension>` already resolves through tier 1, and R2-3.3 fixes what the *axes mean*, not
 which `BinCode` is which pocket — so it would add no resolution power today. It stays specified
 here for the task that has a real TnR document to test against.

## 7. What this implies for the code (for whichever task implements it)

- `E142LidOrder` as an opt-in attribute: absent means "do not resolve LIDs to a lattice".
- Resolution belongs in the **engine**, beside `dimsFromPayload` and `selectMapAndOverlay` — pure,
 document-in / lattice-out, and therefore directly testable. Not in the control.
- The existing `lidOnly` list is the right carrier and should stay: it is what keeps unplaceable
 entries from corrupting a grid, and it is already the input a resolver would consume.
- Corpus obligation under standing rule 10, when the behaviour lands: a LID-only map with an
 explicit order; the same map without one (must error); a TnR single-row and a TnR multi-row; a
 mixed map where one entry carries both forms *agreeing*; the same with them *disagreeing* (must
 warn); a duplicate LID; and a `DeviceIdMap` joined by LID to a `BinCodeMap`. Seven cases, none of
 which the corpus has today.
