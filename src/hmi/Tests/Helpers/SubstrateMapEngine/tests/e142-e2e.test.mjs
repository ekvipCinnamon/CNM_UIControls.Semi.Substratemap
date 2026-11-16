/*
 * Copyright 2026 ekvip automation GmbH
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview
 * TASK O8 item 1+2+5 - end-to-end acceptance harness (node, no DOM).
 *
 * For every VALID fixture of the F2' corpus (Spec v3.2 section 6.1, vendored under
 * ./fixtures) this test runs the EXACT DOM-free chain the SubstrateMap control
 * executes on ingest -
 *
 *   XML : parseE142Xml -> overlay resolve -> resolveLayoutSpecifier
 *         -> computeGridPlacement -> buildGridModel
 *   JSON: normalizeGridData -> computeGridPlacement -> buildGridModel
 *
 * - and asserts, AGAINST THE EXPECTATION CARDS (fixtures/EXPECTATIONS.md), the
 * five acceptance quantities O8 names: grid dimensions, the S-frame corner of the
 * probe cells, the non-null count, the per-bin histogram and the selected default
 * overlay. INVALID fixtures are asserted to fail with their documented error class.
 * The two OFFICIAL SEMI example files are part of the run (item 5). A performance
 * section (item 2) times the 600x600 XML and JSON fixtures end-to-end plus a
 * generated 1000x750 Ascii payload through normalize + buildGridModel and enforces
 * the decoder's 300 ms gate.
 *
 * WHY A HAND-ROLLED XML STUB. parseE142Xml defaults to the platform DOMParser,
 * which node lacks; the parser exposes an injection seam (E142XmlParseOptions
 * .parseDocument) for exactly this. This file provides that seam as a dependency-
 * free, namespace-aware document parser (package.json is read-only per the task
 * invariants, so no npm XML parser may be added). It meets the E142XmlElement
 * contract of domParseDocument verbatim: localName (prefix stripped), namespaceUri
 * (URI or ''), children (element children, document order), text (textContent),
 * attribute(localName, namespaceUri?) with getAttributeNS semantics (unprefixed
 * attributes are in NO namespace; a default xmlns binds ELEMENTS only). It THROWS
 * on ill-formed / truncated input, which is what lets the truncated fixture surface
 * as E142_XML_MALFORMED rather than a silently shortened map.
 *
 * WHY DYNAMIC IMPORT. Every engine module except E142Bins ends with a classic-name
 * global bridge that touches the bare `TcHmi` global at evaluation time. A minimal
 * shim is installed on globalThis BEFORE the modules evaluate; static imports are
 * hoisted above statements, so the modules are pulled in via `await import(...)`
 * after the shim exists. This is the documented node-consumption path (see the
 * bridge notes in E142Bins.ts / E142Grid.ts / E142Xml.ts).
 *
 * HOW THE ORACLE STAYS INDEPENDENT. The cards were hand-derived by a separate read
 * path; this harness re-encodes their numbers and re-derives geometry a second way
 * (norms + atan2 on the produced step basis, not a re-run of computeGridPlacement).
 * Where a card's hand arithmetic is demonstrably wrong against the fixture's own
 * bytes, the CORRECTED value is asserted and the divergence is called out in the
 * run log and OPEN-ISSUES.md (this is the point of an independent acceptance pass).
 * Probe cells are located by their LOGICAL coordinate through mapCoordToIndex - the
 * card's serialized-row annotations are advisory only (card #4 mis-annotates them).
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { onCrash } from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const XML_DIR = join(HERE, 'fixtures', 'xml');
const JSON_DIR = join(HERE, 'fixtures', 'json');

/* ------------------------------------------------------------------------ *
 * Global bridge shim, then the engine modules (dynamic import, see header). *
 * ------------------------------------------------------------------------ */
globalThis.TcHmi ??= { Controls: {} };
const ENGINE_DIR = join(HERE, '..');
const asUrl = (p) => 'file://' + p;
const E142 = await import(asUrl(join(ENGINE_DIR, 'E142.js')));
const E142Xml = await import(asUrl(join(ENGINE_DIR, 'E142Xml.js')));
const E142Grid = await import(asUrl(join(ENGINE_DIR, 'E142Grid.js')));
const Engine = await import(asUrl(join(ENGINE_DIR, 'Engine.js')));

/* ------------------------------------------------------------------------ *
 * Injectable-document stub: dependency-free, namespace-aware XML -> the      *
 * E142XmlElement shape. Throws on ill-formed / truncated input.             *
 * ------------------------------------------------------------------------ */
const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (m, body) => {
        if (body[0] === '#') {
            const cp = (body[1] === 'x' || body[1] === 'X')
                ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(cp)) { throw new Error('bad character reference ' + m); }
            return String.fromCodePoint(cp);
        }
        if (Object.prototype.hasOwnProperty.call(XML_ENTITIES, body)) { return XML_ENTITIES[body]; }
        throw new Error('unknown entity ' + m);
    });
}

/** An E142XmlElement over a parsed node; attribute() mirrors getAttributeNS. */
class StubElement {
    constructor(localName, namespaceUri, attrs, children, text) {
        this.localName = localName;
        this.namespaceUri = namespaceUri;
        this._attrs = attrs;
        this.children = children;
        this.text = text;
    }
    attribute(localName, namespaceUri) {
        const ns = (namespaceUri === undefined || namespaceUri === '') ? null : namespaceUri;
        for (const a of this._attrs) {
            if (a.local === localName && (a.ns ?? null) === ns) { return a.value; }
        }
        return null;
    }
}

/**
 * Parses XML text into the root {@link StubElement}, or throws on any
 * well-formedness violation (unbalanced tags, premature EOF, unquoted values,
 * unbound prefixes). No DTD subset / mixed-content support is needed for the
 * corpus; comments, PIs, CDATA and the XML declaration are handled.
 */
function stubParseDocument(xml) {
    let i = 0;
    const n = xml.length;
    const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
    const nameStart = /[A-Za-z_:]/;
    const nameChar = /[A-Za-z0-9_:.\-]/;
    const readName = () => {
        const s = i;
        if (i >= n || !nameStart.test(xml[i])) { throw new Error('expected a name at offset ' + i); }
        i++;
        while (i < n && nameChar.test(xml[i])) { i++; }
        return xml.slice(s, i);
    };
    const skipMisc = () => {
        for (;;) {
            while (i < n && isWs(xml[i])) { i++; }
            if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i); if (e < 0) { throw new Error('unterminated processing instruction'); } i = e + 2; continue; }
            if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i); if (e < 0) { throw new Error('unterminated comment'); } i = e + 3; continue; }
            if (xml.startsWith('<!DOCTYPE', i)) { let d = 0; while (i < n) { const c = xml[i++]; if (c === '<') { d++; } else if (c === '>') { if (d === 0) { break; } d--; } } continue; }
            break;
        }
    };
    const resolve = (stack, prefix) => {
        for (let k = stack.length - 1; k >= 0; k--) { if (prefix in stack[k]) { return stack[k][prefix]; } }
        return prefix === '' ? '' : undefined;
    };
    const split = (qn) => { const c = qn.indexOf(':'); return c < 0 ? { prefix: '', local: qn } : { prefix: qn.slice(0, c), local: qn.slice(c + 1) }; };

    function parseElement(stack) {
        if (xml[i] !== '<') { throw new Error('expected < at offset ' + i); }
        i++;
        const rawName = readName();
        const rawAttrs = [];
        for (;;) {
            while (i < n && isWs(xml[i])) { i++; }
            if (i >= n) { throw new Error('unterminated start tag (unexpected EOF)'); }
            const c = xml[i];
            if (c === '>' || c === '/') { break; }
            const an = readName();
            while (i < n && isWs(xml[i])) { i++; }
            if (xml[i] !== '=') { throw new Error('expected = in attribute at offset ' + i); }
            i++;
            while (i < n && isWs(xml[i])) { i++; }
            const q = xml[i];
            if (q !== '"' && q !== "'") { throw new Error('unquoted attribute value at offset ' + i); }
            i++;
            const vs = i;
            while (i < n && xml[i] !== q) { i++; }
            if (i >= n) { throw new Error('unterminated attribute value (unexpected EOF)'); }
            const rawVal = xml.slice(vs, i);
            i++;
            rawAttrs.push({ name: an, value: decodeEntities(rawVal) });
        }
        const scope = {};
        for (const a of rawAttrs) {
            if (a.name === 'xmlns') { scope[''] = a.value; }
            else if (a.name.startsWith('xmlns:')) { scope[a.name.slice(6)] = a.value; }
        }
        stack.push(scope);
        const en = split(rawName);
        const elemNs = resolve(stack, en.prefix);
        if (elemNs === undefined) { throw new Error('unbound element prefix "' + en.prefix + '"'); }
        const attrs = [];
        for (const a of rawAttrs) {
            if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) { continue; }
            const sp = split(a.name);
            let ans = null;
            if (sp.prefix !== '') {
                const u = resolve(stack, sp.prefix);
                if (u === undefined) { throw new Error('unbound attribute prefix "' + sp.prefix + '"'); }
                ans = u;
            }
            attrs.push({ local: sp.local, ns: ans, value: a.value });
        }
        const children = [];
        let textBuf = '';
        if (xml[i] === '/') { i++; if (xml[i] !== '>') { throw new Error('malformed empty-element tag'); } i++; stack.pop(); return new StubElement(en.local, elemNs || '', attrs, children, ''); }
        if (xml[i] !== '>') { throw new Error('expected > at offset ' + i); }
        i++;
        for (;;) {
            if (i >= n) { throw new Error('unexpected EOF in element ' + rawName); }
            if (xml.startsWith('</', i)) {
                i += 2;
                const cn = readName();
                while (i < n && isWs(xml[i])) { i++; }
                if (xml[i] !== '>') { throw new Error('malformed end tag'); }
                i++;
                if (cn !== rawName) { throw new Error('mismatched end tag </' + cn + '> for <' + rawName + '>'); }
                break;
            }
            if (xml.startsWith('<!--', i)) { const e = xml.indexOf('-->', i); if (e < 0) { throw new Error('unterminated comment'); } i = e + 3; continue; }
            if (xml.startsWith('<![CDATA[', i)) { const e = xml.indexOf(']]>', i); if (e < 0) { throw new Error('unterminated CDATA'); } textBuf += xml.slice(i + 9, e); i = e + 3; continue; }
            if (xml.startsWith('<?', i)) { const e = xml.indexOf('?>', i); if (e < 0) { throw new Error('unterminated processing instruction'); } i = e + 2; continue; }
            if (xml[i] === '<') { children.push(parseElement(stack)); continue; }
            const ts = i;
            while (i < n && xml[i] !== '<') { i++; }
            textBuf += decodeEntities(xml.slice(ts, i));
        }
        stack.pop();
        const full = textBuf + children.map((c) => c.text).join('');
        return new StubElement(en.local, elemNs || '', attrs, children, full);
    }

    const stack = [{ xml: 'http://www.w3.org/XML/1998/namespace' }];
    skipMisc();
    if (i >= n || xml[i] !== '<') { throw new Error('no root element'); }
    const root = parseElement(stack);
    skipMisc();
    if (i < n) { throw new Error('trailing content after root element at offset ' + i); }
    return root;
}

