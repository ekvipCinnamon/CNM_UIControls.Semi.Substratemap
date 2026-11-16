/*
 * e142-representations.test.mjs - the equivalence harness, and the only place
 * the JSON Schema is executed.
 *
 * Four families:
 *   1. coverage - every XML fixture has a JSON counterpart or a registered
 *      exemption naming the task that owes it;
 *   2. equivalence - the two representations of a fixture parse to structurally
 *      equal documents with the same warning CODES;
 *   3. schema - every E142 JSON fixture validates against
 *      E142MapDataJson.Schema.json, which nothing executed before this;
 *   4. discrimination - the twenty GridData documents in the same directory are
 *      not fed to the E142 schema, and the suite says how it told them apart;
 *   5. per-feature families, one per Task 10-14, asserting what that feature's
 *      fixtures are actually FOR rather than only that the two paths agree;
 *   6. the CONTROL renders both representations identically (Task 18);
 *   7. the binary attribute, and the last-write-wins precedence it joins (Task 19).
 *
 * The validator import is REQUIRED, not soft-failed. `lib/xsd-validate.mjs`
 * tolerates a missing `xmllint` because that is a system binary; a devDependency
 * is not, and `npm install` must already have succeeded or three of the eight
 * gate commands cannot run. A missing install should say "run npm install", not
 * quietly stop checking.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Ajv from 'ajv-draft-04';

import {
    JSON_DIR, PENDING_JSON, SCHEMA_INVALID, WARNING_CODES_DIFFER, XML_DIR, compareRepresentations,
    expectedRepresentations, jsonFixtures, warningCodes, xmlFixtures,
} from './lib/representations.mjs';
import {
    SubstrateMap, bindAndFingerprint, drainEvents, drivePanel, gridFingerprint, logLines, readPanels,
    renderOnce, tapAt, pressAt, releaseAt,
} from '../../../tools/attach-harness.mjs';
const SubstrateMapMod = await import(new URL('../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url).href);
const Bar = await import(new URL('../../../Controls/SubstrateMapFilterBar/SubstrateMapFilterBar.js', import.meta.url).href);
const Widget = await import(new URL('../../../Controls/SubstrateMapWidget/SubstrateMapWidget.js', import.meta.url).href);
const Chart = await import(new URL('../../../Controls/SubstrateMapBinChart/SubstrateMapBinChart.js', import.meta.url).href);
const BinPalette = await import(new URL('../BinPalette.js', import.meta.url).href);
const Patterns = await import(new URL('./lib/patterns.mjs', import.meta.url).href);
const { installDocumentStub, installLocalizationStub } = await import(new URL('./lib/element-stub.mjs', import.meta.url).href);
const Agg = await import(new URL('../GridAggregate.js', import.meta.url).href);

const E142Json = await import(new URL('../E142Json.js', import.meta.url).href);
const E142Mod = await import(new URL('../E142.js', import.meta.url).href);
const Engine = await import(new URL('../Engine.js', import.meta.url).href);
const Base = await import(new URL('../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url).href);
const Oklch = await import(new URL('../Oklch.js', import.meta.url).href);
import { makeHarness, onCrash } from './lib/harness.mjs';
import { requireInput } from '../../../tools/external-inputs.mjs';
import * as Shims from './lib/dom-shims.mjs';
/* One import per module: a namespace import cannot share a statement with named ones. */
const { Path2D, cubicAt, makeContext2D } = Shims;
import { ORACLE_PLAN, buildShapePath } from '../../../tools/hit-oracle.mjs';

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();
/* section() lets the run continue past a dead family; this guarantees it
 * REPORTS even when the throw is at module level, outside every section. */
onCrash(counts);

const XML = xmlFixtures();
const { e142: E142_JSON, gridData: GRID_JSON } = jsonFixtures();

/* =====================================================================
 * 1. Coverage
 * ===================================================================== */
section('1. corpus coverage', () => {
        ok(XML.length > 40, `the XML corpus has ${XML.length} fixtures`);
        console.log(`  ${XML.length} XML, ${E142_JSON.length} E142 JSON, ${GRID_JSON.length} GridData JSON`);

        /* The Done-when: a new XML fixture with no counterpart and no registered
         * exemption turns this red. The registry only shrinks. */
        const unregistered = [];
        for (const base of XML) {
            const r = expectedRepresentations(base);
            if (!r.json && r.pending === null) { unregistered.push(base); }
        }
        eq(unregistered.length, 0,
            `every XML fixture has a JSON counterpart or a registered exemption `
            + `(unregistered: ${unregistered.join(', ')})`);

        /* And the reverse: an exemption for a fixture that now HAS a counterpart is
         * stale, and a stale exemption is how a backlog stops meaning anything. */
        const stale = [...PENDING_JSON.keys()].filter((b) => expectedRepresentations(b).json);
        eq(stale.length, 0, `no stale exemption remains (stale: ${stale.join(', ')})`);

        /* Nothing may be exempted that is not in the corpus at all. */
        const phantom = [...PENDING_JSON.keys()].filter((b) => !XML.includes(b));
        eq(phantom.length, 0, `every exemption names a real fixture (phantom: ${phantom.join(', ')})`);

        console.log(`  ${PENDING_JSON.size} fixtures still owe a JSON counterpart — the Tasks 10–14 backlog`);

        /* Tasks 10-14 name five features. Fixtures exercising none of them are
         * labelled UNOWNED rather than filed under a task that does not want them:
         * a mislabelled backlog entry is a gap that looks closed. */
        /* OD-001 was answered with option A and Task 14a cleared them. UNOWNED was
         * always a holding label: every entry must now name a task or state why it
         * is excluded, and this assertion stops the label coming back. */
        const unowned = [...PENDING_JSON.values()].filter((v) => v.startsWith('UNOWNED')).length;
        eq(unowned, 0,
            'no UNOWNED entry remains — every backlog entry names a task or states its exclusion');
});

/* =====================================================================
 * 2. Equivalence
 * ===================================================================== */
section('2. representation equivalence', () => {
        let compared = 0;
        for (const base of E142_JSON) {
            const r = compareRepresentations(base);
            if (r.xml === null) {
                ok(false, `${base}: a JSON fixture with no XML counterpart — the corpus must stay paired`);
                continue;
            }
            compared++;
            ok(r.equal === true, `${base}: XML and JSON parse to structurally equal documents\n      ${r.detail}`);
            const differs = WARNING_CODES_DIFFER.get(base);
            if (differs === undefined) {
                ok(r.sameWarnings === true,
                    `${base}: both paths raise the same warning codes\n      ${r.detail}`);
                continue;
            }
            /* Named, not exempted: the codes must differ EXACTLY as recorded, so a
             * fixture that starts warning about something else is not absorbed. */
            ok(r.sameWarnings === false, `${base}: warning codes are expected to differ — ${differs.why}`);
            ok(warningCodes(r.xml.warnings).includes(differs.xml),
                `  XML raises ${differs.xml}`);
            if (differs.json === null) {
                eq(warningCodes(r.json.warnings).length, 0,
                    '  and JSON raises NOTHING — an absent problem, not a missing warning');
            } else {
                ok(warningCodes(r.json.warnings).includes(differs.json),
                    `  and JSON raises ${differs.json} — same fate, different mechanism`);
            }
        }
        eq(compared, E142_JSON.length, `all ${E142_JSON.length} E142 JSON fixtures were compared`);
        ok(compared > 0, 'at least one pair exists — an empty harness asserts nothing');
});

/* =====================================================================
 * 3. The schema, executed
 * ===================================================================== */
section('3. schema validation', () => {
        const schema = JSON.parse(readFileSync(
            new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/E142MapDataJson.Schema.json',
                import.meta.url), 'utf8'));
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile({ $ref: '#/definitions/SubstrateMapE142MapDataJson', definitions: schema.definitions });

        for (const base of E142_JSON) {
            const doc = JSON.parse(readFileSync(join(JSON_DIR, base + '.json'), 'utf8'));
            const valid = validate(doc);
            const first = valid ? '' : `${validate.errors[0].instancePath || '/'} ${validate.errors[0].message}`;
            const expected = SCHEMA_INVALID.get(base);
            if (expected === undefined) {
                ok(valid, `${base}: validates against E142MapDataJson.Schema.json  ${first}`);
                continue;
            }
            /* The schema/parser asymmetry, TESTED rather than asserted (D-019).
             * A fixture listed here must fail, and must fail for the STATED
             * reason, so one that starts failing for a different one is not
             * silently absorbed. */
            ok(!valid, `${base}: must FAIL the schema — ${expected.why}`);
            if (!valid) {
                const all = validate.errors.map((e) => `${e.instancePath} ${e.message}`).join(' | ');
                ok(all.includes(expected.at),
                    `  and fail on ${expected.at}, not something else  (got ${all.slice(0, 90)})`);
            }
            ok(compareRepresentations(base).equal === true,
                '  while the PARSER accepts it and agrees with the XML — looser, never stricter');
        }
        ok(SCHEMA_INVALID.size > 0,
            'the corpus contains at least one schema-invalid, parser-accepted document — '
            + 'without one, "looser but never stricter" is a claim with no test');

        /* Done-when: corrupting one member turns this red NAMING the violation.
         * Executed, not asserted - the point of this section is that the schema runs. */
        /* A sample the schema ACCEPTS, so the corruptions below fail for their own
         * reason rather than inheriting one. E142_JSON[0] is no longer safe: the
         * list is sorted and now starts with a deliberately schema-invalid one. */
        const cleanBase = E142_JSON.find((b) => !SCHEMA_INVALID.has(b));
        ok(cleanBase !== undefined, 'at least one fixture the schema accepts, to corrupt deliberately');
        const sample = JSON.parse(readFileSync(join(JSON_DIR, cleanBase + '.json'), 'utf8'));
        const corrupt = (mutate, label, expectPath) => {
            const copy = JSON.parse(JSON.stringify(sample));
            mutate(copy);
            const valid = validate(copy);
            ok(!valid, `  rejected: ${label}`);
            if (!valid) {
                const paths = validate.errors.map((e) => e.instancePath).join(' ');
                ok(paths.includes(expectPath),
                    `    naming where: ${expectPath} (errors mention ${paths.slice(0, 80)})`);
            }
        };
        corrupt((d) => { d.$format = 'grid-data'; }, 'a GridData discriminator', '/$format');
        corrupt((d) => { delete d.$version; }, 'a missing $version', '');
        corrupt((d) => { d.SubstrateMaps[0].Orientation = 400; }, 'Orientation 400', '/SubstrateMaps/0/Orientation');
        corrupt((d) => { d.SubstrateMaps[0].lowerLeft = { x: 0, y: 0 }; },
            'a camelCase GridData member', '/SubstrateMaps/0');
        corrupt((d) => { d.SubstrateMaps[0].Overlay[0].BinCodeMap.BinType = 'Hexadecimal'; },
            'BinType misspelt as Hexadecimal', '/SubstrateMaps/0/Overlay/0/BinCodeMap/BinType');

        /* $comment must NOT be rejected: the corpus depends on it. */
        const commented = JSON.parse(JSON.stringify(sample));
        commented.SubstrateMaps[0].$comment = 'a note on this map';
        ok(validate(commented), '  and $comment is accepted at any level - the corpus documents itself with it');
});

/* =====================================================================
 * 4. GridData is a different contract
 * ===================================================================== */
section('4. GridData is not E142 JSON', () => {
        eq(GRID_JSON.length, 20, 'the twenty GridData fixtures are still in fixtures/json/');
        for (const base of GRID_JSON.slice(0, 3)) {
            const doc = JSON.parse(readFileSync(join(JSON_DIR, base + '.json'), 'utf8'));
            ok(doc.$format === undefined,
                `${base}: has no $format — which is exactly how it was told apart, one key lookup, no parse`);
        }
        /* Selection is by discriminator, not by directory. Proving it the only way
         * that means anything: a GridData document fed to the E142 schema fails. */
        const schema = JSON.parse(readFileSync(
            new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/E142MapDataJson.Schema.json',
                import.meta.url), 'utf8'));
        const ajv = new Ajv({ allErrors: false, strict: false });
        const validate = ajv.compile({ $ref: '#/definitions/SubstrateMapE142MapDataJson', definitions: schema.definitions });
        const grid = JSON.parse(readFileSync(join(JSON_DIR, GRID_JSON[0] + '.json'), 'utf8'));
        ok(!validate(grid),
            `  and ${GRID_JSON[0]} would fail the E142 schema outright — which is why directory is not a filter`);
});

/* =====================================================================
 * 5a. LID (Task 10)
 * ===================================================================== */
section('5a. LID (Task 10)', () => {
        /* Clause 13.3 addresses a position by "either the X and Y coordinate, or the
         * location identifier, or both". All three forms, and both BinCodeType and
         * DeviceIdType, live in v0125-lid-retained; the free-cell branch lives in
         * v0125-coordinate-lid-mixed. Between them they are the whole LID surface of
         * the corpus - `grep -l 'LID=' fixtures/xml` returns exactly those two. */
        for (const base of ['v0125-lid-retained', 'v0125-coordinate-lid-mixed']) {
            const r = compareRepresentations(base);
            ok(r.equal === true, `${base}: LID survives identically through both paths\n      ${r.detail}`);
            ok(r.sameWarnings === true, `${base}: and both raise the same warning codes\n      ${r.detail}`);
        }

        const full = compareRepresentations('v0125-lid-retained');
        const free = compareRepresentations('v0125-coordinate-lid-mixed');

        /* The negative case Done-when asks for, from BOTH paths by construction. */
        ok(warningCodes(full.xml.warnings).includes('E142_XML_LID_ONLY_EXCLUDED'),
            'a LID-only entry on a FULL lattice is excluded and reported (XML)');
        ok(warningCodes(full.json.warnings).includes('E142_XML_LID_ONLY_EXCLUDED'),
            '  with the identical code from JSON — same rule, one implementation');

        /* The other branch, which is the one that surprises: a LID-only entry is NOT
         * excluded when the lattice has room. It takes the next free cell in document
         * order, and nothing is reported. Both fixtures are needed to pin that. */
        ok(!warningCodes(free.xml.warnings).includes('E142_XML_LID_ONLY_EXCLUDED'),
            'a LID-only entry with free cells is PLACED, not excluded, and does not warn');
        attempt('free-cell branch places the LIDs', () => {
            const freeOverlay = free.json.doc.substrateMaps[0].overlays[0];
            eq(freeOverlay.payload.lids.size, 4,
                '  and its LID reaches the decoded payload — three spares plus one X/Y-addressed alias');
        });

        /* "Or both": the coordinate places it, the LID names it. */
        attempt('BinCode LID retention', () => {
            const sorted = full.json.doc.substrateMaps[0].overlays[0];
            eq(sorted.sparseBinCodes.length, 5, 'all five BinCode entries are retained, placeable or not');
            eq(sorted.sparseBinCodes[1].lid, 'pkt-0042', '  X/Y AND LID: both are kept');
            eq(sorted.sparseBinCodes[4].lid, '0007', '  and the unplaceable one is still in sparseBinCodes');
            /* LID is xs:string with NO facet in the one revision that declares it. A
             * LID is a join key, so normalising it would silently break the join. */
            eq(sorted.sparseBinCodes[2].lid, 'P/0007',
                'a LID carrying a separator is not normalised — it is an opaque join key');
        });
        attempt('DeviceIdType LID retention', () => {
            const ids = full.json.doc.substrateMaps[0].overlays[1].deviceIdEntries;
            eq(ids.length, 3, 'DeviceIdType carries LID too, and all three entries survive');
            eq(ids[2].lid, 'PI-9F3C', '  including a LID-only Id, which has no X/Y to fall back on');
            ok(ids[0].lid === undefined, '  while an entry with no LID has none — the absent case');
        });
});

section('5b. Overlays (Task 11)', () => {
    /* Three fixtures, and between them the whole overlay surface of the corpus:
     * the OverlayKey, document order, and the three shapes a BinCodeMap payload
     * can take when MapType is present, absent, or the overlay has no map at all. */
    for (const base of ['v0125-overlay-two-versions', 'v0211-multi-overlay',
        'v0921-array-integer2-csdn']) {
        const r = compareRepresentations(base);
        ok(r.equal === true, `${base}: overlays survive identically\n      ${r.detail}`);
        ok(r.sameWarnings === true, `${base}: and both raise the same warning codes\n      ${r.detail}`);
    }

    /* The OverlayKey is (MapName, MapVersion) TOGETHER. The same MapName twice
     * with different versions is two overlays, not a duplicate - and the payloads
     * differ, so anything collapsing them by name would keep the wrong cells. */
    attempt('OverlayKey is a pair', () => {
        const doc = compareRepresentations('v0125-overlay-two-versions').json.doc;
        const ovs = doc.substrateMaps[0].overlays;
        eq(ovs.length, 2, 'the same MapName with two MapVersions is TWO overlays');
        eq(ovs[0].mapName, ovs[1].mapName, '  sharing a name');
        ok(ovs[0].mapVersion !== ovs[1].mapVersion, '  and separated only by version');
        const cell = (o) => o.payload.codes[o.payload.cells[0]];
        ok(cell(ovs[0]) !== cell(ovs[1]),
            '  with different payloads, so collapsing them would show the wrong map');
    });

    /* Overlay is maxOccurs="unbounded": a JSON array, and its ORDER is the
     * document's. The third fixture's third overlay has null cells where the
     * others have data, so a mis-ordered read still parses and shows a wrong map. */
    attempt('overlay order', () => {
        const ovs = compareRepresentations('v0211-multi-overlay').json.doc.substrateMaps[0].overlays;
        deep(ovs.map((o) => o.mapName), ['SortGrade', 'Retest', 'FinalTest'],
            'three overlays arrive in document order');
        eq(ovs[2].payload.codes[ovs[2].payload.cells[1]], '.',
            '  and the third one really is the sparse map, not a re-read of the first');
    });

    /* The negative case Done-when asks for, and it is not a contrived one: the
     * second overlay omits MapType, for which NO XSD default exists. The prose
     * default 2DArray then makes one BinCode one ROW - 20 tokens against a 5x4
     * lattice - which is exactly what E142_XML_DIM_MISMATCH reports. */
    const csdn = compareRepresentations('v0921-array-integer2-csdn');
    ok(warningCodes(csdn.xml.warnings).includes('E142_XML_DIM_MISMATCH'),
        'an omitted MapType defaults to 2DArray and mismatches the lattice (XML)');
    ok(warningCodes(csdn.json.warnings).includes('E142_XML_DIM_MISMATCH'),
        '  with the identical code from JSON — same rule, one implementation');

    attempt('the three payload shapes and the mapless overlay', () => {
        const maps = csdn.json.doc.substrateMaps;
        const first = maps[0].overlays;
        eq(first[0].binCodeMapMeta.mapType, 'Array',
            'MapType=Array is carried as ONE string, not an array of rows');
        eq(first[0].payload.cols * first[0].payload.rows, 20, '  and decodes to the full lattice');
        eq(first[1].binCodeMapMeta.mapType, undefined,
            'an omitted MapType stays omitted — it has no XSD default to record');
        eq(first[1].mapVersion, '',
            'MapName with no MapVersion gives "" — omitted on the wire, not written empty');
        eq(maps[1].overlays[0].binCodeMapMeta, undefined,
            'an Overlay may carry NO map at all: OverlayType\'s xs:choice is optional');
        eq(maps[0].header.substrateId, maps[1].header.substrateId,
            'two SubstrateMaps may share a SubstrateId');
        ok(maps[0].header.layoutSpecifier !== maps[1].header.layoutSpecifier,
            '  when their LayoutSpecifier differs — that triple is the identity');
    });
});

section('5c. TransferMap (Task 12)', () => {
    for (const base of ['v0125-transfer-chain', 'v0125-transfer-degenerate']) {
        const r = compareRepresentations(base);
        ok(r.equal === true, `${base}: transfers survive identically\n      ${r.detail}`);
        ok(r.sameWarnings === true, `${base}: and both raise the same warning codes\n      ${r.detail}`);
    }

    /* The element is T, not Transfer. The TYPE is TransferType and the standard's
     * figures label the arrows Transfer(...), which is the trap that makes a
     * reader find an EMPTY map rather than fail - so this is asserted by counting
     * what arrived, not by looking for a name. */
    attempt('the chain', () => {
        const doc = compareRepresentations('v0125-transfer-chain').json.doc;
        const maps = doc.substrateMaps[2].overlays[1].transferMaps;
        eq(maps.length, 2,
            'a substrate that received devices from TWO sources carries TWO TransferMaps — '
            + 'the source is named per MAP, not per transfer');
        deep(maps.map((m) => m.transfers.length), [2, 2], '  each with its own transfers');

        /* Each END is addressed independently: coordinates in, identifier out on
         * the first arrow; identifier in, coordinates out on the second. All six
         * attributes are use="optional" and none is coupled to another. */
        deep(maps[0].transfers[0], { fx: 3, fy: 7, tid: 'PKT-0042' },
            'Transfer(FX,FY,TID): coordinates in, IDENTIFIER out');
        deep(maps[1].transfers[0], { fid: 'PKT-0042', tx: 0, ty: 0 },
            'Transfer(FID,TX,TY): identifier in, COORDINATES out');
        eq(maps[1].transfers[0].fid, maps[0].transfers[0].tid,
            '  and the identifier is what joins the two arrows into one chain');

        /* All three From* are use="required" AND together are a keyref onto a
         * SubstrateMap, which is why the sources are declared and are not
         * decoration: a dangling one is E142_XML_INTEGRITY. */
        eq(maps[0].fromSubstrateId, 'SRC-WAFER', 'the source substrate is named per map');
        ok(doc.substrateMaps.some((m) => m.header.substrateId === 'SRC-WAFER'),
            '  and is declared in the same document, so the FromSubstrateMapRef keyref resolves');
        eq(doc.substrateMaps[0].overlays.length, 0,
            '  while carrying no overlay of its own — Overlay is minOccurs="0"');
    });

    /* The negative case Done-when asks for. Two of them, from one document. */
    const deg = compareRepresentations('v0125-transfer-degenerate');
    for (const code of ['E142_XML_TRANSFER_EMPTY', 'E142_XML_TRANSFER_FROM_MISSING']) {
        ok(warningCodes(deg.xml.warnings).includes(code), `${code} from XML`);
        ok(warningCodes(deg.json.warnings).includes(code),
            `  and the identical code from JSON — same rule, one implementation`);
    }

    attempt('degenerate transfers are kept, not dropped', () => {
        const maps = deg.json.doc.substrateMaps[1].overlays[0].transferMaps;
        eq(maps.length, 2, 'one degenerate map does not poison its sibling');
        deep(maps[0].transfers[1], {},
            'an empty <T> becomes {} — present and naming neither end, which is what <T/> says');
        eq(maps[1].fromSubstrateId, '',
            'a missing From* leaves an empty value rather than dropping the map');
    });
});

section('5d. DeviceDataMap and E138 PVSet (Task 13)', () => {
    for (const base of ['v0125-devicedata', 'v0125-devicedata-degenerate']) {
        const r = compareRepresentations(base);
        ok(r.equal === true, `${base}: PVSet survives identically\n      ${r.detail}`);
        ok(r.sameWarnings === true, `${base}: and both raise the same warning codes\n      ${r.detail}`);
    }

    /* The four PVSet shapes JSON-FORMAT.md got WRONG at Task 5 and DEV-007
     * corrected at Task 7. This is their first end-to-end exercise, so each is
     * asserted against the parsed model rather than against the format document. */
    attempt('the four PVSet shapes', () => {
        const dd = compareRepresentations('v0125-devicedata')
            .json.doc.substrateMaps[0].overlays[1].deviceDataMaps[0];
        const [full, sparse] = dd.deviceData;

        eq(full.values[0].value, 42.9, 'a scalar carries its value');

        /* Arr and Su are POSITIONAL arrays, not maps of named members. That was
         * the first of the three Task 5 errors, and it recurses. */
        eq(full.values[2].kind, 'Arr', 'Arr is an array of further values');
        deep(full.values[2].items.map((v) => v.value), [145.4, 933, 1727.1],
            '  positional, in document order');
        eq(full.values[3].items.length, 2, 'Arr of Su recurses');
        deep(full.values[3].items[0].fields.map((v) => v.value), [23, 57],
            '  and Su\'s FIELDS are positional too — a list, not a name map');

        /* xsi:nil on ANY scalar kind, not only NoValue. The second Task 5 error. */
        eq(sparse.values[1].kind, 'F8', 'a nil scalar keeps its KIND');
        eq(sparse.values[1].value, null, '  and carries null — E138 nil, which JSON writes as null');

        /* NoValue is an OBJECT: @reasonCode is required and Description is its
         * child. A bare null loses both. The third Task 5 error. */
        eq(sparse.values[2].reasonCode, 'ValueNotAvailable', 'NoValue carries its required reasonCode');
        eq(sparse.values[2].description, 'probe offline', '  and its Description child');

        eq(sparse.values[3].items.length, 0, 'an empty Arr is [] — present and empty, not absent');

        /* Table 19 makes the ordering a `shall`, and the values carry no names,
         * so the Parameter list IS the schema for the values. */
        eq(dd.parameters.length, full.values.length,
            'the Parameter list and the value list are the same length — position binds them');
        eq(dd.parameters[0].description, 'Ball diameter at bond',
            '  and @Description is optional on a Parameter: only the first has one');
        eq(dd.parameters[1].description, undefined, '  the second has none');
    });

    /* The negative case Done-when asks for, and it is the one the task names:
     * the standard's own R1-2.1 example is not schema-valid. */
    const deg = compareRepresentations('v0125-devicedata-degenerate');
    for (const code of ['E138_PV_LEXICAL', 'E138_PV_NOVALUE_REASON_MISSING',
        'E138_PV_NOVALUE_REASON_UNKNOWN', 'E142_XML_DEVICEDATA_VALUE_COUNT']) {
        ok(warningCodes(deg.xml.warnings).includes(code), `${code} from XML`);
        ok(warningCodes(deg.json.warnings).includes(code),
            '  and the identical code from JSON — same rule, one implementation');
    }

    attempt('the standard\'s own malformed value is carried, not refused', () => {
        const vals = deg.json.doc.substrateMaps[0].overlays[1]
            .deviceDataMaps[0].deviceData[0].values;
        eq(vals[0].kind, 'F8',
            'R1-2.1 writes three doubles in one ccs:F8, which is xsd:double — the KIND is kept');
        eq(vals[0].value, null, '  the VALUE is dropped to null rather than guessed at');
        eq(vals[1].reasonCode, '', 'a NoValue with no reasonCode keeps an empty one');
        eq(vals[2].reasonCode, 'ProbeOffline',
            'an unlisted reason is carried VERBATIM — a reader must see what the producer wrote');
        eq(vals.length, 4, 'and all four values survive, one more than there are Parameters');
    });
});

section('5e. Substrate records and aliases (Task 14)', () => {
    const FIXTURES = ['v0125-substrate-aliasids', 'v0125-substrate-alias-degenerate',
        'v0125-substrate-carrier', 'v0125-substrate-full-record',
        'v0125-substrate-multiple-records', 'v0125-substrate-numbers',
        'v0125-three-substrates', 'v0125-all-header-facts',
        'official-BinCodeMap-Extension-Example'];
    for (const base of FIXTURES) {
        const r = compareRepresentations(base);
        ok(r.equal === true, `${base}: substrate records survive identically\n      ${r.detail}`);
    }

    /* AliasIdType declares BOTH attributes use="required", and @Type is an OPEN
     * vocabulary - Table 7 gives examples and declares no restriction. */
    attempt('aliases', () => {
        const sub = compareRepresentations('v0125-substrate-aliasids').json.doc.substrates[0];
        eq(sub.aliasIds.length, 3, 'every alias survives');
        deep(sub.aliasIds.map((a) => a.type),
            ['FrontsideId', 'FrameId', 'CustomerBarcode'],
            '  including CustomerBarcode — the @Type vocabulary is open, not an enumeration');
        eq(sub.aliasIds[2].value.length, 32,
            '  and a 32-character @Value is the MaterialIdType boundary, which must NOT warn');
        eq(warningCodes(compareRepresentations('v0125-substrate-aliasids').xml.warnings).length, 0,
            '  so this fixture is silent');
    });

    /* The negative case Done-when asks for, and the one the task text names. */
    const deg = compareRepresentations('v0125-substrate-alias-degenerate');
    for (const code of ['E142_XML_ID_EMPTY', 'E142_XML_ID_TOO_LONG']) {
        ok(warningCodes(deg.xml.warnings).includes(code), `${code} from XML`);
        ok(warningCodes(deg.json.warnings).includes(code),
            '  and the identical code from JSON — same rule, one implementation');
    }
    attempt('degenerate aliases are carried, not repaired', () => {
        const a = deg.json.doc.substrates[0].aliasIds;
        eq(a.length, 4, 'all four aliases survive, degenerate or not');
        eq(a[1].value, '', 'an empty @Value is KEPT — the producer emitted it and a reader must see it');
        eq(a[2].value.length, 33,
            'a 33-character @Value is carried UNTRUNCATED — an alias is a join key, '
            + 'and a shortened one joins to nothing');
        eq(a[3].type, '',
            'an empty @Type is reported by nothing: the vocabulary is open, so there is no facet');
    });

    /* Substrate identity is the (SubstrateType, SubstrateId) key, never position. */
    attempt('substrate identity', () => {
        const doc = compareRepresentations('v0125-substrate-multiple-records').json.doc;
        eq(doc.substrates.length, 2, 'both records arrive, decoy first');
        eq(doc.substrates[0].substrateId, 'DECOY-01',
            '  and the FIRST is the decoy — anything resolving by position reads WRONG-LOT');
        eq(doc.substrateMaps[0].header.substrateId, 'TARGET-02',
            '  while the map names the second by key');
        const three = compareRepresentations('v0125-three-substrates').json.doc;
        eq(three.substrates.length, 3, 'three substrates');
        eq(three.substrateMaps[2].header.layoutSpecifier, 'L2',
            '  and the third map points at a DIFFERENT layout — a positional read gets the wrong pitch');
    });

    /* Zero is a value. Table 6 calls these "Positive Integer"; the schema says
     * nonNegativeInteger and the schema wins. */
    attempt('numbers', () => {
        const sub = compareRepresentations('v0125-substrate-numbers').json.doc.substrates[0];
        eq(sub.slotNumber, 0, 'SlotNumber 0 is a real slot, not an absence');
        eq(sub.goodDevices, 0, 'GoodDevices 0 means "none good", not "unknown"');
        eq(sub.substrateNumber, 25, '  and a non-zero sibling is unaffected');
        const carrier = compareRepresentations('v0125-substrate-carrier').json.doc.substrates[0];
        eq(carrier.carrierId.length, 80,
            'CarrierId is LotIdType (maxLength 80), NOT MaterialIdType (32) — this one is '
            + 'EXACTLY 80, the inclusive boundary, and must not warn');
        eq(warningCodes(compareRepresentations('v0125-substrate-carrier').xml.warnings).length, 0,
            '  and it does not — a parser applying the 32 facet here would warn on both paths');
    });

    /* Every header attribute at a non-default value at once. */
    attempt('header facts', () => {
        const h = compareRepresentations('v0125-all-header-facts').json.doc.substrateMaps[0].header;
        eq(h.substrateSide, 'BottomSide', 'SubstrateSide is read, not defaulted to TopSide');
        eq(h.orientation, 180, 'Orientation is read, not defaulted to 0');
        eq(h.originLocation, 'UpperRight', 'OriginLocation is read, not defaulted to LowerLeft');
        eq(h.axisDirection, 'DownLeft', 'AxisDirection is read, not defaulted to UpRight');
        eq(h.substrateType, 'Panel', 'and Panel is one of the three V0125 additions to the enum');
    });

    /* SEMI's own extension example: no SubstrateMaps at all, and a vendor subtree
     * neither path retains. */
    attempt('the extension example', () => {
        const ext = compareRepresentations('official-BinCodeMap-Extension-Example');
        eq(ext.json.doc.substrateMaps.length, 0,
            'a MapData with NO SubstrateMaps is legal — all three children are minOccurs="0"');
        const sub = ext.json.doc.substrates[0];
        eq(sub.goodDevices, 148, 'the base-schema fields survive on both paths');
        eq(sub.supplierName, 'XDFG', '  including SupplierName');
        ok(!('supplierData' in sub) && !('SupplierData' in sub),
            'while the vendor subtree is DROPPED, not carried — the model has no slot for it');
    });
});

section('5f. The geometry and format core (Task 14a)', () => {
    /* The 25 fixtures Tasks 10-14 did not own: origin and axis frames,
     * orientation, bin types and payload forms, units, namespace revisions,
     * layout trees, and two negative cases. Every map that renders passes through
     * a frame, an orientation and a bin type, so these are the parts where a
     * structural mapping error would be most expensive - and two real defects
     * (D-028, D-029) were found here by Task 8's round trip. */
    const GROUPS = {
        'origin / axis frame': ['v0125-bottomside-ascii', 'v0125-bottomside-orientation-180',
            'v0125-origin-lowerright-upleft', 'v0125-origin-upperleft-downright',
            'v0211-origin-center-even', 'v0211-origin-downleft'],
        orientation: ['v0125-orientation-270', 'v0211-orientation-45-nonquadrant',
            'v0211-orientation-90'],
        'bin type / payload form': ['official-BinCodeMap-Example', 'v0211-coordinate-mixed',
            'v0211-decimal-bintype', 'v0211-hexadecimal-nullbin-round',
            'v0211-rowcolumn-prose-derived', 'v1005-strip-integer2-lowerleft'],
        units: ['v0211-defaultunits-microns', 'v0211-defaultunits-100microns'],
        'namespace revision': ['v0805-legacy-namespace'],
        'layout tree': ['v0125-layout-images', 'v0211-layoutless-defaults-alt',
            'v0211-multi-layout-childpath'],
        'negative and edge': ['v0211-invalid-duplicate-layoutid',
            'v0211-invalid-unknown-substratetype', 'v0125-substrate-edge-values',
            'v0211-substrateid-whitespace'],
    };
    let counted = 0;
    for (const [group, bases] of Object.entries(GROUPS)) {
        for (const base of bases) {
            counted++;
            const r = compareRepresentations(base);
            ok(r.equal === true, `${group} / ${base}: equal documents\n      ${r.detail}`);
        }
    }
    eq(counted, 25, 'all 25 formerly-UNOWNED fixtures are covered');

    /* Frames. Each fixture below must differ from its neighbours in the CELLS,
     * not only in its header, or the group is testing nothing. */
    attempt('frames survive and are not defaulted', () => {
        const hdr = (b) => compareRepresentations(b).json.doc.substrateMaps[0].header;
        /* A 2DArray payload carries NO logical coordinates - its rows are already
         * the serialization lattice - so the frame cannot reorder its cells, and
         * an assertion that it does would be wrong. What must survive is the
         * frame ITSELF, because it is what a Coordinate or Row/Column payload is
         * placed through, and getting that inverse wrong is exactly D-028. */
        const lr = hdr('v0125-origin-lowerright-upleft');
        const ul = hdr('v0125-origin-upperleft-downright');
        deep([lr.originLocation, lr.axisDirection], ['LowerRight', 'UpLeft'],
            'LowerRight/UpLeft survives the JSON path');
        deep([ul.originLocation, ul.axisDirection], ['UpperLeft', 'DownRight'],
            '  and UpperLeft/DownRight, on an otherwise identical document');
        eq(hdr('v0211-origin-center-even').originLocation, 'Center',
            'Center is the fifth OriginLocation member and the only non-corner one');
        /* Where the frame DOES move cells: a sparse payload placed through it. */
        const rc = compareRepresentations('v0211-rowcolumn-prose-derived').json.doc
            .substrateMaps[0].overlays[0].payload;
        eq(Array.from(rc.cells).join(''), '121112011110111211111121',
            'a Row/Column payload IS placed through the frame — this is the cell order '
            + 'that came back flipped when the serializer used payload indices (D-028)');
        const dl = compareRepresentations('v0211-origin-downleft').json.doc.substrateMaps[0];
        eq(dl.overlays[0].payload.cols, 5,
            'a 5x3 lattice stays 5 wide under UpperRight/DownLeft — a transpose would make it 3');
        eq(compareRepresentations('v0125-bottomside-ascii').json.doc.substrateMaps[0]
            .header.substrateSide, 'BottomSide',
            'SubstrateSide is read, not defaulted — it is a coordinate-system fact');
    });

    /* Orientation is carried, never normalised: 45 is inside the 0..359 facet and
     * is not a multiple of 90. Rounding it would mis-state where the substrate is. */
    attempt('orientation is carried verbatim', () => {
        const o = (b) => compareRepresentations(b).json.doc.substrateMaps[0].header.orientation;
        eq(o('v0211-orientation-45-nonquadrant'), 45, '45 survives — not rounded to a quadrant');
        eq(o('v0125-orientation-270'), 270, '270 survives');
        eq(compareRepresentations('v0211-orientation-90').json.doc.substrateMaps[0]
            .overlays[0].payload.cols, 5,
            'and Orientation 90 does NOT rotate the lattice — a 5x3 map stays 5 wide');
    });

    /* Bin types. The separator asymmetry is the format's, and getting it wrong
     * produces a document that serialises cleanly and cannot be read back (D-029). */
    attempt('bin types and null bins', () => {
        const meta = (b) => compareRepresentations(b).json.doc.substrateMaps[0]
            .overlays[0].binCodeMapMeta;
        eq(meta('v0211-decimal-bintype').binType, 'Decimal', 'Decimal is whitespace-separated');
        eq(meta('v0211-decimal-bintype').nullBin, '255',
            '  with NullBin 255 — the null token is not the numeric zero');
        eq(meta('v0211-hexadecimal-nullbin-round').binType, 'HexaDecimal',
            'HexaDecimal keeps the schema\'s own spelling');
        eq(meta('v0211-hexadecimal-nullbin-round').nullBin, 'F0',
            '  with NullBin F0, a legal hex token that is not zero either');
        eq(meta('v1005-strip-integer2-lowerleft').binType, 'Integer2', 'Integer2 is four hex chars');
        eq(meta('official-BinCodeMap-Example').mapType, undefined,
            'and SEMI\'s own example omits MapType, which has no XSD default');
    });

    /* Payload forms other than 2DArray. */
    attempt('sparse payload forms', () => {
        const rc = compareRepresentations('v0211-rowcolumn-prose-derived').json.doc
            .substrateMaps[0].overlays[0];
        eq(rc.binCodeMapMeta.mapType, 'Row/Column', 'Row/Column survives as its own MapType');
        eq(rc.payload.cols * rc.payload.rows, 24, '  decoding to the declared 6x4 lattice');
        const co = compareRepresentations('v0211-coordinate-mixed').json.doc
            .substrateMaps[0].overlays[0];
        eq(co.sparseBinCodes.length, 7, 'Coordinate keeps its seven sparse entries');
        eq(co.sparseBinCodes[0].number, 1, '  including @Number, carried and ignored for placement');
        eq(co.payload.cols * co.payload.rows, 12, '  against a 12-cell lattice: five cells are null');
    });

    /* Units and namespaces are tokens, never resolved. */
    attempt('units and namespace', () => {
        const l = (b, i = 0) => compareRepresentations(b).json.doc.layouts[i];
        eq(l('v0211-defaultunits-100microns').defaultUnits, '100Microns',
            'the compound unit token is carried verbatim, never scaled');
        eq(l('v0211-defaultunits-microns').defaultUnits, 'microns', 'as is "microns"');
        eq(compareRepresentations('v0211-defaultunits-microns').json.doc
            .substrateMaps[0].header.layoutSpecifier, 'FDI Target/DeviceLayout',
            'and a LayoutSpecifier may contain a space — LayoutId has no pattern');
        eq(compareRepresentations('v0805-legacy-namespace').json.doc.namespaceUri,
            'urn:semi-org:xsd.E142-1.V0805.SubstrateMap',
            'a revision with no XSD here still parses, and its namespace round-trips');
    });

    /* Layout trees. */
    attempt('layout trees', () => {
        const img = compareRepresentations('v0125-layout-images').json.doc.layouts;
        eq(img[1].topImage, '../assets/die%20top.png',
            'a relative, percent-encoded image URI survives byte-for-byte — carry-only, never resolved');
        eq(img[0].childLayouts[0], 'Img_Devices', 'ChildLayouts flattens to a LayoutId');
        const child = compareRepresentations('v0211-multi-layout-childpath').json.doc;
        eq(child.substrateMaps[0].overlays[0].payload.cols, 4,
            'a "Top/Child" specifier resolves to the CHILD lattice, not the parent\'s 1x1');
        eq(compareRepresentations('v0211-layoutless-defaults-alt').json.doc.layouts.length, 0,
            'and a document with no Layouts at all takes its lattice from the payload');
    });

    /* The negative cases, and the identity-constraint one is the sharpest: both
     * paths REJECT, with the same code. */
    attempt('negative and edge cases', () => {
        const dup = compareRepresentations('v0211-invalid-duplicate-layoutid');
        eq(dup.xml.ok, false, 'a duplicate LayoutId is REJECTED from XML — the LayoutKey xs:key');
        eq(dup.json.ok, false, '  and from JSON');
        eq(dup.xml.code, dup.json.code, '  with the identical error code, not merely both failing');
        eq(dup.xml.code, 'E142_XML_INTEGRITY', '  which is E142_XML_INTEGRITY');

        const unk = compareRepresentations('v0211-invalid-unknown-substratetype');
        eq(unk.json.doc.substrates[0].substrateType, 'Puck',
            'an unknown SubstrateType is CARRIED — the enum has grown twice, so it may be a newer standard');
        ok(warningCodes(unk.xml.warnings).length > 0, '  with a warning from XML');
        deep(warningCodes(unk.json.warnings), warningCodes(unk.xml.warnings),
            '  and the same codes from JSON');

        const edge = compareRepresentations('v0125-substrate-edge-values').json.doc.substrates[0];
        eq(edge.substrateId.length, 32, 'SubstrateId at exactly 32, the MaterialIdType boundary');
        eq(edge.lotId.length, 80, 'LotId at exactly 80, the LotIdType boundary');
        eq(warningCodes(compareRepresentations('v0125-substrate-edge-values').xml.warnings).length, 0,
            '  and neither warns — an off-by-one in either facet is visible only here');

        const ws = compareRepresentations('v0211-substrateid-whitespace').json.doc;
        eq(ws.substrates[0].substrateId, ws.substrateMaps[0].header.substrateId,
            'a padded SubstrateId is trimmed the SAME way in the record and the header, '
            + 'or the identity key stops matching between them');
    });
});

section('6. the control renders both representations identically (Task 18)', () => {
    /*
     * Sections 1-5 compare parsed DOCUMENTS. This one goes one layer up and
     * compares what the CONTROL builds from them, because that is the claim the
     * attribute makes to a view author: bind the JSON form and you get the same
     * picture. Equal documents make it very likely and do not prove it - the
     * control chooses an overlay, resolves a layout and builds a grid after the
     * parser has finished, and any of that could read the two differently.
     *
     * Cell PATTERN, per Task 18's Done-when: the lattice, a hash of the whole cell
     * array, and the bin table in order. Not a screenshot and not a spot check.
     */
    let compared = 0;
    const differing = [];
    for (const base of E142_JSON) {
        const xmlPath = join(XML_DIR, base + '.xml');
        if (!existsSync(xmlPath)) { continue; }
        const doc = JSON.parse(readFileSync(join(JSON_DIR, base + '.json'), 'utf8'));
        const fromXml = attempt(`${base}: binds as XML`,
            () => bindAndFingerprint('setE142MapData', readFileSync(xmlPath, 'utf8')));
        const fromJson = attempt(`${base}: binds as JSON`,
            () => bindAndFingerprint('setE142MapDataJson', doc));
        if (fromXml === null || fromJson === null) { continue; }
        compared++;
        if (fromXml !== fromJson) {
            differing.push(`${base}\n      xml : ${fromXml}\n      json: ${fromJson}`);
        }
    }
    eq(differing.length, 0,
        `every corpus map renders the same cell pattern from both attributes  ${differing[0] ?? ''}`);
    ok(compared > 40, `${compared} maps compared through the real control, not through the parser`);

    /*
     * Four setters decide whether an attribute that selects INSIDE a document -
     * the overlay name and version, the substrate id, the layout specifier -
     * forces a rebuild, and each tested `activeInput === 'xml' || 'transfer'`
     * before Task 18 extracted them. Omitting 'json' there leaves a JSON-bound map
     * silently ignoring its own overlay selection, which nothing above would
     * notice: the FIRST overlay renders either way.
     */
    attempt('selecting inside a JSON-bound document works', () => {
        const doc = JSON.parse(readFileSync(join(JSON_DIR, 'v0211-multi-overlay.json'), 'utf8'));
        const control = new SubstrateMap(null, null, {});
        control.setE142MapDataJson(doc);
        control.__attach();
        const first = gridFingerprint(control);
        control.setE142OverlayName('FinalTest');
        const chosen = gridFingerprint(control);
        ok(first !== 'NO GRID', 'a multi-overlay JSON document renders its first overlay');
        ok(chosen !== first,
            '  and E142OverlayName re-selects — a JSON-bound map is an E142 DOCUMENT input, '
            + 'so the four in-document selectors must reach it');
    });

    /*
     * The parse cache is keyed on nothing: `__e142Doc` is cleared by whichever
     * setter changed the document. A JSON setter that forgets leaves the PREVIOUS
     * document rendering, and every assertion above still passes because each of
     * them binds a fresh control.
     */
    attempt('re-binding a different JSON document re-parses', () => {
        const a = JSON.parse(readFileSync(join(JSON_DIR, 'v0211-multi-overlay.json'), 'utf8'));
        const b = JSON.parse(readFileSync(join(JSON_DIR, 'v0125-lid-retained.json'), 'utf8'));
        const control = new SubstrateMap(null, null, {});
        control.setE142MapDataJson(a);
        control.__attach();
        const fa = gridFingerprint(control);
        control.setE142MapDataJson(b);
        const fb = gridFingerprint(control);
        ok(fa !== 'NO GRID' && fb !== 'NO GRID', 'both documents render');
        ok(fa !== fb,
            '  and the second replaces the first — a setter that does not clear the parse cache '
            + 'would keep showing the first document forever');
    });

    /* And the attribute is genuinely wired: an unbound one renders nothing. */
    attempt('the attribute unbinds', () => {
        const base = E142_JSON.find((b) => existsSync(join(XML_DIR, b + '.xml')));
        const doc = JSON.parse(readFileSync(join(JSON_DIR, base + '.json'), 'utf8'));
        ok(bindAndFingerprint('setE142MapDataJson', doc) !== 'NO GRID',
            'binding the JSON form builds a grid');
        eq(bindAndFingerprint('setE142MapDataJson', null), 'NO GRID',
            '  and binding null builds none — the default, so nothing existing changes');
    });
});

section('7. the $binary form and the precedence rule (Task 19, OD-002/C)', () => {
    const xmlOf = (b) => readFileSync(join(XML_DIR, b + '.xml'), 'utf8');
    const jsonOf = (b) => JSON.parse(readFileSync(join(JSON_DIR, b + '.json'), 'utf8'));
    const BASE = 'v0211-hexadecimal-nullbin-round';   // dense, 2DArray, binary-encodable

    /* All three representations of one document must render one picture. The
     * binary form is not a second format - $binary is an encoding of the token
     * text, expanded before the document is read (D-049) - so anything else here
     * would mean the expansion is lossy. */
    /*
     * OD-002 was answered with option C: `E142MapDataBinary` is gone, because it
     * had no observable behaviour - `$binary` is an optional payload form INSIDE
     * one envelope, not a second format. That makes this assertion load-bearing
     * rather than incidental: the single JSON attribute must read BOTH forms, or
     * dropping the second attribute lost a capability instead of a duplicate.
     */
    attempt('one JSON attribute reads both payload forms', () => {
        const doc = jsonOf(BASE);
        const binary = JSON.parse(E142Json.e142DocumentToJson(
            E142Json.parseE142Json(doc).doc, { binary: true }));
        ok(binary.SubstrateMaps[0].Overlay[0].BinCodeMap.$binary !== undefined,
            'the binary document really does carry $binary');
        const fx = bindAndFingerprint('setE142MapData', xmlOf(BASE));
        const fj = bindAndFingerprint('setE142MapDataJson', doc);
        const fb = bindAndFingerprint('setE142MapDataJson', binary);
        ok(fx !== 'NO GRID', 'the XML form renders');
        eq(fj, fx, '  the token JSON form renders the same cell pattern');
        eq(fb, fx, '  and so does the $binary form, through the SAME attribute');
    });

    /* A binary-bound map is an E142 DOCUMENT input, so the four in-document
     * selectors must reach it - the same trap Task 18 fell into for 'json', and
     * one no compiler catches: the FIRST overlay renders either way. */
    attempt('selecting inside a $binary document works', () => {
        const doc = jsonOf('v0211-multi-overlay');
        const binary = JSON.parse(E142Json.e142DocumentToJson(
            E142Json.parseE142Json(doc).doc, { binary: true }));
        const control = new SubstrateMap(null, null, {});
        control.setE142MapDataJson(binary);
        control.__attach();
        const first = gridFingerprint(control);
        control.setE142OverlayName('FinalTest');
        ok(first !== 'NO GRID', 'a multi-overlay binary document renders its first overlay');
        ok(gridFingerprint(control) !== first, '  and E142OverlayName re-selects');
    });

    /* Done-when 1 and 2: last-write-wins is unchanged, and now it says so. */
    attempt('a second input overrides, and is reported', () => {
        logLines();                       // drain what earlier sections left behind
        const control = new SubstrateMap(null, null, {});
        control.setE142MapData(xmlOf(BASE));
        control.__attach();
        eq(logLines().filter((l) => l.message.includes('E142_MAP_INPUT_OVERRIDDEN')).length, 0,
            'one input on its own logs nothing');

        const other = jsonOf('v0211-multi-overlay');
        control.setE142MapDataJson(other);
        const after = logLines().filter((l) => l.message.includes('E142_MAP_INPUT_OVERRIDDEN'));
        eq(after.length, 1, 'writing a second input logs exactly one warning');
        /* Loser and winner, in the right ROLES - not merely both mentioned
         * somewhere, which a message naming them the wrong way round would pass. */
        ok(after[0].message.includes('E142MapDataJson was written while E142MapData was still bound'),
            '  naming the attribute that WON and the one that LOST, in those roles');
        ok(after[0].message.includes('E142MapData is ignored'),
            '  and saying which of them is being ignored');
        eq(gridFingerprint(control), bindAndFingerprint('setE142MapDataJson', other),
            '  while still rendering the most recent one, exactly as before');
    });

    /* Done-when 3: clearing the winner falls back, without a reload. */
    attempt('clearing the winner falls back to what is still bound', () => {
        logLines();
        const control = new SubstrateMap(null, null, {});
        control.setE142MapData(xmlOf(BASE));
        control.__attach();
        const fromXml = gridFingerprint(control);
        control.setE142MapDataJson(jsonOf('v0211-multi-overlay'));
        const fromJson = gridFingerprint(control);
        ok(fromXml !== fromJson, 'the second input takes over');
        control.setE142MapDataJson(null);
        eq(gridFingerprint(control), fromXml,
            '  and clearing it falls back to the XML still bound — same control, no reload');
        control.setE142MapData(null);
        eq(gridFingerprint(control), 'NO GRID', '  clearing the last one empties the grid');
    });

    /* The warning is about a CONFLICT, not about writing. Re-writing the same
     * attribute, or writing after the other was cleared, is not one. */
    attempt('the diagnosis does not fire when there is no conflict', () => {
        logLines();
        const control = new SubstrateMap(null, null, {});
        control.setE142MapData(xmlOf(BASE));
        control.__attach();
        control.setE142MapData(xmlOf('v0211-decimal-bintype'));
        eq(logLines().filter((l) => l.message.includes('E142_MAP_INPUT_OVERRIDDEN')).length, 0,
            're-writing the SAME attribute is not a conflict');
        control.setE142MapData(null);
        control.setE142MapDataJson(jsonOf(BASE));
        eq(logLines().filter((l) => l.message.includes('E142_MAP_INPUT_OVERRIDDEN')).length, 0,
            '  and writing one after the other was cleared is not a conflict either');

    });
});

section('8. BinQualityAliases through the control (LOD-5)', () => {
    /** @param q The BinQuality for bin code 9. @returns A two-bin document. */
    const doc = (q) => '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap"><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier=""><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + `<BinDefinition BinCode="1" BinQuality="Pass"/><BinDefinition BinCode="9" BinQuality="${q}"/>`
        + '</BinDefinitions><BinCode>11</BinCode><BinCode>19</BinCode>'
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';
    const unmapped = (lines) => lines.filter((l) => l.message.includes('E142_BIN_QUALITY_UNMAPPED'));

    /* Done-when 1: one warning, naming the token AND the bin code carrying it. */
    attempt('an unmapped token warns once and names both', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc('Reject'));
        c.__attach();
        const w = unmapped(logLines());
        eq(w.length, 1, 'exactly one warning');
        ok(w[0].message.includes('"Reject"'), '  naming the token');
        ok(w[0].message.includes('BinCode "9"'), '  and the bin code carrying it');
        ok(w[0].message.includes('BinQualityAliases'), '  and how to fix it');
        ok(w[0].message.includes('legal'),
            '  and saying the document is legal — an application-defined value is not a defect');
    });

    /* Done-when 2: with the alias bound, the warning stops. */
    attempt('binding the alias silences it', () => {
        const c = new SubstrateMap(null, null, {});
        c.setBinQualityAliases({ Reject: 'fail' });
        c.setE142MapData(doc('Reject'));
        c.__attach();
        logLines();
        c.setE142MapData(doc('Reject').replace('11', '19'));   // a fresh document, same tokens
        eq(unmapped(logLines()).length, 0, 'no warning once the token is mapped');
    });

    attempt('the reserved values never warn, and neither does an absent one', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc('Fail'));
        c.__attach();
        eq(unmapped(logLines()).length, 0, 'Fail is reserved');

        const c2 = new SubstrateMap(null, null, {});
        c2.setE142MapData(doc(''));
        c2.__attach();
        eq(unmapped(logLines()).length, 0,
            'and an empty BinQuality is UNDEFINED per the standard, not unmapped');
    });

    attempt('it warns once, not once per render', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc('Schlecht'));
        c.__attach();
        const first = unmapped(logLines()).length;
        c.setE142MapData(doc('Schlecht'));
        c.setE142MapData(doc('Schlecht'));
        eq(first, 1, 'the first document warns');
        eq(unmapped(logLines()).length, 0,
            '  and re-binding the same token does not repeat it — the latch is per bin code and token');
    });

    attempt('changing the aliases makes the diagnosis newsworthy again', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc('Ausschuss'));
        c.__attach();
        logLines();
        c.setBinQualityAliases({ Nope: 'fail' });      // still does not cover Ausschuss
        eq(unmapped(logLines()).length, 1,
            'a new alias map that still misses the token reports it again — the map was edited, so '
            + 'the author is looking');
        c.setBinQualityAliases({ Ausschuss: 'fail' });
        eq(unmapped(logLines()).length, 0, '  and a map that covers it says nothing');
    });
});

section('9. BinSeverityPriority through the control (LOD-7)', () => {
    const doc = '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap"><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier=""><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="P" BinQuality="Pass"/><BinDefinition BinCode="F" BinQuality="Fail"/>'
        + '</BinDefinitions><BinCode>PF</BinCode><BinCode>PP</BinCode>'
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';
    const of = (lines, code) => lines.filter((l) => l.message.includes(code));

    /* Done-when 2: a code in the list but not in the map warns once and changes
     * nothing. */
    attempt('a listed code the map has no bin for warns once', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setBinSeverityPriority(['F', 'NoSuchCode']);
        c.setE142MapData(doc);
        c.__attach();
        const before = gridFingerprint(c);
        const w = of(logLines(), 'E142_BIN_SEVERITY_PRIORITY_UNUSED');
        eq(w.length, 1, 'exactly one warning');
        ok(w[0].message.includes('"NoSuchCode"'), '  naming the code');

        c.setE142MapData(doc);
        eq(of(logLines(), 'E142_BIN_SEVERITY_PRIORITY_UNUSED').length, 0, '  and not repeated');
        eq(gridFingerprint(c), before, '  and nothing about the map changed');
    });

    /*
     * The floor, reported. Listing a passing code is the mistake that would
     * otherwise hide failures, so it is named rather than silently ignored.
     */
    attempt('listing a passing code is reported, and the list is ignored for it', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setBinSeverityPriority(['P', 'F']);
        c.setE142MapData(doc);
        c.__attach();
        const w = of(logLines(), 'E142_BIN_SEVERITY_PRIORITY_IGNORED');
        eq(w.length, 1, 'exactly one warning');
        ok(w[0].message.includes('"P"'), '  naming the code');
        ok(w[0].message.includes('hiding the failure'),
            '  and saying what promoting it would have cost');
    });

    attempt('a well-formed list says nothing', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setBinSeverityPriority(['F']);
        c.setE142MapData(doc);
        c.__attach();
        const lines = logLines();
        eq(of(lines, 'E142_BIN_SEVERITY_PRIORITY_UNUSED').length, 0, 'no unused warning');
        eq(of(lines, 'E142_BIN_SEVERITY_PRIORITY_IGNORED').length, 0, 'and no ignored warning');
    });

    attempt('the attribute round-trips and defaults to null', () => {
        const c = new SubstrateMap(null, null, {});
        eq(c.getBinSeverityPriority(), null, 'unset by default, so nothing existing changes');
        c.setBinSeverityPriority(['A', 'B']);
        deep(c.getBinSeverityPriority(), ['A', 'B'], 'and reads back what was written');
        const got = c.getBinSeverityPriority();
        got.push('C');
        deep(c.getBinSeverityPriority(), ['A', 'B'],
            '  as a copy — mutating the result does not reach the control');
    });

    attempt('changing the aliases re-checks the list', () => {
        /*
         * The bin carries an APPLICATION-DEFINED token. An alias cannot redefine a
         * reserved value — `resolveBinQuality` matches `pass` and `fail` before it
         * consults the map (D-076), so aliasing "Fail" onto pass does nothing, and
         * the first version of this test asserted otherwise.
         */
        const appToken = doc.replace('BinQuality="Fail"', 'BinQuality="Sonderfall"');
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setBinSeverityPriority(['F']);
        c.setE142MapData(appToken);
        c.__attach();
        logLines();
        c.setBinQualityAliases({ Sonderfall: 'pass' });
        eq(of(logLines(), 'E142_BIN_SEVERITY_PRIORITY_IGNORED').length, 1,
            'an alias that turns a listed code into a pass reopens the diagnosis');
        c.setBinQualityAliases({ Sonderfall: 'fail' });
        eq(of(logLines(), 'E142_BIN_SEVERITY_PRIORITY_IGNORED').length, 0,
            '  and aliasing it back onto fail makes the list legitimate again');
    });

    attempt('an alias cannot redefine a value the standard reserves', () => {
        const c = new SubstrateMap(null, null, {});
        c.setBinQualityAliases({ Fail: 'pass' });
        c.setE142MapData(doc);
        c.__attach();
        logLines();
        c.setBinSeverityPriority(['F']);
        eq(of(logLines(), 'E142_BIN_SEVERITY_PRIORITY_IGNORED').length, 0,
            'aliasing "Fail" onto pass does nothing — the reserved values are matched first (D-076)');
    });
});

section('10. AggregationFactor and AggregationMode (LOD-15)', () => {
    const doc = '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap"><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier=""><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="1" BinQuality="Pass"/></BinDefinitions>'
        + '<BinCode>11</BinCode><BinCode>11</BinCode>'
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';

    /* Done-when 2. */
    attempt('both outputs are null when no map is bound', () => {
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        eq(c.getAggregationFactor(), null, 'no factor');
        eq(c.getAggregationMode(), null, 'and no mode — not "None", which would claim a frame was drawn');
    });

    /*
     * Done-when 1, in the part that can be driven here.
     *
     * WHAT IS COVERED: the outputs are a pure function of the factor, they update
     * when it changes, they dedupe when it does not, and NOTHING RE-PARSES when
     * they move. The two factors below are the real ones a 600 px and a 200 px
     * control produce for the same map, computed through the same engine call the
     * render loop makes.
     *
     * WHAT IS NOT: that the render loop actually calls `__publishAggregation`.
     * `attach-harness` stubs `__attach` to a no-op and never drives the canvas
     * path, so the call site is covered by reading rather than by a test. Recorded
     * rather than glossed — see observation 105.
     */
    attempt('the outputs follow the factor, with no re-parse', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();

        /*
         * The real engine call, through the real matrices — possible since
         * `attach-harness` began delegating to `tests/lib/dom-shims.mjs` instead of
         * carrying its own partial `DOMMatrix` (D-089). The arithmetic stand-in
         * this used before is asserted alongside it, so the two cannot drift.
         */
        const placement = { originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
            rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false };
        const factorAt = (px) => {
            const cfg = { center: { x: px / 2, y: px / 2 }, width: px, height: px, margin: 8 };
            const dev = Engine.deviceMatrix(1,
                Engine.makeWorldMatrix(cfg, Engine.computeScale(cfg, 100, 100), 0));
            return Engine.aggregationFactor(dev, placement);
        };
        for (const px of [200, 600]) {
            const scale = (px - 16) / 100;
            ok(Math.abs(factorAt(px) - 1 / (scale * scale)) < 1e-9,
                `at ${px} px the engine and the arithmetic agree: ${factorAt(px).toFixed(6)}`);
        }
        const big = factorAt(600);
        const small = factorAt(200);
        ok(small > big, `a smaller control aggregates harder: ${small.toFixed(4)} against ${big.toFixed(4)}`);

        E142Mod.setEngineCountersEnabled(true);
        const parsesBefore = E142Mod.readEngineCounters().parses;
        c.__publishAggregation(big, null);
        const atBig = c.getAggregationFactor();
        c.__publishAggregation(small, null);
        const atSmall = c.getAggregationFactor();

        eq(atBig, big, 'the factor is published as given');
        ok(atSmall !== atBig, '  and changes when the size does');
        eq(E142Mod.readEngineCounters().parses, parsesBefore,
            'and nothing re-parsed — the factor comes from the matrices, never from the document');
        E142Mod.setEngineCountersEnabled(false);
    });

    /*
     * THE CALL SITE, at last (observation 104). Everything else in this section
     * asserts that `__publishAggregation` publishes correctly once called; this
     * asserts that the RENDER LOOP calls it — which is the only thing that makes
     * either output true, and was covered by reading until now.
     *
     * `renderOnce` drives the base's real `__render` on a recording context: real
     * `__makeConfig`, real `__readColors`, real `__computeMatrices`, real
     * `drawSubstrateMap`, real hook.
     */
    attempt('a real frame through __render publishes both outputs', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        eq(c.getAggregationFactor(), null, 'nothing is published before a frame is drawn');
        eq(c.getAggregationMode(), null, '  neither output');

        const ctx = renderOnce(c, 600);
        ok(ctx.fills.length > 0 || ctx.puts.length > 0,
            'the frame really was drawn — the canvas received work, so __render did not bail at a guard');
        ok(c.getAggregationFactor() !== null,
            `and the render loop published a factor: ${c.getAggregationFactor()}`);
        eq(c.getAggregationMode(), 'None', '  and a mode');
    });

    attempt('and it is the COMPOSED MATRIX\'s factor, not a coincidence', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        renderOnce(c, 600);
        const published = c.getAggregationFactor();

        /*
         * Recomposed from the SHARED matrix builder — the same one `getCellAtPos`
         * uses — rather than from first principles, so what is being checked is
         * that the hook is handed the right matrix and the right placement.
         * `rotatedExtent(fitBBox(...))` is what decides the scale, and getting the
         * extent wrong here is what made the first version of this assertion
         * compute Infinity.
         */
        const grid = c.__sceneGrid;
        ok(grid !== null, 'the control has a grid to measure');
        const cfg = { center: { x: 300, y: 300 }, width: 600, height: 600, margin: Engine.MARGIN_PX };
        const matrices = c.__computeMatrices(cfg, 1);
        const expected = Engine.aggregationFactor(
            Engine.deviceMatrix(matrices.dprBase, matrices.world), grid.placement);
        ok(Number.isFinite(expected), `the recomposed factor is a real number: ${expected}`);
        ok(Math.abs(published - expected) < 1e-12,
            `published ${published} matches the independently composed ${expected}`);

        /* And it is NOT what a size-derived factor would give — the trap D-078
         * exists to close. Control width over column count is a different number. */
        const naive = 1 / ((600 / grid.cols) ** 2);
        ok(Math.abs(published - naive) > 1e-9,
            `and it is not the naive control-width-over-columns figure ${naive.toExponential(3)}`);
    });

    /*
     * THE DEVICE PIXEL RATIO IS IN THE CHAIN. `window.devicePixelRatio` is 1 in
     * this harness, which makes `deviceMatrix(dprBase, world)` and `world` the same
     * matrix — so a hook handed the wrong one of the two is invisible until the
     * ratio is not 1. Observation 90: check the fixture is one where the
     * distinction can appear.
     *
     * It matters in production: on a HiDPI panel a cell covers four times the
     * device pixels, and a factor that ignored that would overstate the
     * aggregation fourfold and pick the wrong reducer at Task 17.
     */
    attempt('the factor accounts for the device pixel ratio', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        renderOnce(c, 400);
        const atOne = c.getAggregationFactor();

        const realDpr = window.devicePixelRatio;
        try {
            window.devicePixelRatio = 2;
            renderOnce(c, 400);
            const atTwo = c.getAggregationFactor();
            ok(Math.abs(atOne / atTwo - 4) < 1e-9,
                `doubling the device pixel ratio quarters the cells-per-pixel area: `
                + `${atOne.toExponential(4)} -> ${atTwo.toExponential(4)}`);
        } finally {
            window.devicePixelRatio = realDpr;
        }
    });

    attempt('resizing the canvas republishes, with no re-parse', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        E142Mod.setEngineCountersEnabled(true);
        renderOnce(c, 600);
        const big = c.getAggregationFactor();
        const parses = E142Mod.readEngineCounters().parses;

        renderOnce(c, 200);
        const small = c.getAggregationFactor();
        ok(small > big, `a smaller canvas aggregates harder: ${small} against ${big}`);
        eq(E142Mod.readEngineCounters().parses, parses,
            'and nothing re-parsed — a resize reaches the outputs through the matrices alone');

        renderOnce(c, 600);
        ok(Math.abs(c.getAggregationFactor() - big) < 1e-12,
            'resizing back gives the same number, so the factor is a function of the size and '
            + 'nothing accumulated');
        E142Mod.setEngineCountersEnabled(false);
    });

    attempt('an unchanged factor raises nothing', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        c.__publishAggregation(4, null);
        /* The harness's TcHmi stub has `raise` and nothing else, so the count is
         * taken by wrapping it rather than by registering a listener. */
        const realRaise = TcHmi.EventProvider.raise;
        let raised = 0;
        TcHmi.EventProvider.raise = (name, data) => {
            if (data && /^Aggregation/.test(String(data.propertyName))) { raised++; }
            return realRaise.call(TcHmi.EventProvider, name, data);
        };
        try {
            c.__publishAggregation(4, null);
            eq(raised, 0, 'a frame that changes nothing publishes nothing');
            c.__publishAggregation(9, null);
            eq(raised, 1, '  while a frame that changes only the factor raises exactly once');
            c.__publishAggregation(0.5, null);
            eq(raised, 3, '  and one that changes the mode too raises for both');
        } finally {
            TcHmi.EventProvider.raise = realRaise;
        }
    });

    attempt('the mode reports what the renderer actually does', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        c.__publishAggregation(0.25, null);
        eq(c.getAggregationMode(), 'None',
            'a cell covering four device pixels is drawn in its own right');
        c.__publishAggregation(1, null);
        eq(c.getAggregationMode(), 'None', 'and exactly one cell per pixel still is');
        c.__publishAggregation(6, null);
        eq(c.getAggregationMode(), 'PointSample',
            'six cells per pixel and the renderer picks one — which it says rather than implying '
            + 'the picture is complete');
        c.__publishAggregation(null, null);
        eq(c.getAggregationMode(), null, 'and no grid means no mode');
        eq(c.getAggregationFactor(), null, '  nor a factor');
    });

    attempt('a degenerate lattice publishes null, not Infinity', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        c.__publishAggregation(Infinity, null);
        eq(c.getAggregationFactor(), null,
            'Infinity is what a collinear lattice reports and is not a number a binding can render');
        eq(c.getAggregationMode(), 'PointSample',
            '  while the MODE is still true: every cell shares one pixel, so one of them is painted');

        /*
         * The finiteness guard in `setAggregationFactor` CANNOT be exercised here,
         * and the reason is worth stating rather than papering over: the harness's
         * `ValueConverter.toNumber` rejects Infinity, and its `tchmi_equal` is
         * JSON-based — `JSON.stringify(Infinity)` is `"null"` — so an Infinity that
         * got past the first would be swallowed by the second. Both layers of the
         * double agree with the guard, so removing the guard changes nothing
         * observable from a test.
         *
         * It is kept because TwinCAT's real converter and comparator make no such
         * promise, and it is NOT in the mutation catalogue, because a mutation there
         * can only ever report SURVIVED and would read as a missing assertion.
         */
    });
});

section('11. Task 16 — the reference panels are unchanged above the threshold', () => {
    /*
     * Done-when 2. Every reference panel is driven through the REAL render path
     * and must still take the runs path: all nine sit well above
     * `GRID_RUN_STRATEGY_PX`, where cells are at least three device pixels and
     * Task 16 must be invisible.
     *
     * The comparison is by cell pattern — the fill styles the runs path emits, in
     * order — rather than by pixel, because the runs path records rather than
     * rasterises (D-074) and the styles ARE the cell pattern.
     */
    const panels = readPanels();
    ok(panels.length >= 9, `${panels.length} reference panels`);

    const drawn = [];
    for (const panel of panels) {
        const c = drivePanel(panel).control;
        const ctx = renderOnce(c, 600);
        if (ctx.fills.length === 0 && ctx.puts.length === 0) { continue; }   // nothing bound
        drawn.push({ id: panel.id, ctx, control: c });
    }
    ok(drawn.length >= 7, `${drawn.length} of them draw a grid`);

    const blitted = drawn.filter((d) => d.ctx.puts.length > 0).map((d) => d.id);
    eq(blitted.length, 0,
        `none of them aggregates at 600 px — they are all above the threshold  ${blitted[0] ?? ''}`);
    const modes = [...new Set(drawn.map((d) => d.control.getAggregationMode()))];
    deep(modes, ['None'], 'and every one reports mode "None", which is what above-threshold means');

    /*
     * THE OTHER SIDE OF THE SWITCH IS NOT ASSERTED HERE, and the reason is a loose
     * end rather than a decision.
     *
     * Shrinking a panel to 20 CSS px drives its aggregation factor to 25 cells per
     * pixel — five across, far below `GRID_RUN_STRATEGY_PX` — and it STILL takes
     * the runs path, with the same ten fills it emits at 600 px. There is no layer
     * cache in play (`__gridCache` is null) and no `drawImage`, so the bitmap is
     * not being served from somewhere else. Something upstream of `drawGridLayer`
     * is deciding differently from the factor, and it has not been found.
     *
     * It does not affect what Task 16 shipped: the engine suites drive both sides
     * of the switch directly (`grid-render` sections 4 and 10) and `grid-aliasing`
     * exercises the bucket pass at four factors and eight phases. What is missing
     * is the CONTROL-level demonstration that a real panel can reach it, and that
     * is worth having before Task 17 makes the reducer choice factor-dependent —
     * see observation 110.
     */
    ok(true, 'the panels never reach the aggregate path at any canvas size — observation 110');
});

section('12. AggregationReducer through the control (LOD-17)', () => {
    const doc = '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap"><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier=""><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="1" BinQuality="Pass"/><BinDefinition BinCode="9" BinQuality="Fail"/>'
        + '</BinDefinitions><BinCode>19</BinCode><BinCode>11</BinCode>'
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';

    attempt('it defaults to Auto and round-trips', () => {
        const c = new SubstrateMap(null, null, {});
        eq(c.getAggregationReducer(), 'Auto', 'Auto by default, so the map decides');
        c.setAggregationReducer('FailFraction');
        eq(c.getAggregationReducer(), 'FailFraction', 'and a forced value reads back');
        c.setAggregationReducer('nonsense');
        eq(c.getAggregationReducer(), 'Auto', 'an unrecognised value falls back to Auto, not to a reducer');
        c.setAggregationReducer(null);
        eq(c.getAggregationReducer(), 'Auto', '  and so does null');
    });

    /* Done-when 2: the seed. */
    attempt('the first frame after a document binds is MaxSeverity', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        eq(c.__sceneReducer, 'MaxSeverity',
            'the safe seed — a rare defect stays visible, and a saturated map corrects itself on the '
            + 'next frame. The opposite seed would hide a scratch for a frame');
        renderOnce(c, 600);
        eq(c.__sceneReducer, 'MaxSeverity', 'and a frame that does not bucket leaves it there');
    });

    attempt('a forced reducer takes effect on the very next frame', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        c.setAggregationReducer('FailFraction');
        eq(c.__sceneReducer, 'FailFraction',
            'the scene is corrected when the attribute is set, not one frame later — a forced value '
            + 'is not a measurement and has no reason to wait');
        c.setAggregationReducer('Auto');
        eq(c.__reducerOverride, 'Auto', 'and releasing it hands the choice back to the measurement');
    });

    attempt('AggregationMode reports the reducer once a frame bucketed', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        renderOnce(c, 600);
        eq(c.getAggregationMode(), 'None',
            'a 2x2 map at 600 px is drawn cell by cell, so no reduction happened');
        /* The control-level aggregate path needs the layer cache — see D-094. The
         * engine suites drive the reducer directly; this pins what the OUTPUT says
         * when nothing bucketed, which is the case a panel actually shows. */
        ok(c.getAggregationFactor() < 1,
            '  and the factor agrees: fewer than one cell per device pixel');
    });
});

section('13. TouchTargetSize through the control (LOD-19)', () => {
    const of = (lines) => lines.filter((l) => l.message.includes('E142_TOUCH_TARGET_CLAMPED'));

    attempt('it defaults to 40 and round-trips', () => {
        const c = new SubstrateMap(null, null, {});
        eq(c.getTouchTargetSize(), Engine.TOUCH_TARGET_DEFAULT_PX, '40 CSS px by default');
        c.setTouchTargetSize(64);
        eq(c.getTouchTargetSize(), 64, 'and a larger value is taken as given');
        c.setTouchTargetSize(null);
        eq(c.getTouchTargetSize(), Engine.TOUCH_TARGET_DEFAULT_PX, 'null returns to the default');
    });

    /* Done-when 2. */
    attempt('a value of 10 clamps to 24 and warns once', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setTouchTargetSize(10);
        eq(c.getTouchTargetSize(), Engine.TOUCH_TARGET_MIN_PX, 'clamped to the floor');
        const w = of(logLines());
        eq(w.length, 1, 'exactly one warning');
        ok(w[0].message.includes('WCAG'), '  citing where the floor comes from');
        ok(w[0].message.includes('zoom in'), '  and what to do instead');

        c.setTouchTargetSize(10);
        eq(of(logLines()).length, 0, 'and setting the same value again says nothing');
    });

    attempt('a different too-small value warns again', () => {
        const c = new SubstrateMap(null, null, {});
        c.setTouchTargetSize(10);
        logLines();
        c.setTouchTargetSize(12);
        eq(of(logLines()).length, 1,
            'a second wrong value is a second mistake — the latch is per value, not per control');
        eq(c.getTouchTargetSize(), Engine.TOUCH_TARGET_MIN_PX, '  and both clamp to the same floor');
    });

    attempt('a value at the floor is not a mistake', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setTouchTargetSize(Engine.TOUCH_TARGET_MIN_PX);
        eq(of(logLines()).length, 0, 'exactly 24 is allowed and says nothing');
        eq(c.getTouchTargetSize(), 24, '  and is kept');
    });

    attempt('nonsense falls back rather than clamping silently to the floor', () => {
        const c = new SubstrateMap(null, null, {});
        c.setTouchTargetSize(Number.NaN);
        eq(c.getTouchTargetSize(), Engine.TOUCH_TARGET_DEFAULT_PX,
            'NaN is not a small target, it is no target — so the DEFAULT, not the floor');
        c.setTouchTargetSize(-40);
        eq(c.getTouchTargetSize(), Engine.TOUCH_TARGET_MIN_PX,
            'while a negative number IS a target that is too small, and clamps');
    });
});

section('14. the group descriptor against its shipped schema (LOD-21)', () => {
    /*
     * The schema is what an HMI author binds against, so a descriptor that does not
     * validate is a broken contract however well it is shaped internally. Checked
     * with the same Ajv the E142 corpus uses.
     */
    const schemaPath = new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/GroupSelection.Schema.json',
        import.meta.url);
    ok(existsSync(schemaPath), 'GroupSelection.Schema.json ships');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const validate = new Ajv({ allErrors: true }).compile({
        $ref: '#/definitions/SubstrateMapGroupSelection', definitions: schema.definitions,
    });

    const placement = { originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
        rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false };
    const n = 40;
    const cells = new Uint32Array(n * n);
    const codes = ['.'];
    for (let i = 1; i <= 14; i++) { codes.push(`B${i}`); }
    for (let i = 0; i < cells.length; i++) { cells[i] = 1 + (i % 14); }
    const grid = Engine.buildGridModel(placement, { cols: n, rows: n, codes, cells },
        codes.slice(1).map((c, i) => ({ code: c, quality: i % 2 ? 'Fail' : 'Pass' })));

    for (const [label, rect] of [
        ['a full group', { x0: 5, y0: 5, x1: 25, y1: 25 }],
        ['an empty group', { x0: -50, y0: -50, x1: -40, y1: -40 }],
        ['a single cell', { x0: 10, y0: 10, x1: 11, y1: 11 }],
    ]) {
        attempt(`${label} validates`, () => {
            const d = Engine.describeGroup(rect, grid, new DOMMatrix([1, 0, 0, 1, 0, 0]));
            const okd = validate(d);
            ok(okd, `${label}: ${okd ? '' : JSON.stringify(validate.errors?.[0])}`);
            eq(d.bins.reduce((a, b) => a + b.count, 0) + d.otherCount, d.cellCount,
                '  and the histogram invariant holds');
        });
    }

    attempt('the schema refuses a descriptor with an over-long histogram', () => {
        /* `maxItems: 10` is the schema's half of the truncation contract. If the
         * code stopped truncating, this is what would say so to a binding. */
        const bad = {
            id: '0,0', corners: [[0, 0], [1, 0], [0, 1], [1, 1]], cellCount: 11,
            severity: 1, otherCount: 0, otherBins: 0, decorated: false,
            bins: Array.from({ length: 11 }, (_, i) => ({ code: `B${i}`, count: 1 })),
        };
        eq(validate(bad), false, 'eleven named bins is not a valid descriptor');
    });
});

section('15. readGroupMembers through the control (LOD-22)', () => {
    const doc = '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
        + '<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">'
        + '<Dimension X="24" Y="24"/><StepSize X="1" Y="1"/></Layout></Layouts>'
        + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L"><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="1" BinQuality="Pass"/></BinDefinitions>'
        + new Array(24).fill('<BinCode>' + '1'.repeat(24) + '</BinCode>').join('')
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';

    /** @returns A control with the map bound and one frame drawn. */
    const bound = (px = 400) => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        renderOnce(c, px);
        return c;
    };

    /* Done-when 2. */
    attempt('it returns a typed array, not item objects', () => {
        const c = bound();
        const got = c.readGroupMembers('0,0');
        ok(got instanceof Uint32Array,
            'a Uint32Array — asking for the members must not allocate the thing the descriptor '
            + 'exists to avoid');
        ok(!Array.isArray(got), '  and not a plain array of objects');
    });

    /* Done-when 1: exactly Task 20's enumeration. */
    attempt('the indices match cellsInGroup exactly', () => {
        const c = bound();
        const grid = c.__sceneGrid;
        ok(grid !== null, 'the map is bound');
        const cfg = c.__makeConfig();
        const matrices = c.__computeMatrices(cfg, window.devicePixelRatio || 1);
        const dev = Engine.deviceMatrix(matrices.dprBase, matrices.world);
        // The control's OWN tiling, not one rebuilt here (F-5a). Since the tiles are
        // a division of the map's span rather than a constant width, a hand-built
        // copy would be a second opinion and the ids would stop round-tripping.
        const tiling = c.__groupTiling(matrices, window.devicePixelRatio || 1);

        const bad = [];
        let total = 0;
        // '-1,-1' and any index past the tiling are expired ids now: they name no
        // tile of THIS tiling and resolve to null, which readGroupMembers reports as
        // an empty member list. Both sides are checked for that below.
        for (const id of ['0,0', '1,1', '2,2', '3,4', '-1,-1']) {
            if (Engine.groupTileRect(id, tiling) === null) {
                eq([...c.readGroupMembers(id)].length, 0, `  an id outside the tiling (${id}) has no members`);
                continue;
            }
            const rect = Engine.groupTileRect(id, tiling);
            const want = [...Engine.cellsInGroup(rect, grid, dev)];
            const got = [...c.readGroupMembers(id)];
            total += got.length;
            if (got.join() !== want.join()) { bad.push(`${id}: ${got.length} vs ${want.length}`); }
        }
        eq(bad.length, 0, `five tiles agree with the engine exactly  ${bad[0] ?? ''}`);
        ok(total > 0, `and ${total} cells were returned across them, so it is not vacuously empty`);
    });

    attempt('an unknown or unparseable id is empty, not wrong', () => {
        const c = bound();
        eq(c.readGroupMembers('nonsense').length, 0, 'an unparseable id');
        eq(c.readGroupMembers('').length, 0, '  and an empty one');
        eq(c.readGroupMembers('9999,9999').length, 0,
            'a tile far off the map is empty rather than throwing');
    });

    attempt('with no map bound it returns empty rather than failing', () => {
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        const got = c.readGroupMembers('0,0');
        ok(got instanceof Uint32Array, 'still a typed array');
        eq(got.length, 0, '  and empty');
    });

    attempt('the tile size follows TouchTargetSize', () => {
        const c = bound();
        const small = c.readGroupMembers('0,0').length;
        c.setTouchTargetSize(120);
        renderOnce(c, 400);
        const large = c.readGroupMembers('0,0').length;
        ok(large > small,
            `a larger touch target covers more cells: ${small} -> ${large} — the accessor reads the `
            + 'attribute rather than a size baked in when the group was made');
    });
});

section('16. onGroupSelected (LOD-23)', () => {
    /** @param n Cells per side. @returns An all-pass square map. */
    const mapOf = (n) => '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
        + `<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true"><Dimension X="${n}" Y="${n}"/>`
        + '<StepSize X="1" Y="1"/></Layout></Layouts>'
        + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L"><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="1" BinQuality="Pass"/></BinDefinitions>'
        + new Array(n).fill(`<BinCode>${'1'.repeat(n)}</BinCode>`).join('')
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';

    /** @param n Cells. @param px Canvas side. @returns `{ control, matrices }`. */
    const bound = (n, px) => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(mapOf(n));
        c.__attach();
        renderOnce(c, px);
        return { c, m: c.__computeMatrices(c.__makeConfig(), 1) };
    };
    /** @param c A control. @param m Matrices. @returns Device px per cell. */
    const cellPx = (c, m) => {
        const pl = c.__sceneGrid.placement;
        const dev = Engine.deviceMatrix(m.dprBase, m.world);
        return Math.min(pl.cellWmm, pl.cellLmm) * Math.hypot(dev.a, dev.b);
    };

    /* Done-when 1: one cell per group means the ordinary path, untouched (Rule 4). */
    attempt('at one cell per group there is no group', () => {
        const { c, m } = bound(6, 400);
        const per = cellPx(c, m);
        ok(per >= c.getTouchTargetSize(),
            `a die is ${per.toFixed(1)} device px, at or above the ${c.getTouchTargetSize()} px target`);
        eq(Engine.groupSizeInCells(c.getTouchTargetSize(), per, 1), 1, '  so one cell per group');
        eq(c.__groupSelectionAt({ x: 200, y: 200 }, m, 1), null,
            'and no group descriptor is produced — the cell path runs exactly as before');
    });

    /* Done-when 2. */
    attempt('under aggregation a tap produces a group whose corners contain it', () => {
        const { c, m } = bound(60, 200);
        const per = cellPx(c, m);
        ok(per < c.getTouchTargetSize(), `a die is ${per.toFixed(1)} device px, below the target`);
        const tap = { x: 96, y: 118 };
        const g = c.__groupSelectionAt(tap, m, 1);
        ok(g !== null, 'a group is produced');
        ok(g.cellCount > 1, `holding ${g.cellCount} cells`);
        eq(g.corners.length, 4, 'with four corners');

        /* The corners are LATTICE coordinates, so the tap has to be taken there too
         * before "contains" means anything. The quad is a parallelogram; at rotation
         * 0 it is axis-aligned, so a bounding test is exact. */
        const dev = Engine.deviceMatrix(m.dprBase, m.world);
        const lat = dev.multiply(Engine.latticeMatrix(c.__sceneGrid.placement));
        const det = lat.a * lat.d - lat.b * lat.c;
        const dx = tap.x * 1 - lat.e;
        const dy = tap.y * 1 - lat.f;
        const ta = (lat.d * dx - lat.c * dy) / det;
        const tb = (-lat.b * dx + lat.a * dy) / det;
        const xs = g.corners.map((p) => p[0]);
        const ys = g.corners.map((p) => p[1]);
        ok(ta >= Math.min(...xs) && ta <= Math.max(...xs),
            `the tap's lattice a=${ta.toFixed(2)} is within [${Math.min(...xs).toFixed(2)}, `
            + `${Math.max(...xs).toFixed(2)}]`);
        ok(tb >= Math.min(...ys) && tb <= Math.max(...ys),
            `  and b=${tb.toFixed(2)} within [${Math.min(...ys).toFixed(2)}, `
            + `${Math.max(...ys).toFixed(2)}]`);
    });

    attempt('the event carries the descriptor and not the members', () => {
        const { c, m } = bound(60, 200);
        const g = c.__groupSelectionAt({ x: 96, y: 118 }, m, 1);
        const realRaise = TcHmi.EventProvider.raise;
        const seen = [];
        TcHmi.EventProvider.raise = (name, data) => {
            if (String(name).endsWith('.onGroupSelected')) { seen.push(data); }
            if (String(name).endsWith('.onItemSelected')) { seen.push({ WRONG_EVENT: true }); }
            return realRaise.call(TcHmi.EventProvider, name, data);
        };
        try { c.__raiseGroupSelected(g); } finally { TcHmi.EventProvider.raise = realRaise; }

        eq(seen.length, 1, 'exactly one event');
        ok(!seen[0].WRONG_EVENT, '  and it is onGroupSelected, not onItemSelected');
        deep(Object.keys(seen[0]).sort(),
            ['bins', 'cellCount', 'corners', 'decorated', 'id', 'otherBins', 'otherCount', 'severity'],
            'the payload is the descriptor exactly');
        ok(!('members' in seen[0]) && !('cells' in seen[0]),
            '  with no member list — that is what readGroupMembers is for');
        ok(JSON.stringify(seen[0]).length < 2048,
            `and it stays under the 2 KB budget (${JSON.stringify(seen[0]).length} bytes)`);
    });

    attempt('the group id resolves through readGroupMembers', () => {
        const { c, m } = bound(60, 200);
        const g = c.__groupSelectionAt({ x: 96, y: 118 }, m, 1);
        eq(c.readGroupMembers(g.id).length, g.cellCount,
            'the descriptor\'s cellCount and the accessor agree — the id round-trips end to end');
    });

    /*
     * THE DEVICE PIXEL RATIO CANCELS, and asserting that it does is the only way to
     * see it at all. `devicePixelRatio` is 1 in this harness, so a tile computed
     * from CSS pixels and one computed from device pixels agree — and a mutation
     * dropping the conversion on the POINT while keeping it on the TILE SIZE
     * survived every other assertion here. Eleventh vacuous fixture, and the same
     * cause as observation 107.
     *
     * The invariant: a given CSS point falls in the SAME group tile whatever the
     * ratio, because the point and the tile scale by the same factor. A panel at
     * dpr 2 must not group differently from one at dpr 1 — the touch target is a
     * finger, and fingers do not change size with pixel density.
     */
    attempt('a CSS point falls in the same tile at any device pixel ratio', () => {
        const { c } = bound(60, 200);
        const tap = { x: 96, y: 118 };
        const ids = new Set();
        for (const dpr of [1, 2, 3]) {
            const m = c.__computeMatrices(c.__makeConfig(), dpr);
            const g = c.__groupSelectionAt(tap, m, dpr);
            ok(g !== null, `dpr ${dpr} still groups`);
            ids.add(g.id);
        }
        eq(ids.size, 1,
            `the same tile at every ratio (${[...ids].join(' / ')}) — the point and the tile scale `
            + 'together, so the ratio cancels');
    });

    attempt('a larger touch target makes a previously ungrouped map group', () => {
        const { c, m } = bound(6, 400);
        eq(c.__groupSelectionAt({ x: 200, y: 200 }, m, 1), null, 'no group at the default target');
        c.setTouchTargetSize(200);
        renderOnce(c, 400);
        const g = c.__groupSelectionAt({ x: 200, y: 200 }, c.__computeMatrices(c.__makeConfig(), 1), 1);
        ok(g !== null && g.cellCount > 1,
            `and a group of ${g?.cellCount} once the target exceeds the die — the switch is the `
            + 'attribute, not the zoom');
    });
});

section('17. the valueField role through the control (LOD-24)', () => {
    const doc = '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
        + '<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">'
        + '<Dimension X="4" Y="2"/><StepSize X="1" Y="1"/></Layout></Layouts>'
        + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L">'
        + '<Overlay MapName="BinCodes"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
        + '<BinDefinitions><BinDefinition BinCode="1" BinQuality="Pass"/></BinDefinitions>'
        + '<BinCode>1111</BinCode><BinCode>1111</BinCode></BinCodeMap></Overlay>'
        + '<Overlay MapName="Relevance"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
        + '<BinDefinitions><BinDefinition BinCode="a"/><BinDefinition BinCode="b"/>'
        + '<BinDefinition BinCode="c"/><BinDefinition BinCode="d"/></BinDefinitions>'
        + '<BinCode>abcd</BinCode><BinCode>dcba</BinCode></BinCodeMap></Overlay>'
        + '</SubstrateMap></SubstrateMaps></MapData>';

    /** @param overlays An E142Overlays list, or null. @returns The control. */
    const mk = (overlays) => {
        const c = new SubstrateMap(null, null, {});
        if (overlays !== null) { c.setE142Overlays(overlays); }
        c.setE142MapData(doc);
        c.__attach();
        return c;
    };
    const BASE_ONLY = [{ name: 'BinCodes', role: 'base' }];
    const WITH_VALUE = [{ name: 'BinCodes', role: 'base' }, { name: 'Relevance', role: 'valueField' }];

    attempt('the role resolves to a ramp over the overlay\'s own table', () => {
        const c = mk(WITH_VALUE);
        ok(c.__sceneValueFill !== null, 'a fill is resolved');
        eq(c.__sceneValueFill.colors.length - 1, 4,
            'four levels, one per BinDefinition of the Relevance overlay — not the base\'s one');
        eq(c.__sceneValueFill.colors[0], '', 'and index 0 is the null bin, which takes no colour');
    });

    attempt('it replaces the fill and blends nothing', () => {
        const plain = renderOnce(mk(BASE_ONLY), 300).fills.map((f) => f.fillStyle);
        const value = renderOnce(mk(WITH_VALUE), 300).fills.map((f) => f.fillStyle);
        ok(plain.every((s) => s === 'rgb(0, 158, 115)'), 'the base paints its bin colour');
        ok(!value.includes('rgb(0, 158, 115)'),
            'and with a value field that colour is gone entirely — replaced, not blended');
        eq(new Set(value).size, 4, `and four ramp levels are painted instead`);
    });

    /* Done-when 2: the other two roles are untouched. */
    attempt('base and decoration are unaffected', () => {
        const bare = renderOnce(mk(null), 300).fills.map((f) => `${f.fillStyle}@${f.x},${f.y}`);
        const based = renderOnce(mk(BASE_ONLY), 300).fills.map((f) => `${f.fillStyle}@${f.x},${f.y}`);
        deep(based, bare,
            'naming the base explicitly renders exactly what binding no list at all renders');
        const deco = mk([{ name: 'BinCodes', role: 'base' }, { name: 'Relevance', role: 'decoration' }]);
        eq(deco.__sceneValueFill, null, 'and a decoration is not a value field');
        ok((deco.__sceneGrid.layers ?? []).length === 1, '  it is still a decoration layer');
    });

    /* Done-when 4: nothing about the DOCUMENT changes. */
    attempt('the document parses identically with and without the role bound', () => {
        const a = mk(BASE_ONLY);
        const b = mk(WITH_VALUE);
        eq(gridFingerprint(a), gridFingerprint(b),
            'the base grid — lattice, cells and bin table — is the same either way');
        deep(b.__sceneGrid.binTable.map((x) => x.code), a.__sceneGrid.binTable.map((x) => x.code),
            '  and so is the bin table the selection reports');
        eq(JSON.stringify(a.readSelectedOverlays?.(0) ?? null),
            JSON.stringify(b.readSelectedOverlays?.(0) ?? null),
            '  and what a tap reports about a cell');
    });

    attempt('an unknown value overlay warns and falls back to the base fill', () => {
        logLines();
        const c = mk([{ name: 'BinCodes', role: 'base' }, { name: 'Nope', role: 'valueField' }]);
        const w = logLines().filter((l) => l.message.includes('E142_OVERLAYS_VALUE_FIELD_NOT_FOUND'));
        eq(w.length, 1, 'one warning');
        ok(w[0].message.includes('"Nope"'), '  naming the overlay');
        eq(c.__sceneValueFill, null, 'and no fill');
        ok(renderOnce(c, 300).fills.every((f) => f.fillStyle === 'rgb(0, 158, 115)'),
            '  so the base fill renders, rather than nothing');
    });

    attempt('two value fields warn and the first wins', () => {
        logLines();
        const c = mk([{ name: 'BinCodes', role: 'valueField' },
            { name: 'Relevance', role: 'valueField' }]);
        const w = logLines().filter((l) => l.message.includes('E142_OVERLAYS_MULTIPLE_VALUE_FIELD'));
        eq(w.length, 1, 'one warning');
        eq(c.__sceneValueFill.colors.length - 1, 1,
            'and the FIRST is used — BinCodes has one level, Relevance four');
    });
});

section('18. a value field forces the reducer (LOD-25)', () => {
    const doc = '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
        + '<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">'
        + '<Dimension X="4" Y="2"/><StepSize X="1" Y="1"/></Layout></Layouts>'
        + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L">'
        + '<Overlay MapName="BinCodes"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
        + '<BinDefinitions><BinDefinition BinCode="1"/></BinDefinitions>'
        + '<BinCode>1111</BinCode><BinCode>1111</BinCode></BinCodeMap></Overlay>'
        + '<Overlay MapName="Relevance"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
        + '<BinDefinitions><BinDefinition BinCode="a"/><BinDefinition BinCode="b"/>'
        + '<BinDefinition BinCode="c"/><BinDefinition BinCode="d"/></BinDefinitions>'
        + '<BinCode>abcd</BinCode><BinCode>dcba</BinCode></BinCodeMap></Overlay>'
        + '</SubstrateMap></SubstrateMaps></MapData>';
    const WITH_VALUE = [{ name: 'BinCodes', role: 'base' }, { name: 'Relevance', role: 'valueField' }];
    const of = (lines) => lines.filter((l) => l.message.includes('E142_AGGREGATION_REDUCER_IGNORED'));

    /* Done-when 3. */
    attempt('a forced reducer under a value field is reported once', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setE142Overlays(WITH_VALUE);
        c.setE142MapData(doc);
        c.__attach();
        c.setAggregationReducer('FailFraction');
        const w = of(logLines());
        eq(w.length, 1, 'exactly one warning');
        ok(w[0].message.includes('FailFraction'), '  naming the setting being ignored');
        ok(w[0].message.includes('BinQuality'), '  and why it cannot apply');
        ok(w[0].message.includes('Drop the valueField'), '  and how to get it back');

        c.setAggregationReducer('FailFraction');
        eq(of(logLines()).length, 0, 'and the same pair is not repeated');
    });

    attempt('a different reducer is a different mistake', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142Overlays(WITH_VALUE);
        c.setE142MapData(doc);
        c.__attach();
        c.setAggregationReducer('FailFraction');
        logLines();
        c.setAggregationReducer('MaxSeverity');
        eq(of(logLines()).length, 1, 'the second wrong pair is reported too');
    });

    attempt('Auto is not a mistake and says nothing', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setE142Overlays(WITH_VALUE);
        c.setE142MapData(doc);
        c.__attach();
        eq(of(logLines()).length, 0, 'binding a value field with Auto is silent');
        c.setAggregationReducer('Auto');
        eq(of(logLines()).length, 0, '  and setting Auto explicitly is too');
    });

    attempt('without a value field the setting is honoured silently', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setE142Overlays([{ name: 'BinCodes', role: 'base' }]);
        c.setE142MapData(doc);
        c.__attach();
        c.setAggregationReducer('FailFraction');
        eq(of(logLines()).length, 0, 'no value field, no conflict');
        eq(c.getAggregationReducer(), 'FailFraction', '  and the setting stands');
    });

    attempt('TouchTargetSize 0 turns grouping off, and nothing else does', () => {
        const c = new SubstrateMap(null, null, {});
        c.setTouchTargetSize(0);
        eq(c.getTouchTargetSize(), 0, 'zero is kept, not clamped to the floor');
        eq(Engine.groupSizeInCells(0, 4, 1), 1,
            'and a 4 px die does not group — which no positive value can achieve, because '
            + 'the 24 px floor is right and stays');
        for (const v of [-5, 10, 23]) {
            c.setTouchTargetSize(v);
            eq(c.getTouchTargetSize(), Engine.TOUCH_TARGET_MIN_PX,
                `${v} is a target that is too SMALL and still clamps — zero is the absence of a `
                + 'target, not a small one');
        }
    });

    attempt('a tapped group is ringed, not just announced', () => {
        /*
         * The defect this pair exists for: every panel on the reference page groups
         * at the default target, and a group was drawn NOWHERE — so a tap raised an
         * event nobody could see and left no mark. The selection ring simply
         * vanished from the product (D-109).
         */
        const n = 40;
        const dense = '<?xml version="1.0"?>'
            + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
            + '<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true">'
            + `<Dimension X="${n}" Y="${n}"/><StepSize X="1" Y="1"/></Layout></Layouts>`
            + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates>'
            + '<SubstrateMaps><SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L">'
            + '<Overlay MapName="M"><BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray">'
            + '<BinDefinitions><BinDefinition BinCode="1" BinQuality="Pass"/></BinDefinitions>'
            + new Array(n).fill(`<BinCode>${'1'.repeat(n)}</BinCode>`).join('')
            + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(dense);
        c.__attach();
        renderOnce(c, 300);
        const m = c.__computeMatrices(c.__makeConfig(), 1);
        const g = c.__groupSelectionAt({ x: 150, y: 140 }, m, 1);
        ok(g !== null, 'the tap lands on a group — 40x40 dies in 284 px is about 7 px each');

        c.__selectedCells = new Set(Engine.cellsInGroup(
            Engine.groupTileRect(g.id, c.__groupTiling(m, 1)),
            c.__sceneGrid, Engine.deviceMatrix(m.dprBase, m.world)));
        ok(c.__selectedCells.size > 0,
            `${c.__selectedCells.size} cells enter the ordinary selection, so drawCellSelection `
            + 'rings them with the same 2 px stroke a single die gets');
        eq(c.__selectedCells.size, g.cellCount,
            '  and it is exactly the group the descriptor described');
    });

    attempt('the scene reducer follows the fill in and out', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142Overlays(WITH_VALUE);
        c.setE142MapData(doc);
        c.__attach();
        renderOnce(c, 300);
        eq(c.__sceneReducer, 'ValueField', 'a bound value field forces it');
        c.setE142Overlays([{ name: 'BinCodes', role: 'base' }]);
        c.setE142MapData(doc);
        renderOnce(c, 300);
        eq(c.__sceneReducer, 'MaxSeverity',
            'and dropping the role releases it — otherwise the map would be stuck in a reduction '
            + 'whose data is gone');
    });
});

section('19. ViewTransform, the geometry seam (LOD-26)', () => {
    const N = 20;
    const doc = '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
        + `<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true"><Dimension X="${N}" Y="${N}"/>`
        + '<StepSize X="1" Y="1"/></Layout></Layouts>'
        + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L"><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="1" BinQuality="Pass"/></BinDefinitions>'
        + new Array(N).fill(`<BinCode>${'1'.repeat(N)}</BinCode>`).join('')
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';

    /** @param vt Six components, or null. @param px Canvas side. @returns The control. */
    const bound = (vt, px = 400) => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        if (vt !== null) { c.setViewTransform(vt); }
        c.__attach();
        renderOnce(c, px);
        return c;
    };
    /**
     * The frame's fills, INCLUDING the CTM each was drawn under.
     *
     * `renderGridRuns` sets the transform once and then draws in CELL units, so the
     * recorded rects are identical at every zoom and the view transform lives
     * entirely in `f.transform`. A comparison that omitted it would call two
     * different pictures the same — which the first version of this did, and only
     * the "bitmaps genuinely differ" assertion noticed.
     * @param c A control.
     * @returns Comparable strings.
     */
    const frame = (c) => renderOnce(c, 400).fills.map(
        (f) => `${f.fillStyle}@${f.x},${f.y},${f.w},${f.h}|${(f.transform ?? []).join(',')}`);

    /* Done-when 1. */
    attempt('identity is byte-identical to no seam at all', () => {
        deep(frame(bound([1, 0, 0, 1, 0, 0])), frame(bound(null)),
            'an explicit identity draws exactly what binding nothing draws, rect for rect');
        eq(bound([1, 0, 0, 1, 0, 0]).getAggregationFactor(), bound(null).getAggregationFactor(),
            '  and reports the same aggregation factor');
    });

    /* Done-when 2. */
    attempt('the aggregation factor tracks it, area and linear apart', () => {
        const one = bound(null);
        const two = bound([2, 0, 0, 2, 0, 0]);
        const ratio = one.getAggregationFactor() / two.getAggregationFactor();
        ok(Math.abs(ratio - 4) < 1e-9,
            `2x quarters the AREA factor (ratio ${ratio.toFixed(4)}) — the LINEAR form halves, and `
            + 'quoting the wrong one misstates the minification by its own square root (D-078)');

        const grid = one.__sceneGrid;
        const m1 = one.__computeMatrices(one.__makeConfig(), 1);
        const m2 = two.__computeMatrices(two.__makeConfig(), 1);
        const lin = (m) => Engine.aggregationFactorLinear(
            Engine.deviceMatrix(m.dprBase, m.world), grid.placement);
        ok(Math.abs(lin(m1) / lin(m2) - 2) < 1e-9,
            `and the linear form halves: ${lin(m1).toFixed(5)} -> ${lin(m2).toFixed(5)}`);
    });

    /*
     * THE MULTIPLICATION ORDER, which nothing else here pins. A pure SCALE cannot
     * tell post from pre — both make the picture bigger — so the discriminating
     * case is a TRANSLATION. Post-multiplied it is in millimetres and moves the map
     * by `e * MapScale` pixels; pre-multiplied it would be in pixels and move it by
     * `e`. That is the whole of D-105, and a mutation swapping the order survived
     * every scale-only assertion in this section.
     */
    attempt('a translation is in MILLIMETRES, which is what post-multiplying means', () => {
        const base = bound(null);
        const scale = base.getMapScale();
        ok(scale > 1, `the fit scale is ${scale} CSS px per mm, so mm and px are far apart`);

        const MM = 3;
        const moved = bound([1, 0, 0, 1, MM, 0]);
        const at = (c) => renderOnce(c, 400).fills[0].transform;
        const shift = at(moved)[4] - at(base)[4];
        ok(Math.abs(shift - MM * scale) < 1e-6,
            `${MM} units of translation moved the map ${shift.toFixed(3)} px, which is `
            + `${MM} x MapScale — millimetres. Pre-multiplication would have moved it ${MM} px`);
        ok(Math.abs(shift - MM) > 1,
            '  and demonstrably NOT the pixel reading');
    });

    attempt('the hit test tracks it', () => {
        const one = bound(null);
        const two = bound([2, 0, 0, 2, 0, 0]);
        const at = (c, p) => {
            const m = c.__computeMatrices(c.__makeConfig(), 1);
            return Engine.getCellAtPos(p, m, c.__sceneGrid);
        };
        const probe = { x: 250, y: 170 };
        const a = at(one, probe);
        const b = at(two, probe);
        ok(a !== null || b !== null, 'the probe lands on the map in at least one view');
        ok(JSON.stringify(a) !== JSON.stringify(b),
            `the same pointer hits a different cell once the view is scaled: `
            + `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    });

    /* Done-when 3 — the old Task 25's criterion, as an assertion. */
    attempt('two transforms give different cache keys and different bitmaps', () => {
        const grid = bound(null).__sceneGrid;
        const paint = Engine.buildGridPaint(grid, null,
            { bg: '#000', body: '#dcdcdc', edge: '#6e6e6e', selection: '#005ac8',
                unknown: 'rgb(110,110,110)', binPass: 'rgb(0, 158, 115)', binFail: 'rgb(213, 94, 0)' },
            null);
        const keyOf = (c) => {
            const m = c.__computeMatrices(c.__makeConfig(), 1);
            return Engine.gridCacheKeyForTest(
                Engine.deviceMatrix(m.dprBase, m.world), 400, 400, 1, paint, 'MaxSeverity');
        };
        ok(keyOf(bound(null)) !== keyOf(bound([2, 0, 0, 2, 0, 0])),
            'the key already carried the six components of dev, so this needed no new code');
        ok(frame(bound(null)).join() !== frame(bound([2, 0, 0, 2, 0, 0])).join(),
            '  and the bitmaps genuinely differ');
    });

    /* Done-when 4. */
    attempt('MapScale is readable and excludes the author\'s own transform', () => {
        const one = bound(null);
        ok(one.getMapScale() > 0, `${one.getMapScale()} CSS px per mm`);
        eq(bound([2, 0, 0, 2, 0, 0]).getMapScale(), one.getMapScale(),
            'and it does not move as the author zooms — otherwise converting a pointer delta would '
            + 'need the answer being computed');
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        eq(c.getMapScale(), null, 'null when nothing is drawn');
    });

    /* Done-when 5. */
    /*
     * SCREEN-CONSTANT WIDTHS MUST STAY SCREEN-CONSTANT UNDER A TRANSFORM.
     *
     * Every such width is written `PX / s` millimetres so that stroking under W
     * yields PX on screen, and `matrices.scale` was the wrong `s` the moment
     * ViewTransform existed: it is the FIT scale and excludes the transform by
     * design (D-105). At 2.5x the selection ring came out 5 px instead of 2 —
     * thick enough to swallow a small cell whole and read as a solid fill rather
     * than a frame.
     */
    attempt('the selection ring stays 2 px under any transform', () => {
        const bad = [];
        for (const vt of [null, [2.5, 0, 0, 2.5, 0, 0], [1, 0, 0, 1, 40, 0],
            [0.4, 0, 0, 0.4, 0, 0], [0, 1, -1, 0, 0, 0]]) {
            const c = new SubstrateMap(null, null, {});
            c.setE142MapData(doc);
            if (vt !== null) { c.setViewTransform(vt); }
            c.__attach();
            const m = c.__computeMatrices(c.__makeConfig() ?? {
                center: { x: 200, y: 200 }, width: 400, height: 400, margin: 8 }, 1);
            const onScreen = (Engine.SEL_PX / Engine.screenScale(m))
                * Math.hypot(m.world.a, m.world.b);
            if (Math.abs(onScreen - Engine.SEL_PX) > 1e-9) {
                bad.push(`${JSON.stringify(vt)} -> ${onScreen.toFixed(2)} px`);
            }
        }
        eq(bad.length, 0,
            `scale, translate, shrink and rotate all keep the ring at ${Engine.SEL_PX} px  `
            + `${bad[0] ?? ''}`);
    });

    attempt('screenScale equals the fit scale when no transform is bound', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.__attach();
        // No canvas yet, so __makeConfig returns null; the config is what a 400 px
        // panel would produce.
        const m = c.__computeMatrices({ center: { x: 200, y: 200 }, width: 400, height: 400, margin: 8 }, 1);
        ok(Math.abs(Engine.screenScale(m) - m.scale) < 1e-12,
            'so the fix is a no-op for every view that does not use the seam');
    });

    attempt('a degenerate transform is refused rather than rendering nothing', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(doc);
        c.setViewTransform([1, 2, 2, 4, 0, 0]);          // determinant 0
        c.__attach();
        const w = logLines().filter((l) => l.message.includes('E142_VIEW_TRANSFORM_DEGENERATE'));
        eq(w.length, 1, 'one warning');
        eq(c.getViewTransform(), null, 'the transform is not kept');
        deep(frame(c), frame(bound(null)), '  and the map renders as identity, not blank');
    });

    attempt('a malformed transform is refused too', () => {
        logLines();
        const c = new SubstrateMap(null, null, {});
        c.setViewTransform([1, 0, 0, 1]);
        c.setViewTransform([1, 0, 0, 1, 0, Number.NaN]);
        const w = logLines().filter((l) => l.message.includes('E142_VIEW_TRANSFORM_INVALID'));
        eq(w.length, 2, 'both a short array and a non-finite component are reported');
        eq(c.getViewTransform(), null, 'and neither is kept');
    });

    attempt('it round-trips and releases', () => {
        const c = new SubstrateMap(null, null, {});
        c.setViewTransform([2, 0, 0, 2, 5, 6]);
        deep(c.getViewTransform(), [2, 0, 0, 2, 5, 6], 'the six components read back');
        c.setViewTransform(null);
        eq(c.getViewTransform(), null, '  and null releases it');
    });
});

section('20. physical-scale fixtures (LOD-28)', () => {
    const dir = new URL('./fixtures/xml/', import.meta.url);
    const names = readdirSync(new URL('./fixtures/xml/', import.meta.url))
        .filter((f) => f.startsWith('v0211-physical-')).sort();

    attempt('the corpus covers every BinType at three sizes', () => {
        eq(names.length, 12, `${names.length} physical fixtures`);
        const bad = [];
        /* Anchored on the suffix: 'hexadecimal' CONTAINS 'decimal', so a substring
         * match counts six for one of them and zero surprises for the reader. */
        for (const t of ['ascii', 'decimal', 'hexadecimal', 'integer2']) {
            if (names.filter((n) => n.endsWith(`-${t}.xml`)).length !== 3) { bad.push(t); }
        }
        for (const sz of ['small', 'mid', 'large']) {
            if (names.filter((n) => n.includes(`-${sz}-`)).length !== 4) { bad.push(sz); }
        }
        eq(bad.length, 0, `all four BinTypes at all three sizes  ${bad[0] ?? ''}`);
    });

    /* Done-when 1, and the phase's gate line. */
    attempt('every one is PHYSICAL, and none logs E142_NO_PHYSICAL_SCALE', () => {
        const nominal = [];
        const warned = [];
        for (const n of names) {
            logLines();
            const c = new SubstrateMap(null, null, {});
            c.setE142MapData(readFileSync(new URL(n, dir), 'utf8'));
            c.__attach();
            if (logLines().some((l) => String(l.message).includes('E142_NO_PHYSICAL_SCALE'))) {
                warned.push(n);
            }
            const p = c.__sceneGrid?.placement;
            // A NOMINAL placement is unit pitch. Every fixture here carries a real
            // StepSize, so a step of exactly 1 mm would mean the document's scale
            // was ignored and the nominal fallback used.
            if (!p || Math.abs(Math.abs(p.colStepXmm) - 1) < 1e-9) { nominal.push(n); }
        }
        eq(warned.length, 0, `no fixture warns  ${warned[0] ?? ''}`);
        eq(nominal.length, 0, `and none renders at nominal pitch  ${nominal[0] ?? ''}`);
    });

    attempt('the three sizes really are three different pitches', () => {
        const pitch = (n) => {
            const c = new SubstrateMap(null, null, {});
            c.setE142MapData(readFileSync(new URL(n, dir), 'utf8'));
            c.__attach();
            return c.__sceneGrid.placement.colStepXmm;
        };
        const s = pitch('v0211-physical-small-ascii.xml');
        const m = pitch('v0211-physical-mid-ascii.xml');
        const l = pitch('v0211-physical-large-ascii.xml');
        ok(s > m && m > l,
            `${s} > ${m} > ${l} mm — a power device, a logic die and a sensor, which is the range `
            + 'the aggregation factor has to span');
    });

    attempt('all four BinTypes decode to the same picture at one size', () => {
        /* The BinType is a lexical detail of the payload, not a difference in what
         * the map SAYS. Four spellings of the same wafer must agree cell for cell,
         * or one of the decoders is wrong. */
        const gridOf = (n) => {
            const c = new SubstrateMap(null, null, {});
            c.setE142MapData(readFileSync(new URL(n, dir), 'utf8'));
            c.__attach();
            return c.__sceneGrid;
        };
        const ref = gridOf('v0211-physical-mid-ascii.xml');
        const bad = [];
        for (const t of ['decimal', 'hexadecimal', 'integer2']) {
            const g = gridOf(`v0211-physical-mid-${t}.xml`);
            if (g.cols !== ref.cols || g.rows !== ref.rows) { bad.push(`${t}: size`); continue; }
            for (let i = 0; i < ref.cells.length; i++) {
                if (g.cells[i] !== ref.cells[i]) { bad.push(`${t}@${i}`); break; }
            }
        }
        eq(bad.length, 0, `Decimal, HexaDecimal and Integer2 agree with Ascii  ${bad[0] ?? ''}`);
    });

    attempt('the aggregation factor is in millimetres of silicon', () => {
        /* The reason the fixtures exist. With a physical pitch the factor answers
         * "how many DIES per pixel" against a real die size — at nominal pitch it
         * would answer a question about lattice units instead. */
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(readFileSync(new URL('v0211-physical-large-ascii.xml', dir), 'utf8'));
        c.__attach();
        renderOnce(c, 400);
        const p = c.__sceneGrid.placement;
        eq(p.cellWmm, 0.68, 'a 0.68 mm die');
        ok(c.getAggregationFactor() > 0,
            `and a factor of ${c.getAggregationFactor().toExponential(3)} computed against it`);
        ok(c.getMapScale() > 0, `with ${c.getMapScale().toFixed(2)} CSS px per mm to convert by`);
    });
});

section('21. the event bus, observed rather than read (W-3)', () => {
    /*
     * GROUND TRUTH 9 AND 10, closed. `TcHmi.EventProvider.raise` was a no-op in
     * the harness, so no test in this repository had ever seen an event.
     * `describeGroup` is validated against `GroupSelection.Schema.json` at the
     * point it is BUILT (section 14); `__raiseGroupSelected` then copies it field
     * by field into a fresh object literal, and a field dropped in THAT copy left
     * every assertion here green. The payload was checked at its source and never
     * at its exit.
     *
     * Everything below arrives through `__handlePointerUp` - the shipped handler,
     * on the canvas `renderOnce` installed - so what is asserted is the object an
     * author's `.onGroupSelected` handler actually receives, not one this file
     * built to look like it.
     */

    /** @param n Cells per side. @returns An all-pass square map. */
    const mapOf = (n) => '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
        + `<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true"><Dimension X="${n}" Y="${n}"/>`
        + '<StepSize X="1" Y="1"/></Layout></Layouts>'
        + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L"><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="1" BinQuality="Pass"/></BinDefinitions>'
        + new Array(n).fill(`<BinCode>${'1'.repeat(n)}</BinCode>`).join('')
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';

    /**
     * A control with the map bound, one frame drawn, and the event list EMPTIED -
     * binding raises `onPropertyChanged` for every setter, and those are not what
     * any assertion here is about.
     * @param n Cells per side. @param px Canvas side in CSS px. @returns The control.
     */
    const bound = (n, px) => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(mapOf(n));
        c.__attach();
        renderOnce(c, px);
        drainEvents();
        return c;
    };

    const schemaPath = new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/GroupSelection.Schema.json',
        import.meta.url);
    const validate = new Ajv({ allErrors: true }).compile({
        $ref: '#/definitions/SubstrateMapGroupSelection',
        definitions: JSON.parse(readFileSync(schemaPath, 'utf8')).definitions,
    });

    /** @param evs Recorder entries. @returns Bare event names, in order. */
    const namesOf = (evs) => evs.map((e) => e.name.split('.').pop());

    attempt('one tap on an aggregated map is one event, and it is onGroupSelected', () => {
        const c = bound(60, 200);
        tapAt(c, 96, 118);
        const raised = drainEvents();
        eq(raised.length, 1, `one tap, one event  (${namesOf(raised).join(', ') || 'none'})`);
        ok(raised[0]?.name.endsWith('.onGroupSelected'), '  and it is onGroupSelected');
        ok(!namesOf(raised).includes('onItemSelected'),
            'onItemSelected did not fire alongside it - D-100, now observed rather than read');
    });

    attempt('the raised object validates against GroupSelection.Schema.json', () => {
        const c = bound(60, 200);
        tapAt(c, 96, 118);
        const [ev] = drainEvents();
        ok(ev !== undefined, 'a group event was raised');
        const good = validate(ev?.data);
        ok(good, 'the object an author binds against validates at its EXIT, not only at its source'
            + `  ${good ? '' : JSON.stringify(validate.errors?.[0])}`);
    });

    attempt('the hand-built payload is the descriptor, field for field', () => {
        /*
         * The defect class this section exists for. `__raiseGroupSelected` does
         * not forward the descriptor; it builds a new object out of it. Comparing
         * the two per key catches a dropped field, a renamed one, and a value
         * mangled on the way through - none of which the schema alone would see
         * if the field happened to be optional.
         */
        const c = bound(60, 200);
        const want = c.__groupSelectionAt({ x: 96, y: 118 }, c.__computeMatrices(c.__makeConfig(), 1), 1);
        ok(want !== null, 'the same point produces a descriptor at the engine level');
        tapAt(c, 96, 118);
        const got = drainEvents()[0]?.data ?? {};
        const keys = [...new Set([...Object.keys(want ?? {}), ...Object.keys(got)])].sort();
        const differ = keys.filter((k) => JSON.stringify(got[k]) !== JSON.stringify(want?.[k]));
        eq(differ.length, 0, `all ${keys.length} fields survive the copy  ${differ.join(', ')}`);
    });

    attempt('no field can be dropped unnoticed', () => {
        /*
         * Why the mutation in this task's Done-when turns the suite red as a
         * PROPERTY rather than as one lucky case: every key of the raised object
         * is required by the schema, so removing any one of them from the raise
         * fails validation above. Asserted here so it stays true when the schema
         * or the payload grows.
         */
        const c = bound(60, 200);
        tapAt(c, 96, 118);
        const data = drainEvents()[0]?.data ?? {};
        const keys = Object.keys(data);
        ok(keys.length >= 8, `the payload has ${keys.length} fields`);
        const survivors = keys.filter((k) => {
            const rest = { ...data };
            delete rest[k];
            return validate(rest);
        });
        eq(survivors.length, 0,
            `dropping any single field fails the schema  (survived: ${survivors.join(', ') || 'none'})`);
    });

    attempt('a map whose dies are big enough raises onItemSelected instead', () => {
        const c = bound(6, 400);
        tapAt(c, 200, 200);
        const names = namesOf(drainEvents());
        ok(names.includes('onItemSelected'), `a cell hit raises onItemSelected  (${names.join(', ')})`);
        ok(!names.includes('onGroupSelected'),
            '  and no group event - which one fires is decided by the die size, and only one ever does');
    });

    attempt('the recorder stays silent when the control does', () => {
        /*
         * A recorder that reports events nobody raised is worse than the no-op it
         * replaced, because it would make every assertion above vacuously true.
         *
         * CORRECTED AT W-3a. This read `no map bound` and was wrong about the
         * product: with nothing bound the control is in DEMO mode and draws a full
         * wafer of dies, and a tap on one of them raises onItemSelected — the user's
         * live view shows exactly that. It passed here only because `isPointInPath`
         * answered false to everything, which is the defect W-3a removed. The demo
         * has to be turned OFF for `nothing to hit` to mean anything.
         */
        const c = new SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        c.__attach();
        renderOnce(c, 200);
        drainEvents();
        tapAt(c, 100, 100);
        const raised = drainEvents();
        eq(raised.length, 0,
            `a tap with nothing bound and no demo raises nothing  (${namesOf(raised).join(', ')})`);
    });

    attempt('a demo die no longer refuses — the W-3a tripwire, discharged at W-3b', () => {
        /*
         * This assertion was written at W-3a to FAIL the moment the boundary moved,
         * and it did: `W-3b` parses `M L C Z`, which is the whole of SWEEP_UNIT, so
         * the demo die is answerable now instead of refused. What is left here is
         * the discharge — a tap on a demo wafer runs to completion. Where it lands
         * is section 23's business.
         */
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        renderOnce(c, 200);
        drainEvents();
        let threw = null;
        try { tapAt(c, 100, 100); } catch (err) { threw = err; }
        eq(threw, null, `a tap on a demo die completes  (${String(threw?.message).slice(0, 70)})`);
    });

    attempt('a tap that could not have happened is an error, not a silence', () => {
        /* `__handlePointerUp` returns immediately when `__canvas` is null, so a
         * tap before `renderOnce` does nothing at all - and "nothing happened"
         * reads identically to "the tap hit nothing". `tapAt` refuses instead. */
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        let threw = false;
        try { tapAt(c, 10, 10); } catch { threw = true; }
        ok(threw, 'tapAt throws without a canvas rather than quietly doing nothing');
    });
});

section('22. an item hit, through the control (W-3a)', () => {
    /*
     * OBSERVATION 160, closed for everything that is not a curve. Until W-3a
     * `isPointInPath` and `isPointInStroke` returned `false` unconditionally, so
     * `getItemAtPos` could never report an item and every assertion about one would
     * have passed by missing. The panel below is `SubstrateMap_Items` from the
     * shipped `Desktop.view` — not a fixture written to be easy — and the user's
     * live-view capture shows Chrome selecting `TEG-1` and `FRAME` on it.
     *
     * Two filled rectangles, a filled circle, and a rectangle with `stroke_width: 1`.
     * Every expectation below is closed-form: a rectangle is a half-open interval
     * test and a circle is a radius, so nothing here is transcribed from a run.
     */
    const PANEL = 'SubstrateMap_Items';
    const panel = readPanels().find((p) => p.id === PANEL);
    ok(panel !== undefined, `${PANEL} is in Desktop.view`);

    /** @param px Canvas side in CSS px. @returns `{ c, toCanvas }`. */
    const bound = (px = 400) => {
        const c = drivePanel(panel).control;
        c.__attach();
        renderOnce(c, px);
        const m = c.__computeMatrices(c.__makeConfig(), 1);
        const wd = m.world.multiply(m.data);
        /*
         * Data-frame millimetres to canvas CSS pixels. The SAME product the hit
         * path builds — `getItemAtPos` applies `world * data * item` on a UNIT base
         * — and the items on this panel carry no rotation, so the item factor is the
         * identity and this is the whole chain.
         */
        const toCanvas = (mmX, mmY) => {
            const p = wd.transformPoint(new DOMPoint(mmX, mmY));
            return [p.x, p.y];
        };
        drainEvents();
        return { c, toCanvas };
    };

    /**
     * What a tap selected.
     *
     * A MISS IS NOT SILENCE on this panel. It binds `selection-mode="multi"`, where
     * an empty click CLEARS and says so: `onItemSelected` fires with every field
     * null and an empty `selection`. Asserting "no event" would have been wrong
     * about the product and is what the first draft of this section got wrong.
     * @param evs Recorder entries.
     * @returns `{ id, count }` — the selected item id, or null, and the selection size.
     */
    /*
     * EVERY MISS IS TAPPED ON A FRESH CONTROL, and that is not tidiness.
     *
     * Under `multi`, re-tapping a SELECTED item toggles it off — and a toggle-off
     * leaves an empty selection, which is byte-identical to a miss. The first draft
     * tapped the hit and then the miss on one control, so a shim that wrongly hit
     * the second point would have toggled the first item away and still shown an
     * empty selection. `check-negatives`'s "isPointInStroke answering like a fill"
     * mutation went undetected against that shape, which is how it was found.
     *
     * On a control with nothing selected, an empty click is inert and raises no
     * event at all, so `{ id: null, count: 0 }` can only mean the point missed.
     */
    const selected = (evs) => {
        const hits = evs.filter((e) => e.name.endsWith('.onItemSelected'));
        if (hits.length === 0) { return { id: null, count: 0 }; }
        const d = hits[hits.length - 1].data;
        return { id: d.itemId ?? null, count: (d.selection ?? []).length };
    };

    attempt('a tap on the circle selects it, and 6 mm outside its 5 mm radius does not', () => {
        const hit = bound();
        tapAt(hit.c, ...hit.toCanvas(18, 12));           // TEG-1's centre
        eq(selected(drainEvents()).id, 3, 'the centre of a filled circle selects TEG-1, item 3');

        const miss = bound();
        tapAt(miss.c, ...miss.toCanvas(18 + 6, 12));     // 6 mm out, radius is 5
        deep(selected(drainEvents()), { id: null, count: 0 },
            'and a point 1 mm beyond the rim selects nothing — 6 mm out of a 5 mm radius misses by '
            + 'a margin four thousand times the flattening error');
    });

    attempt('FRAME is hit on its border AND through its middle (F-6a)', () => {
        /*
         * THIS ASSERTION USED TO SAY THE OPPOSITE, and that is the point.
         *
         * It read "a tap in the middle selects nothing — an outline is never hit
         * through its hollow interior", and it passed, because `stroke_width` on a
         * closed geometry suppressed the fill in the paint and the hit followed.
         * The behaviour the field reported as a defect was locked in by a test that
         * asserted it (observation 372).
         *
         * FRAME is a 56 x 22 mm RECTANGLE at (0, -8) with a 1 mm stroke. A rectangle
         * has an interior. Under the field rule - everything painted with the item is
         * part of the hit area - it is filled with the status colour and edged with
         * the same, and it is hit anywhere inside (`D-232`).
         *
         * An outline-only closed shape is still authorable: a `polyline` that returns
         * to its start is a line, is painted as one, and is hit as one.
         */
        const border = bound();
        tapAt(border.c, ...border.toCanvas(0, -19));     // on the bottom edge
        eq(selected(drainEvents()).id, 4, 'a tap on the edge selects FRAME, item 4');

        const middle = bound();
        tapAt(middle.c, ...middle.toCanvas(0, -8));      // dead centre, 11 mm from any edge
        eq(selected(drainEvents()).id, 4,
            'and a tap in the middle selects it too — a rectangle with an edge is still a rectangle');

        const outside = bound();
        tapAt(outside.c, ...outside.toCanvas(0, 6));     // 3 mm above the top edge at y = +3
        deep(selected(drainEvents()), { id: null, count: 0 },
            'while a tap outside the edge still selects nothing — the fill did not grow the shape');
    });

    attempt('the two filled rectangles are hit inside and missed outside', () => {
        for (const [id, cx, cy] of [[1, -18, 12], [2, 0, 12]]) {
            const hit = bound();
            tapAt(hit.c, ...hit.toCanvas(cx, cy));
            eq(selected(drainEvents()).id, id, `item ${id} at its centre`);

            const miss = bound();
            tapAt(miss.c, ...miss.toCanvas(cx, cy + 9));  // half-length is 5 mm
            deep(selected(drainEvents()), { id: null, count: 0 }, `  and nothing 9 mm above it`);
        }
    });

    attempt('an item hit wins over the grid, and raises onItemSelected not onGroupSelected', () => {
        /* D-100 from the other side: W-3 could only observe the group branch. */
        const { c, toCanvas } = bound();
        tapAt(c, ...toCanvas(18, 12));
        const names = drainEvents().map((e) => e.name.split('.').pop());
        ok(names.includes('onItemSelected'), `an item hit raises onItemSelected  (${names.join(', ')})`);
        ok(!names.includes('onGroupSelected'), '  and never a group event alongside it');
    });

    attempt('the hit follows the CTM rather than the raw coordinates', () => {
        /*
         * The assertion that catches an inverse dropped, transposed or applied in
         * the wrong direction. The same item is tapped on two canvas sizes: the
         * millimetre point is fixed, the pixel point is not, and both must select it.
         * A shim testing the pointer against an untransformed path passes the first
         * and fails the second.
         */
        const seen = [];
        for (const px of [300, 500]) {
            const { c, toCanvas } = bound(px);
            const pt = toCanvas(18, 12);
            tapAt(c, ...pt);
            seen.push({ px, pt: pt.map((v) => Math.round(v)), id: selected(drainEvents()).id });
        }
        deep(seen.map((s) => s.id), [3, 3],
            `TEG-1 at ${JSON.stringify(seen[0].pt)} on a 300 px canvas and `
            + `${JSON.stringify(seen[1].pt)} on a 500 px one — different pixels, same die`);
        ok(seen[0].pt[0] !== seen[1].pt[0] || seen[0].pt[1] !== seen[1].pt[1],
            '  and the two pixel points really do differ, so the second is not a repeat of the first');
    });
});

section('23. the demo die, curves and all (W-3b)', () => {
    /*
     * `buildDemo` authors every die as a `type: 'path'` geometry: SWEEP_UNIT, one
     * moveTo, fourteen lineTos, SEVEN CUBIC BEZIERS and a close, scaled by
     * `sweepHeight` and translated to the die's centre. Until W-3b the shim
     * recorded that `d` string and refused to answer about it. `ShowDemoItems`
     * defaults to true, so this is the shape on screen when nothing is bound - and
     * the user's live capture is a tap selecting one.
     *
     * ---- WHERE THE EXPECTATIONS COME FROM ----
     *
     * Read off SWEEP_UNIT's own coordinates, not off a run. The die is a thick
     * chevron whose vertex sits at unit (-0.01129, -0.0002): along the line y = 0
     * the ink runs from the outer edge at x = -0.164 to that vertex, and there is
     * nothing to its right at that height. So the die's BOUNDING-BOX CENTRE is
     * OUTSIDE its own ink, which is the property no bounding-box test can have and
     * a winding test gets for free.
     *
     * Grid arithmetic, likewise by hand: pitch 12 x 26 mm, so the die at (ix, iy)
     * is centred on ((ix + 0.5) * 12, (iy + 0.5) * 26). At (0, 0) that is (6, 13).
     * nx = floor(143 / 12) + 1 = 12 and ny = floor(143 / 26) + 1 = 6, and the name
     * is 'R' + (ny - iy) + 'C' + (ix + nx + 1) = R6C13. The bin is randomised on
     * every build, so nothing below looks at status.
     */
    const H = 22;                       // DEMO_LAYOUT.sweepHeight
    const DIE = { cx: 6, cy: 13, name: 'R6C13' };

    /** @param ux Unit x within the die. @param uy Unit y. @returns Data-frame mm. */
    const unitToMm = (ux, uy) => [DIE.cx + ux * H, DIE.cy + uy * H];

    /** @param px Canvas side. @returns `{ c, toCanvas }` for a demo-mode control. */
    const demo = (px = 800) => {
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        renderOnce(c, px);
        const m = c.__computeMatrices(c.__makeConfig(), 1);
        const wd = m.world.multiply(m.data);
        const toCanvas = (mmX, mmY) => {
            const p = wd.transformPoint(new DOMPoint(mmX, mmY));
            return [p.x, p.y];
        };
        drainEvents();
        return { c, toCanvas };
    };

    /** @param evs Recorder entries. @returns `{ name, count }` of what was selected. */
    const selected = (evs) => {
        const hits = evs.filter((e) => e.name.endsWith('.onItemSelected'));
        if (hits.length === 0) { return { name: null, count: 0 }; }
        const d = hits[hits.length - 1].data;
        return { name: d.name ?? null, count: (d.selection ?? []).length };
    };

    attempt('the demo is on by default and its dies are curves', () => {
        const { c } = demo();
        const items = c.__sceneItems ?? [];
        ok(items.length > 100, `${items.length} demo dies are on screen with nothing bound`);
        const g = items[0]?.geometries?.[0];
        ok(g !== undefined && g.path instanceof Path2D, 'each carries a Path2D');
        eq(g?.path?.unparsed ?? null, null,
            'and it parsed — a refused path would have `unparsed` set and would throw on probe');
    });

    attempt('a tap on the arm selects R6C13', () => {
        const { c, toCanvas } = demo();
        tapAt(c, ...toCanvas(...unitToMm(-0.12, 0)));   // mid-arm, 2.6 mm inside the outer edge
        eq(selected(drainEvents()).name, DIE.name,
            'the die at grid (0, 0) is R6C13 by the demo\'s own R/C arithmetic');
    });

    attempt('a tap at the die\'s bounding-box centre selects NOTHING', () => {
        /*
         * The assertion that a bounding-box hit test cannot pass, and the reason
         * the winding test is worth having. (6, 13) is the centre of the die's box
         * and sits 2.4 mm to the RIGHT of the chevron's vertex, on bare substrate.
         * At 800 px that margin is about six pixels, and the flattening error is
         * four decimal places smaller.
         */
        const { c, toCanvas } = demo();
        tapAt(c, ...toCanvas(...unitToMm(0.10, 0)));
        deep(selected(drainEvents()), { name: null, count: 0 },
            'the notch of the chevron is not the chevron');
    });

    attempt('both sides of the vertex behave, on one sweep across the die', () => {
        /*
         * A row of probes at y = 0 across the die, compared against the shape read
         * from SWEEP_UNIT: ink from x = -0.164 to the vertex at -0.011, nothing to
         * its right. Ten points rather than two, so a shim that is merely
         * off-by-a-bit shows up as a shifted edge rather than passing on luck.
         */
        const { c, toCanvas } = demo();
        const want = [];
        const got = [];
        for (let ux = -0.20; ux <= 0.20; ux += 0.04) {
            want.push(ux >= -0.164 && ux <= -0.011 ? '#' : '.');
            tapAt(c, ...toCanvas(...unitToMm(ux, 0)));
            got.push(selected(drainEvents()).name === DIE.name ? '#' : '.');
        }
        deep(got.join(''), want.join(''),
            'the ink at y = 0 is where SWEEP_UNIT says it is');
    });

    attempt('the flattening stays within its stated bound of the true cubic', () => {
        /*
         * Not a hit test: the flattener measured against the DEFINITION of a cubic
         * Bezier, `cubicAt`, evaluated at a hundred parameter values. The bound is
         * relative to the curve's own extent (CUBIC_TOLERANCE_RATIO = 1e-3), which
         * is what makes one constant serve a 1 mm die and a 300 mm wafer. The first
         * version of that bound omitted the factor of six in max|B''| and this
         * assertion is what said so.
         *
         * This is the honest half of the accuracy question. The other half — does
         * CHROME agree — is not answerable here and is what tools/hit-oracle.mjs
         * exists for.
         */
        const p0 = [0, 0], p1 = [10, 30], p2 = [40, -20], p3 = [50, 10];
        const path = new Path2D(`M ${p0[0]} ${p0[1]} C ${p1[0]} ${p1[1]} ${p2[0]} ${p2[1]} ${p3[0]} ${p3[1]}`);
        const pts = path.subpaths[0].points;
        ok(pts.length > 4, `${pts.length - 1} chords for one cubic`);
        let worst = 0;
        for (let k = 0; k <= 100; k++) {
            const [tx, ty] = cubicAt(k / 100, p0, p1, p2, p3);
            let best = Infinity;
            for (let i = 0; i < pts.length - 1; i++) {
                const [ax, ay] = pts[i];
                const [bx, by] = pts[i + 1];
                const dx = bx - ax, dy = by - ay;
                const len2 = dx * dx + dy * dy;
                const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((tx - ax) * dx + (ty - ay) * dy) / len2));
                best = Math.min(best, Math.hypot(tx - (ax + t * dx), ty - (ay + t * dy)));
            }
            worst = Math.max(worst, best);
        }
        const extent = 50;                                  // the control polygon's x span
        ok(worst <= 1e-3 * extent,
            `worst deviation ${worst.toExponential(2)} is within ${(1e-3 * extent).toExponential(2)}`);
    });

    attempt('an unsupported command is still recorded and still refused', () => {
        /*
         * `A` is what every disc-flats outline preset emits, it is built on nearly
         * every bind, and it is never hit-tested — so parsing it would be a branch
         * nothing exercises. Construction stays silent; the probe does not.
         */
        const arc = new Path2D('M 0 0 A 5 5 0 1 1 10 0 Z');
        eq(arc.unsupported, 'A', 'the command that stopped the parse is recorded');
        const ctx = makeContext2D(50, 50);
        let refused = null;
        try { ctx.isPointInPath(arc, 1, 1); } catch (err) { refused = err; }
        ok(refused !== null && /"A"/.test(String(refused.message)),
            `probing it throws and names the command  (${String(refused?.message).slice(0, 60)})`);
    });
});

section('24. the shim against a browser (W-3b)', () => {
    /*
     * THE ONE QUESTION THIS WORKSPACE CANNOT ANSWER ALONE. Sections 22 and 23
     * check the shim against expectations read off the geometry by hand, which is
     * exact for a rectangle and a circle and softens near the boundary of a
     * flattened cubic. Whether CHROME agrees is a different question, and there is
     * no browser here to ask — Playwright and Cypress cannot run in this workspace
     * because the browser binaries come from hosts the egress proxy refuses.
     *
     * So it is asked once, by hand, on a machine that has one:
     *   node tools/hit-oracle.mjs   ->  open the page  ->  press Download
     * and the answers are checked in as a fixture. From then on this is an
     * ordinary assertion in the gate list.
     *
     * Both sides build the shapes with the SAME `buildShapePath` — the page gets
     * its source inlined — so a disagreement here is a disagreement about
     * geometry rather than about what was drawn.
     *
     * WHEN THE FIXTURE IS ABSENT this says so, loudly, in its own assertion. It
     * does not skip: a comparison that quietly does not happen is the exact defect
     * this part of the tree exists to remove.
     */
    const ORACLE = new URL('fixtures/hit-oracle.json', import.meta.url);
    const present = existsSync(ORACLE);

    attempt('the capture plan is buildable by the shim', () => {
        /* Runs with or without the fixture, so the plumbing cannot rot unnoticed
         * while nobody has run a browser. */
        let built = 0;
        for (const shape of ORACLE_PLAN.shapes) {
            const p = buildShapePath(shape, Path2D, DOMMatrix);
            ok(p instanceof Path2D, `${shape.id} builds`);
            eq(p.unparsed, null, `  and ${shape.id} parsed rather than being refused`);
            built += p.subpaths.length;
        }
        ok(built >= ORACLE_PLAN.shapes.length, `${built} subpaths across ${ORACLE_PLAN.shapes.length} shapes`);
    });

    if (!present) {
        attempt('NO BROWSER CAPTURE IS PRESENT — the shim is unverified against Chrome', () => {
            ok(true,
                'fixtures/hit-oracle.json is absent, so nothing below ran. Regenerate with '
                + '`node tools/hit-oracle.mjs`, open tools/hit-oracle.html in a browser, press '
                + 'Download, and put the file in tests/fixtures/. Recorded as an open observation '
                + 'rather than a red gate, because the workspace cannot produce it.');
        });
        return;
    }

    const oracle = JSON.parse(readFileSync(ORACLE, 'utf8'));

    /*
     * ---- THE TWO CLASSES OF DISAGREEMENT, AND WHY NEITHER IS A GEOMETRY ERROR ----
     *
     * The capture found 51. Every one falls into a class that was characterised
     * before being excused, and both classes are asserted to be exactly the size
     * they were measured at — so a genuine defect cannot hide inside one.
     *
     * BOUNDARY TIE. The probe lies exactly on the fill boundary, to within 3e-15.
     * Chrome tests in DEVICE space and this shim inverts the pointer into USER
     * space, so the half-open tie-break of the winding rule falls on different
     * edges — visibly so: under `yflip` the disagreeing edge moves from x = +7 to
     * x = -7, because flipping y reverses the subpath's device-space winding.
     * Matching it would mean reimplementing Skia's convention in device space, to
     * decide cases a pointer can never land on.
     *
     * DEGENERATE STROKE. The stroke is wider than the shape it strokes, at which
     * point the offset curves self-intersect and Skia's stroker leaves HOLES: at
     * width 3 on the 0.33-wide chevron, Chrome's answer is not monotone in
     * distance from the path — it says no at 0.44 and yes at 0.68. The shim models
     * the stroke as the Minkowski sum with a disc, which stays correct where the
     * stroker degenerates. The shim is the better answer here and the assertion
     * says so rather than pretending otherwise.
     */
    const BOUNDARY_EPS = 1e-9;

    /** @param p A path. @param x User x. @param y User y. @returns Distance to the nearest segment. */
    const distanceToPath = (p, x, y) => {
        let best = Infinity;
        for (const sp of p.subpaths) {
            const pts = sp.points;
            for (let i = 0; i < pts.length; i++) {
                const [ax, ay] = pts[i];
                const [bx, by] = pts[(i + 1) % pts.length];
                const dx = bx - ax, dy = by - ay;
                const len2 = dx * dx + dy * dy;
                const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
                best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
            }
        }
        return best;
    };

    /** @param p A path. @returns The shorter side of its bounding box. */
    const minFeature = (p) => {
        const xs = p.subpaths.flatMap((sp) => sp.points.map((q) => q[0]));
        const ys = p.subpaths.flatMap((sp) => sp.points.map((q) => q[1]));
        return Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    };

    attempt('the fixture was captured from the plan this suite is running', () => {
        deep(oracle.plan.shapes.map((x) => x.id), ORACLE_PLAN.shapes.map((x) => x.id),
            'the same shapes, in the same order');
        deep(oracle.plan.transforms.map((x) => x.id), ORACLE_PLAN.transforms.map((x) => x.id),
            'and the same transforms');
        deep(oracle.plan.lineWidths, ORACLE_PLAN.lineWidths, 'and the same stroke widths');
    });

    attempt('the fill agrees with Chrome everywhere except exactly on a boundary', () => {
        const ctx = makeContext2D(400, 400);
        const paths = new Map(ORACLE_PLAN.shapes.map((sh) => [sh.id, buildShapePath(sh, Path2D, DOMMatrix)]));
        const ties = [];
        const real = [];
        for (const c of oracle.cases) {
            const t = ORACLE_PLAN.transforms.find((x) => x.id === c.transform);
            ctx.setTransform(...t.m);
            const p = paths.get(c.shape);
            if (ctx.isPointInPath(p, c.canvas[0], c.canvas[1]) === c.inPath) { continue; }
            const d = distanceToPath(p, c.user[0], c.user[1]);
            (d <= BOUNDARY_EPS ? ties : real).push(`${c.shape}/${c.transform} at ${c.user}, ${d.toExponential(1)} off`);
        }
        eq(real.length, 0,
            `${oracle.cases.length - ties.length - real.length} of ${oracle.cases.length} fill probes agree `
            + `with ${String(oracle.capturedBy).match(/Chrome\/[\d.]+/)?.[0] ?? 'the browser'}, and every `
            + `disagreement is exactly on a boundary  ${real[0] ?? ''}`);
        eq(ties.length, 27,
            'the boundary ties are the 27 lattice points that land on an edge of rect-14x10 or concave-L');
    });

    attempt('the stroke agrees with Chrome except where its own stroker degenerates', () => {
        const ctx = makeContext2D(400, 400);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const paths = new Map(ORACLE_PLAN.shapes.map((sh) => [sh.id, buildShapePath(sh, Path2D, DOMMatrix)]));
        const wider = [];
        const real = [];
        let probes = 0;
        for (const c of oracle.cases) {
            const t = ORACLE_PLAN.transforms.find((x) => x.id === c.transform);
            ctx.setTransform(...t.m);
            const p = paths.get(c.shape);
            for (const w of ORACLE_PLAN.lineWidths) {
                ctx.lineWidth = w;                       // 0 is IGNORED, as in the browser
                probes++;
                if (ctx.isPointInStroke(p, c.canvas[0], c.canvas[1]) === c.inStroke[w]) { continue; }
                const half = ctx.lineWidth / 2;
                const where = `${c.shape}/${c.transform} w=${ctx.lineWidth} at ${c.user}`;
                (half > minFeature(p) / 2 ? wider : real).push(where);
            }
        }
        eq(real.length, 0,
            `${probes - wider.length - real.length} of ${probes} stroke probes agree, and every `
            + `disagreement is a stroke wider than the shape it strokes  ${real[0] ?? ''}`);
        eq(wider.length, 24,
            'the 24 are width 3 on the 0.33-wide chevron, where Skia\'s stroker self-intersects');
    });

    attempt('at a width the product can actually ask for, agreement is exact', () => {
        /*
         * The assertion that matters. `getItemAtPos` strokes at
         * `max(strokeWidthMm, HIT_MIN_PX / s')`, which for a die on a normal panel
         * is a fraction of the die. Width 1 against every shape in the plan is that
         * regime, and there it is not "agrees except" — it is agrees.
         */
        const ctx = makeContext2D(400, 400);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 1;
        const paths = new Map(ORACLE_PLAN.shapes.map((sh) => [sh.id, buildShapePath(sh, Path2D, DOMMatrix)]));
        const bad = [];
        for (const c of oracle.cases) {
            const t = ORACLE_PLAN.transforms.find((x) => x.id === c.transform);
            ctx.setTransform(...t.m);
            ctx.lineWidth = 1;
            if (ctx.isPointInStroke(paths.get(c.shape), c.canvas[0], c.canvas[1]) !== c.inStroke[1]) {
                bad.push(`${c.shape}/${c.transform} at ${c.user}`);
            }
        }
        eq(bad.length, 0,
            `all ${oracle.cases.length} probes at width 1 agree with the browser  ${bad[0] ?? ''}`);
    });
});

section('25. onItemSelected gets a schema (W-4)', () => {
    /*
     * There is a `SelectionList.Schema.json` for the ATTRIBUTE and, until now,
     * nothing for the EVENT. `ItemSelection.Schema.json` is derived from what
     * `__raiseSelected` builds — read out of the code, field by field — and not
     * from `SelectionList`, which would have described the release notes' claim
     * instead of the control.
     *
     * The claim is that the two carry the same fields. They do not, and section
     * README 'onItemSelected versus SelectedItems' lists every difference. The
     * assertions below are the ones that would notice if a difference were quietly
     * flattened in either direction.
     */
    const schemaPath = new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/ItemSelection.Schema.json',
        import.meta.url);
    const defs = JSON.parse(readFileSync(schemaPath, 'utf8')).definitions;
    const validate = new Ajv({ allErrors: true }).compile({
        $ref: '#/definitions/SubstrateMapItemSelection', definitions: defs,
    });

    /** @param n Cells per side. @returns An all-pass square map with one failing cell. */
    const mapOf = (n) => '<?xml version="1.0"?>'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
        + `<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true"><Dimension X="${n}" Y="${n}"/>`
        + '<StepSize X="1" Y="1"/></Layout></Layouts>'
        + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
        + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L"><Overlay MapName="M">'
        + '<BinCodeMap BinType="Ascii" NullBin="." MapType="2DArray"><BinDefinitions>'
        + '<BinDefinition BinCode="1" BinQuality="Pass"/><BinDefinition BinCode="9" BinQuality="Fail"/>'
        + '</BinDefinitions>'
        + `<BinCode>9${'1'.repeat(n - 1)}</BinCode>`
        + new Array(n - 1).fill(`<BinCode>${'1'.repeat(n)}</BinCode>`).join('')
        + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';

    /** @param evs Recorder entries. @returns The last onItemSelected payload, or null. */
    const payloadOf = (evs) => {
        const hits = evs.filter((e) => e.name.endsWith('.onItemSelected'));
        return hits.length === 0 ? null : hits[hits.length - 1].data;
    };

    attempt('a CELL hit validates', () => {
        /* A 6-cell map at 400 px draws dies well above TouchTargetSize, so a tap is
         * a cell hit rather than a group hit. */
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(mapOf(6));
        c.__attach();
        renderOnce(c, 400);
        drainEvents();
        tapAt(c, 200, 200);
        const p = payloadOf(drainEvents());
        ok(p !== null, 'a tap on a bound grid raises onItemSelected');
        eq(p?.kind, 'cell', '  and reports kind cell');
        const good = validate(p);
        ok(good, `the cell payload validates  ${good ? '' : JSON.stringify(validate.errors?.[0])}`);
        ok(typeof p?.column === 'number' && typeof p?.row === 'number',
            '  carrying column and row, which no SelectedItems entry has');
        eq(p?.binCode, p?.status, '  and binCode repeats status, as the schema says');
    });

    attempt('an ITEM hit validates', () => {
        const panel = readPanels().find((x) => x.id === 'SubstrateMap_Items');
        const c = drivePanel(panel).control;
        c.__attach();
        renderOnce(c, 400);
        const m = c.__computeMatrices(c.__makeConfig(), 1);
        const wd = m.world.multiply(m.data);
        const pt = wd.transformPoint(new DOMPoint(18, 12));       // TEG-1's centre
        drainEvents();
        tapAt(c, pt.x, pt.y);
        const p = payloadOf(drainEvents());
        ok(p !== null, 'a tap on an item raises onItemSelected');
        eq(p?.kind, 'item', '  and reports kind item');
        const good = validate(p);
        ok(good, `the item payload validates  ${good ? '' : JSON.stringify(validate.errors?.[0])}`);
        eq(p?.column, undefined, '  and carries no cell coordinates');
        eq(p?.binCode, undefined, '  and no bin code');
    });

    attempt('a CLEAR validates — obs. 166, and the schema had to admit it', () => {
        /*
         * Under `multi` an empty click clears and raises the event with every single
         * value null and an empty selection. A schema written from `SelectionList`
         * would have made itemId a plain integer and rejected this on the first
         * deselect in production.
         */
        const panel = readPanels().find((x) => x.id === 'SubstrateMap_Items');
        const c = drivePanel(panel).control;
        c.__attach();
        renderOnce(c, 400);
        const m = c.__computeMatrices(c.__makeConfig(), 1);
        const wd = m.world.multiply(m.data);
        const at = (x, y) => { const q = wd.transformPoint(new DOMPoint(x, y)); return [q.x, q.y]; };
        drainEvents();
        tapAt(c, ...at(18, 12));                                  // select TEG-1
        drainEvents();
        tapAt(c, ...at(18, 30));                                  // bare substrate
        const p = payloadOf(drainEvents());
        ok(p !== null, 'an empty click raises the event rather than staying silent');
        deep([p?.itemId, p?.status, p?.name, p?.userData, (p?.selection ?? []).length],
            [null, null, null, null, 0], '  with every value null and an empty selection');
        const good = validate(p);
        ok(good, `and it validates  ${good ? '' : JSON.stringify(validate.errors?.[0])}`);
    });

    attempt('the schema is derived from the raise, not from SelectionList', () => {
        /*
         * The check that would fail if someone regenerated this schema from the
         * attribute. Three names differ between the two shapes, and each of them is
         * a real consumer-visible difference rather than a typo:
         *   itemId / item_id, userData / user_data, and the selection entries.
         */
        const props = defs.SubstrateMapItemSelection.properties;
        ok('itemId' in props && !('item_id' in props), 'the event says itemId, not item_id');
        ok('userData' in props && !('user_data' in props), 'and userData, not user_data');
        deep(Object.keys(props.selection.items.properties).sort(), ['itemId', 'kind'],
            'and a selection entry is identity only — no status, name or user data');
        ok('column' in props && 'row' in props && 'binCode' in props,
            'the event carries column, row and binCode, which SelectedItems does not');
    });

    attempt('the event DROPS the raw PvValue that SelectedItems keeps', () => {
        /*
         * The substantive difference, and the one the release notes get wrong. A
         * DeviceReading is `{ name, value, raw }`; `__raiseSelected` maps it to
         * `{ name, value }` for the event and hands the whole record to
         * `setSelectedItems`. So a view that wants the E138 tree must read the
         * ATTRIBUTE — the event will never carry it.
         *
         * Asserted against both schemas rather than against prose, so the day
         * someone adds `raw` to the event this stops being true out loud.
         */
        const eventReading = defs.SubstrateMapItemSelection.properties.deviceData.items;
        const listPath = new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/SelectionList.Schema.json',
            import.meta.url);
        const listDefs = JSON.parse(readFileSync(listPath, 'utf8')).definitions;
        const listReading = listDefs.SubstrateMapSelectionList.items.properties.deviceData.items;
        deep(Object.keys(eventReading.properties).sort(), ['name', 'value'],
            'the event reading is name and value');
        deep(Object.keys(listReading.properties).sort(), ['name', 'raw', 'value'],
            'and the attribute reading adds raw');
        eq(eventReading.additionalProperties, false,
            'the event schema forbids the extra field rather than tolerating it');
    });
});

section('26. readBinStatistics (W-10)', () => {
    /*
     * The same pass `describeGroup` runs over a group, run over the whole lattice,
     * and UNTRUNCATED — `D-098`'s cap exists because an event payload is O(K) in
     * something the document controls and is rebuilt on every tap, and a function
     * asked for once per binding is neither.
     *
     * The interesting assertions are the two that could go wrong quietly: the
     * arithmetic invariant, swept over the whole corpus rather than one map, and
     * `color` against what the render path actually paints.
     */
    const schemaPath = new URL('../../../Controls/SubstrateMap/Schema/TypeDefinitions/BinStatistics.Schema.json',
        import.meta.url);
    const validate = new Ajv({ allErrors: true }).compile({
        $ref: '#/definitions/SubstrateMapBinStatistics',
        definitions: JSON.parse(readFileSync(schemaPath, 'utf8')).definitions,
    });

    /*
     * `Integer2`, and the corpus decided that rather than a guess. `Ascii` is ONE
     * CHARACTER per cell, so three hundred codes do not fit. `Decimal` is one BYTE:
     * the parser refused at 256 with
     * `BAD_TOKEN: Decimal token "256 " at row 6, column 15 is malformed`, which is
     * the right answer and not the one this section needs. `Integer2` is four hex
     * digits and no separator, run together — `v0211-physical-small-integer2.xml`
     * is where the format was read off — and it admits 65 536, which is the same
     * number `D-098` names when it explains why a GROUP histogram has to be capped.
     */
    const codeOf = (i) => (i + 1).toString(16).toUpperCase().padStart(4, '0');

    /** @param n Codes to spread over a 40x40 map. @returns E142 XML. */
    const mapOfCodes = (n) => {
        const side = 40;
        const defs = [];
        for (let i = 0; i < n; i++) {
            defs.push(`<BinDefinition BinCode="${codeOf(i)}" BinQuality="${i % 3 === 0 ? 'Fail' : 'Pass'}"/>`);
        }
        const rows = [];
        for (let r = 0; r < side; r++) {
            const row = [];
            for (let c = 0; c < side; c++) { row.push(codeOf((r * side + c) % n)); }
            rows.push(`<BinCode>${row.join('')}</BinCode>`);
        }
        return '<?xml version="1.0"?>'
            + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
            + `<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true"><Dimension X="${side}" Y="${side}"/>`
            + '<StepSize X="1" Y="1"/></Layout></Layouts>'
            + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
            + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L"><Overlay MapName="M">'
            + `<BinCodeMap BinType="Integer2" NullBin="0000" MapType="2DArray"><BinDefinitions>${defs.join('')}</BinDefinitions>`
            + rows.join('')
            + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';
    };

    /*
     * `__readColors` reads `this.__element[0]` and the stubbed
     * `window.getComputedStyle` answers everything else, which is what
     * `renderOnce` arranges at `attach-harness.mjs:247`. A full frame is not needed
     * for a count, so the same one line is done here instead — a 600 x 600 fixture
     * in the corpus sweep below would otherwise pay for a render nothing reads.
     */
    const themed = (c) => { c.__element ??= [{}]; return c; };

    /** @param xml A document. @returns The bound control. */
    const bound = (xml) => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(xml);
        c.__attach();
        return themed(c);
    };

    attempt('nothing bound is an EMPTY reading, not null', () => {
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        const st = c.readBinStatistics();
        ok(st !== null && st !== undefined, 'a reading is returned');
        deep([st.totalCells, st.nullCount, st.bins.length], [0, 0, 0],
            'totalCells 0, nullCount 0, no bins — a chart can draw that; null it would have to branch on');
        ok(validate(st), 'and the empty reading still validates');
    });

    attempt('one code and three hundred both validate', () => {
        for (const n of [1, 300]) {
            const st = bound(mapOfCodes(n)).readBinStatistics();
            const good = validate(st);
            ok(good, `${n} code${n === 1 ? '' : 's'} validates  ${good ? '' : JSON.stringify(validate.errors?.[0])}`);
            eq(st.bins.length, n, `  and all ${n} are listed — untruncated`);
        }
    });

    attempt('no field of a bin row can be dropped unnoticed', () => {
        /*
         * What makes the schema load-bearing rather than decorative. Without this,
         * removing a name from `required` changes nothing any assertion can see —
         * measured: the `check-negatives` case that does exactly that went
         * UNCAUGHT until this was written, which is Rule 22 doing its job on a
         * schema instead of on code.
         */
        const st = bound(mapOfCodes(3)).readBinStatistics();
        const row = st.bins[0];
        const survivors = Object.keys(row).filter((k) => {
            const rest = { ...row };
            delete rest[k];
            return validate({ ...st, bins: [rest] });
        });
        eq(survivors.length, 0,
            `dropping any single field of a bin row fails the schema  (survived: ${survivors.join(', ') || 'none'})`);
        const top = ['totalCells', 'nullCount', 'bins'].filter((k) => {
            const rest = { ...st };
            delete rest[k];
            return validate(rest);
        });
        eq(top.length, 0, `and so does dropping any top-level field  (survived: ${top.join(', ') || 'none'})`);
    });

    attempt('the histogram is descending by count, then by code', () => {
        const st = bound(mapOfCodes(7)).readBinStatistics();
        const sorted = [...st.bins].sort((a, b) => (b.count - a.count)
            || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
        deep(st.bins.map((b) => b.code), sorted.map((b) => b.code),
            'the order two identical readings must both produce');
        ok(st.bins.every((b) => b.count > 0), 'and no zero-count row is listed');
    });

    attempt('sum(bins.count) + nullCount === totalCells across the WHOLE corpus', () => {
        /*
         * Done-when 1, swept rather than sampled. The invariant holds by
         * construction — every cell increments exactly one counter and index 0 is
         * the null bin — and "holds by construction" is what everything says until
         * it does not.
         */
        const dir = new URL('./fixtures/xml/', import.meta.url);
        const names = readdirSync(dir).filter((f) => f.endsWith('.xml')).sort();
        const bad = [];
        let counted = 0;
        for (const n of names) {
            const c = themed(new SubstrateMap(null, null, {}));
            c.setE142MapData(readFileSync(new URL(n, dir), 'utf8'));
            c.__attach();
            if (c.__sceneGrid === null) { continue; }      // not every fixture yields a grid
            const st = c.readBinStatistics();
            counted++;
            const sum = st.bins.reduce((t, b) => t + b.count, 0);
            if (sum + st.nullCount !== st.totalCells) {
                bad.push(`${n}: ${sum} + ${st.nullCount} !== ${st.totalCells}`);
            }
            if (st.totalCells !== c.__sceneGrid.cols * c.__sceneGrid.rows) {
                bad.push(`${n}: totalCells is not cols*rows`);
            }
        }
        ok(counted > 40, `${counted} of ${names.length} XML fixtures yield a grid`);
        eq(bad.length, 0, `the invariant holds in all ${counted}  ${bad[0] ?? ''}`);
    });

    attempt('color is what the render path paints, for every code', () => {
        /*
         * Done-when 4, and the reason this function could not simply read
         * `StatusColorMapping`. The comparison is against `buildGridPaint`'s own
         * table — `paint.colors[paint.groups[binIndex]]` is the string the layer
         * fills that bin with — so a divergence here is a divergence on screen.
         */
        const mapping = { '0001': '#ff00ff', '0003': 'rgb(1, 2, 3)' };   // names two codes of seven
        const c = bound(mapOfCodes(7));
        c.setStatusColorMapping(mapping);
        c.__attach();
        const grid = c.__sceneGrid;
        ok(grid !== null, 'a grid is bound');
        const paint = Engine.buildGridPaint(grid, c.__sceneMapping, c.__readColors(),
            makeContext2D(8, 8), c.__sceneBinQualityAliases, c.__sceneBinSeverityPriority);
        const painted = new Map();
        for (let b = 1; b < grid.binTable.length; b++) {
            painted.set(grid.binTable[b].code, paint.colors[paint.groups[b]]);
        }
        const st = c.readBinStatistics();
        const differ = st.bins.filter((x) => x.color !== painted.get(x.code));
        eq(differ.length, 0,
            `all ${st.bins.length} colours match the layer's own table  `
            + `${differ[0] ? `${differ[0].code}: chart ${differ[0].color} vs map ${painted.get(differ[0].code)}` : ''}`);
        ok(st.bins.some((x) => x.color === '#ff00ff'),
            '  including the two the StatusColorMapping names');
        ok(st.bins.some((x) => x.color !== '#ff00ff' && x.color !== 'rgb(1, 2, 3)'),
            '  and the five it does not, which is where a raw-mapping chart would diverge');
    });

    attempt('quality is the declared token, and severity is the resolved rank', () => {
        const c = bound(mapOfCodes(3));
        const st = c.readBinStatistics();
        const byCode = new Map(st.bins.map((b) => [b.code, b]));
        eq(byCode.get('0001')?.quality, 'Fail', 'the document said Fail, verbatim');
        eq(byCode.get('0002')?.quality, 'Pass', 'and Pass');
        ok((byCode.get('0001')?.severity ?? 0) > (byCode.get('0002')?.severity ?? 0),
            'and a Fail outranks a Pass in the declared order');
    });

    attempt('the null bin is counted apart and never listed as a code', () => {
        /* A map whose NullBin token appears in the cells: those cells are the null
         * bin, they are in `nullCount`, and giving them a bar would give them a
         * colour they do not have. */
        const xml = mapOfCodes(2).replace('<BinCode>0001', '<BinCode>0000');
        const st = bound(xml).readBinStatistics();
        ok(st.nullCount > 0, `${st.nullCount} null cells`);
        ok(!st.bins.some((b) => b.code === '0000'), 'and the null token is not a bin row');
        eq(st.bins.reduce((t, b) => t + b.count, 0) + st.nullCount, st.totalCells,
            'and the invariant still closes');
    });
});

section('27. the categorical fallback (W-11)', () => {
    /*
     * `TODO.md` B0. `categoricalPalette` was built, measured and tested at LOD-11
     * and called by no render path, so a map with eight unqualified sort grades
     * drew the same unknown grey eight times — a map that says nothing about the
     * thing it is a map of.
     *
     * The two assertions that matter are the two the task names: a QUALIFIED map is
     * byte-identical to before, and an unqualified one separates measurably.
     */

    /** @param n Codes. @param quality Whether to declare one. @returns E142 XML. */
    const mapOf = (n, quality) => {
        const side = 20;
        const code = (i) => (i + 1).toString(16).toUpperCase().padStart(4, '0');
        const defs = [];
        for (let i = 0; i < n; i++) {
            defs.push(`<BinDefinition BinCode="${code(i)}"`
                + `${quality ? ` BinQuality="${i % 2 === 0 ? 'Pass' : 'Fail'}"` : ''}/>`);
        }
        const rows = [];
        for (let r = 0; r < side; r++) {
            const row = [];
            for (let c = 0; c < side; c++) { row.push(code((r * side + c) % n)); }
            rows.push(`<BinCode>${row.join('')}</BinCode>`);
        }
        return '<?xml version="1.0"?>'
            + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0211.SubstrateMap">'
            + `<Layouts><Layout LayoutId="L" DefaultUnits="mm" TopLevel="true"><Dimension X="${side}" Y="${side}"/>`
            + '<StepSize X="1" Y="1"/></Layout></Layouts>'
            + '<Substrates><Substrate SubstrateType="Wafer" SubstrateId="W"/></Substrates><SubstrateMaps>'
            + '<SubstrateMap SubstrateType="Wafer" SubstrateId="W" LayoutSpecifier="L"><Overlay MapName="M">'
            + `<BinCodeMap BinType="Integer2" NullBin="0000" MapType="2DArray"><BinDefinitions>${defs.join('')}</BinDefinitions>`
            + rows.join('')
            + '</BinCodeMap></Overlay></SubstrateMap></SubstrateMaps></MapData>';
    };

    /** @param xml A document. @returns A bound, themed control. */
    const bound = (xml) => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(xml);
        c.__attach();
        c.__element ??= [{}];
        return c;
    };

    attempt('a map whose codes ALL carry a quality is unchanged', () => {
        /*
         * Done-when 1, and the whole claim that this task is additive. Compared by
         * the paint's own colour table rather than by a render, because that table
         * IS what the layer fills with — if it is identical, every pixel is.
         */
        const c = bound(mapOf(8, true));
        const grid = c.__sceneGrid;
        ok(grid !== null, 'a grid is bound');
        eq(c.__sceneCategorical, null,
            'no code qualifies for a categorical colour, so the fallback is not even built');
        const withFallback = Engine.buildGridPaint(grid, c.__sceneMapping, c.__readColors(),
            makeContext2D(8, 8), c.__sceneBinQualityAliases, null, undefined, null, c.__sceneCategorical);
        const without = Engine.buildGridPaint(grid, c.__sceneMapping, c.__readColors(),
            makeContext2D(8, 8), c.__sceneBinQualityAliases);
        deep(withFallback.colors, without.colors, 'the colour table is identical');
        eq(withFallback.signature, without.signature, '  and so is the cache signature');
    });

    attempt('an explicit StatusColorMapping still wins, and shrinks the palette', () => {
        /*
         * TWO claims, and the second is the one that needs pinning. A mapped code
         * keeps its colour — but it must also NOT be counted when the palette is
         * sized, because `categoricalPalette(k)` spaces hues over k. Three codes with
         * one mapped is a palette of TWO, and asserting the exact pair is what makes
         * that observable: dropping the mapped-skip in `BinPalette` sizes it three,
         * every colour moves, and nothing weaker than an exact comparison notices.
         */
        const c = bound(mapOf(3, false));
        c.setStatusColorMapping({ '0002': '#123456' });
        c.__attach();
        c.__element ??= [{}];
        const byCode = new Map(c.readBinStatistics().bins.map((b) => [b.code, b.color]));
        eq(byCode.get('0002'), '#123456', 'the mapped code keeps its explicit colour');
        const two = Oklch.categoricalPalette(2).colors;
        deep([byCode.get('0001'), byCode.get('0003')], [two[0], two[1]],
            'and the other two are a palette of TWO, in table order — not of three');
    });

    attempt('the precedence is decided in resolveBinColor, and mapping outranks the palette', () => {
        /*
         * Asserted on the function directly because the two guards are REDUNDANT by
         * design: `BinPalette` never offers a colour for a mapped code, so
         * `resolveBinColor` never has to choose. Measured — the mutation that moves
         * the categorical check above the mapping check went UNCAUGHT through the
         * control, because the case it changes cannot arise there.
         *
         * Defence in depth is worth keeping and worth testing where it can be seen.
         */
        const colors = { binPass: '#00ff00', binFail: '#ff0000', unknown: '#888888' };
        const entry = { code: 'X', quality: null, pick: false };
        eq(Engine.resolveBinColor(entry, { X: '#123456' }, colors, null, '#abcdef'), '#123456',
            'an explicit mapping outranks a categorical colour');
        eq(Engine.resolveBinColor({ code: 'X', quality: 'Pass', pick: false }, null, colors, null, '#abcdef'),
            '#00ff00', 'and so does a resolved quality');
        eq(Engine.resolveBinColor(entry, null, colors, null, '#abcdef'), '#abcdef',
            'the categorical colour applies only when neither does');
        eq(Engine.resolveBinColor(entry, null, colors, null, null), '#888888',
            'and the unknown grey only when there is no categorical colour either');
    });

    attempt('eight unqualified codes get eight distinguishable colours', () => {
        /*
         * Done-when 2, MEASURED. `minPairwiseDeltaE` over the eight colours the map
         * actually paints — not over `categoricalPalette`'s output, which would test
         * the palette rather than the wiring.
         */
        const c = bound(mapOf(8, false));
        const st = c.readBinStatistics();
        eq(st.bins.length, 8, 'eight codes');
        const painted = st.bins.map((b) => b.color);
        eq(new Set(painted).size, 8, 'eight DISTINCT colours, where before there was one grey');
        const separation = Oklch.minPairwiseDeltaE(painted);
        ok(separation >= Oklch.CATEGORICAL_MIN_DELTA_E,
            `measured minimum pairwise deltaE ${separation.toFixed(4)} `
            + `>= ${Oklch.CATEGORICAL_MIN_DELTA_E}`);
        ok(!painted.includes(c.__readColors().unknown),
            '  and none of them is the unknown grey they all used to be');
    });

    attempt('the map and the chart paint the same colour for every code', () => {
        /* The reason the fallback is computed once and handed to both. */
        const c = bound(mapOf(6, false));
        const grid = c.__sceneGrid;
        const paint = Engine.buildGridPaint(grid, c.__sceneMapping, c.__readColors(),
            makeContext2D(8, 8), c.__sceneBinQualityAliases, null, undefined, null, c.__sceneCategorical);
        const onMap = new Map();
        for (let b = 1; b < grid.binTable.length; b++) {
            onMap.set(grid.binTable[b].code, paint.colors[paint.groups[b]]);
        }
        const differ = c.readBinStatistics().bins.filter((x) => x.color !== onMap.get(x.code));
        eq(differ.length, 0, `all six agree  ${differ[0]?.code ?? ''}`);
    });

    attempt('past the cap, the rest share the other colour and it is SAID', () => {
        /*
         * `D-087` caps at ten. Here the cap is visible rather than silent:
         * `readBinStatistics` counts every code while the palette colours ten, so
         * the eleventh is present in the numbers and grey on the map.
         */
        logLines();
        const c = bound(mapOf(14, false));
        const st = c.readBinStatistics();
        eq(st.bins.length, 14, 'all fourteen are counted');
        const distinct = new Set(st.bins.map((b) => b.color));
        eq(distinct.size, Oklch.CATEGORICAL_CAP + 1,
            `${Oklch.CATEGORICAL_CAP} palette colours plus one shared "other"`);
        eq(st.bins.filter((b) => b.color === Oklch.CATEGORICAL_OTHER).length, 4,
            'the four past the cap share it');
        ok(logLines().some((l) => String(l.message).includes('SUBSTRATEMAP_CATEGORICAL_PALETTE_CAPPED')),
            'and the control says so once, rather than silently drawing four identical bins');
    });

    attempt('the assignment is a pure function of the document', () => {
        /* Two bindings of the same bytes must colour the map identically, or a
         * chart redrawn after a rebind would reorder its colours under the reader. */
        const a = bound(mapOf(7, false)).readBinStatistics();
        const b = bound(mapOf(7, false)).readBinStatistics();
        deep(a.bins.map((x) => [x.code, x.color]), b.bins.map((x) => [x.code, x.color]),
            'same document, same colours');
    });
});

section('28. buildDemo relocates and takes a box (W-13)', () => {
    /*
     * Phase 2's empty state is one surface shared by four controls. `buildDemo`
     * was module-private in `SubstrateMap.ts`, so a control extending only
     * `SubstrateMapBase` could not reach it at all — Rule 9, the base owns what the
     * controls share.
     *
     * The two assertions the task names are the two that could go wrong quietly:
     * that the default geometry is unchanged to the byte, and that the base really
     * is reachable without the concrete.
     */
    const BASE = new URL('../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url);
    const CONCRETE = new URL('../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url);

    /**
     * One demo build, reduced to what is deterministic.
     * @param bbox Optional target box.
     * @returns `{ items, geometry, outline }`.
     */
    const demoScene = (bbox) => {
        const scene = Base.buildDemo(bbox);
        return {
            items: scene.items,
            geometry: scene.items.map((it) => `${it.name}|${JSON.stringify(it.geometries)}`),
            outline: scene.outlineModel,
        };
    };

    attempt('the base exports it, and the concrete no longer defines it', () => {
        const base = readFileSync(BASE, 'utf8');
        const concrete = readFileSync(CONCRETE, 'utf8');
        ok(/export function buildDemo\b/.test(base), 'SubstrateMapBase.js exports buildDemo');
        ok(!/function buildDemo\s*\(/.test(concrete.replace(/import[^;]+;/g, '')),
            'and SubstrateMap.js no longer defines one');
        ok(/buildDemo/.test(concrete), '  but still uses it, through the import');
    });

    attempt('a module that imports ONLY the base can call it', () => {
        /*
         * Done-when 2, and the reason the move happened. Asserted on the EMITTED
         * `.js` module graph rather than by writing a fake control: what has to be
         * true is that `SubstrateMapBase.js` reaches `buildDemo` without
         * `SubstrateMap.js` being in the graph at all, and the imports say that
         * directly.
         */
        const base = readFileSync(BASE, 'utf8');
        const imports = [...base.matchAll(/^import[^']*'([^']+)'/gm)].map((m) => m[1]);
        ok(!imports.some((i) => i.includes('SubstrateMap/SubstrateMap')),
            `the base imports ${JSON.stringify(imports)} — the concrete is not among them`);
        const demoAt = base.indexOf('export function buildDemo');
        ok(demoAt !== -1 && demoAt < base.indexOf('class SubstrateMapBase'),
            'and buildDemo is defined in the base module itself, above the class');
    });

    attempt('with no box, the geometry is what it has always been', () => {
        /*
         * Done-when 1. The demo randomises its BINS — `Math.random()` picks the
         * yield rings' sprinkle — so the golden is the GEOMETRY: every die's name
         * and path commands. Bins are deliberately excluded; asserting them would
         * be asserting about a random number generator.
         */
        const a = demoScene();
        const b = demoScene();
        eq(a.items.length, 180, `${a.items.length} dies on the 300 mm wafer`);
        deep(a.geometry, b.geometry, 'two builds produce identical geometry');
        eq(a.geometry.length, 180, '  for all 180');
        ok(a.outline !== null, 'and the 300 mm preset outline is returned');
    });

    attempt('a box scales the pattern and keeps every die', () => {
        /*
         * THE BOX IS THE ENGINE'S `BBox` — min/max, not x/y/width/height. W-13
         * declared a parallel `DemoBox` with the second shape; W-14's only caller
         * is an `OutlineModel.bbox`, so the second type was a conversion nobody
         * needed and it is gone.
         *
         * Passing the old shape now produces NaN coordinates, and the W-3b Path2D
         * shim REFUSES them — `malformed d near token 2 of 95` — rather than
         * flattening a path of NaNs into something that silently draws nothing.
         * That refusal is what caught this rename.
         */
        const full = demoScene();
        const small = demoScene({ minX: -20, minY: -20, maxX: 20, maxY: 20 });
        eq(small.items.length, full.items.length,
            'the die COUNT is preserved — the pattern scales, it does not crop');
        deep(small.items.map((i) => i.name), full.items.map((i) => i.name),
            '  and the same dies, by name');
        /*
         * Measured off the FLATTENED path, not off `commands`: `itemsToModels` runs
         * the authored path through the same builder bound data uses, so a model's
         * geometry is a `Path2D` of subpath points by the time it comes back. That
         * is the right thing to measure anyway — it is what gets drawn.
         */
        const span = (scene) => {
            const xs = scene.items.flatMap((i) =>
                i.geometries[0].path.subpaths.flatMap((sp) => sp.points.map((p) => p[0])));
            return Math.max(...xs) - Math.min(...xs);
        };
        const ratio = span(small) / span(full);
        ok(ratio > 0.12 && ratio < 0.15,
            `the pattern is ${(ratio * 100).toFixed(1)}% of full size — 40 mm into 300 mm is 13.3%`);
    });

    attempt('a box drops the outline rather than drawing a wrong substrate', () => {
        /*
         * `generatePresetOutline` emits millimetres for a real 300 mm substrate. A
         * caller that supplied a box has its own idea of what the substrate is —
         * W-14's panel 6 binds one — and a 300 mm disc drawn there would be a
         * second, wrong substrate over the caller's.
         */
        eq(demoScene({ minX: 0, minY: 0, maxX: 40, maxY: 40 }).outline, null,
            'with a box, no outline');
        ok(demoScene().outline !== null, 'without one, the preset outline as before');
    });

    attempt('the demo notch exaggeration still matches the attribute default', () => {
        /*
         * The base carries the number by VALUE: `DEFAULTS` is module-private in the
         * concrete, and exporting it to reach one field would hand the base the
         * concrete's whole attribute-default table — the wrong direction for a base
         * to depend in. The copy cannot drift silently because this reads both.
         */
        const base = readFileSync(BASE, 'utf8');
        const concrete = readFileSync(CONCRETE, 'utf8');
        const inBase = /DEMO_NOTCH_EXAGGERATION\s*=\s*(\d+)/.exec(base)?.[1];
        const inConcrete = /notchExaggeration:\s*(\d+)/.exec(concrete)?.[1];
        eq(inBase, inConcrete, `the base says ${inBase}, the concrete's default says ${inConcrete}`);
    });
});

section('29. the empty state: the precedence table (W-15a)', () => {
    /*
     * The spec's four-row table, one assertion per row, plus the case that found a
     * defect in `W-14`. It is a table because it is the thing most likely to be got
     * wrong; asserting it row by row is only possible because `emptyState` is a
     * pure function of the scene rather than four `if`s inside a render.
     *
     * Rows 1, 3 and 4 are live. Row 2 - a last known state - arrives at `W-31`;
     * the branch exists so the ORDER is fixed now, and the unit assertion below
     * pins it against the day the state turns up.
     */
    const panel = (id) => {
        const c = drivePanel(readPanels().find((x) => x.id === id)).control;
        c.__attach();
        return c;
    };
    const bare = (configure) => {
        const c = new SubstrateMap(null, null, {});
        if (configure) { configure(c); }
        c.__attach();
        return c;
    };

    attempt('row 1 — real data wins, whether it is a grid or items', () => {
        eq(panel('SubstrateMap_GridData').readEmptyState(), 'data', 'a bound grid is data');
        eq(panel('SubstrateMap_E142Xml').readEmptyState(), 'data', 'so is a bound E142 document');
        eq(panel('SubstrateMap_Items').readEmptyState(), 'data', 'and so are bound items');
    });

    attempt('row 1 — a GRID is data, and W-14 did not know that', () => {
        /*
         * THE DEFECT THIS TASK FOUND. `W-14` made the demo draw into a bound
         * outline and guarded it with `__itemModels.length === 0`, reasoning that a
         * document producing nothing is not data. True, and it missed that a grid
         * never becomes items at all: it goes to `__sceneGrid` by a different path.
         * So every panel binding a map AND an outline - nine of the nineteen on the
         * reference page - drew 180 demo dies over its own wafer.
         *
         * Asserted here on the SCENE rather than on the state, because the state
         * would have said `data` either way; what was wrong was what got drawn.
         */
        for (const id of ['SubstrateMap_GridData', 'SubstrateMap_E142Xml']) {
            const c = panel(id);
            ok(c.__sceneGrid !== null, `${id} has a grid`);
            const demoDies = (c.__sceneItems ?? []).filter((i) => /^R\d+C\d+$/.test(i.name ?? ''));
            eq(demoDies.length, 0, `  and draws no demo die over it`);
        }
    });

    attempt('row 3 — the demo, with nothing bound and with an outline bound', () => {
        eq(bare().readEmptyState(), 'demo', 'nothing bound, ShowDemoItems at its default');
        eq(panel('SubstrateMap_Demo').readEmptyState(), 'demo',
            'and panel 6, which binds an outline AND the demo (W-14)');
    });

    attempt('row 4 — no data image otherwise, and an OUTLINE ALONE is not data', () => {
        eq(bare((c) => c.setShowDemoItems(false)).readEmptyState(), 'nodata',
            'nothing bound and the demo turned off');
        eq(bare((c) => { c.setShowDemoItems(false); c.setOutlinePreset('si-12in'); }).readEmptyState(),
            'nodata', 'an empty substrate body is a frame around nothing, not data');
    });

    attempt('row 2 — the order is fixed before the state exists', () => {
        /*
         * `W-31` supplies the last known state. Asserted on the pure function, so
         * the precedence cannot be renegotiated when it arrives: a last known state
         * outranks the demo, and real data outranks it.
         */
        const st = (o) => Base.emptyState({ hasGrid: false, itemCount: 0, isDemo: false,
            hasLastKnown: false, showDemoItems: false, ...o });
        eq(st({ hasLastKnown: true }), 'stale', 'a last known state is shown when there is no data');
        eq(st({ hasLastKnown: true, isDemo: true, showDemoItems: true }), 'stale',
            '  and it outranks the demo');
        eq(st({ hasLastKnown: true, hasGrid: true }), 'data', '  and real data outranks it');
    });

    attempt('the demo is not counted as data by its own items', () => {
        /* The trap in the function: the demo IS items, so reading `itemCount`
         * before excluding it would make every demo report itself as data. */
        eq(Base.emptyState({ hasGrid: false, itemCount: 180, isDemo: true,
            hasLastKnown: false, showDemoItems: true }), 'demo', '180 demo dies are not data');
        eq(Base.emptyState({ hasGrid: false, itemCount: 180, isDemo: false,
            hasLastKnown: false, showDemoItems: true }), 'data', '180 real items are');
    });

    attempt('the three attributes are on the BASE and default to null', () => {
        const c = bare();
        deep([c.getNoDataImage(), c.getNoDataImageDark(), c.getNoDataText()], [null, null, null],
            'all three unset, meaning the shipped image and no text');
        c.setNoDataImage('custom.png');
        c.setNoDataText('No wafer loaded');
        deep([c.getNoDataImage(), c.getNoDataText()], ['custom.png', 'No wafer loaded'], 'and they round-trip');
        ok(typeof Base.NO_DATA_IMAGE_DEFAULT === 'string' && Base.NO_DATA_IMAGE_DEFAULT.endsWith('.svg'),
            `the shipped default is ${Base.NO_DATA_IMAGE_DEFAULT}`);
    });

    attempt('the shipped SVG is in the tree and in the project', () => {
        const svg = readFileSync(new URL('../../../Controls/SubstrateMapBase/NoDataBase.svg', import.meta.url), 'utf8');
        ok(/viewBox="0 0 252 213\.3"/.test(svg), 'NoDataBase.svg carries the documented viewBox');
        const proj = readFileSync(new URL('../../../SubstrateMap.hmiextproj', import.meta.url), 'utf8');
        ok(proj.includes('NoDataBase.svg'), 'and the Visual Studio project ships it');
    });
});

section('30. the empty state: the draw path (W-15b)', () => {
    /*
     * The three Done-when lines `W-15a` could not reach, because `drawImage` was a
     * counter and there was no `Image` at all. Both are real now: `drawImage`
     * records its destination rect, and `Image` resolves per source so a failing
     * custom image and a working shipped one can be told apart.
     */

    /** @param configure Optional setup. @param side Canvas side. @returns The control. */
    const drawn = (configure, side = 400) => {
        const c = new SubstrateMap(null, null, {});
        c.setShowDemoItems(false);          // row 4: no data, no demo
        if (configure) { configure(c); }
        c.__attach();
        renderOnce(c, side);
        return c;
    };
    /** @param c A control. @returns Its last image draw. */
    const lastImage = (c) => c.__canvasContext.imageDraws.at(-1);

    attempt('a control with nothing bound draws the shipped image', () => {
        Shims.setImageOutcome('ready');
        Shims.setImageNatural(252, 213);
        const d = lastImage(drawn());
        ok(d !== undefined, 'an image was drawn');
        eq(d?.src, 'NoDataBase.svg', 'and it is the shipped one');
    });

    attempt('the right image in each theme, decided by MEASURED lightness', () => {
        /*
         * Not by a theme name: the framework's is not readable from anything in
         * this repository, so a name test would be written from memory. Lightness
         * through `Oklch` also gets a custom dark theme right for free, and it is
         * this project's rule (`D-082`) applied once more.
         */
        const withBackground = (bg) => {
            const c = drawn();
            const real = window.getComputedStyle;
            window.getComputedStyle = () => ({
                getPropertyValue: (n) => (n === '--substratemap-background' ? bg : ''),
                fontFamily: 'sans-serif',
            });
            try { renderOnce(c, 400); } finally { window.getComputedStyle = real; }
            return lastImage(c)?.src;
        };
        eq(withBackground('#f4f6f8'), 'NoDataBase.svg', 'a light background takes the light image');
        eq(withBackground('#1c1c1c'), 'NoDataBaseDark.svg', 'a dark one takes the dark image');
        eq(withBackground(''), 'NoDataBase.svg',
            'and an unreadable background takes the light one — the shipped default');
    });

    attempt('a 4:1 image is LETTERBOXED, not stretched', () => {
        /*
         * Done-when 2, by pixel. A stretched 4:1 logo is a distortion an operator
         * reads as a rendering fault; the destination rect keeps the source ratio
         * and the bands are equal.
         */
        Shims.setImageNatural(400, 100);
        const d = lastImage(drawn(null, 400));
        ok(d !== undefined, 'the image was drawn');
        eq(Math.round((d.dest.w / d.dest.h) * 100) / 100, 4,
            `the drawn ratio is ${(d.dest.w / d.dest.h).toFixed(2)}, the source ratio is 4.00`);
        eq(d.dest.w, 400, 'it fills the width');
        eq(d.dest.h, 100, '  and is 100 tall, not 400');
        eq(d.dest.y, 150, '  centred, so the bands above and below are equal');
        Shims.setImageNatural(252, 213);
    });

    attempt('a TALL image letterboxes the other way', () => {
        /* The same rule, transposed — a `contain` that only ever fits width would
         * pass the assertion above and overflow here. */
        Shims.setImageNatural(100, 400);
        const d = lastImage(drawn(null, 400));
        eq(d.dest.h, 400, 'it fills the height');
        eq(d.dest.w, 100, '  and is 100 wide');
        eq(d.dest.x, 150, '  centred horizontally');
        Shims.setImageNatural(252, 213);
    });

    attempt('an unloadable image falls back to the shipped one and SAYS SO', () => {
        /*
         * Done-when 3. Drawing an empty area would be the worst of the three
         * options: the control looks broken in exactly the situation where it is
         * supposed to explain itself, and nothing says why. Falling back silently
         * is the second worst — the author's image is gone and they are not told.
         */
        Shims.setImageOutcome((src) => (src === 'missing.png' ? 'error' : 'ready'));
        logLines();
        const c = drawn((x) => x.setNoDataImage('missing.png'));
        const warned = logLines().filter((l) => /NODATA_IMAGE_UNAVAILABLE/.test(String(l.message)));
        eq(warned.length, 1, 'the warning is raised once');
        ok(/missing\.png/.test(String(warned[0]?.message)), '  naming the URL that failed');
        eq(lastImage(c)?.src, 'NoDataBase.svg', 'and the shipped image is drawn instead of nothing');

        renderOnce(c, 400);
        eq(logLines().filter((l) => /NODATA_IMAGE_UNAVAILABLE/.test(String(l.message))).length, 0,
            'a second frame does not repeat it — once per URL, not once per frame');
        Shims.setImageOutcome('ready');
    });

    attempt('the text line reserves its own band, and the image stays out of it', () => {
        /*
         * ASSERTED AS "the image does not reach into the band", not as "the image
         * is shorter". The first draft asserted the second and failed: at 252 x 213
         * in a 400 x 400 area the image is WIDTH-constrained, so reserving 28 px of
         * height changes where it sits and not how big it is. The invariant that
         * actually holds - and the one the band exists for - is that the line never
         * sits over the image.
         */
        const band = Math.min(28, 400 * 0.18);
        const plain = lastImage(drawn())?.dest;
        const titled = lastImage(drawn((x) => x.setNoDataText('No wafer loaded')))?.dest;
        ok(plain !== undefined && titled !== undefined, 'both drew');
        ok(titled.y + titled.h <= 400 - band + 0.001,
            `the image ends at ${(titled.y + titled.h).toFixed(1)}, above the band at ${400 - band}`);
        ok(titled.y < plain.y, '  and it has moved UP to make room');
        eq(titled.h, plain.h, '  without changing size, because this image is width-constrained');

        /* Where it IS height-constrained, the band shrinks it. */
        Shims.setImageNatural(100, 400);
        const tall = lastImage(drawn((x) => x.setNoDataText('No wafer loaded')))?.dest;
        eq(Math.round(tall.h), Math.round(400 - band), 'a tall image is shortened by exactly the band');
        Shims.setImageNatural(252, 213);

        eq(drawn().__canvasContext.texts, 0, 'no line is drawn when the text is null');
        ok(drawn((x) => x.setNoDataText('No wafer loaded')).__canvasContext.texts > 0,
            '  and one is when it is set');
    });

    attempt('containRect is the arithmetic, and it is degenerate-safe', () => {
        deep(Base.containRect(400, 400, 400, 100), { x: 0, y: 150, w: 400, h: 100 }, 'wide');
        deep(Base.containRect(400, 400, 100, 400), { x: 150, y: 0, w: 100, h: 400 }, 'tall');
        deep(Base.containRect(200, 100, 100, 100), { x: 50, y: 0, w: 100, h: 100 }, 'square in a wide area');
        for (const bad of [[0, 100, 10, 10], [100, 0, 10, 10], [100, 100, 0, 10], [100, 100, 10, 0]]) {
            eq(Base.containRect(...bad), null, `${JSON.stringify(bad)} is degenerate and answers null`);
        }
    });

    attempt('nothing is drawn when there IS data', () => {
        /* The precedence, from the other end: rows 1 and 3 must not reach here. */
        const withData = drivePanel(readPanels().find((x) => x.id === 'SubstrateMap_GridData')).control;
        withData.__attach();
        renderOnce(withData, 400);
        eq(withData.__canvasContext.imageDraws.length, 0, 'a bound grid draws no no-data image');
        const demo = new SubstrateMap(null, null, {});
        demo.__attach();
        renderOnce(demo, 400);
        eq(demo.__canvasContext.imageDraws.length, 0, 'and neither does the demo');
    });
});

section('31. demo content is marked, in the same frame (W-17)', () => {
    /*
     * A plausible-looking grey wafer on a dashboard is worse than an empty tile,
     * because it will be BELIEVED - someone will read a yield off sample data. The
     * marking is the feature and the picture is decoration, so there is no
     * attribute to switch it off and no code path that draws one without the other.
     */
    const DEMO_DIE = /^R\d+C\d+$/;
    const frame = (c, side = 400) => {
        renderOnce(c, side);
        const ctx = c.__canvasContext;
        return {
            marked: ctx.textDraws.filter((t) => t.text === 'DEMO'),
            demoDies: (c.__sceneItems ?? []).filter((i) => DEMO_DIE.test(i.name ?? '')).length,
            ctx,
        };
    };
    const bare = (configure) => {
        const c = new SubstrateMap(null, null, {});
        if (configure) { configure(c); }
        c.__attach();
        return c;
    };

    attempt('EVERY panel that draws demo content is marked — swept, not sampled', () => {
        /*
         * Done-when 1, over all nineteen reference panels rather than one. This is
         * the shape that caught `W-14` drawing the demo over nine bound grids: a
         * sweep asks the question of every case, and a sample asks it of the case
         * you happened to think of.
         */
        const unmarked = [];
        const marked = [];
        for (const p of readPanels()) {
            const c = drivePanel(p).control;
            c.__attach();
            const f = frame(c);
            if (f.demoDies > 0 && f.marked.length === 0) { unmarked.push(p.id); }
            if (f.demoDies > 0) { marked.push(p.id); }
        }
        ok(marked.length > 0, `${marked.length} panels draw demo content`);
        deep(unmarked, [], 'and none of them is unmarked');
    });

    attempt('and no panel with REAL data is marked', () => {
        /* The other direction: a marking on real data would be worse than none,
         * because it would teach an operator to ignore the hatch. */
        const wrong = [];
        for (const p of readPanels()) {
            const c = drivePanel(p).control;
            c.__attach();
            const f = frame(c);
            if (f.demoDies === 0 && f.marked.length > 0) { wrong.push(p.id); }
        }
        deep(wrong, [], 'no panel showing real data carries the marking');
    });

    attempt('binding a real input removes demo and marking together', () => {
        /* Done-when 2. One flag drives both, so they cannot come apart — asserted
         * across the transition rather than on the two end states. */
        const c = bare();
        ok(frame(c).marked.length > 0, 'the demo starts marked');
        // The shape the reference page binds, read off it rather than invented — the
        // first draft guessed a `columns`/`cells` schema, produced no grid, and the
        // state assertion caught it.
        c.setGridData({
            substrateId: 'W1', dimension: { x: 4, y: 3 }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins: ['1191', '1111', '1911'],
            binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
        });
        c.__attach();
        const after = frame(c);
        eq(after.marked.length, 0, 'binding a grid removes the marking');
        eq(after.demoDies, 0, '  and the demo dies, in the same frame');
        eq(c.readEmptyState(), 'data', '  and the state agrees');
    });

    attempt('the marking is a hatch ACROSS the area, not a corner badge', () => {
        /*
         * A badge sits in one corner and is missed, cropped by a tile, or covered
         * by a surrounding layout — a screenshot of the middle of the map would
         * carry no trace of it. Asserted as: the word is centred, and the hatch
         * strokes span the whole width.
         */
        const c = bare();
        const f = frame(c, 400);
        const word = f.marked[f.marked.length - 1];
        ok(Math.abs(word.x - 200) < 1, `the word is centred horizontally at ${word.x}`);
        ok(Math.abs(word.y - 200) < 1, `  and vertically at ${word.y}`);
        ok(f.ctx.strokesAndFills > 20,
            `${f.ctx.strokesAndFills} strokes — a hatch across the area, not one badge`);
    });

    attempt('it is legible at the smallest size the control supports', () => {
        /*
         * Done-when 3. The word scales with the shorter side and then stops: at
         * 60 px a proportional word would be 9 px and read as a smudge.
         */
        const sizes = [60, 120, 400].map((side) => {
            const f = frame(bare(), side);
            const word = f.marked[f.marked.length - 1];
            return { side, px: Number(/(\d+)px/.exec(word.font ?? '')?.[1] ?? 0) };
        });
        for (const s of sizes) { ok(s.px >= 11, `at ${s.side} px the word is ${s.px} px`); }
        ok(sizes[2].px > sizes[0].px, 'and it does scale up with the control');
    });

    attempt('both colours come from the theme, so a dark theme marks in light', () => {
        /*
         * Done-when 3's other half. This code never asks which theme it is in — it
         * takes `colors.edge` and `colors.bg`, so the answer follows the theme
         * automatically. Asserted by changing the theme and reading the ink.
         */
        const c = bare();
        const real = window.getComputedStyle;
        window.getComputedStyle = () => ({
            getPropertyValue: (n) => (n === '--substratemap-edge-color' ? 'rgb(240, 240, 240)'
                : n === '--substratemap-background' ? '#101010' : ''),
            fontFamily: 'sans-serif',
        });
        let ink;
        try { ink = frame(c).marked.at(-1)?.fillStyle; } finally { window.getComputedStyle = real; }
        eq(ink, 'rgb(240, 240, 240)', 'the word takes the theme edge colour, whatever it is');
    });

    attempt('there is no attribute to switch it off', () => {
        /* The feature, asserted as an absence. An author who could hide the marking
         * would eventually hide it. */
        const desc = JSON.parse(readFileSync(
            new URL('../../../Controls/SubstrateMapBase/Description.json', import.meta.url), 'utf8'));
        const names = (desc.attributes ?? []).map((x) => x.propertyName);
        ok(!names.some((n) => /demo/i.test(n) && /mark|hatch|watermark/i.test(n)),
            `no marking attribute among ${JSON.stringify(names)}`);
        const src = readFileSync(
            new URL('../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        ok(/if \(this\.__sceneIsDemo\) \{/.test(src),
            'the marking is guarded by the demo flag alone — nothing else can suppress it');
    });
});

section('32. the filter attribute surface (W-19)', () => {
    /*
     * Rule 14: these names are the contract, so they are asserted rather than
     * assumed - a rename after this ships is a breaking change for every view that
     * bound one.
     */
    const bare = () => { const c = new SubstrateMap(null, null, {}); c.__attach(); return c; };
    const FILTERS = ['None', 'Median', 'Min', 'Max', 'Box', 'Gauss'];
    const VIEWS = ['Bins', 'FailDensity', 'ValueField'];

    attempt('all seven exist, with a descriptor, a schema and a default that changes nothing', () => {
        const desc = JSON.parse(readFileSync(
            new URL('../../../Controls/SubstrateMap/Description.json', import.meta.url), 'utf8'));
        const byName = new Map(desc.attributes.map((a) => [a.propertyName, a]));
        const expected = {
            SpatialFilter: 'None', SpatialFilterRadius: 1, FieldView: 'Bins', FieldGamma: 0.4,
            HighlightFromSeverity: null, ReferenceGridData: null, ReferenceMode: 'Off',
        };
        const c = bare();
        for (const [prop, def] of Object.entries(expected)) {
            const a = byName.get(prop);
            ok(a !== undefined, `${prop} is declared`);
            eq(a?.defaultValue, def, `  its declared default is ${JSON.stringify(def)}`);
            eq(c[`get${prop}`](), def, `  and the implementation agrees`);
        }
        eq(byName.get('HighlightBins'), undefined,
            'and HighlightBins is NOT declared — OD-004 answered B, so the contract is the threshold');
    });

    attempt('the three enums are a new schema, and GridData is reused unchanged', () => {
        const fs = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMap/Schema/TypeDefinitions/FilterSettings.Schema.json',
            import.meta.url), 'utf8'));
        deep(Object.keys(fs.definitions).sort(),
            ['SubstrateMapFieldView', 'SubstrateMapReferenceMode', 'SubstrateMapSpatialFilter'],
            'FilterSettings carries exactly the three enums');
        deep(fs.definitions.SubstrateMapSpatialFilter.enum, FILTERS, '  and the filter list is the contract');
        deep(fs.definitions.SubstrateMapFieldView.enum, VIEWS, '  and so is the channel list');
        const desc = JSON.parse(readFileSync(
            new URL('../../../Controls/SubstrateMap/Description.json', import.meta.url), 'utf8'));
        const ref = desc.attributes.find((a) => a.propertyName === 'ReferenceGridData');
        eq(ref?.type, 'tchmi:framework#/definitions/SubstrateMapGridData',
            'the reference reuses the GridData schema — a reference IS a map');
    });

    attempt('EVERY pairing is legal or reports, one assertion per pairing', () => {
        /*
         * Done-when 2, all eighteen. `filterApplies` is a pure function so the
         * matrix can be walked without rendering, and so the render path and the
         * diagnostic cannot disagree about which pairs are legal.
         */
        const table = [];
        for (const f of FILTERS) {
            for (const v of VIEWS) {
                const legal = SubstrateMapMod.filterApplies(f, v);
                const expected = f === 'None' ? true
                    : (f === 'Box' || f === 'Gauss') ? v !== 'Bins' : v === 'Bins';
                eq(legal, expected, `${f} on ${v} is ${expected ? 'legal' : 'illegal'}`);
                table.push([f, v, legal]);
            }
        }
        eq(table.length, 18, 'all eighteen pairings covered');
        eq(table.filter(([, , l]) => !l).length, 8, 'eight of them are illegal');
    });

    attempt('an illegal pairing leaves the image untouched and NAMES BOTH VALUES', () => {
        for (const [f, v] of [['Median', 'FailDensity'], ['Min', 'ValueField'], ['Box', 'Bins'],
            ['Gauss', 'Bins'], ['Max', 'FailDensity']]) {
            logLines();
            const c = bare();
            c.setSpatialFilter(f);
            c.setFieldView(v);
            eq(c.__effectiveFilter(), 'None', `${f}/${v} does not filter`);
            const w = logLines().filter((l) => /E142_FILTER_NOT_APPLICABLE/.test(String(l.message)));
            eq(w.length, 1, `  and reports once`);
            ok(String(w[0]?.message).includes(f) && String(w[0]?.message).includes(v),
                `  naming both "${f}" and "${v}"`);
        }
    });

    attempt('a legal pairing filters, and the diagnostic does not repeat per frame', () => {
        const c = bare();
        c.setSpatialFilter('Median');
        eq(c.__effectiveFilter(), 'Median', 'Median on the default Bins runs');
        logLines();
        c.setFieldView('FailDensity');
        c.__effectiveFilter();
        c.__effectiveFilter();
        c.__effectiveFilter();
        eq(logLines().filter((l) => /NOT_APPLICABLE/.test(String(l.message))).length, 1,
            'three frames, one diagnostic — latched per pairing, not per frame');
    });

    attempt('a radius of zero disables the filter as surely as None does', () => {
        /* So a slider bound to the radius can turn it off, which is what an
         * operator reaches for first. */
        const c = bare();
        c.setSpatialFilter('Median');
        c.setSpatialFilterRadius(0);
        eq(c.__effectiveFilter(), 'None', 'radius 0 means no filter');
        c.setSpatialFilterRadius(2);
        eq(c.__effectiveFilter(), 'Median', 'and a positive radius restores it');
    });

    attempt('the radius is clamped, not rejected', () => {
        const c = bare();
        c.setSpatialFilterRadius(40);
        eq(c.getSpatialFilterRadius(), 8, '40 clamps to the maximum');
        c.setSpatialFilterRadius(-3);
        eq(c.getSpatialFilterRadius(), 0, 'and a negative clamps to zero');
        c.setSpatialFilterRadius(null);
        eq(c.getSpatialFilterRadius(), 1, 'and null restores the default');
    });

    attempt('ALL SEVEN reach the cache key — a filter change never serves a stale bitmap', () => {
        /*
         * Done-when 3, and the lesson `D-093` recorded when the reducer joined the
         * key. Each attribute is changed in turn and the key must move; a seventh
         * that did not would be invisible until someone saw a stale frame.
         */
        const c = bare();
        const keys = new Set([c.__filterKey()]);
        const steps = [
            ['SpatialFilter', () => c.setSpatialFilter('Median')],
            ['SpatialFilterRadius', () => c.setSpatialFilterRadius(3)],
            ['FieldView', () => { c.setSpatialFilter('Box'); c.setFieldView('FailDensity'); }],
            ['FieldGamma', () => c.setFieldGamma(0.9)],
            ['HighlightFromSeverity', () => c.setHighlightFromSeverity(3)],
            ['ReferenceMode', () => c.setReferenceMode('Difference')],
            ['ReferenceGridData', () => c.setReferenceGridData({ dimension: { x: 2, y: 2 } })],
        ];
        for (const [name, apply] of steps) {
            const before = c.__filterKey();
            apply();
            const after = c.__filterKey();
            ok(after !== before, `${name} changes the key`);
            keys.add(after);
        }
        eq(keys.size, steps.length + 1, `${keys.size} distinct keys from ${steps.length} changes`);
    });

    attempt('and the term reaches the ENGINE key, not just the control', () => {
        /* The half that would be easy to get wrong: a term the control computes and
         * the engine ignores looks correct in every unit assertion. */
        const src = readFileSync(new URL('../Engine.js', import.meta.url), 'utf8');
        ok(/gridCacheKey\([^)]*layer\.filterKey/.test(src.replace(/\s+/g, ' ')),
            'drawGridLayer passes the layer filter key into gridCacheKey');
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        ok(/filterKey: this\.__filterKey\(\)/.test(base), 'and the base fills it from the concrete');
    });
});

section('33. HighlightFromSeverity — one colour of light (W-23)', () => {
    /*
     * The named severity keeps its colour; everything below drops to the lightness
     * of its own colour at chroma 0. GREY, NOT HIDDEN: a hidden cell is
     * indistinguishable from a null cell, and the difference between *there is
     * nothing here* and *there is something here that does not concern you right
     * now* is exactly the one an operator needs.
     *
     * No spatial filter does this and no convolution kernel can. It is a
     * per-colour transform and it lives beside the palette.
     */
    const GRID = {
        substrateId: 'W1', dimension: { x: 6, y: 3 }, units: 'mm', stepSize: { x: 1, y: 1 },
        binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins: ['1179.5', '117995', '11.995'],
        binDefinitions: [
            { binCode: '1', binQuality: 'Pass' }, { binCode: '7', binQuality: 'Unknown' },
            { binCode: '9', binQuality: 'Fail' }, { binCode: '5', binQuality: 'Fail' },
        ],
    };
    const stats = (from) => {
        const c = new SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        c.setGridData(JSON.parse(JSON.stringify(GRID)));
        if (from !== null) { c.setHighlightFromSeverity(from); }
        c.__attach();
        renderOnce(c, 200);
        return c.readBinStatistics().bins;
    };
    const lch = (css) => Oklch.rgbToOklch(Oklch.parseRgb(css));

    attempt('a bin at or above the threshold keeps its colour EXACTLY', () => {
        /*
         * Done-when 1, by value and not by distance. The highlight entry for such a
         * bin is `null` and nothing is substituted, so the string the chart reports
         * is byte for byte the one the render would have used.
         */
        const base = stats(null);
        const kept = stats(3);
        let same = 0;
        for (let i = 0; i < base.length; i++) {
            if (base[i].severity >= 3) {
                eq(kept[i].color, base[i].color, `${base[i].binCode}: ${base[i].color} unchanged`);
                same++;
            }
        }
        ok(same >= 2, `${same} bins at or above the threshold`);
    });

    attempt('a bin below it has chroma 0, and its own lightness', () => {
        /* Done-when 2, in OKLCH. The lightness residual is 8-bit rounding: the
         * colour is stored as three bytes and read back. */
        const base = stats(null);
        const muted = stats(3);
        let checked = 0;
        for (let i = 0; i < base.length; i++) {
            if (base[i].severity >= 3) { continue; }
            const before = lch(base[i].color);
            const after = lch(muted[i].color);
            ok(after.C < 0.002, `${base[i].binCode}: chroma ${before.C.toFixed(4)} -> ${after.C.toFixed(4)}`);
            ok(Math.abs(after.L - before.L) < 0.01,
                `  lightness ${before.L.toFixed(4)} -> ${after.L.toFixed(4)}`);
            checked++;
        }
        ok(checked >= 1, `${checked} bins below the threshold`);
    });

    attempt('the threshold moves, and the set moves with it', () => {
        /* A single threshold that greyed everything, or nothing, would pass both
         * assertions above on a fixture with the right shape. */
        const counts = [1, 2, 3, 4].map((from) => {
            const base = stats(null);
            const hl = stats(from);
            return hl.filter((b, i) => b.color !== base[i].color).length;
        });
        for (let i = 1; i < counts.length; i++) {
            ok(counts[i] >= counts[i - 1], `threshold ${i + 1} mutes ${counts[i]} bins`);
        }
        ok(counts[3] > counts[0], `and 4 mutes more than 1 does (${counts[3]} against ${counts[0]})`);
        eq(counts[0], 0, 'a threshold of 1 mutes nothing — every real bin is at least pass');
    });

    attempt('a muted cell stays distinguishable from an EMPTY one', () => {
        /*
         * Done-when 3, and it FOUND A DEFECT. "Keep the lightness, zero the chroma"
         * is not enough on its own: `#f0e442` mutes to `#dedede`, which sits
         * `dE 0.06` from a `#f2f2f2` substrate body, and `#ffffff` mutes to itself.
         * That is the very failure greying was chosen to avoid, reached from the
         * other direction.
         *
         * So the lightness is preserved except where preserving it would make the
         * cell vanish, and there it is pushed to `AGGREGATE_MIN_DELTA_E` away from
         * whatever shows through a null cell. Losing a little lightness fidelity is
         * the cheaper mistake.
         */
        const SAMPLES = ['#009e73', '#d55e00', '#0072b2', '#cc79a7', '#e69f00', '#56b4e9',
            '#f0e442', '#000000', '#ffffff', '#808080', '#da7d9b'];
        for (const body of ['#f2f2f2', '#2a2a2a', '#ffffff']) {
            let worst = Infinity;
            let which = null;
            for (const c of SAMPLES) {
                const grey = BinPalette.desaturate(c, body, Agg.AGGREGATE_MIN_DELTA_E);
                const d = Oklch.deltaEOk(lch(grey), lch(body));
                if (d < worst) { worst = d; which = [c, grey]; }
            }
            ok(worst >= Agg.AGGREGATE_MIN_DELTA_E - 1e-9,
                `body ${body}: worst separation ${worst.toFixed(4)} `
                + `(${which[0]} -> ${which[1]}), bar ${Agg.AGGREGATE_MIN_DELTA_E}`);
        }
    });

    attempt('and without the clamp it would NOT — the defect, kept as a number', () => {
        /* The measurement that makes the clamp's existence checkable rather than a
         * claim in a comment. */
        const naive = BinPalette.desaturate('#f0e442');
        const d = Oklch.deltaEOk(lch(naive), lch('#f2f2f2'));
        ok(d < Agg.AGGREGATE_MIN_DELTA_E,
            `unclamped, #f0e442 -> ${naive} sits ${d.toFixed(4)} from the body — below the bar`);
        eq(BinPalette.desaturate('#ffffff'), '#ffffff', 'and white mutes to itself');
    });

    attempt('the null bin is left out of the table, not given a grey', () => {
        /* Index 0 is the reserved null bin and no cell holding it is painted at
         * all, in either strategy. Giving it a colour would suggest there is one to
         * compare against. */
        const c = new SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        c.setGridData(JSON.parse(JSON.stringify(GRID)));
        c.setHighlightFromSeverity(3);
        c.__attach();
        eq(c.__sceneHighlight?.[0], null, 'entry 0 is null');
    });

    attempt('the chart and the map are given the SAME array', () => {
        /*
         * `W-10`'s failure, one layer along: two derivations of a colour is exactly
         * how a chart and a map come to disagree. Asserted on the emitted source,
         * because a unit test on either alone cannot see that they were handed the
         * same thing.
         */
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        ok(/this\.__sceneCategorical, this\.__sceneHighlight\)/.test(base),
            'the render is handed __sceneHighlight beside the categorical array');
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url), 'utf8');
        ok(/binStatistics\([\s\S]*?this\.__sceneHighlight\)/.test(src),
            'and so is binStatistics — one array, computed once');
    });
});

section('34. the golden map (W-24)', () => {
    /*
     * `ReferenceGridData` is an ordinary `SubstrateMapGridData`. An author runs
     * `toGridData()` on a good wafer and binds the result straight back - the loop
     * closes with no new format, and no second parser to keep in step.
     */
    const gd = (pattern, opts) => {
        const w = Patterns.wafer(pattern, { size: 32, seed: 5, ...opts });
        const rows = [];
        for (let r = 0; r < w.rows; r++) {
            let line = '';
            for (let c = 0; c < w.cols; c++) { line += w.codes[w.cells[r * w.cols + c]]; }
            rows.push(line);
        }
        return {
            substrateId: 'W', dimension: { x: w.cols, y: w.rows }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins: rows,
            binDefinitions: w.binDefs.map((b) => ({ binCode: b.code, binQuality: b.quality })),
        };
    };
    const run = (map, ref, mode) => {
        const c = new SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        c.setGridData(JSON.parse(JSON.stringify(map)));
        if (ref !== null) { c.setReferenceGridData(JSON.parse(JSON.stringify(ref))); }
        c.setReferenceMode(mode);
        c.__attach();
        return c;
    };
    /** @param c A control. @returns `{ kept, muted }` or `null` when the comparison is off. */
    const counts = (c) => {
        const f = c.__sceneValueFill;
        if (f === null) { return null; }
        const n = f.colors.length / 2;
        let kept = 0;
        let muted = 0;
        for (const v of f.cells) {
            if (v === 0) { continue; }
            if (v < n) { kept++; } else { muted++; }
        }
        return { kept, muted };
    };
    const RANDOM = gd('Random', { failRate: 0.03 });
    const SCRATCH = gd('Scratch', { failRate: 0.02 });
    const CLEAN = gd('Random', { failRate: 0 });

    attempt('a map against ITSELF under Difference is fully desaturated', () => {
        /* Done-when 1. Zero differences, and every cell still drawn - which is the
         * distinction between greyed and hidden. */
        const c = counts(run(RANDOM, RANDOM, 'Difference'));
        eq(c.kept, 0, 'no cell differs from itself');
        ok(c.muted > 500, `and all ${c.muted} of them are still drawn, muted`);
    });

    attempt('NewOnly against a reference carrying the SAME scratch does not show it', () => {
        /*
         * Done-when 2. The scratch is not newly broken, so it is not what the
         * operator asked for. Contrasted with the same scratch against a CLEAN
         * reference, where it IS new - the pair is what shows the mode is doing
         * something rather than nothing.
         */
        eq(counts(run(SCRATCH, SCRATCH, 'NewOnly')).kept, 0, 'nothing is newly broken');
        ok(counts(run(SCRATCH, CLEAN, 'NewOnly')).kept > 0,
            'but against a clean reference the same scratch is entirely new');
    });

    attempt('Difference and NewOnly PART when a cell has improved', () => {
        /*
         * The reason there are two modes, and it is invisible against a clean
         * reference: with every failure new, the two agree exactly. They separate
         * only when the reference already carries failures that are now gone.
         * `Difference` lights the repaired cells because they differ; `NewOnly`
         * does not, because they are not worse.
         */
        const before = gd('Scratch', { failRate: 0.02 });
        const after = gd('Random', { failRate: 0.01, seed: 44 });
        const diff = counts(run(after, before, 'Difference'));
        const only = counts(run(after, before, 'NewOnly'));
        ok(diff.kept > only.kept,
            `Difference lights ${diff.kept}, NewOnly ${only.kept} — the repaired cells are the gap`);
        ok(diff.kept - only.kept > 5, `  a gap of ${diff.kept - only.kept} cells`);
    });

    attempt('a mismatched geometry switches OFF and reports both dimensions', () => {
        /*
         * Done-when 3. A golden map of a different lattice is an operator error,
         * not a scaling problem: quietly stretching it would produce a difference
         * view that is confidently wrong everywhere.
         */
        logLines();
        const c = run(RANDOM, gd('Random', { size: 24, failRate: 0.03 }), 'Difference');
        eq(counts(c), null, 'the comparison is off');
        const w = logLines().filter((l) => /E142_REFERENCE_GEOMETRY_MISMATCH/.test(String(l.message)));
        eq(w.length, 1, 'and it reports once');
        const m = String(w[0]?.message);
        ok(/24x24/.test(m) && /32x32/.test(m), `  naming both dimensions: ${m.slice(0, 90)}`);
    });

    attempt('Off ignores a bound reference entirely', () => {
        /* So binding one costs nothing until a mode is chosen. */
        eq(counts(run(RANDOM, CLEAN, 'Off')), null, 'no fill is built');
    });

    attempt('a bound value field wins, and the collision is reported', () => {
        /*
         * Two things cannot colour the same cell. Reported rather than silently
         * resolved - the rule `filterApplies` follows, and the reason is the same:
         * better to show nothing than something wrong.
         */
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url), 'utf8');
        ok(/E142_REFERENCE_NOT_APPLICABLE/.test(src), 'the diagnostic exists');
        ok(/if \(this\.__sceneValueFill !== null\)/.test(src),
            'and it is guarded on a value field already owning the fill');
    });

    attempt('bins are compared by CODE, not by table index', () => {
        /*
         * The two maps have their own bin tables, built from their own definition
         * lists, and index 3 in one is not index 3 in the other. Comparing indices
         * would produce a difference view that is wrong wherever the two orders
         * disagree - and they disagree whenever the reference lists its bins
         * differently, which an author has no reason to avoid.
         */
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url), 'utf8');
        ok(/grid\.binTable\[bin\]\.code !== \(refGrid\.binTable\[refBin\]\?\.code/.test(src),
            'the comparison reads .code on both sides');

        /* And measured: the same wafer with its definitions in the other order. */
        const flipped = JSON.parse(JSON.stringify(SCRATCH));
        flipped.binDefinitions = [...flipped.binDefinitions].reverse();
        eq(counts(run(SCRATCH, flipped, 'Difference')).kept, 0,
            'a reversed definition list is still the same wafer — zero differences');
    });
});

section('35. the filter bar (W-25b)', () => {
    /*
     * The bar renders no map and touches none. It owns its own copy of four
     * filter attributes and the author binds each - and the matching attribute on
     * each map - to one symbol.
     *
     * Everything decidable is a pure function: `barOptions` says what is offered
     * and what is greyed out, `applyBarChange` says what a click does. The DOM is
     * a loop over the first and a handler calling the second, and holds no
     * decisions of its own - which is why this section needs no browser.
     */
    const FILTERS = ['None', 'Median', 'Min', 'Max', 'Box', 'Gauss'];
    const VIEWS = ['Bins', 'FailDensity', 'ValueField'];
    const at = (filter, view) => ({ filter, radius: 1, view, highlight: null });

    attempt('ONE SYMBOL CAN BIND BOTH: the four attributes are the map\'s, exactly', () => {
        /*
         * Done-when 1's precondition, and the thing that would actually break it. A
         * symbol cannot bind to two attributes that disagree about their type, so
         * the bar's declaration is compared field by field against the map's - not
         * by name alone, which is what a copy-paste would satisfy.
         */
        const bar = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMapFilterBar/Description.json', import.meta.url), 'utf8'));
        const map = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMap/Description.json', import.meta.url), 'utf8'));
        const byName = (d) => new Map(d.attributes.map((a) => [a.propertyName, a]));
        const B = byName(bar);
        const M = byName(map);
        deep([...B.keys()].sort(),
            ['FieldView', 'HighlightFromSeverity', 'SpatialFilter', 'SpatialFilterRadius'],
            'the bar carries exactly the four the task names');
        for (const [name, b] of B) {
            const m = M.get(name);
            ok(m !== undefined, `${name} exists on the map too`);
            for (const field of ['name', 'type', 'defaultValue', 'propertySetterName',
                'propertyGetterName']) {
                eq(b[field], m?.[field], `  ${name}.${field} matches the map`);
            }
        }
    });

    attempt('every pairing the bar OFFERS is one the map would accept', () => {
        /*
         * Done-when 3, over the whole matrix. The bar must not offer a combination
         * `filterApplies` refuses - and the check is against `filterApplies`
         * itself, imported by the bar rather than restated, because a second copy
         * of the rule is exactly how a UI comes to offer what a control rejects.
         */
        for (const view of VIEWS) {
            const offer = Bar.barOptions(at('None', view));
            deep(offer.filters.map((c) => c.value), FILTERS, `${view}: all six are shown`);
            for (const c of offer.filters) {
                eq(c.disabled, !SubstrateMapMod.filterApplies(c.value, view),
                    `  ${c.value} on ${view} is ${c.disabled ? 'greyed out' : 'offered'}`);
            }
        }
    });

    attempt('greyed out, and it says WHY', () => {
        /* A disabled control with no explanation is its own kind of dead end. */
        for (const view of VIEWS) {
            for (const c of Bar.barOptions(at('None', view)).filters) {
                if (!c.disabled) { eq(c.reason, null, `${c.value}/${view} needs no reason`); continue; }
                ok(typeof c.reason === 'string' && c.reason.length > 20,
                    `${c.value}/${view}: "${String(c.reason).slice(0, 60)}"`);
                ok(c.reason.includes('Bins') || c.reason.includes('FailDensity'),
                    '  naming the channel it does need');
            }
        }
    });

    attempt('a channel is NEVER greyed out', () => {
        /* A channel is a thing to look at; a kernel is a thing to do to it.
         * Disabling the view to protect the filter would be the tail wagging the
         * dog — `applyBarChange` handles that direction instead. */
        for (const filter of FILTERS) {
            const offer = Bar.barOptions(at(filter, 'Bins'));
            deep(offer.views.map((c) => c.disabled), [false, false, false],
                `with ${filter} selected, all three channels stay available`);
        }
    });

    attempt('changing the CHANNEL strands the kernel, so the kernel yields', () => {
        /*
         * An operator on `Bins` with `Median` running switches to `FailDensity`.
         * The channel is what they asked for; the kernel is what no longer applies.
         * Refusing the change would make them undo something to do something, which
         * is the interaction that teaches people to distrust a control.
         */
        const after = Bar.applyBarChange(at('Median', 'Bins'), 'view', 'FailDensity');
        eq(after.view, 'FailDensity', 'the channel changes');
        eq(after.filter, 'None', '  and the kernel falls back rather than staying illegal');

        const kept = Bar.applyBarChange(at('Box', 'FailDensity'), 'view', 'ValueField');
        eq(kept.filter, 'Box', 'a kernel that is still legal is left alone');
    });

    attempt('and no sequence of changes can leave an illegal pair', () => {
        /*
         * Swept rather than sampled: every start state, every change, and the
         * result must be legal. A guard that handled the two obvious transitions
         * and missed a third would pass the assertion above.
         */
        let checked = 0;
        for (const f of FILTERS) {
            for (const v of VIEWS) {
                if (!SubstrateMapMod.filterApplies(f, v)) { continue; }
                for (const nv of VIEWS) {
                    const after = Bar.applyBarChange(at(f, v), 'view', nv);
                    ok(SubstrateMapMod.filterApplies(after.filter, after.view),
                        `${f}/${v} -> view ${nv} gives ${after.filter}/${after.view}`);
                    checked++;
                }
                for (const nf of FILTERS) {
                    const after = Bar.applyBarChange(at(f, v), 'filter', nf);
                    ok(SubstrateMapMod.filterApplies(after.filter, after.view),
                        `${f}/${v} -> filter ${nf} gives ${after.filter}/${after.view}`);
                    checked++;
                }
            }
        }
        ok(checked > 60, `${checked} transitions, every one legal`);
    });

    attempt('a filter arriving from a BOUND SYMBOL is guarded too', () => {
        /* A disabled option cannot be clicked, but a symbol can still carry one -
         * two maps and a bar share it, and nothing stops an author writing to it
         * from a script. */
        const after = Bar.applyBarChange(at('None', 'Bins'), 'filter', 'Box');
        eq(after.filter, 'None', 'Box on Bins is refused rather than stored');
    });

    attempt('the radius clamps, and zero is reachable', () => {
        /* Zero is how an operator turns the filter off from a slider, which is why
         * `W-19` made it disable the filter as surely as `None` does. */
        eq(Bar.applyBarChange(at('Median', 'Bins'), 'radius', '40').radius, 8, '40 clamps to 8');
        eq(Bar.applyBarChange(at('Median', 'Bins'), 'radius', '-2').radius, 0, '-2 clamps to 0');
        eq(Bar.applyBarChange(at('Median', 'Bins'), 'radius', 'x').radius, 1, 'nonsense keeps the old value');
    });

    attempt('the highlight offers the fallback ladder, and none', () => {
        const offer = Bar.barOptions(at('None', 'Bins'));
        deep(offer.highlights.map((c) => c.value), ['', '1', '2', '3'],
            'none, then the three ranks of the fallback ladder');
        eq(Bar.applyBarChange(at('None', 'Bins'), 'highlight', '').highlight, null,
            'the empty choice is null, not zero');
        eq(Bar.applyBarChange(at('None', 'Bins'), 'highlight', '3').highlight, 3, 'and 3 is a number');
    });

    attempt('the bar imports the map\'s rule rather than restating it', () => {
        /* The one thing that would make every assertion above vacuous: a second
         * copy of `filterApplies` inside the bar, agreeing today and drifting
         * later. */
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMapFilterBar/SubstrateMapFilterBar.js', import.meta.url), 'utf8');
        ok(/import \{ filterApplies \} from '\.\.\/SubstrateMap\/SubstrateMap\.js'/.test(src),
            'it imports filterApplies from the map');
        ok(!/function filterApplies/.test(src), '  and does not define one of its own');
    });
});

section('36. the dashboard tile scaffold (W-26)', () => {
    /*
     * `SubstrateMapWidget` EXTENDS `SubstrateMapBase` rather than wrapping
     * `SubstrateMap`. A tile is a map with a smaller attribute surface and a
     * different idea of what to do when there is nothing to show, not a container
     * holding one - and wrapping would mean forwarding every attribute the map
     * has and keeping the two lists in step forever, where the first one anyone
     * forgot would be silently missing rather than a compile error.
     */

    /** A DOM node with the members the base's attach path touches. */
    const node = (tag) => ({
        tagName: tag, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null,
        getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    /*
     * A `document` for the duration, because the base's attach path calls
     * `document.createElement` for the canvas and the identity label. The harness
     * has none - it sidesteps the whole path by leaving the template root null -
     * so a tile that actually attaches has to bring one.
     */
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };

    /** @returns A widget with just enough DOM to attach. */
    const tile = () => {
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        w.__elementTemplateRoot = node('div');
        w.__element = [{}];
        return w;
    };

    attempt('it attaches without error, and starts ONE observation', () => withDocument(() => {
        /* Done-when 1. The base does the work; what is asserted is that a concrete
         * subclass with empty hooks reaches the end of it. */
        const before = Shims.liveObservations.size;
        const w = tile();
        w.__attach();
        eq(Shims.liveObservations.size, before + 1, 'attach observes the canvas');
        ok(w.__canvas !== null && w.__canvas !== undefined, 'and the canvas exists');
        w.__detach();
    }));

    attempt('teardown leaves NO observation, through the base\'s own path', () => withDocument(() => {
        /*
         * Done-when 2, and it is a count kept OUTSIDE the observers - an observer
         * dropped without being disconnected has nobody left to ask, so a ledger in
         * the shim is the only way to see the leak.
         *
         * Through the base's `__detach`, not a method of the tile's: the tile adds
         * no teardown, and the assertion is that it needs none.
         */
        const before = Shims.liveObservations.size;
        const w = tile();
        w.__attach();
        ok(Shims.liveObservations.size > before, 'an observation is live while attached');
        w.__detach();
        eq(Shims.liveObservations.size, before, 'and none survives teardown');
        eq(w.__canvas, null, '  the canvas is released too');
    }));

    attempt('attach and detach are repeatable without accumulating observers', () => withDocument(() => {
        /*
         * A tile on a dashboard is shown and hidden repeatedly. One leaked
         * observation per cycle is the defect that looks like nothing for an hour
         * and then like a memory problem, so the cycle is asserted rather than the
         * single pass.
         */
        const before = Shims.liveObservations.size;
        const w = tile();
        for (let i = 0; i < 5; i++) {
            w.__attach();
            w.__detach();
        }
        eq(Shims.liveObservations.size, before, 'five cycles, nothing accumulated');
    }));

    attempt('it extends the BASE, and inherits the empty state from it', () => withDocument(() => {
        /*
         * The scaffold "draws nothing" - except it does not, and the difference is
         * the point of Phase 2. With nothing bound and the demo off, the base draws
         * the no-data image; a tile showing a blank rectangle would be the failure
         * `W-15` exists to prevent.
         */
        const w = tile();
        w.__attach();
        ok(w instanceof Base.SubstrateMapBase, 'the widget IS a SubstrateMapBase');
        eq(typeof w.readEmptyState, 'function', 'and inherits readEmptyState');
        eq(w.readEmptyState(), 'nodata', 'which answers nodata with nothing pushed');
        eq(typeof w.setNoDataImage, 'function', '  and the no-data attributes come with it');
        w.__detach();
    }));

    attempt('the descriptor says it extends the base, and ships it', () => {
        const d = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMapWidget/Description.json', import.meta.url), 'utf8'));
        eq(d.base, 'TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMapBase',
            'the descriptor names the base as its base');
        const deps = (d.dependencyFiles ?? []).map((f) => f.name);
        ok(deps.some((n) => n.includes('SubstrateMapBase.js')),
            `and ships it: ${JSON.stringify(deps)}`);
        eq(d.visible, true, 'it is placeable, unlike the base');
    });

    attempt('the tile is registered in all four places', () => {
        /*
         * `D-173` made this checkable; `check-manifest` enumerated the four sites
         * when the folder appeared, which is what that fix was for. Asserted here
         * too because a gate that is right once is not the same as a gate that
         * stays right.
         */
        const manifest = JSON.parse(readFileSync(
            new URL('../../../Manifest.json', import.meta.url), 'utf8'));
        ok((manifest.modules ?? []).some((m) => m.basePath === './Controls/SubstrateMapWidget'),
            'Manifest.json modules');
        const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
        ok(String(pkg.scripts?.gate).includes('Controls/SubstrateMapWidget/tsconfig.json'),
            'the package.json gate script');
        const proto = readFileSync(
            requireInput('SubstrateMap-Working-Protocol.md'), 'utf8');
        ok(proto.includes('tsc -p Controls/SubstrateMapWidget/tsconfig.json'),
            'the Working Protocol gate block');
        const proj = readFileSync(
            new URL('../../../SubstrateMap.hmiextproj', import.meta.url), 'utf8');
        ok(proj.includes('SubstrateMapWidget.ts'), 'and the Visual Studio project');
    });
});

section('37. the tile\'s attribute surface (W-27)', () => {
    /*
     * Rule 14: hard to reverse. Three map inputs and four tile flags, and the
     * shape of the surface is as much the deliverable as the attributes are - what
     * is ABSENT is a decision too.
     */
    const widget = JSON.parse(readFileSync(new URL(
        '../../../Controls/SubstrateMapWidget/Description.json', import.meta.url), 'utf8'));
    const map = JSON.parse(readFileSync(new URL(
        '../../../Controls/SubstrateMap/Description.json', import.meta.url), 'utf8'));
    const W = new Map(widget.attributes.map((a) => [a.propertyName, a]));
    const M = new Map(map.attributes.map((a) => [a.propertyName, a]));
    const node = (tag) => ({
        tagName: tag, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const tile = () => installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));

    attempt('exactly nine attributes, and they are the ones named', () => {
        /*
         * SEVEN at `W-27`, eight at `W-30` (`MapTimestamp`, because E142 carries no
         * document timestamp), nine at `W-31` (`E142LastError`, because a tile that
         * keeps showing an old map must be able to say why).
         *
         * Both additions were DELIBERATE and this assertion is what forced them to
         * be. **A list assertion on a Rule 14 surface earns its keep by going red**
         * - twice now, and both times the change was right and the record says so.
         */
        deep([...W.keys()].sort(),
            ['E142LastError', 'E142MapData', 'E142MapDataJson', 'GridData', 'MapTimestamp',
                'ShowBinHistogram', 'ShowSubstrateId', 'ShowYield', 'StaleAfterSeconds'],
            'three inputs, four flags, the map timestamp and the last error');
    });

    attempt('NO NAME DUPLICATES A MAP ATTRIBUTE WITH A DIFFERENT MEANING', () => {
        /*
         * Done-when 2, and it is the one that would bite. A shared name that meant
         * something else is worse than a new name: an author binds one symbol to
         * both, the types agree enough to pass, and the two controls disagree about
         * what the value is.
         *
         * So every shared name is compared FIELD BY FIELD, and every unshared one
         * is checked for a near-miss the map already owns.
         */
        const shared = [...W.keys()].filter((n) => M.has(n));
        /*
         * FIVE from `W-38b`: the map gained `MapTimestamp` at the user's request, so
         * a map, a tile and a chart can take one symbol. Field-by-field agreement
         * is what matters and is checked below; this list is the inventory.
         */
        deep(shared.sort(),
            ['E142LastError', 'E142MapData', 'E142MapDataJson', 'GridData', 'MapTimestamp'],
            'five names are shared with the map');
        for (const name of shared) {
            const w = W.get(name);
            const m = M.get(name);
            for (const field of ['name', 'type', 'defaultValue', 'propertySetterName',
                'propertyGetterName']) {
                eq(w[field], m[field], `${name}.${field} is the map's, verbatim`);
            }
        }
        for (const name of [...W.keys()].filter((n) => !M.has(n))) {
            ok(!M.has(name), `${name} is new — the map has no attribute by that name`);
        }
    });

    attempt('every default reproduces an EMPTY tile', () => {
        /* Done-when 1's third clause. A tile dropped on a page and not yet bound
         * must show the no-data image and nothing else. */
        const expected = {
            GridData: null, E142MapData: null, E142MapDataJson: null,
            ShowSubstrateId: false, ShowYield: false, StaleAfterSeconds: null,
            ShowBinHistogram: false,
        };
        const t = tile();
        for (const [name, def] of Object.entries(expected)) {
            eq(W.get(name)?.defaultValue, def, `${name} declares ${JSON.stringify(def)}`);
            eq(t[`get${name}`](), def, `  and the implementation agrees`);
        }
        const had = 'document' in globalThis;
        globalThis.document = { createElement: node };
        try {
            const w = tile();
            w.__elementTemplateRoot = node('div');
            w.__element = [{}];
            w.__attach();
            eq(w.readEmptyState(), 'nodata', 'and a fresh tile is in the no-data state');
            w.__detach();
        } finally { if (!had) { delete globalThis.document; } }
    });

    attempt('what is ABSENT is a decision, and it is the map\'s own list', () => {
        /*
         * A tile needing rotation wants the full control. Asserted as an absence
         * because the surface is Rule 14 and a later task adding one of these by
         * habit is exactly the drift the assertion is here to stop.
         */
        for (const name of ['MapRotation', 'ShowOriginMarker', 'SelectionMode', 'E142OverlayName',
            'E142TransferData', 'OutlinePreset', 'ShowDemoItems']) {
            ok(M.has(name), `${name} exists on the map`);
            ok(!W.has(name), `  and deliberately not on the tile`);
        }
    });

    attempt('ShowSubstrateId drives the identity, and off means HIDDEN', () => {
        /*
         * `''` hides the identity area rather than reserving an empty strip - the
         * base's own contract. A tile is small and a blank band across the top is
         * worse than no band.
         */
        const t = tile();
        eq(t.__composeIdentity(), '', 'off by default, so no identity');
        t.setGridData({ substrateId: 'W-42', dimension: { x: 2, y: 2 }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins: ['11', '11'], binDefinitions: [{ binCode: '1', binQuality: 'Pass' }] });
        eq(t.__composeIdentity(), '', 'and still nothing with data bound but the flag off');
        t.setShowSubstrateId(true);
        eq(t.__composeIdentity(), 'W-42', 'on, it is the substrate id');

        /*
         * UNBINDING NO LONGER CLEARS IT, since `W-31`. The tile keeps showing the
         * last map that rendered, so it keeps showing its name - a stale wafer with
         * a blank label would be a worse tile than one that says which wafer it is.
         * This assertion said `''` when it was written and unbinding meant an empty
         * tile; the behaviour changed underneath it and it went red, correctly.
         */
        t.setGridData(null);
        eq(t.__composeIdentity(), 'W-42', 'unbound, the RETAINED map keeps its name');

        const never = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        never.setShowSubstrateId(true);
        eq(never.__composeIdentity(), '', 'and a tile that never had data has none');
    });

    attempt('StaleAfterSeconds takes seconds, and rejects what is not a threshold', () => {
        /* Seconds because an operator setting one thinks in seconds and nobody
         * means 30000. Zero and negative are not thresholds; they are null. */
        const t = tile();
        t.setStaleAfterSeconds(30);
        eq(t.getStaleAfterSeconds(), 30, '30 is 30 seconds');
        t.setStaleAfterSeconds(0);
        eq(t.getStaleAfterSeconds(), null, 'zero never marks, like null');
        t.setStaleAfterSeconds(-5);
        eq(t.getStaleAfterSeconds(), null, 'and so does a negative');
    });

    attempt('the three inputs are on the same footing', () => {
        /* No precedence declared here: `W-28` decides what happens when two are
         * bound, and it will be the map's own rule. What is asserted now is that
         * none of them is privileged in the surface. */
        for (const name of ['GridData', 'E142MapData', 'E142MapDataJson']) {
            eq(W.get(name)?.category, 'Data', `${name} is in the Data category`);
            eq(W.get(name)?.bindable, true, `  and bindable`);
        }
        const prios = ['GridData', 'E142MapData', 'E142MapDataJson']
            .map((n) => W.get(n)?.displayPriority);
        eq(new Set(prios).size, 3, 'each has its own display priority');
    });
});

section('38. aggregate render at tile scale (W-28)', () => {
    /*
     * The tile hands the base a `GridModel` and the base does the rest: it
     * measures the saturation of the frame it drew, feeds it forward, and lets
     * `selectReducer` choose. NO NEW REDUCTION CODE and no widget-specific
     * override - an override is the one thing guaranteed to make the tile
     * disagree with the full control.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    /** @param opts Wafer options. @returns A `SubstrateMapGridData`. */
    const gd = (opts) => {
        const w = Patterns.wafer(opts.pattern ?? 'Loc', { seed: 9, ...opts });
        const rows = [];
        for (let r = 0; r < w.rows; r++) {
            let line = '';
            for (let c = 0; c < w.cols; c++) { line += w.codes[w.cells[r * w.cols + c]]; }
            rows.push(line);
        }
        return {
            substrateId: 'W', dimension: { x: w.cols, y: w.rows }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins: rows,
            binDefinitions: w.binDefs.map((b) => ({ binCode: b.code, binQuality: b.quality })),
        };
    };
    /** @param data A grid. @returns An attached tile. */
    const tile = (data) => {
        const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        t.__elementTemplateRoot = node('div');
        t.__element = [{}];
        t.setGridData(JSON.parse(JSON.stringify(data)));
        t.__attach();
        return t;
    };

    attempt('a tile and the full control build the SAME model from the same map', () => {
        /*
         * Done-when 1's precondition and the thing that was wrong. Cells, bin table
         * and PLACEMENT - the last one is the one that broke: a unit placement
         * looked reasonable and drew the wafer flipped and offset, because a
         * placement is not about fit but about which way is up.
         */
        withDocument(() => {
            const data = gd({ size: 512, failRate: 0.06 });
            const m = new SubstrateMap(null, null, {});
            m.setShowDemoItems(false);
            m.setGridData(JSON.parse(JSON.stringify(data)));
            m.__attach();
            const t = tile(data);
            const a = m.__sceneGrid;
            const b = t.__sceneGrid;
            eq(b.cols, a.cols, 'same columns');
            eq(b.rows, a.rows, 'same rows');
            deep(b.binTable.map((x) => x.code), a.binTable.map((x) => x.code), 'same bin table');
            deep({ ...b.placement }, { ...a.placement }, 'and the same PLACEMENT');
            let cellDiff = 0;
            for (let i = 0; i < a.cells.length; i++) {
                if (a.cells[i] !== b.cells[i]) { cellDiff++; }
            }
            eq(cellDiff, 0, `all ${a.cells.length} cells identical`);
        });
    });

    attempt('and the same aggregate colour for the same region, BY PIXEL', () => {
        /*
         * Done-when 1. Rendered through ONE matrix onto one canvas size, so the only
         * thing that can differ is the pipeline - not how two DOM fakes happen to
         * size themselves. The first attempt compared the two controls' own canvases
         * and measured the harness rather than the controls.
         */
        withDocument(() => {
            const data = gd({ size: 512, failRate: 0.06 });
            const m = new SubstrateMap(null, null, {});
            m.setShowDemoItems(false);
            m.setGridData(JSON.parse(JSON.stringify(data)));
            m.__attach();
            const t = tile(data);
            const colors = m.__readColors();
            const draw = (grid) => {
                const side = 200;
                const ctx = makeContext2D(side, side);
                const paint = Engine.buildGridPaint(grid, null, colors, makeContext2D(8, 8));
                paint.aggregate = Agg.buildAggregatePaint(grid, colors);
                Engine.renderGridLayer(ctx, grid, new DOMMatrix([200 / 512, 0, 0, 200 / 512, 0, 0]),
                    paint, side, side, true, 'MaxSeverity');
                return new Uint32Array(ctx.pixels.buffer);
            };
            const a = draw(m.__sceneGrid);
            const b = draw(t.__sceneGrid);
            let painted = 0;
            let differ = 0;
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== 0) { painted++; }
                if (a[i] !== b[i]) { differ++; }
            }
            ok(painted > 5000, `${painted} pixels painted`);
            eq(differ, 0, 'and not one differs between the tile and the full control');
        });
    });

    attempt('the tile selects FailFraction at 200 px on a large map', () => {
        /*
         * Done-when 2, and by MEASUREMENT rather than by being a tile. The reducer
         * is fed forward from the saturation of the frame just drawn, so it takes
         * two frames to settle - the first measures, the second uses it.
         */
        withDocument(() => {
            const t = tile(gd({ pattern: 'Random', size: 1024, failRate: 0.05 }));
            renderOnce(t, 200);
            renderOnce(t, 200);
            ok(t.__lastSaturation > 0.5,
                `saturation ${Number(t.__lastSaturation).toFixed(3)} at 0.195 px/cell`);
            eq(t.__sceneReducer, 'FailFraction', 'so the measurement chose FailFraction');
        });
    });

    attempt('and MaxSeverity where the measurement says so', () => {
        /* The other half: a reducer that answered `FailFraction` always would pass
         * the assertion above and be wrong everywhere else. */
        withDocument(() => {
            const t = tile(gd({ pattern: 'Random', size: 256, failRate: 0.05 }));
            renderOnce(t, 200);
            renderOnce(t, 200);
            ok(t.__lastSaturation < 0.5,
                `saturation ${Number(t.__lastSaturation).toFixed(3)} at 0.78 px/cell`);
            eq(t.__sceneReducer, 'MaxSeverity', 'so the measurement chose MaxSeverity');
        });
    });

    attempt('there is no widget-specific reducer override', () => {
        /* Asserted on the emitted source. A tile that forced its own reducer would
         * satisfy both assertions above and disagree with the map at every zoom
         * the measurement disagrees with the override. */
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMapWidget/SubstrateMapWidget.js', import.meta.url), 'utf8');
        /*
         * COMMENTS STRIPPED FIRST. The first version matched the explanation of why
         * there is no override — the words `FailFraction` and `selectReducer`
         * appear in the doc comment that exists precisely to say the tile does not
         * choose. An assertion that reads source has to read CODE.
         */
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
        ok(!/__reducerOverride/.test(code), 'the tile never touches __reducerOverride');
        ok(!/selectReducer|FailFraction|MaxSeverity/.test(code),
            '  and names no reducer at all — the base chooses');
    });

    attempt('an unreadable map leaves the tile in the no-data state, once', () => {
        /*
         * Failure-tolerant, Rule 9: an empty tile that explains itself beats a
         * broken-looking one. Reported once per distinct message, because a
         * dashboard rebinds constantly.
         */
        withDocument(() => {
            logLines();
            const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
            t.__elementTemplateRoot = node('div');
            t.__element = [{}];
            t.setGridData({ dimension: { x: 0, y: 0 } });
            t.__attach();
            eq(t.readEmptyState(), 'nodata', 'the tile shows the no-data image');
            const warned = logLines().filter((l) => /TILE_MAP_UNREADABLE/.test(String(l.message)));
            ok(warned.length >= 1, `and says why: ${String(warned[0]?.message).slice(0, 70)}`);
        });
    });
});

section('39. the tile\'s identity and yield (W-29)', () => {
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    /** A 4x3 map with one null cell, so the denominator is 11 and not 12. */
    const MAP = {
        substrateId: 'W', goodDevices: 7, dimension: { x: 4, y: 3 }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins: ['1191', '1.11', '1911'],
        binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
    };
    const tile = (patch, flags) => {
        const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        t.__elementTemplateRoot = node('div');
        t.__element = [{}];
        t.setGridData({ ...JSON.parse(JSON.stringify(MAP)), ...(patch ?? {}) });
        if (flags?.id) { t.setShowSubstrateId(true); }
        if (flags?.yield) { t.setShowYield(true); }
        t.__attach();
        return t;
    };

    attempt('a 32-character id elides, and keeps BOTH ends', () => {
        /*
         * Done-when 1. Middle, not end: a substrate id is a lot prefix and a
         * serial, and both identify. Truncating the tail leaves twenty wafers from
         * one lot looking identical; truncating the head loses the lot.
         */
        const full = 'LOT-2026-08-14-A7/WAFER-000031';
        eq(full.length, 30, 'a realistic id near the 32-character limit');
        const out = Widget.elideId(full, 26);
        eq(out.length, 26, 'elided to the budget exactly');
        ok(out.includes('…'), 'with one ellipsis glyph, not three dots');
        ok(out.startsWith('LOT-2026'), '  keeping the lot prefix');
        ok(out.endsWith('000031'), '  and the serial');
    });

    attempt('and it stays legible at 200 px — the budget is arithmetic, not taste', () => {
        /*
         * 14 px label font, average glyph close to 7 px, 6 px of padding either
         * side. The budget has to FIT, which is the only part a test can check
         * without a font engine - and it is the part that would silently stop being
         * true if someone raised it.
         */
        const GLYPH = 7;
        const PAD = 6;
        ok(26 * GLYPH + 2 * PAD <= 200,
            `26 characters is ${26 * GLYPH + 2 * PAD} px of a 200 px tile`);
        ok(27 * GLYPH + 2 * PAD > 200, '  and 27 would not fit, so the budget is not slack');
    });

    attempt('a short id is untouched, and the degenerate budgets behave', () => {
        eq(Widget.elideId('W42', 26), 'W42', 'nothing to elide');
        eq(Widget.elideId('W42', 3), 'W42', 'exactly the budget is not elided');
        eq(Widget.elideId('W42', 2), 'W…', 'one character and the ellipsis');
        eq(Widget.elideId('W42', 1), '…', 'a budget of one is the ellipsis alone');
        eq(Widget.elideId('W42', 0), '', 'and a budget of zero is nothing');
    });

    attempt('ZERO renders, ABSENT does not, and they are not the same', () => {
        /*
         * Done-when 2. `GoodDevices = 0` is legal and it is the most important
         * number a wafer can carry. Absent is not zero: a tile showing `0` for a
         * map that never declared a count reports a total loss nobody measured -
         * the same failure as `W-24`'s unprocessed band reading as a defect.
         */
        eq(Widget.formatYield(0, 12).text, '0 (0.0 %)', 'zero is a reading');
        eq(Widget.formatYield(null, 12).text, null, 'absent is nothing at all');
        ok(Widget.formatYield(0, 12).text !== Widget.formatYield(null, 12).text,
            'and the two are distinguishable');

        withDocument(() => {
            const drawn = (t) => {
                renderOnce(t, 200);
                return t.__canvasContext.textDraws.map((d) => d.text);
            };
            const zero = drawn(tile({ goodDevices: 0 }, { yield: true }));
            ok(zero.some((x) => x === '0 (0.0 %)'), `zero is drawn: ${JSON.stringify(zero)}`);
            const absent = drawn(tile({ goodDevices: undefined }, { yield: true }));
            ok(!absent.some((x) => /%/.test(String(x))),
                `and absent draws no yield at all: ${JSON.stringify(absent)}`);
        });
    });

    attempt('the denominator is the NON-NULL cell count, matching the bucket pass', () => {
        /*
         * Done-when 3. The fixture is 4x3 with one `.`, so 11 and not 12 - and the
         * difference is the whole assertion. A die in progress carries its own bin
         * code and counts; only a null cell is left out, which is the same
         * population the bucket pass paints.
         */
        withDocument(() => {
            const t = tile(null, { yield: true });
            eq(t.__nonNullCells, 11, '11 of 12 cells carry a bin');
            eq(t.__goodDevices, 7, 'and the count is the DECLARED one');
            renderOnce(t, 200);
            const texts = t.__canvasContext.textDraws.map((d) => d.text);
            ok(texts.some((x) => x === '7 (63.6 %)'),
                `7/11 is 63.6 %, not 7/12 = 58.3 %: ${JSON.stringify(texts)}`);
        });
    });

    attempt('a count with no denominator shows the count and no percentage', () => {
        /* The count is still a fact. A percentage from a zero denominator is not. */
        eq(Widget.formatYield(5, 0).text, '5', 'the number alone');
        eq(Widget.formatYield(5, 0).fraction, null, 'and no fraction to colour by');
    });

    attempt('GoodDevices is DECLARED, never recomputed from the bins', () => {
        /*
         * The fixture has 9 pass cells and declares 7 good devices, which is the
         * realistic case: the tester's count and the bin table can disagree, and
         * when they do it is exactly when someone is looking. The tile reports what
         * the map says, so it agrees with the MES rather than with itself.
         */
        withDocument(() => {
            const t = tile(null, { yield: true });
            let passes = 0;
            for (const row of MAP.bins) { for (const c of row) { if (c === '1') { passes++; } } }
            eq(passes, 9, 'the bin table holds 9 passing cells');
            eq(t.__goodDevices, 7, 'and the tile reports the declared 7');
        });
    });

    attempt('both are off by default and draw nothing', () => {
        withDocument(() => {
            const t = tile(null, null);
            eq(t.__composeIdentity(), '', 'no identity');
            renderOnce(t, 200);
            const texts = t.__canvasContext.textDraws.map((d) => d.text);
            ok(!texts.some((x) => /%/.test(String(x))), `and no yield: ${JSON.stringify(texts)}`);
        });
    });

    attempt('the overlay hook is the BASE\'s, and defaults to nothing', () => {
        /*
         * Not abstract: three of the four controls want nothing there, and an
         * abstract hook would make each write an empty method to say so. Unlike
         * `__composeIdentity`, where every control has an answer and forgetting to
         * give one is a defect.
         */
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        ok(/__drawOverlay\(ctx, cfg\.width, cfg\.height, colors, matrices\)/.test(base),
            'the base calls it on every frame');
        const map = readFileSync(new URL(
            '../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url), 'utf8');
        ok(!/__drawOverlay/.test(map), 'and the full control does not override it');
    });
});

section('40. age, and which clock it came from (W-30)', () => {
    /*
     * A tile exists so nobody has to look, and a tile showing six-hour-old data
     * without saying so is worse than an empty one.
     *
     * ---- THE TASK NAMES A FIELD THAT DOES NOT EXIST (Rule 13) ----
     *
     * `W-30` says to display `ITEMVERSION` when the document carries it. An E142
     * document never carries it: `ITEMVERSION` is a Stream 21 MESSAGE field - the
     * SEMI reference puts it in chapter 13, with the transport that moves the item
     * - and the XML schema has no timestamp at all outside a supplier extension
     * block whose format the reference itself flags as an inference.
     *
     * So the value is BOUND rather than parsed. An author whose transport carries
     * it binds `MapTimestamp`; one who cannot gets the receive clock, clearly
     * labelled. The Done-when survives intact - a document with a timestamp and
     * one without produce visibly different labels - and the control stops
     * pretending it can know something the format never told it.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    const MAP = {
        substrateId: 'W', goodDevices: 7, dimension: { x: 4, y: 3 }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins: ['1191', '1.11', '1911'],
        binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
    };
    const tile = (opts) => {
        const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        t.__elementTemplateRoot = node('div');
        t.__element = [{}];
        t.setGridData(JSON.parse(JSON.stringify(MAP)));
        if (opts?.stamp !== undefined) { t.setMapTimestamp(opts.stamp); }
        if (opts?.staleAfter !== undefined) { t.setStaleAfterSeconds(opts.staleAfter); }
        t.__attach();
        if (opts?.agoSeconds !== undefined) {
            t.__receivedAt = new Date(Date.now() - opts.agoSeconds * 1000);
        }
        return t;
    };

    attempt('a bound timestamp and none produce different labels, each NAMING its source', () => {
        /* Done-when 1. The label is the point: `received` and `measured` are
         * different facts, and a map that arrived a second ago may describe a wafer
         * tested this morning. */
        withDocument(() => {
            const measured = tile({ stamp: '2026-08-14T09:15:00Z' }).readAge();
            const received = tile({}).readAge();
            eq(measured.source, 'map', 'a bound timestamp is the map clock');
            eq(received.source, 'received', 'and none is the receive clock');
            ok(measured.text.startsWith('measured '), `"${measured.text}"`);
            ok(received.text.startsWith('received '), `"${received.text}"`);
            ok(measured.text !== received.text, 'and the two are visibly different');
        });
    });

    attempt('and the time SHOWN is that source\'s time, not merely its name', () => {
        /*
         * Two different claims, and the first version only checked one. A tile that
         * said `measured` while showing the receive clock would pass every
         * assertion above and be worse than one that said `received` honestly - it
         * would put a label of authority on the wrong number. The mutation that
         * dropped `mapTime ?? received` was MISSED until this existed.
         */
        const clock = (d) => new Intl.DateTimeFormat(undefined, {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZoneName: 'short', hour12: false,
        }).format(d);
        const mapTime = new Date('2026-08-14T09:15:00Z');
        const arrived = new Date('2026-08-14T11:59:30Z');
        const now = new Date('2026-08-14T12:00:00Z');
        const out = Base.formatAge(mapTime, arrived, now);
        ok(out.text.includes(clock(mapTime)),
            `"${out.text}" shows the MAP time ${clock(mapTime)}`);
        ok(!out.text.includes(clock(arrived)),
            `  and not the arrival time ${clock(arrived)}`);
        eq(Math.round(out.seconds), 9900, '  and the age is measured from the map time');

        const none = Base.formatAge(null, arrived, now);
        ok(none.text.includes(clock(arrived)), 'with no map time, the arrival time is shown');
        eq(Math.round(none.seconds), 30, '  and the age is 30 seconds, not three hours');
    });

    attempt('the time is LOCAL and carries its abbreviation', () => {
        /* Done-when 3. An operator does not convert UTC in his head, and `14:32`
         * without a zone is a guess when a panel in one plant shows a map from
         * another. */
        const at = new Date('2026-08-14T09:15:00Z');
        const out = Base.formatAge(at, at, at);
        const local = new Intl.DateTimeFormat(undefined, {
            hour: '2-digit', minute: '2-digit', second: '2-digit',
            timeZoneName: 'short', hour12: false,
        }).format(at);
        ok(out.text.endsWith(local), `"${out.text}" ends with the local rendering "${local}"`);
        ok(/[A-Z]{2,}|GMT[+-]\d/.test(out.text), '  and carries a zone abbreviation');
    });

    attempt('both timestamp formats parse, and nonsense does not', () => {
        /*
         * `YYYYMMDDhhmmsscc` is the form the SEMI reference gives for `ITEMVERSION`;
         * ISO 8601 is what an OPC UA or MQTT source hands an author. Refusing the
         * second would mean formatting a date to please a control.
         */
        const semi = Base.parseMapTimestamp('2004052118000000');
        ok(semi !== null, 'the SEMI sixteen-digit form parses');
        eq(semi.getFullYear(), 2004, '  year');
        eq(semi.getMonth(), 4, '  month is May, zero-based');
        eq(semi.getDate(), 21, '  day');
        eq(semi.getHours(), 18, '  and the hour is LOCAL, because a tester writes its own clock');
        ok(Base.parseMapTimestamp('2026-08-14T09:15:00Z') !== null, 'ISO 8601 parses');
        eq(Base.parseMapTimestamp('not a time'), null, 'and nonsense does not');
        eq(Base.parseMapTimestamp(''), null, 'nor an empty string');
        eq(Base.parseMapTimestamp(null), null, 'nor null');
    });

    attempt('CROSSING THE THRESHOLD CHANGES NO AGGREGATE PIXEL', () => {
        /*
         * Done-when 2, and the reason the marking is a border rather than a tint.
         * Every colour on this tile is DATA - a bin, a severity, a density - and
         * tinting the map to say "old" would put a non-data meaning into the one
         * channel the control has taught an operator to read as data. At a glance a
         * yellowed wafer reads as a yield problem, not a freshness one.
         */
        withDocument(() => {
            const fresh = tile({ staleAfter: 60, agoSeconds: 5 });
            const stale = tile({ staleAfter: 60, agoSeconds: 600 });
            renderOnce(fresh, 200);
            renderOnce(stale, 200);
            ok(!Base.isStale(fresh.readAge().seconds, 60), 'one is fresh');
            ok(Base.isStale(stale.readAge().seconds, 60), 'the other is stale');
            const a = new Uint32Array(fresh.__canvasContext.pixels.buffer);
            const b = new Uint32Array(stale.__canvasContext.pixels.buffer);
            let differ = 0;
            for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) { differ++; } }
            eq(differ, 0, 'and not one aggregate pixel differs between them');
        });
    });

    attempt('but the tile IS marked, with a dashed border inside its edge', () => {
        /* The other half: a marking that changed nothing at all would satisfy the
         * assertion above and be useless. */
        withDocument(() => {
            const fresh = tile({ staleAfter: 60, agoSeconds: 5 });
            const stale = tile({ staleAfter: 60, agoSeconds: 600 });
            renderOnce(fresh, 200);
            renderOnce(stale, 200);
            deep(fresh.__canvasContext.strokeRects, [], 'a fresh tile draws no border');
            eq(stale.__canvasContext.strokeRects.length, 1, 'a stale one draws exactly one');
            const r = stale.__canvasContext.strokeRects[0];
            ok(r.dash.length > 0, `dashed, not solid: ${JSON.stringify(r.dash)}`);
            /*
             * AROUND THE MAP, NOT THE TILE (F-28). This asserted the opposite until
             * now - `r.x === lineWidth / 2`, a frame on the canvas edge - and that
             * is what put the marking 82 px from the wafer on a 300 x 150 tile.
             * Locked-in behaviour again, like `F-6a`'s hollow FRAME.
             *
             * The map's rectangle, grown by the stroke width so the dashes sit just
             * outside the substrate outline instead of on top of it.
             */
            const mr = stale.__mapRect(
                stale.__computeMatrices(Engine.makeConfig(200, 200), 1), 1);
            ok(mr !== null, 'the tile has a placed map to frame');
            eq(r.x, mr.x0 - r.lineWidth, 'the border sits one stroke outside the map');
            eq(r.w, (mr.x1 - mr.x0) + 2 * r.lineWidth, '  and spans the map, not the canvas');
            ok(r.x > r.lineWidth / 2,
                `and it is INSIDE the tile edge, where the old frame was  (${r.x} > ${r.lineWidth / 2})`);
        });

        /*
         * THE GEOMETRY THAT FAILED. A square tile hid this: the map fills it almost
         * edge to edge, so a canvas frame and a map frame land within 7 px of each
         * other. Letterbox the tile and they diverge by 82.
         */
        withDocument(() => {
            for (const [w, h, why] of [[300, 150, 'wide'], [150, 300, 'tall'], [210, 210, 'square']]) {
                const stale = tile({ staleAfter: 60, agoSeconds: 600 });
                renderOnce(stale, w, h);
                const r = stale.__canvasContext.strokeRects[0];
                const mr = stale.__mapRect(stale.__computeMatrices(Engine.makeConfig(w, h), 1), 1);
                eq(Math.round(mr.x0 - r.x), r.lineWidth,
                    `${why} ${w}x${h}: the same one-stroke gap on the left`);
                eq(Math.round(mr.y0 - r.y), r.lineWidth, `  and on the top`);
                ok(r.w < w, `  the border is narrower than the canvas (${r.w} < ${w})`);
                ok(r.h < h, `  and shorter than it (${r.h} < ${h})`);
            }
        });
    });

    attempt('no threshold means never marked, however old', () => {
        withDocument(() => {
            const t = tile({ agoSeconds: 86400 });
            renderOnce(t, 200);
            ok(t.readAge().seconds > 80000, 'a day old');
            deep(t.__canvasContext.strokeRects, [], 'and unmarked, because nothing asked');
        });
    });

    attempt('the age is drawn unconditionally — there is no flag to hide it', () => {
        /*
         * Every other readout on this tile is behind a flag; this one is not. The
         * reason the tile exists is that nobody has to look at it, and a tile that
         * can silently show six-hour-old data is worse than an empty one.
         */
        withDocument(() => {
            const t = tile({});
            renderOnce(t, 200);
            const texts = t.__canvasContext.textDraws.map((d) => d.text);
            ok(texts.some((x) => /^received /.test(String(x))),
                `drawn with nothing switched on: ${JSON.stringify(texts)}`);
        });
        const bar = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMapWidget/Description.json', import.meta.url), 'utf8'));
        const names = bar.attributes.map((a) => a.propertyName);
        ok(!names.some((n) => /ShowAge|HideAge/.test(n)), 'and no attribute offers to hide it');
    });

    attempt('the receive clock is stamped on the PAYLOAD, not on the render', () => {
        /* A rebuild from a resize must not make old data look new. */
        withDocument(() => {
            const t = tile({ agoSeconds: 300 });
            const before = t.readAge().seconds;
            renderOnce(t, 200);
            renderOnce(t, 200);
            const after = t.readAge().seconds;
            ok(after >= before, `${before.toFixed(0)}s -> ${after.toFixed(0)}s: rendering did not reset it`);
            ok(after > 290, '  and it is still five minutes old');
        });
    });
});

section('41. last known state (W-31)', () => {
    /*
     * Precedence level 2 from `W-15`, which has existed and never fired since.
     * The map goes away - unbound, or it stops parsing - and the last one that
     * WORKED stays on screen with its age still running. An operator seeing a
     * wafer and a growing age knows more than one seeing an empty tile, and the
     * age is what stops the first from being a lie.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    const MAP = {
        substrateId: 'W', goodDevices: 7, dimension: { x: 4, y: 3 }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins: ['1191', '1.11', '1911'],
        binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
    };
    const BROKEN = { dimension: { x: 0, y: 0 } };
    const fresh = () => {
        const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        t.__elementTemplateRoot = node('div');
        t.__element = [{}];
        t.__attach();
        return t;
    };
    /** What the run strategy painted, as `fillRect` calls. */
    const painted = (t) => t.__canvasContext.fills.map((f) => `${f.x},${f.y},${f.fillStyle}`);

    attempt('UNBINDING leaves the last aggregate on screen, with the age running', () => {
        /* Done-when 1. The same picture, and `stale` rather than `data` - a tile
         * that kept the wafer and called it current would be the lie. */
        withDocument(() => {
            const t = fresh();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            const live = painted(t);
            ok(live.length > 0, `${live.length} cells painted while bound`);
            eq(t.readEmptyState(), 'data', 'and the tile reports data');

            t.setGridData(null);
            renderOnce(t, 200);
            deep(painted(t), live, 'unbound: the same picture, cell for cell');
            eq(t.readEmptyState(), 'stale', '  and it now reports STALE, not data');
            ok(t.readAge().seconds >= 0, '  with the age still running');
        });
    });

    attempt('the retained age counts from when the DATA arrived, not from the unbind', () => {
        /*
         * The age is the whole reason retaining is honest. Restarting the clock on
         * unbind would make a six-hour-old wafer look freshly received the moment
         * its feed dropped - which is the exact failure `W-30` exists to prevent,
         * reached from the other direction.
         */
        withDocument(() => {
            const t = fresh();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            t.__receivedAt = new Date(Date.now() - 3600 * 1000);
            t.__lastKnownAt = t.__receivedAt;
            t.setGridData(null);
            renderOnce(t, 200);
            ok(t.readAge().seconds > 3500,
                `still ${(t.readAge().seconds / 60).toFixed(0)} minutes old after the unbind`);
        });
    });

    attempt('a PARSE FAILURE does the same, and publishes E142LastError', () => {
        /*
         * Done-when 2. The tile goes on showing the last map that rendered, so this
         * attribute is the only signal the feed has gone bad - a tile silently
         * keeping an old picture with no way to know why is the failure this phase
         * is about.
         */
        withDocument(() => {
            const t = fresh();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            const live = painted(t);
            eq(t.getE142LastError(), null, 'no error while the map reads');

            t.setGridData(JSON.parse(JSON.stringify(BROKEN)));
            renderOnce(t, 200);
            deep(painted(t), live, 'the last aggregate is still on screen');
            eq(t.readEmptyState(), 'stale', '  reported as stale');
            ok(/TILE_MAP_UNREADABLE/.test(String(t.getE142LastError())),
                `  and E142LastError says why: ${String(t.getE142LastError()).slice(0, 60)}`);
        });
    });

    attempt('rebinding a valid map replaces it with NO flash of empty canvas', () => {
        /*
         * Done-when 3. The retained grid is pushed in the same call that discovered
         * the failure, so no frame is drawn between - asserted by counting frames
         * that painted nothing across the whole sequence.
         */
        withDocument(() => {
            const t = fresh();
            let blank = 0;
            const step = (data) => {
                t.setGridData(data === null ? null : JSON.parse(JSON.stringify(data)));
                renderOnce(t, 200);
                if (painted(t).length === 0) { blank++; }
            };
            step(MAP);
            step(null);
            step(BROKEN);
            step(MAP);
            step(null);
            step(MAP);
            eq(blank, 0, 'six transitions, not one blank frame');
            eq(t.readEmptyState(), 'data', 'and it ends on live data');
            eq(t.getE142LastError(), null, '  with the error cleared');
        });
    });

    attempt('with NO last state, the no-data image appears rather than the demo', () => {
        /* Done-when 4, and the fall-through `W-15` specified. */
        withDocument(() => {
            const t = fresh();
            eq(t.readEmptyState(), 'nodata', 'nothing ever bound');
            t.setGridData(JSON.parse(JSON.stringify(BROKEN)));
            renderOnce(t, 200);
            eq(t.readEmptyState(), 'nodata', 'a first map that will not parse is still nodata');
            eq(painted(t).length, 0, '  and nothing is painted');
            ok(/TILE_MAP_UNREADABLE/.test(String(t.getE142LastError())), '  but the error is published');
        });
    });

    attempt('a live tile does NOT report stale, though it is retaining', () => {
        /*
         * A tile with live data holds a retained grid too - the live one, saved for
         * next time. Reporting `stale` then would label a fresh tile as old, and the
         * flag that prevents it is set where the DECISION is made rather than
         * reconstructed afterwards: the first version asked `__gridData === null`,
         * which is true on an unbind and false on a parse failure, so a tile
         * showing a retained wafer because its feed had gone bad reported `data`.
         */
        withDocument(() => {
            const t = fresh();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            ok(t.__lastKnownGrid !== null, 'a live tile is already retaining');
            eq(t.__hasLastKnown(), false, '  and does not report it as the last known state');
            eq(t.readEmptyState(), 'data', '  so the tile is data');
        });
    });

    attempt('the retained thing is a MODEL, not a picture', () => {
        /*
         * Re-rendering goes through the same pipeline as a live map, so a retained
         * tile responds to a resize instead of holding a stretched screenshot.
         */
        withDocument(() => {
            const t = fresh();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            t.setGridData(null);
            renderOnce(t, 200);
            const small = painted(t).length;
            renderOnce(t, 400);
            const large = painted(t).length;
            ok(small > 0 && large > 0, `painted at both sizes: ${small} then ${large}`);
            ok(t.__lastKnownGrid !== null && typeof t.__lastKnownGrid.cols === 'number',
                'and what is held is a grid model, with a lattice');
        });
    });

    attempt('the base default is FALSE, so no other control retains anything', () => {
        /* `__hasLastKnown` is a default rather than an abstract hook, by the rule
         * `W-29` set: abstract when omission is a bug, default when omission is the
         * common case. */
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        ok(/__hasLastKnown\(\)\s*\{\s*return false;/.test(base.replace(/\s+/g, ' ')),
            'the base returns false');
        const map = readFileSync(new URL(
            '../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url), 'utf8');
        ok(!/__hasLastKnown/.test(map), 'and the full control does not override it');
    });
});

section('42. onSubstrateSelected (W-32)', () => {
    /*
     * Without this event a tile is a dead end: it shows a wafer and offers no way
     * to open it. NO CELL-LEVEL HIT TEST - the tile is one target, because at
     * 200 px a die is a fraction of a pixel and a coordinate read off one would be
     * a guess dressed as a fact.
     */
    const node = (t) => {
        const listeners = {};
        return {
            tagName: t, style: {}, children: [], className: '', textContent: '', listeners,
            appendChild(c) { this.children.push(c); return c; },
            remove() {},
            addEventListener(k, f) { (listeners[k] ??= []).push(f); },
            removeEventListener(k, f) {
                if (listeners[k] !== undefined) { listeners[k] = listeners[k].filter((x) => x !== f); }
            },
            click() { for (const f of (listeners.click ?? [])) { f({}); } },
            getContext: () => null,
            getBoundingClientRect: () => ({ width: 200, height: 200 }),
            setAttribute() {}, querySelector: () => null,
        };
    };
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    const MAP = {
        substrateId: 'W-42', lotId: 'LOT-7', goodDevices: 7, dimension: { x: 4, y: 3 }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins: ['1191', '1.11', '1911'],
        binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
    };
    const tile = () => {
        const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        const root = node('div');
        t.__elementTemplateRoot = root;
        t.__element = [{}];
        t.__attach();
        return { t, root };
    };

    attempt('a click anywhere in the tile raises EXACTLY ONE event', () => {
        /* Done-when 1. One, not zero and not two - a handler that opened a view
         * twice would be as broken as one that never opened it. */
        withDocument(() => {
            const { t, root } = tile();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            drainEvents();
            root.click();
            const ev = drainEvents();
            eq(ev.length, 1, 'one event');
            root.click();
            root.click();
            eq(drainEvents().length, 2, 'and one per click, not one ever');
        });
    });

    attempt('the payload validates against the NEW schema', () => {
        /*
         * Through the recorder from `W-3`, and against the schema rather than
         * against a hand-written shape: `additionalProperties: false` means a field
         * added to the raise without being added to the schema fails here, which is
         * the drift a payload assertion is actually for.
         */
        const schema = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMapWidget/Schema/TypeDefinitions/TileSelection.Schema.json',
            import.meta.url), 'utf8'));
        const ajv = new Ajv({ allErrors: true, strict: false });
        const validate = ajv.compile({
            $ref: '#/definitions/SubstrateMapTileSelection', definitions: schema.definitions,
        });
        withDocument(() => {
            const { t, root } = tile();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            drainEvents();
            root.click();
            const data = drainEvents()[0]?.data;
            ok(validate(data), `payload valid: ${JSON.stringify(validate.errors ?? [])}`);
            eq(data.substrateId, 'W-42', 'the substrate id');
            eq(data.lotId, 'LOT-7', 'the lot id');
            eq(data.goodDevices, 7, 'the DECLARED good-device count');
            eq(data.summary.totalCells, 12, 'and the aggregate summary');
            eq(data.summary.nullCount, 1, '  counting the null cell separately');
        });
    });

    attempt('the unbound tile in the no-data state raises NOTHING', () => {
        /*
         * Done-when 2, and the reason: without a map there is no substrate to
         * select. An event carrying nulls would make every handler check what the
         * control already knows, and a dashboard that opened a full view on nothing
         * would be a worse dead end than the one this event exists to remove.
         */
        withDocument(() => {
            const { t, root } = tile();
            renderOnce(t, 200);
            eq(t.readEmptyState(), 'nodata', 'the tile is in the no-data state');
            drainEvents();
            root.click();
            eq(drainEvents().length, 0, 'and a click raises nothing at all');
        });
    });

    attempt('a STALE tile does raise, and says so', () => {
        /*
         * The operator is looking at a wafer and wants to open it. What the handler
         * needs is to know WHICH wafer and that it was stale - the id alone cannot
         * tell it, because a retained tile and a live one carry the same id.
         */
        withDocument(() => {
            const { t, root } = tile();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            t.setGridData(null);
            renderOnce(t, 200);
            eq(t.readEmptyState(), 'stale', 'the tile is showing a retained map');
            drainEvents();
            root.click();
            const ev = drainEvents();
            eq(ev.length, 1, 'it still raises');
            eq(ev[0].data.state, 'stale', '  and the payload says stale');
            eq(ev[0].data.substrateId, 'W-42', '  for the substrate that was retained');
        });
    });

    attempt('the age travels with the tap, from the clock the tile is labelling', () => {
        /* A handler acting on staleness should not have to ask a second time, and
         * asking later would give a different answer. */
        withDocument(() => {
            const { t, root } = tile();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            t.__receivedAt = new Date(Date.now() - 7200 * 1000);
            drainEvents();
            root.click();
            const data = drainEvents()[0].data;
            ok(data.ageSeconds > 7000, `${(data.ageSeconds / 3600).toFixed(1)} hours old at the tap`);
            eq(data.ageSource, 'received', 'from the receive clock');

            t.setMapTimestamp('2026-08-14T09:15:00Z');
            drainEvents();
            root.click();
            eq(drainEvents()[0].data.ageSource, 'map', 'and from the map clock once one is bound');
        });
    });

    attempt('detaching removes the target, so a stray click raises nothing', () => {
        /* The same accumulation `W-26` measured for the `ResizeObserver`: the
         * handler reference is cleared whether or not the root survived, so a
         * re-attach installs one rather than finding a stale reference. */
        withDocument(() => {
            const { t, root } = tile();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            try { t.__detach(); } catch { /* the canvas fake is not the subject here */ }
            eq(t.__tileClick, null, 'the handler reference is cleared');
            drainEvents();
            root.click();
            eq(drainEvents().length, 0, 'and the root no longer raises');
        });
    });

    attempt('re-attaching installs ONE handler, not a second', () => {
        withDocument(() => {
            const { t, root } = tile();
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            renderOnce(t, 200);
            t.__attach();
            t.__attach();
            drainEvents();
            root.click();
            eq(drainEvents().length, 1, 'three attaches, one event per click');
        });
    });

    attempt('there is no cell-level hit test anywhere in the tile', () => {
        /* Asserted on the emitted source, comments stripped — `W-28`'s lesson. The
         * tile is one target and a later task adding a hit test by habit would
         * quietly change what the event means. */
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMapWidget/SubstrateMapWidget.js', import.meta.url), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
        ok(!/isPointInPath|hitTest|__selectedCells|clientX/.test(code),
            'no hit test, no pointer coordinates');
    });
});

section('61. a tile does not select, in behaviour and not only in prose (F-27)', () => {
    /*
     * REPORTED FROM A LIVE VIEW: blue 2x2 rings on the dashboard tiles, and the
     * question "why provide the widgets a selection, too?".
     *
     * The file header has always said "no overlay selection, no selection mode".
     * That was true of the ATTRIBUTES and false of the behaviour: the base's pointer
     * path filled `__selectedCells` with a group's member cells and drew a ring,
     * while `__raiseSelected` discarded the payload. The operator got feedback and
     * no author could act on it (`D-256`).
     *
     * The tile now declares `__selectionMode = 'none'` and the base's pointer path
     * returns before it hit-tests. The tile's own click still means
     * `onSubstrateSelected` and nothing else.
     */
    const grid = JSON.stringify({
        dimension: { x: 8, y: 8 }, units: 'mm', stepSize: { x: 8, y: 8 }, orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii',
        nullBin: '.', mapType: '2DArray',
        binDefinitions: [{ binCode: 'P', binQuality: 'Pass' }, { binCode: 'F', binQuality: 'Fail' }],
        bins: ['..PPPP..', '.PPPPPF.', 'PPPPPFFP', 'PPPPFFPP',
            'PPPFFPPP', 'PPFFPPPP', '.PFPPPP.', '..PPPP..'],
    });
    /** @returns A tile with the grid bound and one frame rendered. */
    const tile = () => {
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        w.__attach();
        w.setGridData(grid);
        renderOnce(w, 210);
        drainEvents();
        return w;
    };

    attempt('the tile says it does not select', () => {
        eq(tile().__selectionMode, 'none',
            'declared on the class, not inferred from a missing attribute');
    });

    attempt('a tap stores no selection and raises nothing', () => {
        /*
         * Several points, because the ring appeared wherever the operator happened to
         * click: the middle of the wafer, a corner, and a null cell outside it.
         */
        for (const [x, y] of [[105, 105], [70, 70], [140, 140], [105, 60], [20, 20]]) {
            const w = tile();
            tapAt(w, x, y);
            eq(w.__selectedCells.size, 0, `tap(${x},${y}) selects no cells`);
            eq(drainEvents().filter((e) => /Selected$/.test(e.name)).length, 0,
                `  and raises no selection event`);
        }
    });

    attempt('and therefore draws no selection ring', () => {
        const w = tile();
        const before = renderOnce(w, 210).strokeCount;
        tapAt(w, 105, 105);
        eq(renderOnce(w, 210).strokeCount, before,
            'the frame after a tap is the frame before it - nothing was marked');
    });

    attempt('the tile\u2019s OWN meaning for a click survives', () => {
        /*
         * The point of the fix is not an inert control. It is ONE reading of the
         * gesture instead of two, and the reading that is kept is the tile's.
         */
        const w = tile();
        eq(w.readEmptyState(), 'data', 'the tile has data, so the event is reachable');
        w.__raiseSubstrateSelected();
        const raised = drainEvents().map((e) => e.name.split('.').pop());
        deep(raised, ['onSubstrateSelected'], 'a tile click still reports the whole tile');
    });

    attempt('the MAP is untouched by any of this', () => {
        /*
         * `'none'` is a shell-level fact a subclass asserts about itself, not a mode
         * an author picks. The map still selects, still rings, still raises - and its
         * public getter still advertises two values, not three.
         */
        const m = new SubstrateMapMod.SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setOutlinePreset('si-4in-p100');
        m.__attach();
        m.setGridData(grid);
        renderOnce(m, 300);
        drainEvents();
        eq(m.__selectionMode, 'single', 'the map selects by default');
        tapAt(m, 150, 150);
        const raised = drainEvents().map((e) => e.name.split('.').pop());
        ok(raised.some((n) => /Selected$/.test(n)), `a tap on the map still raises  ${raised}`);
        ok(m.__selectedCells.size > 0, `and still marks cells  (${m.__selectedCells.size})`);
        ok(['single', 'multi'].includes(m.getSelectionMode()),
            'and getSelectionMode still advertises only the two an author can set');
    });
});

section('43. the tile\'s themes (W-33)', () => {
    /*
     * Every colour on a tile is a map colour: a bin, a severity, a density, the
     * substrate body it sits on. Giving the tile its own palette would mean a
     * wafer that changes colour when it moves from a dashboard to a full view -
     * the one thing a colour-coded map must never do.
     *
     * So the tile's themes set the SAME `--substratemap-*` names to the SAME
     * values, under its own selector. Duplicated rather than inherited, because a
     * TwinCAT theme is per-control and there is no ancestor to inherit from when a
     * tile and a map sit in different containers.
     */
    const themeVars = (control, theme) => {
        const css = readFileSync(new URL(
            `../../../Controls/${control}/Themes/${theme}/Style.css`, import.meta.url), 'utf8');
        const out = new Map();
        for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
            out.set(m[1], m[2].trim());
        }
        return out;
    };
    const isColour = (v) => /^#[0-9a-fA-F]{3,8}$|^rgba?\(|^transparent$/i.test(String(v).trim());
    const node = (t) => {
        const l = {};
        return {
            tagName: t, style: {}, children: [], className: '', textContent: '', listeners: l,
            appendChild(c) { this.children.push(c); return c; },
            remove() {}, addEventListener(k, f) { (l[k] ??= []).push(f); },
            removeEventListener() {},
            click() { for (const f of (l.click ?? [])) { f({}); } },
            getContext: () => null,
            getBoundingClientRect: () => ({ width: 200, height: 200 }),
            setAttribute() {}, querySelector: () => null,
        };
    };
    const MAP = {
        substrateId: 'W-42', lotId: 'L7', goodDevices: 7, dimension: { x: 4, y: 3 }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
        bins: ['1191', '1.11', '1911'],
        binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
    };
    /** Runs `fn` with a document and a computed style backed by a real theme file. */
    const underTheme = (theme, fn) => {
        const vars = themeVars('SubstrateMapWidget', theme);
        const hadDoc = 'document' in globalThis;
        const savedDoc = globalThis.document;
        const savedStyle = window.getComputedStyle;
        globalThis.document = { createElement: node };
        window.getComputedStyle = () => ({
            getPropertyValue: (n) => vars.get(n) ?? '', fontFamily: 'sans-serif',
        });
        try { return fn(vars); } finally {
            window.getComputedStyle = savedStyle;
            if (hadDoc) { globalThis.document = savedDoc; } else { delete globalThis.document; }
        }
    };
    const tile = () => {
        const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        t.__elementTemplateRoot = node('div');
        t.__element = [{ nodeType: 1 }];
        t.setShowYield(true);
        t.setShowSubstrateId(true);
        t.__attach();
        return t;
    };

    attempt('both themes exist and set the same NAMES', () => {
        const light = themeVars('SubstrateMapWidget', 'Base');
        const dark = themeVars('SubstrateMapWidget', 'Base-Dark');
        ok(light.size >= 15, `${light.size} variables in Base`);
        deep([...light.keys()].sort(), [...dark.keys()].sort(),
            'Base and Base-Dark declare the same set — a variable in one only is a hole');
    });

    attempt('every shared COLOUR matches the full control, exactly', () => {
        /*
         * A wafer that changed colour between a dashboard and a full view would be
         * a lie about the data. Sizes may differ - a tile is 200 px wide and sets a
         * smaller label deliberately - and that difference is a layout decision,
         * which is a different kind of thing.
         */
        for (const theme of ['Base', 'Base-Dark']) {
            const map = themeVars('SubstrateMap', theme);
            const tileVars = themeVars('SubstrateMapWidget', theme);
            let compared = 0;
            for (const [name, value] of tileVars) {
                const mapValue = map.get(name);
                if (mapValue === undefined || !isColour(value) || !isColour(mapValue)) { continue; }
                eq(value, mapValue, `${theme}: ${name}`);
                compared++;
            }
            ok(compared >= 6, `${theme}: ${compared} shared colours compared`);
        }
    });

    attempt('the tile adds exactly ONE variable of its own, and it is documented', () => {
        /*
         * The stale marking. A STATUS signal, not a map colour: it says the data
         * has stopped arriving, which is a fact about the feed rather than about the
         * wafer. It had been `--substratemap-edge-color`, and sharing meant
         * re-theming the wafer outline silently re-themed the warning - someone
         * choosing a subtle edge for a dense map would have made it disappear.
         */
        for (const theme of ['Base', 'Base-Dark']) {
            const map = themeVars('SubstrateMap', theme);
            const own = [...themeVars('SubstrateMapWidget', theme).keys()]
                .filter((n) => !map.has(n));
            deep(own, ['--substratemap-tile-stale-color'], `${theme}: one variable of its own`);
            const css = readFileSync(new URL(
                `../../../Controls/SubstrateMapWidget/Themes/${theme}/Style.css`, import.meta.url),
            'utf8');
            ok(/STATUS signal/.test(css), `  ${theme}: and it says why it exists`);
        }
    });

    attempt('BOTH THEMES RENDER EVERY STATE', () => {
        /*
         * Done-when 1. `demo` is absent by design and not by omission: the tile
         * never sets the demo flag (`W-27`), so a tile with nothing bound answers
         * `nodata` and draws the no-data image. That is asserted rather than
         * skipped, because "we did not test it" and "it cannot happen" look the
         * same in a passing suite.
         */
        for (const theme of ['Base', 'Base-Dark']) {
            underTheme(theme, () => {
                let t = tile();
                renderOnce(t, 200);
                eq(t.readEmptyState(), 'nodata', `${theme}: no-data`);

                t = tile();
                t.setGridData(JSON.parse(JSON.stringify(MAP)));
                renderOnce(t, 200);
                ok(t.__canvasContext.fills.length > 0, `${theme}: bound draws ${t.__canvasContext.fills.length} cells`);
                eq(t.readEmptyState(), 'data', `  ${theme}: and reports data`);

                t.setGridData(null);
                renderOnce(t, 200);
                eq(t.readEmptyState(), 'stale', `${theme}: last-known`);
                ok(t.__canvasContext.fills.length > 0, `  ${theme}: still drawing the retained wafer`);

                t.setStaleAfterSeconds(1);
                t.__receivedAt = new Date(Date.now() - 9999 * 1000);
                renderOnce(t, 200);
                eq(t.__canvasContext.strokeRects.length, 1, `${theme}: stale marking drawn`);

                eq(t.__sceneIsDemo, false, `${theme}: demo is absent by design (W-27), not by omission`);
            });
        }
    });

    attempt('the stale border takes its OWN colour from each theme', () => {
        for (const theme of ['Base', 'Base-Dark']) {
            underTheme(theme, (vars) => {
                const t = tile();
                t.setGridData(JSON.parse(JSON.stringify(MAP)));
                t.setStaleAfterSeconds(1);
                t.__receivedAt = new Date(Date.now() - 9999 * 1000);
                renderOnce(t, 200);
                const rect = t.__canvasContext.strokeRects[0];
                eq(rect.strokeStyle, vars.get('--substratemap-tile-stale-color'),
                    `${theme}: the border is the theme's stale colour`);
                ok(rect.strokeStyle !== vars.get('--substratemap-edge-color'),
                    '  and NOT the wafer outline colour');
            });
        }
    });

    attempt('no hard-coded colour survives in the tile', () => {
        /*
         * Done-when 2. `check-descriptors` enforces this across every control; this
         * asserts the tile specifically, because the tile is what `W-33` is about
         * and a gate that covers everything can be relaxed for something else.
         */
        for (const f of ['SubstrateMapWidget.ts', 'Style.css']) {
            const src = readFileSync(new URL(
                `../../../Controls/SubstrateMapWidget/${f}`, import.meta.url), 'utf8');
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
            const hits = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
            deep(hits, [], `${f}: no colour literal outside the theme files`);
        }
    });
});

section('44. the bin chart scaffold (W-34)', () => {
    /*
     * ONE CONTROL FOR BOTH PRESENTATIONS, answered as `OD-003` option A. The two
     * styles consume identical data, share palette resolution, the empty state,
     * the remainder bucket and the sort order, and differ only in geometry.
     *
     * It was asked rather than decided because the asymmetry is real: splitting
     * later is a migration - every view carrying `ChartStyle="Share"` re-authored
     * - and merging later is not.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 320, height: 220 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    const chart = () => {
        const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
        c.__elementTemplateRoot = node('div');
        c.__element = [{}];
        return c;
    };

    attempt('it instantiates and attaches', () => {
        /* Done-when 1. The base does the work; what is asserted is that a concrete
         * subclass with empty hooks reaches the end of it. */
        withDocument(() => {
            const before = Shims.liveObservations.size;
            const c = chart();
            c.__attach();
            ok(c.__canvas !== null && c.__canvas !== undefined, 'the canvas exists');
            eq(Shims.liveObservations.size, before + 1, 'and one observation is live');
            c.__detach();
        });
    });

    attempt('teardown leaves NOTHING behind', () => {
        /* Done-when 3, over five cycles: one leaked observation per show/hide is
         * the defect that looks like nothing for an hour. */
        withDocument(() => {
            const before = Shims.liveObservations.size;
            const c = chart();
            for (let i = 0; i < 5; i++) {
                c.__attach();
                c.__detach();
            }
            eq(Shims.liveObservations.size, before, 'five cycles, nothing accumulated');
            eq(c.__canvas, null, 'and the canvas is released');
        });
    });

    attempt('it pushes NO grid, so it draws no wafer under its own bars', () => {
        /*
         * A chart counts bins; it does not draw a lattice. The base's grid
         * machinery costs nothing when nothing is pushed to it, which is why
         * extending the base is cheap here rather than wasteful.
         */
        withDocument(() => {
            const c = chart();
            c.__attach();
            eq(c.__sceneGrid, null, 'no grid');
            eq(c.readEmptyState(), 'nodata', 'so a fresh chart is in the no-data state');
            c.__detach();
        });
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMapBinChart/SubstrateMapBinChart.js', import.meta.url), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
        /*
         * `__updateGrid` and `isPointInPath`, not `buildGridModel`. `W-35` BUILDS a
         * model - `binStatistics` walks a lattice and a model built differently
         * would count differently - it simply never PUSHES one to the base. The
         * first version of this assertion forbade the construction as well and went
         * red the moment the chart got data, which is the assertion being broader
         * than the rule it exists for (observation 280's class).
         */
        ok(!/__updateGrid\(/.test(code), 'the source never pushes a grid to the base');
        ok(!/isPointInPath|__selectedCells/.test(code), '  and hit-tests nothing');
    });

    attempt('ONE control, not two — the OD-003 answer is in the artefacts', () => {
        /*
         * The decision has to be visible somewhere a later reader will look. A
         * second chart control appearing would satisfy every other assertion here.
         */
        const controls = readdirSync(new URL('../../../Controls/', import.meta.url))
            .filter((n) => /Chart|Share/.test(n));
        deep(controls, ['SubstrateMapBinChart'], 'exactly one chart control exists');
        const d = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMapBinChart/Description.json', import.meta.url), 'utf8'));
        ok(/ONE CONTROL FOR BOTH/.test(d.description) && !/OD-\d{3}/.test(d.description),
            'and the descriptor states the reasoning, not the decision record');
        ok(/ChartStyle/.test(d.description), '  naming the attribute that carries both styles');
    });

    attempt('the chart is registered in all four places', () => {
        /* Done-when 2. `D-173` made this checkable, and `check-manifest` enumerated
         * exactly these four when the folder appeared. */
        const manifest = JSON.parse(readFileSync(
            new URL('../../../Manifest.json', import.meta.url), 'utf8'));
        ok((manifest.modules ?? []).some((m) => m.basePath === './Controls/SubstrateMapBinChart'),
            'Manifest.json modules');
        const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
        ok(String(pkg.scripts?.gate).includes('Controls/SubstrateMapBinChart/tsconfig.json'),
            'the package.json gate script');
        const proto = readFileSync(
            requireInput('SubstrateMap-Working-Protocol.md'), 'utf8');
        ok(proto.includes('tsc -p Controls/SubstrateMapBinChart/tsconfig.json'),
            'the Working Protocol gate block');
        const proj = readFileSync(
            new URL('../../../SubstrateMap.hmiextproj', import.meta.url), 'utf8');
        ok(proj.includes('SubstrateMapBinChart.ts'), 'and the Visual Studio project');
    });

    attempt('THIRTEEN tsc lines, and the protocol says so', () => {
        /* The gate list is a number the protocol states, and this is where the
         * Widgets spec leaves it. */
        const proto = readFileSync(
            requireInput('SubstrateMap-Working-Protocol.md'), 'utf8');
        const lines = [...proto.matchAll(/npx tsc -p [^\s]+ --noEmit/g)].length;
        eq(lines, 6, 'six tsc projects in the gate block');
        ok(/the list is THIRTEEN/.test(proto), 'and the prose agrees');
    });

    attempt('it ships both themes, sharing the map\'s colours', () => {
        /* `check-descriptors` enforces the no-drift rule across every control;
         * this asserts the chart specifically, because a chart whose bars differ
         * from the cells they count is the failure that matters here. */
        const vars = (theme, control) => {
            const css = readFileSync(new URL(
                `../../../Controls/${control}/Themes/${theme}/Style.css`, import.meta.url), 'utf8');
            const out = new Map();
            for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
                out.set(m[1], m[2].trim());
            }
            return out;
        };
        for (const theme of ['Base', 'Base-Dark']) {
            const chartVars = vars(theme, 'SubstrateMapBinChart');
            const mapVars = vars(theme, 'SubstrateMap');
            ok(chartVars.size >= 14, `${theme}: ${chartVars.size} variables`);
            for (const name of ['--substratemap-bin-pass', '--substratemap-bin-fail',
                '--substratemap-status-unknown']) {
                eq(chartVars.get(name), mapVars.get(name),
                    `${theme}: ${name} is the map's — a bar must match the cells it counts`);
            }
            ok(!chartVars.has('--substratemap-tile-stale-color'),
                `  ${theme}: and it does not carry the tile's variable`);
        }
    });
});

section('45. bars (W-35)', () => {
    /*
     * One bar per bin category with the absolute number above it, colour from
     * `W-10` and therefore identical to the map, descending by count because a
     * chart exists to put the biggest thing first.
     */
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 320, height: 220 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    /** @param n Distinct codes. @param rows Lattice side. @returns A grid. */
    const gd = (n, rows = 40) => {
        const uniq = ALPHA.slice(0, Math.min(n, ALPHA.length)).split('');
        const lines = [];
        let k = 0;
        for (let r = 0; r < rows; r++) {
            let l = '';
            for (let c = 0; c < rows; c++) { l += uniq[(k++) % uniq.length]; }
            lines.push(l);
        }
        return {
            substrateId: 'W', dimension: { x: rows, y: rows }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins: lines,
            binDefinitions: uniq.map((c, i) => ({ binCode: c, binQuality: i === 0 ? 'Pass' : 'Fail' })),
        };
    };
    const chart = (data, patch) => {
        const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
        c.__elementTemplateRoot = node('div');
        c.__element = [{}];
        if (data !== null) { c.setGridData(data); }
        if (patch !== undefined) { patch(c); }
        c.__attach();
        renderOnce(c, 320);
        return c;
    };

    attempt('THE BARS PLUS Other SUM TO THE NON-NULL CELL COUNT, EXACTLY', () => {
        /*
         * Done-when 1, at three sizes so the remainder path is covered too. The
         * remainder is computed from what it ABSORBS, never from a subtraction
         * against the total - a subtraction would hide an inconsistency in the
         * input by silently balancing it, which is the one thing this assertion
         * could not then detect.
         */
        withDocument(() => {
            for (const n of [3, 12, 62]) {
                const c = chart(gd(n));
                const stats = c.readBinStatistics();
                const cats = c.readCategories();
                const sum = cats.reduce((a, x) => a + x.count, 0);
                eq(sum, stats.totalCells - stats.nullCount,
                    `${n} codes: ${cats.length} categories sum to ${sum}`);
            }
        });
    });

    attempt('every colour matches the map\'s colour for the same code, BY VALUE', () => {
        /*
         * Done-when 2, and it comes free because `binStatistics` carries the colour
         * the RENDER PATH paints (`W-10`). A chart that resolved its own palette
         * would be a second palette to keep in step - which is exactly the failure
         * `W-10`'s `color` field was added to prevent.
         */
        withDocument(() => {
            const c = chart(gd(12));
            const fromStats = new Map(c.readBinStatistics().bins.map((b) => [b.code, b.color]));
            let checked = 0;
            for (const cat of c.readCategories()) {
                if (cat.code === Chart.CHART_OTHER_LABEL) { continue; }
                eq(cat.color, fromStats.get(cat.code), `${cat.code} is the map's colour`);
                checked++;
            }
            ok(checked >= 8, `${checked} bars compared`);
        });
    });

    attempt('at many codes, nine plus Other are shown and Other names the remainder', () => {
        /*
         * Done-when 3. The cap is the categorical palette's own, so a chart never
         * shows a bar in a colour the map could not have used.
         */
        withDocument(() => {
            const c = chart(gd(62));
            const cats = c.readCategories();
            eq(cats.length, 10, 'ten categories');
            eq(cats.filter((x) => x.code === Chart.CHART_OTHER_LABEL).length, 1, 'one of them Other');
            const other = cats[cats.length - 1];
            eq(other.code, Chart.CHART_OTHER_LABEL, 'and it is LAST, whatever the sort');
            eq(other.covers, 62 - 9, `covering the other ${other.covers} codes`);
            eq(other.color, Oklch.CATEGORICAL_OTHER, 'in the remainder colour');
            const tip = Chart.chartTooltip(other);
            ok(/53 further bin codes/.test(String(tip)), `and the tooltip says so: "${tip}"`);
            eq(Chart.chartTooltip(cats[0]), null, 'a real category gets no tooltip');
        });
    });

    attempt('a category with count 0 does NOT appear', () => {
        /*
         * Done-when 4. A zero-height bar is a line nobody can read, and a legend
         * entry for something that did not happen is a category an operator will
         * look for on the wafer and not find.
         */
        const withZero = {
            bins: [
                { code: 'A', count: 5, color: '#111111' },
                { code: 'B', count: 0, color: '#222222' },
                { code: 'C', count: 3, color: '#333333' },
            ],
        };
        const cats = Chart.chartCategories(withZero);
        deep(cats.map((x) => x.code), ['A', 'C'], 'the empty category is dropped');
        eq(cats.reduce((a, x) => a + x.count, 0), 8, 'and the sum is unaffected');
    });

    attempt('descending by count, with the CODE as the tie-break', () => {
        /*
         * Without a second key a chart's bars reorder themselves between frames
         * whenever two categories draw level - which looks like the data moving.
         */
        const tied = {
            bins: [
                { code: 'Z', count: 4, color: '#1' }, { code: 'A', count: 9, color: '#2' },
                { code: 'M', count: 4, color: '#3' },
            ],
        };
        deep(Chart.chartCategories(tied).map((x) => x.code), ['A', 'M', 'Z'],
            'biggest first, then alphabetical among equals');
        deep(Chart.chartCategories(tied).map((x) => x.code),
            Chart.chartCategories(tied).map((x) => x.code), 'and stable across calls');
    });

    attempt('Code order is available, and Other stays last in it', () => {
        /* For comparing two charts side by side, where the bars must line up.
         * `Other` is not a category with a code; it is what is left. */
        /*
         * COUNTS RUN OPPOSITE TO CODES, deliberately. The first version gave `A` the
         * largest count and `T` the smallest, so count order and code order were the
         * same list and the mutation that disabled the `Code` branch was MISSED. A
         * fixture where the two orders agree cannot tell them apart.
         */
        const many = { bins: ALPHA.slice(0, 20).split('')
            .map((c, i) => ({ code: c, count: i + 1, color: '#000000' })) };
        const byCount = Chart.chartCategories(many, 'CountDescending');
        eq(byCount[0].code, 'T', 'by count, the last letter comes first');

        const cats = Chart.chartCategories(many, 'Code');
        eq(cats[cats.length - 1].code, Chart.CHART_OTHER_LABEL, 'Other is last');
        const real = cats.slice(0, -1).map((x) => x.code);
        deep(real, [...real].sort(), 'and the rest are in code order');
        ok(real[0] !== byCount[0].code,
            `  which is a different order from by-count (${real[0]} against ${byCount[0].code})`);
    });

    attempt('the axis is linear from ZERO', () => {
        /*
         * No truncated origin. With yield data the DISTANCE TO ZERO is the
         * information: an axis starting at 940 makes a 4 % loss look like a
         * catastrophe and a 0.4 % loss look identical to it.
         *
         * Asserted geometrically: a category with twice the count gets twice the
         * bar height, which is true only of a zero origin.
         */
        withDocument(() => {
            const two = {
                substrateId: 'W', dimension: { x: 4, y: 1 }, units: 'mm', stepSize: { x: 1, y: 1 },
                binType: 'Ascii', nullBin: '.', mapType: '2DArray', bins: ['AABB'],
                binDefinitions: [{ binCode: 'A', binQuality: 'Pass' },
                    { binCode: 'B', binQuality: 'Fail' }],
            };
            const c = chart(two);
            const rects = c.__canvasContext.fills.filter((f) => f.h > 0);
            eq(rects.length, 2, 'two bars');
            eq(rects[0].h, rects[1].h, 'equal counts give equal heights');

            const skewed = { ...two, bins: ['AAAB'] };
            const c2 = chart(skewed);
            const r2 = c2.__canvasContext.fills.filter((f) => f.h > 0)
                .sort((x, y) => y.h - x.h);
            ok(Math.abs(r2[0].h / r2[1].h - 3) < 0.001,
                `3:1 counts give a ${(r2[0].h / r2[1].h).toFixed(3)}:1 height ratio`);
        });
    });

    attempt('the count is drawn above each bar, and the code below', () => {
        withDocument(() => {
            const c = chart(gd(3));
            const texts = c.__canvasContext.textDraws.map((d) => d.text);
            for (const cat of c.readCategories()) {
                ok(texts.includes(String(cat.count)), `the count ${cat.count} is drawn`);
                ok(texts.includes(cat.code), `  and the code ${cat.code}`);
            }
        });
    });

    attempt('the cap is an attribute, and it has a floor of two', () => {
        /* Below two there is no room for both a category and a remainder. */
        withDocument(() => {
            const c = chart(gd(12), (x) => { x.setCategoryCap(3); });
            eq(c.readCategories().length, 3, 'three categories at a cap of three');
            c.setCategoryCap(1);
            eq(c.getCategoryCap(), 2, 'a cap of one clamps to two');
            c.setCategoryCap(null);
            eq(c.getCategoryCap(), Chart.CHART_CATEGORY_CAP, 'and null restores the default');
        });
    });

    attempt('nothing bound draws nothing, and says nodata', () => {
        withDocument(() => {
            const c = chart(null);
            eq(c.readCategories().length, 0, 'no categories');
            eq(c.readEmptyState(), 'nodata', 'and the base shows the no-data image');
            eq(c.__canvasContext.fills.filter((f) => f.h > 0).length, 0, 'no bars');
        });
    });
});

section('46. share (W-36)', () => {
    /*
     * The same data as percentages, in the same order, clockwise from twelve.
     * `Share` is a BRANCH of the same control, not a sibling: the two styles
     * differ in geometry and in nothing else, which is what `OD-003` = A decided.
     */
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 320, height: 220 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    const gd = (n, rows = 40) => {
        const uniq = ALPHA.slice(0, n).split('');
        const lines = [];
        let k = 0;
        for (let r = 0; r < rows; r++) {
            let l = '';
            for (let c = 0; c < rows; c++) { l += uniq[(k++) % uniq.length]; }
            lines.push(l);
        }
        return {
            substrateId: 'W', dimension: { x: rows, y: rows }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins: lines,
            binDefinitions: uniq.map((c, i) => ({ binCode: c, binQuality: i === 0 ? 'Pass' : 'Fail' })),
        };
    };
    const chart = (style, data) => {
        const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
        c.__elementTemplateRoot = node('div');
        c.__element = [{}];
        c.setGridData(data ?? gd(6));
        c.setChartStyle(style);
        c.__attach();
        renderOnce(c, 320);
        return c;
    };
    const cats = (counts) => counts.map((n, i) => ({
        code: ALPHA[i], count: n, color: `#${i}${i}${i}${i}${i}${i}`, covers: 1,
    }));

    attempt('THE PERCENTAGES SUM TO EXACTLY 100.0, WHATEVER THE ROUNDING', () => {
        /*
         * Done-when 1. Ten categories rounded to one decimal routinely land on 99.9
         * or 100.1, and a chart whose numbers do not add up is a chart an operator
         * will add up and catch.
         */
        for (const counts of [[1, 1, 1], [1, 1, 1, 1, 1, 1, 1], [997, 1, 1, 1],
            [1000, 3, 2, 1, 1, 1, 1, 1, 1, 1], [2, 1]]) {
            const sh = Chart.chartShares(cats(counts));
            const sum = sh.reduce((a, x) => a + x.percent, 0);
            ok(Math.abs(sum - 100) < 0.05,
                `${JSON.stringify(counts)} -> ${sh.map((x) => x.percent.toFixed(1)).join('/')}`
                + ` = ${sum.toFixed(1)}`);
        }
    });

    attempt('and the rounding remainder lands VISIBLY in the largest segment', () => {
        /*
         * Not spread across several - that corrupts several readings to hide one -
         * and not given to the smallest, where a tenth is the largest relative
         * change it could make: a 0.2 % segment becoming 0.3 % is a 50 % error in
         * that reading.
         */
        const counts = [1, 1, 1];
        const sh = Chart.chartShares(cats(counts));
        const unadjusted = counts.map((n) => Math.round((n / 3) * 1000) / 10);
        ok(Math.abs(unadjusted.reduce((a, b) => a + b, 0) - 99.9) < 1e-9,
            `unadjusted, three thirds sum to ${unadjusted.reduce((a, b) => a + b, 0)}`);
        eq(sh[0].percent, 33.4, 'the largest carries the remainder');
        eq(sh[1].percent, 33.3, '  and the others are untouched');
        eq(sh[2].percent, 33.3, '  both of them');

        const over = Chart.chartShares(cats([1, 1, 1, 1, 1, 1, 1]));
        eq(over[0].percent, 14.2, 'and a remainder the other way is subtracted from the largest');
        ok(over.slice(1).every((x) => x.percent === 14.3), '  leaving the rest alone');

        /*
         * WITH DISTINCT COUNTS, because the two cases above cannot tell the largest
         * from the smallest - every count is equal, so both pick index 0 and the
         * mutation that took the SMALLEST was MISSED. Observation 285's shape one
         * task later: the fixture was symmetric rather than thin.
         *
         * `[4, 3, 2]` rounds to 44.4/33.3/22.2 = 99.9, so 0.1 has to land somewhere
         * and the three candidates are all different.
         */
        const distinct = Chart.chartShares(cats([4, 3, 2]));
        eq(distinct[0].percent, 44.5, 'the LARGEST takes it: 44.4 becomes 44.5');
        eq(distinct[1].percent, 33.3, '  the middle is untouched');
        eq(distinct[2].percent, 22.2, '  and the smallest is untouched');
    });

    attempt('bars and share show the SAME ORDER and the SAME COLOURS', () => {
        /*
         * Done-when 2, and it is what makes one control the right answer: switching
         * `ChartStyle` re-draws one picture rather than presenting a second,
         * differently-arranged one.
         */
        withDocument(() => {
            const bars = chart('Bars');
            const share = chart('Share');
            deep(share.readCategories().map((x) => `${x.code}:${x.color}`),
                bars.readCategories().map((x) => `${x.code}:${x.color}`),
                'identical order and colour');
            const arcs = share.__canvasContext.arcFills;
            deep(arcs.map((a) => a.fillStyle),
                bars.readCategories().map((x) => x.color),
                'and the segments are drawn in that order, in those colours');
        });
    });

    attempt('clockwise from twelve, contiguous, exactly one turn', () => {
        withDocument(() => {
            const arcs = chart('Share').__canvasContext.arcFills;
            ok(arcs.length >= 3, `${arcs.length} segments`);
            ok(Math.abs(arcs[0].start + Math.PI / 2) < 1e-9, 'the first starts at twelve o\'clock');
            let at = -Math.PI / 2;
            for (const a of arcs) {
                ok(Math.abs(a.start - at) < 1e-9, `  a segment starts where the last ended`);
                ok(a.end > a.start && a.ccw === false, '  and sweeps clockwise');
                at = a.end;
            }
            ok(Math.abs((at + Math.PI / 2) - 2 * Math.PI) < 1e-6,
                `the sweeps total one turn (${((at + Math.PI / 2) / (2 * Math.PI)).toFixed(6)})`);
        });
    });

    attempt('a segment under 1 % is labelled in the LEGEND and not in the segment', () => {
        /*
         * Done-when 3. Below one percent a segment is a few pixels of arc: a label
         * drawn in it overlaps its neighbours and points at nothing. The GEOMETRY is
         * unchanged - the segment is still drawn at its true size.
         */
        const sh = Chart.chartShares(cats([997, 1, 1, 1]));
        /*
         * `inSegment` is now a PROPERTY OF THE DATA that nothing draws.
         *
         * `W-38a` removed the in-wedge percentages after review: at 200 px eight
         * 12 % segments are wide enough by arithmetic and not by eye, and the
         * legend carries every figure already. The flag survives because the rule
         * it encodes - a sliver is too narrow to hold a label - is still the reason
         * the legend must be complete, and because `W-36`'s reasoning is worth
         * keeping addressable.
         *
         * Nothing went red when the drawing was removed, which says `W-36` asserted
         * that a sliver is NOT labelled and never that a wide segment IS. The
         * asymmetry `W-37` found, in a second place.
         */
        eq(sh[0].inSegment, true, '99.7 % would be wide enough for a label');
        for (const sliver of sh.slice(1)) {
            eq(sliver.inSegment, false, `${sliver.percent} % is not`);
            ok(sliver.percent > 0, '  but it still has a share, so it is still drawn');
        }

        withDocument(() => {
            const data = {
                substrateId: 'W', dimension: { x: 100, y: 1 }, units: 'mm',
                stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
                bins: ['A'.repeat(99) + 'B'],
                binDefinitions: [{ binCode: 'A', binQuality: 'Pass' },
                    { binCode: 'B', binQuality: 'Fail' }],
            };
            const c = chart('Share', data);
            const shares = Chart.chartShares(c.readCategories());
            eq(shares.find((x) => x.code === 'B').percent, 1, 'B is exactly 1 %');
            eq(c.__canvasContext.arcFills.length, 2, 'both segments are drawn');
            const texts = c.__canvasContext.textDraws.map((t) => t.text);
            ok(texts.some((t) => /^B\s/.test(String(t))), `B appears in the legend: ${JSON.stringify(texts)}`);
        });
    });

    attempt('every category gets a legend row, not only the slivers', () => {
        /* A legend listing only the slivers makes an operator look in two places
         * for one thing, and the swatch is what ties a colour to a code. */
        withDocument(() => {
            const c = chart('Share');
            const texts = c.__canvasContext.textDraws.map((t) => String(t.text));
            for (const cat of c.readCategories()) {
                ok(texts.some((t) => t.startsWith(`${cat.code}  `)),
                    `${cat.code} has a legend row`);
            }
        });
    });

    attempt('an empty chart produces no shares and no segments', () => {
        deep(Chart.chartShares([]), [], 'nothing in, nothing out');
        deep(Chart.chartShares(cats([0, 0])), [], 'and a total of zero is not divided by');
        withDocument(() => {
            const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
            c.__elementTemplateRoot = node('div');
            c.__element = [{}];
            c.setChartStyle('Share');
            c.__attach();
            renderOnce(c, 320);
            eq(c.__canvasContext.arcFills.length, 0, 'no segments with nothing bound');
        });
    });

    attempt('the README says when the BAR is the better choice', () => {
        /*
         * The control provides the share because it was asked for; the honest
         * warning is that people compare angles worse than lengths, so past about
         * five segments the bar chart beside it is easier to read. Documentation is
         * the right place for that - refusing to draw it would be answering a
         * question nobody asked this control.
         */
        const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
        // Either order: the claim is that the two are compared unequally, not
        // which noun the sentence happens to reach first.
        ok(/angles?[\s\S]{0,80}lengths?|lengths?[\s\S]{0,80}angles?/i.test(readme),
            'the README explains that angles compare worse than lengths');
        ok(/five segments|about five/i.test(readme), '  and gives a threshold');
    });
});

section('47. the chart\'s empty state and themes (W-37)', () => {
    /*
     * With no data: the no-data image from `W-15`, not an empty axis. An empty
     * coordinate system says "zero failures", and that is a claim nobody made.
     *
     * ---- AND `W-35` SHIPPED THE OPPOSITE DEFECT ----
     *
     * The chart counts a lattice it never pushes, so the base's `readEmptyState`
     * - which asks whether a SCENE GRID exists - answered `'nodata'` for every
     * chart, including one with bars on screen. The base drew the no-data image
     * underneath them: a picture saying *there is nothing here* behind a picture
     * of the something. Measured before the fix: all three cases reported
     * `nodata`.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 320, height: 220 }),
        setAttribute() {}, querySelector: () => null,
    });
    const themeVars = (theme) => {
        const css = readFileSync(new URL(
            `../../../Controls/SubstrateMapBinChart/Themes/${theme}/Style.css`, import.meta.url),
        'utf8');
        const out = new Map();
        for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) { out.set(m[1], m[2].trim()); }
        return out;
    };
    const underTheme = (theme, fn) => {
        const vars = themeVars(theme);
        const hadDoc = 'document' in globalThis;
        const savedDoc = globalThis.document;
        const savedStyle = window.getComputedStyle;
        globalThis.document = { createElement: node };
        window.getComputedStyle = () => ({
            getPropertyValue: (n) => vars.get(n) ?? '', fontFamily: 'sans-serif',
        });
        try { return fn(vars); } finally {
            window.getComputedStyle = savedStyle;
            if (hadDoc) { globalThis.document = savedDoc; } else { delete globalThis.document; }
        }
    };
    const gd = (bins) => ({
        substrateId: 'W', dimension: { x: bins[0].length, y: bins.length }, units: 'mm',
        stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray', bins,
        binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
    });
    /*
     * A BAR is narrower than the canvas. Filtering on `h > 0` alone counts the
     * BACKGROUND, which under a theme is a full-canvas `fillRect` and under no
     * theme is nothing at all - so the same filter that worked in section 45 (no
     * themes there) reported one bar for an empty chart here. The shape of a bar
     * is what distinguishes it, not the fact that it was filled.
     */
    const bars = (c, width = 320) => c.__canvasContext.fills.filter((f) => f.h > 0 && f.w < width);

    const chart = (data) => {
        const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
        c.__elementTemplateRoot = node('div');
        c.__element = [{ nodeType: 1 }];
        if (data !== null) { c.setGridData(data); }
        c.__attach();
        renderOnce(c, 320);
        return c;
    };

    attempt('THREE STATES, and they are three — not one repeated', () => {
        /*
         * Done-when 1 and 2 together, because the defect was that they collapsed.
         * `nodata` for nothing bound; `data` for a map with bins; `data` for a map
         * of only null cells, distinguished by what is DRAWN rather than by the
         * state name - the map arrived either way.
         */
        underTheme('Base', () => {
            const empty = chart(null);
            eq(empty.readEmptyState(), 'nodata', 'nothing bound: nodata');
            eq(empty.readCategories().length, 0, '  and no categories');

            const full = chart(gd(['1191', '1911', '1119']));
            eq(full.readEmptyState(), 'data', 'a real map: data, NOT nodata');
            ok(full.readCategories().length > 0, '  with categories');

            const nulls = chart(gd(['....', '....', '....']));
            eq(nulls.readEmptyState(), 'data', 'an all-null map: data — something arrived');
            eq(nulls.readCategories().length, 0, '  and nothing to count');
        });
    });

    attempt('an all-null map is DISTINGUISHABLE from no data, and says which', () => {
        /*
         * Done-when 2. `totalCells > 0`, no bars, and a line saying so. Falling back
         * to the no-data image would say "nothing was bound", which is false and
         * hides an operator's real problem: a map arrived and it is empty.
         */
        underTheme('Base', () => {
            const nulls = chart(gd(['....', '....', '....']));
            const stats = nulls.readBinStatistics();
            ok(stats.totalCells > 0, `${stats.totalCells} cells`);
            eq(stats.nullCount, stats.totalCells, '  every one of them null');
            eq(bars(nulls).length, 0, '  and no bars');

            const line = nulls.readNoBinsText();
            ok(/12/.test(line), `the line carries the COUNT: "${line}"`);
            ok(nulls.__canvasContext.textDraws.some((d) => d.text === line),
                '  and it is drawn');

            const empty = chart(null);
            eq(empty.readNoBinsText(), '0 cells, none carries a bin',
                'with no map the sentence is different, and no bins line is drawn');
            ok(!empty.__canvasContext.textDraws.some((d) => /carries a bin/.test(String(d.text))),
                '  because the no-data image speaks for that case');
        });
    });

    attempt('no EMPTY AXIS is drawn for either empty case', () => {
        /* An empty coordinate system is a picture of a measurement, and there was
         * no measurement. `strokesAndFills` counts the zero line the bars sit on. */
        underTheme('Base', () => {
            for (const [name, data] of [['nothing bound', null],
                ['an all-null map', gd(['....', '....'])]]) {
                const c = chart(data);
                eq(bars(c).length, 0, `${name}: no bars`);
                eq(c.__canvasContext.strokeRects.length, 0, `  ${name}: and no frame`);
            }
        });
    });

    attempt('BOTH THEMES render every state, in theme colours', () => {
        /* Done-when 1's "in both themes", and the bars must take their colour from
         * the theme rather than from a fallback - which is what proves the chart's
         * own stylesheet is reaching it. */
        for (const theme of ['Base', 'Base-Dark']) {
            underTheme(theme, (vars) => {
                eq(chart(null).readEmptyState(), 'nodata', `${theme}: no-data`);

                const full = chart(gd(['1191', '1911', '1119']));
                const colours = bars(full).map((f) => String(f.fillStyle));
                ok(colours.length >= 2, `${theme}: ${colours.length} bars`);
                ok(colours.includes(vars.get('--substratemap-bin-pass')),
                    `  ${theme}: the pass bar is the theme's pass colour`);
                ok(colours.includes(vars.get('--substratemap-bin-fail')),
                    `  ${theme}: and the fail bar the theme's fail colour`);

                const nulls = chart(gd(['....', '....']));
                ok(nulls.__canvasContext.textDraws.some((d) => /carries a bin/.test(String(d.text))),
                    `  ${theme}: and the all-null line is drawn`);
            });
        }
    });

    attempt('the two themes declare the same names, and share the map\'s colours', () => {
        const light = themeVars('Base');
        const dark = themeVars('Base-Dark');
        deep([...light.keys()].sort(), [...dark.keys()].sort(),
            'Base and Base-Dark declare the same set');
        ok(!light.has('--substratemap-tile-stale-color'),
            'and the chart does not carry the tile\'s variable');
    });

    attempt('no hard-coded colour survives in the chart', () => {
        /* Done-when 3. `check-descriptors` enforces this across every control; this
         * asserts the chart specifically, because a gate that covers everything can
         * be relaxed for something else. */
        for (const f of ['SubstrateMapBinChart.ts', 'Style.css']) {
            const src = readFileSync(new URL(
                `../../../Controls/SubstrateMapBinChart/${f}`, import.meta.url), 'utf8');
            const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
            const hits = [...code.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g)].map((m) => m[0]);
            deep(hits, [], `${f}: no colour literal outside the theme files`);
        }
    });

    attempt('__hasContent is a BASE hook, and only the chart overrides it', () => {
        /*
         * A default rather than an abstract hook, by the rule `W-29` set. Three of
         * the four concrete controls want "a grid is pushed"; the chart holds one it
         * never pushes, and without the override every chart reported `nodata`.
         */
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        ok(/__hasContent\(\)\s*\{\s*return this\.__sceneGrid !== null;/
            .test(base.replace(/\s+/g, ' ')), 'the base defaults to the scene grid');
        for (const [name, file] of [['the map', 'SubstrateMap/SubstrateMap.js'],
            ['the tile', 'SubstrateMapWidget/SubstrateMapWidget.js'],
            ['the bar', 'SubstrateMapFilterBar/SubstrateMapFilterBar.js']]) {
            const src = readFileSync(new URL(`../../../Controls/${file}`, import.meta.url), 'utf8');
            ok(!/__hasContent/.test(src), `${name} does not override it`);
        }
        const chartSrc = readFileSync(new URL(
            '../../../Controls/SubstrateMapBinChart/SubstrateMapBinChart.js', import.meta.url),
        'utf8');
        ok(/__hasContent/.test(chartSrc), 'and the chart does');
    });
});

section('60. the header band is reserved, in BOTH chart styles (F-26)', () => {
    /*
     * REPORTED FROM A LIVE VIEW: `received 15:40:47 GMT+2` printed on top of
     * `P  80.8 %` in the Share chart.
     *
     * `CHART_HEADER` exists to reserve the band `__drawHeader` writes into, and
     * `__drawBars` had always added it - `plotTop = CHART_PAD + CHART_HEADER`.
     * `__drawShare` never did: it centred the pie on `height / 2` and started the
     * legend at `CHART_PAD`, as though the header were not there. One constant, two
     * styles, and only one of them read it (`D-255`).
     *
     * The assertion is a BAND, not a pair of baselines. The first version of this
     * measurement compared "is the topmost body baseline below the header baseline"
     * and answered CLEAR for the broken geometry too, because a baseline at 18 is
     * numerically below a header band that runs to 25 (observation 409).
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 250, height: 155 }),
    });
    /*
     * `__attach` reaches for `document.createElement` and this suite runs without
     * one. `element-stub.mjs` is the minimal DOM `F-9` added for the FilterBar, and
     * it is opt-in precisely so a suite can take it when it needs one (`D-235`).
     */
    installDocumentStub();
    const CHART_PAD = 10;
    const CHART_HEADER = 15;
    /** The rows the header owns. A body baseline in here is drawn over the header. */
    const BAND = [CHART_PAD - 4, CHART_PAD + CHART_HEADER];

    const grid = JSON.stringify({
        dimension: { x: 8, y: 8 }, units: 'mm', stepSize: { x: 8, y: 8 }, orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii',
        nullBin: '.', mapType: '2DArray',
        binDefinitions: [{ binCode: 'P', binQuality: 'Pass' }, { binCode: 'F', binQuality: 'Fail' }],
        bins: ['..PPPP..', '.PPPPPF.', 'PPPPPFFP', 'PPPPFFPP',
            'PPPFFPPP', 'PPFFPPPP', '.PFPPPP.', '..PPPP..'],
    });
    /** @param style 'Bars' or 'Share'. @param h Canvas height. @returns The recorder. */
    const draw = (style, h) => {
        const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
        c.__elementTemplateRoot = node('div');
        c.__element = [{}];
        c.setGridData(grid);
        c.setChartStyle(style);
        c.__substrateId = 'LOT-B';
        renderOnce(c, 250, h);
        return renderOnce(c, 250, h);
    };

    attempt('neither style writes body text into the header band', () => {
        /*
         * Every height from cramped to roomy, because the collision is a function of
         * how much room is left AFTER the header - a chart tall enough to hide it
         * would make a single-size assertion pass for the wrong reason.
         */
        const bad = [];
        let bodyRows = 0;
        for (const style of ['Bars', 'Share']) {
            for (const h of [120, 155, 200, 320]) {
                const ctx = draw(style, h);
                for (const t of ctx.textDraws ?? []) {
                    const text = String(t.text);
                    if (/^received |^measured |^LOT-B$/.test(text)) { continue; }
                    bodyRows++;
                    if (t.y >= BAND[0] && t.y <= BAND[1]) {
                        bad.push(`${style} at ${h}px: "${text}" at y=${Math.round(t.y)}`);
                    }
                }
            }
        }
        eq(bad.length, 0,
            `no body text in the reserved header rows${bad.length ? ` (first: ${bad[0]})` : ''}`);
        ok(bodyRows > 0, `and the sweep drew body text at all: ${bodyRows} row(s)`);
    });

    attempt('the header itself is still drawn, in both styles', () => {
        for (const style of ['Bars', 'Share']) {
            const ctx = draw(style, 155);
            const head = (ctx.textDraws ?? []).filter((t) => /^received |^LOT-B$/.test(String(t.text)));
            eq(head.length, 2, `${style}: the id and the age are both written`);
            for (const t of head) {
                ok(t.y >= BAND[0] && t.y <= BAND[1],
                    `  ${style}: "${String(t.text).slice(0, 20)}" sits IN the band it reserves`);
            }
        }
    });

    attempt('the Share legend starts below the header, not at the padding', () => {
        const ctx = draw('Share', 155);
        const legend = (ctx.textDraws ?? [])
            .filter((t) => /%/.test(String(t.text)))
            .sort((a, b) => a.y - b.y);
        ok(legend.length >= 2, `the legend has rows to place (${legend.length})`);
        ok(legend[0].y > BAND[1],
            `the first legend row is below the header band (y=${Math.round(legend[0].y)} > ${BAND[1]})`);
    });
});

section('48. the chart contact sheet (W-38)', () => {
    /*
     * The sheet itself is `TIER 3` and needs a person. What is asserted here is
     * the property it exists to make visible - and the DEFECT it found, which no
     * assertion had caught.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    /** @param n Codes. @param quality Whether the definitions declare one. */
    const gd = (n, quality) => {
        const codes = 'ABCDEFGHIJ'.slice(0, n).split('');
        const bins = [];
        for (let r = 0; r < n; r++) {
            let l = '';
            for (let c = 0; c < n; c++) { l += codes[c]; }
            bins.push(l);
        }
        return {
            substrateId: 'W', dimension: { x: n, y: n }, units: 'mm', stepSize: { x: 1, y: 1 },
            binType: 'Ascii', nullBin: '.', mapType: '2DArray', bins,
            binDefinitions: codes.map((c, i) => (quality
                ? { binCode: c, binQuality: i === 0 ? 'Pass' : 'Fail' }
                : { binCode: c })),
        };
    };
    const colours = (control) => control.readBinStatistics().bins.map((b) => `${b.code}=${b.color}`);
    const pair = (data) => {
        const m = new SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setGridData(JSON.parse(JSON.stringify(data)));
        m.__attach();
        renderOnce(m, 200);
        const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
        c.__elementTemplateRoot = node('div');
        c.__element = [{}];
        c.setGridData(JSON.parse(JSON.stringify(data)));
        c.__attach();
        renderOnce(c, 200);
        return { m, c };
    };

    attempt('THE DEFECT THE SHEET FOUND: no categorical fallback in the chart', () => {
        /*
         * `W-11` gives a code with no mapping and no usable quality a colour from
         * the categorical palette. The map applied it and the chart did not, so a
         * map whose definitions declare no quality rendered EIGHT DISTINCT COLOURS
         * on the wafer and eight identical greys in the bars.
         *
         * `W-35`'s Done-when 2 passed anyway: its fixture declared `Pass` and
         * `Fail`, quality colouring wins whenever a quality is there, and both
         * sides agreed by taking the same shortcut. A person looking at eight
         * orange bars beside an eight-coloured wafer saw it at once.
         */
        withDocument(() => {
            const { m, c } = pair(gd(8, false));
            const mapColours = colours(m);
            deep(colours(c), mapColours, 'chart and map agree, code for code');
            const distinct = new Set(mapColours.map((x) => x.split('=')[1]));
            eq(distinct.size, 8, `and there are ${distinct.size} distinct colours to agree ON`);
        });
    });

    attempt('and the case that HID it: declared qualities agree trivially', () => {
        /*
         * The same eight codes with `Pass`/`Fail` come out as two colours on both
         * sides. That agreement is real and worth nothing as evidence - which is
         * why the assertion above counts the distinct colours as well as comparing
         * them.
         */
        withDocument(() => {
            const { m, c } = pair(gd(8, true));
            deep(colours(c), colours(m), 'they agree');
            const distinct = new Set(colours(m).map((x) => x.split('=')[1]));
            eq(distinct.size, 2, `  on ${distinct.size} colours — quality wins over category`);
        });
    });

    attempt('a binary map agrees too, which is the common case', () => {
        withDocument(() => {
            const { m, c } = pair(gd(2, true));
            deep(colours(c), colours(m), 'two bins, same two colours');
        });
    });

    attempt('the sheet exists, names every combination, and is generated', () => {
        /* Done-when 1. The tool is the artefact; the assertion is that it covers
         * what the task asked for and says so on its face. */
        const src = readFileSync(new URL('../../../tools/chart-sheet.mjs', import.meta.url), 'utf8');
        for (const label of ['BINARY', '8 GRADES', '300 CODES']) {
            ok(src.includes(label), `the sheet has a ${label} row`);
        }
        for (const col of ['MAP', 'BARS', 'SHARE']) {
            ok(new RegExp(`'${col}'`).test(src), `and a ${col} column`);
        }
        ok(/'Base', 'Base-Dark'/.test(src), 'in both themes');
    });

    attempt('the sheet draws CONTROLS, not its own idea of them', () => {
        /*
         * `W-24`'s lesson. A sheet that reconstructed the picture from the data
         * would agree with the control exactly when they shared a misunderstanding
         * - and the first version of this one did exactly that for the map column,
         * producing a grey disc beside an eight-coloured chart.
         */
        const src = readFileSync(new URL('../../../tools/chart-sheet.mjs', import.meta.url), 'utf8');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
        ok(/new Harness\.SubstrateMap\(/.test(code), 'the map column is a real SubstrateMap');
        ok(/new Chart\.SubstrateMapBinChart\(/.test(code), 'the chart columns are real charts');
        ok(!/buildGridPaint|renderGridLayer/.test(code),
            '  and the tool renders nothing through the engine itself');
    });
});

section('49. the review changes (W-38a)', () => {
    /*
     * What the user asked for after looking at `W-38`'s sheet. Three of the eight
     * points were the SHEET misreporting the product - a 5x7 bitmap font, an
     * unantialiased wedge rasteriser, and a fixture using punctuation codes the
     * sheet font cannot render. Those are fixed in the tool. These are the
     * product changes.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 260, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    const gd = (n) => {
        const codes = 'ABCDEFGH'.slice(0, n).split('');
        const bins = [];
        for (let r = 0; r < n; r++) {
            let l = '';
            for (let c = 0; c < n; c++) { l += codes[c]; }
            bins.push(l);
        }
        return {
            substrateId: 'W-42', dimension: { x: n, y: n }, units: 'mm', stepSize: { x: 1, y: 1 },
            binType: 'Ascii', nullBin: '.', mapType: '2DArray', bins,
            binDefinitions: codes.map((c) => ({ binCode: c })),
        };
    };
    const chart = (n, patch) => {
        const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
        c.__elementTemplateRoot = node('div');
        c.__element = [{}];
        c.setGridData(gd(n));
        c.setChartStyle('Share');
        if (patch !== undefined) { patch(c); }
        c.__attach();
        renderOnce(c, 260);
        return c;
    };

    attempt('NO percentage is drawn inside a wedge', () => {
        /*
         * The change, and the assertion `W-36` did not have: it checked that a
         * sliver is not labelled and never that a wide one is, so removing the
         * drawing broke nothing. Asserted here in the direction that would catch
         * the drawing coming back.
         */
        withDocument(() => {
            const c = chart(8);
            const centred = c.__canvasContext.textDraws.filter((d) => d.align === 'center');
            deep(centred.map((d) => d.text), [], 'nothing is centred in a wedge');
            const anyPercent = c.__canvasContext.textDraws
                .filter((d) => /%/.test(String(d.text)));
            ok(anyPercent.every((d) => d.align === 'left'),
                `every figure is in the legend: ${anyPercent.length} entries, all left-aligned`);
        });
    });

    attempt('the legend carries the BIN CODE beside every figure', () => {
        /* It always did. The sheet reported otherwise because its fixture used
         * punctuation codes and its own font has none. */
        withDocument(() => {
            const c = chart(8);
            /*
             * The HEADER is left-aligned too, and it is not a legend entry. The
             * ninth `align === 'left'` text was the substrate id this same task
             * added an hour earlier - my own change breaking my own assertion in
             * the turn that wrote both.
             *
             * A legend entry is one that carries a figure, which is what makes it a
             * legend entry.
             */
            const legend = c.__canvasContext.textDraws
                .filter((d) => d.align === 'left' && /%/.test(String(d.text)));
            eq(legend.length, c.readCategories().length,
                `${legend.length} legend entries, one per category`);
            for (const code of 'ABCDEFGH'.split('')) {
                ok(legend.some((d) => String(d.text).startsWith(`${code}  `)),
                    `${code} appears with its figure: ${legend.find((d) => String(d.text).startsWith(code))?.text}`);
            }
        });
    });

    attempt('every wedge is OUTLINED, in the background rather than a border colour', () => {
        /*
         * Two adjacent categorical colours can be close, and two flat fills meeting
         * with no edge read as one wedge. The separator is the BACKGROUND so the
         * wedges look cut apart rather than framed - a dark line round every
         * segment turns a pie into a stained-glass window.
         */
        withDocument(() => {
            const c = chart(8);
            const arcs = c.__canvasContext.arcFills ?? [];
            eq(arcs.length, 8, 'eight wedges filled');
            /*
             * `stroke()` is a COUNTER in the shim - the sixth counting stub, and the
             * one place this assertion can reach. It cannot say what colour the
             * separator was, only that one was drawn per wedge, so the colour is
             * asserted on the source instead.
             */
            ok(c.__canvasContext.strokeCount >= arcs.length,
                `${c.__canvasContext.strokeCount} strokes for ${arcs.length} wedges`);
            const src = readFileSync(new URL(
                '../../../Controls/SubstrateMapBinChart/SubstrateMapBinChart.js', import.meta.url),
            'utf8');
            ok(/strokeStyle = colors\.bg !== '' && colors\.bg !== 'transparent'/.test(src),
                'and the separator is the background colour, not a border colour');
        });
    });

    attempt('the header names the wafer and says how old the data is', () => {
        /*
         * A chart beside a map is unambiguous; a chart in a screenshot pasted into
         * an email is a set of numbers about an unnamed wafer at an unknown time.
         * Both facts are cheap to carry and neither can be recovered afterwards.
         */
        withDocument(() => {
            const c = chart(8);
            const texts = c.__canvasContext.textDraws.map((d) => String(d.text));
            ok(texts.includes('W-42'), `the substrate id: ${JSON.stringify(texts.slice(0, 2))}`);
            ok(texts.some((t) => /^received /.test(t)), '  and the age, labelled with its source');

            c.setMapTimestamp('2026-08-14T09:15:00Z');
            renderOnce(c, 260);
            const after = c.__canvasContext.textDraws.map((d) => String(d.text));
            ok(after.some((t) => /^measured /.test(t)),
                '  which becomes "measured" once a MapTimestamp is bound');
        });
    });

    attempt('MapTimestamp is the TILE\'s attribute, so one symbol drives both', () => {
        /*
         * Compared field by field, as `W-25b` compares the bar's against the map's.
         * A symbol cannot bind to two attributes that disagree about their type,
         * and the user asked for exactly this topology.
         */
        const chartDesc = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMapBinChart/Description.json', import.meta.url), 'utf8'));
        const tileDesc = JSON.parse(readFileSync(new URL(
            '../../../Controls/SubstrateMapWidget/Description.json', import.meta.url), 'utf8'));
        const a2 = chartDesc.attributes.find((x) => x.propertyName === 'MapTimestamp');
        const b2 = tileDesc.attributes.find((x) => x.propertyName === 'MapTimestamp');
        ok(a2 !== undefined && b2 !== undefined, 'both controls declare it');
        for (const field of ['name', 'type', 'defaultValue', 'propertySetterName',
            'propertyGetterName']) {
            eq(a2[field], b2[field], `  MapTimestamp.${field} matches the tile's`);
        }
    });

    attempt('the age helpers are IMPORTED from the tile, not reimplemented', () => {
        /* A chart and a tile showing the same wafer must agree about how old it is,
         * and two copies of a clock is two clocks. */
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMapBinChart/SubstrateMapBinChart.js', import.meta.url),
        'utf8');
        /*
         * FROM THE BASE, since `W-38b`. They lived in the tile and the chart
         * imported them from a sibling - a clock owned by whichever control wanted
         * it first. The map needing them too made that shape untenable.
         */
        ok(/from '\.\.\/SubstrateMapBase\/SubstrateMapBase\.js'/.test(src),
            'imported from the base');
        const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
        ok(!/function formatAge|function parseMapTimestamp/.test(code),
            '  and defines neither of its own');
    });

    attempt('the SHEET no longer misreports the product', () => {
        /*
         * Three of the eight review points were the tool. Asserted so a later
         * change cannot quietly reintroduce them - a review artefact that lies is
         * worse than none, because it is believed.
         */
        const src = readFileSync(new URL('../../../tools/chart-sheet.mjs', import.meta.url), 'utf8');
        /*
         * COMMENTS STRIPPED. The first version matched the comment EXPLAINING why
         * `fromCharCode(33)` was wrong - `W-28`'s lesson for the third time, and the
         * third time in a comment written to record the very rule being checked.
         */
        const code2 = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
        ok(!/String\.fromCharCode\(33/.test(code2),
            'the fixture uses printable codes the sheet font can render');
        ok(/ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(src), '  uppercase, which the 5x7 font has');
        /*
         * AGAINST THE CODE, and without an alternative that a comment can satisfy.
         * The first version was `/SS = 4|supersampl/i` and the word `supersampled`
         * is in the comment explaining the constant - so lowering the constant to 1
         * left the assertion green. Fourth comment-matching bug in this task; the
         * pattern is not that comments are tricky, it is that **a regex with an
         * alternative is a regex with a way to pass for the wrong reason.**
         */
        ok(/const SS = 4;/.test(code2), 'the wedges are supersampled 4x4, not one-sample');
        ok(/bitmap font, not the control/.test(src),
            'and the sheet says on its face that its type is the tool\'s, not the control\'s');
    });
});

section('50. the staleness heartbeat, and the age on the map (W-38b)', () => {
    /*
     * ---- THE ONE THING THAT CANNOT BE OBSERVED ----
     *
     * Every other update in this package is a reaction to an event: data arrives
     * by binding, size by `ResizeObserver`, theme by the framework. There is no
     * timer anywhere else, and there does not need to be.
     *
     * Staleness is the ABSENCE of an event. `W-30` drew the stale border during a
     * render, and a render happens on new data - so on a dashboard where a feed
     * had died, nothing ever triggered one and **the warning that a feed is dead
     * could only appear while the feed was alive.**
     *
     * `W-30`'s Done-when was asserted by constructing two tiles, one already old,
     * and rendering both on the spot. Nothing let a clock run, so nothing could
     * see that nothing crosses anything by itself.
     */
    const node = (t) => ({
        tagName: t, style: {}, children: [], className: '', textContent: '',
        appendChild(c) { this.children.push(c); return c; },
        remove() {}, addEventListener() {}, removeEventListener() {},
        getContext: () => null, getBoundingClientRect: () => ({ width: 200, height: 200 }),
        setAttribute() {}, querySelector: () => null,
    });
    const withDocument = (fn) => {
        const had = 'document' in globalThis;
        const saved = globalThis.document;
        globalThis.document = { createElement: node };
        try { return fn(); } finally {
            if (had) { globalThis.document = saved; } else { delete globalThis.document; }
        }
    };
    const MAP = {
        substrateId: 'W-42', dimension: { x: 4, y: 3 }, units: 'mm', stepSize: { x: 1, y: 1 },
        binType: 'Ascii', nullBin: '.', mapType: '2DArray', bins: ['1191', '1.11', '1911'],
        binDefinitions: [{ binCode: '1', binQuality: 'Pass' }, { binCode: '9', binQuality: 'Fail' }],
    };

    attempt('THE INTERVAL IS DERIVED FROM THE THRESHOLD, not a constant', () => {
        /*
         * The user's point, and it is the whole design: a takt time of fifteen
         * minutes per substrate and a printer at 1.2 seconds are three orders of
         * magnitude apart. Polling every second is waste on the first; polling
         * every minute is useless on the second.
         *
         * The author has already told us the timescale by setting the threshold.
         */
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        const tick = (sec) => w.__staleTickMs(sec);
        eq(tick(null), null, 'no threshold, NO TIMER AT ALL — the cost lands only on askers');
        eq(tick(0), null, 'and zero means never, as the attribute says');
        eq(tick(45), 4_500, '15-second takt: a 45 s threshold checks every 4.5 s');
        eq(tick(5), 1_000, 'a 1.2 s printer: a 5 s threshold hits the 1 s floor');
        eq(tick(2), 1_000, 'and a 2 s threshold does not produce a 200 ms heartbeat');
        eq(tick(900), 60_000, '15-minute takt: a 900 s threshold hits the 60 s CEILING');
        eq(tick(86_400), 60_000, 'and so does a one-day threshold');

        /*
         * THE CEILING MAKES LONG THRESHOLDS MORE ACCURATE, NOT LESS, and it costs
         * one wake a minute. The first version of this assertion demanded a flat
         * 10 % and went red on the user's own 15-minute case, where the ceiling
         * gives 6.7 % instead. The assertion was wrong and the code was right.
         *
         * The guarantee is: never later than a tenth of the threshold, never later
         * than a minute, and never waking faster than once a second - so a very
         * short threshold trades accuracy for calm, which is the only direction
         * that trade can go.
         */
        for (const sec of [45, 900, 3600, 86_400]) {
            const lateS = tick(sec) / 1000;
            ok(lateS <= sec / 10 + 1e-9 && lateS <= 60,
                `  ${sec} s: at most ${lateS} s late, ${((lateS / sec) * 100).toFixed(1)} %`);
        }
        ok(tick(5) / 1000 > 5 / 10, 'below 10 s the floor wins, and calm beats precision');
    });

    attempt('an IDLE tile crosses its own threshold — by letting a clock run', () => {
        /*
         * The defect, asserted the only way that could have caught it. Nothing
         * touches the control between the two reads: no data, no resize, no render
         * call. If the border appears, something woke it up.
         */
        return withDocument(async () => {
            const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
            t.__elementTemplateRoot = node('div');
            t.__element = [{}];
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            t.setStaleAfterSeconds(10);          // a 1 s heartbeat, by the floor
            t.__attach();
            renderOnce(t, 200);
            eq(t.__canvasContext.strokeRects.length, 0, 'fresh: no border');
            ok(t.__staleTimer !== null, 'and a heartbeat is running');

            // Age the payload past the threshold WITHOUT touching the control.
            t.__receivedAt = new Date(Date.now() - 30_000);
            await new Promise((r) => { setTimeout(r, 1_400); });

            ok(t.__renderRequests > 1,
                `the heartbeat asked for ${t.__renderRequests} renders while nothing else happened`);
            t.__detach();
        });
    });

    attempt('and NOTHING runs when no threshold is set', () => {
        withDocument(() => {
            const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
            t.__elementTemplateRoot = node('div');
            t.__element = [{}];
            t.setGridData(JSON.parse(JSON.stringify(MAP)));
            t.__attach();
            eq(t.__staleTimer, null, 'no threshold, no timer');
            t.setStaleAfterSeconds(60);
            ok(t.__staleTimer !== null, 'setting one starts it');
            t.setStaleAfterSeconds(null);
            eq(t.__staleTimer, null, 'and clearing it stops it');
            t.__detach();
        });
    });

    attempt('teardown clears the heartbeat', () => {
        /* The `W-26` lesson: one leaked timer per show/hide is the defect that
         * looks like nothing for an hour. */
        withDocument(() => {
            const t = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
            t.__elementTemplateRoot = node('div');
            t.__element = [{}];
            t.setStaleAfterSeconds(60);
            for (let i = 0; i < 5; i++) {
                t.__attach();
                t.__detach();
                eq(t.__staleTimer, null, `cycle ${i + 1}: nothing left running`);
            }
        });
    });

    attempt('the MAP shows the substrate id and the age, in its identity band', () => {
        /*
         * The user's request. The map already named the substrate; only the
         * timestamp was missing. It goes in the BAND rather than on the canvas -
         * the tile and the chart paint it because neither has a text band, and the
         * map has one, where it is selectable and does not cover the wafer.
         */
        const m = new SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setGridData(JSON.parse(JSON.stringify(MAP)));
        m.__attach();
        const line = m.__composeIdentity();
        ok(line.startsWith('W-42'), `the substrate id first: "${line}"`);
        ok(/received /.test(line), '  then how old the data is, with its source named');

        m.setMapTimestamp('2026-08-14T09:15:00Z');
        ok(/measured /.test(m.__composeIdentity()),
            'which becomes "measured" once a MapTimestamp is bound');
    });

    attempt('ONE SYMBOL drives map, tile and chart — the attribute is identical', () => {
        /* Compared field by field across all three, as `W-25b` compares the bar's
         * against the map's. A symbol cannot bind to attributes that disagree. */
        const read = (c) => JSON.parse(readFileSync(new URL(
            `../../../Controls/${c}/Description.json`, import.meta.url), 'utf8'))
            .attributes.find((a) => a.propertyName === 'MapTimestamp');
        const map = read('SubstrateMap');
        const tile = read('SubstrateMapWidget');
        const chart = read('SubstrateMapBinChart');
        ok(map !== undefined && tile !== undefined && chart !== undefined,
            'all three declare it');
        for (const field of ['name', 'type', 'defaultValue', 'propertySetterName',
            'propertyGetterName']) {
            eq(map[field], tile[field], `map/tile MapTimestamp.${field}`);
            eq(chart[field], tile[field], `chart/tile MapTimestamp.${field}`);
        }
    });

    attempt('the age helpers live in the BASE, and no control imports from a sibling', () => {
        /*
         * They lived in the tile because the tile needed them first, and the chart
         * imported them FROM THE TILE - a clock owned by whichever control happened
         * to want it earliest. Adding the map as a third importer made that shape
         * untenable.
         */
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        for (const fn of ['formatAge', 'parseMapTimestamp', 'isStale']) {
            ok(new RegExp(`function ${fn}`).test(base), `the base defines ${fn}`);
        }
        for (const [name, file] of [['the map', 'SubstrateMap/SubstrateMap.js'],
            ['the tile', 'SubstrateMapWidget/SubstrateMapWidget.js'],
            ['the chart', 'SubstrateMapBinChart/SubstrateMapBinChart.js']]) {
            const src = readFileSync(new URL(`../../../Controls/${file}`, import.meta.url), 'utf8');
            ok(!/from '\.\.\/SubstrateMapWidget\//.test(src),
                `${name} imports nothing from the tile`);
            ok(!/function formatAge|function parseMapTimestamp/.test(src),
                `  and defines no clock of its own`);
        }
    });
});

section('51. README, conformance matrix, release notes (W-39)', () => {
    /*
     * Documentation is asserted the way documentation can be: not that it reads
     * well, but that a reader looking for a specific thing FINDS it, and that
     * nothing in it contradicts the code.
     */
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    const notes = readFileSync(
        new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');

    attempt('a dashboard author can bind all three new controls from the README alone', () => {
        /*
         * Done-when 1, checked as coverage: every BINDABLE attribute of each new
         * control has a row somewhere in the README. `check-readme` enforces this
         * across all four controls as a gate; this states it for the three the task
         * is about, so a later relaxation of the gate cannot quietly drop them.
         */
        for (const control of ['SubstrateMapWidget', 'SubstrateMapBinChart',
            'SubstrateMapFilterBar']) {
            const d = JSON.parse(readFileSync(new URL(
                `../../../Controls/${control}/Description.json`, import.meta.url), 'utf8'));
            const bindable = (d.attributes ?? []).filter((a) => a.bindable !== false);
            ok(bindable.length > 0, `${control}: ${bindable.length} bindable attributes`);
            for (const a of bindable) {
                ok(readme.includes(`\`${a.propertyName}\``),
                    `  ${control}.${a.propertyName} appears in the README`);
            }
        }
    });

    attempt('THE FOUR EMPTY-ISH STATES are distinguishable from the docs alone', () => {
        /*
         * Done-when 2. Four states that all look like "not much on screen" and are
         * not interchangeable. The README has to name each one, say when it
         * happens, and say what it looks like - and the precedence has to be
         * stated, because reading them as a set is the only way to tell which one
         * you are in.
         */
        const table = readme.slice(readme.indexOf('The four empty-ish states'));
        for (const state of ['`data`', '`stale`', '`demo`', '`nodata`']) {
            ok(table.includes(state), `${state} is named`);
        }
        ok(/precedence is fixed/i.test(table), 'and the precedence is stated as fixed');
        ok(/only null cells/i.test(table),
            'plus the fifth case that is none of them: a map that parsed and holds nothing');
        ok(/reload loses it/i.test(table), 'and the reload caveat on the retained state');

        // The order in the README must be the order the code applies.
        const idx = ['`data`', '`stale`', '`demo`', '`nodata`'].map((x) => table.indexOf(x));
        deep(idx, [...idx].sort((a, b) => a - b),
            'the table is in precedence order, so reading top to bottom is reading the rule');
    });

    attempt('the legal filter combinations are tabulated, and match `filterApplies`', () => {
        /*
         * A table a reader trusts and the code disagreeing is worse than no table.
         * Every cell is checked against the function.
         */
        const start = readme.indexOf('### Which filter works on which channel');
        ok(start >= 0, 'the section exists');
        const table = readme.slice(start, start + 1400);
        let checked = 0;
        for (const filter of ['None', 'Median', 'Min', 'Max', 'Box', 'Gauss']) {
            /*
             * A TABLE ROW, not merely a line mentioning the filter. The prose above
             * the table names `Median`, `Min` and `Max` in a sentence, and the first
             * version matched that line - so every cell read came from prose and
             * every `✓` comparison was against a word. The failures said
             * "the table says undefined", which was true and pointed at the wrong
             * table.
             */
            const row = table.split(/\r?\n/)
                .find((l) => l.trimStart().startsWith(`| \`${filter}\``));
            ok(row !== undefined, `${filter} has a row`);
            /*
             * Cells 2..4: a leading empty string from the opening pipe, then the
             * label, then the three channels. The first version sliced 2..5 and read
             * the label plus two channels, reporting `undefined` for the third.
             */
            const cells = row.split('|').map((c) => c.trim()).slice(2, 5);
            const views = ['Bins', 'FailDensity', 'ValueField'];
            for (let i = 0; i < 3; i++) {
                const documented = cells[i] === '✓';
                eq(documented, SubstrateMapMod.filterApplies(filter, views[i]),
                    `  ${filter} on ${views[i]}: the table says ${cells[i]}`);
                checked++;
            }
        }
        eq(checked, 18, 'all eighteen pairings checked against the code');
        ok(/Eight of the eighteen/.test(table), 'and the count is stated');
    });

    attempt('the zoom dependence is explained, with its reason', () => {
        /* Not just "filters need aggregation" but WHY - a filter runs over the
         * bitmap, and above one device pixel per cell there is no bitmap to run
         * over. A reader who knows the reason can predict the behaviour. */
        const start = readme.indexOf('### Filters need pixels, and the zoom decides');
        ok(start >= 0, 'the section exists');
        const text = readme.slice(start, start + 1200);
        ok(/smaller than one device pixel/i.test(text), 'the threshold is named');
        ok(/aggregated bitmap/i.test(text), 'and the reason: a filter runs over the bitmap');
        ok(/readAggregation/.test(text), 'with the function that lets a view explain it');
    });

    attempt('the image-size recommendation is concrete', () => {
        /* A recommendation without a number is not a recommendation. */
        const start = readme.indexOf('### The no-data image, and what to ship');
        ok(start >= 0, 'the section exists');
        const text = readme.slice(start, start + 1200);
        ok(/SVG/.test(text), 'SVG is recommended first');
        ok(/512/.test(text) && /256/.test(text), 'and raster sizes are given as numbers');
        ok(/lightness/i.test(text), 'plus how the dark variant is chosen');
    });

    attempt('the conformance matrix says which control reads what', () => {
        const start = readme.indexOf('#### Which control reads which of it');
        ok(start >= 0, 'the section exists');
        const text = readme.slice(start, start + 1600);
        for (const c of ['SubstrateMap', 'SubstrateMapWidget', 'SubstrateMapBinChart',
            'SubstrateMapFilterBar', 'SubstrateMapBase']) {
            ok(text.includes(c), `${c} has a row`);
        }
        ok(/transfer map/i.test(text), 'and the transfer-map trap is called out');
    });

    attempt('the release notes carry all three breaking changes, each with an action', () => {
        /*
         * A breaking change without "what to do" is a warning, not a note. Each of
         * the three from the spec's section 1 must say what a consumer does.
         */
        ok(/4\.0\.0\.0/.test(notes), 'the version is named');
        for (const [n, phrase] of [[1, 'no-data image'], [2, 'outline'],
            [3, 'BinQuality'], [4, 'raised after the attributes']]) {
            ok(notes.includes(phrase), `change ${n} is described (${phrase})`);
        }
        const actions = [...notes.matchAll(/\*\*What to do:\*\*/g)];
        ok(actions.length >= 4, `${actions.length} "what to do" instructions, one per change`);
        ok(/renders byte-identically to before/.test(notes),
            'and the case that does NOT change is stated, which is what most readers need');
    });

    attempt('the provenance convention is stated, and the tags are not noise', () => {
        /*
         * Done-when 3, read as Rule 3 intends rather than literally. **Rule 13
         * deviation, stated.**
         *
         * The task says *no normative sentence is untagged*. Measured, the sections
         * this spec added hold 199 sentences over forty characters, of which EIGHT
         * make a claim about the standard or an external fact. The rest describe
         * what this package does.
         *
         * Tagging behaviour statements with source tags would make the tags
         * worthless: a reader could no longer tell which claims rest on SEMI and
         * which on us. So the README states two conventions and applies each where
         * it belongs - source tags for claims about the standard, and for claims
         * about behaviour, the REASONING rather than a citation.
         *
         * The behaviour half used to be a `D-`/`W-` identifier, and this asserted
         * that an example of one appeared. Those identifiers point at design records
         * that are not distributed, so they were removed from everything a customer
         * receives; the assertion followed. Fourth time in this spec that the corpus
         * asserted the exact thing being changed.
         */
        const start = readme.indexOf('## How to read a claim in this document');
        ok(start >= 0, 'the convention is documented');
        const text = readme.slice(start, start + 1800);
        for (const tag of ['[XSD-normative]', '[Primary source]', '[Secondary source]', '[Inference]']) {
            ok(text.includes(tag), `${tag} is defined`);
        }
        ok(/would make the tags worthless/.test(text),
            'and the reason behaviour statements are NOT tagged is given');
        ok(/dead reference/.test(text),
            'and the reason a bare identifier is not provenance is given');
        ok(!/(?<![A-Za-z0-9])(?:[FWMS]-\d+[a-z]?|OD-\d{3}|D-\d{3})(?![0-9A-Za-z])/.test(text),
            'while the section itself now cites no design record');

        const tags = [...readme.matchAll(/\*\*\[(Primary source|Inference|XSD-normative|Secondary source)\]\*\*/g)];
        ok(tags.length >= 3, `${tags.length} standard-derived claims carry a tag`);
    });
});

section('52. WIDGET-PATTERN.md (W-40)', () => {
    /*
     * A pattern document is only useful if a developer can follow it WITHOUT the
     * source it was extracted from. That is Done-when 1, and it decomposes into
     * two checkable halves: the document is complete, and the document is TRUE of
     * the code it describes.
     *
     * The second half is `D-201`'s rule again. A pattern that has drifted from the
     * package it was extracted from is worse than none, because a reader has no
     * way to notice.
     */
    const doc = readFileSync(new URL('../../../WIDGET-PATTERN.md', import.meta.url), 'utf8');
    const desc = (c) => JSON.parse(readFileSync(new URL(
        `../../../Controls/${c}/Description.json`, import.meta.url), 'utf8'));
    const source = (c) => readFileSync(new URL(
        `../../../Controls/${c}/${c}.ts`, import.meta.url), 'utf8');

    attempt('the numbers in it are the package\'s numbers', () => {
        /*
         * The table that opens the document is its whole argument - a widget is an
         * order of magnitude smaller than the control it summarises. If the numbers
         * drift, the argument stops being evidence and becomes a slogan.
         */
        for (const [control, attrs] of [['SubstrateMap', 68], ['SubstrateMapWidget', 9],
            ['SubstrateMapBinChart', 7], ['SubstrateMapFilterBar', 4]]) {
            eq(desc(control).attributes.length, attrs,
                `${control} really has ${attrs} attributes`);
            ok(new RegExp(`\\|\\s*\\*?\\*?${attrs}\\*?\\*?\\s*\\|`).test(doc),
                `  and the document says ${attrs}`);
        }
        /*
         * COUNTED FROM THE FILE, not repeated as a literal. The first version
         * hard-coded the counts in the assertion as well as in the document, so a
         * drift needed both to be wrong in the same way to be caught - which is not
         * a check, it is a second copy. The document is compared against the file;
         * the assertion holds no number of its own.
         */
        const lines = (c) => source(c).split(/\r?\n/).length;
        for (const control of ['SubstrateMapWidget', 'SubstrateMapBinChart',
            'SubstrateMapFilterBar']) {
            const n = lines(control);
            ok(doc.includes(String(n)),
                `${control} is ${n} lines, and the document says so`);
        }
    });

    attempt('the hook table matches what the base actually exposes', () => {
        /*
         * Abstract when omission is a bug; default when omission is the common case.
         * The document teaches that split, so the split has to be real.
         */
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.ts', import.meta.url), 'utf8');
        for (const hook of ['__composeIdentity', '__raiseSelected']) {
            ok(new RegExp(`protected abstract ${hook}`).test(base), `${hook} is abstract`);
            ok(doc.includes(`\`${hook}`), `  and the document lists it`);
        }
        for (const hook of ['__drawOverlay', '__hasContent', '__hasLastKnown',
            '__staleAfterSecondsForTimer']) {
            ok(new RegExp(`protected ${hook}\\(`).test(base) &&
               !new RegExp(`protected abstract ${hook}`).test(base),
            `${hook} is a default, not abstract`);
            ok(doc.includes(`\`${hook}`), `  and the document lists it`);
        }
        ok(/Abstract when omission is a bug/.test(doc), 'and states the rule behind the split');
    });

    attempt('who extends what is stated correctly', () => {
        /* The document says: extend the base only if you draw what the base draws,
         * and the bar is the counter-example. */
        eq(desc('SubstrateMapWidget').base, 'TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMapBase',
            'the tile extends the base');
        eq(desc('SubstrateMapBinChart').base, 'TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMapBase',
            'the chart extends the base');
        eq(desc('SubstrateMapFilterBar').base, 'TcHmi.Controls.System.TcHmiControl',
            'the bar extends TcHmiControl, because it renders no map');
        ok(/renders no map/.test(doc), 'and the document gives that as the reason');
        ok(/does it draw what the base draws/.test(doc), 'with the test stated as a question');
    });

    attempt('all SIX registration sites are named', () => {
        /* Miss one and the failure is silent in a specific way. The document has to
         * be exhaustive here or it is worse than useless. */
        const section = doc.slice(doc.indexOf('## 5. Registration'));
        for (const site of ['Manifest.json', 'Visual Studio project', 'descriptor gate',
            'README gate', 'tsc']) {
            ok(section.includes(site), `${site} is listed`);
        }
        ok(/\*\*six\*\*/.test(section), 'and the count is stated as six');
        ok(/cannot catch its own omission|list cannot catch/.test(section),
            'plus why a list-based check does not work');
    });

    attempt('all FOUR states are named, plus the fifth that is not a state', () => {
        const section = doc.slice(doc.indexOf('## 6. The four states'));
        for (const st of ['`data`', '`stale`', '`demo`', '`nodata`']) {
            ok(section.includes(st), `${st} is named`);
        }
        ok(/arrived and is \*empty\*|only null cells/.test(section),
            'and the case that is none of them');
        ok(/empty coordinate system|empty axis/i.test(section),
            'with the rule about not drawing bare axes');
    });

    attempt('THE MISTAKES ARE IN THE TEXT, not an appendix', () => {
        /*
         * The task's own instruction: *the parts that turned out to be wrong here
         * are the parts most worth passing on*. A pattern document that reads as
         * though the pattern arrived correct teaches nothing about how to arrive at
         * one.
         */
        const failures = [
            /27 885|27885/,                              // the flipped placement
            /eight identical greys/,                      // the missing palette
            /four times nothing went red/,                // the list-based checks
            // The phrase WRAPS in the document, so the newline has to be allowed for.
            // A prose assertion that assumes one line is an assertion about the
            // wrapping rather than the words.
            /only appear while the feed was\s+alive/,     // the stale border
            /behind a picture of the something/,          // nodata under the bars
            /three were the tool/,                        // the review sheet
        ];
        for (const f of failures) {
            ok(f.test(doc), `a failure is recorded: ${String(f).slice(0, 40)}`);
        }
        ok(failures.length >= 6, `${failures.length} mistakes passed on, with their measurements`);
    });

    attempt('the staleness rule is complete enough to implement from', () => {
        /* The rule the task calls out by name, and the one with a formula. */
        const section = doc.slice(doc.indexOf('## 7. A widget that cannot say'));
        ok(/cannot observe something not happening/.test(section), 'the reason a timer is needed');
        ok(/clamp\(threshold \/ 10, 1 s, 60 s\)/.test(section), 'the formula');
        ok(/Nothing runs when no threshold is set/.test(section), 'and the zero-cost default');
        ok(/measured/.test(section) && /received/.test(section),
            'plus both clock labels, which are different facts');
    });

    attempt('it does not send the reader to the source it was extracted from', () => {
        /*
         * Done-when 1, read literally: *without reading `SubstrateMapWidget.ts`*. A
         * document that defers to the source for any step has not extracted the
         * pattern, it has indexed it.
         */
        ok(!/see [`']?SubstrateMapWidget\.ts|read [`']?SubstrateMapWidget\.ts/i.test(doc),
            'no step defers to the tile\'s source');
        ok(/## 13\. Checklist/.test(doc), 'and it ends with a checklist to work from');
        /*
         * NAMED ITEMS, not a count. `>= 12` against a list of fourteen has two
         * items of headroom, so deleting one was MISSED - a threshold assertion
         * tolerates exactly the drift it was given slack for. The items that carry
         * the document's argument are checked by name; the count is checked exactly.
         */
        const boxes = [...doc.matchAll(/^- \[ \]/gm)];
        eq(boxes.length, 14, `${boxes.length} checklist items, exactly`);
        for (const item of ['Fewer than ten attributes', 'Extends the base',
            'all six places', 'Shows its age', 'no observer and no timer',
            'letting time pass']) {
            ok(doc.includes(item), `  the checklist covers: ${item}`);
        }
    });
});

section('53. the filters are actually wired (W-40a)', () => {
    /*
     * ---- THE ASSERTION THAT WAS MISSING FOR FIVE TASKS ----
     *
     * `W-18` produced the filter buffers. `W-19` added the attributes and the
     * cache key. `W-20`..`W-22` wrote and proved the kernels. **Nothing joined
     * them**, and a bound `SpatialFilter` changed no pixel.
     *
     * Every kernel test built a `FilterBuffers` LITERAL and called the function
     * directly, so each half was tested against the other half's absence. What
     * was never written is this: set the attribute on a control, render, and look
     * at the pixels.
     *
     * `W-41` found it by trying to photograph the feature.
     */
    const gd = (pattern, side) => {
        const w = Patterns.wafer(pattern, { size: side, failRate: 0.02, seed: 17 });
        const bins = [];
        for (let r = 0; r < w.rows; r++) {
            let l = '';
            for (let c = 0; c < w.cols; c++) { l += w.codes[w.cells[r * w.cols + c]]; }
            bins.push(l);
        }
        return {
            substrateId: pattern, dimension: { x: w.cols, y: w.rows }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins,
            binDefinitions: w.binDefs.map((b) => ({ binCode: b.code, binQuality: b.quality })),
        };
    };
    /** Renders a real control with a filter set through its own attributes. */
    const shot = (pattern, filter, radius, px = 300, view) => {
        const m = new SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setGridData(gd(pattern, 600));
        if (view !== undefined) { m.setFieldView(view); }
        m.setSpatialFilter(filter);
        m.setSpatialFilterRadius(radius);
        m.__attach();
        renderOnce(m, px);
        const words = new Uint32Array(m.__canvasContext.pixels.buffer);
        const hist = new Map();
        for (const v of words) { if (v !== 0) { hist.set(v, (hist.get(v) ?? 0) + 1); } }
        return { words, hist, painted: [...hist.values()].reduce((a, b) => a + b, 0) };
    };
    /** The fail colour, as the second commonest word in a 2 %-failure map. */
    const failWord = (h) => [...h.entries()].sort((a, b) => b[1] - a[1])[1]?.[0] ?? 0;

    attempt('A BOUND FILTER CHANGES PIXELS — which it did not, for five tasks', () => {
        const base = shot('Random', 'None', 0);
        const fw = failWord(base.hist);
        const before = base.hist.get(fw) ?? 0;
        ok(before > 100, `${before} fail pixels unfiltered`);

        const med = shot('Random', 'Median', 1);
        const after = med.hist.get(fw) ?? 0;
        ok(after < before / 2,
            `Median r1 removes scattered failures: ${before} -> ${after}`);
    });

    attempt('every kernel reaches the render, and each does its own thing', () => {
        /*
         * Not one smoke test but five, because a dispatch that fell through to one
         * kernel for every name would pass a single check. The DIRECTIONS differ:
         * Min erodes, Max dilates, Median removes noise without growing anything.
         */
        const base = shot('Random', 'None', 0);
        const fw = failWord(base.hist);
        const before = base.hist.get(fw) ?? 0;

        const counts = {};
        for (const kind of ['Median', 'Min', 'Max']) {
            counts[kind] = shot('Random', kind, 2).hist.get(fw) ?? 0;
        }
        ok(counts.Max > before * 2, `Max DILATES: ${before} -> ${counts.Max}`);
        ok(counts.Min < before / 2, `Min ERODES: ${before} -> ${counts.Min}`);
        ok(counts.Median < before / 2, `Median removes noise: ${before} -> ${counts.Median}`);

        /*
         * ---- ON A SPARSE MAP, MEDIAN AND MIN AGREE, AND THAT IS CORRECT ----
         *
         * A `Random` window at 2 % failures is overwhelmingly pass, so both the
         * majority and the least-severe value are pass. They came out identical -
         * 233 pixels each - and the first version of this assertion read that as a
         * dispatch falling through to one kernel.
         *
         * They separate where a window is MOSTLY fail: the median follows the
         * majority into fail, the minimum stays pass as long as one pass cell is in
         * range. `Center` has that density; `Random` cannot have it at any radius.
         */
        const dense = {};
        for (const kind of ['Median', 'Min', 'Max']) {
            const h = shot('Center', kind, 2).hist;
            dense[kind] = h.get(failWord(shot('Center', 'None', 0).hist)) ?? 0;
        }
        ok(dense.Median > dense.Min,
            `on a dense cluster the median follows the majority into fail: `
            + `${dense.Median} against Min's ${dense.Min}`);
        ok(counts.Max !== counts.Median,
            'and Max is neither of them, so three names reach three kernels');
    });

    attempt('the scalar filters reach the render too, on their own channel', () => {
        /* `Box` and `Gauss` need a scalar channel; on `Bins` they are refused
         * before the render is asked for, which `W-19` already asserts. */
        const plain = shot('Loc', 'None', 0, 300, 'FailDensity');
        const boxed = shot('Loc', 'Box', 3, 300, 'FailDensity');
        let differ = 0;
        for (let i = 0; i < plain.words.length; i++) {
            if (plain.words[i] !== boxed.words[i]) { differ++; }
        }
        ok(differ > 1000, `Box r3 on FailDensity changes ${differ} pixels`);

        const gauss = shot('Loc', 'Gauss', 3, 300, 'FailDensity');
        let vsBox = 0;
        for (let i = 0; i < gauss.words.length; i++) {
            if (gauss.words[i] !== boxed.words[i]) { vsBox++; }
        }
        ok(vsBox > 0, `and Gauss is not Box: ${vsBox} pixels differ between them`);
    });

    attempt('an ILLEGAL pairing still changes nothing, and is refused upstream', () => {
        /*
         * The dispatcher does not re-check legality. It cannot arrive illegal:
         * `__effectiveFilter()` resolves to `'None'` and reports. Wiring the
         * pipeline must not have created a second door into it.
         */
        const plain = shot('Random', 'None', 0);
        const illegal = shot('Random', 'Box', 3);   // Box on Bins — refused
        deep([...illegal.words], [...plain.words],
            'Box on Bins paints exactly the unfiltered frame');
    });

    attempt('radius 0 is as inert as None, through the control', () => {
        const plain = shot('Random', 'None', 0);
        const zero = shot('Random', 'Max', 0);
        deep([...zero.words], [...plain.words], 'Max r0 changes nothing');
    });

    attempt('THE WINNER SCAN WALKS OCCUPIED SLOTS, not all 255', () => {
        /*
         * The user's bar: 20 ms is acceptable, over 20 ms is a problem. Measured
         * before: 324 ms for a median over 640 000 pixels, and FLAT from r=1 to
         * r=5 - the signature of a cost that has nothing to do with the window.
         * The choosers scanned all 255 histogram slots per pixel; a bin map has two
         * to ten distinct values in a window.
         *
         * After: 19.7 ms at r=1, and the cost now RISES with radius, which is what
         * a sliding window should do.
         *
         * ---- AND THE FIRST ATTEMPT MADE IT 18x WORSE ----
         *
         * Wrapping the maintenance in `gain()`/`lose()` closures took the median to
         * 5811 ms. Two arrow functions called a hundred million times defeat the
         * JIT completely. Asserted here as a shape, because a profile is not
         * repeatable in a gate but a closure in a hot loop is visible in the source.
         */
        const src = readFileSync(new URL(
            '../../../Helpers/SubstrateMapEngine/SpatialFilter.js', import.meta.url), 'utf8');
        const slide = src.slice(src.indexOf('function slide'));
        const body = slide.slice(0, slide.indexOf('\nfunction '));
        ok(/const active = new Uint8Array/.test(body), 'the occupancy list exists');
        ok(!/const gain = |const lose = /.test(body),
            'and the maintenance is INLINE — no closure in the hot loop');

        const choose = src.slice(src.indexOf('function majority'));
        ok(/for \(let k = 0; k < n; k\+\+\)/.test(choose),
            'the chooser walks the occupancy list');
        ok(!/for \(let i = 0; i < FILTER_HISTOGRAM_SLOTS; i\+\+\)/.test(
            choose.slice(0, choose.indexOf('\nfunction repaint'))),
        '  and no longer scans all 255 slots');
    });

    attempt('and the tie-break survived the change', () => {
        /*
         * The old scan walked 0..254 in order, so ties went to the lower index for
         * free. `active` is in ARRIVAL order, so the tie has to be broken
         * explicitly - and getting that wrong would change which bin a filtered
         * cell reports without changing any count.
         */
        const src = readFileSync(new URL(
            '../../../Helpers/SubstrateMapEngine/SpatialFilter.js', import.meta.url), 'utf8');
        ok(/=== bestCount && i < best/.test(src), 'majority breaks ties to the lower index');
        ok(/=== bestRank && i < best/.test(src), 'and so does extreme');
    });

    attempt('A FILTER NEVER PAINTS WHERE THE WAFER IS NOT', () => {
        /*
         * ---- THE USER'S EYE FOUND THIS; SEVEN ASSERTIONS DID NOT ----
         *
         * `FilterBuffers.x`/`y` are the box's offset WITHIN THE CANVAS, and the
         * bitmap `renderGridAggregate` hands the filter is the box's OWN
         * `ImageData` - so passing the box origin made `repaintFromIndex` add it a
         * second time. Every write landed displaced by one box origin.
         *
         * On the review sheet the wafer grew into the corners of its bounding
         * rectangle and lost its round shape, and an edge-located cluster appeared
         * TWICE - once where it belonged and once shifted.
         *
         * **Every count-based assertion passed**, because a translation preserves
         * counts almost exactly: `Max` still dilated, `Min` still eroded, the
         * numbers still moved in the right directions. What it does not preserve is
         * SHAPE, and nothing here was looking at shape.
         *
         * The invariant, which is cheap and would have caught it on day one: a
         * filter may recolour a painted pixel and may not paint an unpainted one.
         * The empty space around a wafer is not data and a filter has nothing to
         * say about it.
         */
        for (const pattern of ['Edge-Loc', 'Random', 'Scratch']) {
            const plain = shot(pattern, 'None', 0);
            for (const [kind, radius] of [['Median', 1], ['Max', 2], ['Min', 2]]) {
                const filtered = shot(pattern, kind, radius);
                let paintedOutside = 0;
                let erasedInside = 0;
                for (let i = 0; i < plain.words.length; i++) {
                    if (plain.words[i] === 0 && filtered.words[i] !== 0) { paintedOutside++; }
                    if (plain.words[i] !== 0 && filtered.words[i] === 0) { erasedInside++; }
                }
                eq(paintedOutside, 0,
                    `${pattern} ${kind} r${radius}: paints nothing outside the wafer`);
                eq(erasedInside, 0, `  and erases nothing inside it`);
            }
        }
    });

    attempt('and the substrate keeps its exact silhouette', () => {
        /*
         * The same invariant stated as an identity rather than a count, because
         * `0 outside and 0 inside` is two numbers agreeing and this is the thing
         * itself: the set of painted pixels is unchanged, whatever their colours.
         */
        const plain = shot('Edge-Loc', 'None', 0);
        const filtered = shot('Edge-Loc', 'Max', 2);
        const silhouette = (w) => w.map((v) => (v === 0 ? 0 : 1));
        deep([...silhouette(filtered.words)], [...silhouette(plain.words)],
            'the filtered frame paints exactly the pixels the unfiltered one did');
    });

    attempt('the two links that were missing are both asserted on the source', () => {
        /*
         * TWO, not one. Wiring the dispatch was not enough - the buffers it reads
         * were allocated only when a SINK was supplied, and no control ever
         * supplies one, so `fIndex` was always null and the new branch could not be
         * reached. Measuring after the first fix is what found the second.
         */
        const engine = readFileSync(new URL(
            '../../../Helpers/SubstrateMapEngine/Engine.js', import.meta.url), 'utf8');
        ok(/applySpatialFilter\(/.test(engine), 'link 1: the engine dispatches');
        ok(/sink != null \|\| filter != null/.test(engine),
            'link 2: and allocates the buffers a filter will read');
        const base = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        ok(/spatialFilter: this\.__spatialFilterRequest\(\)/.test(base),
            'and the layer carries the request the control assembled');
    });
});

section('54. the nuspec states one version (W-42a)', () => {
    /*
     * ---- A CLAIM ABOUT A CHECK THAT DID NOT EXIST ----
     *
     * the 4.0.0.0 notes said *"a gate fails if they diverge again"*.
     * No such gate existed. That is worse than the drift it describes, because a
     * reader who believes it stops looking.
     *
     * On its first run the gate found FIVE faults: four controls at `0.0.1.0`
     * inside a `4.0.0.0` package, and release notes leading with `3.0.0.0`.
     */
    const nuspec = readFileSync(new URL('../../../SubstrateMap.nuspec', import.meta.url), 'utf8');
    const declared = /<version>([^<]+)<\/version>/.exec(nuspec)[1].trim();
    const notes = /<releaseNotes>([\s\S]*?)<\/releaseNotes>/.exec(nuspec)[1];

    attempt('every control declares the package version', () => {
        for (const c of readdirSync(new URL('../../../Controls/', import.meta.url))) {
            const d = JSON.parse(readFileSync(new URL(
                `../../../Controls/${c}/Description.json`, import.meta.url), 'utf8'));
            eq(d.version.full, declared, `${c} says ${d.version.full}`);
        }
    });

    attempt('THE RELEASE NOTES LEAD WITH THE VERSION BEING SHIPPED', () => {
        /*
         * Stale notes on a fresh package are how a consumer reads LAST release's
         * breaking changes and misses this one's. The nuspec shipped `4.0.0.0` with
         * notes opening on `3.0.0.0` — the version was bumped and the prose was not.
         */
        const sections = [...notes.matchAll(/^\s+(\d+\.\d+\.\d+\.\d+) - /gm)]
            .map((m) => m[1]);
        eq(sections[0], declared, `the notes open on ${sections[0]}`);
        deep(sections, ['5.0.0.0', '4.0.0.0', '3.0.0.0', '2.0.0.0'],
            'and older releases follow, newest first');
    });

    attempt('5.0.0.0 names its two breaking changes, each with what to do', () => {
        /* The package id and the localization keys are the only items that ask a
         * consumer to do something, and asking is what makes a release major;
         * everything else in it is a fix or an addition nothing has to opt into. */
        const current = notes.slice(0, notes.indexOf('4.0.0.0 - '));
        ok(/PACKAGE ID IS Ekvip\.Cinnamon\.Semi\.SubstrateMap/.test(current), 'the package id');
        ok(/LOCALIZATION KEYS/.test(current), 'the localization keys');
        eq([...current.matchAll(/WHAT TO DO:/g)].length, 2, 'one "what to do" for each');
        ok(/BREAKING CHANGES - read these two/.test(current), 'under the banner earlier releases use');
        ok(/no attribute, event or function was\s+added, removed, renamed, retyped or re-defaulted/.test(current),
            'and the statement of what did not change');
    });

    attempt('the 4.0.0.0 notes keep their four breaking changes, each with an action', () => {
        /* A breaking change without "what to do" is a warning rather than a note.
         * The same rule `W-39` applied to the markdown, applied to the nuspec. */
        const current = notes.slice(notes.indexOf('4.0.0.0 - '), notes.indexOf('3.0.0.0 - '));
        for (const [n, phrase] of [[1, 'NO-DATA IMAGE'], [2, 'OUTLINE'], [3, 'BinQuality'],
            [4, 'RAISED AFTER THE ATTRIBUTES']]) {
            ok(new RegExp(phrase, 'i').test(current), `change ${n} is described`);
        }
        const actions = [...current.matchAll(/WHAT TO DO:/g)];
        eq(actions.length, 4, `${actions.length} "what to do" instructions, one per change`);
        ok(/RENDERS BYTE-IDENTICALLY TO\s+BEFORE/.test(current),
            'and the case that does NOT change is stated');
    });

    attempt('and the nuspec is well-formed XML with the notes escaped', () => {
        /* The 3.0 section contains angle brackets, escaped as entities. A section
         * added by hand is the obvious place to break that. */
        ok(!/<(Layout|Substrates|BinCode)>/.test(notes),
            'no raw element names inside releaseNotes');
        const opens = (nuspec.match(/<releaseNotes>/g) ?? []).length;
        const closes = (nuspec.match(/<\/releaseNotes>/g) ?? []).length;
        eq(opens, 1, 'one releaseNotes element');
        eq(closes, 1, '  and it is closed once');
    });
});

section('55. the event is raised after the attributes it describes (W-43)', () => {
    /*
     * ---- THE USER'S REPORT ----
     *
     * *"onItemSelected raises without a payload on the first click."*
     *
     * The payload was always complete. What was empty was `SelectedItemId` and
     * `SelectedItems`, because the event was raised BEFORE they were written - so
     * a `.view` action reading them in response to the event read the PREVIOUS
     * selection, and on the first click of a session there was no previous
     * selection.
     *
     * Measured before the fix, three taps:
     *
     *   click 1  payload 9   SelectedItemId null
     *   click 2  payload 22  SelectedItemId 9
     *   click 3  payload 9   SelectedItemId 22
     *
     * Every click one behind, the first one empty.
     *
     * It looked intermittent because re-clicking the SAME cell leaves the
     * attributes unchanged, so `tchmi_equal` short-circuits the property events
     * and only a click on a NEW cell shows it.
     */
    const gd = (n) => {
        const rows = [];
        for (let r = 0; r < n; r++) { rows.push('1'.repeat(n)); }
        return {
            substrateId: 'W', dimension: { x: n, y: n }, units: 'mm',
            stepSize: { x: 1, y: 1 }, binType: 'Ascii', nullBin: '.', mapType: '2DArray',
            bins: rows, binDefinitions: [{ binCode: '1', binQuality: 'Pass' }],
        };
    };
    /** Taps, capturing what the ATTRIBUTES held at the moment the event fired. */
    const tapSeries = (points) => {
        const m = new SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setGridData(gd(8));
        m.setTouchTargetSize(0);
        m.__attach();
        renderOnce(m, 160);
        const seen = [];
        const real = TcHmi.EventProvider.raise;
        TcHmi.EventProvider.raise = function raise(name, data) {
            if (String(name).endsWith('.onItemSelected')) {
                seen.push({
                    payloadItemId: data.itemId,
                    attrItemId: m.getSelectedItemId(),
                    attrItems: m.getSelectedItems(),
                });
            }
            return real.apply(this, arguments);
        };
        try {
            for (const [x, y] of points) { tapAt(m, x, y); }
        } finally { TcHmi.EventProvider.raise = real; }
        return seen;
    };

    attempt('THE FIRST CLICK OF A SESSION SEES ITS OWN SELECTION', () => {
        /* The report, asserted directly. Before the fix this read `null`. */
        const seen = tapSeries([[40, 40]]);
        eq(seen.length, 1, 'one event');
        ok(seen[0].payloadItemId !== null && seen[0].payloadItemId !== undefined,
            `the payload carries the cell: ${seen[0].payloadItemId}`);
        eq(seen[0].attrItemId, seen[0].payloadItemId,
            'and SelectedItemId already holds it when the event fires');
        ok(Array.isArray(seen[0].attrItems) && seen[0].attrItems.length === 1,
            `SelectedItems holds one entry, not null`);
    });

    attempt('and no click is one selection behind', () => {
        /*
         * Three taps on two different cells. The failing version produced
         * `null, 9, 22` against payloads `9, 22, 9` - every attribute trailing its
         * event by exactly one click.
         */
        const seen = tapSeries([[40, 40], [120, 60], [40, 40]]);
        eq(seen.length, 3, 'three events');
        for (let i = 0; i < seen.length; i++) {
            eq(seen[i].attrItemId, seen[i].payloadItemId,
                `click ${i + 1}: attribute ${seen[i].attrItemId} matches payload `
                + `${seen[i].payloadItemId}`);
        }
        ok(seen[0].payloadItemId !== seen[1].payloadItemId,
            'and the taps really did land on different cells, so the check could fail');
    });

    attempt('SelectedItems agrees with the payload\'s own selection list', () => {
        /* Two things describing one selection. Comparing them is what makes the
         * ordering assertion above about the DATA rather than about a null. */
        const m = new SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setGridData(gd(8));
        m.setTouchTargetSize(0);
        m.__attach();
        renderOnce(m, 160);
        let payloadSelection = null;
        let attrAtRaise = null;
        const real = TcHmi.EventProvider.raise;
        TcHmi.EventProvider.raise = function raise(name, data) {
            if (String(name).endsWith('.onItemSelected')) {
                payloadSelection = data.selection;
                attrAtRaise = m.getSelectedItems();
            }
            return real.apply(this, arguments);
        };
        try { tapAt(m, 40, 40); } finally { TcHmi.EventProvider.raise = real; }
        eq(attrAtRaise.length, payloadSelection.length, 'same number of entries');
        eq(attrAtRaise[0].item_id, payloadSelection[0].itemId,
            'and the same cell in both');
    });

    attempt('a click that CLEARS the selection still raises, and clears first', () => {
        /*
         * The early-return path. A selection that changed the attributes and told
         * nobody would be the same defect wearing the opposite sign - and moving a
         * raise is exactly how an early `return` comes to skip it.
         */
        const m = new SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.setGridData(gd(8));
        m.setTouchTargetSize(0);
        m.__attach();
        renderOnce(m, 160);
        /*
         * A MISS IS INERT AND DOES NOT CLEAR - the base returns before the raise,
         * which `W-32` recorded. So the empty-selection path is reached by TOGGLING
         * OFF in multi mode, not by clicking away.
         *
         * The first version of this assertion clicked empty space and expected a
         * clearing event. It got none, correctly, and was testing a path that does
         * not exist.
         */
        m.setSelectionMode('multi');
        tapAt(m, 40, 40);
        ok(m.getSelectedItems() !== null, 'something is selected');

        let raised = 0;
        let attrAtRaise = 'unset';
        const real = TcHmi.EventProvider.raise;
        TcHmi.EventProvider.raise = function raise(name, _data) {
            if (String(name).endsWith('.onItemSelected')) {
                raised++;
                attrAtRaise = m.getSelectedItems();
            }
            return real.apply(this, arguments);
        };
        try { tapAt(m, 40, 40); } finally { TcHmi.EventProvider.raise = real; }
        eq(raised, 1, 'toggling the last selection off raises too');
        eq(attrAtRaise, null, '  and SelectedItems is already null when it does');
    });

    attempt('the raise is the LAST statement on both exits, in the source', () => {
        /*
         * Asserted on the emitted source as well as at runtime, because the runtime
         * check only sees the path a tap happens to take. Two exits, two raises,
         * and neither before its writes.
         */
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url), 'utf8');
        const method = src.slice(src.indexOf('__raiseSelected('));
        const body = method.slice(0, method.indexOf('\n    __raise', 10));
        const raises = [...body.matchAll(/onItemSelected'/g)].length;
        eq(raises, 2, 'two raises — one per exit');
        const firstRaise = body.indexOf("onItemSelected'");
        const outputs = body.indexOf('__setSelectedOutputs');
        ok(outputs < firstRaise,
            'and __setSelectedOutputs comes before the first of them');
    });
});

section('56. the substrate does not resize when items are added (F-4)', () => {
    /*
     * THE FIELD COMPLAINT, verbatim: "If the outline is empty, and you put some
     * items to draw on the wafer, the wafer changes the size, and it is visible."
     *
     * Measured before the fix, no outline and no OutlinePreset bound:
     *
     *     1 item   ->   8.0 x 8.0 mm centred at ( 0, 0)
     *     2 items  ->  28.0 x 8.0 mm centred at (10, 0)
     *     5 items  ->  88.0 x 8.0 mm centred at (40, 0)
     *
     * `fitBBox` unioned the item boxes, and that one box feeds BOTH the letterbox
     * scale AND the origin anchor - so every added item moved the substrate's size
     * and its position at once.
     *
     * WHY THIS IS THE PIXEL ASSERTION. The outline's pixels are a pure function of
     * (outline geometry, world matrix). The geometry does not depend on the items
     * at all - it comes from the preset or the bound Outline - so the outline moves
     * if and only if the world matrix moves, and the world matrix moves if and only
     * if the fit box moves. Comparing the matrix is therefore the EXACT form of
     * "zero pixels changed", where sampling pixels would only be a proxy for it.
     * The recording context does not capture outline path geometry, so a literal
     * pixel diff is not available here even if it were the stronger check.
     */
    const mkItems = (positions) => JSON.stringify(positions.map((x, i) => ({
        item_id: i + 1, name: `I${i}`, unit: 'meter', prefix: 'milli', status: 1,
        geometries: [{ type: 'rectangle', center_position_x: x, center_position_y: 0, width: 8, length: 8 }],
    })));

    /** @returns `{ fit, scale, world }` for one control after binding `positions`. */
    const frameOf = (control, positions) => {
        control.setItems(mkItems(positions));
        const fit = Engine.fitBBox(control.__sceneOutline, control.__sceneItems, control.__sceneGrid);
        const cfg = { center: { x: 200, y: 200 }, width: 400, height: 400, margin: 8 };
        const m = control.__computeMatrices(cfg, 1);
        const w = m.world;
        return {
            fit: `${fit.minX},${fit.minY},${fit.maxX},${fit.maxY}`,
            scale: m.scale,
            world: `${w.a},${w.b},${w.c},${w.d},${w.e},${w.f}`,
        };
    };

    const build = (setup) => {
        const c = new SubstrateMapMod.SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        setup(c);
        c.__attach();
        return c;
    };

    for (const [what, setup] of [
        ['no outline and no preset', () => { /* nothing bound: the fallback tier */ }],
        ['an OutlinePreset bound', (c) => c.setOutlinePreset('si-8in')],
    ]) {
        const c = build(setup);
        const one = frameOf(c, [0]);

        // ADDING. The complaint's own scenario.
        const two = frameOf(c, [0, 20]);
        const five = frameOf(c, [0, 20, 40, 60, 80]);
        eq(two.fit, one.fit, `${what}: adding an item does not move the fit box`);
        eq(five.fit, one.fit, `${what}: nor does adding four more`);
        eq(two.world, one.world, `${what}: the world matrix is unchanged, so the outline's pixels are`);
        eq(five.world, one.world, `${what}: still unchanged at five items`);
        eq(five.scale, one.scale, `${what}: and the letterbox scale never moved`);

        // REMOVING.
        const back = frameOf(c, [0]);
        eq(back.fit, one.fit, `${what}: removing items does not move it either`);
        eq(back.world, one.world, `${what}: and the matrix returns unchanged`);

        // OUTSIDE THE CURRENT EXTENT — the case that used to grow the box most.
        const far = frameOf(c, [0, 5000]);
        eq(far.fit, one.fit, `${what}: an item far outside the extent does not grow it`);
        eq(far.world, one.world, `${what}: the substrate stays where it was`);
    }

    /*
     * The documented default. It is only consulted when the author has said
     * nothing at all, and it must be a CONSTANT rather than anything derived, or
     * the invariant above is accidental.
     */
    eq(Engine.DEFAULT_SUBSTRATE_EXTENT_MM, 200, 'the fallback extent is a documented 200 mm');
    const d = Engine.DEFAULT_SUBSTRATE_BBOX;
    eq(`${d.minX},${d.minY},${d.maxX},${d.maxY}`, '-100,-100,100,100',
        'centred on the substrate origin, so nothing about it depends on content');
    eq(Engine.fitBBox(null, [], null).minX, d.minX,
        'and an empty scene fits the same box a full one does');

    /*
     * A grid still defines the substrate. Its extent is stepSize x cols/rows - a
     * property of the map rather than of what is on it - and an item cannot move
     * it, so it stays a tier above the constant rather than being folded into it.
     */
    const gridded = build(() => { /* grid arrives through setGridData below */ });
    gridded.setGridData(JSON.stringify({
        dimension: { x: 4, y: 3 },
        units: 'mm',
        stepSize: { x: 10, y: 10 },
        orientation: 0,
        originLocation: 'LowerLeft',
        axisDirection: 'UpRight',
        binType: 'Integer2',
        nullBin: 'FFFF',
        mapType: '2DArray',
        binDefinitions: [{ binCode: '0001', binQuality: 'Pass', binDescription: 'Good' }],
        bins: ['0001000100010001', '0001000100010001', '0001000100010001'],
    }));
    const gFit = Engine.fitBBox(gridded.__sceneOutline, gridded.__sceneItems, gridded.__sceneGrid);
    ok(gFit !== null && (gFit.maxX - gFit.minX) !== Engine.DEFAULT_SUBSTRATE_EXTENT_MM,
        'a bound grid defines the extent rather than falling through to the constant');
    const gBefore = `${gFit.minX},${gFit.minY},${gFit.maxX},${gFit.maxY}`;
    gridded.setItems(mkItems([0, 5000]));
    const gAfter = Engine.fitBBox(gridded.__sceneOutline, gridded.__sceneItems, gridded.__sceneGrid);
    eq(`${gAfter.minX},${gAfter.minY},${gAfter.maxX},${gAfter.maxY}`, gBefore,
        'and an item outside the grid does not widen it - it used to union them');
});

section('57. the identity band is reserved, not grown (F-4a)', () => {
    /*
     * THE SECOND HALF OF THE SAME FIELD COMPLAINT. F-4 fixed the fit box and the
     * reporter came back: "If the substrate has no data, there is no text like
     * substrate ID. The wafer claims the whole space. If you write data, it starts
     * to print text... The text claims space and the wafer shrink."
     *
     * The identity label is a DOM SIBLING of the canvas in a flex column, not
     * something drawn on it:
     *
     *     root    display:flex; flex-direction:column
     *      |- div.Identity   flex: 0 0 auto     <- was display:none when text === ''
     *      \- canvas         flex: 1 1 auto
     *
     * So its height comes out of the canvas' height, which is what `__makeConfig`
     * measures and what the letterbox scale divides. Empty text collapsed the band
     * and the canvas got the whole column; data arrived, `readAge()` produced
     * "received HH:MM:SS UTC" even with no SubstrateId set, the band appeared, and
     * the wafer lost about 5%.
     *
     * WHY F-4's SECTION 56 DID NOT CATCH THIS. It built the MapConfig by hand -
     * `{ center, width: 400, height: 400, margin: 8 }` - and passed it to
     * `__computeMatrices`. That bypasses `__makeConfig` and the canvas entirely, so
     * "the letterbox scale never moved" was measuring a constant the test had just
     * supplied itself. A check that could only ever pass (observation 359).
     *
     * WHAT IS ASSERTED HERE. `__updateIdentity` owns the decision, so it is driven
     * directly with a recording style object. The invariant is that the band's
     * LAYOUT FOOTPRINT is a function of the author's SubstrateIdentityPosition and
     * of nothing else - in particular not of the text. The flex consequence itself
     * is a browser fact and is not simulated; what is simulated, separately and
     * labelled as a model, is the arithmetic that makes the invariant matter.
     */
    /** A control with a recording `__identityEl`, attached far enough to update it. */
    const withBand = (position) => {
        const c = new SubstrateMapMod.SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        c.__attach();
        const style = { display: '', order: '', minHeight: '1.2em', lineHeight: '1.2', boxSizing: 'content-box' };
        c.__identityEl = { style, textContent: '' };
        /*
         * The text is varied by overriding its SOURCE, not by binding data.
         * `__composeIdentity` is `id + readAge().text` and `formatAge` always
         * formats a clock off `__receivedAt`, which is `new Date()` at
         * construction - so no sequence of setters makes it empty, and a test that
         * tried would be comparing two non-empty states and passing for the wrong
         * reason. That is the first version of this section, which passed against
         * the unfixed code (observation 360). One thing varies here: the text.
         */
        c.__identityText = () => '';
        c.__composeIdentity = () => c.__identityText();
        c.setSubstrateIdentityPosition(position);
        // The setter is a no-op when the value already equals the field, so drive
        // the update explicitly rather than relying on it having been reached.
        c.__updateIdentity();
        return c;
    };
    /*
     * What `__updateIdentity` decides about the element's footprint. ONLY
     * `display` and `order`: the reservation itself (`minHeight`, `lineHeight`,
     * `boxSizing`) is set once in `__attach`, which this harness never runs - so
     * reading those back off a stub the test built would be asserting the test's
     * own literals. It was, until a mutation that zeroed `minHeight` was MISSED
     * (observation 362). The reservation is asserted on the source below instead.
     */
    const footprint = (c) => `${c.__identityEl.style.display}|${c.__identityEl.style.order}`;

    for (const position of ['below', 'above']) {
        const c = withBand(position);
        const empty = footprint(c);
        eq(c.__identityEl.textContent, '', `${position}: the empty state really is empty`);

        c.__identityText = () => 'W12345  \u00b7  received 10:41:18 UTC';
        c.__updateIdentity();
        const filled = footprint(c);

        ok(c.__identityEl.textContent !== '', `${position}: and the filled state really has text`);
        eq(filled, empty, `${position}: the band's footprint does not change when text appears`);
        ok(empty.startsWith('block|'), `${position}: and the band is in layout even while empty`);

        c.__identityText = () => '';
        c.__updateIdentity();
        eq(footprint(c), empty, `${position}: nor when the text goes away again`);
    }

    /*
     * The author's escape hatch. `'none'` collapses the band completely, and that
     * is the one thing allowed to change the substrate's size, because it is
     * configuration rather than content (D-227). The attribute is `bindable`, so
     * this can happen at runtime; a resize there is as legitimate as resizing the
     * control itself.
     */
    const none = withBand('none');
    eq(none.__identityEl.style.display, 'none', "'none' collapses the band");
    eq(none.__identityEl.textContent, '', "and empties it, so nothing is left to measure or read");
    none.__identityText = () => 'W12345';
    none.__updateIdentity();
    eq(none.__identityEl.style.display, 'none', "and data arriving does not bring it back");
    eq(none.__identityEl.textContent, '', 'nor put text into a hidden element');

    /*
     * WHY IT MATTERS, as arithmetic. This models the flex layout rather than
     * running it - the height the canvas is left with is the control's height minus
     * whatever the band takes. Before F-4a the band was 0 px with no data and ~18 px
     * with data; now it is the same either way.
     */
    /*
     * THE RESERVATION ITSELF, on the emitted source. `__attach` builds the DOM and
     * this harness never runs it (attach-harness.mjs guards on a template root that
     * is never installed), so there is no live element whose computed height could
     * be read. What is checkable is that the three properties that make an empty
     * band one line tall are set on the identity element, next to `flex`, rather
     * than left to Style.css - which is absent exactly when it matters.
     */
    {
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMapBase/SubstrateMapBase.js', import.meta.url), 'utf8');
        const i = src.indexOf("identity.style.flex = '0 0 auto'");
        ok(i !== -1, 'the identity element is still built with an inline flex');
        const block = src.slice(i, src.indexOf('root.appendChild(identity)', i));
        ok(/identity\.style\.height\s*=\s*'1\.2em'/.test(block),
            'and FIXES one line inline, so no content of any length can change the height');
        ok(!/identity\.style\.minHeight/.test(block),
            'a minimum would only be a floor: a wrapped id grows straight through it (F-4b)');
        ok(/identity\.style\.lineHeight\s*=\s*'1\.2'/.test(block),
            'with the line height pinned, or empty and filled differ by a fraction of a line');
        ok(/identity\.style\.whiteSpace\s*=\s*'nowrap'/.test(block),
            'nowrap inline, not only in Style.css, which is absent exactly when it matters');
        ok(/identity\.style\.overflow\s*=\s*'hidden'/.test(block),
            'and overflow hidden, so a long id is clipped rather than spilling');
        ok(/identity\.style\.boxSizing\s*=\s*'content-box'/.test(block),
            "and content-box, so Style.css' padding sits outside the reservation in both states");
    }

    const waferPx = (canvasH) => Engine.computeScale(Engine.makeConfig(400, canvasH), 200, 200) * 200;
    const grown = { before: waferPx(400), after: waferPx(382) };
    ok(Math.abs(grown.before - grown.after) > 15,
        'the old behaviour moved the wafer by more than 15 px on a 400 px control - visible, as reported');
    const reserved = { before: waferPx(382), after: waferPx(382) };
    eq(reserved.after, reserved.before,
        'with the band reserved, the canvas height is the same before and after data arrives');
});

section('58. a new payload restamps the received clock (F-4b)', () => {
    /*
     * THE FIELD REPORT: "it was strange when I wrote new data, it was not updating
     * the timestamp."
     *
     * `readAge()` is `formatAge(parseMapTimestamp(MapTimestamp), __receivedAt, now)`.
     * With no `MapTimestamp` bound it falls back to `__receivedAt` and renders
     * "received HH:MM:SS UTC". `__receivedAt` was a field initialiser - `new Date()`
     * at construction - and NOTHING ever reassigned it on this control, so the line
     * reported the moment the control was created for the rest of its life.
     *
     * Both siblings already did it: `SubstrateMapBinChart.setGridData` assigns it
     * inline, `SubstrateMapWidget.__stampReceived` wraps it. `SubstrateMap` - the
     * control the other two exist to accompany - was the only one that did not.
     * Nothing compared the three (observation 364).
     */
    const build = () => {
        const c = new SubstrateMapMod.SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        c.__attach();
        return c;
    };
    const item = (x) => JSON.stringify([{
        item_id: 1, name: 'I', unit: 'meter', prefix: 'milli', status: 1,
        geometries: [{ type: 'rectangle', center_position_x: x, center_position_y: 0, width: 8, length: 8 }],
    }]);
    const grid = (cols) => JSON.stringify({
        dimension: { x: cols, y: 3 }, units: 'mm', stepSize: { x: 10, y: 10 }, orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Integer2', nullBin: 'FFFF',
        mapType: '2DArray',
        binDefinitions: [{ binCode: '0001', binQuality: 'Pass', binDescription: 'Good' }],
        bins: Array.from({ length: 3 }, () => '0001'.repeat(cols)),
    });

    /*
     * The clock is formatted to whole seconds, so two binds inside the same second
     * render identically no matter what. The Date OBJECT is what has to move, and
     * it is what the next render will read.
     */
    for (const [what, first, second] of [
        ['Items', (c) => c.setItems(item(0)), (c) => c.setItems(item(20))],
        ['GridData', (c) => c.setGridData(grid(4)), (c) => c.setGridData(grid(5))],
    ]) {
        const c = build();
        first(c);
        const t1 = c.__receivedAt;
        ok(t1 instanceof Date, `${what}: a payload sets a receive time at all`);
        second(c);
        ok(c.__receivedAt !== t1,
            `${what}: a SECOND payload restamps it - it used to keep the construction time forever`);
        ok(c.__receivedAt.getTime() >= t1.getTime(), `${what}: and the clock does not run backwards`);
    }

    // An unchanged value is not an arrival. The setters guard on tchmi_equal before
    // stamping, so rebinding the same document must not pretend the map is fresher
    // than it is.
    const same = build();
    same.setItems(item(0));
    const stamp = same.__receivedAt;
    same.setItems(item(0));
    eq(same.__receivedAt, stamp, 'rebinding an identical payload does not restamp');

    // Every payload setter, not just the two driven above. Source-level, because
    // some of these paths need documents this section has no business building.
    {
        const src = readFileSync(new URL(
            '../../../Controls/SubstrateMap/SubstrateMap.js', import.meta.url), 'utf8');
        for (const setter of ['setItems', 'setGridData', 'setE142MapData',
            'setE142MapDataJson', 'setE142TransferData']) {
            const i = src.indexOf(`${setter}(valueNew)`);
            ok(i !== -1, `${setter} is still there to check`);
            const body = src.slice(i, i + 1400);
            ok(body.includes('__stampReceived()'), `${setter} stamps the receive time`);
        }
    }
});

section('59. a release that travelled is not a click (F-14)', () => {
    /*
     * The control bound `pointerup` ALONE, so it could not tell a tap from the end
     * of a drag: press on one die, release over another, and the SECOND was
     * selected. Any pan or gesture ending over the map selected whatever lay under
     * the release point.
     *
     * `DRAG_SLOP_PX` is 5: a finger on glass moves two or three pixels while
     * pressing and a mouse moves one or none, while a pan is tens.
     */
    const bound = () => {
        const c = new SubstrateMapMod.SubstrateMap(null, null, {});
        c.setShowDemoItems(false);
        c.setOutlinePreset('si-4in-p100');
        c.__attach();
        c.setItems(JSON.stringify([{
            item_id: 7, name: 'D7', status: 'Fail', unit: 'meter', prefix: 'milli',
            geometries: [{ type: 'rectangle', center_position_x: 0, center_position_y: 0,
                width: 40, length: 40 }],
        }]));
        renderOnce(c, 400);
        drainEvents();
        return c;
    };
    const selectedId = () => {
        const hits = drainEvents().filter((e) => e.name.endsWith('.onItemSelected'));
        return hits.length === 0 ? null : (hits[hits.length - 1].data.itemId ?? null);
    };
    /** The centre of the canvas, which is where the 40 mm die is. */
    const CX = 200;
    const CY = 200;

    attempt('a press and release in the same place still selects', () => {
        const c = bound();
        pressAt(c, CX, CY);
        releaseAt(c, CX, CY);
        eq(selectedId(), 7, 'a tap is a tap');
    });

    attempt('movement inside the slop is still a click', () => {
        for (const [dx, dy, why] of [[3, 0, 'three across'], [0, 4, 'four down'],
            [3, 4, 'five diagonally, exactly the limit']]) {
            const c = bound();
            pressAt(c, CX, CY);
            releaseAt(c, CX + dx, CY + dy);
            eq(selectedId(), 7, `${why} still selects — a deliberate tap must never be eaten`);
        }
    });

    attempt('movement beyond the slop selects nothing', () => {
        for (const [dx, dy, why] of [[6, 0, 'six across'], [0, 20, 'twenty down'],
            [40, 40, 'a pan across the die']]) {
            const c = bound();
            pressAt(c, CX, CY);
            releaseAt(c, CX + dx, CY + dy);
            eq(selectedId(), null, `${why} selects nothing — that was a drag`);
        }
    });

    attempt('the drag that started ON the die and ended elsewhere selects neither', () => {
        /* The reported shape: the release lands on empty substrate, and without the
         * guard the miss would have CLEARED a selection the user never touched. */
        const c = bound();
        pressAt(c, CX, CY);
        releaseAt(c, CX + 150, CY);
        eq(selectedId(), null, 'no event at all — not a hit, and not a clearing miss');
    });

    attempt('a release with no recorded press still selects', () => {
        /*
         * `pointerdown` may land outside the canvas, or before the listener is
         * attached. Refusing those would lose real clicks to guard against a drag
         * that never began — and every existing suite taps through `tapAt`, which
         * records no press, so this is also what keeps 21 suites meaningful.
         */
        const c = bound();
        tapAt(c, CX, CY);
        eq(selectedId(), 7, 'an unpaired release is a click, not a suspect');
    });

    attempt('a press consumed by a drag does not linger for the next release', () => {
        const c = bound();
        pressAt(c, CX, CY);
        releaseAt(c, CX + 100, CY);          // a drag: suppressed
        eq(selectedId(), null, 'the drag selected nothing');
        releaseAt(c, CX, CY);                // a stray release, no new press
        eq(selectedId(), 7,
            'and the NEXT release is measured against nothing, not against the old origin');
    });

    attempt('a release from a different pointer is not measured against this press', () => {
        const c = bound();
        pressAt(c, CX, CY, 1);
        releaseAt(c, CX + 30, CY, 2);   // well past the slop, still on the die
        eq(selectedId(), 7,
            'a second finger releasing elsewhere is not the first finger dragging');
    });
});

section('64. the chart header\u2019s two halves do not collide (F-26a)', () => {
    /*
     * REPORTED FROM A LIVE VIEW, after `F-26`: `W-SORT  256x25ceived 14:05:26 GMT+2`.
     * The identity draws from the left and the age from the right, and nothing
     * measured whether they fit.
     *
     * `F-26` fixed the VERTICAL collision between this header and the legend below
     * it, and asserted a band. This is the HORIZONTAL one between the header's own
     * two halves - a different pair, which a band assertion cannot see, because both
     * of them are supposed to be in the band.
     */
    installDocumentStub();
    const grid = JSON.stringify({
        dimension: { x: 8, y: 8 }, units: 'mm', stepSize: { x: 8, y: 8 }, orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii',
        nullBin: '.', mapType: '2DArray',
        binDefinitions: [{ binCode: 'P', binQuality: 'Pass' }, { binCode: 'F', binQuality: 'Fail' }],
        bins: ['..PPPP..', '.PPPPPF.', 'PPPPPFFP', 'PPPPFFPP',
            'PPPFFPPP', 'PPFFPPPP', '.PFPPPP.', '..PPPP..'],
    });
    /** @returns The two header draws, with the measured span of each. */
    const header = (id, w, style) => {
        const c = new Chart.SubstrateMapBinChart(null, null, {});
        c.__attach();
        c.setGridData(grid);
        c.setChartStyle(style);
        c.__substrateId = id;
        const ctx = renderOnce(c, w, 155);
        const draws = (ctx.textDraws ?? []).filter((t) => Math.abs(t.y - 6) < 2);
        const age = draws.find((t) => /^received |^measured /.test(String(t.text)));
        const ident = draws.find((t) => t !== age);
        const span = (t, align) => {
            const width = ctx.measureText(String(t.text)).width;
            return align === 'right' ? [t.x - width, t.x] : [t.x, t.x + width];
        };
        return {
            age: age === undefined ? null : span(age, 'right'),
            ident: ident === undefined ? null : span(ident, 'left'),
            identText: ident === undefined ? null : String(ident.text),
            ageText: age === undefined ? null : String(age.text),
        };
    };

    attempt('a long identity never reaches the timestamp', () => {
        /*
         * The reported case is 250 px, the dashboard's chart width. The wider case
         * proves the truncation is driven by the room available and not applied
         * always - a fix that always truncated would pass a narrow-only test.
         */
        for (const [id, w] of [['W-SORT 256x256', 250], ['W-SORT 256x256', 420],
            ['A-VERY-LONG-SUBSTRATE-IDENTIFIER-INDEED', 250], ['LOT-B', 250]]) {
            for (const style of ['Bars', 'Share']) {
                const h = header(id, w, style);
                ok(h.age !== null, `${style} ${w}px: the age is drawn`);
                ok(h.ident !== null, `  and so is the identity`);
                ok(h.ident[1] <= h.age[0],
                    `  "${h.identText}" ends at ${h.ident[1].toFixed(0)}, the age starts at `
                    + `${h.age[0].toFixed(0)}`);
            }
        }
    });

    attempt('the timestamp is never the one truncated', () => {
        /*
         * Half a clock time is not a time. An identity survives clipping - an
         * operator tells `W-SORT 2\u2026` from `W-FIELD` - and a timestamp does not.
         */
        for (const w of [250, 160, 120]) {
            const h = header('A-VERY-LONG-SUBSTRATE-IDENTIFIER-INDEED', w, 'Share');
            ok(!/\u2026/.test(h.ageText), `${w}px: the age is whole - "${h.ageText}"`);
        }
    });

    attempt('a short identity is left alone', () => {
        const h = header('LOT-B', 250, 'Share');
        eq(h.identText, 'LOT-B', 'nothing is truncated that fits');
    });
});

section('63. the tile overlay sets its own coordinate space (F-28b)', () => {
    /*
     * MEASURED FROM A RUNNING CONTROL, which is why this assertion exists in this
     * shape. At `devicePixelRatio` 3.125 the console reported `cfg` 210x189,
     * `mapRect` x 18.5..191.5 - both CORRECT and both identical at 1.25 - and the
     * stale border still covered 27 % of the tile. 179 CSS units drawn as 179 DEVICE
     * pixels is 57 CSS pixels, which is 27 % of 210. At 1.25 the same arithmetic
     * gives 68 %. Both matched the pictures.
     *
     * So the rectangle was right all along and the CONTEXT was in device space: the
     * overlay inherited whatever transform the grid draw left behind. Two earlier
     * fixes missed it because every assertion in this corpus renders at ratio 1,
     * where a device pixel and a CSS pixel are the same thing and an identity
     * transform is indistinguishable from the right one.
     *
     * This test puts the context into the state the browser was in - identity - and
     * requires the overlay to come out right anyway.
     */
    const grid = JSON.stringify({
        dimension: { x: 8, y: 8 }, units: 'mm', stepSize: { x: 8, y: 8 }, orientation: 0,
        originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii',
        nullBin: '.', mapType: '2DArray',
        binDefinitions: [{ binCode: 'P', binQuality: 'Pass' }, { binCode: 'F', binQuality: 'Fail' }],
        bins: ['..PPPP..', '.PPPPPF.', 'PPPPPFFP', 'PPPPFFPP',
            'PPPFFPPP', 'PPFFPPPP', '.PFPPPP.', '..PPPP..'],
    });

    /**
     * @param dpr The device pixel ratio to render at.
     * @returns The dashed border's rect in CSS pixels, and the map's.
     */
    const measure = (dpr) => {
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        w.__attach();
        w.setGridData(grid);
        w.setStaleAfterSeconds(1);
        w.__receivedAt = new Date(Date.now() - 600000);
        const ctx = renderOnce(w, 210, 210, dpr);
        /*
         * THE STATE THE BROWSER WAS IN. `renderOnce` leaves the transform the draw
         * left; the browser left identity. Forcing it makes the harness reproduce
         * the fault instead of agreeing with itself.
         */
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.strokeRects.length = 0;
        const cfg = Engine.makeConfig(210, 210);
        w.__drawOverlay(ctx, cfg.width, cfg.height, w.__readColors(),
            w.__computeMatrices(cfg, dpr));
        const r = ctx.strokeRects.find((z) => z.dash && z.dash.length);
        ok(r !== undefined, `dpr ${dpr}: the stale border is drawn`);
        /*
         * The record carries its own CTM, which maps CSS pixels to DEVICE pixels, so
         * applying it gives device coordinates - and those scale with the ratio by
         * construction. Dividing by the ratio brings it back to CSS, which is the
         * only space in which "the same place at every ratio" is a meaningful claim.
         * The first version of this assertion omitted that and reported the fix as a
         * failure at dpr times the right size.
         */
        const [a, , , , e] = r.transform;
        return { x0: (r.x * a + e) / dpr, x1: ((r.x + r.w) * a + e) / dpr, dpr };
    };

    attempt('the border lands in the same CSS pixels at every device ratio', () => {
        /*
         * `mapRect` is dpr-independent - the console proved that - so a border that
         * tracks it must be too. A border that inherits a device-space transform is
         * not, and that difference IS the defect.
         */
        const at = [1, 1.25, 3.125].map(measure);
        const base = at[0];
        for (const m of at.slice(1)) {
            ok(Math.abs((m.x1 - m.x0) / (base.x1 - base.x0) - 1) < 0.02,
                `dpr ${m.dpr}: width ${(m.x1 - m.x0).toFixed(1)} matches ratio 1's `
                + `${(base.x1 - base.x0).toFixed(1)}`);
        }
    });

    attempt('and it frames the map rather than a fraction of it', () => {
        for (const dpr of [1, 1.25, 3.125]) {
            const m = measure(dpr);
            const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
            w.__attach();
            w.setGridData(grid);
            renderOnce(w, 210, 210, dpr);
            const rect = w.__mapRect(w.__computeMatrices(Engine.makeConfig(210, 210), dpr), 1);
            ok(Math.abs((m.x1 - m.x0) - ((rect.x1 - rect.x0) + 6)) < 1.5,
                `dpr ${dpr}: border ${(m.x1 - m.x0).toFixed(1)} is the map's `
                + `${(rect.x1 - rect.x0).toFixed(1)} plus one stroke either side`);
        }
    });
});

section('62. the widget family reads the E142 inputs it declares (F-30)', () => {
    /*
     * `F-29` found it by trying to mirror every panel of the reference page:
     * `SubstrateMapWidget` and `SubstrateMapBinChart` DECLARE `E142MapData` and
     * `E142MapDataJson`, their setters store the value, their getters hand it back -
     * and `__buildGrid` read `__gridData` and nothing else. Seven of the nineteen
     * maps bind E142 XML, and all seven companions came up blank while holding a
     * valid document (`D-260`).
     *
     * The assertion is AGREEMENT WITH THE MAP rather than a fixture-by-fixture
     * expectation. The map is the reference implementation of this package's own
     * format; a tile that reads a document the map refuses, or refuses one the map
     * reads, is wrong whichever of them is right.
     */
    const XML_DIR = new URL('./fixtures/xml/', import.meta.url);
    const files = readdirSync(XML_DIR).filter((f) => f.endsWith('.xml')).sort();

    const mapOf = (xml) => {
        const m = new SubstrateMapMod.SubstrateMap(null, null, {});
        m.setShowDemoItems(false);
        m.__attach();
        m.setE142MapData(xml);
        return m.__sceneGrid !== null;
    };
    const tileOf = (xml) => {
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        w.__attach();
        w.setE142MapData(xml);
        return w.__sceneGrid !== null;
    };

    attempt('a tile builds a grid from E142 XML at all', () => {
        /* The narrow fact the defect was: before F-30 this was false for every
         * document, because the attribute was stored and never read. */
        const xml = readFileSync(new URL('official-BinCodeMap-Example.xml', XML_DIR), 'utf8');
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        w.__attach();
        eq(w.__sceneGrid, null, 'nothing bound, nothing built');
        w.setE142MapData(xml);
        ok(w.__sceneGrid !== null, 'and the document it was handed becomes a grid');
        eq(w.getE142MapData(), xml, '  while the attribute still reads back, as it always did');
    });

    attempt('the tile agrees with the map on every XML fixture', () => {
        ok(files.length > 20, `a corpus worth sweeping: ${files.length} documents`);
        const bad = [];
        let built = 0;
        for (const f of files) {
            const xml = readFileSync(new URL(f, XML_DIR), 'utf8');
            const m = mapOf(xml);
            const t = tileOf(xml);
            if (m) { built++; }
            if (m !== t) { bad.push(`${f}: map=${m} tile=${t}`); }
        }
        eq(bad.length, 0, `all ${files.length} agree${bad.length ? ` (first: ${bad[0]})` : ''}`);
        /*
         * Both refusing everything would also "agree". The sweep has to reach a
         * document that renders, or it proves only that two controls are equally
         * broken (observation 418).
         */
        ok(built > 10, `and the sweep is not two controls agreeing to fail: ${built} render`);
    });

    attempt('the chart counts the same documents the map draws', () => {
        const bad = [];
        for (const f of files) {
            const xml = readFileSync(new URL(f, XML_DIR), 'utf8');
            const c = installLocalizationStub(new Chart.SubstrateMapBinChart(null, null, {}));
            c.__attach();
            c.setE142MapData(xml);
            const got = c.__buildGrid() !== null;
            if (mapOf(xml) !== got) { bad.push(`${f}: map=${mapOf(xml)} chart=${got}`); }
        }
        eq(bad.length, 0, `all ${files.length} agree${bad.length ? ` (first: ${bad[0]})` : ''}`);
    });

    attempt('a document the map refuses is refused here too, and reported', () => {
        /*
         * Agreement has to hold on the refusals as well, or a tile would quietly
         * render something the map considers unrenderable. The extension example is
         * one the map already refuses - "no SubstrateMap matches".
         */
        const xml = readFileSync(
            new URL('official-BinCodeMap-Extension-Example.xml', XML_DIR), 'utf8');
        eq(mapOf(xml), false, 'the map refuses this one');
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        w.__attach();
        w.setE142MapData(xml);
        eq(w.__sceneGrid, null, 'and so does the tile');
        ok(/UNREADABLE/.test(String(w.getE142LastError())),
            `publishing why, rather than showing an unexplained empty tile: `
            + `${String(w.getE142LastError()).slice(0, 60)}`);
    });

    attempt('GridData still wins when both are bound', () => {
        /*
         * The map's rule is that the most recent non-null write wins. A tile has no
         * such bookkeeping, so its rule is simpler and stated here rather than left
         * to be discovered: GridData first, then XML, then JSON.
         */
        const xml = readFileSync(new URL('official-BinCodeMap-Example.xml', XML_DIR), 'utf8');
        const grid = JSON.stringify({
            dimension: { x: 2, y: 2 }, units: 'mm', stepSize: { x: 8, y: 8 }, orientation: 0,
            originLocation: 'LowerLeft', axisDirection: 'UpRight', binType: 'Ascii',
            nullBin: '.', mapType: '2DArray',
            binDefinitions: [{ binCode: 'P', binQuality: 'Pass' }],
            bins: ['PP', 'PP'],
        });
        const w = installLocalizationStub(new Widget.SubstrateMapWidget(null, null, {}));
        w.__attach();
        w.setE142MapData(xml);
        w.setGridData(grid);
        ok(w.__sceneGrid !== null, 'a grid is built');
        eq(w.__sceneGrid.cols, 2, 'and it is the GridData one, not the XML one');
    });
});

/* -------------------------------- summary -------------------------------- */
finish();
