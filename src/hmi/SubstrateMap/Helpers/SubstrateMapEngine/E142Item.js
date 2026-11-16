/**
 * @fileoverview
 * E142Item - the SEMI E142.4 (Stream-21 "Item Transfer") consumer-side decode
 * front-end of the SubstrateMapEngine. It turns the REASSEMBLED item content of
 * a Stream-21 transfer - handed to the control as a byte stream (base64 String
 * or a Number[] of byte values) - into the text the existing E142.1 XML input
 * path already consumes, and, as a single-call convenience, straight into an
 * {@link E142Document}.
 *
 * WHAT THIS FILE OWNS: exactly the byte-level concerns the XML path deliberately
 * does not - input-form normalisation (base64 / Number[] -> bytes) and the
 * character-encoding SNIFF (a byte-order mark and/or the XML declaration ->
 * a decode label), with the precedence and mismatch rules the task fixes. It
 * OWNS NO XML SEMANTICS: it does not tokenise, validate namespaces, or build a
 * model. The moment it holds a decoded string it hands off to
 * {@link parseE142Xml} VERBATIM - there is no second parser here.
 *
 * SCOPE BOUNDARY (E142.4). Stream-21 REASSEMBLY - the S21F17/F18 (or S21F3/F6)
 * `ITEMPART` chunking, ordering, `ITEMACK`/`ITEMERROR` handling and
 * concatenation - is the HOST SECS/GEM stack's job, upstream of this control
 * (REKON3 14.3-14.5). This module begins where that ends: at the finished item
 * bytes bound to a symbol. It implements the CONSUMER side of E142.4's item
 * CONTENT only, nothing of its transport.
 *
 * ITEM-CONTENT ASSUMPTION (ASSUME-B B1.1, grade [B]). The transferred item is
 * taken to be the complete E142.1 `MapData` XML DOCUMENT as raw bytes - no
 * envelope, no E142.2-style attribute decomposition, no application-level
 * compression or checksum (REKON3 14.5 records neither an `ITEMPARTCKSUM` nor a
 * compression data item; integrity rides on the SECS transport). The falsifier
 * is the licensed E142.4-1022 item-content clause, which is not in the reference
 * pack. This module is exactly the contingency that assumption's blast radius
 * calls for: {@link decodeE142Item} is a documented ADAPTER SEAM in front of the
 * XML pipeline. Should the stack turn out to deliver a NON-document payload (a
 * vendor envelope, say), the fix is local - pre-process the bytes at the marked
 * seam - and the pipeline behind it stands unchanged.
 *
 * NO WELL-KNOWN ITEMTYPE (ASSUME-B B2.1; REKON3 14.6/14.7). The literal
 * Stream-21 `ITEMTYPE` string for an E142.4 substrate-map item is not settled in
 * any open source: the well-known-names ballot was still unsubmitted as of the
 * Winter 2026 SEMI meetings. `ITEMTYPE` filtering is therefore exclusively the
 * host stack's configuration concern; nothing in this module inspects, matches
 * or hard-codes it. Should a fixed string later surface (the licensed text or
 * the ballot outcome), it is a host-side wiring detail, informational here only.
 *
 * ERROR CONTRACT. Like its siblings E142Bins / E142Xml, this module THROWS, and
 * throws exactly one type of its own: {@link E142ItemError}, carrying a
 * machine-readable {@link E142ItemError.code}. Downstream XML defects surface as
 * {@link parseE142Xml}'s {@link E142ParseError}; the two are disjoint, so a
 * caller that already handles the parser's error type only adds one more.
 *
 * DOM-FREENESS. Nothing here touches the DOM: no `document`, no `DOMParser`, no
 * layout, no attributes, no events, no theme. Base64 is decoded by a
 * self-contained table (no `atob`), and text is decoded through the platform
 * `TextDecoder`, a text-encoding primitive present in the browser runtime and in
 * Node alike - so the whole file is exercised by the node test
 * `Tests/e142-item.test.mjs` without a DOM.
 *
 * PROVENANCE. Grades mirror the assumption sheets ([A] normative/quoted,
 * [B] deduced/forced, [C] thin evidence). The two graded points this module
 * rests on - item = XML bytes (B1.1) and no fixed ITEMTYPE (B2.1) - are named
 * above with their falsifiers.
 *
 * S1 mechanism (frozen by spike S1): authored as an ES module, linked with `.js`
 * import specifiers, with the idempotent (`??=`) global bridge at the end of the
 * file exposing the classic namespace name
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Item.
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
import { parseE142Xml } from './E142Xml.js';
/**
 * The one error this module throws. Carries a machine-readable {@link code} and,
 * for a wrapped platform failure (a `TextDecoder` throw), the original error in
 * {@link cause}. Disjoint from {@link E142ParseError}, so
 * `catch (e) { if (e instanceof E142ItemError) ... else if (e instanceof E142ParseError) ... }`
 * covers the whole transfer -> model path.
 */
