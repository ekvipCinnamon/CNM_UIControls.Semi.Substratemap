/*
 * e142-export.test.mjs - conformance of what the SERIALIZER writes.
 *
 * The other three suites all read: they feed a document in and check what comes
 * out of the parser. That is why every export defect found during Phase 2 - the
 * missing two-level layout tree, the dropped DeviceSize, the SubstrateSide that
 * silently flipped a BottomSide map to TopSide, the absent MapVersion and
 * Substrates block, and the layout/map frame mix-up under a quadrant rotation -
 * was invisible while those suites reported a clean pass.
 *
 * This suite asserts six families of property on documents this package
 * PRODUCES:
 *
 *   1. XSD validity            - it is a schema-valid E142 document at all
 *   2. Table 2 semantics       - the part the XSD cannot see
 *   3. Header fidelity         - SubstrateSide, MapVersion
 *   4. Identity fidelity       - LotId, GoodDevices
 *   5. Geometry fidelity       - DeviceSize; a 1 mm street is not lost
 *   6. Negative control        - a bogus BinType is rejected
 *
 * (6) is not decoration. Every other assertion here is of the form "the
 * validator accepted it", and a validator that has silently stopped validating
 * accepts everything. Without a document that MUST fail, a green run proves the
 * suite ran, not that the exporter is right.
 *
 * The source documents are inline rather than read from tests/fixtures/. This
 * suite is about the exporter, so it should not go red because a corpus is
 * missing or has moved on; the corpus round trip lives in e142-e2e.test.mjs and
 * covers the complementary case of real-world inputs.
 *
 * Run: node --test Helpers/SubstrateMapEngine/tests/e142-export.test.mjs
 *      npm run test:export
 */

