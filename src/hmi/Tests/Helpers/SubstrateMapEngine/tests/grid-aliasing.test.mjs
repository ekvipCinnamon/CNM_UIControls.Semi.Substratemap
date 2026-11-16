/*
 * grid-aliasing.test.mjs - the defect, and its repair.
 *
 * ============================================================================
 *  UN-SKIPPED AT TASK 16, PERMANENTLY. It is green, and it must stay green.
 *
 *  It was written at Task 4 to FAIL, and it did: one failing die vanished at
 *  four of eight phases at factor 2, seven of eight at factor 6, and at EVERY
 *  phase at factors 20 and 50. Task 16 replaced point sampling with the bucket
 *  pass and the same probe now finds the die at 8/8 everywhere.
 *
 *  A red result here means the aggregation regressed, not that the test is
 *  stale. The `LOD_ALIASING` guard is gone: this is a gate now.
 * ============================================================================
 *
 * WHAT IT DEMONSTRATES. `renderGridImageData` maps each device pixel back through
 * the lattice inverse to EXACTLY ONE cell - `Math.floor(a)`, `Math.floor(b)` - and
 * paints that cell's colour. That is point sampling. At an aggregation factor of
 * N, each pixel stands for N x N cells and N x N - 1 of them are invisible; WHICH
 * one survives is decided by subpixel phase. On a yield map that is silent
 * suppression of defects: a single failing die is seen or not seen depending on
 * where the grid happens to land relative to the pixel raster, and panning by half
 * a pixel changes the answer.
 *
 * The assertion is the weakest thing that would still be true of a correct
 * renderer: **one failing die must produce at least one non-background pixel**, at
 * every factor and every phase. Not the right colour, not the right position, not
 * the right area - merely visible at all.
 *
 * WHY IT IS SKIPPED RATHER THAN DELETED OR INVERTED. Inverting it - asserting the
 * die DOES vanish - would have to be inverted back at Task 16 and would pass for a
 * while against a half-finished aggregator. Deleting it loses the demonstration.
 * Skipped, it is a standing statement of what the feature is for, and Task 16
 * turns it on by removing one line.
 *
 * FIXTURE NOTES, both of which cost a task to learn (observations 77 and 78):
 *   - the BinDefinitions carry `quality`, or `resolveBinColor` returns `unknown`
 *     for pass AND fail and they render the same colour;
 *   - the colour object's keys are `binPass` / `binFail`, not `pass` / `fail`.
 * Either mistake alone makes this suite assert that grey is not the background.
 */

import { makeHarness, onCrash } from './lib/harness.mjs';
import { DOMMatrix, installDomShims, makeContext2D } from './lib/dom-shims.mjs';

const { ok, eq, section, finish, counts } = makeHarness();
onCrash(counts);

installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Engine = await import(new URL('../Engine.js', import.meta.url).href);
const Agg = await import(new URL('../GridAggregate.js', import.meta.url).href);

/* ------------------------------------------------------------------ fixture */

const SIDE = 600;                       // 600 x 600 = 360 000 cells
/*
 * The failing die sits at a deliberately awkward coordinate: 293 and 251 are both
 * PRIME, so the cell is not a multiple of any factor under test (2, 6, 20, 50) and
 * cannot be sampled by luck of alignment at a whole-pixel phase. A die at (300,300)
 * would survive several factors for a reason that has nothing to do with the
 * renderer being correct.
 */
const FAIL_COL = 293;
const FAIL_ROW = 251;

const CODES = ['.', '1', '9'];          // null, pass, fail
const cells = new Uint32Array(SIDE * SIDE).fill(1);
cells[FAIL_ROW * SIDE + FAIL_COL] = 2;

const PLACEMENT = {
    originXmm: 0, originYmm: 0,
    colStepXmm: 1, colStepYmm: 0,
    rowStepXmm: 0, rowStepYmm: 1,
    cellWmm: 1, cellLmm: 1,
    sideMirror: false,
};
const BIN_DEFS = [{ code: '1', quality: 'Pass' }, { code: '9', quality: 'Fail' }];
const COLORS = {
    bg: '#000000', body: '#111111', edge: '#222222', selection: '#333333',
    unknown: '#888888', binPass: '#00aa00', binFail: '#aa0000',
};

const grid = Engine.buildGridModel(PLACEMENT, { cols: SIDE, rows: SIDE, cells, codes: CODES }, BIN_DEFS);
const paint = Engine.buildGridPaint(grid, null, COLORS, makeContext2D(8, 8));
/* Task 16: the aggregate palette is what makes the dispatcher take the bucket
 * pass. Without it `renderGridLayer` falls back to point sampling and this suite
 * goes red again, which is exactly the regression it now guards. */
