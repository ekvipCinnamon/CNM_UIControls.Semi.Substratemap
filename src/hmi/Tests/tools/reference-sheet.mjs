#!/usr/bin/env node
/*
 * reference-sheet.mjs - the golden-map review sheet (`W-24`, TIER 3).
 *
 * Seven WM-811K patterns against ONE clean reference, in three columns: the map
 * as it renders normally, then `Difference`, then `NewOnly`. Whether a
 * difference view tells a process engineer what he needs to see is not
 * answerable by assertion, so it is answerable by looking.
 *
 * The corpus is synthetic, from `patterns.mjs`. The NDA rule is unchanged: no
 * customer maps, ever.
 *
 * Shares `Sheet` and the PNG writer with `contact-sheet.mjs` rather than
 * reimplementing them - `W-21` and `W-22a` both showed what a second copy of a
 * fiddly loop costs.
 *
 * Run:  node tools/reference-sheet.mjs
 */

import {  } from 'node:fs';

const ROOT = new URL('../', import.meta.url).href;
const S = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs');
S.installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import(ROOT + 'Helpers/SubstrateMapEngine/Engine.js');
const Agg = await import(ROOT + 'Helpers/SubstrateMapEngine/GridAggregate.js');
const BinPalette = await import(ROOT + 'Helpers/SubstrateMapEngine/BinPalette.js');
const W = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/patterns.mjs');
const Sheet = await import(ROOT + 'tools/lib/sheet.mjs');

const PLACEMENT = { originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
    rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false };
const COLORS = { bg: '#000000', body: 'rgb(220, 220, 220)', edge: 'rgb(110, 110, 110)',
    selection: 'rgb(0, 90, 200)', unknown: 'rgb(110, 110, 110)',
    binPass: 'rgb(0, 158, 115)', binFail: 'rgb(213, 94, 0)' };

/*
 * ---- RENDERED WHERE THE COMPARISON EXISTS ----
 *
 * At or above one device pixel per cell. Below that the bucket pass colours by
 * SEVERITY RANK through a four-entry table, or by a scalar ramp - it has no way
 * to carry a per-cell colour, and the comparison is simply not expressible
 * there. Measured, not assumed: `gates/W-24.md` has the table.
 *
 * That is also the honest zoom for this view. A difference map whose dies are a
 * third of a pixel each is not something anyone reads cell by cell.
 */
const SIDE = 128;
const SCALE = 1.5;                        // point strategy: one cell, several pixels
const MODES = ['(no reference)', 'Difference', 'NewOnly'];
const CELL = 200;
const PAD = 12;
const ROWHDR = 132;
const COLHDR = 46;
const TITLE = 78;

/**
 * The reference: the same geometry, no failures at all.
 *
 * A clean wafer is the golden map an author would actually bind - `toGridData()`
 * run on a wafer that came out right. Every failure in every pattern is
 * therefore new, which is the case that makes the two modes easy to tell apart
 * by eye.
 */
const CORPUS = { sortBins: true, unprocessed: 0.42, testRows: 3 };

/*
 * ---- THE CORPUS IS A REAL-LOOKING MAP, NOT A CLEAN DISC (W-24, second pass) ----
 *
 * The first sheet used two bins on a fully processed wafer and the reviewer said
 * so: it looks nothing like what an engineer sees, and it cannot show the two
 * things that make a difference view hard to read.
 *
 *   SORT BINS. Five failure modes, not one. "This die went from bin 3 to bin 7"
 *   is the difference actually looked for, and a two-bin map cannot contain one.
 *   It also puts several distinct greys on the page instead of one, which is the
 *   real test of whether muting stays legible.
 *
 *   AN UNPROCESSED REGION. 42 % of the width, untested. Those cells are NULL and
 *   nothing is painted there - so the sheet shows the distinction `W-23`'s clamp
 *   exists to protect: a muted cell against an absent one, side by side.
 *
 *   TEST DIES. Three rows of them, and they are the reason the whole feature
 *   exists. A test die is not a defect - it was never product - but it carries a
 *   bin code that is not a pass bin, so on a plain map it reads as a regular
 *   defect line, which is exactly the shape an operator is trained to notice.
 *
 * ---- THE REFERENCE CARRIES THE TEST DIES TOO ----
 *
 * That is the correction the reviewer made and it is the whole point. A CLEAN
 * reference adds no information: every failure is new, `Difference` and `NewOnly`
 * agree, and the sheet showed seven identical pairs twice over. A reference that
 * contains what the wafer is SUPPOSED to contain greys the test rows out, and
 * what stays lit is what is actually wrong.
 */
