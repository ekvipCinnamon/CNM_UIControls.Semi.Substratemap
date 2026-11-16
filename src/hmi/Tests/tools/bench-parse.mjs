/*
 * bench-parse.mjs - where the time actually goes: envelope parse vs payload decode.
 *
 * WHY. The JSON feature's premise is that a typed JSON envelope beats an escaped
 * XML string. The spec's own preamble already measured the BYTES and found the
 * envelope is 5.2 % of an XML document and 0.4 % of a JSON one - so whatever
 * ratio JSON wins on parsing, it wins it on a twentieth of the file. This tool
 * measures the TIME behind that claim before any of the feature is built, so
 * Task 17 has something to compare against and nobody optimises the wrong half.
 *
 * THREE CAVEATS, and they all cut against the feature rather than for it. They
 * are printed with the table, not just written here.
 *
 *  1. The XML column uses `tests/xml-stub.mjs`, a hand-written JS parser. The
 *     browser uses a native `DOMParser`. This number is therefore a PESSIMISTIC
 *     proxy - the real XML envelope cost is lower, probably much lower.
 *  2. `JSON.parse` is native C++. So the envelope comparison is hand-written JS
 *     against a C++ builtin, which flatters JSON twice over. A JSON win here is
 *     evidence of almost nothing; a JSON LOSS would be worth acting on.
 *  3. The JSON column is **GridData v1**, not the E142 JSON envelope that Task 5
 *     has yet to specify. It is measured because it is the real, delivered typed
 *     JSON path this feature extends - but it is a proxy, and Task 17 must
 *     re-measure against `parseE142Json` once that exists.
 *
 * The DECODE column is format-independent by construction: both representations
 * carry the same E142 token text (ground truth 1), so `decodeBinPayload` is
 * given identical input either way and is measured once per case.
 *
 * The generated documents are checked by DECODING them before anything is timed
 * - a generator that emits subtly wrong tokens would otherwise produce a fast,
 * meaningless benchmark.
 *
 * Run: node tools/bench-parse.mjs [--quick]
 *      --quick trims the 1200x1200 row, which dominates the wall time.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = join(ROOT, 'Helpers/SubstrateMapEngine');
const FIXTURES = join(ENGINE, 'tests/fixtures');
const asUrl = (p) => 'file://' + p;

globalThis.TcHmi ??= { Controls: {} };
const { stubParseDocument } = await import(asUrl(join(ENGINE, 'tests/xml-stub.mjs')));
const E142Bins = await import(asUrl(join(ENGINE, 'E142Bins.js')));
const E142Xml = await import(asUrl(join(ENGINE, 'E142Xml.js')));
const E142Grid = await import(asUrl(join(ENGINE, 'E142Grid.js')));
const E142Json = await import(asUrl(join(ENGINE, 'E142Json.js')));

/* ------------------------------------------------------------ generation */

/**
 * The canonical token for a bin value, per the grammar `E142Bins` documents:
 * Ascii one character, Decimal three zero-padded digits, HexaDecimal two
 * uppercase hex digits, Integer2 four. Re-implemented here rather than imported
 * because the engine's `tokenFromValue` is module-private; {@link validate}
 * checks the result against the real decoder instead of trusting this.
 * @param binType The bin type.
 * @param value   A legal value for that type.
 * @returns The token.
 */
function tokenOf(binType, value) {
    switch (binType) {
        case 'Ascii': return String.fromCharCode(value);
        case 'Decimal': return String(value).padStart(3, '0');
        case 'HexaDecimal': return value.toString(16).toUpperCase().padStart(2, '0');
        case 'Integer2': return value.toString(16).toUpperCase().padStart(4, '0');
        default: throw new Error('unknown BinType ' + binType);
    }
}

/**
 * Forces a rope/cons string into V8's flat representation. `slice` on a
 * concatenation flattens; the leading space keeps the result byte-identical.
 * @param s Any string.
 * @returns The same string, flat.
 */
function flatten(s) { return (' ' + s).slice(1); }

/** Bin values per type: null, pass, fail. Ascii uses '.', '1', '9' as the corpus does. */
const VALUES = {
    Ascii: { nul: 0x2e, pass: 0x31, fail: 0x39 },
    Decimal: { nul: 0, pass: 1, fail: 9 },
    HexaDecimal: { nul: 0, pass: 1, fail: 9 },
    Integer2: { nul: 0, pass: 1, fail: 9 },
};

