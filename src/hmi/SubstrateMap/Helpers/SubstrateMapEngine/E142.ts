/**
 * @fileoverview
 * E142 domain model and coordinate normalization - the pure, DOM-free slice of
 * the SubstrateMapEngine that turns a decoded SEMI E142 SubstrateMap into a
 * concrete, node-testable grid placement in the substrate frame S.
 *
 * Three-layer split (SubstrateMapEngine / SubstrateMapBase / concrete
 * controls): this module belongs to the ENGINE layer. It is a framework-free ES
 * module - no DOM, no Path2D/DOMMatrix, no TcHmi, no theme reads, no attributes,
 * no events. Colors/fonts and any host state arrive as resolved parameters
 * elsewhere; here everything is plain numbers so the placement math stays
 * portable and testable under node.
 *
 * SCOPE. This file owns the E142 TYPE model (mirroring the newest
 * V0125 XSD = E142-0225), UNIT resolution, LAYOUT-specifier resolution and the
 * geometric PLACEMENT of a rectangular cell grid. Out of scope by contract:
 * XML/JSON parsing, token decoding, rendering, attributes.
 *
 * WHERE THE GEOMETRIC RULES COME FROM. Every rule this module encodes was
 * checked against SEMI E142-0225 and SEMI E142.4-1022, and each one says in its
 * own JSDoc whether the standard settles it, the XSD declares it, or it is
 * inferred. The rules that govern placement, and what settles them:
 *
 *  - SERIALIZATION ORDER. MapType='Array' is "row major format starting at the
 *    top left", and BinCode/@Y starts "with the top row". Both are quoted.
 *  - 90/270 TRANSPOSE. For MapType='2DArray' the dimensions are "rotated to the
 *    coordinate system of the SubstrateMap"; Figure R2-11 shows it.
 *  - NON-QUADRANT ORIENTATIONS. Table A4-1 has NO Orientation column, so the
 *    logical frame is orientation-independent: rotation is physical only.
 *  - AXIS SIGNS AND THE ZERO CELL, including Center with an even dimension and
 *    the truncation rule. Table A4-1 settles all of it, and the normative test
 *    suite verifies every combination exhaustively.
 *  - Row/Column. Settled by the standard's own worked example.
 *  - BinCode/@Number is "derived from the length of the Values attribute";
 *    BinCode/@LID is "an alternative to x and y coordinates", and opaque.
 *  - LowerLeft is parent-relative, and an absent one means (0,0).
 *  - UNITS. DefaultUnits is normatively restricted to {um, mm}. Everything this
 *    module additionally accepts is deliberate tolerance for schema evolution,
 *    NOT a claim about the standard.
 *  - THE ORIENTATION DATUM. Orientation "increases in the right (clockwise)
 *    direction from 0", and Figure A1-2 puts the notch at 6/9/12/3 o'clock for
 *    Orientation 0/90/180/270. With the preset outline's notch pinned at 6
 *    o'clock that is exactly the counter-clockwise map rotation implemented
 *    here, which the normative suite checks.
 * Reference-device registration and the no-anchor centering fallback are the two
 * places where that check changed the implementation; see
 * registerPlacementToReferenceDevices and computeGridPlacement.
 *
 * MODULE MECHANISM: authored as an ES module and shared
 * through the module graph exactly like Engine.ts; the global bridge at the end
 * of this file additionally exposes the classic namespace name
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142 with first-wins (??=)
 * assignments.
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

// ===================================================================
//  Dev instrumentation - REMOVABLE BLOCK
//
//  Two counters on the engine's two entry points, so a harness can ask how
//  often a control parsed and how often it rebuilt a placement during one
//  attach. OFF by default, and enabled only by an explicit call - never from
//  an environment read, which a production bundle could trip over.
//
//  Plain totals, no labels, no call-site attribution: a harness that wants to
//  know WHICH setter caused a rebuild reads them either side of that setter
//  and diffs.
//
//  To remove: delete this block, the two count* call sites, and E142Xml's
//  import of countEngineParse.
// ===================================================================

/** Engine entry-point totals since the last {@link resetEngineCounters}. */
export interface E142EngineCounters {
    /** Entries into `parseE142Xml`, whether or not the parse then threw. */
    readonly parses: number;
    /** Entries into {@link computeGridPlacement}. */
    readonly placements: number;
}

/** Whether counting is on. `false` is the default and the shipped state. */
let countersOn = false;
/** Running parse total; meaningless while {@link countersOn} is false. */
let parseCount = 0;
/** Running placement total; meaningless while {@link countersOn} is false. */
let placementCount = 0;

/**
 * Turns counting on or off. Does not reset the totals.
 * @param on Whether to count.
 */
export function setEngineCountersEnabled(on: boolean): void { countersOn = on; }

/** @returns Whether counting is currently on. */
export function engineCountersEnabled(): boolean { return countersOn; }

/** Zeroes both totals. Leaves the enabled flag alone. */
export function resetEngineCounters(): void { parseCount = 0; placementCount = 0; }

/** @returns The totals since the last reset. */
export function readEngineCounters(): E142EngineCounters {
    return { parses: parseCount, placements: placementCount };
}

/** Counts one parse entry. No-op while counting is off. */
export function countEngineParse(): void { if (countersOn) { parseCount++; } }

/** Counts one placement build. No-op while counting is off. */
export function countEnginePlacement(): void { if (countersOn) { placementCount++; } }

// ===================================================================
//  Enums (V0125 XSD ground truth, = E142-0225)
// ===================================================================

/**
 * SubstrateType enumeration. V0125 (= E142-0225) extends the classic
 * Wafer/Frame/Strip/Tray set with TnR (tape and reel), Panel and PCB.
 * Declared by `SubstrateTypeEnum` in E142-1-V0125-Schema.xsd.
 */

import type { PvValue } from './E138Pv.js';
export type E142SubstrateType =
    | 'Wafer' | 'Frame' | 'Strip' | 'Tray' | 'TnR' | 'Panel' | 'PCB';

/**
 * A SubstrateType token AS IT APPEARED in the source document: either one of the
 * schema-enumerated {@link E142SubstrateType} values or, for schema-evolution
 * tolerance, any other string carried through verbatim.
 *
 * WHY THIS EXISTS. The enumeration has grown before: TnR, Panel and PCB arrived
 * in the XSD only with V0224, although the standard's prose had described them
 * since E142-0820 - roughly a four-year lag between prose and schema. A
 * strict enum would therefore have rejected legal-per-prose documents for four
 * years, and would reject the NEXT such token again. Input paths must instead
 * pass an unknown token through with a warning, which needs a type that can hold
 * it. `(string & {})` widens the union to any string WITHOUT collapsing the
 * literal members, so editors still complete the seven known values while an
 * exhaustive `switch` over them is correctly rejected as non-exhaustive - a
 * consumer must decide what to do with an unknown token instead of assuming
 * there is none.
 */
export type E142SubstrateTypeToken = E142SubstrateType | (string & {});

/** Side of the substrate the map applies to, per `SubstrateSideEnum`. */
export type E142SubstrateSide = 'TopSide' | 'BottomSide';

/**
 * OriginLocation: the visual cell that carries logical coordinate (0,0).
 * Declared by `OriginLocationEnum`; default LowerLeft.
 */
export type E142OriginLocation =
    | 'LowerLeft' | 'UpperLeft' | 'LowerRight' | 'UpperRight' | 'Center';

/**
 * AxisDirection: the sign convention of the logical X/Y axes. The first token
 * (Up/Down) is the Y direction and the second (Right/Left) the X direction.
 * That reading is inferred from the token names rather than stated outright, and
 * Table A4-1 bears it out. The enum values are the XSD's; default UpRight.
 */
export type E142AxisDirection = 'UpRight' | 'DownRight' | 'UpLeft' | 'DownLeft';

/**
 * BinType: the payload token encoding, per `BinTypeEnum`.
 */
export type E142BinType = 'Ascii' | 'Decimal' | 'HexaDecimal' | 'Integer2';

/**
 * MapType: the serialization form of the bin payload, per `MapTypeEnum`.
 * The XSD deliberately declares NO default; the standard's prose pins
 * the application-level default to '2DArray' (see {@link E142_DEFAULT_MAP_TYPE}).
 */
export type E142MapType = '2DArray' | 'Row/Column' | 'Array' | 'Coordinate';

/**
 * Application-level default MapType when the XML omits the attribute.
 * The V0125 XSD has no schema default for MapType; the standard's prose
 * documents that an omitted MapType is interpreted as '2DArray' by prose
 * convention, confirmed by the official BinCodeMap-Example.xml which omits the
 * attribute. That divergence is encoded here explicitly.
 */
export const E142_DEFAULT_MAP_TYPE: E142MapType = '2DArray';

// ===================================================================
//  Decoded payload (shared canonical form - reference, do NOT redefine)
// ===================================================================

/**
 * Canonical decoded bin payload, shared by the XML, JSON and E142.4 input
 * paths and consumed directly by buildGridModel. cells holds one entry per
 * lattice cell, row-major, cols*rows long; each entry is an index into
 * codes. Index 0 is reserved: codes[0] is the canonical NullBin token and
 * cells[i] === 0 means "null cell" (not present / not tested / outside the
 * substrate). codes[i>0] are the canonical bin tokens in first-seen order.
 * "Canonical" token: exactly the wire token for string payloads; for
 * numeric payloads the number formatted per BinType (Ascii: the single
 * character; Decimal: 3-digit zero-padded; HexaDecimal: 2 uppercase hex
 * digits; Integer2: 4 uppercase hex digits).
 * Index order: cells is row-major in SERIALIZATION order - cells[0] is the
 * first serialized token of the first serialized BinCode row. Per the
 * standard's prose the Array MapType serializes "row major starting at the
 * top left"; the mapping from serialization indices to logical E142 map
 * coordinates (which may be negative and depend on OriginLocation and
 * AxisDirection) is NOT this type's concern - the domain module provides
 * index<->map-coordinate conversion.
 */
export interface DecodedBinPayload {
    cols: number;
    rows: number;
    cells: Uint32Array;
    codes: string[];
    /**
     * Per-cell location identifiers, keyed by the SAME row-major linear index as
     * {@link cells} (`row * cols + col`). Absent when no cell carries a `LID`.
     *
     * A `Map`, not an array parallel to `cells`, because LIDs are sparse by
     * nature: a 600x600 map with three named pockets would otherwise carry
     * 359 997 nulls. Absent rather than empty when there are none, so a consumer
     * can branch on presence.
     *
     * Adopted BY REFERENCE, like `cells`.
     */
    lids?: ReadonlyMap<number, string>;
}

// ===================================================================
//  Document types (mirror the V0125 XSD; carry-only where noted)
// ===================================================================

/**
 * A physical (X,Y) pair with optional units string, mirroring
 * PhysicalCoordinatesType. Units, when present, is resolved via
 * {@link toMmFactor}; when absent the owning layout's DefaultUnits applies
 * Declared by the XSD.
 */
export interface E142PhysicalCoordinates {
    /** X value in `units` (or the layout DefaultUnits when `units` is absent). */
    x: number;
    /** Y value in `units` (or the layout DefaultUnits when `units` is absent). */
    y: number;
    /** Optional unit token; resolved by {@link toMmFactor}. */
    units?: string;
}

/**
 * A logical integer (X,Y) pair, mirroring LogicalCoordinatesType. Used for a
 * layout Dimension (cols=X, rows=Y) and for ReferenceDevice coordinates, both
 * expressed in the OriginLocation/AxisDirection logical frame. Declared by the XSD.
 */