/* ------------------------------------------------------------------------ *
 * Field rename E142BinDefinition -> engine BinDefinition (mirrors           *
 * SubstrateMap.toEngineBinDefinition, which the control feeds buildGridModel). *
 * ------------------------------------------------------------------------ */
function toEngineBinDefinition(d) {
    return { code: d.binCode, quality: d.binQuality, pick: d.pick };
}

/**
 * Runs the control's XML ingest chain DOM-free. `overlayName` mirrors
 * getE142OverlayName (null = first renderable overlay in document order,
 * decision E-5); a string selects the first renderable BinCodeMap with that
 * MapName. Returns the built grid plus the header/placement/overlay-selection
 * facts the assertions need. Throws exactly what the control would surface as
 * E142LastError (a parse error, a layout error, or "no drawable lattice").
 */
function runXmlChain(xml, overlayName = null) {
    const parsed = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
    const doc = parsed.doc;

    const overlayNames = [];
    for (const sm of doc.substrateMaps) {
        for (const ov of sm.overlays) { overlayNames.push({ name: ov.mapName, renderable: ov.payload !== undefined }); }
    }
    let header = null;
    let overlay = null;
    let sawName = false;
    for (const sm of doc.substrateMaps) {
        for (const ov of sm.overlays) {
            const renderable = ov.payload !== undefined;
            if (overlayName === null) {
                if (renderable) { header = sm.header; overlay = ov; break; }
            } else if (ov.mapName === overlayName) {
                sawName = true;
                if (renderable) { header = sm.header; overlay = ov; break; }
            }
        }
        if (overlay !== null) { break; }
    }
    if (header === null || overlay === null || overlay.payload === undefined) {
        return { grid: null, doc, overlayNames, warnings: parsed.warnings, noRenderable: true, sawName };
    }
    const resolved = E142.resolveLayoutSpecifier(doc, header.layoutSpecifier);
    if (resolved instanceof E142.E142Error) { throw resolved; }
    const layout = resolved !== null ? resolved : E142.dimsFromPayload(overlay.payload);

    const placementResult = E142.computeGridPlacement(header, layout, 0, undefined);
    const placement = placementResult.placement; // DOM-free: no outline, so no fitPlacementToBox (unit pitch stays nominal)
    const grid = Engine.buildGridModel(
        placement,
        overlay.payload,
        overlay.binDefinitions ? overlay.binDefinitions.map(toEngineBinDefinition) : null,
    );
    if (grid === null) { throw new Error('the map payload does not describe a drawable lattice'); }
    return {
        grid, doc, header, placement, scaled: placementResult.scaled,
        pickedOverlay: overlay.mapName, overlay, overlayNames,
        warnings: parsed.warnings.concat(placementResult.warnings.map((w) => w.code + ': ' + w.message)),
    };
}

/**
 * Runs the control's JSON (GridData) ingest chain DOM-free
 * (normalizeGridData -> computeGridPlacement -> buildGridModel). Throws the
 * typed E142GridError normalizeGridData raises on an invalid document.
 */
function runJsonChain(gd) {
    const norm = E142Grid.normalizeGridData(gd);
    const placementResult = E142.computeGridPlacement(norm.header, norm.resolvedLayout, 0, undefined);
    const placement = placementResult.placement;
    const grid = Engine.buildGridModel(
        placement,
        norm.payload,
        norm.binDefs ? norm.binDefs.map(toEngineBinDefinition) : null,
    );
    if (grid === null) { throw new Error('the map payload does not describe a drawable lattice'); }
    return { grid, header: norm.header, placement, scaled: placementResult.scaled, warnings: norm.warnings };
}

/* ------------------------------------------------------------------------ *
 * Analysis over a built GridModel (all read-path, no engine internals).     *
 * ------------------------------------------------------------------------ */

/** Per-bin histogram (token -> count) over every cell, plus the non-null count. */
function histogramAndNonNull(grid) {
    const { cols, rows, cells, binTable } = grid;
    const hist = Object.create(null);
    let nonNull = 0;
    const total = cols * rows;
    for (let k = 0; k < total; k++) {
        const idx = cells[k];
        const code = binTable[idx].code;
        hist[code] = (hist[code] || 0) + 1;
        if (idx !== 0) { nonNull++; } // binTable index 0 is the reserved null bin
    }
    return { hist, nonNull, total };
}

/**
 * Token at the cell whose LOGICAL coordinate is (x, y), located through the
 * same frame math the control's selection path uses (mapCoordToIndex). Returns
 * { offGrid:true } when (x, y) addresses no serialized cell.
 */
function tokenAtLogical(grid, header, x, y) {
    const { cols, rows, cells, binTable } = grid;
    const { serCol, serRow } = E142.mapCoordToIndex(x, y, header.originLocation, header.axisDirection, cols, rows);
    if (!(serCol >= 0 && serCol < cols && serRow >= 0 && serRow < rows)) { return { offGrid: true, serCol, serRow }; }
    const linear = serRow * cols + serCol;
    return { serCol, serRow, token: binTable[cells[linear]].code };
}

/** S-frame corner (mm) of the serialized cell (serCol, serRow): origin + serCol*colStep + serRow*rowStep. */
function sFrameCorner(placement, serCol, serRow) {
    return {
        x: placement.originXmm + serCol * placement.colStepXmm + serRow * placement.rowStepXmm,
        y: placement.originYmm + serCol * placement.colStepYmm + serRow * placement.rowStepYmm,
    };
}

const hypot = (x, y) => Math.sqrt(x * x + y * y);
const angleDeg = (x, y) => { const a = Math.atan2(y, x) * 180 / Math.PI; return ((a % 360) + 360) % 360; };
const angClose = (a, b, eps = 1e-6) => { let d = Math.abs(((a - b) % 360) + 360) % 360; if (d > 180) { d = 360 - d; } return d <= eps; };

/* ------------------------------------------------------------------------ *
 * Minimal assertion harness (counts, records, never throws out).            *
 * ------------------------------------------------------------------------ */
let PASS = 0;
let FAIL = 0;
const FAILURES = [];
/* Last-resort crash guard: a throw anywhere still produces a summary and
 * exit 1, instead of a stack trace that discards the counts. See D-036. */