const reference = W.wafer('Random', { size: SIDE, failRate: 0, seed: 11, ...CORPUS });

/**
 * One render.
 * @param pattern The WM-811K pattern.
 * @param mode    `'(no reference)'`, `'Difference'` or `'NewOnly'`.
 * @returns `{ words, side, kept, total }`.
 */
function tile(pattern, mode, rework) {
    const w = rework ? rework.map
        : W.wafer(pattern, { size: SIDE, failRate: 0.02, seed: 21, ...CORPUS });
    const grid = Engine.buildGridModel(PLACEMENT,
        { cols: w.cols, rows: w.rows, cells: w.cells, codes: w.codes }, w.binDefs);
    const r = rework ? rework.ref : reference;
    const ref = Engine.buildGridModel(PLACEMENT,
        { cols: r.cols, rows: r.rows, cells: r.cells, codes: r.codes }, r.binDefs);

    let fill = null;
    let kept = 0;
    let total = 0;
    if (mode !== '(no reference)') {
        /*
         * The same construction the control performs, deliberately duplicated here
         * rather than driven through a control: this tool renders the ENGINE, and
         * standing up a control per tile would make the sheet a test of the
         * attribute plumbing instead of a picture of the operation. The assertions
         * cover the control's version.
         */
        const n = grid.binTable.length;
        const colors = new Array(n * 2);
        for (let i = 0; i < n; i++) {
            const lit = Engine.resolveBinColor(grid.binTable[i], null, COLORS, null, null, null);
            colors[i] = lit;
            colors[n + i] = BinPalette.desaturate(lit, COLORS.body, Agg.AGGREGATE_MIN_DELTA_E);
        }
        const sev = Engine.binSeverityTable(grid.binTable, null);
        const refSev = Engine.binSeverityTable(ref.binTable, null);
        const cells = new Uint32Array(grid.cells.length);
        for (let i = 0; i < cells.length; i++) {
            const bin = grid.cells[i];
            const refBin = ref.cells[i];
            if (bin === 0) { cells[i] = 0; continue; }
            total++;
            const keep = mode === 'Difference'
                ? grid.binTable[bin].code !== (ref.binTable[refBin]?.code ?? null)
                : sev[bin] > (refBin === 0 ? 0 : refSev[refBin]);
            if (keep) { kept++; }
            cells[i] = keep ? bin : n + bin;
        }
        fill = { cells, colors };
    }

    const paint = Engine.buildGridPaint(grid, null, COLORS, S.makeContext2D(8, 8),
        null, null, undefined, fill, null, null);
    paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
    const side = Math.max(4, Math.round(SIDE * SCALE));
    const ctx = S.makeContext2D(side, side);
    Engine.renderGridLayer(ctx, grid, new S.DOMMatrix([SCALE, 0, 0, SCALE, 0, 0]),
        paint, side, side, true, 'MaxSeverity');
    /*
     * ---- THE SUBSTRATE BODY, DRAWN UNDER THE DIES ----
     *
     * Without it an UNPROCESSED cell and an OFF-SUBSTRATE one look identical -
     * both are simply not painted - and the reviewer cannot tell "this half was
     * not tested" from "the wafer is a half-disc". The map format cannot
     * distinguish them either: `nullBin` covers both. What distinguishes them on
     * screen is the outline, and a control binds one.
     *
     * Faked here as a disc rather than run through `drawSubstrateMap`, because
     * this tool renders the grid layer alone and standing up the whole map draw
     * per tile would make the sheet a test of the outline path.
     */
    const words = new Uint32Array(ctx.pixels.buffer);
    const body = 0xffdcdcdc >>> 0;
    const c0 = (side - 1) / 2;
    const rad = side / 2 - 0.5;
    for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
            const i = y * side + x;
            if (words[i] !== 0) { continue; }
            if ((x - c0) ** 2 + (y - c0) ** 2 <= rad * rad) { words[i] = body; }
        }
    }
    return { words, side, kept, total };
}

