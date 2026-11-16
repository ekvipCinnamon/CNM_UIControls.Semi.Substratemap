/*
 * Copyright 2026 ekvip automation GmbH
 * Licensed under the Apache License, Version 2.0 (see the E142 engine headers).
 */

/**
 * @fileoverview
 * NORMATIVE CONFORMANCE (task F1-V) - assertions taken directly from the licensed
 * SEMI standards, replacing the assumption-sheet vectors they settle. Each block
 * cites the clause it encodes so a future revision can be re-checked against it.
 *
 *  N1. Table A4-1 "Valid XY Range for Coordinate Systems" (E142-0225 Appendix 4).
 *      The complete normative specification of the logical frame: for all 5
 *      OriginLocation x 4 AxisDirection combinations it fixes Xmin/Xmax/Ymin/Ymax
 *      as functions of Columns/Rows (footnote #1: odd Columns/Rows truncate).
 *      Exhaustively verifies zeroCell + axisSigns (ASSUME-A A4.1 and A4.2) - the
 *      Center-with-even-dimensions case included, which the sheets graded [B].
 *      NOTE the table has NO Orientation column: the logical frame is
 *      orientation-INDEPENDENT, which is what settles A3.2 (non-quadrant
 *      Orientation causes no logical relabel; it is a physical rotation only).
 *
 *  N2. The four-MapType equivalence example (E142-0225 A1-2.1 .. A1-2.4): the SAME
 *      map written as 2DArray, Array, Row/Column and Coordinate. Pins the
 *      serialization order (A2) and the Row/Column run model (A5, formerly [C+]
 *      "no complete official example exists" - it does, this is it).
 *
 *  N3. Orientation 90 dimension transpose (A3.1, formerly the single most material
 *      open question). Normative basis: MapType='2DArray' - the row length and row
 *      count "should correspond with the product of the dimensions of the layouts
 *      defined by the LayoutSpecifier attribute, ROTATED TO THE COORDINATE SYSTEM
 *      OF THE SUBSTRATEMAP". Uses a DERIVED fixture (inline below) that is
 *      conformant, unlike the F2' corpus fixture - see OPEN-ISSUES 4.1.
 *
 *  N4. Reference-device Position axes (E142-0225 Table 10 + Table 4). Position is
 *      the offset of the device CENTRE from the SUBSTRATE CENTRE, along the
 *      SUBSTRATEMAP's own X/Y axes - so a rotated or mirrored frame changes the
 *      axes. Guards the F1-V fix to registerPlacementToReferenceDevices.
 *
 *  N5. No-anchor centring (O8 finding 4.3, fixed): the drawn extent must be centred
 *      on the substrate origin, not one row pitch below it.
 *
 * Run: ./typecheck.sh --emit && node Tests/e142-normative.test.mjs
 */

import { stubParseDocument } from './lib/xml-stub.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../Helpers/SubstrateMapEngine/', import.meta.url).href;
const E142 = await import(ENGINE + 'E142.js');
const E142Xml = await import(ENGINE + 'E142Xml.js');
const Engine = await import(ENGINE + 'Engine.js');

