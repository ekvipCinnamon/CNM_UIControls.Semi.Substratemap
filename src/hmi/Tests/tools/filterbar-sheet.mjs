#!/usr/bin/env node
/*
 * filterbar-sheet.mjs - the FilterBar review sheet (`F-9`, TIER 3).
 *
 * ---- THE QUESTION THIS SHEET EXISTS FOR ----
 *
 * No assertion can answer it: *does an operator looking at this bar understand
 * why a filter he wants is not available?* `filterbar-dom.test.mjs` proves the
 * `disabled` flag and the `title` string reach the right option. It cannot say
 * whether the resulting bar reads as "this is off limits, and here is why" or as
 * "this control is broken".
 *
 * The FilterBar is the only control with no visual review at all, which is how it
 * reached 41% of lines with its whole DOM loop unexecuted.
 *
 * ---- WHERE THE PICTURE COMES FROM ----
 *
 * From the CONTROL, through `element-stub.mjs`. Every option, every `disabled`
 * and every tooltip on this sheet was written by `__build` and `__refresh` into a
 * stub element and read back out - nothing here decides what the bar should show.
 *
 * That is `W-24`'s lesson, which `chart-sheet.mjs` states plainly: a sheet that
 * reconstructed the picture from the data would be a picture of the tool's
 * understanding, and would agree with the control exactly when they shared a
 * misunderstanding. This tool knows how to draw a rectangle and some text. It does
 * not know what a spatial filter is.
 *
 * ---- WHAT IT IS NOT ----
 *
 * Not a screenshot. There is no browser here, no stylesheet and no layout engine,
 * so the geometry is this tool's and only the CONTENT and the STATE are the
 * control's. A disabled option is drawn grey because that is what a browser does
 * with `disabled`; whether the shipped CSS greys it the same way is a question for
 * the live view, and this sheet cannot answer it. It answers whether the right
 * things are disabled and whether the reasons are worth reading.
 *
 * Run:  node tools/filterbar-sheet.mjs
 */

const ROOT = new URL('../', import.meta.url).href;
const S = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs');
S.installDomShims();
await import(ROOT + 'tools/attach-harness.mjs');
const { installDocumentStub } = await import(ROOT + 'Helpers/SubstrateMapEngine/tests/lib/element-stub.mjs');
const FB = await import(ROOT + 'Controls/SubstrateMapFilterBar/SubstrateMapFilterBar.js');
const Sheet = await import(ROOT + 'tools/lib/sheet.mjs');

/* ------------------------------------------------------------------ colours */
const BG = [250, 250, 250];
const INK = [40, 40, 40];
const MUTED = [150, 150, 150];
const FIELD = [255, 255, 255];
const EDGE = [200, 200, 200];
const OK = [34, 95, 121];          // the same azure the demo palette leads with
const OFF = [232, 232, 232];       // a disabled option's fill
const WHY = [171, 65, 31];         // the accent, for the reason text

/* ------------------------------------------------------------- the states */
/**
 * Every channel, and for each the filter the operator is most likely to have
 * selected when he switches - which is what makes the reset visible.
 */
const VIEWS = ['Bins', 'FailDensity', 'ValueField'];
const RADII = [0, 2, 5];

/**
 * Drives the real control and reads back what it wrote.
 * @param surface `{ view, filter, radius, highlight }`.
 * @returns `{ fields }`, each `{ label, kind, options|value }`.
 */
function readBar(surface) {
    const root = installDocumentStub();
    const bar = new FB.SubstrateMapFilterBar(null, null, {});
    /*
     * The sheet renders what an operator sees, so it needs the dictionary the
     * product gets from TcHmiControl. The stub returns the key for every lookup —
     * which is what the framework itself does when a locale has no text — so the
     * sheet shows the keys, and a reviewer can tell at a glance which strings are
     * localised and which are still hard-coded.
     */
    bar.__localization = { getText: (k) => String(k), watch: () => () => {}, watchText: () => () => {} };
    bar.__destroyOnDetach = [];
    bar.__destroyOnDestroy = [];
    bar.__root = root;
    if (surface.view !== undefined) { bar.setFieldView(surface.view); }
    if (surface.filter !== undefined) { bar.setSpatialFilter(surface.filter); }
    if (surface.radius !== undefined) { bar.setSpatialFilterRadius(surface.radius); }
    if (surface.highlight !== undefined) { bar.setHighlightFromSeverity(surface.highlight); }
    bar.__build();
    bar.__refresh();

    const one = (key, label) => {
        const el = root.byClass(`substratemap-filterbar-${key}`)[0];
        if (el.tagName === 'INPUT') {
            const out = root.byClass('substratemap-filterbar-radius-value')[0];
            return { label, kind: 'range', value: el.value, min: el.min, max: el.max,
                readout: out === undefined ? '' : out.textContent };
        }
        return {
            label,
            kind: 'select',
            value: el.value,
            options: el.children.map((o) => ({
                text: o.textContent, value: o.value, disabled: o.disabled, reason: o.title,
            })),
        };
    };
    return {
        surface: bar.readSurface(),
        fields: [one('filter', 'Filter'), one('view', 'Channel'),
            one('highlight', 'Highlight'), one('radius', 'Radius')],
    };
}

/* ---------------------------------------------------------------- layout */
const PAD = 14;
const ROW_H = 22;
const COL_W = 430;
const REASON_W = 520;
const CARD_W = COL_W + REASON_W + PAD * 2;