export class E142ItemError extends Error {
    /** Machine-readable discriminator; switch on this, never on the message. */
    code;
    /** The wrapped original error, when this error translates one. */
    cause;
    /**
     * @param code    The machine-readable discriminator.
     * @param message Human-readable detail; should name the concrete cause.
     * @param cause   The original error, when translating one.
     */
    constructor(code, message, cause) {
        super(message);
        this.name = 'E142ItemError';
        this.code = code;
        this.cause = cause;
    }
}
// ===================================================================
//  Base64 (self-contained; no `atob`, so DOM-free and node-runnable)
// ===================================================================
/** The standard base64 alphabet, index = 6-bit value. */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/**
 * Reverse lookup: byte value of an ASCII character -> its 6-bit base64 value, or
 * 255 for "not a base64 character". Built once at module load.
 */
const BASE64_LOOKUP = (() => {
    const table = new Uint8Array(256).fill(255);
    for (let i = 0; i < BASE64_ALPHABET.length; i++) {
        table[BASE64_ALPHABET.charCodeAt(i)] = i;
    }
    return table;
})();
/**
 * Decodes a base64 string to bytes without the platform `atob` (keeping this
 * module DOM-free and node-runnable). ASCII whitespace is ignored and the two
 * URL-safe substitutions (`-` -> `+`, `_` -> `/`) are accepted; any other
 * non-alphabet character, or an impossible length, throws
 * {@link E142ItemError} `E142_ITEM_BASE64`. Padding `=` is optional.
 * @param b64 The base64 text.
 * @returns The decoded bytes.
 */
function decodeBase64ToBytes(b64) {
    // SINGLE PASS, no intermediate array. The previous implementation collected
    // every 6-bit value into a `number[]` first, which for a Stream-21 sized item
    // means tens of millions of boxed numbers - that dominated the cost of the
    // whole transfer path (a ~20 MB base64 item spent seconds here while the XML
    // parse and the grid build together took a fraction of that). Semantics are
    // unchanged: ASCII whitespace is skipped, `=` opens padding and any data after
    // it is an error, URL-safe `-`/`_` are accepted, any other character is an
    // error, and a sextet count of n % 4 === 1 is an invalid length.
    //
    // Upper bound for the output: every 4 sextets yield 3 bytes, so the decoded
    // length can never exceed ceil(len * 3 / 4). The exact length is known once
    // the scan finishes, so the buffer is subarray'd at the end (a view, no copy).
    const out = new Uint8Array(Math.ceil((b64.length * 3) / 4) + 3);
    let o = 0;
    let acc = 0; // packed sextets, 6 bits each
    let have = 0; // how many sextets are currently in `acc`
    let total = 0; // total sextets seen, for the length check
    let padSeen = false;
    for (let i = 0; i < b64.length; i++) {
        let code = b64.charCodeAt(i);
        // Ignore ASCII whitespace: TAB, LF, VT, FF, CR, SPACE.
        if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d || code === 0x20) {
            continue;
        }
        if (code === 0x3d /* '=' */) {
            padSeen = true;
            continue;
        }
        // URL-safe -> standard.
        if (code === 0x2d /* '-' */) {
            code = 0x2b /* '+' */;
        }
        else if (code === 0x5f /* '_' */) {
            code = 0x2f /* '/' */;
        }
        if (padSeen) {
            // Data after padding is malformed.
            throw new E142ItemError('E142_ITEM_BASE64', 'base64 string has data after its padding');
        }
        const v = BASE64_LOOKUP[code];
        if (v === 255) {
            throw new E142ItemError('E142_ITEM_BASE64', `base64 string contains an invalid character (code ${code})`);
        }
        acc = (acc << 6) | v;
        have++;
        total++;
        if (have === 4) {
            out[o++] = (acc >> 16) & 0xff;
            out[o++] = (acc >> 8) & 0xff;
            out[o++] = acc & 0xff;
            acc = 0;
            have = 0;
        }
    }
    if (total % 4 === 1) {
        // 6 leftover bits cannot form a byte - impossible from valid base64.
        throw new E142ItemError('E142_ITEM_BASE64', 'base64 string has an invalid length');
    }
    // Tail: 2 leftover sextets -> 1 byte, 3 -> 2 bytes (the low bits are padding).
    if (have === 2) {
        out[o++] = (acc >> 4) & 0xff;
    }
    else if (have === 3) {
        out[o++] = (acc >> 10) & 0xff;
        out[o++] = (acc >> 2) & 0xff;
    }
    return out.subarray(0, o);
}
/**
 * Normalises any accepted input form to bytes (ASSUME-B B4.1). A `string` is
 * base64; a `Uint8Array` is returned as-is (not copied); a `number[]` is
 * validated element-by-element to be byte values. An empty result throws, since
 * an E142.1 document is never empty.
 * @param input The reassembled item content.
 * @returns The item bytes.
 * @throws {E142ItemError} `E142_ITEM_EMPTY`, `E142_ITEM_BASE64` or `E142_ITEM_BYTE_RANGE`.
 */
