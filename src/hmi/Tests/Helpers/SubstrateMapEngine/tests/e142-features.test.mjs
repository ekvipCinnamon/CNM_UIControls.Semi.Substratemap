/*
 * Copyright 2026 ekvip automation GmbH
 * Licensed under the Apache License, Version 2.0 (see the E142 engine headers).
 */

/**
 * @fileoverview
 * Feature tests for the three post-O8 additions (decisions E-6b / E-4 / E-7):
 *
 *  A. DeviceIdMap -> cell lookup. Parses a document carrying a BinCodeMap render
 *     overlay AND a DeviceIdMap overlay (sparse <Id X Y|LID>), and verifies the
 *     parsed entries and the frame-mapped cell -> device-id index the control
 *     builds (this test replays that thin index build - mapCoordToIndex per entry
 *     - against the engine's parse output; the control's __buildDeviceIdIndex and
 *     the SelectionEntry.deviceId wiring are the same primitives, typechecked).
 *
 *  B. Export round-trip. gridToGridData / gridToE142Xml are the inverses of
 *     normalizeGridData / parseE142Xml; a built grid, exported and re-imported,
 *     must reproduce the same cells / dimensions / histogram. Covered for the
 *     Ascii (2DArray) and a numeric (Coordinate) payload form, and across an
 *     orientation and an anchored source (cells are frame-invariant; the absolute
 *     anchor is deliberately not round-tripped - see gridToGridData's contract).
 *
 *  C. Reference-device registration. registerPlacementToReferenceDevices shifts a
 *     placement so reference-device model cell-centres meet their Positions:
 *     single-anchor (exact), two-anchor (mean translation), off-grid, no-anchor,
 *     and unit handling (per-Position Units and the DefaultUnits fallback).
 *
 * Engine .js is imported after a TcHmi shim (the classic-name bridges touch the
 * bare global at evaluation time); run `./typecheck.sh --emit` first.
 */

import { stubParseDocument } from './xml-stub.mjs';
import { onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const HERE = new URL('.', import.meta.url).pathname;
const ENGINE = HERE + '../';
const asUrl = (p) => 'file://' + p;
const E142 = await import(asUrl(ENGINE + 'E142.js'));
const E142Xml = await import(asUrl(ENGINE + 'E142Xml.js'));
const E142Grid = await import(asUrl(ENGINE + 'E142Grid.js'));
const Engine = await import(asUrl(ENGINE + 'Engine.js'));

/* --------------------------- assertion harness --------------------------- */
let PASS = 0;
let FAIL = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES }));
function ok(cond, label) {
    if (cond) { PASS++; } else { FAIL++; FAILURES.push(label); console.log('    FAIL: ' + label); }
}
function eq(a, b, label) { ok(a === b, `${label}  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`); }
function close(a, b, eps, label) { ok(Number.isFinite(a) && Math.abs(a - b) <= eps, `${label}  (expected ${b}+/-${eps}, got ${a})`); }

/* ----------------------------- shared helpers ---------------------------- */
const toEngineBinDefinition = (d) => ({ code: d.binCode, quality: d.binQuality, pick: d.pick });

/** normalizeGridData -> placement -> grid, returning what export needs. */
function buildFromGridData(gd) {
    const n = E142Grid.normalizeGridData(gd);
    const pr = E142.computeGridPlacement(n.header, n.resolvedLayout, 0, undefined);
    const grid = Engine.buildGridModel(pr.placement, n.payload, n.binDefs ? n.binDefs.map(toEngineBinDefinition) : null);
    return { grid, header: n.header, binType: gd.binType, binDefs: n.binDefs };
}

/** parseE142Xml -> first renderable overlay -> placement -> grid (mirrors the control). */
function buildFromXml(xml) {
    const parsed = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
    const doc = parsed.doc;
    let header = null;
    let overlay = null;
    let sm = null;
    for (const s of doc.substrateMaps) {
        for (const ov of s.overlays) {
            if (ov.payload !== undefined) { header = s.header; overlay = ov; sm = s; break; }
        }
        if (overlay) { break; }
    }
    if (!overlay) { return { grid: null, header: null, doc, sm }; }
    const resolved = E142.resolveLayoutSpecifier(doc, header.layoutSpecifier);
    if (resolved instanceof E142.E142Error) { throw resolved; }
    const layout = resolved !== null ? resolved : E142.dimsFromPayload(overlay.payload);
    const pr = E142.computeGridPlacement(header, layout, 0, undefined);
    const grid = Engine.buildGridModel(pr.placement, overlay.payload, overlay.binDefinitions ? overlay.binDefinitions.map(toEngineBinDefinition) : null);
    return { grid, header, overlay, doc, sm, placement: pr.placement, layout };
}