onCrash(() => ({ pass: PASS, fail: FAIL, failures: FAILURES }));
function ok(cond, label) {
    if (cond) { PASS++; } else { FAIL++; FAILURES.push(label); console.log('    FAIL: ' + label); }
}
function eq(actual, expected, label) {
    ok(actual === expected, `${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function close(actual, expected, eps, label) {
    ok(Number.isFinite(actual) && Math.abs(actual - expected) <= eps,
        `${label}  (expected ${expected}+/-${eps}, got ${actual})`);
}
function sameHistogram(actual, expected, label) {
    const ak = Object.keys(actual).sort();
    const ek = Object.keys(expected).sort();
    let same = ak.length === ek.length && ak.every((k, idx) => k === ek[idx] && actual[k] === expected[k]);
    ok(same, `${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}
function assertThrows(fn, expectedCode, label) {
    try {
        fn();
        FAIL++; FAILURES.push(`${label}  (expected throw ${expectedCode}, but it succeeded)`);
        console.log('    FAIL: ' + label + ' (no throw)');
    } catch (e) {
        const code = e && e.code ? e.code : '(none)';
        ok(code === expectedCode, `${label}  (expected code ${expectedCode}, got ${code}: ${e && e.message})`);
    }
}

/* ======================================================================== *
 * EXPECTATION CARDS (transcribed from fixtures/EXPECTATIONS.md).
 *
 * Probe cells are given by LOGICAL coordinate + token; `tokenAtLogical` maps
 * through mapCoordToIndex so the frame (OriginLocation x AxisDirection) is under
 * test both ways. `orientation`/`origin`/`axis` are also asserted against the
 * parsed header. `stepMm` (when present, quadrant orientations only) drives the
 * step-magnitude check; `geomAngle:false` suppresses the rotation check for the
 * A3.1-open 90-degree swap fixture. `correction` notes where a card's own hand
 * arithmetic is wrong against the fixture bytes and the asserted value is the
 * verified-correct one.
 * ======================================================================== */
const XML_CARDS = [
    {
        file: 'official-BinCodeMap-Example.xml', cols: 12, rows: 11,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', defaultOverlay: 'SortGrade',
        probes: [{ x: 0, y: 0, t: '.' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: '.' }, { x: 11, y: 10, t: '.' }],
        nonNull: 108, hist: { '.': 24, '1': 97, '2': 5, '8': 3, '9': 3 },
    },
    {
        file: 'v1005-wafer-2darray-ascii.xml', cols: 10, rows: 8,
        orientation: 180, origin: 'UpperRight', axis: 'DownLeft', defaultOverlay: 'SortGrade',
        stepMm: [0.63, 0.64],
        probes: [{ x: 0, y: 0, t: '.' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: '.' }, { x: 9, y: 7, t: '.' }],
        nonNull: 68, hist: { '.': 12, 'E': 20, 'P': 43, 'X': 4, 'F': 1 },
    },
    {
        file: 'v1005-strip-integer2-lowerleft.xml', cols: 7, rows: 5,
        orientation: 180, origin: 'LowerLeft', axis: 'UpRight', defaultOverlay: 'BinCodeMap',
        stepMm: [50, 15],
        probes: [{ x: 0, y: 0, t: 'FFFF' }, { x: 1, y: 0, t: 'FFFF' }, { x: 0, y: 1, t: '0002' }, { x: 6, y: 4, t: 'FFFF' }],
        nonNull: 21, hist: { 'FFFF': 14, '0002': 19, '0008': 1, '0001': 1 },
    },
    {
        file: 'v0921-array-integer2-csdn.xml', cols: 5, rows: 4,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', defaultOverlay: 'DownloadCodeMap',
        // CORRECTION: card #6 gives (0,0)=0001,(1,0)=0002,last(4,3)=0002. The BinCode
        // is 0001 0002 alternating (20 tokens); Array is row-major top-left, so serial
        // idx15=0002, idx16=0001, idx4=0001. The chain is correct; the card swapped the
        // even/odd token values. Aggregate count/histogram are unaffected and match.
        correction: 'card #6 probe tokens (0,0)/(1,0)/last swapped even/odd; corrected to fixture bytes',
        probes: [{ x: 0, y: 0, t: '0002' }, { x: 1, y: 0, t: '0001' }, { x: 0, y: 1, t: '0001' }, { x: 4, y: 3, t: '0001' }],
        nonNull: 20, hist: { '0001': 10, '0002': 10 },
    },
    {
        file: 'v0805-legacy-namespace.xml', cols: 4, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: '.' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 2, t: '.' }],
        nonNull: 8, hist: { '.': 4, '1': 7, '9': 1 },
    },
    {
        file: 'v0211-rowcolumn-prose-derived.xml', cols: 6, rows: 4,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', prose: 'Row/Column (inferred A5, grade C+)',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 5, y: 3, t: '9' }],
        nonNull: 22, hist: { '1': 18, '9': 4, '.': 2 },
    },
    {
        file: 'v0211-coordinate-mixed.xml', cols: 4, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 2, t: '.' }],
        nonNull: 7, hist: { '1': 6, '9': 1, '.': 5 },
    },
    {
        // UPDATED IN TASK 40. The three LID-only entries used to be EXCLUDED
        // (nonNull 5, and an E142_XML_LID_ONLY_EXCLUDED warning); they are now
        // RESOLVED onto the free cells of the declared 4x3 lattice in document
        // order, so nothing is excluded and no warning fires. Hand-derived:
        // the five X/Y entries take linear 4, 7, 8, 9, 10; the cursor then hands
        // DIE-SPARE-A/B/C the first three free cells, linear 0, 1, 2.
        //     911.        <- row 0: the three resolved spares
        //     1..1
        //     119.
        file: 'v0125-coordinate-lid-mixed.xml', cols: 4, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [
            { x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 2, t: '.' },
            // the resolved cells themselves - logical y=2 is serialization row 0
            { x: 0, y: 2, t: '9' }, { x: 1, y: 2, t: '1' }, { x: 2, y: 2, t: '1' },
        ],
        nonNull: 8, hist: { '1': 6, '9': 2, '.': 4 },
    },
    {
        file: 'v0211-hexadecimal-nullbin-round.xml', cols: 9, rows: 9,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: 'F0' }, { x: 1, y: 0, t: 'F0' }, { x: 0, y: 1, t: 'F0' }, { x: 8, y: 8, t: 'F0' }],
        nonNull: 61, hist: { 'F0': 20, '01': 59, '09': 2 },
    },
    {
        file: 'v0211-decimal-bintype.xml', cols: 5, rows: 4,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: '255' }, { x: 1, y: 0, t: '001' }, { x: 0, y: 1, t: '001' }, { x: 4, y: 3, t: '001' }],
        nonNull: 18, hist: { '001': 16, '009': 2, '255': 2 },
    },
    {
        file: 'v0211-orientation-90.xml', cols: 5, rows: 3,
        orientation: 90, origin: 'LowerLeft', axis: 'UpRight', geomAngle: false,
        openGeometry: 'the 90-degree layout/payload swap is unsettled; data asserted, placement not',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 4, y: 2, t: '9' }],
        nonNull: 15, hist: { '1': 12, '9': 3 },
    },
    {
        file: 'v0211-orientation-45-nonquadrant.xml', cols: 4, rows: 4,
        orientation: 45, origin: 'LowerLeft', axis: 'UpRight',
        openGeometry: 'the non-quadrant logical meaning is open; placement is a well-defined 45-deg rotation',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 3, t: '1' }],
        nonNull: 16, hist: { '1': 14, '9': 2 },
    },
    {
        file: 'v0211-origin-center-even.xml', cols: 4, rows: 4,
        orientation: 0, origin: 'Center', axis: 'UpRight', formulaDerived: 'Center-even zero cell ((C-1)//2,(R-1)//2)',
        // Card labels probes by VISUAL corner; the logical coordinate the card assigns
        // to each is used here (Center-even zero cell = (1,1)).
        probes: [{ x: -1, y: -1, t: '1' }, { x: 0, y: -1, t: '1' }, { x: -1, y: 0, t: '1' }, { x: 2, y: 2, t: '1' }],
        nonNull: 16, hist: { '1': 14, '9': 2 },
    },
    {
        file: 'v0211-origin-downleft.xml', cols: 5, rows: 3,
        orientation: 0, origin: 'UpperRight', axis: 'DownLeft',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '9' }, { x: 0, y: 1, t: '1' }, { x: 4, y: 2, t: '1' }],
        nonNull: 15, hist: { '1': 13, '9': 2 },
    },
    {
        file: 'v0211-multi-overlay.xml', cols: 3, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', defaultOverlay: 'SortGrade',
        // CORRECTION: card #17 states non-null 8/9 for SortGrade, but its own histogram
        // is {1:8,9:1} with "no NullBin token present" and the fixture's NullBin='.'
        // never appears -> all 9 cells are non-null. The card's non-null is self-
        // contradictory; the verified value is 9. Histogram matches.
        correction: 'card #17 SortGrade non-null 8 contradicts its own histogram (no null token); corrected to 9',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 2, y: 2, t: '1' }],
        nonNull: 9, hist: { '1': 8, '9': 1 },
    },
    {
        file: 'v0211-multi-layout-childpath.xml', cols: 4, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [2, 2],
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 2, t: '1' }],
        nonNull: 12, hist: { '1': 11, '9': 1 },
    },
    {
        file: 'v0211-substrateid-whitespace.xml', cols: 3, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', expectWarning: 'E142_XML_ID_TRIMMED',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: '1' }, { x: 2, y: 1, t: '1' }],
        nonNull: 5, hist: { '1': 5, '.': 1 },
    },
    {
        file: 'v0211-layoutless-defaults-alt.xml', cols: 8, rows: 6,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 7, y: 5, t: '1' }],
        nonNull: 48, hist: { '1': 44, '9': 4 },
    },
    {
        file: 'v0211-defaultunits-microns.xml', cols: 4, rows: 1,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', expectWarning: 'E142_UNIT_TOLERATED',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '9' }, { x: 3, y: 0, t: '1' }],
        nonNull: 4, hist: { '1': 3, '9': 1 },
    },
    {
        file: 'v0211-defaultunits-100microns.xml', cols: 3, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', expectWarning: 'E142_UNIT_TOLERATED',
        stepMm: [0.63, 0.64],
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 2, y: 2, t: '1' }],
        nonNull: 9, hist: { '1': 8, '9': 1 },
    },
    {
        file: 'v0211-perf-600x600-ascii.xml', cols: 600, rows: 600,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [0.1, 0.1], perf: true,
        probes: [{ x: 0, y: 0, t: '.' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: '.' }, { x: 599, y: 599, t: '.' }],
        nonNull: 279004, hist: { '.': 80996, '1': 273496, '9': 5508 },
    },
    /* ------------------------------------------------------------------ *
     * Coverage extension. Every expectation below was derived BY HAND from
     * the fixture bytes and the frame rule, then confirmed against the
     * engine - not read out of it. The rule (serialization row 0 is the TOP
     * row, column 0 the LEFTMOST; OriginLocation names the corner holding
     * logical (0,0); AxisDirection reads <vertical-for-y><horizontal-for-x>)
     * was itself validated by re-deriving all 43 probes of the pre-existing
     * cards above and matching every one.
     * ------------------------------------------------------------------ */
    {
        file: 'v0125-bottomside-ascii.xml', cols: 4, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'i' }, { x: 1, y: 0, t: 'j' }, { x: 0, y: 1, t: 'e' }, { x: 3, y: 2, t: 'd' }],
        nonNull: 12,
        hist: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1, j: 1, k: 1, l: 1 },
    },
    {
        file: 'v0125-orientation-270.xml', cols: 3, rows: 2,
        orientation: 270, origin: 'LowerLeft', axis: 'UpRight', stepMm: [3, 2],
        // stepMm is TRANSPOSED against the layout's StepSize X="2.0" Y="3.0", and
        // that is correct, not a typo. A 90/270 orientation transposes the map
        // frame (the dimension swap in dimsInMapFrame), so the layout's X pitch
        // becomes the map frame's ROW pitch. The card is compared against the
        // placement, which is in the map frame. Hand-writing [2, 3] here is the
        // obvious mistake and the suite catches it - do not "fix" this back.
        formulaDerived: 'stepMm transposed by the 270-degree A3 frame swap',
        probes: [{ x: 0, y: 0, t: 's' }, { x: 1, y: 0, t: 't' }, { x: 0, y: 1, t: 'p' }, { x: 2, y: 1, t: 'r' }],
        nonNull: 6,
        hist: { p: 1, q: 1, r: 1, s: 1, t: 1, u: 1 },
    },
    {
        file: 'v0125-origin-upperleft-downright.xml', cols: 3, rows: 3,
        orientation: 0, origin: 'UpperLeft', axis: 'DownRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'A' }, { x: 1, y: 0, t: 'B' }, { x: 0, y: 1, t: 'D' }, { x: 2, y: 2, t: 'I' }],
        nonNull: 9,
        hist: { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1, H: 1, I: 1 },
    },
    {
        file: 'v0125-origin-lowerright-upleft.xml', cols: 3, rows: 3,
        orientation: 0, origin: 'LowerRight', axis: 'UpLeft', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'R' }, { x: 1, y: 0, t: 'Q' }, { x: 0, y: 1, t: 'O' }, { x: 2, y: 2, t: 'J' }],
        nonNull: 9,
        hist: { J: 1, K: 1, L: 1, M: 1, N: 1, O: 1, P: 1, Q: 1, R: 1 },
    },
    {
        file: 'v0125-bottomside-orientation-180.xml', cols: 4, rows: 2,
        orientation: 180, origin: 'UpperRight', axis: 'DownLeft', stepMm: [2, 2],
        probes: [{ x: 0, y: 0, t: '4' }, { x: 1, y: 0, t: '3' }, { x: 0, y: 1, t: '8' }, { x: 3, y: 1, t: '5' }],
        nonNull: 8,
        hist: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
    },
    /* ------------------------------------------------------------------ *
     * Task 14 coverage: the <Substrates> block. Before these, exactly ONE
     * fixture carried any Substrate child and none carried SupplierName or
     * Status. Normal case, both schema boundaries, and the join.
     * ------------------------------------------------------------------ */
    {
        file: 'v0125-substrate-full-record.xml', cols: 3, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'd' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: 'a' }, { x: 2, y: 1, t: 'c' }],
        nonNull: 5, hist: { a: 1, b: 1, c: 1, d: 1, '.': 1, f: 1 },
    },
    {
        // GoodDevices = 0 is a MEASUREMENT, not an absence: xs:nonNegativeInteger
        // admits zero. LotId is exactly 80 and SubstrateId exactly 32 - the
        // LotIdType and MaterialIdType maxLength boundaries. The id appears twice
        // in an exported document, so truncating it breaks the SubstrateKey join
        // rather than merely shortening a label.
        file: 'v0125-substrate-edge-values.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'r' }, { x: 1, y: 0, t: 's' }, { x: 0, y: 1, t: 'p' }, { x: 1, y: 1, t: 'q' }],
        nonNull: 4, hist: { p: 1, q: 1, r: 1, s: 1 },
    },
    {
        // Two Substrate records; the map is keyed to the SECOND. Reading the
        // first because it comes first in document order is the obvious bug, and
        // every other fixture has exactly one Substrate.
        file: 'v0125-substrate-multiple-records.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'y' }, { x: 1, y: 0, t: 'z' }, { x: 0, y: 1, t: 'w' }, { x: 1, y: 1, t: 'x' }],
        nonNull: 4, hist: { w: 1, x: 1, y: 1, z: 1 },
    },
    {
        // Task 15 integration: SubstrateSide, Orientation, a non-default frame,
        // MapVersion and a full Substrate record in ONE document. The control
        // retains all of them in a single __lastBuilt record and passes them as
        // a single options object, so a dropped or transposed field only shows
        // when its neighbours are populated too.
        file: 'v0125-all-header-facts.xml', cols: 3, rows: 2,
        orientation: 180, origin: 'UpperRight', axis: 'DownLeft', stepMm: [2, 3],
        probes: [{ x: 0, y: 0, t: 'O' }, { x: 1, y: 0, t: 'N' }, { x: 0, y: 1, t: 'R' }, { x: 2, y: 1, t: 'P' }],
        nonNull: 6, hist: { M: 1, N: 1, O: 1, P: 1, Q: 1, R: 1 },
    },
    {
        // Task 18: Substrate/AliasIds. Three entries so document order and the
        // multi-entry path are exercised, an open-vocabulary @Type that must be
        // carried without complaint, and a @Value at exactly the MaterialIdType
        // maxLength of 32.
        file: 'v0125-substrate-aliasids.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'c' }, { x: 1, y: 0, t: 'd' }, { x: 0, y: 1, t: 'a' }, { x: 1, y: 1, t: 'b' }],
        nonNull: 4, hist: { a: 1, b: 1, c: 1, d: 1 },
    },
    {
        // Task 19: Substrate/CarrierType + CarrierId, the latter at exactly 80 -
        // the LotIdType maxLength, NOT the MaterialIdType 32 that SubstrateId
        // carries two lines above it in the same xs:sequence. Zero warnings is
        // the assertion that matters; checking at 32 would warn here.
        file: 'v0125-substrate-carrier.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'g' }, { x: 1, y: 0, t: 'h' }, { x: 0, y: 1, t: 'e' }, { x: 1, y: 1, t: 'f' }],
        nonNull: 4, hist: { e: 1, f: 1, g: 1, h: 1 },
    },
    {
        // Task 20: SlotNumber / SubstrateNumber, with SlotNumber = 0 and
        // GoodDevices = 0. Table 6 calls these "Positive Integer"; the XSD types
        // them xs:nonNegativeInteger and xmllint accepts 0. The schema wins, so
        // this fixture must parse with zero warnings - a parser written to the
        // prose would reject it.
        file: 'v0125-substrate-numbers.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'k' }, { x: 1, y: 0, t: 'l' }, { x: 0, y: 1, t: 'i' }, { x: 1, y: 1, t: 'j' }],
        nonNull: 4, hist: { i: 1, j: 1, k: 1, l: 1 },
    },
    {
        // Task 22: Layout/TopImage + BottomImage on BOTH levels of a two-level
        // tree. Table 2 defines them as the image of an INDIVIDUAL DEVICE, so
        // the substrate-level and device-level layouts legitimately carry
        // different URIs; a parser that merged or inherited them would pass a
        // single-layout fixture and fail this one. Resolved through
        // LayoutSpecifier="Img/Img_Devices".
        file: 'v0125-layout-images.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'o' }, { x: 1, y: 0, t: 'p' }, { x: 0, y: 1, t: 'm' }, { x: 1, y: 1, t: 'n' }],
        nonNull: 4, hist: { m: 1, n: 1, o: 1, p: 1 },
    },
    {
        // Task 29: one MapName at two MapVersions - the R2-1.2.1 lifecycle
        // (download at 1, upload the result at 2). No other fixture carries a
        // repeated name, which is exactly the case a name-only selector gets
        // wrong. defaultOverlay is version 1 because it comes first; the cells
        // are 'a' throughout so picking version 2 would be visible.
        file: 'v0125-overlay-two-versions.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        defaultOverlay: 'Sort',
        probes: [{ x: 0, y: 0, t: 'a' }, { x: 1, y: 0, t: 'a' }, { x: 0, y: 1, t: 'a' }, { x: 1, y: 1, t: 'a' }],
        nonNull: 4, hist: { a: 4 },
    },
    {
        // Task 31: three SubstrateMaps - the 14.3 MapUpload / 14.4
        // MapGroupDownload shape. Two share LayoutSpecifier "L" and differ only
        // in SubstrateId; the third uses "L2". Cells are 'a' / 'b' / 'c' so a
        // selector rendering the wrong substrate is visible in the grid. The
        // DOM-free chain takes the first renderable overlay, so this card
        // describes W-001.
        file: 'v0125-three-substrates.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'a' }, { x: 1, y: 0, t: 'a' }, { x: 0, y: 1, t: 'a' }, { x: 1, y: 1, t: 'a' }],
        nonNull: 4, hist: { a: 4 },
    },
    {
        // Task 39: LID retained on BOTH modelled carriers, in all three §13.3
        // forms ("either X/Y, or the LID, or BOTH"). The grid is built from the
        // four placeable entries; the fifth is LID-only and is retained on the
        // overlay rather than placed, which is what the expected warning says.
        // LIDs here are deliberately awkward - mixed case, a separator, one that
        // looks numeric - because none may be normalised.
        file: 'v0125-lid-retained.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'a' }, { x: 1, y: 0, t: 'b' }, { x: 0, y: 1, t: 'c' }, { x: 1, y: 1, t: 'd' }],
        nonNull: 4, hist: { a: 1, b: 1, c: 1, d: 1 },
        expectWarning: 'E142_XML_LID_ONLY_EXCLUDED',
    },
    {
        // Tasks 44-46: the first corpus document to carry a <TransferMap> at all.
        // Three SubstrateMaps - two sources and a target - because the three
        // From* attributes are an xs:keyref into SubstrateMapKey and a dangling
        // one is E142_XML_INTEGRITY. The target's Provenance overlay carries TWO
        // TransferMaps (maxOccurs="unbounded"): the source is named per map, so a
        // substrate fed from two places needs two. The renderable overlay is the
        // separate Sort BinCodeMap; a TransferMap overlay has nothing to draw.
        file: 'v0125-transfer-chain.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        defaultOverlay: 'Sort',
        probes: [{ x: 0, y: 0, t: 'c' }, { x: 1, y: 0, t: 'd' }, { x: 0, y: 1, t: 'a' }, { x: 1, y: 1, t: 'b' }],
        nonNull: 4, hist: { a: 1, b: 1, c: 1, d: 1 },
    },
    {
        // Tasks 51-56: the first corpus document with a DeviceDataMap and an
        // embedded E138 ccs:PVSet. The renderable overlay is the separate Sort
        // BinCodeMap - OverlayType is an xs:choice, so a DeviceDataMap overlay
        // carries no bin codes and has nothing to draw.
        file: 'v0125-devicedata.xml', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        defaultOverlay: 'Sort',
        probes: [{ x: 0, y: 0, t: 'c' }, { x: 1, y: 0, t: 'd' }, { x: 0, y: 1, t: 'a' }, { x: 1, y: 1, t: 'b' }],
        nonNull: 4, hist: { a: 1, b: 1, c: 1, d: 1 },
    },
];

