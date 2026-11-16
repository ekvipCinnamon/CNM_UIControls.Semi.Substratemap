/*
 * e142-composition.test.mjs - several overlays on one SubstrateMap.
 *
 * E142 permits many overlays per SubstrateMap and 13.1 defines each as "an array
 * of data that corresponds to the dimensions on the Layout to which the
 * containing SubstrateMap is assigned" - one LayoutSpecifier per SubstrateMap,
 * hence one lattice, hence every overlay is an array over it.
 *
 * `ws/notes/DECISION-overlay-composition.md` chose BASE LAYER + ORDERED
 * DECORATIONS over the two obvious alternatives: one BinCodeMap owns the fill
 * and the geometry, and further overlays contribute per-cell marks. Stacking
 * with opacity was rejected because blending two bin colours yields a colour
 * that maps back to no bin code at all; switching one overlay at a time was
 * rejected because it destroys COINCIDENCE, the only question layers exist to
 * answer.
 *
 * Five families:
 *   1. layer lattice mismatch is rejected, with a typed error
 *   2. selection reports the base AND every decoration bin
 *   3. `E142Overlays` overriding the scalar attributes warns
 *   4. the decoration pass draws marks, and draws nothing without layers
 *   5. `ShowDemoItems` losing to a bound Outline / OutlinePreset warns
 *   6. the attach batch coalesces the map rebuild to one
 *   7. E142MapDataJson.Schema.json states the invariants JSON-FORMAT.md decided
 *
 * Families 2, 3 and 5 are the control's, and the control needs a DOM - so they
 * replay its expressions over a real model and assert that its source performs
 * them. Families 1 and 4 call the engine directly.
 *
 * Family 5 is therefore a SOURCE assertion, not a behavioural one: it cannot
 * observe a log line, only that the control is wired to emit one. It is aimed at
 * the regression that actually happens - the warn condition drifting away from
 * the branch condition it is supposed to describe.
 *
 * Run: node --test Helpers/SubstrateMapEngine/tests/e142-composition.test.mjs
 *      npm run test:composition
 */