/** Column-by-column cell equality of two grids (via the token strings). */
function sameCells(g1, g2, label) {
    if (g1.cols !== g2.cols || g1.rows !== g2.rows) {
        ok(false, `${label}: dims (${g1.cols}x${g1.rows} vs ${g2.cols}x${g2.rows})`);
        return;
    }
    let diff = 0;
    for (let i = 0; i < g1.cols * g1.rows; i++) {
        if (g1.binTable[g1.cells[i]].code !== g2.binTable[g2.cells[i]].code) { diff++; }
    }
    ok(diff === 0, `${label}: ${diff} cell token(s) differ after round-trip`);
}

/** Replays the control's __buildDeviceIdIndex over parsed entries + a grid frame. */
function buildDeviceIdIndex(entries, header, cols, rows) {
    const index = new Map();
    let unplaceable = 0;
    for (const e of entries) {
        if (e.x === undefined || e.y === undefined) { unplaceable++; continue; }
        const { serCol, serRow } = E142.mapCoordToIndex(e.x, e.y, header.originLocation, header.axisDirection, cols, rows);
        if (!(serCol >= 0 && serCol < cols && serRow >= 0 && serRow < rows)) { unplaceable++; continue; }
        index.set(serRow * cols + serCol, e.deviceId);
    }
    return { index, unplaceable };
}

/* ======================================================================== *
 * A. DeviceIdMap -> cell lookup (decision E-6b)
 * ======================================================================== */
console.log('\n=== A. DeviceIdMap -> cell lookup ===');
{
    // 3x3 render overlay (all '1'); a DeviceIdMap with three on-grid ids, one
    // LID-only (unplaceable) and one off-grid (unplaceable). Layoutless (dims
    // from payload); LowerLeft / UpRight default frame.
    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">',
        '  <SubstrateMaps>',
        '    <SubstrateMap SubstrateType="Wafer" SubstrateId="W1" LayoutSpecifier="" OriginLocation="LowerLeft" AxisDirection="UpRight">',
        '      <Overlay MapName="Grade">',
        '        <BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">',
        '          <BinCode>111</BinCode><BinCode>111</BinCode><BinCode>111</BinCode>',
        '        </BinCodeMap>',
        '      </Overlay>',
        '      <Overlay MapName="Devices">',
        '        <DeviceIdMap>',
        '          <Id X="0" Y="0">Foo-000</Id>',
        '          <Id X="1" Y="2">Bar-120</Id>',
        '          <Id X="2" Y="1">Baz-210</Id>',
        '          <Id LID="Layout_A">Lid-only</Id>',
        '          <Id X="9" Y="9">Off-grid</Id>',
        '        </DeviceIdMap>',
        '      </Overlay>',
        '    </SubstrateMap>',
        '  </SubstrateMaps>',
        '</MapData>',
    ].join('\n');

    const built = buildFromXml(xml);
    ok(built.grid !== null, 'A: render grid built');
    eq(built.grid.cols, 3, 'A: cols');
    eq(built.grid.rows, 3, 'A: rows');

    // The DeviceIdMap overlay parsed into deviceIdEntries.
    const dev = built.sm.overlays.find((o) => o.deviceIdEntries !== undefined);
    ok(dev !== undefined, 'A: DeviceIdMap overlay parsed (deviceIdEntries present)');
    eq(dev.deviceIdEntries.length, 5, 'A: five <Id> entries');
    eq(dev.deviceIdEntries[0].x, 0, 'A: entry0.x');
    eq(dev.deviceIdEntries[0].y, 0, 'A: entry0.y');
    eq(dev.deviceIdEntries[0].deviceId, 'Foo-000', 'A: entry0.deviceId');
    eq(dev.deviceIdEntries[3].x, undefined, 'A: LID-only entry has no X');
    eq(dev.deviceIdEntries[3].lid, 'Layout_A', 'A: LID-only entry keeps LID');

    // The frame-mapped index the control builds.
    const { index, unplaceable } = buildDeviceIdIndex(dev.deviceIdEntries, built.header, 3, 3);
    eq(unplaceable, 2, 'A: two unplaceable (LID-only + off-grid)');
    // logical (0,0) LowerLeft/UpRight -> serCol 0, serRow 2 -> linear 6.
    const at = (x, y) => {
        const { serCol, serRow } = E142.mapCoordToIndex(x, y, built.header.originLocation, built.header.axisDirection, 3, 3);
        return index.get(serRow * 3 + serCol);
    };
    eq(at(0, 0), 'Foo-000', 'A: lookup logical (0,0)');
    eq(at(1, 2), 'Bar-120', 'A: lookup logical (1,2)');
    eq(at(2, 1), 'Baz-210', 'A: lookup logical (2,1)');
    eq(at(2, 2), undefined, 'A: cell with no <Id> -> undefined');
    console.log(`  parsed 5 <Id> entries; 3 placed, 2 unplaceable; lookups by logical coord OK`);
}

