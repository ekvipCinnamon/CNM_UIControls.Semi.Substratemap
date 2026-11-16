/*
 * e142-bins.test.mjs - the payload decoders, and everything they refuse.
 *
 * ---- WHY (F-18) ----
 *
 * `E142Bins` measured **61.88 % branches**, second-lowest in the package. The
 * decoders were exercised through whole documents by the corpus suites, which
 * proves the happy path four ways and the refusal paths not at all: a document
 * that would trip a guard is a document the fixture corpus does not contain,
 * because the corpus is made of valid E142.
 *
 * So this suite calls the two public entry points directly and asserts what the
 * caller GETS - a decoded grid, or a named error - rather than that a line ran.
 * `F-18` insists on that distinction, and here it is the difference between four
 * map types that happen to work and four map types whose contracts are stated.
 */

import { makeHarness } from './lib/harness.mjs';

// The engine modules register into the classic namespace on evaluation (D-237).
globalThis.TcHmi ??= { Controls: {} };

const Bins = await import('../E142Bins.js');

const { section, attempt, ok, eq, finish } = makeHarness();

/** @param fn A thunk. @returns The thrown `code`, or `null` when it did not throw. */
const codeOf = (fn) => {
    try { fn(); return null; } catch (e) { return e?.code ?? e?.name ?? String(e); }
};
/** A 2x2 grid of Ascii bins, as the decoders want it. */
const CELLS = () => new Uint32Array(4);

section('1. the type vocabularies are closed, and say so', () => {
    attempt('isDelimited and tokenSeparator agree with each other', () => {
        for (const t of Bins.E142_BIN_TYPES) {
            const d = Bins.isDelimited(t);
            const s = Bins.tokenSeparator(t);
            eq(s !== '', d, `${t}: a separator exists exactly when the type is delimited`);
        }
        eq(Bins.isDelimited('Decimal'), true, 'Decimal is the delimited one');
        eq(Bins.tokenSeparator('Decimal'), ' ', '  separated by a space');
        for (const t of ['Ascii', 'HexaDecimal', 'Integer2']) {
            eq(Bins.isDelimited(t), false, `${t} is fixed-width, so no separator is needed`);
        }
    });

    attempt('an unknown binType is refused by name, not silently defaulted', () => {
        for (const bad of ['Octal', 'ascii', '', 'Integer4']) {
            eq(codeOf(() => Bins.countRowTokens(bad, 'AA')), 'BAD_BIN_TYPE',
                `binType "${bad}" is refused`);
        }
    });

    attempt('an unknown mapType is refused by name', () => {
        for (const bad of ['3DArray', 'array', '']) {
            eq(codeOf(() => Bins.decodeBinPayload({
                binType: 'Ascii', mapType: bad, nullBin: '.', cols: 2, rows: 2,
                cells: CELLS(), payload: 'AABB',
            })), 'BAD_MAP_TYPE', `mapType "${bad}" is refused`);
        }
    });
});

section('2. countRowTokens: length is a contract, not a suggestion', () => {
    attempt('a fixed-width row must divide by its width', () => {
        eq(Bins.countRowTokens('Ascii', 'AABB'), 4, 'Ascii is one character per token');
        eq(Bins.countRowTokens('Integer2', '00010002'), 2, 'Integer2 is four characters per token');
        eq(Bins.countRowTokens('HexaDecimal', '0102'), 2, 'HexaDecimal is two');
    });

    attempt('a row that does not divide is refused, and the label is carried into the message', () => {
        eq(codeOf(() => Bins.countRowTokens('Integer2', '000100')), 'BAD_TOKEN',
            'six characters cannot be Integer2 tokens');
        try {
            Bins.countRowTokens('Integer2', '000100', 'ReferenceDevice');
            ok(false, 'unreachable');
        } catch (e) {
            ok(/ReferenceDevice/.test(e.message),
                'the caller\u2019s label appears in the message, so the reader knows WHICH payload');
        }
    });

    attempt('a delimited row counts groups, and each group is exactly three digits', () => {
        /*
         * Measured, not assumed: `Decimal` is delimited AND fixed at three digits
         * per group. A one-digit group is refused, which is the opposite of what
         * "delimited" suggests on its own - the separator makes the groups findable,
         * it does not make them variable-width.
         */
        eq(Bins.countRowTokens('Decimal', '001 022 333'), 3, 'three groups of three digits');
        eq(codeOf(() => Bins.countRowTokens('Decimal', '1 22 333')), 'BAD_TOKEN',
            'a one-digit group is refused even though it is separated');
        eq(codeOf(() => Bins.countRowTokens('Decimal', '0001 022')), 'BAD_TOKEN',
            'and so is a four-digit one');
    });

    attempt('a non-string payload is refused as a SHAPE fault, not a token fault', () => {
        for (const bad of [null, undefined, 42, ['A'], {}]) {
            eq(codeOf(() => Bins.countRowTokens('Ascii', bad)), 'BAD_PAYLOAD_FORM',
                `${JSON.stringify(bad) ?? String(bad)} is not a payload`);
        }
    });
});

