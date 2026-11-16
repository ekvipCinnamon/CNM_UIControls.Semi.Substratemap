/**
 * @fileoverview
 * BinCodec - the compact wire form of a decoded bin payload.
 *
 * WHAT IT IS FOR. A `DecodedBinPayload` is a code table plus one index per cell.
 * The token text is what a document carries and is normative (ground truth 1), but
 * once decoded the same information fits in two bytes per cell, and a 600x600 map
 * is 360 000 cells - 720 kB of indices against 5.6 MB of `Decimal` tokens. This
 * module is that narrowing and nothing else: it does not decide bins, it does not
 * read documents, and it is never the source of truth for a payload.
 *
 * ---- BYTE ORDER: LITTLE-ENDIAN, ALWAYS ----
 *
 * The wire form is a sequence of unsigned 16-bit integers in **little-endian**
 * order: index 0x0102 is the byte pair `02 01`. That is a property of the FORMAT,
 * not of the machine, and this file does not assume the two agree.
 *
 * Every conversion goes through a `DataView` with an explicit `littleEndian`
 * argument, and there is NO typed-array fast path. `new Uint16Array(buffer)` reads
 * in PLATFORM order, which on a big-endian host would byte-swap every cell and
 * produce a valid-looking map with the wrong bins rather than an error - so a fast
 * path needs a platform probe, and a probe is a second branch that no test on a
 * little-endian machine can reach. That branch WAS written, and two deliberate
 * byte-order mutations inside it survived the entire suite. It is gone for that
 * reason, and the same two mutations now fail nine and three assertions.
 *
 * The cost was measured, not assumed: on a 1200x1200 map (1.44 M cells) the
 * typed-array path saved about 3 ms encoding and 2 ms decoding, against roughly
 * 65 ms for the token decode the same map already pays. Five
 * milliseconds in seventy does not buy an untestable branch.
 *
 * Using `DataView` throughout removes the alignment hazard as well: a
 * `Uint16Array` view requires a 2-byte-aligned `byteOffset` and throws otherwise,
 * while a `DataView` is defined at any offset. Nothing is left to get wrong about
 * where the bytes came from.
 *
 * The test asserts the bytes LITERALLY rather than only round-tripping them: a
 * round trip is symmetric and passes just as happily if both halves are
 * big-endian.
 *
 * ---- WHY UINT16 IS EXACTLY ENOUGH ----
 *
 * The index space is bounded by the bin key space, not by the map: `Ascii` has 128
 * possible tokens, `Decimal` and `HexaDecimal` 256, `Integer2` 65 536
 * (`E142Bins.ts`). The largest is `Integer2`, whose 65 536 distinct codes need
 * indices 0..65 535 - exactly the range of a `Uint16Array`, with nothing to spare.
 * A payload presenting a larger index is not a big map, it is a corrupt one, and
 * it throws rather than wrapping.
 *
 * ---- WHAT IS NOT HERE ----
 *
 * No base64 DECODER. `E142Item.ts` already owns one, deliberately self-contained
 * so the engine stays DOM-free and node-runnable, and a second table would be a
 * second alphabet to keep in step with the first. Only the encoder is new, and it uses that module's
 * alphabet so the two halves cannot disagree.
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

import { BASE64_ALPHABET, decodeBase64ToBytes } from './E142Item.js';

/** The highest index a `Uint16` cell can carry. */
const MAX_INDEX = 0xFFFF;

/** Raised when a payload or a wire form cannot be encoded or decoded. */
export class BinCodecError extends Error {
    /** A stable code, in the engine's `E142_*` family. */
    public readonly code: string;

    /**
     * @param code    The stable code.
     * @param message What is wrong, and why it is not tolerated.
     */
    public constructor(code: string, message: string) {
        super(message);
        this.name = 'BinCodecError';
        this.code = code;
    }
}

/** The compact wire form of a decoded payload. */
export interface EncodedBinIndices {
    /**
     * The code table, in index order. `codes[0]` is the null bin - see
     * {@link encodeBinIndices}.
     */
    readonly codes: readonly string[];
    /** The cell indices as base64 of little-endian `uint16`, row-major. */
    readonly data: string;
}

/** The subset of `DecodedBinPayload` this codec reads. */
export interface BinIndexSource {
    /** One index per cell, row-major, each an offset into {@link codes}. */
    readonly cells: Uint32Array | Uint16Array;
    /** The code table; entry 0 is the null bin. */
    readonly codes: readonly string[];
}

/**
 * Encodes bytes to base64.
 *
 * The counterpart of `E142Item`'s decoder and deliberately built on that module's
 * alphabet: two tables that could drift by one character would produce data that
 * survives a round trip through itself and is wrong everywhere else.
 * @param bytes The bytes.
 * @returns Padded standard base64.
 */
function encodeBytesToBase64(bytes: Uint8Array): string {
    const out: string[] = [];
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out.push(BASE64_ALPHABET[(n >>> 18) & 63], BASE64_ALPHABET[(n >>> 12) & 63],
            BASE64_ALPHABET[(n >>> 6) & 63], BASE64_ALPHABET[n & 63]);
    }
    const left = bytes.length - i;
    if (left === 1) {
        const n = bytes[i] << 16;
        out.push(BASE64_ALPHABET[(n >>> 18) & 63], BASE64_ALPHABET[(n >>> 12) & 63], '=', '=');
    } else if (left === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out.push(BASE64_ALPHABET[(n >>> 18) & 63], BASE64_ALPHABET[(n >>> 12) & 63],
            BASE64_ALPHABET[(n >>> 6) & 63], '=');
    }
    return out.join('');
}

