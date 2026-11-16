# EXPECTATIONS.md — Task 6.1 F2' Fixture Corpus

Each card below was derived by **independently re-reading the fixture file
from disk**, using two standalone oracle scripts (`oracle_xml.py`,
`oracle_json.py`, workspace-root `task-6.1/`) that share no code or
in-memory state with the scripts that authored the fixtures
(`gen_perf_xml.py`, `gen_perf_json.py`, or the manual `write` calls used for
all other fixtures). A sample of small fixtures was additionally
cross-checked by hand (raw `grep`/`cat` of the file text) against the
oracle output — see REPORT.md "Verification performed" for the list of
fixtures hand-checked and the outcome. Full raw oracle output is preserved
at `/home/user/workspace/task-6.1/oracle_xml_output.txt` and
`/home/user/workspace/task-6.1/oracle_json_output.txt`.

**Logical-coordinate convention used throughout** (E142-0225 Table A4-1 / A4-1,
independently re-implemented a second time inside each oracle script):
zero-cell (visual `from_left`,`from_bottom`, 0-based) depends on
`OriginLocation`: LowerLeft→(0,0); UpperLeft→(0,R−1); LowerRight→(C−1,0);
UpperRight→(C−1,R−1); **Center→((C−1)//2,(R−1)//2)** (integer truncating
division — physically fixed regardless of `AxisDirection`; for even
dimensions this is the *lower-left* cell of the central 2×2 block —
marked **FORMULA-DERIVED** below wherever it appears, since no source
states the even-dimension case in prose). Axis signs: `sy=+1` if
`AxisDirection` starts with "Up", else −1; `sx=+1` if it ends with
"Right", else −1. Logical `X = sx·(from_left − zero.from_left)`,
`Y = sy·(from_bottom − zero.from_bottom)`.

**Serialization-order convention** (inferred from the Array clause): the
first `<BinCode>` row (2DArray) / first row of a JSON `string[]` = the
**visual TOP** row of the map; tokens run left→right; this ordering is
independent of `OriginLocation`/`AxisDirection` (those only *label* the
grid with logical coordinates, they do not change which physical row is
serialized first).

---

## PART 1 — XML fixtures

### 1. `official-BinCodeMap-Example.xml` (OFFICIAL, byte-identical)
- Dims: **12 cols × 11 rows** (dims-from-data; no `<Layouts>` element in
 this file at all — **no physical scale in document**).
- Step/device size: not present (layoutless).
- Orientation=0 (default), OriginLocation=LowerLeft (default),
 AxisDirection=UpRight (default).
- Cell (0,0) [visual bottom-left, serRow=10]: `.`
- Cell (1,0): `.`
- Cell (0,1) [serRow=9]: `.`
- Last cell (11,10) [visual top-right, serRow=0]: `.`
- Non-null cell count: **108** / 132 total.
- Histogram: `.`=24 (NullBin), `1`=97, `2`=5, `8`=3, `9`=3.
- Single overlay ("SortGrade") — no default-overlay ambiguity.
- Probe cells (LOGICAL coords, LowerLeft/UpRight so logical=visual-from
 corner): (0,0)→`.`, (1,0)→`.`, (0,1)→`.`, last (11,10)→`.`.

### 2. `official-BinCodeMap-Extension-Example.xml` (OFFICIAL, byte-identical)
- No `SubstrateMaps`/grid data of any kind — this file only demonstrates
 the `Substrate`-level `xsi:type` extension mechanism
 (`sme:SupplierData`, 8 `Value`-attribute children). **No data card
 applicable** (no bins to report); its "expectation" is structural:
 `Substrate/@xsi:type="sme:SubstrateTypeExtension"` resolves against the
 companion `official-E142-1-V0211-Schema-Extension-Example.xsd`, and the
 8 child elements of `sme:SupplierData` are present with the exact
 `Value` attributes listed in the source file.

