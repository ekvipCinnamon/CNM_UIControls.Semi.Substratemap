/**
 * @fileoverview
 * E142Grid - the GridData v1 JSON input path of the SubstrateMapEngine: it turns
 * one compact, PLC-friendly single-map JSON object into the engine's plain-data
 * hand-over ({@link NormalizedGridData}) and nothing else.
 *
 * WHAT GridData IS. A flattening of the E142.1 model down to the one shape a PLC
 * actually publishes: ONE substrate, ONE layout, ONE BinCodeMap, no overlays, no
 * layout tree, no namespaces. Its field semantics, enums and defaults are E142
 * verbatim (V0125 XSD, reached through REKON3 = SEMI_E142_Spezifikation_v3.md and
 * its Appendix A) - this module invents no SEMI semantics of its own. Where the
 * contract deliberately DEPARTS from E142 there is exactly one place, `lowerLeft`,
 * and it is documented at {@link GridData.lowerLeft}.
 *
 * DIVISION OF LABOUR - identical to the sibling XML path (E142Xml.ts), which is
 * the file to read next to this one:
 *  - E142.ts (domain) owns the LOGICAL FRAME, the units and the A3 map-frame
 *    swap: this file calls {@link toMmFactor}, {@link dimsInMapFrame} and
 *    {@link mapCoordToIndex} and re-derives none of their rules. Every X/Y that
 *    reaches this module from a document is a LOGICAL coordinate; every X/Y it
 *    hands downstream is a SERIALIZATION index, converted in exactly one place
 *    ({@link toSerializationIndex}).
 *  - E142Bins.ts (decoder) owns the TOKEN GRAMMAR: this file shapes the payload
 *    the declared MapType demands and calls {@link decodeBinPayload}. It contains
 *    NO tokenizer and no second numeric formatter - the canonical `number ->
 *    token` rule (REKON3 6.5.4 / 7.1; the GridData contract's own SS 5.2 is not in
 *    the reference pack) lives in the decoder alone and is reached by handing it
 *    the `number[]` unchanged.
 *
 * WHAT THIS FILE OWNS: the JSON shape, the required-field and enum gates, the
 * contract's defaults, the units conversion of the physical fields, the
 * form <-> MapType correspondence, and the identity pass-through. Nothing else -
 * no rendering, no placement, no attributes, no events, no theme, no DOM. The
 * result feeds {@link computeGridPlacement} and `buildGridModel` with no further
 * shaping: `header` IS an `E142SubstrateMapHeader`, `resolvedLayout` IS a
 * `ResolvedLayout`, `payload` IS a `DecodedBinPayload`.
 *
 * ERROR CONTRACT. Like E142Bins and E142Xml, and unlike Engine.ts's
 * null-returning builders, this module THROWS, and throws exactly one type:
 * {@link E142GridError}, carrying a machine-readable {@link E142GridError.code}
 * and the JSON POINTER (RFC 6901) of the offending value. A wire document's
 * defects must be reportable to an operator with a location; "the map came out
 * empty" is not a diagnosis. Decode errors are wrapped, never leaked, so a caller
 * needs to know one error type. There is no lenient mode: every shape, length and
 * enum defect is an error, never a repair.
 *
 * PROVENANCE. Grades mirror E142-ASSUME-A-COORD.md ("ASSUME-A"), the
 * authoritative supplement to REKON3 chapter 6:
 *   [A] normative or literally quoted   [B] deduced/forced   [C] thin evidence.
 * Every graded rule carries a PDF-VERIFY marker for the deferred verification
 * pass (task F1-V).
 *
 * S1 mechanism (frozen by spike S1): authored as an ES module, linked with `.js`
 * import specifiers, with the idempotent (`??=`) global bridge at the end of the
 * file exposing the classic namespace name
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Grid.
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
import { E142_DEFAULT_MAP_TYPE, E142Error, dimsInMapFrame, indexToMapCoord, mapCoordToIndex, toMmFactor, } from './E142.js';
import { E142_BIN_TYPES, E142_MAP_TYPES, E142DecodeError, decodeBinPayload } from './E142Bins.js';
/**
 * The one error {@link normalizeGridData} throws. Carries a machine-readable
 * {@link code}, a human message, and the JSON POINTER (RFC 6901) of the offending
 * value - `""` for the document itself, `"/dimension/x"` for a nested scalar,
 * `"/bins/3/x"` for an array element's field. A pointer rather than a dotted path
 * because GridData arrives as JSON and RFC 6901 is what a JSON operator's tools
 * already speak; the XML sibling uses an XPath-flavoured path for the same reason.
 *
 * Nothing else escapes this module: {@link E142DecodeError} from the decoder and
 * {@link E142Error} from the units resolver are translated, so a caller can
 * `catch (e) { if (e instanceof E142GridError) }` and be exhaustive. The original
 * travels in {@link cause}, so the decoder's serialization row/column survives
 * without being re-modeled here.
 */
