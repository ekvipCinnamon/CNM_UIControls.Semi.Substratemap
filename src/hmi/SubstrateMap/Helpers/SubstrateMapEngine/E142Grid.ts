/**
 * @fileoverview
 * E142Grid - the GridData v1 JSON input path of the SubstrateMapEngine: it turns
 * one compact, PLC-friendly single-map JSON object into the engine's plain-data
 * hand-over ({@link NormalizedGridData}) and nothing else.
 *
 * WHAT GridData IS. A flattening of the E142.1 model down to the one shape a PLC
 * actually publishes: ONE substrate, ONE layout, ONE BinCodeMap, no overlays, no
 * layout tree, no namespaces. Its field semantics, enums and defaults are E142
 * verbatim, taken from the V0125 XSD - this module invents no SEMI semantics of
 * its own. Where the
 * contract deliberately DEPARTS from E142 there is exactly one place, `lowerLeft`,
 * and it is documented at {@link GridData.lowerLeft}.
 *
 * DIVISION OF LABOUR - identical to the sibling XML path (E142Xml.ts), which is
 * the file to read next to this one:
 *  - E142.ts (domain) owns the LOGICAL FRAME, the units and the `Orientation`
 *    map-frame swap: this file calls {@link toMmFactor}, {@link dimsInMapFrame} and
 *    {@link mapCoordToIndex} and re-derives none of their rules. Every X/Y that
 *    reaches this module from a document is a LOGICAL coordinate; every X/Y it
 *    hands downstream is a SERIALIZATION index, converted in exactly one place
 *    ({@link toSerializationIndex}).
 *  - E142Bins.ts (decoder) owns the TOKEN GRAMMAR: this file shapes the payload
 *    the declared MapType demands and calls {@link decodeBinPayload}. It contains
 *    NO tokenizer and no second numeric formatter - the canonical `number ->
 *    token` rule lives in the decoder alone and is reached by handing it
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
 * PROVENANCE. Where a comment states a SEMI rule it also says where the rule
 * comes from: quoted from E142-0225, declared by the XSD, or inferred. An
 * inferred rule says so, so a reader can check it rather than take it on trust.
 *
 * MODULE MECHANISM: authored as an ES module, linked with `.js`
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

import {
    E142_DEFAULT_MAP_TYPE,
    E142Error,
    dimsInMapFrame,
    indexToMapCoord,
    mapCoordToIndex,
    mapFrameSwapsAxes,
    positiveXY,
    toMmFactor,
    type E142AxisDirection,
    type E142BinDefinition,
    type E142MapType,
    type E142OriginLocation,
    type E142SubstrateMapHeader,
    type E142SubstrateSide,
    type E142Warning,
    type ResolvedLayout,
} from './E142.js';
import {
    E142_BIN_TYPES, E142_MAP_TYPES, E142DecodeError, decodeBinPayload, type E142BinPayload,
    type E142BinType, type E142CoordinateEntry, type E142Dimension,
} from './E142Bins.js';
import type { DecodedBinPayload, GridModel } from './Engine.js';

// ===================================================================
//  The wire contract (GridData v1)
// ===================================================================

/**
 * An (x, y) pair as GridData spells it: two plain numbers, no per-value units
 * token (the document-level {@link GridData.units} governs every physical pair).
 * Used for `dimension` (logical, integers), `stepSize` / `deviceSize` / `lowerLeft`
 * (physical, in `units`).
 */
export interface GridDataXY {
    /** X component. Logical count for `dimension`, a length in `units` otherwise. */
    x: number;
    /** Y component. Logical count for `dimension`, a length in `units` otherwise. */
    y: number;
}

/**
 * One entry of {@link GridData.binDefinitions}, mirroring E142 `BinDefinitionType`
 * attribute for attribute. Only `binCode` is required; the other four carry the
 * XSD's own `default=` values, which {@link normalizeGridData} applies verbatim
 * Declared by `BinDefinitionType` in E142-1-V0125-Schema.xsd.
 */
export interface GridDataBinDefinition {
    /** `BinDefinition/@BinCode` - the token this definition describes. Required. */
    binCode: string;
    /** `@BinQuality` - free-form quality string, NOT an enum. XSD default `""`. */
    binQuality?: string;
    /** `@BinDescription` - human-readable description. XSD default `""`. */
    binDescription?: string;
    /** `@BinCount` - optional running count (`xs:nonNegativeInteger`); no default. */
    binCount?: number;
    /** `@Pick` - whether devices of this bin are picked. XSD default `false`. */
    pick?: boolean;
}

/**
 * One entry of a sparse `Coordinate` payload. `x` / `y` are LOGICAL E142 map
 * coordinates (the `originLocation` x `axisDirection` frame, hence possibly
 * negative), NOT serialization indices; {@link normalizeGridData} converts them
 * in exactly one place ({@link toSerializationIndex}).
 */
export interface GridDataCoordinateEntry {
    /** Logical X of the addressed device. */
    x: number;
    /** Logical Y of the addressed device. */
    y: number;
    /** The device's bin: the wire token, or its numeric value. */
    bin: string | number;
}

/**
 * Every payload form {@link GridData.bins} may take. Which one is legal is
 * decided by {@link GridData.mapType} and never by inspecting the value - see
 * {@link normalizeGridData}'s dispatch note.
 */
export type GridDataBins = string | string[] | number[] | GridDataCoordinateEntry[];

/**
 * The GridData v1 document: the compact, PLC-friendly single-map JSON contract.
 *
 * This interface is the TypeScript face of the contract that
 * `Controls/SubstrateMap/Schema/TypeDefinitions/GridData.Schema.json` is the
 * TwinCAT face of; the two are kept field-for-field consistent by hand, and the
 * schema is the stricter of the pair (it additionally enforces the XSD's
 * `maxLength` on the identity strings, which this module only warns about - see
 * {@link normalizeGridData}).
 *
 * It is exported for documentation and for callers that already hold a typed
 * object; {@link normalizeGridData} deliberately takes `unknown` regardless,
 * because a value arriving from a PLC binding has no compile-time guarantee.
 */