let PASS = 0, FAIL = 0; const FAILURES = [];
const ok = (c, l) => { if (c) { PASS++; } else { FAIL++; FAILURES.push(l); console.log('    FAIL: ' + l); } };
const eq = (a, b, l) => ok(a === b, `${l}  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
const close = (a, b, e, l) => ok(Number.isFinite(a) && Math.abs(a - b) <= e, `${l}  (expected ${b}+/-${e}, got ${a})`);
const angClose = (a, b, e = 1e-6) => { let d = Math.abs(((a - b) % 360) + 360) % 360; if (d > 180) { d = 360 - d; } return d <= e; };
const angleDeg = (x, y) => ((Math.atan2(y, x) * 180 / Math.PI) % 360 + 360) % 360;

/* ======================================================================== *
 * N1. Table A4-1 - Valid XY Range for Coordinate Systems  [E142-0225 App. 4]
 * ======================================================================== */
console.log('\n=== N1. Table A4-1 (logical frame, all 20 combinations) ===');
{
    // Transcribed verbatim. Footnote #1: "If Columns or Rows are odd then the
    // result of Columns/2 and Rows/2 is truncated."
    const TABLE = (C, R) => { const c2 = Math.trunc(C / 2), r2 = Math.trunc(R / 2); return {
        'LowerLeft|UpRight':    [0, C - 1, 0, R - 1],
        'UpperLeft|UpRight':    [0, C - 1, -R + 1, 0],
        'LowerRight|UpRight':   [-C + 1, 0, 0, R - 1],
        'UpperRight|UpRight':   [-C + 1, 0, -R + 1, 0],
        'Center|UpRight':       [c2 - C + 1, c2, r2 - R + 1, r2],
        'LowerLeft|DownRight':  [0, C - 1, -R + 1, 0],
        'UpperLeft|DownRight':  [0, C - 1, 0, R - 1],
        'LowerRight|DownRight': [-C + 1, 0, -R + 1, 0],
        'UpperRight|DownRight': [-C + 1, 0, 0, R - 1],
        'Center|DownRight':     [c2 - C + 1, c2, -r2, -r2 + R - 1],
        'LowerLeft|UpLeft':     [-C + 1, 0, 0, R - 1],
        'UpperLeft|UpLeft':     [-C + 1, 0, -R + 1, 0],
        'LowerRight|UpLeft':    [0, C - 1, 0, R - 1],
        'UpperRight|UpLeft':    [0, C - 1, -R + 1, 0],
        'Center|UpLeft':        [-c2, -c2 + C - 1, r2 - R + 1, r2],
        'LowerLeft|DownLeft':   [-C + 1, 0, -R + 1, 0],
        'UpperLeft|DownLeft':   [-C + 1, 0, 0, R - 1],
        'LowerRight|DownLeft':  [0, C - 1, -R + 1, 0],
        'UpperRight|DownLeft':  [0, C - 1, 0, R - 1],
        'Center|DownLeft':      [-c2, -c2 + C - 1, -r2, -r2 + R - 1],
    }; };
    // Sizes chosen to exercise even/odd and asymmetric grids (the Center rows are
    // the ones the sheets could not pin down for EVEN dimensions).
    const SIZES = [[4, 4], [5, 5], [4, 5], [5, 4], [1, 1], [2, 3], [6, 7], [10, 3], [12, 11]];
    let combos = 0;
    for (const [C, R] of SIZES) {
        const tbl = TABLE(C, R);
        for (const key of Object.keys(tbl)) {
            const [origin, dir] = key.split('|');
            const [Xmin, Xmax, Ymin, Ymax] = tbl[key];
            const xs = [], ys = []; let rt = true;
            for (let sr = 0; sr < R; sr++) {
                for (let sc = 0; sc < C; sc++) {
                    const p = E142.indexToMapCoord(sc, sr, origin, dir, C, R);
                    xs.push(p.x); ys.push(p.y);
                    const b = E142.mapCoordToIndex(p.x, p.y, origin, dir, C, R);
                    if (b.serCol !== sc || b.serRow !== sr) { rt = false; }
                }
            }
            const okRange = Math.min(...xs) === Xmin && Math.max(...xs) === Xmax
                         && Math.min(...ys) === Ymin && Math.max(...ys) === Ymax;
            const covers = new Set(xs.map((x, i) => x + ',' + ys[i])).size === C * R;
            ok(okRange, `A4-1 ${C}x${R} ${key}: range X[${Xmin},${Xmax}] Y[${Ymin},${Ymax}]`);
            ok(rt, `A4-1 ${C}x${R} ${key}: logical<->serial round-trip`);
            ok(covers, `A4-1 ${C}x${R} ${key}: covers the full rectangle exactly once`);
            combos++;
        }
    }
    console.log(`  ${combos} (OriginLocation x AxisDirection x size) combinations checked against Table A4-1`);
}

/* ======================================================================== *
 * N2. Four-MapType equivalence  [E142-0225 A1-2.1 .. A1-2.4]
 * ======================================================================== */
console.log('\n=== N2. The four MapType encodings of one map (A1-2) ===');
{
    // The normative example, transcribed. OriginLocation="UpperLeft",
    // AxisDirection="DownRight", BinType="Ascii", NullBin=".".
    const twoD = ['.3.', '312', '221', '312', '211', '.21', '.1.'];
    const array = '.3.312221312211.21.1.';
    const rowcol = [[1, 0, '3'], [0, 1, '312'], [0, 2, '221'], [0, 3, '312'], [0, 4, '211'], [1, 5, '21'], [1, 6, '1']];
    const coord = [[1, 0, '3'], [0, 1, '3'], [1, 1, '1'], [2, 1, '2'], [0, 2, '2'], [1, 2, '2'], [2, 2, '1'],
                   [0, 3, '3'], [1, 3, '1'], [2, 3, '2'], [0, 4, '2'], [1, 4, '1'], [2, 4, '1'],
                   [1, 5, '2'], [2, 5, '1'], [1, 6, '1']];
    const NULL = '.';
    const R = twoD.length, C = twoD[0].length;

    // (a) MapType='Array' is "row major format starting at the top left" -> the
    //     concatenation of the 2DArray rows, in order. [A2]
    eq(array, twoD.join(''), 'A1-2.2 Array == row-major concatenation of the 2DArray rows');
    eq(array.length, C * R, 'A1-2.2 Array length == Columns * Rows');

    // (b) MapType='Row/Column': a run starts at (X,Y) and fills consecutive cells
    //     in +X; its length is the token count (Number is derivable, see (d));
    //     cells no run covers are NullBin. [A5 - formerly [C+], now normative]
    const g1 = Array.from({ length: R }, () => Array(C).fill(NULL));
    for (const [x, y, toks] of rowcol) { for (let i = 0; i < toks.length; i++) { g1[y][x + i] = toks[i]; } }
    eq(g1.map((r) => r.join('')).join('|'), twoD.join('|'), 'A1-2.3 Row/Column runs reproduce the 2DArray');

    // (c) MapType='Coordinate': cell (X,Y) is row Y, column X.
    const g2 = Array.from({ length: R }, () => Array(C).fill(NULL));
    for (const [x, y, t] of coord) { g2[y][x] = t; }
    eq(g2.map((r) => r.join('')).join('|'), twoD.join('|'), 'A1-2.4 Coordinate entries reproduce the 2DArray');

    // (d) Number "is derived from the length of the Values attribute" when omitted.
    ok(rowcol.every(([, , t]) => t.length >= 1), 'A1-2.3 every Row/Column run carries >= 1 token');
    eq(1, '3'.length, 'BinCode/Number: Number=1 matches its 1-token Values');
    eq(3, '312'.length, 'BinCode/Number: Number=3 matches its 3-token Values');

    // (e) The engine decodes the normative 2DArray through the real pipeline and
    //     lands the same tokens at the same LOGICAL coordinates.
    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">',
        '  <SubstrateMaps>',
        '    <SubstrateMap SubstrateType="Wafer" SubstrateId="A1-2" LayoutSpecifier=""',
        '        OriginLocation="UpperLeft" AxisDirection="DownRight">',
        '      <Overlay MapName="BinCodes">',
        '        <BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">',
        ...twoD.map((r) => `          <BinCode>${r}</BinCode>`),
        '        </BinCodeMap>',
        '      </Overlay>',
        '    </SubstrateMap>',
        '  </SubstrateMaps>',
        '</MapData>',
    ].join('\n');
    const parsed = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
    const sm = parsed.doc.substrateMaps[0];
    const ov = sm.overlays.find((o) => o.payload !== undefined);
    const layout = E142.dimsFromPayload(ov.payload);
    const pl = E142.computeGridPlacement(sm.header, layout, 0, undefined).placement;
    const grid = Engine.buildGridModel(pl, ov.payload, null);
    eq(grid.cols, C, 'A1-2 pipeline: cols');
    eq(grid.rows, R, 'A1-2 pipeline: rows');
    let mismatches = 0;
    for (const [x, y, t] of coord) {
        const { serCol, serRow } = E142.mapCoordToIndex(x, y, sm.header.originLocation, sm.header.axisDirection, C, R);
        if (grid.binTable[grid.cells[serRow * C + serCol]].code !== t) { mismatches++; }
    }
    eq(mismatches, 0, 'A1-2 pipeline: every Coordinate entry lands on its logical cell');
    console.log(`  ${C}x${R} normative map: Array/Row-Column/Coordinate all agree with 2DArray; pipeline matches all ${coord.length} coordinate entries`);
}

/* ======================================================================== *
 * N3. Orientation 90 dimension transpose  [E142-0225, MapType='2DArray']
 * ======================================================================== */
console.log('\n=== N3. Orientation 90 layout->map transpose (A3.1) ===');
{
    // DERIVED fixture (not the F2' corpus one, which is non-conformant here - it
    // declares a 5x3 layout at Orientation=90 yet serialises 5 cols x 3 rows; per
    // the 2DArray clause the map must be the layout ROTATED, i.e. 3 cols x 5 rows.
    // This fixture declares the 3x5 LAYOUT that makes the same 5x3 MAP conformant.)
    const xml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">',
        '  <Layouts>',
        '    <Layout LayoutId="Orient90" DefaultUnits="mm" TopLevel="true">',
        '      <Dimension X="3" Y="5"/>',
        '      <StepSize X="2.0" Y="4.0"/>',
        '    </Layout>',
        '  </Layouts>',
        '  <SubstrateMaps>',
        '    <SubstrateMap SubstrateType="Wafer" SubstrateId="ORIENT090" LayoutSpecifier="Orient90" Orientation="90">',
        '      <Overlay MapName="Sort">',
        '        <BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">',
        '          <BinCode>11119</BinCode>',
        '          <BinCode>19111</BinCode>',
        '          <BinCode>11191</BinCode>',
        '        </BinCodeMap>',
        '      </Overlay>',
        '    </SubstrateMap>',
        '  </SubstrateMaps>',
        '</MapData>',
    ].join('\n');
    const parsed = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
    const sm = parsed.doc.substrateMaps[0];
    const ov = sm.overlays.find((o) => o.payload !== undefined);
    // A conformant document must NOT provoke the transpose-mismatch warning.
    const swapWarn = parsed.warnings.filter((w) => w.includes('E142_XML_DIM_ORIENTATION_SWAP'));
    eq(swapWarn.length, 0, 'conformant 90-degree document raises no DIM_ORIENTATION_SWAP warning');
    const resolved = E142.resolveLayoutSpecifier(parsed.doc, sm.header.layoutSpecifier);
    eq(resolved.cols, 3, 'layout declares 3 columns (layout axes)');
    eq(resolved.rows, 5, 'layout declares 5 rows (layout axes)');
    const mf = E142.dimsInMapFrame(resolved, 90);
    eq(mf.cols, 5, 'map frame at Orientation 90: cols == layout rows (transposed)');
    eq(mf.rows, 3, 'map frame at Orientation 90: rows == layout cols (transposed)');
    close(mf.colPitchMm, 4.0, 1e-12, 'map frame at Orientation 90: colPitch == layout stepY (transposed)');
    close(mf.rowPitchMm, 2.0, 1e-12, 'map frame at Orientation 90: rowPitch == layout stepX (transposed)');
    // Payload agrees with the transposed map frame, so a grid builds cleanly...
    const res = E142.computeGridPlacement(sm.header, resolved, 0, undefined);
    const grid = Engine.buildGridModel(res.placement, ov.payload, null);
    eq(grid.cols, 5, 'built grid cols == map frame cols');
    eq(grid.rows, 3, 'built grid rows == map frame rows');
    // ...and its geometry IS now assertable (the corpus fixture had to suppress this).
    const p = res.placement;
    ok(angClose(angleDeg(p.colStepXmm, p.colStepYmm), 90, 1e-4), 'colStep angle == Orientation 90');
    ok(angClose(angleDeg(p.rowStepXmm, p.rowStepYmm), 0, 1e-4), 'rowStep angle == Orientation-90 == 0');
    close(Math.hypot(p.colStepXmm, p.colStepYmm), 4.0, 1e-9, '|colStep| == transposed pitch 4.0 mm');
    close(Math.hypot(p.rowStepXmm, p.rowStepYmm), 2.0, 1e-9, '|rowStep| == transposed pitch 2.0 mm');
    // 0 and 180 must NOT transpose.
    for (const deg of [0, 180]) {
        const m = E142.dimsInMapFrame(resolved, deg);
        eq(m.cols, 3, `Orientation ${deg}: cols not transposed`);
        eq(m.rows, 5, `Orientation ${deg}: rows not transposed`);
    }
    console.log('  layout 3x5 @ Orientation 90 -> map 5x3, pitches swapped, geometry asserted; 0/180 unswapped');
}

/* ======================================================================== *
 * N4. Reference-device Position axes  [E142-0225 Table 10 + Table 4]
 * ======================================================================== */
console.log('\n=== N4. Reference-device Position follows the SubstrateMap axes ===');
{
    const mk = (orientation, dir) => ({
        substrateType: 'Wafer', substrateId: 'W', layoutSpecifier: '', substrateSide: 'TopSide',
        orientation, originLocation: 'LowerLeft', axisDirection: dir,
    });
    const layout = { flavor: 'resolved', cols: 5, rows: 3, stepXmm: 10, stepYmm: 10, unitsToMm: 1, warnings: [] };
    const centre = (pl, hdr, x, y) => {
        const { serCol, serRow } = E142.mapCoordToIndex(x, y, hdr.originLocation, hdr.axisDirection, 5, 3);
        return {
            x: pl.originXmm + (serCol + 0.5) * pl.colStepXmm + (serRow + 0.5) * pl.rowStepXmm,
            y: pl.originYmm + (serCol + 0.5) * pl.colStepYmm + (serRow + 0.5) * pl.rowStepYmm,
        };
    };
    // For every frame, registering a single anchor must land that device's CENTRE
    // on its Position expressed IN THAT FRAME'S AXES. The check re-derives the
    // expected S-frame point independently, from the frame's unit vectors.
    for (const orientation of [0, 90, 180, 270]) {
        for (const dir of ['UpRight', 'DownRight', 'UpLeft', 'DownLeft']) {
            const hdr = mk(orientation, dir);
            const pl = E142.computeGridPlacement(hdr, layout, 0, undefined).placement;
            const pos = { x: 37.5, y: -12.25, units: 'mm' };
            const rd = [{ coordinates: { x: 0, y: 0 }, position: pos }];
            const reg = E142.registerPlacementToReferenceDevices(pl, rd, hdr.originLocation, dir, 5, 3, 1);
            eq(reg.anchorsUsed, 1, `${orientation}/${dir}: one anchor used`);
            // Independent expectation: unit vectors of logical +X / +Y in S.
            const sgn = { UpRight: [1, 1], DownRight: [1, -1], UpLeft: [-1, 1], DownLeft: [-1, -1] }[dir];
            const cl = Math.hypot(pl.colStepXmm, pl.colStepYmm), rl = Math.hypot(pl.rowStepXmm, pl.rowStepYmm);
            const uX = [sgn[0] * pl.colStepXmm / cl, sgn[0] * pl.colStepYmm / cl];
            const uY = [-sgn[1] * pl.rowStepXmm / rl, -sgn[1] * pl.rowStepYmm / rl];
            const wantX = pos.x * uX[0] + pos.y * uY[0];
            const wantY = pos.x * uX[1] + pos.y * uY[1];
            const c = centre(reg.placement, hdr, 0, 0);
            close(c.x, wantX, 1e-9, `${orientation}/${dir}: anchored centre X on the frame's own axes`);
            close(c.y, wantY, 1e-9, `${orientation}/${dir}: anchored centre Y on the frame's own axes`);
        }
    }
    // The default frame must be unchanged by the axis fix (Position == plain S mm).
    {
        const hdr = mk(0, 'UpRight');
        const pl = E142.computeGridPlacement(hdr, layout, 0, undefined).placement;
        const rd = [{ coordinates: { x: 0, y: 0 }, position: { x: 12, y: -7, units: 'mm' } }];
        const reg = E142.registerPlacementToReferenceDevices(pl, rd, 'LowerLeft', 'UpRight', 5, 3, 1);
        const c = centre(reg.placement, hdr, 0, 0);
        close(c.x, 12, 1e-9, 'default frame: Position X is plain S millimetres');
        close(c.y, -7, 1e-9, 'default frame: Position Y is plain S millimetres');
    }
    console.log('  16 frames (4 Orientation x 4 AxisDirection) register onto their own axes; default frame unchanged');
}

