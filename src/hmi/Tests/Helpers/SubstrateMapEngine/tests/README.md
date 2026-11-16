# SubstrateMapEngine — test suites

Nine suites, all plain ESM scripts. They do not use `node:test`'s `test()` API: each one keeps its
own `PASS`/`FAIL` counters, prints a `RESULT:` line and calls `process.exit(FAIL > 0 ? 1 : 0)`.
Running them under `node --test` therefore reports one subtest per *file*, and the assertion counts
live in the `RESULT:` line rather than in the TAP summary.

All three import the compiled `.js` from `Helpers/SubstrateMapEngine/`, **not** the `.ts`. If you
have edited TypeScript, run `./typecheck.sh --emit` (or rebuild in Visual Studio) before testing, or
you will be testing the previous build.

## Running them

From the repository root:

```bash
# everything
node --test Helpers/SubstrateMapEngine/tests/*.test.mjs

# just the export conformance suite
npm run test:export

# just the selection suite
npm run test:selection

# just the LID suite
npm run test:lid

# just the TransferMap suite
npm run test:transfer

# just the DeviceDataMap / PVSet suite
npm run test:devicedata

# just the multi-overlay composition suite
npm run test:composition

# one at a time
node --test Helpers/SubstrateMapEngine/tests/e142-normative.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-features.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-e2e.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-export.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-selection.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-lid.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-transfer.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-devicedata.test.mjs
node --test Helpers/SubstrateMapEngine/tests/e142-composition.test.mjs

# without the TAP wrapper, if you want the raw RESULT line and nothing else
node Helpers/SubstrateMapEngine/tests/e142-normative.test.mjs
```

<!-- SUITES:BEGIN -->
**23 suites.** Rows are generated from `Helpers/SubstrateMapEngine/tests/`; the *Covers* column is written by
hand and carried across, because a description is a judgement and a generated one would read like
prose and mean nothing. A new suite arrives with `—` until someone writes it.

