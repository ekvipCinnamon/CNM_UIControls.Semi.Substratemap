/*
 * e142-selection.test.mjs - which SubstrateMap, and which Overlay.
 *
 * Covers every branch of Tasks 29 (version-aware overlay selection) and 31
 * (substrate filtering), plus the interaction: the substrate filter narrows the
 * set the overlay filter then searches, so a name that exists in the document
 * but not in the surviving substrate must NOT be found.
 *
 * This suite calls the ENGINE's selectMapAndOverlay() directly. Selection used
 * to live in SubstrateMap.ts, and the control cannot be instantiated without a
 * DOM - so a suite written against it would have had to transcribe the algorithm
 * into the test, which tests the transcription and drifts from the code the
 * moment either changes. Task 32 moved the logic into the engine, where it is
 * pure, so these assertions run the same function the control runs.
 *
 * Run: node --test Helpers/SubstrateMapEngine/tests/e142-selection.test.mjs
 *      npm run test:selection
 */

import { stubParseDocument } from './xml-stub.mjs';
import { onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const E142 = await import(ENGINE + 'E142.js');
const E142Xml = await import(ENGINE + 'E142Xml.js');

/* ------------------------------ harness ------------------------------ */
let PASS = 0, FAIL = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES }));
function ok(cond, label) { if (cond) { PASS++; } else { FAIL++; FAILURES.push(label); } }
function eq(actual, expected, label) {
    ok(Object.is(actual, expected), `${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function has(haystack, needle, label) {
    ok(typeof haystack === 'string' && haystack.includes(needle), `${label}  (missing ${JSON.stringify(needle)} in ${JSON.stringify(haystack)})`);
}

/* ---------------------------- fixtures -------------------------------- */
const NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';
/** One overlay whose cells are all `tok`, so a wrong pick is visible. */
const overlay = (name, version, tok) =>
    `      <Overlay MapName="${name}"${version === null ? '' : ` MapVersion="${version}"`}>`
    + `<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">`
    + `<BinCode>${tok}${tok}</BinCode><BinCode>${tok}${tok}</BinCode></BinCodeMap></Overlay>`;
/** One SubstrateMap. `overlays` is pre-rendered markup. */
const map = (id, layout, overlays) =>
    `    <SubstrateMap SubstrateType="Wafer" SubstrateId="${id}" LayoutSpecifier="${layout}"`
    + ` OriginLocation="LowerLeft" AxisDirection="UpRight">\n${overlays}\n    </SubstrateMap>`;
const document_ = (maps, layouts = ['L', 'L2']) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<MapData xmlns="${NS}">`,
    '  <Layouts>',
    ...layouts.map((l) => `    <Layout LayoutId="${l}" DefaultUnits="mm" TopLevel="true">`
        + '<Dimension X="2" Y="2"/><StepSize X="1" Y="1" Units="mm"/></Layout>'),
    '  </Layouts>',
    '  <SubstrateMaps>',
    maps.join('\n'),
    '  </SubstrateMaps>',
    '</MapData>',
].join('\n');

const parse = (xml) => E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument }).doc;
const pick = (doc, f = {}) => E142.selectMapAndOverlay(doc, {
    substrateId: null, layoutSpecifier: null, overlayName: null, overlayVersion: null, ...f,
});
/** The token filling the chosen overlay - identifies WHICH one was picked. */
const token = (sel) => (sel.overlay === null ? null : sel.overlay.payload.codes[sel.overlay.payload.cells[0]]);

/* R2-1.2.1's lifecycle: one name, two versions, plus an unversioned overlay. */
const LIFECYCLE = parse(document_([
    map('W-001', 'L', [overlay('Sort', '1', 'a'), overlay('Sort', '2', 'b'), overlay('Probe', null, 'c')].join('\n')),
]));
/* 14.4 MapGroupDownload: three substrates, two sharing a layout. */
const THREE = parse(document_([
    map('W-001', 'L', overlay('Sort', '1', 'a')),
    map('W-002', 'L', overlay('Sort', '1', 'b')),
    map('W-003', 'L2', overlay('Sort', '1', 'c')),
]));

/* =====================================================================
 * Task 29 - overlay selection
 * ===================================================================== */
console.log('\n=== OVERLAY: name null, version null ===');
{
    const s = pick(LIFECYCLE);
    eq(s.error, null, 'no error');
    eq(token(s), 'a', "first renderable overlay in document order (Sort/'1')");
    eq(s.warnings.length, 0, 'no warning');
}

console.log('\n=== OVERLAY: name set, version null -> first match, WITH a warning ===');
{
    const s = pick(LIFECYCLE, { overlayName: 'Sort' });
    eq(token(s), 'a', "chose Sort/'1'");
    eq(s.warnings.length, 1, 'exactly one warning');
    has(s.warnings[0], '2 versions', 'the warning counts them');
    has(s.warnings[0], "'1', '2'", 'and lists every version found');
    has(s.warnings[0], "rendered '1'", 'and names the one chosen');
    has(s.warnings[0], 'Set E142OverlayVersion', 'and says how to make it deliberate');
}
{
    const s = pick(LIFECYCLE, { overlayName: 'Probe' });
    eq(s.warnings.length, 0, 'a name carried once does NOT warn');
    eq(token(s), 'c', 'and selects it');
}

console.log('\n=== OVERLAY: name null, version set -> ERROR, never a guess ===');
{
    const s = pick(LIFECYCLE, { overlayVersion: '2' });
    ok(s.error !== null, 'refused');
    ok(s.overlay === null, 'and selects nothing');
    has(s.error, 'not an identity', 'the message says why');
    has(s.error, '(MapName, MapVersion)', 'and names the key');
}

console.log('\n=== OVERLAY: both set -> exact pair match ===');
{
    const s = pick(LIFECYCLE, { overlayName: 'Sort', overlayVersion: '2' });
    eq(token(s), 'b', "chose Sort/'2' - the UPLOADED map (R2-1.2.1), not the stale one");
    eq(s.warnings.length, 0, 'no warning: the choice was explicit');
}
{
    const s = pick(LIFECYCLE, { overlayName: 'Sort', overlayVersion: '9' });
    ok(s.error !== null, 'no match is an error');
    has(s.error, "versions present under that name: '1', '2'", 'listing what IS there');
}

console.log('\n=== OVERLAY: "" selects an overlay with no MapVersion ===');
{
    const s = pick(LIFECYCLE, { overlayName: 'Probe', overlayVersion: '' });
    eq(token(s), 'c', "'' matched the overlay that carries no MapVersion");
    eq(s.overlay.mapVersion, '', 'whose key value is the empty string');
}
{
    const s = pick(LIFECYCLE, { overlayName: 'Sort', overlayVersion: '' });
    ok(s.error !== null, "'' is a VALUE, not a wildcard: it does not match Sort/1 or Sort/2");
    has(s.error, 'MapVersion (none)', 'and the message renders it legibly');
}
{
    const a = pick(LIFECYCLE, { overlayName: 'Sort' });
    const b = pick(LIFECYCLE, { overlayName: 'Sort', overlayVersion: '' });
    ok(a.error === null && b.error !== null, 'null and "" behave differently, as designed');
}

console.log('\n=== OVERLAY: a name that is not there ===');
{
    const s = pick(LIFECYCLE, { overlayName: 'Nope' });
    ok(s.error !== null, 'error');
    has(s.error, "no overlay named 'Nope'", 'naming what was asked for');
}

/* =====================================================================
 * Task 31 - substrate selection
 * ===================================================================== */
console.log('\n=== SUBSTRATE: filters ===');
{
    const s = pick(THREE, { substrateId: 'W-002' });
    eq(token(s), 'b', 'by SubstrateId');
    eq(s.warnings.length, 0, 'one survivor, no warning');
}
{
    const s = pick(THREE, { layoutSpecifier: 'L2' });
    eq(token(s), 'c', 'by LayoutSpecifier');
    eq(s.warnings.length, 0, 'one survivor, no warning');
}
{
    const s = pick(THREE, { substrateId: 'W-001', layoutSpecifier: 'L' });
    eq(token(s), 'a', 'by both - the complete SubstrateMapKey');
    eq(s.warnings.length, 0, 'which can never be ambiguous in a schema-valid document');
}
{
    const s = pick(THREE, { layoutSpecifier: 'L' });
    eq(token(s), 'a', 'LayoutSpecifier alone CAN still be ambiguous: two maps share L');
    eq(s.warnings.length, 1, 'so it warns');
    has(s.warnings[0], '2 SubstrateMaps match', 'counting the survivors, not the document');
}

console.log('\n=== SUBSTRATE: unfiltered warns with every triple ===');
{
    const s = pick(THREE);
    eq(token(s), 'a', 'renders the first in document order');
    eq(s.warnings.length, 1, 'and warns');
    for (const t of ['(Wafer, W-001, L)', '(Wafer, W-002, L)', '(Wafer, W-003, L2)']) {
        has(s.warnings[0], t, `listing ${t}`);
    }
    has(s.warnings[0], 'rendered (Wafer, W-001, L)', 'and naming the choice');
}

console.log('\n=== SUBSTRATE: no survivor errors with the AVAILABLE triples ===');
{
    const s = pick(THREE, { substrateId: 'W-999' });
    ok(s.error !== null, 'error');
    ok(s.overlay === null, 'nothing selected');
    has(s.error, 'The document carries 3', 'says how many there are');
    for (const t of ['(Wafer, W-001, L)', '(Wafer, W-002, L)', '(Wafer, W-003, L2)']) {
        has(s.error, t, `lists ${t}`);
    }
    has(s.error, "E142SubstrateId 'W-999'", 'and repeats what was asked for');
}
{
    const s = pick(THREE, { substrateId: 'W-001', layoutSpecifier: 'L2' });
    ok(s.error !== null, 'a pair that exists separately but not together is still no match');
    has(s.error, 'and', 'the message names BOTH filters');
}

/* =====================================================================
 * The interaction
 * ===================================================================== */
console.log('\n=== INTERACTION: the substrate filter narrows what the overlay filter searches ===');
{
    /* 'Retest' exists in the document, but only under W-002. Selecting W-001
     * must not find it: the overlay search runs over the SURVIVORS, not the
     * document. A selector that searched the document first and filtered
     * afterwards would return it. */
    const doc = parse(document_([
        map('W-001', 'L', overlay('Sort', '1', 'a')),
        map('W-002', 'L2', [overlay('Sort', '1', 'b'), overlay('Retest', '1', 'r')].join('\n')),
    ]));
    eq(token(pick(doc, { overlayName: 'Retest' })), 'r', 'unfiltered, Retest is found under W-002');
    const s = pick(doc, { substrateId: 'W-001', overlayName: 'Retest' });
    ok(s.error !== null, 'filtered to W-001, Retest is NOT found');
    has(s.error, "no overlay named 'Retest'", 'and the message is about the overlay, not the substrate');
    eq(token(pick(doc, { substrateId: 'W-002', overlayName: 'Retest' })), 'r', 'filtered to W-002, it is');
}
{
    /* Same name at different versions in different substrates: the version
     * ambiguity warning must count only within the surviving substrate. */
    const doc = parse(document_([
        map('W-001', 'L', overlay('Sort', '1', 'a')),
        map('W-002', 'L2', [overlay('Sort', '1', 'b'), overlay('Sort', '2', 'c')].join('\n')),
    ]));
    const all = pick(doc, { overlayName: 'Sort' });
    eq(all.warnings.length, 2, 'unfiltered: both the substrate and the version warnings fire');
    const one = pick(doc, { substrateId: 'W-001', overlayName: 'Sort' });
    eq(one.warnings.length, 0, 'filtered to W-001: no ambiguity remains, so neither warning fires');
    eq(token(one), 'a', 'and the right overlay is chosen');
    const two = pick(doc, { substrateId: 'W-002', overlayName: 'Sort' });
    eq(two.warnings.length, 1, 'filtered to W-002: only the version warning remains');
    has(two.warnings[0], '2 versions', 'counted within the surviving substrate only');
}
{
    /* Substrate filter first also means an unrenderable overlay in a filtered-out
     * substrate cannot mask a good one. */
    const doc = parse(document_([
        map('W-001', 'L', '      <Overlay MapName="Sort" MapVersion="1"/>'),
        map('W-002', 'L2', overlay('Sort', '1', 'b')),
    ]));
    const s = pick(doc, { substrateId: 'W-002', overlayName: 'Sort' });
    eq(token(s), 'b', 'the empty overlay in W-001 is out of scope and does not interfere');
    const t = pick(doc, { substrateId: 'W-001', overlayName: 'Sort' });
    ok(t.error !== null, 'while selecting W-001 reports the unrenderable overlay');
    has(t.error, 'not a BinCodeMap', 'with the right reason');
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