export interface E142LogicalCoordinates {
    /** Logical X (for a Dimension: number of columns along the layout X axis). */
    x: number;
    /** Logical Y (for a Dimension: number of rows along the layout Y axis). */
    y: number;
}

/** Z-stack descriptor, mirroring `ZDimensionsType`. Carry-only for placement. */
export interface E142ZDimensions {
    /** Stacking order index. */
    order?: number;
    /** Physical height. */
    height?: number;
    /** Optional unit token. */
    units?: string;
}

/**
 * A layout node, mirroring LayoutType of the V0125 XSD. `dimension` is required
 * (cols=X, rows=Y); `lowerLeft`, `deviceSize`, `stepSize`, `z`, `productId` and
 * `childLayouts` are optional. `package` and `topLevel` are the boolean flags;
 * `defaultUnits` is required by the XSD.
 */
export interface E142Layout {
    /** Stable id, referenced by LayoutSpecifier path segments and ChildLayout. */
    layoutId: string;
    /** Logical grid extent: x = columns (Dimension.X), y = rows (Dimension.Y). */
    dimension: E142LogicalCoordinates;
    /** Optional physical anchor of the layout's lower-left corner. */
    lowerLeft?: E142PhysicalCoordinates;
    /** Optional physical device (drawn cell) size; deviceSize fallback = stepSize. */
    deviceSize?: E142PhysicalCoordinates;
    /** Optional physical full pitch (street included) per column (X) / row (Y). */
    stepSize?: E142PhysicalCoordinates;
    /** Optional Z-stack descriptor. */
    z?: E142ZDimensions;
    /** Package flag (functional package node). Carry-only for placement. */
    package: boolean;
    /** Top-level flag. Only a top-level layout is centered on the substrate. */
    topLevel: boolean;
    /** Required default units token for this layout's physical children. */
    defaultUnits: string;
    /**
     * `Layout/TopImage` - E142-0225 Table 2: "URI (refer to W3C RFC 2396 in
     * references for a definition of URI) of an image showing the top side of an
     * INDIVIDUAL DEVICE in the layout." Not a picture of
     * the substrate: it depicts one die, so a consumer tiling it across the grid
     * is doing something the standard describes, and one stretching it over the
     * wafer outline is not.
     *
     * Typed `xs:string` in the XSD, not `xs:anyURI`. The URI-ness
     * is a prose expectation the schema does not enforce, so this is carried
     * verbatim and never syntax-checked - validating it here would reject
     * documents `xmllint` accepts.
     *
     * CARRY-ONLY. Nothing in this package fetches or renders it.
     */
    topImage?: string;
    /**
     * `Layout/BottomImage` - the bottom-side twin of {@link E142Layout.topImage},
     * with the same type, the same carry-only contract and the same
     * individual-device semantics (Table 2).
     */
    bottomImage?: string;
    /** Optional product id. Carry-only. */
    productId?: string;
    /** Child layout ids (ChildLayout references), in document order. */
    childLayouts: string[];
}

/**
 * A substrate record, mirroring SubstrateType. Carry-only for placement; the
 * fields the engine cares about live on {@link E142SubstrateMapHeader}.
 */
/**
 * One `AliasIds/AliasId` entry, per `AliasIdType`.
 *
 * Both attributes are `use="required"`, so neither is optional here. E142-0225
 * Table 7 gives `Type` as the "type of identifier (e.g., 'FrontsideId',
 * 'BacksideId', 'WaferId', 'FrameId')" in E142-0225's own words - an open
 * vocabulary, not an enum, so it stays a plain string and unknown types are
 * carried rather than rejected.
 *
 * `Value` is `MaterialIdType`, which the XSD constrains to `maxLength 32`.
 * Table 7 states the range as "Text 1-32 characters", i.e. it also asserts a
 * MINIMUM of one - a bound the schema does not carry, since `MaterialIdType`
 * declares no `minLength`. An empty `Value` is therefore XSD-valid and
 * prose-invalid, the same shape of gap as the Table 2 `Dimension` rule. Nothing
 * enforces it here yet; whichever task starts parsing these should warn rather
 * than reject, in keeping with the parser's tolerance elsewhere.
 */
export interface E142AliasId {
    /** `AliasId/@Type` - open vocabulary (`FrontsideId`, `BacksideId`, ...). Required. */
    type: string;
    /** `AliasId/@Value` - `MaterialIdType`, maxLength 32 (Table 7: 1-32). Required. */
    value: string;
}

export interface E142Substrate {
    /** Substrate type; unknown tokens are carried through verbatim ({@link E142SubstrateTypeToken}). */
    substrateType: E142SubstrateTypeToken;
    /** Substrate id (MaterialIdType, maxLength 32). */
    substrateId: string;
    /**
     * Optional lot id (LotIdType, maxLength 80). Modeled because the XML input
     * path tolerates both the schema's child-element spelling and the observed
     * attribute dialect for it; carry-only for placement.
     */
    lotId?: string;
    /** Optional good-device count. */
    goodDevices?: number;
    /** Optional supplier name. */
    supplierName?: string;
    /** Optional free-form status. */
    status?: string;
    /**
     * Optional alias identifiers (`AliasIds/AliasId`, 1..n when the element is
     * present - `AliasIdType` is `maxOccurs="unbounded"` with no lower bound
     * stated, but `AliasIdsType` requires at least one child).
     */
    aliasIds?: E142AliasId[];
    /** Optional carrier type (`xs:string`, unconstrained). */
    carrierType?: string;
    /**
     * Optional carrier id. Typed `LotIdType` - maxLength **80**, not the 32 of
     * `MaterialIdType` that `SubstrateId` and `AliasId/@Value` carry. The two
     * id-like types are easy to conflate and the facets differ.
     */
    carrierId?: string;
    /** Optional slot number (`xs:nonNegativeInteger`, so zero is admissible). */
    slotNumber?: number;
    /** Optional substrate number (`xs:nonNegativeInteger`). */
    substrateNumber?: number;
}

/**
 * The header attributes of a SubstrateMap element, mirroring SubstrateMapType.
 * These are the placement-relevant inputs: which layout, which side, the
 * orientation and the logical-frame convention. Declared by the XSD.
 */
export interface E142SubstrateMapHeader {
    /** Substrate type (incl. TnR/Panel/PCB in V0125); unknown tokens pass through ({@link E142SubstrateTypeToken}). */
    substrateType: E142SubstrateTypeToken;
    /** Substrate id. */
    substrateId: string;
    /** LayoutSpecifier path (e.g. "Top/Child"); may dangle / be absent (layoutless). */
    layoutSpecifier: string;
    /** Which side the map applies to; default TopSide. */
    substrateSide: E142SubstrateSide;
    /** Rotation of the substrate relative to the map data, CW-positive, 0-359. */
    orientation: number;
    /** Visual cell carrying logical (0,0); default LowerLeft. */
    originLocation: E142OriginLocation;
    /** Logical axis sign convention; default UpRight. */
    axisDirection: E142AxisDirection;
}

/**
 * A ReferenceDevice: a named anchor device in the logical frame.
 * Reference devices are CARRIED ALONG, never folded into the
 * placement math. The XSD gives the shape; that the coordinates are logical
 * rather than physical is inferred from the frame attributes.
 */
export interface E142ReferenceDevice {
    /** Optional name. */
    name?: string;
    /** Logical coordinates in the OriginLocation/AxisDirection frame. */
    coordinates: E142LogicalCoordinates;
    /** Optional physical position. */
    position?: E142PhysicalCoordinates;
}

/**
 * A single BinDefinition, mirroring BinDefinitionType. `binQuality` is a free
 * string (per the XSD it is xs:string, not an enum).
 */
export interface E142BinDefinition {
    /** The bin code token this definition describes. */
    binCode: string;
    /** Free-form quality string (xs:string in the XSD, NOT an enum). */
    binQuality: string;
    /** Human-readable description. */
    binDescription: string;
    /** Optional running count. */
    binCount?: number;
    /** Whether devices of this bin are picked. */
    pick: boolean;
}

/**
 * Header metadata of a BinCodeMap, mirroring BinCodeMapType attributes.
 * `mapType` is optional in the XSD; callers should fall back to
 * {@link E142_DEFAULT_MAP_TYPE} when it is undefined.
 */
export interface E142BinCodeMapMeta {
    /** Token encoding. */
    binType: E142BinType;
    /** The null-cell token (required by the XSD). */
    nullBin: string;
    /**
     * Serialization form; may be undefined (XSD has no default). Resolve an
     * undefined value to {@link E142_DEFAULT_MAP_TYPE} ('2DArray'), per the standard's prose.
     */
    mapType?: E142MapType;
}

/**
 * A pre-decode sparse BinCode entry, retained ONLY to model the LID-bearing
 * Coordinate form. The typed-array {@link DecodedBinPayload} cannot carry a LID,
 * so LID-only entries (no X/Y) never reach a grid; they are carried here and
 * excluded from grids with one aggregated warning.
 */
export interface E142SparseBinCode {
    /** Logical X, if present. Absent for a LID-only entry. */
    x?: number;
    /** Logical Y, if present. Absent for a LID-only entry. */
    y?: number;
    /** Opaque logical id (V0125); no intra-document resolution is assumed. */
    lid?: string;
    /** Optional informational sequence number; IGNORED for placement. */
    number?: number;
    /** The single bin token for this device. */
    code: string;
}

/**
 * One `<Id>` entry of a `DeviceIdMap` overlay (`DeviceIdType`): the device
 * identifier string plus an OPTIONAL address, exactly parallel to the sparse
 * {@link E142SparseBinCode} but naming a device ID instead of a bin token and
 * carrying no `Number`. All three address attributes are `use="optional"` in
 * the XSD, so an entry may address a cell by X/Y, by LID, or by neither.
 *
 * FRAME: `x`/`y`, when present, are LOGICAL coordinates in the OriginLocation x
 * AxisDirection frame - the same frame as `ReferenceDevice/Coordinates` and a
 * `Coordinate` BinCode. `lid` is the opaque V0125 logical id, for which the
 * standard defines no coordinate resolution. Identical to
 * the sparse-BinCode falsifiers; DeviceIdMap reuses their frame verbatim.
 */
export interface E142DeviceIdEntry {
    /** Logical X, if present. Absent for a LID-only or address-less entry. */
    x?: number;
    /** Logical Y, if present. Absent for a LID-only or address-less entry. */
    y?: number;
    /** Opaque logical id (V0125); no intra-document resolution is assumed. */
    lid?: string;
    /** The device identifier string (the `<Id>` element's text content). */
    deviceId: string;
}

/**
 * One `<Parameter>` of a `DeviceDataMap`: what a value at the same position MEANS.
 *
 * The parameter list is the schema for the values. 13.10.2.1: a `Parameter` names
 * "a processing condition or raw material identifier used in the assembly, for
 * example the epoxy lot identifier or the bond force applied at die attach."

 *
 * PROSE vs SCHEMA - `@Name`. Table 18 marks it **required** (Reqd = Y), but
 * `ParameterType` declares `<xs:attribute name="Name" type="xs:string"/>` with
 * **no `use=`**, and the XSD default is `optional`. So `xmllint`
 * accepts a nameless `<Parameter/>` that the prose forbids. Modeled as a
 * non-optional `string` because a parameter without a name is useless to a
 * reader; the parser reports an absent one and carries `''` rather than refusing
 * a document the schema accepts.
 */
export interface E142Parameter {
    /** `@Name` - see the note above on why this is not optional here. */
    name: string;
    /** `@Description` - `use="optional"` in both prose and schema. */
    description?: string;
}