| Suite | Covers | Needs fixtures | Expected |
|---|---|---|---|
| `dom-shims.test.mjs` | The shim itself: `Path2D`, `DOMMatrix`, the recording 2D context and `isPointInPath`, checked against the captured browser oracle in `fixtures/hit-oracle.json`. If this is wrong, every geometry assertion in the corpus is wrong with it. | no | `71 passed` |
| `e142-bincodec.test.mjs` | Bin token encode/decode across every `binType`: widths, the null bin, out-of-range indices and the five refusal paths. | no | `91 passed` |
| `e142-bins.test.mjs` | The payload decoders and everything they refuse: the closed type vocabularies, token width, the dimension and step guards in the order they fire, and each map type's mis-sized payload. The corpus proves the happy path four ways; these are the paths a valid document never reaches. | no | `105 passed` |
| `e142-composition.test.mjs` | Several overlays on one SubstrateMap: a layer disagreeing on the lattice is rejected with a typed error, selection reports the base and every decoration bin, `E142Overlays` overriding the scalar attributes warns, and the decoration pass draws marks only when there are layers. | no | `101 passed` |
| `e142-devicedata.test.mjs` | `DeviceDataMap` and the embedded E138 `PVSet`: all sixteen value kinds, nesting and the depth guard, `NoValue` vs `xsi:nil` vs the empty string, the Table 19 count mismatch, the selection join by index, and the round trip through `pvSetToXml`. | no | `77 passed` |
| `e142-e2e.test.mjs` | The full DOM-free chain the control runs at runtime, against a vendored fixture corpus, checked against the expectation cards transcribed from `fixtures/EXPECTATIONS.md`. Also carries the round-trip section and the performance gate. | **yes** | `2639 passed` |
| `e142-export.test.mjs` | Conformance of what the serializer **writes**: XSD validity of six exported documents, the Table 2 semantics the XSD cannot see, header / identity / geometry fidelity, and a negative control. Source documents are inline, so it does not depend on the corpus. | no | `202 passed` |
| `e142-features.test.mjs` | Behavioural surface of the engine: parse, grid build, bin decode, export, item helpers. Inputs are inline strings. | no | `53 passed` |
| `e142-item.test.mjs` | The transferred item's bytes and how its text is found: base64 with its six refusal paths, the three input shapes, BOM-then-declaration-then-default encoding detection, and the family reconciliation that decides whether `utf-16` and `utf-16le` are the same claim. | no | `71 passed` |
| `e142-json.test.mjs` | The E142 JSON envelope: member names against the XSD's own, version skew ahead and behind, the `$binary` payload form, and the unknown-member refusal. | no | `104 passed` |
| `e142-lid.test.mjs` | Location identifiers end to end: a LID-only Coordinate map, a map mixing LID and X/Y, a `DeviceIdMap` joined by LID, the TnR ordering of R2-3.3, and the two unresolvable cases. | no | `70 passed` |
| `e142-normative.test.mjs` | Clause-by-clause assertions against E142 / E142.1 normative text and the XSDs. Inputs are inline strings. | no | `782 passed` |
| `e142-representations.test.mjs` | The control's rendered behaviour end to end: origin and axis placement, selection and its payload, grouping, the identity band, aggregation publishing, the fit box, and the drag guard. The largest suite, and the one a control change is most likely to disturb. | no | `1926 passed` |
| `e142-selection.test.mjs` | Which `SubstrateMap` and which `Overlay` get rendered: every branch of version-aware overlay selection and substrate filtering, plus their interaction. Calls the engine's `selectMapAndOverlay()` directly. | no | `62 passed` |
| `e142-transfer.test.mjs` | Substrate-to-substrate traceability: parsing a `TransferMap`, the `FromSubstrateMapRef` keyref satisfied and violated, the transfer index (including `TID`-addressed targets), the selection payload, the round trip, and the dangling-reference omission path. | no | `87 passed` |
| `filterbar-dom.test.mjs` | The FilterBar's DOM loop through `lib/element-stub.mjs`: the four controls it builds, grey-out and tooltip reasons written onto the options, rebuild-not-patch, the radius readout, and one `onPropertyChanged` per attribute that actually moved. | no | `66 passed` |
| `grid-aggregate.test.mjs` | Level-of-detail aggregation: the reducers, the factor chosen per zoom, and that an aggregated cell reports the same bin a reader would compute by hand. | no | `200 passed` |
| `grid-aliasing.test.mjs` | That the raster strategies do not alias: a grid drawn at a scale between two integers keeps every cell visible rather than dropping rows. | no | `15 passed` |
| `grid-monoid.test.mjs` | The aggregation reducers as a monoid — associativity and identity over random cell sets, so any tiling order gives the same answer. | no | `22 passed` |
| `grid-render.test.mjs` | The grid layer's geometry: cell rectangles, the group tiling and its round-tripping ids, `cellsInGroup`, and `packColor`'s refusal of every form it does not understand. | no | `392 passed` |
| `patterns.test.mjs` | The spatial filters over WM-811K wafer patterns: each kernel's effect at each radius, the channel each is legal on, and the street/edge handling. | no | `103 passed` |
| `previnit.test.mjs` | Attribute writes that arrive before `__attach`: every setter is called on a detached control and the scene must match one built after attach. | no | `20 passed` |
| `tools-smoke.test.mjs` | Every tool runs, exits 0 and reports what it wrote — plus the mutation catalogue's anchors, each of which must match its source exactly once. | no | `121 passed` |
<!-- SUITES:END -->

`e142-normative` and `e142-features` share the dependency-free XML stub in `xml-stub.mjs`
(`stubParseDocument`). `e142-e2e` carries its own copy inline so that it has no local imports at all.

## External inputs: not run is not failed

Three files the suites and the checkers read ship in **neither archive**:

| File | What it gates |
|---|---|
| `Desktop.view` | ten sections of `e142-representations` that drive the reference panels, and two of `tools-smoke` including `selfCheck` |
| `SubstrateMap-Working-Protocol.md` | three assertions in `e142-representations`, and one direction of `check-manifest` |
| `STATE.md` | all of `check-state` |