/* ======================================================================== *
 * N5. No-anchor centring  [O8 finding 4.3, fixed]
 * ======================================================================== */
console.log('\n=== N5. No-anchor nominal placement centres the DRAWN extent ===');
{
    const hdr = {
        substrateType: 'Wafer', substrateId: 'X', layoutSpecifier: '', substrateSide: 'TopSide',
        orientation: 0, originLocation: 'LowerLeft', axisDirection: 'UpRight',
    };
    for (const [C, R] of [[12, 11], [4, 4], [5, 3], [1, 1]]) {
        const layout = { flavor: 'layoutless', cols: C, rows: R, warnings: [] };
        const pl = E142.computeGridPlacement(hdr, layout, 0, undefined).placement;
        const payload = { cols: C, rows: R, cells: new Uint32Array(C * R).fill(1), codes: ['.', '1'] };
        const grid = Engine.buildGridModel(pl, payload, null);
        const bb = Engine.gridBBox(grid);
        close((bb.minX + bb.maxX) / 2, 0, 1e-9, `${C}x${R}: drawn extent centred on S origin (x)`);
        close((bb.minY + bb.maxY) / 2, 0, 1e-9, `${C}x${R}: drawn extent centred on S origin (y)`);
    }
    console.log('  drawn bbox centre is (0,0) for every tested shape (was one row pitch low)');
}