const cards = [];
for (const view of VIEWS) {
    for (const filter of ['Median', 'Box']) {
        cards.push({ title: `Channel = ${view}, operator wants ${filter}`, surface: { view, filter } });
    }
}
for (const radius of RADII) {
    cards.push({ title: `Radius = ${radius}${radius === 0 ? '  (the filter is off)' : ''}`,
        surface: { view: 'Bins', filter: 'Median', radius } });
}
cards.push({ title: 'Highlight = none', surface: { view: 'Bins', filter: 'None' } });
cards.push({ title: 'Highlight = a threshold', surface: { view: 'Bins', filter: 'None', highlight: 3 } });

const read = cards.map((c) => ({ ...c, bar: readBar(c.surface) }));
const cardH = (r) => {
    let h = ROW_H + PAD;                                   // title
    for (const f of r.bar.fields) {
        h += ROW_H;                                        // the field's own row
        if (f.kind === 'select') { h += f.options.length * ROW_H; }
    }
    return h + PAD;
};
const heights = read.map(cardH);
const width = CARD_W;
const height = heights.reduce((a, b) => a + b, 0) + PAD * 2 + ROW_H * 3;

const sheet = new Sheet.Sheet(width, height, BG);
let y = PAD;
sheet.text('SubstrateMapFilterBar - every state the bar can offer (F-9)', PAD, y, INK, 2);
y += ROW_H;
sheet.text('Content and state read back from the control; only the geometry is this tool\'s.', PAD, y, MUTED, 1);
y += ROW_H;
sheet.text('A greyed row is a disabled option. The text on its right is the tooltip the operator gets.', PAD, y, MUTED, 1);
y += ROW_H + PAD;

let disabledSeen = 0;
let reasonsSeen = 0;
let optionsSeen = 0;

for (const [i, r] of read.entries()) {
    sheet.rect(PAD - 4, y - 4, CARD_W - PAD * 2 + 8, heights[i] - PAD, [244, 244, 244]);
    sheet.text(r.title, PAD, y, INK, 1);
    let ry = y + ROW_H;
    for (const f of r.bar.fields) {
        sheet.text(f.label, PAD + 6, ry, MUTED, 1);
        if (f.kind === 'range') {
            const w = 160;
            sheet.rect(PAD + 110, ry + 6, w, 4, EDGE);
            const frac = Number(f.value) / (Number(f.max) || 1);
            sheet.rect(PAD + 110 + Math.round(frac * (w - 6)), ry + 2, 6, 12, OK);
            // The readout the operator actually sees, not the raw slider number.
            sheet.text(`${f.readout}`, PAD + 110 + w + 12, ry, f.value === '0' ? WHY : INK, 1);
            sheet.text(`(${f.min}..${f.max})`, PAD + 110 + w + 90, ry, MUTED, 1);
            ry += ROW_H;
            continue;
        }
        sheet.text(`= ${f.value === '' ? '(none)' : f.value}`, PAD + 110, ry, INK, 1);
        ry += ROW_H;
        for (const o of f.options) {
            optionsSeen++;
            const selected = o.value === f.value;
            sheet.rect(PAD + 118, ry, COL_W - 150, ROW_H - 4, o.disabled ? OFF : FIELD);
            sheet.rect(PAD + 118, ry, 3, ROW_H - 4, o.disabled ? OFF : (selected ? OK : EDGE));
            sheet.text(o.text, PAD + 128, ry + 3, o.disabled ? MUTED : INK, 1);
            if (selected) { sheet.text('<', PAD + COL_W - 40, ry + 3, OK, 1); }
            if (o.disabled) { disabledSeen++; }
            if (o.reason !== '') {
                reasonsSeen++;
                // Wrapped by hand: the sheet library has no text metrics, and a
                // reason that runs off the edge is a reason nobody reads.
                const words = o.reason.split(' ');
                let line = '';
                let ly = ry + 3;
                for (const wd of words) {
                    if ((line + ' ' + wd).length > 62) { sheet.text(line, PAD + COL_W, ly, WHY, 1); line = wd; ly += 12; }
                    else { line = line === '' ? wd : line + ' ' + wd; }
                }
                if (line !== '') { sheet.text(line, PAD + COL_W, ly, WHY, 1); }
            }
            ry += ROW_H;
        }
    }
    y += heights[i];
}

const OUT = '/mnt/user-data/outputs/filterbar-review-sheet.png';
Sheet.writePng(OUT, sheet);
console.log(`\n  filterbar-review-sheet.png  ${width}x${height}`);
console.log(`  cards            : ${read.length}`);
console.log(`  options drawn    : ${optionsSeen}`);
console.log(`  disabled options : ${disabledSeen}`);
console.log(`  tooltip reasons  : ${reasonsSeen}`);
console.log('\n  Every one of those came from the control, not from this tool.');

/*
 * The claims tools-smoke checks. Both are about the FAILURE MODE rather than the
 * success: a sheet that drew nothing would still say "0 disabled", so the numbers
 * that matter are the ones that would be wrong if the bar stopped offering the
 * illegal combinations or stopped explaining them.
 */
console.log(`  claim disabled-options: ${disabledSeen} of ${optionsSeen}`);
console.log(`  claim reasons-given: ${reasonsSeen} of ${disabledSeen}`);
