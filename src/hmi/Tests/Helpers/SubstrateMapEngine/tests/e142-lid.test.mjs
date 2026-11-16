/*
 * e142-lid.test.mjs - location identifiers, end to end.
 *
 * A LID names a POSITION, not the device in it. E142-0225 13.4 is explicit:
 * "A location identifier is distinct from the DeviceId (identifier on the
 * device) that might be placed in that position. The location identifier is
 * still present when the device is removed." Everything below follows from that
 * sentence and from 13.3's "either the X and Y coordinate, or the location
 * identifier, or both".
 *
 * Five families, matching ws/notes/DECISION-lid.md:
 *   1. a LID-only Coordinate map resolves onto the declared lattice
 *   2. a map mixing LID and X/Y places both without collision
 *   3. a DeviceIdMap LID joins to the cell the BinCodeMap named
 *   4. the TnR ordering (R2-3.3) - X from the hub, Y per row
 *   5. the unresolvable case, and what its warning has to say
 *
 * The join in (3) is the control's, and the control cannot be instantiated
 * without a DOM - so that family exercises the same lookup the control performs
 * over a real parsed document, and asserts the control's source performs it.
 * Families 1, 2, 4 and 5 call the engine directly.
 *
 * Run: node --test Helpers/SubstrateMapEngine/tests/e142-lid.test.mjs
 *      npm run test:lid
 */

import { readFileSync } from 'node:fs';
import { stubParseDocument } from './xml-stub.mjs';
import { onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const E142 = await import(ENGINE + 'E142.js');
const E142Xml = await import(ENGINE + 'E142Xml.js');
const E142Grid = await import(ENGINE + 'E142Grid.js');
const Engine = await import(ENGINE + 'Engine.js');

/* ------------------------------ harness ------------------------------ */
let PASS = 0, FAIL = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES }));
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; FAILURES.push(label); } }
function eq(actual, expected, label) {
    ok(Object.is(actual, expected), `${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function has(hay, needle, label) {
    ok(typeof hay === 'string' && hay.includes(needle), `${label}  (missing ${JSON.stringify(needle)})`);
}

/* ------------------------------ fixtures ----------------------------- */
const NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';
/** `layout` = '' means NO <Layouts> and a dangling specifier: the no-lattice shape. */
const document_ = (layout, overlays, substrateType = 'Wafer') => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MapData xmlns="${NS}">`,
    layout === '' ? '' : `  <Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">${layout}`
        + '<StepSize X="1" Y="1" Units="mm"/></Layout></Layouts>',
    `  <SubstrateMaps><SubstrateMap SubstrateType="${substrateType}" SubstrateId="S1" LayoutSpecifier="L"`,
    '      OriginLocation="LowerLeft" AxisDirection="UpRight">',
    overlays,
    '  </SubstrateMap></SubstrateMaps></MapData>',
].filter((l) => l !== '').join('\n');
const bcm = (entries, name = 'Sort') =>
    `    <Overlay MapName="${name}"><BinCodeMap BinType="Ascii" NullBin="." MapType="Coordinate">`
    + `${entries}</BinCodeMap></Overlay>`;

const parse = (xml) => E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
/** Parse -> resolve -> place -> build, the chain the control runs. */
function build(xml) {
    const r = parse(xml);
    const sm = r.doc.substrateMaps[0];
    const ov = sm.overlays.find((o) => o.payload !== undefined) ?? sm.overlays[0];
    if (ov.payload === undefined) { return { r, sm, ov, grid: null }; }
    const resolved = E142.resolveLayoutSpecifier(r.doc, sm.header.layoutSpecifier);
    const layout = resolved !== null && !(resolved instanceof E142.E142Error)
        ? resolved : E142.dimsFromPayload(ov.payload);
    const placement = E142.computeGridPlacement(sm.header, layout, 0, undefined).placement;
    return { r, sm, ov, grid: Engine.buildGridModel(placement, ov.payload, null) };
}
const tokenAt = (grid, i) => grid.binTable[grid.cells[i]].code;

/* =====================================================================
 * 1. A LID-only Coordinate map resolves onto the declared lattice
 * ===================================================================== */
console.log('\n=== 1. LID-only Coordinate map ===');
{
    const lids = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];
    const entries = lids.map((l, i) => `<BinCode LID="${l}">${'abcdef'[i]}</BinCode>`).join('');
    const { r, grid } = build(document_('<Dimension X="3" Y="2"/>', bcm(entries)));

    ok(grid !== null, 'a grid is built from entries that carry no X/Y at all');
    eq(grid.cols, 3, 'cols from the declared Dimension');
    eq(grid.rows, 2, 'rows from the declared Dimension');
    let filled = 0;
    for (let i = 0; i < 6; i++) { if (grid.cells[i] !== 0) { filled++; } }
    eq(filled, 6, 'every cell is filled - nothing was excluded');
    eq([0, 1, 2, 3, 4, 5].map((i) => tokenAt(grid, i)).join(''), 'abcdef',
        'document order fills the lattice ROW-MAJOR');
    for (let i = 0; i < 6; i++) { eq(grid.lids.get(i), lids[i], `cell ${i} keeps its LID`); }
    eq(r.warnings.length, 0, 'and nothing warns: the map is fully resolvable');
}

