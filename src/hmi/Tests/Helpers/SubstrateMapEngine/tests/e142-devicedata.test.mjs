/*
 * e142-devicedata.test.mjs - DeviceDataMap and the embedded E138 PVSet.
 *
 * E142 embeds SEMI E138 by reference: `DeviceDataType` declares
 * `<xs:element ref="ccs:PVSet" minOccurs="1"/>`, and that one line is why
 * `DeviceDataMap` was the last overlay kind to be parsed. The map itself is
 * small; the payload is a sixteen-way choice with two recursive cases.
 *
 * The thread running through every family below is E142-0225 Table 19:
 *
 *   "The order of values shall match the order of parameters listed in the
 *    DeviceDataMap's Parameter attribute."
 *
 * A `shall`, and the values carry no names of their own. `values[i]` means
 * `parameters[i]` and nothing else says so - which is why a dropped or skipped
 * value is not one lost reading but a silent re-labelling of every reading after
 * it, and why the parser reports rather than omits at every step.
 *
 * Six families:
 *   1. all sixteen PVSet kinds
 *   2. nesting - Su and Arr, both ways, and the depth guard
 *   3. NoValue vs xsi:nil vs the empty string
 *   4. the parameter/value count mismatch warning
 *   5. the selection join, name to value by index
 *   6. serialisation and the round trip
 *
 * Run: node --test Helpers/SubstrateMapEngine/tests/e142-devicedata.test.mjs
 *      npm run test:devicedata
 */