Out of the box that used to be **16 red assertions and two dead checkers**, with
nothing in the output to tell *we did not send you a file* from *your code is
broken*. Sixteen reds that mean the former teach a reader to ignore reds.

**The rule: not run is not failed.** When a declared input is absent the work that
needed it is **SKIPPED**, not failed. The file is named, every section it gated is
named, the count appears as a third column in the `RESULT` line, and the exit code
stays **0**.

```
  RESULT: 1803 passed, 0 failed, 13 skipped
  SKIPPED — an input that ships in neither archive (F-2):
   - Desktop.view  gates 10:
       11. Task 16 — the reference panels are unchanged above the threshold
       22. an item hit, through the control (W-3a)
       ...
```

**`--strict` turns every skip into a failure**, and the repository's own gate runs
strict. Inside this repository the three files *are* present, so an absence here
means something broke rather than something was not shipped:

```bash
npm test            # lenient: absent input -> SKIPPED, exit 0
npm run test:strict # strict:  absent input -> FAILED,  exit 1
npm run check       # lenient
npm run check:strict
npm run gate        # uses the strict variants
```

Suites read `SUBSTRATEMAP_STRICT=1` from the environment rather than `--strict`
from the command line, because `node --test <files>` gives trailing arguments to
node and they never reach the suite. Checkers accept either.

**Where the guard lives.** Not on the sections. `tools/external-inputs.mjs`
exports `requireInput(file)`, which throws `MissingExternalInput` **at the read**;
`section()` and `attempt()` in `lib/harness.mjs` turn that into a skip wherever it
surfaces. Annotating sections by hand would mean the ninth section to drive
`Desktop.view` silently goes red again — a hand-maintained list drifts from the
thing it describes, which is the defect this corpus keeps finding elsewhere.

A skip is loud and counted precisely so it cannot grow quietly. If the skipped
count rises, something stopped being checked.

## `lib/`

Shared helpers, not suites. The `node --test` glob is `*.test.mjs`, so nothing here is picked up as
a test.

| File | Exports | Purpose |
|---|---|---|
| `lib/xsd-validate.mjs` | `validateAgainstE142Xsd(xml, {version})` | Validates a MapData document against a vendored XSD by shelling out to `xmllint`. Returns `{ok, errors}` where `ok` is `true` (valid), `false` (judged and rejected) or `null` (could not be judged — no `xmllint`, unknown revision, or the schema itself failed to compile). Callers should skip on `null` rather than fail, so a machine without libxml2 does not turn a clean run red. |

## The fixture corpus

`e142-e2e.test.mjs` reads from two directories:

## Coverage

`npm run coverage` runs the same 21 suites under Node's own coverage and **fails on a drop**.
There is no dependency: the instrumentation, the exclusions and the thresholds are all node flags.

<!-- COVERAGE:BEGIN -->
| | line | branch | function |
|---|---|---|---|
| **threshold** | **93.73 %** | **83.85 %** | **87.46 %** |
<!-- COVERAGE:END -->

The thresholds are the **measured** baseline, not the one the field review quoted
(89.98 / 81.91 / 81.04). That review predates this spec, and a threshold set to a stale
number would licence a three-point regression. `check-readme` asserts these three figures
against `package.json`, so the table and the gate cannot disagree.

**Branches carry 0.09 of headroom and the other two carry none.** Line and function coverage
measured identically across five runs; branch coverage moved between **82.29** and **82.31** —
one or two branches, in code that reads a clock. A threshold pinned to the best observation
would fail perhaps one run in five, and **a gate that fails at random is a gate someone turns
off**, which is a worse outcome than 0.09 of slack. The margin is below the observed minimum,
not above it.

`Helpers/SubstrateMapEngine/tests/**` and `tools/**` are excluded: a test that covers itself
measures nothing. Coverage is over the **emitted** `.js`, which is what the suites import.

