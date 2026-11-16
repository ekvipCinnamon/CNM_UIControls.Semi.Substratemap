/**
 * @fileoverview
 * E142Bins - SEMI E142 BinCodeMap payload decoder of the SubstrateMapEngine.
 *
 * ONE decoder serves the XML, JSON and E142.4 input paths: they differ in how
 * the bytes arrive (an `<BinCode>` element tree, a JSON transcription of the
 * same model, or a Stream-21 ITEMPART reassembly of the very same E142.1
 * document), never in what a bin token MEANS. Everything
 * format-specific about tokens lives here; everything format-neutral about
 * cells lives in {@link DecodedBinPayload} and `buildGridModel`.
 *
 * SCOPE - what this module does NOT do:
 *  - It has no notion of the E142 LOGICAL coordinate frame (OriginLocation x
 *    AxisDirection). Every X / Y that reaches this module is a
 *    SERIALIZATION INDEX: `x` = column, 0 = leftmost; `y` = row, 0 = TOP row of
 *    the map view. The caller converts logical start
 *    coordinates to serialization indices via the domain module at merge.
 *    The ONE exception is {@link E142BinMeta.xStep}, the sign of the logical X
 *    axis, which `Row/Column` cannot do without and which converting a start
 *    POINT does not carry - see {@link decodeRowColumnRuns}.
 *  - It does not apply the "missing MapType means 2DArray" rule. That default
 *    is standard PROSE with no `default=` in any XSD revision (
 *    6.5.2 / 6.7), i.e. an APPLICATION-level default; each input path applies
 *    it when it builds {@link E142BinMeta}.
 *  - It never touches the DOM, TcHmi or a global bridge, and it imports the
 *    engine for TYPES ONLY (`import type`, fully erased at emit), so the
 *    emitted E142Bins.js is standalone and node-testable.
 *
 * THREE-LAYER SPLIT: this file is engine layer - pure functions, no `this`, no
 * attributes, no events, no theme. See Engine.ts's @fileoverview.
 *
 * DEVIATION FROM THE ENGINE'S HOUSE STYLE, deliberate: Engine.ts is defensive
 * and returns `null` on malformed input (`buildGridModel`, `itemsToModels`).
 * This module THROWS {@link E142DecodeError} instead, because a bin payload is
 * a wire document whose defects must be reportable to the operator with a row
 * and a column; "the map silently came out empty" is not an acceptable
 * diagnosis. A lenient mode is explicitly not wanted: every length mismatch and
 * every malformed token is an error, never a repair.
 *
 * PROVENANCE. Every rule below says where it came from: quoted from E142-0225,
 * declared by the XSD, or inferred. The Row/Column run semantics are the weakest
 * of them - the standard describes the form but publishes no complete worked
 * example - so they live behind ONE function seam, {@link decodeRowColumnRuns},
 * and can be rewritten there without touching any caller.
 *
 * @author ekvip automation GmbH
 * @license Apache-2.0
 *
 * Copyright 2026 ekvip automation GmbH
 *
 *   Licensed under the Apache License, Version 2.0 (the "License");
 *   you may not use this file except in compliance with the License.
 *   You may obtain a copy of the License at
 *
 *       http://www.apache.org/licenses/LICENSE-2.0
 *
 *   Unless required by applicable law or agreed to in writing, software
 *   distributed under the License is distributed on an "AS IS" BASIS,
 *   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *   See the License for the specific language governing permissions and
 *   limitations under the License.
 *
 */

// Types only: erased at emit, so E142Bins.js imports nothing and never drags
// Engine.js's global bridge (which touches `TcHmi`) into a node process.
import type { DecodedBinPayload } from './Engine.js';

// ===================================================================
//  Wire vocabulary  (enumerations declared by the XSD)
// ===================================================================

/**
 * `BinTypeEnum` of the E142.1 XSD - the encoding of ONE bin token. Identical in
 * all four inspected schema revisions (V0211, V0921, V0224, V0125) and
 * `use="required"` on `BinCodeMap`. Declared by the XSD. (
 * Appendix A]
 *
 * Token grammar and byte width:
 * | BinType       | token             | separator | bytes/die |
 * | `Ascii`       | 1 printable char  | none      | 1         |
 * | `Decimal`     | 3 digits, 000-255 | whitespace| 1         |
 * | `HexaDecimal` | 2 hex digits      | none      | 1         |
 * | `Integer2`    | 4 hex digits      | none      | 2         |
 *
 * Note the schema's spelling: `HexaDecimal`, not `Hexadecimal`.
 */
export type E142BinType = 'Ascii' | 'Decimal' | 'HexaDecimal' | 'Integer2';

/** The four legal {@link E142BinType} values, in XSD declaration order. */
export const E142_BIN_TYPES: readonly E142BinType[] = ['Ascii', 'Decimal', 'HexaDecimal', 'Integer2'];

/**
 * `MapTypeEnum` of the E142.1 XSD - how the bin tokens are laid out across the
 * `<BinCode>` elements. Identical in all four inspected schema revisions, and
 * declared by the XSD.
 *
 * Note the schema's spelling: `Row/Column` WITH a literal slash. The attribute
 * is `use="optional"` and carries NO `default=` in any revision, although the
 * standard's prose says a missing value means `2DArray` - a documented
 * prose-vs-schema divergence. Applying that default is the
 * caller's job, see this file's @fileoverview.
 */
export type E142MapType = '2DArray' | 'Row/Column' | 'Array' | 'Coordinate';

/** The four legal {@link E142MapType} values, in XSD declaration order. */
export const E142_MAP_TYPES: readonly E142MapType[] = ['2DArray', 'Row/Column', 'Array', 'Coordinate'];

/**
 * The `BinCodeMap` attributes that decide how a payload is read, lifted out of
 * whichever wire format delivered them, plus the one scalar the caller must
 * derive from the logical frame ({@link E142BinMeta.xStep}).
 */
export interface E142BinMeta {
    /** `BinCodeMap/@BinType` - the token encoding. Required by the XSD. */
    binType: E142BinType;
    /**
     * `BinCodeMap/@NullBin` - the literal token standing for "no device / not
     * tested / outside the substrate". `use="required"` on every schema
     * revision, an untyped `xs:string`; observed values are
     * `"."` (Ascii), `"F0"` (HexaDecimal), `"FFFF"` (Integer2).
     *
     * It is validated as a well-formed token of `binType` and becomes
     * `codes[0]` of the result VERBATIM (see {@link decodeBinPayload}).
     */
    nullBin: string;
    /** `BinCodeMap/@MapType` - the payload layout. The caller resolves the prose default. */
    mapType: E142MapType;
    /**
     * The serialization-column step of the LOGICAL +X direction: `+1` when
     * `AxisDirection`'s X token is `Right` and `-1` when it is `Left`. This is
     * the `sx` of {@link axisSigns}, carried through
     * `X = sx * (from_left - zero.from_left)` with `from_left = serCol`.
     *
     * REQUIRED for `MapType="Row/Column"` and IGNORED by the other three
     * layouts, which encode no direction: `2DArray` and `Array` are serialized
     * in visual order, and `Coordinate` names every cell outright.
     *
     * Why this exists at all, when the caller is supposed to hand this module
     * nothing but serialization indices: a run's fill
     * direction in LOGICAL terms, and converting the start POINT does not carry
     * a DIRECTION. Under `sx = -1` a run fills toward DECREASING serialization
     * columns and its bounds check flips to the left edge. So the seam needs
     * exactly this one bit of the logical frame - not the frame, just the sign.
     *
     * It has NO DEFAULT on purpose. Defaulting it to `+1` would silently decode
     * every `Left`-axis map mirrored about each run's start - a plausible-
     * looking, wrong wafer - and this module does not repair missing
     * information, it reports it ({@link E142DecodeErrorCode} `BAD_X_STEP`).
     * Inferred, and forced by the run-fill and axis-sign rules together; it is no
     * better evidenced than the Row/Column reading it depends on.
     */
    xStep?: 1 | -1;
}

/**
 * The lattice size the payload must fill, in SERIALIZATION index space - i.e.
 * already through the dimension swap for `Orientation mod 180 == 90`
 * where the map view swaps the layout's X/Y. Both values `> 0`.
 */
export interface E142Dimension {
    /** Number of serialization columns; `x` runs `0 .. cols-1`, 0 = leftmost. */
    cols: number;
    /** Number of serialization rows; `y` runs `0 .. rows-1`, 0 = TOP row. */
    rows: number;
}

/**
 * One `<BinCode X="" Y="">token</BinCode>` element of a `MapType="Coordinate"`
 * payload: one element per device, X and Y both REQUIRED, content is exactly
 * one token, in the standard's own words.
 *
 * Cells named by no entry stay NullBin - `Coordinate` is sparse by nature.
 * `Number` is NOT read: it is assumed informational and ignored for placement
 * and V0125 `LID`-only entries cannot be placed on a grid at all. Both readings
 * are inferred rather than stated, and both are the caller's business, never
 * this module's.
 */
export interface E142CoordinateEntry {
    /** SERIALIZATION column index, `0 .. cols-1` (NOT a logical E142 X). */
    x: number;
    /** SERIALIZATION row index, `0 .. rows-1`, 0 = top (NOT a logical E142 Y). */
    y: number;
    /**
     * The device's bin: either the wire token (`string`) or its numeric value
     * (`number`, e.g. from a JSON path). All entries of one payload must use
     * the SAME form - see {@link decodeBinPayload} on key spaces.
     */
    bin: string | number;
}