/**
 * One `<DeviceData>`: a position, and the parameter values that apply there.
 *
 * ADDRESSED LIKE EVERY OTHER PER-DEVICE RECORD - `@X`/`@Y`, `@LID`, or both, all
 * three `use="optional"` in the XSD, exactly as on `BinCodeType` and
 * `DeviceIdType`. 13.3's "either the X and Y coordinate, or the location
 * identifier, or both" governs here too, so this joins to a cell by the same rule
 * the other two use: name first, then coordinate.
 *
 * `X`/`Y` are read in the map's own frame - Table 19: "with the substrate
 * oriented, according to the values of SubstrateMap coordinate attributes;
 * SubstrateSide, Orientation, OriginLocation, and AxisDirection"
 * - which is what `mapCoordToIndex` already implements.
 */
export interface E142DeviceData {
    /** `@X` - logical X, when this record is addressed by coordinate. */
    x?: number;
    /** `@Y` - logical Y. */
    y?: number;
    /** `@LID` - location identifier, when addressed by name. Opaque; never normalized. */
    lid?: string;
    /**
     * The `ccs:PVSet` payload, in document order.
     *
     * ORDER IS NORMATIVE AND IT IS THE ONLY LINK TO MEANING. Table 19: "The order
     * of values **shall** match the order of parameters listed in the
     * DeviceDataMap's Parameter attribute." A `shall`,
     * and the values carry no names of their own - `values[i]` means
     * `parameters[i]`, and nothing else says so.
     *
     * The consequence is sharp: a value dropped or reordered anywhere in the set
     * does not lose ONE reading, it silently re-labels every reading after it.
     * That is why `parsePvSet` reports rather than skips, and why a count
     * mismatch against `parameters` has to be reported too.
     *
     * `DeviceDataType` declares exactly one `ccs:PVSet` (`minOccurs="1"`, and
     * `maxOccurs` defaults to 1), so these are that one set's values - not a
     * concatenation.
     */
    values: PvValue[];
}

/**
 * A `<DeviceDataMap>` overlay: the parameter list, and one record per device.
 *
 * Both children are `minOccurs="1" maxOccurs="unbounded"` in the XSD - a map
 * with no parameters, or with no device data, is schema-invalid.
 */
export interface E142DeviceDataMap {
    /** `<Parameter>` elements, in document order. At least one. This IS the schema for {@link E142DeviceData.values}. */
    parameters: E142Parameter[];
    /** `<DeviceData>` elements, in document order. At least one. */
    deviceData: E142DeviceData[];
}

/**
 * One `<T>` element of a `TransferMap`: a single device moving from one place to
 * another.
 *
 * THE ELEMENT IS `<T>`, NOT `<Transfer>`. `TransferMapType` declares
 * `<xs:element name="T" type="sm:TransferType" maxOccurs="unbounded"/>`
 * in the XSD. The TYPE is `TransferType` and E142-0225's figures label the
 * arrows `Transfer(...)`, so `<Transfer>` is the natural guess and it is wrong -
 * a parser looking for it finds nothing and reports an empty map rather than
 * failing, which is the worst kind of wrong.
 *
 * EVERY FIELD IS OPTIONAL AND NONE IS COUPLED IN THE XSD. That is not
 * sloppiness: each END of a transfer is independently addressed, by a coordinate
 * pair OR by an identifier. Figure R2-22 exercises exactly the mixed case -
 * `Transfer(FX,FY,TID)` moves a device from wafer coordinates into a named tape
 * pocket, then `Transfer(FID,TX,TY)` moves it from that pocket to target
 * coordinates. See `ws/notes/DECISION-lid.md` §4a.
 *
 * `fid` / `tid` are the transfer-scope siblings of `LID`: `xs:string`, opaque,
 * unordered, not unique by declaration, and never normalized.
 */
export interface E142Transfer {
    /** `@FX` - source logical X. Absent when the source end is addressed by `fid`. */
    fx?: number;
    /** `@FY` - source logical Y. */
    fy?: number;
    /** `@FID` - source location identifier (`xs:string`, opaque). */
    fid?: string;
    /** `@TX` - destination logical X. Absent when the destination end is addressed by `tid`. */
    tx?: number;
    /** `@TY` - destination logical Y. */
    ty?: number;
    /** `@TID` - destination location identifier (`xs:string`, opaque). */
    tid?: string;
}

/**
 * One `<TransferMap>`: where a batch of devices came FROM, plus the per-device
 * moves.
 *
 * The source substrate is named ONCE on the map - three required attributes
 * in the XSD - and the individual `<T>` elements carry only endpoints. So a
 * chain is walked back by following {@link E142TransferMap.fromSubstrateId}, not
 * by matching device ids.
 *
 * THE THREE `From*` ATTRIBUTES ARE AN INTRA-DOCUMENT REFERENCE. The XSD declares
 * `<xs:keyref name="FromSubstrateMapRef" refer="sm:SubstrateMapKey">` over
 * exactly this triple, so they must match a `SubstrateMap`
 * PRESENT IN THE SAME FILE - `xmllint` rejects a document whose `TransferMap`
 * points at a substrate that is not there (verified). A `TransferMap` is
 * therefore not a free-floating provenance record; it is a link, and what it
 * links to has to travel with it.
 *
 * `fromSubstrateType` is `string`, not the enum. `SubstrateTypeEnum` constrains
 * it, but this parser tolerates an unrecognized token with a warning rather than
 * rejecting the document - as it already does for `SubstrateMap/@SubstrateType`
 * - and the model has to be able to hold what the parser accepts.
 */
export interface E142TransferMap {
    /** `@FromSubstrateType` - required. A token; see the note above on why not the enum. */
    fromSubstrateType: string;
    /** `@FromSubstrateId` - required (`MaterialIdType`, maxLength 32). */
    fromSubstrateId: string;
    /** `@FromSubstrateLayoutSpecifier` - required; may legitimately be the empty string. */
    fromLayoutSpecifier: string;
    /** The `<T>` elements, in document order. `maxOccurs="unbounded"`, at least one. */
    transfers: E142Transfer[];
}

/**
 * An Overlay, mirroring OverlayType. Only the fields the engine consumes are
 * modeled; the choice between BinCodeMap / DeviceIdMap / TransferMap /
 * DeviceDataMap is represented by the optional payload fields.
 */
export interface E142Overlay {
    /** Overlay name. */
    mapName: string;
    /** Overlay version; default "". */
    mapVersion: string;
    /** Reference devices, carried along; used by the opt-in registration step. */
    referenceDevices: E142ReferenceDevice[];
    /** BinCodeMap metadata, when this overlay is a BinCodeMap. */
    binCodeMapMeta?: E142BinCodeMapMeta;
    /** BinDefinitions, when present. */
    binDefinitions?: E142BinDefinition[];
    /** Pre-decode sparse entries, when the payload is a Coordinate form. */
    sparseBinCodes?: E142SparseBinCode[];
    /** The canonical decoded payload, when available (Array/2DArray/Row-Column). */
    payload?: DecodedBinPayload;
    /**
     * The `<Id>` entries, when this overlay is a `DeviceIdMap`. Absent for every
     * other overlay kind.
     *
     * Read as the cell -> device-id lookup that `onItemSelected` reports as
     * `deviceId`. Each entry is joined to a cell by its location identifier first
     * and its X/Y coordinate second.
     */
    deviceIdEntries?: E142DeviceIdEntry[];
    /**
     * The `TransferMap` elements of this overlay, in document order.
     *
     * AN ARRAY, not a single value, because `OverlayType` declares
     * `<xs:element name="TransferMap" ... maxOccurs="unbounded"/>` inside its
     * `xs:choice`. One overlay may legitimately carry several -
     * and it must, whenever a substrate received devices from more than one
     * source, since the source is named per MAP rather than per transfer. A
     * consolidation step (E142-0225 14.4 is defined for a whole lot or carrier)
     * produces exactly that shape. Verified with `xmllint`: a two-`TransferMap`
     * overlay validates.
     *
     * Absent when this overlay carries none. The `xs:choice` means an overlay
     * with transfers has no `BinCodeMap` and so nothing to render.
     */
    transferMaps?: E142TransferMap[];
    /**
     * The `DeviceDataMap` elements of this overlay, in document order.
     *
     * AN ARRAY, for the same reason {@link E142Overlay.transferMaps} is:
     * `OverlayType` declares `<xs:element name="DeviceDataMap" ...
     * maxOccurs="unbounded"/>` inside its `xs:choice`. Modeling it singular
     * would contradict the schema, and one overlay may
     * legitimately carry several - one parameter set per process step, say, each
     * with its own values.
     *
     * Absent when this overlay carries none. The `xs:choice` means an overlay
     * with device data has no `BinCodeMap` and nothing to render.
     */
    deviceDataMaps?: E142DeviceDataMap[];
}

/**
 * The whole decoded document, mirroring MapDataType: the three optional
 * top-level collections. This is the input to {@link resolveLayoutSpecifier}.
 * as the XSD declares.
 */
export interface E142Document {
    /** Layouts by id (may be empty - the official example is layoutless). */
    layouts: E142Layout[];
    /** Substrate records (carry-only). */
    substrates: E142Substrate[];
    /** Substrate map headers + overlays. */
    substrateMaps: Array<{ header: E142SubstrateMapHeader; overlays: E142Overlay[] }>;
    /**
     * Provenance, XML input path only:
     * the document element's namespace, e.g.
     * 'urn:semi-org:xsd.E142-1.V0125.SubstrateMap'. Absent for the JSON and
     * E142.4 paths, which carry no namespace. Carry-only: no rule in this
     * module branches on it, because the E142.1 data model is byte-identical
     * across every inspected revision for everything this engine reads.
     */
    namespaceUri?: string;
    /**
     * Provenance, XML input path only: the schema-version token lifted out of
     * {@link namespaceUri}, e.g. 'V0125' (= E142-0225). Absent for the JSON and
     * E142.4 paths. Carry-only, as above.
     */
    schemaVersion?: string;
}

// ===================================================================
//  Diagnostics
// ===================================================================

/**
 * A non-fatal diagnostic produced by the pure functions in this module.
 * Framework-free: the engine surfaces these to callers, which decide how to log
 * them (never console/DOM here).
 */
export interface E142Warning {
    /** Stable machine code for the warning. */
    code: string;
    /** Human-readable message. */
    message: string;
}

/**
 * A typed error returned (never thrown) by the pure functions, so callers can
 * branch without try/catch and the module stays exception-free by contract.
 */
export class E142Error extends Error {
    /** Stable machine code for the error. */
    public readonly code: string;
    /**
     * @param code    Stable machine code.
     * @param message Human-readable message.
     */
    public constructor(code: string, message: string) {
        super(message);
        this.name = 'E142Error';
        this.code = code;
    }
}

// ===================================================================
//  Units
// ===================================================================

/** Millimeters per micrometer. */
const MM_PER_UM = 0.001;
/** Millimeters per mil (thousandth of an inch): 25.4 / 1000. */
const MM_PER_MIL = 25.4 / 1000;

/**
 * The result of {@link toMmFactor}: the multiplicative factor to millimeters,
 * plus an optional warning when a tolerated (non-normative) spelling was used.
 */
export interface ToMmFactorResult {
    /** Multiplicative factor: value_mm = value * factorMm. */
    factorMm: number;
    /** A warning when a tolerated, non-normative unit spelling was accepted. */
    warning?: E142Warning;
}

