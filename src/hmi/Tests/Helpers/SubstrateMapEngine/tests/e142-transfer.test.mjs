/*
 * e142-transfer.test.mjs - substrate-to-substrate traceability.
 *
 * E142-0225 13.9 and R2-3 make `TransferMap` the whole mechanism for saying
 * where a device came from. R2-3.2.2 describes the chain it records: a die
 * leaves a wafer coordinate for a named tape pocket, then leaves that pocket for
 * a target coordinate. Figure R2-22 labels the two arrows `Transfer(FX,FY,TID)`
 * and `Transfer(FID,TX,TY)` - each END addressed independently, by a coordinate
 * pair or by an identifier.
 *
 * Six families:
 *   1. parse - the three From* attributes and the six per-<T> ones
 *   2. the keyref, satisfied and violated
 *   3. the transfer index, including TID-addressed targets
 *   4. the selection payload
 *   5. round trip through the serializer
 *   6. the dangling-reference omission path
 *
 * Families 3 and 4 are the control's, and the control needs a DOM - so they
 * replay the control's own expressions over a real parsed document and assert
 * that its source performs them. Everything else calls the engine directly.
 *
 * Run: node --test Helpers/SubstrateMapEngine/tests/e142-transfer.test.mjs
 *      npm run test:transfer
 */

import { readFileSync } from 'node:fs';
import { stubParseDocument } from './xml-stub.mjs';
import { onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const E142 = await import(ENGINE + 'E142.js');
const E142Xml = await import(ENGINE + 'E142Xml.js');
const Engine = await import(ENGINE + 'Engine.js');

let validateXsd = null;
try { ({ validateAgainstE142Xsd: validateXsd } = await import('./lib/xsd-validate.mjs')); } catch { validateXsd = null; }

/* ------------------------------ harness ------------------------------ */
let PASS = 0, FAIL = 0, SKIP = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES, skipped: SKIP }));
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
function skip(label) { SKIP++; console.log(`  SKIP  ${label}`); }

/* ------------------------------ fixtures ----------------------------- */
const NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';
/**
 * A document with two source substrates and one target. `sources` defaults to
 * declaring both, because `FromSubstrateMapRef` is an xs:keyref onto
 * `SubstrateMapKey`: a TransferMap whose From* triple names no SubstrateMap in
 * THIS document makes the document invalid, and the parser enforces it.
 */