/**
 * One `<BinCode X="" Y="">tokens</BinCode>` element of a `MapType="Row/Column"`
 * payload: a RUN of consecutive cells.
 *
 * WEAKLY EVIDENCED, AND QUARANTINED BEHIND A SEAM. The whole shape rests on a
 * reading which
 * rests on prose fragments ("a starting XY coordinate and length may be
 * specified") plus the XSD attribute inventory. NO
 * complete official `Row/Column` example exists in any public source. The
 * falsifier is Figure A1-1a. Consumed by exactly one function,
 * {@link decodeRowColumnRuns}.
 */
export interface E142BinRun {
    /** SERIALIZATION column index of the run's FIRST cell (start X, converted). */
    x: number;
    /** SERIALIZATION row index of the run (start Y, converted), 0 = top. */
    y: number;
    /**
     * The element's text content. The run fills consecutive cells in the +X
     * direction; its LENGTH IS THE TOKEN COUNT - no `Length` attribute exists
     * in any XSD revision, so length is implicit.
     */
    tokens: string;
}

/**
 * Every payload shape {@link decodeBinPayload} accepts, discriminated by
 * {@link E142BinMeta.mapType} and NOT by inspection:
 *
 * | MapType      | accepted payload                                              |
 * | `2DArray`    | `string[]` (one row per element), `string` (newline-joined), `number[]` |
 * | `Array`      | `string` (one continuous token stream), `number[]`             |
 * | `Row/Column` | {@link E142BinRun}`[]`                                        |
 * | `Coordinate` | {@link E142CoordinateEntry}`[]`                               |
 *
 * `number[]` is one numeric value per cell, row-major, `cols * rows` long.
 * The sparse entry form is `Coordinate`-ONLY and rejected everywhere else.
 */
export type E142BinPayload = string | string[] | number[] | E142CoordinateEntry[] | E142BinRun[];

// ===================================================================
//  Typed error
// ===================================================================

/**
 * Discriminator of {@link E142DecodeError}. Stable, machine-readable, and
 * deliberately narrow - the human detail lives in the message, the location in
 * `row` / `col`.
 */
export type E142DecodeErrorCode =
    /** `meta.binType` is absent or not a member of {@link E142_BIN_TYPES}. */
    | 'BAD_BIN_TYPE'
    /** `meta.mapType` is absent or not a member of {@link E142_MAP_TYPES}. */
    | 'BAD_MAP_TYPE'
    /** `meta.nullBin` is not a well-formed token of `meta.binType`. */
    | 'BAD_NULL_BIN'
    /** `meta.xStep` is absent or not `1` / `-1`, and `meta.mapType` is `Row/Column`, which requires it. */
    | 'BAD_X_STEP'
    /** `dimension.cols` / `.rows` are not positive integers, or the lattice cannot be allocated. */
    | 'BAD_DIMENSION'
    /** The payload's SHAPE does not match `meta.mapType` (includes the sparse-outside-`Coordinate` rule). */
    | 'BAD_PAYLOAD_FORM'
    /** A token is malformed, out of range, or of the wrong width for `meta.binType`. */
    | 'BAD_TOKEN'
    /** The payload carries a different number of rows than `dimension.rows`. */
    | 'ROW_COUNT_MISMATCH'
    /** A row carries a different number of tokens than `dimension.cols`, or a run overruns its row. */
    | 'ROW_LENGTH_MISMATCH'
    /** A flat (`Array` / `number[]`) payload carries a different number of cells than `cols * rows`. */
    | 'CELL_COUNT_MISMATCH'
    /** A sparse X / Y addresses a cell outside the lattice. */
    | 'OUT_OF_RANGE'
    /** Two sparse entries / runs cover the same cell. */
    | 'DUPLICATE_CELL';

/**
 * The one error {@link decodeBinPayload} throws. Carries a machine-readable
 * {@link code}, a human message, and - wherever the defect can be pinned to a
 * cell - the SERIALIZATION `row` / `col` of the offending position (`row` 0 =
 * top, `col` 0 = left; the same index space as {@link DecodedBinPayload.cells}).
 *
 * A position is reported only when it is INSIDE the lattice, which cuts one
 * way: a payload that is too SHORT names the first cell it failed to deliver,
 * a payload that is too LONG names no position at all, because the surplus has
 * none. The counts are in the message either way. `row` without `col` means the
 * row is known but the column is meaningless (a row of the wrong length).
 *
 * Nothing else escapes this module: allocation failures and shape surprises are
 * translated, so a caller can `catch (e) { if (e instanceof E142DecodeError) }`
 * and be exhaustive.
 */
export class E142DecodeError extends Error {
    /** Machine-readable discriminator; switch on this, never on the message. */
    public readonly code: E142DecodeErrorCode;
    /** Serialization row index of the offending cell, when the defect has one. */
    public readonly row?: number;
    /** Serialization column index of the offending cell, when the defect has one. */
    public readonly col?: number;

    /**
     * @param code    The machine-readable discriminator.
     * @param message Human-readable detail; should name the concrete values seen.
     * @param row     Serialization row index of the offending cell, if any.
     * @param col     Serialization column index of the offending cell, if any.
     */
    public constructor(code: E142DecodeErrorCode, message: string, row?: number, col?: number) {
        super(message);
        this.name = 'E142DecodeError';
        this.code = code;
        this.row = row;
        this.col = col;
    }
}

// ===================================================================
//  Token grammar tables
//
//  The decoder never compares strings on the hot path. Instead every token has
//  a KEY - a small non-negative integer that is a LOSSLESS encoding of the
//  token - and the key indexes an Int32Array straight to the code index. Two
//  key spaces exist, one per payload family, and exactly one of them is live
//  per decode call:
//
//    STRING key space (string / string[] / run / string-bin payloads):
//      the token's characters, base-`radix` most-significant-first.
//        Ascii        key = code - 0x21             radix 94, width 1 ->     94
//        HexaDecimal  key = d0*22 + d1              radix 22, width 2 ->    484
//        Integer2     key = ((d0*22+d1)*22+d2)*22+d3          width 4 -> 234256
//        Decimal      key = the 3-digit value                          ->    256
//      `d` is the index of the hex character in HEX_DIGITS, so upper- and
//      lowercase hex map to DIFFERENT keys - which is exactly what the
//      DecodedBinPayload contract demands ("canonical token: exactly the wire
//      token for string payloads"). Folding case here would silently merge two
//      codes that `BinDefinition/@BinCode` (an `xs:string`, joined verbatim by
//      `buildGridModel`) still treats as distinct.
//
//    NUMERIC key space (number[] / number-bin payloads):
//      key = the value itself.
//        Ascii 0x21..0x7E -> 128, Decimal/HexaDecimal 0..255 -> 256,
//        Integer2 0..0xFFFF -> 65536.
//
//  Because key <-> token is a bijection inside one space, the canonical token
//  is RECONSTRUCTED from the key on first sight ({@link tokenFromKey}) and no
//  Map<string, int> is needed at all - see {@link decodeBinPayload}'s
//  PERFORMANCE note.
// ===================================================================

/** Lowest character code accepted as an `Ascii` bin token (`'!'`). See {@link ASCII_DIGIT}. */
const ASCII_MIN = 0x21;

/** Highest character code accepted as an `Ascii` bin token (`'~'`). See {@link ASCII_DIGIT}. */
const ASCII_MAX = 0x7e;

/** Size of the `Ascii` string key space: the printable, non-space ASCII range. */
const ASCII_RADIX = ASCII_MAX - ASCII_MIN + 1;

/**
 * The 22 characters that may appear in a `HexaDecimal` / `Integer2` token; the
 * INDEX of a character here is its base-22 key digit, and the first 16 entries
 * are the canonical (uppercase) spelling that {@link tokenFromValue} emits.
 */
const HEX_DIGITS = '0123456789ABCDEFabcdef';

/** Radix of the `HexaDecimal` / `Integer2` string key space: `HEX_DIGITS.length`. */
const HEX_RADIX = 22;

/** Largest `Decimal` / `HexaDecimal` bin value: 1 byte per die. */
const BYTE_MAX = 0xff;

/** Largest `Integer2` bin value: 2 bytes per die. */
const INTEGER2_MAX = 0xffff;

/** Number of digits in a `Decimal` token (`000`-`255`). */
const DECIMAL_WIDTH = 3;

/**
 * Character-code -> key-digit table for `Ascii`: printable, non-space ASCII maps
 * to `0 .. 93`, everything else to `-1`.
 *
 * INFERRED, NOT STATED. An `Ascii` token is described as a "single ASCII character", and
 * 6.5.4 (Artwork.com secondary source) calls it "1 printable character"; the two
 * disagree over control characters and space. Rejecting `0x00-0x20` and
 * `0x7F+` implements the narrower of the two, and is what makes indentation and
 * stray line breaks in an `<BinCode>` text node a reported BAD_TOKEN instead of
 * six silently invented bin codes. FALSIFIER: the `BinType` clause of the PDF.
 * If it turns out that space is a legal `Ascii` bin code, only this table
 * changes.
 */
const ASCII_DIGIT: Int8Array = (() => {
    const table = new Int8Array(128).fill(-1);
    for (let code = ASCII_MIN; code <= ASCII_MAX; code++) {
        table[code] = code - ASCII_MIN;
    }
    return table;
})();

/**
 * Character-code -> key-digit table for `HexaDecimal` / `Integer2`: the 22
 * characters of {@link HEX_DIGITS} map to their index, everything else to `-1`.
 * Doubles as the token validator: a negative digit IS a malformed token.
 */
const HEX_DIGIT: Int8Array = (() => {
    const table = new Int8Array(128).fill(-1);
    for (let i = 0; i < HEX_DIGITS.length; i++) {
        table[HEX_DIGITS.charCodeAt(i)] = i;
    }
    return table;
})();

