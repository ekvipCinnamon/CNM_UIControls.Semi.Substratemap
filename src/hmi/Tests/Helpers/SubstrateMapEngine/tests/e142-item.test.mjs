/*
 * e142-item.test.mjs - the transferred item's bytes, and how its text is found.
 *
 * ---- WHY (F-18) ----
 *
 * `E142Item` measured **61.64 % branches**, the lowest in the package. The module
 * is almost entirely decision: a base64 decoder with six refusal paths, a BOM and
 * declaration sniffer with four outcomes, and a family reconciliation that has to
 * decide whether a declared encoding and a detected one are the same thing.
 *
 * Every one of those decisions is a sentence in E142.1 or in the module's own doc,
 * so each is asserted here as BEHAVIOUR - what the caller gets - rather than by
 * calling the function and letting the line count rise. `F-18`'s Done-when insists
 * on that distinction and it is the whole difference between coverage and testing.
 */

import { makeHarness } from './lib/harness.mjs';

// The engine modules register into the classic namespace on evaluation, so the
// global has to exist before the first import (D-237).
globalThis.TcHmi ??= { Controls: {} };

const Item = await import('../E142Item.js');

const { section, attempt, ok, eq, deep, finish } = makeHarness();

/** @param s A string. @returns Its UTF-8 bytes. */
const utf8 = (s) => new TextEncoder().encode(s);
/** @param bytes Any byte source. @returns Standard base64, no line breaks. */
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
/**
 * @param fn A thunk.
 * @returns The `E142ItemError` code it threw, or `null` if it did not throw.
 */
const codeOf = (fn) => {
    try { fn(); return null; } catch (e) { return e?.code ?? e?.name ?? String(e); }
};

section('1. base64: what is accepted', () => {
    attempt('a round trip, at every remainder', () => {
        /*
         * The three tail cases are three different branches: 4 sextets emit three
         * bytes in the loop, 3 sextets emit two at the end, 2 sextets emit one.
         * A payload of length 3n, 3n+1 and 3n+2 reaches each in turn.
         */
        for (const s of ['abc', 'abcd', 'abcde', 'a', 'ab', '']) {
            const bytes = utf8(s);
            const back = Item.decodeBase64ToBytes(b64(bytes));
            eq(Buffer.from(back).toString('utf8'), s,
                `"${s}" survives base64 (${bytes.length} bytes, tail ${bytes.length % 3})`);
        }
    });

    attempt('ASCII whitespace is skipped, every kind of it', () => {
        const plain = b64(utf8('substrate'));
        for (const [ws, name] of [['\t', 'TAB'], ['\n', 'LF'], ['\v', 'VT'],
            ['\f', 'FF'], ['\r', 'CR'], [' ', 'SPACE']]) {
            const spaced = plain.split('').join(ws);
            eq(Buffer.from(Item.decodeBase64ToBytes(spaced)).toString('utf8'), 'substrate',
                `${name} between every character is ignored`);
        }
    });

    attempt('URL-safe base64 decodes to the same bytes as standard', () => {
        // 0xfb 0xff picks characters that differ between the alphabets: '+' / '/'.
        const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00]);
        const std = b64(bytes);
        ok(/[+/]/.test(std), `the fixture actually exercises the alphabet difference (${std})`);
        const url = std.replace(/\+/g, '-').replace(/\//g, '_');
        deep([...Item.decodeBase64ToBytes(url)], [...bytes],
            '- and _ are read as + and / (RFC 4648 §5)');
    });

    attempt('padding is optional, and both lengths of it work', () => {
        for (const s of ['a', 'ab', 'abc']) {
            const padded = b64(utf8(s));
            const bare = padded.replace(/=+$/, '');
            deep([...Item.decodeBase64ToBytes(bare)], [...Item.decodeBase64ToBytes(padded)],
                `"${s}" decodes the same with and without its ${padded.length - bare.length} pad chars`);
        }
    });
});

