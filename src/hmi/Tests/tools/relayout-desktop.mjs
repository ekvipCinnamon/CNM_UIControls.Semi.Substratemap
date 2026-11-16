#!/usr/bin/env node
/*
 * relayout-desktop.mjs - the six-column reference page (`F-29`).
 *
 * ---- WHAT IT DOES ----
 *
 * Columns 1-3 are the nineteen `SubstrateMap` panels, unchanged in what they
 * demonstrate and moved into a regular grid. Columns 4-6 mirror them: the panel in
 * column 1 gets a widget in column 4 **bound to the same data attribute**, column 2
 * to column 5, column 3 to column 6.
 *
 * ---- WHY A TOOL AND NOT AN EDIT ----
 *
 * Nineteen panels times two coordinates, plus nineteen new controls each carrying a
 * copy of a binding that can be 3 kB of escaped JSON. Done by hand that is a
 * transcription exercise with nineteen chances to paste the wrong lot into the
 * wrong tile - and the failure would look like a working page showing the wrong
 * thing, which is the hardest kind to notice.
 *
 * The bindings are COPIED FROM THE MAP, not restated. A widget shows what its map
 * shows because it was handed the same attribute value, so the two cannot drift and
 * the page cannot lie about which data a tile is displaying.
 *
 * ---- WHAT IT DELIBERATELY DOES NOT TOUCH ----
 *
 * The `F-25` dashboard below the grid: it demonstrates one filter bar driving two
 * maps, which a grid of independent pairs cannot show. And the event-log script at
 * the end of the view, whose wiring `tools-smoke` pins at two entries.
 *
 *   node tools/relayout-desktop.mjs           rewrite Desktop.view
 *   node tools/relayout-desktop.mjs --check   exit 1 if the grid is out of step
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEW = join(ROOT, 'Desktop.view');
const CHECK = process.argv.includes('--check');

const BEGIN = '<!-- GRID:BEGIN -->';
const END = '<!-- GRID:END -->';
const NS = 'TcHmi.Controls.CNM_UIControls.SEMI';

/* ------------------------------------------------------------------ geometry */
const MAP_W = 440;
const MAP_H = 400;
const SIDE_W = 250;          // a widget column is narrower: a tile is not a map
const GAP = 20;
const TOP = 100;
const ROW_H = MAP_H + 60;    // room for the identity band under each map

/** Left edge of each of the six columns. */
const COL_X = [
    GAP,
    GAP + (MAP_W + GAP),
    GAP + 2 * (MAP_W + GAP),
    GAP + 3 * (MAP_W + GAP),
    GAP + 3 * (MAP_W + GAP) + (SIDE_W + GAP),
    GAP + 3 * (MAP_W + GAP) + 2 * (SIDE_W + GAP),
];

/**
 * The variety, one entry per grid row, cycled.
 *
 * `F-29` asks for many different examples, so each row pairs its maps with a
 * different companion: a plain tile, a tile with every readout on, a stale-marking
 * tile, and both chart styles. A page that showed the same tile nineteen times
 * would demonstrate one thing nineteen times.
 */
const FLAVOURS = [
    { kind: 'Widget', note: 'tile - identity only',
        attrs: { 'show-substrate-id': 'true' } },
    { kind: 'Widget', note: 'tile - yield and histogram',
        attrs: { 'show-substrate-id': 'true', 'show-yield': 'true', 'show-bin-histogram': 'true' } },
    { kind: 'BinChart', note: 'chart - bars, most common first',
        attrs: { 'chart-style': 'Bars', 'chart-sort': 'CountDescending' } },
    { kind: 'Widget', note: 'tile - marks itself stale after 30 s',
        attrs: { 'show-substrate-id': 'true', 'show-yield': 'true', 'stale-after-seconds': '30' } },
    { kind: 'BinChart', note: 'chart - share, most common first',
        attrs: { 'chart-style': 'Share', 'chart-sort': 'CountDescending' } },
    { kind: 'Widget', note: 'tile - bare, no readouts at all',
        attrs: {} },
    { kind: 'BinChart', note: 'chart - bars, capped at four categories',
        attrs: { 'chart-style': 'Bars', 'category-cap': '4' } },
];