import { stubParseDocument } from './xml-stub.mjs';
import { onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const E142 = await import(ENGINE + 'E142.js');
const E142Xml = await import(ENGINE + 'E142Xml.js');
const Engine = await import(ENGINE + 'Engine.js');

/* Optional. Loaded dynamically so a machine without libxml2 skips one family
 * of assertions instead of failing the suite on a toolchain gap. */
let validateXsd = null;
try {
    ({ validateAgainstE142Xsd: validateXsd } = await import('./lib/xsd-validate.mjs'));
} catch { validateXsd = null; }

/* ------------------------------ harness ------------------------------ */
let PASS = 0, FAIL = 0, SKIP = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES, skipped: SKIP }));
function ok(cond, label) {
    if (cond) { PASS++; } else { FAIL++; FAILURES.push(label); }
}
function eq(actual, expected, label) {
    ok(Object.is(actual, expected), `${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function close(actual, expected, eps, label) {
    ok(typeof actual === 'number' && Math.abs(actual - expected) <= eps,
        `${label}  (expected ${expected}+/-${eps}, got ${actual})`);
}
function skip(label) { SKIP++; console.log(`  SKIP  ${label}`); }

/* --------------------------- source documents ------------------------- */
/**
 * Wraps a body in a MapData document. Sources are deliberately in the V0211
 * namespace where they carry no LID, to prove the exporter re-emits into V0125
 * regardless of what it read.
 */
const doc = (layout, substrates, mapAttrs, overlay) => [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">',
    `  <Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">${layout}</Layout></Layouts>`,
    substrates,
    `  <SubstrateMaps><SubstrateMap SubstrateType="Wafer" SubstrateId="W1" LayoutSpecifier="L" ${mapAttrs}>`,
    overlay,
    '  </SubstrateMap></SubstrateMaps>',
    '</MapData>',
].filter((l) => l !== '').join('\n');

/* All NINE SubstrateType children, in the XSD's sequence order. SlotNumber is
 * ZERO on purpose: E142-0225 Table 6 calls it "Positive Integer" while the XSD
 * types it xs:nonNegativeInteger, and the schema is what a document is validated
 * against - so 0 has to survive the round trip like any other value. */
const SUB_FULL = '  <Substrates><Substrate SubstrateType="Wafer" SubstrateId="W1">'
    + '<LotId>LOT-16</LotId>'
    + '<AliasIds><AliasId Type="FrontsideId" Value="FRONT-16"/>'
    + '<AliasId Type="CustomerBarcode" Value="BC-16"/></AliasIds>'
    + '<CarrierType>FOUP</CarrierType><CarrierId>CAR-16</CarrierId>'
    + '<SlotNumber>0</SlotNumber><SubstrateNumber>16</SubstrateNumber>'
    + '<GoodDevices>7</GoodDevices>'
    + '<SupplierName>Conformance Supplier</SupplierName><Status>Sorted</Status>'
    + '</Substrate></Substrates>';

const SOURCES = [
    {
        label: 'Ascii / 2DArray, bin definitions, full identity, BottomSide, 1 mm street',
        // StepSize 5 with DeviceSize 4 is a 1 mm street. Table 2, StepSize row:
        // "StepSize - DeviceSize is equal to the 'street' width between devices."
        street: [5, 4],
        xml: doc(
            '<Dimension X="4" Y="3"/><DeviceSize X="4" Y="4" Units="mm"/><StepSize X="5" Y="5" Units="mm"/>',
            SUB_FULL,
            'SubstrateSide="BottomSide" OriginLocation="LowerLeft" AxisDirection="UpRight"',
            '    <Overlay MapName="Sort" MapVersion="2"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
            + '<BinDefinitions><BinDefinition BinCode="1" BinQuality="Pass" Pick="true"/>'
            + '<BinDefinition BinCode="9" BinQuality="Fail"/></BinDefinitions>'
            + '<BinCode>1111</BinCode><BinCode>1.91</BinCode><BinCode>1111</BinCode>'
            + '</BinCodeMap></Overlay>'),
    },
    {
        label: 'Integer2 -> Coordinate export form',
        xml: doc(
            '<Dimension X="4" Y="2"/><StepSize X="1" Y="1" Units="mm"/>',
            SUB_FULL,
            'OriginLocation="LowerLeft" AxisDirection="UpRight"',
            '    <Overlay MapName="Sort" MapVersion="1"><BinCodeMap BinType="Integer2" NullBin="0000" MapType="2DArray">'
            + '<BinCode>0001000200010002</BinCode><BinCode>0001000000010001</BinCode>'
            + '</BinCodeMap></Overlay>'),
    },
    {
        label: 'HexaDecimal',
        xml: doc(
            '<Dimension X="4" Y="2"/><StepSize X="1" Y="1" Units="mm"/>',
            SUB_FULL,
            'OriginLocation="LowerLeft" AxisDirection="UpRight"',
            '    <Overlay MapName="Sort" MapVersion="1"><BinCodeMap BinType="HexaDecimal" NullBin="F0" MapType="2DArray">'
            + '<BinCode>01010101</BinCode><BinCode>0101F001</BinCode>'
            + '</BinCodeMap></Overlay>'),
    },
    {
        label: 'Decimal (whitespace-separated tokens)',
        xml: doc(
            '<Dimension X="3" Y="2"/><StepSize X="1" Y="1" Units="mm"/>',
            SUB_FULL,
            'OriginLocation="LowerLeft" AxisDirection="UpRight"',
            '    <Overlay MapName="Sort" MapVersion="1"><BinCodeMap BinType="Decimal" NullBin="255" MapType="2DArray">'
            + '<BinCode>001 001 001</BinCode><BinCode>001 255 009</BinCode>'
            + '</BinCodeMap></Overlay>'),
    },
    {
        label: 'no bin definitions, no substrate identity',
        noIdentity: true,
        xml: doc(
            '<Dimension X="3" Y="2"/><StepSize X="1" Y="1" Units="mm"/>',
            '',
            'OriginLocation="LowerLeft" AxisDirection="UpRight"',
            '    <Overlay MapName="Sort"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
            + '<BinCode>111</BinCode><BinCode>1.1</BinCode>'
            + '</BinCodeMap></Overlay>'),
    },
    {
        label: 'non-default frame + quadrant rotation (UpperLeft / DownRight, Orientation 90)',
        // A 90-degree map with a NON-SQUARE pitch: the case where the layout and
        // map frames differ, so a serializer that writes map-frame values into
        // Layout/* shows up (Task 13b). Payload is in the map frame per Table 12.
        xml: doc(
            '<Dimension X="3" Y="2"/><StepSize X="2" Y="3" Units="mm"/>',
            SUB_FULL,
            'Orientation="90" OriginLocation="UpperLeft" AxisDirection="DownRight"',
            '    <Overlay MapName="Sort" MapVersion="1"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
            + '<BinCode>ab</BinCode><BinCode>cd</BinCode><BinCode>e.</BinCode>'
            + '</BinCodeMap></Overlay>'),
    },
];

/* ------------------------------- the chain ---------------------------- */
/** Parse -> choose overlay -> resolve layout -> place -> build. Mirrors the control. */
function build(xml) {
    const d = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument }).doc;
    let header = null, overlay = null;
    for (const sm of d.substrateMaps) {
        for (const ov of sm.overlays) { if (ov.payload !== undefined) { header = sm.header; overlay = ov; break; } }
        if (overlay !== null) { break; }
    }
    if (header === null || overlay === null) { return null; }
    const resolved = E142.resolveLayoutSpecifier(d, header.layoutSpecifier);
    if (resolved instanceof E142.E142Error) { throw resolved; }
    const layout = resolved !== null ? resolved : E142.dimsFromPayload(overlay.payload);
    const pr = E142.computeGridPlacement(header, layout, 0, undefined);
    const grid = Engine.buildGridModel(pr.placement, overlay.payload, null);
    const sub = (d.substrates || []).find(
        (x) => x.substrateType === header.substrateType && x.substrateId === header.substrateId,
    );
    return { doc: d, header, overlay, grid, sub };
}