/* ======================================================================== *
 * B. Export round-trip (decision E-4)
 * ======================================================================== */
console.log('\n=== B. Export round-trip (GridData + E142 XML) ===');

/** Round-trips one source grid through both exporters and checks cell equality. */
function roundTrip(label, gd) {
    const src = buildFromGridData(gd);
    const opts = {
        orientation: src.header.orientation,
        originLocation: src.header.originLocation,
        axisDirection: src.header.axisDirection,
        binType: src.binType,
        substrateId: gd.substrateId ?? null,
        binDefinitions: src.binDefs && src.binDefs.length ? src.binDefs : null,
    };
    // GridData round-trip.
    const gd2 = E142Grid.gridToGridData(src.grid, opts);
    const rt1 = buildFromGridData(gd2);
    sameCells(src.grid, rt1.grid, `${label} [GridData]`);
    // XML round-trip (re-parse via the stub).
    const xml2 = E142Xml.gridToE142Xml(src.grid, { ...opts, substrateType: 'Wafer' });
    const rt2 = buildFromXml(xml2);
    ok(rt2.grid !== null, `${label} [XML]: re-parsed a grid`);
    if (rt2.grid) { sameCells(src.grid, rt2.grid, `${label} [XML]`); }
    // Report which payload form the exporter chose.
    console.log(`  ${label}: GridData mapType=${gd2.mapType}, XML round-trip ${rt2.grid ? 'OK' : 'FAILED'}`);
}

// B1: Ascii, 2DArray, mixed tokens, orientation 0, LowerLeft/UpRight.
roundTrip('B1 Ascii 5x3', {
    dimension: { x: 5, y: 3 }, units: 'mm', stepSize: { x: 1, y: 1 },
    binType: 'Ascii', nullBin: '.', mapType: '2DArray',
    bins: ['1.9.1', '11111', '9.1.9'], substrateId: 'A1',
    binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
});

// B2: numeric (Integer2) -> exercises the Coordinate export branch, with a NullBin.
roundTrip('B2 Integer2 4x2', {
    dimension: { x: 4, y: 2 }, units: 'mm', stepSize: { x: 2, y: 2 },
    binType: 'Integer2', nullBin: '0000', mapType: '2DArray',
    bins: ['0001', '0002', 'FFFF', '0000', '0001', '0009', '0001', '0001'].reduce((rows, tok, i) => {
        // build two rows of four 4-hex tokens (concatenated 2DArray form)
        const r = Math.floor(i / 4); rows[r] = (rows[r] || '') + tok; return rows;
    }, []),
});

// B3: orientation 180 + a different frame (UpperRight/DownLeft); cells are frame-invariant.
roundTrip('B3 Ascii orient180 frame', {
    dimension: { x: 4, y: 3 }, units: 'mm', stepSize: { x: 3, y: 4 }, orientation: 180,
    originLocation: 'UpperRight', axisDirection: 'DownLeft',
    binType: 'Ascii', nullBin: '.', mapType: '2DArray',
    bins: ['1.19', '9.1.', '1191'],
});

// B4: anchored source (lowerLeft) - the anchor is NOT round-tripped, but cells are.
roundTrip('B4 Ascii anchored', {
    dimension: { x: 3, y: 3 }, units: 'mm', stepSize: { x: 1, y: 1 }, lowerLeft: { x: -5, y: -5 },
    binType: 'Ascii', nullBin: '.', mapType: '2DArray',
    bins: ['1.1', '.9.', '1.1'],
});

/* ======================================================================== *
 * C. Reference-device registration (decision E-7, opt-in)
 * ======================================================================== */
