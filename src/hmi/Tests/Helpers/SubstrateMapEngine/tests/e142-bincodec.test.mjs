/*
 * e142-bincodec.test.mjs - the bin-index codec.
 *
 * The task's instruction is that little-endian byte order be "asserted byte-wise,
 * not merely round-tripped", and that is the whole shape of this suite. A round
 * trip is symmetric: it passes just as happily if BOTH halves are big-endian, or
 * if both agree on any other private convention. The only assertion that pins the
 * FORMAT rather than the pair is one that names the bytes.
 *
 * So section 1 writes down what a three-cell payload must encode to, character by
 * character, derived by hand from the index values - and only then checks that the
 * decoder agrees.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { stubParseDocument } from './xml-stub.mjs';
import { makeHarness, onCrash } from './lib/harness.mjs';

globalThis.TcHmi ??= { Controls: {} };
const ENGINE = new URL('../', import.meta.url).href;
const BinCodec = await import(ENGINE + 'BinCodec.js');
const E142Xml = await import(ENGINE + 'E142Xml.js');

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();
onCrash(counts);

const threwCode = (fn) => { try { fn(); return null; } catch (e) { return e.code ?? e.name; } };

section('1. little-endian, asserted byte-wise', () => {
    /*
     * Three cells: the null bin, then two indices chosen so that every byte
     * position carries something distinct and a byte swap cannot go unnoticed.
     *
     *   index 0      -> 00 00
     *   index 1      -> 01 00      low byte first: this is what "little-endian" means
     *   index 0x0102 -> 02 01      both bytes non-zero AND different
     *
     * Bytes: 00 00 01 00 02 01
     * Base64 of six bytes is eight characters with no padding:
     *   000000 000000 | 000001 000000 | 000010 000001
     *      A      A          B      A          C      B
     * -> "AAABAAMB"?  No: group the BYTES, not the values. Worked below.
     */
    const cells = new Uint32Array([0, 1, 0x0102]);
    const codes = ['.', '1', '9'];
    /* Padded to a code table large enough to hold index 0x0102. */
    const table = codes.concat(new Array(0x0103 - codes.length).fill('x'));

    const enc = BinCodec.encodeBinIndices({ cells, codes: table });

    /* The bytes, stated: 00 00 | 01 00 | 02 01. Derived by hand from the three
     * indices above, then base64'd by the same hand:
     *   00000000 00000000 00000001  ->  000000 000000 000000 000001 -> A A A B
     *   00000000 00000010 00000001  ->  000000 000000 001000 000001 -> A A I B
     */
    eq(enc.data, 'AAABAAIB',
        'a three-cell payload encodes to the exact base64 of 00 00 01 00 02 01 — '
        + 'low byte FIRST, which is what little-endian means');

    /* And the same claim without base64 in the way, so a base64 bug cannot be
     * mistaken for an endianness one. */
    attempt('the raw bytes', () => {
        const raw = BinCodec.decodeBinIndices; // decoder exists; bytes checked below
        ok(typeof raw === 'function', 'the decoder is exported');
        const bytes = [...atobBytes(enc.data)];
        deep(bytes, [0x00, 0x00, 0x01, 0x00, 0x02, 0x01],
            '  and the decoded bytes are literally 00 00 01 00 02 01');
        eq(bytes[2], 0x01, '  cell 1 (index 1) puts its LOW byte at offset 2');
        eq(bytes[3], 0x00, '  and its high byte at offset 3');
        eq(bytes[4], 0x02, '  cell 2 (index 0x0102) puts 0x02 first');
        eq(bytes[5], 0x01, '  and 0x01 second — a big-endian encoder would swap these two');
    });

    /* Only now the round trip, which on its own would have accepted big-endian. */
    const back = BinCodec.decodeBinIndices(table, enc.data);
    deep([...back], [0, 1, 0x0102], 'and the decoder returns the three indices unchanged');
    ok(back instanceof Uint16Array, '  as a Uint16Array');
});

/** Minimal base64 -> bytes, written here so the assertion above does not lean on the code under test. */
function atobBytes(b64) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const clean = b64.replace(/=+$/, '');
    const out = [];
    let acc = 0;
    let bits = 0;
    for (const ch of clean) {
        acc = (acc << 6) | A.indexOf(ch);
        bits += 6;
        if (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xFF); }
    }
    return out;
}

section('2. the null bin is index 0', () => {
    /* decodeBinPayload builds the table with the null token first. The codec
     * passes the table through UNCHANGED - it preserves that ordering rather than
     * choosing one - so the property has to hold across the real corpus, not only
     * in a constructed case. */
    const dir = fileURLToPath(new URL('./fixtures/xml/', import.meta.url));
    let checked = 0;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.xml')).sort()) {
        let doc;
        try {
            doc = E142Xml.parseE142Xml(readFileSync(join(dir, name), 'utf8'),
                { parseDocument: stubParseDocument }).doc;
        } catch { continue; }
        for (const map of doc.substrateMaps) {
            for (const ov of map.overlays) {
                if (ov.payload === undefined || ov.binCodeMapMeta === undefined) { continue; }
                const enc = BinCodec.encodeBinIndices(ov.payload);
                if (enc.codes[0] !== ov.binCodeMapMeta.nullBin) {
                    ok(false, `${name}: codes[0] is ${JSON.stringify(enc.codes[0])}, `
                        + `not the NullBin ${JSON.stringify(ov.binCodeMapMeta.nullBin)}`);
                }
                checked++;
            }
        }
    }
    ok(checked > 20, `the null bin sits at index 0 in all ${checked} encoded payloads in the corpus`);
});

