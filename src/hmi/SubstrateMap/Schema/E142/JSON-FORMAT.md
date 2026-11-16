# SEMI E142 — JSON representation

**Status:** stable, and hard to reverse once documents exist in the field. This file is the contract;
`E142MapDataJson.Schema.json` encodes it and `parseE142Json` / `e142DocumentToJson`
(Tasks 7–8) implement it. Where any of the three disagree with this file, this file is right and the
other is a defect.

**What this is not.** It is not a second data model. `E142Xml.d.ts` exports three functions and
everything downstream of them — LID, overlays, transfer maps, device data, the E138 PVSet accessors —
already operates on `E142Document` and is therefore format-independent. This document defines one
more *input and output encoding* for that same model, nothing else.

---

## 1. The envelope

```json
{
  "$format": "semi-e142",
  "$version": 1,
  "$namespace": "urn:semi-org:xsd.E142-1.V0125.SubstrateMap",
  "Layouts": [ … ],
  "Substrates": [ … ],
  "SubstrateMaps": [ … ]
}
```

`$format` is **mandatory**, is exactly the string `semi-e142`, and is **the first member**. A
document whose first member is anything else is not an E142 JSON document. This is what makes a
`GridData` document and an E142 JSON document distinguishable without parsing either of them
further — see §3.