/* ======================================================================== *
 * N6. Orientation zero reference / notch datum  [E142-0225 Figure A1-2]
 * ======================================================================== */
console.log('\n=== N6. Notch datum vs. Orientation (Figure A1-2) ===');
{
    // Figure A1-2 "Orientation of the Wafer Flat or Notch (Orientation)" shows the
    // grid drawn axis-aligned while the notch moves round the wafer:
    //     Orientation   0 -> notch at  6 o'clock
    //     Orientation  90 -> notch at  9 o'clock
    //     Orientation 180 -> notch at 12 o'clock
    //     Orientation 270 -> notch at  3 o'clock
    // i.e. the notch travels CLOCKWISE as Orientation increases, consistent with
    // the Orientation attribute's own wording ("increases in the right (clockwise)
    // direction from 0"). Equivalently - and this is the form the renderer needs -
    // with the notch pinned at screen 6 o'clock (where `disc-notch` / the wafer
    // presets cut it), the MAP must rotate counter-clockwise by Orientation.
    //
    // The check below pins the notch at S-south and asks where it lands when
    // expressed in the MAP's own basis; that must reproduce the figure exactly.
    const NOTCH_S = [0, -1]; // preset outlines cut the V-notch at 6 o'clock
    const EXPECT = { 0: 270, 90: 180, 180: 90, 270: 0 }; // map-frame angle, deg CCW from map +x
    const CLOCK = { 270: "6 o'clock", 180: "9 o'clock", 90: "12 o'clock", 0: "3 o'clock" };
    const layout = { flavor: 'resolved', cols: 4, rows: 4, stepXmm: 1, stepYmm: 1, warnings: [] };
    for (const orientation of [0, 90, 180, 270]) {
        const hdr = {
            substrateType: 'Wafer', substrateId: 'W', layoutSpecifier: '', substrateSide: 'TopSide',
            orientation, originLocation: 'LowerLeft', axisDirection: 'UpRight',
        };
        const p = E142.computeGridPlacement(hdr, layout, 0, undefined).placement;
        const cl = Math.hypot(p.colStepXmm, p.colStepYmm), rl = Math.hypot(p.rowStepXmm, p.rowStepYmm);
        const east = [p.colStepXmm / cl, p.colStepYmm / cl];    // map +x expressed in S
        const north = [-p.rowStepXmm / rl, -p.rowStepYmm / rl]; // map +y (up) expressed in S
        const e = NOTCH_S[0] * east[0] + NOTCH_S[1] * east[1];
        const n = NOTCH_S[0] * north[0] + NOTCH_S[1] * north[1];
        const got = angleDeg(e, n);
        ok(angClose(got, EXPECT[orientation], 1e-6),
            `Figure A1-2: Orientation ${orientation} puts the notch at ${CLOCK[EXPECT[orientation]]} of the map `
            + `(expected ${EXPECT[orientation]} deg in the map frame, got ${got.toFixed(3)})`);
    }
    // And the offset attribute must be able to reconcile the opposite convention
    // (a source that measures Orientation from a notch at 12 o'clock).
    {
        const hdr = {
            substrateType: 'Wafer', substrateId: 'W', layoutSpecifier: '', substrateSide: 'TopSide',
            orientation: 0, originLocation: 'LowerLeft', axisDirection: 'UpRight',
        };
        const p = E142.computeGridPlacement(hdr, layout, 180, undefined).placement;
        const cl = Math.hypot(p.colStepXmm, p.colStepYmm), rl = Math.hypot(p.rowStepXmm, p.rowStepYmm);
        const e = NOTCH_S[0] * (p.colStepXmm / cl) + NOTCH_S[1] * (p.colStepYmm / cl);
        const n = NOTCH_S[0] * (-p.rowStepXmm / rl) + NOTCH_S[1] * (-p.rowStepYmm / rl);
        ok(angClose(angleDeg(e, n), 90, 1e-6),
            'E142OrientationOffset=180 relocates the datum to a 12 o\'clock notch source');
    }
    console.log("  notch at 6/9/12/3 o'clock for Orientation 0/90/180/270; offset=180 flips the datum");
}