import { readFileSync } from 'node:fs';
import { onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const Engine = await import(ENGINE + 'Engine.js');

/* ------------------------------ harness ------------------------------ */
let PASS = 0, FAIL = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES }));
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; FAILURES.push(label); } }
function eq(a, b, label) {
    ok(Object.is(a, b), `${label}  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function deep(a, b, label) {
    ok(JSON.stringify(a) === JSON.stringify(b), `${label}  (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}
function has(hay, needle, label) {
    ok(typeof hay === 'string' && hay.includes(needle), `${label}  (missing ${JSON.stringify(needle)})`);
}

const SRC = readFileSync(new URL('../../../Controls/SubstrateMap/SubstrateMap.ts', import.meta.url), 'utf8');
/** Source with JSDoc asterisks stripped and adjacent literals joined - the Task 57 recipe. */
const FLAT = SRC.replace(/^\s*\*\s?/gm, '').replace(/'\s*\+\s*'/g, '').replace(/`\s*\+\s*`/g, '').replace(/\s+/g, ' ');
/**
 * The flattened text of ONE member, from its signature to the start of the next
 * one. Fixed-size windows were used here first and broke the moment a member
 * grew by four lines; the member boundary is the thing actually meant.
 */
function member(signature) {
    const from = FLAT.indexOf(signature);
    if (from === -1) { return ''; }
    const rest = FLAT.slice(from + signature.length);
    const next = rest.search(/\b(?:public|protected|private) [\w_]+[(:]/);
    return signature + (next === -1 ? rest : rest.slice(0, next));
}

/* ------------------------------ fixtures ----------------------------- */
const PLACEMENT = {
    originXmm: 0, originYmm: 0,
    colStepXmm: 1, colStepYmm: 0,
    rowStepXmm: 0, rowStepYmm: -1,
    cellWmm: 1, cellLmm: 1, sideMirror: false,
};
/** A 3 x 2 base whose six cells all carry bin `a`. */
const basePayload = () => ({
    cols: 3, rows: 2,
    cells: new Uint32Array([1, 1, 1, 1, 1, 1]),
    codes: ['.', 'a'],
});
/** A layer over the same lattice; `pattern` is one index per cell, 0 = null bin. */
const layerOf = (mapName, pattern, mapVersion = '1', code = 'x') => ({
    mapName, mapVersion,
    cells: new Uint32Array(pattern),
    binTable: [{ code: '.', quality: null, pick: false }, { code, quality: 'Fail', pick: false }],
});
const COLORS = {
    bg: '', body: '#ddd', edge: '#666', selection: '#05a', unknown: '#666',
    binPass: '#0a7', binFail: '#d50', labelFont: '12px x', labelColor: '#222',
    decoration: ['#c1', '#c2', '#c3', '#c4'],
};

/* =====================================================================
 * 1. Layer lattice mismatch
 * ===================================================================== */
console.log('\n=== 1. a layer that disagrees on the lattice is REJECTED ===');
{
    const good = Engine.buildGridModel(PLACEMENT, basePayload(), null,
        [layerOf('DefectCode', [1, 0, 1, 0, 1, 0])]);
    ok(good !== null, 'a layer over the same 3 x 2 lattice composes');
    eq(good.layers.length, 1, '  one layer on the model');
    eq(good.layers[0].mapName, 'DefectCode', '  keeping its name');
    eq(good.layers[0].mapVersion, '1', '  and its version - OverlayKey is the pair');
}
{
    let err = null;
    try {
        Engine.buildGridModel(PLACEMENT, basePayload(), null, [layerOf('Short', [1, 1, 1, 1])]);
    } catch (e) { err = e; }
    ok(err !== null, 'a SHORT layer is refused');
    ok(err instanceof Engine.GridLayerError, '  with GridLayerError, not a null return');
    eq(err && err.code, 'E142_LAYER_EXTENT', '  code E142_LAYER_EXTENT');
    eq(err && err.mapName, 'Short', '  naming the offending layer');
    const flat = err.message.replace(/\s+/g, ' ');
    has(flat, 'spans 4 cells; the base grid is 3 x 2 = 6', '  stating both extents');
    has(flat, '13.1 defines an Overlay as an array over', '  citing the clause');
    has(flat, 'not a second lattice', '  saying what it is instead');
    has(flat, 'refused rather than cropped or scaled', '  and what was deliberately NOT done');
    has(flat, 'marks the WRONG dies', '  and why cropping would be worse than refusing');
}
{
    /* A LONGER layer is tolerated: it spans at least the base and the surplus is
     * unused. Refusing it would be stricter than the schema, which is the one
     * thing this parser must never be. */
    let err = null;
    try {
        Engine.buildGridModel(PLACEMENT, basePayload(), null, [layerOf('Long', new Array(12).fill(1))]);
    } catch (e) { err = e; }
    ok(err === null, 'a LONGER layer is accepted - the surplus is simply unused');
}
{
    /* The base is unaffected by a bad decoration: the control catches
     * GridLayerError and rebuilds without layers rather than blanking the map. */
    ok(FLAT.includes('if (e instanceof GridLayerError)'), 'the control catches GridLayerError');
    ok(FLAT.includes('grid = buildGridModel(placement, payload, binDefs ? binDefs.map(toEngineBinDefinition) : null);'),
        '  and rebuilds WITHOUT decorations rather than failing the map');
    ok(FLAT.includes('The BASE is fine'), '  because the base is fine and only the decoration is wrong');
}
{
    /* Out-of-range bin indices are caught once, here, so a renderer never
     * re-checks per frame. */
    let err = null;
    try {
        Engine.buildGridModel(PLACEMENT, basePayload(), null,
            [{ mapName: 'Bad', mapVersion: '1', cells: new Uint32Array([0, 1, 9, 0, 0, 0]),
                binTable: [{ code: '.', quality: null }, { code: 'x', quality: null }] }]);
    } catch (e) { err = e; }
    eq(err && err.code, 'E142_LAYER_BIN_INDEX', 'an out-of-range bin index is caught at build time');
}

/* =====================================================================
 * 2. Selection reports base and decoration bins
 * ===================================================================== */
console.log('\n=== 2. selection reports the base AND every decoration ===');
{
    /* Cell 0 is named by both layers, cell 1 only by the base, cell 2 by the
     * base and the second layer. That is the coincidence a switch view cannot
     * show and this composition exists to make visible. */
    const grid = Engine.buildGridModel(PLACEMENT, basePayload(), null, [
        layerOf('DefectCode', [1, 0, 0, 0, 0, 0], '1', 'D07'),
        layerOf('MarkGrade', [1, 0, 1, 0, 0, 0], '2', 'MB'),
    ]);
    /* Exactly the control's __overlayBinsAt. */
    const at = (cells, table, cell) => {
        if (cell < 0 || cell >= cells.length) { return { binCode: null, binQuality: null }; }
        const idx = cells[cell];
        if (idx === 0) { return { binCode: null, binQuality: null }; }
        const b = table[idx];
        return { binCode: b ? b.code : null, binQuality: b ? b.quality : null };
    };
    const report = (cell) => {
        if (grid.layers === undefined || grid.layers.length === 0) { return null; }
        const out = [{ mapName: 'SortGrade', mapVersion: '', ...at(grid.cells, grid.binTable, cell) }];
        for (const l of grid.layers) {
            out.push({ mapName: l.mapName, mapVersion: l.mapVersion, ...at(l.cells, l.binTable, cell) });
        }
        return out;
    };

    const c0 = report(0);
    eq(c0.length, 3, 'three entries: the base plus two decorations');
    eq(c0[0].mapName, 'SortGrade', 'the BASE is first');
    eq(c0[0].binCode, 'a', '  with its own bin');
    eq(c0[1].mapName, 'DefectCode', 'then the decorations, in list order');
    eq(c0[1].binCode, 'D07', '  each with ITS bin, not the base\u2019s');
    eq(c0[1].binQuality, 'Fail', '  and its quality');
    eq(c0[2].mapName, 'MarkGrade', 'second decoration');
    eq(c0[2].mapVersion, '2', '  carrying its own version - OverlayKey is (MapName, MapVersion)');
    eq(c0[2].binCode, 'MB', '  and its bin');

    const c1 = report(1);
    eq(c1.length, 3, 'a cell only the base names still lists all three');
    eq(c1[0].binCode, 'a', '  the base names it');
    eq(c1[1].binCode, null, '  and a silent layer reports null');
    ok(c1[1].mapName === 'DefectCode', '  but is STILL LISTED - absent would mean "no such overlay"');

    const c2 = report(2);
    eq(c2[1].binCode, null, 'cell 2: DefectCode says nothing');
    eq(c2[2].binCode, 'MB', '  MarkGrade does - the coincidence is visible');

    ok(report.length >= 0 && Engine.buildGridModel(PLACEMENT, basePayload(), null).layers === undefined,
        'and an uncomposed map has no layers at all');
}
{
    ok(FLAT.includes('protected __overlayBinsAt('), 'the control has __overlayBinsAt');
    ok(FLAT.includes('eventData.overlays = g === null'), '  onItemSelected sets overlays');
    ok(FLAT.includes('entry.overlays = this.__overlayBinsAt(grid, sel.itemId);'), '  SelectedItems sets it too');
    ok(FLAT.includes('Index 0 is the reserved NULL bin'), '  and the null bin is reported as null, not as its code');
    const SCH = JSON.parse(readFileSync(
        new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/SelectionList.Schema.json', import.meta.url), 'utf8'));
    const p = SCH.definitions.SubstrateMapSelectionList.items.properties.overlays;
    ok(p !== undefined, 'overlays is declared in SelectionList.Schema.json');
    deep(p.type, ['array', 'null'], '  array|null');
    deep(p.items.required, ['mapName', 'mapVersion'], '  name and version required on every entry');
    has(p.description, 'binCode on this entry remains the BASE', '  and the description says binCode is unchanged');
}

/* =====================================================================
 * 3. E142Overlays overriding the scalar attributes
 * ===================================================================== */
console.log('\n=== 3. E142Overlays vs E142OverlayName / E142OverlayVersion ===');
{
    ok(FLAT.includes('E142_OVERLAYS_OVERRIDES_SINGLE'), 'binding both is reported');
    ok(FLAT.includes('the LIST is used and the single-overlay attributes are ignored'),
        '  and the LIST wins');
    ok(FLAT.includes('cannot both decide it'), '  saying why one has to lose');
    ok(FLAT.includes('Clear the list to go back to them'), '  and how to undo it');
    ok(SRC.includes('this.__e142OverlayName !== null || this.__e142OverlayVersion !== null'),
        '  checked against BOTH scalar attributes, not just the name');
    ok(FLAT.includes('E142_OVERLAYS_MULTIPLE_BASE'), 'two entries claiming role "base" is reported');
    ok(FLAT.includes('a contradiction rather than a preference'),
        '  and named a contradiction - one overlay owns the fill');
    ok(SRC.includes("v[0].role = 'base';"), 'no role anywhere -> the FIRST entry is the base');
    ok(SRC.includes("'version' in raw"), "and version uses a membership test, so '' survives");
}
{
    ok(FLAT.includes('E142_OVERLAYS_DECORATION_NOT_FOUND'),
        'a decoration naming no renderable overlay is reported');
    ok(FLAT.includes('The remaining decorations are still drawn'),
        '  and the rest are still drawn - one bad name is not fatal');
    ok(FLAT.includes('this.__e142Overlays !== null ? this.__buildDecorationLayers('),
        'and the layers are built only when the list is bound');
}

/* =====================================================================
 * 4. The decoration pass
 * ===================================================================== */
console.log('\n=== 4. the decoration pass draws marks, and nothing without layers ===');
{
    let paths = 0;
    const fills = [];
    const ctx = {
        set fillStyle(v) { fills.push(v); }, get fillStyle() { return ''; },
        beginPath() { paths++; }, moveTo() {}, lineTo() {}, closePath() {}, fill() {},
    };

    paths = 0; fills.length = 0;
    Engine.renderGridDecorations(ctx, Engine.buildGridModel(PLACEMENT, basePayload(), null), COLORS);
    eq(paths, 0, 'NO LAYERS -> nothing is drawn at all');
    eq(fills.length, 0, '  and no fill style is even set');

    paths = 0; fills.length = 0;
    Engine.renderGridDecorations(ctx,
        Engine.buildGridModel(PLACEMENT, basePayload(), null, [layerOf('D', [1, 0, 1, 0, 1, 0])]), COLORS);
    eq(paths, 3, 'one layer -> one wedge per NON-NULL cell');
    ok(paths !== 6, '  null cells are skipped: a mark there would assert coverage the document never claimed');
    deep(fills, ['#c1'], '  one colour, from the layer palette');

    paths = 0; fills.length = 0;
    Engine.renderGridDecorations(ctx, Engine.buildGridModel(PLACEMENT, basePayload(), null,
        [layerOf('A', [1, 0, 1, 0, 1, 0]), layerOf('B', [1, 1, 1, 1, 1, 1])]), COLORS);
    eq(paths, 9, 'two layers -> 3 + 6 wedges');
    deep(fills, ['#c1', '#c2'], '  a colour per layer, in list order');
}
{
    const ESRC = readFileSync(new URL('../Engine.ts', import.meta.url), 'utf8');
    const EFLAT = ESRC.replace(/^\s*\*\s?/gm, '').replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
    ok(EFLAT.includes('A MARK, NEVER A FILL'), 'the pass is documented as a mark, never a fill');
    ok(EFLAT.includes('CORNER PER LAYER'), '  with a corner per layer');
    ok(EFLAT.includes('Position is what distinguishes layers at a glance'),
        '  position primary, colour reinforcing - so it survives colour-vision deficiency');
    ok(ESRC.includes('if (grid.layers !== undefined && grid.layers.length > 0) {'),
        'and the whole pass sits behind one guard');
    ok(EFLAT.includes('Decorations run AFTER BOTH BRANCHES'),
        '  running after the cached AND uncached branches, not only the uncached one');
    ok(EFLAT.includes('the layer list is in none of those'),
        '  and deliberately not baked into the cached bitmap');
}

/* =====================================================================
 * 5. ShowDemoItems with a bound Outline / OutlinePreset — the demo draws INTO it
 * ===================================================================== */
console.log('\n=== 5. ShowDemoItems with an Outline / OutlinePreset ===');
{
    /*
     * REWRITTEN AT W-14. This section used to assert the SUPPRESSION and its
     * warning, in ten assertions: that the real branch fires on the outline alone,
     * that `SUBSTRATEMAP_DEMO_SUPPRESSED_BY_OUTLINE` names both attributes and says
     * how to undo it, that the warn latches, that it reads the built models rather
     * than the raw attributes, and that three setters reach it.
     *
     * All ten described behaviour that no longer exists. A view binding an outline
     * AND a demo clearly wanted both, and what it used to get was an empty
     * substrate plus a warning telling it to remove one of the two things it asked
     * for. The demo now draws into the outline as its box.
     *
     * The assertions below are the ones that survive the change in substance: real
     * items still win, and the warning is gone from the source rather than merely
     * unreachable.
     */
    const BRANCH = 'const outlineModel = this.__outlineModel ?? this.__presetOutlineModel; '
        + 'if (outlineModel !== null || this.__itemModels.length > 0) {';
    ok(FLAT.includes(BRANCH), 'the real branch still triggers on the outline alone');

    /* The one case that changed, and its condition. `__itemModels.length === 0`
     * and not `!this.__mapBound()`: what suppresses the demo is something REAL TO
     * DRAW, not merely a document that produced nothing. */
    ok(FLAT.includes('if (this.__itemModels.length === 0 && !this.__hasRenderableGrid() '
        + '&& this.__showDemoItems && this.__demo !== null) {'),
        'and inside it, the demo draws when there is nothing real to draw');
    ok(FLAT.includes('return this.__sceneGrid !== null && this.__sceneGrid.cols * this.__sceneGrid.rows > 0;'),
        '  where a GRID counts as real, which W-14 missed and W-15 found');
    ok(FLAT.includes('items: this.__demo.items,'), '  taking the demo items');
    ok(FLAT.includes('mapping: this.__demo.mapping,'), '  and the demo mapping');

    /* The box. Both entry points have to supply it, or an outline change would
     * leave the demo scaled to the previous one. */
    ok(FLAT.includes('const box = this.__outlineModel ?? this.__presetOutlineModel; '
        + 'this.__demo = this.__showDemoItems ? buildDemo(box ? box.bbox : null) : null;'),
        '__rebuildDemo scales the demo into the active outline');
    ok(FLAT.includes('this.__demo = buildDemo(box ? box.bbox : null);'),
        '  and __refitAfterOutlineChange re-scales it when the outline changes');

    /* Done-when 3: gone, not commented out. */
    ok(!FLAT.includes('SUBSTRATEMAP_DEMO_SUPPRESSED_BY_OUTLINE'),
        'the warning code is nowhere in the control');
    ok(!FLAT.includes('__warnIfDemoSuppressedByOutline'), '  nor its helper');
    ok(!FLAT.includes('__demoSuppressedWarned'), '  nor its latch');

    /* `__showDemoItemsWritten` survives the deletion on purpose: it records an
     * explicit write, which is a fact about the binding rather than about the
     * warning that used to read it. */
    ok(FLAT.includes('if (valueNew !== null && valueNew !== undefined) { this.__showDemoItemsWritten = true; }'),
        'the explicit-write flag is still recorded');
    {
        const setter = member('public setShowDemoItems(valueNew: boolean | null): void {');
        ok(setter.indexOf('this.__showDemoItemsWritten = true') < setter.indexOf('tchmi_equal(b, this.__showDemoItems)'),
            '  before the no-op guard, or an explicit "true" is never seen');
    }
}

/* =====================================================================
 * 6. The attach batch coalesces the map rebuild
 * ===================================================================== */
console.log('\n=== 6. attach-batch coalescing ===');
{
    /* Task 2c measured five to six placement builds per control on the reference
     * page, all but the last discarded. Task 3 defers them to one at attach.
     *
     * The behavioural proof is executable and lives in the harness
     * (`npm run harness`), which cannot be a gate - it needs @xmldom/xmldom, and
     * the control needs a DOM. What is asserted here is the wiring, aimed at the
     * regression that would actually happen: the gate being cleared in the wrong
     * place, or the owed rebuild being dropped. */
    ok(FLAT.includes('protected __attachPending: boolean = true;'),
        'the gate starts closed - the batch begins at construction, not at the first setter');
    ok(FLAT.includes('protected __mapRebuildOwed: boolean = false;'), '  with nothing owed yet');

    ok(FLAT.includes('if (this.__attachPending) { this.__mapRebuildOwed = true; return; }'),
        '__rebuildMap records the debt and returns while the batch is open');
    const BODY = FLAT.slice(FLAT.indexOf('protected __rebuildMap(): void {'), FLAT.indexOf('protected __rebuildMap(): void {') + 400);
    ok(BODY.indexOf('if (this.__attachPending)') < BODY.indexOf('switch (this.__activeInput)'),
        '  and does so BEFORE reading __activeInput, so no partial work escapes');

    const ATTACH = FLAT.slice(FLAT.indexOf('public __attach(): void {'));
    const window_ = ATTACH.slice(0, ATTACH.indexOf('__rebuildDemo();') + 20);
    ok(window_.includes('this.__attachPending = false;'), '__attach closes the batch');
    ok(window_.includes('if (this.__mapRebuildOwed) { this.__mapRebuildOwed = false; this.__rebuildMap(); }')
        || (window_.includes('this.__mapRebuildOwed = false;') && window_.includes('this.__rebuildMap();')),
        '  and pays the one owed rebuild');
    ok(window_.indexOf('this.__attachPending = false;') < window_.indexOf('this.__rebuildMap();'),
        '  clearing the gate first, or the rebuild would defer itself for ever');
    ok(window_.indexOf('this.__rebuildMap();') < window_.indexOf('this.__rebuildDemo();'),
        '  and before __rebuildDemo, so demo suppression still sees the bound map');

    /* One assignment to true - the initialiser. A re-arm anywhere would make a
     * post-attach setter silently stop rebuilding, which no gate would catch. */
    const arms = (FLAT.match(/__attachPending(?::\s*boolean)?\s*=\s*true/g) ?? []).length;
    eq(arms, 1, 'the gate is never re-armed: exactly one assignment to true, the field initialiser');
}

/* =====================================================================
 * 7. The E142 JSON envelope schema
 * ===================================================================== */
console.log('\n=== 7. E142MapDataJson.Schema.json ===');
{
    /* Structural assertions, not validation: running a real JSON-Schema validator
     * would put a devDependency on the gate path for one file, and the schema's
     * behavioural check is Task 9's equivalence corpus. What is pinned here is the
     * handful of decisions JSON-FORMAT.md took that a later edit could quietly
     * undo - the discriminator above all. */
    const SCHEMA = JSON.parse(readFileSync(
        new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/E142MapDataJson.Schema.json',
            import.meta.url), 'utf8'));
    const D = SCHEMA.definitions;
    const env = D.SubstrateMapE142MapDataJson;

    eq(SCHEMA.$schema, 'http://json-schema.org/draft-04/schema', 'draft-04, as the sibling schemas are');
    deep(env.properties.$format.enum, ['semi-e142'], 'the discriminator is pinned to one value');
    ok(env.required.includes('$format') && env.required.includes('$version'),
        '  and both envelope members are required');
    eq(env.properties.$version.type, 'integer', '$version is an integer, not a string');
    eq(env.additionalProperties, false,
        'the envelope is strict - engineering-time contract, unlike the tolerant runtime parser');

    /* The case boundary against GridData. Every GridData key is camelCase; if one
     * ever appears as a member here, the two vocabularies have started to blur. */
    const GRID_KEYS = ['dimension', 'units', 'stepSize', 'deviceSize', 'lowerLeft', 'orientation',
        'originLocation', 'axisDirection', 'binType', 'nullBin', 'mapType', 'binDefinitions',
        'bins', 'lids', 'substrateId', 'lotId', 'goodDevices'];
    const members = new Set();
    const walk = (n) => {
        if (n === null || typeof n !== 'object') { return; }
        if (n.properties) { for (const k of Object.keys(n.properties)) { members.add(k); } }
        for (const v of Object.values(n)) { walk(v); }
    };
    walk(SCHEMA);
    const blurred = GRID_KEYS.filter((k) => members.has(k));
    deep(blurred, [], 'no camelCase GridData key appears as a member - case IS the boundary');

    /* The payload is carried undecoded: DecodedBinPayload's fields must not appear. */
    for (const gone of ['cells', 'codes', 'cols', 'rows']) {
        ok(!members.has(gone), `  the decode output "${gone}" is not a document member`);
    }
    eq(D.SubstrateMapE142BinCodeMap.properties.BinCode.oneOf.length, 3,
        'BinCode has one shape per MapType family: rows, one stream, sparse entries');
    ok(D.SubstrateMapE142PvValue.oneOf.every((v) => v.required && v.required.length === 1),
        'every PVSet value is a single-key object named for its PVType element');
    eq(D.SubstrateMapE142PvValue.oneOf.length, 16, '  and all sixteen kinds are covered');
}

/* ------------------------------- summary ------------------------------ */
console.log('\n========================================================');
console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
    console.log('  FAILURES:');
    for (const f of FAILURES) { console.log('   - ' + f); }
}
console.log('========================================================');
process.exit(FAIL > 0 ? 1 : 0);