console.log('\n=== C. Reference-device registration ===');
{
    // A 5x3 grid at 10 mm pitch, LowerLeft/UpRight, orientation 0.
    const header = {
        substrateType: 'Wafer', substrateId: 'W', layoutSpecifier: '', substrateSide: 'TopSide',
        orientation: 0, originLocation: 'LowerLeft', axisDirection: 'UpRight',
    };
    const layout = { flavor: 'resolved', cols: 5, rows: 3, stepXmm: 10, stepYmm: 10, unitsToMm: 1, warnings: [] };
    const placement = E142.computeGridPlacement(header, layout, 0, undefined).placement;

    // Model cell-centre of a logical coordinate under this placement.
    const modelCenter = (pl, x, y) => {
        const { serCol, serRow } = E142.mapCoordToIndex(x, y, header.originLocation, header.axisDirection, 5, 3);
        return {
            x: pl.originXmm + (serCol + 0.5) * pl.colStepXmm + (serRow + 0.5) * pl.rowStepXmm,
            y: pl.originYmm + (serCol + 0.5) * pl.colStepYmm + (serRow + 0.5) * pl.rowStepYmm,
        };
    };

    // C1: single anchor is EXACT - after registration, (0,0)'s centre == its Position.
    {
        const target = { x: 123.5, y: -47.0 };
        const rd = [{ coordinates: { x: 0, y: 0 }, position: { x: target.x, y: target.y, units: 'mm' } }];
        const reg = E142.registerPlacementToReferenceDevices(placement, rd, header.originLocation, header.axisDirection, 5, 3, 1);
        eq(reg.anchorsUsed, 1, 'C1: one anchor used');
        const c = modelCenter(reg.placement, 0, 0);
        close(c.x, target.x, 1e-9, 'C1: (0,0) centre X == Position X');
        close(c.y, target.y, 1e-9, 'C1: (0,0) centre Y == Position Y');
    }

    // C2: two anchors -> mean translation. The applied shift is the mean of the
    // two required shifts; verify against an independent hand computation.
    {
        const rd = [
            { coordinates: { x: 0, y: 0 }, position: { x: 0, y: 0, units: 'mm' } },
            { coordinates: { x: 4, y: 2 }, position: { x: 40, y: 20, units: 'mm' } },
        ];
        const before0 = modelCenter(placement, 0, 0);
        const before4 = modelCenter(placement, 4, 2);
        const shiftX = ((0 - before0.x) + (40 - before4.x)) / 2;
        const shiftY = ((0 - before0.y) + (20 - before4.y)) / 2;
        const reg = E142.registerPlacementToReferenceDevices(placement, rd, header.originLocation, header.axisDirection, 5, 3, 1);
        eq(reg.anchorsUsed, 2, 'C2: two anchors used');
        close(reg.placement.originXmm - placement.originXmm, shiftX, 1e-9, 'C2: applied shift X == mean of residuals');
        close(reg.placement.originYmm - placement.originYmm, shiftY, 1e-9, 'C2: applied shift Y == mean of residuals');
    }

    // C3: off-grid anchor is ignored; with no usable anchor the placement is unchanged.
    {
        const rd = [{ coordinates: { x: 99, y: 99 }, position: { x: 1, y: 1, units: 'mm' } }];
        const reg = E142.registerPlacementToReferenceDevices(placement, rd, header.originLocation, header.axisDirection, 5, 3, 1);
        eq(reg.anchorsUsed, 0, 'C3: off-grid anchor not used');
        ok(reg.warnings.some((w) => w.code === 'E142_REGISTER_ANCHOR_OFF_GRID'), 'C3: off-grid warning');
        ok(reg.warnings.some((w) => w.code === 'E142_REGISTER_NO_ANCHOR'), 'C3: no-anchor warning');
        eq(reg.placement.originXmm, placement.originXmm, 'C3: origin X unchanged');
        eq(reg.placement.originYmm, placement.originYmm, 'C3: origin Y unchanged');
    }

    // C4: a reference device with no Position contributes nothing.
    {
        const rd = [{ coordinates: { x: 0, y: 0 } }];
        const reg = E142.registerPlacementToReferenceDevices(placement, rd, header.originLocation, header.axisDirection, 5, 3, 1);
        eq(reg.anchorsUsed, 0, 'C4: Position-less device not used');
    }

    // C5: unit handling. A Position in 'um' is converted; and a unit-less Position
    // uses the DefaultUnits factor (here 'um' => 0.001 mm/unit).
    {
        // (0,0) centre in mm under the base placement:
        const base = modelCenter(placement, 0, 0);
        // Per-Position units: 'um', value chosen so target mm == base (round-trips to zero shift).
        const rdUm = [{ coordinates: { x: 0, y: 0 }, position: { x: base.x * 1000, y: base.y * 1000, units: 'um' } }];
        const regUm = E142.registerPlacementToReferenceDevices(placement, rdUm, header.originLocation, header.axisDirection, 5, 3, 1);
        close(regUm.placement.originXmm, placement.originXmm, 1e-6, 'C5: um Position converts (zero net shift)');

        // Unit-less Position + defaultUnitsToMm = 0.001 (um): same target, no per-Position units.
        const rdDefault = [{ coordinates: { x: 0, y: 0 }, position: { x: base.x * 1000, y: base.y * 1000 } }];
        const regDef = E142.registerPlacementToReferenceDevices(placement, rdDefault, header.originLocation, header.axisDirection, 5, 3, 0.001);
        close(regDef.placement.originXmm, placement.originXmm, 1e-6, 'C5: unit-less Position uses DefaultUnits factor');
    }
    console.log('  single-anchor exact, two-anchor mean, off-grid/no-anchor/no-position, unit + DefaultUnits handling OK');
}