/**
 * A deterministic round-wafer payload, shaped like the delivered perf fixtures:
 * cells outside the inscribed circle are the null bin, ~2 % of the rest fail.
 * @param n       Side length; the lattice is n x n.
 * @param binType The bin type.
 * @returns `{ rows, nullBin, fails }` - one token string per row.
 */
function makePayload(n, binType) {
    const v = VALUES[binType];
    const sep = binType === 'Decimal' ? ' ' : '';
    const [NUL, PASS, FAIL] = [tokenOf(binType, v.nul), tokenOf(binType, v.pass), tokenOf(binType, v.fail)];
    const c = (n - 1) / 2;
    const r2 = (n / 2 * 0.98) ** 2;
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const rows = [];
    let fails = 0;
    for (let y = 0; y < n; y++) {
        const out = new Array(n);
        for (let x = 0; x < n; x++) {
            if ((x - c) ** 2 + (y - c) ** 2 > r2) { out[x] = NUL; continue; }
            if (next() < 0.02) { out[x] = FAIL; fails++; } else { out[x] = PASS; }
        }
        // FLATTENED on purpose. Array.join leaves V8 a rope/cons string, and
        // decoding one is ~40 % slower than decoding a flat one - which the real
        // path always has, because its rows are substrings of a parsed document.
        // Measured: 18.5 ms vs 13.1 ms for 600x600 Decimal. Without this the
        // decode column reports V8's string representation, not the decoder.
        rows.push(flatten(out.join(sep)));
    }
    return { rows, nullBin: NUL, fails };
}

/**
 * A minimal, layoutless E142 `MapData` around a 2DArray payload. Layoutless is
 * deliberate: `2DArray` describes its own lattice, so no `<Layouts>` is needed
 * and the envelope stays the thing being measured rather than a document tour.
 * @param rows     Payload rows.
 * @param binType  The bin type.
 * @param nullBin  The null token.
 * @returns The document text.
 */
function toXml(rows, binType, nullBin) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<MapData xmlns="urn:semi-org:xsd.E142-1.V0125.SubstrateMap">\n'
        + '  <SubstrateMaps>\n'
        + `    <SubstrateMap SubstrateType="Wafer" SubstrateId="BENCH" LayoutSpecifier=""`
        + ` Orientation="0" OriginLocation="LowerLeft" AxisDirection="UpRight">\n`
        + '      <Overlay MapName="BinCodes">\n'
        + `        <BinCodeMap BinType="${binType}" NullBin="${nullBin}" MapType="2DArray">\n`
        + rows.map((r) => `          <BinCode>${r}</BinCode>`).join('\n') + '\n'
        + '        </BinCodeMap>\n      </Overlay>\n    </SubstrateMap>\n  </SubstrateMaps>\n</MapData>\n';
}

/**
 * The same payload as a GridData v1 document - the shape the delivered
 * `json-perf-600x600-ascii.json` fixture uses, minus its fixture note.
 * @param rows    Payload rows.
 * @param n       Side length.
 * @param binType The bin type.
 * @param nullBin The null token.
 * @returns The document text.
 */
function toGridDataJson(rows, n, binType, nullBin) {
    return JSON.stringify({
        dimension: { x: n, y: n },
        units: 'mm',
        stepSize: { x: 0.1, y: 0.1 },
        orientation: 0,
        originLocation: 'LowerLeft',
        axisDirection: 'UpRight',
        binType,
        nullBin,
        mapType: '2DArray',
        binDefinitions: [{ binCode: tokenOf(binType, VALUES[binType].pass), binQuality: 'Pass' },
            { binCode: tokenOf(binType, VALUES[binType].fail), binQuality: 'Fail' }],
        bins: rows,
        substrateId: 'BENCH',
    });
}

/* -------------------------------------------------------------- timing */

/**
 * Median of 20 timed runs after 5 warm-ups, in milliseconds.
 * @param fn The thing to time; its return value is kept so V8 cannot elide it.
 * @returns The median duration in ms.
 */
function bench(fn) {
    let sink = null;
    for (let i = 0; i < 5; i++) { sink = fn(); }
    const ms = [];
    for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        sink = fn();
        ms.push(performance.now() - t0);
    }
    if (sink === undefined) { throw new Error('benched function returned undefined'); }
    ms.sort((a, b) => a - b);
    return (ms[9] + ms[10]) / 2;
}

/* ------------------------------------------------------------ the cases */

const QUICK = process.argv.includes('--quick');
/*
 * `--smoke` exists so a GATED test can run this tool and check that it still
 * produces a table. `--quick` takes 11 s, which would triple the cost of
 * `node --test`; one 50x50 lattice takes well under a second and exercises every
 * code path the larger sizes do. It is for proving the instrument works, never for
 * quoting a number - 50x50 is far too small for the envelope not to dominate.
 */