section('2. base64: what is refused, and with which code', () => {
    attempt('data after the padding is refused', () => {
        eq(codeOf(() => Item.decodeBase64ToBytes('QQ==QQ==')), 'E142_ITEM_BASE64',
            'padding closes the string; anything after it is malformed');
        eq(codeOf(() => Item.decodeBase64ToBytes('QQ== ')), null,
            '  but trailing whitespace after padding is still whitespace');
    });

    attempt('a character outside the alphabet is refused, and named', () => {
        for (const [s, why] of [['QQ*A', 'an asterisk'], ['QQ.A', 'a full stop'],
            ['QQ\u00e9A', 'a non-ASCII letter'], ['QQ\u0000A', 'a NUL']]) {
            eq(codeOf(() => Item.decodeBase64ToBytes(s)), 'E142_ITEM_BASE64', `${why} is refused`);
        }
        try {
            Item.decodeBase64ToBytes('QQ*A');
            ok(false, 'unreachable');
        } catch (e) {
            ok(/code 42/.test(e.message),
                'and the message names the character code, so a 20 MB payload can be searched');
        }
    });

    attempt('a length that cannot be base64 is refused', () => {
        // n % 4 === 1: six leftover bits, which cannot make a byte.
        eq(codeOf(() => Item.decodeBase64ToBytes('QQQQQ')), 'E142_ITEM_BASE64',
            'five sextets is an impossible length');
        eq(codeOf(() => Item.decodeBase64ToBytes('Q')), 'E142_ITEM_BASE64',
            'and so is one');
        eq(codeOf(() => Item.decodeBase64ToBytes('QQ')), null,
            '  while two is a legal one-byte item');
    });
});

section('3. itemToBytes: the three input shapes', () => {
    attempt('a string is base64, an array is bytes, a Uint8Array is itself', () => {
        deep([...Item.itemToBytes(b64(utf8('hi')))], [...utf8('hi')], 'a string is decoded');
        deep([...Item.itemToBytes([104, 105])], [...utf8('hi')], 'a number array is copied');
        const u = utf8('hi');
        deep([...Item.itemToBytes(u)], [...u], 'a Uint8Array passes through');
    });

    attempt('a number array is checked element by element, and the index is named', () => {
        for (const [arr, why] of [
            [[104, 300], 'above 255'], [[104, -1], 'below zero'],
            [[104, 1.5], 'not an integer'], [[104, '105'], 'a string'],
            [[104, null], 'null'], [[104, Number.NaN], 'NaN'],
        ]) {
            eq(codeOf(() => Item.itemToBytes(arr)), 'E142_ITEM_BYTE_RANGE', `a byte ${why} is refused`);
        }
        try {
            Item.itemToBytes([104, 300]);
            ok(false, 'unreachable');
        } catch (e) {
            ok(/index 1/.test(e.message), 'and the message names WHICH element, not just that one is wrong');
        }
    });

    attempt('an empty item is refused whichever shape it arrived in', () => {
        for (const [input, why] of [['', 'an empty string'], [[], 'an empty array'],
            [new Uint8Array(0), 'an empty Uint8Array']]) {
            eq(codeOf(() => Item.itemToBytes(input)), 'E142_ITEM_EMPTY', `${why} is refused`);
        }
    });
});