### 3. `official-E142-1-V0211-Schema-Extension-Example.xsd` (OFFICIAL, byte-identical)
- Not a data fixture — the extension XSD required by fixture #2. No card.

### 4. `v1005-wafer-2darray-ascii.xml`
- Dims: **10 cols × 8 rows**.
- Step size: 0.630000 × 0.640000 mm; DeviceSize (top layout) 200.0×200.0 mm.
- Orientation=180, OriginLocation=**UpperRight**, AxisDirection=**DownLeft**.
- Zero-cell = UpperRight visual corner = (from_left=9, from_bottom=7).
- Cell (0,0) logical → visual (from_left=9,from_bottom=7) = serRow 7, col 9 = `.`
- Cell (1,0) logical → visual (from_left=8,from_bottom=7) = serRow 7, col 8 = `.`
- Cell (0,1) logical → visual (from_left=9,from_bottom=6) = serRow 6, col 9 = `.`
- Last cell logical (9,7) → visual (from_left=0,from_bottom=0) = serRow 0, col 0 = `.`
- Non-null cell count: **68** / 80 total.
- Histogram: `.`=12 (NullBin), `E`=20, `P`=43, `X`=4, `F`=1.
- Single overlay ("SortGrade").

### 5. `v1005-strip-integer2-lowerleft.xml`
- Dims: **7 cols × 5 rows**.
- Step size: 50×15 mm (ChipLayout); DeviceSize (StripLayout) 170×200 mm;
 `LowerLeft` = (4.5, 42) mm set on the ChipLayout (the required
 "Layout with LowerLeft set" coverage bullet).
- Orientation=180; OriginLocation/AxisDirection unset → defaults
 (LowerLeft/UpRight).
- Cell (0,0) [visual bottom-left, serRow=4]: `FFFF`
- Cell (1,0) [serRow=4]: `FFFF`
- Cell (0,1) [serRow=3]: `0002`
- Last cell (6,4) [serRow=0]: `FFFF`
- Non-null cell count: **21** / 35 total.
- Histogram: `FFFF`=14 (NullBin), `0002`=19, `0008`=1, `0001`=1.
- Note: histogram has 21 non-null but no `0009` token actually appears in
 data despite `BinDefinition BinCode="0009"` being declared — this is
 legal (a declared bin code with zero occurrences); do not infer a data
 error.

### 6. `v0921-array-integer2-csdn.xml`
- Two SubstrateMap entries share `SubstrateId="33D075"`; only the first
 (`LayoutSpecifier="StripLayout/Device"`) carries grid data; the second
 (`.../Die1`) has an empty `UploadTransferMap` overlay (no BinCodeMap) —
 documented as a legal "declared overlay with no map yet" case, not an
 error.
- Dims (Device layout): **5 cols × 4 rows**; MapType=Array (single-block,
 row-major, starting top-left).
- Overlay "DownloadCodeMap" (MapType=Array explicit):
 - Cell (0,0) logical: since Array serializes row-major top-left and this
 payload is a SINGLE row of 20 tokens with no row breaks, the "grid" is
 effectively linearized 5×4 in row-major order starting top-left.
 Token index 0 (top-left) = `0001`; by the same LowerLeft/UpRight
 default logical mapping used elsewhere, cell (0,0) [visual bottom-left]
 = row index 3 (0-based from top), col 0 = token index 15 = `0001`.
 - Cell (1,0) = token index 16 = `0002`.
 - Cell (0,1) = row index 2, col 0 = token index 10 = `0001`.
 - Last cell (4,3) [visual top-right] = token index 4 = `0002`.
 - Non-null: **20**/20 (NullBin `0000` never appears).
 - Histogram: `0001`=10, `0002`=10.
- Overlay "UploadCodeMap" (MapType unset → defaults to 2DArray per prose,
 but payload is still a single un-broken 20-token line — documents the
 MapType-default prose/XSD divergence noted in REPORT.md):
 - All 20 tokens = `0F0A`. Non-null: 20/20. Histogram: `0F0A`=20.
