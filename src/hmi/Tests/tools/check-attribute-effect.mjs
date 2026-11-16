#!/usr/bin/env node
/*
 * check-attribute-effect.mjs - binding an attribute must CHANGE something.
 *
 * ---- WHY THIS EXISTS, AND WHY IT IS NOT A STATIC CHECK ----
 *
 * `SubstrateMapWidget` declared `E142MapData`, stored it in a setter, and built its
 * grid from `GridData` only. A tile bound to a valid document showed "no data" while
 * holding it. `check-descriptors` proves an attribute exists in the descriptor AND in
 * the class - which it did, with a setter, a getter, a backing field and a schema
 * entry. Existing is not being used.
 *
 * A STATIC version of this check was built and thrown away. It reported two working
 * attributes as dead and never found the defect above, because "does this value reach
 * anything" is a reachability problem over a class hierarchy and it was being
 * answered with text matching: a value can leave a class through its field, through
 * its getter, or through a push that carries it into the base; a private field name
 * recurs on sibling controls; and a getter's own definition matches "is the getter
 * called".
 *
 * ---- WHAT THIS DOES INSTEAD ----
 *
 * It asks the question itself. Render a control, call one setter with a value that
 * differs from the default, render again, and require the two recordings to differ -
 * in what was drawn, in what was published, or in what was raised.
 *
 * No model of pushes, privates or accessors. If an author can bind it, something
 * downstream is different, or the attribute does nothing.
 *
 * ---- THE PROBE TABLE ----
 *
 * A probe is a value known to differ from the default. `String`, `Number` and
 * `Boolean` are derived from the descriptor's own `defaultValue`. The framework types
 * are objects and enumerations whose meaningful values cannot be read off a schema -
 * the first `enum` in `GridData.Schema.json` is `originLocation`, not the attribute's
 * value set - so each is a LINE HERE. An attribute with no probe is REPORTED, never
 * skipped silently: a coverage check with a quiet exception list is the shape of
 * defect it exists to catch.
 *
 *   node tools/check-attribute-effect.mjs
 *   node tools/check-attribute-effect.mjs --verbose   name every attribute and its verdict
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { installDomShims } from '../Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs';

installDomShims();
const H = await import('./attach-harness.mjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERBOSE = process.argv.includes('--verbose');

/** A small grid, so there is something on the canvas to be changed. */
const GRID = JSON.stringify({
    dimension: { x: 8, y: 8 }, units: 'mm', stepSize: { x: 8, y: 8 }, orientation: 0,
    originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii',
    nullBin: '.', mapType: '2DArray',
    binDefinitions: [{ binCode: 'P', binQuality: 'Pass' }, { binCode: 'F', binQuality: 'Fail' }],
    bins: ['..PPPP..', '.PPPPPF.', 'PPPPPFFP', 'PPPPFFPP',
        'PPPFFPPP', 'PPFFPPPP', '.PFPPPP.', '..PPPP..'],
});

/**
 * Probes for the types no default can produce one for. Each is a value that differs
 * from the attribute's default and is legal for its schema.
 */
/* A minimal but VALID E142 document: an invalid probe cannot prove anything. */
const E142_XML = '<?xml version="1.0"?><MapData Version="E142-0710"><Substrate '
    + 'SubstrateId="PROBE"><SubstrateMap MapName="m" MapVersion="1" NullBin="." '
    + 'BinType="Ascii" OriginLocation="LowerLeft" AxisDirection="UpRight" '
    + 'NumberOfColumns="4" NumberOfRows="4"><BinCodeMap>PPPP\nPFFP\nPFFP\nPPPP\n'
    + '</BinCodeMap></SubstrateMap></Substrate></MapData>';

const PROBE = {
    'tchmi:framework#/definitions/SubstrateMapSpatialFilter': 'Median',
    'tchmi:framework#/definitions/SubstrateMapFieldView': 'FailDensity',
    'tchmi:framework#/definitions/SubstrateMapChartStyle': 'Share',
    'tchmi:framework#/definitions/SubstrateMapChartSort': 'CountDescending',
    'tchmi:framework#/definitions/SubstrateMapReferenceMode': 'Difference',
    'tchmi:framework#/definitions/SubstrateMapAggregationReducer': 'FailFraction',
    'tchmi:framework#/definitions/SubstrateMapGridData': GRID,
    'tchmi:framework#/definitions/SubstrateMapViewTransform': [2, 0, 0, 2, 0, 0],
    'tchmi:framework#/definitions/SubstrateMapOutline': {
        unit: 'meter', prefix: 'milli',
        geometry: { type: 'circle', radius: 100 },
    },
    'tchmi:framework#/definitions/SubstrateMapItemList': [{
        id: 'probe', status: 'good',
        geometry: { type: 'rect', x: -20, y: -20, width: 40, height: 40 },
    }],
    'tchmi:framework#/definitions/SubstrateMapLabelList': [{
        text: 'PROBE', x: 0, y: 0,
    }],
    'tchmi:framework#/definitions/SubstrateMapBinSeverityPriority': ['F', 'P'],
    'tchmi:framework#/definitions/SubstrateMapBinQualityAliases': { P: 'Fail' },
    'tchmi:framework#/definitions/SubstrateMapStatusColorMapping': { good: '#ff00ff' },
};