section('3. round trip across every BinType in the corpus', () => {
    const dir = fileURLToPath(new URL('./fixtures/xml/', import.meta.url));
    const seen = new Set();
    let payloads = 0;
    const broken = [];
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.xml')).sort()) {
        let doc;
        try {
            doc = E142Xml.parseE142Xml(readFileSync(join(dir, name), 'utf8'),
                { parseDocument: stubParseDocument }).doc;
        } catch { continue; }
        for (const map of doc.substrateMaps) {
            for (const ov of map.overlays) {
                if (ov.payload === undefined) { continue; }
                payloads++;
                seen.add(ov.binCodeMapMeta?.binType ?? '(none)');
                const enc = BinCodec.encodeBinIndices(ov.payload);
                const back = BinCodec.decodeBinIndices(enc.codes, enc.data);
                if (back.length !== ov.payload.cells.length) {
                    broken.push(`${name}: ${back.length} cells back, ${ov.payload.cells.length} in`);
                    continue;
                }
                for (let i = 0; i < back.length; i++) {
                    if (back[i] !== ov.payload.cells[i]) {
                        broken.push(`${name}: cell ${i} came back ${back[i]}, was ${ov.payload.cells[i]}`);
                        break;
                    }
                }
                deep(enc.codes, ov.payload.codes, `${name}: the code table survives unchanged`);
            }
        }
    }
    eq(broken.length, 0, `decode(encode(x)) === x for all ${payloads} payloads  ${broken[0] ?? ''}`);
    for (const t of ['Ascii', 'Decimal', 'HexaDecimal', 'Integer2']) {
        ok(seen.has(t), `the corpus exercised BinType ${t}`);
    }
});

section('4. what it refuses, and why', () => {
    const table = ['.', '1'];
    eq(threwCode(() => BinCodec.encodeBinIndices({ cells: new Uint32Array([0]), codes: [] })),
        'E142_BINCODEC_NO_CODES',
        'an empty code table is refused — every decoded payload has at least the null bin');
    eq(threwCode(() => BinCodec.encodeBinIndices({ cells: new Uint32Array([70000]), codes: table })),
        'E142_BINCODEC_INDEX_TOO_LARGE',
        'an index past 65535 is refused rather than wrapped — wrapping renders a wrong map');
    /* Four base64 characters are 24 bits = THREE bytes, which is odd. Three
     * characters would be 18 bits = two whole bytes, i.e. even, and would not
     * exercise this at all. */
    eq(threwCode(() => BinCodec.decodeBinIndices(table, 'AAAA')),
        'E142_BINCODEC_ODD_LENGTH',
        'an odd byte count is refused — a truncated block would render as a smaller complete map');
    eq(threwCode(() => BinCodec.decodeBinIndices(table, BinCodec.encodeBinIndices(
        { cells: new Uint32Array([5]), codes: ['.', 'a', 'b', 'c', 'd', 'e'] }).data)),
        'E142_BINCODEC_INDEX_UNKNOWN',
        'a block whose indices outrun the table is refused — the two do not belong together');

    /* The boundary itself: 65535 is legal, 65536 is not. */
    const big = new Array(0x10000).fill('x');
    ok(threwCode(() => BinCodec.encodeBinIndices({ cells: new Uint32Array([0xFFFF]), codes: big }))
        === null, 'index 65535 with a 65536-entry table is accepted — Integer2 fits exactly');
    eq(threwCode(() => BinCodec.encodeBinIndices(
        { cells: new Uint32Array([0]), codes: big.concat('one-too-many') })),
        'E142_BINCODEC_TABLE_TOO_LARGE', '  and one entry more is refused');
});

/*
 * Titled "the shapes that make the fast path safe" until P-2. There is no fast
 * path — D-046 deleted it, because a mutation could not reach it — so the title
 * named a construct that had not existed for six tasks. What the section actually
 * covers is the edge SHAPES: an empty payload, the three base64 tail cases, and
 * the code table being copied rather than adopted.
 */
section('5. the edge shapes: empty, odd-length, and the copied table', () => {
    /* An empty payload is not an error: a map may legitimately decode to no cells,
     * and base64 of zero bytes is the empty string. */
    const empty = BinCodec.encodeBinIndices({ cells: new Uint32Array(0), codes: ['.'] });
    eq(empty.data, '', 'zero cells encode to the empty string, not to padding');
    eq(BinCodec.decodeBinIndices(['.'], '').length, 0, '  and decode back to zero cells');

    /* A large odd-length run, to exercise the base64 tail cases (n%3 === 1 and 2)
     * rather than only the aligned path. */
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
        const cells = new Uint32Array(n).map((_, i) => i % 2);
        const enc = BinCodec.encodeBinIndices({ cells, codes: ['.', '1'] });
        deep([...BinCodec.decodeBinIndices(['.', '1'], enc.data)], [...cells],
            `${n} cells (${n * 2} bytes) round-trips — base64 tail ${(n * 2) % 3}`);
    }

    /* The codec must not adopt the caller's array. */
    const codes = ['.', '1'];
    const enc = BinCodec.encodeBinIndices({ cells: new Uint32Array([1]), codes });
    codes.push('mutated');
    eq(enc.codes.length, 2, 'the returned code table is a copy — mutating the input does not reach it');
});

finish();