- Default overlay (multi-overlay convention, see fixture #16 below):
 first Overlay in document order = **"DownloadCodeMap"**.

### 7. `v0805-legacy-namespace.xml`
- Dims: **4 cols × 3 rows**. All defaults (Orientation=0,
 OriginLocation=LowerLeft, AxisDirection=UpRight, MapType=2DArray).
- Cell (0,0) [serRow=2]: `.`
- Cell (1,0) [serRow=2]: `1`
- Cell (0,1) [serRow=1]: `1`
- Last cell (3,2) [serRow=0]: `.`
- Non-null cell count: **8** / 12 total.
- Histogram: `.`=4 (NullBin), `1`=7, `9`=1.

### 8. `v0211-rowcolumn-prose-derived.xml` — **PROSE-DERIVED**
- Dims: **6 cols × 4 rows** (declared via Layout/Dimension).
- MapType=Row/Column, four `<BinCode>` run elements across Y=0..3 (row
 Y=2 has only ONE run covering cols 1-4, demonstrating NullBin-fill-by-
 omission at cols 0 and 5 of that row).
- Row Y=0 (X=0, 6 tokens): `111191` → cols 0-5 = 1,1,1,1,9,1
- Row Y=1 (X=0, 3 tokens `111` + X=3, 3 tokens `911`): cols 0-5 =
 1,1,1,9,1,1
- Row Y=2 (X=1, 4 tokens `1111`): col 0 = NullBin(`.`), cols 1-4 = 1,1,1,1,
 col 5 = NullBin(`.`)
- Row Y=3 (X=0, 6 tokens `191119`): cols 0-5 = 1,9,1,1,1,9
- Cell (0,0) [row Y=0, col 0]: `1`
- Cell (1,0) [row Y=0, col 1]: `1`
- Cell (0,1) [row Y=1, col 0]: `1`
- Last cell (5,3) [row Y=3, col 5]: `9`
- Non-null count: **22** / 24 total (2 NullBin cells, both in row Y=2).
- Histogram: `1`=18, `9`=4, `.`=2 (2 of the 24 total cells are NullBin by
 omission; oracle script's raw per-BinCode-element histogram reported
 22 non-null summed directly from the 5 XML text runs — consistent).
- **STATUS: PROSE-DERIVED.** Re-verification caveat: see REPORT.md open
 questions — no complete official Row/Column XML example exists in the
 reference material; this card assumes the run-length-from-(X,Y) model
 documented in the fixture's own header comment (see the note thereD.md
 seam A5, grade C+). If the deferred PDF verification pass finds a
 different Row/Column serialization rule, this card must be redone.

### 9. `v0211-coordinate-mixed.xml`
- Dims: **4 cols × 3 rows** (12 cells total).
- MapType=Coordinate, 7 of 12 cells populated (sparse); 5 absent → NullBin.
- Cell (0,0): `1` (explicit `X="0" Y="0"` entry)
- Cell (1,0): `1` (explicit `X="1" Y="0"` entry)
- Cell (0,1): `1` (explicit `X="0" Y="1"` entry)
- Last cell (3,2): `.` (NullBin by omission — no `X="3" Y="2"` entry exists)
- Non-null count: **7** / 12 total.
- Histogram: `1`=6, `9`=1, `.`=5 (by omission).
- `Number` attributes (1-7) present on each entry but are documented as
 informational-only (not used for placement).

### 10. `v0125-coordinate-lid-mixed.xml` — **HARD ACCEPTANCE CRITERION**
- Namespace: V0125. Dims: **4 cols × 3 rows** (12 cells total).
- MapType=Coordinate. 5 X/Y-addressed entries (one, at X=3,Y=1, also
 carries `LID="DIE-0301"` — placement follows X/Y per this fixture's
 design assumption), 3 LID-only entries (`DIE-SPARE-A/B/C`, no X/Y —
 **excluded from the grid**, carried only in the logical
 model/warning; the LID-to-coordinate rule is inferred), remaining 7 grid cells
 are NullBin by omission.