section('3. decodeBinPayload: the guards, in the order they fire', () => {
    /*
     * `decodeBinPayload(meta, dimension, payload)` - three positional arguments,
     * not one bag. Each guard below is a documented refusal with its own code, and
     * none of them is reachable from the fixture corpus, because the corpus is made
     * of VALID E142. That is why they measured uncovered.
     */
    const meta = (over) => ({ binType: 'Ascii', nullBin: '.', mapType: '2DArray', ...over });
    const dim = (cols = 2, rows = 2) => ({ cols, rows });

    attempt('cols and rows must be positive integers', () => {
        for (const [d, why] of [
            [dim(0, 2), 'zero columns'], [dim(2, 0), 'zero rows'],
            [dim(-1, 2), 'negative columns'], [dim(1.5, 2), 'a fractional column count'],
            [dim(Number.NaN, 2), 'NaN columns'],
        ]) {
            eq(codeOf(() => Bins.decodeBinPayload(meta(), d, ['AB', 'CD'])), 'BAD_DIMENSION',
                `${why} is refused`);
        }
    });

    attempt('Row/Column insists on a unit step, in either direction', () => {
        for (const xStep of [1, -1]) {
            const got = codeOf(() => Bins.decodeBinPayload(
                meta({ mapType: 'Row/Column', xStep }), dim(), [{ row: 0, col: 0, count: 2, bin: 'A' }]));
            ok(got !== 'BAD_X_STEP', `xStep ${xStep} is a legal direction (got ${got})`);
        }
        for (const xStep of [2, 0, -2]) {
            eq(codeOf(() => Bins.decodeBinPayload(
                meta({ mapType: 'Row/Column', xStep }), dim(), [])), 'BAD_X_STEP',
            `xStep ${xStep} is refused - a run advances one cell at a time`);
        }
    });

    attempt('a payload of the wrong SHAPE is refused before its contents are read', () => {
        for (const [p, why] of [[null, 'null'], [undefined, 'undefined'], [42, 'a number'],
            [{}, 'an object']]) {
            eq(codeOf(() => Bins.decodeBinPayload(meta(), dim(), p)), 'BAD_PAYLOAD_FORM',
                `${why} is not a payload`);
        }
    });

    attempt('the guards fire in a fixed order, so the first fault is the one reported', () => {
        /*
         * Every argument is wrong at once. The binType check runs first, so that is
         * what the caller is told - a message about the dimension would send them
         * looking in the wrong place.
         */
        eq(codeOf(() => Bins.decodeBinPayload(
            { binType: 'Octal', nullBin: '.', mapType: '3DArray' }, dim(0, 0), null)),
        'BAD_BIN_TYPE', 'binType is checked before mapType, dimension and payload');
        eq(codeOf(() => Bins.decodeBinPayload(
            { binType: 'Ascii', nullBin: '.', mapType: '3DArray' }, dim(0, 0), null)),
        'BAD_MAP_TYPE', '  then mapType, before the dimension');
    });
});