/**
 * The fixed-width token grammars, i.e. everything except `Decimal`. One shared
 * scanner ({@link scanFixedRun}) is parameterized by this, which is why `Ascii`,
 * `HexaDecimal` and `Integer2` share a single hot loop.
 */
interface FixedGrammar {
    /** Characters per token: 1 (`Ascii`), 2 (`HexaDecimal`), 4 (`Integer2`). */
    width: number;
    /** Base of the string key space: 94 (`Ascii`) or 22 (hex). */
    radix: number;
    /** Character-code -> key-digit table; `-1` marks a character illegal for this grammar. */
    digit: Int8Array;
}

/** Grammar of the fixed-width bin types; `Decimal` is whitespace-delimited and has none. */
const FIXED_GRAMMAR: Readonly<Record<Exclude<E142BinType, 'Decimal'>, FixedGrammar>> = {
    Ascii: { width: 1, radix: ASCII_RADIX, digit: ASCII_DIGIT },
    HexaDecimal: { width: 2, radix: HEX_RADIX, digit: HEX_DIGIT },
    Integer2: { width: 4, radix: HEX_RADIX, digit: HEX_DIGIT },
};

/**
 * True for the whitespace-delimited bin type. `Decimal` is the ONE type whose
 * footnote #1 mandates separators ("there must be spaces added between each
 * device", in E142-0225's own words); the other three have no separators at all
 * (footnote #2), so for them any whitespace inside a payload is a bad token,
 * not a delimiter. That asymmetry is the format's, not this decoder's.
 * @param binType The bin type in question.
 * @returns `true` for `Decimal`.
 */
export function isDelimited(binType: E142BinType): boolean {
    return binType === 'Decimal';
}

/**
 * The separator a bin type needs when tokens are written back out.
 *
 * The inverse of {@link isDelimited} and defined beside it on purpose: a
 * serializer that guesses wrong produces a document that writes cleanly and
 * cannot be read back - `Decimal` concatenated is `BAD_TOKEN`, a fixed-width type
 * with spaces is `ROW_LENGTH_MISMATCH`. It lived in the JSON serializer until the
 * XML one needed it too; one rule, one place.
 * @param binType The bin type.
 * @returns The separator to join tokens with.
 */
export function tokenSeparator(binType: E142BinType): string {
    return isDelimited(binType) ? ' ' : '';
}

/**
 * Re-encodes a decoded payload into one token string per row.
 *
 * The model does not keep a `2DArray` or `Array` payload's original row text -
 * `DecodedBinPayload` holds cell indices and a code table, and the source bytes
 * are gone by the time a document exists. So the rows are rebuilt as
 * `codes[cells[i]]`. Lossless for every CELL VALUE and lossy for the source's
 * incidental whitespace, which is the correct trade for a round trip defined over
 * the MODEL rather than over bytes.
 * @param payload The decoded payload.
 * @param binType The bin type, for the separator.
 * @returns One token string per row.
 */
export function encodePayloadRows(
    payload: { readonly cols: number; readonly rows: number;
        readonly cells: Uint32Array; readonly codes: readonly string[] },
    binType: E142BinType,
): string[] {
    const sep = tokenSeparator(binType);
    const out: string[] = [];
    for (let y = 0; y < payload.rows; y++) {
        const row: string[] = [];
        for (let x = 0; x < payload.cols; x++) {
            row.push(payload.codes[payload.cells[y * payload.cols + x]] ?? '');
        }
        out.push(row.join(sep));
    }
    return out;
}

/**
 * Size of the string key space of a bin type, i.e. the length of the
 * `key -> codeIndex` table for string-shaped payloads.
 * @param binType The bin type.
 * @returns `radix ** width` for the fixed grammars, 256 for `Decimal`.
 */
function stringKeySpace(binType: E142BinType): number {
    if (binType === 'Decimal') {
        return BYTE_MAX + 1;
    }
    const g = FIXED_GRAMMAR[binType];
    return Math.pow(g.radix, g.width);
}

/**
 * Size of the numeric key space of a bin type (`key === value`), i.e. the length
 * of the `value -> codeIndex` table for `number`-shaped payloads.
 * @param binType The bin type.
 * @returns One past the largest legal value.
 */
function numericKeySpace(binType: E142BinType): number {
    switch (binType) {
        case 'Ascii': return 128;                 // 0x21..0x7E live inside; see ASCII_DIGIT
        case 'Decimal': return BYTE_MAX + 1;
        case 'HexaDecimal': return BYTE_MAX + 1;
        case 'Integer2': return INTEGER2_MAX + 1;
        default: { const _never: never = binType; return _never; }
    }
}

/**
     * Whether a number is a legal bin VALUE of the given type. `Ascii` is a
     * character code restricted to {@link ASCII_DIGIT}'s range, `Decimal` and
     * `HexaDecimal` are one byte, `Integer2` two. The byte widths are stated by
     * the standard; the `Ascii` range is inferred - see {@link ASCII_DIGIT}.
 * @param binType The bin type.
 * @param value   The candidate value.
 * @returns `true` when `value` is an integer inside the type's range.
 */
function isLegalValue(binType: E142BinType, value: number): boolean {
    if (!Number.isInteger(value)) {
        return false;
    }
    switch (binType) {
        case 'Ascii': return value >= ASCII_MIN && value <= ASCII_MAX;
        case 'Decimal': return value >= 0 && value <= BYTE_MAX;
        case 'HexaDecimal': return value >= 0 && value <= BYTE_MAX;
        case 'Integer2': return value >= 0 && value <= INTEGER2_MAX;
        default: { const _never: never = binType; return _never; }
    }
}

/**
 * Canonical token of a bin VALUE, i.e. the `codes` entry a numeric payload
 * produces. Verbatim from the {@link DecodedBinPayload} contract: "for numeric
 * payloads the number formatted per BinType (Ascii: the single character;
 * Decimal: 3-digit zero-padded; HexaDecimal: 2 uppercase hex digits; Integer2:
 * 4 uppercase hex digits)".
 *
 * Called ONCE PER DISTINCT CODE, never per cell.
 * @param binType The bin type.
 * @param value   A value that passed {@link isLegalValue}.
 * @returns The canonical token.
 */
function tokenFromValue(binType: E142BinType, value: number): string {
    switch (binType) {
        case 'Ascii': return String.fromCharCode(value);
        case 'Decimal': return String(value).padStart(DECIMAL_WIDTH, '0');
        case 'HexaDecimal': return value.toString(16).toUpperCase().padStart(2, '0');
        case 'Integer2': return value.toString(16).toUpperCase().padStart(4, '0');
        default: { const _never: never = binType; return _never; }
    }
}

/**
 * Canonical token of a STRING key, i.e. the `codes` entry a string payload
 * produces. Verbatim from the {@link DecodedBinPayload} contract: "exactly the
 * wire token for string payloads" - which the string key space delivers by
 * construction, because it is a lossless base-`radix` encoding of the token's
 * own characters (CASE INCLUDED, see the key-space banner above).
 *
 * Called ONCE PER DISTINCT CODE, never per cell - which is why the decoder
 * needs no `substring` on the hot path and no `Map<string, int>` anywhere.
 * @param binType The bin type.
 * @param key     A key produced by this module's scanners for `binType`.
 * @returns The canonical token.
 */
function tokenFromKey(binType: E142BinType, key: number): string {
    if (binType === 'Decimal') {
        return tokenFromValue('Decimal', key);        // Decimal's string key IS its value
    }
    const g = FIXED_GRAMMAR[binType];
    const chars: string[] = new Array(g.width);
    let rest = key;
    for (let i = g.width - 1; i >= 0; i--) {
        const d = rest % g.radix;
        rest = (rest - d) / g.radix;
        chars[i] = binType === 'Ascii' ? String.fromCharCode(d + ASCII_MIN) : HEX_DIGITS.charAt(d);
    }
    return chars.join('');
}

/**
 * The bin VALUE behind a STRING key - the bridge between the two key spaces,
 * needed exactly once per decode: to seed the NullBin into a numeric payload's
 * table (the NullBin arrives as a wire token even when the cells arrive as
 * numbers).
 * @param binType The bin type.
 * @param key     A key produced by this module's scanners for `binType`.
 * @returns The value the token denotes.
 */
function valueFromKey(binType: E142BinType, key: number): number {
    switch (binType) {
        case 'Decimal':
            return key;                               // Decimal's string key IS its value
        case 'Ascii':
            return key + ASCII_MIN;
        case 'HexaDecimal':
        case 'Integer2': {
            const g = FIXED_GRAMMAR[binType];
            let rest = key;
            let value = 0;
            let place = 1;
            for (let i = 0; i < g.width; i++) {
                const d = rest % HEX_RADIX;
                rest = (rest - d) / HEX_RADIX;
                // HEX_DIGITS is '0-9A-Fa-f': index 16..21 are the lowercase
                // duplicates of 10..15, so the nibble is `d` minus that offset.
                value += (d < 16 ? d : d - 6) * place;
                place *= 16;
            }
            return value;
        }
        default: { const _never: never = binType; return _never; }
    }
}

/**
 * True for the characters the `Decimal` grammar accepts as a token separator.
 * Space, tab, CR and LF - "spaces added between each device" plus "each row of
 * devices should be on a new line", quoted from E142-0225's footnote.
 * @param code A UTF-16 code unit.
 * @returns `true` when `code` separates two `Decimal` tokens.
 */