const JSON_CARDS = [
    {
        file: 'json-bins-string-array.json', cols: 5, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [0.5, 0.5],
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 4, y: 2, t: '1' }],
        nonNull: 15, hist: { '1': 13, '9': 2 },
    },
    {
        file: 'json-bins-string-single.json', cols: 4, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 2, t: '1' }],
        nonNull: 11, hist: { '1': 9, '9': 2, '.': 1 },
    },
    {
        file: 'json-bins-number-integer2.json', cols: 4, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [2, 2],
        probes: [{ x: 0, y: 0, t: '0001' }, { x: 1, y: 0, t: '0001' }, { x: 0, y: 1, t: '0001' }, { x: 3, y: 1, t: '0001' }],
        nonNull: 7, hist: { '0001': 6, '0009': 1, 'FFFF': 1 },
    },
    {
        file: 'json-coordinate-sparse.json', cols: 4, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 2, t: '.' }],
        nonNull: 6, hist: { '1': 5, '9': 1, '.': 6 },
    },
    {
        file: 'json-defaults-omitted.json', cols: 3, rows: 3,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: '.' }, { x: 2, y: 2, t: '1' }],
        nonNull: 5, hist: { '1': 4, '9': 1, '.': 4 },
    },
    {
        file: 'json-units-um.json', cols: 3, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [0.63, 0.64],
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 2, y: 1, t: '1' }],
        nonNull: 5, hist: { '1': 5, '.': 1 },
    },
    {
        file: 'json-lowerleft-anchored.json', cols: 4, rows: 4,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [0.63, 0.64],
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 3, y: 3, t: '1' }],
        nonNull: 16, hist: { '1': 14, '9': 2 },
    },
    {
        file: 'json-perf-600x600-ascii.json', cols: 600, rows: 600,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [0.1, 0.1], perf: true,
        probes: [{ x: 0, y: 0, t: '.' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: '.' }, { x: 599, y: 599, t: '.' }],
        nonNull: 279004, hist: { '.': 80996, '1': 273371, '9': 5633 },
    },
    /* ------------------------------------------------------------------ *
     * Coverage extension (JSON side). Before these, the whole GridData
     * corpus used orientation 0, OriginLocation LowerLeft and AxisDirection
     * UpRight and nothing else - four of five origins, three of four axis
     * directions and every non-zero orientation were untested. Expectations
     * hand-derived from the fixture bytes with the same frame rule used for
     * the XML cards, then confirmed.
     * ------------------------------------------------------------------ */
    {
        file: 'json-origin-upperleft-downright.json', cols: 3, rows: 3,
        orientation: 0, origin: 'UpperLeft', axis: 'DownRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'A' }, { x: 1, y: 0, t: 'B' }, { x: 0, y: 1, t: 'D' }, { x: 2, y: 2, t: 'I' }],
        nonNull: 9, hist: { A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1, H: 1, I: 1 },
    },
    {
        file: 'json-origin-lowerright-upleft.json', cols: 3, rows: 3,
        orientation: 0, origin: 'LowerRight', axis: 'UpLeft', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'R' }, { x: 1, y: 0, t: 'Q' }, { x: 0, y: 1, t: 'O' }, { x: 2, y: 2, t: 'J' }],
        nonNull: 9, hist: { J: 1, K: 1, L: 1, M: 1, N: 1, O: 1, P: 1, Q: 1, R: 1 },
    },
    {
        file: 'json-origin-upperright-downleft.json', cols: 4, rows: 2,
        orientation: 0, origin: 'UpperRight', axis: 'DownLeft', stepMm: [2, 3],
        probes: [{ x: 0, y: 0, t: '4' }, { x: 1, y: 0, t: '3' }, { x: 0, y: 1, t: '8' }, { x: 3, y: 1, t: '5' }],
        nonNull: 8, hist: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1 },
    },
    {
        // Center on an ODD x ODD grid: the centre cell is unambiguous, so the
        // zero-cell tie-break rule cannot hide a mistake here. Only (0,0) is
        // asserted - it is the one address whose meaning "Center" fixes on its
        // own, without leaning on a convention this card would then be circular
        // evidence for.
        file: 'json-origin-center-odd.json', cols: 3, rows: 3,
        orientation: 0, origin: 'Center', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'e' }],
        nonNull: 9, hist: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1, h: 1, i: 1 },
    },
    {
        file: 'json-orientation-180.json', cols: 4, rows: 2,
        orientation: 180, origin: 'LowerLeft', axis: 'UpRight', stepMm: [2, 3],
        probes: [{ x: 0, y: 0, t: 's' }, { x: 1, y: 0, t: 't' }, { x: 0, y: 1, t: 'w' }, { x: 3, y: 1, t: 'z' }],
        nonNull: 8, hist: { w: 1, x: 1, y: 1, z: 1, s: 1, t: 1, u: 1, v: 1 },
    },
    {
        // 45 degrees: NO dimension/pitch swap off-quadrant, so
        // stepMm stays layout-aligned even though the placement is rotated.
        file: 'json-orientation-45-nonquadrant.json', cols: 3, rows: 2,
        orientation: 45, origin: 'LowerLeft', axis: 'UpRight', stepMm: [2, 3],
        probes: [{ x: 0, y: 0, t: 's' }, { x: 1, y: 0, t: 't' }, { x: 0, y: 1, t: 'p' }, { x: 2, y: 1, t: 'r' }],
        nonNull: 6, hist: { p: 1, q: 1, r: 1, s: 1, t: 1, u: 1 },
    },
    {
        // The CONFORMING 90-degree document: layout dimension 3x2, payload in
        // the MAP frame (3 rows of 2) per E142-0225 Table 12. Imports cleanly,
        // and stepMm is transposed to [3, 2] by the A3 quadrant swap. This is
        // the counter-example that shows the importer is right and
        // gridToGridData - which emits 2 rows of 3 for the same map - is the
        // defect. Do not "align" this fixture with the exporter's output.
        file: 'json-orientation-90-mapframe.json', cols: 2, rows: 3,
        orientation: 90, origin: 'LowerLeft', axis: 'UpRight', stepMm: [3, 2],
        probes: [{ x: 0, y: 0, t: 'e' }, { x: 1, y: 0, t: 'f' }, { x: 0, y: 1, t: 'c' }, { x: 1, y: 2, t: 'b' }],
        nonNull: 6, hist: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
        formulaDerived: 'stepMm transposed by the 90-degree A3 frame swap',
    },
    /* ------------------------------------------------------------------ *
     * Task 14 parity (JSON side): the substrate identity. `GridData.Schema.json`
     * declares `lotId` (maxLength 80) and `goodDevices` (integer, minimum 0) and
     * normalizeGridData reads both, but no JSON fixture carried either and
     * gridToGridData dropped them - the same shape of gap `deviceSize` had.
     * ------------------------------------------------------------------ */
    {
        file: 'json-substrate-identity.json', cols: 3, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'd' }, { x: 1, y: 0, t: '.' }, { x: 0, y: 1, t: 'a' }, { x: 2, y: 1, t: 'c' }],
        nonNull: 5, hist: { a: 1, b: 1, c: 1, d: 1, '.': 1, f: 1 },
    },
    {
        // goodDevices = 0 must survive as a value; lotId at 80 and substrateId at
        // 32 are the schema's declared maxLength boundaries.
        file: 'json-substrate-identity-edge.json', cols: 2, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'r' }, { x: 1, y: 0, t: 's' }, { x: 0, y: 1, t: 'p' }, { x: 1, y: 1, t: 'q' }],
        nonNull: 4, hist: { p: 1, q: 1, r: 1, s: 1 },
    },
    {
        // Task 41: per-cell LIDs on the GridData path. Row-major over the whole
        // 3x2 lattice; index 2 is null (unnamed) and index 1 is an EMPTY STRING,
        // which is a real zero-length LID and deliberately not the same thing.
        file: 'json-lids.json', cols: 3, rows: 2,
        orientation: 0, origin: 'LowerLeft', axis: 'UpRight', stepMm: [1, 1],
        probes: [{ x: 0, y: 0, t: 'd' }, { x: 2, y: 0, t: 'f' }, { x: 0, y: 1, t: 'a' }, { x: 2, y: 1, t: 'c' }],
        nonNull: 6, hist: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1 },
    },
];