const SOURCES = [
    '    <SubstrateMap SubstrateType="Wafer" SubstrateId="W-55" LayoutSpecifier=""/>',
    '    <SubstrateMap SubstrateType="TnR" SubstrateId="REEL-7" LayoutSpecifier=""/>',
].join('\n');
const document_ = (provenance, sources = SOURCES, cells = null) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MapData xmlns="${NS}">`,
    '  <Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">',
    '    <Dimension X="2" Y="2"/><StepSize X="1" Y="1" Units="mm"/></Layout></Layouts>',
    '  <SubstrateMaps>',
    sources,
    '    <SubstrateMap SubstrateType="Wafer" SubstrateId="T1" LayoutSpecifier="L"',
    '        OriginLocation="LowerLeft" AxisDirection="UpRight">',
    '      <Overlay MapName="Sort"><BinCodeMap BinType="Ascii" NullBin="." MapType="Coordinate">',
    cells ?? '        <BinCode X="0" Y="0" LID="C00">a</BinCode><BinCode X="1" Y="0" LID="C10">b</BinCode>'
        + '<BinCode X="0" Y="1">c</BinCode><BinCode X="1" Y="1">d</BinCode>',
    '      </BinCodeMap></Overlay>',
    provenance === '' ? '' : `      <Overlay MapName="Prov">${provenance}</Overlay>`,
    '    </SubstrateMap></SubstrateMaps></MapData>',
].filter((l) => l !== '').join('\n');
const tmap = (type, id, spec, ts) =>
    `<TransferMap FromSubstrateType="${type}" FromSubstrateId="${id}" FromSubstrateLayoutSpecifier="${spec}">`
    + ts + '</TransferMap>';

const parse = (xml) => E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
/** Parse -> pick the target -> build its grid. */
function build(xml) {
    const r = parse(xml);
    const sm = r.doc.substrateMaps.find((s) => s.header.substrateId === 'T1');
    const ov = sm.overlays.find((o) => o.payload !== undefined);
    const resolved = E142.resolveLayoutSpecifier(r.doc, sm.header.layoutSpecifier);
    const placement = E142.computeGridPlacement(sm.header, resolved, 0, undefined).placement;
    return { r, sm, grid: Engine.buildGridModel(placement, ov.payload, null) };
}
/** The control's transfer index, replayed. Its source is asserted in family 3. */
function transferIndex(sm, grid) {
    const byLid = grid.lids === undefined ? null : (() => {
        const m = new Map();
        for (const [cell, lid] of grid.lids) { if (!m.has(lid)) { m.set(lid, cell); } }
        return m;
    })();
    const resolve = (lid, x, y) => {
        let byCoord = null;
        if (x !== undefined && y !== undefined) {
            const { serCol, serRow } = E142.mapCoordToIndex(
                x, y, sm.header.originLocation, sm.header.axisDirection, grid.cols, grid.rows);
            byCoord = (serCol >= 0 && serCol < grid.cols && serRow >= 0 && serRow < grid.rows)
                ? serRow * grid.cols + serCol : null;
        }
        const byName = (lid !== undefined && byLid !== null) ? byLid.get(lid) ?? null : null;
        return { cell: byName ?? byCoord, disagreed: byName !== null && byCoord !== null && byName !== byCoord };
    };
    const maps = [];
    for (const ov of sm.overlays) { if (ov.transferMaps !== undefined) { maps.push(...ov.transferMaps); } }
    const index = new Map();
    let unplaceable = 0, disagreed = 0, collided = 0;
    for (const tm of maps) {
        for (const t of tm.transfers) {
            const r = resolve(t.tid, t.tx, t.ty);
            if (r.disagreed) { disagreed++; }
            if (r.cell === null) { unplaceable++; continue; }
            if (index.has(r.cell)) { collided++; continue; }
            const o = {
                fromSubstrateType: tm.fromSubstrateType,
                fromSubstrateId: tm.fromSubstrateId,
                fromLayoutSpecifier: tm.fromLayoutSpecifier,
            };
            if (t.fx !== undefined) { o.fx = t.fx; }
            if (t.fy !== undefined) { o.fy = t.fy; }
            if (t.fid !== undefined) { o.fid = t.fid; }
            index.set(r.cell, o);
        }
    }
    return { index, unplaceable, disagreed, collided };
}
const cellOf = (sm, grid, x, y) => {
    const { serCol, serRow } = E142.mapCoordToIndex(
        x, y, sm.header.originLocation, sm.header.axisDirection, grid.cols, grid.rows);
    return serRow * grid.cols + serCol;
};

/* =====================================================================
 * 1. Parse
 * ===================================================================== */
console.log('\n=== 1. parse ===');
{
    const { r, sm } = build(document_(
        tmap('Wafer', 'W-55', '', '<T FX="12" FY="34" TID="PKT-0042"/><T FX="13" FY="34" TID="PKT-0043"/>')));
    const tms = sm.overlays.flatMap((o) => o.transferMaps ?? []);
    eq(tms.length, 1, 'one TransferMap');
    eq(tms[0].fromSubstrateType, 'Wafer', '@FromSubstrateType');
    eq(tms[0].fromSubstrateId, 'W-55', '@FromSubstrateId');
    eq(tms[0].fromLayoutSpecifier, '', '@FromSubstrateLayoutSpecifier - the empty string is a real value');
    eq(tms[0].transfers.length, 2, 'two <T> children');
    deep(tms[0].transfers[0], { fx: 12, fy: 34, tid: 'PKT-0042' }, 'coordinates in, identifier out');
    eq(r.warnings.length, 0, 'and nothing warns');
}
{
    /* All six, and every subset: the attributes are independent. */
    const cases = [
        ['<T FX="1" FY="2"/>', { fx: 1, fy: 2 }],
        ['<T FID="P"/>', { fid: 'P' }],
        ['<T TX="-3" TY="4"/>', { tx: -3, ty: 4 }],
        ['<T TID="Q"/>', { tid: 'Q' }],
        ['<T FX="1" FY="2" FID="P" TX="3" TY="4" TID="Q"/>', { fx: 1, fy: 2, fid: 'P', tx: 3, ty: 4, tid: 'Q' }],
    ];
    for (const [xml, want] of cases) {
        const { sm } = build(document_(tmap('Wafer', 'W-55', '', xml)));
        deep(sm.overlays.flatMap((o) => o.transferMaps ?? [])[0].transfers[0], want, `${xml} parses`);
    }
}
{
    /* The child is <T>. <Transfer> is the natural guess and produces an EMPTY
     * map rather than an error, which is why the parser reports it. */
    const { r, sm } = build(document_(tmap('Wafer', 'W-55', '', '<Transfer FX="0" FY="0"/>')));
    eq(sm.overlays.flatMap((o) => o.transferMaps ?? [])[0].transfers.length, 0,
        'a <Transfer> child yields no transfers - the element is <T>');
    ok(r.warnings.some((w) => /Transfer/.test(w) && /unknown/i.test(w)),
        '  and is reported as an unknown element, not silently ignored');
}
{
    /* FID/TID are opaque; FX/FY/TX/TY go through the xs:integer validator. */
    const { sm } = build(document_(tmap('Wafer', 'W-55', '', '<T FID="  p/0042  " TID="0007"/>')));
    const t = sm.overlays.flatMap((o) => o.transferMaps ?? [])[0].transfers[0];
    eq(t.fid, '  p/0042  ', 'FID verbatim - never trimmed');
    eq(typeof t.tid, 'string', 'a numeric-looking TID stays a string');
    for (const bad of ['1.0', 'true', '0x10', '']) {
        let err = null;
        try { build(document_(tmap('Wafer', 'W-55', '', `<T FX="${bad}" FY="0"/>`))); } catch (e) { err = e; }
        eq(err && err.code, 'E142_XML_ATTR_INVALID', `FX=${JSON.stringify(bad)} is not an xs:integer`);
    }
}
{
    /* A missing From* attribute WARNS rather than throwing: a TransferMap is
     * carry-only provenance and the <T> endpoints stay readable. */
    const xml = document_(
        '<TransferMap FromSubstrateType="Wafer" FromSubstrateLayoutSpecifier=""><T FX="1" FY="1"/></TransferMap>',
        SOURCES + '\n    <SubstrateMap SubstrateType="Wafer" SubstrateId="" LayoutSpecifier=""/>');
    const { r, sm } = build(xml);
    const tm = sm.overlays.flatMap((o) => o.transferMaps ?? [])[0];
    eq(tm.fromSubstrateId, '', 'a missing @FromSubstrateId is reported as ""');
    eq(tm.transfers.length, 1, '  and the transfers are still read');
    const w = r.warnings.filter((x) => x.includes('E142_XML_TRANSFER_FROM_MISSING'));
    eq(w.length, 1, '  with one warning');
    has(w[0], 'use="required"', '    saying the XSD requires it');
    has(w[0], 'keyref FromSubstrateMapRef', '    and why it matters');
}
{
    const { r } = build(document_(tmap('Wafer', 'W-55', '', '<T FX="0" FY="0"/><T/>')));
    ok(r.warnings.some((w) => w.includes('E142_XML_TRANSFER_EMPTY')),
        'a <T> carrying no attribute at all is reported: it records no movement');
}

/* =====================================================================
 * 2. The keyref, satisfied and violated
 * ===================================================================== */
console.log('\n=== 2. the FromSubstrateMapRef keyref ===');
{
    const xml = document_(tmap('Wafer', 'W-55', '', '<T FX="0" FY="0" TX="0" TY="0"/>'));
    const { r } = build(xml);
    eq(r.warnings.length, 0, 'a reference to a declared SubstrateMap parses clean');
    if (validateXsd === null) { skip('  and validates (helper unavailable)'); }
    else {
        const v = validateXsd(xml);
        if (v.ok === null) { skip(`  and validates (${v.errors[0]})`); }
        else { ok(v.ok === true, `  and xmllint validates it - ${v.errors[0] ?? ''}`); }
    }
}
{
    /* Violated: the triple names no SubstrateMap here. The parser enforces the
     * keyref itself - it does not rely on the caller having run xmllint. */
    let err = null;
    try {
        build(document_(tmap('Wafer', 'NOT-HERE', 'L', '<T FX="0" FY="0"/>')));
    } catch (e) { err = e; }
    ok(err !== null, 'a dangling reference is rejected');
    eq(err && err.code, 'E142_XML_INTEGRITY', '  with E142_XML_INTEGRITY');
    has(err && err.path, '/TransferMap[1]', '  at the offending element');
    has(err && err.message, 'FromSubstrateMapRef', '  naming the constraint');
    has(err && err.message, 'no <SubstrateMap> in this document declares', '  and what is missing');
    ok(!/skipped by decision E-6a/.test(err.message),
        '  and no longer claims the content is skipped - Task 45 parses it');
}
{
    /* All THREE fields are part of the key: matching two is not enough. */
    let err = null;
    try {
        build(document_(tmap('Wafer', 'W-55', 'WRONG-SPEC', '<T FX="0" FY="0"/>')));
    } catch (e) { err = e; }
    eq(err && err.code, 'E142_XML_INTEGRITY',
        'the LayoutSpecifier is part of the key: type and id alone do not resolve');
}

/* =====================================================================
 * 3. The transfer index, including TID-addressed targets
 * ===================================================================== */
console.log('\n=== 3. the transfer index ===');
{
    const { sm, grid } = build(document_(
        tmap('Wafer', 'W-55', '', '<T FX="12" FY="34" TX="0" TY="0"/>')
        + tmap('TnR', 'REEL-7', '', '<T FID="PKT-0042" TID="C10"/>')));
    const { index } = transferIndex(sm, grid);
    eq(index.size, 2, 'both TransferMaps contribute - the source is named per MAP');

    const fromWafer = index.get(cellOf(sm, grid, 0, 0));
    eq(fromWafer.fromSubstrateId, 'W-55', 'the coordinate-targeted transfer indexes its cell');
    eq(fromWafer.fx, 12, '  carrying the source coordinate');
    eq(fromWafer.fid, undefined, '  and no source identifier');

    /* TID resolves through the LID index built in Phase 8. */
    const byTid = [...index.entries()].find(([, o]) => o.fromSubstrateId === 'REEL-7');
    ok(byTid !== undefined, 'the TID-targeted transfer is indexed');
    eq(grid.lids.get(byTid[0]), 'C10', '  onto the cell the BinCodeMap named C10');
    eq(byTid[1].fid, 'PKT-0042', '  carrying the source pocket');
    eq(byTid[1].fx, undefined, '  and no source coordinate - the two forms are alternatives');
}
{
    const { sm, grid } = build(document_(tmap('Wafer', 'W-55', '',
        '<T FX="1" FY="1" TX="0" TY="0"/><T FX="2" FY="2" TX="9" TY="9"/><T FX="3" FY="3"/>')));
    const { index, unplaceable } = transferIndex(sm, grid);
    eq(index.size, 1, 'only the on-grid target is indexed');
    eq(unplaceable, 2, 'an off-grid TX/TY and a targetless <T> are COUNTED, not dropped silently');
}
{
    const { sm, grid } = build(document_(tmap('Wafer', 'W-55', '',
        '<T FX="1" FY="1" TX="0" TY="0"/><T FX="2" FY="2" TX="0" TY="0"/>')));
    const { index, collided } = transferIndex(sm, grid);
    eq(collided, 1, 'two transfers claiming one cell is a collision');
    eq(index.get(cellOf(sm, grid, 0, 0)).fx, 1, '  and the FIRST arrival is kept');
}
{
    const { sm, grid } = build(document_(tmap('Wafer', 'W-55', '',
        '<T FX="0" FY="0" TID="C00" TX="1" TY="0"/>')));
    eq(transferIndex(sm, grid).disagreed, 1, 'a TID and TX/TY naming different cells is detected');
}
{
    /* The control really does all of this - assert the rule, not one spelling. */
    const SRC = readFileSync(new URL('../../../Controls/SubstrateMap/SubstrateMap.ts', import.meta.url), 'utf8');
    ok(SRC.includes('protected __buildTransferIndex('), 'the control builds a transfer index');
    ok(SRC.includes('this.__resolveAddressToCell(t.tid, t.tx, t.ty, header, grid, byLid)'),
        '  resolving the TARGET end by TID then TX/TY');
    ok(SRC.includes('E142_TRANSFER_UNPLACEABLE'), '  and warns about unplaceable targets');
    ok(SRC.includes('E142_TRANSFER_TARGET_COLLISION'), '  about collisions');
    ok(SRC.includes('E142_TRANSFER_ADDRESS_CONFLICT'), '  and about address conflicts');
}

/* =====================================================================
 * 4. The selection payload
 * ===================================================================== */
console.log('\n=== 4. the selection payload ===');
{
    const { sm, grid } = build(document_(
        tmap('Wafer', 'W-55', '', '<T FX="12" FY="34" TX="0" TY="0"/>')
        + tmap('TnR', 'REEL-7', '', '<T FID="PKT-0042" TX="1" TY="0"/>')));
    const { index } = transferIndex(sm, grid);
    /* Exactly the five expressions the control evaluates for a cell. */
    const report = (cell) => {
        const o = index.get(cell) ?? null;
        return {
            fromSubstrateType: o ? o.fromSubstrateType : null,
            fromSubstrateId: o ? o.fromSubstrateId : null,
            fromX: o && o.fx !== undefined ? o.fx : null,
            fromY: o && o.fy !== undefined ? o.fy : null,
            fromLid: o && o.fid !== undefined ? o.fid : null,
        };
    };
    deep(report(cellOf(sm, grid, 0, 0)),
        { fromSubstrateType: 'Wafer', fromSubstrateId: 'W-55', fromX: 12, fromY: 34, fromLid: null },
        'a die off a wafer reports the wafer and the coordinate');
    deep(report(cellOf(sm, grid, 1, 0)),
        { fromSubstrateType: 'TnR', fromSubstrateId: 'REEL-7', fromX: null, fromY: null, fromLid: 'PKT-0042' },
        'a die out of a pocket reports the reel and the pocket');
    deep(report(cellOf(sm, grid, 0, 1)),
        { fromSubstrateType: null, fromSubstrateId: null, fromX: null, fromY: null, fromLid: null },
        'an untransferred cell reports all five as null, together');

    const SRC = readFileSync(new URL('../../../Controls/SubstrateMap/SubstrateMap.ts', import.meta.url), 'utf8');
    for (const f of ['fromSubstrateType', 'fromSubstrateId', 'fromX', 'fromY', 'fromLid']) {
        ok(SRC.includes(`eventData.${f} =`), `onItemSelected sets ${f}`);
        ok(SRC.includes(`entry.${f} =`), `SelectedItems sets ${f}`);
    }
}

/* =====================================================================
 * 5. Round trip through the serializer
 * ===================================================================== */
console.log('\n=== 5. round trip ===');
{
    /* The serializer emits ONE SubstrateMap, keyed (type, id, "L0/L0_Devices"),
     * so only a transfer naming THAT one can be carried - see family 6. */
    const { sm, grid } = build(document_(''));
    const tms = [{
        fromSubstrateType: 'Wafer', fromSubstrateId: 'T1', fromLayoutSpecifier: 'L0/L0_Devices',
        transfers: [{ fx: 3, fy: 7, tid: 'PKT-1' }, { fid: 'PKT-2', tx: 1, ty: 0 },
            { fx: 0, fy: 0, fid: 'P', tx: 1, ty: 1, tid: 'Q' }],
    }];
    const xml = E142Xml.gridToE142Xml(grid, {
        substrateType: 'Wafer', substrateId: 'T1', orientation: sm.header.orientation,
        originLocation: sm.header.originLocation, axisDirection: sm.header.axisDirection,
        binType: 'Ascii', mapName: 'Sort', transferMaps: tms,
    });
    has(xml, '<Overlay MapName="Transfers">', 'transfers get their own overlay (OverlayType is an xs:choice)');
    has(xml, '<T FX="3" FY="7" TID="PKT-1"/>', 'attribute order FX FY FID TX TY TID, absent omitted');
    has(xml, '<T FX="0" FY="0" FID="P" TX="1" TY="1" TID="Q"/>', '  and all six in declaration order');
    if (validateXsd !== null) {
        const v = validateXsd(xml);
        if (v.ok === null) { skip(`  XSD validity (${v.errors[0]})`); }
        else { ok(v.ok === true, `  and the document validates - ${v.errors[0] ?? ''}`); }
    }
    const back = parse(xml);
    const rt = back.doc.substrateMaps[0].overlays.flatMap((o) => o.transferMaps ?? []);
    eq(rt.length, 1, 'one TransferMap re-parses');
    deep(rt[0].transfers, tms[0].transfers, 'every <T> survives exactly');
    eq(rt[0].fromSubstrateId, 'T1', '  and the source triple with it');
    eq(back.warnings.length, 0, '  cleanly');
}
{
    const { grid } = build(document_(''));
    const base = {
        substrateType: 'Wafer', substrateId: 'T1', orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii', mapName: 'Sort',
    };
    eq(E142Xml.gridToE142Xml(grid, base), E142Xml.gridToE142Xml(grid, { ...base, transferMaps: [] }),
        'no transfers: an empty array and undefined produce byte-identical output');
}

/* =====================================================================
 * 6. The dangling-reference omission path
 * ===================================================================== */
console.log('\n=== 6. dangling reference: omit and warn ===');
{
    const { grid } = build(document_(''));
    const warned = [];
    const xml = E142Xml.gridToE142Xml(grid, {
        substrateType: 'Wafer', substrateId: 'T1', orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii', mapName: 'Sort',
        transferMaps: [{
            fromSubstrateType: 'Wafer', fromSubstrateId: 'W-55', fromLayoutSpecifier: '',
            transfers: [{ fx: 1, fy: 1, tx: 0, ty: 0 }],
        }],
        onWarning: (code, message) => warned.push({ code, message }),
    });
    ok(!/TransferMap/.test(xml), 'the unresolvable TransferMap is NOT emitted');
    ok(!/<Overlay MapName="Transfers">/.test(xml), '  and no empty overlay is left behind');
    eq(warned.length, 1, 'exactly one warning');
    eq(warned[0].code, 'E142_XML_TRANSFER_UNRESOLVABLE', '  with a stable code');
    has(warned[0].message, 'FromSubstrateMapRef keyref would dangle', '  naming the constraint');
    has(warned[0].message, '(Wafer, T1, L0/L0_Devices)', '  and the one key that WOULD have resolved');
    has(warned[0].message, 'take the bin codes with it', '  and why omitting beats emitting');
    if (validateXsd !== null) {
        const v = validateXsd(xml);
        if (v.ok === null) { skip('  the document still validates (helper unavailable)'); }
        else {
            ok(v.ok === true, '  and the document STILL VALIDATES - the bin codes survived the drop');
        }
    }
}
{
    /* A mix: keep what resolves, drop what does not. */
    const { grid } = build(document_(''));
    const warned = [];
    const xml = E142Xml.gridToE142Xml(grid, {
        substrateType: 'Wafer', substrateId: 'T1', orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii', mapName: 'Sort',
        transferMaps: [
            { fromSubstrateType: 'Wafer', fromSubstrateId: 'T1', fromLayoutSpecifier: 'L0/L0_Devices',
                transfers: [{ fx: 1, fy: 1, tx: 0, ty: 0 }] },
            { fromSubstrateType: 'TnR', fromSubstrateId: 'REEL-7', fromLayoutSpecifier: '',
                transfers: [{ fid: 'P', tx: 1, ty: 1 }] },
        ],
        onWarning: (code, message) => warned.push(message),
    });
    eq((xml.match(/<TransferMap /g) || []).length, 1, 'one TransferMap emitted');
    ok(/FromSubstrateId="T1"/.test(xml) && !/REEL-7/.test(xml), '  the resolvable one');
    eq(warned.length, 1, 'and one warning');
    has(warned[0], '1 TransferMap was NOT emitted', '  counting the drop precisely');
}

/* ------------------------------- summary ------------------------------ */
console.log('\n========================================================');
console.log(`  RESULT: ${PASS} passed, ${FAIL} failed${SKIP > 0 ? `, ${SKIP} skipped` : ''}`);
if (FAIL > 0) {
    console.log('  FAILURES:');
    for (const f of FAILURES) { console.log('   - ' + f); }
}
console.log('========================================================');
process.exit(FAIL > 0 ? 1 : 0);