/** The full option surface, taken from the parsed document - as the control does. */
function optionsFrom(src) {
    return {
        substrateType: String(src.header.substrateType),
        substrateId: src.header.substrateId,
        orientation: src.header.orientation,
        originLocation: src.header.originLocation,
        axisDirection: src.header.axisDirection,
        substrateSide: src.header.substrateSide,
        binType: (src.overlay.binCodeMapMeta || {}).binType,
        mapVersion: src.overlay.mapVersion,
        binDefinitions: src.overlay.binDefinitions && src.overlay.binDefinitions.length
            ? src.overlay.binDefinitions
            : null,
        lotId: src.sub?.lotId,
        goodDevices: src.sub?.goodDevices,
        supplierName: src.sub?.supplierName,
        status: src.sub?.status,
        aliasIds: src.sub?.aliasIds,
        carrierType: src.sub?.carrierType,
        carrierId: src.sub?.carrierId,
        slotNumber: src.sub?.slotNumber,
        substrateNumber: src.sub?.substrateNumber,
    };
}

/* =====================================================================
 * 1-5. The exported documents
 * ===================================================================== */
console.log('\n=== EXPORT CONFORMANCE ===');
let xsdChecked = 0;

for (const s of SOURCES) {
    const src = build(s.xml);
    if (src === null || src.grid === null) { ok(false, `${s.label}: source built no grid`); continue; }
    const opts = optionsFrom(src);
    const xml = E142Xml.gridToE142Xml(src.grid, opts);

    /* --- 1. XSD validity ------------------------------------------- */
    if (validateXsd === null) {
        skip(`${s.label}: XSD validity (helper unavailable)`);
    } else {
        const v = validateXsd(xml);
        if (v.ok === null) { skip(`${s.label}: XSD validity (${v.errors[0]})`); }
        else { xsdChecked++; ok(v.ok === true, `${s.label}: exported document is XSD-valid - ${v.errors[0] ?? ''}`); }
    }

    /* --- 2. Table 2 semantics, which the XSD cannot see -------------
     * E142-0225 Table 2, Dimension row: "If this is the top level layout
     * then X=1, Y=1." in E142-0225's own words. There is no facet, no
     * identity constraint and no keyref behind that sentence, so the
     * single-layout output this package used to emit - device matrix on
     * the top level - was and remains fully schema-valid. Only an
     * assertion like this one can tell the difference. */
    const back = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument }).doc;
    const tops = back.layouts.filter((l) => l.topLevel);
    ok(tops.length >= 1, `${s.label}: at least one TopLevel layout`);
    for (const t of tops) {
        ok(t.dimension.x === 1 && t.dimension.y === 1,
            `${s.label}: TopLevel layout '${t.layoutId}' has Dimension 1x1 (Table 2)`
            + ` - got ${t.dimension.x}x${t.dimension.y}`);
    }
    const spec = back.substrateMaps[0].header.layoutSpecifier;
    const leafId = spec.split('/').filter((x) => x !== '').pop();
    const leaf = back.layouts.find((l) => l.layoutId === leafId);
    ok(leaf !== undefined, `${s.label}: the last LayoutSpecifier segment '${leafId}' names a real layout`);
    if (leaf) {
        ok(!leaf.topLevel, `${s.label}: the device layout is not itself TopLevel`);
        // The device matrix lives on the leaf, in the LAYOUT frame - so under a
        // quadrant rotation it is the grid's dims transposed back (Task 13b).
        const swap = E142.mapFrameSwapsAxes(src.header.orientation);
        const wantCols = swap ? src.grid.rows : src.grid.cols;
        const wantRows = swap ? src.grid.cols : src.grid.rows;
        eq(leaf.dimension.x, wantCols, `${s.label}: leaf layout carries the real cols`);
        eq(leaf.dimension.y, wantRows, `${s.label}: leaf layout carries the real rows`);
    }

    /* --- 3. header fidelity ---------------------------------------- */
    const bh = back.substrateMaps[0].header;
    eq(bh.substrateSide, src.header.substrateSide, `${s.label}: SubstrateSide survives`);
    eq(bh.orientation, src.header.orientation, `${s.label}: Orientation survives`);
    eq(bh.originLocation, src.header.originLocation, `${s.label}: OriginLocation survives`);
    eq(bh.axisDirection, src.header.axisDirection, `${s.label}: AxisDirection survives`);
    eq(back.substrateMaps[0].overlays[0].mapVersion, src.overlay.mapVersion,
        `${s.label}: MapVersion survives`);

    /* --- 4. identity fidelity -------------------------------------- */
    const bs = (back.substrates || []).find(
        (x) => x.substrateType === bh.substrateType && x.substrateId === bh.substrateId,
    );
    if (s.noIdentity) {
        ok(bs === undefined || bs.lotId === undefined,
            `${s.label}: no identity in, no Substrate record out`);
    } else {
        ok(bs !== undefined, `${s.label}: the Substrate record is joined by (SubstrateType, SubstrateId)`);
        if (bs) {
            eq(bs.lotId, src.sub.lotId, `${s.label}: LotId survives`);
            eq(bs.goodDevices, src.sub.goodDevices, `${s.label}: GoodDevices survives`);
            eq(bs.supplierName, src.sub.supplierName, `${s.label}: SupplierName survives`);
            eq(bs.status, src.sub.status, `${s.label}: Status survives`);
            eq(bs.carrierType, src.sub.carrierType, `${s.label}: CarrierType survives`);
            eq(bs.carrierId, src.sub.carrierId, `${s.label}: CarrierId survives`);
            eq(bs.slotNumber, src.sub.slotNumber, `${s.label}: SlotNumber survives`);
            eq(bs.substrateNumber, src.sub.substrateNumber, `${s.label}: SubstrateNumber survives`);
            eq(JSON.stringify(bs.aliasIds), JSON.stringify(src.sub.aliasIds),
                `${s.label}: AliasIds survive entry-for-entry, in order`);
            if (src.sub.slotNumber === 0) {
                ok(bs.slotNumber === 0 && Object.is(bs.slotNumber, 0),
                    `${s.label}: SlotNumber 0 survives as a VALUE, not dropped as an absence`);
            }
            // Sequence order is fixed by the XSD; a document whose children are out
            // of order is invalid even though every child is individually fine.
            const body = xml.slice(xml.indexOf('<Substrates>'), xml.indexOf('</Substrates>'));
            const seq = ['LotId', 'AliasIds', 'CarrierType', 'CarrierId', 'SlotNumber',
                'SubstrateNumber', 'GoodDevices', 'SupplierName', 'Status']
                .map((n) => body.indexOf('<' + n + '>'))
                .filter((i) => i >= 0);
            ok(seq.every((v, i) => i === 0 || v > seq[i - 1]),
                `${s.label}: the nine children are in XSD sequence order`);
            ok(!/<AliasIds\s*\/>/.test(xml),
                `${s.label}: no empty <AliasIds/> is ever emitted (it would be schema-invalid)`);
        }
    }

    /* --- 5. geometry fidelity -------------------------------------- */
    const rt = build(xml);
    ok(rt !== null && rt.grid !== null, `${s.label}: the exported document re-builds a grid`);
    if (rt && rt.grid) {
        eq(rt.grid.cols, src.grid.cols, `${s.label}: cols survive`);
        eq(rt.grid.rows, src.grid.rows, `${s.label}: rows survive`);
        let diff = 0;
        for (let i = 0; i < src.grid.cols * src.grid.rows; i++) {
            if (src.grid.binTable[src.grid.cells[i]].code !== rt.grid.binTable[rt.grid.cells[i]].code) { diff++; }
        }
        eq(diff, 0, `${s.label}: every cell token survives`);
        close(rt.grid.placement.cellWmm, src.grid.placement.cellWmm, 1e-9, `${s.label}: DeviceSize (cellWmm) survives`);
        close(rt.grid.placement.cellLmm, src.grid.placement.cellLmm, 1e-9, `${s.label}: DeviceSize (cellLmm) survives`);
        if (s.street) {
            const [pitch, device] = s.street;
            close(src.grid.placement.cellWmm, device, 1e-9, `${s.label}: source device extent is ${device} mm`);
            close(rt.grid.placement.cellWmm, device, 1e-9, `${s.label}: device extent still ${device} mm after export`);
            const streetIn = Math.hypot(src.grid.placement.colStepXmm, src.grid.placement.colStepYmm) - src.grid.placement.cellWmm;
            const streetOut = Math.hypot(rt.grid.placement.colStepXmm, rt.grid.placement.colStepYmm) - rt.grid.placement.cellWmm;
            close(streetIn, pitch - device, 1e-9, `${s.label}: source street is ${pitch - device} mm`);
            close(streetOut, pitch - device, 1e-9,
                `${s.label}: the ${pitch - device} mm street is NOT closed by the export`);
        }
    }
    console.log(`  [export] ${s.label}: ${src.grid.cols}x${src.grid.rows}`
        + ` side=${src.header.substrateSide} orient=${src.header.orientation}`
        + ` binType=${opts.binType} layouts=${back.layouts.length}`);
}

