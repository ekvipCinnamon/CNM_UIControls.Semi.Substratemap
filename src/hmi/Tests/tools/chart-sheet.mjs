#!/usr/bin/env node
/*
 * chart-sheet.mjs - the bin-chart review sheet (`W-38`, TIER 3).
 *
 * Three maps - binary, eight sort grades, three hundred codes - each shown as a
 * MAP, then as bars, then as share, in both themes. The map sits beside its own
 * charts so colour parity is VISIBLE rather than only asserted: section 45
 * proves every bar is the map's colour for that code, and this is where a person
 * can see it.
 *
 * ---- WHAT IS ON THE SHEET IS WHAT THE CONTROL DREW ----
 *
 * The chart tiles are not re-drawn from `readCategories()`. The control renders
 * onto the recording context, and this tool REPLAYS the calls it recorded -
 * `fillRect`, `arc` + `fill`, `fillText`. The geometry, the order, the colours
 * and the angles are the control's; the only thing here is a rasteriser that
 * knows how to paint a rectangle and a wedge.
 *
 * That distinction is `W-24`'s lesson. A sheet that reconstructed the picture
 * from the data would be a picture of the tool's understanding, and would agree
 * with the control exactly when they shared a misunderstanding.
 *
 * The alternative was to make the shim rasterise `fillRect`, which is shared
 * infrastructure every suite depends on - and `W-30`'s Done-when compares pixel
 * buffers, so changing what lands in one would change what that assertion means.
 * A local rasteriser costs forty lines and risks nothing.
 *
 * Run:  node tools/chart-sheet.mjs
 */

const ROOT = new URL('../', import.meta.url).href;
const S = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs');
S.installDomShims();
globalThis.TcHmi ??= { Controls: {} };
const Sheet = await import(ROOT + 'tools/lib/sheet.mjs');
const { readFileSync } = await import('node:fs');

/* A DOM node with the members the base's attach path touches. */
const node = (t) => ({
    tagName: t, style: {}, children: [], className: '', textContent: '',
    appendChild(c) { this.children.push(c); return c; },
    remove() {}, addEventListener() {}, removeEventListener() {},
    getContext: () => null, getBoundingClientRect: () => ({ width: TILE, height: TILE }),
    setAttribute() {}, querySelector: () => null,
});
globalThis.document ??= { createElement: node };
const Harness = await import(ROOT + 'tools/attach-harness.mjs');
const Chart = await import(ROOT + 'Controls/SubstrateMapBinChart/SubstrateMapBinChart.js');

const TILE = 200;
const PAD = 10;
const ROWHDR = 128;
const COLHDR = 44;
const TITLE = 96;   // room for three sub-heading lines, incl. the note about this tool's font
const COLS = ['MAP', 'BARS', 'SHARE'];


/**
 * A wafer disc carrying `n` distinct bin codes.
 *
 * Disc-shaped rather than square, because the map tile beside the chart has to
 * look like a wafer for the comparison to mean anything to a person.
 *
 * The codes are spread by POSITION rather than at random, so the eight-grade
 * case shows eight visible regions rather than eight-way noise - a reviewer
 * judging colour parity needs to find the same colour twice, and confetti makes
 * that impossible.
 * @param n    Distinct codes.
 * @param side Lattice side.
 * @returns `{ cols, rows, cells, codes, binDefs }`.
 */