function isSpace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/**
 * Parses ONE complete token and returns its STRING key, or `-1` when the token
 * is malformed. Used for whole-string tokens only - `NullBin` and a
 * `Coordinate` entry's `bin` - never per cell; the dense paths compute the same
 * keys directly from character codes ({@link scanFixedRun} /
 * {@link scanDecimalRun}) and MUST stay in agreement with this function.
 *
 * For `Decimal` surrounding whitespace is accepted, because whitespace IS that
 * grammar's delimiter; for the fixed-width grammars the string must be exactly
 * `width` characters long, because those grammars have no delimiter at all.
 * @param binType The bin type.
 * @param token   The candidate token.
 * @returns The string key, or `-1` when `token` is not a well-formed token.
 */
function parseTokenKey(binType: E142BinType, token: unknown): number {
    if (typeof token !== 'string') {
        return -1;
    }
    if (binType === 'Decimal') {
        let p = 0;
        const len = token.length;
        while (p < len && isSpace(token.charCodeAt(p))) { p++; }
        if (p + DECIMAL_WIDTH > len) {
            return -1;
        }
        let value = 0;
        for (let k = 0; k < DECIMAL_WIDTH; k++) {
            const d = token.charCodeAt(p + k) - 0x30;
            if (d < 0 || d > 9) {
                return -1;
            }
            value = value * 10 + d;
        }
        p += DECIMAL_WIDTH;
        while (p < len && isSpace(token.charCodeAt(p))) { p++; }
        if (p !== len || value > BYTE_MAX) {
            return -1;                                // trailing junk, or 256..999
        }
        return value;
    }
    const g = FIXED_GRAMMAR[binType];
    if (token.length !== g.width) {
        return -1;
    }
    let key = 0;
    for (let k = 0; k < g.width; k++) {
        const code = token.charCodeAt(k);
        const d = code < 128 ? g.digit[code] : -1;
        if (d < 0) {
            return -1;
        }
        key = key * g.radix + d;
    }
    return key;
}

// ===================================================================
//  Code interning
// ===================================================================

/**
 * The growing `codes` table of a decode plus its `key -> index` lookup. One
 * instance per {@link decodeBinPayload} call; the key space it is built over
 * ({@link CodeSink.numeric}) is fixed for the whole call, because a payload is
 * either token-shaped or number-shaped, never both.
 */
interface CodeSink {
    /** The bin type; decides how a first-seen key becomes a canonical token. */
    binType: E142BinType;
    /** `true` when `table` is indexed by bin VALUE, `false` when by string key. */
    numeric: boolean;
    /** The result's `codes`, seeded with `codes[0] = NullBin` and grown in first-seen order. */
    codes: string[];
    /** `key -> index into codes`; `-1` = not seen yet. Seeded with `table[nullKey] = 0`. */
    table: Int32Array;
}

/**
 * Builds the sink for one decode: validates `NullBin`, allocates the lookup and
 * SEEDS the NullBin's key with index 0.
 *
 * Seeding is what implements "NullBin comparison on canonical tokens" without a
 * single comparison on the hot path: the null token owns a key like any other
 * token, so a cell carrying it simply resolves to index 0.
 *
 * `codes[0]` is `nullBin` VERBATIM, not a re-formatted value. It is a wire
 * token in every input path (an XML attribute, a JSON field, an E142.4
 * reassembly of the same XML), so "exactly the wire token" is already its
 * canonical form; and per the {@link DecodedBinPayload} / `GridModel` contract
 * the null bin is never painted, never hit and never joined against a
 * `BinDefinition`, so its spelling is inert downstream.
 *
 * CONSEQUENCE, deliberate and contract-mandated: under a STRING payload the
 * NullBin match is case-sensitive for hex types (`NullBin="F0"` does NOT match
 * a wire token `f0`, and the two would become two distinct codes), while under
 * a NUMERIC payload it is case-insensitive (both spell value 240). That
 * asymmetry is inherited from the contract's own definition of "canonical" and
 * is not repaired here.
 * @param binType The bin type.
 * @param nullBin The `BinCodeMap/@NullBin` attribute value.
 * @param numeric `true` for a `number`-shaped payload.
 * @returns The seeded sink.
 * @throws {E142DecodeError} `BAD_NULL_BIN` when `nullBin` is not a well-formed token of `binType`.
 */
function makeSink(binType: E142BinType, nullBin: string, numeric: boolean): CodeSink {
    const nullKey = parseTokenKey(binType, nullBin);
    if (nullKey < 0) {
        throw new E142DecodeError(
            'BAD_NULL_BIN',
            `BinCodeMap/@NullBin ${JSON.stringify(nullBin)} is not a well-formed ${binType} token `
            + `(${describeGrammar(binType)}). BinType and NullBin sit on the same element and must agree; `
            + `a NullBin no cell can ever carry would silently produce a map without a single null cell.`,
        );
    }
    const table = new Int32Array(numeric ? numericKeySpace(binType) : stringKeySpace(binType)).fill(-1);
    table[numeric ? valueFromKey(binType, nullKey) : nullKey] = 0;
    return { binType, numeric, codes: [nullBin], table };
}

/**
 * Registers a first-seen key and returns its brand-new code index. Never
 * returns 0: index 0 is the NullBin, pre-seeded by {@link makeSink}. Called at
 * most once per DISTINCT code, so its string work is off the hot path.
 * @param sink The sink of the running decode.
 * @param key  A key that {@link CodeSink.table} maps to `-1`.
 * @returns The new index into {@link CodeSink.codes}.
 */
function internKey(sink: CodeSink, key: number): number {
    const index = sink.codes.length;
    sink.codes.push(sink.numeric ? tokenFromValue(sink.binType, key) : tokenFromKey(sink.binType, key));
    sink.table[key] = index;
    return index;
}

/**
 * One-line description of a bin type's token grammar, for error messages.
 * @param binType The bin type.
 * @returns A human-readable grammar summary.
 */
function describeGrammar(binType: E142BinType): string {
    switch (binType) {
        case 'Ascii': return 'exactly 1 printable ASCII character, 0x21..0x7E';
        case 'Decimal': return 'exactly 3 decimal digits, 000..255, whitespace-separated';
        case 'HexaDecimal': return 'exactly 2 hexadecimal digits, 00..FF';
        case 'Integer2': return 'exactly 4 hexadecimal digits, 0000..FFFF';
        default: { const _never: never = binType; return _never; }
    }
}

// ===================================================================
//  Scanners  (the hot path)
//
//  Both scanners write `count` cells starting at the LINEAR index `base`, and
//  derive a defect's (row, col) from the linear index, so one implementation
//  serves the row-wise (`2DArray`), flat (`Array`) and run (`Row/Column`)
//  layouts. Neither allocates anything per cell.
// ===================================================================

/**
 * Scans `count` fixed-width tokens out of `src[from ...]` into `cells[base ...]`.
 * The caller has already proven that `count * width` characters are available -
 * for the dense layouts by a string-length check, for a run by a bounds check -
 * so this loop does no length arithmetic at all.
 *
 * PER CELL this executes: `width` `charCodeAt`s, `width` table reads, `width`
 * multiply-adds, one `Int32Array` read and one `Uint32Array` write. No
 * substring, no string comparison, no allocation, no `Map`.
 * @param src   The payload string.
 * @param from  Index of the first character to read.
 * @param base  Linear cell index of the first cell to write.
 * @param count Number of tokens to scan.
 * @param step  Linear cell stride between consecutive tokens: `+1` everywhere
 *              except a `Row/Column` run under a `Left` X axis, which fills
 *              backwards - see {@link E142BinMeta.xStep}. The caller has
 *              already proven every cell from `base` to `base + (count-1)*step`
 *              is inside the lattice.
 * @param cols  Lattice width, for turning a linear index into (row, col) on error.
 * @param sink  The sink of the running decode.
 * @param cells The output lattice.
 * @throws {E142DecodeError} `BAD_TOKEN` naming the offending row and column.
 */
function scanFixedRun(
    src: string,
    from: number,
    base: number,
    count: number,
    step: number,
    cols: number,
    sink: CodeSink,
    cells: Uint32Array,
): void {
    const g = FIXED_GRAMMAR[sink.binType as Exclude<E142BinType, 'Decimal'>];
    const width = g.width;
    const radix = g.radix;
    const digit = g.digit;
    const table = sink.table;
    let p = from;
    let cursor = base;
    for (let i = 0; i < count; i++) {
        let key = 0;
        for (let k = 0; k < width; k++) {
            const code = src.charCodeAt(p++);
            // `code < 128` also fences off the Int8Array's `undefined` tail: a
            // typed array read past its end yields `undefined`, and
            // `undefined < 0` is false - which would wave every non-ASCII
            // character straight through.
            const d = code < 128 ? digit[code] : -1;
            if (d < 0) {
                throw new E142DecodeError(
                    'BAD_TOKEN',
                    `${sink.binType} token ${JSON.stringify(src.substring(p - k - 1, p - k - 1 + width))} at row `
                    + `${(cursor / cols) | 0}, column ${cursor % cols} is malformed `
                    + `(${describeGrammar(sink.binType)}).`,
                    (cursor / cols) | 0,
                    cursor % cols,
                );
            }
            key = key * radix + d;
        }
        let index = table[key];
        if (index < 0) {
            index = internKey(sink, key);
        }
        cells[cursor] = index;
        cursor += step;
    }
}