export class E142GridError extends Error {
    /** Machine-readable discriminator; switch on this, never on the message. */
    code;
    /** JSON Pointer (RFC 6901) of the offending value; `""` is the document root. */
    path;
    /** The wrapped original error, when this error translates one. */
    cause;
    /**
     * @param code    The machine-readable discriminator.
     * @param path    JSON Pointer of the offending value.
     * @param message Human-readable detail; should name the concrete values seen.
     * @param cause   The original error, when translating one.
     */
    constructor(code, path, message, cause) {
        super(`${message} (at ${path === '' ? '<document>' : path})`);
        this.name = 'E142GridError';
        this.code = code;
        this.path = path;
        this.cause = cause;
    }
}
// ===================================================================
//  Contract constants
// ===================================================================
/**
 * `OriginLocationEnum` of the E142.1 XSD, in declaration order. [XSD-normativ,
 * E142-1-V0125-Schema.xsd]. Duplicated from E142Xml's private list rather than
 * shared because neither module exports one; a future task should lift both to
 * E142.ts next to {@link E142OriginLocation}. The list is XSD-verbatim in both
 * places, so it cannot drift silently - a member added to one and not the other
 * is a compile error against the union type.
 */
const ORIGIN_LOCATIONS = [
    'LowerLeft', 'UpperLeft', 'LowerRight', 'UpperRight', 'Center',
];
/** `AxisDirectionEnum` of the E142.1 XSD, in declaration order. [XSD-normativ]. See {@link ORIGIN_LOCATIONS}. */
const AXIS_DIRECTIONS = ['UpRight', 'DownRight', 'UpLeft', 'DownLeft'];
/** `SubstrateMapType/@OriginLocation` XSD default. [XSD-normativ]. */
const DEFAULT_ORIGIN_LOCATION = 'LowerLeft';
/** `SubstrateMapType/@AxisDirection` XSD default. [XSD-normativ]. */
const DEFAULT_AXIS_DIRECTION = 'UpRight';
/** `SubstrateMapType/@Orientation` XSD default. [XSD-normativ]. */
const DEFAULT_ORIENTATION = 0;
/**
 * `SubstrateMapType/@SubstrateSide` XSD default. [XSD-normativ]. GridData carries
 * no side field, so this is what every GridData map is; it is carry-only for
 * placement either way.
 */
const DEFAULT_SUBSTRATE_SIDE = 'TopSide';
/** `OrientationType` inclusive lower bound. [XSD-normativ]. */
const ORIENTATION_MIN = 0;
/** `OrientationType` inclusive upper bound. [XSD-normativ]. */
const ORIENTATION_MAX = 359;
/** `MaterialIdType` maxLength, which `Substrate/@SubstrateId` is typed with. [XSD-normativ]. */
const MATERIAL_ID_MAX_LENGTH = 32;
/** `LotIdType` maxLength, which `Substrate/LotId` is typed with. [XSD-normativ]. */
const LOT_ID_MAX_LENGTH = 80;
/**
 * Every key the GridData v1 contract defines. Anything else is reported once and
 * ignored - see {@link normalizeGridData} on forward compatibility.
 */
const KNOWN_KEYS = new Set([
    'dimension', 'units', 'stepSize', 'deviceSize', 'lowerLeft',
    'orientation', 'originLocation', 'axisDirection',
    'binType', 'nullBin', 'mapType', 'binDefinitions', 'bins',
    'substrateId', 'lotId', 'goodDevices',
]);
// ===================================================================
//  Field readers (pure; no `this`)
// ===================================================================
/**
 * Appends a JSON Pointer segment to `base`, escaping per RFC 6901 (`~` -> `~0`,
 * `/` -> `~1`). Applied to array indices too, where the escape is a no-op.
 * @param base   The parent pointer (`""` for the root).
 * @param segment The child key or index.
 * @returns The child pointer.
 */
function ptr(base, segment) {
    const s = typeof segment === 'number' ? String(segment) : segment.replace(/~/g, '~0').replace(/\//g, '~1');
    return `${base}/${s}`;
}
/**
 * Narrows a value to a plain JSON object, rejecting `null` and arrays.
 * @param v    The value.
 * @param path Its JSON Pointer.
 * @param what Human-readable name of the value, for the message.
 * @returns The value as a key/value record.
 * @throws {E142GridError} `E142_GRID_NOT_AN_OBJECT`.
 */
function asObject(v, path, what) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new E142GridError('E142_GRID_NOT_AN_OBJECT', path, `${what} must be a JSON object; got ${describe(v)}.`);
    }
    return v;
}
/**
 * Names a value's JavaScript shape for an error message, without serializing a
 * 360,000-cell payload into it.
 * @param v The value.
 * @returns A short description.
 */
function describe(v) {
    if (v === null) {
        return 'null';
    }
    if (Array.isArray(v)) {
        return `an array of ${v.length}`;
    }
    return typeof v;
}
/**
 * Reads a required field, rejecting `undefined` and `null` alike (a PLC binding
 * that has nothing to say publishes `null` as readily as it omits the key, and
 * the contract distinguishes neither).
 * @param obj  The owning object.
 * @param key  The field name.
 * @param base The owner's JSON Pointer.
 * @returns The value, guaranteed neither `undefined` nor `null`.
 * @throws {E142GridError} `E142_GRID_FIELD_MISSING`.
 */