/* ======================================================================== *
 * N7. Figure R2-11 device identity across Orientation  [E142-0225]
 * ======================================================================== */
console.log('\n=== N7. Figure R2-11: the same two devices at every Orientation ===');
{
    // Figure R2-11 shows the SAME two devices indexed under four Orientations,
    // all with AxisDirection="UpRight", OriginLocation="LowerLeft". Read from the
    // figure (upper row of examples):
    //
    //   Orientation |  map  | device A | device B
    //   ------------+-------+----------+---------
    //        0      |  5x4  |  (0,3)   |  (3,2)
    //       90      |  4x5  |  (3,4)   |  (2,1)
    //      180      |  5x4  |  (4,0)   |  (1,1)
    //      270      |  4x5  |  (0,0)   |  (1,3)
    //
    // Those eight coordinates are exactly a CLOCKWISE rotation of the presentation
    // as Orientation increases (with the map frame re-derived from the rotated
    // presentation), which is the same sense Figure A1-2 shows for the notch.
    //
    // THE STRONG CLAIM this section tests: because it is one physical array in one
    // physical pose, a device must land on ONE physical point in the substrate
    // frame S regardless of which Orientation is used to index it. That pins the
    // dimension transpose, the zero cell, the axis signs and the lattice rotation
    // simultaneously - a single wrong sign anywhere breaks the coincidence.
    const FIG = {
        0:   { dims: [5, 4], A: [0, 3], B: [3, 2] },
        90:  { dims: [4, 5], A: [3, 4], B: [2, 1] },
        180: { dims: [5, 4], A: [4, 0], B: [1, 1] },
        270: { dims: [4, 5], A: [0, 0], B: [1, 3] },
    };
    // The physical array: 5 x 4 in LAYOUT axes, deliberately non-square pitch so
    // that a missed transpose shows up as a position error, not just a relabel.
    const layout = { flavor: 'resolved', cols: 5, rows: 4, stepXmm: 2, stepYmm: 1, warnings: [] };
    const centreOf = (p, hdr, C, R, x, y) => {
        const { serCol, serRow } = E142.mapCoordToIndex(x, y, hdr.originLocation, hdr.axisDirection, C, R);
        return [
            p.originXmm + (serCol + 0.5) * p.colStepXmm + (serRow + 0.5) * p.rowStepXmm,
            p.originYmm + (serCol + 0.5) * p.colStepYmm + (serRow + 0.5) * p.rowStepYmm,
        ];
    };
    let refA = null, refB = null;
    for (const orientation of [0, 90, 180, 270]) {
        const hdr = {
            substrateType: 'Wafer', substrateId: 'W', layoutSpecifier: '', substrateSide: 'TopSide',
            orientation, originLocation: 'LowerLeft', axisDirection: 'UpRight',
        };
        const fig = FIG[orientation];
        const mf = E142.dimsInMapFrame(layout, orientation);
        eq(mf.cols, fig.dims[0], `R2-11 Orientation ${orientation}: map cols`);
        eq(mf.rows, fig.dims[1], `R2-11 Orientation ${orientation}: map rows`);
        const p = E142.computeGridPlacement(hdr, layout, 0, undefined).placement;
        const a = centreOf(p, hdr, mf.cols, mf.rows, fig.A[0], fig.A[1]);
        const b = centreOf(p, hdr, mf.cols, mf.rows, fig.B[0], fig.B[1]);
        if (refA === null) { refA = a; refB = b; }
        close(a[0], refA[0], 1e-9, `R2-11 Orientation ${orientation}: device A physical X invariant`);
        close(a[1], refA[1], 1e-9, `R2-11 Orientation ${orientation}: device A physical Y invariant`);
        close(b[0], refB[0], 1e-9, `R2-11 Orientation ${orientation}: device B physical X invariant`);
        close(b[1], refB[1], 1e-9, `R2-11 Orientation ${orientation}: device B physical Y invariant`);
        // The two devices must stay distinct - guards against a degenerate mapping
        // that would make every coordinate coincide trivially.
        ok(Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-6, `R2-11 Orientation ${orientation}: A and B are distinct points`);
    }
    console.log(`  device A -> S(${refA[0].toFixed(3)}, ${refA[1].toFixed(3)}), device B -> S(${refB[0].toFixed(3)}, ${refB[1].toFixed(3)}) at all four Orientations`);
}

/* -------------------------------- summary -------------------------------- */
console.log('\n========================================================');
console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) { console.log('  FAILURES:'); for (const f of FAILURES) { console.log('   - ' + f); } }
console.log('========================================================');
process.exit(FAIL > 0 ? 1 : 0);