/**
 * Resolves a units string to a multiplicative factor to millimeters.
 *
 * Normative, and quoted from the standard: 'mm' -> 1, 'um' -> 0.001.
 * Tolerated WITH WARNING. 'microns' is observed in SEMI's own appendix example,
 * so it is well supported; the /(\d+)Microns/ multiplier pattern and 'mil' are
 * not, and are accepted only as schema-evolution tolerance:
 *   'microns' -> um; /^(\d+)Microns$/ -> n x um; 'mil' -> 25.4/1000 mm.
 * Anything else -> a typed {@link E142Error} (never thrown; returned).
 *
 * Used by layout resolution and by the GridData path.
 *
 * @param units The raw units token (already trimmed by the caller if desired).
 * @returns A {@link ToMmFactorResult}, or an {@link E142Error} for an unknown unit.
 */
export function toMmFactor(units: string): ToMmFactorResult | E142Error {
    switch (units) {
        case 'mm':
            return { factorMm: 1 };
        case 'um':
            return { factorMm: MM_PER_UM };
        case 'microns':
            return {
                factorMm: MM_PER_UM,
                warning: {
                    code: 'E142_UNIT_TOLERATED',
                    message: "Non-normative unit 'microns' accepted as 'um'.",
                },
            };
        case 'mil':
            return {
                factorMm: MM_PER_MIL,
                warning: {
                    code: 'E142_UNIT_TOLERATED',
                    message: "Non-normative unit 'mil' accepted as 25.4/1000 mm.",
                },
            };
        default: {
            const m = /^(\d+)Microns$/.exec(units);
            if (m) {
                const n = Number(m[1]);
                return {
                    factorMm: n * MM_PER_UM,
                    warning: {
                        code: 'E142_UNIT_TOLERATED',
                        message: `Non-normative unit '${units}' accepted as ${n} x um.`,
                    },
                };
            }
            return new E142Error(
                'E142_UNIT_UNKNOWN',
                `Unknown units '${units}'; the normative units are 'mm' and 'um'.`,
            );
        }
    }
}

// ===================================================================
//  Layout resolution
// ===================================================================

/**
 * The outcome of {@link resolveLayoutSpecifier}. `flavor` distinguishes a
 * fully resolved layout from the LAYOUTLESS case (a dangling or absent
 * LayoutSpecifier - explicitly NOT an error; the official SEMI example has no
 * keyref for LayoutSpecifier). A layoutless result carries cols/rows only,
 * derived from the payload via {@link dimsFromPayload}.
 */
export interface ResolvedLayout {
    /** 'resolved' = walked the layout tree; 'layoutless' = cols/rows only. */
    flavor: 'resolved' | 'layoutless';
    /** Logical grid columns (layout Dimension.X before any orientation swap). */
    cols: number;
    /** Logical grid rows (layout Dimension.Y before any orientation swap). */
    rows: number;
    /** Column full pitch in mm (StepSize.X), if resolvable. */
    stepXmm?: number;
    /** Row full pitch in mm (StepSize.Y), if resolvable. */
    stepYmm?: number;
    /** Drawn cell width in mm (DeviceSize.X), if resolvable. */
    cellWmm?: number;
    /** Drawn cell length in mm (DeviceSize.Y), if resolvable. */
    cellLmm?: number;
    /**
     * Accumulated lower-left anchor in mm, in the SUBSTRATE frame, if any
     * LowerLeft offsets were present along the path. They are parent-relative.
     */
    anchorLowerLeftMm?: { x: number; y: number };
    /**
     * Millimeters per unit of the target layout's DefaultUnits ({@link toMmFactor}
     * of `current.defaultUnits`), so a caller can resolve a physical value that
     * omits its own `Units` - the opt-in reference-device registration uses it for
     * a `Position` without a `Units` attribute. Absent for the layoutless path
     * (no layout, hence no DefaultUnits) or an unresolvable unit.
     */
    unitsToMm?: number;
    /** Non-fatal diagnostics gathered while resolving. */
    warnings: E142Warning[];
}

/**
 * A finite, strictly positive X/Y pair, or `null` when either component fails.
 *
 * The shared guard for every physical extent the serializers emit - E142
 * `DeviceSize` in {@link gridToE142Xml} and `deviceSize` in
 * {@link gridToGridData}. It lives here rather than in either serializer
 * because `E142Xml` and `E142Grid` are peers that deliberately do not import
 * each other; `E142` is the module they both already depend on and it imports
 * nothing, so there is no cycle to create.
 *
 * Zero is rejected alongside NaN and Infinity. A zero-extent device is not a
 * measurement, it is a missing one, and E142-0225 Table 2 gives absence a
 * defined meaning - "If not present, then DeviceSize is not defined"
 * - that a zero would misrepresent as a real reading.
 *
 * The pair is all-or-nothing because the elements it guards are: E142
 * `XYDimensions` declares X and Y `use="required"`, so a
 * half-known extent cannot be expressed and must be omitted whole.
 *
 * @param x The X component, or `undefined`.
 * @param y The Y component, or `undefined`.
 * @returns The pair when both are finite and `> 0`; otherwise `null`.
 */
export function positiveXY(
    x: number | undefined,
    y: number | undefined,
): { x: number; y: number } | null {
    if (typeof x !== 'number' || typeof y !== 'number') { return null; }
    if (!Number.isFinite(x) || !Number.isFinite(y)) { return null; }
    if (x <= 0 || y <= 0) { return null; }
    return { x, y };
}

/**
 * Derives grid dimensions from a decoded payload alone. Used for the LAYOUTLESS
 * case where no layout tree exists to walk (the official SEMI example). The
 * payload's cols/rows are the SERIALIZED extents (visual map view); no pitch is
 * available, so physical scale falls to the fit heuristic ({@link fitPlacementToBox}).
 * @param payload The decoded payload.
 * @returns A layoutless {@link ResolvedLayout} carrying cols/rows only.
 */
/** Which `SubstrateMap` and which `Overlay` a caller wants rendered. */
export interface E142SelectionFilters {
    /** `SubstrateMap/@SubstrateId`; `null` does not filter. */
    substrateId: string | null;
    /** `SubstrateMap/@LayoutSpecifier`; `null` does not filter. */
    layoutSpecifier: string | null;
    /** `Overlay/@MapName`; `null` selects the first renderable overlay. */
    overlayName: string | null;
    /**
     * `Overlay/@MapVersion`; `null` does not filter by version. `""` is NOT
     * "don't care" - it selects overlays whose `MapVersion` is empty, which is
     * a real addressable overlay because the attribute defaults to `""`.
     */
    overlayVersion: string | null;
}

/** What {@link selectMapAndOverlay} decided. */
export interface E142Selection {
    /** The chosen map's header, or `null` when nothing was selected. */
    header: E142SubstrateMapHeader | null;
    /** The chosen overlay, or `null`. */
    overlay: E142Overlay | null;
    /** A human-readable reason nothing was selected, or `null` on success. */
    error: string | null;
    /** Ambiguity notices; empty when the choice was unambiguous. */
    warnings: string[];
}

/** `(SubstrateType, SubstrateId, LayoutSpecifier)` - the `SubstrateMapKey` fields. */
function selectionTriple(h: E142SubstrateMapHeader): string {
    return '(' + String(h.substrateType) + ', ' + (h.substrateId ?? '') + ', ' + h.layoutSpecifier + ')';
}

/** `''` shown as `(none)`, so an empty MapVersion is legible in a message. */
function shownVersion(v: string): string {
    return v === '' ? '(none)' : "'" + v + "'";
}

/**
 * Chooses the `SubstrateMap` and `Overlay` to render from a parsed document.
 *
 * PURE, and deliberately here rather than in the control. Selection depends on
 * nothing but the document and four strings, and the control cannot be
 * instantiated without a DOM - so leaving it in a control method would mean the
 * only way to test it is to transcribe it into the test, which tests the
 * transcription. `tests/e142-selection.test.mjs` calls this.
 *
 * SUBSTRATE FILTERS RUN FIRST. A document may legitimately carry many
 * substrates - E142-0225 14.3 MapUpload is defined for "one or more substrates"
 * and 14.4 MapGroupDownload for a lot or carrier - and searching overlays across
 * all of them discards the rest silently.
 *
 * The two keys behave differently, and the difference is normative:
 * - `SubstrateMapKey` is an `xs:key` over (`@SubstrateType`, `@SubstrateId`,
 *   `@LayoutSpecifier`), so BOTH substrate filters set means at
 *   most one survivor in a schema-valid document. Ambiguity is only possible
 *   when one is left unset.
 * - `OverlayKey` is (`@MapName`, `@MapVersion`), so a name alone is genuinely
 *   ambiguous - E142-0225 R2-1.2.1's lifecycle downloads at `MapVersion=1` and
 *   uploads the result at `2`, both under one name.
 *
 * Ambiguity WARNS and renders the first in document order; it is never an error,
 * because a document carrying several maps is perfectly legal. A filter that
 * matches nothing IS an error, and the message lists what is actually available:
 * an operator who mistyped a wafer id needs the list, not the word "not found".
 *
 * @param doc     The parsed document.
 * @param filters Which map and overlay to select.
 * @returns The choice, or an error with nothing selected.
 */
export function selectMapAndOverlay(doc: E142Document, filters: E142SelectionFilters): E142Selection {
    const warnings: string[] = [];
    const fail = (error: string): E142Selection => ({ header: null, overlay: null, error, warnings });

    const candidates = doc.substrateMaps.filter(
        (sm) => (filters.substrateId === null || sm.header.substrateId === filters.substrateId)
            && (filters.layoutSpecifier === null || sm.header.layoutSpecifier === filters.layoutSpecifier),
    );
    if (candidates.length === 0) {
        const named = [
            filters.substrateId === null ? null : "E142SubstrateId '" + filters.substrateId + "'",
            filters.layoutSpecifier === null ? null : "E142LayoutSpecifier '" + filters.layoutSpecifier + "'",
        ].filter((x) => x !== null).join(' and ');
        return fail(
            'no SubstrateMap matches ' + named + '. The document carries ' + doc.substrateMaps.length
            + ': ' + doc.substrateMaps.map((sm) => selectionTriple(sm.header)).join(', '),
        );
    }

    // Half a key is not a selector. Refused before any scanning, so the message
    // names the mistake rather than reporting whatever it failed to find.
    if (filters.overlayName === null && filters.overlayVersion !== null) {
        return fail(
            "E142OverlayVersion '" + filters.overlayVersion + "' was set without an E142OverlayName. "
            + 'An overlay is identified by the pair (MapName, MapVersion); a version alone is not an '
            + 'identity. Set E142OverlayName as well, or clear the version.',
        );
    }

    let header: E142SubstrateMapHeader | null = null;
    let overlay: E142Overlay | null = null;
    let chosenSm: { header: E142SubstrateMapHeader; overlays: E142Overlay[] } | null = null;
    let sawName = false;
    /**
     * Every version carried under the wanted name, across the WHOLE candidate
     * set. Counting only up to the chosen overlay would stop at the first match
     * and never see a second version, so the ambiguity warning could never fire.
     */
    const versionsSeen: string[] = [];
    for (const sm of candidates) {
        for (const ov of sm.overlays) {
            const renderable = ov.payload !== undefined;
            if (filters.overlayName === null) {
                if (renderable && overlay === null) { header = sm.header; overlay = ov; chosenSm = sm; }
                continue;
            }
            if (ov.mapName !== filters.overlayName) { continue; }
            sawName = true;
            versionsSeen.push(ov.mapVersion);
            if (filters.overlayVersion !== null && ov.mapVersion !== filters.overlayVersion) { continue; }
            if (renderable && overlay === null) { header = sm.header; overlay = ov; chosenSm = sm; }
        }
        if (filters.overlayName === null && overlay !== null) { break; }
    }

    if (header === null || overlay === null || overlay.payload === undefined) {
        return fail(
            filters.overlayName === null
                ? 'no renderable BinCodeMap overlay in the E142 document'
                : filters.overlayVersion !== null && sawName
                    ? "no overlay '" + filters.overlayName + "' at MapVersion "
                        + shownVersion(filters.overlayVersion)
                        + ' in the E142 document; versions present under that name: '
                        + versionsSeen.map(shownVersion).join(', ')
                    : sawName
                        ? "overlay '" + filters.overlayName + "' is not a BinCodeMap (nothing to render)"
                        : "no overlay named '" + filters.overlayName + "' in the E142 document",
        );
    }

    if (candidates.length > 1 && chosenSm !== null) {
        warnings.push(
            candidates.length + ' SubstrateMaps match the current filters ('
            + candidates.map((sm) => selectionTriple(sm.header)).join(', ') + '); rendered '
            + selectionTriple(chosenSm.header) + ' because it comes first in document order. '
            + 'Set E142SubstrateId and E142LayoutSpecifier to choose.',
        );
    }
    if (filters.overlayName !== null && filters.overlayVersion === null && versionsSeen.length > 1) {
        warnings.push(
            "overlay '" + filters.overlayName + "' is carried at " + versionsSeen.length + ' versions ('
            + versionsSeen.map(shownVersion).join(', ') + '); rendered ' + shownVersion(overlay.mapVersion)
            + ' because it comes first in document order. Set E142OverlayVersion to choose.',
        );
    }
    return { header, overlay, error: null, warnings };
}