const SMOKE = process.argv.includes('--smoke');
const SIZES = SMOKE ? [50] : QUICK ? [200, 600] : [200, 600, 1200];
const BIN_TYPES = ['Ascii', 'Decimal', 'HexaDecimal', 'Integer2'];

/**
 * Decodes a generated payload through the real engine and checks it against the
 * generator's own count. A generator that emits wrong tokens would otherwise
 * time a document that means nothing.
 * @param rows    Payload rows.
 * @param n       Side length.
 * @param binType The bin type.
 * @param nullBin The null token.
 * @param fails   How many fail cells the generator placed.
 */
function validate(rows, n, binType, nullBin, fails) {
    const meta = { binType, nullBin, mapType: '2DArray' };
    const decoded = E142Bins.decodeBinPayload(meta, { cols: n, rows: n }, rows);
    if (decoded.cells.length !== n * n) {
        throw new Error(`${binType} ${n}x${n}: decoded ${decoded.cells.length} cells, expected ${n * n}`);
    }
    const failToken = tokenOf(binType, VALUES[binType].fail);
    const failIndex = decoded.codes.indexOf(failToken);
    let seen = 0;
    for (let i = 0; i < decoded.cells.length; i++) { if (decoded.cells[i] === failIndex) { seen++; } }
    if (seen !== fails) {
        throw new Error(`${binType} ${n}x${n}: decoder found ${seen} fail cells, generator placed ${fails}`);
    }
}

/*
 * GLOBAL warm-up, before any timing at all.
 *
 * The per-case 5 runs inside bench() are not enough on their own: the first
 * cases measured pay for V8 optimising code paths that every later case then
 * gets for free, and the first table produced this way showed 200x200 decoding
 * FOUR TIMES SLOWER than 1200x1200. A non-monotonic benchmark is not a slow
 * finding, it is a wrong one, and Task 17 would have compared against it.
 */
for (const binType of BIN_TYPES) {
    const { rows, nullBin } = makePayload(300, binType);
    const xml = toXml(rows, binType, nullBin);
    const json = toGridDataJson(rows, 300, binType, nullBin);
    for (let i = 0; i < 3; i++) {
        stubParseDocument(xml);
        JSON.parse(json);
        E142Bins.decodeBinPayload({ binType, nullBin, mapType: '2DArray' }, { cols: 300, rows: 300 }, rows);
        E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument });
        E142Grid.normalizeGridData(JSON.parse(json));
    }
}

const results = [];
for (const n of SIZES) {
    for (const binType of BIN_TYPES) {
        const { rows, nullBin, fails } = makePayload(n, binType);
        validate(rows, n, binType, nullBin, fails);
        const xml = toXml(rows, binType, nullBin);
        const json = toGridDataJson(rows, n, binType, nullBin);
        const payloadBytes = rows.reduce((a, r) => a + r.length, 0);
        results.push({
            n, binType,
            xmlBytes: xml.length, jsonBytes: json.length, payloadBytes,
            xmlEnvelope: bench(() => stubParseDocument(xml)),
            jsonEnvelope: bench(() => JSON.parse(json)),
            decode: bench(() => E142Bins.decodeBinPayload({ binType, nullBin, mapType: '2DArray' },
                { cols: n, rows: n }, rows)),
            xmlTotal: bench(() => E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument })),
            jsonTotal: bench(() => E142Grid.normalizeGridData(JSON.parse(json))),
        });
    }
}

/* The delivered fixtures, as an anchor: if the generator drifted from what the
 * corpus actually contains, these two rows will not sit near the generated
 * 600x600 Ascii row. */
const anchorXml = readFileSync(join(FIXTURES, 'xml/v0211-perf-600x600-ascii.xml'), 'utf8');
const anchorJson = readFileSync(join(FIXTURES, 'json/json-perf-600x600-ascii.json'), 'utf8');
const anchor = {
    xmlBytes: anchorXml.length, jsonBytes: anchorJson.length,
    xmlEnvelope: bench(() => stubParseDocument(anchorXml)),
    jsonEnvelope: bench(() => JSON.parse(anchorJson)),
    xmlTotal: bench(() => E142Xml.parseE142Xml(anchorXml, { parseDocument: stubParseDocument })),
    jsonTotal: bench(() => E142Grid.normalizeGridData(JSON.parse(anchorJson))),
};