<!-- FIXTURES:BEGIN -->
```
tests/fixtures/xml/               58 .xml (+ official-E142-1-V0211-Schema-Extension-Example.xsd,
                                  shipped with the corpus, not read by any card)
tests/fixtures/json/              77 .json
tests/fixtures/EXPECTATIONS.md    the expectation cards the suite's XML_CARDS / JSON_CARDS
                                  arrays were transcribed from — reference only, never read
                                  at run time
```

**Full corpus: 135 fixtures (58 XML + 77 JSON).** Counted from disk.
<!-- FIXTURES:END -->

It originates as a standalone `fixtures/{xml,json}` tree. To re-install or replace it:

```bash
cp -r <corpus>/fixtures/xml  Helpers/SubstrateMapEngine/tests/fixtures/xml
cp -r <corpus>/fixtures/json Helpers/SubstrateMapEngine/tests/fixtures/json
```

Filenames must match exactly — a corpus using a different naming convention (for example one naming
the GridData fixtures `gd01_…`–`gd10_…` rather than `json-…`) will install cleanly and then miss
every card. The suite reports each miss by name, so compare that list against the inventory below
before assuming the corpus is wrong.

None of this ships. The `.nuspec` file globs are extension-scoped (`**/*.Schema.json`,
`**/Description.json`, `**/*.js`, `**/*.ts`, …) and match neither the fixture `.xml`/`.json` names
nor `EXPECTATIONS.md`.

### Behaviour when it is absent

The suite prints a banner naming each missing directory and how many fixtures it expects, then
**exits 0**. A missing corpus means "not run", and "not run" is not "failed", so it does not paint
the run red:

```
========================================================
  E2E SKIPPED - fixture corpus is not installed
========================================================
  missing directory : .../tests/fixtures/xml
  XML fixtures expected there : 43
  missing directory : .../tests/fixtures/json
  JSON fixtures expected there : 20
  full corpus       : 63 fixtures (43 XML + 20 JSON)
```

The guard covers the partial case too: if only one directory is missing, only that one is named.
It has to run before any section, because the `PERFORMANCE` block reads its two 600×600 inputs with
a bare `readFileSync` and no existence check — without the guard, an absent corpus throws `ENOENT`
and kills the file before the summary line is printed.

The counts in the banner are computed from the card arrays at run time, never hard-coded, so adding
or removing a card cannot leave the banner lying.

## Fixture inventory

Read out of the card arrays in `e142-e2e.test.mjs`. 35 files, no duplicates. The two 600×600
performance inputs are members of the ordinary card arrays; the `PERFORMANCE` section re-reads them
rather than adding fixtures of its own.

### `tests/fixtures/xml/` — 43

**`XML_CARDS` (39)** — parsed, gridded and checked against a full expectation card: dimensions,
orientation, origin, axis direction, default overlay, probe tokens, non-null count, bin histogram.

| File |
|---|
| `official-BinCodeMap-Example.xml` |
| `v1005-wafer-2darray-ascii.xml` |
| `v1005-strip-integer2-lowerleft.xml` |
| `v0921-array-integer2-csdn.xml` |
| `v0805-legacy-namespace.xml` |
| `v0211-rowcolumn-prose-derived.xml` |
| `v0211-coordinate-mixed.xml` |
| `v0125-coordinate-lid-mixed.xml` |
| `v0211-hexadecimal-nullbin-round.xml` |
| `v0211-decimal-bintype.xml` |
| `v0211-orientation-90.xml` |
| `v0211-orientation-45-nonquadrant.xml` |
| `v0211-origin-center-even.xml` |
| `v0211-origin-downleft.xml` |
| `v0211-multi-overlay.xml` |
| `v0211-multi-layout-childpath.xml` |
| `v0211-substrateid-whitespace.xml` |
| `v0211-layoutless-defaults-alt.xml` |
| `v0211-defaultunits-microns.xml` |
| `v0211-defaultunits-100microns.xml` |
| `v0211-perf-600x600-ascii.xml` |
| `v0125-bottomside-ascii.xml` |
| `v0125-orientation-270.xml` |
| `v0125-origin-upperleft-downright.xml` |
| `v0125-origin-lowerright-upleft.xml` |
| `v0125-bottomside-orientation-180.xml` |
| `v0125-substrate-full-record.xml` |
| `v0125-substrate-edge-values.xml` |
| `v0125-substrate-multiple-records.xml` |
| `v0125-all-header-facts.xml` |
| `v0125-substrate-aliasids.xml` |
| `v0125-substrate-carrier.xml` |
| `v0125-substrate-numbers.xml` |
| `v0125-layout-images.xml` |
| `v0125-overlay-two-versions.xml` |
| `v0125-three-substrates.xml` |
| `v0125-lid-retained.xml` |
| `v0125-transfer-chain.xml` |
| `v0125-devicedata.xml` |