export function dimsFromPayload(payload: DecodedBinPayload): ResolvedLayout {
    return {
        flavor: 'layoutless',
        cols: payload.cols,
        rows: payload.rows,
        warnings: [],
    };
}

/**
 * Resolves a physical coordinate pair to millimeters, honoring an explicit
 * `units` on the pair, else the layout's DefaultUnits.
 * Collects a warning for tolerated spellings; on an unknown unit returns the
 * error so the caller can decide.
 */
function physToMm(
    p: E142PhysicalCoordinates,
    defaultUnits: string,
    warnings: E142Warning[],
): { x: number; y: number } | E142Error {
    const units = (p.units !== undefined && p.units !== '') ? p.units : defaultUnits;
    const f = toMmFactor(units);
    if (f instanceof E142Error) {
        return f;
    }
    if (f.warning) {
        warnings.push(f.warning);
    }
    return { x: p.x * f.factorMm, y: p.y * f.factorMm };
}

/**
 * Resolves a LayoutSpecifier by walking the 'Top/Child' path through the
 * document's layouts, accumulating child-layout LowerLeft
 * offsets in the PARENT layout's frame (inferred, and weakly evidenced:
 * parent-relative accumulation - quarantined here behind this function).
 *
 * The resolved dims/pitch/cell come from the DEEPEST (target) layout on the
 * path. StepSize gives the full pitch; DeviceSize (when present) gives the
 * drawn cell extent; if DeviceSize is absent it is left undefined here and the
 * placement uses stepSize as the cell extent (deviceSize fallback = stepSize).
 *
 * CRITICAL: a DANGLING or ABSENT LayoutSpecifier is NOT an
 * error - the official SEMI BinCodeMap-Example.xml is layoutless (no keyref for
 * LayoutSpecifier exists). In that case the caller should fall back to
 * {@link dimsFromPayload}. This function signals that by returning `null` (no
 * error, no throw) when the head segment cannot be found, so the caller can
 * choose the layoutless path with the payload in hand.
 *
 * UNVERIFIED: the parent-relative accumulation of `LowerLeft` and the top-level
 * centering convention are inferred; no public source states either in words.
 *
 * @param doc       The decoded document.
 * @param specifier The LayoutSpecifier path, e.g. "WaferLayout/Devices".
 * @returns A resolved {@link ResolvedLayout}; an {@link E142Error} for a
 *          broken path / bad units; or `null` when the specifier is absent or
 *          its head layout does not exist (=> caller uses the layoutless path).
 */
export function resolveLayoutSpecifier(
    doc: E142Document,
    specifier: string,
): ResolvedLayout | E142Error | null {
    const warnings: E142Warning[] = [];
    const path = specifier.split('/').map((s) => s.trim()).filter((s) => s.length > 0);
    if (path.length === 0) {
        return null; // absent specifier -> layoutless
    }
    const byId = new Map<string, E142Layout>();
    for (const l of doc.layouts) {
        byId.set(l.layoutId, l);
    }
    const head = byId.get(path[0]);
    if (head === undefined) {
        return null; // dangling head -> layoutless (official example)
    }

    let current: E142Layout = head;
    // The top-level layout's own LowerLeft anchors it relative to the substrate
    // center; child LowerLeft offsets are parent-relative and
    // accumulate down the path. Both readings are inferred, not stated.
    let anchor: { x: number; y: number } | undefined;
    if (current.lowerLeft) {
        const mm = physToMm(current.lowerLeft, current.defaultUnits, warnings);
        if (mm instanceof E142Error) {
            return mm;
        }
        anchor = mm;
    }

    for (let i = 1; i < path.length; i++) {
        const nextId = path[i];
        if (!current.childLayouts.includes(nextId)) {
            return new E142Error(
                'E142_LAYOUT_PATH_BROKEN',
                `LayoutSpecifier segment '${nextId}' is not a child of '${current.layoutId}'.`,
            );
        }
        const child = byId.get(nextId);
        if (child === undefined) {
            return new E142Error(
                'E142_LAYOUT_MISSING',
                `LayoutSpecifier references layout '${nextId}' which is not defined.`,
            );
        }
        if (child.lowerLeft) {
            const mm = physToMm(child.lowerLeft, child.defaultUnits, warnings);
            if (mm instanceof E142Error) {
                return mm;
            }
            anchor = { x: (anchor?.x ?? 0) + mm.x, y: (anchor?.y ?? 0) + mm.y };
        }
        current = child;
    }

    const out: ResolvedLayout = {
        flavor: 'resolved',
        cols: current.dimension.x,
        rows: current.dimension.y,
        warnings,
    };
    // Expose the target layout's DefaultUnits factor for callers that must resolve
    // a physical value carrying no `Units` of its own (reference-device Position).
    const uf = toMmFactor(current.defaultUnits);
    if (!(uf instanceof E142Error)) {
        out.unitsToMm = uf.factorMm;
    }
    if (anchor) {
        out.anchorLowerLeftMm = anchor;
    }
    if (current.stepSize) {
        const mm = physToMm(current.stepSize, current.defaultUnits, warnings);
        if (mm instanceof E142Error) {
            return mm;
        }
        out.stepXmm = mm.x;
        out.stepYmm = mm.y;
    }
    if (current.deviceSize) {
        const mm = physToMm(current.deviceSize, current.defaultUnits, warnings);
        if (mm instanceof E142Error) {
            return mm;
        }
        out.cellWmm = mm.x;
        out.cellLmm = mm.y;
    }
    return out;
}

// ===================================================================
//  Logical coordinate frame
// ===================================================================

/**
 * Map-frame dimensions and per-axis pitch after applying the Orientation swap
 * of the dimension swap. C = serialized columns, R = serialized rows in the MAP view.
 */
export interface MapFrameDims {
    /** Serialized columns in the map view (post-swap). */
    cols: number;
    /** Serialized rows in the map view (post-swap). */
    rows: number;
    /** Physical column pitch in mm (post-swap), if a pitch is known. */
    colPitchMm?: number;
    /** Physical row pitch in mm (post-swap), if a pitch is known. */
    rowPitchMm?: number;
    /** Drawn cell width in mm (post-swap), if known. */
    cellWmm?: number;
    /** Drawn cell length in mm (post-swap), if known. */
    cellLmm?: number;
}

/**
 * Applies the dimension and pitch swap for the map view.
 *
 * For orientation mod 180 == 90 the MAP view swaps the layout's X/Y: serialized
 * cols = layout Dimension.Y (rows), rows = layout Dimension.X (cols), and the
 * physical column pitch = layout StepSize.Y (row pitch = StepSize.X). For
 * orientation mod 180 == 0, no swap. The standard's 2DArray prose says the
 * dimensions are "rotated to the coordinate system of the SubstrateMap"; that
 * the rotation means a transpose at 90 and 270 is the reading taken here.
 *
 * Non-quadrant orientation (e.g. 45): NO swap - dims/pitch stay layout-aligned
 * and the angle only rotates the physical placement. That case is undefined
 * territory; document, do NOT error.]
 *
 * @param layoutDims  The resolved layout dims/pitch/cell (layout-aligned).
 * @param orientationDeg Total orientation in degrees (already incl. offset).
 * @returns The map-frame dims/pitch after the swap decision.
 */
/**
 * Does the map frame exchange the layout's X and Y axes at this orientation?
 *
 * True exactly for the quadrant rotations that transpose - orientation mod 180
 * == 90. THE ONE PLACE this rule is written down: {@link dimsInMapFrame} applies
 * it going in (layout -> map), and the two serializers apply it going out
 * (map -> layout). Two copies of the predicate would eventually disagree, and
 * the symptom - a pitch that comes back with X and Y exchanged - is quiet.
 *
 * Non-quadrant orientations (45, say) do NOT swap: the angle rotates the
 * physical placement only.
 *
 * @param orientationDeg Total orientation in degrees.
 * @returns `true` when the map frame is the layout frame transposed.
 */
export function mapFrameSwapsAxes(orientationDeg: number): boolean {
    return ((Math.round(orientationDeg) % 180) + 180) % 180 === 90;
}

export function dimsInMapFrame(layoutDims: ResolvedLayout, orientationDeg: number): MapFrameDims {
    if (mapFrameSwapsAxes(orientationDeg)) {
        return {
            cols: layoutDims.rows,
            rows: layoutDims.cols,
            colPitchMm: layoutDims.stepYmm,
            rowPitchMm: layoutDims.stepXmm,
            cellWmm: layoutDims.cellLmm,
            cellLmm: layoutDims.cellWmm,
        };
    }
    return {
        cols: layoutDims.cols,
        rows: layoutDims.rows,
        colPitchMm: layoutDims.stepXmm,
        rowPitchMm: layoutDims.stepYmm,
        cellWmm: layoutDims.cellWmm,
        cellLmm: layoutDims.cellLmm,
    };
}

/** A visual cell address: distance from the left edge and from the bottom edge. */
interface VisualCell {
    /** 0..C-1, from the left edge of the map view. */
    fromLeft: number;
    /** 0..R-1, from the bottom edge of the map view. */
    fromBottom: number;
}

/**
 * The visual cell carrying logical coordinate (0,0).
 *   LowerLeft  (0, 0);  UpperLeft (0, R-1);  LowerRight (C-1, 0);
 *   UpperRight (C-1, R-1); Center ((C-1)//2, (R-1)//2).
 * Center is PHYSICALLY FIXED, independent of AxisDirection; integer division
 * truncates toward zero, per the standard's own footnote. Settled for the four
 * corners, B for Center.]
 */
function zeroCell(origin: E142OriginLocation, C: number, R: number): VisualCell {
    switch (origin) {
        case 'LowerLeft': return { fromLeft: 0, fromBottom: 0 };
        case 'UpperLeft': return { fromLeft: 0, fromBottom: R - 1 };
        case 'LowerRight': return { fromLeft: C - 1, fromBottom: 0 };
        case 'UpperRight': return { fromLeft: C - 1, fromBottom: R - 1 };
        case 'Center': return {
            fromLeft: Math.trunc((C - 1) / 2),
            fromBottom: Math.trunc((R - 1) / 2),
        };
        default: {
            const _never: never = origin;
            return _never;
        }
    }
}