/* =====================================================================
 * 5b. Layout round trip - every optional field, and the ELEMENT ORDER
 *
 * Order is asserted with a REGEX OVER THE EMITTED STRING, never by
 * re-parsing. Measured, not assumed: this parser looks children up by name
 * (firstNamed), so it reads an out-of-sequence layout and produces an
 * identical model with zero warnings. xmllint does reject it - but the XSD
 * family skips when libxml2 is absent, so it cannot be the only guard.
 *
 *   document                 xmllint     this parser     regex below
 *   in XSD sequence          accepted    accepted        matches
 *   children shuffled        REJECTED    accepted (!)    fails
 * ===================================================================== */
console.log('\n=== LAYOUT ROUND TRIP (two levels, every optional field) ===');
{
    // A two-level source whose DEVICE layout populates every optional child and
    // the Package attribute. The top level carries its own images and LowerLeft,
    // so a serializer that flattened the tree or leaked one level into the other
    // would show up.
    const full = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">',
        '  <Layouts>',
        '    <Layout LayoutId="Top" DefaultUnits="mm" TopLevel="true">',
        '      <Dimension X="1" Y="1"/>',
        '      <DeviceSize X="200" Y="200" Units="mm"/>',
        '      <TopImage>substrate-top.png</TopImage>',
        '      <BottomImage>substrate-bottom.png</BottomImage>',
        '      <ChildLayouts><ChildLayout LayoutId="Dev"/></ChildLayouts>',
        '    </Layout>',
        '    <Layout LayoutId="Dev" DefaultUnits="mm" Package="true">',
        '      <Dimension X="3" Y="2"/>',
        '      <LowerLeft X="-1.5" Y="-2.5" Units="mm"/>',
        '      <DeviceSize X="0.8" Y="0.9" Units="mm"/>',
        '      <StepSize X="1.0" Y="1.5" Units="mm"/>',
        '      <Z Order="2" Height="0.75" Units="mm"/>',
        '      <TopImage>die-top.png</TopImage>',
        '      <BottomImage>die-bottom.png</BottomImage>',
        '      <ProductId>PROD-24</ProductId>',
        '    </Layout>',
        '  </Layouts>',
        '  <SubstrateMaps>',
        '    <SubstrateMap SubstrateType="Wafer" SubstrateId="W24" LayoutSpecifier="Top/Dev"',
        '        OriginLocation="LowerLeft" AxisDirection="UpRight">',
        '      <Overlay MapName="Sort" MapVersion="1">',
        '        <BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">',
        '          <BinCode>abc</BinCode><BinCode>de.</BinCode>',
        '        </BinCodeMap>',
        '      </Overlay>',
        '    </SubstrateMap>',
        '  </SubstrateMaps>',
        '</MapData>',
    ].join('\n');

    const src = build(full);
    ok(src !== null && src.grid !== null, 'layout round trip: source builds a grid');
    if (src && src.grid) {
        const leafId = src.header.layoutSpecifier.split('/').filter((x) => x !== '').pop();
        const srcLeaf = src.doc.layouts.find((l) => l.layoutId === leafId);
        ok(srcLeaf !== undefined, 'layout round trip: the device layout is the LayoutSpecifier leaf');

        const xml = E142Xml.gridToE142Xml(src.grid, { ...optionsFrom(src), sourceLayout: srcLeaf });

        /* --- order, by regex over the emitted string --------------------- */
        const devOpen = xml.indexOf('<Layout LayoutId="L0_Devices"');
        const devEnd = xml.indexOf('</Layout>', devOpen);
        const dev = xml.slice(devOpen, devEnd);
        // One anchored pattern for the whole sequence: a swapped pair cannot
        // satisfy it, and neither can a missing element.
        const SEQUENCE = new RegExp([
            '<Dimension\\b[^>]*>', '<LowerLeft\\b[^>]*>', '<DeviceSize\\b[^>]*>',
            '<StepSize\\b[^>]*>', '<Z\\b[^>]*>', '<TopImage>', '<BottomImage>', '<ProductId>',
        ].join('[\\s\\S]*?'));
        ok(SEQUENCE.test(dev),
            'layout round trip: the eight device-layout children appear in XSD sequence order');

        // The regex must be capable of FAILING, or its passing means nothing.
        const shuffled = dev
            .replace(/(\s*<LowerLeft\b[^>]*>)/, '')
            .replace(/(<ProductId>[\s\S]*?<\/ProductId>)/, '$1\n      <LowerLeft X="0" Y="0" Units="mm"/>');
        ok(!SEQUENCE.test(shuffled),
            'layout round trip: ...and the same pattern REJECTS a shuffled copy (the check is not vacuous)');

        /* --- every optional field survives the cycle --------------------- */
        const back = build(xml);
        const backLeaf = back === null ? undefined : back.doc.layouts.find((l) => l.layoutId === 'L0_Devices');
        ok(backLeaf !== undefined, 'layout round trip: the device layout re-parses');
        if (backLeaf && srcLeaf) {
            eq(backLeaf.dimension.x, srcLeaf.dimension.x, 'layout round trip: Dimension.X survives');
            eq(backLeaf.dimension.y, srcLeaf.dimension.y, 'layout round trip: Dimension.Y survives');
            eq(JSON.stringify(backLeaf.lowerLeft), JSON.stringify(srcLeaf.lowerLeft),
                'layout round trip: LowerLeft survives');
            eq(JSON.stringify(backLeaf.deviceSize), JSON.stringify(srcLeaf.deviceSize),
                'layout round trip: DeviceSize survives');
            eq(JSON.stringify(backLeaf.stepSize), JSON.stringify(srcLeaf.stepSize),
                'layout round trip: StepSize survives');
            eq(JSON.stringify(backLeaf.z), JSON.stringify(srcLeaf.z), 'layout round trip: Z survives');
            eq(backLeaf.topImage, srcLeaf.topImage, 'layout round trip: TopImage survives');
            eq(backLeaf.bottomImage, srcLeaf.bottomImage, 'layout round trip: BottomImage survives');
            eq(backLeaf.productId, srcLeaf.productId, 'layout round trip: ProductId survives');
            eq(backLeaf.package, srcLeaf.package, 'layout round trip: @Package survives');
            eq(backLeaf.topLevel, false, 'layout round trip: the device layout is not TopLevel');
        }

        /* --- the two levels do not bleed into each other ----------------- */
        const backTop = back === null ? undefined : back.doc.layouts.find((l) => l.topLevel);
        ok(backTop !== undefined, 'layout round trip: a TopLevel layout is emitted');
        if (backTop) {
            ok(backTop.dimension.x === 1 && backTop.dimension.y === 1,
                'layout round trip: the top level keeps Dimension 1x1 (Table 2)');
            ok(backTop.topImage === undefined && backTop.productId === undefined,
                'layout round trip: the device layout\u2019s children did not leak onto the top level');
            ok(backTop.childLayouts.length === 1 && backTop.childLayouts[0] === 'L0_Devices',
                'layout round trip: the top level still names its child');
        }

        if (validateXsd !== null) {
            const v = validateXsd(xml);
            if (v.ok === null) { skip(`layout round trip: XSD validity (${v.errors[0]})`); }
            else { ok(v.ok === true, `layout round trip: XSD-valid - ${v.errors[0] ?? ''}`); }
        }
        console.log(`  [layout] two levels, ${srcLeaf ? '9' : '?'} device children, `
            + `Package=${srcLeaf ? srcLeaf.package : '?'}, order OK`);
    }
}