function wafer(n, side = 96) {
    /*
     * PRINTABLE, UPPERCASE CODES. The first version used `String.fromCharCode(33+i)`
     * - `!"#$%&'(` - and this sheet's own bitmap font has only uppercase and
     * digits, so every legend entry rendered as a blank swatch. That looked like
     * the control omitting the bin code, and it does not: it draws `A  12.5 %`.
     *
     * The tool's fixture and the tool's font, conspiring to misreport the product.
     */
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const codes = ['.'];
    for (let i = 0; i < n; i++) {
        codes.push(n <= ALPHA.length ? ALPHA[i] : ALPHA[i % ALPHA.length]);
    }
    const cells = new Uint32Array(side * side);
    const c0 = (side - 1) / 2;
    const rad = (side / 2 - 1) ** 2;
    for (let r = 0; r < side; r++) {
        for (let c = 0; c < side; c++) {
            const dx = c - c0;
            const dy = r - c0;
            if (dx * dx + dy * dy > rad) { continue; }
            /*
             * A radial banding: the angle picks the code, so each code owns a
             * wedge of the wafer. With 300 codes the wedges are thinner than a
             * cell and it degenerates to noise, which is the honest picture of
             * 300 codes anyway.
             */
            const a = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
            cells[r * side + c] = 1 + Math.min(n - 1, Math.floor(a * n));
        }
    }
    /*
     * ---- THE GRADED MAPS DECLARE NO QUALITY, DELIBERATELY ----
     *
     * A code that declares `Pass` or `Fail` is coloured by its QUALITY, so eight
     * grades come out as one green and seven identical oranges - on the wafer and
     * in the bars alike. They agree, and the agreement is trivial: both took the
     * same shortcut.
     *
     * A code with no declared quality falls through to `W-11`'s categorical
     * palette, which is the case worth reviewing and the realistic one: a sort
     * program emits grade codes and the author has not mapped them yet. That is
     * also the case that found `W-35`'s missing fallback.
     *
     * The BINARY map keeps its qualities, because a two-bin map with pass and fail
     * is exactly what most maps are.
     */
    const binDefs = [];
    for (let i = 0; i < n; i++) {
        binDefs.push(n <= 2
            ? { code: codes[i + 1], quality: i === 0 ? 'Pass' : 'Fail' }
            : { code: codes[i + 1] });
    }
    return { cols: side, rows: side, cells, codes, binDefs };
}

/** The same wafer as a `SubstrateMapGridData`, for the control. */
function asGridData(w) {
    const bins = [];
    for (let r = 0; r < w.rows; r++) {
        let line = '';
        for (let c = 0; c < w.cols; c++) { line += w.codes[w.cells[r * w.cols + c]]; }
        bins.push(line);
    }
    return {
        substrateId: 'W', dimension: { x: w.cols, y: w.rows }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins,
        // `binQuality` omitted where the definition has none, rather than sent as
        // `undefined`: the normaliser distinguishes absent from empty.
        binDefinitions: w.binDefs.map((b) => (b.quality === undefined
            ? { binCode: b.code } : { binCode: b.code, binQuality: b.quality })),
    };
}

/** Theme variables, read from the chart's own stylesheet. */
function themeVars(theme) {
    const css = readFileSync(new URL(
        `../Controls/SubstrateMapBinChart/Themes/${theme}/Style.css`, import.meta.url), 'utf8');
    const out = new Map();
    for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) { out.set(m[1], m[2].trim()); }
    return out;
}

/**
 * The colour a tile sits on, for this theme.
 *
 * `--substratemap-background` is `transparent` in both themes - a control is
 * expected to sit on whatever the view provides - so the sheet supplies a plate:
 * near-white for the light theme, near-black for the dark one. Without it the
 * light theme's dark labels vanish into the sheet.
 * @param theme The theme name.
 * @returns A packed colour.
 */
function plate(theme) {
    return theme === 'Base-Dark' ? [30, 30, 34] : [244, 244, 246];
}

/** The theme's colours in the shape the engine wants. */

/** Parses a CSS colour into a packed word, or `null` for transparent. */
function word(css) {
    const s = String(css).trim();
    if (s === '' || s === 'transparent') { return null; }
    let r = 0;
    let g = 0;
    let b = 0;
    const hex = /^#([0-9a-f]{6})$/i.exec(s);
    const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
    if (hex !== null) {
        const n = parseInt(hex[1], 16);
        r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
    } else if (rgb !== null) {
        r = Number(rgb[1]); g = Number(rgb[2]); b = Number(rgb[3]);
    } else { return null; }
    return [r, g, b];
}

/**
 * Replays a recording context's draw calls into the sheet.
 *
 * The ONLY drawing knowledge here is how to paint a rectangle and a wedge. What
 * to paint, where, in what colour and in what order all come from the control.
 * @param sheet The sheet. @param ctx The recording context.
 * @param ox Left. @param oy Top. @param size Tile size.
 * @returns Nothing.
 */