**`TOLERATED_XML` (1)** — XSD-invalid by the corpus's own classification, but processed anyway: the
hand parser is deliberately not an XSD validator, so it builds with a warning instead of rejecting.
Asserted as tolerated-with-warning.

| File | Expected warning |
|---|---|
| `v0211-invalid-unknown-substratetype.xml` | `E142_XML_SUBSTRATE_TYPE_UNKNOWN` |

**`STRUCTURAL_XML` (1)** — parse must succeed, but there is no `BinCodeMap`, so no renderable
overlay is produced.

| File | Why |
|---|---|
| `official-BinCodeMap-Extension-Example.xml` | `Substrate` `xsi:type` extension demo; no `SubstrateMaps` grid data |

**`INVALID_XML` (2)** — must throw, with the documented error code.

| File | Code | Class |
|---|---|---|
| `v0211-invalid-duplicate-layoutid.xml` | `E142_XML_INTEGRITY` | XSD identity constraint (duplicate `LayoutId` key) |
| `v0211-invalid-truncated.xml` | `E142_XML_MALFORMED` | XML well-formedness (premature EOF) |

### `tests/fixtures/json/` — 20

**`JSON_CARDS` (18)** — `SubstrateMapGridData` inputs run through normalize → `buildGridModel` and
checked against the same card shape as the XML side.

| File |
|---|
| `json-bins-string-array.json` |
| `json-bins-string-single.json` |
| `json-bins-number-integer2.json` |
| `json-coordinate-sparse.json` |
| `json-defaults-omitted.json` |
| `json-units-um.json` |
| `json-lowerleft-anchored.json` |
| `json-perf-600x600-ascii.json` |
| `json-origin-upperleft-downright.json` |
| `json-origin-lowerright-upleft.json` |
| `json-origin-upperright-downleft.json` |
| `json-origin-center-odd.json` |
| `json-orientation-180.json` |
| `json-orientation-45-nonquadrant.json` |
| `json-orientation-90-mapframe.json` |
| `json-substrate-identity.json` |
| `json-substrate-identity-edge.json` |
| `json-lids.json` |

**`INVALID_JSON` (2)** — must throw, with the documented error code.

| File | Code | Class |
|---|---|---|
| `json-invalid-dimension-mismatch.json` | `E142_GRID_DECODE` | dimension / bins-length mismatch |
| `json-invalid-bintype-enum.json` | `E142_GRID_ENUM_INVALID` | out-of-enum `binType` |

### Re-deriving this list

The inventory above is transcribed from the source, not maintained by hand. To regenerate it after
the card arrays change, extract the `file:` values from `XML_CARDS`, `TOLERATED_XML`,
`STRUCTURAL_XML`, `INVALID_XML` (→ `fixtures/xml/`) and `JSON_CARDS`, `INVALID_JSON`
(→ `fixtures/json/`). A quicker check: install an empty `fixtures/xml` and `fixtures/json`, run the
suite, and every expected filename is printed on its own `fixture missing from corpus` line.

## The coverage extension