- Cell (0,0): `1` (X=0,Y=0 entry)
- Cell (1,0): `1` (X=1,Y=0 entry)
- Cell (0,1): `1` (X=0,Y=1 entry)
- Last cell (3,2): `.` (NullBin — no X=3,Y=2 entry; note the X=3,Y=1
 entry is NOT the last cell, it is one row below it)
- Non-null count on the **grid** (LID-only entries excluded from this
 count by design): **5** / 12 total.
- Histogram (grid only): `1`=4, `9`=1, `.`=7.
- LID-only entries (NOT counted in the grid histogram above, listed
 separately): `DIE-SPARE-A`→`9`, `DIE-SPARE-B`→`1`, `DIE-SPARE-C`→`1`.
- This is the fixture required verbatim by spec §6.1 Abnahme: "a V0125
 LID Coordinate fixture exists (mix of X/Y-addressed and LID-only
 BinCode entries)."

### 11. `v0211-hexadecimal-nullbin-round.xml`
- Dims: **9 cols × 9 rows**. BinType=HexaDecimal (2 hex chars/token).
- Cell (0,0) [serRow=8]: `F0` (NullBin)
- Cell (1,0) [serRow=8]: `F0`
- Cell (0,1) [serRow=7]: `F0`
- Last cell (8,8) [serRow=0]: `F0`
- Non-null count: **61** / 81 total.
- Histogram: `F0`=20 (NullBin), `01`=59, `09`=2.
- Round-wafer mask; two Fail (`09`) cells present in the interior.

### 12. `v0211-decimal-bintype.xml`
- Dims: **5 cols × 4 rows**. BinType=Decimal (3-digit, space-separated).
- Cell (0,0) [serRow=3]: `255` (NullBin)
- Cell (1,0) [serRow=3]: `001`
- Cell (0,1) [serRow=2]: `001`
- Last cell (4,3) [serRow=0]: `001`
- Non-null count: **18** / 20 total.
- Histogram: `001`=16, `009`=2, `255`=2 (NullBin).

### 13. `v0211-orientation-90.xml`
- Dims: **5 cols × 3 rows**. Orientation=90 (quadrant value); origin/axis
 defaults (LowerLeft/UpRight).
- Cell (0,0) [serRow=2]: `1`
- Cell (1,0) [serRow=2]: `1`
- Cell (0,1) [serRow=1]: `1`
- Last cell (4,2) [serRow=0]: `9`
- Non-null count: **15** / 15 total (no NullBin used in this fixture).
- Histogram: `1`=12, `9`=3.

### 14. `v0211-orientation-45-nonquadrant.xml` — non-quadrant, open question
- Dims: **4 cols × 4 rows**. Orientation=**45** (non-quadrant).
- Cell (0,0) [serRow=3]: `1`
- Cell (1,0) [serRow=3]: `1`
- Cell (0,1) [serRow=2]: `1`
- Last cell (3,3) [serRow=0]: `1`
- Non-null count: **16** / 16 (no NullBin present).
- Histogram: `1`=14, `9`=2.
- **Open question** (see REPORT.md): what "logical coordinates" even mean
 under a 45° physical rotation is undefined in all inspected sources
 (undefined territory: the standard states no rule for a non-quadrant angle). The
 probe-cell values above are reported using the SAME rectangular
 from_left/from_bottom indexing as every other fixture (i.e., Orientation
 is treated as a pure display/placement rotation that does NOT alter
 which array cell is logical (0,0)); this is an assumption, not a
 normatively derived fact, and is flagged accordingly.