export interface GridData {
    /** E142 `Layout/Dimension`: the LOGICAL grid extent, x = columns, y = rows. Both `>= 1`. Required. */
    dimension: GridDataXY;
    /**
     * The units every physical field of this document is expressed in
     * (`stepSize`, `deviceSize`, `lowerLeft`), i.e. E142 `Layout/@DefaultUnits`.
     * Required - the contract states no default, and E142 declares the attribute
     * `use="required"` in the XSD.
     *
     * `mm` / `um` are normative; `microns`, `<n>Microns` and `mil` are tolerated
     * WITH a warning; anything else is a typed error. The rule lives in
     * {@link toMmFactor}, not here.
     */
    units: string;
    /** E142 `Layout/StepSize`: the full pitch (street included) per column (x) / row (y). Required. */
    stepSize: GridDataXY;
    /** E142 `Layout/DeviceSize`: the DRAWN cell extent. Optional; defaults to `stepSize`. */
    deviceSize?: GridDataXY;
    /**
     * The physical anchor: the S-frame position of the grid's LOWER-LEFT CORNER,
     * in `units`, +y up, origin = the substrate center. Optional; when absent the
     * grid extent is centered on the substrate origin.
     *
     * DELIBERATELY CONTROL-DEFINED, and the one field of this contract that is
     * NOT E142-verbatim. E142's own `Layout/LowerLeft` is, per the source
     * situation, a PARENT-LAYOUT-RELATIVE offset - inferred, not stated - and no
     * public source states its reference frame in words, and every observed
     * example carries it on child layouts only. GridData has no layout tree for
     * such an offset to be relative TO, so the contract redefines the field
     * against the substrate frame instead of inheriting an inferred meaning.
     * The two are NOT interchangeable and this module never treats them as such.
     * This is a contract decision, not a SEMI assumption; the E142 side of it is
     * quarantined in {@link resolveLayoutSpecifier}.
     */
    lowerLeft?: GridDataXY;
    /**
     * `SubstrateMap/@Orientation`: rotation of the substrate relative to the map
     * data, CW-positive, an integer `0..359`. Optional; XSD default `0`
     * Declared by `OrientationType` and `SubstrateMapType/@Orientation`.
     */
    orientation?: number;
    /** `SubstrateMap/@OriginLocation`: the visual cell carrying logical (0,0). Optional; XSD default `LowerLeft`. */
    originLocation?: E142OriginLocation;
    /** `SubstrateMap/@AxisDirection`: the logical axis sign convention. Optional; XSD default `UpRight`. */
    axisDirection?: E142AxisDirection;
    /** `BinCodeMap/@BinType`: the token encoding. Required (XSD `use="required"`). */
    binType: E142BinType;
    /** `BinCodeMap/@NullBin`: the null-cell token. Required (XSD `use="required"`). */
    nullBin: string;
    /**
     * `BinCodeMap/@MapType`: the payload's serialization form. Optional; resolves
     * to `2DArray`. The XSD carries NO `default=` for it - that value is the
     * standard's PROSE default, an application-level rule this module applies via
     * {@link E142_DEFAULT_MAP_TYPE} (the prose-vs-schema
     * divergence).
     *
     * `Row/Column` and `2DArray` share ONE wire form here. E142's XML Row/Column is
     * a list of runs, each with its own logical start (X, Y); GridData carries no
     * run-start field, so a GridData Row/Column map is serialized as full-width
     * rows with the cells no run covers written out as the NullBin token (which
     * E142 defines for exactly that). Stripped of run starts and required to be
     * full width, it IS a 2DArray map, and is decoded as one - the label survives
     * only as provenance.
     */
    mapType?: E142MapType;
    /** E142 `BinDefinitions/BinDefinition`, optional. */
    binDefinitions?: GridDataBinDefinition[];
    /**
     * The payload. Its legal FORM is decided by {@link mapType}, per the
     * contract's own form table:
     * | `mapType`               | accepted `bins`                              |
     * | `Array`                 | `string` (one block) or `number[]`           |
     * | `2DArray`, `Row/Column` | `string[]` (one row each) or `number[]`      |
     * | `Coordinate`            | {@link GridDataCoordinateEntry}`[]` (sparse) |
     * A `number[]` is one value per cell, row-major, `dimension.x * dimension.y`
     * long, canonicalized to a token by {@link decodeBinPayload} per `binType`.
     * `Row/Column` shares `2DArray`'s form because GridData carries no run start
     * (see {@link mapType}); every row is the full grid width, uncovered cells
     * written as the NullBin token.
     */
    bins: GridDataBins;

    /**
     * Optional per-cell location identifiers, mirroring E142 `BinCode/@LID`.
     *
     * Row-major over the WHOLE lattice - exactly `dimension.x * dimension.y`
     * entries, index `row * cols + col` - regardless of which form `bins` takes.
     * `null` marks a cell the document does not name; `""` is a real, legal LID
     * of zero length and is NOT the same thing.
     *
     * A LID names the LOCATION, not the device in it (13.4). Opaque: never
     * trimmed, never case-folded, because it is a join key.
     */
    lids?: (string | null)[];
    /** E142 `Substrate/@SubstrateId`. Optional pass-through for the read-only outputs. */
    substrateId?: string;
    /** E142 `Substrate/LotId`. Optional pass-through for the read-only outputs. */
    lotId?: string;
    /** E142 `Substrate/GoodDevices`. Optional pass-through for the read-only outputs. */
    goodDevices?: number;
}