Twelve fixtures were added to close gaps the original corpus left open — five XML (`v0125-*`, other
than `v0125-coordinate-lid-mixed.xml`) and seven JSON. Before them the corpus contained no `SubstrateSide="BottomSide"` at all,
no `Orientation="270"`, and never used `OriginLocation` `UpperLeft` / `LowerRight` or
`AxisDirection` `DownRight` / `UpLeft`. All five enum spaces are now fully covered on both sides.

The JSON side was the narrower of the two. Before the extension the entire GridData corpus used
`orientation: 0`, `originLocation: "LowerLeft"` and `axisDirection: "UpRight"` and nothing else —
four of five origins, three of four axis directions and every non-zero orientation were untested.
`substrateSide` is not a GridData field at all, so it has no JSON counterpart by design.

Their expectation cards were derived **by hand** from the fixture bytes and the frame rule, then
confirmed against the engine — not read out of it. A card generated from the code under test can
only detect change, never incorrectness. The rule used is:

> serialization row 0 is the **top** row and column 0 the **leftmost**; `OriginLocation` names the
> corner holding logical (0,0); `AxisDirection` reads `<vertical-for-y><horizontal-for-x>`, so
> `DownLeft` means +y down and +x left. Orientation is a physical rotation and does **not** change
> this mapping.

That rule was itself validated by re-deriving all 43 probes of the pre-existing cards and matching
every one, before a single new card was written.

## Selection

`selectMapAndOverlay()` lives in `E142.ts`, not in the control, and that placement is what makes
`e142-selection.test.mjs` worth having. Selection depends on nothing but the document and four
strings, while the control cannot be instantiated without a DOM — so a suite written against the
control would have had to **transcribe the algorithm into the test**, which tests the transcription
and drifts from the code the moment either side changes. The suite calls the same function the
control calls.

Two keys, two behaviours, both normative:

| | key | ambiguity possible? |
|---|---|---|
| `SubstrateMap` | `xs:key` (`@SubstrateType`, `@SubstrateId`, `@LayoutSpecifier`) | only when a filter is left unset — both set can never be ambiguous in a schema-valid document |
| `Overlay` | (`@MapName`, `@MapVersion`) | yes — one name at several versions is the R2-1.2.1 lifecycle |

Ambiguity **warns** and renders the first in document order; a document carrying several maps is
perfectly legal. A filter matching nothing is an **error**, and the message lists what is available —
an operator who mistyped a wafer id needs the list, not the word "not found".

## Export conformance

`e142-export.test.mjs` is the mirror image of everything else here. The other three suites *read* —
they feed a document in and check what comes out of the parser — which is why every export defect
found during Phase 2 was invisible while they reported a clean pass.

It asserts six families on documents this package **produces**:

| # | Family | Why it is separate |
|---|---|---|
| 1 | XSD validity of six exported documents | Ascii/2DArray, Integer2/Coordinate, HexaDecimal, Decimal, ±bin definitions, ±identity, non-default frame + quadrant rotation |
| 2 | **Table 2 semantics** | Every `TopLevel="true"` layout has `Dimension X="1" Y="1"`, and the layout named by the last `LayoutSpecifier` segment carries the real cols/rows. There is no facet, keyref or identity constraint behind that rule, so the XSD passes a violation happily |
| 3 | Header fidelity | `SubstrateSide`, `MapVersion`, orientation and frame |
| 4 | Identity fidelity | **All nine `SubstrateType` children** — `LotId`, `AliasIds`, `CarrierType`, `CarrierId`, `SlotNumber`, `SubstrateNumber`, `GoodDevices`, `SupplierName`, `Status` — in XSD sequence order, plus that no identity in means no `Substrate` record out |
| 5 | Geometry fidelity | `DeviceSize` survives and a 1 mm street is not closed |
| 5b | **Layout round trip** | A two-level source with every optional child and `@Package` survives a full cycle, the two levels do not bleed into each other, and the eight device-layout children are in **XSD sequence order** |
| 6 | **Negative control** | A document with `BinType="Nonsense"` must be REJECTED, the rejection must name `BinType`, and the same document with `BinType="Ascii"` must be ACCEPTED |