/* ======================================================================== *
 * D. Stream-21 item decoding (E142.4 transfer path)
 * ======================================================================== */
console.log('\n=== D. Stream-21 item bytes -> text (base64 / number[]) ===');
{
    const Item = await import(asUrl(ENGINE + 'E142Item.js'));
    const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    // D1: the base64 decoder is hand-rolled (no atob/Buffer dependency in the
    // engine) AND single-pass for speed, so it is differentially tested against a
    // reference encoder across every short length and several large blobs. A
    // decoder that is fast but wrong would corrupt a map silently.
    let lenOk = 0;
    for (let n = 1; n <= 300; n++) {
        const src = new Uint8Array(n);
        for (let i = 0; i < n; i++) { src[i] = (i * 37 + n * 11) & 0xff; }
        const got = Item.itemToBytes(Buffer.from(src).toString('base64'));
        if (eqBytes(Array.from(got), Array.from(src))) { lenOk++; }
    }
    eq(lenOk, 300, 'D1: base64 round-trips exactly for every length 1..300');
    for (const n of [1000, 65537, 1048576]) {
        const src = new Uint8Array(n);
        for (let i = 0; i < n; i++) { src[i] = (i * 2654435761) & 0xff; }
        const got = Item.itemToBytes(Buffer.from(src).toString('base64'));
        ok(eqBytes(Array.from(got), Array.from(src)), `D1: base64 round-trips a ${n}-byte blob`);
    }
    // D2: PEM-style line wrapping and the URL-safe alphabet are accepted.
    {
        const src = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const wrapped = Buffer.from(src).toString('base64').replace(/(.{4})/g, '$1\n  ');
        ok(eqBytes(Array.from(Item.itemToBytes(wrapped)), Array.from(src)), 'D2: whitespace inside base64 is ignored');
        const src2 = Uint8Array.from([251, 255, 254, 253, 252, 190]);
        const url = Buffer.from(src2).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
        ok(eqBytes(Array.from(Item.itemToBytes(url)), Array.from(src2)), 'D2: URL-safe alphabet is accepted');
    }
    // D3: malformed input still raises the documented code (the fast path must not
    // have traded error reporting for speed).
    for (const [bad, why] of [['QQ==QQ', 'data after padding'], ['QUJD*', 'invalid character'], ['QUJDQ', 'invalid length']]) {
        try { Item.itemToBytes(bad); ok(false, `D3: '${bad}' (${why}) should throw`); }
        catch (e) { eq(e.code, 'E142_ITEM_BASE64', `D3: '${bad}' (${why}) raises E142_ITEM_BASE64`); }
    }
    try { Item.itemToBytes(''); ok(false, 'D3: empty item should throw'); }
    catch (e) { eq(e.code, 'E142_ITEM_EMPTY', 'D3: an empty item raises E142_ITEM_EMPTY'); }
    // D4: both accepted forms yield identical bytes and identical decoded text -
    // per E142.4 the reassembled item IS the E142.1 XML document, format 10 binary.
    {
        const xml = '<?xml version="1.0" encoding="utf-8"?>\n<MapData/>';
        const bytes = new TextEncoder().encode(xml);
        const fromB64 = Item.itemToBytes(Buffer.from(bytes).toString('base64'));
        const fromArr = Item.itemToBytes(Array.from(bytes));
        ok(eqBytes(Array.from(fromB64), Array.from(fromArr)), 'D4: base64 and number[] forms agree');
        eq(Item.decodeItemText(fromB64).text, xml, 'D4: decoded text is the original XML');
    }
    console.log('  base64 decoder verified against a reference across 300 lengths + 1 MB blobs; error codes preserved');
}

/* -------------------------------- summary -------------------------------- */
console.log('\n========================================================');
console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { console.log('  FAILURES:'); for (const f of FAILURES) { console.log('   - ' + f); } }
console.log('========================================================');
process.exit(FAIL > 0 ? 1 : 0);