/**
 * The axis sign pair (sx, sy) from an AxisDirection: the
 * FIRST token is the Y direction (Up=+1 / Down=-1), the SECOND the X direction
 * (Right=+1 / Left=-1). Inferred from the token names rather than stated - the
 * component-wise decomposition is nowhere quoted verbatim by SEMI.]
 */
function axisSigns(dir: E142AxisDirection): { sx: number; sy: number } {
    switch (dir) {
        case 'UpRight': return { sx: 1, sy: 1 };
        case 'DownRight': return { sx: 1, sy: -1 };
        case 'UpLeft': return { sx: -1, sy: 1 };
        case 'DownLeft': return { sx: -1, sy: -1 };
        default: {
            const _never: never = dir;
            return _never;
        }
    }
}

/**
 * The serialization-column step of the LOGICAL +X direction: +1 when
 * AxisDirection's X token is Right, -1 when it is Left.
 *
 * This is {@link axisSigns}' `sx` under the coordinate bridge, which gives
 * X = sx * (from_left - zero.from_left), so from_left = zero.from_left + sx * X
 * (sx is +/-1, hence *sx == /sx), with from_left = serCol. Walking one
 * cell in logical +X therefore walks `sx` serialization columns.
 *
 * Exported because it is the ONE bit of the logical frame the Row/Column decoder
 * seam cannot do without (E142Bins' `E142BinMeta.xStep`): a Row/Column run's
 * fill direction in LOGICAL terms, and converting the run's start POINT through
 * {@link mapCoordToIndex} does not carry a DIRECTION. Input paths must derive it
 * HERE rather than re-deriving "endsWith('Right')" locally, so the token
 * decomposition lives in exactly one place and cannot drift from
 * {@link indexToMapCoord}.
 *
 * @param dir AxisDirection.
 * @returns +1 for a Right X axis, -1 for a Left X axis.
 */
export function logicalXStep(dir: E142AxisDirection): 1 | -1 {
    return axisSigns(dir).sx === 1 ? 1 : -1;
}

/**
 * Converts a SERIALIZATION-ORDER array index (serCol, serRow) to the LOGICAL
 * E142 map coordinate (X, Y), in closed form.
 *
 * Serialization is VISUAL: serRow 0 = TOP row, serCol 0 = LEFT; this is
 * INDEPENDENT of OriginLocation/AxisDirection. The Array prose settles the
 * serialization order; the independence of the two is a proof from it rather
 * than a quotation. The logical frame only LABELS the visual grid. The bridge to
 * visual coordinates:
 *   from_left = serCol,  from_bottom = R - 1 - serRow.
 * Then:
 *   X = sx * (from_left  - zero.fromLeft)
 *   Y = sy * (from_bottom - zero.fromBottom)
 * Negative logical coordinates are legal and expected. Figure A1-1b with the
 * 2DArray clause, and Table A4-1, are what settle this.
 *
 * @param serCol Serialized column index, 0..C-1 (C = map-frame cols).
 * @param serRow Serialized row index, 0..R-1 (R = map-frame rows).
 * @param origin OriginLocation.
 * @param dir    AxisDirection.
 * @param C      Map-frame columns (post-A3 swap).
 * @param R      Map-frame rows (post-A3 swap).
 * @returns The logical (x, y).
 */
export function indexToMapCoord(
    serCol: number,
    serRow: number,
    origin: E142OriginLocation,
    dir: E142AxisDirection,
    C: number,
    R: number,
): { x: number; y: number } {
    const zero = zeroCell(origin, C, R);
    const { sx, sy } = axisSigns(dir);
    const fromLeft = serCol;
    const fromBottom = R - 1 - serRow;
    return {
        x: sx * (fromLeft - zero.fromLeft),
        y: sy * (fromBottom - zero.fromBottom),
    };
}

/**
 * The inverse of {@link indexToMapCoord}: converts a LOGICAL map coordinate
 * (x, y) back to the SERIALIZATION index (serCol, serRow): the forward bridge
 * solved for from_left and from_bottom, then the serialization step.
 *   from_left  = zero.fromLeft   + sx * x     (sx = +/-1, so *sx == /sx)
 *   from_bottom = zero.fromBottom + sy * y
 *   serCol = from_left;  serRow = R - 1 - from_bottom.
 * It rests on exactly the same frame reading as {@link indexToMapCoord}.
 *
 * @returns The serialization (serCol, serRow). Values outside 0..C-1 / 0..R-1
 *          mean the logical coordinate lies off the serialized grid.
 */
export function mapCoordToIndex(
    x: number,
    y: number,
    origin: E142OriginLocation,
    dir: E142AxisDirection,
    C: number,
    R: number,
): { serCol: number; serRow: number } {
    const zero = zeroCell(origin, C, R);
    const { sx, sy } = axisSigns(dir);
    const fromLeft = zero.fromLeft + sx * x;
    const fromBottom = zero.fromBottom + sy * y;
    return { serCol: fromLeft, serRow: R - 1 - fromBottom };
}

/**
 * A serialization-index -> logical-(x, y) table for one lattice and frame.
 *
 * DERIVED, NOT REIMPLEMENTED. A parser converts every logical X/Y in a document
 * into a serialization index through {@link mapCoordToIndex}; a serializer needs
 * that map backwards, and there is no closed-form inverse to hand - the transform
 * is an involution for only 10 of the 20 OriginLocation x AxisDirection frames
 * (measured). A hand-written inverse would be a second coordinate rule to keep in
 * step with the first, so this builds one by calling the SAME function over the
 * lattice and recording where each logical pair lands. It cannot disagree with the
 * rule, because it IS the rule, run backwards.
 *
 * O(cols x rows) once per map, against a decode that is already O(cols x rows).
 * @param originLocation The map's origin corner.
 * @param axisDirection  The map's axis direction.
 * @param cols           Serialization columns.
 * @param rows           Serialization rows.
 * @returns `table[serRow * cols + serCol] = { x, y }` in logical coordinates.
 */
export function buildLogicalTable(
    originLocation: E142OriginLocation,
    axisDirection: E142AxisDirection,
    cols: number,
    rows: number,
): Array<{ x: number; y: number } | undefined> {
    const table = new Array<{ x: number; y: number } | undefined>(cols * rows);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const { serCol, serRow } = mapCoordToIndex(x, y, originLocation, axisDirection, cols, rows);
            if (serCol >= 0 && serCol < cols && serRow >= 0 && serRow < rows) {
                table[serRow * cols + serCol] = { x, y };
            }
        }
    }
    return table;
}

// ===================================================================
//  Placement
// ===================================================================

/**
 * Placement of a rectangular cell grid in the substrate frame S (+y up,
 * millimeters). The lattice point of cell (0,0) is the cell's own origin
 * corner as defined by the source map's OriginLocation; walking one column
 * adds colStep, walking one row adds rowStep. The two step vectors are the
 * full pitch (street included); the drawn cell rectangle is cellWmm x
 * cellLmm, centered on the pitch cell. All numbers plain (no DOMMatrix),
 * so the type stays DOM-free and node-testable. The vector form covers all
 * four AxisDirection sign combinations AND arbitrary Orientation 0-359.
 */
export interface GridPlacement {
    originXmm: number;   // S-frame X of the lattice origin (corner of cell (0,0))
    originYmm: number;   // S-frame Y, +y up
    colStepXmm: number;  // signed column step: cell (c+1,r) = origin + colStep
    colStepYmm: number;
    rowStepXmm: number;  // signed row step: cell (c,r+1) = origin + rowStep
    rowStepYmm: number;
    cellWmm: number;     // drawn device extent per cell (<= pitch)
    cellLmm: number;
    /**
     * Whether {@link computeGridPlacement} reflected this lattice about the
     * S-frame vertical axis (its `sideMirror` argument).
     *
     * Recorded here rather than passed alongside because it describes THESE
     * vectors: anything holding the placement can ask, and the answer cannot go
     * stale. The origin marker needs it - the marker is authored in the data
     * frame and rides `W * D2S`, which carries the rotation and the y-flip but
     * NOT the mirror, because the mirror lives in these vectors instead. Without
     * it the marker's `+x` stub points right while the cells run left, which is
     * not a cosmetic mismatch: it is the diagnostic overlay lying about the very
     * axis it exists to show.
     */
    sideMirror: boolean;
}

/**
 * The result of {@link computeGridPlacement}: the placement plus a flag telling
 * the caller whether a PHYSICAL scale was resolved. When `scaled` is false the
 * placement carries unit pitch only and the caller must run
 * {@link fitPlacementToBox} to obtain nominal (non-physical) dimensions.
 */
export interface GridPlacementResult {
    /** The computed placement. */
    placement: GridPlacement;
    /** True when a physical pitch was available - from the layout, or the caller's fallback. */
    scaled: boolean;
    /** Non-fatal diagnostics. */
    warnings: E142Warning[];
}

/** Rotates a plain vector by `deg` degrees CCW (+y up). Pure geometry, sign-neutral. */
function rotCcw(x: number, y: number, deg: number): { x: number; y: number } {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return { x: x * c - y * s, y: x * s + y * c };
}

/**
 * ===================================================================
 * THE SINGLE CW->CCW CONVERSION of the whole engine.
 * ===================================================================
 * Converts the E142 source Orientation (rotation of the SUBSTRATE relative to
 * the map data, CLOCKWISE-positive in E142-0225's own words) plus
 * the display-only E142OrientationOffset into the CCW-positive total angle the
 * engine's +y-up frames use. A substrate rotated CW by th relative to the map is
 * the map rotated CCW by th relative to the substrate, so the
 * conversion is the IDENTITY on the numeric value: the source degrees are simply
 * ADOPTED as a positive (CCW) angle. This single adoption is the one and only
 * source-semantic sign conversion in the engine; it is NOT a render-side
 * per-angle sign correction, which the angle sign rule (Engine.ts) rules out. The
 * downstream render chain keeps its single axis flip (Sc(s,-s) inside the world
 * matrix W) and carries no per-angle sign correction anywhere. Zero reference:
 * notch/flat at 6 o'clock at Orientation=0 (inferred from Figures A1-2 and A1-3;
 * matches the outline presets).
 *
 * {@link rotCcw} downstream is sign-NEUTRAL geometry (it rotates a vector by the
 * angle handed to it); {@link fitPlacementToBox} recovers the ALREADY-CONVERTED
 * angle from the placement's step vectors and never re-reads the source
 * Orientation, so no second conversion exists.
 *
 * @param orientationDeg       E142 Orientation, CW-positive, 0-359.
 * @param orientationOffsetDeg E142OrientationOffset in degrees, default 0.
 * @returns The CCW-positive total angle in degrees for the +y-up engine frames.
 */
function cwOrientationToCcwDeg(orientationDeg: number, orientationOffsetDeg: number): number {
    return orientationDeg + orientationOffsetDeg;
}