paint.aggregate = Agg.buildAggregatePaint(grid, COLORS);
const FAIL_WORD = paint.aggregate.bySeverity[Engine.SEVERITY_FAIL];

/* ------------------------------------------------------------------- probe */

const FACTORS = [2, 6, 20, 50];         // cells per device pixel
const PHASES = 8;                       // subpixel offsets, k/8 of a pixel

/**
 * Renders the grid at one factor and phase and counts the failing die's pixels.
 *
 * The device matrix is `1/factor` px per cell with a translation of `k/PHASES` of a
 * device pixel - the whole point being that this shift changes nothing about the
 * DATA and everything about which cell each pixel samples.
 * @param factor Cells per device pixel.
 * @param k      Phase index, 0..PHASES-1.
 * @returns The number of pixels carrying the fail colour.
 */
function failPixels(factor, k) {
    const scale = 1 / factor;
    const side = Math.ceil(SIDE * scale) + 2;
    const ctx = makeContext2D(side, side);
    const off = k / PHASES;
    Engine.renderGridLayer(ctx, grid,
        new DOMMatrix([scale, 0, 0, scale, off, off]), paint, side, side, true, 'MaxSeverity');

    // The aggregate palette, not the bin palette: at aggregation a tile means "at
    // least one bad die in here", and it is painted from the darker band D-086
    // chose so an operator can tell a summary from a datum.
    let n = 0;
    const words = new Uint32Array(ctx.pixels.buffer);
    for (let i = 0; i < words.length; i++) {
        if (words[i] === FAIL_WORD) { n++; }
    }
    return n;
}

/* ------------------------------------------------------------------ checks */

section('0. the fixture itself is sound', () => {
    /*
     * Before asserting the die vanishes, prove it EXISTS and is distinguishable.
     * Without this the suite could fail for the trivial reason that the fail colour
     * was never in the buffer at all, which would look identical from the outside.
     */
    ok(grid !== null, 'the 600x600 grid builds');
    eq(grid.cols * grid.rows, SIDE * SIDE, `  ${SIDE * SIDE} cells`);
    ok(paint.rgba !== null, 'paint.rgba is populated, so the ImageData strategy is reachable');

    const passGroup = paint.groups[1];
    const failGroup = paint.groups[2];
    ok(passGroup !== failGroup, 'pass and fail land in different paint groups');
    ok(paint.colors[failGroup] === '#aa0000',
        `  and fail resolves to #aa0000, not unknown (observations 77, 78)`);

    /* At factor 1 every cell is its own pixel, so the die MUST be visible. If this
     * fails, nothing below means anything. */
    ok(paint.aggregate !== null, 'the aggregate palette builds from the default theme');
    /* Factor 2, not 1: aggregation runs only BELOW one device pixel per cell, so at
     * factor 1 the gather is still in charge and paints bin colours rather than the
     * aggregate band. */
    const at2 = failPixels(2, 0);
    ok(at2 > 0, `at factor 2 the failing die paints ${at2} aggregate pixel(s) — the fixture is visible`);
});

section('1. one failing die stays visible at every factor and every phase', () => {
    /*
     * THE ASSERTION THIS FILE EXISTS FOR, and the one that fails.
     *
     * A correct renderer under minification cannot show every cell, but it must not
     * be able to LOSE one entirely: a pixel standing for N x N cells should carry
     * something derived from all of them. Point sampling derives it from one.
     */
    for (const factor of FACTORS) {
        const vanished = [];
        const counts = [];
        for (let k = 0; k < PHASES; k++) {
            const n = failPixels(factor, k);
            counts.push(n);
            if (n === 0) { vanished.push(k); }
        }
        const seen = counts.filter((n) => n > 0).length;
        ok(vanished.length === 0,
            `factor ${factor}: the failing die is visible at all ${PHASES} phases `
            + `— visible at ${seen}/${PHASES}, VANISHED at phase offset(s) `
            + `${vanished.map((k) => `${k}/${PHASES}`).join(', ') || 'none'} `
            + `[pixels per phase: ${counts.join(', ')}]`);
        ok(counts.every((n) => n > 0 && n < 20),
            `  and it stays a defect rather than becoming a smear: ${Math.min(...counts)}–`
            + `${Math.max(...counts)} pixels, not the whole tile`);
    }
});

finish();