export function itemToBytes(input) {
    let bytes;
    if (typeof input === 'string') {
        bytes = decodeBase64ToBytes(input);
    }
    else if (input instanceof Uint8Array) {
        bytes = input;
    }
    else {
        // A `number[]` (or any array-like of numbers). Validate each is a byte.
        const arr = input;
        const out = new Uint8Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
            const v = arr[i];
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
                throw new E142ItemError('E142_ITEM_BYTE_RANGE', `item byte at index ${i} is not an integer in 0..255 (got ${String(v)})`);
            }
            out[i] = v;
        }
        bytes = out;
    }
    if (bytes.length === 0) {
        throw new E142ItemError('E142_ITEM_EMPTY', 'the transferred item is empty (zero bytes)');
    }
    return bytes;
}
/**
 * Classifies a raw declared encoding label into a {@link EncodingFamily}
 * (case- and separator-insensitive). Only the labels this module can act on are
 * recognised; everything else is `'other'`.
 * @param raw The verbatim declared label.
 * @returns Its family.
 */
function encodingFamily(raw) {
    const k = raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
    switch (k) {
        case 'utf-8':
        case 'utf8':
            return 'utf-8';
        case 'utf-16le':
        case 'utf-16-le':
            return 'utf-16le';
        case 'utf-16be':
        case 'utf-16-be':
            return 'utf-16be';
        case 'utf-16':
        case 'utf16':
        case 'unicode':
            return 'utf-16';
        default:
            return 'other';
    }
}
/**
 * The prolog window, in bytes, scanned for an XML declaration. An XML
 * declaration must be the very first content and is far shorter than this.
 */
const DECLARATION_PROBE_BYTES = 512;
/**
 * Reads the `encoding=` value from a leading XML declaration, decoding the
 * prolog window with `probeLabel`. Returns the raw declared label, or `null`
 * when there is no declaration or it carries no `encoding`. Never throws and
 * never fatal: it is a best-effort probe, not the real decode.
 * @param bytes      The full item bytes.
 * @param probeLabel The label to decode the prolog with (the BOM's encoding when
 *                   there is a BOM; `'iso-8859-1'` otherwise, so an ASCII
 *                   declaration in an 8-bit stream reads correctly).
 * @returns The raw declared encoding label, or `null`.
 */