/** Invalid fixtures that MUST throw, with the documented error code. */
const INVALID_XML = [
    { file: 'v0211-invalid-duplicate-layoutid.xml', code: 'E142_XML_INTEGRITY', klass: 'XSD identity-constraint (duplicate LayoutId key)' },
    { file: 'v0211-invalid-truncated.xml', code: 'E142_XML_MALFORMED', klass: 'XML well-formedness (premature EOF)' },
];
const INVALID_JSON = [
    { file: 'json-invalid-dimension-mismatch.json', code: 'E142_GRID_DECODE', klass: 'dimension / bins-length mismatch' },
    { file: 'json-invalid-bintype-enum.json', code: 'E142_GRID_ENUM_INVALID', klass: 'out-of-enum binType' },
];

/**
 * Fixtures that are well-formed and processed successfully but that the corpus
 * classifies as XSD-invalid: the hand parser is deliberately NOT an XSD validator
 * (schema-evolution tolerance, task O4 step 5), so it builds with a warning rather
 * than rejecting. Asserted as tolerated-with-warning; the divergence is in OPEN-ISSUES.
 */
const TOLERATED_XML = [
    {
        file: 'v0211-invalid-unknown-substratetype.xml', cols: 2, rows: 2,
        origin: 'LowerLeft', axis: 'UpRight', warning: 'E142_XML_SUBSTRATE_TYPE_UNKNOWN',
        probes: [{ x: 0, y: 0, t: '1' }, { x: 1, y: 0, t: '1' }, { x: 0, y: 1, t: '1' }, { x: 1, y: 1, t: '1' }],
        nonNull: 4, hist: { '1': 4 },
    },
];