/* =====================================================================
 * 2. Mixed LID and X/Y in one map (13.3's "or both")
 * ===================================================================== */
console.log('\n=== 2. mixed LID and X/Y ===');
{
    /* LowerLeft/UpRight on a 2x2: logical (0,0) is serialization index 2.
     * The X/Y entry claims index 2; the three LID-only entries must take
     * 0, 1 and 3 - skipping the claimed one rather than colliding with it. */
    const { r, grid } = build(document_('<Dimension X="2" Y="2"/>', bcm(
        '<BinCode X="0" Y="0">z</BinCode>'
        + '<BinCode LID="A">p</BinCode><BinCode LID="B">q</BinCode><BinCode LID="C">s</BinCode>')));
    eq(tokenAt(grid, 2), 'z', 'the X/Y entry keeps the cell its coordinate names');
    ok(!grid.lids.has(2), '  and is unnamed, having carried no LID');
    eq(grid.lids.get(0), 'A', 'the LID-only entries take the FREE cells, in document order');
    eq(grid.lids.get(1), 'B', '  ...');
    eq(grid.lids.get(3), 'C', '  ...skipping the one the coordinate claimed');
    eq(r.warnings.length, 0, 'no collision, so no warning');
}
{
    /* "or both": one entry carrying a coordinate AND a LID. The coordinate
     * places it - a LID is a name, a coordinate is a position - and the LID
     * still names the cell. */
    const { grid } = build(document_('<Dimension X="2" Y="1"/>', bcm(
        '<BinCode X="0" Y="0" LID="NAMED">a</BinCode><BinCode X="1" Y="0">b</BinCode>')));
    eq(grid.lids.size, 1, 'exactly one cell is named');
    eq(grid.lids.get(0), 'NAMED', 'the coordinate placed it; the LID names it');
    eq(tokenAt(grid, 0), 'a', '  and its token is the one the entry carried');
}
{
    /* LIDs are opaque: a join key, never normalised. */
    const { grid } = build(document_('<Dimension X="4" Y="1"/>', bcm(
        '<BinCode LID="  P-1  ">a</BinCode><BinCode LID="pkt-0042">b</BinCode>'
        + '<BinCode LID="P/0007">c</BinCode><BinCode LID="0007">d</BinCode>')));
    eq(grid.lids.get(0), '  P-1  ', 'surrounding whitespace is NOT trimmed');
    eq(grid.lids.get(1), 'pkt-0042', 'case is NOT folded');
    eq(grid.lids.get(2), 'P/0007', 'a separator is not special');
    eq(grid.lids.get(3), '0007', 'a numeric-looking LID stays a string');
}

/* =====================================================================
 * 3. A DeviceIdMap LID joins to the cell the BinCodeMap named
 * ===================================================================== */