`$version` is **mandatory** and is a JSON **integer**, not a string. It versions *this envelope*,
not SEMI's schema; the SEMI revision travels in `$namespace`. It is `1`, or `2` when the
optional `$binary` payload member is used (see
[`$binary`](#binary--the-same-payload-as-bin-indices-envelope-version-2)).

`$namespace` is **optional** and carries the E142.1 namespace URI verbatim. It exists so
`xml → doc → json → doc → xml` reproduces the original namespace instead of silently promoting every
document to V0125. When absent, a consumer applies the same default the serializer emits
(`urn:semi-org:xsd.E142-1.V0125.SubstrateMap`). The version token inside it is parsed exactly as the
XML path parses it, by the same pattern, so an unlisted version warns and still reads.

`$comment` is **optional, legal at any level, and ignored entirely** — never read into the model,
never written by the serializer, never warned about. JSON has no comment syntax, and every XML
fixture in the corpus carries a `<!-- -->` header naming what it covers and where it came from;
without this the JSON half of that corpus would be the undocumented half. It is the one member here
borrowed from JSON Schema's vocabulary rather than the XSD's.

### Why `$`

`$format`, `$version`, `$namespace` and `$comment` are the only members in this format that are not
an XSD element or attribute name. The `$` prefix marks them as envelope metadata rather than E142 content,
and it cannot collide with a real name: no name in any inspected E142.1 XSD revision begins with `$`.
Every other member in this document comes from the schema.

---

## 2. Naming rule

**Member names are the XSD's element and attribute names, verbatim, including case.** Not the
TypeScript identifiers, not camelCase, not "tidied". `SubstrateId`, `LayoutSpecifier`, `NullBin`,
`FromSubstrateLayoutSpecifier`, `LID`, `FX`. A reader with `E142-1-V0125-Schema.xsd` open must be able
to follow this document by searching for the same string.

Consequences, all deliberate:

- `MapType` values carry the schema's own literals, slash included: `"2DArray"`, `"Row/Column"`,
  `"Array"`, `"Coordinate"`.
- `HexaDecimal` keeps the schema's spelling.
- Abbreviations stay upper-case where the schema has them upper-case: `LID`, `FX`, `FY`, `FID`,
  `TX`, `TY`, `TID`.
- The XML dialect tolerance is **not** reproduced. `Orientation`, `OriginLocation` and
  `AxisDirection` may appear as attributes *or* child elements in XML, and the parser accepts both
  with the attribute winning. JSON has no such distinction, so each is one member and a document
  carrying it twice is impossible by construction. Nothing is lost: the tolerance exists to read
  other producers' XML, and there is no legacy JSON to be tolerant of.

---

## 3. What this format deliberately does NOT reuse from `GridData`

`GridData` is a flat, single-substrate, single-overlay projection with its own contract. It is a
different thing with an unfortunate family resemblance, and blurring the two is the single most
likely way for this feature to cause damage.

**The boundary is case.** Every `GridData` member is camelCase; every E142 JSON member is the XSD's
PascalCase. The two vocabularies therefore cannot silently overlap, and a reader can tell which
contract a member belongs to from the member alone.

| `GridData` (camelCase) | E142 JSON (XSD name) | Same thing? |
|---|---|---|
| `dimension` | `Dimension` | yes — `LogicalCoordinatesType` in both |
| `units` | `DefaultUnits` | yes, **different name**: E142 puts it on `Layout` as `@DefaultUnits` |
| `stepSize` | `StepSize` | yes |
| `deviceSize` | `DeviceSize` | yes |
| **`lowerLeft`** | **`LowerLeft`** | **NO — see below** |
| `orientation` | `Orientation` | yes |
| `originLocation` | `OriginLocation` | yes |
| `axisDirection` | `AxisDirection` | yes |
| `binType` | `BinType` | yes |
| `nullBin` | `NullBin` | yes |
| `mapType` | `MapType` | yes |
| `binDefinitions` | `BinDefinitions` | yes |
| `bins` | `BinCode` | yes, **different name**: E142's payload element is `BinCode` |
| `lids` | `LID` on each `BinCode` | same information, **different shape**: E142 attaches the LID to the entry rather than keeping a parallel map |
| `substrateId` | `SubstrateId` | yes |
| `lotId` | `LotId` | yes |
| `goodDevices` | `GoodDevices` | yes |

### `lowerLeft` is the trap

`GridData.lowerLeft` is **control-defined and explicitly not E142-verbatim**. Its own contract says
so: it is the S-frame position of the grid's lower-left corner, `+y` up, origin at the substrate
center, and it was redefined that way *because* `GridData` has no layout tree.

E142's `Layout/LowerLeft` is a **parent-layout-relative offset** — and that reading is itself
inferred, since no public source states its reference frame in words and every observed example
carries it on child layouts only.

**They are not interchangeable and this format never treats them as such.** An E142 JSON document's
`LowerLeft` means exactly what the XSD's `Layout/LowerLeft` means, no more and no less. A converter
between the two formats must transform the value, not copy it; anything that copies it is a bug and
will render a substrate in the wrong place with no diagnostic at all.

---

## 4. Value conventions

**Absent, empty and present are three different things**, and the format preserves all three, because
E142 does. The XML parser already distinguishes them explicitly for id fields.

| State | JSON |
|---|---|
| absent — the producer says nothing | the member is **omitted** |
| present and empty — the producer says `""` | the member is present with value `""` |
| present with a value | the member carries it |

**`null` is never written and is rejected on read.** JSON offers a fourth state E142 has no meaning
for; admitting it would create a distinction no XML document can express and no round trip can carry.

- `xs:integer` and `xs:nonNegativeInteger` → JSON **number**, integral. The existing contract already
  refuses values outside the safe-integer range, and this format inherits that: `xs:integer` is
  unbounded, this engine's grids are not.
- `xs:double` → JSON **number**. XML's observed `X=""` tolerance — an empty value read as absent — has
  no JSON counterpart: a producer with no value omits the member. `NaN` and `±Infinity` are not JSON
  numbers and are rejected, as they are in the XML path.
- `xs:boolean` → JSON **true** / **false**. The XML path's `"True"` tolerance is not reproduced;
  there is no legacy JSON producer to be tolerant of.
- `xs:string` → JSON **string**, verbatim. Whitespace is preserved on the wire; the same trimming and
  the same `E142_XML_ID_TRIMMED`-shaped warning apply after reading, so the two paths agree.
- Enumerations → the schema's own token, as a string.

**Repeated vs single.** An element the XSD declares with `maxOccurs="unbounded"` is a JSON **array**,
always, even with one entry. An element that occurs at most once is a JSON **object**. So `Overlay`,
`TransferMap` and `DeviceDataMap` are arrays; `BinCodeMap` and `DeviceIdMap` are objects.

---

## 5. The mapping, field by field

Every field of `E142Document` and of every type it reaches. Fields with no JSON counterpart are
listed with the reason, not omitted from this table.

### 5.1 `E142Document`

| Model field | JSON | Note |
|---|---|---|
| `layouts` | `Layouts` — array of Layout | `<Layouts>` is a container in XML; JSON needs no container element |
| `substrates` | `Substrates` — array of Substrate | as above |
| `substrateMaps` | `SubstrateMaps` — array of SubstrateMap | as above; each entry is the header's members plus `Overlay`. **Optional**: `minOccurs="0"` like its two siblings, and SEMI's own `BinCodeMap-Extension-Example` carries `Substrates` and nothing else. |
| `namespaceUri` | `$namespace` | not an XSD name; §1 |
| `schemaVersion` | **deliberately absent** | derived from `$namespace` by the same pattern the XML path uses. Carrying both would create two sources for one fact and let them disagree |

### 5.2 Layout — `LayoutType`

| Model | JSON | Required |
|---|---|---|
| `layoutId` | `LayoutId` | yes |
| `dimension` | `Dimension` | yes |
| `lowerLeft` | `LowerLeft` | no — **§3** |
| `deviceSize` | `DeviceSize` | no |
| `stepSize` | `StepSize` | no |
| `z` | `Z` | no |
| `package` | `Package` | no, XSD default `false` |
| `topLevel` | `TopLevel` | no, XSD default `false` |
| `defaultUnits` | `DefaultUnits` | yes |
| `topImage` | `TopImage` | no |
| `bottomImage` | `BottomImage` | no |
| `productId` | `ProductId` | no |
| `childLayouts` | `ChildLayouts` — array of `LayoutId` **strings** | no |

`ChildLayouts` flattens: XML nests `<ChildLayouts><ChildLayout LayoutId="…"/></ChildLayouts>` and
`ChildLayout` carries exactly one optional attribute, so an array of strings loses nothing. A
`ChildLayout` with no `LayoutId` is legal XML that addresses nothing; in JSON it is simply an entry
that does not exist, and the `E142_XML_CHILDLAYOUT_UNADDRESSED` warning has no JSON counterpart.

`LowerLeft`, `DeviceSize`, `StepSize` and `Position` are `PhysicalCoordinatesType`:
`{ "X": number, "Y": number, "Units"?: string }`. `Dimension` and `Coordinates` are
`LogicalCoordinatesType`: `{ "X": integer, "Y": integer }`. `Z` is
`{ "Order"?: integer, "Height"?: number, "Units"?: string }`.

### 5.3 Substrate — `SubstrateType`

| Model | JSON | Required |
|---|---|---|
| `substrateType` | `SubstrateType` | yes — unknown tokens carried verbatim with a warning, as in XML |
| `substrateId` | `SubstrateId` | yes |
| `lotId` | `LotId` | no |
| `aliasIds` | `AliasIds` — array of `{ "Type": string, "Value": string }` | no; both members required per entry |
| `carrierType` | `CarrierType` | no |
| `carrierId` | `CarrierId` | no |
| `slotNumber` | `SlotNumber` | no |
| `substrateNumber` | `SubstrateNumber` | no |
| `goodDevices` | `GoodDevices` | no — **zero is a value, not an absence** |
| `supplierName` | `SupplierName` | no |
| `status` | `Status` | no |

Member order follows the XSD's `xs:sequence`. JSON does not enforce it and no reader may depend on
it, but the serializer emits it so a hand-diff against the schema lines up.

### 5.4 SubstrateMap — `SubstrateMapType`

The header's seven fields sit directly on the SubstrateMap object, alongside `Overlay`.

| Model | JSON | Required |
|---|---|---|
| `substrateType` | `SubstrateType` | yes |
| `substrateId` | `SubstrateId` | yes |
| `layoutSpecifier` | `LayoutSpecifier` | yes; `""` is the layoutless form and is a **value**, not an absence |
| `substrateSide` | `SubstrateSide` | no, XSD default `TopSide` — **but see below** |
| `orientation` | `Orientation` | no, defaults `0`; facets 0…359 enforced as in XML |
| `originLocation` | `OriginLocation` | no, defaults `LowerLeft` |
| `axisDirection` | `AxisDirection` | no, defaults `UpRight` |
| *(the overlays)* | `Overlay` — array | **no.** `minOccurs="0"` in every revision: a `SubstrateMap` with no overlay is legal, and the corpus has three — the source substrates of a transfer chain are declared so the `FromSubstrateMapRef` keyref resolves, and carry no map of their own. |

**`SubstrateSide` should be written whenever it is known, `TopSide` included.** Its absence is not
silence: the XSD declares `default="TopSide"`, so an omitted member positively asserts the top face.
`SubstrateSide` is a coordinate-system attribute, so that assertion propagates into how every
coordinate in the document is read. The serializer therefore emits it whenever the model has it. This
is the same policy `gridToE142Xml` already applies, and the reasoning is recorded there.

### 5.5 Overlay — `OverlayType`

| Model | JSON | Required |
|---|---|---|
| `mapName` | `MapName` | yes |
| `mapVersion` | `MapVersion` | no — omitted when `""`; absent and `""` are the **same** `OverlayKey` value, so writing `""` asserts nothing and invites a reader to think it does |
| `referenceDevices` | `ReferenceDevices` — array | no |
| `binCodeMapMeta` + `binDefinitions` + the payload | `BinCodeMap` — object | no |
| `deviceIdEntries` | `DeviceIdMap` — object with `Id`: array | no |
| `transferMaps` | `TransferMap` — array | no |
| `deviceDataMaps` | `DeviceDataMap` — array | no |
| `sparseBinCodes` | **deliberately absent** | §5.6 |
| `payload` | **deliberately absent** | §5.6 |

`OverlayType` is an `xs:choice`: one overlay carries one kind of map. JSON does not enforce that and a
document carrying two is a defect, reported the way the XML path reports its equivalents.

### 5.6 BinCodeMap, and why the payload is carried undecoded

**This is the load-bearing decision of the whole format.**

The payload token text is normative and must survive the round trip byte-for-byte. So the JSON
carries **the same `BinCode` token text the XML carries** — not the decoded cells:

```json
"BinCodeMap": {
  "BinType": "Ascii",
  "NullBin": ".",
  "MapType": "2DArray",
  "BinDefinitions": [ { "BinCode": "1", "BinQuality": "Pass" } ],
  "BinCode": [ "..111...", "..119..." ]
}
```

`BinCode`'s JSON shape is decided by `MapType`, exactly as its XML shape is:

| `MapType` | `BinCode` is |
|---|---|
| `2DArray` | `string[]` — one entry per row, the row's token text |
| `Array` | `string` — the whole map in one token stream, row-major |
| `Coordinate` | array of `{ "X"?: int, "Y"?: int, "LID"?: string, "Number"?: int, "$text": string }` |
| `Row/Column` | array of the same object shape; `X`/`Y` are the run's start and the token count is its length |

**`LID`.** It is `xs:string` with **no facet** in the one revision that declares
it (V0125; it is absent from V0211, V0224 and V0921), so it is never normalized — a LID addresses a
location and is a join key. Clause 13.3 addresses a position by the X/Y coordinate, the location
identifier, **or both**; when both are present the coordinate places the entry and the LID names it.
A LID-only entry takes the next **free** cell in document order and is *not* reported; only when the
lattice is full is it unplaceable, and it is then excluded and reported once as
`E142_XML_LID_ONLY_EXCLUDED`. It is retained in `sparseBinCodes` either way.

> An earlier draft of this document and of the schema said a LID-only entry "is placed by document
> order **and reported**". The second half was wrong: the report fires only on the full-lattice
> branch. Both fixtures exist because one branch each is unreachable from the other.

`$text` is the fifth `$` member in this format and the only one below the envelope. `BinCodeType` has
mixed content — four attributes plus the token text — and JSON has no notion of element text, so the
text needs a name. `$text` is used rather than inventing an XSD-looking name for something the XSD
does not name, and the `$` keeps it out of the attribute vocabulary.

Consequences, all intended:

- `E142Overlay.payload` (`DecodedBinPayload`: `cols`, `rows`, `cells`, `codes`, `lids`) is
  **deliberately absent**. It is the *output* of `decodeBinPayload`, not document content. Writing it
  would create a second source of truth for every cell, and a document whose tokens and cells
  disagreed would have no defensible reading.
- `E142Overlay.sparseBinCodes` is **deliberately absent** for the same reason: it is the pre-decode
  view of a `Coordinate` payload and is rebuilt from `BinCode` on read.
- `DecodedBinPayload.lids` is **deliberately absent**: each LID travels on its own `BinCode` entry,
  which is where the document puts it.
- The decode cost is therefore identical in both formats — measured, and it dominates: at 1200×1200
  the shared decode is 65 ms against a 26 ms envelope difference. Whatever this format wins, it wins
  on the envelope, and the envelope is 0.6 % of a large document.

### `$binary` — the same payload as bin indices (envelope version 2)

**Optional, opt-in, and never the default.** A `BinCodeMap` may carry `$binary` *instead of*
`BinCode`:

```json
"BinCodeMap": {
  "BinType": "Integer2", "NullBin": "FFFF", "MapType": "2DArray",
  "$binary": { "Codes": ["FFFF", "0002", "0008"], "Data": "AAABAAIB…", "Cols": 7, "Rows": 5 }
}
```

`Codes` is the code table **in index order**, `Data` is base64 of little-endian `uint16` cell indices
row-major, and `Cols`/`Rows` state the lattice — the index stream alone cannot say where a row ends,
and a `Layout` may be absent or may dangle.

- **It is an encoding of the token text, not an alternative to it.** On read the block is expanded
  back into `BinCode` before anything else looks at the document, so every rule — the lattice check,
  the facets, the identity constraints, the warnings — applies unchanged. It compresses; it cannot
  mean anything the token form cannot.
- **`Codes` order is load-bearing.** Index *i* means `Codes[i]` and nothing else, so a re-sorted or
  de-duplicated table renumbers every cell. `Codes[0]` is the null bin, as it is in a decoded payload.
- **Defined for the dense forms only**: `MapType` `2DArray`, `Array`, or absent. `Coordinate` and
  `Row/Column` address every entry individually — X, Y, LID, Number — and an index stream has nowhere
  to put any of it. A serializer asked for the binary form on one of those **refuses** with
  `E142_JSON_BINARY_UNSUPPORTED` rather than quietly writing tokens, because a caller who asked for
  binary and got text would not find out.
- **`$version` is 2** when `$binary` is present and **1** when it is not — a token-form document
  written as version 2 would be refused by a version-1 reader for a feature it does not contain. A
  document declaring 1 *and* using `$binary` is warned about and read: the content is unambiguous.
- **Carrying both `$binary` and `BinCode` is a defect**, warned about; `$binary` wins, because it is
  the one a producer went out of its way to write.
- **It does not always win on size.** For `Ascii` (one character per cell) and `HexaDecimal` (two),
  base64 of two bytes per cell is *larger*.

`BinDefinitions` flattens its XML container: an array of
`{ "BinCode": string, "BinQuality"?: string, "BinDescription"?: string, "BinCount"?: int, "Pick"?: bool }`.

### 5.7 The remaining overlay kinds

`ReferenceDevices` → array of `{ "Name"?: string, "Coordinates": {X,Y}, "Position"?: {X,Y,Units?} }`.

`DeviceIdMap` → `{ "Id": [ { "X"?: int, "Y"?: int, "LID"?: string, "$text": string } ] }`. `$text`
again, for the same reason: `DeviceIdType` is an id string with three optional attributes.

`TransferMap` → array of
`{ "FromSubstrateType": string, "FromSubstrateId": string, "FromSubstrateLayoutSpecifier": string,
"T": [ { "FX"?, "FY"?, "FID"?, "TX"?, "TY"?, "TID"? } ] }`. The element is `T`, not `Transfer`; the
type is `TransferType` and the standard's figures label the arrows `Transfer(…)`, which is exactly
the trap that makes a reader find an empty map instead of failing.

`DeviceDataMap` → array of `{ "Parameter": [ { "Name": string, "Description"?: string } ],
"DeviceData": [ { "X"?, "Y"?, "LID"?, "PVSet": [ … ] } ] }`.

`PVSet` is E138 content, not E142, and it was the one part of this format flagged as most likely to
need revision. **It did, and it now follows `E138Pv.ts`'s walker exactly.**

Each value is a single-key object named for the `PVType` choice element that carries it. Four shapes,
and they are not interchangeable:

| Shape | JSON | Why |
|---|---|---|
| scalar kind | `{"F8": 1.5}`, `{"S": "text"}`, `{"B64": "…"}` | the lexical value |
| scalar kind, absent | `{"F8": null}` | E138 spells "this value is absent" as `xsi:nil`; a JSON `null` is how that arrives, for **any** kind |
| `Su`, `Arr` | `{"Su": [ …values… ]}` | **an ARRAY, and the fields are POSITIONAL.** `parsePvSet` recurses over the children and returns `PvValue[]` for both — `PvStructure.fields` is a list, not a name map |
| `NoValue` | `{"NoValue": {"reasonCode": "NoSuchSource", "Description": "…"}}` | **an OBJECT.** `@reasonCode` is `use="required"` and `<Description>` is a required child; a bare `null` loses both and warns on every document |

`reasonCode` is one of `ValueNotAvailable`, `NoSuchSource`, `NoSuchParameter`; anything else is
carried through with a warning, so a reader can see what the producer wrote.

Sixteen kinds: `F8 F4 I8 I4 I2 I1 S D B URI B64 EI ES Su Arr NoValue`.

This is the one region where a JSON `null` is meaningful — §4's rule holds for E142 content, and E138
has a nil concept that E142 does not.

Order is normative here and nowhere else: Table 19 states that the order of values **shall** match
the order of parameters. `PVSet` is a JSON array precisely so that order survives, and `Su`'s fields
are an array for exactly the same reason.

---

## 6. Unknown members

An unknown member **never rejects the document**. It produces one aggregated warning naming the
members and their locations, and parsing continues — the same treatment the XML path gives a foreign
namespace or an unrecognized same-namespace element, and the same failure-tolerant choice: accepting an unknown field beats rejecting a
document over it.

> **Read carefully — "carried" means accepted, not preserved.** Unknown members are accepted and
> warned about, but they are **not retained through a round trip**: `E142Document` has no slot for
> them, and adding one would be a model change rather than a format decision. The XML path behaves
> identically — foreign-namespace subtrees are counted, warned about and dropped. If preservation is
> ever wanted, it is a change to the model, and it must land on both paths at once, or the two halves
> of one round trip will disagree.

---

## 7. Member order and byte stability

Member order is **fixed and documented** so that serializing the same document twice produces
identical bytes:

1. `$format`, `$version`, `$namespace`
2. `Layouts`, `Substrates`, `SubstrateMaps` — the `MapDataType` sequence order
3. within every object, the XSD's own declaration order: attributes first in their declared order,
   then child elements in `xs:sequence` order

No reader may depend on order — JSON objects are unordered by specification — with exactly one
exception: `$format` is written first so a consumer can discriminate on the first member without
parsing the rest. Everything else is for diffs and for the byte-stability contract, not for
semantics.