/* ==================================================================== *
 * The three representations of ONE document (Tasks 16-17)
 *
 * The block above compares an XML envelope with a GridData one, which is what
 * existed when Task 4 ran and which its own caveat 3 flagged as a proxy: GridData
 * is a different contract, and the E142 JSON envelope did not exist yet. This
 * block discharges that caveat. All three inputs below parse to the SAME
 * `E142Document`, so the comparison is finally like for like:
 *
 *   XML          the token text in E142.1 elements
 *   JSON         the token text in the E142 JSON envelope (Task 5)
 *   JSON+binary  the same document with `$binary` index blocks (Task 16)
 *
 * The size result is arithmetic - base64 of two bytes is 2.67 characters per cell,
 * against one token character for Ascii and four for Decimal - and the timing is
 * not, so both are measured rather than either being reasoned about.
 * ==================================================================== */

/**
 * Measures one document in all three representations.
 * @param n       Side length of the square lattice.
 * @param binType The bin type.
 * @returns One row of the three-way table.
 */
function measureThreeWays(n, binType) {
    const { rows, nullBin } = makePayload(n, binType);
    const xml = toXml(rows, binType, nullBin);
    const doc = E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument }).doc;
    const token = E142Json.e142DocumentToJson(doc);
    const binary = E142Json.e142DocumentToJson(doc, { binary: true });

    return {
        n, binType,
        xmlBytes: xml.length, tokenBytes: token.length, binaryBytes: binary.length,
        xmlMs: bench(() => E142Xml.parseE142Xml(xml, { parseDocument: stubParseDocument })),
        tokenMs: bench(() => E142Json.parseE142Json(token)),
        binaryMs: bench(() => E142Json.parseE142Json(binary)),
    };
}

const threeWay = [];
for (const n of SIZES) {
    for (const binType of BIN_TYPES) { threeWay.push(measureThreeWays(n, binType)); }
}

/**
 * Renders the three-way result as markdown, for the README.
 *
 * GENERATED, never typed. Task 16's Done-when asks for that, and the reason is not
 * tidiness: a hand-typed performance table is a claim nobody re-checks, and this
 * one contains a result that contradicts the feature's own premise for half the
 * bin types. A number that inconvenient has to be reproducible on demand, or it
 * will quietly be corrected into something nicer.
 * @returns The markdown block.
 */
function renderMarkdown() {
    const kb = (b) => (b / 1024).toFixed(0);
    const rel = (a, b) => {
        const p = (a / b - 1) * 100;
        return `${p > 0 ? '+' : ''}${p.toFixed(0)} %`;
    };
    const out = [];
    out.push('Sizes, one document written three ways. Generated by `node tools/bench-parse.mjs');
    out.push('--write-readme`; do not edit by hand.');
    out.push('');
    out.push('| lattice | `BinType` | XML | JSON | JSON `$binary` | binary vs XML | binary vs JSON |');
    out.push('|---|---|---|---|---|---|---|');
    for (const r of threeWay) {
        const verdict = r.binaryBytes < r.tokenBytes ? 'smaller' : '**LARGER**';
        out.push(`| ${r.n}\u00d7${r.n} | \`${r.binType}\` | ${kb(r.xmlBytes)} kB | `
            + `${kb(r.tokenBytes)} kB | ${kb(r.binaryBytes)} kB | ${rel(r.binaryBytes, r.xmlBytes)} | `
            + `${rel(r.binaryBytes, r.tokenBytes)} ${verdict} |`);
    }
    out.push('');
    out.push('Parse time to an `E142Document`, median of 20 runs after 5 warm-ups, milliseconds:');
    out.push('');
    out.push('| lattice | `BinType` | XML | JSON | JSON `$binary` |');
    out.push('|---|---|---|---|---|');
    for (const r of threeWay) {
        out.push(`| ${r.n}\u00d7${r.n} | \`${r.binType}\` | ${r.xmlMs.toFixed(1)} | `
            + `${r.tokenMs.toFixed(1)} | ${r.binaryMs.toFixed(1)} |`);
    }
    return out.join('\n');
}