/**
 * Scans exactly `count` whitespace-delimited `Decimal` tokens out of
 * `src[from ... to)` into `cells[base ...]`, and requires the remainder to be
 * whitespace only. Both "too few" and "too many" raise `lengthCode`, so the
 * caller decides whether a wrong token count is a row-length or a cell-count
 * defect. Per {@link E142DecodeError}'s rule, "too few" names the first cell it
 * failed to deliver and "too many" names no position.
 *
 * `Decimal` is the delimited grammar, so leading,
 * trailing and repeated separators are part of the format, NOT leniency; the
 * fixed-width grammars, having no delimiter, treat the same characters as bad
 * tokens.
 * @param src        The payload string.
 * @param from       Index of the first character to read.
 * @param to         Index one past the last character to read.
 * @param base       Linear cell index of the first cell to write.
 * @param count      Number of tokens expected.
 * @param step       Linear cell stride between consecutive tokens; see {@link scanFixedRun}.
 * @param cols       Lattice width, for turning a linear index into (row, col) on error.
 * @param sink       The sink of the running decode.
 * @param cells      The output lattice.
 * @param lengthCode The error code for a wrong token count.
 * @param lengthWhat Human-readable name of the counted unit, for the message.
 * @throws {E142DecodeError} `BAD_TOKEN`, or `lengthCode` on a token-count mismatch.
 */
function scanDecimalRun(
    src: string,
    from: number,
    to: number,
    base: number,
    count: number,
    step: number,
    cols: number,
    sink: CodeSink,
    cells: Uint32Array,
    lengthCode: E142DecodeErrorCode,
    lengthWhat: string,
): void {
    const table = sink.table;
    let p = from;
    let cursor = base;
    let i = 0;
    for (;;) {
        while (p < to && isSpace(src.charCodeAt(p))) { p++; }
        if (p >= to) {
            break;
        }
        if (i === count) {
            throw new E142DecodeError(
                lengthCode,
                `${lengthWhat}: expected ${count} Decimal tokens, found more.`,
            );
        }
        const row = (cursor / cols) | 0;
        const col = cursor % cols;
        let value = 0;
        let k = 0;
        for (; k < DECIMAL_WIDTH && p + k < to; k++) {
            const d = src.charCodeAt(p + k) - 0x30;
            if (d < 0 || d > 9) {
                break;
            }
            value = value * 10 + d;
        }
        const after = p + DECIMAL_WIDTH;
        if (k !== DECIMAL_WIDTH || value > BYTE_MAX || (after < to && !isSpace(src.charCodeAt(after)))) {
            throw new E142DecodeError(
                'BAD_TOKEN',
                `Decimal token ${JSON.stringify(src.substring(p, Math.min(to, p + DECIMAL_WIDTH + 1)))} at row `
                + `${row}, column ${col} is malformed (${describeGrammar('Decimal')}).`,
                row,
                col,
            );
        }
        p = after;
        let index = table[value];
        if (index < 0) {
            index = internKey(sink, value);
        }
        cells[cursor] = index;
        cursor += step;
        i++;
    }
    if (i !== count) {
        throw new E142DecodeError(
            lengthCode,
            `${lengthWhat}: expected ${count} Decimal tokens, found ${i}.`,
            (cursor / cols) | 0,
            cursor % cols,
        );
    }
}

// ===================================================================
//  Payload-shape helpers
// ===================================================================

/**
 * Splits a newline-joined payload into rows. Drops ONE trailing line terminator
 * (a text block is newline-TERMINATED at least as often as newline-SEPARATED)
 * and then splits on every remaining `\r\n`, `\n` or `\r`. No other blank line
 * is dropped and nothing is trimmed - that would be the lenient mode this
 * decoder does not have; an empty interior line simply becomes a row of length
 * zero and fails the row-length check.
 *
 * The only per-ROW allocation of the whole decoder, and it is unavoidable: the
 * caller handed one string, the format is one row per element.
 * @param text The newline-joined payload.
 * @returns One string per row.
 */
function splitLines(text: string): string[] {
    let body = text;
    if (body.endsWith('\n')) {
        body = body.slice(0, -1);
    }
    if (body.endsWith('\r')) {
        body = body.slice(0, -1);
    }
    return body.split(/\r\n|\n|\r/);
}

/**
 * True when a payload array carries the sparse entry form (objects) rather than
 * tokens or values. Only the FIRST element is inspected; the per-element checks
 * in the sparse decoders catch a mixed array.
 * @param payload A payload array.
 * @returns `true` when the first element is a non-null object.
 */
function looksSparse(payload: readonly unknown[]): boolean {
    const first = payload[0];
    return typeof first === 'object' && first !== null;
}

/**
 * Rejects a payload whose shape cannot belong to the declared `MapType`. The
 * message names the sparse restriction explicitly whenever it applies, because
 * "sparse entries outside `Coordinate`" is the single most likely caller
 * mistake - `Coordinate` is the only layout that carries a position per device
 * ("The X and Y coordinates must both be included", quoted from E142-0225).
 * @param mapType  The declared map type.
 * @param payload  The payload as received.
 * @param accepted Human-readable list of the shapes this map type accepts.
 * @returns Never; always throws.
 * @throws {E142DecodeError} `BAD_PAYLOAD_FORM`.
 */
function rejectForm(mapType: E142MapType, payload: unknown, accepted: string): never {
    const sparse = Array.isArray(payload) && payload.length > 0 && looksSparse(payload);
    throw new E142DecodeError(
        'BAD_PAYLOAD_FORM',
        `MapType ${JSON.stringify(mapType)} accepts ${accepted}; received ${describeShape(payload)}.`
        + (sparse ? ' The sparse entry form is valid for MapType "Coordinate" ONLY.' : ''),
    );
}

/**
 * One-line description of a payload's runtime shape, for error messages.
 * @param payload The payload as received.
 * @returns A human-readable shape summary.
 */
function describeShape(payload: unknown): string {
    if (typeof payload === 'string') {
        return `a string of length ${payload.length}`;
    }
    if (!Array.isArray(payload)) {
        return `a value of type ${payload === null ? 'null' : typeof payload}`;
    }
    if (payload.length === 0) {
        return 'an empty array';
    }
    return `an array of ${typeof payload[0]} (length ${payload.length})`;
}

// ===================================================================
//  Dense layouts:  2DArray  and  Array
// ===================================================================

/**
 * Decodes the row-wise layout: `MapType="2DArray"`, one `<BinCode>` element per
 * row of the map view, position implicit in element order ("The most readable
 * approach is to represent all the devices in a row in a single BinCode entry",
 * quoted from E142-0225; one element per row is structurally confirmed by every
 * real example found, including SEMI's own `BinCodeMap-Example.xml`, REKON
 * 6.5.3 / 7.3).
 *
 * Row `0` is the TOP row of the map view and tokens run left to right. This is
 * inferred: the serialization order is VISUAL and independent of
 * `OriginLocation` / `AxisDirection`, which only LABEL the visual grid.
 * FALSIFIER: Figure A1-1b and the 2DArray clause. This module never sees the
 * logical frame at all, so if that inference falls, this function does not change - only
 * the caller's index mapping does.
 * @param binType   The bin type.
 * @param nullBin   The `NullBin` attribute value.
 * @param cols      Serialization columns.
 * @param rows      Serialization rows.
 * @param cells     The zero-filled output lattice (`cols * rows` long).
 * @param payload   `string[]`, a newline-joined `string`, or a row-major `number[]`.
 * @returns The decoded payload.
 * @throws {E142DecodeError} On any shape, length or token defect.
 */
function decode2DArray(
    binType: E142BinType,
    nullBin: string,
    cols: number,
    rows: number,
    cells: Uint32Array,
    payload: E142BinPayload,
): DecodedBinPayload {
    let lines: string[];
    if (typeof payload === 'string') {
        lines = splitLines(payload);
    } else if (Array.isArray(payload)) {
        if (payload.length > 0 && typeof payload[0] === 'number') {
            return decodeNumericCells(binType, nullBin, cols, rows, cells, payload as number[]);
        }
        if (payload.length > 0 && typeof payload[0] !== 'string') {
            rejectForm('2DArray', payload, 'string[] (one row per element), a newline-joined string, or number[]');
        }
        lines = payload as string[];
    } else {
        rejectForm('2DArray', payload, 'string[] (one row per element), a newline-joined string, or number[]');
    }

    if (lines.length !== rows) {
        throw new E142DecodeError(
            'ROW_COUNT_MISMATCH',
            `Expected ${rows} rows, received ${lines.length}.`,
            lines.length < rows ? lines.length : undefined,
        );
    }
    const sink = makeSink(binType, nullBin, false);
    const delimited = isDelimited(binType);
    const width = delimited ? 0 : FIXED_GRAMMAR[binType as Exclude<E142BinType, 'Decimal'>].width;
    for (let r = 0; r < rows; r++) {
        const line = lines[r];
        if (typeof line !== 'string') {
            throw new E142DecodeError(
                'BAD_PAYLOAD_FORM',
                `Row ${r} is ${describeShape(line)}, expected a string.`,
                r,
            );
        }
        const base = r * cols;
        if (delimited) {
            scanDecimalRun(
                line, 0, line.length, base, cols, 1, cols, sink, cells, 'ROW_LENGTH_MISMATCH', `Row ${r}`,
            );
        } else {
            if (line.length !== cols * width) {
                const seen = (line.length / width) | 0;
                throw new E142DecodeError(
                    'ROW_LENGTH_MISMATCH',
                    `Row ${r}: expected ${cols} ${binType} tokens = ${cols * width} characters, `
                    + `received ${line.length}.`,
                    r,
                    seen < cols ? seen : undefined,
                );
            }
            scanFixedRun(line, 0, base, cols, 1, cols, sink, cells);
        }
    }
    return { cols, rows, cells, codes: sink.codes };
}