function required(obj, key, base) {
    const v = obj[key];
    if (v === undefined || v === null) {
        throw new E142GridError('E142_GRID_FIELD_MISSING', ptr(base, key), `Required field '${key}' is absent.`);
    }
    return v;
}
/**
 * Narrows a value to a finite number.
 * @param v    The value.
 * @param path Its JSON Pointer.
 * @param what Human-readable name, for the message.
 * @returns The number.
 * @throws {E142GridError} `E142_GRID_FIELD_TYPE` (also for `NaN` / infinities,
 *         which are numbers to `typeof` and lengths to nobody).
 */
function asFiniteNumber(v, path, what) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new E142GridError('E142_GRID_FIELD_TYPE', path, `${what} must be a finite number; got ${describe(v)}.`);
    }
    return v;
}
/**
 * Narrows a value to a string.
 * @param v    The value.
 * @param path Its JSON Pointer.
 * @param what Human-readable name, for the message.
 * @returns The string.
 * @throws {E142GridError} `E142_GRID_FIELD_TYPE`.
 */
function asString(v, path, what) {
    if (typeof v !== 'string') {
        throw new E142GridError('E142_GRID_FIELD_TYPE', path, `${what} must be a string; got ${describe(v)}.`);
    }
    return v;
}
/**
 * Narrows a value to an integer within an inclusive range.
 * @param v    The value.
 * @param path Its JSON Pointer.
 * @param what Human-readable name, for the message.
 * @param min  Inclusive lower bound.
 * @param max  Inclusive upper bound, or `undefined` for none.
 * @returns The integer.
 * @throws {E142GridError} `E142_GRID_FIELD_TYPE` for a non-integer,
 *         `E142_GRID_FIELD_RANGE` for an out-of-range one.
 */
function asIntInRange(v, path, what, min, max) {
    const n = asFiniteNumber(v, path, what);
    if (!Number.isInteger(n)) {
        throw new E142GridError('E142_GRID_FIELD_TYPE', path, `${what} must be an integer; got ${n}.`);
    }
    if (n < min || (max !== undefined && n > max)) {
        const range = max === undefined ? `>= ${min}` : `${min}..${max}`;
        throw new E142GridError('E142_GRID_FIELD_RANGE', path, `${what} must be ${range}; got ${n}.`);
    }
    return n;
}
/**
 * Narrows a raw value to a member of an XSD enumeration.
 *
 * Deliberately NOT trimmed and NOT case-folded: JSON carries no pretty-printer
 * whitespace the way XML element content does (the XML sibling trims for exactly
 * that reason), and the schema spellings are exact - `HexaDecimal`, not
 * `Hexadecimal`; `Row/Column`, with the slash.
 * @param v       The raw value.
 * @param allowed The enumeration, in XSD declaration order.
 * @param name    The field name, for the message.
 * @param path    Its JSON Pointer.
 * @returns The value, narrowed.
 * @throws {E142GridError} `E142_GRID_FIELD_TYPE` for a non-string,
 *         `E142_GRID_ENUM_INVALID` for a non-member.
 */
function asEnum(v, allowed, name, path) {
    const s = asString(v, path, `'${name}'`);
    if (allowed.indexOf(s) === -1) {
        throw new E142GridError('E142_GRID_ENUM_INVALID', path, `'${name}'=${JSON.stringify(s)} is not a member of {${allowed.join(', ')}}.`);
    }
    return s;
}
/**
 * Reads an (x, y) pair.
 * @param v    The value.
 * @param path Its JSON Pointer.
 * @param what Human-readable name, for the message.
 * @returns The pair.
 * @throws {E142GridError} `E142_GRID_NOT_AN_OBJECT`, `E142_GRID_FIELD_MISSING`,
 *         `E142_GRID_FIELD_TYPE`.
 */
function asXY(v, path, what) {
    const o = asObject(v, path, what);
    return {
        x: asFiniteNumber(required(o, 'x', path), ptr(path, 'x'), `${what}.x`),
        y: asFiniteNumber(required(o, 'y', path), ptr(path, 'y'), `${what}.y`),
    };
}
// ===================================================================
//  Sub-readers
// ===================================================================
/**
 * Reads {@link GridData.binDefinitions}, applying every XSD `default=` verbatim:
 * `BinQuality=""`, `BinDescription=""`, `Pick=false`; `BinCount` has no default
 * and stays absent. [XSD-normativ, BinDefinitionType].
 *
 * `binQuality` is a FREE STRING and is NOT validated against `Pass` / `Fail`: the
 * XSD types it `xs:string`, and the engine's own colour resolver treats those two
 * as a convention with an unknown-colour fallback for everything else. Rejecting
 * a third value here would invent an enumeration the standard does not have.
 * @param v    The raw `binDefinitions` value.
 * @param path Its JSON Pointer.
 * @returns The definitions, defaults applied.
 * @throws {E142GridError} On any shape or type defect.
 */
