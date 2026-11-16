/*
 * mutations.catalogue.mjs - every SOURCE mutation run in this workspace, from
 * Task 1 onward, in a form `tools/mutate.mjs` can re-run.
 *
 * WHY IT IS WRITTEN DOWN. Each of these was run once by hand, its verdict recorded
 * in STATE.md, and then discarded. That was fine until Task 16 found that the
 * hand-rolled loop discarded `tsc`'s exit code, at which point every recorded
 * verdict needed re-checking and there was nothing to re-run. A mutation is a test
 * of a test; leaving it un-recorded is leaving the only evidence for an assertion
 * in a console that scrolled away.
 *
 * FIXTURE mutations are deliberately absent. They have no compile step, so the
 * defect that motivated this file cannot affect them, and they are cheap to redo
 * from the JSON.
 *
 * `expect: 'SURVIVED'` marks the two experiments where surviving is the CORRECT
 * outcome and the reason is recorded - not a gap. Everything else must be CAUGHT.
 */

const ENGINE = 'Helpers/SubstrateMapEngine/tsconfig.json';
const CONTROL = 'Controls/SubstrateMap/tsconfig.json';
const SM = 'Controls/SubstrateMap/SubstrateMap.ts';
const BASE = 'Controls/SubstrateMapBase/tsconfig.json';
const BASEMOD = 'Controls/SubstrateMapBase/SubstrateMapBase.ts';
const JSONMOD = 'Helpers/SubstrateMapEngine/E142Json.ts';
const BINSMOD = 'Helpers/SubstrateMapEngine/E142Bins.ts';
const XMLMOD = 'Helpers/SubstrateMapEngine/E142Xml.ts';
const CODEC = 'Helpers/SubstrateMapEngine/BinCodec.ts';
const SHIMS = 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs';

const COMPOSITION = 'Helpers/SubstrateMapEngine/tests/e142-composition.test.mjs';
const E2E = 'Helpers/SubstrateMapEngine/tests/e142-e2e.test.mjs';
const JSONTEST = 'Helpers/SubstrateMapEngine/tests/e142-json.test.mjs';
const BINCODEC = 'Helpers/SubstrateMapEngine/tests/e142-bincodec.test.mjs';
const SHIMTEST = 'Helpers/SubstrateMapEngine/tests/dom-shims.test.mjs';
const ENGINEMOD = 'Helpers/SubstrateMapEngine/Engine.ts';
/* W-6 moved the severity ladder out of Engine.ts; seven anchors came with it. */
const BINSEV = 'Helpers/SubstrateMapEngine/BinSeverity.ts';
const RENDERTEST = 'Helpers/SubstrateMapEngine/tests/grid-render.test.mjs';
const AGGMOD = 'Helpers/SubstrateMapEngine/GridAggregate.ts';
const AGGTEST = 'Helpers/SubstrateMapEngine/tests/grid-aggregate.test.mjs';
const OKLCHMOD = 'Helpers/SubstrateMapEngine/Oklch.ts';