/**
 * Narrows a decoded payload to its compact wire form.
 *
 * The code table is passed through **unchanged, in its existing order**, which is
 * what keeps `codes[0]` the null bin: `decodeBinPayload` builds the table with the
 * null token first, and re-sorting or de-duplicating it here would renumber every
 * cell. This function does not choose an ordering; it preserves one.
 * @param source A decoded payload, or anything carrying its `cells` and `codes`.
 * @returns The code table and the base64 index block.
 * @throws {BinCodecError} On an empty table or an index a `uint16` cannot hold.
 */
export function encodeBinIndices(source: BinIndexSource): EncodedBinIndices {
    const { cells, codes } = source;
    if (codes.length === 0) {
        throw new BinCodecError('E142_BINCODEC_NO_CODES',
            'The code table is empty. Every decoded payload has at least the null bin at index 0, '
            + 'so an empty table means the payload was never decoded rather than that it has no cells.');
    }
    if (codes.length - 1 > MAX_INDEX) {
        throw new BinCodecError('E142_BINCODEC_TABLE_TOO_LARGE',
            `The code table has ${codes.length} entries; a uint16 index reaches ${MAX_INDEX + 1}. `
            + 'The largest legal key space is Integer2 at 65536, which fits exactly, so a larger '
            + 'table is a corrupt payload rather than a big map.');
    }

    const bytes = new Uint8Array(cells.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < cells.length; i++) {
        const v = cells[i];
        if (v > MAX_INDEX) { throw indexTooLarge(i, v); }
        // `true` is the little-endian argument, and it is the whole byte-order
        // contract of this format - stated once here and once in the decoder.
        view.setUint16(i * 2, v, true);
    }
    return { codes: codes.slice(), data: encodeBytesToBase64(bytes) };
}

/**
 * @param at    The cell index.
 * @param value The offending value.
 * @returns The error to throw.
 */
function indexTooLarge(at: number, value: number): BinCodecError {
    return new BinCodecError('E142_BINCODEC_INDEX_TOO_LARGE',
        `Cell ${at} carries index ${value}; a uint16 reaches ${MAX_INDEX}. Wrapping it would `
        + 'produce a map that renders and is wrong, so it is refused.');
}

/**
 * Widens the compact wire form back to one index per cell.
 *
 * `codes` is taken as an argument rather than read from the data because the wire
 * form carries indices only: the block is meaningless without the table that was
 * encoded beside it, and passing them separately makes that structural rather than
 * a convention.
 * @param codes The code table the block was encoded against.
 * @param data  The base64 index block.
 * @returns One index per cell, row-major.
 * @throws {BinCodecError} On an odd byte count or an index outside the table.
 */
export function decodeBinIndices(codes: readonly string[], data: string): Uint16Array {
    const bytes = decodeBase64ToBytes(data);
    if (bytes.length % 2 !== 0) {
        throw new BinCodecError('E142_BINCODEC_ODD_LENGTH',
            `The index block decodes to ${bytes.length} bytes, which is odd. Every cell is a uint16, `
            + 'so an odd length means the block was truncated - and a truncated map would render as a '
            + 'complete, smaller one.');
    }

    const count = bytes.length / 2;
    const out = new Uint16Array(count);
    // Constructed over the decoder's own byteOffset and length rather than over the
    // bare buffer. A DataView imposes no alignment requirement, so no copy is
    // needed to make one true - the second reason there is no fast path.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count; i++) { out[i] = view.getUint16(i * 2, true); }

    for (let i = 0; i < count; i++) {
        if (out[i] >= codes.length) {
            throw new BinCodecError('E142_BINCODEC_INDEX_UNKNOWN',
                `Cell ${i} carries index ${out[i]} but the code table has ${codes.length} entries. `
                + 'The block and the table do not belong together; rendering it would show bins that '
                + 'were never in the document.');
        }
    }
    return out;
}

/* ------------------------------------------------------------------------ *
 * Global namespace bridge (classic consumers)
 * ------------------------------------------------------------------------ */

declare const _encodeBinIndicesAlias: typeof encodeBinIndices;
declare const _decodeBinIndicesAlias: typeof decodeBinIndices;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI.Engine.BinCodec {
        /** Global alias of {@link encodeBinIndices}. */
        let encodeBinIndices: typeof _encodeBinIndicesAlias;
        /** Global alias of {@link decodeBinIndices}. */
        let decodeBinIndices: typeof _decodeBinIndicesAlias;
    }
}

/**
 * Returns (creating on demand) the namespace object at `segments` below `root`.
 * First-wins on every level.
 * @param root     The root object to hang the namespace off.
 * @param segments The namespace path.
 * @returns The namespace object.
 */
function ensureNamespace(root: object, ...segments: string[]): Record<string, unknown> {
    let current = root as Record<string, unknown>;
    for (const segment of segments) {
        current = (current[segment] ??= {}) as Record<string, unknown>;
    }
    return current;
}

const binCodecNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'BinCodec');
binCodecNamespace['encodeBinIndices'] ??= encodeBinIndices;
binCodecNamespace['decodeBinIndices'] ??= decodeBinIndices;