function readBinDefinitions(v, path) {
    if (!Array.isArray(v)) {
        throw new E142GridError('E142_GRID_FIELD_TYPE', path, `'binDefinitions' must be an array; got ${describe(v)}.`);
    }
    return v.map((raw, i) => {
        const p = ptr(path, i);
        const o = asObject(raw, p, `binDefinitions[${i}]`);
        const out = {
            binCode: asString(required(o, 'binCode', p), ptr(p, 'binCode'), `binDefinitions[${i}].binCode`),
            binQuality: o['binQuality'] === undefined || o['binQuality'] === null
                ? ''
                : asString(o['binQuality'], ptr(p, 'binQuality'), `binDefinitions[${i}].binQuality`),
            binDescription: o['binDescription'] === undefined || o['binDescription'] === null
                ? ''
                : asString(o['binDescription'], ptr(p, 'binDescription'), `binDefinitions[${i}].binDescription`),
            pick: o['pick'] === undefined || o['pick'] === null
                ? false
                : asBoolean(o['pick'], ptr(p, 'pick'), `binDefinitions[${i}].pick`),
        };
        if (o['binCount'] !== undefined && o['binCount'] !== null) {
            out.binCount = asIntInRange(o['binCount'], ptr(p, 'binCount'), `binDefinitions[${i}].binCount`, 0);
        }
        return out;
    });
}
/**
 * Narrows a value to a boolean.
 * @param v    The value.
 * @param path Its JSON Pointer.
 * @param what Human-readable name, for the message.
 * @returns The boolean.
 * @throws {E142GridError} `E142_GRID_FIELD_TYPE`.
 */
function asBoolean(v, path, what) {
    if (typeof v !== 'boolean') {
        throw new E142GridError('E142_GRID_FIELD_TYPE', path, `${what} must be a boolean; got ${describe(v)}.`);
    }
    return v;
}
/**
 * Converts a LOGICAL (X, Y) - the frame `Coordinate` entries live in (ASSUME-A
 * A6.1) - into the SERIALIZATION (col, row) index space the decoder speaks. The
 * ONE conversion point of this module; the rule itself lives in
 * {@link mapCoordToIndex} (ASSUME-A A2.3 + A4.3), never re-derived here.
 *
 * Out-of-range results are NOT filtered: the decoder's own bounds check reports
 * them with the offending row/column and a message that says these are
 * serialization indices, which is a better diagnostic than anything this function
 * could produce, and it keeps one gate rather than two. (Identical reasoning, and
 * identical wording, to the XML path's `toSerializationIndex`.)
 * PDF-VERIFY: A2.1/2 (Figure A1-1b, the 2DArray clause), A4.3 (Table A4-1).
 * @param x      Logical X.
 * @param y      Logical Y.
 * @param header The map header (OriginLocation x AxisDirection).
 * @param dims   The serialization lattice.
 * @returns The (col, row) serialization index.
 */
function toSerializationIndex(x, y, header, dims) {
    return mapCoordToIndex(x, y, header.originLocation, header.axisDirection, dims.cols, dims.rows);
}
/**
 * Whether every element of an array is a `string`. Vacuously true for `[]`, which
 * is intended: an empty `2DArray` payload is a zero-row payload, and the decoder
 * reports it as a row-count mismatch against the declared dimension - a truer
 * diagnosis than "indeterminate form".
 * @param a The array.
 * @returns Whether all elements are strings.
 */
function allStrings(a) {
    return a.every((e) => typeof e === 'string');
}
/**
 * Whether every element of an array is a finite `number`.
 * @param a The array.
 * @returns Whether all elements are finite numbers.
 */
function allNumbers(a) {
    return a.every((e) => typeof e === 'number' && Number.isFinite(e));
}
/**
 * Builds the `Coordinate` payload: one entry per device, `x` / `y` LOGICAL and
 * both required, `bin` the single token (or its numeric value).
 *
 * GridData's sparse entry is E142's `Coordinate` `BinCode` minus the two
 * V0125 additions the JSON contract does not carry: no `LID` - so the LID-only,
 * ungridded entry of A6.3 [C] cannot arise here and this path needs none of that
 * machinery - and no `Number`, the informational sequence index A6.2 [C] ignores
 * anyway. What remains is the [A]-quoted addressing mode alone ("The X and Y
 * coordinates must both be included", REKON3 6.5.2), which is why this function
 * is short where the XML sibling's is not.
 * @param v      The raw `bins` value, already known to be an array.
 * @param path   Its JSON Pointer.
 * @param header The map header (for the logical frame).
 * @param dims   The serialization lattice.
 * @returns The decoder payload, in serialization indices.
 * @throws {E142GridError} On any shape or type defect.
 */