// ===================================================================
//  The error contract
// ===================================================================

/**
 * Discriminator of {@link E142GridError}. Stable, machine-readable, and
 * deliberately narrow - the human detail lives in the message, the location in
 * {@link E142GridError.path}.
 */
export type E142GridErrorCode =
    /** The document, or a value that must be an object/array, is not one. */
    | 'E142_GRID_NOT_AN_OBJECT'
    /** A required field is absent. */
    | 'E142_GRID_FIELD_MISSING'
    /** A field is present but of the wrong JavaScript type. */
    | 'E142_GRID_FIELD_TYPE'
    /** A field is of the right type but outside its declared range (e.g. `orientation` 0..359). */
    | 'E142_GRID_FIELD_RANGE'
    /** A field's value is not a member of its XSD enumeration. */
    | 'E142_GRID_ENUM_INVALID'
    /** `units` is not resolvable to a millimeter factor ({@link toMmFactor}). */
    | 'E142_GRID_UNITS_UNKNOWN'
    /** `bins` has a form the declared `mapType` does not accept. */
    | 'E142_GRID_PAYLOAD_FORM'
    /** {@link decodeBinPayload} rejected the payload; the original travels in `cause`. */
    | 'E142_GRID_DECODE';

/**
 * The one error {@link normalizeGridData} throws. Carries a machine-readable
 * {@link code}, a human message, and the JSON POINTER (RFC 6901) of the offending
 * value - `""` for the document itself, `"/dimension/x"` for a nested scalar,
 * `"/bins/3/x"` for an array element's field. A pointer rather than a dotted path
 * because GridData arrives as JSON and RFC 6901 is what a JSON operator's tools
 * already speak; the XML sibling uses an XPath-flavored path for the same reason.
 *
 * Nothing else escapes this module: {@link E142DecodeError} from the decoder and
 * {@link E142Error} from the units resolver are translated, so a caller can
 * `catch (e) { if (e instanceof E142GridError) }` and be exhaustive. The original
 * travels in {@link cause}, so the decoder's serialization row/column survives
 * without being re-modeled here.
 */
export class E142GridError extends Error {
    /** Machine-readable discriminator; switch on this, never on the message. */
    public readonly code: E142GridErrorCode;

    /** JSON Pointer (RFC 6901) of the offending value; `""` is the document root. */
    public readonly path: string;

    /** The wrapped original error, when this error translates one. */
    public readonly cause?: unknown;

    /**
     * @param code    The machine-readable discriminator.
     * @param path    JSON Pointer of the offending value.
     * @param message Human-readable detail; should name the concrete values seen.
     * @param cause   The original error, when translating one.
     */
    public constructor(code: E142GridErrorCode, path: string, message: string, cause?: unknown) {
        super(`${message} (at ${path === '' ? '<document>' : path})`);
        this.name = 'E142GridError';
        this.code = code;
        this.path = path;
        this.cause = cause;
    }
}

// ===================================================================
//  The result
// ===================================================================

/**
 * The optional E142 `Substrate` fields GridData passes through untouched, for the
 * control's read-only outputs. Carry-only: no rule in this module or in the
 * placement math branches on any of them. A field is present only when the
 * document supplied it, so a consumer can tell "absent" from "empty".
 */
export interface GridDataIdentity {
    /** `Substrate/@SubstrateId`, when supplied. */
    substrateId?: string;
    /** `Substrate/LotId`, when supplied. */
    lotId?: string;
    /** `Substrate/GoodDevices`, when supplied. */
    goodDevices?: number;
}

/**
 * Everything one GridData document normalizes to: the four values the render
 * pipeline consumes, the identity pass-through and the diagnostics.
 *
 * NO FURTHER SHAPING IS NEEDED OR INTENDED. The pipeline is literally:
 * ```ts
 * const n = normalizeGridData(json);
 * const { placement } = computeGridPlacement(n.header, n.resolvedLayout);
 * const grid = buildGridModel(placement, n.payload, n.binDefs.map(toEngineBinDefinition));
 * ```
 * The one map on the last line is a FIELD RENAME between two engine types
 * (`E142BinDefinition.binCode/binQuality` vs `Engine.BinDefinition.code/quality`),
 * not a reshaping of this result; it belongs to whichever layer owns the engine's
 * render types, exactly as it does on the XML path.
 */
export interface NormalizedGridData {
    /**
     * The E142 map header, with the three fields GridData does not carry filled
     * from the XSD default (`substrateSide`) or left empty (`substrateType`,
     * `layoutSpecifier`) - see {@link normalizeGridData} on why that is inert.
     * Feeds {@link computeGridPlacement} directly.
     */
    header: E142SubstrateMapHeader;

    /**
     * The layout, resolved exactly as {@link resolveLayoutSpecifier} would return
     * it for an equivalent XML document: LAYOUT-axis dims and pitches in
     * millimeters (the `Orientation` map-frame swap is {@link computeGridPlacement}'s job,
     * not this result's), `anchorLowerLeftMm` present only when the document
     * carried `lowerLeft`. `flavor` is always `'resolved'`: GridData always
     * declares its dimension, so the layoutless path cannot arise.
     */
    resolvedLayout: ResolvedLayout;

    /** The bin definitions, with every XSD `default=` applied. Empty when the document carried none. */
    binDefs: E142BinDefinition[];

    /** The decoded payload, in SERIALIZATION index space, ready for `buildGridModel`. */
    payload: DecodedBinPayload;

    /** The E142 `Substrate` fields, passed through untouched. */
    identity: GridDataIdentity;