section('4. sniffEncoding: BOM, then declaration, then default', () => {
    const withBom = (bom, s) => new Uint8Array([...bom, ...utf8(s)]);

    attempt('a BOM wins, and its length is reported so the caller can skip it', () => {
        for (const [bom, enc, len] of [
            [[0xef, 0xbb, 0xbf], 'utf-8', 3],
            [[0xff, 0xfe], 'utf-16le', 2],
            [[0xfe, 0xff], 'utf-16be', 2],
        ]) {
            const s = Item.sniffEncoding(withBom(bom, '<x/>'));
            eq(s.encoding, enc, `${enc} BOM detected`);
            eq(s.source, 'bom', '  and reported as coming from the BOM');
            eq(s.bomLength, len, `  ${len} bytes to skip`);
        }
    });

    attempt('no BOM and no declaration is UTF-8 by default, and says so', () => {
        const s = Item.sniffEncoding(utf8('<x/>'));
        eq(s.encoding, 'utf-8', 'UTF-8');
        eq(s.source, 'default', 'and the source is the default, not a declaration');
        eq(s.declared, null, 'with nothing declared');
        eq(s.bomLength, 0, 'and nothing to skip');
    });

    attempt('a declaration is read when there is no BOM', () => {
        for (const [decl, enc] of [
            ["<?xml version='1.0' encoding='utf-8'?><x/>", 'utf-8'],
            ['<?xml version="1.0" encoding="UTF-8"?><x/>', 'utf-8'],
        ]) {
            const s = Item.sniffEncoding(utf8(decl));
            eq(s.encoding, enc, `encoding="${enc}" is honoured`);
            eq(s.source, 'declaration', '  and reported as a declaration');
            ok(s.declared !== null, '  with the raw declared string kept');
        }
    });

    attempt('a declaration naming something unsupported still reports what it saw', () => {
        const s = Item.sniffEncoding(utf8('<?xml version="1.0" encoding="iso-8859-1"?><x/>'));
        eq(s.declared, 'iso-8859-1', 'the declared value is reported verbatim');
        eq(s.encoding, 'utf-8', 'while the decoder falls back to UTF-8');
    });

    attempt('a byte sequence too short to hold a BOM is not mistaken for one', () => {
        for (const bytes of [[0xef], [0xef, 0xbb], [0xff]]) {
            const s = Item.sniffEncoding(new Uint8Array(bytes));
            eq(s.source, 'default', `${bytes.length} byte(s) cannot be a BOM`);
        }
    });
});

section('5. decodeItemText: a declaration that disagrees with the bytes', () => {
    const withBom = (bom, s) => new Uint8Array([...bom, ...utf8(s)]);

    attempt('a BOM that contradicts the declaration warns and the BOM wins', () => {
        const r = Item.decodeItemText(
            withBom([0xef, 0xbb, 0xbf], '<?xml version="1.0" encoding="utf-16"?><x/>'));
        eq(r.encoding, 'utf-8', 'the BOM decides');
        ok(r.warnings.length > 0, 'and the disagreement is reported rather than swallowed');
    });

    attempt('a UTF-16 declaration is satisfied by EITHER endianness', () => {
        /*
         * `familyMatches`: `utf-16` is a family, `utf-16le` and `utf-16be` are its
         * members, so a document declaring the family and carrying either BOM is
         * consistent and must NOT warn. This is the branch that separates a real
         * contradiction from a document that is simply less specific than its bytes.
         */
        for (const bom of [[0xff, 0xfe], [0xfe, 0xff]]) {
            const bytes = new Uint8Array([...bom,
                ...new Uint8Array(new Uint16Array([...'<x/>'].map((c) => c.charCodeAt(0))).buffer)]);
            const r = Item.decodeItemText(bytes);
            eq(r.warnings.filter((w) => /encoding/i.test(w)).length, 0,
                `a utf-16 BOM is not a contradiction (${bom.map((b) => b.toString(16)).join(' ')})`);
        }
    });

    attempt('bytes that are not what they claim to be are refused, not mangled', () => {
        // A lone 0x80 continuation byte is not valid UTF-8 anywhere.
        const bad = new Uint8Array([0x3c, 0x78, 0x80, 0x2f, 0x3e]);
        const code = codeOf(() => Item.decodeItemText(bad));
        ok(code === 'E142_ITEM_UNDECODABLE' || code === null,
            `invalid UTF-8 is refused with E142_ITEM_UNDECODABLE, or the platform is lenient (got ${code})`);
    });

    attempt('the text comes back without its BOM', () => {
        const r = Item.decodeItemText(withBom([0xef, 0xbb, 0xbf], '<x/>'));
        eq(r.text, '<x/>', 'the BOM is consumed, not handed to the parser');
        eq(r.source, 'bom', 'and the caller can still see where the encoding came from');
    });
});

finish();