function buildCoordinatePayload(v, path, header, dims) {
    return v.map((raw, i) => {
        const p = ptr(path, i);
        const o = asObject(raw, p, `bins[${i}]`);
        const x = asFiniteNumber(required(o, 'x', p), ptr(p, 'x'), `bins[${i}].x`);
        const y = asFiniteNumber(required(o, 'y', p), ptr(p, 'y'), `bins[${i}].y`);
        const bin = required(o, 'bin', p);
        if (typeof bin !== 'string' && typeof bin !== 'number') {
            throw new E142GridError('E142_GRID_FIELD_TYPE', ptr(p, 'bin'), `bins[${i}].bin must be a string or a number; got ${describe(bin)}.`);
        }
        const { serCol, serRow } = toSerializationIndex(x, y, header, dims);
        return { x: serCol, y: serRow, bin };
    });
}
/**
 * Shapes {@link GridData.bins} the way the DECLARED MapType demands, and rejects
 * every other form.
 *
 * DISPATCH BY THE DECLARED TYPE, never by inspecting the value - the XML sibling's
 * rule and for the same reason: the declared type is the document's statement of
 * intent, and guessing from shape is how a single-row `2DArray` silently becomes
 * an `Array` (REKON3 7.7.3's CSDN document is exactly that trap). The form table
 * is the contract's own; this function only enforces it.
 * @param bins   The raw `bins` value.
 * @param path   Its JSON Pointer.
 * @param mapType The resolved MapType.
 * @param header The map header (for the logical frame of `Coordinate`).
 * @param dims   The serialization lattice.
 * @returns The payload in one of {@link E142BinPayload}'s shapes.
 * @throws {E142GridError} `E142_GRID_PAYLOAD_FORM`.
 */
function shapePayload(bins, path, mapType, header, dims) {
    switch (mapType) {
        case 'Array':
            if (typeof bins === 'string') {
                return bins;
            }
            if (Array.isArray(bins) && allNumbers(bins)) {
                return bins;
            }
            throw new E142GridError('E142_GRID_PAYLOAD_FORM', path, 'MapType="Array" carries the whole map as ONE token block ("a single BinCode object can include '
                + 'the entire array of bin codes in row major format starting at the top left" [A quote, '
                + `REKON3 6.5.2]), so 'bins' must be a string or a number[]; got ${describe(bins)}.`);
        case '2DArray':
        case 'Row/Column':
            // GridData requires FULL-WIDTH rows - every row the full grid width,
            // with the cells a run would not have covered written out as the NullBin
            // token, which E142 defines for exactly that. GridData carries no
            // run-start field, so a Row/Column map has nothing that a 2DArray map
            // does not: the two share this one wire form and this reader accepts
            // both here identically. The label survives only as provenance; the
            // decode call maps it to 2DArray, because the decoder's own
            // "Row/Column" means an E142BinRun[] (see the decode boundary below).
            // (O5 open question 1, resolved for this task.)
            if (Array.isArray(bins) && allStrings(bins)) {
                return bins;
            }
            if (Array.isArray(bins) && allNumbers(bins)) {
                return bins;
            }
            throw new E142GridError('E142_GRID_PAYLOAD_FORM', path, `MapType="${mapType}" serializes one ROW per element (each row the full grid width, cells no `
                + `run covers written as the NullBin token), so 'bins' must be a string[] (one row each) or a `
                + `number[] (one value per cell, row-major); got ${describe(bins)}. A bare string is the Array `
                + 'form - declare MapType="Array" for it rather than relying on this reader to guess.');
        case 'Coordinate':
            if (Array.isArray(bins)) {
                return buildCoordinatePayload(bins, path, header, dims);
            }
            throw new E142GridError('E142_GRID_PAYLOAD_FORM', path, `MapType="Coordinate" names every device outright, so 'bins' must be an array of `
                + `{x, y, bin} entries; got ${describe(bins)}.`);
        default: {
            const _never = mapType;
            return _never;
        }
    }
}
// ===================================================================
//  The entry point
// ===================================================================
/**
 * Normalizes one GridData v1 JSON document into the engine's hand-over.
 *
 * ---- Validation order, and why it is this one ----
 * Structure, then units, then the header enums, then the BinCodeMap enums, then
 * the definitions, then the payload. The payload is LAST on purpose: a document
 * whose `binType` is out of enum has no readable payload at all, so reporting the
 * payload's shape first would name a symptom and hide the cause. Every gate is a
 * typed {@link E142GridError}; there is no lenient mode and no repair.
 *
 * ---- Defaults, all XSD-verbatim ----
 * `deviceSize` = `stepSize` (the contract's own words, and identical to the
 * engine's E-9 fallback, so the two cannot diverge); `orientation` = 0;
 * `originLocation` = `LowerLeft`; `axisDirection` = `UpRight`; `substrateSide` =
 * `TopSide`; `BinQuality` = `""`; `BinDescription` = `""`; `Pick` = `false`.
 * `mapType` = `2DArray` is the one that is NOT an XSD default but the standard's
 * PROSE default ({@link E142_DEFAULT_MAP_TYPE}, REKON3 6.5.2). Absent `lowerLeft`
 * leaves `anchorLowerLeftMm` undefined, which is how {@link computeGridPlacement}
 * is told to centre the extent on the substrate origin (A7.2).
 *
 * ---- The three header fields GridData does not carry ----
 * `substrateType` and `layoutSpecifier` are `use="required"` in the XSD and have
 * no default; GridData states neither, because it has no layout tree to specify
 * and no substrate-type field. Both are set to `''`. This is inert, not a guess:
 * {@link computeGridPlacement} reads `header.orientation` and nothing else, and
 * every other consumer of these two fields is an XML-path concern (keyref
 * resolution, schema-evolution tolerance). Inventing `'Wafer'` would be a claim
 * the document does not make. `substrateSide` differs - it HAS an XSD default, so
 * `TopSide` is the document's value, not a placeholder.
 *
 * ---- The lattice the payload must fill ----
 * `dimension` is the LAYOUT dimension (the contract says so: "E142
 * Layout/Dimension"), so the payload's lattice is that dimension through the
 * ASSUME-A A3 map-frame swap, i.e. {@link dimsInMapFrame} with this document's
 * orientation - the same function, called the same way, as the XML path. At
 * `orientation mod 180 == 0` (every fixture in the corpus) the two coincide.
 * Deriving the lattice HERE rather than from the payload's own shape is what keeps
 * it identical to the lattice {@link computeGridPlacement} will build the
 * placement on; a payload that disagrees is a mismatch and is reported as one,
 * never adopted. (The XML path can afford to adopt an observed shape because a
 * layoutless document has no declared one; GridData always declares.)
 * PDF-VERIFY: A3.1 grade B - the quadrant swap, untested by this corpus (no
 * GridData fixture carries a 90/270 orientation). See the O5 report, open question 2.
 *
 * ---- Forward compatibility ----
 * An unknown top-level key is reported once and ignored, mirroring the XML path's
 * treatment of an unknown child element. A PLC publisher that adds a field must
 * not brick a working map, and the schema at the control's attribute boundary is
 * the strict gate for authored documents.
 *
 * @param input The raw document, straight off a binding. Deliberately `unknown`.
 * @returns The normalized hand-over; feeds `computeGridPlacement` + `buildGridModel`.
 * @throws {E142GridError} Always this type and no other.
 */