    /**
     * Non-fatal diagnostics, rendered human-readable as `"<code>: <message>"`.
     *
     * The `string[]` shape is this contract's, not the engine's: every other engine
     * function surfaces {@link E142Warning}`[]`. Nothing is lost by it here -
     * these are the very same warnings, and their STRUCTURED form survives in
     * {@link resolvedLayout}`.warnings`, which {@link computeGridPlacement} copies
     * into its own result. A caller that wants to switch on `code` reads them
     * there; a caller that wants to log reads these.
     */
    warnings: string[];
}

// ===================================================================
//  Contract constants
// ===================================================================

/**
 * `OriginLocationEnum` of the E142.1 XSD, in declaration order. See
 * E142-1-V0125-Schema.xsd]. Duplicated from E142Xml's private list rather than
 * shared because neither module exports one; a future task should lift both to
 * E142.ts next to {@link E142OriginLocation}. The list is XSD-verbatim in both
 * places, so it cannot drift silently - a member added to one and not the other
 * is a compile error against the union type.
 */
const ORIGIN_LOCATIONS: readonly E142OriginLocation[] = [
    'LowerLeft', 'UpperLeft', 'LowerRight', 'UpperRight', 'Center',
];

/** `AxisDirectionEnum` of the E142.1 XSD, in declaration order. See {@link ORIGIN_LOCATIONS}. */
const AXIS_DIRECTIONS: readonly E142AxisDirection[] = ['UpRight', 'DownRight', 'UpLeft', 'DownLeft'];

/** `SubstrateMapType/@OriginLocation` XSD default. */
const DEFAULT_ORIGIN_LOCATION: E142OriginLocation = 'LowerLeft';

/** `SubstrateMapType/@AxisDirection` XSD default. */
const DEFAULT_AXIS_DIRECTION: E142AxisDirection = 'UpRight';

/** `SubstrateMapType/@Orientation` XSD default. */
const DEFAULT_ORIENTATION = 0;

/**
 * `SubstrateMapType/@SubstrateSide` XSD default. GridData carries
 * no side field, so this is what every GridData map is; it is carry-only for
 * placement either way.
 */
const DEFAULT_SUBSTRATE_SIDE: E142SubstrateSide = 'TopSide';

/** `OrientationType` inclusive lower bound, from the XSD. */
const ORIENTATION_MIN = 0;

/** `OrientationType` inclusive upper bound, from the XSD. */
const ORIENTATION_MAX = 359;

/** `MaterialIdType` maxLength, which `Substrate/@SubstrateId` is typed with. */
const MATERIAL_ID_MAX_LENGTH = 32;

/** `LotIdType` maxLength, which `Substrate/LotId` is typed with. */
const LOT_ID_MAX_LENGTH = 80;

/**
 * Reads the optional `lids` array into the sparse map {@link DecodedBinPayload}
 * carries.
 *
 * ROW-MAJOR AND FULL LENGTH, whatever form `bins` took. One slot per cell means
 * there is no shape to match against `bins`, whose four accepted forms
 * (a token block, rows, a flat number array, sparse entries) index the grid four
 * different ways - and whose `Coordinate` form is in LOGICAL coordinates while
 * the decoded cells are in SERIALIZATION order. A single row-major array sidesteps
 * that entirely: index `row * cols + col`, exactly the key
 * {@link DecodedBinPayload.lids} uses, so the mapping is the identity.
 *
 * `null` MEANS ABSENT AND `""` DOES NOT. E142 types `LID` as `xs:string` with no
 * `minLength`, so a zero-length LID is legal and a document may state one; the two
 * are different claims and collapsing them would lose a distinction the standard
 * makes (the Substrate id fields follow the same reasoning). Only non-null entries
 * reach the map.
 *
 * Values are opaque: no trimming, no case folding. A LID is a join key.
 *
 * @param raw   The raw `lids` value, or `undefined`.
 * @param cells How many cells the lattice has (`cols * rows`).
 * @returns The sparse map, or `undefined` when the document carried none.
 * @throws {E142GridError} `E142_GRID_FIELD_TYPE` on a wrong shape or a length
 *         that does not match the lattice.
 */
function readLids(raw: unknown, cells: number): ReadonlyMap<number, string> | undefined {
    if (raw === undefined || raw === null) { return undefined; }
    if (!Array.isArray(raw)) {
        throw new E142GridError(
            'E142_GRID_FIELD_TYPE', '/lids',
            `lids must be an array of strings and nulls, one per cell; got ${describe(raw)}.`,
        );
    }
    if (raw.length !== cells) {
        throw new E142GridError(
            'E142_GRID_FIELD_TYPE', '/lids',
            `lids must have exactly one entry per cell - dimension.x * dimension.y = ${cells} - `
            + `but has ${raw.length}. It is row-major over the whole lattice, not only over the cells `
            + 'that carry a LID; use null for a cell the document does not name.',
        );
    }
    const out = new Map<number, string>();
    for (let i = 0; i < raw.length; i++) {
        const v = raw[i];
        if (v === null || v === undefined) { continue; }
        if (typeof v !== 'string') {
            throw new E142GridError(
                'E142_GRID_FIELD_TYPE', ptr('/lids', String(i)),
                `lids[${i}] must be a string or null; got ${describe(v)}.`,
            );
        }
        out.set(i, v);
    }
    return out.size > 0 ? out : undefined;
}

/**
 * Every key the GridData v1 contract defines. Anything else is reported once and
 * ignored - see {@link normalizeGridData} on forward compatibility.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
    'dimension', 'units', 'stepSize', 'deviceSize', 'lowerLeft',
    'orientation', 'originLocation', 'axisDirection',
    'binType', 'nullBin', 'mapType', 'binDefinitions', 'bins', 'lids',
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
function ptr(base: string, segment: string | number): string {
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
function asObject(v: unknown, path: string, what: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new E142GridError(
            'E142_GRID_NOT_AN_OBJECT',
            path,
            `${what} must be a JSON object; got ${describe(v)}.`,
        );
    }
    return v as Record<string, unknown>;
}

/**
 * Names a value's JavaScript shape for an error message, without serializing a
 * 360,000-cell payload into it.
 * @param v The value.
 * @returns A short description.
 */
