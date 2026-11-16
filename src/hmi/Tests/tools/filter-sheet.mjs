#!/usr/bin/env node
/*
 * filter-sheet.mjs - the spatial-filter review sheet (`W-41`, TIER 3).
 *
 * Seven WM-811K patterns down, every spatial filter across, at radius 1 and 2,
 * with a row of channel operations underneath. Each tile carries its MEASURED
 * runtime at the sheet's pixel count.
 *
 * ---- THE QUESTION THIS SHEET EXISTS FOR ----
 *
 * No assertion can answer it: *does a person who knows wafers see a pattern in
 * the filtered image that he would have missed in the unfiltered one?*
 *
 * Everything else about these filters is already proved - the median removes
 * 100 % of Random, closing bridges a gap of `g` when `g <= 2r`, the total
 * survives a Box to Float32 precision. None of that says whether the pictures
 * help.
 *
 * ---- IT MUST SHOW THE FAILURES ----
 *
 * A sheet that only shows the feature working is a screenshot. `Max` at radius 2
 * on `Random` walls the wafer in - scattered failures dilate into a solid mass -
 * and that tile is on the sheet at the same size as the others, not cropped and
 * not apologised for. So is `Min` at radius 2, which erases nearly everything.
 *
 * ---- WHAT IS THE TOOL AND WHAT IS THE PRODUCT ----
 *
 * Stated up front, because `W-38` learned this the hard way: three of eight
 * review points there were the tool misreporting the product.
 *
 *   THE TOOL:    the 5x7 bitmap font on this sheet, and the dark plate behind
 *                each tile. A control uses the panel's font and sits on the
 *                view's background.
 *   THE PRODUCT: every pixel inside a tile. Each one is rendered by a real
 *                `SubstrateMap` through `renderOnce`, with the filter set
 *                through its own attributes, and blitted from the canvas it
 *                painted. Nothing here re-implements a filter.
 *
 * Run:  node tools/filter-sheet.mjs
 */

const ROOT = new URL('../', import.meta.url).href;
const S = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs');
S.installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const W = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/patterns.mjs');
const Sheet = await import(ROOT + 'tools/lib/sheet.mjs');
const Harness = await import(ROOT + 'tools/attach-harness.mjs');

const TILE = 132;
const PAD = 6;
const ROWHDR = 132;   // EDGE-RING at scale 2 is 117 px; 96 clipped it into the tiles
const COLHDR = 34;
const TITLE = 92;
const FOOT = 20;

/** Lattice side. 800 x 800 is 640 000 cells, the figure the task asks costs for. */
const SIDE = 800;

/** The columns: a filter and a radius. `None` appears once; radius means nothing to it. */
const COLUMNS = [
    { label: 'UNFILTERED', filter: 'None', radius: 0 },
    { label: 'MEDIAN r1', filter: 'Median', radius: 1 },
    { label: 'MEDIAN r2', filter: 'Median', radius: 2 },
    { label: 'MIN r1', filter: 'Min', radius: 1 },
    { label: 'MIN r2', filter: 'Min', radius: 2 },
    { label: 'MAX r1', filter: 'Max', radius: 1 },
    { label: 'MAX r2', filter: 'Max', radius: 2 },
];

/** The channel row: the two scalar filters, which need a non-Bins channel. */
const CHANNELS = [
    { label: 'BINS', view: 'Bins', filter: 'None', radius: 0 },
    { label: 'FAILDENSITY', view: 'FailDensity', filter: 'None', radius: 0, reducer: 'FailFraction' },
    { label: 'DENSITY BOX r2', view: 'FailDensity', filter: 'Box', radius: 2, reducer: 'FailFraction' },
    { label: 'DENSITY BOX r5', view: 'FailDensity', filter: 'Box', radius: 5, reducer: 'FailFraction' },
    { label: 'DENSITY GAUSS r2', view: 'FailDensity', filter: 'Gauss', radius: 2, reducer: 'FailFraction' },
    { label: 'DENSITY GAUSS r5', view: 'FailDensity', filter: 'Gauss', radius: 5, reducer: 'FailFraction' },
];