function readDeclaredEncoding(bytes, probeLabel) {
    const head = bytes.subarray(0, Math.min(bytes.length, DECLARATION_PROBE_BYTES));
    let text;
    try {
        // ignoreBOM:false so a leading BOM matching probeLabel is dropped, leaving
        // the declaration at the string start; non-fatal so a truncated multibyte
        // at the window edge never throws here.
        text = new TextDecoder(probeLabel, { fatal: false, ignoreBOM: false }).decode(head);
    }
    catch {
        text = new TextDecoder('utf-8', { fatal: false }).decode(head);
    }
    // `[^>]*` cannot cross the declaration's closing `?>`, so this only ever reads
    // an `encoding` that belongs to the declaration itself.
    const m = /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(text);
    if (m === null) {
        return null;
    }
    return m[1] !== undefined ? m[1] : m[2];
}
/**
 * Detects the encoding of an item byte stream (ASSUME-B B4.2). A byte-order mark
 * decides and wins over any declaration; absent a BOM, the XML declaration's
 * `encoding=` decides; absent both, UTF-8. A declaration naming an unsupported
 * encoding resolves to UTF-8 with `source:'default'` (the raw label is preserved
 * in {@link E142ItemEncodingSniff.declared} for the caller's warning). Pure and
 * warning-free - {@link decodeItemText} turns the returned facts into warnings.
 *
 * UTF-32 is out of scope: a `FF FE 00 00` prolog is read as UTF-16 LE, as the
 * task's UTF-16 minimum dictates; a genuine UTF-32 stream would then fail the
 * `fatal` decode and surface as `E142_ITEM_UNDECODABLE`.
 * @param bytes The item bytes (non-empty).
 * @returns The sniff result.
 */
export function sniffEncoding(bytes) {
    // 1) Byte-order mark - highest precedence.
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return { encoding: 'utf-8', source: 'bom', bomLength: 3, declared: readDeclaredEncoding(bytes, 'utf-8') };
    }
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return { encoding: 'utf-16le', source: 'bom', bomLength: 2, declared: readDeclaredEncoding(bytes, 'utf-16le') };
    }
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return { encoding: 'utf-16be', source: 'bom', bomLength: 2, declared: readDeclaredEncoding(bytes, 'utf-16be') };
    }
    // 2) No BOM - the XML declaration decides. Probe as ISO-8859-1 so an ASCII
    //    declaration in any 8-bit stream (UTF-8 above all) reads verbatim.
    const declared = readDeclaredEncoding(bytes, 'iso-8859-1');
    if (declared === null) {
        return { encoding: 'utf-8', source: 'default', bomLength: 0, declared: null };
    }
    const fam = encodingFamily(declared);
    switch (fam) {
        case 'utf-8':
            return { encoding: 'utf-8', source: 'declaration', bomLength: 0, declared };
        case 'utf-16le':
            return { encoding: 'utf-16le', source: 'declaration', bomLength: 0, declared };
        case 'utf-16be':
            return { encoding: 'utf-16be', source: 'declaration', bomLength: 0, declared };
        case 'utf-16':
            // Declared UTF-16 but no BOM to fix the byte order: honour the intent,
            // pick LE (the prevailing default); decodeItemText warns.
            return { encoding: 'utf-16le', source: 'declaration', bomLength: 0, declared };
        case 'other':
            // Unsupported: fall back to UTF-8; decodeItemText warns.
            return { encoding: 'utf-8', source: 'default', bomLength: 0, declared };
        default: {
            const _never = fam;
            return _never;
        }
    }
}
/**
 * Whether a declared encoding family is consistent with a resolved encoding: an
 * exact match, or the endianness-unspecified `'utf-16'` against either UTF-16
 * byte order.
 * @param declared The declared family.
 * @param resolved The resolved encoding.
 * @returns `true` when consistent.
 */
function familyMatches(declared, resolved) {
    if (declared === resolved) {
        return true;
    }
    return declared === 'utf-16' && (resolved === 'utf-16le' || resolved === 'utf-16be');
}
// ===================================================================
//  Decode
// ===================================================================
/**
 * Decodes reassembled item bytes to text (ASSUME-B B4.2), applying the sniff and
 * emitting the precedence warnings:
 *  - a declaration that disagrees with the BOM -> the BOM wins, one warning;
 *  - a declaration naming an unsupported encoding -> UTF-8, one warning;
 *  - a declaration naming UTF-16 with no BOM -> UTF-16 LE, one warning.
 *
 * The actual character decode is the platform `TextDecoder` in `fatal` mode, so
 * a mis-reassembled or truncated stream fails loudly as
 * {@link E142ItemError} `E142_ITEM_UNDECODABLE` instead of smuggling U+FFFD into
 * the document. Any leading BOM is stripped (default `ignoreBOM:false`).
 * @param input The reassembled item content (base64 / Number[] / Uint8Array).
 * @returns The decoded text and its diagnostics.
 * @throws {E142ItemError} on empty input, a bad input form, or an undecodable stream.
 */