console.log('\n=== 3. DeviceIdMap joined by LID ===');
{
    const xml = document_('<Dimension X="2" Y="2"/>',
        bcm('<BinCode X="0" Y="0">a</BinCode><BinCode LID="SOCK-1">b</BinCode>'
            + '<BinCode LID="SOCK-2">c</BinCode><BinCode LID="SOCK-3">d</BinCode>')
        + '\n    <Overlay MapName="Ids"><DeviceIdMap>'
        + '<Id LID="SOCK-2">DEV-B</Id>'          // LID only - the R2-3.2.2 shape
        + '<Id X="0" Y="0">DEV-A</Id>'           // coordinate only
        + '<Id LID="NOT-THERE">DEV-X</Id>'       // names a location this map does not
        + '</DeviceIdMap></Overlay>');
    const { r, sm, grid } = build(xml);
    const ids = sm.overlays.find((o) => o.deviceIdEntries !== undefined).deviceIdEntries;
    eq(ids.length, 3, 'three <Id> entries parsed');

    /* The control's join, performed here over the real grid: LID first, then X/Y. */
    const byLid = new Map();
    for (const [cell, lid] of grid.lids) { if (!byLid.has(lid)) { byLid.set(lid, cell); } }
    const resolve = (e) => {
        const byName = e.lid !== undefined ? byLid.get(e.lid) ?? null : null;
        if (byName !== null) { return byName; }
        if (e.x === undefined || e.y === undefined) { return null; }
        const { serCol, serRow } = E142.mapCoordToIndex(
            e.x, e.y, sm.header.originLocation, sm.header.axisDirection, grid.cols, grid.rows);
        return (serCol >= 0 && serCol < grid.cols && serRow >= 0 && serRow < grid.rows)
            ? serRow * grid.cols + serCol : null;
    };
    const cellOfSock2 = byLid.get('SOCK-2');
    eq(resolve(ids[0]), cellOfSock2, 'a LID-only <Id> resolves to the cell the BinCodeMap named');
    ok(cellOfSock2 !== undefined, '  and that cell exists');
    eq(tokenAt(grid, resolve(ids[0])), 'c', '  the joined cell carries the right bin');
    eq(resolve(ids[1]), 2, 'a coordinate-only <Id> still resolves by X/Y');
    eq(resolve(ids[2]), null, 'a LID this map does not name resolves to nothing');
    eq(r.warnings.length, 0, 'the document itself is clean');

    /* And the control really does it this way - the join is in its source. */
    const SRC = readFileSync(new URL('../../../Controls/SubstrateMap/SubstrateMap.ts', import.meta.url), 'utf8');
    /* Task 47 factored this rule into __resolveAddressToCell, shared with the
     * transfer index. Assert the SHARED rule rather than one call site's text:
     * the previous version pinned the inline source lines and broke on a
     * refactor that changed no behaviour. */
    ok(SRC.includes('protected __resolveAddressToCell('), 'the control has one address rule');
    ok(SRC.includes('cell: byName ?? byCoord,'), '  and it prefers the LID over the coordinate');
    ok((SRC.match(/this\.__resolveAddressToCell\(/g) || []).length >= 2,
        '  used by the DeviceIdMap join and the transfer index alike');
    ok(SRC.includes('this.__resolveAddressToCell(e.lid, e.x, e.y, header, grid, byLid)'),
        '  the DeviceIdMap join passes the <Id> entry\u2019s own LID and X/Y');
    ok(SRC.includes('E142_DEVICEID_ADDRESS_CONFLICT'), '  and warns when the two disagree');
    ok(SRC.includes('E142_LID_DUPLICATE'), '  and when the map names one location twice');
}

/* =====================================================================
 * 4. The TnR ordering (R2-3.3)
 * ===================================================================== */
console.log('\n=== 4. TnR ordering: X from the hub, Y per row ===');
{
    /* R2-3.3.1: "For X, a value of '0' should indicate the location beginning at
     * the first pocket closest to the TnR hub and Xmax should indicate the pocket
     * furthest from the hub."  R2-3.3.2: "For Y, a value of '0' should indicate
     * the first row of pockets and if there are multiple rows of pockets, Y should
     * increase for each successive row."
     *
     * No TnR-specific code exists, and none is needed: a single-row tape declared
     * `Dimension X=n Y=1` and filled row-major in document order ALREADY satisfies
     * both clauses - pocket k lands at X=k, Y=0. This asserts that equivalence
     * rather than assuming it, which is why DECISION-lid.md's tier 2 stayed
     * unimplemented. */
    const pockets = ['PI-A', 'PI-B', 'PI-C', 'PI-D', 'PI-E'];
    const entries = pockets.map((p, i) => `<BinCode LID="${p}">${'12345'[i]}</BinCode>`).join('');
    const { r, sm, grid } = build(document_('<Dimension X="5" Y="1"/>', bcm(entries), 'TnR'));
    eq(String(sm.header.substrateType), 'TnR', 'the substrate declares itself a tape and reel');
    eq(grid.cols, 5, 'five pockets along the tape');
    eq(grid.rows, 1, 'one row');
    for (let k = 0; k < 5; k++) {
        const { serCol, serRow } = E142.mapCoordToIndex(
            k, 0, sm.header.originLocation, sm.header.axisDirection, grid.cols, grid.rows);
        eq(grid.lids.get(serRow * grid.cols + serCol), pockets[k],
            `R2-3.3.1: pocket ${k} in document order is at logical X=${k}`);
    }
    eq(r.warnings.length, 0, 'and it resolves without complaint');
}
{
    /* Multi-row: R2-3.3.2 says Y increases per row of pockets. Row-major fill
     * gives exactly that - the first `cols` entries are row 0, the next `cols`
     * row 1. */
    const p = ['A0', 'A1', 'A2', 'B0', 'B1', 'B2'];
    const entries = p.map((l, i) => `<BinCode LID="${l}">${'abcdef'[i]}</BinCode>`).join('');
    const { sm, grid } = build(document_('<Dimension X="3" Y="2"/>', bcm(entries), 'TnR'));
    const at = (x, y) => {
        const { serCol, serRow } = E142.mapCoordToIndex(
            x, y, sm.header.originLocation, sm.header.axisDirection, grid.cols, grid.rows);
        return grid.lids.get(serRow * grid.cols + serCol);
    };
    /* Serialization row 0 is the TOP row and logical Y counts UP from LowerLeft,
     * so the first three document entries (serialization row 0) are logical Y=1. */
    eq(at(0, 1), 'A0', 'R2-3.3.2: the first row of pockets fills first');
    eq(at(2, 1), 'A2', '  ...left to right');
    eq(at(0, 0), 'B0', '  ...then the next row');
    eq(at(2, 0), 'B2', '  ...also left to right');
}

/* =====================================================================
 * 5. Unresolvable: no lattice, and the lattice exhausted
 * ===================================================================== */
console.log('\n=== 5. the unresolvable cases ===');
{
    /* No <Layouts> at all: a Coordinate map does not describe its own shape, so
     * there is nothing to resolve onto. This warns rather than throwing, and the
     * overlay is simply not renderable. */
    const { r, ov, grid } = build(document_('', bcm('<BinCode LID="A">1</BinCode><BinCode LID="B">9</BinCode>')));
    ok(grid === null, 'no grid');
    ok(ov.payload === undefined, 'and no payload: the overlay is not renderable');
    const w = r.warnings.filter((x) => x.includes('E142_XML_LID_NO_LATTICE'));
    eq(w.length, 1, 'exactly one warning');
    has(w[0], 'supplies no lattice', 'it names what is missing');
    has(w[0], 'does not describe its own shape', 'says why Coordinate cannot supply one itself');
    has(w[0], 'no Layout with a Dimension is reachable', 'names the input that would fix it');
    has(w[0], 'Supply a Layout Dimension, or address the entries by X/Y', 'and both remedies');
    has(w[0], 'retained on the overlay in sparseBinCodes', 'and where the data went');
    eq(ov.sparseBinCodes.length, 2, 'both entries are retained, not dropped');
    eq(ov.sparseBinCodes.map((e) => e.lid).join(','), 'A,B', '  with their LIDs, in document order');
}
{
    /* Lattice exhausted: more LID-only entries than free cells. The ones that fit
     * are placed; the rest are genuinely unresolvable. */
    const { r, grid } = build(document_('<Dimension X="2" Y="1"/>', bcm(
        '<BinCode LID="A">a</BinCode><BinCode LID="B">b</BinCode><BinCode LID="C">c</BinCode>')));
    ok(grid !== null, 'the two that fit are placed');
    eq(grid.lids.size, 2, '  two cells named');
    const w = r.warnings.filter((x) => x.includes('E142_XML_LID_ONLY_EXCLUDED'));
    eq(w.length, 1, 'and one warning for the overflow');
    has(w[0], '"C"', '  naming exactly the entry that did not fit');
    ok(!w[0].includes('"A"') && !w[0].includes('"B"'), '  and not the two that did');
}
{
    /* The GridData path refuses a lids array that is not one-per-cell, and says
     * how to express "this cell has no LID". */
    let err = null;
    try {
        E142Grid.normalizeGridData({
            dimension: { x: 2, y: 2 }, units: 'mm', stepSize: { x: 1, y: 1 },
            binType: 'Ascii', nullBin: '.', mapType: '2DArray', bins: ['ab', 'cd'],
            lids: ['only', 'three', 'here'],
        });
    } catch (e) { err = e; }
    ok(err !== null, 'GridData: a short lids array is rejected');
    eq(err && err.code, 'E142_GRID_FIELD_TYPE', '  with a field-type error');
    has(err && err.path, '/lids', '  pointing at /lids');
    has(err && err.message, 'use null for a cell the document does not name', '  and saying how to fix it');
}

/* ------------------------------- summary ------------------------------ */
console.log('\n========================================================');
console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
    console.log('  FAILURES:');
    for (const f of FAILURES) { console.log('   - ' + f); }
}
console.log('========================================================');
process.exit(FAIL > 0 ? 1 : 0);