/**
 * Decodes the compact layout: `MapType="Array"`, the whole map in ONE
 * `<BinCode>` element, row-major, starting top left ("For a more compact
 * representation, a single BinCode object can include the entire array of bin
 * codes in row major format starting at the top left", quoted from E142-0225).
 *
 * There are no row breaks in this layout, so for the fixed-width
 * grammars a newline inside the stream is a bad token, not a separator - while
 * for `Decimal`, whose grammar is delimited, it is simply another separator.
 * @param binType The bin type.
 * @param nullBin The `NullBin` attribute value.
 * @param cols    Serialization columns.
 * @param rows    Serialization rows.
 * @param cells   The zero-filled output lattice (`cols * rows` long).
 * @param payload One continuous `string`, or a row-major `number[]`.
 * @returns The decoded payload.
 * @throws {E142DecodeError} On any shape, length or token defect.
 */
function decodeArray(
    binType: E142BinType,
    nullBin: string,
    cols: number,
    rows: number,
    cells: Uint32Array,
    payload: E142BinPayload,
): DecodedBinPayload {
    if (Array.isArray(payload)) {
        if (payload.length === 0 || typeof payload[0] === 'number') {
            return decodeNumericCells(binType, nullBin, cols, rows, cells, payload as number[]);
        }
        rejectForm('Array', payload, 'one continuous token stream (string) or a row-major number[]');
    }
    if (typeof payload !== 'string') {
        rejectForm('Array', payload, 'one continuous token stream (string) or a row-major number[]');
    }
    const n = cols * rows;
    const sink = makeSink(binType, nullBin, false);
    if (isDelimited(binType)) {
        scanDecimalRun(
            payload, 0, payload.length, 0, n, 1, cols, sink, cells, 'CELL_COUNT_MISMATCH', 'Array payload',
        );
    } else {
        const width = FIXED_GRAMMAR[binType as Exclude<E142BinType, 'Decimal'>].width;
        if (payload.length !== n * width) {
            const seen = (payload.length / width) | 0;
            throw new E142DecodeError(
                'CELL_COUNT_MISMATCH',
                `Array payload: expected ${n} ${binType} tokens = ${n * width} characters, `
                + `received ${payload.length}.`,
                seen < n ? (seen / cols) | 0 : undefined,
                seen < n ? seen % cols : undefined,
            );
        }
        scanFixedRun(payload, 0, 0, n, 1, cols, sink, cells);
    }
    return { cols, rows, cells, codes: sink.codes };
}

/**
 * Decodes a `number[]` payload: one numeric bin VALUE per cell, row-major,
 * `cols * rows` long. The shape a JSON input path naturally produces, and the
 * only shape that lives in the numeric key space - `codes` therefore carries
 * the FORMATTED canonical tokens (`240 -> "F0"`, `7 -> "007"`), per the
 * {@link DecodedBinPayload} contract.
 * @param binType The bin type.
 * @param nullBin The `NullBin` attribute value.
 * @param cols    Serialization columns.
 * @param rows    Serialization rows.
 * @param cells   The zero-filled output lattice (`cols * rows` long).
 * @param values  One value per cell, row-major.
 * @returns The decoded payload.
 * @throws {E142DecodeError} `CELL_COUNT_MISMATCH` or `BAD_TOKEN`.
 */
function decodeNumericCells(
    binType: E142BinType,
    nullBin: string,
    cols: number,
    rows: number,
    cells: Uint32Array,
    values: readonly number[],
): DecodedBinPayload {
    const n = cols * rows;
    if (values.length !== n) {
        const at = values.length;
        throw new E142DecodeError(
            'CELL_COUNT_MISMATCH',
            `Numeric payload: expected ${n} values (${cols} x ${rows}), received ${values.length}.`,
            at < n ? (at / cols) | 0 : undefined,
            at < n ? at % cols : undefined,
        );
    }
    const sink = makeSink(binType, nullBin, true);
    const table = sink.table;
    for (let i = 0; i < n; i++) {
        const value = values[i];
        if (typeof value !== 'number' || !isLegalValue(binType, value)) {
            throw new E142DecodeError(
                'BAD_TOKEN',
                `${binType} value ${JSON.stringify(value)} at row ${(i / cols) | 0}, column ${i % cols} `
                + `is out of range (${describeGrammar(binType)}).`,
                (i / cols) | 0,
                i % cols,
            );
        }
        let index = table[value];
        if (index < 0) {
            index = internKey(sink, value);
        }
        cells[i] = index;
    }
    return { cols, rows, cells, codes: sink.codes };
}

// ===================================================================
//  Sparse layouts:  Coordinate  and  Row/Column
// ===================================================================

/**
 * Decodes `MapType="Coordinate"`: one `<BinCode X="" Y="">token</BinCode>` per
 * device, position fully explicit, cells named by nobody left NullBin.
 *
 * `X` and `Y` are both required and the content is exactly one token, in the
 * standard's own words. `Number` is ignored and `LID`-only entries cannot be
 * placed - both readings inferred - and both are filtered by the caller, which is also
 * why neither field appears in {@link E142CoordinateEntry}.
 *
 * All entries must use the SAME `bin` form (all tokens or all values), because
 * the two forms live in different key spaces and the choice is made once per
 * decode; the FIRST entry decides and a deviating one is a `BAD_PAYLOAD_FORM`.
 *
 * `codes` order is first-seen in ELEMENT order. Element order is otherwise
 * irrelevant (the coordinates carry the position), so reordering a payload can
 * permute `codes` and hence the values in `cells` - but never the token a cell
 * resolves to, which is the only thing `buildGridModel` and the renderer see.
 *
 * DUPLICATES are rejected. The material is silent on repeated coordinates;
 * erroring is the reading that follows "a separate BinCode object for each
 * individual device", quoted from E142-0225, and matches the overlap rule for
 * the sibling sparse layout, and it is fail-loud rather than silently
 * first-wins. Detection uses a `Uint8Array` coverage mask, because a legal
 * entry may itself carry the NullBin token and would then be indistinguishable
 * from an untouched cell.
 * @param binType The bin type.
 * @param nullBin The `NullBin` attribute value.
 * @param cols    Serialization columns.
 * @param rows    Serialization rows.
 * @param cells   The zero-filled output lattice (`cols * rows` long).
 * @param payload The sparse entry array.
 * @returns The decoded payload.
 * @throws {E142DecodeError} On any shape, range, duplicate or token defect.
 */
function decodeCoordinate(
    binType: E142BinType,
    nullBin: string,
    cols: number,
    rows: number,
    cells: Uint32Array,
    payload: E142BinPayload,
): DecodedBinPayload {
    if (!Array.isArray(payload) || (payload.length > 0 && !looksSparse(payload))) {
        rejectForm('Coordinate', payload, 'a sparse array of { x, y, bin } entries');
    }
    const entries = payload as readonly E142CoordinateEntry[];
    const numeric = entries.length > 0 && typeof entries[0].bin === 'number';
    const sink = makeSink(binType, nullBin, numeric);
    const table = sink.table;
    const covered = new Uint8Array(cols * rows);

    for (let e = 0; e < entries.length; e++) {
        const entry = entries[e];
        if (!entry || typeof entry !== 'object') {
            throw new E142DecodeError(
                'BAD_PAYLOAD_FORM',
                `Coordinate entry ${e} is ${describeShape(entry)}, expected { x, y, bin }.`,
            );
        }
        const index = cellIndex(entry.x, entry.y, cols, rows, `Coordinate entry ${e}`);
        if (covered[index] !== 0) {
            throw new E142DecodeError(
                'DUPLICATE_CELL',
                `Coordinate entry ${e} addresses row ${entry.y}, column ${entry.x}, which an earlier entry `
                + `already covers; MapType "Coordinate" carries one BinCode element per device.`,
                entry.y,
                entry.x,
            );
        }
        covered[index] = 1;

        let key: number;
        if (numeric) {
            if (typeof entry.bin !== 'number' || !isLegalValue(binType, entry.bin)) {
                throw new E142DecodeError(
                    typeof entry.bin === 'number' ? 'BAD_TOKEN' : 'BAD_PAYLOAD_FORM',
                    `Coordinate entry ${e} (row ${entry.y}, column ${entry.x}) carries `
                    + `${JSON.stringify(entry.bin)}; this payload's first entry fixed the numeric form, so every `
                    + `bin must be a ${binType} value (${describeGrammar(binType)}).`,
                    entry.y,
                    entry.x,
                );
            }
            key = entry.bin;
        } else {
            key = parseTokenKey(binType, entry.bin);
            if (key < 0) {
                throw new E142DecodeError(
                    typeof entry.bin === 'string' ? 'BAD_TOKEN' : 'BAD_PAYLOAD_FORM',
                    `Coordinate entry ${e} (row ${entry.y}, column ${entry.x}) carries `
                    + `${JSON.stringify(entry.bin)}; expected exactly one ${binType} token `
                    + `(${describeGrammar(binType)}).`,
                    entry.y,
                    entry.x,
                );
            }
        }
        let code = table[key];
        if (code < 0) {
            code = internKey(sink, key);
        }
        cells[index] = code;
    }
    return { cols, rows, cells, codes: sink.codes };
}