/** The wafer as a `SubstrateMapGridData`, which is what a control takes. */
function asGridData(pattern) {
    const w = W.wafer(pattern, { size: SIDE, failRate: 0.02, seed: 17 });
    const bins = [];
    for (let r = 0; r < w.rows; r++) {
        let line = '';
        for (let c = 0; c < w.cols; c++) { line += w.codes[w.cells[r * w.cols + c]]; }
        bins.push(line);
    }
    return {
        substrateId: pattern, dimension: { x: w.cols, y: w.rows }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins,
        binDefinitions: w.binDefs.map((b) => ({ binCode: b.code, binQuality: b.quality })),
    };
}

/**
 * Renders one tile through a REAL control, and times it.
 *
 * The filter is set through the control's own attributes. The cost measured is a
 * full second frame - the first settles the reducer, the second runs the filter
 * on a warm cache - which is what an operator's next frame costs, not what a
 * cold start costs.
 * @param gridData The map. @param cfg A column or channel entry.
 * @returns `{ words, ms, painted }`.
 */
function tile(gridData, cfg) {
    const m = new Harness.SubstrateMap(null, null, {});
    m.setShowDemoItems(false);
    m.setGridData(JSON.parse(JSON.stringify(gridData)));
    /*
     * ---- THE REDUCER IS PINNED, NOT LEFT ON AUTO ----
     *
     * At 132 px a 800-cell wafer saturates hard enough that `Auto` picks
     * `FailFraction`, which paints a density ramp - so the bins rows would show
     * what the REDUCER does and the filter's effect would be a change to a ramp
     * bucket. A review of what `Median` does to bins cannot have the reducer
     * changing underneath it.
     *
     * `MaxSeverity` for the bins rows, so every tile in a row is the same
     * question. The channel rows set their own, because that is what they are
     * about.
     */
    m.setAggregationReducer(cfg.reducer ?? 'MaxSeverity');
    if (cfg.view !== undefined) { m.setFieldView(cfg.view); }
    m.setSpatialFilter(cfg.filter);
    m.setSpatialFilterRadius(cfg.radius);
    m.__attach();
    Harness.renderOnce(m, TILE);          // settles the reducer
    const t0 = process.hrtime.bigint();
    Harness.renderOnce(m, TILE);          // the frame we time
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const words = new Uint32Array(m.__canvasContext.pixels.buffer);
    let painted = 0;
    for (const v of words) { if (v !== 0) { painted++; } }
    return { words, ms, painted };
}

/** Counts pixels at the fail colour, to make "walled in" a number. */
function failPixels(words, failWord) {
    let n = 0;
    for (const v of words) { if (v === failWord) { n++; } }
    return n;
}

const PATTERNS = W.PATTERNS;
const width = ROWHDR + COLUMNS.length * (TILE + PAD) + PAD;
const height = TITLE + COLHDR + PATTERNS.length * (TILE + PAD + 24)
    + COLHDR + 14 + 2 * (TILE + PAD + 24) + FOOT + 30;
const sheet = new Sheet.Sheet(width, height, [22, 22, 26]);
const INK = [232, 232, 236];
const DIM = [150, 150, 158];
const WARN = [214, 150, 90];
const RULE = [58, 58, 66];

sheet.text('SUBSTRATEMAP SPATIAL-FILTER REVIEW SHEET', PAD, 16, INK, 3);
sheet.text(`seven WM-811K patterns at 2% fail  ·  ${SIDE}x${SIDE} = ${(SIDE * SIDE / 1000).toFixed(0)}k cells`
    + `  ·  every tile is a real SubstrateMap, filtered through its own attributes`,
PAD, 46, DIM, 1);
sheet.text('the millisecond figure under each tile is a MEASURED second frame, warm cache'
    + '  ·  synthetic corpus, no customer maps', PAD, 58, DIM, 1);
sheet.text('THE TOOL, not the product: this sheet\'s 5x7 font and the plate behind each tile. '
    + 'Everything inside a tile is the control\'s own pixels.', PAD, 70, WARN, 1);

let y = TITLE;
sheet.rect(PAD, y, width - 2 * PAD, 1, RULE);
for (let c = 0; c < COLUMNS.length; c++) {
    sheet.text(COLUMNS[c].label, ROWHDR + c * (TILE + PAD), y + 12, DIM, 1);
}
y += COLHDR;

/* ---- the numeric claims this sheet rests on, re-derived by tools-smoke ---- */
const claims = [];