export function decodeItemText(input) {
    const bytes = itemToBytes(input);
    const sniff = sniffEncoding(bytes);
    const warnings = [];
    if (sniff.declared !== null) {
        const fam = encodingFamily(sniff.declared);
        if (sniff.source === 'bom') {
            if (!familyMatches(fam, sniff.encoding)) {
                warnings.push(`encoding: the XML declaration says "${sniff.declared}" but the byte-order mark indicates ${sniff.encoding}; decoding as ${sniff.encoding} (the BOM wins).`);
            }
        }
        else if (sniff.source === 'default') {
            // declared !== null with source 'default' means the label was unsupported.
            warnings.push(`encoding: the XML declaration names unsupported encoding "${sniff.declared}"; decoding as UTF-8 (only UTF-8 and UTF-16 LE/BE are supported).`);
        }
        else if (fam === 'utf-16') {
            warnings.push(`encoding: the XML declaration says "${sniff.declared}" but there is no byte-order mark to fix the byte order; decoding as UTF-16 LE.`);
        }
    }
    let text;
    try {
        text = new TextDecoder(sniff.encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
    }
    catch (e) {
        throw new E142ItemError('E142_ITEM_UNDECODABLE', `the item bytes are not valid ${sniff.encoding}`, e);
    }
    return { text, encoding: sniff.encoding, source: sniff.source, warnings };
}
/**
 * The single-call ADAPTER SEAM: reassembled item bytes -> {@link E142Document}.
 * Decodes the bytes to text ({@link decodeItemText}) and hands the text to
 * {@link parseE142Xml} verbatim, merging both stages' warnings. This is the
 * documented insertion point for the ASSUME-B B1.1 contingency, and is NOT on
 * the control's default path (the control runs the sniff and the existing XML
 * pipeline as two visible steps, so the XML path is used unchanged).
 *
 * ADAPTER SEAM. Should the SECS/GEM stack turn out to deliver something other
 * than raw E142.1 document bytes - a vendor envelope, a length/type prefix, an
 * application-level compressed blob - unwrap it to document bytes HERE, before
 * {@link decodeItemText}, or map it to text before {@link parseE142Xml}. The
 * default body makes no such assumption beyond B1.1: it treats the bytes as the
 * document itself.
 * @param input   The reassembled item content (base64 / Number[] / Uint8Array).
 * @param options Parser options, forwarded verbatim to {@link parseE142Xml}
 *                (e.g. an injected `parseDocument` for a DOM-free/node caller).
 * @returns The parsed document and the combined decode + parse warnings.
 * @throws {E142ItemError} on the decode stage; {@link E142ParseError} on the parse stage.
 */
export function decodeE142Item(input, options) {
    const decoded = decodeItemText(input);
    // --- ADAPTER SEAM (see above): default path assumes `decoded.text` IS the
    // ---  complete E142.1 MapData document. Pre-process here for a non-document
    // ---  payload; the parse below is untouched.
    const parsed = parseE142Xml(decoded.text, options);
    return { doc: parsed.doc, warnings: [...decoded.warnings, ...parsed.warnings] };
}
/**
 * Returns (creating on demand) the namespace object at `segments` below `root`.
 * First-wins on every level: existing objects are reused, never replaced, so
 * repeated evaluation cannot orphan earlier registrations.
 * @param root     The root object to hang the namespace off.
 * @param segments The namespace path.
 * @returns The namespace object.
 */
function ensureNamespace(root, ...segments) {
    let current = root;
    for (const segment of segments) {
        current = (current[segment] ??= {});
    }
    return current;
}
// Idempotent registration guard: `??=` keeps the first definition if this file
// is ever evaluated twice (cannot happen through the module cache, but required
// for the classic fallback variant and free of cost here).
const e142ItemNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142Item');
e142ItemNamespace['E142ItemError'] ??= E142ItemError;
e142ItemNamespace['itemToBytes'] ??= itemToBytes;
e142ItemNamespace['sniffEncoding'] ??= sniffEncoding;
e142ItemNamespace['decodeItemText'] ??= decodeItemText;
e142ItemNamespace['decodeE142Item'] ??= decodeE142Item;
//# sourceMappingURL=E142Item.js.map