/**
 * Computes the placement of a rectangular cell grid in the substrate frame S.
 *
 * ---- Serialization indexing ----
 * ARRAY cell (0,0) = the first token of the first serialized BinCode row = the
 * TOP-LEFT visual cell; colStep walks serCol +1 (rightward on the map view),
 * rowStep walks serRow +1 (downward on the map view). Array/2DArray serialize
 * top-left first, in visual order, independent of OriginLocation/AxisDirection
 * The Array order is quoted from the standard; its independence from the frame
 * attributes is a proof from that, not a further quotation.
 *
 * ---- Map-view construction (before orientation) ----
 * In an intermediate map-view frame M (+x right, +y up) the grid is laid out so
 * the TOP-LEFT cell (0,0) has its lower-left corner at (0, (R-1)*rowPitch),
 * colStepM = (+colPitch, 0), rowStepM = (0, -rowPitch). The grid bounding box in
 * M is x in [0, C*colPitch], y in [0, R*rowPitch].
 *
 * ---- Anchoring ----
 * If `resolved.anchorLowerLeftMm` is present, the grid bbox lower-left corner is
 * placed at that S-frame coordinate (inferred; parent-relative accumulation done
 * during layout resolution). Otherwise the bbox is CENTERED on the S origin
 * That reading is inferred rather than stated.
 *
 * ---- Orientation ----
 * Orientation is the rotation of the SUBSTRATE relative to the map data,
 * CLOCKWISE-positive, in E142-0225's own words. This engine's frames
 * are CCW-positive; a substrate rotated CW by th relative to the map is the map
 * rotated CCW by th relative to the substrate. Therefore the grid,
 * expressed in S, carries a rotation of +(orientation + orientationOffsetDeg)
 * CCW about the substrate origin.
 *
 * The single CW->CCW source-semantic conversion is factored into
 * {@link cwOrientationToCcwDeg} and applied here EXACTLY ONCE to produce the
 * total CCW angle; every {@link rotCcw} call below is sign-neutral geometry on
 * that one angle. This is NOT a render-side per-angle sign correction: the
 * downstream render chain still contains exactly ONE axis flip (Sc(s,-s) inside
 * the world matrix W; see the angle sign rule in Engine.ts).
 *
 * ---- Physical scale ----
 *   (1) stepSize from the resolved layout (deviceSize fallback = stepSize) -> use it;
 *   (2) else, if `fallbackStep` is provided -> use its values as the pitch;
 *   (3) else return the placement WITHOUT physical scale (unit pitch) and set
 *       `scaled=false`; the caller must run {@link fitPlacementToBox}.
 *
 * ---- Side mirror (VIEW transform, opt-in) ----
 * When `sideMirror` is true the finished S-frame lattice is reflected about the
 * VERTICAL axis: the X component of the origin and of both step vectors is
 * negated, Y untouched.
 *
 * WHICH AXIS, AND WHY. E142-0225 Figure R2-17 ("Example Where Translation Is
 * Required as SubstrateSide Differs") draws two panels with an IDENTICAL wafer
 * outline - notch at the bottom in both - and changes only the frame: origin
 * cell upper-left with X running right, versus origin cell upper-right with X
 * running LEFT, Y running down in both. X reverses, Y is preserved. Figure R2-16
 * immediately above is the contrast case and reverses Y instead; it is captioned
 * as an `OriginLocation` difference. See `ws/notes/DECISION-substrate-side.md`
 * for the full reading, the Appendix 2 corroboration (strip `OriginLocation` is
 * a COMBINED corner+side code, 1-4 top / 6-9 bottom) and the rejected
 * alternatives. What the figures depict is settled; the consumer rule below is
 * an inference.
 *
 * THIS IS NOT DRIVEN BY `SubstrateSide`, and must not be. The mirror in
 * R2-17 is expressed THROUGH `OriginLocation` and `AxisDirection`, which this
 * function already applies - so a caller that set `sideMirror` from the
 * document's `SubstrateSide` would double-flip a conforming document: the frame
 * attributes flip it once, this would flip it again. `SubstrateSide` is
 * descriptive. This parameter exists for the separate question "show me this map
 * as it would look from the other face", which is a property of the VIEWER, not
 * of the document.
 *
 * AFTER THE ROTATION, deliberately. Reflecting the already-oriented lattice
 * about the S-frame vertical axis is "turn the substrate over and look at it";
 * reflecting before would mirror the map frame and then rotate, which is a
 * different operation whenever the orientation is not a multiple of 180.
 *
 * The reflection is exact, not approximate. A lattice point is
 * `origin + col*colStep + row*rowStep`; a linear map M distributes over that sum,
 * so applying `M = diag(-1, 1)` to the three vectors reflects every cell center
 * with no accumulated error. `cellWmm` / `cellLmm` are extents rather than
 * vectors and a reflection preserves lengths, so they are untouched.
 *
 * @param header               The SubstrateMap header (orientation, origin, axes).
 * @param resolved             The resolved (or layoutless) layout.
 * @param orientationOffsetDeg E142OrientationOffset in degrees, default 0.
 * @param fallbackStep         Optional pitch, used when the layout carries none.
 * @param sideMirror           Reflect the finished lattice about the S-frame
 *                             vertical axis. Default `false` - no existing
 *                             caller changes behavior.
 * @returns A {@link GridPlacementResult}.
 */
export function computeGridPlacement(
    header: E142SubstrateMapHeader,
    resolved: ResolvedLayout,
    orientationOffsetDeg = 0,
    fallbackStep?: { xMm: number; yMm: number },
    sideMirror = false,
): GridPlacementResult {
    countEnginePlacement();     // dev instrumentation - REMOVABLE
    const warnings: E142Warning[] = [...resolved.warnings];
    // THE single CW->CCW conversion (see {@link cwOrientationToCcwDeg}). Every
    // downstream rotCcw call is sign-neutral geometry using this one angle.
    const totalDeg = cwOrientationToCcwDeg(header.orientation, orientationOffsetDeg);

    // The `Orientation` dim/pitch swap for the map view.
    const mf = dimsInMapFrame(resolved, totalDeg);
    const C = mf.cols;
    const R = mf.rows;

    // Physical scale, in order: (1) the layout's pitch, (2) the caller's fallback
    // pitch, (3) none - unit pitch, which the caller fits to a box.
    let colPitch: number;
    let rowPitch: number;
    let scaled: boolean;
    if (mf.colPitchMm !== undefined && mf.rowPitchMm !== undefined) {
        // Stage 1: pitch from the resolved layout.
        colPitch = mf.colPitchMm;
        rowPitch = mf.rowPitchMm;
        scaled = true;
    } else if (fallbackStep !== undefined) {
        // Stage 2: caller-supplied fallback pitch. The fallback is supplied in
        // LAYOUT axes; apply the same `Orientation` swap as the layout pitch.
        const q = ((Math.round(totalDeg) % 180) + 180) % 180;
        if (q === 90) {
            colPitch = fallbackStep.yMm;
            rowPitch = fallbackStep.xMm;
        } else {
            colPitch = fallbackStep.xMm;
            rowPitch = fallbackStep.yMm;
        }
        scaled = true;
    } else {
        // Stage 3: no physical scale; unit pitch, caller must fit-to-box.
        colPitch = 1;
        rowPitch = 1;
        scaled = false;
        warnings.push({
            code: 'E142_NO_PHYSICAL_SCALE',
            message: 'No StepSize and no fallbackStep; placement carries nominal unit pitch '
                + '(run fitPlacementToBox for a fit; v1 heuristic renders nominal, not physical, sizes).',
        });
    }

    // Drawn cell extent: DeviceSize when present, else full pitch (deviceSize
    // fallback = stepSize). When unscaled, cell == unit pitch.
    const cellW = (scaled && mf.cellWmm !== undefined) ? mf.cellWmm : colPitch;
    const cellL = (scaled && mf.cellLmm !== undefined) ? mf.cellLmm : rowPitch;

    // Map-view (pre-orientation) lattice, cell (0,0) = top-left.
    const originMx0 = 0;
    const originMy0 = (R - 1) * rowPitch;
    const colStepMx = colPitch;
    const colStepMy = 0;
    const rowStepMx = 0;
    const rowStepMy = -rowPitch;

    // Anchoring: translate the map-view lattice so either the bbox lower-left
    // sits at anchorLowerLeftMm, or the bbox center sits at the S origin.
    let tx: number;
    let ty: number;
    if (resolved.anchorLowerLeftMm !== undefined) {
        // bbox lower-left in M is (0,0); move it to the anchor.
        tx = resolved.anchorLowerLeftMm.x;
        ty = resolved.anchorLowerLeftMm.y;
    } else {
        // No anchor anywhere along the path. NOTE the normative default is
        // LowerLeft = (0,0) relative to the PARENT's lower-left corner (E142-0225
        // Layout/LowerLeft, quoted: "If not present, then LowerLeft.X = 0 and
        // LowerLeft.Y = 0"), which the anchored branch above already realizes by
        // accumulating 0 for absent segments. Reaching HERE means no layout tree
        // with a physical frame exists at all (the layoutless / scale-less
        // NOMINAL path), so there is no parent corner to sit on and the grid is
        // centered on the substrate origin instead - a rendering fallback outside
        // the standard's coordinate model, not a coordinate claim.
        //
        // Center the DRAWN extent. In map view the cell corner of (0,0) is the
        // cell's ORIGIN corner and each cell extends +x and -y from it, so the
        // drawn box is x in [0, C*colPitch] but y in [-rowPitch, (R-1)*rowPitch]
        // - NOT [0, R*rowPitch]. Centering the latter is what put the drawn grid
        // one row pitch low (O8 finding 4.3).
        tx = -(C * colPitch) / 2;
        ty = -((R - 2) * rowPitch) / 2;
    }
    const originMx = originMx0 + tx;
    const originMy = originMy0 + ty;

    // Orientation: rotate origin point and step vectors by +totalDeg CCW about
    // the substrate origin (THE single CW->CCW conversion, see banner above).
    const o = rotCcw(originMx, originMy, totalDeg);
    const cs = rotCcw(colStepMx, colStepMy, totalDeg);
    const rs = rotCcw(rowStepMx, rowStepMy, totalDeg);

    // Side mirror: reflect about the S-frame vertical axis, AFTER the rotation.
    // See the banner. `m` is -1 or +1 so the arithmetic below is one multiply
    // either way and the false path is bit-identical to having no mirror at all
    // (x * 1 === x for every finite double, and for -0 the sign is preserved).
    const m = sideMirror ? -1 : 1;

    return {
        placement: {
            originXmm: m * o.x,
            originYmm: o.y,
            colStepXmm: m * cs.x,
            colStepYmm: cs.y,
            rowStepXmm: m * rs.x,
            rowStepYmm: rs.y,
            cellWmm: cellW,
            cellLmm: cellL,
            sideMirror,
        },
        scaled,
        warnings,
    };
}

/**
 * The fit-to-box heuristic. Given an UNSCALED
 * placement (unit pitch, from {@link computeGridPlacement} with scaled=false)
 * and a target bounding box in mm (e.g. the outline bbox), scales the lattice to
 * SQUARE cells via min(bboxW/cols, bboxH/rows) and centers the grid extent on
 * the box center. The result renders NOMINAL, not physical, dimensions - it is a
 * cosmetic v1 fit, not a measurement.
 *
 * Implementation note: the unscaled placement already has unit pitch and is
 * centered on the S origin (or anchored). We rescale the step vectors and the
 * origin about the CURRENT grid-extent center, then recenter on the box center.
 * An engineering heuristic, not a SEMI assumption.
 *
 * @param placement An UNSCALED placement (unit pitch).
 * @param cols      Serialized columns C (after the `Orientation` swap).
 * @param rows      Serialized rows R (after the `Orientation` swap).
 * @param bbox      Target box in mm.
 * @returns A new, scaled {@link GridPlacement} with square cells, centered on bbox.
 */