export function normalizeGridData(input) {
    const warnings = [];
    const root = asObject(input, '', 'A GridData document');
    // Forward compatibility: report unknown keys once, then ignore them.
    const unknown = Object.keys(root).filter((k) => !KNOWN_KEYS.has(k));
    if (unknown.length > 0) {
        warnings.push({
            code: 'E142_GRID_UNKNOWN_KEY',
            message: `Ignored ${unknown.length} key(s) the GridData v1 contract does not define: `
                + `${unknown.map((k) => JSON.stringify(k)).join(', ')}.`,
        });
    }
    // ---- Logical grid (E142 Layout/Dimension) --------------------------------
    const dimension = asXY(required(root, 'dimension', ''), '/dimension', "'dimension'");
    const cols = asIntInRange(dimension.x, '/dimension/x', "'dimension.x' (columns)", 1);
    const rows = asIntInRange(dimension.y, '/dimension/y', "'dimension.y' (rows)", 1);
    // ---- Units (REKON3 6.4.4 / ASSUME-A A8), resolved by the shared function --
    const unitsRaw = asString(required(root, 'units', ''), '/units', "'units'");
    const factor = toMmFactor(unitsRaw);
    if (factor instanceof E142Error) {
        // Translate, never leak: one error type reaches a caller of this module.
        throw new E142GridError('E142_GRID_UNITS_UNKNOWN', '/units', factor.message, factor);
    }
    if (factor.warning !== undefined) {
        warnings.push(factor.warning);
    }
    const f = factor.factorMm;
    // ---- Physics (E142 Layout/StepSize, Layout/DeviceSize) -------------------
    const stepSize = asXY(required(root, 'stepSize', ''), '/stepSize', "'stepSize'");
    const deviceSize = root['deviceSize'] === undefined || root['deviceSize'] === null
        ? stepSize // contract default; == the engine's E-9 fallback
        : asXY(root['deviceSize'], '/deviceSize', "'deviceSize'");
    // ---- Header (E142 SubstrateMap attributes) -------------------------------
    const header = {
        substrateType: '', // not carried by GridData; inert (see the doc comment)
        substrateId: root['substrateId'] === undefined || root['substrateId'] === null
            ? ''
            : asString(root['substrateId'], '/substrateId', "'substrateId'"),
        layoutSpecifier: '', // not carried by GridData; inert (see the doc comment)
        substrateSide: DEFAULT_SUBSTRATE_SIDE, // XSD default; GridData has no side field
        orientation: root['orientation'] === undefined || root['orientation'] === null
            ? DEFAULT_ORIENTATION
            : asIntInRange(root['orientation'], '/orientation', "'orientation'", ORIENTATION_MIN, ORIENTATION_MAX),
        originLocation: root['originLocation'] === undefined || root['originLocation'] === null
            ? DEFAULT_ORIGIN_LOCATION
            : asEnum(root['originLocation'], ORIGIN_LOCATIONS, 'originLocation', '/originLocation'),
        axisDirection: root['axisDirection'] === undefined || root['axisDirection'] === null
            ? DEFAULT_AXIS_DIRECTION
            : asEnum(root['axisDirection'], AXIS_DIRECTIONS, 'axisDirection', '/axisDirection'),
    };
    // ---- Bin encoding (E142 BinCodeMap attributes) ---------------------------
    // Before the payload, deliberately: an out-of-enum binType has no readable
    // payload, so its own gate must fire first.
    const binType = asEnum(required(root, 'binType', ''), E142_BIN_TYPES, 'binType', '/binType');
    const nullBin = asString(required(root, 'nullBin', ''), '/nullBin', "'nullBin'");
    const mapType = root['mapType'] === undefined || root['mapType'] === null
        ? E142_DEFAULT_MAP_TYPE // prose default, NOT an XSD one (REKON3 6.5.2)
        : asEnum(root['mapType'], E142_MAP_TYPES, 'mapType', '/mapType');
    // ---- Bin definitions ------------------------------------------------------
    const binDefs = root['binDefinitions'] === undefined || root['binDefinitions'] === null
        ? []
        : readBinDefinitions(root['binDefinitions'], '/binDefinitions');
    // ---- Identity pass-through ------------------------------------------------
    const identity = {};
    if (root['substrateId'] !== undefined && root['substrateId'] !== null) {
        identity.substrateId = header.substrateId;
        if (identity.substrateId.length > MATERIAL_ID_MAX_LENGTH) {
            warnings.push({
                code: 'E142_GRID_ID_TOO_LONG',
                message: `'substrateId' is ${identity.substrateId.length} characters; E142 types it MaterialIdType `
                    + `(maxLength ${MATERIAL_ID_MAX_LENGTH}) [XSD-normativ]. Carried through unchanged - it is an `
                    + 'opaque output value, and truncating an identifier is worse than reporting it.',
            });
        }
    }
    if (root['lotId'] !== undefined && root['lotId'] !== null) {
        identity.lotId = asString(root['lotId'], '/lotId', "'lotId'");
        if (identity.lotId.length > LOT_ID_MAX_LENGTH) {
            warnings.push({
                code: 'E142_GRID_ID_TOO_LONG',
                message: `'lotId' is ${identity.lotId.length} characters; E142 types it LotIdType (maxLength `
                    + `${LOT_ID_MAX_LENGTH}) [XSD-normativ]. Carried through unchanged.`,
            });
        }
    }
    if (root['goodDevices'] !== undefined && root['goodDevices'] !== null) {
        identity.goodDevices = asIntInRange(root['goodDevices'], '/goodDevices', "'goodDevices'", 0);
    }
    // ---- The resolved layout --------------------------------------------------
    // The exact shape resolveLayoutSpecifier returns, in LAYOUT axes and
    // millimetres. `flavor` is 'resolved': GridData always declares its dimension,
    // so the layoutless path (dimsFromPayload) cannot arise.
    const resolvedLayout = {
        flavor: 'resolved',
        cols,
        rows,
        stepXmm: stepSize.x * f,
        stepYmm: stepSize.y * f,
        cellWmm: deviceSize.x * f,
        cellLmm: deviceSize.y * f,
        warnings,
    };
    if (root['lowerLeft'] !== undefined && root['lowerLeft'] !== null) {
        const ll = asXY(root['lowerLeft'], '/lowerLeft', "'lowerLeft'");
        resolvedLayout.anchorLowerLeftMm = { x: ll.x * f, y: ll.y * f };
    }
    // ---- The payload ----------------------------------------------------------
    // The lattice is the DECLARED dimension through the A3 map-frame swap - the
    // same lattice computeGridPlacement will place, by construction.
    const mf = dimsInMapFrame(resolvedLayout, header.orientation);
    const dims = { cols: mf.cols, rows: mf.rows };
    const shaped = shapePayload(required(root, 'bins', ''), '/bins', mapType, header, dims);
    // Cross from the GridData mapType vocabulary into the decoder's. The decoder's
    // own "Row/Column" is an E142BinRun[] - runs with logical starts - which
    // GridData never produces; a GridData Row/Column map is full-width 2DArray rows
    // (see shapePayload), so it is decoded as 2DArray. This one line is the whole
    // boundary between the two vocabularies.
    const decodeMapType = mapType === 'Row/Column' ? '2DArray' : mapType;
    let payload;
    try {
        payload = decodeBinPayload({ binType, nullBin, mapType: decodeMapType }, dims, shaped);
    }
    catch (e) {
        if (e instanceof E142DecodeError) {
            // Translate, never leak. The original travels in `cause`, so the
            // decoder's serialization row/column survives without being re-modeled.
            throw new E142GridError('E142_GRID_DECODE', '/bins', `${e.code}: ${e.message}`
                + (e.row === undefined ? '' : ` [serialization row ${e.row}${e.col === undefined ? '' : `, column ${e.col}`}]`), e);
        }
        throw e;
    }
    return {
        header,
        resolvedLayout,
        binDefs,
        payload,
        identity,
        warnings: warnings.map((w) => `${w.code}: ${w.message}`),
    };
}
/**
 * Serialises a built {@link GridModel} back to a canonical {@link GridData}
 * document - the inverse of {@link normalizeGridData} (decision E-4 was
 * import-only; this adds the export path). Round-trips: feeding the result back
 * through {@link normalizeGridData} reproduces the same cells.
 *
 * WHAT IT EMITS. Physical pitch is taken from the model's own placement step
 * VECTORS (their magnitudes, `units: "mm"`), so a map that carried real scale
 * exports its real pitch and a NOMINAL (unscaled/fit) map exports its nominal
 * pitch - i.e. exactly what the control drew. `orientation` is the SOURCE map's
 * orientation; the control-side `E142OrientationOffset` is a display correction
 * and is deliberately NOT folded in, so a round-trip through the same control
 * (which re-applies its offset) is faithful. The frame (`originLocation` /
 * `axisDirection`) is emitted verbatim so the logical addressing survives.
 *
 * PAYLOAD FORM. `Ascii` maps emit the compact `2DArray` `string[]` (one full row
 * of single-character tokens each). Numeric maps (`Decimal` / `HexaDecimal` /
 * `Integer2`) emit the sparse `Coordinate` form carrying the EXACT canonical
 * token strings - this sidesteps any per-BinType number-formatting question on
 * re-decode, and numeric grids are small in practice. Null cells are the
 * `nullBin` token in the row form and are simply omitted in the sparse form.
 * PDF-VERIFY: none - this is the inverse of an existing contract, not a SEMI
 * assumption; the frame it round-trips through is the same A2/A4 one the parser uses.
 *
 * @param grid The built grid (its `placement` supplies the pitch).
 * @param opts The non-geometric fields a GridModel does not carry.
 * @returns A GridData document equivalent to `grid`.
 */