import { readFileSync } from 'node:fs';
import { stubParseDocument } from './xml-stub.mjs';
import { onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const E142 = await import(ENGINE + 'E142.js');
const E142Xml = await import(ENGINE + 'E142Xml.js');
const Engine = await import(ENGINE + 'Engine.js');
const Pv = await import(ENGINE + 'E138Pv.js');

/* ------------------------------ harness ------------------------------ */
let PASS = 0, FAIL = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES }));
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; FAILURES.push(label); } }
function eq(a, b, label) {
    ok(Object.is(a, b), `${label}  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function deep(a, b, label) {
    ok(JSON.stringify(a) === JSON.stringify(b), `${label}  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function has(hay, needle, label) {
    ok(typeof hay === 'string' && hay.includes(needle), `${label}  (missing ${JSON.stringify(needle)})`);
}

/* ------------------------------ fixtures ----------------------------- */
const E142_NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
/** A document whose one SubstrateMap renders a 2x2 grid and carries a DeviceDataMap. */
const document_ = (ddm) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MapData xmlns:ccs="${Pv.E138_NS}" xmlns:xsi="${XSI}" xmlns="${E142_NS}">`,
    '  <Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">',
    '    <Dimension X="2" Y="2"/><StepSize X="1" Y="1" Units="mm"/></Layout></Layouts>',
    '  <SubstrateMaps><SubstrateMap SubstrateType="Wafer" SubstrateId="W1" LayoutSpecifier="L"',
    '      OriginLocation="LowerLeft" AxisDirection="UpRight">',
    '    <Overlay MapName="Sort"><BinCodeMap BinType="Ascii" NullBin="." MapType="Coordinate">',
    '      <BinCode X="0" Y="0" LID="C00">a</BinCode><BinCode X="1" Y="0" LID="C10">b</BinCode>',
    '      <BinCode X="0" Y="1">c</BinCode><BinCode X="1" Y="1">d</BinCode>',
    '    </BinCodeMap></Overlay>',
    `    <Overlay MapName="DD"><DeviceDataMap>${ddm}</DeviceDataMap></Overlay>`,
    '  </SubstrateMap></SubstrateMaps></MapData>',
].join('\n');
const P = (n) => `<Parameter Name="${n}"/>`;
const DD = (attrs, pv) => `<DeviceData ${attrs}><ccs:PVSet>${pv}</ccs:PVSet></DeviceData>`;
/** `<ccs:X>text</ccs:X>` */
const v = (kind, text = '') => `<ccs:${kind}>${text}</ccs:${kind}>`;

const parse = (xml) => E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
function read(ddm) {
    const r = parse(document_(ddm));
    const sm = r.doc.substrateMaps[0];
    const ov = sm.overlays.find((o) => o.deviceDataMaps !== undefined);
    return { r, sm, map: ov === undefined ? undefined : ov.deviceDataMaps[0] };
}
function gridOf(r, sm) {
    const ov = sm.overlays.find((o) => o.payload !== undefined);
    const resolved = E142.resolveLayoutSpecifier(r.doc, sm.header.layoutSpecifier);
    return Engine.buildGridModel(
        E142.computeGridPlacement(sm.header, resolved, 0, undefined).placement, ov.payload, null);
}

/* =====================================================================
 * 1. All sixteen PVSet kinds
 * ===================================================================== */
console.log('\n=== 1. all sixteen kinds ===');
{
    const pv = v('F8', '42.9') + v('F4', '0.25') + v('I8', '9007199254740991')
        + v('I4', '-2147483648') + v('I2', '-32768') + v('I1', '127')
        + v('S', 'text') + v('D', '2026-07-29T12:00:00.123456+02:00') + v('B', 'true')
        + v('URI', 'urn:x:1') + v('B64', 'QUJD') + v('EI', '7') + v('ES', 'GRADE_A')
        + `<ccs:Su>${v('I2', '1')}</ccs:Su>` + '<ccs:Arr/>'
        + `<ccs:NoValue reasonCode="NoSuchSource">${v('Description', 'd')}</ccs:NoValue>`;
    const { r, map } = read(Array.from({ length: 16 }, (_, i) => P(`p${i}`)).join('') + DD('X="0" Y="0"', pv));
    const values = map.deviceData[0].values;
    eq(values.length, 16, 'sixteen values reach the E142 model');
    deep(values.map((x) => x.kind), [...Pv.PV_KINDS],
        'their kinds are exactly PV_KINDS, in the schema\u2019s declaration order');
    eq(r.warnings.length, 0, 'and nothing warns');

    eq(values[0].value, 42.9, 'F8');
    eq(values[2].value, 9007199254740991, 'I8 at MAX_SAFE_INTEGER');
    eq(values[6].value, 'text', 'S');
    eq(values[7].value, '2026-07-29T12:00:00.123456+02:00',
        'D is LEXICAL - offset and six-digit fraction both survive the E142 layer');
    eq(values[8].value, true, 'B');
    eq(values[10].value, 'QUJD', 'B64 is not decoded');
    eq(values[14].items.length, 0, 'an empty Arr is a value, not an absence');
    eq(values[15].reasonCode, 'NoSuchSource', 'NoValue keeps its reason');
}
{
    /* Lexical validation survives the embedding: a bad number inside a PVSet
     * inside a DeviceData is still reported, with the whole path. */
    const { r, map } = read(P('p') + DD('X="0" Y="0"', v('I4', '1.0')));
    eq(map.deviceData[0].values[0].value, null, 'an invalid xs:int reads as null');
    const w = r.warnings.filter((x) => x.includes('E138_PV_LEXICAL'));
    eq(w.length, 1, '  and warns');
    has(w[0], '/DeviceDataMap[1]/DeviceData[1]/PVSet/I4[1]', '  with the full E142 path');
}

/* =====================================================================
 * 2. Nesting
 * ===================================================================== */
console.log('\n=== 2. nesting ===');
{
    /* The R1-2.1 waveform: an Arr of two Su, each two I2. */
    const pv = '<ccs:Arr>'
        + `<ccs:Su>${v('I2', '23')}${v('I2', '57')}</ccs:Su>`
        + `<ccs:Su>${v('I2', '25')}${v('I2', '63')}</ccs:Su>`
        + '</ccs:Arr>';
    const { map } = read(P('Waveform') + DD('X="0" Y="0"', pv));
    const arr = map.deviceData[0].values[0];
    eq(arr.kind, 'Arr', 'the value is an Arr');
    eq(arr.items.length, 2, '  of two');
    ok(arr.items.every((x) => x.kind === 'Su'), '  both Su');
    deep(arr.items.map((s) => s.fields.map((f) => f.value)), [[23, 57], [25, 63]],
        'the XY pairs survive the whole E142 -> E138 path');
}
{
    /* Recursion both ways, and heterogeneous items - neither is forbidden. */
    const pv = `<ccs:Su>${v('S', 'a')}<ccs:Arr>${v('I1', '1')}${v('B', 'false')}</ccs:Arr></ccs:Su>`;
    const { r, map } = read(P('p') + DD('X="0" Y="0"', pv));
    const su = map.deviceData[0].values[0];
    eq(su.fields.length, 2, 'a Su may hold a scalar and an Arr');
    eq(su.fields[1].kind, 'Arr', '  recursion the other way round');
    deep(su.fields[1].items.map((x) => x.kind), ['I1', 'B'],
        '  and an Arr need not be homogeneous - the schema does not require it');
    eq(r.warnings.length, 0, 'so nothing warns');
}
{
    /* Su requires >=1 child; Arr permits 0. Asymmetric, and from the XSD. */
    const { r } = read(P('p') + DD('X="0" Y="0"', '<ccs:Su/>'));
    ok(r.warnings.some((w) => w.includes('E138_PV_EMPTY_STRUCTURE')),
        '<Su/> warns - StructureValueType is minOccurs="1"');
    const arr = read(P('p') + DD('X="0" Y="0"', '<ccs:Arr/>'));
    ok(!arr.r.warnings.some((w) => w.includes('E138_PV_EMPTY_STRUCTURE')),
        '<Arr/> does NOT - ArrayValueType is minOccurs="0"');
}
{
    /* The depth guard raises a TYPED error rather than a host stack overflow.
     * E138 bounds the recursion nowhere, so the limit is this engine's. */
    const nest = (n) => (n === 0 ? v('I2', '1') : `<ccs:Su>${nest(n - 1)}</ccs:Su>`);
    let err = null;
    try { read(P('p') + DD('X="0" Y="0"', nest(Pv.PV_MAX_DEPTH + 1))); } catch (e) { err = e; }
    ok(err !== null, `${Pv.PV_MAX_DEPTH + 1} nested Su raises`);
    ok(err instanceof Pv.E138PvError, '  and it is E138PvError, not a RangeError from the host');
    eq(err && err.code, 'E138_PV_DEPTH', '  code E138_PV_DEPTH');
    has(err && err.message, 'E138 itself', '  saying the limit is this engine\u2019s, not the standard\u2019s');
    let deepOk = null;
    try { read(P('p') + DD('X="0" Y="0"', nest(Pv.PV_MAX_DEPTH))); } catch (e) { deepOk = e; }
    ok(deepOk === null, `  and exactly ${Pv.PV_MAX_DEPTH} is accepted`);
}

/* =====================================================================
 * 3. NoValue vs xsi:nil vs the empty string
 * ===================================================================== */
console.log('\n=== 3. three ways to have no reading ===');
{
    const pv = '<ccs:F8 xsi:nil="true"/>'
        + `<ccs:NoValue reasonCode="NoSuchParameter">${v('Description', 'not on this tool')}</ccs:NoValue>`
        + v('S', '');
    const { r, map } = read(P('a') + P('b') + P('c') + DD('X="0" Y="0"', pv));
    const [nil, none, empty] = map.deviceData[0].values;

    eq(nil.kind, 'F8', 'the nil KEEPS its type - a reader still knows what was expected');
    eq(nil.value, null, '  with value null');
    ok(!('reasonCode' in nil), '  and offers no explanation');

    eq(none.kind, 'NoValue', 'the NoValue has its own kind');
    eq(none.reasonCode, 'NoSuchParameter', '  carrying WHY');
    ok(!('value' in none), '  and no value field at all - nothing to mistake for a reading');
    eq(none.description, 'not on this tool', '  plus the description');

    eq(empty.kind, 'S', 'the empty string is an S');
    eq(empty.value, '', '  whose value is the empty string - a VALUE, not an absence');

    ok(nil.value !== empty.value, 'nil and "" are distinguishable');
    ok(JSON.stringify(nil) !== JSON.stringify(none), 'nil and NoValue are distinguishable');
    eq(r.warnings.length, 0, 'and all three are legal - nothing warns');

    /* They must stay distinct at the display surface too, or the parser's care
     * is undone by the last step. */
    const shown = map.deviceData[0].values.map((x) => Pv.pvToDisplayString(x));
    eq(shown[0], '(nil)', 'displayed: nil');
    eq(shown[1], '(NoSuchParameter: not on this tool)', 'displayed: NoValue, with its reason');
    eq(shown[2], '', 'displayed: the empty string is empty');
    eq(new Set(shown).size, 3, 'three distinct display strings');
}

/* =====================================================================
 * 4. The parameter/value count mismatch
 * ===================================================================== */
console.log('\n=== 4. Table 19: the count must match ===');
{
    const { r, map } = read(P('a') + P('b') + P('c') + DD('X="0" Y="0"', v('F8', '1') + v('F8', '2')));
    eq(map.deviceData[0].values.length, 2, 'the values are still read - a defect is not a refusal');
    const w = r.warnings.find((x) => x.includes('E142_XML_DEVICEDATA_VALUE_COUNT'));
    ok(w !== undefined, 'and the mismatch warns');
    has(w, 'exactly 3 values - the first has 2', '  stating want and got');
    has(w, 'shall match the order of parameters', '  quoting Table 19');
    has(w, 're-labels every reading after it', '  and naming the real damage');
    has(w, 'do not trust the pairing past the first discrepancy', '  with advice a reader can act on');
}
{
    /* More values than parameters warns the same way - the tail has no names. */
    const { r } = read(P('a') + DD('X="0" Y="0"', v('F8', '1') + v('F8', '2')));
    ok(r.warnings.some((x) => x.includes('E142_XML_DEVICEDATA_VALUE_COUNT')),
        'a surplus value warns too');
}
{
    /* An INVALID value keeps its position rather than being dropped, so the
     * count still matches. This is the whole reason parsePvSet reports instead
     * of skipping: dropping it would have re-labelled everything after it. */
    const { r, map } = read(P('a') + P('b') + DD('X="0" Y="0"', v('F8', 'not-a-number') + v('F8', '2')));
    eq(map.deviceData[0].values.length, 2, 'an invalid value still occupies its slot');
    eq(map.deviceData[0].values[0].value, null, '  reported as null');
    ok(r.warnings.some((x) => x.includes('E138_PV_LEXICAL')), '  and warned about');
    ok(!r.warnings.some((x) => x.includes('E142_XML_DEVICEDATA_VALUE_COUNT')),
        '  so the COUNT still matches - the pairing is intact');
}
{
    const { r } = read(P('a') + DD('X="0" Y="0"', v('F8', '1')));
    ok(!r.warnings.some((x) => x.includes('E142_XML_DEVICEDATA_VALUE_COUNT')),
        'a matching count does not warn');
}

/* =====================================================================
 * 5. The selection join
 * ===================================================================== */
console.log('\n=== 5. the selection join: name to value by INDEX ===');
{
    const pv = v('F8', '42.9') + v('F8', '10.4');
    const { r, sm, map } = read(P('Ball Dia (um)') + P('Ball Height (um)') + DD('X="0" Y="0"', pv));
    const grid = gridOf(r, sm);
    /* Exactly the control's join. */
    const readings = map.deviceData[0].values.map((val, k) => ({
        name: k < map.parameters.length ? map.parameters[k].name : '',
        value: Pv.pvToDisplayString(val),
        raw: val,
    }));
    eq(readings.length, 2, 'two readings');
    eq(readings[0].name, 'Ball Dia (um)', 'name[0] from parameters[0]');
    eq(readings[0].value, '42.9', 'value[0] from values[0]');
    eq(readings[1].name, 'Ball Height (um)', 'name[1] from parameters[1]');
    eq(readings[1].value, '10.4', 'value[1] from values[1]');
    ok(readings[0].raw.kind === 'F8', 'the raw PvValue rides along for programmatic consumers');

    /* And it lands on the right cell, resolved by the same rule as every other
     * per-device join: LID first, then X/Y. */
    const { serCol, serRow } = E142.mapCoordToIndex(
        0, 0, sm.header.originLocation, sm.header.axisDirection, grid.cols, grid.rows);
    eq(grid.binTable[grid.cells[serRow * grid.cols + serCol]].code, 'a',
        'the target cell is the one the BinCodeMap put an "a" in');
}
{
    /* Addressed by LID alone - the 13.3 shape a tape pocket uses. */
    const { r, sm, map } = read(P('p') + DD('LID="C10"', v('F8', '7')));
    const grid = gridOf(r, sm);
    const byLid = new Map();
    for (const [cell, lid] of grid.lids) { if (!byLid.has(lid)) { byLid.set(lid, cell); } }
    const cell = byLid.get(map.deviceData[0].lid);
    ok(cell !== undefined, 'a DeviceData addressed by LID alone resolves through the LID index');
    eq(grid.binTable[grid.cells[cell]].code, 'b', '  onto the cell the BinCodeMap named C10');
}
{
    /* Past the end of the parameter list a value has no name. Shown as empty
     * rather than dropped, so a reader sees there IS an unlabelled reading. */
    const { map } = read(P('only') + DD('X="0" Y="0"', v('F8', '1') + v('F8', '2')));
    const readings = map.deviceData[0].values.map((val, k) => ({
        name: k < map.parameters.length ? map.parameters[k].name : '',
        value: Pv.pvToDisplayString(val),
    }));
    eq(readings[1].name, '', 'a value past the parameter list has an empty name');
    eq(readings[1].value, '2', '  but its value is still shown');
}
{
    /* The control's source really performs this join, and by index. */
    const SRC = readFileSync(new URL('../../../Controls/SubstrateMap/SubstrateMap.ts', import.meta.url), 'utf8');
    ok(SRC.includes('protected __buildDeviceDataIndex('), 'the control builds a device-data index');
    ok(SRC.includes('name: k < names.length ? names[k].name : \'\''),
        '  joining name to value BY INDEX');
    ok(SRC.includes('value: pvToDisplayString(dd.values[k])'), '  rendering the value for display');
    ok(SRC.includes('raw: dd.values[k]'), '  and keeping the raw value beside it');
    ok(SRC.includes('this.__resolveAddressToCell(dd.lid, dd.x, dd.y, header, grid, byLid)'),
        '  resolving the cell with the shared LID-first rule');
}

/* =====================================================================
 * 6. Serialisation and the round trip
 * ===================================================================== */
console.log('\n=== 6. round trip through pvSetToXml ===');
{
    const pv = v('F8', '42.9') + '<ccs:F8 xsi:nil="true"/>'
        + `<ccs:NoValue reasonCode="NoSuchSource">${v('Description', 'probe offline')}</ccs:NoValue>`
        + v('D', '2026-07-29T12:00:00.123456+02:00')
        + `<ccs:Arr><ccs:Su>${v('I2', '23')}${v('I2', '57')}</ccs:Su></ccs:Arr>`;
    const { map } = read(Array.from({ length: 5 }, (_, i) => P(`p${i}`)).join('') + DD('X="0" Y="0"', pv));
    const before = map.deviceData[0].values;
    const xml = Pv.pvSetToXml(before);
    const after = Pv.parsePvSet(stubParseDocument(xml), '/PVSet', () => {});
    deep(after, before, 'the values survive emit -> re-parse UNCHANGED');
    has(xml, '<F8 xsi:nil="true"/>', 'a nil emits as xsi:nil, not as an empty element');
    has(xml, '<D>2026-07-29T12:00:00.123456+02:00</D>', 'D is written back byte-for-byte');
    has(xml, 'reasonCode="NoSuchSource"', 'and the NoValue keeps its reason');
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