/*
 * ---- THE ROW THAT SEPARATES THE TWO MODES ----
 *
 * Against a CLEAN reference the two agree in every row, because every failure is
 * new. They part only when the reference already carries failures AND some of
 * them are gone - a REWORKED wafer, which is the case the spec names as the
 * question an operator asks after a rework step.
 *
 * So: a reference with a scratch, and a map where the scratch is repaired and
 * new scattered failures have appeared. `Difference` lights both the repaired
 * cells and the new ones, because both differ. `NewOnly` lights just the new
 * ones. Without this row a reviewer cannot judge whether two modes are worth
 * having.
 */
const reworkRef = W.wafer('Scratch', { size: SIDE, failRate: 0.02, seed: 21, ...CORPUS });
const reworkMap = W.wafer('Random', { size: SIDE, failRate: 0.01, seed: 44, ...CORPUS });
const REWORK = { ref: reworkRef, map: reworkMap };

const ROWS = [...W.PATTERNS, 'rework'];
const width = ROWHDR + MODES.length * (CELL + PAD) + PAD;
const height = TITLE + COLHDR + ROWS.length * (CELL + PAD) + PAD + 46;
const sheet = new Sheet.Sheet(width, height, [22, 22, 26]);
const INK = [232, 232, 236];
const DIM = [150, 150, 158];
const RULE = [58, 58, 66];

sheet.text('SUBSTRATEMAP GOLDEN-MAP REVIEW SHEET', PAD, 16, INK, 3);
sheet.text('seven patterns at 2% fail  ·  SEVEN SORT BINS  ·  THREE ROWS OF TEST DIES (not defects) '
    + ' ·  ' + Math.round(CORPUS.unprocessed * 100) + '% of the width UNPROCESSED (null, not a bin)',
PAD, 44, DIM, 1);
sheet.text('the reference carries the SAME test rows and the same unprocessed band, and no failures'
    + '  ·  ' + SIDE + 'x' + SIDE + ' cells at ' + SCALE + ' px/cell  ·  synthetic, no customer maps',
PAD, 58, DIM, 1);

for (let m = 0; m < MODES.length; m++) {
    const x = ROWHDR + m * (CELL + PAD);
    sheet.text(MODES[m].toUpperCase(), x, TITLE + 14, INK, 2);
}
sheet.rect(PAD, TITLE + COLHDR - 8, width - PAD - PAD, 1, RULE);

for (let p = 0; p < ROWS.length; p++) {
    const pattern = ROWS[p];
    const rework = pattern === 'rework' ? REWORK : null;
    const y = TITLE + COLHDR + p * (CELL + PAD);
    sheet.text(rework ? 'REWORK' : pattern, PAD, y + CELL / 2 - 6, INK, 2);
    if (rework) {
        sheet.text('ref: scratch', PAD, y + CELL / 2 + 12, DIM, 1);
        sheet.text('map: repaired,', PAD, y + CELL / 2 + 26, DIM, 1);
        sheet.text('new randoms', PAD, y + CELL / 2 + 40, DIM, 1);
    }
    for (let m = 0; m < MODES.length; m++) {
        const t = tile(pattern, MODES[m], rework);
        const x = ROWHDR + m * (CELL + PAD);
        sheet.blit(t.words, t.side, t.side, x, y, CELL);
        if (MODES[m] !== '(no reference)') {
            const pct = t.total === 0 ? 0 : (100 * t.kept) / t.total;
            sheet.text(t.kept + ' of ' + t.total + ' lit  (' + pct.toFixed(1) + '%)',
                x, y + CELL + 2, DIM, 1);
        }
    }
    sheet.rect(PAD, y + CELL + 16, width - PAD - PAD, 1, RULE);
}

sheet.text('A LIT cell differs from the reference; a MID-GREY cell matches it. The PALE band is '
    + 'substrate with nothing tested. Compare column 1 with column 2: the TEST ROWS go quiet.',
PAD, height - 32, DIM, 1);
sheet.text('With a CLEAN reference every failure is new, so Difference and NewOnly agree here. '
    + 'They part when the reference already carries failures - see the SCRATCH pair below.',
PAD, height - 16, DIM, 1);

const OUT = '/mnt/user-data/outputs/reference-review-sheet.png';
Sheet.writePng(OUT, sheet);
console.log('\n  reference-review-sheet.png  ' + width + 'x' + height);