export function gridToGridData(grid, opts) {
    const { cols, rows, cells, binTable, placement } = grid;
    const nullToken = binTable.length > 0 ? binTable[0].code : '';
    const stepXmm = Math.hypot(placement.colStepXmm, placement.colStepYmm);
    const stepYmm = Math.hypot(placement.rowStepXmm, placement.rowStepYmm);
    let mapType;
    let bins;
    if (opts.binType === 'Ascii') {
        mapType = '2DArray';
        const rowStrings = new Array(rows);
        for (let r = 0; r < rows; r++) {
            let s = '';
            for (let c = 0; c < cols; c++) {
                s += binTable[cells[r * cols + c]].code;
            }
            rowStrings[r] = s;
        }
        bins = rowStrings;
    }
    else {
        mapType = 'Coordinate';
        const entries = [];
        for (let serRow = 0; serRow < rows; serRow++) {
            for (let serCol = 0; serCol < cols; serCol++) {
                const idx = cells[serRow * cols + serCol];
                if (idx === 0) {
                    continue; // null cell: omitted from the sparse form
                }
                const { x, y } = indexToMapCoord(serCol, serRow, opts.originLocation, opts.axisDirection, cols, rows);
                entries.push({ x, y, bin: binTable[idx].code });
            }
        }
        bins = entries;
    }
    const gd = {
        dimension: { x: cols, y: rows },
        units: 'mm',
        stepSize: { x: stepXmm, y: stepYmm },
        orientation: opts.orientation,
        originLocation: opts.originLocation,
        axisDirection: opts.axisDirection,
        binType: opts.binType,
        nullBin: nullToken,
        mapType,
        bins,
    };
    if (opts.substrateId !== undefined && opts.substrateId !== null) {
        gd.substrateId = opts.substrateId;
    }
    if (opts.binDefinitions && opts.binDefinitions.length > 0) {
        gd.binDefinitions = opts.binDefinitions.map((d) => {
            const out = { binCode: d.binCode };
            if (d.binQuality !== '') {
                out.binQuality = d.binQuality;
            }
            if (d.binDescription !== '') {
                out.binDescription = d.binDescription;
            }
            if (d.binCount !== undefined) {
                out.binCount = d.binCount;
            }
            if (d.pick) {
                out.pick = d.pick;
            }
            return out;
        });
    }
    return gd;
}
/**
 * Returns (creating on demand) the namespace object at `segments` below
 * `root`. First-wins on every level: existing objects are reused, never
 * replaced, so repeated evaluation cannot orphan earlier registrations.
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
const e142GridNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142Grid');
e142GridNamespace['E142GridError'] ??= E142GridError;
e142GridNamespace['normalizeGridData'] ??= normalizeGridData;
//# sourceMappingURL=E142Grid.js.map