**Element order is asserted by regex over the emitted string, never by re-parsing.** Measured, not
assumed: this parser looks children up by name (`firstNamed`), so it reads an out-of-sequence layout
and produces an identical model with zero warnings. `xmllint` does reject such a document — but the
XSD family skips when libxml2 is absent, so it cannot be the only guard.

| | in XSD sequence | children shuffled |
|---|---|---|
| `xmllint` | accepted | **rejected** |
| this parser | accepted | accepted — no warning |
| the regex | matches | **fails** |

The order pattern is paired with its own negative control: the same regex is run against a
deliberately shuffled copy of the emitted layout and must fail, so a vacuous pattern cannot pass
quietly.

(6) is load-bearing. Every other assertion is of the form "the validator accepted it", and a
validator that has silently stopped validating accepts everything. Without a document that must
fail, a green run proves the suite ran — not that the exporter is right.

When `xmllint` is unavailable the XSD family and the negative control **skip** rather than fail, and
the suite still exits 0: a missing toolchain is not a defect in the exporter.

## Round trip

`e142-e2e.test.mjs` ends its assertion sections with a round-trip pass: every valid XML fixture is
parsed, exported through `gridToE142Xml` **and** `gridToGridData` with the full option surface taken
from the parsed document, then read back and compared.

This exists because everything else in the suite is an *import* test. A defect in the serializers is
invisible to a corpus that never re-exports, however rich the inputs are — the missing two-level
layout tree, the dropped `DeviceSize`, the `SubstrateSide` that silently flipped a `BottomSide` map
to `TopSide`, and the missing `MapVersion` were all present while this suite reported a clean pass.

The assertions are properties, not transcribed numbers — the cells come back, the header still says
what it said, the drawn extent survives — so they need no expectation card and cannot drift.

Two defects are **pinned as known-broken** rather than skipped, each asserting the exact wrong
behaviour so that fixing it fails the assertion and says so:

| Constant | Fixtures | Symptom |
|---|---|---|
| `GRIDDATA_ROUNDTRIP_KNOWN_BROKEN` | `v0211-orientation-90.xml`, `v0125-orientation-270.xml` | `gridToGridData` writes `bins` in the serialization frame; `normalizeGridData` validates the row count against the oriented map frame. Throws `E142_GRID_DECODE`. |
| `XML_PITCH_TRANSPOSED_KNOWN_BROKEN` | `v0125-orientation-270.xml` | `gridToE142Xml` writes `Dimension` in the layout frame but `StepSize`/`DeviceSize` in the map frame, so a 90/270 map re-imports with X and Y pitch exchanged. Cells and header survive. |

Both are the same root cause — frame handling under a quadrant rotation — and both were invisible
until a rotated fixture with a **non-square** pitch existed. `v0211-orientation-90.xml` uses
1.0 × 1.0, where a transposition changes nothing.

## Performance gate

`e142-e2e.test.mjs` ends with a `PERFORMANCE` section:

- 600×600 XML end-to-end (parse → `buildGridModel`), median of 5
- 600×600 JSON end-to-end (normalize → `buildGridModel`), median of 5
- a generated 1000×750 (750 000 cell) Ascii `GridData` through normalize + `buildGridModel`,
  gated at `DECODER_GATE_MS = 300`

Only the last one is a hard gate; the two 600×600 figures are reported, and the assertion is merely
that a finite timing was produced. Timings are machine-dependent — treat a regression as a signal to
investigate, not as a threshold to tune.

---

## Parse / decode baseline

`node tools/bench-parse.mjs` — where the time actually goes, measured before any of the JSON feature
was built so there is something to compare against later. Median of 20 runs after 5 warm-ups,
milliseconds; sizes 200×200 / 600×600 / 1200×1200 in all four `BinType`s, dense `2DArray`, plus the
delivered 600×600 fixtures as an anchor row.