if (process.argv.includes('--write-readme')) {
    const README = join(ROOT, 'README.md');
    const text = readFileSync(README, 'utf8');
    const OPEN = '<!-- BENCH:SIZES:BEGIN -->';
    const CLOSE = '<!-- BENCH:SIZES:END -->';
    const from = text.indexOf(OPEN);
    const to = text.indexOf(CLOSE);
    if (from === -1 || to === -1) {
        console.error(`\nREADME.md has no ${OPEN} ... ${CLOSE} block to fill. Add one first: this tool `
            + 'replaces a marked region rather than guessing where the table belongs.');
        process.exit(1);
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const body = renderMarkdown().split('\n').join(eol);
    writeFileSync(README, text.slice(0, from + OPEN.length) + eol + eol + body + eol + eol + text.slice(to));
    console.log(`\n  README.md updated between ${OPEN} and ${CLOSE}`);
}

/* -------------------------------------------------------------- report */

const f = (x) => x.toFixed(2).padStart(8);
const b = (x) => (x / 1024).toFixed(0).padStart(7);
console.log('\nbench-parse - median of 20 runs after 5 warm-ups, milliseconds\n');
console.log('  size  BinType       XMLenv   JSONenv    decode  XMLtotal JSONtotal |   XMLkB  JSONkB  env%XML env%JSON');
console.log('  ' + '-'.repeat(105));
for (const r of results) {
    const envXml = 100 * (r.xmlBytes - r.payloadBytes) / r.xmlBytes;
    const envJson = 100 * (r.jsonBytes - r.payloadBytes) / r.jsonBytes;
    console.log(`  ${String(r.n).padStart(4)}  ${r.binType.padEnd(12)}${f(r.xmlEnvelope)}${f(r.jsonEnvelope)}`
        + `${f(r.decode)}${f(r.xmlTotal)}${f(r.jsonTotal)} | ${b(r.xmlBytes)}${b(r.jsonBytes)}`
        + `${envXml.toFixed(1).padStart(9)}%${envJson.toFixed(1).padStart(8)}%`);
}
console.log('\n  delivered 600x600 Ascii fixtures, for comparison with the generated row above:');
console.log(`  anchor              ${f(anchor.xmlEnvelope)}${f(anchor.jsonEnvelope)}        -`
    + `${f(anchor.xmlTotal)}${f(anchor.jsonTotal)} | ${b(anchor.xmlBytes)}${b(anchor.jsonBytes)}`);

console.log('\nthree representations of ONE document - all parse to the same E142Document\n');
console.log('  size  BinType         XMLkB   JSONkB    BINkB    XMLms   JSONms    BINms   binary vs JSON');
console.log('  ' + '-'.repeat(97));
for (const r of threeWay) {
    const d = r.binaryBytes / r.tokenBytes;
    console.log(`  ${String(r.n).padStart(4)}  ${r.binType.padEnd(14)}`
        + `${(r.xmlBytes / 1024).toFixed(0).padStart(6)}${(r.tokenBytes / 1024).toFixed(0).padStart(9)}`
        + `${(r.binaryBytes / 1024).toFixed(0).padStart(9)}`
        + `${r.xmlMs.toFixed(1).padStart(9)}${r.tokenMs.toFixed(1).padStart(9)}`
        + `${r.binaryMs.toFixed(1).padStart(9)}`
        + `   ${d.toFixed(2)}x ${d < 1 ? 'smaller' : 'LARGER'}`);
}

console.log(`
  READ THIS BEFORE QUOTING ANY NUMBER ABOVE.

  1. XMLenv uses tests/xml-stub.mjs, a HAND-WRITTEN JS parser. The browser uses a
     native DOMParser. This column is a PESSIMISTIC proxy and the real XML
     envelope cost is lower - overstating it would flatter this whole feature.
  2. JSONenv is JSON.parse, a native C++ builtin. The envelope comparison is
     therefore hand-written JS against C++. A JSON win here means little; a JSON
     loss would mean a lot.
  3. JSONenv / JSONtotal measure GridData v1, NOT the E142 JSON envelope Task 5
     has yet to specify. Real, delivered, and the pattern this feature extends -
     but a proxy. Task 17 must re-measure against parseE142Json.
  4. decode is shared: both representations carry the same E142 token text, so
     decodeBinPayload sees identical input either way. It is measured once.
  5. The THREE-WAY block is like for like: all three inputs parse to the same
     E142Document, which the GridData column above them does not. That column is
     Task 4's and is kept because the size claim in the JSON spec's preamble rests
     on it; its caveat 3 is discharged by the block below.
  6. decode is an UPPER BOUND. It re-decodes one array in a tight loop, which is
     ~25 % dearer than decoding freshly parsed input (1200x1200 Decimal: 51 ms
     reused vs 40 ms fresh) - an allocation-locality effect, not a property of
     the decoder. Run-to-run spread at 1200x1200 is around +-20 % too. Read the
     RELATIVE picture, which is stable: decode dominates at every size, and the
     envelope's share shrinks as maps grow.
`);