export const MUTATIONS = [
    /* ---- W-14: the demo draws into a bound outline ---- */
    {
        task: 'W-14', label: 'the demo is suppressed by an outline again',
        file: SM, project: CONTROL, suite: COMPOSITION,
        // `&& false` rather than `if (false)`: the branch body dereferences
        // `this.__demo`, and a literal-false condition makes tsc narrow it to null
        // and refuse to compile. A COMPILE-FAIL verdict says nothing about whether
        // the suite would have caught the behaviour change.
        from: 'if (this.__itemModels.length === 0 && !this.__hasRenderableGrid()',
        to: 'if (this.__showLabels && !this.__showLabels && !this.__hasRenderableGrid()',
    },
    {
        task: 'W-14', label: 'real items no longer beat the demo',
        file: SM, project: CONTROL, suite: COMPOSITION,
        // `this.__demo !== null` has to survive, or tsc narrows __demo to null in
        // the branch body and the mutation becomes a COMPILE-FAIL, which says
        // nothing about whether the suite would have caught the behaviour.
        from: 'if (this.__itemModels.length === 0 && !this.__hasRenderableGrid()',
        to: 'if (this.__showLabels && !this.__showLabels',
    },
    {
        task: 'W-14', label: 'the demo is built without the outline box',
        file: SM, project: CONTROL, suite: COMPOSITION,
        from: 'this.__demo = this.__showDemoItems ? buildDemo(box ? box.bbox : null) : null;',
        to: 'this.__demo = this.__showDemoItems ? buildDemo(null) : null;',
    },

    /* ---- Task 1: the demo-suppressed diagnostic ---- */
    {
        task: 'Task 1', label: 'real branch no longer triggers on the outline alone',
        file: SM, project: CONTROL, suite: COMPOSITION,
        from: 'if (outlineModel !== null || this.__itemModels.length > 0) {',
        to: 'if (this.__itemModels.length > 0) {',
    },

    /* ---- Task 2a: the engine counters ---- */
    {
        task: 'Task 2a', label: 'counters default to ON',
        file: 'Helpers/SubstrateMapEngine/E142.ts', project: ENGINE, suite: E2E,
        from: 'let countersOn = false;', to: 'let countersOn = true;',
    },
    {
        task: 'Task 2a', label: 'the guard removed from countEngineParse',
        file: 'Helpers/SubstrateMapEngine/E142.ts', project: ENGINE, suite: E2E,
        from: 'export function countEngineParse(): void { if (countersOn) { parseCount++; } }',
        to: 'export function countEngineParse(): void { parseCount++; }',
    },

    /* ---- Task 3: attach-batch coalescing ---- */
    {
        task: 'Task 3', label: 'the gate starts open',
        file: SM, project: CONTROL, suite: COMPOSITION,
        from: 'protected __attachPending: boolean = true;',
        to: 'protected __attachPending: boolean = false;',
    },

    /* ---- D-017: the explicitly-asked-for flag ---- */

    /* ---- Task 7: the JSON parser as an adapter ---- */
    {
        task: 'Task 7', label: 'text-child lookup loses its parent context',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: 'if (TEXT_CHILDREN.has(`${name}/${key}`)) {', to: 'if (TEXT_CHILDREN.has(key)) {',
    },
    {
        task: 'Task 7', label: 'unknown-member accounting removed (the SCALAR fix)',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: 'if (!KNOWN_MEMBERS.has(key)) {', to: 'if (false) {',
    },

    /* ---- Task 8: the serializer ---- */
    {
        // Moved to E142Bins at D-064, when both serializers needed it. The
        // catalogue said E142Json until the tools smoke test noticed.
        task: 'Task 8', label: 'Decimal loses its separators',
        file: BINSMOD, project: ENGINE, suite: JSONTEST,
        from: "    return isDelimited(binType) ? ' ' : '';", to: "    return '';",
    },
    {
        task: 'Task 8', label: 'SubstrateSide omitted',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: '        SubstrateSide: header.substrateSide,\r\n', to: '',
    },
    {
        task: 'Task 8', label: 'Row/Column addressed by payload index',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: '                const at = table[i];',
        to: '                const at = { x: i % p.cols, y: Math.floor(i / p.cols) };',
    },
    {
        task: 'Task 8', label: 'empty MapVersion written as "" (was reported SURVIVED)',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: "    if (overlay.mapVersion !== '') { out.MapVersion = overlay.mapVersion; }",
        to: '    out.MapVersion = overlay.mapVersion;',
    },

    /* ---- Task 12: the From* asymmetry ---- */
    {
        task: 'Task 12', label: 'an empty FromSubstrateId written back out',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: "            if (m.fromSubstrateId !== '') { tm.FromSubstrateId = m.fromSubstrateId; }",
        to: '            tm.FromSubstrateId = m.fromSubstrateId;',
    },

    /* ---- Task 15: the codec ---- */
    {
        task: 'Task 15', label: 'big-endian WRITE (the D-046 experiment, restated)',
        file: CODEC, project: ENGINE, suite: BINCODEC,
        from: 'view.setUint16(i * 2, v, true);', to: 'view.setUint16(i * 2, v, false);',
    },
    {
        task: 'Task 15', label: 'big-endian READ (the D-046 experiment, restated)',
        file: CODEC, project: ENGINE, suite: BINCODEC,
        from: 'out[i] = view.getUint16(i * 2, true);', to: 'out[i] = view.getUint16(i * 2, false);',
    },
    {
        task: 'Task 15', label: 'the code table adopted, not copied',
        file: CODEC, project: ENGINE, suite: BINCODEC,
        from: '    return { codes: codes.slice(), data: encodeBytesToBase64(bytes) };',
        to: '    return { codes, data: encodeBytesToBase64(bytes) };',
    },
    {
        task: 'Task 15', label: 'the uint16 overflow guard removed',
        file: CODEC, project: ENGINE, suite: BINCODEC,
        from: '        if (v > MAX_INDEX) { throw indexTooLarge(i, v); }\r\n', to: '',
    },

    /* ---- Task 18: the E142MapDataJson attribute ---- */
    {
        task: 'Task 18', label: 'the JSON input is not an E142 document input',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "        return this.__activeInput === 'xml'\r\n            || this.__activeInput === 'json'\r\n",
        to: "        return this.__activeInput === 'xml'\r\n",
    },
    {
        task: 'Task 18', label: 'the setter forgets to invalidate the parse cache',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "        this.__e142Doc = null;   // the document changed: force a fresh parse\r\n        this.__rebuildMap();\r\n    }\r\n    /** @returns The bound E142 MapData JSON document, or `null`. */",
        to: "        this.__rebuildMap();\r\n    }\r\n    /** @returns The bound E142 MapData JSON document, or `null`. */",
    },

    /* ---- Task 19: the binary attribute and the precedence diagnosis ---- */
  {
        task: 'Task 19', label: 'the diagnosis fires on a re-write of the same attribute',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "        if (previous === null || previous === active) { return; }",
        to: '        if (previous === null) { return; }',
    },
    /* ---- LOD Task 11: FailFraction and OKLCH ---- */
    {
        task: 'LOD-11', label: 'the gamma exponent is perturbed',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '    return gamma === 1 ? f : Math.pow(f, gamma);', to: '    return Math.pow(f, gamma * 1.0000001);',
    },
    {
        task: 'LOD-11', label: 'the default gamma is 1 (no transfer at all)',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: 'export const FAIL_FRACTION_DEFAULT_GAMMA = 0.4;',
        to: 'export const FAIL_FRACTION_DEFAULT_GAMMA = 1;',
    },
    {
        task: 'LOD-11', label: 'an empty bucket divides by zero',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '    return total > 0 ? failCount / total : 0;', to: '    return failCount / total;',
    },
    {
        task: 'LOD-11', label: 'unknown bins count as failures',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: "        out[i] = binSeverity(binTable[i], priority, aliases) >= SEVERITY_FAIL ? 1 : 0;",
        to: "        out[i] = binSeverity(binTable[i], priority, aliases) > 1 ? 1 : 0;",
    },
    {
        task: 'LOD-11', label: 'the hue takes the long way round',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '    let dh = ((h1 - h0 + 540) % 360) - 180;      // signed shortest arc, -180..180',
        to: '    let dh = h1 - h0;',
    },
    {
        task: 'LOD-11', label: 'the OKLab lightness row is transposed',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '    const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;',
        to: '    const L = 0.7936177850 * l + 0.2104542553 * m - 0.0040720468 * s;',
    },
    {
        task: 'LOD-11', label: 'the sRGB transfer function is a plain 2.2 power',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);',
        to: '    return Math.pow(c, 2.2);',
    },
    {
        task: 'LOD-11', label: 'a grey keeps atan2 hue instead of 0',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '    const h = C < 1e-7 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;',
        to: '    const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;',
    },

    {
        task: 'LOD-15', label: 'the harness stops installing the shared DOM shim',
        file: 'tools/attach-harness.mjs', project: null,
        suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: 'installDomShims();', to: 'void installDomShims;',
    },

    {
        task: 'LOD-15', label: 'the render loop stops calling __publishAggregation',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        this.__publishAggregation(',
        to: '        if (gridModel !== gridModel) this.__publishAggregation(',
    },
    {
        task: 'LOD-15', label: 'the hook is handed the world matrix without the dpr',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '                : aggregationFactor(deviceMatrix(matrices.dprBase, matrices.world), gridModel.placement),',
        to: '                : aggregationFactor(matrices.world, gridModel.placement),',
    },

    /* ---- LOD Task 27: the pattern generator ---- */
    {
        task: 'LOD-27', label: 'the scratch is sampled along t, so it doubles and skips cells',
        file: 'Helpers/SubstrateMapEngine/tests/lib/patterns.mjs', project: null, suite: 'Helpers/SubstrateMapEngine/tests/patterns.test.mjs',
        from: '            const e2 = 2 * err;', to: '            const e2 = 2 * err + 2;',
    },
    {
        task: 'LOD-27', label: 'the PRNG is seeded from a constant',
        file: 'Helpers/SubstrateMapEngine/tests/lib/patterns.mjs', project: null, suite: 'Helpers/SubstrateMapEngine/tests/patterns.test.mjs',
        from: '    let a = (seed >>> 0) || 0x9e3779b9;', to: '    let a = 0x9e3779b9;',
    },
    {
        task: 'LOD-27', label: 'Edge-Loc spans the whole rim, making it an Edge-Ring',
        file: 'Helpers/SubstrateMapEngine/tests/lib/patterns.mjs', project: null, suite: 'Helpers/SubstrateMapEngine/tests/patterns.test.mjs',
        from: '        const span = Math.PI / 3;', to: '        const span = Math.PI * 2;',
    },
    {
        task: 'LOD-27', label: 'defects are placed off the substrate',
        file: 'Helpers/SubstrateMapEngine/tests/lib/patterns.mjs', project: null, suite: 'Helpers/SubstrateMapEngine/tests/patterns.test.mjs',
        from: '        && cells[y * size + x] !== 0;', to: '        && true;',
    },

    {
        task: 'LOD-26', label: 'screen-constant widths use the fit scale again',
        file: ENGINEMOD, project: ENGINE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '    const h = Math.hypot(matrices.world.a, matrices.world.b);',
        to: '    const h = matrices.scale;',
    },

    /* ---- LOD Task 26: the geometry seam ---- */
    {
        task: 'LOD-26', label: 'the transform is pre-multiplied, not post',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '                : makeWorldMatrix(cfg, scale, rot).multiply(this.__sceneViewTransform),',
        to: '                : this.__sceneViewTransform.multiply(makeWorldMatrix(cfg, scale, rot)),',
    },
    {
        task: 'LOD-26', label: 'the transform is never composed',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '                : makeWorldMatrix(cfg, scale, rot).multiply(this.__sceneViewTransform),',
        to: '                : makeWorldMatrix(cfg, scale, rot).multiply(new DOMMatrix()),',
    },
    {
        task: 'LOD-26', label: 'MapScale includes the author transform',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        this.__publishMapScale(matrices.scale > 0 ? matrices.scale : null);',
        to: '        this.__publishMapScale(matrices.scale > 0 ? Math.hypot(matrices.world.a, matrices.world.b) : null);',
    },
    {
        task: 'LOD-26', label: 'a degenerate transform is accepted',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '            } else if (Math.abs(v[0]! * v[3]! - v[1]! * v[2]!) === 0) {',
        to: '            } else if (false) {',
    },
    {
        task: 'LOD-26', label: 'a five-component transform is accepted',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "            if (v.length !== 6 || v.some((x) => x === null || !Number.isFinite(x))) {",
        to: '            if (false) {',
    },

    /* ---- LOD Task 25: the value field under aggregation ---- */
    {
        task: 'LOD-25', label: 'a value field never builds an aggregate paint',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '            aggregate: frgba === null ? null : {', to: '            aggregate: frgba !== null ? null : {',
    },
    {
        task: 'LOD-25', label: 'the value reduction falls back to severity',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "    const isValue = mode === 'ValueField' && agg.valueCells !== null && agg.valueColors !== null;",
        to: '    const isValue = false;',
    },
    {
        task: 'LOD-25', label: 'the scatter reads the base index instead of the value',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '            const v = valueCells !== null ? valueCells[base + col] : value![bin];',
        to: '            const v = value !== null ? value[bin] : bin;',
    },
    {
        task: 'LOD-25', label: 'ValueField is not sticky',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "    if (previous === 'ValueField') { return 'ValueField'; }", to: '    if (false) { return previous; }',
    },
    {
        task: 'LOD-25', label: 'a value field reports saturation it cannot have',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        if (isValue ? false : (isMax ? acc[i] >= SEVERITY_FAIL : acc[i] > 0)) { atFail++; }',
        to: '        if (isMax ? acc[i] >= SEVERITY_FAIL : acc[i] > 0) { atFail++; }',
    },
    {
        task: 'LOD-25', label: 'the ignored reducer is never reported',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "        if (this.__sceneValueFill === null || this.__aggregationReducer === 'Auto') { return; }",
        to: '        if (true) { return; }',
    },
    {
        task: 'LOD-25', label: 'the reducer stays ValueField after the fill is dropped',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "        else if (this.__sceneReducer === 'ValueField') { this.__sceneReducer = 'MaxSeverity'; }",
        to: '        else { void 0; }',
    },

    /* ---- LOD Task 24: the value-field seam ---- */
    {
        task: 'LOD-24', label: 'the value fill blends with the base instead of replacing it',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    if (fill) {', to: '    if (fill && fill.colors.length < 0) {',
    },
    {
        task: 'LOD-24', label: 'the base no longer masks the substrate',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    const mask = paint.fillCells === null ? null : grid.cells;\r\n    const cols = grid.cols;\r\n    const rows = grid.rows;\r\n    let o = 0;',
        to: '    const mask: Uint32Array | null = null;\r\n    const cols = grid.cols;\r\n    const rows = grid.rows;\r\n    let o = 0;',
    },
    {
        task: 'LOD-24', label: 'the ramp is not lightness-ordered',
        file: OKLCHMOD, project: ENGINE, suite: RENDERTEST,
        from: '        const L = VALUE_RAMP_L0 + (VALUE_RAMP_L1 - VALUE_RAMP_L0) * t;',
        to: '        const L = VALUE_RAMP_L1 - (VALUE_RAMP_L1 - VALUE_RAMP_L0) * 0;',
    },
    {
        task: 'LOD-24', label: 'one level divides by zero',
        file: OKLCHMOD, project: ENGINE, suite: RENDERTEST,
        from: '        const t = count === 1 ? 1 : i / (count - 1);', to: '        const t = i / (count - 1);',
    },
    {
        task: 'LOD-24', label: 'the fill does not change the cache signature',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "            signature: 'value\\u0002' + fcolors.join('\\u0001'),",
        to: "            signature: 'value',",
    },
    {
        task: 'LOD-24', label: 'the short form clobbers stated roles again',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '                if (v.every((o) => o.role === undefined)) {', to: '                if (bases.length === 0) {',
    },

    {
        task: 'LOD-23', label: 'zero no longer turns grouping off',
        file: ENGINEMOD, project: ENGINE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '    if (targetCssPx === 0) { return 1; }', to: '    if (false) { return 1; }',
    },
    {
        task: 'LOD-23', label: 'zero is clamped to the floor like any other small value',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        const clamped = asked === 0 ? 0 : Math.max(TOUCH_TARGET_MIN_PX, asked);',
        to: '        const clamped = Math.max(TOUCH_TARGET_MIN_PX, asked);',
    },

    /* ---- LOD Task 23: onGroupSelected ---- */
    {
        task: 'LOD-23', label: 'grouping engages even at one cell per group',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        if (n <= 1) { return null; }', to: '        if (n <= 0) { return null; }',
    },
    {
        task: 'LOD-23', label: 'the group tile ignores the device pixel ratio',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        const tile = groupTileAt(p.x * dpr, p.y * dpr, this.__groupTiling(matrices, dpr));',
        to: '        const tile = groupTileAt(p.x, p.y, this.__groupTiling(matrices, dpr));',
    },
    {
        task: 'LOD-23', label: 'the descriptor is built without the tile id',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '            this.__sceneBinSeverityPriority, this.__sceneBinQualityAliases, tile.id);',
        to: '            this.__sceneBinSeverityPriority, this.__sceneBinQualityAliases);',
    },
    {
        task: 'LOD-23', label: 'the event carries the member cells too',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '            decorated: group.decorated,',
        to: '            decorated: group.decorated,\r\n            members: [...this.readGroupMembers(group.id)],',
    },
    {
        task: 'LOD-23', label: 'an item hit no longer wins over a group',
        file: BASEMOD, project: BASE, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        if (!hit && this.__sceneGrid !== null) {', to: '        if (this.__sceneGrid !== null) {',
    },

    /* ---- LOD Task 22: the member accessor ---- */
    {
        // Re-aimed at F-5a. There is no `Math.floor(px / groupPx)` any more: an
        // index comes from a prefix-sum scan, so the equivalent defect is the
        // containment comparison. `<=` puts a boundary point in two tiles.
        task: 'LOD-22', label: 'a boundary point belongs to two tiles',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        if (v < at + spans[i]!) { return { i, at }; }',
        to: '        if (v <= at + spans[i]!) { return { i, at }; }',
    },
    {
        task: 'LOD-22', label: 'the id regex accepts a fractional index',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "    const m = /^(-?\\d+),(-?\\d+)$/.exec(String(id));",
        to: "    const m = /^(-?[\\d.]+),(-?[\\d.]+)$/.exec(String(id));",
    },
    {
        // Re-aimed at F-5a: the rectangle is built from prefix sums now.
        task: 'LOD-22', label: 'the tile rectangle is one tile wide plus a pixel',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    return { x0, y0, x1: x0 + tiling.xs[gx]!, y1: y0 + tiling.ys[gy]! };',
        to: '    return { x0, y0, x1: x0 + tiling.xs[gx]! + 1, y1: y0 + tiling.ys[gy]! + 1 };',
    },
    {
        task: 'LOD-22', label: 'the accessor ignores TouchTargetSize',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        return this.__touchTargetSize * (dpr > 0 ? dpr : 1);',
        to: '        return TOUCH_TARGET_DEFAULT_PX * (dpr > 0 ? dpr : 1);',
    },
    {
        task: 'LOD-22', label: 'an unparseable id enumerates the whole map',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        if (rect === null) { return new Uint32Array(0); }',
        to: '        if (rect === null) { return cellsInGroup({ x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 }, grid, deviceMatrix(matrices.dprBase, matrices.world)); }',
    },

    /* ---- LOD Task 21: the group descriptor ---- */
    {
        task: 'LOD-21', label: 'the histogram is not truncated',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    const bins = ranked.slice(0, GROUP_HISTOGRAM_MAX);', to: '    const bins = ranked;',
    },
    {
        task: 'LOD-21', label: 'the remainder is computed from the wrong total',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        otherCount: indices.length - named,', to: '        otherCount: ranked.length - bins.length,',
    },
    {
        task: 'LOD-21', label: 'the histogram is ordered ascending',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    ranked.sort((x, y) => (y.count - x.count) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));',
        to: '    ranked.sort((x, y) => (x.count - y.count) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));',
    },
    {
        task: 'LOD-21', label: 'the corners are device coordinates',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '            corners.push([(m.d * dx - m.c * dy) / det, (-m.b * dx + m.a * dy) / det]);',
        to: '            corners.push([px, py]);',
    },
    {
        task: 'LOD-21', label: 'the decoration flag is never set',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        if (!decorated && cellDeco !== null && cellDeco[i] !== 0) { decorated = true; }',
        to: '        if (false) { decorated = true; }',
    },

    /* ---- LOD Task 20: group enumeration ---- */
    {
        task: 'LOD-20', label: 'containment is closed, so adjacent groups overlap',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '            if (px < rect.x0 || px >= rect.x1 || py < rect.y0 || py >= rect.y1) { continue; }',
        to: '            if (px < rect.x0 || px > rect.x1 || py < rect.y0 || py > rect.y1) { continue; }',
    },
    {
        task: 'LOD-20', label: 'the bounding box forgets the half-cell slack',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    const c0 = Math.max(0, Math.floor(minA - 0.5));', to: '    const c0 = Math.max(0, Math.ceil(minA));',
    },
    {
        task: 'LOD-20', label: 'null-bin cells are enumerated',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '            if (cells[base + col] === 0) { continue; }     // off substrate',
        to: '            if (false) { continue; }',
    },
    {
        task: 'LOD-20', label: 'the inverse drops its cross terms, so rotation is ignored',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        return { a: (m.d * dx - m.c * dy) / det, b: (-m.b * dx + m.a * dy) / det };',
        to: '        return { a: (m.d * dx) / det, b: (m.a * dy) / det };',
    },

    /* ---- LOD Task 19: touch targets ---- */
    {
        task: 'LOD-19', label: 'the dpr is ignored, as the task text had it',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    const cellCssPx = cellDevicePx / ratio;', to: '    const cellCssPx = cellDevicePx;',
    },
    {
        task: 'LOD-19', label: 'the floor is not applied to the target',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        ? Math.max(TOUCH_TARGET_MIN_PX, targetCssPx)',
        to: '        ? targetCssPx',
    },
    {
        task: 'LOD-19', label: 'ceil becomes floor, so a group falls short of the target',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    return Math.ceil(target / cellCssPx);', to: '    return Math.max(1, Math.floor(target / cellCssPx));',
    },
    {
        task: 'LOD-19', label: 'the control clamps without reporting',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        if (clamped !== asked && !this.__touchTargetWarned.has(asked)) {',
        to: '        if (false) {',
    },
    {
        task: 'LOD-19', label: 'nonsense clamps to the floor instead of the default',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '            ? TOUCH_TARGET_DEFAULT_PX', to: '            ? TOUCH_TARGET_MIN_PX',
    },

    /* ---- LOD Task 18: the decoration presence flag ---- */
    {
        task: 'LOD-18', label: 'the decoration mark is never applied',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        if (deco !== null && deco[i] !== 0) {', to: '        if (false) {',
    },
    {
        task: 'LOD-18', label: 'the mark changes a colour channel, not the alpha',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '                ? ((buf[i] & 0x00ffffff) | (DECORATED_ALPHA << 24)) >>> 0',
        to: '                ? ((buf[i] & 0xffffff00) | DECORATED_ALPHA) >>> 0',
    },
    {
        task: 'LOD-18', label: 'the mask is built from every cell, not only named ones',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '                if (lc[i] !== 0) { decorated[i] = 1; }', to: '                decorated[i] = 1;',
    },
    {
        task: 'LOD-18', label: 'an undecorated map allocates a mask anyway',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    if (decorated !== null) { model.decorated = decorated; }',
        to: '    model.decorated = decorated ?? new Uint8Array(n);',
    },
    {
        task: 'LOD-18', label: 'the bucket flag is set for undecorated cells too',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        // Re-anchored at W-22a: the decoration read moved OUT of the inner write
        // and up beside the value, because the footprint branch writes the same
        // cell to many pixels and re-reading the cell per pixel would be waste.
        from: '            const marked = cellDeco !== null && cellDeco[base + col] !== 0;',
        to: '            const marked = cellDeco !== null;',
    },

    /* ---- LOD Task 17: the saturation-fed reducer choice ---- */
    {
        task: 'LOD-17', label: 'no hysteresis — one threshold instead of two',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    if (saturation <= SATURATION_SWITCH_DOWN) { return \'MaxSeverity\'; }',
        to: '    if (saturation < SATURATION_SWITCH_UP) { return \'MaxSeverity\'; }',
    },
    {
        task: 'LOD-17', label: 'the override is ignored',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "    if (override !== 'Auto') { return override; }", to: "    if (override !== 'Auto') { return previous; }",
    },
    {
        task: 'LOD-17', label: 'an unmeasured frame resets to MaxSeverity',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "    if (saturation === null || !Number.isFinite(saturation)) { return previous; }",
        to: "    if (saturation === null || !Number.isFinite(saturation)) { return 'MaxSeverity'; }",
    },
    {
        task: 'LOD-17', label: 'saturation counts every bucket, not only painted ones',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '        painted++;\r\n        // A value field has no failures to saturate on, so it reports none and the',
        to: '        painted += 2;\r\n        if (isMax ? acc[i] >= SEVERITY_FAIL : acc[i] > 0) { atFail++; }',
    },
    {
        task: 'LOD-17', label: 'the gather reports a saturation it never measured',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '            renderGridImageData(ctx, grid, lat, paint.rgba, paint, halfA, halfB, bitmapWidth, bitmapHeight);\r\n            return null;',
        to: '            renderGridImageData(ctx, grid, lat, paint.rgba, paint, halfA, halfB, bitmapWidth, bitmapHeight);\r\n            return 0;',
    },
    {
        task: 'LOD-17', label: 'a forced reducer waits a frame',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "        if (next !== 'Auto') { this.__sceneReducer = next; }", to: '        void next;',
    },

    /* ---- LOD Task 16: the aggregate render ---- */
    {
        task: 'LOD-16', label: 'the dispatcher prefers point sampling over aggregation',
        file: ENGINEMOD, project: ENGINE, suite: 'Helpers/SubstrateMapEngine/tests/grid-aliasing.test.mjs',
        // Re-anchored at W-5: the branch moved OUT of the `allowImageData` guard
        // when the bucket pass learned to composite, so it is now four spaces in
        // rather than eight. The mutation is unchanged - it still makes the
        // dispatcher pick point sampling whenever the paint has rgba.
        // Re-anchored at W-22a: the condition gained the forceAggregate override,
        // which FieldView=FailDensity sets to bucket at any zoom.
        from: '    if (paint.aggregate && (pxPerCell < 1 || forceAggregate)) {',
        to: '    if (paint.aggregate && !paint.rgba) {',
    },
    {
        task: 'LOD-16', label: 'a priority rank indexes past the severity table',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        // Re-anchored at W-18: the clamp moved out of the subscript and into an
        // `index` variable, because the same value now picks the colour AND fills
        // the filter buffer, and computing it twice is how the two would disagree.
        from: '            index = acc[i] >= SEVERITY_FAIL ? SEVERITY_FAIL : acc[i];',
        to: '            index = acc[i];',
    },
    {
        task: 'LOD-16', label: 'the cache key drops the reducer',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "        '|' + bw + 'x' + bh + '|' + dataVersion + '|' + reducer",
        to: "        '|' + bw + 'x' + bh + '|' + dataVersion + '|' + ''",
    },
    {
        task: 'LOD-16', label: 'the null bin joins the scatter',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '            if (bin === 0) { continue; }            // null bin: neither num nor denom',
        to: '            if (bin < 0) { continue; }',
    },

    /* ---- LOD Task 15: the aggregation outputs ---- */
    {
        task: 'LOD-15', label: 'an unbound map publishes None instead of null',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "            factor === null ? null",
        to: "            factor === null ? 'None'",
    },
    {
        task: 'LOD-15', label: 'the mode threshold is off by one cell per pixel',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "                    : (factor <= 1 ? 'None' : 'PointSample'));",
        to: "                    : (factor <= 8 ? 'None' : 'PointSample'));",
    },
    {
        task: 'LOD-15', label: 'the factor setter never dedupes',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        if (tchmi_equal(clean, this.__aggregationFactor)) { return; }',
        to: '        if (false) { return; }',
    },

    /* ---- LOD Task 14: the categorical palette ---- */
    {
        task: 'LOD-14', label: 'the chroma exceeds the in-gamut ceiling',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: 'export const CATEGORICAL_C = 0.12;', to: 'export const CATEGORICAL_C = 0.22;',
    },
    {
        task: 'LOD-14', label: 'the cap is raised past what the floor allows',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: 'export const CATEGORICAL_CAP = 10;', to: 'export const CATEGORICAL_CAP = 16;',
    },
    {
        task: 'LOD-14', label: 'hues are spaced by the request, not the capped count',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '        const h = (((hueOffset + (i * 360) / n) % 360) + 360) % 360;',
        to: '        const h = (((hueOffset + (i * 360) / requested) % 360) + 360) % 360;',
    },
    {
        task: 'LOD-14', label: 'the cap is applied one late, so 11 bins get 11 colours',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '    const capped = requested > CATEGORICAL_CAP;', to: '    const capped = requested > CATEGORICAL_CAP + 1;',
    },
    {
        task: 'LOD-14', label: 'the other colour is one of the palette hues',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: "export const CATEGORICAL_OTHER = '#8a8a8a';", to: "export const CATEGORICAL_OTHER = '#da7d9b';",
    },
    {
        task: 'LOD-14', label: 'a negative K is not clamped to zero',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '    const requested = Math.max(0, Math.floor(k));', to: '    const requested = Math.floor(k);',
    },

    /* ---- LOD Task 13: the aggregate palette ---- */
    {
        task: 'LOD-13', label: 'the aggregate band collides with the bin palette',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: 'export const AGGREGATE_LIGHTNESS = { pass: 0.34, unknown: 0.29, fail: 0.24 } as const;',
        to: 'export const AGGREGATE_LIGHTNESS = { pass: 0.60, unknown: 0.55, fail: 0.50 } as const;',
    },
    {
        task: 'LOD-13', label: 'the aggregate is separated by chroma instead of lightness',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '    return formatRgb(oklchToRgb({ L: lightness, C: c.C, h: c.h }));',
        to: '    return formatRgb(oklchToRgb({ L: c.L, C: c.C * 0.4, h: c.h }));',
    },
    {
        task: 'LOD-13', label: 'darker no longer means worse',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: 'export const AGGREGATE_LIGHTNESS = { pass: 0.34, unknown: 0.29, fail: 0.24 } as const;',
        to: 'export const AGGREGATE_LIGHTNESS = { pass: 0.24, unknown: 0.29, fail: 0.34 } as const;',
    },
    {
        task: 'LOD-13', label: 'the threshold is loosened to a JND',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: 'export const AGGREGATE_MIN_DELTA_E = 0.153;', to: 'export const AGGREGATE_MIN_DELTA_E = 0.02;',
    },
    {
        task: 'LOD-13', label: 'the null rank gets a colour',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '    if (rank <= SEVERITY_NULL) { return null; }          // no substrate: paint nothing',
        to: '    if (rank < SEVERITY_NULL) { return null; }',
    },
    {
        task: 'LOD-13', label: 'deltaE ignores the chroma axes',
        file: OKLCHMOD, project: ENGINE, suite: AGGTEST,
        from: '        Math.sin(ra) * a.C - Math.sin(rb) * b.C,', to: '        0 * (Math.sin(ra) * a.C - Math.sin(rb) * b.C),',
    },

    /* ---- LOD Task 12: the property suite ---- */
    {
        task: 'LOD-12', label: 'the projection is stepped instead of evaluated (D-085)',
        file: AGGMOD, project: ENGINE, suite: 'Helpers/SubstrateMapEngine/tests/grid-monoid.test.mjs',
        from: '                const px = Math.floor(a * cx + rx);',
        to: '                const px = Math.floor(a * cx + rx - col * Number.EPSILON);',
    },

    /* ---- LOD Task 10: MaxSeverity ---- */
    {
        task: 'LOD-10', label: 'maxSeverity takes the smaller value',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '    return a > b ? a : b;', to: '    return a < b ? a : b;',
    },
    {
        task: 'LOD-10', label: 'maxSeverity is not commutative',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '    return a > b ? a : b;', to: '    return a >= b ? a : b + 1;',
    },
    {
        task: 'LOD-10', label: 'the identity is FAIL rather than NULL',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: 'export const MAX_SEVERITY_IDENTITY = SEVERITY_NULL;',
        to: 'export const MAX_SEVERITY_IDENTITY = 3;',
    },

    /* ---- LOD Task 9: the bucket accumulator ---- */
    {
        task: 'LOD-9', label: 'null cells are counted in the denominator',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '            if (bin !== 0) {', to: '            if (true) {',
    },
    {
        task: 'LOD-9', label: 'the cell corner is projected instead of its centre',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '                const cx = col + 0.5;', to: "                const cx = col;",
    },
    {
        task: 'LOD-9', label: 'max is a sum',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '                        if (v > acc[at]) { acc[at] = v; }', to: '                        acc[at] += v;',
    },
    {
        task: 'LOD-9', label: 'sum is a max',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '                        acc[at] += v;\r\n                    }\r\n                } else {',
        to: '                        if (v > acc[at]) { acc[at] = v; }\r\n                    }\r\n                } else {',
    },
    {
        task: 'LOD-9', label: 'the row term uses the column step',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '        const rx = mc * cy + e;', to: '        const rx = a * cy + e;',
    },
    {
        task: 'LOD-9', label: 'dropped cells are silently forgotten',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '                    dropped++;', to: '                    counted++;',
    },
    {
        task: 'LOD-9', label: 'an empty bucket counts as painted',
        file: AGGMOD, project: ENGINE, suite: AGGTEST,
        from: '    return buckets.total[y * buckets.width + x] > 0;',
        to: '    return buckets.total[y * buckets.width + x] >= 0;',
    },

    /* ---- LOD Task 8: the aggregation factor ---- */
    {
        task: 'LOD-8', label: 'the factor is derived from the device scale, not the composed matrix',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    const m = dev.multiply(latticeMatrix(placement));',
        to: '    const m = dev;',
    },
    {
        task: 'LOD-8', label: 'the factor uses the drawn extent instead of the pitch',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    const det = Math.abs(m.a * m.d - m.b * m.c);',
        to: '    const det = Math.abs(m.a * m.d - m.b * m.c) * placement.cellWmm * placement.cellLmm;',
    },
    {
        task: 'LOD-8', label: 'a degenerate lattice reports zero aggregation',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    return det > 0 ? 1 / det : Infinity;', to: '    return det > 0 ? 1 / det : 0;',
    },
    {
        task: 'LOD-8', label: 'the linear form is not a square root',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    return Math.sqrt(aggregationFactor(dev, placement));',
        to: '    return aggregationFactor(dev, placement);',
    },
    {
        task: 'LOD-8', label: 'the determinant drops its off-diagonal term',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    const det = Math.abs(m.a * m.d - m.b * m.c);', to: '    const det = Math.abs(m.a * m.d);',
    },

    /* ---- LOD Task 7: BinSeverityPriority and the pass floor ---- */
    {
        task: 'LOD-7', label: 'the priority list may promote a passing bin',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: "    if (priority && q !== 'pass') {", to: '    if (priority) {',
    },
    {
        task: 'LOD-7', label: 'the list is read least-severe-first',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: '        if (at >= 0) { return SEVERITY_FAIL + (priority.length - at); }',
        to: '        if (at >= 0) { return SEVERITY_FAIL + 1 + at; }',
    },
    {
        task: 'LOD-7', label: 'the priority diagnosis never logs',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "        if (this.__binPriorityWarned.has(key)) { return; }", to: '        return;',
    },
    {
        task: 'LOD-7', label: 'no warning for a listed passing code',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "            if (resolveBinQuality(entry.quality, this.__binQualityAliases) === 'pass') {",
        to: '            if (false) {',
    },
    {
        task: 'LOD-7', label: 'the getter hands out its own array',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        return this.__binSeverityPriority === null ? null : [...this.__binSeverityPriority];',
        to: '        return this.__binSeverityPriority as string[] | null;',
    },

    /* ---- LOD Task 6: the severity ladder ---- */
    {
        task: 'LOD-6', label: 'unknown ranks BELOW pass',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: 'export const SEVERITY_UNKNOWN = 2;', to: 'export const SEVERITY_UNKNOWN = 0.5;',
    },
    {
        task: 'LOD-6', label: 'an unclassified bin ranks pass',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: '    return SEVERITY_UNKNOWN;\r\n}\r\n\r\n/**\r\n * One severity rank per bin table index',
        to: '    return SEVERITY_PASS;\r\n}\r\n\r\n/**\r\n * One severity rank per bin table index',
    },
    {
        task: 'LOD-6', label: 'Pick=true overrides a declared Fail',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: "    if (q === 'fail') { return SEVERITY_FAIL; }",
        to: "    if (q === 'fail' && entry.pick !== true) { return SEVERITY_FAIL; }",
    },
    {
        task: 'LOD-6', label: 'the priority list is read least-severe-first',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: '        if (at >= 0) { return SEVERITY_FAIL + (priority.length - at); }',
        to: '        if (at >= 0) { return SEVERITY_FAIL + 1 + at; }',
    },
    {
        task: 'LOD-6', label: 'binSeverityTable ranks the null bin like any other',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: '    for (let i = 1; i < binTable.length; i++) {', to: '    for (let i = 0; i < binTable.length; i++) {',
    },

    /* ---- LOD Task 5: BinQuality tokens and aliases ---- */
    {
        task: 'LOD-5', label: 'an empty BinQuality counts as unmapped',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: "    if (q === '') { return 'undeclared'; }", to: '',
    },
    {
        task: 'LOD-5', label: 'an alias may point at any token',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: "            if (to === 'pass' || to === 'fail') { return to; }",
        to: "            if (to !== '') { return to as BinQualityResolution; }",
    },
    {
        task: 'LOD-5', label: 'alias keys are matched case-sensitively',
        file: BINSEV, project: ENGINE, suite: RENDERTEST,
        from: '            if (key.trim().toLowerCase() !== q) { continue; }',
        to: '            if (key !== q) { continue; }',
    },
    {
        task: 'LOD-5', label: 'StatusColorMapping no longer outranks the quality',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: "        return mapped;\r\n    }\r\n    const resolved = resolveBinQuality(",
        to: "        void mapped;\r\n    }\r\n    const resolved = resolveBinQuality(",
    },
    {
        task: 'LOD-5', label: 'the control stops warning about unmapped tokens',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: "            if (resolveBinQuality(entry.quality, this.__binQualityAliases) !== 'unmapped') { continue; }",
        to: '            continue;',
    },
    {
        task: 'LOD-5', label: 'the warn-once latch is never cleared',
        file: SM, project: CONTROL, suite: 'Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs',
        from: '        this.__binQualityWarned.clear();', to: '',
    },

    /* ---- LOD Task 3: the retro-cover suite, mutated against Engine.ts itself ---- */
    {
        task: 'LOD-3', label: 'latticeMatrix reorders its components',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: 'return new DOMMatrix([p.colStepXmm, p.colStepYmm, p.rowStepXmm, p.rowStepYmm, p.originXmm, p.originYmm]);',
        to: 'return new DOMMatrix([p.colStepXmm, p.rowStepXmm, p.colStepYmm, p.rowStepYmm, p.originXmm, p.originYmm]);',
    },
    {
        task: 'LOD-3', label: 'makeWorldMatrix loses the y flip',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    m.scaleSelf(s, -s);', to: '    m.scaleSelf(s, s);',
    },
    {
        task: 'LOD-3', label: 'the strategy switch uses <= instead of <',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: 'pxPerCell < GRID_RUN_STRATEGY_PX', to: 'pxPerCell <= GRID_RUN_STRATEGY_PX',
    },
    {
        task: 'LOD-3', label: 'getCellAtPos drops the drawn-extent check',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    if (Math.abs(a - col - 0.5) > gridHalfA(pl) || Math.abs(b - row - 0.5) > gridHalfB(pl)) {',
        to: '    if (false) {',
    },
    {
        task: 'LOD-3', label: 'getCellAtPos hits the null bin',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '    if (grid.cells[index] === 0) {', to: '    if (false) {',
    },
    {
        task: 'LOD-3', label: 'one unparsable colour no longer disables rgba',
        file: ENGINEMOD, project: ENGINE, suite: RENDERTEST,
        from: '                rgba = null;                      // one unparsable color disables the whole strategy',
        to: '                continue;',
    },

    /* ---- LOD Task 2: ImageData and the recording context ---- */
    {
        task: 'LOD-2', label: 'putImageData applies the transform',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: '        const x0 = Math.round(Number(dx));',
        to: '        const x0 = Math.round(Number(dx) + this.transform.e);',
    },
    {
        task: 'LOD-2', label: 'fillRect forgets the style in effect',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: '            fillStyle: this.fillStyle,', to: "            fillStyle: '',",
    },
    {
        task: 'LOD-2', label: 'restore does not put back the fill style',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: '        this.fillStyle = s.fillStyle;', to: '',
    },
    {
        task: 'LOD-2', label: 'fillStyle stops normalising #rgb',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: "        this.__fillStyle = /^#[0-9a-fA-F]{3}$/.test(s)",
        to: "        this.__fillStyle = false && /^#[0-9a-fA-F]{3}$/.test(s)",
    },
    {
        task: 'LOD-2', label: 'setTransform multiplies instead of replacing',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: '    setTransform(a, b, c, d, e, f) { this.transform = new DOMMatrix([a, b, c, d, e, f]); }',
        to: '    setTransform(a, b, c, d, e, f) { this.transform.multiplySelf(new DOMMatrix([a, b, c, d, e, f])); }',
    },

    /* ---- LOD Task 1: the DOMMatrix shim ---- */
    {
        task: 'LOD-1', label: 'multiply composes in the wrong order',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: "        return new DOMMatrix([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(other);",
        to: "        return new DOMMatrix([other.a, other.b, other.c, other.d, other.e, other.f]).multiplySelf(this);",
    },
    {
        task: 'LOD-1', label: 'rotateSelf uses radians, not degrees',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: "        const r = (Number(deg) * Math.PI) / 180;", to: '        const r = Number(deg);',
    },
    {
        task: 'LOD-1', label: 'the translation column is dropped from multiplySelf',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: "        this.e = a * other.e + c * other.f + e;",
        to: '        this.e = a * other.e + c * other.f;',
    },
    {
        task: 'LOD-1', label: 'transformPoint transposes b and c',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: "        return new DOMPoint(this.a * x + this.c * y + this.e, this.b * x + this.d * y + this.f);",
        to: "        return new DOMPoint(this.a * x + this.b * y + this.e, this.c * x + this.d * y + this.f);",
    },
    {
        task: 'LOD-1', label: 'installDomShims clobbers an existing global',
        file: SHIMS, project: null, suite: SHIMTEST,
        from: "    globalThis.DOMMatrix ??= DOMMatrix;", to: '    globalThis.DOMMatrix = DOMMatrix;',
    },

    /* ---- Transport symmetry: e142DocumentToXml ---- */
    {
        task: 'Symmetry', label: 'SubstrateSide omitted from the XML writer',
        file: XMLMOD, project: ENGINE, suite: JSONTEST,
        from: "                attr('SubstrateSide', h.substrateSide),\r\n", to: '',
    },
    {
        task: 'Symmetry', label: 'Row/Column addressed by payload index, not the frame',
        file: XMLMOD, project: ENGINE, suite: JSONTEST,
        from: "            const at = table[i];\r\n            if (at === undefined) { continue; }",
        to: "            const at = { x: i % p.cols, y: Math.floor(i / p.cols) };",
    },
    {
        task: 'Symmetry', label: 'an empty MapVersion written out',
        file: XMLMOD, project: ENGINE, suite: JSONTEST,
        from: "        ov.mapVersion !== '' ? attr('MapVersion', ov.mapVersion) : '',",
        to: "        attr('MapVersion', ov.mapVersion),",
    },
    {
        task: 'Symmetry', label: 'an empty FromSubstrateId written out',
        file: XMLMOD, project: ENGINE, suite: JSONTEST,
        from: "                m.fromSubstrateId !== '' ? attr('FromSubstrateId', m.fromSubstrateId) : '',",
        to: "                attr('FromSubstrateId', m.fromSubstrateId),",
    },

    /* ---- Task 16: the binary payload ---- */
    {
        task: 'Task 16', label: 'refuse by sparse presence instead of by MapType',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: "    const perEntry = meta.mapType === 'Coordinate' || meta.mapType === 'Row/Column';",
        to: '    const perEntry = overlay.sparseBinCodes !== undefined;',
    },
    {
        task: 'Task 16', label: 'always declare $version 2',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: '        $version: binary ? E142_JSON_BINARY_SINCE : 1,',
        to: '        $version: E142_JSON_BINARY_SINCE,',
    },
    {
        task: 'Task 16', label: 'ignore MapType when shaping the expansion',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: "bcm['MapType'] === 'Array'", to: 'false as boolean',
    },
    {
        task: 'Task 16', label: 'sort the code table',
        file: JSONMOD, project: ENGINE, suite: JSONTEST,
        from: '            Codes: enc.codes, Data: enc.data, Cols: p.cols, Rows: p.rows,',
        to: '            Codes: enc.codes.slice().sort(), Data: enc.data, Cols: p.cols, Rows: p.rows,',
    },
];