| size | BinType | XML env | JSON env | decode | XML total | JSON total | XML kB | JSON kB | env % XML | env % JSON |
|---|---|---|---|---|---|---|---|---|---|---|
| 200 | Ascii | 0.42 | 0.04 | 0.44 | 1.01 | 0.49 | 45 | 40 | 13.9 % | 2.2 % |
| 200 | Decimal | 1.07 | 0.12 | 1.85 | 3.10 | 1.65 | 162 | 157 | 3.9 % | 0.6 % |
| 200 | HexaDecimal | 0.63 | 0.04 | 0.71 | 1.30 | 0.58 | 84 | 79 | 7.5 % | 1.1 % |
| 200 | Integer2 | 1.02 | 0.07 | 1.56 | 2.62 | 1.11 | 163 | 157 | 3.9 % | 0.6 % |
| 600 | Ascii | 2.53 | 0.16 | 3.98 | 6.70 | 3.63 | 370 | 354 | 4.9 % | 0.6 % |
| 600 | Decimal | 7.84 | 1.08 | 16.05 | 24.23 | 14.20 | 1424 | 1408 | 1.3 % | 0.1 % |
| 600 | HexaDecimal | 4.27 | 0.32 | 5.98 | 10.69 | 5.18 | 721 | 705 | 2.5 % | 0.3 % |
| 600 | Integer2 | 7.90 | 0.76 | 9.46 | 18.19 | 8.89 | 1424 | 1408 | 1.3 % | 0.1 % |
| 1200 | Ascii | 8.44 | 0.63 | 15.30 | 24.42 | 14.71 | 1442 | 1410 | 2.5 % | 0.3 % |
| 1200 | Decimal | 30.05 | 4.33 | 65.18 | 93.52 | 55.71 | 5659 | 5628 | 0.6 % | 0.1 % |
| 1200 | HexaDecimal | 15.80 | 1.41 | 22.74 | 37.78 | 20.24 | 2848 | 2816 | 1.3 % | 0.1 % |
| 1200 | Integer2 | 33.94 | 4.62 | 37.37 | 68.74 | 34.29 | 5661 | 5629 | 0.6 % | 0.1 % |
| *anchor* | *delivered 600×600 Ascii fixtures* | 2.80 | 0.16 | — | 9.21 | 5.55 | 371 | 355 | | |

**What it says.** Decode dominates at every size and in every `BinType`: at 1200×1200 `Decimal` the
whole envelope difference between the two formats is 25.7 ms against a shared 65.2 ms of decoding.
And the envelope's *share* shrinks as maps grow — 13.9 % of an XML document at 200×200, 0.6 % at
1200×1200 — so the format change wins least exactly where a map is big enough for anyone to care.

`XML total ≈ XML env + decode` holds on every row, which is the table's own consistency check.

Five caveats, printed by the tool itself so they cannot be separated from the numbers:

1. **`XML env` is a pessimistic proxy.** It uses `tests/xml-stub.mjs`, a hand-written JS parser; the
   browser uses a native `DOMParser`. The real XML envelope cost is lower — overstating it would
   flatter this whole feature.
2. **`JSON env` is `JSON.parse`, a native C++ builtin.** So the envelope comparison is hand-written
   JS against C++, which flatters JSON twice over. A JSON win here means little; a JSON *loss* would
   mean a lot.
3. **The JSON columns are `GridData` v1**, not the E142 JSON envelope Task 5 has yet to specify.
   Real, delivered, and the pattern this feature extends — but a proxy. Task 17 re-measures against
   `parseE142Json`.
4. **`decode` is shared.** Both representations carry the same E142 token text (ground truth 1), so
   `decodeBinPayload` sees identical input either way and is measured once per case.
5. **`decode` is an upper bound.** It re-decodes one array in a tight loop, ~25 % dearer than
   decoding freshly parsed input (1200×1200 Decimal: 51 ms reused vs 40 ms fresh) — allocation
   locality, not a decoder property. Run-to-run spread at 1200×1200 is roughly ±20 %.

Timings are machine-dependent, as everywhere else in this file: treat a change as a signal to
investigate, not as a threshold to tune. The tool validates every generated document by decoding it
before timing anything, so a generator fault cannot become a fast, meaningless number.