### 15. `v0211-origin-center-even.xml` — **Center-even, FORMULA-DERIVED**
- Dims: **4 cols × 4 rows** (even × even). OriginLocation=Center,
 AxisDirection=UpRight (explicit).
- Zero-cell (FORMULA-DERIVED per A4-1, even-dimension case not stated in
 prose anywhere in the source material): `((4-1)//2, (4-1)//2)` = `(1,1)`.
- Cell (0,0) logical → visual (from_left=0,from_bottom=0) = serRow 3, col 0:
 logical X = sx·(0−1) = **−1**, Y = sy·(0−1) = **−1** → logical(−1,−1),
 token = `1`.
- Cell (1,0) logical-address (i.e. the visual cell one step right) → visual
 (from_left=1,from_bottom=0) = serRow 3, col 1: logical(0,−1), token = `1`.
- Cell (0,1) → visual (from_left=0,from_bottom=1) = serRow 2, col 0:
 logical(−1,0), token = `1`.
- Last cell → visual (from_left=3,from_bottom=3) = serRow 0, col 3:
 logical(2,2), token = `1`.
- Non-null count: **16** / 16 (no NullBin present).
- Histogram: `1`=14, `9`=2.
- **All four probe values above are marked FORMULA-DERIVED** — the
 Center/even zero-cell placement is computed strictly from the
 formula that generalizes Table A4-1, not from any literal worked
 example (every Table A4-1 row quoted in the standard uses odd dimensions).

### 16. `v0211-origin-downleft.xml`
- Dims: **5 cols × 3 rows**. OriginLocation=**UpperRight**,
 AxisDirection=**DownLeft** (the required DownLeft case).
- Zero-cell = UpperRight visual corner = (from_left=4, from_bottom=2).
- Cell (0,0) logical → visual (from_left=4,from_bottom=2) = serRow 0, col 4:
 logical(0,0) [this is the zero-cell itself], token = `1`.
- Cell (1,0) logical → visual (from_left=3,from_bottom=2) = serRow 0, col 3:
 logical(1,0), token = `9`.
- Cell (0,1) logical → visual (from_left=4,from_bottom=1) = serRow 1, col 4:
 logical(0,1), token = `1`.
- Last cell logical (4,2) → visual (from_left=0,from_bottom=0) = serRow 2,
 col 0: token = `1`.
- Non-null count: **15** / 15 (no NullBin present).
- Histogram: `1`=13, `9`=2.

### 17. `v0211-multi-overlay.xml`
- Dims: **3 cols × 3 rows**, THREE overlays: SortGrade (v1), Retest (v1),
 FinalTest (v2).