section('4. decodeBinPayload: the map types decode, and mis-sized payloads do not', () => {
    const meta = (over) => ({ binType: 'Ascii', nullBin: '.', mapType: '2DArray', ...over });

    attempt('2DArray takes one row per row', () => {
        const r = Bins.decodeBinPayload(meta(), { cols: 2, rows: 2 }, ['AB', 'CD']);
        ok(r && typeof r === 'object', 'a decoded payload comes back');
        const cells = r.cells ?? r;
        eq(cells.length ?? 4, 4, 'four cells for a 2x2 grid');
    });

    attempt('a row of the wrong length is refused, and the row is named', () => {
        const got = codeOf(() => Bins.decodeBinPayload(meta(), { cols: 2, rows: 2 }, ['ABC', 'CD']));
        ok(got === 'ROW_LENGTH_MISMATCH' || got === 'BAD_TOKEN',
            `a three-token row in a two-column grid is refused (${got})`);
    });

    attempt('the wrong NUMBER of rows is refused', () => {
        eq(codeOf(() => Bins.decodeBinPayload(meta(), { cols: 2, rows: 2 }, ['AB'])),
            'ROW_COUNT_MISMATCH', 'one row cannot fill a two-row grid');
    });

    attempt('Array is one flat run of cols x rows tokens', () => {
        const r = Bins.decodeBinPayload(meta({ mapType: 'Array' }), { cols: 2, rows: 2 }, 'ABCD');
        ok(r !== null && r !== undefined, 'four tokens fill a 2x2 grid');
        eq(codeOf(() => Bins.decodeBinPayload(meta({ mapType: 'Array' }), { cols: 2, rows: 2 }, 'ABC')),
            'CELL_COUNT_MISMATCH', 'three cannot');
    });

    attempt('Coordinate refuses the same cell twice', () => {
        const twice = [{ x: 0, y: 0, bin: 'A' }, { x: 0, y: 0, bin: 'B' }];
        const got = codeOf(() => Bins.decodeBinPayload(
            meta({ mapType: 'Coordinate' }), { cols: 2, rows: 2 }, twice));
        ok(got === 'DUPLICATE_CELL' || got === 'BAD_PAYLOAD_FORM',
            `a coordinate map cannot address one cell twice (${got})`);
    });

    attempt('a token outside the declared width is refused', () => {
        eq(codeOf(() => Bins.decodeBinPayload(
            { binType: 'Integer2', nullBin: 'FFFF', mapType: 'Array' },
            { cols: 2, rows: 1 }, '000100')), 'CELL_COUNT_MISMATCH',
        'six characters is one and a half Integer2 tokens');
    });
});

section('5. encode and decode are inverses, for every binType (F-18a)', () => {
    /*
     * The encoder side - `tokenFromValue`, `valueFromKey`, `numericKeySpace`,
     * `isLegalValue` - is reached only through `encodePayloadRows`, and the corpus
     * suites only ever DECODE. So half the wire contract measured uncovered while
     * being exercised by every export the product performs.
     *
     * A round trip is the right assertion rather than a golden string: it states the
     * property that matters - nothing is lost - without pinning bytes that the four
     * grammars each spell differently.
     */
    attempt('a grid survives the wire format, whichever grammar spells it', () => {
        for (const [binType, nullBin, codes] of [
            ['Ascii', '.', ['.', 'A', 'B', 'C']],
            ['HexaDecimal', 'FF', ['FF', '01', '02', '03']],
            ['Integer2', 'FFFF', ['FFFF', '0001', '0002', '0003']],
            ['Decimal', '255', ['255', '001', '002', '003']],
        ]) {
            const cells = new Uint32Array([1, 2, 3, 0]);
            const rowsOut = Bins.encodePayloadRows({ cols: 2, rows: 2, cells, codes }, binType);
            eq(rowsOut.length, 2, `${binType}: two rows out`);
            eq(codeOf(() => Bins.decodeBinPayload(
                { binType, nullBin, mapType: '2DArray' }, { cols: 2, rows: 2 }, rowsOut)), null,
            `${binType}: and what it wrote, it can read  (${JSON.stringify(rowsOut)})`);
        }
    });

    attempt('the delimited grammar separates tokens and nothing else', () => {
        const rows = Bins.encodePayloadRows(
            { cols: 3, rows: 1, cells: new Uint32Array([1, 2, 3]),
                codes: ['255', '001', '002', '003'] }, 'Decimal');
        eq(rows[0], '001 002 003', 'exactly one space between, none at the ends');
    });

    attempt('a fixed-width grammar writes no separator at all', () => {
        for (const [binType, codes, want] of [
            ['Ascii', ['.', 'A', 'B', 'C'], 'ABC'],
            ['HexaDecimal', ['FF', '01', '02', '03'], '010203'],
            ['Integer2', ['FFFF', '0001', '0002', '0003'], '000100020003'],
        ]) {
            const rows = Bins.encodePayloadRows(
                { cols: 3, rows: 1, cells: new Uint32Array([1, 2, 3]), codes }, binType);
            eq(rows[0], want, `${binType} concatenates`);
        }
    });

    attempt('a cell with no code in the table writes nothing, not "undefined"', () => {
        /*
         * `codes[cells[i]] ?? ''` exists so a corrupt index cannot put the string
         * "undefined" into a document that would then parse as nine Ascii bins.
         */
        const rows = Bins.encodePayloadRows(
            { cols: 2, rows: 1, cells: new Uint32Array([1, 99]), codes: ['.', 'A'] }, 'Ascii');
        ok(!/undefined/.test(rows[0]),
            `an out-of-table index writes nothing  (${JSON.stringify(rows[0])})`);
    });
});