/** Structural-only fixtures (no BinCodeMap grid): parse must succeed, no renderable overlay. */
const STRUCTURAL_XML = [
    { file: 'official-BinCodeMap-Extension-Example.xml', why: 'Substrate xsi:type extension demo; no SubstrateMaps grid data' },
];

/* ------------------------------------------------------------------------ *
 * Independent lattice inverse (own 2x2 solve; NOT engine code) - maps an     *
 * S-frame point back to lattice (a, b) to round-trip a probe cell's corner.  *
 * ------------------------------------------------------------------------ */
function latticeInverse(placement, px, py) {
    const ex = px - placement.originXmm;
    const ey = py - placement.originYmm;
    const det = placement.colStepXmm * placement.rowStepYmm - placement.colStepYmm * placement.rowStepXmm;
    return {
        a: (placement.rowStepYmm * ex - placement.rowStepXmm * ey) / det,
        b: (placement.colStepXmm * ey - placement.colStepYmm * ex) / det,
    };
}

/** Shared assertion body for one built grid against one card (XML or JSON). */
function assertCard(card, run, kind) {
    const { grid, header, placement } = run;
    // (D1) dimensions
    eq(grid.cols, card.cols, `${card.file}: cols`);
    eq(grid.rows, card.rows, `${card.file}: rows`);
    // header fields the card states
    if (card.orientation !== undefined) { eq(header.orientation, card.orientation, `${card.file}: header.orientation`); }
    if (card.origin) { eq(header.originLocation, card.origin, `${card.file}: header.originLocation`); }
    if (card.axis) { eq(header.axisDirection, card.axis, `${card.file}: header.axisDirection`); }

    // (D2/D3) probe cells: token by logical coord + logical<->serial round-trip
    // + (S-frame corner) corner finiteness and corner->lattice round-trip.
    const cornerLog = [];
    for (const p of card.probes) {
        const at = tokenAtLogical(grid, header, p.x, p.y);
        if (at.offGrid) { ok(false, `${card.file}: probe (${p.x},${p.y}) unexpectedly off-grid`); continue; }
        eq(at.token, p.t, `${card.file}: token @logical(${p.x},${p.y})`);
        // logical<->serial inverse consistency (indexToMapCoord o mapCoordToIndex == id)
        const back = E142.indexToMapCoord(at.serCol, at.serRow, header.originLocation, header.axisDirection, grid.cols, grid.rows);
        ok(back.x === p.x && back.y === p.y,
            `${card.file}: frame round-trip @(${p.x},${p.y}) -> serial(${at.serCol},${at.serRow}) -> logical(${back.x},${back.y})`);
        // S-frame corner of the probe cell + independent corner->lattice round-trip
        const c = sFrameCorner(placement, at.serCol, at.serRow);
        ok(Number.isFinite(c.x) && Number.isFinite(c.y), `${card.file}: S-frame corner finite @(${p.x},${p.y})`);
        const inv = latticeInverse(placement, c.x, c.y);
        ok(Math.abs(inv.a - at.serCol) < 1e-6 && Math.abs(inv.b - at.serRow) < 1e-6,
            `${card.file}: S-frame corner round-trips to lattice (${at.serCol},${at.serRow})`);
        cornerLog.push(`(${p.x},${p.y})@S[${c.x.toFixed(3)},${c.y.toFixed(3)}]`);
    }

    // (D4) non-null, (D5) histogram
    const h = histogramAndNonNull(grid);
    eq(h.nonNull, card.nonNull, `${card.file}: non-null count`);
    sameHistogram(h.hist, card.hist, `${card.file}: histogram`);

    // (D6) default overlay (XML multi-overlay)
    if (card.defaultOverlay) { eq(run.pickedOverlay, card.defaultOverlay, `${card.file}: default overlay`); }

    // Geometry: rotation angle (card orientation) and step magnitude (card stepMm).
    const csAng = angleDeg(placement.colStepXmm, placement.colStepYmm);
    const rsAng = angleDeg(placement.rowStepXmm, placement.rowStepYmm);
    if (card.geomAngle !== false) {
        ok(angClose(csAng, card.orientation ?? 0, 1e-4), `${card.file}: colStep angle == orientation (${csAng.toFixed(3)} vs ${card.orientation ?? 0})`);
        ok(angClose(rsAng, ((card.orientation ?? 0) - 90 + 360) % 360, 1e-4), `${card.file}: rowStep angle == orientation-90 (${rsAng.toFixed(3)})`);
    }
    if (card.stepMm) {
        close(hypot(placement.colStepXmm, placement.colStepYmm), card.stepMm[0], 1e-9, `${card.file}: |colStep| == stepX mm`);
        close(hypot(placement.rowStepXmm, placement.rowStepYmm), card.stepMm[1], 1e-9, `${card.file}: |rowStep| == stepY mm`);
    }

    const flags = [];
    if (card.correction) { flags.push('CORRECTED(' + card.correction + ')'); }
    if (card.prose) { flags.push('PROSE(' + card.prose + ')'); }
    if (card.formulaDerived) { flags.push('FORMULA(' + card.formulaDerived + ')'); }
    if (card.openGeometry) { flags.push('OPEN-GEOM(' + card.openGeometry + ')'); }
    console.log(`  [${kind}] ${card.file}: ${grid.cols}x${grid.rows} nonNull=${h.nonNull} corners=${cornerLog.join(' ')}${flags.length ? '  ' + flags.join(' ') : ''}`);
}

/* ------------------------------------------------------------------------ *
 * Run the cards.                                                            *
 * ------------------------------------------------------------------------ */
function present(dir, file) { return existsSync(join(dir, file)); }

/* ------------------------------------------------------------------------ *
 * Fixture-corpus guard (Task 2).                                            *
 *                                                                           *
 * The corpus is not vendored in this repository. It ships separately as      *
 * fixtures/{xml,json} and has to be dropped into tests/fixtures/. When it is  *
 * absent, every section below misbehaves in one of two ways:                 *
 *                                                                           *
 *   - the card loops call present() and bank one ok(false) per fixture, so   *
 *     the summary reports 35 failures that say nothing about the engine;     *
 *   - the PERFORMANCE section reads its two 600x600 inputs with a bare       *
 *     readFileSync and no present() check, so it throws ENOENT and takes the *
 *     whole file down before the summary line is ever printed.               *
 *                                                                           *
 * Neither outcome is evidence of a defect, so neither should paint the suite *
 * red. A missing corpus means "not run", and "not run" is not "failed": we   *
 * name the directory, say how many fixtures it should hold, and exit 0.      *
 *                                                                           *
 * The counts come from the card arrays above and are never hard-coded, so    *
 * adding or removing a card cannot leave this banner lying. The per-file     *
 * inventory lives in tests/README.md.                                        *
 * ------------------------------------------------------------------------ */
const XML_EXPECTED = [...XML_CARDS, ...TOLERATED_XML, ...STRUCTURAL_XML, ...INVALID_XML].map((c) => c.file);
const JSON_EXPECTED = [...JSON_CARDS, ...INVALID_JSON].map((c) => c.file);
{
    const absent = [];
    if (!existsSync(XML_DIR)) { absent.push({ kind: 'XML', dir: XML_DIR, count: XML_EXPECTED.length }); }
    if (!existsSync(JSON_DIR)) { absent.push({ kind: 'JSON', dir: JSON_DIR, count: JSON_EXPECTED.length }); }
    if (absent.length > 0) {
        console.log('\n========================================================');
        console.log('  E2E SKIPPED - fixture corpus is not installed');
        console.log('========================================================');
        for (const a of absent) {
            console.log(`  missing directory : ${a.dir}`);
            console.log(`  ${a.kind} fixtures expected there : ${a.count}`);
        }
        const total = XML_EXPECTED.length + JSON_EXPECTED.length;
        console.log(`  full corpus       : ${total} fixtures ` +
            `(${XML_EXPECTED.length} XML + ${JSON_EXPECTED.length} JSON)`);
        console.log('  inventory + install steps : tests/README.md');
        console.log('  Nothing was executed. This is a skip, not a failure -');
        console.log('  the normative and features suites are unaffected.');
        console.log('========================================================');
        process.exit(0);
    }
}

console.log('\n=== VALID XML fixtures (DOM-free chain vs cards) ===');
for (const card of XML_CARDS) {
    if (!present(XML_DIR, card.file)) { ok(false, `${card.file}: fixture missing from corpus`); continue; }
    try {
        const run = runXmlChain(readFileSync(join(XML_DIR, card.file), 'utf8'), null);
        if (!run.grid) { ok(false, `${card.file}: no renderable overlay (expected a grid)`); continue; }
        if (card.expectWarning) {
            ok(run.warnings.some((w) => w.includes(card.expectWarning)), `${card.file}: expected warning ${card.expectWarning}`);
        }
        assertCard(card, run, 'XML');
    } catch (e) {
        ok(false, `${card.file}: unexpected throw ${e && e.code ? e.code : ''} ${e && e.message}`);
    }
}

console.log('\n=== VALID JSON (GridData) fixtures (DOM-free chain vs cards) ===');
for (const card of JSON_CARDS) {
    if (!present(JSON_DIR, card.file)) { ok(false, `${card.file}: fixture missing from corpus`); continue; }
    try {
        const gd = JSON.parse(readFileSync(join(JSON_DIR, card.file), 'utf8'));
        const run = runJsonChain(gd);
        assertCard(card, run, 'JSON');
    } catch (e) {
        ok(false, `${card.file}: unexpected throw ${e && e.code ? e.code : ''} ${e && e.message}`);
    }
}

console.log('\n=== TOLERATED (XSD-invalid but processed by design) ===');
for (const card of TOLERATED_XML) {
    if (!present(XML_DIR, card.file)) { ok(false, `${card.file}: fixture missing`); continue; }
    try {
        const run = runXmlChain(readFileSync(join(XML_DIR, card.file), 'utf8'), null);
        if (!run.grid) { ok(false, `${card.file}: expected a tolerated grid`); continue; }
        ok(run.warnings.some((w) => w.includes(card.warning)), `${card.file}: expected warning ${card.warning}`);
        assertCard(card, run, 'TOL');
    } catch (e) {
        ok(false, `${card.file}: expected tolerated success, threw ${e && e.code ? e.code : ''} ${e && e.message}`);
    }
}