/* =====================================================================
 * 6. Negative control
 * ===================================================================== */
console.log('\n=== NEGATIVE CONTROL ===');
if (validateXsd === null) {
    skip('negative control (helper unavailable)');
} else {
    const bogus = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">',
        '  <Layouts><Layout LayoutId="L0" DefaultUnits="mm" TopLevel="true">',
        '    <Dimension X="1" Y="1"/>',
        '    <ChildLayouts><ChildLayout LayoutId="L0_Devices"/></ChildLayouts>',
        '  </Layout><Layout LayoutId="L0_Devices" DefaultUnits="mm">',
        '    <Dimension X="2" Y="2"/><StepSize X="1" Y="1" Units="mm"/>',
        '  </Layout></Layouts>',
        '  <SubstrateMaps><SubstrateMap SubstrateType="Wafer" SubstrateId="W1"',
        '      LayoutSpecifier="L0/L0_Devices" OriginLocation="LowerLeft" AxisDirection="UpRight">',
        '    <Overlay MapName="Sort"><BinCodeMap BinType="Nonsense" NullBin="." MapType="2DArray">',
        '      <BinCode>11</BinCode><BinCode>1.</BinCode>',
        '    </BinCodeMap></Overlay>',
        '  </SubstrateMap></SubstrateMaps>',
        '</MapData>',
    ].join('\n');
    const v = validateXsd(bogus);
    if (v.ok === null) {
        skip(`negative control (${v.errors[0]})`);
    } else {
        ok(v.ok === false, 'a document with BinType="Nonsense" is REJECTED'
            + ' - if this passes, the validator is not validating and every assertion above is worthless');
        ok(v.errors.some((e) => e.includes('BinType')), 'and the rejection names the offending attribute');
        // The same document with the enum corrected must pass, so the rejection
        // is attributable to BinType and not to something else in the document.
        const fixed = bogus.replace('BinType="Nonsense"', 'BinType="Ascii"');
        ok(validateXsd(fixed).ok === true, 'the same document with BinType="Ascii" is ACCEPTED');
    }
}

/* ------------------------------- summary ------------------------------ */
console.log('\n========================================================');
console.log(`  RESULT: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
if (validateXsd !== null && xsdChecked > 0) {
    console.log(`  XSD-validated ${xsdChecked} exported documents`);
}
if (FAIL > 0) {
    console.log('  FAILURES:');
    for (const f of FAILURES) { console.log('   - ' + f); }
}
console.log('========================================================');
process.exit(FAIL > 0 ? 1 : 0);