/**
 * SEAM - `MapType="Row/Column"`. WEAKLY EVIDENCED, QUARANTINED BY DESIGN.
 *
 * The entire Row/Column reading is implemented here and nowhere
 * else, so if the standard's Figure A1-1a "Row/Column Format", or any worked
 * example, ever contradicts it, this function can be rewritten without touching
 * {@link decodeBinPayload} or any caller. What it encodes - the run rules the
 * code below cites by number:
 *
 *  1. Each `<BinCode>` element carries start attributes `X` and `Y` and its
 *     text content holds the run's tokens.
 *  2. The run fills consecutive cells in the +X LOGICAL direction starting at
 *     (X, Y); RUN LENGTH = TOKEN COUNT. No `Length` attribute exists in any XSD
 *     revision, so length is implicit.
 *  3. Cells covered by no run are NullBin. Element ORDER IS IRRELEVANT - the
 *     start coordinates make it so.
 *  4. Overlapping runs, and runs exceeding the row's logical X range, are typed
 *     errors.
 *  5. The `Number` attribute is NOT used by Row/Column.
 *
 * Why C+: the basis is the prose fragment "a starting XY coordinate and length
 * may be specified" plus the XSD attribute inventory plus the absence of a
 * `Length` attribute, and NO complete official
 * `Row/Column` example exists in any public source, in any language.
 *
 * Note the tension inside rule 2: the prose says a "length MAY be specified",
 * yet no revision of the schema provides anywhere to specify it. This module
 * resolves that by making the token count the length. If the figure shows otherwise -
 * say, a length encoded in `Number` (which rule 5 currently forbids) - only
 * this function moves.
 *
 * THE ONE PLACE THIS MODULE TOUCHES THE LOGICAL FRAME, and it is unavoidable.
 * `x` / `y` are SERIALIZATION indices - the caller has already mapped the
 * logical START POINT through the domain module. But rule 2 fixes the fill
 * DIRECTION in logical terms, and mapping a point does not map a direction:
 * `sx = -1` when `AxisDirection`'s X token is `Left`, with
 * `X = sx * (from_left - zero.from_left)` and `from_left = serCol`.
 * So under a `Left` X axis, +X LOGICAL runs toward DECREASING serialization
 * columns and rule 4's bounds check flips to the left edge. That single bit
 * arrives as {@link E142BinMeta.xStep}; it has no default, because assuming
 * `+1` would decode every `Left`-axis map mirrored about each run's start -
 * silently, and into a wafer that still looks plausible.
 *
 * Note that rule 4's "the row's logical X range" IS the full serialization
 * column range `0 .. cols-1` in either direction: the logical X
 * range exactly `C` cells wide for both `Right` and `Left`, so the check is
 * "every covered column is inside the row", not an arithmetic on logical
 * values this module never sees.
 *
 * As in {@link decodeCoordinate}, `codes` order is first-seen in element order
 * and therefore permutes with a reordered payload, while the token each cell
 * resolves to does not.
 * @param binType The bin type.
 * @param nullBin The `NullBin` attribute value.
 * @param xStep   The serialization-column step of logical +X, `+1` or `-1`;
 *                validated by {@link decodeBinPayload}. See {@link E142BinMeta.xStep}.
 * @param cols    Serialization columns.
 * @param rows    Serialization rows.
 * @param cells   The zero-filled output lattice (`cols * rows` long).
 * @param payload The run array.
 * @returns The decoded payload.
 * @throws {E142DecodeError} On any shape, range, overlap, length or token defect.
 */
function decodeRowColumnRuns(
    binType: E142BinType,
    nullBin: string,
    xStep: number,
    cols: number,
    rows: number,
    cells: Uint32Array,
    payload: E142BinPayload,
): DecodedBinPayload {
    if (!Array.isArray(payload) || (payload.length > 0 && !looksSparse(payload))) {
        rejectForm('Row/Column', payload, 'an array of { x, y, tokens } runs');
    }
    const runs = payload as readonly E142BinRun[];
    const sink = makeSink(binType, nullBin, false);
    const covered = new Uint8Array(cols * rows);
    const delimited = isDelimited(binType);
    const width = delimited ? 0 : FIXED_GRAMMAR[binType as Exclude<E142BinType, 'Decimal'>].width;

    for (let e = 0; e < runs.length; e++) {
        const run = runs[e];
        if (!run || typeof run !== 'object' || typeof run.tokens !== 'string') {
            throw new E142DecodeError(
                'BAD_PAYLOAD_FORM',
                `Row/Column run ${e} is ${describeShape(run)}, expected { x, y, tokens: string }.`,
            );
        }
        const start = cellIndex(run.x, run.y, cols, rows, `Row/Column run ${e}`);

        // Run rule 2: the length is the token count, so it must be measured before
        // the run can be bounds-checked against its row.
        const count = delimited
            ? countDecimalTokens(run.tokens, `Row/Column run ${e} at row ${run.y}, column ${run.x}`, run.y, run.x)
            : run.tokens.length / width;
        if (!delimited && !Number.isInteger(count)) {
            throw new E142DecodeError(
                'BAD_TOKEN',
                `Row/Column run ${e} at row ${run.y}, column ${run.x} carries ${run.tokens.length} characters, `
                + `which is not a whole number of ${binType} tokens (${describeGrammar(binType)}).`,
                run.y,
                run.x,
            );
        }
        if (count === 0) {
            throw new E142DecodeError(
                'BAD_TOKEN',
                `Row/Column run ${e} at row ${run.y}, column ${run.x} carries no tokens; BinCodeContentType `
                + `has minLength 1 and a run's length IS its token count.`,
                run.y,
                run.x,
            );
        }
        // Run rule 4, first half: a run may not leave its row. `last` is the run's
        // final column, which is to the LEFT of the start under xStep -1.
        const last = run.x + (count - 1) * xStep;
        if (last < 0 || last >= cols) {
            throw new E142DecodeError(
                'ROW_LENGTH_MISMATCH',
                `Row/Column run ${e} starts at row ${run.y}, column ${run.x} and carries ${count} tokens `
                + `running ${xStep < 0 ? 'left (logical +X is -column)' : 'right (logical +X is +column)'}, `
                + `ending at column ${last} and overrunning the row's ${cols} columns.`,
                run.y,
                run.x,
            );
        }
        // Run rule 4, second half: runs may not overlap. The mask is required
        // because a run may legitimately carry the NullBin token, so a zero in
        // `cells` does not mean "untouched".
        for (let k = 0; k < count; k++) {
            const at = start + k * xStep;
            if (covered[at] !== 0) {
                throw new E142DecodeError(
                    'DUPLICATE_CELL',
                    `Row/Column run ${e} covers row ${run.y}, column ${run.x + k * xStep}, which an earlier run `
                    + `already covers; runs may not overlap.`,
                    run.y,
                    run.x + k * xStep,
                );
            }
            covered[at] = 1;
        }

        if (delimited) {
            scanDecimalRun(
                run.tokens, 0, run.tokens.length, start, count, xStep, cols, sink, cells,
                'ROW_LENGTH_MISMATCH', `Row/Column run ${e}`,
            );
        } else {
            scanFixedRun(run.tokens, 0, start, count, xStep, cols, sink, cells);
        }
    }
    // Run rule 3 needs no code: `cells` arrives zero-filled and index 0 IS the
    // NullBin, so every cell no run covered is already null.
    return { cols, rows, cells, codes: sink.codes };
}

/**
 * Counts the whitespace-delimited groups in a `Decimal` string without decoding
 * them - for a run, its implicit length, needed before the run
 * can be bounds-checked. Only the group COUNT is established here; each group's
 * validity is the business of {@link scanDecimalRun}, which walks the same
 * string immediately afterwards.
 * @param text The text to measure.
 * @param what Human-readable name of the measured unit, for the error message;
 *             the message appends to it, so it reads as a sentence subject.
 * @param y    Serialization row, for the error position (omit when there is none).
 * @param x    Serialization column, for the error position (omit when there is none).
 * @returns The number of groups.
 * @throws {E142DecodeError} `BAD_TOKEN` when a group is not exactly 3 characters wide.
 */
function countDecimalTokens(text: string, what: string, y?: number, x?: number): number {
    let count = 0;
    let p = 0;
    const len = text.length;
    while (p < len) {
        if (isSpace(text.charCodeAt(p))) {
            p++;
            continue;
        }
        let k = 0;
        while (p + k < len && !isSpace(text.charCodeAt(p + k))) { k++; }
        if (k !== DECIMAL_WIDTH) {
            throw new E142DecodeError(
                'BAD_TOKEN',
                `${what} carries the ${k}-character group `
                + `${JSON.stringify(text.substring(p, p + k))} (${describeGrammar('Decimal')}).`,
                y,
                x,
            );
        }
        p += k;
        count++;
    }
    return count;
}

/**
 * Counts the tokens in ONE serialized string of `binType` - a `2DArray` row, an
 * `Array` block - WITHOUT decoding it.
 *
 * WHY THIS IS EXPORTED. An input path cannot always be
 * handed a lattice size: the official `BinCodeMap-Example.xml` is LAYOUTLESS
 * (no `Layouts` element at all), so the only statement of its width
 * is the payload itself. Measuring that width is a TOKENIZER question - the
 * answer is `length / 1` for `Ascii`, `length / 2` for `HexaDecimal`,
 * `length / 4` for `Integer2` and "count the whitespace-delimited groups" for
 * `Decimal` - and this module owns the token grammar (see its @fileoverview).
 * Exporting the measurement keeps the "ONE tokenizer" rule intact: it reads the
 * same {@link FIXED_GRAMMAR} table and the same {@link countDecimalTokens}
 * scanner the decoders use, so a caller cannot derive a width this decoder would
 * then disagree with.
 *
 * Deliberately NOT lenient, exactly like the decoders: a string whose length is
 * not a whole number of tokens has no token count, and gets a `BAD_TOKEN` rather
 * than a truncated one - a rounded-down width would turn a corrupt row into a
 * plausible narrower map. Whitespace is NOT trimmed either (the fixed-width
 * grammars have no whitespace at all, so a padded string is a defect the caller
 * must resolve at its own boundary); for `Decimal` surrounding whitespace is
 * simply the grammar's own separator and costs nothing.
 * @param binType The bin type; decides the grammar.
 * @param text    The serialized string to measure.
 * @param what    Human-readable name of the measured unit, for error messages.
 * @returns The token count (`>= 0`).
 * @throws {E142DecodeError} `BAD_BIN_TYPE` for an unknown `binType`; `BAD_TOKEN`
 *         when `text` is not a whole number of `binType` tokens.
 */
