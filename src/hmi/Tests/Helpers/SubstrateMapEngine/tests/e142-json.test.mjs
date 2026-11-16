/*
 * e142-json.test.mjs - the JSON input path.
 *
 * Task 7's instruction is "do not reimplement a single rule", and the module
 * obeys it by not being a parser at all: it presents a JSON document as the
 * `E142XmlElement` interface that `parseE142Xml` already takes through its
 * injectable seam, so every facet, every identity constraint and the whole token
 * decode is literally the same code for both formats.
 *
 * That makes the interesting assertions structural rather than semantic. There
 * is no point re-testing whether an 81-character CarrierId warns - the XML suite
 * already does, and it is the same function. What IS worth testing:
 *
 *   1. the two paths agree, on a document exercising most of the model;
 *   2. the mapping is right where the XSD is asymmetric - `BinCode` is an
 *      ELEMENT on BinCodeMap and an ATTRIBUTE on BinDefinition, and an unkeyed
 *      lookup gets one of the two wrong;
 *   3. all four MapType payload forms reach the decoder;
 *   4. PVSet, whose JSON shape was wrong in three ways until Task 7 checked it
 *      against E138Pv's actual walker;
 *   5. the envelope, which is the only part with rules of its own;
 *   6. that the module has not grown a second validator;
 *   7. that e142DocumentToJson round-trips the whole XML corpus and is
 *      byte-stable (Task 8);
 *   8. the $binary payload member, which compresses the token text without being
 *      able to mean anything it cannot (Task 16);
 *   9. TRANSPORT SYMMETRY: every route out of the model and back into it.
 *
 * Run: node --test Helpers/SubstrateMapEngine/tests/e142-json.test.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { stubParseDocument } from './xml-stub.mjs';
import { makeHarness, normalize as norm, threw, onCrash } from './lib/harness.mjs';

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();
/* section() lets the run continue past a dead family; this guarantees it
 * REPORTS even when the throw is at module level, outside every section. */
onCrash(counts);

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const E142Xml = await import(ENGINE + 'E142Xml.js');
const E142Json = await import(ENGINE + 'E142Json.js');


const NS = 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap';
const LONG_CARRIER = 'C'.repeat(81);

/* =====================================================================
 * 1. The two paths agree
 * ===================================================================== */
