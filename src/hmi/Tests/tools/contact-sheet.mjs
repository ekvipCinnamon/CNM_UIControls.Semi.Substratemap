#!/usr/bin/env node
/*
 * contact-sheet.mjs - the one Tier-3 review artefact in this spec (LOD Task 29).
 *
 * ============================================================================
 *  Seven WM-811K patterns x four aggregation factors x two reducers, on one
 *  sheet, labelled. 56 renders of the SAME wafer at four zooms, so the columns
 *  are comparable down their length and the rows across their width.
 *
 *  The sheet must show the failure mode Task 17 exists to avoid, not hide it:
 *  Random under MaxSeverity at factor 50 should be a solid field, and if it is
 *  not then either the fixture or the reducer is wrong. A contact sheet that
 *  only shows the feature working is a screenshot, not a review.
 * ============================================================================
 *
 * No canvas and no font library: the tiles come from the real engine through the
 * test shims, and the labels from a 5x7 bitmap font defined below. Written as a
 * PNG by hand - zlib is in Node, and the alternative was a dependency for one
 * image.
 */
import {  } from 'node:zlib';
import {  } from 'node:fs';

const ROOT = new URL('../', import.meta.url).href;
const S = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs');
S.installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import(ROOT + 'Helpers/SubstrateMapEngine/Engine.js');
const Agg = await import(ROOT + 'Helpers/SubstrateMapEngine/GridAggregate.js');
const W = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/patterns.mjs');

const Sheet = await import(new URL('./lib/sheet.mjs', import.meta.url).href);

/* ------------------------------------------------------------------ render */

const PLACEMENT = { originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
    rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false };
const COLORS = { bg: '#000000', body: 'rgb(220, 220, 220)', edge: 'rgb(110, 110, 110)',
    selection: 'rgb(0, 90, 200)', unknown: 'rgb(110, 110, 110)',
    binPass: 'rgb(0, 158, 115)', binFail: 'rgb(213, 94, 0)' };

const SIDE = 512;                       // one wafer, four zooms
const FACTORS = [2, 6, 20, 50];         // AREA factors, per D-078
const REDUCERS = ['MaxSeverity', 'FailFraction'];
const CELL = 176;                       // display box per tile
const PAD = 10;
const ROWHDR = 132;
const COLHDR = 46;
const TITLE = 74;

/**
 * One render.
 * @param pattern The WM-811K pattern.
 * @param factor  Cells per device pixel, by area.
 * @param reducer Which reduction.
 * @returns `{ words, side, saturation, failWord }`.
 */
function tile(pattern, factor, reducer) {
    const w = W.wafer(pattern, { size: SIDE, failRate: 0.02, seed: 21 });
    const grid = Engine.buildGridModel(PLACEMENT,
        { cols: w.cols, rows: w.rows, cells: w.cells, codes: w.codes }, w.binDefs);
    const paint = Engine.buildGridPaint(grid, null, COLORS, S.makeContext2D(8, 8));
    paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
    const scale = 1 / Math.sqrt(factor);
    const side = Math.max(4, Math.round(SIDE * scale));
    const ctx = S.makeContext2D(side, side);
    const sat = Engine.renderGridLayer(ctx, grid,
        new S.DOMMatrix([scale, 0, 0, scale, 0, 0]), paint, side, side, true, reducer);
    return {
        words: new Uint32Array(ctx.pixels.buffer),
        side,
        saturation: sat,
        failWord: paint.aggregate.bySeverity[Engine.SEVERITY_FAIL] >>> 0,
        rate: w.failRate,
    };
}

const COLS = FACTORS.length * REDUCERS.length;
const width = ROWHDR + COLS * (CELL + PAD) + PAD;
const height = TITLE + COLHDR + W.PATTERNS.length * (CELL + PAD) + PAD + 30;
const sheet = new Sheet.Sheet(width, height, [22, 22, 26]);
const INK = [232, 232, 236];
const DIM = [150, 150, 158];
const RULE = [58, 58, 66];