/**
 * A value that differs from this attribute's default.
 * @param a The attribute record from the descriptor.
 * @returns The probe, or `undefined` when none is known.
 */
/*
 * PER-ATTRIBUTE PROBES, where the type is `String` but the SETTER enumerates.
 *
 * `SubstrateIdentityPosition` is declared `String` and accepts `above`, `below` or
 * `none`; anything else is refused and the default kept. A generic string probe is
 * therefore a no-op, and the check reported ten working attributes as dead until
 * these were written down. **The descriptor's type is what the schema validates, not
 * what the setter accepts**, and only the second decides whether a value lands.
 */
const BY_NAME = {
    'SubstrateMap.SubstrateIdentityPosition': 'above',
    'SubstrateMap.SelectionMode': 'multi',
    'SubstrateMap.OriginLocation': 'top-left',
    'SubstrateMap.OutlinePreset': 'si-12in',
    'SubstrateMap.SecondaryFlatDirection': 'ccw',
    'SubstrateMap.YAxisDirection': 'down',
    'SubstrateMap.ViewSubstrateSide': 'flip-x',
    'SubstrateMap.OriginOffsetPrefix': 'micro',
};

function probeFor(a, control) {
    const nm = `${control}.${a.propertyName ?? a.name}`;
    if (/\.E142MapData$/.test(nm)) { return E142_XML; }
    const byName = BY_NAME[`${control}.${a.propertyName ?? a.name}`];
    if (byName !== undefined) { return byName; }
    const t = a.type ?? '';
    if (Object.prototype.hasOwnProperty.call(PROBE, t)) { return PROBE[t]; }
    const d = a.defaultValue;
    if (t.endsWith('/Boolean')) { return !(d === true); }
    if (t.endsWith('/Number')) { return typeof d === 'number' ? d + 7 : 7; }
    if (t.endsWith('/String')) { return d === 'PROBE-VALUE' ? 'PROBE-OTHER' : 'PROBE-VALUE'; }
    return undefined;
}

/*
 * SOME ATTRIBUTES ONLY MATTER IN A CONTEXT THE BASELINE DOES NOT CREATE.
 *
 * `ShowDemoItems` draws nothing while real data is bound - that is its whole point.
 * `ShowLabels` needs labels. `ChartSort` cannot reorder two bins. The baseline binds
 * one eight-by-eight grid, and an attribute whose effect needs more than that is not
 * dead, it is untested by this setup.
 *
 * So each gets the context it needs, by name. The alternative - excusing them - is
 * the silent exception list this check exists to prevent.
 */
const SETUP = {
    'SubstrateMap.ShowDemoItems': (c) => { c.setGridData(null); },
    'SubstrateMap.ShowLabels': (c) => {
        c.setLabels([{ text: 'L', x: 0, y: 0 }]);
    },
    'SubstrateMapBinChart.ChartSort': (c) => {
        c.setGridData(JSON.stringify({
            ...JSON.parse(GRID),
            binDefinitions: [{ binCode: 'A', binQuality: 'Pass' },
                { binCode: 'B', binQuality: 'Pass' }, { binCode: 'C', binQuality: 'Fail' },
                { binCode: 'D', binQuality: 'Fail' }],
            bins: ['AABBCCDD', 'AABBCCDD', 'ABBBCCDD', 'ABBCCCDD',
                'ABBCCDDD', 'AABCCDDD', 'AABBCDDD', 'AABBCCDD'],
        }));
    },
};

/**
 * Everything a frame produced, as one comparable string.
 *
 * The filter bar has no canvas - it writes attributes and builds DOM - so its
 * recording is its element tree and its published values instead.
 * @param c The control.
 * @returns The recording.
 */
function snapshot(c) {
    if (typeof c.__render !== 'function') {
        const dom = JSON.stringify(c.__element?.[0] ?? c.__rootEl ?? null,
            (k, v) => (k === 'parentNode' || k === 'ownerDocument' ? undefined : v));
        return JSON.stringify({ dom, published: publishedOf(c) });
    }
    const ctx = H.renderOnce(c, 260, 220);
    const pick = (arr) => (arr ?? []).map((x) => JSON.stringify(x)).join('|');
    return JSON.stringify({
        fills: pick(ctx.fills), strokes: pick(ctx.strokeRects), texts: pick(ctx.textDraws),
        arcs: pick(ctx.arcFills), paths: (ctx.paths ?? []).length, published: publishedOf(c),
    });
}

/** @param c A control. @returns Every getter's value, as a comparable object. */
function publishedOf(c) {
    const out = {};
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(c))) {
        if (!/^get[A-Z]/.test(k)) { continue; }
        /*
         * THE CLOCK IS NOT EVIDENCE. Every data setter calls `__stampReceived`, so
         * the age changes whether or not the value was used - which made a widget
         * that ignored `E142MapData` entirely look live, the exact defect this check
         * exists for. What an operator sees is the drawing and the values derived
         * from the data; when the data arrived is not one of them.
         */
        if (/Age|Received/i.test(k)) { continue; }
        try { out[k] = JSON.stringify(c[k]()); } catch { out[k] = 'threw'; }
    }
    return out;
}

