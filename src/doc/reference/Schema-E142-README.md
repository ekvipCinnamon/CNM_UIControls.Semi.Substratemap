# Vendored SEMI schemas — `Schema/E142/`

These are the XML Schema documents the SubstrateMap control validates against. They are vendored
here so the package can ship them: the `.nuspec` copies `Schema\E142\*.xsd` to
`runtimes\native1.12-tchmi\Schema\E142\` on the target, which means the schemas are available at
runtime without a network fetch or a SEMI login.

Nothing in this directory is authored by us. Do not edit the `.xsd` files. If a revision needs
correcting, replace it wholesale from the source distribution and say so here.

## What is here

| File | Target namespace | Imports E138 | Role |
|---|---|---|---|
| `E142-1-V0125-Schema.xsd` | `urn:semi-org:xsd.E142-1.V0125.SubstrateMap` | yes | **The revision the serializer emits.** Newest of the four. |
| `E142-1-V0224-Schema.xsd` | `urn:semi-org:xsd.E142-1.V0224.SubstrateMap` | yes | Predecessor of V0125 |
| `E142-1-V0921-Schema.xsd` | `urn:semi-org:xsd.E142-1.V0921.SubstrateMap` | yes | First revision with `DeviceDataMap` |
| `E142-1-V0211-Schema.xsd` | `urn:semi-org:xsd.E142-1.V0211.SubstrateMap` | **no** | Long-lived older revision; most of the test corpus is `v0211-*` |
| `E138-1-V0709-Schema.xsd` | `urn:semi-org:xsd.E138.V0709.ccs` | — | E138 Common Component Schema. Provides `ccs:PVSet`. |

### The E138 file is not optional

V0125, V0224 and V0921 each carry:

```xml
<xs:import namespace="urn:semi-org:xsd.E138.V0709.ccs" schemaLocation="E138-1-V0709-Schema.xsd" />
```

`schemaLocation` is a bare relative filename, so the E138 file **must** sit in this directory
beside them. This is not a soft dependency that only bites documents using `ccs:PVSet` — without
it the schema does not compile at all, and *every* document fails, including ones with no device
data anywhere:

```
warning: failed to load external entity "E138-1-V0709-Schema.xsd"
E142-1-V0125-Schema.xsd:9: Failed to locate a schema at location 'E138-1-V0709-Schema.xsd'. Skipping the import.
E142-1-V0125-Schema.xsd:230: Element 'element', attribute 'ref': The QName value
 '{urn:semi-org:xsd.E138.V0709.ccs}PVSet' does not resolve to a(n) element declaration.
WXS schema E142-1-V0125-Schema.xsd failed to compile
```

Verified by temporarily removing the file. `V0211` is the exception: it has no `DeviceDataMap`, so
no import, so it compiles alone.

## Which revision is which

The type sets are close but not identical, and the differences are the reason a specific revision
was chosen. Established by diffing the four files with the revision token normalised out:

**V0211 → V0921** — adds `DeviceDataMapType`, `DeviceDataType`, `ParameterType`. This is the arrival
of per-device parametric data carried as E138 `ccs:PVSet`, and therefore the arrival of the E138
import. 25 complex types → 28.

**V0921 → V0224** — identical type set. Adds three members to `SubstrateTypeEnum`: `TnR`, `Panel`,
`PCB`.

**V0224 → V0125** — identical type set. This revision introduces the **location identifier**:

- `LID` added to `BinCodeType`, `DeviceIdType` and `DeviceDataType`
- `FID` and `TID` added to `TransferType`
- `TransferType`'s `FX`/`FY`/`TX`/`TY` relaxed from `use="required"` to `use="optional"`, since a
 transfer may now be expressed by identifier instead of by coordinate

That last group is the whole reason V0125 is the emit target: a cell may be addressed by X/Y, by
location identifier, or by both (E142-0225 §13.3), and only V0125 can express it.

### On the revision tokens

`V0125`, `V0224`, `V0921`, `V0211`, `V0709` read as MMYY — January 2025, February 2024, September
2021, February 2011, July 2009. `inferred[B]` — this is inferred from SEMI's own document
numbering in the same corpus (`E142-0225` = February 2025, `E142.4-1022` = October 2022,
`E142.2-1016` = October 2016), not from a statement inside the schemas, which carry no version or
date element. The ordering it implies is corroborated by the structural diffs above, which are
strictly additive in that order. One datapoint does not fit: `E138-1-V0709-Schema.xsd` carries a
file timestamp of 2009-02-06, which is *before* a July 2009 publication. Treat the token as a label,
not as a date you can compute with.

## What the control does with them

**Emits V0125.** `gridToE142Xml()` writes `<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">`
from a single hard-coded constant:

```
Helpers/SubstrateMapEngine/E142Xml.ts:2431 const E142_V0125_NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';
Helpers/SubstrateMapEngine/E142Xml.ts:2503 L.push(`<MapData xmlns="${E142_V0125_NS}">`);
```

There is no option to emit an older revision, and no reason to add one: V0125 is a superset of the
others in every respect the control models.

**Parses any revision.** The parser does not bind to a single namespace. It matches

```
Helpers/SubstrateMapEngine/E142Xml.ts:273 const E142_NAMESPACE_PATTERN = /^urn:semi-org:xsd\.E142-1\.(V\d{4})\.SubstrateMap$/;
```

so it accepts revisions that are not vendored here — the test corpus includes `v0805-*` and
`v1005-*` fixtures whose schemas are not in this directory. Vendoring a schema is about being able
to *validate*; it is not what makes a document readable.

## What the XSD does and does not enforce

Worth stating explicitly, because it sets the limit on what schema validation can prove:

- `ChildLayout/@LayoutId` **is** a keyref onto `LayoutKey`. A child layout reference that names no
 existing layout is caught by validation.
- `SubstrateMap/@LayoutSpecifier` is **not** a keyref. It is a plain `xs:string` participating in
 `SubstrateMapKey`. A `LayoutSpecifier` pointing at a layout that does not exist — or at nothing
 at all — validates cleanly.
- Identity constraints declared on `MapData`: `LayoutKey`, `SubstrateKey`, `SubstrateMapKey`
 (keys), `ChildLayoutRef`, `FromSubstrateMapRef` (keyrefs).
- Every child of `MapDataType` is `minOccurs="0"`. A bare `<MapData/>` is valid.

Consequence: a document can be fully XSD-valid and still violate the standard's prose. The
top-level `Dimension X="1" Y="1"` rule (E142-0225 Table 2) is prose-normative with no XSD
counterpart, so no amount of `xmllint` will catch its absence.

## Example documents and the validation gate

`examples/` holds three hand-written documents. They are not shipped — the `.nuspec` entry globs
`*.xsd` only.

| File | Expected | Purpose |
|---|---|---|
| `minimal-mapdata.xml` | validates | Mirrors the shape `gridToE142Xml()` emits today: one `TopLevel` layout carrying the grid, one `SubstrateMap`, one `Overlay`, one 2DArray `BinCodeMap`. If this passes, the vendored schema accepts the control's own export. |
| `pvset-devicedatamap.xml` | validates | A `DeviceDataMap` with a `ccs:PVSet`. The only document here that actually crosses the `xs:import`, and therefore the one that proves the E138 co-location. |
| `invalid-bintype.xml` | **fails** | `BinType="Nonsense"`. A gate that only ever proves documents valid proves nothing. |

Run all three:

```bash
cd <repo root>
S=Schema/E142/E142-1-V0125-Schema.xsd
xmllint --noout --schema "$S" Schema/E142/examples/minimal-mapdata.xml # expect: validates
xmllint --noout --schema "$S" Schema/E142/examples/pvset-devicedatamap.xml # expect: validates
xmllint --noout --schema "$S" Schema/E142/examples/invalid-bintype.xml # expect: fails to validate
```

The third should report:

```
element BinCodeMap: Schemas validity error : Element '{...}BinCodeMap', attribute 'BinType':
[facet 'enumeration'] The value 'Nonsense' is not an element of the set
{'Ascii', 'Decimal', 'HexaDecimal', 'Integer2'}.
```

## Provenance

Copied verbatim from `REFPACK`, the reference bundle supplied with this remediation work, which
carries the official SEMI schema distributions alongside the E125/E128/E132 WSDLs. No
transformation was applied — byte-identical to the `REFPACK` copies, which is checkable with
`cmp`. `from vendor documentation`: the immediate source is REFPACK, not a direct download from
semi.org, so if byte-level provenance to SEMI matters for a conformance claim, re-fetch from the
SEMI distribution and diff.

These are copyrighted SEMI documents redistributed inside this package. That is a licensing
question for whoever ships it, not a technical one, and it is not resolved here.