console.log('\n=== STRUCTURAL (no grid; parse must succeed) ===');
for (const s of STRUCTURAL_XML) {
    if (!present(XML_DIR, s.file)) { ok(false, `${s.file}: fixture missing`); continue; }
    try {
        const run = runXmlChain(readFileSync(join(XML_DIR, s.file), 'utf8'), null);
        ok(run.noRenderable === true && run.grid === null, `${s.file}: parses, no renderable overlay (${s.why})`);
        console.log(`  [STRUCT] ${s.file}: ok (no grid) - ${s.why}`);
    } catch (e) {
        ok(false, `${s.file}: parse threw ${e && e.code ? e.code : ''} ${e && e.message}`);
    }
}

console.log('\n=== INVALID fixtures (must fail with documented class) ===');
for (const inv of INVALID_XML) {
    if (!present(XML_DIR, inv.file)) { ok(false, `${inv.file}: fixture missing`); continue; }
    const xml = readFileSync(join(XML_DIR, inv.file), 'utf8');
    assertThrows(() => runXmlChain(xml, null), inv.code, `${inv.file}: throws ${inv.code} [${inv.klass}]`);
    console.log(`  [INVALID] ${inv.file}: ${inv.code} (${inv.klass})`);
}
for (const inv of INVALID_JSON) {
    if (!present(JSON_DIR, inv.file)) { ok(false, `${inv.file}: fixture missing`); continue; }
    const gd = JSON.parse(readFileSync(join(JSON_DIR, inv.file), 'utf8'));
    assertThrows(() => runJsonChain(gd), inv.code, `${inv.file}: throws ${inv.code} [${inv.klass}]`);
    console.log(`  [INVALID] ${inv.file}: ${inv.code} (${inv.klass})`);
}

/* ======================================================================== *
 * TASK O8 item 2 - PERFORMANCE
 *
 * The 600x600 XML and JSON fixtures end-to-end, plus a generated 1000x750
 * Ascii GridData payload through normalize + buildGridModel. The decoder's
 * 300 ms gate (the budget the E142Bins/E142Grid decode path is designed to
 * meet for a >=6e5-cell map) must still pass for the generated payload.
 * ======================================================================== */
/* ======================================================================== *
 * ROUND TRIP - export every valid fixture and read it back.
 *
 * Why this section exists. Everything above is an IMPORT test: it feeds a
 * document in and checks what comes out of the parser. Nothing re-exported and
 * compared, so an export defect was invisible no matter how rich the corpus
 * was - the two-level layout tree, the dropped DeviceSize, the SubstrateSide
 * that silently flipped a BottomSide map to TopSide and the missing MapVersion
 * were all present while this suite reported a clean pass.
 *
 * These assertions are PROPERTIES, not transcribed numbers: "the cells come
 * back", "the header still says what it said", "the drawn extent survives".
 * They need no expectation card and cannot drift, which is exactly what makes
 * them worth having alongside the cards.
 * ======================================================================== */
console.log('\n=== ROUND TRIP (export -> re-import) ===');

/* Optional XSD validation. Loaded dynamically so this file keeps its property
 * of running standalone: if the helper or xmllint is missing we skip that one
 * assertion rather than failing the suite on a toolchain gap. */
let validateXsd = null;
try {
    ({ validateAgainstE142Xsd: validateXsd } = await import('./lib/xsd-validate.mjs'));
} catch { validateXsd = null; }

/*
 * FIXED - two defects used to be pinned here and are not any more.
 *
 * Both were one root cause: the serializers wrote MAP-frame values into fields
 * that E142 defines as LAYOUT-frame. gridToE142Xml put the placement's pitch
 * into `Layout/StepSize`, and gridToGridData put the grid's dimensions into
 * `dimension`. Under a 90/270 orientation those frames are transposed, so the
 * importer applied the A3 swap to values that already carried it: the XML pitch
 * came back with X and Y exchanged, and the GridData row count no longer matched
 * its own payload (E142_GRID_DECODE).
 *
 * Settled by E142-0225 Table 12 - the 2DArray payload's rows correspond to the
 * layout dimensions "rotated to the coordinate system of the SubstrateMap", so
 * the PAYLOAD is map-frame - and by 12.1.2, where several SubstrateMaps may
 * share one Layout while differing in Orientation, so `Layout/*` cannot be
 * map-frame. Both serializers now undo the swap on the declared dimension and
 * physics and leave the payload alone.
 *
 * The assertions below are the ordinary ones; there is nothing special about
 * the rotated fixtures any more, which is the point.
 */

function cellsMatch(a, b) {
    if (a.cols !== b.cols || a.rows !== b.rows) { return -1; }
    let diff = 0;
    for (let i = 0; i < a.cols * a.rows; i++) {
        if (a.binTable[a.cells[i]].code !== b.binTable[b.cells[i]].code) { diff++; }
    }
    return diff;
}

for (const card of XML_CARDS) {
    if (!present(XML_DIR, card.file)) { continue; }
    let src;
    try {
        src = runXmlChain(readFileSync(join(XML_DIR, card.file), 'utf8'), null);
    } catch (e) {
        ok(false, `${card.file} [rt]: source chain threw ${e && e.code}`);
        continue;
    }
    if (!src.grid) { continue; }

    // Everything the serializer can be told, taken from the parsed document, so
    // the round trip exercises the full option surface rather than the defaults.
    const opts = {
        substrateType: String(src.header.substrateType),
        substrateId: src.header.substrateId,
        orientation: src.header.orientation,
        originLocation: src.header.originLocation,
        axisDirection: src.header.axisDirection,
        substrateSide: src.header.substrateSide,
        binType: (src.overlay.binCodeMapMeta || {}).binType,
        mapVersion: src.overlay.mapVersion,
        // RAW E142BinDefinition shape, not toEngineBinDefinition() - that maps to
        // the Engine's internal bin shape, which the serializers do not accept.
        binDefinitions: src.overlay.binDefinitions && src.overlay.binDefinitions.length
            ? src.overlay.binDefinitions
            : null,
    };
    // The DEEPEST layout on the LayoutSpecifier path - the one whose children
    // describe the emitted grid (Task 23). resolveLayoutSpecifier returns the
    // resolved geometry, not the node, so the leaf is looked up directly.
    const leafId = src.header.layoutSpecifier.split('/').map((x) => x.trim()).filter((x) => x !== '').pop();
    const srcLayout = leafId === undefined ? undefined : src.doc.layouts.find((l) => l.layoutId === leafId);
    if (srcLayout) { opts.sourceLayout = srcLayout; }

    // The Substrate record joined to this map by (SubstrateType, SubstrateId).
    const srcSub = (src.doc.substrates || []).find(
        (x) => x.substrateType === src.header.substrateType && x.substrateId === src.header.substrateId,
    );
    if (srcSub) {
        opts.lotId = srcSub.lotId;
        opts.goodDevices = srcSub.goodDevices;
        opts.supplierName = srcSub.supplierName;
        opts.status = srcSub.status;
        opts.aliasIds = srcSub.aliasIds;
        opts.carrierType = srcSub.carrierType;
        opts.carrierId = srcSub.carrierId;
        opts.slotNumber = srcSub.slotNumber;
        opts.substrateNumber = srcSub.substrateNumber;
    }

    /* ---- XML ---------------------------------------------------------- */
    let xml = null;
    try {
        xml = E142Xml.gridToE142Xml(src.grid, opts);
    } catch (e) {
        ok(false, `${card.file} [rt xml]: export threw ${e && e.code}`);
    }
    if (xml !== null) {
        if (validateXsd) {
            const v = validateXsd(xml);
            if (v.ok === null) {
                console.log(`  [rt] ${card.file}: XSD check skipped (${v.errors[0]})`);
            } else {
                ok(v.ok === true, `${card.file} [rt xml]: exported document is XSD-valid${v.ok ? '' : ' - ' + v.errors[0]}`);
            }
        }
        let back = null;
        try {
            back = runXmlChain(xml, null);
        } catch (e) {
            ok(false, `${card.file} [rt xml]: re-import threw ${e && e.code}`);
        }
        if (back && back.grid) {
            const d = cellsMatch(src.grid, back.grid);
            ok(d === 0, `${card.file} [rt xml]: cells survive (${d < 0 ? 'dims changed' : d + ' differ'})`);
            eq(back.header.substrateSide, src.header.substrateSide, `${card.file} [rt xml]: SubstrateSide survives`);
            eq(back.header.orientation, src.header.orientation, `${card.file} [rt xml]: Orientation survives`);
            eq(back.header.originLocation, src.header.originLocation, `${card.file} [rt xml]: OriginLocation survives`);
            eq(back.header.axisDirection, src.header.axisDirection, `${card.file} [rt xml]: AxisDirection survives`);
            if (src.overlay) {
                eq(back.overlay.mapVersion, src.overlay.mapVersion, `${card.file} [rt xml]: MapVersion survives`);
            }
            close(back.grid.placement.cellWmm, src.grid.placement.cellWmm, 1e-9, `${card.file} [rt xml]: DeviceSize (cellWmm) survives`);
            close(back.grid.placement.cellLmm, src.grid.placement.cellLmm, 1e-9, `${card.file} [rt xml]: DeviceSize (cellLmm) survives`);
            if (srcLayout) {
                const backLeaf = back.doc.layouts.find((l) => l.layoutId === 'L0_Devices');
                ok(backLeaf !== undefined, `${card.file} [rt xml]: the device layout is there`);
                if (backLeaf) {
                    for (const f of ['topImage', 'bottomImage', 'productId']) {
                        eq(backLeaf[f], srcLayout[f], `${card.file} [rt xml]: Layout/${f} survives`);
                    }
                    // x/y only: the export always writes an explicit Units, so a
                    // source that inherited its layout's DefaultUnits gains the
                    // key. That is the point of writing it (the emitted layout
                    // declares DefaultUnits="mm"), and the physical value is
                    // unchanged - which the placement assertions above check.
                    eq(JSON.stringify(backLeaf.lowerLeft && { x: backLeaf.lowerLeft.x, y: backLeaf.lowerLeft.y }),
                        JSON.stringify(srcLayout.lowerLeft && { x: srcLayout.lowerLeft.x, y: srcLayout.lowerLeft.y }),
                        `${card.file} [rt xml]: Layout/LowerLeft survives`);
                    eq(JSON.stringify(backLeaf.z), JSON.stringify(srcLayout.z),
                        `${card.file} [rt xml]: Layout/Z survives`);
                    eq(backLeaf.package, srcLayout.package, `${card.file} [rt xml]: Layout/@Package survives`);
                }
            }
            if (srcSub) {
                const backSub = (back.doc.substrates || []).find(
                    (x) => x.substrateType === back.header.substrateType && x.substrateId === back.header.substrateId,
                );
                ok(backSub !== undefined,
                    `${card.file} [rt xml]: the Substrate record is still joined by (SubstrateType, SubstrateId)`);
                if (backSub) {
                    for (const f of ['lotId', 'goodDevices', 'supplierName', 'status',
                        'carrierType', 'carrierId', 'slotNumber', 'substrateNumber']) {
                        eq(backSub[f], srcSub[f], `${card.file} [rt xml]: Substrate/${f} survives`);
                    }
                    eq(JSON.stringify(backSub.aliasIds), JSON.stringify(srcSub.aliasIds),
                        `${card.file} [rt xml]: Substrate/aliasIds survive entry-for-entry`);
                }
            }
        } else if (back) {
            ok(false, `${card.file} [rt xml]: re-import produced no grid`);
        }
    }

    /* ---- GridData ------------------------------------------------------ */
    let gd = null;
    try {
        gd = E142Grid.gridToGridData(src.grid, opts);
    } catch (e) {
        ok(false, `${card.file} [rt gd]: export threw ${e && e.code}`);
    }
    if (gd !== null) {
        let back = null;
        try {
            back = runJsonChain(gd);
        } catch (e) {
            ok(false, `${card.file} [rt gd]: re-import threw ${e && e.code}`);
        }
        if (back && back.grid) {
            const d = cellsMatch(src.grid, back.grid);
            ok(d === 0, `${card.file} [rt gd]: cells survive (${d < 0 ? 'dims changed' : d + ' differ'})`);
            close(back.grid.placement.cellWmm, src.grid.placement.cellWmm, 1e-9, `${card.file} [rt gd]: deviceSize (cellWmm) survives`);
            close(back.grid.placement.cellLmm, src.grid.placement.cellLmm, 1e-9, `${card.file} [rt gd]: deviceSize (cellLmm) survives`);
            if (srcSub) {
                eq(gd.lotId, srcSub.lotId, `${card.file} [rt gd]: lotId survives`);
                eq(gd.goodDevices, srcSub.goodDevices, `${card.file} [rt gd]: goodDevices survives`);
            }
        }
    }
}