/** The data attributes a companion can accept, in the order they are looked for. */
/*
 * ALL THREE, since `F-30` (`D-260`).
 *
 * This read `GridData` only, because the widget family declared `E142MapData` and
 * `E142MapDataJson`, stored them and never looked at them - so binding them here
 * produced seven confidently blank tiles beside seven working maps. `F-30` made
 * both controls read them, by the map's own route through the engine, and the
 * seven companions now show what their maps show.
 *
 * `SubstrateMapWidget` and `SubstrateMapBinChart` both DECLARE `E142MapData` and
 * `E142MapDataJson`, both have setters that store the value, and both have getters
 * that hand it back - and `__buildGrid` reads `this.__gridData` and nothing else.
 * Measured: `setE142MapData(xml)` then `getE142MapData()` returns the document and
 * `__sceneGrid` is still null.
 *
 * So binding those attributes here would produce seven confidently blank tiles
 * beside seven working maps, and the page would be advertising a defect as a
 * feature. They are left unbound and each says why, which is the only honest thing
 * a demonstration can do about a control that accepts an input it never reads.
 */
const DATA_ATTRS = ['grid-data', 'e142-map-data', 'e142-map-data-json'];

/* -------------------------------------------------------------------- parse */
const view = readFileSync(VIEW, 'utf8');
const eol = view.includes('\r\n') ? '\r\n' : '\n';

/** @returns Every control div's `{ id, type, tag, start, end, attrs }`. */
function controls(text) {
    const out = [];
    const re = /<div\s+id="([A-Za-z0-9_]+)"\s+data-tchmi-type="([^"]+)"/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        // The first '>' outside a quoted value closes the opening tag.
        let i = re.lastIndex;
        let q = null;
        for (; i < text.length; i++) {
            const ch = text[i];
            if (q !== null) { if (ch === q) { q = null; } continue; }
            if (ch === '"' || ch === "'") { q = ch; continue; }
            if (ch === '>') { break; }
        }
        const tag = text.slice(m.index, i + 1);
        out.push({
            id: m[1], type: m[2].split('.').pop(), tag, start: m.index, end: i + 1,
            attrs: Object.fromEntries(
                [...tag.matchAll(/data-tchmi-([a-z0-9-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]])),
        });
    }
    return out;
}

const all = controls(view);
/*
 * The dashboard's own maps are excluded: they exist to be driven by one filter bar,
 * which is a different demonstration and is left where it is.
 */
const maps = all.filter((c) => c.type === 'SubstrateMap' && !c.id.startsWith('DashMap_'));

/* ------------------------------------------------------------------ rewrite */
/** @param tag An opening tag. @param set Attributes to force. @returns The tag. */
function withAttrs(tag, set) {
    let out = tag;
    for (const [k, v] of Object.entries(set)) {
        const re = new RegExp(`data-tchmi-${k}="[^"]*"`);
        out = re.test(out)
            ? out.replace(re, `data-tchmi-${k}="${v}"`)
            : out.replace(/^<div\s+id="[A-Za-z0-9_]+"/, (h) => `${h} data-tchmi-${k}="${v}"`);
    }
    return out;
}

/**
 * Why a map's data could not be handed to its companion.
 *
 * Three of the nineteen cannot be mirrored, for two DIFFERENT reasons, and saying
 * so is the point: the widget family accepts `GridData`, `E142MapData` and
 * `E142MapDataJson` and nothing else, so a map bound through `Items` or
 * `E142TransferData` has data its companion has no attribute to receive. That is a
 * gap in the widget's surface, found by trying to mirror every panel, and it is
 * written on the page rather than left as an empty tile nobody can explain.
 * @param m The map control.
 * @returns A sentence for the comment.
 */
const unmirrorable = (m) => {
    if ('items' in m.attrs) {
        return '. EMPTY: the map binds Items, and no widget has an Items attribute - '
            + 'the widget family takes GridData, E142MapData or E142MapDataJson only.';
    }
    if ('e142-transfer-data' in m.attrs) {
        return '. EMPTY: the map binds E142TransferData (Stream-21), which no widget declares.';
    }
    return '. EMPTY: the map binds nothing - it draws demo content, and there is '
        + 'nothing to hand on.';
};