/*
 * The harness exports `SubstrateMap` only, so the rest are imported from their
 * emitted `.js` - the same modules the suites use.
 */
const W = await import('../Controls/SubstrateMapWidget/SubstrateMapWidget.js');
const C = await import('../Controls/SubstrateMapBinChart/SubstrateMapBinChart.js');
const B = await import('../Controls/SubstrateMapFilterBar/SubstrateMapFilterBar.js');

const CONTROLS = {
    SubstrateMap: () => new H.SubstrateMap(null, null, {}),
    SubstrateMapWidget: () => new W.SubstrateMapWidget(null, null, {}),
    SubstrateMapBinChart: () => new C.SubstrateMapBinChart(null, null, {}),
    SubstrateMapFilterBar: () => new B.SubstrateMapFilterBar(null, null, {}),
};

const noProbe = [];
const noEffect = [];
const threw = [];
let checked = 0;

for (const [name, make] of Object.entries(CONTROLS)) {
    const dp = join(ROOT, 'Controls', name, 'Description.json');
    if (!existsSync(dp)) { continue; }
    const desc = JSON.parse(readFileSync(dp, 'utf8'));
    for (const a of desc.attributes ?? []) {
        const prop = a.propertyName ?? a.name;
        if (typeof prop !== 'string' || a.readOnly === true) { continue; }
        const probe = probeFor(a, name);
        if (probe === undefined) {
            noProbe.push(`${name}.${prop} (${(a.type ?? '?').split('/').pop()})`);
            continue;
        }
        let before;
        let after;
        try {
            const c = make();
            c.__attach();
            /*
             * THE BASELINE MUST NOT PRE-BIND A RIVAL INPUT.
             *
             * Binding `GridData` to everything gives the control a map before the
             * probe runs, so an attribute that is a MAP INPUT can be ignored
             * entirely and the drawing will not change. That is `D-258` exactly -
             * a tile bound to E142 showing "no data" while holding it - and this
             * check could not see it while the baseline was doing the same thing
             * observation 419 blamed the corpus for: every suite bound `GridData`
             * because the first one did.
             */
            const isMapInput = /^(GridData|E142MapData|E142MapDataJson|E142TransferData)$/
                .test(prop);
            if (typeof c.setGridData === 'function' && !isMapInput) { c.setGridData(GRID); }
            SETUP[`${name}.${prop}`]?.(c);
            before = snapshot(c);
            c[`set${prop}`](probe);
            after = snapshot(c);
        } catch (e) {
            threw.push(`${name}.${prop}: ${String(e?.message ?? e).split('\n')[0].slice(0, 90)}`);
            continue;
        }
        checked++;
        if (before === after) {
            noEffect.push(`${name}.${prop} — bound and nothing downstream differed: not the drawing, `
                + 'not a published attribute. An author can set it and no frame will change.');
        } else if (VERBOSE) {
            console.log(`  ok  ${name}.${prop}`);
        }
    }
}

/*
 * A SHRINKING BASELINE, not a flat rule, and the honest reason is that the ELEVEN
 * are not known to be defects - they are attributes this setup cannot yet
 * demonstrate. Four need a context the baseline does not build; six need a probe
 * value that is a document rather than a scalar; one throws in the Path2D shim.
 *
 * Every one is named on every run. A coverage tool that hides what it could not
 * cover is the shape of defect it exists to catch, so the number is printed, the
 * names are printed, and it may only fall.
 */
const OUTSTANDING = noEffect.length + noProbe.length + threw.length;
const BASELINE = 11;

console.log(`\nattribute effect     : ${checked} of ${checked + OUTSTANDING} input attribute(s) `
    + `proven live; ${OUTSTANDING} outstanding, baseline ${BASELINE}`);
for (const f of noEffect) { console.log(`  [attr-effect] ${f}`); }
if (threw.length > 0) {
    console.log(`  ${threw.length} setter(s) threw and were not judged:`);
    for (const t of threw.slice(0, 5)) { console.log(`    ${t}`); }
}
if (noProbe.length > 0) {
    console.log(`  ${noProbe.length} attribute(s) have no probe — add one to PROBE:`);
    for (const n of noProbe) { console.log(`    ${n}`); }
}
if (OUTSTANDING === 0) {
    console.log('  every input attribute changes the drawing or a published value');
} else if (OUTSTANDING > BASELINE) {
    console.log(`  ${OUTSTANDING} outstanding, above the baseline of ${BASELINE} - an attribute `
        + 'stopped having an effect, or a new one arrived without a probe.');
} else if (OUTSTANDING < BASELINE) {
    console.log(`  ${BASELINE - OUTSTANDING} fewer than the baseline - lower BASELINE in `
        + 'tools/check-attribute-effect.mjs to lock the gain in');
}
process.exit(OUTSTANDING > BASELINE ? 1 : 0);