function replay(sheet, ctx, ox, oy, size, bg) {
    /*
     * The PIXEL buffer first, then the recorded calls. The two strategies write to
     * different places - the bucket and point passes go through `putImageData`,
     * the run pass through `fillRect` - and a tool that read only one would show
     * an empty tile at whichever zoom it guessed wrong.
     */
    /*
     * THE TILE'S OWN BACKGROUND FIRST.
     *
     * A control is drawn against its theme's background, and this sheet's is dark.
     * Compositing a LIGHT theme's control straight onto it left every label
     * dark-on-dark: the first sheet's whole Base half had invisible numbers, which
     * would have read as a bug in the control rather than in the sheet.
     */
    if (bg !== null) { sheet.rect(ox, oy, size, size, bg); }
    if (ctx.pixels !== undefined) {
        const words = new Uint32Array(ctx.pixels.buffer);
        let painted = 0;
        for (const v of words) { if (v !== 0) { painted++; } }
        if (painted > 0) { sheet.blit(words, size, size, ox, oy, size); }
    }
    for (const f of ctx.fills) {
        const c = word(f.fillStyle);
        if (c === null) { continue; }
        sheet.rect(ox + Math.round(f.x), oy + Math.round(f.y),
            Math.max(1, Math.round(f.w)), Math.max(1, Math.round(f.h)), c);
    }
    for (const a of ctx.arcFills ?? []) {
        const c = word(a.fillStyle);
        if (c === null) { continue; }
        /*
         * SUPERSAMPLED, 4x4 per pixel. A one-sample point-in-wedge test gives the
         * hard stair-stepped edge that made the first sheet look like 8-bit
         * graphics - which is the TOOL's rasteriser, not the control: the control
         * calls `ctx.arc()` and a browser antialiases it.
         *
         * Sixteen samples is enough to be indistinguishable from a smooth edge at
         * this size, and the sheet is generated once.
         */
        const r = a.r;
        const SS = 4;
        for (let dy = -r - 1; dy <= r + 1; dy++) {
            for (let dx = -r - 1; dx <= r + 1; dx++) {
                let hits = 0;
                for (let sy = 0; sy < SS; sy++) {
                    for (let sx = 0; sx < SS; sx++) {
                        const px = dx + (sx + 0.5) / SS - 0.5;
                        const py = dy + (sy + 0.5) / SS - 0.5;
                        if (px * px + py * py > r * r) { continue; }
                        /*
                         * The canvas measures from three o'clock and increases
                         * clockwise, which is what `atan2` gives once folded into
                         * `[0, 2pi)`. The control's own start and end are verbatim.
                         */
                        let ang = Math.atan2(py, px);
                        if (ang < a.start) { ang += 2 * Math.PI; }
                        if (ang > a.end) { continue; }
                        hits++;
                    }
                }
                if (hits === 0) { continue; }
                const x = ox + Math.round(a.cx + dx);
                const y = oy + Math.round(a.cy + dy);
                if (hits === SS * SS) { sheet.set(x, y, c); continue; }
                // Partial coverage: blend against what is already there.
                const t = hits / (SS * SS);
                const under = sheet.get(x, y);
                sheet.set(x, y, [
                    Math.round(under[0] + (c[0] - under[0]) * t),
                    Math.round(under[1] + (c[1] - under[1]) * t),
                    Math.round(under[2] + (c[2] - under[2]) * t),
                ]);
            }
        }
    }
    for (const t of ctx.textDraws ?? []) {
        const c = word(t.fillStyle);
        if (c === null || String(t.text) === '') { continue; }
        const w = Sheet.Sheet.width(String(t.text), 1);
        const x = t.align === 'center' ? t.x - w / 2 : t.align === 'right' ? t.x - w : t.x;
        sheet.text(String(t.text).toUpperCase(), ox + Math.round(x), oy + Math.round(t.y) - 4, c, 1);
    }
    void size;
}

/**
 * Renders the map through THE REAL CONTROL, under the theme.
 *
 * ---- NOT THROUGH THE ENGINE ----
 *
 * The first version called `buildGridPaint` directly and passed no categorical
 * fallback, so the eight-grade map came out a uniform grey disc beside a chart
 * showing eight distinct colours - a parity failure on the sheet whose whole
 * subject is parity, caused by the sheet rather than by either control.
 *
 * The Done-when says *map and chart colours sit side by side and match*. That is
 * a claim about two CONTROLS, so both columns are controls. Anything this tool
 * assembles itself is a claim about this tool.
 * @param gridData The map.
 * @param vars     The theme's variables.
 * @returns The control's recording context.
 */