console.log('\n=== PERFORMANCE (item 2) ===');
const DECODER_GATE_MS = 300;

/** Median of several timed runs (ms), to damp JIT warm-up and GC jitter. */
function timeMedian(fn, runs) {
    const xs = [];
    for (let r = 0; r < runs; r++) { const t0 = performance.now(); fn(); xs.push(performance.now() - t0); }
    xs.sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
}

// 600x600 XML end-to-end (parse -> ... -> buildGridModel).
{
    const xml = readFileSync(join(XML_DIR, 'v0211-perf-600x600-ascii.xml'), 'utf8');
    runXmlChain(xml, null); // warm
    const ms = timeMedian(() => { const r = runXmlChain(xml, null); if (!r.grid) { throw new Error('perf xml built no grid'); } }, 5);
    console.log(`  600x600 XML end-to-end (parse->buildGridModel): ${ms.toFixed(1)} ms (median of 5)`);
    ok(Number.isFinite(ms), '600x600 XML timing produced');
}

// 600x600 JSON end-to-end (normalize -> buildGridModel).
{
    const gd = JSON.parse(readFileSync(join(JSON_DIR, 'json-perf-600x600-ascii.json'), 'utf8'));
    runJsonChain(gd); // warm
    const ms = timeMedian(() => { const r = runJsonChain(gd); if (!r.grid) { throw new Error('perf json built no grid'); } }, 5);
    console.log(`  600x600 JSON end-to-end (normalize->buildGridModel): ${ms.toFixed(1)} ms (median of 5)`);
    ok(Number.isFinite(ms), '600x600 JSON timing produced');
}

// Generated 1000x750 Ascii GridData through normalize + buildGridModel; 300 ms gate.
{
    const COLS = 1000;
    const ROWS = 750;
    const CELLS = COLS * ROWS; // 750,000
    // Deterministic round-wafer-ish pattern: '.' outside a disc, '9' on a sparse
    // lattice inside, '1' otherwise. Built once, outside the timed region.
    const rows = new Array(ROWS);
    const cx = (COLS - 1) / 2;
    const cy = (ROWS - 1) / 2;
    const rr = Math.min(cx, cy) * 0.98;
    const rr2 = rr * rr;
    for (let r = 0; r < ROWS; r++) {
        const line = new Array(COLS);
        for (let c = 0; c < COLS; c++) {
            const dx = c - cx;
            const dy = r - cy;
            if (dx * dx + dy * dy > rr2) { line[c] = '.'; }
            else if (((c * 7 + r * 13) % 97) === 0) { line[c] = '9'; }
            else { line[c] = '1'; }
        }
        rows[r] = line.join('');
    }
    const gd = {
        substrateId: 'PERF-1000x750',
        dimension: { x: COLS, y: ROWS },
        units: 'mm',
        binType: 'Ascii',
        mapType: '2DArray',
        nullBin: '.',
        bins: rows,
        stepSize: { x: 0.1, y: 0.1 },
    };
    // Warm, then time normalize + buildGridModel (the decoder path the gate covers).
    runJsonChain(gd);
    const ms = timeMedian(() => {
        const norm = E142Grid.normalizeGridData(gd);
        const pr = E142.computeGridPlacement(norm.header, norm.resolvedLayout, 0, undefined);
        const grid = Engine.buildGridModel(pr.placement, norm.payload, norm.binDefs ? norm.binDefs.map(toEngineBinDefinition) : null);
        if (!grid || grid.cols !== COLS || grid.rows !== ROWS) { throw new Error('generated grid wrong'); }
    }, 5);
    // Independent cell count for the log (read path).
    const norm = E142Grid.normalizeGridData(gd);
    let nn = 0;
    for (let k = 0; k < CELLS; k++) { if (norm.payload.cells[k] !== 0) { nn++; } }
    console.log(`  1000x750 generated (${CELLS} cells) normalize+buildGridModel: ${ms.toFixed(1)} ms (median of 5); non-null=${nn}`);
    ok(ms < DECODER_GATE_MS, `1000x750 decode within ${DECODER_GATE_MS} ms gate (was ${ms.toFixed(1)} ms)`);
}

console.log('\n=== ENGINE COUNTERS (JSON spec Task 2a) ===');
{
    /*
     * The counters exist so Task 2c can ask how often one control attach parses
     * and how often it rebuilds a placement. Two properties matter and both are
     * executed here, not read out of the source: OFF costs nothing observable,
     * and ON counts entries rather than something adjacent to them.
     *
     * `parses` counts ENTRIES into parseE142Xml, deliberately - a document that
     * throws halfway still consumed a parse, and a counter that only saw
     * successes would understate exactly the pathological case worth measuring.
     */
    const drive = () => {
        const xml = readFileSync(join(XML_DIR, 'v0125-all-header-facts.xml'), 'utf8');
        const parsed = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
        const sm = parsed.doc.substrateMaps[0];
        const ov = sm.overlays.find((o) => o.payload !== undefined);
        E142.computeGridPlacement(sm.header, E142.dimsFromPayload(ov.payload), 0, undefined);
    };

    ok(E142.engineCountersEnabled() === false, 'counters are OFF by default');
    const atStart = E142.readEngineCounters();
    eq(atStart.parses, 0, '  and have counted no parse through this whole suite');
    eq(atStart.placements, 0, '  nor any placement build');

    drive();
    const stillOff = E142.readEngineCounters();
    eq(stillOff.parses, 0, 'driving the pipeline with counters off changes nothing: parses');
    eq(stillOff.placements, 0, '  placements');

    E142.setEngineCountersEnabled(true);
    drive();
    drive();
    const on = E142.readEngineCounters();
    eq(on.parses, 2, 'with counters on, two runs report two parses');
    eq(on.placements, 2, '  and two placement builds');

    E142.resetEngineCounters();
    const afterReset = E142.readEngineCounters();
    eq(afterReset.parses, 0, 'reset zeroes the totals');
    ok(E142.engineCountersEnabled() === true, '  and leaves the enabled flag alone');

    /* A throwing parse still counted, per the contract above. */
    let threw = false;
    try { E142Xml.parseE142Xml('<nope/>', { parseDocument: stubParseDocument }); } catch { threw = true; }
    ok(threw, 'a non-E142 document still throws');
    eq(E142.readEngineCounters().parses, 1, '  and is still counted: entries, not successes');

    E142.setEngineCountersEnabled(false);
    E142.resetEngineCounters();
    drive();
    eq(E142.readEngineCounters().parses, 0, 'switching back off stops counting again');
}

/* ======================================================================== *
 * Summary
 * ======================================================================== */
console.log('\n========================================================');
console.log(`  RESULT: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) {
    console.log('  FAILURES:');
    for (const f of FAILURES) { console.log('   - ' + f); }
}
console.log('========================================================');
process.exit(FAIL > 0 ? 1 : 0);