sheet.text('SUBSTRATEMAP AGGREGATION CONTACT SHEET', PAD, 16, INK, 3);
sheet.text(`${SIDE}X${SIDE} WAFER  2% FAIL  SEED 21  -  ONE WAFER AT FOUR ZOOMS, BOTH REDUCERS`,
    PAD, 44, DIM, 2);

let cx = ROWHDR;
for (const reducer of REDUCERS) {
    for (const factor of FACTORS) {
        sheet.text(reducer === 'MaxSeverity' ? 'MAXSEVERITY' : 'FAILFRACTION',
            cx + (CELL - Sheet.Sheet.width(reducer === 'MaxSeverity' ? 'MAXSEVERITY' : 'FAILFRACTION', 2)) / 2,
            TITLE + 4, reducer === 'MaxSeverity' ? INK : DIM, 2);
        const f = `FACTOR ${factor}`;
        sheet.text(f, cx + (CELL - Sheet.Sheet.width(f, 2)) / 2, TITLE + 22, DIM, 2);
        cx += CELL + PAD;
    }
    sheet.rect(cx - PAD / 2 - 1, TITLE, 2, height - TITLE - 34, RULE);
}

const report = [];
let cy = TITLE + COLHDR;
for (const pattern of W.PATTERNS) {
    sheet.text(pattern.replace('-', '-'), PAD, cy + CELL / 2 - 7, INK, 2);
    let x = ROWHDR;
    for (const reducer of REDUCERS) {
        for (const factor of FACTORS) {
            const t = tile(pattern, factor, reducer);
            sheet.rect(x - 1, cy - 1, CELL + 2, CELL + 2, RULE);
            sheet.blit(t.words, t.side, t.side, x, cy, CELL);
            const lbl = `F${factor} ${t.side}PX`;
            sheet.text(lbl, x + 3, cy + CELL - 10, DIM, 1);
            report.push({ pattern, factor, reducer, saturation: t.saturation, rate: t.rate,
                words: t.words, failWord: t.failWord, side: t.side });
            x += CELL + PAD;
        }
    }
    cy += CELL + PAD;
}
sheet.text('FACTOR IS CELLS PER DEVICE PIXEL BY AREA (D-078).  TILE SIDE SHOWN PER CELL.',
    PAD, height - 24, DIM, 2);

const OUT = '/mnt/user-data/outputs/aggregation-contact-sheet.png';
Sheet.writePng(OUT, sheet);

/* ------------------------------------------------- the sheet's own checks */

/** @param r A report row. @returns Painted pixel count. */
const painted = (r) => [...r.words].filter((w) => (w >>> 24) !== 0).length;
/** @param r A report row. @returns Pixels at the aggregate fail swatch. */
const failPx = (r) => [...r.words].filter((w) => (w >>> 0) === r.failWord).length;

console.log(`  wrote ${OUT}  ${sheet.w} x ${sheet.h}`);
console.log();
console.log('  DONE-WHEN 2 — Scratch is continuous under MaxSeverity at every factor');
for (const f of FACTORS) {
    const r = report.find((q) => q.pattern === 'Scratch' && q.factor === f
        && q.reducer === 'MaxSeverity');
    console.log(`    factor ${String(f).padStart(2)}: ${String(failPx(r)).padStart(4)} fail pixels`
        + ` of ${String(painted(r)).padStart(5)} painted   ${failPx(r) > 0 ? 'VISIBLE' : '*** LOST'}`);
}
console.log();
console.log('  DONE-WHEN 3 — Random under MaxSeverity is visibly saturated at factor 50');
for (const f of FACTORS) {
    const r = report.find((q) => q.pattern === 'Random' && q.factor === f
        && q.reducer === 'MaxSeverity');
    const pct = (failPx(r) / painted(r)) * 100;
    console.log(`    factor ${String(f).padStart(2)}: ${pct.toFixed(1).padStart(5)} % of the wafer`
        + ` is the fail swatch   (measured saturation ${r.saturation.toFixed(3)})`);
}
console.log();
console.log('  every combination present:', report.length,
    `= ${W.PATTERNS.length} patterns x ${FACTORS.length} factors x ${REDUCERS.length} reducers`);