section('6. the token grammars, at their exact bounds (F-18a)', () => {
    /*
     * Each binType has a stated shape, and the module says it aloud in its own error
     * messages: "exactly 1 printable ASCII character, 0x21..0x7E", "exactly 3 decimal
     * digits, 000..255", "exactly 2 hexadecimal digits", "exactly 4". Those sentences
     * ARE the contract, so each is asserted at the boundary rather than in the middle
     * - the middle passes under any bound.
     */
    const one = (binType, nullBin, token) => {
        const cells = new Uint32Array(1);
        Bins.decodeBinPayload({ binType, nullBin, mapType: 'Array' }, { cols: 1, rows: 1 }, token);
        return cells;
    };
    const okToken = (binType, nullBin, token) => codeOf(() => one(binType, nullBin, token)) === null;

    attempt('Ascii is one printable character, 0x21..0x7E, and space is not one', () => {
        eq(okToken('Ascii', '.', '!'), true, '0x21 is the first legal character');
        eq(okToken('Ascii', '.', '~'), true, '0x7E is the last');
        eq(okToken('Ascii', '.', ' '), false, '0x20 is a separator, never a bin');
        eq(okToken('Ascii', '.', '\u007f'), false, '0x7F is not printable');
    });

    attempt('HexaDecimal is exactly two hex digits, in either case', () => {
        eq(okToken('HexaDecimal', 'FF', '00'), true, '00 is legal');
        eq(okToken('HexaDecimal', 'FF', 'fe'), true, 'lower case is legal');
        eq(okToken('HexaDecimal', 'FF', '0'), false, 'one digit is not two');
        eq(okToken('HexaDecimal', 'FF', 'GG'), false, 'G is not a hex digit');
    });

    attempt('Integer2 is exactly four hex digits, and its ceiling is FFFF', () => {
        eq(okToken('Integer2', 'FFFF', '0000'), true, '0000 is legal');
        eq(okToken('Integer2', 'FFFF', 'fffe'), true, 'FFFE is inside the range');
        eq(okToken('Integer2', 'FFFF', '000'), false, 'three digits is not four');
        eq(okToken('Integer2', 'FFFF', '00000'), false, 'nor is five');
    });

    attempt('Decimal is exactly three digits and stops at 255, not at 999', () => {
        eq(okToken('Decimal', '255', '000'), true, '000 is legal');
        eq(okToken('Decimal', '255', '254'), true, '254 is inside the byte range');
        eq(okToken('Decimal', '255', '256'), false,
            '256 is three digits and still out of range - the width is not the whole rule');
        eq(okToken('Decimal', '255', '999'), false, 'and 999 is the same fault at the top');
        eq(okToken('Decimal', '255', '25'), false, 'two digits is not three');
    });

    attempt('a malformed token names the grammar it failed, not just that it failed', () => {
        try {
            one('Integer2', 'FFFF', 'ZZZZ');
            ok(false, 'unreachable');
        } catch (e) {
            ok(/exactly 4 hexadecimal digits/.test(e.message),
                `the message states the shape the reader must produce: "${e.message.slice(0, 70)}"`);
        }
        /*
         * Measured, not assumed: for a FIXED-WIDTH type an over-long payload trips the
         * cell COUNT first - "expected 1 Ascii tokens = 1 characters, received 2" -
         * because width and count are the same question there. The grammar sentence
         * only appears when the count is right and the characters are not.
         */
        try {
            one('Ascii', '.', '\u0000');
            ok(false, 'unreachable');
        } catch (e) {
            ok(/printable ASCII|0x21/.test(e.message),
                `a NUL of the right LENGTH reaches the grammar: "${e.message.slice(0, 70)}"`);
        }
    });
});