section('1. parseE142Json and parseE142Xml agree', () => {
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <MapData xmlns="${NS}">
      <Layouts>
        <Layout LayoutId="L0" DefaultUnits="mm" TopLevel="true">
          <Dimension X="1" Y="1"/>
          <ChildLayouts><ChildLayout LayoutId="L0_Dev"/></ChildLayouts>
        </Layout>
        <Layout LayoutId="L0_Dev" DefaultUnits="mm">
          <Dimension X="5" Y="4"/>
          <StepSize X="1.5" Y="1.5" Units="mm"/>
          <DeviceSize X="1.2" Y="1.2" Units="mm"/>
          <ProductId>PN-7</ProductId>
        </Layout>
      </Layouts>
      <Substrates>
        <Substrate SubstrateType="Wafer" SubstrateId="W-1">
          <LotId>LOT-9</LotId>
          <AliasIds><AliasId Type="FrontsideId" Value="F-1"/></AliasIds>
          <CarrierId>${LONG_CARRIER}</CarrierId>
          <SlotNumber>0</SlotNumber>
          <GoodDevices>17</GoodDevices>
        </Substrate>
      </Substrates>
      <SubstrateMaps>
        <SubstrateMap SubstrateType="Wafer" SubstrateId="W-1" LayoutSpecifier="L0/L0_Dev"
                      SubstrateSide="TopSide" Orientation="0" OriginLocation="UpperLeft"
                      AxisDirection="DownRight">
          <Overlay MapName="BinCodes" MapVersion="1">
            <ReferenceDevices>
              <ReferenceDevice Name="R1"><Coordinates X="0" Y="0"/></ReferenceDevice>
            </ReferenceDevices>
            <BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">
              <BinDefinitions>
                <BinDefinition BinCode="1" BinQuality="Pass"/>
                <BinDefinition BinCode="9" BinQuality="Fail"/>
              </BinDefinitions>
              <BinCode>.111.</BinCode><BinCode>11911</BinCode>
              <BinCode>11111</BinCode><BinCode>.111.</BinCode>
            </BinCodeMap>
          </Overlay>
        </SubstrateMap>
      </SubstrateMaps>
    </MapData>`;
        const json = {
            $format: 'semi-e142', $version: 1, $namespace: NS,
            Layouts: [
                { LayoutId: 'L0', DefaultUnits: 'mm', TopLevel: true,
                    Dimension: { X: 1, Y: 1 }, ChildLayouts: ['L0_Dev'] },
                { LayoutId: 'L0_Dev', DefaultUnits: 'mm', Dimension: { X: 5, Y: 4 },
                    StepSize: { X: 1.5, Y: 1.5, Units: 'mm' },
                    DeviceSize: { X: 1.2, Y: 1.2, Units: 'mm' }, ProductId: 'PN-7' },
            ],
            Substrates: [
                { SubstrateType: 'Wafer', SubstrateId: 'W-1', LotId: 'LOT-9',
                    AliasIds: [{ Type: 'FrontsideId', Value: 'F-1' }],
                    CarrierId: LONG_CARRIER, SlotNumber: 0, GoodDevices: 17 },
            ],
            SubstrateMaps: [{
                SubstrateType: 'Wafer', SubstrateId: 'W-1', LayoutSpecifier: 'L0/L0_Dev',
                SubstrateSide: 'TopSide', Orientation: 0, OriginLocation: 'UpperLeft',
                AxisDirection: 'DownRight',
                Overlay: [{
                    MapName: 'BinCodes', MapVersion: '1',
                    ReferenceDevices: [{ Name: 'R1', Coordinates: { X: 0, Y: 0 } }],
                    BinCodeMap: {
                        BinType: 'Ascii', NullBin: '.', MapType: '2DArray',
                        BinDefinitions: [{ BinCode: '1', BinQuality: 'Pass' },
                            { BinCode: '9', BinQuality: 'Fail' }],
                        BinCode: ['.111.', '11911', '11111', '.111.'],
                    },
                }],
            }],
        };
        const a = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
        const b = E142Json.parseE142Json(json);

        ok(norm(a.doc) === norm(b.doc),
            'the two paths return structurally equal E142Documents for the same map');
        /* Done-when 2, and the reason it is free: checkIdLength is one function. */
        ok(a.warnings.length === 1 && a.warnings[0].startsWith('E142_XML_ID_TOO_LONG'),
            '  the XML path warns about the 81-character CarrierId');
        ok(b.warnings.length === 1 && b.warnings[0].startsWith('E142_XML_ID_TOO_LONG'),
            '  so does the JSON path, with the SAME code - not a second rule');
        eq(b.warnings[0], a.warnings[0], '  and the same structural path, character for character');

        /* Zero on purpose: it is a value, not an absence. */
        eq(b.doc.substrates[0].slotNumber, 0, '  SlotNumber 0 survives as a value');
        eq(b.doc.substrates[0].aliasIds[0].value, 'F-1', '  AliasIds flattens its container correctly');
        eq(b.doc.layouts[0].childLayouts[0], 'L0_Dev',
            '  ChildLayouts flattens an array of strings back into <ChildLayout LayoutId=…>');
});

/* =====================================================================
 * 2. The asymmetric names
 * ===================================================================== */
section('2. BinCode is an element here and an attribute there', () => {
        const withMapType = (mapType, binCode, layout) => E142Json.parseE142Json({
            $format: 'semi-e142', $version: 1,
            ...(layout ? { Layouts: [{ LayoutId: 'L', DefaultUnits: 'mm', Dimension: { X: 3, Y: 3 } }] } : {}),
            SubstrateMaps: [{
                SubstrateType: 'Wafer', SubstrateId: 'W', LayoutSpecifier: layout ? 'L' : '',
                Overlay: [{ MapName: 'M', BinCodeMap: {
                    BinType: 'Ascii', NullBin: '.', MapType: mapType,
                    BinDefinitions: [{ BinCode: '1', BinQuality: 'Pass' }],
                    BinCode: binCode } }],
            }],
        });

        const twoD = attempt('2DArray parses', () => withMapType('2DArray', ['.1.', '111', '.1.'], false));
        if (twoD) {
            eq(twoD.doc.substrateMaps[0].overlays[0].payload.cols, 3,
                '2DArray: string[] becomes one row each');
            eq(twoD.doc.substrateMaps[0].overlays[0].binDefinitions[0].binCode, '1',
                '  and BinDefinition/@BinCode is still read as an ATTRIBUTE in the same document');
        }

        const arr = attempt('Array parses - the case an unkeyed TEXT_CHILDREN breaks',
            () => withMapType('Array', '.1.111.1.', true));
        if (arr) {
            eq(arr.doc.substrateMaps[0].overlays[0].payload.cells.length, 9,
                'Array: one string becomes the element\'s text, not an attribute');
        }

        const coord = attempt('Coordinate parses', () => withMapType('Coordinate',
            [{ X: 0, Y: 0, $text: '1' }, { X: 1, Y: 1, $text: '1', LID: 'L7' }], true));
        if (coord) {
            const cp = coord.doc.substrateMaps[0].overlays[0].payload;
            eq(cp.cols, 3, 'Coordinate: sparse entries decode against the declared lattice');
            eq(cp.lids.size, 1, '  and a LID on an entry reaches the decoded payload');
        }
});

/* =====================================================================
 * 3. PVSet — three shapes that were wrong until Task 7 checked them
 * ===================================================================== */
section('3. PVSet', () => {
        const pv = (values) => E142Json.parseE142Json({
            $format: 'semi-e142', $version: 1,
            SubstrateMaps: [{ SubstrateType: 'Wafer', SubstrateId: 'W', LayoutSpecifier: '',
                Overlay: [{ MapName: 'D', DeviceDataMap: [{ Parameter: [{ Name: 'T' }],
                    DeviceData: [{ X: 0, Y: 0, PVSet: values }] }] }] }],
        });
        const vals = (r) => r.doc.substrateMaps[0].overlays[0].deviceDataMaps[0].deviceData[0].values;

        const su = vals(pv([{ F8: 1.5 }, { Su: [{ I4: 7 }, { S: 'in' }] }]));
        eq(su[0].value, 1.5, 'a scalar kind carries its lexical value');
        eq(su[1].kind, 'Su', 'Su recurses');
        eq(su[1].fields.length, 2, '  and its fields are POSITIONAL - an array, not a name map');
        eq(su[1].fields[1].value, 'in', '  in document order');

        const nil = vals(pv([{ F8: null }]));
        eq(nil[0].value, null, 'a scalar kind with null is xsi:nil, not a parse failure');

        const nv = pv([{ NoValue: { reasonCode: 'NoSuchSource', Description: 'offline' } }]);
        eq(vals(nv)[0].reasonCode, 'NoSuchSource', 'NoValue is an OBJECT carrying its required reasonCode');
        eq(vals(nv)[0].description, 'offline', '  and its Description child');
        eq(nv.warnings.filter((w) => w.includes('NOVALUE')).length, 0,
            '  so it warns about nothing - a bare null would warn on every document');
});

/* =====================================================================
 * 4. The envelope
 * ===================================================================== */
section('4. the envelope', () => {
        const minimal = (over = {}) => ({
            $format: 'semi-e142', $version: 1,
            SubstrateMaps: [{ SubstrateType: 'Wafer', SubstrateId: 'W', LayoutSpecifier: '',
                Overlay: [{ MapName: 'M', BinCodeMap: { BinType: 'Ascii', NullBin: '.',
                    MapType: '2DArray', BinCode: ['.1.', '111', '.1.'] } }] }],
            ...over,
        });

        eq(threw(() => E142Json.parseE142Json(minimal({ $format: 'nope' }))), 'E142_XML_NOT_E142',
            'a wrong $format is refused');
        eq(threw(() => E142Json.parseE142Json(minimal({ $format: undefined }))), 'E142_XML_NOT_E142',
            '  and so is an absent one');
        eq(threw(() => E142Json.parseE142Json(minimal({ $version: '1' }))), 'E142_XML_ATTR_INVALID',
            '$version must be an integer, not a string');
        eq(threw(() => E142Json.parseE142Json('{nope')), 'E142_XML_MALFORMED',
            'malformed JSON text is refused outright');
        eq(threw(() => E142Json.parseE142Json([])), 'E142_XML_MALFORMED',
            '  as is a document that is not an object');

        const ahead = E142Json.parseE142Json(minimal({ $version: 99 }));
        ok(ahead.warnings.some((w) => w.startsWith('E142_JSON_VERSION_AHEAD')),
            'a $version ahead of this engine warns');
        eq(ahead.doc.substrateMaps.length, 1, '  and parses anyway - a later envelope only adds members');

        eq(E142Json.parseE142Json(JSON.stringify(minimal())).doc.substrateMaps.length, 1,
            'a string document parses');
        eq(E142Json.parseE142Json(minimal()).doc.substrateMaps.length, 1,
            'so does an already-parsed object - which is how a typed HMI symbol arrives');

        /* Done-when 3. */
        const scalar = E142Json.parseE142Json(minimal({ SubstrateMaps: [{ SubstrateType: 'Wafer',
            SubstrateId: 'W', SubstrateID: 'typo', LayoutSpecifier: '',
            Overlay: [{ MapName: 'M', BinCodeMap: { BinType: 'Ascii', NullBin: '.',
                MapType: '2DArray', BinCode: ['.1.', '111', '.1.'] } }] }] }));
        ok(scalar.warnings.some((w) => w.startsWith('E142_JSON_UNKNOWN_MEMBER')),
            'an unknown SCALAR member warns - it would otherwise become an attribute and vanish');
        eq(scalar.doc.substrateMaps.length, 1, '  and the document still parses, rather than being rejected');
});

/* =====================================================================
 * 5. No second validator has grown here
 * ===================================================================== */
section('5. the module is still not a parser', () => {
        const SRC = readFileSync(new URL('../E142Json.ts', import.meta.url), 'utf8');
        ok(/^import \{[^}]*\bparseE142Xml\b[^}]*\} from '\.\/E142Xml\.js';$/m.test(SRC),
            'it delegates to parseE142Xml rather than walking the document itself');
        ok(/parseE142Xml\('',\s*\{\s*parseDocument:/.test(SRC.replace(/\s+/g, ' ')),
            '  through the injectable seam, with the JSON tree as the provider');

        /* The rules that must live in exactly one place. If any of these names ever
         * appears here, a second copy has started. */
        for (const rule of ['maxLength', 'MATERIAL_ID_MAX', 'LOT_ID_MAX', 'nonNegativeInteger',
            'decodeBinPayload', 'xs:double', 'OrientationType', 'xs:key']) {
            ok(!SRC.includes(rule), `  no "${rule}" here - that rule lives in E142Xml/E142Bins alone`);
        }
        /* Enumerations too: the bin types, map types and frame enums are the XML
         * parser's, and a copy here would be the drift the task warns about. */
        for (const enumMember of ['HexaDecimal', 'Integer2', 'UpperLeft', 'DownRight', 'BottomSide']) {
            ok(!SRC.includes(enumMember), `  and no "${enumMember}" - enumerations are not restated`);
        }
});

/* =====================================================================
 * 6. e142DocumentToJson - round trip and byte stability (Task 8)
 * ===================================================================== */
section('6. the serializer', () => {
        /* Over the WHOLE XML corpus, not a sample: the interesting cases are the ones
         * nobody would think to write by hand. Two fixtures are deliberately invalid
         * and do not parse; they are counted, not silently skipped, because a
         * "skipped" that quietly grows is how a corpus stops covering anything. */
        const dir = fileURLToPath(new URL('./fixtures/xml/', import.meta.url));
        const files = readdirSync(dir).filter((n) => n.endsWith('.xml')).sort();
        ok(files.length > 30, `the XML corpus has ${files.length} fixtures to round-trip`);

        let round = 0, stable = 0, unparseable = 0;
        const broken = [];
        for (const f of files) {
            let doc;
            try { doc = E142Xml.parseE142Xml(readFileSync(dir + f, 'utf8'), { parseDocument: stubParseDocument }).doc; }
            catch { unparseable++; continue; }
            const a = E142Json.e142DocumentToJson(doc);
            const b = E142Json.e142DocumentToJson(doc);
            if (a === b) { stable++; } else { broken.push(`${f}: not byte-stable`); continue; }
            let back;
            try { back = E142Json.parseE142Json(a).doc; }
            catch (e) { broken.push(`${f}: reparse threw ${e.code}`); continue; }
            if (norm(back) === norm(doc)) { round++; } else { broken.push(`${f}: not structurally equal`); }
        }
        const parseable = files.length - unparseable;
        eq(round, parseable, `Done-when 1: parse(serialize(doc)) equals doc for all ${parseable} parseable fixtures`);
        eq(stable, parseable, 'Done-when 2: serializing twice produces identical bytes, every fixture');
        eq(unparseable, 2, '  and exactly the two deliberately-invalid fixtures did not parse');
        for (const b of broken.slice(0, 5)) { ok(false, '  ' + b); }

        /* The three payload forms that cannot simply be copied back out. */
        const oneMap = (mapType, binCode, layout) => E142Json.parseE142Json({
            $format: 'semi-e142', $version: 1,
            ...(layout ? { Layouts: [{ LayoutId: 'L', DefaultUnits: 'mm', Dimension: { X: 3, Y: 3 } }] } : {}),
            SubstrateMaps: [{ SubstrateType: 'Wafer', SubstrateId: 'W', LayoutSpecifier: layout ? 'L' : '',
                OriginLocation: 'LowerLeft', AxisDirection: 'UpRight',
                Overlay: [{ MapName: 'M', BinCodeMap: { BinType: 'Ascii', NullBin: '.',
                    MapType: mapType, BinCode: binCode } }] }],
        }).doc;
        for (const [label, mapType, payload, layout] of [
            ['2DArray', '2DArray', ['.1.', '119', '.1.'], false],
            ['Array', 'Array', '.1.119.1.', true],
            ['Row/Column', 'Row/Column', [{ X: 0, Y: 0, $text: '.1.' }, { X: 0, Y: 1, $text: '119' }], true],
            ['Coordinate', 'Coordinate', [{ X: 0, Y: 0, $text: '1' }, { X: 1, Y: 1, $text: '9' }], true],
        ]) {
            const doc = oneMap(mapType, payload, layout);
            const back = attempt(`${label} survives the serializer`,
                () => E142Json.parseE142Json(E142Json.e142DocumentToJson(doc)).doc);
            if (back) {
                ok(norm(back) === norm(doc), `  ${label}: cells and MapType both survive`);
                eq(back.substrateMaps[0].overlays[0].binCodeMapMeta.mapType, mapType,
                    `  ${label}: MapType is preserved, not normalised to another form`);
            }
        }

        /* Decimal is the separator trap: its tokens are whitespace-separated, so a
         * concatenated re-encode serialises cleanly and cannot be read back. */
        const dec = E142Json.parseE142Json({
            $format: 'semi-e142', $version: 1,
            SubstrateMaps: [{ SubstrateType: 'Wafer', SubstrateId: 'W', LayoutSpecifier: '',
                Overlay: [{ MapName: 'M', BinCodeMap: { BinType: 'Decimal', NullBin: '000',
                    MapType: '2DArray', BinCode: ['000 001 000', '001 009 001'] } }] }],
        }).doc;
        const decBack = attempt('Decimal re-encodes with its separators',
            () => E142Json.parseE142Json(E142Json.e142DocumentToJson(dec)).doc);
        if (decBack) { ok(norm(decBack) === norm(dec), '  and round-trips to the same cells'); }

        /* An absent From* must not come back as an empty one. The model stores both
     * as '', but the parser WARNS about an absent @FromSubstrateId and THROWS
     * E142_XML_INTEGRITY on an empty one - so writing '' turns a document that
     * parses into one that is rejected. Found by round-tripping
     * v0125-transfer-degenerate; without this assertion the fix is one edit from
     * being undone. */
    attempt('an absent From* survives the round trip as absent', () => {
        const src = {
            $format: 'semi-e142', $version: 1,
            Layouts: [{ LayoutId: 'D', DefaultUnits: 'mm', Dimension: { X: 2, Y: 1 } }],
            SubstrateMaps: [
                { SubstrateType: 'Wafer', SubstrateId: 'SRC-A', LayoutSpecifier: '' },
                { SubstrateType: 'Wafer', SubstrateId: 'D1', LayoutSpecifier: 'D',
                    Overlay: [{ MapName: 'P', TransferMap: [{
                        FromSubstrateType: 'Wafer', FromSubstrateLayoutSpecifier: '',
                        T: [{ FX: 0, FY: 0, TX: 0, TY: 0 }] }] }] },
            ],
        };
        const once = E142Json.parseE142Json(src);
        ok(once.warnings.some((w) => w.startsWith('E142_XML_TRANSFER_FROM_MISSING')),
            'an absent @FromSubstrateId warns and parses');
        const text = E142Json.e142DocumentToJson(once.doc);
        ok(!text.includes('"FromSubstrateId":""'),
            '  and is NOT written back as "" — that would be a dangling keyref');
        const twice = attempt('  reparsing the serialized form',
            () => E142Json.parseE142Json(text));
        if (twice) {
            deep(twice.warnings.map((w) => w.split(/[: ]/)[0]),
                once.warnings.map((w) => w.split(/[: ]/)[0]),
                '  so the round trip warns the same and does not throw E142_XML_INTEGRITY');
        }
        /* The empty specifier is the opposite case and must be KEPT. */
        ok(text.includes('"FromSubstrateLayoutSpecifier":""'),
            'while an empty @FromSubstrateLayoutSpecifier IS written — "" is the layoutless form');
    });

    /* The envelope the serializer writes. */
        const emitted = JSON.parse(E142Json.e142DocumentToJson(dec));
        eq(Object.keys(emitted)[0], '$format', '$format is written FIRST, so a reader can discriminate on it');
        eq(emitted.$version, 1, '  with the envelope version as an integer');
        eq(emitted.SubstrateMaps[0].SubstrateSide, 'TopSide',
            'SubstrateSide is written even when TopSide - its absence would ASSERT the top face');
        eq(emitted.SubstrateMaps[0].LayoutSpecifier, '',
            '  and an empty LayoutSpecifier is kept: "" is the layoutless form, not an absence');
        ok(!('schemaVersion' in emitted), 'schemaVersion is not emitted - it is derived from $namespace');
        ok(!('MapVersion' in emitted.SubstrateMaps[0].Overlay[0]),
            'an empty MapVersion is OMITTED - absent and "" are the same OverlayKey, so writing "" '
            + 'asserts nothing and invites a reader to think it does');
        ok(!JSON.stringify(emitted).includes('"cells"'),
            'the decoded payload is not emitted - the token text is the document, cells are its decode');
});

section('7. the $binary payload (Task 16)', () => {
    const dir = fileURLToPath(new URL('./fixtures/xml/', import.meta.url));
    const files = readdirSync(dir).filter((n) => n.endsWith('.xml')).sort();

    /* xml -> doc -> BINARY -> doc, over the whole corpus. The token round trip is
     * section 6's; this asserts the binary form loses nothing the token form keeps. */
    let round = 0;
    let refused = 0;
    let unparseable = 0;
    const broken = [];
    for (const f of files) {
        let doc;
        try { doc = E142Xml.parseE142Xml(readFileSync(dir + f, 'utf8'), { parseDocument: stubParseDocument }).doc; }
        catch { unparseable++; continue; }
        let bin;
        try { bin = E142Json.e142DocumentToJson(doc, { binary: true }); }
        catch (e) {
            if (e.code === 'E142_JSON_BINARY_UNSUPPORTED') { refused++; continue; }
            broken.push(`${f}: ${e.code}`); continue;
        }
        let back;
        try { back = E142Json.parseE142Json(bin).doc; }
        catch (e) { broken.push(`${f}: reparse ${e.code}`); continue; }
        if (norm(back) === norm(doc)) { round++; } else { broken.push(`${f}: not equal`); }
    }
    eq(broken.length, 0,
        `xml -> doc -> binary -> doc equals xml -> doc for all ${round} dense fixtures  ${broken[0] ?? ''}`);
    ok(round > 35, `${round} fixtures round-tripped through the binary form`);
    eq(unparseable, 2, '  the two deliberately-invalid fixtures still do not parse');
    eq(refused, 4,
        '  and four are REFUSED, not silently written as tokens — Coordinate and Row/Column '
        + 'address every entry individually and an index stream cannot express that');

    /* The refusal is by declared MapType, not by whether sparse entries survived.
     * The parser keeps them for Coordinate and drops them for Row/Column
     * (observation 27), so a presence check refuses one form and mangles the other
     * — which is what happened before this was keyed on MapType. */
    attempt('refusal is keyed on MapType', () => {
        const rc = E142Xml.parseE142Xml(readFileSync(dir + 'v0211-rowcolumn-prose-derived.xml', 'utf8'),
            { parseDocument: stubParseDocument }).doc;
        eq(rc.substrateMaps[0].overlays[0].sparseBinCodes, undefined,
            'Row/Column retains NO sparse entries — a presence check would not catch it');
        eq(threw(() => E142Json.e142DocumentToJson(rc, { binary: true })),
            'E142_JSON_BINARY_UNSUPPORTED', '  and it is refused anyway, on the declared MapType');
    });

    /* The envelope version tracks the features used, not the engine's. */
    attempt('the version bump', () => {
        const doc = E142Xml.parseE142Xml(
            readFileSync(dir + 'v0211-hexadecimal-nullbin-round.xml', 'utf8'),
            { parseDocument: stubParseDocument }).doc;
        eq(JSON.parse(E142Json.e142DocumentToJson(doc)).$version, 1,
            'the token form stays $version 1 — a version-1 reader must not be refused a document '
            + 'it could read');
        const bin = JSON.parse(E142Json.e142DocumentToJson(doc, { binary: true }));
        eq(bin.$version, 2, 'and the binary form declares 2');
        ok(bin.SubstrateMaps[0].Overlay[0].BinCodeMap.$binary !== undefined, '  carrying $binary');
        eq(bin.SubstrateMaps[0].Overlay[0].BinCodeMap.BinCode, undefined,
            '  and NOT BinCode — they are two encodings of one payload');
        eq(bin.SubstrateMaps[0].Overlay[0].BinCodeMap.$binary.Codes[0], 'F0',
            '  with the null bin first in the code table, as index 0 demands');
    });

    /* A document that uses the member while declaring the older version is read,
     * with a warning: its content is unambiguous. */
    attempt('version tolerance and conflicts', () => {
        const doc = E142Xml.parseE142Xml(
            readFileSync(dir + 'v0211-hexadecimal-nullbin-round.xml', 'utf8'),
            { parseDocument: stubParseDocument }).doc;
        const bin = JSON.parse(E142Json.e142DocumentToJson(doc, { binary: true }));

        const old = JSON.parse(JSON.stringify(bin));
        old.$version = 1;
        const r = E142Json.parseE142Json(old);
        ok(r.warnings.some((w) => w.startsWith('E142_JSON_BINARY_VERSION_TOO_OLD')),
            '$binary at $version 1 warns');
        ok(norm(r.doc) === norm(doc), '  and is read anyway — the content is unambiguous');

        const both = JSON.parse(JSON.stringify(bin));
        both.SubstrateMaps[0].Overlay[0].BinCodeMap.BinCode = ['garbage'];
        const r2 = E142Json.parseE142Json(both);
        ok(r2.warnings.some((w) => w.startsWith('E142_JSON_BINARY_AND_TOKENS')),
            'carrying BOTH forms warns');
        ok(norm(r2.doc) === norm(doc),
            '  and $binary wins — it is the one a producer went out of its way to write');

        /* A malformed block with no BinCode to fall back on leaves the overlay
         * with no payload at all. That is an error, and it is raised HERE rather
         * than downstream, where the message would blame a missing <BinCode> the
         * document never claimed to have. */
        const bad = JSON.parse(JSON.stringify(bin));
        delete bad.SubstrateMaps[0].Overlay[0].BinCodeMap.$binary.Cols;
        eq(threw(() => E142Json.parseE142Json(bad)), 'E142_XML_ELEMENT_MISSING',
            'a block missing Cols with no token fallback is an error, not a guess');

        /* With a fallback, the same malformation is survivable: warn, use BinCode. */
        const fallback = JSON.parse(JSON.stringify(bad));
        fallback.SubstrateMaps[0].Overlay[0].BinCodeMap.BinCode =
            JSON.parse(E142Json.e142DocumentToJson(doc)).SubstrateMaps[0].Overlay[0].BinCodeMap.BinCode;
        const r3 = E142Json.parseE142Json(fallback);
        ok(r3.warnings.some((w) => w.startsWith('E142_JSON_BINARY_MALFORMED')),
            '  and with a BinCode present it is reported and the tokens are used instead');
        ok(norm(r3.doc) === norm(doc), '  giving the same document');
    });

    /*
     * And the honest part: it does not always win, and which way it falls is
     * arithmetic rather than a property of any document. Base64 of two bytes is
     * 2.67 characters per cell. A token costs one character for Ascii, two for
     * HexaDecimal, and four for Decimal ("001 ", the separator included) and
     * Integer2 - so the binary form is about a third smaller for the four-character
     * types and up to 2.7x LARGER for Ascii.
     *
     * Measured on synthetic maps rather than on the corpus: the corpus fixtures are
     * a few cells each except one, so their envelope dominates and every BinType
     * appears to lose. That table would have been true and useless.
     */
    attempt('the size result, stated whichever way it falls', () => {
        const N = 100;
        const TOKEN = { Ascii: (v) => String.fromCharCode(v), Decimal: (v) => String(v).padStart(3, '0'),
            HexaDecimal: (v) => v.toString(16).toUpperCase().padStart(2, '0'),
            Integer2: (v) => v.toString(16).toUpperCase().padStart(4, '0') };
        const NULLS = { Ascii: 0x2e, Decimal: 0, HexaDecimal: 0, Integer2: 0 };
        const PASS = { Ascii: 0x31, Decimal: 1, HexaDecimal: 1, Integer2: 1 };
        const verdict = {};
        for (const bt of ['Ascii', 'Decimal', 'HexaDecimal', 'Integer2']) {
            const sep = bt === 'Decimal' ? ' ' : '';
            const row = new Array(N).fill(TOKEN[bt](PASS[bt])).join(sep);
            const rows = new Array(N).fill(row);
            const xml = '<?xml version="1.0"?><MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">'
                + '<SubstrateMaps><SubstrateMap SubstrateType="Wafer" SubstrateId="B" LayoutSpecifier="">'
                + `<Overlay MapName="M"><BinCodeMap BinType="${bt}" NullBin="${TOKEN[bt](NULLS[bt])}" `
                + 'MapType="2DArray">' + rows.map((r) => `<BinCode>${r}</BinCode>`).join('')
                + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';
            const doc = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument }).doc;
            const t = E142Json.e142DocumentToJson(doc).length;
            const b = E142Json.e142DocumentToJson(doc, { binary: true }).length;
            verdict[bt] = b < t;
            console.log(`  ${bt.padEnd(12)} ${N}x${N}: token ${String(t).padStart(7)} B   binary `
                + `${String(b).padStart(7)} B   ratio ${(b / t).toFixed(2)}   `
                + `${b < t ? 'binary wins' : 'BINARY LOSES'}`);
        }
        ok(verdict.Decimal, 'Decimal is SMALLER in the binary form — four token characters against 2.67');
        ok(verdict.Integer2, 'Integer2 is smaller too, for the same reason');
        ok(!verdict.Ascii,
            'Ascii is LARGER — one character per cell against base64 of two bytes. Asserted rather '
            + 'than omitted, so Task 17 does not meet it as a surprise');
        ok(!verdict.HexaDecimal, 'and HexaDecimal is larger as well: two characters against 2.67');
    });
});

section('8. transport symmetry (e142DocumentToXml)', () => {
    /*
     * E142 specifies a data MODEL and an XML representation of it for transport.
     * This engine holds the model as `E142Document` and reads both representations
     * into it through one parser; until `e142DocumentToXml` existed it could only
     * write one of them back, which made JSON the better-supported transport of
     * the two - the opposite asymmetry to the one the documentation implied.
     *
     * Four routes, all of which must land on the same document. The interesting
     * one is xml -> json -> xml: it crosses transports twice, so anything the JSON
     * representation cannot express shows up as a difference at the end.
     */
    const dir = fileURLToPath(new URL('./fixtures/xml/', import.meta.url));
    const files = readdirSync(dir).filter((n) => n.endsWith('.xml')).sort();
    const parse = (x) => E142Xml.parseE142Xml(x, { parseDocument: stubParseDocument }).doc;

    const routes = {
        'xml -> xml': (d) => parse(E142Xml.e142DocumentToXml(d)),
        'xml -> json -> xml': (d) =>
            parse(E142Xml.e142DocumentToXml(E142Json.parseE142Json(E142Json.e142DocumentToJson(d)).doc)),
        'xml -> binary -> xml': (d) =>
            parse(E142Xml.e142DocumentToXml(
                E142Json.parseE142Json(E142Json.e142DocumentToJson(d, { binary: true })).doc)),
    };
    const tally = {};
    const broken = [];
    for (const f of files) {
        let doc;
        try { doc = parse(readFileSync(dir + f, 'utf8')); } catch { continue; }
        for (const [label, run] of Object.entries(routes)) {
            try {
                if (norm(run(doc)) === norm(doc)) { tally[label] = (tally[label] ?? 0) + 1; }
                else { broken.push(`${f} via ${label}: differs`); }
            } catch (e) {
                // The binary form refuses the per-entry MapTypes by design (D-050).
                if (e.code !== 'E142_JSON_BINARY_UNSUPPORTED') {
                    broken.push(`${f} via ${label}: ${e.code ?? e.name}`);
                }
            }
        }
    }
    eq(broken.length, 0, `every transport route lands on the same document  ${broken[0] ?? ''}`);
    // 44 before Task 28 added twelve physical-scale fixtures. A literal rather
    // than a length, so a fixture that silently stopped parsing shows up here
    // as a smaller number instead of as a smaller expectation.
    eq(tally['xml -> xml'], 56, 'doc -> XML -> doc for all 56 parseable fixtures');
    eq(tally['xml -> json -> xml'], 56,
        'and doc -> JSON -> doc -> XML -> doc too — crossing transports twice loses nothing');
    eq(tally['xml -> binary -> xml'], 52,
        '  the binary route covers the 52 dense fixtures; the four per-entry MapTypes are refused');

    /*
     * ONE LARGE REAL DOCUMENT (P-3). Everything above runs on corpus fixtures of a
     * few hundred cells, and the size assertions in section 7 run on synthetic
     * maps. Neither exercises the binary path at a scale where an index block is
     * what it exists for. 360 000 cells, three codes, a real round-wafer mask.
     */
    attempt('the binary route survives a 360 000-cell document', () => {
        const doc = parse(readFileSync(dir + 'v0211-perf-600x600-ascii.xml', 'utf8'));
        const payload = doc.substrateMaps[0].overlays[0].payload;
        eq(payload.cols * payload.rows, 360000, 'the fixture really is 600x600');

        const binary = E142Json.e142DocumentToJson(doc, { binary: true });
        const back = E142Json.parseE142Json(binary).doc;
        ok(norm(back) === norm(doc), 'xml -> model -> binary -> model is unchanged at this size');

        /* Ascii is the bin type the binary form is WORST at - one token character
         * against 2.67 - so this is also the largest real instance of the
         * regression Task 17 measured, rather than a case chosen to flatter it. */
        const token = E142Json.e142DocumentToJson(doc);
        ok(binary.length > token.length,
            `and it is LARGER, as Ascii must be: ${Math.round(binary.length / 1024)} kB against `
            + `${Math.round(token.length / 1024)} kB`);
    });

    /* The XML writer follows the same rules as the JSON one, and the assertions
     * are the same three, because they are the same decisions. */
    attempt('the XML writer keeps the three-state distinctions', () => {
        const doc = parse(readFileSync(dir + 'v0125-all-header-facts.xml', 'utf8'));
        const xml = E142Xml.e142DocumentToXml(doc);
        ok(xml.includes('SubstrateSide="BottomSide"'),
            'SubstrateSide is written — its absence would ASSERT the top face');
        // v0125-transfer-chain, not the 'layoutless' one: THAT fixture has no
        // Layouts block but its specifier is 'WaferLayout/Devices' and dangles.
        // The empty specifier lives on a transfer chain's source substrates.
        const layoutless = parse(readFileSync(dir + 'v0125-transfer-chain.xml', 'utf8'));
        ok(E142Xml.e142DocumentToXml(layoutless).includes('LayoutSpecifier=""'),
            'an empty LayoutSpecifier is kept — "" is the layoutless form, not an absence');
        const zero = parse(readFileSync(dir + 'v0125-substrate-edge-values.xml', 'utf8'));
        ok(E142Xml.e142DocumentToXml(zero).includes('<GoodDevices>0</GoodDevices>'),
            'GoodDevices 0 is written — zero is a value, not an absence');
        // v0921 is the ONE fixture whose overlay carries MapName and no
        // MapVersion; asserting this on a fixture that has a version is
        // vacuous, which is how the mutation first survived.
        const noVersion = parse(readFileSync(dir + 'v0921-array-integer2-csdn.xml', 'utf8'));
        ok(!E142Xml.e142DocumentToXml(noVersion).includes('MapVersion=""'),
            'an empty MapVersion is omitted — absent and "" are the same OverlayKey');
    });

    /* Byte-stable, like its JSON counterpart: member order is the XSD's sequence
     * and every element is written by a literal, not by iterating the model. */
    attempt('the XML writer is byte-stable', () => {
        const doc = parse(readFileSync(dir + 'v0211-multi-overlay.xml', 'utf8'));
        eq(E142Xml.e142DocumentToXml(doc), E142Xml.e142DocumentToXml(doc),
            'serializing twice produces identical bytes');
    });
});

/* -------------------------------- summary -------------------------------- */
finish();