function describe(v: unknown): string {
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
function required(obj: Record<string, unknown>, key: string, base: string): unknown {
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
function asFiniteNumber(v: unknown, path: string, what: string): number {
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
function asString(v: unknown, path: string, what: string): string {
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
function asIntInRange(v: unknown, path: string, what: string, min: number, max?: number): number {
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
function asEnum<T extends string>(v: unknown, allowed: readonly T[], name: string, path: string): T {
    const s = asString(v, path, `'${name}'`);
    if ((allowed as readonly string[]).indexOf(s) === -1) {
        throw new E142GridError(
            'E142_GRID_ENUM_INVALID',
            path,
            `'${name}'=${JSON.stringify(s)} is not a member of {${allowed.join(', ')}}.`,
        );
    }
    return s as T;
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
function asXY(v: unknown, path: string, what: string): GridDataXY {
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
 * and stays absent, as `BinDefinitionType` declares.
 *
 * `binQuality` is a FREE STRING and is NOT validated against `Pass` / `Fail`: the
 * XSD types it `xs:string`, and the engine's own color resolver treats those two
 * as a convention with an unknown-color fallback for everything else. Rejecting
 * a third value here would invent an enumeration the standard does not have.
 * @param v    The raw `binDefinitions` value.
 * @param path Its JSON Pointer.
 * @returns The definitions, defaults applied.
 * @throws {E142GridError} On any shape or type defect.
 */
function readBinDefinitions(v: unknown, path: string): E142BinDefinition[] {
    if (!Array.isArray(v)) {
        throw new E142GridError('E142_GRID_FIELD_TYPE', path, `'binDefinitions' must be an array; got ${describe(v)}.`);
    }
    return v.map((raw, i) => {
        const p = ptr(path, i);
        const o = asObject(raw, p, `binDefinitions[${i}]`);
        const out: E142BinDefinition = {
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
function asBoolean(v: unknown, path: string, what: string): boolean {
    if (typeof v !== 'boolean') {
        throw new E142GridError('E142_GRID_FIELD_TYPE', path, `${what} must be a boolean; got ${describe(v)}.`);
    }
    return v;
}

/**
 * Converts a LOGICAL (X, Y) - the frame `Coordinate` entries live in - into the
 * SERIALIZATION (col, row) index space the decoder speaks. The
 * ONE conversion point of this module; the rule itself lives in
 * {@link mapCoordToIndex}, never re-derived here.
 *
 * Out-of-range results are NOT filtered: the decoder's own bounds check reports
 * them with the offending row/column and a message that says these are
 * serialization indices, which is a better diagnostic than anything this function
 * could produce, and it keeps one gate rather than two. (Identical reasoning, and
 * identical wording, to the XML path's `toSerializationIndex`.)
 * The rule is settled by Figure A1-1b with the 2DArray clause, and by Table A4-1.
 * @param x      Logical X.
 * @param y      Logical Y.
 * @param header The map header (OriginLocation x AxisDirection).
 * @param dims   The serialization lattice.
 * @returns The (col, row) serialization index.
 */
function toSerializationIndex(
    x: number,
    y: number,
    header: E142SubstrateMapHeader,
    dims: E142Dimension,
): { serCol: number; serRow: number } {
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
function allStrings(a: readonly unknown[]): a is string[] {
    return a.every((e) => typeof e === 'string');
}

/**
 * Whether every element of an array is a finite `number`.
 * @param a The array.
 * @returns Whether all elements are finite numbers.
 */
function allNumbers(a: readonly unknown[]): a is number[] {
    return a.every((e) => typeof e === 'number' && Number.isFinite(e));
}

/**
 * Builds the `Coordinate` payload: one entry per device, `x` / `y` LOGICAL and
 * both required, `bin` the single token (or its numeric value).
 *
 * GridData's sparse entry is E142's `Coordinate` `BinCode` minus the two
 * V0125 additions the JSON contract does not carry: no `LID` - so the LID-only,
 * ungridded LID-only entry cannot arise here and this path needs none of that
 * machinery - and no `Number`, the informational sequence index that placement
 * ignores anyway. What remains is the addressing mode the standard states
 * outright ("The X and Y coordinates must both be included"), which is why this function
 * is short where the XML sibling's is not.
 * @param v      The raw `bins` value, already known to be an array.
 * @param path   Its JSON Pointer.
 * @param header The map header (for the logical frame).
 * @param dims   The serialization lattice.
 * @returns The decoder payload, in serialization indices.
 * @throws {E142GridError} On any shape or type defect.
 */
function buildCoordinatePayload(
    v: readonly unknown[],
    path: string,
    header: E142SubstrateMapHeader,
    dims: E142Dimension,
): E142CoordinateEntry[] {
    return v.map((raw, i) => {
        const p = ptr(path, i);
        const o = asObject(raw, p, `bins[${i}]`);
        const x = asFiniteNumber(required(o, 'x', p), ptr(p, 'x'), `bins[${i}].x`);
        const y = asFiniteNumber(required(o, 'y', p), ptr(p, 'y'), `bins[${i}].y`);
        const bin = required(o, 'bin', p);
        if (typeof bin !== 'string' && typeof bin !== 'number') {
            throw new E142GridError(
                'E142_GRID_FIELD_TYPE',
                ptr(p, 'bin'),
                `bins[${i}].bin must be a string or a number; got ${describe(bin)}.`,
            );
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
 * an `Array` (one surveyed document is exactly that trap). The form table
 * is the contract's own; this function only enforces it.
 * @param bins   The raw `bins` value.
 * @param path   Its JSON Pointer.
 * @param mapType The resolved MapType.
 * @param header The map header (for the logical frame of `Coordinate`).
 * @param dims   The serialization lattice.
 * @returns The payload in one of {@link E142BinPayload}'s shapes.
 * @throws {E142GridError} `E142_GRID_PAYLOAD_FORM`.
 */
function shapePayload(
    bins: unknown,
    path: string,
    mapType: E142MapType,
    header: E142SubstrateMapHeader,
    dims: E142Dimension,
): E142BinPayload {
    switch (mapType) {
        case 'Array':
            if (typeof bins === 'string') {
                return bins;
            }
            if (Array.isArray(bins) && allNumbers(bins)) {
                return bins;
            }
            throw new E142GridError(
                'E142_GRID_PAYLOAD_FORM',
                path,
                'MapType="Array" carries the whole map as ONE token block ("a single BinCode object can include '
                + 'the entire array of bin codes in row major format starting at the top left", '
                + `in E142-0225's own words), so 'bins' must be a string or a number[]; got ${describe(bins)}.`,
            );
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
            if (Array.isArray(bins) && allStrings(bins)) {
                return bins;
            }
            if (Array.isArray(bins) && allNumbers(bins)) {
                return bins;
            }
            throw new E142GridError(
                'E142_GRID_PAYLOAD_FORM',
                path,
                `MapType="${mapType}" serializes one ROW per element (each row the full grid width, cells no `
                + `run covers written as the NullBin token), so 'bins' must be a string[] (one row each) or a `
                + `number[] (one value per cell, row-major); got ${describe(bins)}. A bare string is the Array `
                + 'form - declare MapType="Array" for it rather than relying on this reader to guess.',
            );
        case 'Coordinate':
            if (Array.isArray(bins)) {
                return buildCoordinatePayload(bins, path, header, dims);
            }
            throw new E142GridError(
                'E142_GRID_PAYLOAD_FORM',
                path,
                `MapType="Coordinate" names every device outright, so 'bins' must be an array of `
                + `{x, y, bin} entries; got ${describe(bins)}.`,
            );
        default: {
            const _never: never = mapType;
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
 * engine's own `deviceSize` fallback, so the two cannot diverge); `orientation` = 0;
 * `originLocation` = `LowerLeft`; `axisDirection` = `UpRight`; `substrateSide` =
 * `TopSide`; `BinQuality` = `""`; `BinDescription` = `""`; `Pick` = `false`.
 * `mapType` = `2DArray` is the one that is NOT an XSD default but the standard's
 * PROSE default ({@link E142_DEFAULT_MAP_TYPE}). Absent `lowerLeft`
 * leaves `anchorLowerLeftMm` undefined, which is how {@link computeGridPlacement}
 * is told to center the extent on the substrate origin.
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
 * map-frame dimension swap, i.e. {@link dimsInMapFrame} with this document's
 * orientation - the same function, called the same way, as the XML path. At
 * `orientation mod 180 == 0` (every fixture in the corpus) the two coincide.
 * Deriving the lattice HERE rather than from the payload's own shape is what keeps
 * it identical to the lattice {@link computeGridPlacement} will build the
 * placement on; a payload that disagrees is a mismatch and is reported as one,
 * never adopted. (The XML path can afford to adopt an observed shape because a
 * layoutless document has no declared one; GridData always declares.)
 * The quadrant swap is untested by this corpus (no
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
export function normalizeGridData(input: unknown): NormalizedGridData {
    const warnings: E142Warning[] = [];
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

    // ---- Units, resolved by the shared function ------------------------------
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
        ? stepSize                                      // contract default; == the engine's own fallback
        : asXY(root['deviceSize'], '/deviceSize', "'deviceSize'");

    // ---- Header (E142 SubstrateMap attributes) -------------------------------
    const header: E142SubstrateMapHeader = {
        substrateType: '',                              // not carried by GridData; inert (see the doc comment)
        substrateId: root['substrateId'] === undefined || root['substrateId'] === null
            ? ''
            : asString(root['substrateId'], '/substrateId', "'substrateId'"),
        layoutSpecifier: '',                            // not carried by GridData; inert (see the doc comment)
        substrateSide: DEFAULT_SUBSTRATE_SIDE,          // XSD default; GridData has no side field
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
        ? E142_DEFAULT_MAP_TYPE                         // prose default, NOT an XSD one
        : asEnum(root['mapType'], E142_MAP_TYPES, 'mapType', '/mapType');

    // ---- Bin definitions ------------------------------------------------------
    const binDefs = root['binDefinitions'] === undefined || root['binDefinitions'] === null
        ? []
        : readBinDefinitions(root['binDefinitions'], '/binDefinitions');

    // ---- Identity pass-through ------------------------------------------------
    const identity: GridDataIdentity = {};
    if (root['substrateId'] !== undefined && root['substrateId'] !== null) {
        identity.substrateId = header.substrateId;
        if (identity.substrateId.length > MATERIAL_ID_MAX_LENGTH) {
            warnings.push({
                code: 'E142_GRID_ID_TOO_LONG',
                message: `'substrateId' is ${identity.substrateId.length} characters; E142 types it MaterialIdType `
                    + `(maxLength ${MATERIAL_ID_MAX_LENGTH}) in the XSD. Carried through unchanged - it is an `
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
                    + `${LOT_ID_MAX_LENGTH}) in the XSD. Carried through unchanged.`,
            });
        }
    }
    if (root['goodDevices'] !== undefined && root['goodDevices'] !== null) {
        identity.goodDevices = asIntInRange(root['goodDevices'], '/goodDevices', "'goodDevices'", 0);
    }

    // ---- The resolved layout --------------------------------------------------
    // The exact shape resolveLayoutSpecifier returns, in LAYOUT axes and
    // millimeters. `flavor` is 'resolved': GridData always declares its dimension,
    // so the layoutless path (dimsFromPayload) cannot arise.
    const resolvedLayout: ResolvedLayout = {
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
    // The lattice is the DECLARED dimension through the `Orientation` swap - the
    // same lattice computeGridPlacement will place, by construction.
    const mf = dimsInMapFrame(resolvedLayout, header.orientation);
    const dims: E142Dimension = { cols: mf.cols, rows: mf.rows };
    const shaped = shapePayload(required(root, 'bins', ''), '/bins', mapType, header, dims);

    // Cross from the GridData mapType vocabulary into the decoder's. The decoder's
    // own "Row/Column" is an E142BinRun[] - runs with logical starts - which
    // GridData never produces; a GridData Row/Column map is full-width 2DArray rows
    // (see shapePayload), so it is decoded as 2DArray. This one line is the whole
    // boundary between the two vocabularies.
    const decodeMapType: E142MapType = mapType === 'Row/Column' ? '2DArray' : mapType;

    let payload: DecodedBinPayload;
    try {
        payload = decodeBinPayload({ binType, nullBin, mapType: decodeMapType }, dims, shaped);
    } catch (e) {
        if (e instanceof E142DecodeError) {
            // Translate, never leak. The original travels in `cause`, so the
            // decoder's serialization row/column survives without being re-modeled.
            throw new E142GridError(
                'E142_GRID_DECODE',
                '/bins',
                `${e.code}: ${e.message}`
                + (e.row === undefined ? '' : ` [serialization row ${e.row}${e.col === undefined ? '' : `, column ${e.col}`}]`),
                e,
            );
        }
        throw e;
    }
    const lids = readLids(root['lids'], dims.cols * dims.rows);
    if (lids !== undefined) {
        payload.lids = lids;
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
 * Options for {@link gridToGridData} that a {@link GridModel} does not itself
 * carry (the frame, the source orientation, the token encoding, the identity).
 */
export interface GridToGridDataOptions {
    /** Source `SubstrateMap/@Orientation` (the map's own, NOT the control's display offset). */
    orientation: number;
    /** OriginLocation of the frame the grid was built in. */
    originLocation: E142OriginLocation;
    /** AxisDirection of that frame. */
    axisDirection: E142AxisDirection;
    /** The bin-token encoding, needed to canonicalize the exported tokens. */
    binType: E142BinType;
    /** Substrate id for the identity field, or `null`/absent to omit it. */
    substrateId?: string | null;
    /** Bin definitions to emit, or `null`/absent to omit. */
    binDefinitions?: E142BinDefinition[] | null;
    /**
     * `Substrate/LotId` (`LotIdType`, maxLength 80). Omitted when absent or
     * blank - the importer trims, so a blank string reads back as absent and
     * emitting it would claim a lot id that is not one.
     */
    lotId?: string;
    /**
     * `Substrate/GoodDevices`. The contract types it `integer, minimum 0`, so
     * ZERO is a legitimate measurement and is emitted; a negative, fractional or
     * non-finite value is not a count and is dropped.
     */
    goodDevices?: number;
}

/**
 * Serializes a built {@link GridModel} back to a canonical {@link GridData}
 * document - the inverse of {@link normalizeGridData} (the reader was
 * import-only; this adds the export path). Round-trips: feeding the result back
 * through {@link normalizeGridData} reproduces the same cells.
 *
 * WHAT IT EMITS. Physical pitch is taken from the model's own placement step
 * VECTORS (their magnitudes, `units: "mm"`), so a map that carried real scale
 * exports its real pitch and a NOMINAL (unscaled/fit) map exports its nominal
 * pitch - i.e. exactly what the control drew.
 *
 * `deviceSize` - the DRAWN extent of one cell - is emitted alongside `stepSize`,
 * the full pitch. The two are not the same number and the difference is the
 * street: E142-0225 Table 2, `StepSize` row, "StepSize - DeviceSize is equal to
 * the 'street' width between devices", in E142-0225's own words. Emitting only
 * `stepSize` does not leave the street unknown, it asserts that there is none,
 * because this contract's documented fallback for an absent `deviceSize` is
 * `deviceSize = stepSize`: a 5 mm pitch with a 4 mm device re-imported as a
 * 5 mm device and the street was silently closed. The value comes from
 * `placement.cellWmm` / `cellLmm`, which the importer derived from the source's
 * own `deviceSize` (or E142 `Layout/DeviceSize`) on the way in, so the street
 * now survives the round trip.
 *
 * It is omitted when either extent is not finite or not strictly positive
 * ({@link positiveXY}) - all-or-nothing, since the field declares both `x` and
 * `y` required. There is deliberately no substrate-size counterpart here: E142
 * expresses that as `DeviceSize` on a TOP-LEVEL layout, and GridData has no
 * layout tree for a top level to exist in. `orientation` is the SOURCE map's
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
 * Not a SEMI assumption: this is the inverse of an existing contract, and the frame
 * it round-trips through is the same one the parser uses.
 *
 * @param grid The built grid (its `placement` supplies the pitch).
 * @param opts The non-geometric fields a GridModel does not carry.
 * @returns A GridData document equivalent to `grid`.
 */
export function gridToGridData(grid: GridModel, opts: GridToGridDataOptions): GridData {
    const { cols, rows, cells, binTable, placement } = grid;
    const nullToken = binTable.length > 0 ? binTable[0].code : '';
    // `dimension`, `stepSize` and `deviceSize` mirror E142 `Layout/*` and are
    // therefore LAYOUT-frame; `bins` mirrors the 2DArray payload and is
    // MAP-frame (E142-0225 Table 12, "rotated to the coordinate system of the
    // SubstrateMap"). The grid is map-frame throughout, so the declared
    // dimension and physics need the `Orientation` swap undone - the payload does
    // not. normalizeGridData re-applies the swap on the way back in.
    const swap = mapFrameSwapsAxes(opts.orientation);
    const mapStepX = Math.hypot(placement.colStepXmm, placement.colStepYmm);
    const mapStepY = Math.hypot(placement.rowStepXmm, placement.rowStepYmm);
    const stepXmm = swap ? mapStepY : mapStepX;
    const stepYmm = swap ? mapStepX : mapStepY;
    const layoutCols = swap ? rows : cols;
    const layoutRows = swap ? cols : rows;
    // Drawn device extent. Omitted whole when either component is not a usable
    // measurement, which the contract reads as "defaults to stepSize".
    const deviceSize = swap
        ? positiveXY(placement.cellLmm, placement.cellWmm)
        : positiveXY(placement.cellWmm, placement.cellLmm);

    let mapType: E142MapType;
    let bins: string[] | GridDataCoordinateEntry[];
    if (opts.binType === 'Ascii') {
        mapType = '2DArray';
        const rowStrings: string[] = new Array(rows);
        for (let r = 0; r < rows; r++) {
            let s = '';
            for (let c = 0; c < cols; c++) {
                s += binTable[cells[r * cols + c]].code;
            }
            rowStrings[r] = s;
        }
        bins = rowStrings;
    } else {
        mapType = 'Coordinate';
        const entries: GridDataCoordinateEntry[] = [];
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

    const gd: GridData = {
        dimension: { x: layoutCols, y: layoutRows },
        units: 'mm',
        stepSize: { x: stepXmm, y: stepYmm },
        ...(deviceSize !== null ? { deviceSize } : {}),
        orientation: opts.orientation,
        originLocation: opts.originLocation,
        axisDirection: opts.axisDirection,
        binType: opts.binType,
        nullBin: nullToken,
        mapType,
        bins,
    };
    // Per-cell LIDs, if the grid carries any. Emitted in the same row-major,
    // full-length form readLids() accepts, with null for an unnamed cell - so a
    // document exported here re-imports to an identical map. Omitted entirely
    // when nothing is named, which is what `lids` being absent means.
    if (grid.lids !== undefined && grid.lids.size > 0) {
        const n = grid.cols * grid.rows;
        const arr: (string | null)[] = new Array(n);
        for (let i = 0; i < n; i++) {
            const v = grid.lids.get(i);
            arr[i] = v === undefined ? null : v;
        }
        gd.lids = arr;
    }
    if (opts.substrateId !== undefined && opts.substrateId !== null) {
        gd.substrateId = opts.substrateId;
    }
    // Substrate identity, same guards as the XML side: blank text is absent,
    // and goodDevices must survive `integer, minimum 0` or it is not a count.
    if (typeof opts.lotId === 'string' && opts.lotId.trim() !== '') {
        gd.lotId = opts.lotId;
    }
    if (typeof opts.goodDevices === 'number'
        && Number.isFinite(opts.goodDevices)
        && Number.isInteger(opts.goodDevices)
        && opts.goodDevices >= 0) {
        gd.goodDevices = opts.goodDevices;
    }
    if (opts.binDefinitions && opts.binDefinitions.length > 0) {
        gd.binDefinitions = opts.binDefinitions.map((d): GridDataBinDefinition => {
            const out: GridDataBinDefinition = { binCode: d.binCode };
            if (d.binQuality !== '') { out.binQuality = d.binQuality; }
            if (d.binDescription !== '') { out.binDescription = d.binDescription; }
            if (d.binCount !== undefined) { out.binCount = d.binCount; }
            if (d.pick) { out.pick = d.pick; }
            return out;
        });
    }
    return gd;
}

/* ------------------------------------------------------------------------ *
 * Global namespace bridge (classic consumers)
 *
 * Mirrors E142.ts, E142Xml.ts and Engine.ts exactly, per the S1 module
 * mechanism: the module is consumed as
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Grid.* after listing
 * E142Grid.js as an EsModule dependency file. First-wins (??=) assignments keep
 * the first definition if the file is ever evaluated twice. Like E142Xml - and
 * unlike E142Bins, which carries no bridge so that its emitted JS stays
 * standalone - this module already imports E142.js, whose own bridge touches
 * TcHmi, so a bridge here costs nothing that is not paid already; a node test
 * stubs the global either way.
 * ------------------------------------------------------------------------ */

declare const _E142GridErrorAlias: typeof E142GridError;
type _E142GridErrorInstance = E142GridError;
declare const _normalizeGridDataAlias: typeof normalizeGridData;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142Grid {
        /** Global (classic namespace) alias of the module export {@link E142GridError}. */
        let E142GridError: typeof _E142GridErrorAlias;
        /** Instance type of the global alias. */
        type E142GridError = _E142GridErrorInstance;
        /** Global alias of the module's entry point {@link normalizeGridData}. */
        let normalizeGridData: typeof _normalizeGridDataAlias;
    }
}

/**
 * Returns (creating on demand) the namespace object at `segments` below
 * `root`. First-wins on every level: existing objects are reused, never
 * replaced, so repeated evaluation cannot orphan earlier registrations.
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

// Idempotent registration guard: `??=` keeps the first definition if this file
// is ever evaluated twice (cannot happen through the module cache, but required
// for the classic fallback variant and free of cost here).
const e142GridNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142Grid');
e142GridNamespace['E142GridError'] ??= E142GridError;
e142GridNamespace['normalizeGridData'] ??= normalizeGridData;