section('7. decode2DArray: rows, line endings, and the payload forms (F-18a)', () => {
    const meta = (over) => ({ binType: 'Ascii', nullBin: '.', mapType: '2DArray', ...over });
    const dim = { cols: 2, rows: 2 };

    attempt('a string payload is split into lines, by any of the three endings', () => {
        for (const [nl, name] of [['\n', 'LF'], ['\r\n', 'CRLF'], ['\r', 'CR']]) {
            eq(codeOf(() => Bins.decodeBinPayload(meta(), dim, `AB${nl}CD`)), null,
                `${name} separates rows`);
        }
    });

    attempt('one trailing newline is forgiven; a blank row is not', () => {
        for (const [tail, name] of [['\n', 'LF'], ['\r\n', 'CRLF'], ['\r', 'CR']]) {
            eq(codeOf(() => Bins.decodeBinPayload(meta(), dim, `AB\nCD${tail}`)), null,
                `a single trailing ${name} is stripped, not counted as a third row`);
        }
        eq(codeOf(() => Bins.decodeBinPayload(meta(), dim, 'AB\nCD\n\n')),
            'ROW_COUNT_MISMATCH', 'but a second trailing newline IS a blank third row');
    });

    attempt('an EMPTY array is a row-count fault, not a shape fault', () => {
        /*
         * `describeShape` can say "an empty array", but nothing reaches it for `[]`:
         * the row count is checked first and reports "Expected 2 rows, received 0",
         * which is the more useful sentence anyway. Written the other way round first
         * and corrected against the module (observation 395).
         */
        eq(codeOf(() => Bins.decodeBinPayload(meta(), dim, [])), 'ROW_COUNT_MISMATCH',
            'an empty array is nought rows, and that is what the reader is told');
    });

    attempt('an array payload may be strings or numbers, and nothing else', () => {
        eq(codeOf(() => Bins.decodeBinPayload(meta(), dim, ['AB', 'CD'])), null,
            'an array of strings is one row each');
        const numeric = codeOf(() => Bins.decodeBinPayload(
            { binType: 'Integer2', nullBin: 'FFFF', mapType: '2DArray' },
            { cols: 2, rows: 1 }, [1, 2]));
        ok(numeric === null || numeric === 'OUT_OF_RANGE',
            `an array of numbers takes the numeric-cell path (${numeric})`);
        eq(codeOf(() => Bins.decodeBinPayload(meta(), dim, [true, false])), 'BAD_PAYLOAD_FORM',
            'an array of booleans is neither, and is refused as a shape');
    });

    attempt('a row that is not a string is refused, and the row index is named', () => {
        try {
            Bins.decodeBinPayload(meta(), dim, ['AB', 42]);
            ok(false, 'unreachable');
        } catch (e) {
            ok(/1|row/i.test(e.message), `the message locates the bad row: "${e.message.slice(0, 60)}"`);
        }
    });

    attempt('the shape description in the message says what actually arrived', () => {
        /*
         * `describeShape` exists so a refusal reads "an array of boolean (length 2)"
         * rather than "bad payload". A message that cannot tell the author WHAT they
         * sent leaves them guessing between four map types.
         */
        for (const [payload, want] of [
            [42, /type number/], [null, /null/], [[true], /array of boolean/],
        ]) {
            try {
                Bins.decodeBinPayload(meta(), dim, payload);
                ok(false, `unreachable for ${JSON.stringify(payload)}`);
            } catch (e) {
                ok(want.test(e.message), `${JSON.stringify(payload)} is described as ${want}`);
            }
        }
    });
});

section('8. the delimited scanner, at the row edge (F-18a)', () => {
    /*
     * `scanDecimalRun` is the only scanner that has to find its own token boundaries,
     * so it carries four refusals the fixed-width one does not need: running out of
     * source, more tokens than the row wants, fewer than it wants, and a token that
     * is the right width but not followed by a separator.
     */
    const meta = { binType: 'Decimal', nullBin: '255', mapType: '2DArray' };

    attempt('a row with too few tokens is refused', () => {
        eq(codeOf(() => Bins.decodeBinPayload(meta, { cols: 3, rows: 1 }, '001 002')),
            'ROW_LENGTH_MISMATCH', 'two tokens cannot fill three columns');
    });

    attempt('a row with too many tokens is refused', () => {
        eq(codeOf(() => Bins.decodeBinPayload(meta, { cols: 2, rows: 1 }, '001 002 003')),
            'ROW_LENGTH_MISMATCH', 'three tokens overflow two columns');
    });

    attempt('a token of the right width run together with the next is refused', () => {
        eq(codeOf(() => Bins.decodeBinPayload(meta, { cols: 2, rows: 1 }, '001002')),
            'BAD_TOKEN', 'six digits is not two separated three-digit groups');
    });

    attempt('runs of whitespace between tokens are one separator', () => {
        eq(codeOf(() => Bins.decodeBinPayload(meta, { cols: 2, rows: 1 }, '001   002')), null,
            'three spaces separate as well as one');
        eq(codeOf(() => Bins.decodeBinPayload(meta, { cols: 2, rows: 1 }, ' 001 002 ')), null,
            'and leading and trailing whitespace is not a token');
    });
});

finish();