for (const pattern of PATTERNS) {
    const gd = asGridData(pattern);
    sheet.text(pattern.toUpperCase(), PAD, y + TILE / 2 - 4, INK, 2);
    let baseFail = null;
    let failWord = null;
    for (let c = 0; c < COLUMNS.length; c++) {
        const t = tile(gd, COLUMNS[c]);
        const x = ROWHDR + c * (TILE + PAD);
        sheet.rect(x, y, TILE, TILE, [30, 30, 34]);
        sheet.blit(t.words, TILE, TILE, x, y, TILE);
        sheet.text(`${t.ms.toFixed(1)} MS`, x, y + TILE + 8, DIM, 1);

        if (c === 0) {
            /*
             * ---- FAIL IS THE REDDER WORD, NOT THE RARER ONE ----
             *
             * Two heuristics were tried and both were wrong, for the same reason:
             * they assumed a distribution.
             *
             *   "the second commonest" - and `Auto` chose `FailFraction` at this
             *   tile size, so the word found was a ramp bucket;
             *   "the minority, since a wafer is 2 % failures" - and under
             *   `MaxSeverity` any bucket holding ONE fail cell becomes fail, so
             *   fail is the MAJORITY at this zoom. That is the whole point of the
             *   paranoid reducer.
             *
             * Colour is what a reviewer reads, so colour is what this counts:
             * `binFail` is orange-red and `binPass` is green, so R > G identifies
             * one and not the other at any zoom, under any reducer, whatever the
             * counts happen to be.
             */
            const seen = new Set();
            for (const v of t.words) { if (v !== 0) { seen.add(v); } }
            failWord = [...seen].find((v) => {
                const r = v & 0xff;
                const g = (v >>> 8) & 0xff;
                return r > g;
            }) ?? 0;
            baseFail = failPixels(t.words, failWord);
        }
        if (pattern === 'Random' && COLUMNS[c].label === 'MAX r2') {
            const walled = failPixels(t.words, failWord);
            claims.push({ name: 'random-max-r2-walls-in', base: baseFail, after: walled });
            sheet.text(`${((walled / Math.max(1, t.painted)) * 100).toFixed(0)}% WALLED IN`,
                x, y + TILE + 18, WARN, 1);
        }
        if (pattern === 'Random' && COLUMNS[c].label === 'MIN r2') {
            const left = failPixels(t.words, failWord);
            claims.push({ name: 'random-min-r2-erases', base: baseFail, after: left });
            sheet.text('ERASED', x, y + TILE + 18, WARN, 1);
        }
    }
    y += TILE + PAD + 24;
}

sheet.rect(PAD, y + 6, width - 2 * PAD, 1, RULE);
sheet.text('CHANNELS', PAD, y + 22, INK, 2);
sheet.text('Box and Gauss average, so they need a scalar channel — on Bins they are refused',
    ROWHDR, y + 22, DIM, 1);
y += COLHDR + 14;

for (let c = 0; c < CHANNELS.length; c++) {
    sheet.text(CHANNELS[c].label, ROWHDR + c * (TILE + PAD), y - 6, DIM, 1);
}
for (const pattern of ['Loc', 'Random']) {
    const gd = asGridData(pattern);
    sheet.text(pattern.toUpperCase(), PAD, y + TILE / 2 - 4, INK, 2);
    for (let c = 0; c < CHANNELS.length; c++) {
        const t = tile(gd, CHANNELS[c]);
        const x = ROWHDR + c * (TILE + PAD);
        sheet.rect(x, y, TILE, TILE, [30, 30, 34]);
        sheet.blit(t.words, TILE, TILE, x, y, TILE);
        sheet.text(`${t.ms.toFixed(1)} MS`, x, y + TILE + 8, DIM, 1);
    }
    y += TILE + PAD + 24;
}

sheet.rect(PAD, height - 26, width - 2 * PAD, 1, RULE);
sheet.text('THE QUESTION: does a filtered tile show you a pattern you would have missed in the '
    + 'unfiltered one? Nothing but a person can answer that.', PAD, height - 14, INK, 1);

const OUT = '/mnt/user-data/outputs/filter-review-sheet.png';
Sheet.writePng(OUT, sheet);
console.log(`\n  filter-review-sheet.png  ${width}x${height}`);
for (const c of claims) {
    console.log(`  claim ${c.name}: ${c.base} -> ${c.after} fail pixels`);
}