- **Default overlay** (application-level convention documented in this
 fixture's header comment and REPORT.md — no schema-normative "default
 overlay" flag exists in any inspected XSD): first Overlay in document
 order = **"SortGrade"**.
- Overlay "SortGrade": cell (0,0)[serRow2]=`1`, (1,0)=`1`, (0,1)[serRow1]=`1`,
 last(2,2)[serRow0]=`1`. Non-null 8/9. Histogram: `1`=8,`9`=1 (no NullBin
 token present — this overlay simply never uses `.`).
- Overlay "Retest": all cells `1`. Non-null 9/9. Histogram: `1`=9.
- Overlay "FinalTest": cell(0,0)[serRow2]=`1`, (1,0)=`.`, (0,1)[serRow1]=`.`,
 last(2,2)[serRow0]=`1`. Non-null 5/9. Histogram: `1`=4, `.`=4 (NullBin), `9`=1.

### 18. `v0211-multi-layout-childpath.xml`
- LayoutSpecifier = literally **"Top/Child"**; Child layout dims:
 **4 cols × 3 rows** (Top layout is a 1×1 placeholder with a
 ChildLayouts pointer, per the multi-layout convention seen in the
 V1005 fixtures).
- Cell (0,0) [serRow=2]: `1`
- Cell (1,0) [serRow=2]: `1`
- Cell (0,1) [serRow=1]: `1`
- Last cell (3,2) [serRow=0]: `1`
- Non-null count: **12** / 12 total (NullBin token `.` is declared but
 never actually used in this fixture's data — every cell is `1` or `9`).
- Histogram: `1`=11, `9`=1.

### 19. `v0211-substrateid-whitespace.xml`
- SubstrateId = `" PADDED01 "` (2 leading + 2 trailing spaces, preserved
 verbatim on both `Substrate` and `SubstrateMap`).
- Dims: **3 cols × 2 rows**.
- Cell (0,0) [serRow=1]: `1`
- Cell (1,0) [serRow=1]: `.` (NullBin)
- Cell (0,1) [serRow=0]: `1`
- Last cell (2,1) [serRow=0]: `1`
- Non-null count: **5** / 6 total.
- Histogram: `1`=5, `.`=1 (NullBin).

### 20. `v0211-layoutless-defaults-alt.xml`
- No `<Layouts>` element (layoutless, like the official example, but a
 different grid) — dims-from-data: **8 cols × 6 rows**.
- No physical scale in document (same as official example).
- Cell (0,0) [serRow=5]: `1`
- Cell (1,0) [serRow=5]: `1`
- Cell (0,1) [serRow=4]: `1`
- Last cell (7,5) [serRow=0]: `1`
- Non-null count: **48** / 48 total (no NullBin token appears in this
 fixture's data — the rectangular pattern uses only `1`/`9`).
- Histogram: `1`=44, `9`=4.

### 21. `v0211-defaultunits-microns.xml`
- DefaultUnits=**"microns"** (non-normative, tolerated with warning →
 mapped to `um`).
- Dims (DeviceLayout child): **4 cols × 1 row**.
- Cell (0,0) [serRow=0]: `1`
- Cell (1,0) [serRow=0]: `9`
- Cell (0,1): **does not exist** (only 1 row; Y=1 is out of range for
 this 4×1 grid) — no card entry for (0,1).
- Last cell (3,0) [serRow=0]: `1`
- Non-null count: **4** / 4 total (no NullBin present).
- Histogram: `1`=3, `9`=1.

### 22. `v0211-defaultunits-100microns.xml`
- DefaultUnits=**"100Microns"** (non-normative, `/^(\d+)Microns$/`
 multiplier pattern, tolerated with warning → mapped to n×um, i.e. 100 um
 per unit here).
- Dims: **3 cols × 3 rows**. StepSize 6.3×6.4 (in "100Microns" units,
 i.e. 630×640 um).
- Cell (0,0) [serRow=2]: `1`
- Cell (1,0) [serRow=2]: `1`
- Cell (0,1) [serRow=1]: `1`
- Last cell (2,2) [serRow=0]: `1`
- Non-null count: **9** / 9 total (no NullBin present).
- Histogram: `1`=8, `9`=1.

### 23. `v0211-perf-600x600-ascii.xml` — script-generated, independently verified
- Dims: **600 cols × 600 rows** (declared Layout/Dimension matches actual
 BinCode row count of 600 and row length of 600, cross-checked by
 `verify_perf_xml.py` re-reading the file from disk — see REPORT.md).
- Cell (0,0) [serRow=599]: `.`
- Cell (1,0) [serRow=599]: `.`
- Cell (0,1) [serRow=598]: `.`
- Last cell (599,599) [serRow=0]: `.`
- Non-null count: **279,004** / 360,000 total.
- Histogram: `.`=80,996 (NullBin), `1`=273,496, `9`=5,508.
- Derivation method: **independent verification script**
 `verify_perf_xml.py` (does not import/reuse `gen_perf_xml.py`), re-parses
 the emitted XML text and recomputes the histogram/probe cells from
 scratch. See REPORT.md "600×600 verification method".

### INVALID fixtures (expected failure class instead of a data card)

**24. `v0211-invalid-duplicate-layoutid.xml`**
Expected failure class: **XSD identity-constraint violation**
(`cvc-identity-constraint.4.2.2`, duplicate key value for the `LayoutKey`
`xs:key` — two `<Layout LayoutId="Dup">` elements). The document is
well-formed XML (confirmed by `oracle_xml.py`, which parses it without
error) but must be rejected by any XSD-validating parser.

**25. `v0211-invalid-truncated.xml`**
Expected failure class: **XML well-formedness error** (not-well-formed /
premature end of file). Confirmed: `oracle_xml.py` raised
`xml.etree.ElementTree.ParseError: no element found: line 34, column 0`
when attempting to parse this file — this is the expected and required
outcome, not a bug.

**26. `v0211-invalid-unknown-substratetype.xml`**
Expected failure class: **XSD enumeration violation**
(`cvc-enumeration-valid`/`cvc-attribute.3` on `SubstrateTypeEnum`,
value `"Puck"` not in `{Wafer, Frame, Strip, Tray}` in any inspected
schema revision including V0125/V0224). Document is well-formed XML
(confirmed) but schema-invalid.

---

## PART 2 — GridData JSON fixtures

### 1. `json-bins-string-array.json`
- Dims: **5×3**. Units mm, stepSize 0.5×0.5.
- Cell (0,0) [serRow=2]: `1`
- Cell (1,0) [serRow=2]: `1`
- Cell (0,1) [serRow=1]: `1`
- Last cell (4,2) [serRow=0]: `1`
- Non-null: **15**/15 (no `.` present). Histogram: `1`=13, `9`=2.

### 2. `json-bins-string-single.json`
- Dims: **4×3**, mapType Array, single 12-char string.
- Cell (0,0) [serRow=2]: `1`
- Cell (1,0) [serRow=2]: `1`
- Cell (0,1) [serRow=1]: `1`
- Last cell (3,2) [serRow=0]: `1`
- Non-null: **11**/12. Histogram: `1`=9, `9`=2, `.`=1 (NullBin).

### 3. `json-bins-number-integer2.json`
- Dims: **4×2**, binType Integer2, bins as number[] (row-major, length 8).
- Decoded tokens (canonical 4-hex-digit): row-major from top:
 [0001,0001,0009,0001] / [0001,0001,0001,FFFF(65535)].
- Cell (0,0) [serRow=1]: `0001`
- Cell (1,0) [serRow=1]: `0001`
- Cell (0,1) [serRow=0]: `0001`
- Last cell (3,1) [serRow=0]: `0001`
- Non-null: **7**/8. Histogram: `0001`=6, `0009`=1, `FFFF`=1 (NullBin).

### 4. `json-coordinate-sparse.json`
- Dims: **4×3** (12 cells), mapType Coordinate, sparse `{x,y,bin}[]`,
 6 of 12 cells populated.
- Cell (0,0): `1` (explicit x=0,y=0)
- Cell (1,0): `1` (explicit x=1,y=0)
- Cell (0,1): `1` (explicit x=0,y=1)
- Last cell (3,2): `.` (NullBin by omission — no x=3,y=2 entry)
- Non-null: **6**/12. Histogram: `1`=5, `9`=1, `.`=6 (by omission).

### 5. `json-defaults-omitted.json`
- Dims: **3×3**. Only Pflicht fields present; orientation/originLocation/
 axisDirection/mapType all default (0/LowerLeft/UpRight/2DArray).
- Cell (0,0) [serRow=2]: `1`
- Cell (1,0) [serRow=2]: `.` (NullBin)
- Cell (0,1) [serRow=1]: `.` (NullBin)
- Last cell (2,2) [serRow=0]: `1`
- Non-null: **5**/9. Histogram: `1`=4, `.`=4 (NullBin), `9`=1.

### 6. `json-units-um.json`
- Dims: **3×2**. units="um", stepSize 630×640 (um), deviceSize 600×600 (um).
- Cell (0,0) [serRow=1]: `1`
- Cell (1,0) [serRow=1]: `1`
- Cell (0,1) [serRow=0]: `1`
- Last cell (2,1) [serRow=0]: `1`
- Non-null: **5**/6. Histogram: `1`=5, `.`=1 (NullBin).

### 7. `json-lowerleft-anchored.json`
- Dims: **4×4** (even×even). `lowerLeft`={x:-1.26,y:-1.28} mm anchor set
 (originLocation remains LowerLeft — this is a physical-anchor test, NOT
 a Center-geometry test).
- Cell (0,0) [serRow=3]: `1`
- Cell (1,0) [serRow=3]: `1`
- Cell (0,1) [serRow=2]: `1`
- Last cell (3,3) [serRow=0]: `1`
- Non-null: **16**/16 (no NullBin token present). Histogram: `1`=14, `9`=2.

### 8. `json-perf-600x600-ascii.json` — script-generated, independently verified
- Dims: **600×600**.
- Cell (0,0) [serRow=599]: `.`
- Cell (1,0) [serRow=599]: `.`
- Cell (0,1) [serRow=598]: `.`
- Last cell (599,599) [serRow=0]: `.`
- Non-null: **279,004**/360,000. Histogram: `.`=80,996 (NullBin),
 `1`=273,371, `9`=5,633.
- Derivation method: independent verification script `verify_perf_json.py`
 (does not import/reuse `gen_perf_json.py`), re-parses the emitted JSON
 from disk. Note the histogram numbers differ slightly from the XML
 600×600 fixture (different RNG seed, 42 vs 43, and independent mask
 computation) — this is intentional, the two performance fixtures are
 not meant to be identical.

### INVALID fixtures (expected failure class instead of a data card)

**9. `json-invalid-dimension-mismatch.json`**
Expected failure class: **typed validation error, dimension/bins length
mismatch**. Declared dimension 5×3 (3 rows of 5 expected); only 2 rows
supplied, and row 2 (`"1911"`) is 4 characters instead of the required 5.
Confirmed by `oracle_json.py`: attempting to build row 3 raised
`IndexError: list index out of range` when applying the declared
dimension — this is the expected failure signature (both a row-count
shortfall and a row-width shortfall are present simultaneously).

**10. `json-invalid-bintype-enum.json`**
Expected failure class: **typed validation error, out-of-enum binType**.
`binType: "Octal"` is not a member of `{Ascii, Decimal, HexaDecimal,
Integer2}`. The JSON is otherwise syntactically well-formed and its bins
payload (2×2, all `"1"`) would parse fine structurally — the failure must
come specifically from binType enum validation, not from a payload-shape
error.

---

## Coverage cross-check

All PART 1 coverage bullets (namespaces V0805/V0921/V1005/V0211/V0125;
MapTypes 2DArray/Array/Row-Column/Coordinate; BinTypes
Ascii/Decimal/HexaDecimal/Integer2; NullBin-heavy round shape; Origin ×
Axis variation incl. Center and DownLeft; Orientation 0/90/180/45;
multi-overlay; multi-layout "Top/Child"; whitespace SubstrateId; LowerLeft
Layout; 3 invalid classes; 2 layoutless variants; 2 DefaultUnits variants;
1 V0125 LID-mixed Coordinate; 1 PROSE-DERIVED Row/Column; 1 ≥600×600
performance file) are each satisfied by exactly one fixture enumerated
above, cross-referenced 1:1 against the file list in
`/home/user/workspace/task-6.1/fixtures/xml/`. All PART 2 coverage bullets
(string/string[]/number[]/Coordinate-sparse bins; defaults-omitted; units
"um"; lowerLeft-anchored; ≥600×600; 2 invalid classes) are likewise
satisfied 1:1 against `/home/user/workspace/task-6.1/fixtures/json/`. See
REPORT.md for the full bullet-by-bullet coverage table.