export function countRowTokens(binType: E142BinType, text: string, what = 'Payload'): number {
    if (E142_BIN_TYPES.indexOf(binType) === -1) {
        throw new E142DecodeError(
            'BAD_BIN_TYPE',
            `BinCodeMap/@BinType ${JSON.stringify(binType)} is unknown; expected one of `
            + `${E142_BIN_TYPES.join(', ')}.`,
        );
    }
    if (typeof text !== 'string') {
        throw new E142DecodeError(
            'BAD_PAYLOAD_FORM',
            `${what} is ${describeShape(text)}, expected a string.`,
        );
    }
    if (isDelimited(binType)) {
        return countDecimalTokens(text, what);
    }
    const width = FIXED_GRAMMAR[binType as Exclude<E142BinType, 'Decimal'>].width;
    if (text.length % width !== 0) {
        throw new E142DecodeError(
            'BAD_TOKEN',
            `${what} carries ${text.length} characters, which is not a whole number of ${binType} tokens `
            + `(${describeGrammar(binType)}).`,
        );
    }
    return text.length / width;
}

/**
 * Validates a sparse (x, y) pair and turns it into a linear cell index.
 * @param x     Serialization column index.
 * @param y     Serialization row index.
 * @param cols  Serialization columns.
 * @param rows  Serialization rows.
 * @param what  Human-readable name of the element, for the message.
 * @returns `y * cols + x`.
 * @throws {E142DecodeError} `OUT_OF_RANGE` when the pair leaves the lattice.
 */
function cellIndex(x: unknown, y: unknown, cols: number, rows: number, what: string): number {
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= cols
        || typeof y !== 'number' || !Number.isInteger(y) || y < 0 || y >= rows) {
        throw new E142DecodeError(
            'OUT_OF_RANGE',
            `${what}: serialization position (x=${JSON.stringify(x)}, y=${JSON.stringify(y)}) is outside the `
            + `${cols} x ${rows} lattice. Note that x / y are serialization indices, not logical E142 coordinates.`,
            typeof y === 'number' ? y : undefined,
            typeof x === 'number' ? x : undefined,
        );
    }
    return y * cols + x;
}

// ===================================================================
//  Entry point
// ===================================================================

/**
 * Decodes ONE `BinCodeMap` payload into the engine's canonical
 * {@link DecodedBinPayload}. The single entry point of this module and the one
 * decoder behind the XML, JSON and E142.4 input paths.
 *
 * INDEX SPACE. Everything here is SERIALIZATION indices: `cells[row * cols +
 * col]` with row 0 = the TOP row of the map view and col 0 = leftmost.
 * The logical E142 frame (`OriginLocation` x `AxisDirection`) and the
 * `Orientation` dimension swap belong to the domain module;
 * the caller converts before calling and labels after.
 *
 * RESULT. `codes[0]` is `meta.nullBin` and `cells[i] === 0` means null cell;
 * `codes[i>0]` are the canonical bin tokens in first-seen order, where
 * "canonical" is exactly the wire token for the string-shaped payloads and the
 * formatted value for the `number`-shaped ones. `cells` is `cols * rows` long
 * and every entry is a valid index into `codes`, which is exactly the invariant
 * `buildGridModel` re-checks before it adopts the array by reference.
 *
 * STRICTNESS. There is no lenient mode. Every row-count, row-length and
 * cell-count mismatch, every malformed token, every out-of-range or duplicated
 * sparse position and every shape that cannot belong to the declared `MapType`
 * throws an {@link E142DecodeError} naming the serialization row and column
 * wherever the defect has a position.
 *
 * PERFORMANCE. One linear pass over the payload, nothing allocated per cell:
 *  - Per cell: `width` `charCodeAt`s, `width` `Int8Array` reads, one
 *    `Int32Array` read and one `Uint32Array` write. No `substring`, no string
 *    comparison, no `Map`, no boxing, and never an intermediate per-cell array.
 *  - The `token -> index` lookup is a direct-indexed `Int32Array` over an
 *    integer key rather than a `Map<string, int>`, which is
 *    strictly stronger: the string map would still hash a key per cell. A
 *    string is materialized only on the FIRST occurrence of a code -
 *    reconstructed from the key, which is a lossless encoding of the token, so
 *    even that costs no `substring`. Bounded by the code alphabet
 *    (<= 94 / 256 / 484 / 65536 entries), never by the cell count.
 *  - The lookup costs `4 * keySpace` bytes, which is 376 B (`Ascii`), 1 KB
 *    (`Decimal`), 1.9 KB (`HexaDecimal`) and 937 KB (`Integer2` strings, whose
 *    key space is 22^4 because upper- and lowercase hex must stay distinct).
 *    That last one is the price of a branch-free hot loop for the widest
 *    grammar; it is transient, and next to the 4 MB `Uint32Array` a 1000x1000
 *    map needs anyway it is noise.
 *  - The sparse layouts additionally allocate a 1-byte-per-cell coverage mask
 *    for their overlap rule. This is not the banned per-cell array: no
 *    per-cell object, no boxing, and the dense layouts - the only ones that
 *    reach 1e6 cells in practice - never touch it.
 *  - The one per-ROW allocation is `splitLines`, and only for the
 *    newline-joined convenience form.
 * Measured on the gate case (1000x1000 `Ascii` `string[]`) by
 * `Tests/e142-bins.test.mjs`, which fails the build above 300 ms.
 * @param meta      `BinType`, `NullBin` and `MapType` of the `BinCodeMap`, plus
 *                  `xStep` for `Row/Column`. The caller has already resolved the prose
 *                  default for a missing `MapType` and derived `xStep` from the logical frame.
 * @param dimension The lattice size in SERIALIZATION index space (post-A3 swap).
 * @param payload   One of the shapes {@link E142BinPayload} lists, matching `meta.mapType`.
 * @returns The decoded payload, ready for `buildGridModel`.
 * @throws {E142DecodeError} Always this type and no other.
 */
export function decodeBinPayload(
    meta: E142BinMeta,
    dimension: E142Dimension,
    payload: E142BinPayload,
): DecodedBinPayload {
    const binType = (meta ? meta.binType : undefined) as E142BinType;
    if (E142_BIN_TYPES.indexOf(binType) === -1) {
        throw new E142DecodeError(
            'BAD_BIN_TYPE',
            `BinCodeMap/@BinType ${JSON.stringify(binType)} is unknown; expected one of `
            + `${E142_BIN_TYPES.join(', ')}.`,
        );
    }
    const mapType = meta.mapType;
    if (E142_MAP_TYPES.indexOf(mapType) === -1) {
        throw new E142DecodeError(
            'BAD_MAP_TYPE',
            `BinCodeMap/@MapType ${JSON.stringify(mapType)} is unknown; expected one of `
            + `${E142_MAP_TYPES.join(', ')}. A missing MapType means "2DArray" per the standard's prose, but no `
            + `XSD revision carries that default - the input path resolves it, not the decoder.`,
        );
    }
    const nullBin = meta.nullBin;
    const xStep = meta.xStep;
    // Required for Row/Column and meaningless for the other three layouts, so
    // it is demanded exactly where it changes an answer - and never defaulted,
    // see E142BinMeta.xStep.
    if (mapType === 'Row/Column' && xStep !== 1 && xStep !== -1) {
        throw new E142DecodeError(
            'BAD_X_STEP',
            `MapType "Row/Column" requires meta.xStep to be 1 or -1; received ${JSON.stringify(xStep)}. `
            + 'A run fills the LOGICAL +X direction, which is +1 serialization column when '
            + "AxisDirection's X token is Right and -1 when it is Left; converting the start "
            + `coordinate does not carry that sign, so the caller must derive it from the logical frame. `
            + `There is deliberately no default: assuming +1 would mirror every Left-axis run silently.`,
        );
    }

    const cols = dimension ? dimension.cols : NaN;
    const rows = dimension ? dimension.rows : NaN;
    if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0
        || !Number.isSafeInteger(cols * rows)) {
        throw new E142DecodeError(
            'BAD_DIMENSION',
            `Dimension (cols=${JSON.stringify(cols)}, rows=${JSON.stringify(rows)}) must be positive integers `
            + `whose product is a safe integer.`,
        );
    }
    let cells: Uint32Array;
    try {
        cells = new Uint32Array(cols * rows);
    } catch (e) {
        // Translate rather than leak: a RangeError / allocation failure is
        // still "the dimension is wrong", and callers must only have to know
        // about E142DecodeError.
        throw new E142DecodeError(
            'BAD_DIMENSION',
            `Cannot allocate a ${cols} x ${rows} lattice (${cols * rows} cells): `
            + `${e instanceof Error ? e.message : String(e)}.`,
        );
    }

    switch (mapType) {
        case '2DArray': return decode2DArray(binType, nullBin, cols, rows, cells, payload);
        case 'Array': return decodeArray(binType, nullBin, cols, rows, cells, payload);
        case 'Row/Column': return decodeRowColumnRuns(binType, nullBin, xStep as number, cols, rows, cells, payload);
        case 'Coordinate': return decodeCoordinate(binType, nullBin, cols, rows, cells, payload);
        default: { const _never: never = mapType; return _never; }
    }
}