const placed = [];
const companions = [];
maps.forEach((m, i) => {
    const row = Math.floor(i / 3);
    const col = i % 3;
    const top = TOP + row * ROW_H;
    placed.push({
        id: m.id,
        tag: withAttrs(m.tag, {
            left: String(COL_X[col]), 'left-unit': 'px', top: String(top), 'top-unit': 'px',
            width: String(MAP_W), 'width-unit': 'px', height: String(MAP_H), 'height-unit': 'px',
        }),
    });

    const f = FLAVOURS[row % FLAVOURS.length];
    const data = DATA_ATTRS.find((k) => k in m.attrs);
    const bind = data === undefined ? '' : `${eol}         data-tchmi-${data}="${m.attrs[data]}"`;
    const extra = Object.entries(f.attrs)
        .map(([k, v]) => `${eol}         data-tchmi-${k}="${v}"`).join('');
    companions.push(
        `    <!-- col ${col + 4} <- col ${col + 1}: ${m.id.replace('SubstrateMap_', '')} as a `
        + `${f.note}${data === undefined ? unmirrorable(m) : ''} -->${eol}`
        + `    <div id="${m.id.replace('SubstrateMap_', 'Side_')}" `
        + `data-tchmi-type="${NS}.SubstrateMap${f.kind}"${eol}`
        + `         data-tchmi-left="${COL_X[col + 3]}" data-tchmi-left-unit="px" `
        + `data-tchmi-top="${top}" data-tchmi-top-unit="px"${eol}`
        + `         data-tchmi-width="${SIDE_W}" data-tchmi-width-unit="px" `
        + `data-tchmi-height="${SIDE_W}" data-tchmi-height-unit="px"`
        + `${bind}${extra}></div>`);
});

/* --------------------------------------------------------------- assemble */
let next = view;
// Reposition the maps, back to front so the earlier offsets stay valid.
for (let i = maps.length - 1; i >= 0; i--) {
    next = next.slice(0, maps[i].start) + placed[i].tag + next.slice(maps[i].end);
}

const body = [
    '',
    `    <!-- ${maps.length} companions, one per map, generated by tools/relayout-desktop.mjs.`,
    '         Each is handed the SAME data attribute its map carries, so a tile cannot',
    '         show a different lot from the map beside it. Do not edit by hand. -->',
    '',
    ...companions,
    '',
].join(eol);

const i0 = next.indexOf(BEGIN);
const i1 = next.indexOf(END);
if (i0 === -1 || i1 === -1) {
    console.error(`relayout-desktop: no ${BEGIN} … ${END} block in Desktop.view`);
    process.exit(2);
}
let wanted = next.slice(0, i0 + BEGIN.length) + body + next.slice(i1);

/*
 * THE DASHBOARD MOVES DOWN WITH THE GRID (F-29). It sat at a hand-written top of
 * 2560, which the six-column grid grew straight through - a page that overlaps
 * itself is a page nobody can read, and a fixed coordinate below a variable block
 * is a collision waiting for the next panel. Its offsets are shifted as a group so
 * the arrangement inside it survives.
 */
const gridBottom = TOP + Math.ceil(maps.length / 3) * ROW_H;
const DASH_GAP = 80;
{
    const dash = controls(wanted).filter((c) => c.id.startsWith('Dash'));
    const oldTop = Math.min(...dash.map((c) => Number(c.attrs.top)));
    const delta = (gridBottom + DASH_GAP) - oldTop;
    if (delta !== 0) {
        for (let i = dash.length - 1; i >= 0; i--) {
            const c = dash[i];
            const moved = withAttrs(c.tag, { top: String(Number(c.attrs.top) + delta) });
            wanted = wanted.slice(0, c.start) + moved + wanted.slice(c.end);
        }
    }
}

if (!CHECK) {
    writeFileSync(VIEW, wanted, 'utf8');
    console.log(`  Desktop.view: ${maps.length} maps in 3 columns, ${companions.length} companions in 3 more`);
    process.exit(0);
}
if (wanted === view) {
    console.log(`  desktop grid          : ${maps.length} maps and their companions, in step`);
    process.exit(0);
}
console.error('\n  Desktop.view grid is out of step with its maps.');
console.error('  Run: node tools/relayout-desktop.mjs\n');
process.exit(1);