export function fitPlacementToBox(
    placement: GridPlacement,
    cols: number,
    rows: number,
    bbox: { minX: number; minY: number; maxX: number; maxY: number },
): GridPlacement {
    const bboxW = bbox.maxX - bbox.minX;
    const bboxH = bbox.maxY - bbox.minY;
    const cell = Math.min(bboxW / cols, bboxH / rows);
    // Square cells: the fit ignores orientation cross-terms by construction of
    // the unit placement (unit pitch, axis-aligned in the map view). We rebuild
    // the placement directly from cell size, centered on the box center, at the
    // placement's own orientation (encoded in its step-vector direction).
    // Recover the orientation from the (unit) colStep direction.
    const deg = Math.atan2(placement.colStepYmm, placement.colStepXmm) * 180 / Math.PI;
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;

    // Map-view lattice at square pitch `cell`, top-left cell (0,0). The cell CORNER
    // of (0,0) is its origin corner and cells extend +x/-y from it, so the drawn
    // extent is x in [0, cols*cell] but y in [-cell, (rows-1)*cell] - NOT
    // [0, rows*cell]. Center the DRAWN extent on the box center (same one-row-pitch
    // correction as computeGridPlacement; centering [0, rows*cell] put the grid one
    // pitch low and hung it below the box).
    const originMx0 = 0;
    const originMy0 = (rows - 1) * cell;
    const tx = -(cols * cell) / 2;
    const ty = -((rows - 2) * cell) / 2;
    const o = rotCcw(originMx0 + tx, originMy0 + ty, deg);
    const cs = rotCcw(cell, 0, deg);
    const rs = rotCcw(0, -cell, deg);
    return {
        originXmm: o.x + cx,
        originYmm: o.y + cy,
        colStepXmm: cs.x,
        colStepYmm: cs.y,
        rowStepXmm: rs.x,
        rowStepYmm: rs.y,
        cellWmm: cell,
        cellLmm: cell,
        // Built for the layoutless / unscaled case only; the side mirror is
        // applied by computeGridPlacement, which owns it.
        sideMirror: false,
    };
}

/**
 * The result of {@link registerPlacementToReferenceDevices}: the (possibly
 * shifted) placement, how many reference devices actually anchored it, and any
 * diagnostics.
 */
export interface ReferenceRegistrationResult {
    /** The registered placement (translated), or the input unchanged when nothing anchored it. */
    placement: GridPlacement;
    /** Reference devices that contributed: had a `Position` AND an on-grid `Coordinates` cell. */
    anchorsUsed: number;
    /** Non-fatal diagnostics (off-grid anchors, unit-less positions, no usable anchor). */
    warnings: E142Warning[];
}

/**
 * OPT-IN reference-device registration (the parser was "carry, do not
 * compute"; this adds the compute path, gated by the control's
 * `E142AlignToReferenceDevices` attribute and OFF by default so existing
 * behavior is unchanged).
 *
 * It TRANSLATES the placement so that the reference devices' MODEL cell-centers
 * land, on average (least-squares translation), on their stated physical
 * `Position`s. For each `ReferenceDevice` that carries a `Position`, the model
 * point is the center of the cell its logical `Coordinates` address (via
 * {@link mapCoordToIndex} in the current frame); the target is the `Position`
 * converted to millimeters. The applied shift is the mean of (target - model)
 * over all contributing devices; with a single anchor it places that device
 * exactly, which is the one registration every source agrees on.
 *
 * VERIFIED against SEMI E142-0225:
 *  - Table 10, ReferenceDevice: `Coordinates` are "X and Y coordinate of the
 *    reference device to align device matrix on physical substrate with the map
 *    data" (so reference devices ARE the alignment mechanism), and `Position` is
 *    the "Offset of the CENTER of a reference device in the X and Y directions
 *    from the CENTER of substrate" - hence the cell-CENTER target below and the
 *    substrate-center (S) origin.
 *  - Table 4, XYDimensions: the X/Y axes are "according to the values of
 *    SubstrateMap coordinate attributes; SubstrateSide, Orientation,
 *    OriginLocation, and AxisDirection", and "If omitted then the Layout,
 *    DefaultUnits is used" - hence the basis conversion and `defaultUnitsToMm`.
 * STILL ASSUMED, and inferred rather than stated: that the intended transform is a TRANSLATION rather than a
 * similarity. The standard names no rotation/scale attribute for reference devices
 * and gives only point correspondences, so translation is the only fit it
 * determines; with >= 2 anchors a similarity is not excluded by the text either.
 * If a future revision mandates one, replace the mean-translation with a Procrustes
 * solve - callers, the attribute and this signature are unaffected.
 *
 * A `Position` without a `Units` attribute is resolved with `defaultUnitsToMm`
 * (the resolved layout's DefaultUnits factor); when that too is absent (the
 * layoutless path) the position is taken as already-millimeters with a warning.
 *
 * @param placement        The placement to register (from {@link computeGridPlacement} / {@link fitPlacementToBox}).
 * @param referenceDevices The overlay's reference devices.
 * @param origin           OriginLocation of the current frame.
 * @param dir              AxisDirection of the current frame.
 * @param cols             Grid columns (serialization frame).
 * @param rows             Grid rows.
 * @param defaultUnitsToMm Millimeters per DefaultUnits unit, or `undefined` (layoutless).
 * @returns A {@link ReferenceRegistrationResult}.
 */
export function registerPlacementToReferenceDevices(
    placement: GridPlacement,
    referenceDevices: readonly E142ReferenceDevice[],
    origin: E142OriginLocation,
    dir: E142AxisDirection,
    cols: number,
    rows: number,
    defaultUnitsToMm: number | undefined,
): ReferenceRegistrationResult {
    const warnings: E142Warning[] = [];
    let sumDx = 0;
    let sumDy = 0;
    let used = 0;
    let offGrid = 0;
    let unitless = 0;
    for (const rd of referenceDevices) {
        if (!rd.position) {
            continue; // no target to register against
        }
        // Resolve the Position to millimeters.
        let factorMm: number;
        if (rd.position.units !== undefined && rd.position.units !== '') {
            const r = toMmFactor(rd.position.units);
            if (r instanceof E142Error) {
                warnings.push({
                    code: 'E142_REGISTER_UNIT_UNKNOWN',
                    message: `Reference-device Position units '${rd.position.units}' are not resolvable; this device was skipped for registration.`,
                });
                continue;
            }
            if (r.warning) {
                warnings.push(r.warning);
            }
            factorMm = r.factorMm;
        } else if (defaultUnitsToMm !== undefined) {
            factorMm = defaultUnitsToMm;
        } else {
            unitless++;
            factorMm = 1; // layoutless + no per-Position units: assume mm
        }
        // Position is a PHYSICAL offset expressed along the SubstrateMap's OWN X and Y
        // axes ("according to the values of SubstrateMap coordinate attributes;
        // SubstrateSide, Orientation, OriginLocation, and AxisDirection" - E142-0225
        // Table 4, XYDimensions), measured from the substrate center (the S origin;
        // "Offset of the center of a reference device in the X and Y directions from the
        // center of substrate", Table 10). It is therefore NOT plain S-frame mm: for a
        // rotated or mirrored frame the axes differ. Convert it through the placement's own
        // basis, which already encodes Orientation (step directions) and AxisDirection
        // (via the signs): one unit of logical +X moves by sx*colStep, one unit of logical
        // +Y by -sy*rowStep (from mapCoordToIndex: d(serCol)/dx = sx, d(serRow)/dy = -sy).
        const { sx, sy } = axisSigns(dir);
        const colLen = Math.hypot(placement.colStepXmm, placement.colStepYmm);
        const rowLen = Math.hypot(placement.rowStepXmm, placement.rowStepYmm);
        if (!(colLen > 0) || !(rowLen > 0)) {
            continue; // degenerate lattice: no basis to express the offset in
        }
        const uXx = sx * placement.colStepXmm / colLen;
        const uXy = sx * placement.colStepYmm / colLen;
        const uYx = -sy * placement.rowStepXmm / rowLen;
        const uYy = -sy * placement.rowStepYmm / rowLen;
        const px = rd.position.x * factorMm;
        const py = rd.position.y * factorMm;
        const targetX = px * uXx + py * uYx;
        const targetY = px * uXy + py * uYy;

        // Model cell-center for the device's logical Coordinates, in the current frame.
        const { serCol, serRow } = mapCoordToIndex(rd.coordinates.x, rd.coordinates.y, origin, dir, cols, rows);
        if (!(serCol >= 0 && serCol < cols && serRow >= 0 && serRow < rows)) {
            offGrid++;
            continue;
        }
        const modelX = placement.originXmm + (serCol + 0.5) * placement.colStepXmm + (serRow + 0.5) * placement.rowStepXmm;
        const modelY = placement.originYmm + (serCol + 0.5) * placement.colStepYmm + (serRow + 0.5) * placement.rowStepYmm;
        sumDx += targetX - modelX;
        sumDy += targetY - modelY;
        used++;
    }
    if (unitless > 0) {
        warnings.push({
            code: 'E142_REGISTER_UNITLESS_POSITION',
            message: `${unitless} reference-device Position(s) carried no Units and no layout DefaultUnits was available; they were taken as millimeters.`,
        });
    }
    if (offGrid > 0) {
        warnings.push({
            code: 'E142_REGISTER_ANCHOR_OFF_GRID',
            message: `${offGrid} reference-device Coordinates addressed no cell of this ${cols}x${rows} grid and were ignored for registration.`,
        });
    }
    if (used === 0) {
        warnings.push({
            code: 'E142_REGISTER_NO_ANCHOR',
            message: 'Reference-device registration was requested but no reference device carried both a Position and an on-grid Coordinates; the placement is unchanged.',
        });
        return { placement, anchorsUsed: 0, warnings };
    }
    const dx = sumDx / used;
    const dy = sumDy / used;
    const shifted: GridPlacement = {
        originXmm: placement.originXmm + dx,
        originYmm: placement.originYmm + dy,
        colStepXmm: placement.colStepXmm,
        colStepYmm: placement.colStepYmm,
        rowStepXmm: placement.rowStepXmm,
        rowStepYmm: placement.rowStepYmm,
        cellWmm: placement.cellWmm,
        cellLmm: placement.cellLmm,
        // Registration translates the lattice; it does not un-mirror it.
        sideMirror: placement.sideMirror,
    };
    return { placement: shifted, anchorsUsed: used, warnings };
}

/* ------------------------------------------------------------------------ *
 * Global namespace bridge (classic consumers)
 *
 * Mirrors the compatibility pattern used by Engine.ts and the attached
 * Beckhoff package: the module is consumed as
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142.* after listing E142.js as an
 * EsModule dependency file. First-wins (??=) assignments keep the first
 * definition if the file is ever evaluated twice.
 * ------------------------------------------------------------------------ */

declare const _E142ErrorAlias: typeof E142Error;
type _E142ErrorInstance = E142Error;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI.Engine.E142 {
        /** Global (classic namespace) alias of the module export {@link E142Error}. */
        let E142Error: typeof _E142ErrorAlias;
        /** Instance type of the global alias. */
        type E142Error = _E142ErrorInstance;
        /** Global alias of the default MapType constant. */
        let E142_DEFAULT_MAP_TYPE: E142MapType;
    }
}

/**
 * Returns (creating on demand) the namespace object at `segments` below
 * `root`. First-wins on every level: existing objects are reused, never
 * replaced, so repeated evaluation cannot orphan earlier registrations.
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
const e142Namespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine', 'E142');
e142Namespace['E142Error'] ??= E142Error;
e142Namespace['E142_DEFAULT_MAP_TYPE'] ??= E142_DEFAULT_MAP_TYPE;