function mapTile(gridData, vars) {
    const saved = window.getComputedStyle;
    window.getComputedStyle = () => ({
        getPropertyValue: (n) => vars.get(n) ?? '', fontFamily: 'sans-serif',
    });
    try {
        const m = new Harness.SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setGridData(JSON.parse(JSON.stringify(gridData)));
        m.__attach();
        Harness.renderOnce(m, TILE);
        return m.__canvasContext;
    } finally { window.getComputedStyle = saved; }
}

/** Renders the chart, under a theme, and returns its recording context. */
function chartTile(gridData, style, vars) {
    const saved = window.getComputedStyle;
    window.getComputedStyle = () => ({
        getPropertyValue: (n) => vars.get(n) ?? '', fontFamily: 'sans-serif',
    });
    try {
        const c = new Chart.SubstrateMapBinChart(null, null, {});
        c.__elementTemplateRoot = node('div');
        c.__element = [{ nodeType: 1 }];
        c.setGridData(JSON.parse(JSON.stringify(gridData)));
        c.setChartStyle(style);
        c.__attach();
        Harness.renderOnce(c, TILE);
        return c.__canvasContext;
    } finally { window.getComputedStyle = saved; }
}

const MAPS = [
    { label: 'BINARY', codes: 2 },
    { label: '8 GRADES', codes: 8 },
    { label: '300 CODES', codes: 300 },
];
const THEMES = ['Base', 'Base-Dark'];

const width = ROWHDR + COLS.length * (TILE + PAD) + PAD;
const rows = THEMES.length * MAPS.length;
const height = TITLE + THEMES.length * (COLHDR + MAPS.length * (TILE + PAD)) + PAD + 34;
const sheet = new Sheet.Sheet(width, height, [22, 22, 26]);
const INK = [232, 232, 236];
const DIM = [150, 150, 158];
const RULE = [58, 58, 66];

sheet.text('SUBSTRATEMAP BIN-CHART REVIEW SHEET', PAD, 16, INK, 3);
sheet.text('three maps x two styles x two themes, each beside its own map render'
    + '  ·  the chart tiles REPLAY the control\'s recorded draw calls, not a redrawing',
PAD, 46, DIM, 1);
sheet.text('so a colour that matches here matches because the control painted it'
    + '  ·  synthetic corpus, no customer maps', PAD, 60, DIM, 1);
sheet.text('BINARY declares Pass/Fail and is coloured by QUALITY; the graded maps declare no '
    + 'quality and fall through to the categorical palette', PAD, 72, DIM, 1);
sheet.text('NOTE: the type on this sheet is the TOOL\'s 5x7 bitmap font, not the control\'s - '
    + 'a control uses the panel\'s font through --substratemap-label-font-family',
PAD, 84, [190, 150, 120], 1);

let y = TITLE;
for (const theme of THEMES) {
    const vars = themeVars(theme);
    sheet.rect(PAD, y, width - 2 * PAD, 1, RULE);
    sheet.text(theme.toUpperCase(), PAD, y + 12, INK, 2);
    for (let c = 0; c < COLS.length; c++) {
        sheet.text(COLS[c], ROWHDR + c * (TILE + PAD), y + 12, DIM, 1);
    }
    y += COLHDR;

    for (const m of MAPS) {
        const w = wafer(m.codes);
        const gridData = asGridData(w);
        sheet.text(m.label, PAD, y + TILE / 2 - 4, INK, 2);

        replay(sheet, mapTile(gridData, vars), ROWHDR, y, TILE, plate(theme));
        replay(sheet, chartTile(gridData, 'Bars', vars),
            ROWHDR + TILE + PAD, y, TILE, plate(theme));
        replay(sheet, chartTile(gridData, 'Share', vars),
            ROWHDR + 2 * (TILE + PAD), y, TILE, plate(theme));
        y += TILE + PAD;
    }
}

sheet.rect(PAD, height - 30, width - 2 * PAD, 1, RULE);
sheet.text('Compare a colour in the MAP column with the same colour in BARS and SHARE. '
    + 'They come from one palette resolution and must be identical.', PAD, height - 18, DIM, 1);

const OUT = '/mnt/user-data/outputs/chart-review-sheet.png';
Sheet.writePng(OUT, sheet);
console.log(`\n  chart-review-sheet.png  ${width}x${height}`);
console.log(`  ${rows} rows: ${THEMES.join(', ')} x ${MAPS.map((m) => m.label).join(', ')}`);
