/**
 * @fileoverview
 * SubstrateMapEngine - shared, framework-free rendering/model library of the
 * SubstrateMap package.
 *
 * Three-layer split (SubstrateMapEngine / SubstrateMapBase / concrete controls):
 *  - Engine (this file and the modules beside it): a framework-free ES module
 *    that owns the data->model builders, the transform chain, the render
 *    strategies and the hit tests; it never touches DOM layout, attributes,
 *    events or themes (colors/fonts arrive as a resolved parameter object).
 *  - SubstrateMapBase: the abstract, non-placeable shell that owns the template
 *    root, canvas, devicePixelRatio bitmap sizing, ResizeObserver, theme
 *    reading, pointer wiring and one engine instance.
 *  - Concrete controls (SubstrateMap, SubstrateMapWidget, SubstrateMapBinChart):
 *    they own the attributes, schemas and events, mapping their data model onto
 *    the engine's calls. SubstrateMapFilterBar stands beside them and drives a
 *    map through its attributes.
 *
 * MODULE MECHANISM: the engine is authored as an ES module and shared through
 * the module graph exactly like dist/TcHmiCharting/* in the Beckhoff
 * TwinCAT.HMI.Controls package, so single-evaluation and
 * load-before-consumer are language guarantees; the global bridge at the end of
 * this file additionally exposes the classic namespace name
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine with first-wins (??=) assignments.
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

/*
 * THE ONE IMPORT. The module graph has to stay a tree with a leaf that depends
 * on nothing. `BinSeverity.ts` is that leaf now - it imports nothing at all - so the
 * root moved rather than the invariant breaking. Building the aggregate palette
 * still needs `Oklch`, and that still cannot be imported here.
 */
import { applySpatialFilter, type SpatialFilterRequest } from './SpatialFilter.js';
import {
    SEVERITY_FAIL, SEVERITY_NULL, SEVERITY_PASS, SEVERITY_UNKNOWN, binSeverityTable,
    resolveBinQuality, type BinTableEntry,
} from './BinSeverity.js';

/*
 * Re-exported so nothing that imports these from `Engine.js` today has to change:
 * `GridAggregate.ts`, the control and the test suites name them, and moving a
 * definition is not a reason to rename it.
 */
export {
    BIN_QUALITY_RESERVED, SEVERITY_FAIL, SEVERITY_NULL, SEVERITY_PASS, SEVERITY_UNKNOWN,
    binSeverity, binSeverityTable, resolveBinQuality,
} from './BinSeverity.js';
export type { BinQualityResolution, BinTableEntry } from './BinSeverity.js';

/**
 * Number of times this module file has been evaluated in the current page.
 * The ES module cache guarantees exactly one evaluation per resolved URL, so
 * this must read 1 no matter how many controls import the engine. Logged by
 * the classic-namespace bridge so the single-load property is observable on the
 * canvas itself during the designer session.
 */
export const MODULE_EVALUATIONS: number = (() => {
    const host = globalThis as { __substrateMapEngineEvaluations?: number };
    host.__substrateMapEngineEvaluations = (host.__substrateMapEngineEvaluations ?? 0) + 1;
    return host.__substrateMapEngineEvaluations;
})();


// ===================================================================
//  Data model  (types 1:1 with the JSON schemas registered in the
//  concrete control's Description.json).
// ===================================================================

/** A 2D point in CSS-pixel space or substrate/data-frame millimeters, depending on context. */
export interface Point { x: number; y: number; }

/** Status of an item: a free-form string mapped to a color via the status-color mapping. */
export type ItemStatus = string;

/** Metric prefix applied to a base unit (meter for positions/sizes, degree for orientation). */
export type MetricPrefix =
    'yocto' | 'zepto' | 'atto' | 'femto' | 'pico' | 'nano' |
    'micro' | 'milli' | 'centi' | 'deci' | 'none';

/** A single point of a polyline/polygon, authored in the data frame D (+y as per YAxisDirection). */
export interface ShapePoint { x: number; y: number; }

/**
 * One SVG path command as delivered by the data source. Coordinates are
 * authored in the data frame D (+y as per YAxisDirection, NOT raw SVG
 * +y-down); absolute vs relative is encoded in the command name
 * (`*_absolute`/`*_relative`), and the arc flags `large_arc`/`sweep` are
 * booleans. Mirrors the `path.commands` item schema.
 */
export type PathCommand =
    | { type: 'move_to_absolute' | 'move_to_relative' | 'line_to_absolute' | 'line_to_relative' | 'smooth_quadratic_bezier_absolute' | 'smooth_quadratic_bezier_relative'; x: number; y: number }
    | { type: 'horizontal_line_to_absolute' | 'horizontal_line_to_relative'; x: number }
    | { type: 'vertical_line_to_absolute' | 'vertical_line_to_relative'; y: number }
    | { type: 'quadratic_bezier_absolute' | 'quadratic_bezier_relative'; control_x: number; control_y: number; x: number; y: number }
    | { type: 'smooth_cubic_bezier_absolute' | 'smooth_cubic_bezier_relative'; control_2_x: number; control_2_y: number; x: number; y: number }
    | { type: 'cubic_bezier_absolute' | 'cubic_bezier_relative'; control_1_x: number; control_1_y: number; control_2_x: number; control_2_y: number; x: number; y: number }
    | { type: 'elliptical_arc_absolute' | 'elliptical_arc_relative'; rx: number; ry: number; x_axis_rotation: number; large_arc: boolean; sweep: boolean; x: number; y: number }
    | { type: 'close_path' };

/**
 * One geometry within an item, a discriminated union on `type`. Coordinates
 * and sizes are authored in the data frame D (+y as per YAxisDirection) in the
 * parent item's `unit`/`prefix`. Mirrors the `geometries` item schema.
 * `stroke_width` present -> an outline is painted IN ADDITION to the fill; absent
 * -> filled only. Open geometries (`polyline`, and a `path` with no `close_path`)
 * have no interior and are stroke-only, which is why `polyline` requires its
 * `stroke_width`. `stroke_width` never suppresses the fill of a closed shape.
 */
export type Geometry =
    | { type: 'rectangle'; center_position_x: number; center_position_y: number; width: number; length: number; stroke_width?: number }
    | { type: 'circle'; center_position_x: number; center_position_y: number; radius: number; stroke_width?: number }
    | { type: 'ellipse'; center_position_x: number; center_position_y: number; radius_x: number; radius_y: number; stroke_width?: number }
    | { type: 'polyline'; points: ShapePoint[]; stroke_width: number }
    | { type: 'polygon'; points: ShapePoint[]; stroke_width?: number }
    | { type: 'path'; commands: PathCommand[]; stroke_width?: number };

/**
 * One item as delivered by the data source: a container/group of geometries
 * sharing one status/bin color, one orientation and one z-layer. Mirrors the `SubstrateMapItemList`
 * item schema.
 *
 * `unit`/`prefix` are typed as `string` (not {@link MetricPrefix}) because
 * bound data is arbitrary and is validated defensively when the draw model is
 * built. All geometry coordinates/sizes are authored in the data frame D (+y
 * as per YAxisDirection) in the base unit `meter` scaled by `prefix`.
 * `orientation` is the item's own orientation about its combined-geometry bbox
 * center (CCW-positive in a +y-up frame) in the base unit `degree` scaled by
 * `orientation_prefix` (MES sends `'micro'`).
 */
export interface Item {
    /** Primary key/identifier of the item. Optional - absent => not targetable by assignments, selection reports `null`. */
    item_id?: number;
    /** Parent substrate reference. Accepted for 1:1 row binding, not used for rendering. Optional. */
    substrate_ref?: number;
    /** Opaque value passed through unchanged into the selection payload and exposed as SelectedItemUserData. Optional. */
    user_data?: string | number;
    /** Human-readable item name, e.g. `'S12'`. Optional. */
    name?: string;
    /** Optional z-order. Unlayered items draw first (array order); layered ones draw above, ascending. */
    layer?: number;
    /** Base unit; always `'meter'` for valid data. */
    unit: string;
    /** Metric prefix applied to all geometry coordinates and sizes. */
    prefix: string;
    /** Orientation magnitude in `orientation_prefix`-scaled degrees, CCW-positive, for the whole group. Optional; default 0. */
    orientation?: number;
    /** Orientation base unit; always `'degree'`. Optional. */
    orientation_unit?: string;
    /** Metric prefix applied to `orientation`. Optional (MES sends `'micro'`). */
    orientation_prefix?: string;
    /** Status / bin for the whole item; optional (may be supplied via assignments instead). */
    status?: ItemStatus;
    /** One or more geometries drawn as a group, in list order. Required and non-empty for valid data. */
    geometries: Geometry[];
}

/** Full item layout: an array of {@link Item}. */
export type ItemList = Item[];

/**
 * One status-only update for an item, keyed by `item_id`. Mirrors the
 * `SubstrateMapItemStatusAssignmentList` item schema.
 */
export interface ItemStatusAssignment {
    /** Identifier of the item to update. */
    item_id: number;
    /** New status for that item. */
    status: ItemStatus;
}

/** Per-item status updates: an array of {@link ItemStatusAssignment}. */
export type ItemStatusAssignmentList = ItemStatusAssignment[];

/**
 * One label as delivered by the data source. Mirrors the `SubstrateMapLabelList`
 * item schema. The box is authored in the data frame D (+y as per
 * YAxisDirection); the text is drawn upright and clipped to the box.
 */
export interface SubstrateMapLabel {
    /** Label box center X in the data frame, in `prefix`-scaled meters. */
    center_position_x: number;
    /** Label box center Y in the data frame, in `prefix`-scaled meters. */
    center_position_y: number;
    /** Label box width in `prefix`-scaled meters. */
    width: number;
    /** Label box length (height) in `prefix`-scaled meters. */
    length: number;
    /** Base unit; always `'meter'`. */
    unit: 'meter';
    /** Metric prefix applied to all spatial dimensions of the box. */
    prefix: MetricPrefix;
    /** Label text. */
    text: string;
}

/** All labels: an array of {@link SubstrateMapLabel}. */
export type SubstrateMapLabelList = SubstrateMapLabel[];

/**
 * The closed-shape subset of {@link Geometry} allowed for the substrate
 * outline: a single filled contour, with no `stroke_width` and no open
 * `polyline`. A `path` may hold multiple contours (fill rule nonzero).
 * Authored in the substrate frame S.
 */
export type OutlineGeometry =
    | { type: 'rectangle'; center_position_x: number; center_position_y: number; width: number; length: number }
    | { type: 'circle'; center_position_x: number; center_position_y: number; radius: number }
    | { type: 'ellipse'; center_position_x: number; center_position_y: number; radius_x: number; radius_y: number }
    | { type: 'polygon'; points: ShapePoint[] }
    | { type: 'path'; commands: PathCommand[] };

/**
 * The substrate outline: exactly one closed shape authored in the substrate
 * frame S (+y up, origin at the substrate center). Filled with the body color
 * and stroked with the edge color; its bounding box defines the fit box and the
 * origin anchors. Mirrors the `SubstrateMapOutline` schema.
 *
 * `unit`/`prefix` are typed as `string` because bound data is arbitrary and is
 * validated defensively when the draw model is built.
 */
export interface Outline {
    /** Base unit; always `'meter'` for valid data. */
    unit: string;
    /** Metric prefix applied to the outline coordinates and sizes. */
    prefix: string;
    /** The single closed outline shape, authored in the substrate frame S. */
    geometry: OutlineGeometry;
}

/**
 * Render-ready label: its box converted to data-frame millimeters plus the
 * text. Produced by {@link labelsToModels}; consumed by the label render
 * strategy. @internal
 */
export interface LabelModel {
    /** Box center X in data-frame millimeters. */
    x: number;
    /** Box center Y in data-frame millimeters (+y as per YAxisDirection). */
    y: number;
    /** Box width in millimeters. */
    w: number;
    /** Box length (height) in millimeters. */
    l: number;
    /** Label text. */
    text: string;
}

// ===================================================================
//  Constants
// ===================================================================

/** Decimal exponent for each {@link MetricPrefix} relative to its base unit. */
const PREFIX_EXP: Record<MetricPrefix, number> = {
    yocto: -24, zepto: -21, atto: -18, femto: -15, pico: -12, nano: -9,
    micro: -6, milli: -3, centi: -2, deci: -1, none: 0,
};

/** All valid metric prefixes (used to validate the prefix fields on bound data). */
export const PREFIXES: string[] = Object.keys(PREFIX_EXP);

// ===================================================================
//  Data transforms (pure functions)
//
//  THE ANGLE SIGN RULE, which the rest of this file cites by name: the
//  transform chain has exactly ONE axis flip, Sc(s, -s) in the canvas
//  world matrix, so a CCW-positive source angle renders CCW on screen
//  with no per-angle sign correction anywhere.
// ===================================================================

/**
 * Normalizes a status value: trims a string and returns it if non-empty,
 * otherwise `null`. Status is free-form, so there is no validation against a
 * fixed set.
 * @param s Candidate value of unknown type.
 * @returns The trimmed status string, or `null` when absent/empty.
 */
export function normStatus(s: unknown): ItemStatus | null {
    const t = (typeof s === 'string') ? s.trim() : '';
    return t !== '' ? t : null;
}

/**
 * Converts a value in `prefix`-scaled meters to millimeters. (The `+ 3`
 * accounts for the meter-to-millimeter factor of `1e3`.) An unknown prefix is
 * treated as `none` (exponent 0).
 * @param value  Numeric value in the prefixed unit.
 * @param prefix Metric prefix applied to the meter base unit.
 * @returns The value in millimeters.
 */
export function toMillimeters(value: number, prefix: MetricPrefix): number {
    const exp = PREFIX_EXP[prefix];
    return value * Math.pow(10, (exp === undefined ? 0 : exp) + 3);
}

/**
 * Converts a value in `prefix`-scaled degrees to degrees. Unlike
 * {@link toMillimeters} the base unit is already `degree`, so there is no
 * `+ 3`: micro-degrees (`prefix = 'micro'`) scale by `1e-6`, e.g. `90000000`
 * micro-degrees -> `90` degrees.
 * @param value  Numeric value in the prefixed unit.
 * @param prefix Metric prefix applied to the degree base unit.
 * @returns The value in degrees.
 */
export function toDegrees(value: number, prefix: MetricPrefix): number {
    const exp = PREFIX_EXP[prefix];
    return value * Math.pow(10, exp === undefined ? 0 : exp);
}

/**
 * Resolves an item's orientation in radians from the raw orientation fields. A
 * missing orientation is treated as 0; a missing `orientation_prefix` is
 * treated as `'none'` (literal degrees). The angle is returned CCW-positive in
 * the +y-up frame and carries NO sign correction (the substrate-map transform
 * chain applies its single axis flip in the canvas CTM, so this angle is passed
 * unchanged to the rotation matrix; see the angle sign rule).
 * @param orientation Raw orientation magnitude (CCW-positive), or `undefined`.
 * @param prefix      Raw orientation prefix, or `undefined`.
 * @returns The source angle in radians (CCW-positive).
 */
export function orientationToRad(orientation: number | undefined, prefix: MetricPrefix | undefined): number {
    if (orientation === undefined || orientation === null) {
        return 0;
    }
    const deg = toDegrees(orientation, prefix === undefined ? 'none' : prefix);
    return deg * Math.PI / 180;
}

/**
 * Builds an `item_id -> status` lookup from a status-assignment list, skipping
 * entries whose status is invalid.
 * @param list Status assignments, or `null`.
 * @returns A map from item id to status (empty if `list` is `null`).
 */
export function buildStatusMap(list: ItemStatusAssignmentList | null): Map<number, ItemStatus> {
    const m = new Map<number, ItemStatus>();
    if (list) {
        for (const a of list) {
            const s = normStatus(a.status);
            if (s !== null) {
                m.set(a.item_id, s);
            }
        }
    }
    return m;
}

/**
 * Resolves an item's fill color: the mapped color for its status if present and
 * non-empty, otherwise the unknown fallback. A `null` status (absent/empty)
 * also yields the unknown color.
 * @param status  Effective status, or `null`.
 * @param mapping Status-string -> CSS color map, or `null`.
 * @param unknown Fallback color for unmapped/absent status.
 * @returns The CSS color string to fill/stroke with.
 */
export function resolveStatusColor(status: ItemStatus | null, mapping: Record<string, string> | null, unknown: string): string {
    if (status === null) { return unknown; }
    const c = mapping ? mapping[status] : undefined;
    return (typeof c === 'string' && c.trim() !== '') ? c : unknown;
}

/**
 * Maps the schema-shaped label list to internal render-ready labels, converting
 * each box to millimeters and skipping non-object entries.
 * @param list Labels as delivered by the data source, or `null`.
 * @returns Internal {@link LabelModel} array (empty if `list` is `null`).
 */
export function labelsToModels(list: SubstrateMapLabelList | null): LabelModel[] {
    const out: LabelModel[] = [];
    if (list) {
        for (const label of list) {
            if (!label || typeof label !== 'object') { continue; }
            out.push({
                x: toMillimeters(label.center_position_x, label.prefix),
                y: toMillimeters(label.center_position_y, label.prefix),
                w: toMillimeters(label.width, label.prefix),
                l: toMillimeters(label.length, label.prefix),
                text: typeof label.text === 'string' ? label.text : '',
            });
        }
    }
    return out;
}

// ===================================================================
//  Geometry -> model  (pure build)
//
//  The geometry primitives are frame-neutral: they convert authored
//  coordinates to millimeters, and the authoring frame is the caller's -
//  {@link itemsToModels} authors the data frame D, {@link buildOutlineModel}
//  the substrate frame S. No per-angle sign correction is applied (see the
//  angle sign rule). None of these builders logs: invalid data is skipped
//  silently, and the caller decides what to report.
// ===================================================================

/** Axis-aligned bounding box in millimeters (+y up), in the authoring frame of its producer. @internal */
export interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

/**
 * Internal, render-ready geometry: its outline as a {@link Path2D} in
 * data-frame millimeters (+y up) plus its resolved paint mode. The per-item
 * CTM applies scale, centering, the y-flip and the item's rotation to this
 * path for both draw and hit-test.
 * @internal
 */
export interface GeometryModel {
    /** Geometry outline in data-frame millimeters (+y up). */
    path: Path2D;
    /**
     * `true` when the geometry has no interior - a `polyline`, or a `path` with no
     * `close_path`. Such a geometry is painted as a line and hit as a line.
     *
     * Not called `stroked`, because that name would mean two things at once: an
     * open shape, and a closed one carrying an outline. The second is
     * {@link hasStroke}, and a closed shape is filled whether or not it has one.
     */
    open: boolean;
    /** `true` when an outline is painted: always for {@link open}, otherwise when a `stroke_width` was given. */
    hasStroke: boolean;
    /** Stroke thickness in millimeters; meaningful only when {@link hasStroke}. */
    strokeWidthMm: number;
}

/**
 * Internal, render-ready item: identity plus the resolved rotation
 * (center + angle) and the built {@link GeometryModel} children. One bin color and one rotation
 * apply to the whole group; the color is resolved at draw time (status +
 * mapping), not stored here.
 * @internal
 */
export interface ItemModel {
    /** `item_id`, or `null` when absent. */
    id: number | null;
    /** name, or `null`. */
    name: string | null;
    /**
     * Opaque `user_data` carried through from the source {@link Item} unchanged,
     * or `null` when absent. Never used for rendering; it exists on the render
     * model so the shell's hit-test path can lift it into the selection payload
     * (SelectedItemUserData) - the base sees only {@link ItemModel}[], never the
     * raw {@link Item} rows, so this is the only place the value survives the
     * schema -> model build.
     */
    userData: string | number | null;
    /** Embedded status, or `null` when unknown (assignments may still override at draw time). */
    status: ItemStatus | null;
    /** z-layer, or `null` for an unlayered item. */
    layer: number | null;
    /**
     * Draw angle in radians, applied via `CanvasRenderingContext2D.rotate` in
     * the item CTM.
     *
     * NO per-angle sign factor. The source orientation (CCW-positive in the
     * +y-up data frame) is passed through unchanged, because the chain performs
     * its single axis flip inside the canvas CTM (`Sc(s, -s)` in `W`); a CCW
     * source angle therefore renders CCW on screen without correction. A sign
     * factor would only be needed if coordinates were flipped outside the CTM.
     * The hit-test rebuilds the SAME CTM, so draw and hit-test remain exact
     * inverses. (See the angle sign rule.)
     */
    angle: number;
    /** Rotation-center (combined-geometry bbox center) X in data-frame millimeters. */
    cx: number;
    /** Rotation-center (combined-geometry bbox center) Y in data-frame millimeters (+y up). */
    cy: number;
    /**
     * Combined axis-aligned bounding box of the item's geometries in data-frame
     * millimeters (+y up), or `null` when the item has no boundable geometry.
     * Feeds the canvas fit box when no outline is bound (see {@link fitBBox}) and
     * the later hit-test / spatial-index tasks; it is the same box whose midpoint
     * is {@link cx}/{@link cy}.
     */
    bbox: BBox | null;
    /** The item's geometries, drawn/hit-tested in list order under one shared CTM. */
    geometries: GeometryModel[];
}

/**
 * Render-ready substrate outline: its closed contour as a {@link Path2D} in
 * substrate-frame millimeters (+y up) plus the axis-aligned bounding box of
 * that contour. The bbox defines the fit box and the origin anchors; the path
 * is filled with the body color and stroked with the edge color. Produced by
 * {@link buildOutlineModel}.
 * @internal
 */
export interface OutlineModel {
    /** Closed outline contour in substrate-frame millimeters (+y up). */
    path: Path2D;
    /** Axis-aligned bounding box of the contour in substrate-frame millimeters. */
    bbox: BBox;
}

/** Geometry `type` discriminators understood by the item renderer. */
export const KNOWN_GEOMETRY_TYPES: string[] = ['rectangle', 'circle', 'ellipse', 'polyline', 'polygon', 'path'];

/** Closed-shape `type` discriminators allowed for the substrate outline (the open `polyline` is excluded). */
const KNOWN_OUTLINE_GEOMETRY_TYPES: string[] = ['rectangle', 'circle', 'ellipse', 'polygon', 'path'];

/**
 * Serializes one path command to its SVG fragment, converting every length
 * field to millimeters (abs and rel scale identically, so deltas convert the
 * same way). Absolute commands use the uppercase SVG letter, relative ones the
 * lowercase; arc `large_arc`/`sweep` booleans become `1`/`0`; `x_axis_rotation`
 * is an angle and is NOT scaled. The result is fed to `new Path2D(d)`, so arcs
 * are parsed by the browser for free.
 * @param cmd    The path command.
 * @param prefix The parent item's (or outline's) metric prefix.
 * @returns The SVG path fragment (millimeter coordinates).
 */
export function serializeCommand(cmd: PathCommand, prefix: MetricPrefix): string {
    const M = (v: number): number => toMillimeters(v, prefix);
    switch (cmd.type) {
        case 'move_to_absolute': return 'M ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'move_to_relative': return 'm ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'line_to_absolute': return 'L ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'line_to_relative': return 'l ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_quadratic_bezier_absolute': return 'T ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_quadratic_bezier_relative': return 't ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'horizontal_line_to_absolute': return 'H ' + M(cmd.x);
        case 'horizontal_line_to_relative': return 'h ' + M(cmd.x);
        case 'vertical_line_to_absolute': return 'V ' + M(cmd.y);
        case 'vertical_line_to_relative': return 'v ' + M(cmd.y);
        case 'quadratic_bezier_absolute': return 'Q ' + M(cmd.control_x) + ' ' + M(cmd.control_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'quadratic_bezier_relative': return 'q ' + M(cmd.control_x) + ' ' + M(cmd.control_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_cubic_bezier_absolute': return 'S ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'smooth_cubic_bezier_relative': return 's ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'cubic_bezier_absolute': return 'C ' + M(cmd.control_1_x) + ' ' + M(cmd.control_1_y) + ' ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'cubic_bezier_relative': return 'c ' + M(cmd.control_1_x) + ' ' + M(cmd.control_1_y) + ' ' + M(cmd.control_2_x) + ' ' + M(cmd.control_2_y) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'elliptical_arc_absolute': return 'A ' + M(cmd.rx) + ' ' + M(cmd.ry) + ' ' + cmd.x_axis_rotation + ' ' + (cmd.large_arc ? 1 : 0) + ' ' + (cmd.sweep ? 1 : 0) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'elliptical_arc_relative': return 'a ' + M(cmd.rx) + ' ' + M(cmd.ry) + ' ' + cmd.x_axis_rotation + ' ' + (cmd.large_arc ? 1 : 0) + ' ' + (cmd.sweep ? 1 : 0) + ' ' + M(cmd.x) + ' ' + M(cmd.y);
        case 'close_path': return 'Z';
        default: { const _never: never = cmd; return _never; }
    }
}

/**
 * Builds a geometry's outline as a {@link Path2D} in millimeters (+y up).
 * Closed shapes are added with the native canvas primitives; a `path` is
 * reassembled into an SVG `d` string (see {@link serializeCommand}) and parsed
 * by `new Path2D(d)`. The Y-flip, scale, centering and rotation are applied
 * later by the CTM, not here. The authoring frame is the caller's: the data
 * frame D for item geometries, the substrate frame S for the outline (the
 * function itself is frame-agnostic).
 * @param geom   The geometry (an item geometry or the outline's closed shape).
 * @param prefix The parent item's (or outline's) metric prefix.
 * @returns A {@link Path2D} in millimeters.
 */
export function geometryToPath2D(geom: Geometry, prefix: MetricPrefix): Path2D {
    const M = (v: number): number => toMillimeters(v, prefix);
    const p = new Path2D();
    switch (geom.type) {
        case 'rectangle': {
            const w = M(geom.width), l = M(geom.length);
            p.rect(M(geom.center_position_x) - w / 2, M(geom.center_position_y) - l / 2, w, l);
            break;
        }
        case 'circle':
            p.arc(M(geom.center_position_x), M(geom.center_position_y), M(geom.radius), 0, 2 * Math.PI);
            break;
        case 'ellipse':
            p.ellipse(M(geom.center_position_x), M(geom.center_position_y), M(geom.radius_x), M(geom.radius_y), 0, 0, 2 * Math.PI);
            break;
        case 'polyline':
        case 'polygon': {
            const pts = geom.points;
            if (pts && pts.length > 0) {
                p.moveTo(M(pts[0].x), M(pts[0].y));
                for (let i = 1; i < pts.length; i++) {
                    p.lineTo(M(pts[i].x), M(pts[i].y));
                }
                if (geom.type === 'polygon') {
                    p.closePath();
                }
            }
            break;
        }
        case 'path':
            return new Path2D(geom.commands.map((c) => serializeCommand(c, prefix)).join(' '));
        default: { const _never: never = geom; return _never; }
    }
    return p;
}

/** Whether a geometry is painted as an outline (`stroke_width`, or any `polyline`) vs. filled. */
export function geometryIsOpen(geom: Geometry): boolean {
    if (geom.type === 'polyline') {
        return true;
    }
    if (geom.type === 'path') {
        // A path is closed when it says so. `close_path` anywhere is enough: a
        // multi-subpath figure with one closed subpath has an interior, and the
        // canvas fills it.
        return !geom.commands.some((c) => c.type === 'close_path');
    }
    return false;
}

/**
 * Whether a geometry paints an outline in addition to whatever it fills.
 *
 * Open geometries are always stroked - that is all they are. Closed ones are
 * stroked when they carry a `stroke_width`, and they are filled either way.
 * @param geom The geometry.
 * @returns Whether an outline is painted.
 */
export function geometryHasStroke(geom: Geometry): boolean {
    return geometryIsOpen(geom) || typeof geom.stroke_width === 'number';
}

/** A geometry's stroke thickness in millimeters (0 when filled / unset). */
export function geometryStrokeWidthMm(geom: Geometry, prefix: MetricPrefix): number {
    return typeof geom.stroke_width === 'number' ? toMillimeters(geom.stroke_width, prefix) : 0;
}

/**
 * Accumulates the axis-aligned bounds of ONE elliptical-arc segment into the
 * `accX`/`accY` sinks: both endpoints plus every axis extreme of the ellipse
 * whose parameter angle lies on the swept range. The ellipse center - which the
 * endpoint-parameterized command does not carry - is derived exactly as the
 * browser derives it to draw the arc: the SVG endpoint->center conversion
 * (SVG 1.1 F.6.5), including the F.6.6 radii correction, degenerate radii
 * (straight line per spec) and coincident endpoints (arc omitted per spec).
 * The candidate extreme angles solve dx/dt = 0 / dy/dt = 0 of the rotated
 * ellipse parameterization, so a non-zero `x_axis_rotation` is bounded exactly
 * too. Pure algebra over the raw coordinates - frame-agnostic, so it holds in
 * the +y-up authoring frames unchanged.
 * @param x0       Arc start point x (the current point), millimeters.
 * @param y0       Arc start point y (the current point), millimeters.
 * @param rx       Arc radius x, millimeters (absolute value is used).
 * @param ry       Arc radius y, millimeters (absolute value is used).
 * @param phiDeg   Ellipse x-axis rotation in DEGREES (SVG semantics, as serialized).
 * @param largeArc SVG large-arc flag.
 * @param sweep    SVG sweep flag.
 * @param x1       Arc end point x, millimeters.
 * @param y1       Arc end point y, millimeters.
 * @param accX     X accumulator sink.
 * @param accY     Y accumulator sink.
 */
function accumulateArcBBox(
    x0: number, y0: number,
    rx: number, ry: number, phiDeg: number, largeArc: boolean, sweep: boolean,
    x1: number, y1: number,
    accX: (x: number) => void, accY: (y: number) => void,
): void {
    accX(x0); accY(y0);
    accX(x1); accY(y1);
    rx = Math.abs(rx);
    ry = Math.abs(ry);
    if (rx === 0 || ry === 0) { return; }                  // degenerate radii: a straight line (SVG spec)
    const phi = phiDeg * Math.PI / 180;
    const cosP = Math.cos(phi), sinP = Math.sin(phi);
    // F.6.5.1: midpoint-relative start point in the ellipse-aligned frame.
    const hx = (x0 - x1) / 2, hy = (y0 - y1) / 2;
    const x1p = cosP * hx + sinP * hy;
    const y1p = -sinP * hx + cosP * hy;
    if (x1p === 0 && y1p === 0) { return; }                // coincident endpoints: arc omitted (SVG spec)
    // F.6.6: scale the radii up when they cannot span the endpoints.
    const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lambda > 1) {
        const k = Math.sqrt(lambda);
        rx *= k;
        ry *= k;
    }
    // F.6.5.2/3: ellipse center, first in the aligned frame, then unrotated back.
    const sign = largeArc !== sweep ? 1 : -1;
    const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    const co = sign * Math.sqrt(Math.max(0, num / den));
    const cxp = co * rx * y1p / ry;
    const cyp = -co * ry * x1p / rx;
    const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2;
    const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2;
    // F.6.5.5/6: start angle and signed sweep extent (sweep flag <=> positive extent).
    const theta1 = Math.atan2((y1p - cyp) / ry, (x1p - cxp) / rx);
    const theta2 = Math.atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx);
    let dTheta = theta2 - theta1;
    if (!sweep && dTheta > 0) { dTheta -= 2 * Math.PI; }
    if (sweep && dTheta < 0) { dTheta += 2 * Math.PI; }
    // Whether parameter angle `t` lies on the swept range [theta1, theta1 + dTheta].
    const EPS = 1e-9;
    const inSweep = (t: number): boolean => {
        const d = normAngle(t - theta1);
        return dTheta >= 0 ? d <= dTheta + EPS : (d <= EPS || d >= 2 * Math.PI + dTheta - EPS);
    };
    // Axis extremes of the rotated ellipse: dx/dt = 0 at tX (+pi), dy/dt = 0 at tY (+pi).
    const tX = Math.atan2(-ry * sinP, rx * cosP);
    const tY = Math.atan2(ry * cosP, rx * sinP);
    for (const t of [tX, tX + Math.PI, tY, tY + Math.PI]) {
        if (inSweep(t)) {
            accX(cx + rx * cosP * Math.cos(t) - ry * sinP * Math.sin(t));
            accY(cy + rx * sinP * Math.cos(t) + ry * cosP * Math.sin(t));
        }
    }
}

/**
 * Bounding box of a command path in millimeters, shared by {@link geometryBBox}
 * (item paths) and the outline's box (see {@link buildOutlineModel}) so items,
 * outline anchoring, letterbox fit and hit-testing all bound one and the same
 * way. The walker tracks the current point, the subpath start (`close_path`
 * returns to it) and the previous control point (SVG smooth-command
 * reflection), so relative commands and smooth beziers resolve to their true
 * absolute coordinates.
 *
 * Exact for moves, lines, H/V and elliptical arcs (true analytic arc bounds via
 * {@link accumulateArcBBox}); conservative for beziers, which are bounded by
 * their control-point hull (curve is contained in it; reflected smooth control
 * points are included in the hull).
 *
 * WHY A WALKER. Accumulating the literal command fields - relative deltas taken
 * as absolute positions, arcs by their endpoint only, or endpoint padded by the
 * radii - gives boxes that are wrong-centered for arcs and for any relative
 * command; since BBOX_S anchors the data frame (OriginLocation) and the fit,
 * items and outline alike go through this walker.
 * @param commands The path commands.
 * @param M        Unit conversion: authored value -> millimeters (the caller's prefix closure).
 * @returns The bounding box, or `null` when the path bounds nothing.
 */
function pathCommandsBBox(commands: PathCommand[], M: (v: number) => number): BBox | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const accX = (x: number): void => { if (x < minX) { minX = x; } if (x > maxX) { maxX = x; } };
    const accY = (y: number): void => { if (y < minY) { minY = y; } if (y > maxY) { maxY = y; } };
    let curX = 0, curY = 0;                               // current point (mm)
    let startX = 0, startY = 0;                           // current subpath start (mm)
    let prevC2: Point | null = null;                      // last cubic control_2 (smooth-cubic reflection)
    let prevQC: Point | null = null;                      // last quadratic control (smooth-quadratic reflection)
    for (const c of commands) {
        switch (c.type) {
            case 'move_to_absolute':
            case 'move_to_relative': {
                curX = c.type === 'move_to_absolute' ? M(c.x) : curX + M(c.x);
                curY = c.type === 'move_to_absolute' ? M(c.y) : curY + M(c.y);
                startX = curX; startY = curY;
                accX(curX); accY(curY);
                prevC2 = null; prevQC = null;
                break;
            }
            case 'line_to_absolute':
            case 'line_to_relative': {
                curX = c.type === 'line_to_absolute' ? M(c.x) : curX + M(c.x);
                curY = c.type === 'line_to_absolute' ? M(c.y) : curY + M(c.y);
                accX(curX); accY(curY);
                prevC2 = null; prevQC = null;
                break;
            }
            case 'horizontal_line_to_absolute':
            case 'horizontal_line_to_relative': {
                curX = c.type === 'horizontal_line_to_absolute' ? M(c.x) : curX + M(c.x);
                accX(curX); accY(curY);
                prevC2 = null; prevQC = null;
                break;
            }
            case 'vertical_line_to_absolute':
            case 'vertical_line_to_relative': {
                curY = c.type === 'vertical_line_to_absolute' ? M(c.y) : curY + M(c.y);
                accX(curX); accY(curY);
                prevC2 = null; prevQC = null;
                break;
            }
            case 'quadratic_bezier_absolute':
            case 'quadratic_bezier_relative': {
                const rel = c.type === 'quadratic_bezier_relative';
                const qx = rel ? curX + M(c.control_x) : M(c.control_x);
                const qy = rel ? curY + M(c.control_y) : M(c.control_y);
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(qx); accY(qy); accX(curX); accY(curY);
                prevQC = { x: qx, y: qy }; prevC2 = null;
                break;
            }
            case 'smooth_quadratic_bezier_absolute':
            case 'smooth_quadratic_bezier_relative': {
                const rel = c.type === 'smooth_quadratic_bezier_relative';
                /*
                 * ANNOTATED BECAUSE OF THE LOOP'S BACK-EDGE.
                 *
                 * `prevQC` is declared `Point | null`, so this looks like it needs no help.
                 * It does. Control-flow analysis re-types `prevQC` at THIS line from every
                 * assignment that can reach it, and one of them is `prevQC = { x: qx, y: qy }`
                 * four lines below - which reaches here again on the next turn of the `for`.
                 * So `qx` depends on `prevQC` depends on `qx`, and under `noImplicitAny` that
                 * circularity is TS7022 rather than a silent `any`.
                 *
                 * The plain quadratic case above does NOT need this, and the difference is the
                 * evidence: it computes its control point without reading `prevQC`.
                 */
                const qx: number = prevQC ? 2 * curX - prevQC.x : curX;   // reflected control (SVG smooth rule)
                const qy: number = prevQC ? 2 * curY - prevQC.y : curY;
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(qx); accY(qy); accX(curX); accY(curY);
                prevQC = { x: qx, y: qy }; prevC2 = null;
                break;
            }
            case 'cubic_bezier_absolute':
            case 'cubic_bezier_relative': {
                const rel = c.type === 'cubic_bezier_relative';
                const c1x = rel ? curX + M(c.control_1_x) : M(c.control_1_x);
                const c1y = rel ? curY + M(c.control_1_y) : M(c.control_1_y);
                const c2x = rel ? curX + M(c.control_2_x) : M(c.control_2_x);
                const c2y = rel ? curY + M(c.control_2_y) : M(c.control_2_y);
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(c1x); accY(c1y); accX(c2x); accY(c2y); accX(curX); accY(curY);
                prevC2 = { x: c2x, y: c2y }; prevQC = null;
                break;
            }
            case 'smooth_cubic_bezier_absolute':
            case 'smooth_cubic_bezier_relative': {
                const rel = c.type === 'smooth_cubic_bezier_relative';
                const c1x = prevC2 ? 2 * curX - prevC2.x : curX;  // reflected control (SVG smooth rule)
                const c1y = prevC2 ? 2 * curY - prevC2.y : curY;
                const c2x = rel ? curX + M(c.control_2_x) : M(c.control_2_x);
                const c2y = rel ? curY + M(c.control_2_y) : M(c.control_2_y);
                curX = rel ? curX + M(c.x) : M(c.x);
                curY = rel ? curY + M(c.y) : M(c.y);
                accX(c1x); accY(c1y); accX(c2x); accY(c2y); accX(curX); accY(curY);
                prevC2 = { x: c2x, y: c2y }; prevQC = null;
                break;
            }
            case 'elliptical_arc_absolute':
            case 'elliptical_arc_relative': {
                const rel = c.type === 'elliptical_arc_relative';
                const ex = rel ? curX + M(c.x) : M(c.x);
                const ey = rel ? curY + M(c.y) : M(c.y);
                accumulateArcBBox(curX, curY, M(c.rx), M(c.ry), c.x_axis_rotation, c.large_arc, c.sweep, ex, ey, accX, accY);
                curX = ex; curY = ey;
                prevC2 = null; prevQC = null;
                break;
            }
            case 'close_path': {
                curX = startX; curY = startY;
                prevC2 = null; prevQC = null;
                break;
            }
            default: { const _never: never = c; break; }
        }
    }
    return (minX <= maxX && minY <= maxY) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Computes an item geometry's bounding box in data-frame millimeters, or `null`
 * when it cannot be bounded on both axes. For a `path` this is the shared
 * {@link pathCommandsBBox} walker: exact for lines, H/V and elliptical arcs,
 * control-point hull for beziers, with relative commands and smooth
 * reflections resolved against the tracked current point (see the walker's
 * WHY A WALKER note).
 * @param geom   The geometry.
 * @param prefix The parent item's metric prefix.
 * @returns The bounding box, or `null`.
 */
export function geometryBBox(geom: Geometry, prefix: MetricPrefix): BBox | null {
    const M = (v: number): number => toMillimeters(v, prefix);
    switch (geom.type) {
        case 'rectangle': {
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            const hw = M(geom.width) / 2, hl = M(geom.length) / 2;
            return { minX: cx - hw, minY: cy - hl, maxX: cx + hw, maxY: cy + hl };
        }
        case 'circle': {
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y), r = M(geom.radius);
            return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
        }
        case 'ellipse': {
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            const rx = M(geom.radius_x), ry = M(geom.radius_y);
            return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
        }
        case 'polyline':
        case 'polygon': {
            const pts = geom.points;
            if (!pts || pts.length === 0) { return null; }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of pts) {
                const x = M(pt.x), y = M(pt.y);
                if (x < minX) { minX = x; }
                if (y < minY) { minY = y; }
                if (x > maxX) { maxX = x; }
                if (y > maxY) { maxY = y; }
            }
            return { minX, minY, maxX, maxY };
        }
        case 'path':
            return pathCommandsBBox(geom.commands, M);
        default: { const _never: never = geom; return _never; }
    }
}

/**
 * Combines geometry bounding boxes into an item's rotation center (the
 * combined-bbox midpoint). Falls back to the origin when there is nothing to
 * bound.
 * @param boxes Per-geometry bounding boxes.
 * @returns The rotation center in data-frame millimeters.
 */
export function combinedCenter(boxes: BBox[]): { cx: number; cy: number } {
    if (boxes.length === 0) { return { cx: 0, cy: 0 }; }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const b of boxes) {
        if (b.minX < minX) { minX = b.minX; }
        if (b.minY < minY) { minY = b.minY; }
        if (b.maxX > maxX) { maxX = b.maxX; }
        if (b.maxY > maxY) { maxY = b.maxY; }
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * Unions a set of bounding boxes (skipping `null` entries) into their combined
 * axis-aligned box, or `null` when none are present. Used for an item's combined
 * bbox (over its geometry boxes) and for the items' fit box (over the item
 * boxes, see {@link fitBBox}).
 * @param boxes Bounding boxes, some possibly `null`.
 * @returns The combined box, or `null` when there is nothing to bound.
 */
export function unionBoxes(boxes: Array<BBox | null>): BBox | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const b of boxes) {
        if (!b) { continue; }
        any = true;
        if (b.minX < minX) { minX = b.minX; }
        if (b.minY < minY) { minY = b.minY; }
        if (b.maxX > maxX) { maxX = b.maxX; }
        if (b.maxY > maxY) { maxY = b.maxY; }
    }
    return any ? { minX, minY, maxX, maxY } : null;
}

/**
 * Maps the schema-shaped item list to internal render-ready items: builds each
 * geometry's {@link Path2D} (in data-frame millimeters) and paint mode,
 * resolves the draw angle and the combined-bbox rotation center, and normalizes
 * optional fields to `null`. Geometries with an unknown `type` are skipped (not
 * thrown).
 *
 * `angle = orientationToRad(...)` with NO sign factor - the CCW-positive source
 * angle is passed through unchanged because the single axis flip lives in the
 * canvas CTM, not in the coordinate mapping (see {@link ItemModel.angle} and the
 * angle sign rule). `cx`/`cy` are the combined-geometry bbox center, expressed in
 * DATA-frame millimeters (frame D).
 * @param list Item layout as delivered by the data source (authored in frame D).
 * @returns Internal {@link ItemModel} array.
 */
export function itemsToModels(list: ItemList): ItemModel[] {
    const out: ItemModel[] = [];
    for (const s of list) {
        if (!s || typeof s !== 'object' || !Array.isArray(s.geometries)) { continue; }
        const prefix = s.prefix as MetricPrefix;
        const geometries: GeometryModel[] = [];
        const boxes: BBox[] = [];
        for (const geom of s.geometries) {
            if (!geom || typeof geom.type !== 'string' || KNOWN_GEOMETRY_TYPES.indexOf(geom.type) === -1) { continue; }
            geometries.push({
                path: geometryToPath2D(geom, prefix),
                open: geometryIsOpen(geom),
                hasStroke: geometryHasStroke(geom),
                strokeWidthMm: geometryStrokeWidthMm(geom, prefix),
            });
            const bb = geometryBBox(geom, prefix);
            if (bb) { boxes.push(bb); }
        }
        const center = combinedCenter(boxes);
        out.push({
            id: typeof s.item_id === 'number' ? s.item_id : null,
            name: typeof s.name === 'string' ? s.name : null,
            // Opaque: only string/number pass through; anything else is null.
            userData: (typeof s.user_data === 'string' || typeof s.user_data === 'number') ? s.user_data : null,
            status: normStatus(s.status),
            layer: typeof s.layer === 'number' ? s.layer : null,
            // NO sign factor: the CCW-positive source angle is passed through
            // unchanged (the axis flip lives in the canvas CTM). See the angle sign rule.
            angle: orientationToRad(s.orientation, s.orientation_prefix as MetricPrefix | undefined),
            cx: center.cx,
            cy: center.cy,
            bbox: unionBoxes(boxes),
            geometries,
        });
    }
    return out;
}

/**
 * Computes the substrate outline's bounding box in substrate-frame millimeters,
 * or `null` for an empty / degenerate shape. Exact for `rectangle`/`circle`/
 * `ellipse`/`polygon`; a `path` is bounded by the SAME shared
 * {@link pathCommandsBBox} walker the items use - exact for lines, H/V and
 * elliptical arcs (the endpoint-parameterized arc's center is derived via the
 * SVG endpoint->center conversion, exactly as the browser derives it to draw),
 * control-point hull for beziers. This box IS BBOX_S: it anchors the data
 * frame (OriginLocation) and the letterbox fit, so it must be positionally
 * exact for the preset contours (lines + arcs) - the former endpoint-padded
 * approximation was wrong-centered and shifted every D2S consumer.
 * Degenerate shapes are rejected: a `polygon` with fewer than 3 points, any
 * non-positive extent (zero/negative width, length or radius), and a `path`
 * that bounds nothing.
 * @param geom   The outline's closed geometry (authored in frame S).
 * @param prefix The outline's metric prefix.
 * @returns The bounding box, or `null` when empty/degenerate.
 */
function outlineBBox(geom: OutlineGeometry, prefix: MetricPrefix): BBox | null {
    const M = (v: number): number => toMillimeters(v, prefix);
    switch (geom.type) {
        case 'rectangle': {
            const w = M(geom.width), l = M(geom.length);
            if (!(w > 0) || !(l > 0)) { return null; }
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            const hw = w / 2, hl = l / 2;
            return { minX: cx - hw, minY: cy - hl, maxX: cx + hw, maxY: cy + hl };
        }
        case 'circle': {
            const r = M(geom.radius);
            if (!(r > 0)) { return null; }
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            return { minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r };
        }
        case 'ellipse': {
            const rx = M(geom.radius_x), ry = M(geom.radius_y);
            if (!(rx > 0) || !(ry > 0)) { return null; }
            const cx = M(geom.center_position_x), cy = M(geom.center_position_y);
            return { minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry };
        }
        case 'polygon': {
            const pts = geom.points;
            if (!pts || pts.length < 3) { return null; }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const pt of pts) {
                const x = M(pt.x), y = M(pt.y);
                if (x < minX) { minX = x; }
                if (y < minY) { minY = y; }
                if (x > maxX) { maxX = x; }
                if (y > maxY) { maxY = y; }
            }
            return { minX, minY, maxX, maxY };
        }
        case 'path':
            return pathCommandsBBox(geom.commands, M);
        default: { const _never: never = geom; return _never; }
    }
}

/**
 * Builds the render-ready substrate outline from the bound outline, or `null`
 * when it is absent, malformed or degenerate. Validates defensively (in the
 * spirit of {@link itemsToModels}): the `unit` must be `'meter'`, the `prefix`
 * a known metric prefix, and the geometry a known closed outline type. The
 * single closed geometry is converted to a {@link Path2D} in substrate-frame
 * millimeters (+y up) by the shared {@link geometryToPath2D} (which reuses
 * {@link serializeCommand} for a `path`), and its bounding box is computed by
 * {@link outlineBBox}. Stays silent on rejection: the caller decides what to report.
 * @param outline The bound outline (authored in frame S), or `null`.
 * @returns The {@link OutlineModel}, or `null` when there is nothing drawable.
 */
export function buildOutlineModel(outline: Outline | null): OutlineModel | null {
    if (!outline || typeof outline !== 'object') { return null; }
    if (outline.unit !== 'meter') { return null; }
    if (PREFIXES.indexOf(outline.prefix) === -1) { return null; }
    const prefix = outline.prefix as MetricPrefix;
    const geom = outline.geometry;
    if (!geom || typeof geom.type !== 'string' || KNOWN_OUTLINE_GEOMETRY_TYPES.indexOf(geom.type) === -1) { return null; }
    const bbox = outlineBBox(geom, prefix);
    if (!bbox) { return null; }
    return { path: geometryToPath2D(geom, prefix), bbox };
}

// ===================================================================
//  Outline presets  (SEMI substrate library)
//
//  A normative preset table ({@link OUTLINE_SPECS}) plus pure generators that turn a preset
//  key into a substrate Outline authored in the substrate frame S (+y up,
//  millimeters, primary mark at 6 o'clock). Each generator emits the SAME
//  closed-shape Outline that a bound Outline travels, so a preset and an
//  explicit binding render through one identical pipeline (geometryToPath2D /
//  buildOutlineModel). No SEMI dimension is re-derived here: every number is the
//  millimeter value from the preset table, passed through unchanged (prefix 'milli' makes
//  the engine's unit conversion 1:1).
//
//  Angle / sweep convention (see the angle sign rule): the whole
//  construct is painted through exactly ONE axis flip (Sc(s, -s) in the world
//  matrix), so an outline authored as a COUNTER-CLOCKWISE loop in the +y-up S
//  frame paints correctly on screen. Every elliptical_arc is therefore emitted
//  with sweep = true (CCW / increasing-angle in the raw +y-up coordinates the
//  browser's `new Path2D` parses) and large_arc set iff the segment subtends
//  more than 180 degrees. Both flags were validated against the SVG
//  endpoint->center arc parametrization: the reconstructed arc center resolves
//  to the true substrate center O_S, never the reflected one. Angles are the
//  canonical +y-DOWN canvas angles negated into the +y-up S frame
//  (a = -a_canvas), which preserves the on-screen layout - including secDir
//  cw/ccw semantics - bit-for-bit through the single flip. No per-angle sign
//  factor applies (the angle sign rule).
// ===================================================================

/** Secondary-flat placement relative to the primary flat (as seen on screen). */
export type SecDir = 'cw' | 'ccw';

/**
 * The geometric parameters of one substrate preset: a discriminated union on
 * `kind`. All lengths are millimeters and all angles degrees, taken verbatim
 * from the preset table ({@link OUTLINE_SPECS}). `disc-flats` carries the primary chord and an
 * optional secondary chord + its angle from the primary; `disc-notch` the true
 * (unexaggerated) V-notch depth; `pseudo-square` the square edge length and the
 * ingot diameter that chamfers its corners; `rectangle` a plain width/height.
 */
export type OutlineSpec =
    | { kind: 'disc-flats'; dia: number; primary: number; secondary: number | null; secAngle: number | null }
    | { kind: 'disc-notch'; dia: number; notchDepth: number }
    | { kind: 'pseudo-square'; side: number; ingotDia: number }
    | { kind: 'rectangle'; width: number; height: number };

/**
 * Every preset key: the string-literal union of all preset-table keys plus the
 * `'none'` sentinel ("no preset"). Used to type and validate the concrete
 * control's OutlinePreset attribute.
 */
export type PresetKey =
    | 'si-2in-p111' | 'si-2in-n111' | 'si-2in-p100' | 'si-2in-n100'
    | 'si-3in-p111' | 'si-3in-n111' | 'si-3in-p100' | 'si-3in-n100'
    | 'si-4in-p111' | 'si-4in-n111' | 'si-4in-p100' | 'si-4in-n100'
    | 'si-5in-p111' | 'si-5in-n111' | 'si-5in-p100' | 'si-5in-n100'
    | 'si-6in-p111' | 'si-6in-n111' | 'si-6in-p100' | 'si-6in-n100'
    | 'si-8in' | 'si-12in' | 'si-18in'
    | 'sic-4in' | 'sic-6in-flat' | 'sic-6in-notch'
    | 'gaas-4in'
    | 'sapphire-2in' | 'sapphire-4in'
    | 'solar-m0' | 'solar-m2' | 'solar-g1' | 'solar-m6' | 'solar-m10' | 'solar-g12'
    | 'glass-gen2.5' | 'glass-gen4'
    | 'ceramic-100x100'
    | 'none';

/**
 * The normative preset table: SEMI substrate dimensions. Keyed by every
 * spec-bearing preset - that is {@link PresetKey} minus the `'none'` sentinel,
 * which carries no geometry. Typing it `Record<Exclude<PresetKey, 'none'>,
 * OutlineSpec>` makes the key set exhaustive and closed: a missing or misspelled
 * key is a compile error. All numbers are millimeters / degrees, verbatim from
 * the published dimensions - do NOT re-derive.
 */
export const OUTLINE_SPECS: Record<Exclude<PresetKey, 'none'>, OutlineSpec> = {
    'si-2in-p111': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: null, secAngle: null },
    'si-2in-n111': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: 8.00, secAngle: 45 },
    'si-2in-p100': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: 8.00, secAngle: 90 },
    'si-2in-n100': { kind: 'disc-flats', dia: 50.8, primary: 15.88, secondary: 8.00, secAngle: 180 },
    'si-3in-p111': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: null, secAngle: null },
    'si-3in-n111': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: 11.18, secAngle: 45 },
    'si-3in-p100': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: 11.18, secAngle: 90 },
    'si-3in-n100': { kind: 'disc-flats', dia: 76.2, primary: 22.22, secondary: 11.18, secAngle: 180 },
    'si-4in-p111': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: null, secAngle: null },
    'si-4in-n111': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 45 },
    'si-4in-p100': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 90 },
    'si-4in-n100': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 180 },
    'si-5in-p111': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: null, secAngle: null },
    'si-5in-n111': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: 27.50, secAngle: 45 },
    'si-5in-p100': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: 27.50, secAngle: 90 },
    'si-5in-n100': { kind: 'disc-flats', dia: 125.0, primary: 42.50, secondary: 27.50, secAngle: 180 },
    'si-6in-p111': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: null, secAngle: null },
    'si-6in-n111': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: 37.50, secAngle: 45 },
    'si-6in-p100': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: 37.50, secAngle: 90 },
    'si-6in-n100': { kind: 'disc-flats', dia: 150.0, primary: 57.50, secondary: 37.50, secAngle: 180 },
    'si-8in': { kind: 'disc-notch', dia: 200.0, notchDepth: 1.125 },
    'si-12in': { kind: 'disc-notch', dia: 300.0, notchDepth: 1.125 },
    'si-18in': { kind: 'disc-notch', dia: 450.0, notchDepth: 1.125 },
    'sic-4in': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 18.00, secAngle: 90 },
    'sic-6in-flat': { kind: 'disc-flats', dia: 150.0, primary: 47.50, secondary: null, secAngle: null },
    'sic-6in-notch': { kind: 'disc-notch', dia: 150.0, notchDepth: 1.125 },
    'gaas-4in': { kind: 'disc-flats', dia: 100.0, primary: 32.50, secondary: 16.00, secAngle: 90 },
    'sapphire-2in': { kind: 'disc-flats', dia: 50.8, primary: 16.00, secondary: null, secAngle: null },
    'sapphire-4in': { kind: 'disc-flats', dia: 100.0, primary: 30.00, secondary: null, secAngle: null },
    'solar-m0': { kind: 'pseudo-square', side: 156.0, ingotDia: 200.0 },
    'solar-m2': { kind: 'pseudo-square', side: 156.75, ingotDia: 210.0 },
    'solar-g1': { kind: 'pseudo-square', side: 158.75, ingotDia: 223.0 },
    'solar-m6': { kind: 'pseudo-square', side: 166.0, ingotDia: 223.0 },
    'solar-m10': { kind: 'pseudo-square', side: 182.0, ingotDia: 247.0 },
    'solar-g12': { kind: 'pseudo-square', side: 210.0, ingotDia: 295.0 },
    'glass-gen2.5': { kind: 'rectangle', width: 370.0, height: 470.0 },
    'glass-gen4': { kind: 'rectangle', width: 550.0, height: 650.0 },
    'ceramic-100x100': { kind: 'rectangle', width: 100.0, height: 100.0 },
};

/**
 * Every {@link PresetKey} as a runtime array (the `'none'` sentinel first, then
 * the preset keys in table order), for validating the OutlinePreset attribute.
 */
export const PRESET_KEYS: readonly PresetKey[] =
    ['none', ...(Object.keys(OUTLINE_SPECS) as Array<Exclude<PresetKey, 'none'>>)];

/** Normalizes an angle to `[0, 2*PI)`. */
function normAngle(a: number): number { a %= 2 * Math.PI; return a < 0 ? a + 2 * Math.PI : a; }

/** A chord flat expressed as a midpoint angle and half-angle on the substrate circle, in frame S (+y up). @internal */
interface FlatS { center: number; half: number; }

/**
 * Computes the chord flats of a disc-flats preset IN THE SUBSTRATE FRAME S
 * (+y up). The primary flat is centered at `-PI/2` (6 o'clock, `-y`) with
 * half-angle `asin(primary / dia)`; a secondary flat (when both `secondary` and
 * `secAngle` are present) is offset by `secAngle` from the primary, `secDir`
 * choosing the on-screen side. The canonical +y-DOWN canvas angles are negated
 * into the +y-up S frame
 * (`a = -a_canvas`), so the painted flat layout - and the exact `secDir` cw/ccw
 * semantics - survive the transform chain's single axis flip unchanged.
 * @param spec   The disc-flats preset spec.
 * @param secDir Secondary-flat direction relative to the primary.
 * @returns The flats as S-frame angle/half-angle pairs (primary first).
 */
function computeFlatsS(spec: Extract<OutlineSpec, { kind: 'disc-flats' }>, secDir: SecDir): FlatS[] {
    const aP = Math.asin(Math.min(1, spec.primary / spec.dia));
    const flats: FlatS[] = [{ center: -Math.PI / 2, half: aP }];
    if (spec.secondary != null && spec.secAngle != null) {
        const aS = Math.asin(Math.min(1, spec.secondary / spec.dia));
        const theta = spec.secAngle * Math.PI / 180;
        const center = secDir === 'cw' ? (-Math.PI / 2 - theta) : (-Math.PI / 2 + theta);
        flats.push({ center, half: aS });
    }
    return flats;
}

/**
 * Builds the disc-with-flats contour as an SVG-command list in frame S. Flats are normalized and sorted by center
 * angle; the contour is walked COUNTER-CLOCKWISE (increasing angle) as an
 * alternation of a rim arc (from one flat's trailing edge to the next flat's
 * leading edge) and the next flat's chord. Each arc is emitted with
 * `sweep = true` and `large_arc` iff its central angle exceeds `PI`; the closing
 * segment is the last chord (`close_path`). Assumes at least one flat (a
 * disc-flats preset always has a primary).
 * @param R     Disc radius in millimeters.
 * @param flats Chord flats in frame S (from {@link computeFlatsS}).
 * @returns The `path` commands (substrate-frame millimeters, +y up).
 */
function discFlatsCommands(R: number, flats: FlatS[]): PathCommand[] {
    const sorted = flats.map((f) => ({ center: normAngle(f.center), half: f.half }))
                        .sort((a, b) => a.center - b.center);
    const pt = (a: number): { x: number; y: number } => ({ x: R * Math.cos(a), y: R * Math.sin(a) });
    const cmds: PathCommand[] = [];
    const p0 = pt(sorted[0].center + sorted[0].half);
    cmds.push({ type: 'move_to_absolute', x: p0.x, y: p0.y });
    for (let k = 1; k <= sorted.length; k++) {
        const prev = sorted[k - 1];
        const cur = sorted[k % sorted.length];
        const arcStart = prev.center + prev.half;
        let arcEnd = cur.center - cur.half;
        while (arcEnd < arcStart) { arcEnd += 2 * Math.PI; }
        const end = pt(arcEnd);
        cmds.push({ type: 'elliptical_arc_absolute', rx: R, ry: R, x_axis_rotation: 0, large_arc: (arcEnd - arcStart) > Math.PI, sweep: true, x: end.x, y: end.y });
        const trailing = pt(cur.center + cur.half);
        cmds.push({ type: 'line_to_absolute', x: trailing.x, y: trailing.y });
    }
    cmds.push({ type: 'close_path' });
    return cmds;
}

/**
 * Generates a disc-with-flats substrate {@link Outline}: a circle of diameter
 * `spec.dia` interrupted by its primary flat at 6 o'clock and (when present) a
 * secondary flat placed per `secDir`. Emitted as a single closed `path`
 * (elliptical-arc rim segments + chord `line_to`s) authored in the substrate
 * frame S (+y up, mm), via {@link computeFlatsS} and the disc-with-flats
 * contour; see the section header for the arc-flag convention.
 * @param spec   The disc-flats preset spec.
 * @param secDir Secondary-flat direction relative to the primary flat.
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generateDiscWithFlats(spec: Extract<OutlineSpec, { kind: 'disc-flats' }>, secDir: SecDir): Outline {
    const R = spec.dia / 2;
    const commands = discFlatsCommands(R, computeFlatsS(spec, secDir));
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'path', commands } };
}

/**
 * Generates a disc-with-notch substrate {@link Outline}: a circle of diameter
 * `spec.dia` with a V-notch cut into 6 o'clock. The true notch depth in
 * millimeters equals `spec.notchDepth` (`(notchDepth / (dia/2)) * R` collapses
 * to `notchDepth` when `R = dia/2`), magnified by `exaggeration`, with the notch
 * half-width derived as `depth / R`. The
 * contour is the major rim arc over 12 o'clock (`large_arc`, `sweep = true`) plus
 * the two flanks meeting at the inward apex. An explicitly bound Outline is never
 * scaled; only presets pass through here.
 * @param spec         The disc-notch preset spec.
 * @param exaggeration Visual magnification of the notch depth (`1` = to scale).
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generateDiscWithNotch(spec: Extract<OutlineSpec, { kind: 'disc-notch' }>, exaggeration: number): Outline {
    const R = spec.dia / 2;
    const depth = spec.notchDepth * exaggeration;   // true depth (mm) * magnification
    const hw = depth / R;                           // notch half-width (rad)
    const rimBx = R * Math.sin(hw);                 // +x rim point of the notch mouth
    const rimY = -R * Math.cos(hw);                 // rim y (both mouth points share it)
    const commands: PathCommand[] = [
        { type: 'move_to_absolute', x: rimBx, y: rimY },
        // Major rim arc over 12 o'clock (CCW) from the +x mouth to the -x mouth.
        { type: 'elliptical_arc_absolute', rx: R, ry: R, x_axis_rotation: 0, large_arc: true, sweep: true, x: -rimBx, y: rimY },
        { type: 'line_to_absolute', x: 0, y: -(R - depth) },   // inward V apex at 6 o'clock
        { type: 'line_to_absolute', x: rimBx, y: rimY },       // back out to the +x mouth
        { type: 'close_path' },
    ];
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'path', commands } };
}

/**
 * Generates a pseudo-square (chamfered) substrate {@link Outline} from the square
 * edge length `side` and the ingot diameter `ingotDia` that rounds its corners
 * (frame S, +y up, mm). Three regimes: when `ingotDia >= side*sqrt(2)` the ingot
 * contains the whole square, so the outline is the plain square (`rectangle`);
 * when `ingotDia <= side` the ingot is no wider than an edge, so the outline is
 * the bare disc (`circle`); otherwise the four corners are chamfered by circular
 * arcs of radius `R = ingotDia/2` and the outline is a closed `path` with
 * `k = sqrt(R*R - h*h)` (h = side/2) as the chamfer inset, walked one full CCW
 * traversal (each corner arc minor, `sweep = true`).
 * @param side     Square edge length in millimeters.
 * @param ingotDia Ingot diameter in millimeters.
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generatePseudoSquare(side: number, ingotDia: number): Outline {
    const h = side / 2;
    const R = ingotDia / 2;
    if (ingotDia >= side * Math.SQRT2) {
        return { unit: 'meter', prefix: 'milli', geometry: { type: 'rectangle', center_position_x: 0, center_position_y: 0, width: side, length: side } };
    }
    if (ingotDia <= side) {
        return { unit: 'meter', prefix: 'milli', geometry: { type: 'circle', center_position_x: 0, center_position_y: 0, radius: R } };
    }
    const k = Math.sqrt(R * R - h * h);
    const corner = (x: number, y: number): PathCommand =>
        ({ type: 'elliptical_arc_absolute', rx: R, ry: R, x_axis_rotation: 0, large_arc: false, sweep: true, x, y });
    const commands: PathCommand[] = [
        { type: 'move_to_absolute', x: h, y: -k },   // right edge, lower
        { type: 'line_to_absolute', x: h, y: k },    // up the right edge
        corner(k, h),                                // top-right chamfer
        { type: 'line_to_absolute', x: -k, y: h },   // across the top edge
        corner(-h, k),                               // top-left chamfer
        { type: 'line_to_absolute', x: -h, y: -k },  // down the left edge
        corner(-k, -h),                              // bottom-left chamfer
        { type: 'line_to_absolute', x: k, y: -h },   // across the bottom edge
        corner(h, -k),                               // bottom-right chamfer
        { type: 'close_path' },
    ];
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'path', commands } };
}

/**
 * Generates a plain rectangle substrate {@link Outline} centered at the origin,
 * with edges aligned to the S axes (frame S, +y up, mm).
 * @param w Rectangle width in millimeters (X extent).
 * @param h Rectangle height in millimeters (Y extent, the outline `length`).
 * @returns The substrate outline (unit `'meter'`, prefix `'milli'`).
 */
export function generateRectangle(w: number, h: number): Outline {
    return { unit: 'meter', prefix: 'milli', geometry: { type: 'rectangle', center_position_x: 0, center_position_y: 0, width: w, length: h } };
}

/**
 * Generates the substrate {@link Outline} for a spec-bearing preset key by
 * dispatching on its preset `kind`. `secDir` steers disc-flats secondary
 * placement; `notchExaggeration` magnifies disc-notch depth; each is ignored by
 * the kinds it does not apply to. The `'none'` sentinel carries no geometry and
 * is excluded at the type level.
 * @param key               A spec-bearing preset key (not `'none'`).
 * @param secDir            Secondary-flat direction (disc-flats only).
 * @param notchExaggeration Notch magnification (disc-notch only).
 * @returns The generated substrate outline.
 */
export function generatePresetOutline(key: Exclude<PresetKey, 'none'>, secDir: SecDir, notchExaggeration: number): Outline {
    const spec = OUTLINE_SPECS[key];
    switch (spec.kind) {
        case 'disc-flats': return generateDiscWithFlats(spec, secDir);
        case 'disc-notch': return generateDiscWithNotch(spec, notchExaggeration);
        case 'pseudo-square': return generatePseudoSquare(spec.side, spec.ingotDia);
        case 'rectangle': return generateRectangle(spec.width, spec.height);
        default: { const _never: never = spec; return _never; }
    }
}

/**
 * Computes the item draw order (two-tier z-order): unlayered items first in
 * array order (bottom), then layered items by ascending layer, stable within
 * equal layers, on top. The whole layered tier sits above the whole unlayered
 * tier regardless of layer sign. Draw walks this order; the hit-test walks its
 * reverse, so it is computed once and shared.
 * @param items Render-ready items.
 * @returns The items in bottom-to-top draw order.
 */
export function computeDrawOrder(items: ItemModel[]): ItemModel[] {
    const unlayered = items.filter((st) => st.layer === null);
    const layered = items
        .map((st, i) => ({ st, i }))
        .filter((x) => x.st.layer !== null)
        .sort((a, b) => ((a.st.layer as number) - (b.st.layer as number)) || (a.i - b.i));
    return unlayered.concat(layered.map((x) => x.st));
}

// ===================================================================
//  Canvas mapping, transform chain and drawing  (render layer)
//
//  The rules the rest of this file cites by name:
//   1. The transform chain is expressed with DOMMatrix and its single axis
//      flip (Sc(s, -s)) lives in the world matrix W, so the angle sign rule
//      holds: no per-angle sign correction anywhere (see {@link ItemModel.angle}).
//   2. THE HIT-TEST INVARIANT: hit CTM = draw CTM minus the device-pixel-ratio
//      factor, so the hit region and the painted shape coincide.
//   3. THE FIT PRECEDENCE: the outline's bbox defines the fit box and the
//      origin anchor; without an outline, the items and the grid are fitted
//      and no substrate body is drawn.
//   4. The substrate body is an arbitrary closed Outline path (filled and
//      edged).
//  Colors and fonts are NOT read here: they arrive already resolved from the
//  shell (SubstrateMapBase.__readColors) as {@link SubstrateMapColors}, so the
//  engine stays free of the DOM and the theme.
// ===================================================================

/**
 * Drawing configuration derived from the canvas' current client size; all
 * values are in CSS pixels.
 */
export interface MapConfig {
    /** Canvas center in CSS pixels. */
    center: Point;
    /** Canvas width in CSS pixels. */
    width: number;
    /** Canvas height in CSS pixels. */
    height: number;
    /** Margin in CSS pixels kept clear between the drawn construct and the canvas box. */
    margin: number;
}

/**
 * Resolved colors and fonts the engine paints with, read from the theme CSS
 * custom properties (`--substratemap-*`) by the shell and handed in as the
 * "resolved parameter object": the engine never touches the DOM or the
 * theme itself.
 */
export interface SubstrateMapColors {
    /** Background fill; an empty string leaves the canvas transparent. */
    bg: string;
    /** Substrate body fill color. */
    body: string;
    /** Substrate edge stroke color. */
    edge: string;
    /** Selection outline color. */
    selection: string;
    /** Fallback fill color for items whose status is unmapped, empty or unknown. */
    unknown: string;
    /**
     * Per-quality default fill for grid cells whose bin carries the conventional
     * quality string `pass` (case-insensitive) and whose bin CODE is not in the
     * status-color mapping. See {@link resolveBinColor} for the full precedence.
     */
    binPass: string;
    /**
     * Per-quality default fill for grid cells whose bin carries the conventional
     * quality string `fail` (case-insensitive) and whose bin CODE is not in the
     * status-color mapping. See {@link resolveBinColor} for the full precedence.
     */
    binFail: string;
    /** Ready-to-use canvas font shorthand for labels. */
    labelFont: string;
    /** Label text color. */
    labelColor: string;
    /**
     * Mark colors for composed decoration layers, in layer order.
     *
     * SEPARATE FROM `StatusColorMapping` ON PURPOSE. A decoration marks that a
     * cell is NAMED by another overlay; it does not restate that overlay's bin as
     * a fill. `ws/notes/DECISION-overlay-composition.md` rejects the "stack"
     * alternative because blending two bin colors yields a color that maps back
     * to no bin code at all - and the moment a decoration draws from the bin
     * palette, that is what a viewer sees. So the palette is small, fixed and
     * about LAYERS, not about bins.
     *
     * Cycled when there are more layers than entries; four is already past what
     * is legible on one cell.
     */
    decoration: string[];
}

/** Valid anchor points on BBOX_S for the data-frame origin (see {@link makeDataMatrix}). */
export type OriginAnchor = 'center' | 'top-left' | 'bottom-left' | 'top-right' | 'bottom-right';

/** Direction of the data-frame Y axis (see {@link makeDataMatrix}). */
export type YAxisDirection = 'up' | 'down';

/**
 * The resolved transform chain and per-frame scalars handed from the shell to
 * {@link drawSubstrateMap}. `world` (W) and `data` (D2S) are CSS-pixel matrices
 * and do NOT contain the device-pixel-ratio factor - that enters only in
 * {@link applyMatrix}. `scale` is the uniform letterbox scale in CSS px per mm;
 * `fitBox` is the axis-aligned box W was fitted to ({@link fitBBox}: the outline
 * bbox, else the grid's extent, else the default substrate), or `null` when
 * there is nothing to draw. @internal
 */
export interface MapMatrices {
    /** Device-pixel-ratio base factor; the leftmost factor applied in {@link applyMatrix}. */
    dprBase: number;
    /** World matrix W = T(center) * Sc(s, -s) * VIEW, in CSS pixels. */
    world: DOMMatrix;
    /** Data->substrate matrix D2S, in millimeters (see {@link makeDataMatrix}). */
    data: DOMMatrix;
    /** Uniform letterbox scale in CSS pixels per millimeter (`0` when nothing is drawn). */
    scale: number;
    /** The box W was fitted to, or `null` when there is nothing to fit. */
    fitBox: BBox | null;
}

/** Margin in CSS pixels kept clear between the drawn construct and the canvas box. */
export const MARGIN_PX = 8;

/**
 * Screen-constant width in CSS pixels of the substrate body edge. Applied under
 * the world CTM as {@link EDGE_PX} / s millimeters, which the scaled CTM turns
 * back into a fixed {@link EDGE_PX} CSS px independent of the letterbox scale and
 * the device pixel ratio.
 */
export const EDGE_PX = 2;

/**
 * Screen-constant width in CSS pixels of the selection ring drawn on top of the
 * selected item. Applied as {@link SEL_PX} / s millimeters under the item CTM
 * (screen-constant, like {@link EDGE_PX}), and the same width as the edge.
 */
export const SEL_PX = 2;

/**
 * The scale `W` actually applies, in CSS pixels per millimeter.
 *
 * ---- WHY THIS IS NOT `matrices.scale` ----
 *
 * Every screen-constant width in this file is written `PX / s` millimeters, so
 * that stroking it under `W` yields `PX` on screen. That identity holds only when
 * `s` is the scale `W` really applies.
 *
 * `matrices.scale` is the FIT scale and deliberately EXCLUDES the author's
 * `ViewTransform`, because an author converting a pointer delta needs a
 * number that does not move as they zoom. Under a 2.5x transform the two differ by
 * 2.5, and a selection ring computed from the fit scale came out **5 px instead of
 * 2** — a ring thick enough to swallow a small cell whole.
 *
 * `hypot(world.a, world.b)` is the length of `W`'s first column, which for
 * `T(center) * Sc(s,-s) * R(rot)` is exactly `s` at any rotation. So this is a
 * no-op when no transform is bound and correct when one is. Under a NON-UNIFORM
 * transform there is no single answer; this takes the x axis, which is the
 * approximation the origin marker has always made.
 * @param matrices The frame's matrices.
 * @returns CSS pixels per millimeter under `W`, or the fit scale if degenerate.
 */
export function screenScale(matrices: MapMatrices): number {
    const h = Math.hypot(matrices.world.a, matrices.world.b);
    return h > 0 && Number.isFinite(h) ? h : matrices.scale;
}

/**
 * Minimum hittable band for stroked/outline geometries, in CSS pixels. Very thin
 * (or zero-width) lines are otherwise almost impossible to click, so
 * {@link getItemAtPos} clamps a stroke's hit width up to this. Applied as
 * {@link HIT_MIN_PX} / s' millimeters under the per-item hit CTM (s' = that CTM's
 * uniform scale; see {@link getItemAtPos}), it is a screen-constant tolerance -
 * independent of the letterbox scale, the map/origin rotation and the device
 * pixel ratio. It only widens the hit band, never the painted stroke, so the hit
 * area still follows paint (an outline is never hit through its hollow interior).
 */
export const HIT_MIN_PX = 4;

/**
 * Screen-constant length in CSS pixels of each origin-marker axis stub (the +x and
 * +y arms drawn from the data origin). Authored under the W * D2S CTM as
 * {@link ORIGIN_MARKER_STUB_PX} / s millimeters, so the scaled CTM turns it back
 * into a fixed CSS-pixel length independent of the letterbox scale and the device
 * pixel ratio - the same screen-constant idiom as {@link EDGE_PX}.
 */
export const ORIGIN_MARKER_STUB_PX = 18;

/** Screen-constant half-length in CSS pixels of the origin-marker center crosshair arms (a small `+` on the data origin). */
export const ORIGIN_MARKER_CROSS_PX = 5;

/**
 * Smallest a decoration wedge may be drawn, in CSS pixels.
 *
 * A floor, not a size: the wedge is half a cell and only grows to this when the
 * cell itself is smaller. Without it a decoration silently vanishes at low zoom
 * - the one failure mode a mark must not have, since the whole point of a
 * decoration is that it is noticed.
 */
export const DECORATION_MIN_PX = 6;

/** Screen-constant arrowhead barb length in CSS pixels for the origin-marker axis heads. */
export const ORIGIN_MARKER_HEAD_PX = 6;

/** Screen-constant spacing in CSS pixels between the two chevrons of the +y (double) arrowhead. */
export const ORIGIN_MARKER_DOUBLE_GAP_PX = 4;

/** Screen-constant stroke width in CSS pixels of the whole origin marker (matches {@link EDGE_PX}). */
export const ORIGIN_MARKER_WIDTH_PX = 2;

/**
 * Assembles a {@link MapConfig} from a canvas client size using the shared
 * {@link MARGIN_PX}. Pure: the shell reads the canvas and calls this.
 * @param width  Canvas client width in CSS pixels.
 * @param height Canvas client height in CSS pixels.
 * @returns The drawing configuration.
 */
export function makeConfig(width: number, height: number): MapConfig {
    return { center: { x: width / 2, y: height / 2 }, width, height, margin: MARGIN_PX };
}

/**
 * Uniform, letterboxed CSS-pixels-per-millimeter scale that fits a box of the
 * given size into the drawing box minus the margin on both axes. No per-axis
 * stretch (which keeps circles circular and arcs un-distorted). The caller passes
 * the extent of the fit box ({@link fitBBox}).
 * @param cfg    Drawing configuration.
 * @param width  Fit-box width in millimeters.
 * @param height Fit-box height in millimeters.
 * @returns The scale (`<= 0` for a degenerate box or fit size).
 */
export function computeScale(cfg: MapConfig, width: number, height: number): number {
    if (width <= 0 || height <= 0) {
        return 0;
    }
    const sx = (cfg.width - 2 * cfg.margin) / width;
    const sy = (cfg.height - 2 * cfg.margin) / height;
    return Math.min(sx, sy);
}

/**
 * Axis-aligned extent of `bbox` after rotating it by `rad` (CCW-positive): the
 * width and height of the smallest upright box that still contains the rotated
 * rectangle. Feeds {@link computeScale} so the letterbox fit grows with the
 * {@link makeWorldMatrix} view rotation (VIEW) and the turning construct is
 * never clipped.
 *
 * CONSERVATIVE BY DESIGN (documented decision): the four CORNERS of `bbox` are
 * rotated, NOT the outline contour, so a shape that does not fill its bounding
 * box (a disc, a wafer with a flat) is over-boxed - a 45deg-rotated square is
 * fitted as its ~sqrt(2)-larger diagonal box and thus gets extra margin. This
 * buys a fit that never depends on sampling the geometry, at the cost of a
 * little screen area. The result is invariant to the rotation CENTER (a rigid
 * rotation only translates the corner set, and an extent is translation-
 * invariant) and to the SIGN of `rad` (+rad and -rad give mirror-image boxes of
 * equal size), so at `rad = 0` it returns the box's own width/height unchanged -
 * the neutral case that keeps the unrotated fit bit-identical to before.
 * @param bbox The box to rotate (any +y direction; only its extent is used).
 * @param rad  View rotation in radians (CCW-positive; the sign does not affect the result).
 * @returns The rotated box's axis-aligned width `w` and height `h` (both `>= 0`).
 */
export function rotatedExtent(bbox: BBox, rad: number): { w: number; h: number } {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corners: ReadonlyArray<readonly [number, number]> = [
        [bbox.minX, bbox.minY],
        [bbox.maxX, bbox.minY],
        [bbox.maxX, bbox.maxY],
        [bbox.minX, bbox.maxY],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of corners) {
        const rx = x * cos - y * sin;
        const ry = x * sin + y * cos;
        if (rx < minX) { minX = rx; }
        if (rx > maxX) { maxX = rx; }
        if (ry < minY) { minY = ry; }
        if (ry > maxY) { maxY = ry; }
    }
    return { w: maxX - minX, h: maxY - minY };
}

/**
 * The substrate extent assumed when nothing else declares one: a 200 mm square
 * centered on the substrate origin, in millimeters.
 *
 * WHY A CONSTANT AND NOT THE CONTENT. A wafer has a size before
 * anyone puts anything on it. Deriving the extent from the items meant every
 * added item re-fitted the substrate, which is visible and is what the field
 * reported. Deriving it from the FIRST content and latching would have made the
 * result depend on arrival order, which is worse than a documented guess.
 *
 * WHY 200. It is the bounding size of a 200 mm wafer, the most common production
 * substrate, and it is only ever used when the author has told the control
 * nothing at all: no `Outline`, no `OutlinePreset`, no grid. Anyone who knows
 * their substrate says so, and then this constant is not consulted.
 */
export const DEFAULT_SUBSTRATE_EXTENT_MM = 200;

/**
 * {@link DEFAULT_SUBSTRATE_EXTENT_MM} as a box, centered on the substrate origin.
 *
 * Frozen: it is returned directly rather than copied, and a caller that mutated
 * it would move every future fallback fit in the process.
 */
export const DEFAULT_SUBSTRATE_BBOX: BBox = Object.freeze({
    minX: -DEFAULT_SUBSTRATE_EXTENT_MM / 2, maxX: DEFAULT_SUBSTRATE_EXTENT_MM / 2,
    minY: -DEFAULT_SUBSTRATE_EXTENT_MM / 2, maxY: DEFAULT_SUBSTRATE_EXTENT_MM / 2,
}) as BBox;

/**
 * Selects the canvas fit box, in tiers (the fit precedence): the outline's
 * bounding box when an outline is bound; otherwise a present cell grid's drawn
 * extent; otherwise a default substrate of {@link DEFAULT_SUBSTRATE_EXTENT_MM}.
 * Items never take part (see the note in the body). Without an outline,
 * {@link drawSubstrateMap} draws no substrate body.
 *
 * A bound outline therefore fits BBOX_S exactly, which keeps "the outline's bbox
 * defines the fit box and the origin anchor" literally true - {@link makeDataMatrix}
 * anchors the data frame on this very box, so letting a grid widen it would
 * silently move every Item the moment a grid appears. In the physical case (a
 * die grid lies inside its substrate) a union with the outline box would be a
 * no-op anyway; the only behavioral difference is that a grid extending BEYOND a
 * bound outline is clipped rather than zoomed away from, which is the treatment
 * out-of-substrate items get too. A grid-only scene fits and paints through the
 * second tier.
 * @param outline The built outline model, or `null`.
 * @param items   The render-ready items. **Deliberately unused** — kept in the
 *                signature because a reader of the call site must be able to see
 *                that the items were offered and refused, which a shorter
 *                signature would hide.
 * @param grid    The render-ready cell grid, or `null`. Optional so that callers
 *                predating the grid layer stay source-compatible.
 * @returns The fit box in the common millimeter frame. Never `null`: the last
 *          tier is a constant.
 */
export function fitBBox(outline: OutlineModel | null, items: ItemModel[], grid: GridModel | null = null): BBox {
    if (outline) {
        return outline.bbox;
    }
    /*
     * NO ITEMS HERE. Unioning them into the box, with no outline and no preset
     * bound, gives:
     *
     *     1 item   ->   8.0 x 8.0 mm centered at ( 0, 0)
     *     2 items  ->  28.0 x 8.0 mm centered at (10, 0)
     *     5 items  ->  88.0 x 8.0 mm centered at (40, 0)
     *
     * Every added item would move BOTH the scale and the center, because this
     * box feeds the letterbox scale AND the origin anchor: a wafer that visibly
     * changes size as items are drawn on it.
     *
     * A substrate has a size before anything is placed on it, so content does
     * not get to define it. Items are drawn ON the substrate and never
     * ARE it.
     */
    void items;
    const g = gridBBox(grid);
    if (g) {
        // A grid is substrate-defining in a way items are not: its extent comes
        // from stepSize x cols/rows, which is a physical property of the map
        // rather than of what happens to be on it, and adding an item cannot
        // move it. It stays a tier.
        return g;
    }
    return DEFAULT_SUBSTRATE_BBOX;
}

/**
 * Builds the world matrix W = T(center) * Sc(s, -s) * VIEW in CSS pixels. The
 * single axis flip Sc(s, -s) lives here, which is exactly why source angles are
 * passed unchanged to the rotation matrices and still render CCW on screen (see
 * the angle sign rule).
 *
 * VIEW = R(mapRotation): the caller passes the resolved `MapRotation` (radians)
 * and the whole construct - outline, items, labels and origin marker, all drawn
 * under `W` or `W * D2S` - turns with it about the substrate frame origin. `0`
 * leaves VIEW the identity (the neutral, unrotated view), which is why the
 * default keeps every pre-rotation caller unchanged. The fit must grow to match
 * (the caller scales with {@link rotatedExtent}) or a non-zero rotation clips.
 * @param cfg            Drawing configuration.
 * @param s              Uniform letterbox scale in CSS px per mm.
 * @param mapRotationRad View rotation in radians, CCW-positive on screen (0 = unrotated).
 * @returns The world matrix (CSS pixels; no device-pixel-ratio factor).
 */
export function makeWorldMatrix(cfg: MapConfig, s: number, mapRotationRad: number = 0): DOMMatrix {
    const m = new DOMMatrix();
    m.translateSelf(cfg.center.x, cfg.center.y);           // T(center)
    m.scaleSelf(s, -s);                                    // * Sc(s, -s)  (the one axis flip)
    m.rotateSelf(mapRotationRad * 180 / Math.PI);          // * VIEW = R(mapRotation); 0 => identity
    return m;
}

/**
 * Selects the anchor point A on a bounding box for a given {@link OriginAnchor},
 * in the frame the box is expressed in. The box is the substrate frame S bbox
 * (BBOX_S) when an outline is bound, or the fallback box of {@link fitBBox} -
 * both are +y-up millimeter frames, so `'top'` is the +y (max) edge and
 * `'left'` the -x (min) edge. `'center'` is the box center; the four corners take
 * the matching min/max edges. Pure.
 * @param bbox     The bounding box the anchor is selected on (+y up).
 * @param location Which anchor point to take.
 * @returns The anchor point in the box's frame (millimeters).
 */
export function anchor(bbox: BBox, location: OriginAnchor): Point {
    const cx = (bbox.minX + bbox.maxX) / 2;
    const cy = (bbox.minY + bbox.maxY) / 2;
    switch (location) {
        case 'center':       return { x: cx,        y: cy        };
        case 'top-left':     return { x: bbox.minX, y: bbox.maxY };   // left = -x edge, top = +y edge
        case 'bottom-left':  return { x: bbox.minX, y: bbox.minY };
        case 'top-right':    return { x: bbox.maxX, y: bbox.maxY };
        case 'bottom-right': return { x: bbox.maxX, y: bbox.minY };
        default: {
            const _never: never = location;
            return _never;
        }
    }
}

/**
 * Builds the data->substrate matrix D2S in millimeters:
 *   D2S = T(A + offset) * R(originRotation) * Sc(1, ydir)
 * where A is the {@link anchor} point for `location` on `anchorBBox`, `offset` is
 * (offsetX, offsetY) in millimeters expressed along the SUBSTRATE axes (+y up,
 * independent of `ydir`), `originRotation` is `rotationRad` (CCW-positive in S)
 * and `ydir` mirrors the D y axis (`'down'` => Sc(1, -1)).
 *
 * `anchorBBox` is the fit box the shell selected ({@link fitBBox}): the outline's
 * BBOX_S when an outline is bound, else the grid's extent, else the default
 * substrate, so the anchor tracks whatever the map fits. `null` collapses the
 * anchor to the origin, which is irrelevant because the draw/hit guards skip a
 * scene with no fit box.
 *
 * The matrix is authored in +y-up space and its rotation angle is passed
 * unchanged (no sign factor): the chain's single axis flip lives in W
 * ({@link makeWorldMatrix}), so a CCW-positive `rotationRad` renders CCW on
 * screen. With `ydir === 'down'` the D handedness flips, so a CCW-positive item
 * orientation authored in that y-down frame then appears clockwise on screen -
 * the intended physical behavior (the angle sign rule).
 * @param anchorBBox  The bbox the anchor is selected on (outline BBOX_S or the fallback box), or `null`.
 * @param location    Anchor point on the bbox (default 'center').
 * @param offsetX     Extra translation along S +x in millimeters (default 0).
 * @param offsetY     Extra translation along S +y in millimeters (default 0).
 * @param rotationRad Data-axes rotation about the origin, CCW-positive in S (default 0).
 * @param ydir        Data Y-axis direction (default 'up').
 * @returns The data->substrate matrix (identity for the neutral 'center'/0/0/'up' inputs on a centered bbox).
 */
export function makeDataMatrix(
    anchorBBox: BBox | null,
    location: OriginAnchor = 'center',
    offsetX: number = 0,
    offsetY: number = 0,
    rotationRad: number = 0,
    ydir: YAxisDirection = 'up',
): DOMMatrix {
    const a = anchorBBox ? anchor(anchorBBox, location) : { x: 0, y: 0 };
    const m = new DOMMatrix();
    m.translateSelf(a.x + offsetX, a.y + offsetY);         // T(A + offset)
    m.rotateSelf(rotationRad * 180 / Math.PI);             // * R(originRotation)  (CCW-positive; no sign factor)
    m.scaleSelf(1, ydir === 'down' ? -1 : 1);              // * Sc(1, ydir)  (the D-frame y mirror)
    return m;
}

/**
 * Any 2D context the engine paints into: the control's on-screen canvas, or the
 * {@link GridLayerCache}'s offscreen bitmap. The two DOM types are unrelated
 * nominally but share every member the engine uses, so the union keeps ONE code
 * path (and therefore one transform chain) for both. @internal
 */
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Builds the device-pixel product `Sc(dprBase) * m`: the device-pixel-ratio
 * factor as the leftmost factor on top of the CSS-pixel matrix `m` (a world or
 * world*data*item product). This is the ONE place the dpr enters the chain;
 * {@link applyMatrix} pushes the product onto a context, and the grid layer needs
 * the product itself (to derive its device-space extent and its inverse), so the
 * two cannot drift apart.
 * @param dprBase Device pixel ratio (leftmost scale factor).
 * @param m       CSS-pixel transform to scale into device pixels.
 * @returns The device-pixel matrix `Sc(dprBase) * m`.
 */
export function deviceMatrix(dprBase: number, m: DOMMatrix): DOMMatrix {
    return new DOMMatrix([dprBase, 0, 0, dprBase, 0, 0]).multiplySelf(m);
}

/**
 * Sets the context CTM to `dprBase * m` (see {@link deviceMatrix}): the
 * device-pixel-ratio factor enters ONLY here, as the leftmost factor, on top of
 * the CSS-pixel matrix `m` (a world or world*data*item product). Draw sets `m`;
 * the hit-test uses the SAME `m` with `dprBase = 1` ({@link getItemAtPos}) or
 * inverts it analytically ({@link getCellAtPos}), keeping the painted shape and
 * the hit region identical.
 * @param ctx     2D context (on-screen or offscreen; see {@link Context2D}).
 * @param dprBase Device pixel ratio (leftmost scale factor).
 * @param m       CSS-pixel transform to apply under the dpr base.
 */
export function applyMatrix(ctx: Context2D, dprBase: number, m: DOMMatrix): void {
    const t = deviceMatrix(dprBase, m);
    ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
}

/**
 * Builds an item's own-orientation matrix T(c) * R(theta) * T(-c) in the data
 * frame (millimeters): rotate the item's combined geometry about its bbox center
 * by its source angle. CCW-positive and un-corrected - the axis flip is in W.
 * @param item The item model.
 * @returns The item matrix (millimeters).
 */
function itemMatrix(item: ItemModel): DOMMatrix {
    const m = new DOMMatrix();
    m.translateSelf(item.cx, item.cy);            // T(c)
    m.rotateSelf(item.angle * 180 / Math.PI);     // * R(theta)  (CCW-positive; no sign factor)
    m.translateSelf(-item.cx, -item.cy);          // * T(-c)
    return m;
}

/**
 * Draws one label upright and clipped to its box. The box CENTER is mapped from
 * data-frame millimeters to CSS pixels through `cssMatrix` (= W * D2S, which
 * carries the y-flip and the view rotation), then the glyphs are drawn in upright
 * CSS-pixel space under the dpr base - so the box rides the map's flip, scale and
 * rotation while the text itself never inherits any of them and stays upright and
 * readable. The box is an axis-aligned `w*s` x `l*s` rectangle.
 * @param ctx       2D context.
 * @param label     Render-ready label (box + text, data-frame millimeters).
 * @param cssMatrix World*data CSS-pixel matrix used to place the box center.
 * @param dprBase   Device pixel ratio (upright glyph space is `Sc(dprBase)`).
 * @param s         Uniform letterbox scale (CSS px per mm) for the box size.
 * @param colors    Resolved colors (label font + color).
 */
function drawLabel(
    ctx: CanvasRenderingContext2D,
    label: LabelModel,
    cssMatrix: DOMMatrix,
    dprBase: number,
    s: number,
    colors: SubstrateMapColors,
): void {
    const boxW = label.w * s;
    const boxH = label.l * s;
    if (boxW <= 0 || boxH <= 0 || label.text === '') {
        return;
    }
    const c = cssMatrix.transformPoint(new DOMPoint(label.x, label.y));
    ctx.save();
    ctx.setTransform(dprBase, 0, 0, dprBase, 0, 0);   // upright CSS-pixel space
    ctx.beginPath();
    ctx.rect(c.x - boxW / 2, c.y - boxH / 2, boxW, boxH);
    ctx.clip();
    ctx.fillStyle = colors.labelColor;
    ctx.font = colors.labelFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.text, c.x, c.y);
    ctx.restore();
}

/**
 * Builds the origin marker as ONE {@link Path2D} authored in the data frame D
 * (millimeters, +y up before the D2S y-flip), sized so that under the W * D2S CTM
 * every feature renders at a fixed CSS-pixel size: a small center crosshair (a `+`
 * on the exact data origin) plus a +x and a +y axis stub, each with an arrowhead.
 * The two axes are told apart by arrowhead COUNT, not color - +x carries a single
 * chevron, +y a double one - so the marker stays legible for color-blind viewers
 * and in a single ink (no red/green pairing anywhere). All lengths are the
 * `ORIGIN_MARKER_*_PX / s` millimeters that {@link EDGE_PX} uses (s = uniform
 * letterbox scale, CSS px per mm), so the scaled CTM maps them back to their
 * CSS-pixel constants regardless of zoom or device pixel ratio.
 *
 * Authoring the stubs in D (rather than pre-rotated in screen space) is exactly
 * what makes the marker report the data placement for free: stroked under W * D2S
 * it inherits the origin's position and {@link makeDataMatrix}'s R(originRotation)
 * and Sc(1, ydir), so OriginRotation turns the whole marker and YAxisDirection
 * 'down' flips the +y stub (and its double head) to point downward on screen - the
 * true direction of the authored y axis. The +x stub is unaffected by the y flip.
 * @param s Uniform letterbox scale in CSS pixels per millimeter (must be `> 0`).
 * @returns The marker path in data-frame millimeters, ready to stroke under W * D2S.
 */
export function buildOriginMarkerPath(s: number, sideMirror = false): Path2D {
    const mm = (px: number): number => px / s;          // CSS px -> data-frame mm under W * D2S
    const stub = mm(ORIGIN_MARKER_STUB_PX);
    const cross = mm(ORIGIN_MARKER_CROSS_PX);
    const head = mm(ORIGIN_MARKER_HEAD_PX);
    const gap = mm(ORIGIN_MARKER_DOUBLE_GAP_PX);
    const barb = head * 0.55;                            // perpendicular half-spread of a chevron
    // The marker rides W * D2S, which carries the view rotation and the y-flip
    // but NOT the side mirror - that lives in the placement's step vectors, so
    // the cells mirror and this path would not. Authoring +x along -x when the
    // lattice is mirrored puts the stub back on the axis it is describing.
    // Only x is flipped: the mirror is about the vertical axis, y is unchanged.
    const sx = sideMirror ? -1 : 1;
    const path = new Path2D();

    // Center crosshair: a small `+` on both axes, marking the exact data origin.
    path.moveTo(-sx * cross, 0); path.lineTo(sx * cross, 0);
    path.moveTo(0, -cross); path.lineTo(0, cross);

    // +x axis stub (from the crosshair edge to the tip) with a SINGLE chevron head.
    path.moveTo(sx * cross, 0); path.lineTo(sx * stub, 0);
    path.moveTo(sx * stub, 0); path.lineTo(sx * (stub - head), barb);
    path.moveTo(sx * stub, 0); path.lineTo(sx * (stub - head), -barb);

    // +y axis stub with a DOUBLE chevron head (two stacked chevrons => "+y", the
    // color-free distinction from +x). Authored along +y in D; the D2S y-flip and
    // W turn YAxisDirection 'down' into a downward stub on screen automatically.
    path.moveTo(0, cross); path.lineTo(0, stub);
    path.moveTo(0, stub); path.lineTo(sx * barb, stub - head);
    path.moveTo(0, stub); path.lineTo(-sx * barb, stub - head);
    path.moveTo(0, stub - gap); path.lineTo(sx * barb, stub - gap - head);
    path.moveTo(0, stub - gap); path.lineTo(-sx * barb, stub - gap - head);

    return path;
}

/**
 * Draws the origin marker on top of the scene, under the world*data CTM
 * `cssMatrix` (= W * D2S) so it sits at, turns with and mirrors with the data
 * frame (see {@link buildOriginMarkerPath}). Stroked once in the selection color
 * with a screen-constant width ({@link ORIGIN_MARKER_WIDTH_PX} / s mm, the
 * {@link EDGE_PX} idiom). Purely diagnostic: the marker is never added to the hit
 * index, so it is not selectable and never intercepts pointer input.
 * @param ctx       2D context (its CTM is overwritten).
 * @param cssMatrix World*data CSS-pixel matrix (W * D2S).
 * @param dprBase   Device pixel ratio (leftmost factor in {@link applyMatrix}).
 * @param s         Uniform letterbox scale (CSS px per mm); the stub/head/width scale.
 * @param color     Stroke color (the resolved selection color).
 * @param sideMirror Whether the lattice is mirrored, so the `+x` stub points
 *                   the way the cells actually run.
 */
function drawOriginMarker(
    ctx: CanvasRenderingContext2D,
    cssMatrix: DOMMatrix,
    dprBase: number,
    s: number,
    color: string,
    sideMirror: boolean,
): void {
    applyMatrix(ctx, dprBase, cssMatrix);
    ctx.strokeStyle = color;
    ctx.lineWidth = ORIGIN_MARKER_WIDTH_PX / s;         // screen-constant under W * D2S
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(buildOriginMarkerPath(s, sideMirror));
}

// ===================================================================
//  Cell grid layer  (generic, format-neutral)
//
//  A rectangular lattice of up to ~1e6 sub-millimeter cells (RFID structures on
//  a 300 mm wafer are the design driver), so PER-CELL OBJECTS ARE BANNED end to
//  end: the model is two typed arrays plus a small per-BIN table, the renderer
//  allocates nothing per cell, and the hit-test is O(1) arithmetic. The layer is
//  FORMAT-NEUTRAL - it knows nothing about SEMI E142 or any other wire format.
//  The input-path tasks decode their format into a {@link GridPlacement} plus a
//  {@link DecodedBinPayload} and hand those to {@link buildGridModel}; from there
//  on the engine sees numbers only.
//
//  FRAME: the lattice is authored in the SUBSTRATE frame S (+y up, millimeters),
//  like the Outline and unlike the Items (frame D). It is therefore drawn and
//  hit-tested under `W` ALONE - never under `W * D2S`. The Origin* attributes
//  place the ITEM data frame and must not move the grid.
//
//  LATTICE COORDINATES (a, b) - the one parametrization draw and hit-test share:
//      p_S(a, b) = origin + a * colStep + b * rowStep
//  For cell (c, r): p_S(c, r) is its lattice/origin corner, its pitch cell is
//  the image of [c, c+1] x [r, r+1], and its DRAWN rectangle is centered on the
//  pitch-cell center p_S(c + 0.5, r + 0.5), measuring cellWmm along the column
//  direction and cellLmm along the row direction. In lattice coordinates that
//  drawn cell is simply the axis-aligned box
//      |a - (c + 0.5)| <= halfA,   |b - (r + 0.5)| <= halfB
//  with halfA = cellWmm / (2 * |colStep|) and halfB = cellLmm / (2 * |rowStep|)
//  ({@link gridHalfA} / {@link gridHalfB}). For the orthogonal step bases the
//  contract promises (any AxisDirection sign combination, any Orientation) that
//  box IS the metric cellWmm x cellLmm rectangle, because rowStep contributes
//  nothing along the column direction and vice versa. The renderer draws the box
//  by pushing the lattice basis onto the CTM (so `fillRect` paints it), and the
//  hit-test recovers (a, b) by inverting the very same basis - which makes draw
//  and hit-test exact inverses by construction, under MapRotation, under a
//  device-pixel ratio, and even under an out-of-contract skewed basis, where both
//  degrade to the same parallelogram.
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
    /** Whether the lattice was reflected about the S-frame vertical axis (see E142.computeGridPlacement). */
    sideMirror: boolean;
}

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
 */
export interface DecodedBinPayload {
    cols: number;
    rows: number;
    cells: Uint32Array;
    codes: string[];
    /** Per-cell LIDs, keyed by the row-major linear index (see E142.DecodedBinPayload). */
    lids?: ReadonlyMap<number, string>;
}

/**
 * One bin definition as handed to {@link buildGridModel}: the per-CODE metadata
 * an input path decoded from its own format. Format-neutral by design - the
 * engine never learns where `quality` came from - and deliberately a superset of
 * nothing: only the three fields the grid model needs are read.
 *
 * `quality` is a FREE STRING, not an enumeration; the conventional values
 * `pass` / `fail` get per-quality default colors ({@link resolveBinColor}) and
 * every other value falls back to the unknown color.
 */
export interface BinDefinition {
    /** The bin code this definition describes; joined against {@link DecodedBinPayload.codes}. */
    code: string;
    /** Free-form quality string, or absent/`null` when the source did not supply one. */
    quality?: string | null;
    /** Whether devices of this bin are selected for downstream pick-and-place. Absent => `false`. */
    pick?: boolean;
}


/**
 * One extra `BinCodeMap` overlay's cells, over the SAME lattice as the base.
 *
 * NOT {@link GridLayer}, and the two must not be confused - which is why this is
 * `GridBinLayer`. `GridLayer` is a RENDER BUNDLE: a model plus the current
 * selection, a data version and the caller's cache, handed to
 * {@link drawSubstrateMap} once per frame. This is a DATA layer: one more
 * overlay's bin codes for the same cells. `GridLayer` was already taken, and
 * shadowing it would have made two unrelated things read alike at every call
 * site.
 *
 * WHAT IT IS FOR. `ws/notes/DECISION-overlay-composition.md` chose "base layer
 * plus ordered decorations": one `BinCodeMap` owns the fill and the geometry,
 * and further overlays contribute per-cell MARKS. This carries what a decoration
 * needs per cell - its bin - and deliberately carries no color, no opacity and
 * no z-index. Order is the array's; appearance belongs to a separate attribute,
 * because the moment a layer brings its own fill the rejected "stack"
 * alternative is back in through the styling.
 *
 * SAME LATTICE, ENFORCED. E142-0225 13.1 defines an Overlay as "an array of data
 * that corresponds to the dimensions on the Layout to which the containing
 * SubstrateMap is assigned", in the words of E142-0225 13.1 - one `LayoutSpecifier` per
 * `SubstrateMap`, hence one lattice, hence every overlay is an array over it. A
 * layer whose extent differs is not a second lattice, it is a malformed overlay,
 * and {@link buildGridModel} refuses it rather than cropping or scaling: a
 * cropped decoration silently marks the WRONG dies and nothing on screen says so.
 */
export interface GridBinLayer {
    /** `Overlay/@MapName` of the overlay this came from. */
    mapName: string;
    /** `Overlay/@MapVersion`. With {@link mapName} this is `OverlayKey`, so the pair identifies the layer. */
    mapVersion: string;
    /** Per-cell bin index, row-major, at least `cols * rows` long. Adopted BY REFERENCE, like the base's. */
    cells: Uint32Array;
    /** The bins {@link cells} indexes; entry 0 is the reserved null bin. */
    binTable: BinTableEntry[];
}

/**
 * A layer could not be composed onto the base grid.
 *
 * A TYPED error rather than a `null` return, deliberately: {@link buildGridModel}
 * already returns `null` for "there is nothing to draw", which a caller handles
 * by drawing nothing. A layer that disagrees with the base is a different thing -
 * the base is fine and the DOCUMENT is wrong - and collapsing the two would let a
 * malformed decoration silently blank a perfectly good map.
 */
export class GridLayerError extends Error {
    /** A stable `E142_LAYER_*` code. */
    public readonly code: string;

    /** `Overlay/@MapName` of the offending layer. */
    public readonly mapName: string;

    /**
     * @param code    A stable `E142_LAYER_*` code.
     * @param mapName The offending layer's `MapName`.
     * @param message What is wrong, and why it is not worked around.
     */
    public constructor(code: string, mapName: string, message: string) {
        super(`${message} (layer ${JSON.stringify(mapName)})`);
        this.name = 'GridLayerError';
        this.code = code;
        this.mapName = mapName;
    }
}

/**
 * Render-ready cell grid: the placement, the lattice size, the per-cell bin
 * INDICES and the per-bin table those indices address. Produced by
 * {@link buildGridModel}; drawn by {@link drawSubstrateMap} and hit-tested by
 * {@link getCellAtPos}.
 *
 * Index 0 of {@link binTable} is the reserved NULL BIN: `cells[i] === 0` means
 * the cell is absent / not tested / outside the substrate. It is NEVER painted
 * and NEVER hit, so the null cell needs no color and no bin definition (the row
 * is still built, so that `binTable[i]` is a 1:1 image of `codes[i]` at every
 * index and no consumer needs an off-by-one).
 *
 * INVARIANT established by {@link buildGridModel} and relied upon by both hot
 * loops: every one of the first `cols * rows` entries of {@link cells} is a
 * valid index into {@link binTable}. That is checked ONCE at build time so the
 * per-cell and per-pixel paths can index without a bounds branch.
 */
export interface GridModel {
    /** The lattice placement in the substrate frame S. */
    placement: GridPlacement;
    /** Number of lattice columns (`> 0`). */
    cols: number;
    /** Number of lattice rows (`> 0`). */
    rows: number;
    /**
     * Per-cell bin index, row-major (`cells[row * cols + col]`), at least
     * `cols * rows` long. Adopted BY REFERENCE from the payload - a 1e6-cell map
     * is not copied - so the caller must treat it as owned by the model.
     */
    cells: Uint32Array;
    /** The bins `cells` indexes; entry 0 is the reserved null bin. */
    binTable: BinTableEntry[];
    /**
     * Per-cell location identifiers from the payload, same linear index as
     * {@link cells}. Absent when the map named no cells. Adopted by reference;
     * see {@link DecodedBinPayload.lids} for why it is a sparse Map.
     */
    lids?: ReadonlyMap<number, string>;
    /**
     * Extra overlays' cells over the same lattice, in the caller's order.
     *
     * ABSENT, not empty, when there are none - so a consumer can branch on
     * presence and today's single-overlay path is reached without looping over
     * an empty array. THE ORDER IS THE CALLER'S: `OverlayKey` is (`MapName`,
     * `MapVersion`), a set rather than a sequence, so the document declares no
     * z-order and one must not be inferred from element order.
     *
     * Every entry is guaranteed to span at least `cols * rows` cells and to
     * index its own `binTable` - {@link buildGridModel} checks both and throws
     * {@link GridLayerError} rather than handing back a model a renderer would
     * have to re-validate every frame.
     */
    layers?: GridBinLayer[];
    /**
     * One byte per cell: non-zero when ANY layer decorates it, `null` when there
     * are no layers.
     *
     * Built once here rather than per frame, because it is a function of the
     * document and the layer list and neither changes between frames. An
     * undecorated map gets `null` and pays nothing at all - not an allocation, not
     * a branch in the inner loop beyond the one that reads this field.
     *
     * It exists because `renderGridDecorations` draws from `DECORATION_MIN_PX`, and
     * under aggregation cells are subpixel, so decorations vanish entirely and
     * silently: a map with three overlays looks like a map with one. The aggregate
     * cannot draw the wedges - there is no room - but it can say they are there.
     */
    decorated?: Uint8Array | null;
}

/**
 * A hit cell as reported by {@link getCellAtPos}: its lattice coordinates and the
 * row-major LINEAR INDEX `row * cols + col` - the same index the shell uses as
 * the `itemId` of a `{ kind: 'cell' }` selection entry, and the index into
 * {@link GridModel.cells}.
 */
export interface CellHit {
    /** Lattice column, `0 <= col < cols`. */
    col: number;
    /** Lattice row, `0 <= row < rows`. */
    row: number;
    /** Row-major linear index `row * cols + col`. */
    index: number;
}

/**
 * Device pixels per cell at or above which the grid layer uses the batched
 * `fillRect` run strategy, and below which it uses direct {@link ImageData}
 * writes (see {@link renderGridLayer}).
 *
 * WHERE THE NUMBER COMES FROM: a run of same-colored cells costs one `fillRect`
 * (call overhead plus rasterization), i.e. roughly a constant `C_rect` per cell
 * once runs are short; a pixel write costs a constant `C_px`. A cell covers
 * `k^2` pixels at `k` pixels per cell, so per-cell work wins while
 * `C_rect < k^2 * C_px`, i.e. below `k = sqrt(C_rect / C_px)`. With the usual
 * order of magnitude for a 2D canvas (`C_rect` ~ 1e2 ns of call + setup,
 * `C_px` ~ 1e1 ns of arithmetic + store) that crossover sits at `k ~ 3`. Below
 * it the per-pixel path is additionally BOUNDED BY THE SCREEN rather than by the
 * cell count - many cells collapse onto one pixel - which is exactly the regime
 * the 1e6-cell design driver lives in.
 */
export const GRID_RUN_STRATEGY_PX = 3;

/**
 * Relative tolerance for "the drawn cell fills its pitch cell along the column
 * axis", i.e. for merging a run of same-colored cells into ONE `fillRect`. Only
 * a street-free lattice (`cellWmm === |colStep|`) may merge; anything narrower
 * leaves gaps that must stay unpainted.
 */
const GRID_MERGE_EPS = 1e-9;

/**
 * Half-extent of a drawn cell along the COLUMN axis in lattice units (see the
 * section header): `cellWmm / (2 * |colStep|)`, clamped to `[0, 0.5]`.
 *
 * The clamp enforces the contract's `cellWmm <= pitch` rather than trusting it:
 * a wider cell would overlap its neighbors, and since the hit-test resolves a
 * point to exactly one cell via `floor(a)`, an overlap would make the painted
 * region and the hit region disagree - the one thing the hit-test invariant
 * forbids. Clamped, cells tile at worst and never overlap.
 * @param p The lattice placement.
 * @returns The half-extent in lattice units, `0` for a degenerate column step.
 */
export function gridHalfA(p: GridPlacement): number {
    const len = Math.hypot(p.colStepXmm, p.colStepYmm);
    return len > 0 ? Math.min(0.5, Math.max(0, p.cellWmm / (2 * len))) : 0;
}

/**
 * Half-extent of a drawn cell along the ROW axis in lattice units:
 * `cellLmm / (2 * |rowStep|)`, clamped to `[0, 0.5]`. The row-axis twin of
 * {@link gridHalfA}; see there for the reasoning behind the clamp.
 * @param p The lattice placement.
 * @returns The half-extent in lattice units, `0` for a degenerate row step.
 */
export function gridHalfB(p: GridPlacement): number {
    const len = Math.hypot(p.rowStepXmm, p.rowStepYmm);
    return len > 0 ? Math.min(0.5, Math.max(0, p.cellLmm / (2 * len))) : 0;
}

/**
 * Builds the matrix of the lattice basis: `(a, b) -> S` in millimeters, i.e.
 * `[colStep rowStep | origin]`. Pushed onto the CTM (pre-multiplied by `W`, and
 * by the dpr base) it turns every drawn cell into an axis-aligned unit-ish box,
 * so the renderer can use plain `fillRect` and still inherit MapRotation, the
 * axis flip and all four AxisDirection sign combinations for free.
 * @param p The lattice placement.
 * @returns The lattice matrix (millimeters).
 */
export function latticeMatrix(p: GridPlacement): DOMMatrix {
    return new DOMMatrix([p.colStepXmm, p.colStepYmm, p.rowStepXmm, p.rowStepYmm, p.originXmm, p.originYmm]);
}

/**
 * Builds a {@link BinTableEntry} table from a payload's codes and optional
 * definitions.
 *
 * Extracted so a decoration layer can be built the SAME way the base is.
 * Duplicating the loop in the control would let the two drift - and the drift
 * would show up as a decoration whose `quality` or `pick` disagreed with the
 * identical bin on the base, which is the kind of difference nobody looks for.
 *
 * @param codes   The payload's distinct bin codes; index 0 is the null bin.
 * @param binDefs Definitions to join, first-wins on a duplicate code, or `null`.
 * @returns One entry per code, in the same order.
 */
export function buildBinTable(codes: readonly string[], binDefs: BinDefinition[] | null): BinTableEntry[] {
    const defs = new Map<string, BinDefinition>();
    if (binDefs) {
        for (const d of binDefs) {
            if (d && typeof d.code === 'string' && !defs.has(d.code)) { defs.set(d.code, d); }
        }
    }
    const table: BinTableEntry[] = new Array(codes.length);
    for (let i = 0; i < codes.length; i++) {
        const code = typeof codes[i] === 'string' ? codes[i] : '';
        const d = defs.get(code);
        table[i] = { code, quality: d ? normStatus(d.quality) : null, pick: d ? d.pick === true : false };
    }
    return table;
}

/**
 * Joins a decoded bin payload with its bin definitions into a render-ready
 * {@link GridModel}, or returns `null` when the payload cannot describe a
 * lattice. Returning `null` (rather than throwing) mirrors
 * {@link buildOutlineModel}'s "null when there is nothing drawable" and drops
 * straight into the shell's `__updateGrid(grid: GridModel | null)`.
 *
 * NO PER-CELL WORK BEYOND ONE VALIDATION SCAN: the join is over
 * `payload.codes` (one row per DISTINCT bin, typically a handful), never over
 * the cells; no per-cell object and no per-cell string is materialized, and
 * `payload.cells` is ADOPTED BY REFERENCE - a 1e6-cell `Uint32Array` is never
 * copied. The single `O(cols * rows)` pass is the index-range check, which buys
 * the {@link GridModel} invariant that both hot loops index `binTable` without a
 * bounds branch; it reads one typed-array element per cell and costs well under
 * a millisecond at the design-driver size (reported by the timing section of
 * Tests/grid-core.test.mjs).
 *
 * Rejected as "not a lattice": non-integral / non-positive `cols` or `rows`, a
 * `cells` array shorter than `cols * rows` (longer is accepted, the tail is
 * ignored), an empty `codes` array (index 0 must exist - it is the reserved
 * NullBin token), a singular step basis (parallel or zero step vectors have no
 * 2x2 inverse, so nothing could be hit-tested), and any cell index outside
 * `codes`.
 *
 * The null bin (index 0) is joined like any other row so that `binTable` is a
 * 1:1 image of `codes`; it is simply never painted and never hit. Duplicate
 * definitions for one code are resolved first-wins.
 * @param placement The lattice placement in the substrate frame S.
 * @param payload   The decoded bin payload (its `cells` is adopted by reference).
 * @param binDefs   Per-code definitions to join, or `null` for none.
 * @returns The render-ready grid model, or `null` when there is nothing drawable.
 */
export function buildGridModel(
    placement: GridPlacement,
    payload: DecodedBinPayload,
    binDefs: BinDefinition[] | null,
    layers?: readonly GridBinLayer[],
): GridModel | null {
    if (!placement || typeof placement !== 'object' || !payload || typeof payload !== 'object') {
        return null;
    }
    const cols = payload.cols;
    const rows = payload.rows;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
        return null;
    }
    const n = cols * rows;
    const cells = payload.cells;
    // Duck-typed (not `instanceof`): realm-safe, and the hot loops only need
    // indexed reads - the same defensive spirit as `itemsToModels`.
    if (!cells || typeof cells.length !== 'number' || cells.length < n) {
        return null;
    }
    const codes = payload.codes;
    if (!Array.isArray(codes) || codes.length === 0) {
        return null;
    }
    // Singular basis => no 2x2 inverse => no hit-test and no drawable cell.
    const det = placement.colStepXmm * placement.rowStepYmm - placement.colStepYmm * placement.rowStepXmm;
    if (!(Math.abs(det) > 0)) {
        return null;
    }

    // Join over the DISTINCT codes, never over the cells. One implementation,
    // shared with decoration layers - see buildBinTable.
    const binTable = buildBinTable(codes, binDefs);

    // The one O(cells) pass: establish the "every index addresses binTable"
    // invariant so neither hot loop needs a per-cell bounds branch.
    const limit = binTable.length;
    for (let i = 0; i < n; i++) {
        if (cells[i] >= limit) {
            return null;
        }
    }
    /*
     * Layers, if any. Validated HERE rather than at draw time so a renderer can
     * index them without a per-frame bounds check - the same contract the base's
     * one O(cells) pass above establishes.
     *
     * A failure THROWS rather than returning null. `null` from this function
     * means "nothing to draw", which a caller answers by drawing nothing; a
     * decoration that disagrees with the base is a different fact - the base is
     * fine, the document is wrong - and blanking a good map over a bad badge
     * would be the wrong repair.
     */
    let checked: GridBinLayer[] | undefined;
    /*
     * The decoration mask, built in the SAME pass that validates the layers -
     * which already reads every cell of every layer to bounds-check its bin index.
     * Free, therefore, and once per document rather than once per frame.
     */
    let decorated: Uint8Array | null = null;
    if (layers !== undefined && layers.length > 0) {
        checked = [];
        decorated = new Uint8Array(n);
        for (const layer of layers) {
            if (!layer || typeof layer !== 'object') {
                throw new GridLayerError('E142_LAYER_SHAPE', '',
                    'a layer is not an object. buildGridModel validates layers once, here, so that a '
                    + 'renderer can index them without re-checking every frame.');
            }
            const lc = layer.cells;
            if (!lc || typeof lc.length !== 'number' || lc.length < n) {
                throw new GridLayerError('E142_LAYER_EXTENT', layer.mapName,
                    `this layer spans ${lc && typeof lc.length === 'number' ? lc.length : 0} cells; the base `
                    + `grid is ${cols} x ${rows} = ${n}. E142-0225 13.1 defines an Overlay as an array over `
                    + 'the dimensions of the layout the containing SubstrateMap is assigned, so every '
                    + 'overlay spans the SAME lattice - a different extent is a malformed overlay, not a '
                    + 'second lattice. It is refused rather than cropped or scaled: a cropped decoration '
                    + 'marks the WRONG dies and nothing on screen would say so.');
            }
            const lt = layer.binTable;
            if (!Array.isArray(lt) || lt.length === 0) {
                throw new GridLayerError('E142_LAYER_BINTABLE', layer.mapName,
                    'this layer has no bin table. Entry 0 is the reserved null bin, so a table is never '
                    + 'empty for a layer that has cells.');
            }
            const limit = lt.length;
            for (let i = 0; i < n; i++) {
                // Bin 0 is the null bin: a layer that does not name this cell.
                if (lc[i] !== 0) { decorated[i] = 1; }
                if (lc[i] >= limit) {
                    throw new GridLayerError('E142_LAYER_BIN_INDEX', layer.mapName,
                        `cell ${i} indexes bin ${lc[i]} of a ${limit}-entry table. Every index must address `
                        + 'the table, and it is verified once here for the same reason the base is.');
                }
            }
            checked.push(layer);
        }
    }

    // `lids` rides through untouched when the payload carries one: the model's
    // linear index is the payload's, so no re-keying is needed.
    const model: GridModel = { placement, cols, rows, cells, binTable };
    if (payload.lids !== undefined) { model.lids = payload.lids; }
    if (checked !== undefined) { model.layers = checked; }
    if (decorated !== null) { model.decorated = decorated; }
    return model;
}

/**
 * Axis-aligned bounding box of a grid's DRAWN extent in substrate-frame
 * millimeters, or `null` when there is no grid. Feeds {@link fitBBox}.
 *
 * The box spans the four corners of the drawn lattice - `a` from `0.5 - halfA`
 * to `cols - 0.5 + halfA`, `b` likewise - transformed through the step basis, so
 * it is exact under any rotation and any AxisDirection sign combination. The
 * DRAWN extent (not the pitch extent) is used because it is precisely the
 * painted area: nothing painted is ever clipped, and the outer half-streets that
 * carry no ink do not steal margin.
 * @param grid The render-ready grid, or `null`.
 * @returns The bounding box in frame S, or `null`.
 */
export function gridBBox(grid: GridModel | null): BBox | null {
    if (!grid) {
        return null;
    }
    const p = grid.placement;
    const ha = gridHalfA(p);
    const hb = gridHalfB(p);
    const a0 = 0.5 - ha;
    const a1 = grid.cols - 0.5 + ha;
    const b0 = 0.5 - hb;
    const b1 = grid.rows - 0.5 + hb;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const a = (i === 1 || i === 2) ? a1 : a0;
        const b = (i >= 2) ? b1 : b0;
        const x = p.originXmm + a * p.colStepXmm + b * p.rowStepXmm;
        const y = p.originYmm + a * p.colStepYmm + b * p.rowStepYmm;
        if (x < minX) { minX = x; }
        if (x > maxX) { maxX = x; }
        if (y < minY) { minY = y; }
        if (y > maxY) { maxY = y; }
    }
    return (minX <= maxX && minY <= maxY) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Resolves a bin's fill color. Precedence:
 *  1. the status-color mapping keyed by the bin CODE string - the same mapping
 *     and the same lookup rule items use ({@link resolveStatusColor}), so one
 *     StatusColorMapping colors items and cells alike;
 *  2. the per-quality default for the CONVENTIONAL quality strings `pass` /
 *     `fail`, matched case-insensitively on the trimmed value;
 *  3. the unknown fallback.
 *
 * `pass` / `fail` are a CONVENTION, not an enumeration: the bin quality is a free
 * string, and every other value (`edge`, `skip`, `reference`, ...) resolves to
 * the unknown color unless the mapping names its code.
 * @param entry   The bin table row.
 * @param mapping Status/code -> CSS color map, or `null`.
 * @param colors  Resolved colors (supplies `binPass` / `binFail` / `unknown`).
 * @returns The CSS color string to fill the cell with.
 */



/**
 * Cells per device pixel, as an AREA — the aggregation factor.
 *
 * ---- WHY IT IS READ FROM THE MATRIX ----
 *
 * `dev · latticeMatrix(placement)` maps cell coordinates straight to device
 * pixels, so its determinant is the device-pixel AREA of one cell and the
 * reciprocal is how many cells share a pixel. Nothing else needs to be known.
 *
 * The tempting alternative — control width divided by column count — gives the
 * same answer today and silently stops being right the moment anything is
 * composed into the chain. A caller can post-multiply a view transform onto the
 * world matrix, and a size-derived factor would ignore it completely: the map
 * would aggregate as though unzoomed while drawing zoomed, with nothing to
 * report. Reading the composed matrix keeps the two in step.
 *
 * ---- PITCH, NOT DRAWN EXTENT ----
 *
 * The determinant uses the lattice STEPS. It is deliberately not
 * `renderGridLayer`'s `pxPerCell`, which multiplies `cellWmm` / `cellLmm` — the
 * DRAWN extent — and answers a different question: whether a cell is big enough
 * to be worth a rect. How many cells land in a pixel is decided by the pitch;
 * streets between cells do not make a pixel cover fewer of them.
 *
 * A degenerate lattice — collinear column and row steps, or a zero step — has no
 * area and returns `Infinity`: every cell is on top of every other, so a pixel
 * covers all of them. `Infinity` is the honest answer and it compares correctly
 * against any threshold; `0` would read as "no aggregation" and be exactly wrong.
 * @param dev       Frame S -> device px, i.e. `deviceMatrix(dpr, world)`.
 * @param placement The grid placement.
 * @returns Cells per device pixel, by area. `Infinity` for a degenerate lattice.
 */
export function aggregationFactor(dev: DOMMatrix, placement: GridPlacement): number {
    const m = dev.multiply(latticeMatrix(placement));
    const det = Math.abs(m.a * m.d - m.b * m.c);
    return det > 0 ? 1 / det : Infinity;
}

/**
 * The same factor as a LINEAR ratio: cells per pixel along one axis.
 *
 * `sqrt` of the area form, and the one to compare against a length threshold.
 * `aggregationFactor` counts cells in a pixel, so 4 cells per pixel is 2 cells
 * across — quoting the area number where a length is meant overstates the
 * minification by its own square root, which at the sizes this feature cares
 * about is the difference between 6:1 and 36:1.
 * @param dev       Frame S -> device px.
 * @param placement The grid placement.
 * @returns Cells per device pixel along one axis. `Infinity` when degenerate.

 *
 * **MEASURING SURFACE FOR TESTS. No render path calls this** — the dispatcher computes the factor inline from the matrices; this is the same
 * arithmetic exposed so a suite can sweep it across zooms without rendering.
 * Written down because an export with no runtime consumer otherwise reads as a
 * promise to whoever finds it in the module surface. */
export function aggregationFactorLinear(dev: DOMMatrix, placement: GridPlacement): number {
    return Math.sqrt(aggregationFactor(dev, placement));
}




/**
 * How many steps the fail-fraction ramp is quantized to.
 *
 * The reducer produces a continuous fraction, and turning one into a CSS string
 * and back per pixel would cost far more than the whole scatter. A lookup table
 * of packed words indexed by `round(t * (N - 1))` costs one multiply and one
 * array read.
 *
 * 64 steps is under half an OKLab JND per step across the ramp - the palette's
 * two ends are about 0.35 apart, so a step is 0.0055 against a JND near
 * 0.02. Nobody can see the quantization; everybody would see the frame rate.
 */
export const AGGREGATE_RAMP_STEPS = 64;

/**
 * Which reduction an aggregated tile uses.
 *
 * `'ValueField'` is not a choice the rule makes — it is what a value field forces,
 * because `MaxSeverity` and `FailFraction` both ask about bin QUALITY and a
 * relevance field has no pass and no fail.
 */
export type GridReducer = 'MaxSeverity' | 'FailFraction' | 'ValueField';

/**
 * Everything the aggregated render needs from above.
 *
 * `paint` is built by `GridAggregate.buildAggregatePaint`, which this module
 * cannot call - `Engine.ts` imports nothing, by design, and constructing the
 * palette needs `Oklch`. The other three ride along because they belong
 * to the same decision and all three must reach the cache key.
 */
export interface AggregateOptions {
    /** The packed palette, or `null` to fall back to point sampling. */
    readonly paint: GridAggregatePaint | null;
    /** Which reduction to use below the threshold. */
    readonly reducer: GridReducer;
    /** `BinSeverityPriority`, for the paint signature. */
    readonly priority: readonly string[] | null;
    /** The fail-fraction transfer exponent, for the paint signature. */
    readonly gamma: number;
}

/** Everything the aggregate strategies need, as packed RGBA words. */
export interface GridAggregatePaint {
    /** Severity rank per bin index, from {@link binSeverityTable}. */
    readonly severity: Uint32Array;
    /** 1 per failing bin index, 0 elsewhere: the FailFraction numerator. */
    readonly failFlag: Uint32Array;
    /**
     * Packed aggregate color by severity LEVEL, not by rank: index 0 unused
     * (nothing painted), 1 pass, 2 unknown, 3 fail-or-worse.
     */
    readonly bySeverity: Uint32Array;
    /** Packed aggregate ramp, {@link AGGREGATE_RAMP_STEPS} entries. */
    readonly ramp: Uint32Array;
    /**
     * A value field's per-cell table indices, or `null` when the fill is bins.
     *
     * Present only for a `valueField` overlay. The scatter reads this for the value
     * and `grid.cells` for the substrate, exactly as the un-aggregated renderers do
     *.
     */
    readonly valueCells: Uint32Array | null;
    /**
     * Packed color per value-table index, or `null`.
     *
     * Indexed by the table index itself rather than by a normalized fraction: the
     * ramp IS the table, so there is nothing to normalize and no rounding to lose.
     */
    readonly valueColors: Uint32Array | null;
}

/**
 * The paint color for one bin.
 *
 * Precedence:
 *
 *   1. an explicit `StatusColorMapping` entry
 *   2. a `BinQuality` resolving to pass or fail
 *   3. the CATEGORICAL fallback, when the caller supplied one
 *   4. the unknown color
 *
 * Steps 1, 2 and 4 are unchanged. Step 3 is additive: a map whose codes all carry
 * a quality never reaches it and renders exactly as it did before, which is
 * asserted byte for byte.
 *
 * **The fallback is passed IN, not computed here.** Building it needs `Oklch`, and
 * palette construction stays out of this module — see `BinPalette.ts`. It
 * arrives already resolved for this entry, so this function stays a lookup.
 * @param entry     The bin table entry.
 * @param mapping   `StatusColorMapping`, or `null`.
 * @param colors    The theme colors.
 * @param aliases `BinQualityAliases`, or `null`.
 * @param categorical The categorical color for THIS entry, or `null`/omitted.
 * @param highlight   The muted color for THIS entry when a `HighlightFromSeverity`
 *        threshold puts it below the line, or `null`/omitted. OVERRIDES every
 *        other step, including an explicit `StatusColorMapping` entry: the
 *        author asked for one severity to stand out, and a bin that kept its
 *        mapped color would go on competing for attention with the thing they
 *        asked to see. Computed by the control, because deriving it needs
 *        `Oklch`, which stays out of this module.
 * @returns The CSS color.
 *
 * **It does not warn.** An unmapped token is diagnosed by the CONTROL, once when
 * the model is built, because this function runs on every frame and a per-frame
 * warning is noise. See `__warnUnmappedBinQualities`.
 */
export function resolveBinColor(
    entry: BinTableEntry,
    mapping: Record<string, string> | null,
    colors: SubstrateMapColors,
    aliases?: Record<string, string> | null,
    categorical?: string | null,
    highlight?: string | null,
): string {
    // FIRST, and the only step that outranks an explicit mapping. See the note on
    // the parameter for why.
    if (typeof highlight === 'string' && highlight !== '') { return highlight; }
    const mapped = mapping ? mapping[entry.code] : undefined;
    if (typeof mapped === 'string' && mapped.trim() !== '') {
        return mapped;
    }
    const resolved = resolveBinQuality(entry.quality, aliases ?? null);
    if (resolved === 'pass') { return colors.binPass; }
    if (resolved === 'fail') { return colors.binFail; }
    if (typeof categorical === 'string' && categorical !== '') { return categorical; }
    return colors.unknown;
}

/**
 * The resolved paint of a grid layer: everything the two render strategies need,
 * reduced to per-BIN lookups so neither strategy touches a color string or a bin
 * row per cell. Built by {@link buildGridPaint}. @internal
 */
export interface GridPaint {
    /**
     * Color GROUP per {@link GridModel.binTable} index. Group `0` means "never
     * painted" and is the null bin's group; groups `>= 1` are the DISTINCT colors
     * in first-seen order, so two bin codes that resolve to the same color share a
     * group and merge into one run.
     */
    groups: Uint32Array;
    /** CSS color per group id; index 0 is the unused null-bin slot. */
    colors: string[];
    /**
     * Packed RGBA per group id in {@link ImageData} byte order, or `null` when a
     * color could not be resolved numerically - in which case the ImageData
     * strategy is unavailable and the run strategy is used regardless of zoom.
     */
    rgba: Uint32Array | null;
    /**
     * Aggregate paint, or `null` when the ImageData strategy was not asked for.
     *
     * Built beside `rgba` and under the same condition, so a render that will take
     * the runs path never pays for it. See {@link GridAggregatePaint}.
     */
    aggregate: GridAggregatePaint | null;
    /**
     * Per-cell bin indices the FILL is read from, or `null` for the grid's own.
     *
     * A `valueField` overlay owns the fill while the base still owns the geometry,
     * the selection and the bin codes a tap reports. So the renderers index this
     * for the COLOR and `grid.cells` for whether there is substrate at all — a
     * cell is painted only when both say something.
     */
    fillCells: Uint32Array | null;
    /**
     * Exact signature of this paint: two paints with equal signatures produce a
     * bit-identical layer. It is the cache key's color term, and it is what makes
     * a theme switch or a StatusColorMapping edit invalidate the cached bitmap
     * even though the grid data did not change.
     */
    signature: string;
}

/** Whether this platform stores {@link Uint32Array} words little-endian; decided once. */
const LITTLE_ENDIAN: boolean = (() => {
    const probe = new Uint8Array([1, 0, 0, 0]);
    return new Uint32Array(probe.buffer)[0] === 1;
})();

/**
 * Packs 8-bit RGBA into one word laid out exactly as {@link ImageData} bytes, so
 * a `Uint32Array` view over `ImageData.data.buffer` can be written one word per
 * pixel instead of four bytes. Honors the platform byte order rather than
 * assuming little-endian.
 * @param r Red 0..255.
 * @param g Green 0..255.
 * @param b Blue 0..255.
 * @param a Alpha 0..255.
 * @returns The packed word.
 */
function packRgba(r: number, g: number, b: number, a: number): number {
    return LITTLE_ENDIAN
        ? (((a << 24) | (b << 16) | (g << 8) | r) >>> 0)
        : (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}

/**
 * Resolves an arbitrary CSS color string to its canvas SERIALIZATION, or `null`
 * when the browser cannot parse it.
 *
 * This is the only DOM-free way to understand a color the engine did not author:
 * `StatusColorMapping` is user data and may hold anything CSS accepts
 * (`hsl(...)`, `red`, `#abc`), and the engine must not own a CSS color parser.
 * Assigning to `fillStyle` makes the canvas context parse it, and reading `fillStyle`
 * back yields the serialization; an unparsable value leaves the property
 * untouched, which the two differing sentinels detect. No pixels are read, so
 * this costs a property round-trip, not a `getImageData`.
 * @param ctx   A 2D context used purely as a parser; its `fillStyle` is restored.
 * @param color The candidate CSS color.
 * @returns The serialized color, or `null` when unparsable.
 */
function normalizeColor(ctx: Context2D, color: string): string | null {
    const prev = ctx.fillStyle;
    ctx.fillStyle = '#000000';
    ctx.fillStyle = color;
    const a = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = color;
    const b = ctx.fillStyle;
    ctx.fillStyle = prev;
    // Parsed => both probes serialize identically; ignored => each keeps its sentinel.
    return (typeof a === 'string' && typeof b === 'string' && a === b) ? a : null;
}

/**
 * The two forms the HTML canvas serialization produces, matched WHOLE.
 *
 * Not prefix tests: `s.charCodeAt(0) === 35 && s.length === 7` would let
 * `parseInt` prefix-parse `#12345g` into `0x12345`, and `s.slice(0, 3) === 'rgb'`
 * would accept `rgbx(1,2,3)`. A color parser that guesses is worse than one that
 * refuses, because `null` cleanly disables the ImageData strategy for the layer
 * while a wrong-but-plausible word is painted.
 */
const RE_HEX6 = /^#[0-9a-fA-F]{6}$/;
/** `rgb(...)` / `rgba(...)`, capturing the function name and the argument list. */
const RE_RGB = /^(rgba?)\(([^()]*)\)$/;
/**
 * One numeric component: an optional sign, decimal digits, an optional fraction,
 * an optional exponent, optionally a percentage.
 *
 * `Number()` alone was the test, and `Number` accepts things CSS does not:
 * `0x10` is 16, `Infinity` is finite-looking to a NaN check and clamps to 255,
 * and `''` is 0. None of those can come out of a canvas serialization.
 */
const RE_NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parses a canvas-SERIALIZED color into a packed {@link ImageData} word, or
 * `null` when the form is not one this function understands.
 *
 * Only the two forms the HTML canvas serialization produces are handled:
 * `#rrggbb` (opaque) and `rgba(r, g, b, a)` / `rgb(r, g, b)`. Anything else - a
 * wide-gamut `color(...)` form, for instance - returns `null`, which cleanly
 * disables the ImageData strategy for the whole layer instead of guessing a
 * color. Deliberately NOT a general CSS color parser: {@link normalizeColor} has
 * already made the browser do that work.
 * @param s A canvas-serialized color string.
 * @returns The packed word, or `null`.
 */
export function packColor(s: string): number | null {
    if (typeof s !== 'string') { return null; }
    if (RE_HEX6.test(s)) {
        // `parseInt` cannot fail here, because the regex already proved every digit
        // is hex. It used to run on any 7-character string starting with '#', and
        // parseInt PREFIX-parses: '#12345g' became 0x12345 - a wrong but entirely
        // plausible color, silently.
        const v = parseInt(s.slice(1), 16);
        return packRgba((v >>> 16) & 255, (v >>> 8) & 255, v & 255, 255);
    }
    const m = RE_RGB.exec(s);
    if (m !== null) {
        const parts = m[2]!.split(/[\s,/]+/).filter((t) => t !== '');
        // `rgb` takes exactly three components and `rgba` exactly four. A shorter
        // list used to return null and a LONGER one was accepted with the extras
        // ignored, so `rgb(1,2,3,4,5)` parsed.
        if (parts.length !== (m[1] === 'rgba' ? 4 : 3)) { return null; }
        if (!parts.every((t) => RE_NUM.test(t))) { return null; }
        const r = Number(parts[0]), g = Number(parts[1]), b = Number(parts[2]);
        const a = parts.length > 3 ? Number(parts[3]) : 1;
        return packRgba(
            Math.max(0, Math.min(255, Math.round(r))),
            Math.max(0, Math.min(255, Math.round(g))),
            Math.max(0, Math.min(255, Math.round(b))),
            Math.max(0, Math.min(255, Math.round(a * 255))),
        );
    }
    return null;
}

/**
 * Resolves a grid's per-bin colors into the per-GROUP lookups the render
 * strategies use, plus the exact signature the layer cache keys on.
 *
 * Grouping by resolved color (not by bin index) is what makes "batched
 * same-color row runs" literal: two different bin codes mapped to one color form
 * ONE run. The work is `O(binTable.length)` - typically a handful of rows - and
 * is repeated every draw, because the mapping and the theme can change at any
 * time and the signature must track them.
 * @param grid    The grid whose bins are colored.
 * @param mapping Status/code -> CSS color map, or `null`.
 * @param colors  Resolved colors (`binPass` / `binFail` / `unknown`).
 * @param ctx     A context to resolve colors numerically with, or `null` to skip
 *                the numeric packing (leaving {@link GridPaint.rgba} `null`) when
 *                the caller knows the ImageData strategy will not be used.
 * @returns The resolved paint.
 */
export function buildGridPaint(
    grid: GridModel,
    mapping: Record<string, string> | null,
    colors: SubstrateMapColors,
    ctx: Context2D | null,
    aliases?: Record<string, string> | null,
    priority?: readonly string[] | null,
    gamma: number = 0.4,
    fill?: { cells: Uint32Array; colors: readonly string[] } | null,
    categorical?: readonly (string | null)[] | null,
    highlight?: readonly (string | null)[] | null,
): GridPaint {
    /*
     * A VALUE FIELD REPLACES THE FILL, and does not blend with it. The rule it
     * follows is the existing one: blending two bin colors yields a color that
     * maps back to no bin code at all. So when a fill is supplied, the groups and
     * the palette are ITS table's, and `resolveBinColor` is not consulted — a value
     * field has no BinQuality to resolve and inventing one would be worse than
     * having none.
     */
    if (fill) {
        const fn = fill.colors.length;
        const fgroups = new Uint32Array(fn);
        const fcolors: string[] = [''];
        for (let i = 1; i < fn; i++) { fgroups[i] = i; fcolors.push(fill.colors[i] ?? ''); }
        let frgba: Uint32Array | null = null;
        if (ctx) {
            frgba = new Uint32Array(fn);
            for (let i = 1; i < fn; i++) {
                const packed = packColor(normalizeColor(ctx, fcolors[i]) ?? '');
                if (packed === null) { frgba = null; break; }
                frgba[i] = packed;
            }
        }
        /*
         * A VALUE FIELD AGGREGATES TOO. Without this the fill branch returned no
         * aggregate paint, the dispatcher fell through to the gather, and a value
         * field would be POINT SAMPLED below one device pixel per cell — the exact
         * defect aggregation removes for bins, reintroduced for the seam that
         * carries a relevance map. The packed colors are already built above, so the
         * aggregate costs two more fields and no more work.
         */
        const emptyBin = new Uint32Array(fn);
        return {
            groups: fgroups,
            colors: fcolors,
            rgba: frgba,
            aggregate: frgba === null ? null : {
                severity: emptyBin,
                failFlag: emptyBin,
                bySeverity: new Uint32Array(4),
                ramp: new Uint32Array(AGGREGATE_RAMP_STEPS),
                valueCells: fill.cells,
                valueColors: frgba,
            },
            fillCells: fill.cells,
            signature: 'value\u0002' + fcolors.join('\u0001'),
        };
    }
    const n = grid.binTable.length;
    const groups = new Uint32Array(n);            // groups[0] stays 0: the null bin is never painted
    const byColor = new Map<string, number>();
    const colorsByGroup: string[] = [''];         // slot 0 unused (never painted)
    for (let i = 1; i < n; i++) {
        const color = resolveBinColor(grid.binTable[i], mapping, colors, aliases ?? null,
            categorical ? categorical[i] : null, highlight ? highlight[i] : null);
        let g = byColor.get(color);
        if (g === undefined) {
            g = colorsByGroup.length;
            colorsByGroup.push(color);
            byColor.set(color, g);
        }
        groups[i] = g;
    }
    let rgba: Uint32Array | null = null;
    if (ctx) {
        rgba = new Uint32Array(colorsByGroup.length);
        for (let g = 1; g < colorsByGroup.length; g++) {
            const norm = normalizeColor(ctx, colorsByGroup[g]);
            const packed = norm !== null ? packColor(norm) : null;
            if (packed === null) {
                rgba = null;                      // one unparsable color disables the whole strategy
                break;
            }
            rgba[g] = packed;
        }
    }
    // The layer is a pure function of (cells, placement, groups, colorsByGroup);
    // the first two are covered by the cache key's data version, these two by this.
    // The aggregate inputs join it because two renders that differ only in the
    // priority list or the gamma must not share a cached bitmap.
    // The categorical assignment needs no term of its own: it can only change the
    // colors, and `colorsByGroup` plus `groups` already carry every one of them.
    const signature = colorsByGroup.join('\u0001') + '\u0002' + groups.join(',')
        + '\u0002' + (priority ? priority.join('\u0001') : '') + '\u0002' + gamma;
    return { groups, colors: colorsByGroup, rgba, aggregate: null, fillCells: null, signature };
}

/** @internal Test seam for the cache key, which is otherwise module-private. */
export function gridCacheKeyForTest(
    dev: DOMMatrix, bw: number, bh: number, dataVersion: number, paint: GridPaint,
    reducer: GridReducer, filter: string,
): string {
    return gridCacheKey(dev, bw, bh, dataVersion, paint, reducer, filter);
}

/** A half-open rectangle in DEVICE pixels: `x0 <= x < x1`, `y0 <= y < y1`. */
export interface DeviceRect {
    /** Left edge, inclusive. */ readonly x0: number;
    /** Top edge, inclusive. */ readonly y0: number;
    /** Right edge, EXCLUSIVE. */ readonly x1: number;
    /** Bottom edge, EXCLUSIVE. */ readonly y1: number;
}

/**
 * The cells whose centers fall inside a device-space group rectangle.
 *
 * ---- WHY THIS IS NOT A BOUNDING BOX OVER (col, row) ----
 *
 * A rectangle in device space is a **rotated parallelogram** in lattice space -
 * `MapRotation` turns it, `AxisDirection` and `sideMirror` flip it, and a
 * non-orthogonal lattice shears it. Iterating the (col, row) bounding box and
 * taking everything in it hands back cells the operator never touched, and at 45
 * degrees that is nearly half of them.
 *
 * ---- THE TEST IS THE DEFINITION ----
 *
 * A cell is in the group when its CENTER, projected forward into device space,
 * lies in the rectangle. That is exactly what a brute-force pass over every cell
 * would compute, so the two cannot disagree - the only thing this adds is not
 * visiting the whole map. The rectangle's corners are inverted into lattice space
 * to bound the scan; the forward projection then decides. Overscan is bounded by
 * the ratio of a rotated rectangle's bounding box to its area, which is at most 2.
 *
 * The center is the same point `getCellAtPos` tests and the same point the
 * aggregate scatter projects, so a group holds the cells a click would land in.
 *
 * ---- HALF-OPEN, SO ADJACENT GROUPS PARTITION ----
 *
 * Containment is `x0 <= px < x1`. With closed edges a cell center landing exactly
 * on a boundary would belong to both neighboring groups; with open edges it would
 * belong to neither. Tiling is the point of grouping, so the interval is half-open
 * and the property is asserted rather than assumed.
 *
 * **The null bin is excluded.** Index 0 is off-substrate - never painted, never
 * selected - so a group over the edge of a wafer returns only the dies that
 * are there. That is why this takes the grid and not just the placement: the
 * placement carries no cell data and no extent.
 * @param rect The group, in device pixels.
 * @param grid The grid.
 * @param dev  Frame S -> device px, i.e. `deviceMatrix(dpr, world)`.
 * @returns Cell indices, row-major, ascending. Empty when the lattice is
 *          degenerate or the rectangle covers nothing.
 */
export function cellsInGroup(rect: DeviceRect, grid: GridModel, dev: DOMMatrix): Uint32Array {
    const m = dev.multiply(latticeMatrix(grid.placement));
    const det = m.a * m.d - m.b * m.c;
    // A SHORT CIRCUIT, not a correctness guard, and NOT mutation-tested: with
    // det 0 the inverse yields +/-Infinity, the corner bounds come out
    // non-finite, and the `Number.isFinite` check below returns the same empty
    // array. Removing this line changes no output, only how far the code walks
    // before giving the same answer.
    if (!(Math.abs(det) > 0)) { return new Uint32Array(0); }

    // Device -> lattice, written out rather than composed as a matrix: one
    // expression to read, and no second DOMMatrix to keep consistent with this one.
    const toLattice = (px: number, py: number): { a: number; b: number } => {
        const dx = px - m.e;
        const dy = py - m.f;
        return { a: (m.d * dx - m.c * dy) / det, b: (-m.b * dx + m.a * dy) / det };
    };

    let minA = Infinity;
    let maxA = -Infinity;
    let minB = Infinity;
    let maxB = -Infinity;
    for (const [px, py] of [[rect.x0, rect.y0], [rect.x1, rect.y0],
        [rect.x0, rect.y1], [rect.x1, rect.y1]] as const) {
        const { a, b } = toLattice(px, py);
        if (a < minA) { minA = a; }
        if (a > maxA) { maxA = a; }
        if (b < minB) { minB = b; }
        if (b > maxB) { maxB = b; }
    }
    if (!Number.isFinite(minA) || !Number.isFinite(minB)) { return new Uint32Array(0); }

    // A cell's center sits at (col + 0.5), so the candidate columns are those whose
    // centers can reach the span - hence the half-cell slack on each side.
    const c0 = Math.max(0, Math.floor(minA - 0.5));
    const c1 = Math.min(grid.cols - 1, Math.ceil(maxA - 0.5));
    const r0 = Math.max(0, Math.floor(minB - 0.5));
    const r1 = Math.min(grid.rows - 1, Math.ceil(maxB - 0.5));
    if (c1 < c0 || r1 < r0) { return new Uint32Array(0); }

    const out: number[] = [];
    const cells = grid.cells;
    for (let r = r0; r <= r1; r++) {
        const cy = r + 0.5;
        const rx = m.c * cy + m.e;
        const ry = m.d * cy + m.f;
        const base = r * grid.cols;
        for (let col = c0; col <= c1; col++) {
            if (cells[base + col] === 0) { continue; }     // off substrate
            const cx = col + 0.5;
            const px = m.a * cx + rx;
            const py = m.b * cx + ry;
            if (px < rect.x0 || px >= rect.x1 || py < rect.y0 || py >= rect.y1) { continue; }
            out.push(base + col);
        }
    }
    return Uint32Array.from(out);
}

/**
 * How many bins a group descriptor names before the rest become a remainder.
 *
 * **Ten, and the number is borrowed on purpose.** `Integer2` permits 65 536 bin
 * codes, so an untruncated histogram is O(K) in something the document controls -
 * a 2 KB descriptor is not a promise you can keep against an adversarial map. Ten
 * is where the categorical palette caps for the same underlying reason: a
 * person cannot hold more than about that many categories at once, so an eleventh
 * named bin in a tooltip is a row nobody reads.
 */
export const GROUP_HISTOGRAM_MAX = 10;

/** One named bin in a group's histogram. */
export interface GroupBinCount {
    /** The bin code, as the document spells it. */
    readonly code: string;
    /** How many cells of the group carry it. */
    readonly count: number;
}

/**
 * What a tap on an aggregated map hands the HMI author.
 *
 * ---- NEVER A MATERIALIZED LIST ----
 *
 * A 48x48 group on a 1.5 M map holds about 12 900 cells. A `SelectionList` entry
 * is a ten-field object with several strings, so the list form is a
 * multi-hundred-millisecond stall on every tap - in exactly the scenario this
 * feature exists to prevent - and it is the wrong ergonomics besides. The author
 * wants to know WHAT IS IN the group and then ask about the part that matters.
 *
 * So this is a summary of fixed size: counts, a truncated histogram and a
 * remainder. `cellsInGroup` is still there for a caller who genuinely wants the
 * indices.
 */
export interface SubstrateMapGroupSelection {
    /** Stable within a render: the group's lattice-space origin, `"col,row"`. */
    readonly id: string;
    /**
     * The group quad's four corners in LATTICE coordinates, in device order:
     * top-left, top-right, bottom-left, bottom-right of the device rectangle.
     *
     * Lattice rather than device, because a device rectangle means nothing once the
     * view has moved, and because this is what a caller needs to ask a follow-up
     * question about the same region.
     */
    readonly corners: readonly (readonly [number, number])[];
    /** Cells in the group, excluding the null bin. */
    readonly cellCount: number;
    /** The worst severity rank present, or `SEVERITY_NULL` for an empty group. */
    readonly severity: number;
    /** The most common bins, descending by count, at most {@link GROUP_HISTOGRAM_MAX}. */
    readonly bins: readonly GroupBinCount[];
    /** Cells in bins the histogram did not name. `bins` + this === `cellCount`. */
    readonly otherCount: number;
    /** How many distinct bins the remainder covers. */
    readonly otherBins: number;
    /** Whether any cell in the group carries a decoration layer. */
    readonly decorated: boolean;
}

/**
 * Divides a span into whole-pixel tiles of near-equal size, none below `minTile`.
 *
 * ---- THE COMPLAINT ----
 *
 * "Some of the groups are huge and others small... it would be better if the
 * control tried to get groups with an almost similar size." Today the tile is a
 * fixed `minTile` on a grid anchored at device zero, so the map's edges land
 * wherever they land and the boundary tiles are whatever is left. Measured, with
 * `minTile` 40:
 *
 *     map spans [  0, 100]  ->  40, 40, 20        2.0x  spread
 *     map spans [ 12, 112]  ->  28, 40, 32        1.4x
 *     map spans [ 37, 137]  ->   3, 40, 40, 17   13.3x
 *
 * The 3 px tile is not tappable, and which case you get depends on where the map
 * happens to sit — so it changes when the window is resized.
 *
 * ---- WHY `floor` AND NOT `ceil` ----
 *
 * `n = ceil(span / minTile)` looks right and is not: `ceil` rounds the COUNT up,
 * which makes each tile SMALLER. A 100 px span at `minTile` 40 gives `n = 3` and
 * tiles of 33.3, below the minimum. It holds only when the span divides exactly
 * (100 at 25).
 *
 * Checked over every span 1..400 against every minimum 8..64, excluding spans
 * below the minimum where no rule can succeed:
 * **`ceil` is under the minimum in 19 968 of 20 805 cases; `floor` in none.**
 *
 * `span / n >= minTile` is equivalent to `n <= span / minTile`, so the largest
 * usable count is `floor`, not `ceil` - and "every tile is at least the
 * minimum" is the constraint that binds.
 *
 * ---- WHY WHOLE PIXELS ----
 *
 * `span / n` is generally fractional and a tile boundary is a pixel edge, so the
 * remainder is spread one pixel at a time across the first `rem` tiles rather
 * than dumped on the last one. That is what keeps the spread to a single pixel:
 * 100 at `minTile` 30 gives 34, 33, 33 — the wider tiles first, so and the arithmetic stays a prefix sum.
 *
 * @param span    The extent to divide, in device pixels.
 * @param minTile The smallest acceptable tile, in device pixels.
 * @returns Tile widths, in order, summing exactly to `floor(span)`. Empty when
 *          either argument is not a usable positive number.
 */
export function groupTileSpans(span: number, minTile: number): number[] {
    const total = Math.floor(span);
    if (!(total > 0) || !Number.isFinite(total)) { return []; }
    if (!(minTile > 0) || !Number.isFinite(minTile)) { return []; }
    /*
     * A span smaller than one minimum tile becomes ONE tile of the whole span.
     * It is below the minimum, and it is the only case where that is allowed,
     * because the alternative is a tile larger than the thing it divides. The
     * caller that cares — grouping exists to make a target tappable — should not
     * be grouping at all at that size.
     */
    const n = Math.max(1, Math.floor(total / minTile));
    const base = Math.floor(total / n);
    const rem = total - base * n;
    return Array.from({ length: n }, (_, k) => base + (k < rem ? 1 : 0));
}

/**
 * A group tiling: where the tiled region starts, and how wide each tile is.
 *
 * ---- WHY THIS REPLACED A SINGLE `groupPx` ----
 *
 * The tiles used to be a constant `groupPx` on an infinite grid anchored at device
 * zero, clipped by whatever the map happened to cover. So the map's edges landed
 * wherever they landed, and the boundary tiles were the leftovers. Measured, at a
 * 40 px minimum:
 *
 *     map spans [  0, 100]  ->  40, 40, 20        2.0x  spread
 *     map spans [ 12, 112]  ->  28, 40, 32        1.4x
 *     map spans [ 37, 137]  ->   3, 40, 40, 17   13.3x
 *
 * A 3 px tile is not tappable, and which case you got depended on where the map sat
 * relative to the DEVICE origin - so it changed on a window resize, which is why it
 * read as arbitrary.
 *
 * A span-divided tiling has no constant tile width, so a single number can no longer
 * describe it and both `groupTileAt` and `groupTileRect` take this instead. They must
 * be given the SAME tiling for an id to round-trip, which is the existing rule that a
 * group id means something only within one render, stated in a type rather than in a
 * comment.
 */
export interface GroupTiling {
    /** Device x of the tiled region's left edge. */
    readonly x0: number;
    /** Device y of the tiled region's top edge. */
    readonly y0: number;
    /** Tile widths, left to right. Sums to the region's width. */
    readonly xs: readonly number[];
    /** Tile heights, top to bottom. Sums to the region's height. */
    readonly ys: readonly number[];
}

/**
 * Builds a {@link GroupTiling} over a device-space region.
 *
 * Rows and columns are divided independently: a wide short
 * map gets many columns and few rows, and neither count constrains the other.
 * @param rect    The region to tile, in device pixels.
 * @param minTile The smallest acceptable tile side, in device pixels.
 * @returns The tiling, or `null` when the region or the minimum is unusable.
 */
export function groupTiling(rect: DeviceRect, minTile: number): GroupTiling | null {
    const xs = groupTileSpans(rect.x1 - rect.x0, minTile);
    const ys = groupTileSpans(rect.y1 - rect.y0, minTile);
    if (xs.length === 0 || ys.length === 0) { return null; }
    return { x0: Math.floor(rect.x0), y0: Math.floor(rect.y0), xs, ys };
}

/**
 * The index of the tile containing `v`, and the tile's start offset.
 * @param v     Position along the axis, relative to the region's origin.
 * @param spans Tile extents along that axis.
 * @returns `{ i, at }`, or `null` when `v` falls outside the region.
 */
function tileIndexAt(v: number, spans: readonly number[]): { i: number; at: number } | null {
    if (!(v >= 0)) { return null; }
    let at = 0;
    for (let i = 0; i < spans.length; i++) {
        // Right edge EXCLUSIVE, matching DeviceRect - so a point on a boundary
        // belongs to the tile it starts, and no point belongs to two.
        if (v < at + spans[i]!) { return { i, at }; }
        at += spans[i]!;
    }
    return null;
}

/** The offset of tile `i` from the region's origin. */
function tileOffset(i: number, spans: readonly number[]): number {
    let at = 0;
    for (let k = 0; k < i; k++) { at += spans[k]!; }
    return at;
}

/**
 * The group tile a device point falls in, and its id.
 *
 * ---- WHY THE ID IS A TILE INDEX ----
 *
 * A group id has to ROUND-TRIP: `onGroupSelected` hands one to the author, who asks
 * for the members a moment later. It therefore has to name something a
 * rectangle can be rebuilt from.
 *
 * A lattice-space origin - which is what the first version of `describeGroup` used -
 * cannot do that. The group is a rectangle in DEVICE space, and its image in lattice
 * space is a rotated parallelogram, so an origin identifies a corner and says nothing
 * about the shape. The tile index does, given the tiling: the prefix sums are the
 * rectangle, exactly.
 *
 * The id is meaningful only within one render, which is what the descriptor already
 * says, and the {@link GroupTiling} parameter makes that a type-level fact
 * rather than a convention.
 * @param px      Device x of the point.
 * @param py      Device y.
 * @param tiling  The tiling this frame is using.
 * @returns `{ id, rect }`, or `null` when the point is outside the tiled region.
 */
export function groupTileAt(px: number, py: number, tiling: GroupTiling | null):
{ id: string; rect: DeviceRect } | null {
    if (tiling === null) { return null; }
    const gx = tileIndexAt(px - tiling.x0, tiling.xs);
    const gy = tileIndexAt(py - tiling.y0, tiling.ys);
    if (gx === null || gy === null) { return null; }
    const id = `${gx.i},${gy.i}`;
    return { id, rect: groupTileRect(id, tiling) as DeviceRect };
}

/**
 * Rebuilds a group tile's rectangle from its id.
 *
 * The inverse of {@link groupTileAt}, and the reason the id is what it is. Given the
 * same tiling, `groupTileAt` on any point of the returned rectangle returns the same
 * id - asserted by the tests for every tile of every tiling they cover.
 * @param id     A `"gx,gy"` id.
 * @param tiling The tiling the id was issued against.
 * @returns The rectangle, or `null` when the id names no tile of this tiling.
 */
export function groupTileRect(id: string, tiling: GroupTiling | null): DeviceRect | null {
    if (tiling === null) { return null; }
    const m = /^(-?\d+),(-?\d+)$/.exec(String(id));
    if (m === null) { return null; }
    const gx = Number(m[1]);
    const gy = Number(m[2]);
    // An id from another frame's tiling can name a tile this one does not have. That
    // is not an error to throw on - it is an id that has expired - so it resolves to
    // null the same way a malformed one does.
    if (gx < 0 || gy < 0 || gx >= tiling.xs.length || gy >= tiling.ys.length) { return null; }
    const x0 = tiling.x0 + tileOffset(gx, tiling.xs);
    const y0 = tiling.y0 + tileOffset(gy, tiling.ys);
    return { x0, y0, x1: x0 + tiling.xs[gx]!, y1: y0 + tiling.ys[gy]! };
}

/** One bin's row in a {@link BinStatistics}. */
export interface BinStatistic {
    /** The canonical bin code, as `binTable` carries it. */
    readonly code: string;
    /** How many cells hold it. Always `> 0` — a code with no cells is not listed. */
    readonly count: number;
    /**
     * The quality the DOCUMENT declared, verbatim and untrimmed of meaning, or
     * `null` when it declared none.
     *
     * The declared string and not the resolved one, because {@link severity}
     * already carries the resolution and the declared token is the only thing here
     * that cannot be recovered from the rest. A legend that wants to print `Pass`
     * wants this; a legend that wants to sort wants `severity`.
     */
    readonly quality: string | null;
    /** Its rank in the declared order, from {@link binSeverityTable}. */
    readonly severity: number;
    /**
     * The color the RENDER PATH paints for this code — {@link resolveBinColor},
     * the same call `buildGridPaint` makes, with the same mapping and aliases.
     *
     * Not the value read out of `StatusColorMapping`. A chart built from that would
     * disagree with the map for every code the mapping does not name, and two
     * independent palettes disagreeing is the one failure a statistics function can
     * introduce that nothing else would catch.
     */
    readonly color: string;
}

/** The whole lattice counted by bin. */
export interface BinStatistics {
    /** Every cell in the lattice, `cols * rows`. */
    readonly totalCells: number;
    /** Cells holding the reserved null bin — no code, or off the substrate. */
    readonly nullCount: number;
    /** One row per code that occurs, descending by count then by code. */
    readonly bins: readonly BinStatistic[];
}

/**
 * Counts the whole lattice by bin.
 *
 * The same pass {@link describeGroup} runs over a group, run over everything —
 * a dense `Uint32Array` over `binTable` rather than a map, because the table has
 * a handful of entries where the lattice has millions of cells.
 *
 * ---- UNTRUNCATED, UNLIKE THE GROUP DESCRIPTOR ----
 *
 * A group's histogram is capped at ten because an event payload is O(K) in
 * something the DOCUMENT controls, and that payload is built on every tap. This
 * is asked for explicitly and runs once per binding, so the reason for the cap
 * does not apply — and a bar chart that hides the eleventh-largest code is
 * worthless. `Integer2` still permits 65 536 codes; the caller decides what to do
 * with a long list, which is a different question from whether it may see one.
 *
 * ---- THE INVARIANT ----
 *
 * `sum(bins.count) + nullCount === totalCells`, exactly, always. It holds by
 * construction — every cell increments exactly one counter and index 0 is the
 * null bin — and it is asserted across the whole fixture corpus, because "holds
 * by construction" is what everything says until it does not.
 * @param grid     The grid.
 * @param mapping  `StatusColorMapping`, or `null`.
 * @param colors   The resolved theme colors, for the quality fallbacks.
 * @param priority `BinSeverityPriority`, or `null`.
 * @param aliases  `BinQualityAliases`, or `null`.
 * @param categorical The categorical fallback by table index, or `null`. The SAME
 *        array the render path was given, so the chart and the map agree.
 * @param highlight The muted colors by table index, or `null`. Also the same
 *        array: a chart that showed a bin's true color while the map showed it
 *        grayed would be describing a different picture.
 * @returns The counts.
 */
export function binStatistics(
    grid: GridModel,
    mapping: Record<string, string> | null,
    colors: SubstrateMapColors,
    priority?: readonly string[] | null,
    aliases?: Record<string, string> | null,
    categorical?: readonly (string | null)[] | null,
    highlight?: readonly (string | null)[] | null,
): BinStatistics {
    const severityByBin = binSeverityTable(grid.binTable, priority ?? null, aliases ?? null);
    const total = grid.cols * grid.rows;
    const counts = new Uint32Array(grid.binTable.length);
    for (let i = 0; i < total; i++) { counts[grid.cells[i]]++; }

    const bins: BinStatistic[] = [];
    for (let b = 1; b < counts.length; b++) {
        if (counts[b] === 0) { continue; }
        const entry = grid.binTable[b];
        bins.push({
            code: entry.code,
            count: counts[b],
            quality: entry.quality,
            severity: severityByBin[b],
            color: resolveBinColor(entry, mapping, colors, aliases ?? null,
                categorical ? categorical[b] : null, highlight ? highlight[b] : null),
        });
    }
    // Descending by count, then by code. The same order `describeGroup` uses, and
    // for the same reason: a chart whose bars reordered between two identical
    // readings would look like a change in the data.
    bins.sort((x, y) => (y.count - x.count) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));

    return { totalCells: total, nullCount: counts[0], bins };
}

/**
 * Summarizes the cells a group rectangle covers.
 * @param rect     The group, in device pixels.
 * @param grid     The grid.
 * @param dev      Frame S -> device px.
 * @param priority `BinSeverityPriority`, or `null`.
 * @param aliases  `BinQualityAliases`, or `null`.
 * @returns The descriptor.
 */
export function describeGroup(
    rect: DeviceRect,
    grid: GridModel,
    dev: DOMMatrix,
    priority?: readonly string[] | null,
    aliases?: Record<string, string> | null,
    id: string = '',
): SubstrateMapGroupSelection {
    const indices = cellsInGroup(rect, grid, dev);
    const m = dev.multiply(latticeMatrix(grid.placement));
    const det = m.a * m.d - m.b * m.c;
    const corners: [number, number][] = [];
    if (Math.abs(det) > 0) {
        for (const [px, py] of [[rect.x0, rect.y0], [rect.x1, rect.y0],
            [rect.x0, rect.y1], [rect.x1, rect.y1]] as const) {
            const dx = px - m.e;
            const dy = py - m.f;
            corners.push([(m.d * dx - m.c * dy) / det, (-m.b * dx + m.a * dy) / det]);
        }
    }

    // One pass: counts by bin index, worst severity, and whether anything is
    // decorated. The bin table has a handful of entries where the group has
    // thousands of cells, so the histogram is dense over bins rather than a map.
    const severityByBin = binSeverityTable(grid.binTable, priority ?? null, aliases ?? null);
    const counts = new Uint32Array(grid.binTable.length);
    const cellDeco = grid.decorated ?? null;
    let severity = SEVERITY_NULL;
    let decorated = false;
    for (let k = 0; k < indices.length; k++) {
        const i = indices[k];
        const bin = grid.cells[i];
        counts[bin]++;
        const sev = severityByBin[bin];
        if (sev > severity) { severity = sev; }
        if (!decorated && cellDeco !== null && cellDeco[i] !== 0) { decorated = true; }
    }

    /*
     * Index 0 is the null bin. Starting at 1 states that, and is NOT
     * mutation-tested: `cellsInGroup` already excludes off-substrate cells, so
     * `counts[0]` is always 0 and starting at 0 would produce the same
     * histogram. The guarantee is pinned where it is made - `grid-render`
     * section 14 asserts that a group covering the whole map returns not one
     * null-bin cell - rather than defended against twice.
     */
    const ranked: GroupBinCount[] = [];
    for (let b = 1; b < counts.length; b++) {
        if (counts[b] > 0) { ranked.push({ code: grid.binTable[b].code, count: counts[b] }); }
    }
    // Descending by count, then by code, so the same group always serializes the
    // same way - a descriptor that reordered itself between taps would look like a
    // change to anything comparing them.
    ranked.sort((x, y) => (y.count - x.count) || (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));

    const bins = ranked.slice(0, GROUP_HISTOGRAM_MAX);
    let named = 0;
    for (const b of bins) { named += b.count; }
    return {
        // Supplied by the caller, because only the caller knows the group grid the
        // rectangle came from — and the id must name something `groupTileRect` can
        // rebuild.
        id,
        corners,
        cellCount: indices.length,
        severity,
        bins,
        otherCount: indices.length - named,
        otherBins: ranked.length - bins.length,
        decorated,
    };
}

/* ------------------------------------------------------------------------ *
 * Touch targets
 * ------------------------------------------------------------------------ */

/**
 * The smallest touch target this control will produce, in CSS pixels.
 *
 * **24 is WCAG 2.2's Target Size (Minimum), SC 2.5.8.** It is a floor rather than
 * a recommendation - the enhanced criterion is 44, Apple's guidance 44 pt and
 * Google's 48 dp - so an author who sets less is asking for something the control
 * will not do, and is told so rather than obeyed.
 */
export const TOUCH_TARGET_MIN_PX = 24;

/**
 * The default touch target, in CSS pixels.
 *
 * Between WCAG's 24 minimum and the 44-48 of the phone guidelines: an industrial
 * panel is usually operated with a gloved finger at arm's length rather than a
 * thumb, and 40 is the size this control's own reference panels were laid out
 * against. Easy to reverse: it is a default, not a contract.
 */
export const TOUCH_TARGET_DEFAULT_PX = 40;

/**
 * How many cells wide a hit group must be to reach the touch target.
 *
 * ---- ONE UNIT ----
 *
 * The obvious formula is `ceil(target / cellDevicePx)` - a CSS-pixel target over a
 * DEVICE-pixel cell. Those are the same number only at `devicePixelRatio` 1. At
 * dpr 3 a 60-device-pixel cell is 20 CSS px, and that formula returns 1, producing
 * a **20 CSS px target - below the 24 floor**. Both operands are converted to CSS
 * pixels here.
 *
 * **Minimum 1**, so grouping engages only when cells are already smaller than the
 * target. A cell bigger than a finger needs no group.
 *
 * **This governs HIT resolution only.** Painting stays at one device pixel per
 * bucket: a group is how much of the map one tap selects, not how coarsely it is
 * drawn. Conflating the two would throw away the resolution aggregation keeps.
 * @param targetCssPx   The touch target, in CSS pixels.
 * @param cellDevicePx  A cell's extent in device pixels.
 * @param dpr           Device pixels per CSS pixel.
 * @returns Cells per group, an integer of at least 1.
 */
export function groupSizeInCells(
    targetCssPx: number,
    cellDevicePx: number,
    dpr: number = 1,
): number {
    /*
     * ZERO MEANS NEVER GROUP, and it is the only value that does.
     *
     * The floor of 24 is right and stays: below it a target is smaller than WCAG
     * 2.2 SC 2.5.8 allows, and lowering it to escape grouping would trade one
     * defect for another. What was missing was a way to say "not at all" - and
     * without it, a map with 16 px dies grouped even at the lowest legal setting,
     * so per-die selection was unreachable and the selection ring never appeared
     *.
     *
     * A negative value is NOT the opt-out: that is a target that is too small, and
     * the control clamps and reports it. Zero is the absence of a target.
     */
    if (targetCssPx === 0) { return 1; }
    const ratio = dpr > 0 ? dpr : 1;
    const cellCssPx = cellDevicePx / ratio;
    if (!(cellCssPx > 0) || !Number.isFinite(cellCssPx)) { return 1; }
    // The floor doubles as the guard against a non-finite target: `max` would
    // propagate an Infinity, and there is no sane group size for one.
    const target = Number.isFinite(targetCssPx)
        ? Math.max(TOUCH_TARGET_MIN_PX, targetCssPx)
        : TOUCH_TARGET_MIN_PX;
    // At least 1 by construction, not by clamping: `target` is at least 24 and
    // `cellCssPx` is a positive finite number, so `ceil` cannot return less. A
    // clamp here would be a branch no input can reach.
    return Math.ceil(target / cellCssPx);
}

/**
 * The alpha an aggregated tile is drawn at when its bucket carries decorations.
 *
 * ---- WHY ALPHA, AFTER THE OTHER THREE CHANNELS WERE MEASURED AND REJECTED ----
 *
 * Under aggregation a bucket IS one device pixel, so there is no room for a
 * pattern, a hatch or a corner wedge - `renderGridDecorations` draws from
 * `DECORATION_MIN_PX` and simply stops. The tile can only say "there is more here"
 * by being a different color, and every color axis is already spoken for:
 *
 * - **Lightness** carries severity inside the aggregate band, and is what
 *   separates that band from the bin palette. Measured: a lighter variant
 *   falls to dE 0.118-0.146 against the theme, below the 0.153 floor. A darker one
 *   clears the theme easily but lands dE 0.09 from the aggregate UNKNOWN swatch -
 *   a collision inside the band, where decorated-pass would read as unclassified.
 * - **Chroma** is at the sRGB ceiling already. The band sits at L 0.28-0.36 where
 *   the gamut allows about 0.09, so every boost from +0.04 upward clamps; and the
 *   `unknown` swatch is achromatic, so a boost would give it a hue nobody chose.
 * - **Hue** would make a decorated tile read as a different bin family, which is
 *   the one thing the palette exists to communicate.
 *
 * Alpha is orthogonal to all three and cannot collide with anything by
 * construction: the substrate body shows faintly through, which is the
 * conventional way to mark "there is more here than the fill says". It costs one
 * mask and one or per decorated pixel and no extra table.
 */
export const DECORATED_ALPHA = 0xaa;

/** Saturation at or above which `MaxSeverity` is judged to have stopped informing. */
export const SATURATION_SWITCH_UP = 0.6;
/** Saturation at or below which `MaxSeverity` is judged useful again. */
export const SATURATION_SWITCH_DOWN = 0.4;

/**
 * Chooses the reducer for the NEXT frame from the one just drawn.
 *
 * ---- WHY MEASURED, AND WHY FED FORWARD ----
 *
 * The question is never "how much is this minified" but "has worst-wins stopped
 * saying anything", and those come apart. `P(a bucket holds a fail)` depends on
 * the defect RATE as much as the factor, and at one factor it spans 0.5 % to
 * 100 %. Predicting it from the document's own fail rate is no better: `1-(1-p)^n`
 * assumes independence, and every named WM-811K pattern is clustered - a simulated
 * edge ring predicted 0.968 and measured 0.355.
 *
 * So it is measured. It is fed FORWARD because that is what makes it free: the
 * reducer that just ran already accumulated the predicate, so the measurement is a
 * pass over buckets rather than over cells. One frame of lag on a gesture that
 * spans many.
 *
 * ---- HYSTERESIS ----
 *
 * Two thresholds, not one, so a map sitting near the boundary does not alternate
 * palettes as it is panned. Between them the previous choice stands, from either
 * direction.
 * @param previous   The reducer that drew the last frame.
 * @param saturation What that frame measured, or `null` when it did not aggregate.
 * @param override   `'Auto'` to apply the rule, or a reducer to force.
 * @returns The reducer for the next frame.
 */
export function selectReducer(
    previous: GridReducer,
    saturation: number | null,
    override: GridReducer | 'Auto' = 'Auto',
): GridReducer {
    // A value field is not a severity view, so neither the rule nor an explicit
    // override applies: `MaxSeverity` and `FailFraction` both ask about bin quality
    // and there is none to ask about. It sticks until the fill goes away.
    if (previous === 'ValueField') { return 'ValueField'; }
    if (override !== 'Auto') { return override; }
    // Nothing was measured - no aggregation, or nothing painted. The last decision
    // is still the right one for what is on screen, so it stands.
    if (saturation === null || !Number.isFinite(saturation)) { return previous; }
    if (saturation >= SATURATION_SWITCH_UP) { return 'FailFraction'; }
    if (saturation <= SATURATION_SWITCH_DOWN) { return 'MaxSeverity'; }
    return previous;
}

/**
 * Paints one device pixel per BUCKET rather than per sampled cell.
 *
 * ---- WHAT CHANGES, AND WHAT DOES NOT ----
 *
 * {@link renderGridImageData} gathers: for each pixel it inverts the lattice,
 * finds ONE cell and paints that. Every other cell in the pixel is invisible and
 * which one survives is decided by subpixel phase, which is the defect
 * `grid-aliasing.test.mjs` measures. This scatters instead - every cell reaches
 * the pixel it falls in - and reduces each bucket to a color.
 *
 * The street test is the one thing that is NOT carried over, and deliberately.
 * Below one cell per pixel the gap between cells is far under a pixel, so
 * rejecting a cell for landing in a street would discard data over a distinction
 * nothing can see. `getCellAtPos` still applies it, because a click is a point.
 *
 * ---- WHY THE COLOR COMES FROM A TABLE ----
 *
 * Both reducers resolve to a packed RGBA word by integer index: severity picks
 * one of four, the fraction picks one of {@link AGGREGATE_RAMP_STEPS}. Building a
 * CSS string per pixel would cost more than the entire scatter, and the tables are
 * built once per frame over the bin table.
 * ---- WHY IT DOES NOT SIMPLY `putImageData` ANY MORE ----
 *
 * `putImageData` REPLACES the destination rect, including the pixels no bucket
 * reached, so on a shared canvas it erased the substrate body around the map.
 * That is why the bucket pass used to sit behind `allowImageData` and why a
 * control with no layer cache never aggregated at all, whatever its factor said.
 *
 * When the caller does not own the rect, the buckets are composited over what is
 * already there instead: read the destination back, blend source-over in straight
 * alpha, write the result to the same rect. The rect written is the rect read, so
 * nothing outside it is touched.
 *
 * STRAIGHT ALPHA, not premultiplied, because that is what `ImageData` carries.
 * Blending premultiplied and writing back would round twice and drift the
 * decoration marks - the only partially transparent thing the pass emits.
 *
 * When the caller DOES own the rect the old path is kept exactly: a read-back is
 * not free, and over a transparent destination source-over is the identity, so
 * the composite would be work with no effect. The cached bitmap is byte-identical
 * to what it was before this change, which is asserted.
 * @param ctx      Target context.
 * @param grid     The grid.
 * @param lat      Cell coordinates -> device px.
 * @param agg      The aggregate paint.
 * @param mode     `'MaxSeverity'` or `'FailFraction'`.
 * @param bw       Bitmap width.
 * @param bh       Bitmap height.
 * @param owns     Whether the destination rect is exclusively this grid's. When
 *                 false the buckets are composited rather than written.
 * @returns Nothing.
 */
function renderGridAggregate(
    ctx: Context2D,
    grid: GridModel,
    lat: DOMMatrix,
    agg: GridAggregatePaint,
    mode: GridReducer,
    bw: number,
    bh: number,
    owns: boolean,
    sink: FilterBufferSink | null,
    filter: SpatialFilterRequest | null,
): number | null {
    const det = lat.a * lat.d - lat.b * lat.c;
    if (!(Math.abs(det) > 0)) { return null; }
    // Half-extents of 0.5 give the full pitch: the box must cover every cell that
    // contributes to a bucket, not only the drawn part of it.
    // Half-extents of 0.5 give the full PITCH: a cell contributes to a bucket
    // whether or not its drawn rectangle is inset by streets. NOT mutation-tested
    // - the scatter only runs below one device pixel per cell, so the difference
    // between a pitch-sized and an extent-sized box is a fraction of a pixel and
    // cannot change which bucket any cell lands in.
    const box = gridDeviceBox(grid, lat, 0.5, 0.5, bw, bh);
    if (!box) { return null; }

    const w = box.w;
    const h = box.h;
    const total = new Uint32Array(w * h);
    const acc = new Uint32Array(w * h);
    /*
     * A VALUE FIELD REDUCES BY TABLE INDEX. The index IS the ordering — the ramp was
     * built over `BinDefinitions` in document order — so "the most of
     * whatever this measures" is the highest index present, and `max` is already
     * the operator for that. No severity is consulted, because a relevance field
     * has none to consult.
     */
    const isValue = mode === 'ValueField' && agg.valueCells !== null && agg.valueColors !== null;
    const isMax = isValue || mode === 'MaxSeverity';
    const value = isValue ? null : (isMax ? agg.severity : agg.failFlag);
    const valueCells = isValue ? agg.valueCells : null;
    // One byte per BUCKET, not per cell, and only when the document has layers at
    // all: an undecorated map allocates nothing and never takes the branch.
    const cellDeco = grid.decorated ?? null;
    const deco = cellDeco === null ? null : new Uint8Array(w * h);

    // Scatter. Evaluated per cell rather than stepped - a running sum drifts a few
    // ULPs across a wide map and puts a whole column one pixel out at an exact
    // boundary.
    const { a, b, c: mc, d, e, f } = lat;
    const ox = e - box.x0;
    const oy = f - box.y0;
    const cells = grid.cells;
    const cols = grid.cols;
    /*
     * ---- ONE CELL, ONE PIXEL — OR ITS WHOLE FOOTPRINT ----
     *
     * Below one device pixel per cell the scatter writes a cell's CENTER and that
     * is right: many cells land in each pixel and the reduce averages them.
     *
     * Above it the same loop leaves holes. At 4 px/cell a cell covers sixteen
     * pixels and marks one, so 6.3 % of the tile is painted and the rest is
     * transparent - a dotted image, which is why the aggregation gate refuses to
     * bucket there at all. `FailDensity` asks for a density map at ANY zoom, so a cell
     * has to fill the pixels it actually covers.
     *
     * THE POINT PATH IS UNTOUCHED, deliberately and not merely by intention: it is
     * a separate branch, byte-identical to what it was, and the aggregate contact
     * sheet is compared before and after as the evidence. A single unified loop
     * would have been tidier and would have put the hot path's rounding at risk
     * for a case it never takes.
     */
    const footprintW = Math.abs(a) + Math.abs(mc);
    const footprintH = Math.abs(b) + Math.abs(d);
    const wantFootprint = footprintW > 1 || footprintH > 1;

    for (let r = 0; r < grid.rows; r++) {
        const cy = r + 0.5;
        const rx = mc * cy + ox;
        const ry = d * cy + oy;
        const base = r * cols;
        for (let col = 0; col < cols; col++) {
            const bin = cells[base + col];
            if (bin === 0) { continue; }            // null bin: neither num nor denom
            const cx = col + 0.5;
            // `bin` is the BASE's index and says there is substrate; the value comes
            // from the value overlay when one is bound.
            const v = valueCells !== null ? valueCells[base + col] : value![bin];
            const marked = cellDeco !== null && cellDeco[base + col] !== 0;

            if (!wantFootprint) {
                const px = Math.floor(a * cx + rx);
                const py = Math.floor(b * cx + ry);
                if (px < 0 || px >= w || py < 0 || py >= h) { continue; }
                const at = py * w + px;
                total[at]++;
                if (marked) { deco![at] = 1; }
                if (isMax) {
                    if (v > acc[at]) { acc[at] = v; }
                } else {
                    acc[at] += v;
                }
                continue;
            }

            /*
             * The axis-aligned bounding box of the cell's four corners. Under
             * rotation that box is larger than the cell, so neighbors overlap and a
             * pixel counts more than one cell - which the reduce handles correctly,
             * because it divides by `total`. An exact rotated fill would be a
             * polygon rasterizer, and the cost of that is not repaid by a density
             * map whose whole purpose is to be blurred afterwards.
             */
            const qx = a * cx + rx;
            const qy = b * cx + ry;
            const x0 = Math.max(0, Math.floor(qx - footprintW / 2));
            const x1 = Math.min(w - 1, Math.floor(qx + footprintW / 2 - 1e-9));
            const y0 = Math.max(0, Math.floor(qy - footprintH / 2));
            const y1 = Math.min(h - 1, Math.floor(qy + footprintH / 2 - 1e-9));
            for (let py = y0; py <= y1; py++) {
                const row = py * w;
                for (let px = x0; px <= x1; px++) {
                    const at = row + px;
                    total[at]++;
                    if (marked) { deco![at] = 1; }
                    if (isMax) {
                        if (v > acc[at]) { acc[at] = v; }
                    } else {
                        acc[at] += v;
                    }
                }
            }
        }
    }

    // Reduce. A bucket with no substrate is left transparent: `total`, never the
    // accumulator, decides whether a pixel is painted at all.
    const img = ctx.createImageData(w, h);
    const buf = new Uint32Array(img.data.buffer);
    const bySeverity = agg.bySeverity;
    const ramp = agg.ramp;
    const lastStep = AGGREGATE_RAMP_STEPS - 1;
    /*
     * SATURATION, measured here because it is FREE here. Whichever reducer
     * ran has already accumulated the predicate: `max >= FAIL` and `failCount > 0`
     * are the same test reached two ways, because `failValueTable` marks exactly
     * the bins whose severity reaches `SEVERITY_FAIL`. This is a pass over BUCKETS
     * — 22 500 of them at 150x150 — not over the map's million cells.
     */
    /*
     * THE FILTER BUFFERS, written in this loop or not at all.
     *
     * Allocated only when a sink was supplied, so a control with no filter active
     * pays nothing. The palette is chosen by reducer because the index means a
     * different thing in each: a severity LEVEL under `MaxSeverity`, a ramp step
     * under `FailFraction`, a value-table index under `ValueField`.
     */
    const paletteFor = isValue ? (agg.valueColors as Uint32Array) : (isMax ? bySeverity : ramp);
    /*
     * A value table can exceed 255 entries - it is the caller's color list and
     * nothing bounds it - and an index that does not fit a Uint8Array cannot be
     * recorded. Rather than truncate silently, no buffers are produced and the
     * reducer says why. `Box` and `Gauss` still work on such a field through the
     * SCALAR, which is what a relevance map is filtered with anyway.
     */
    /*
     * ALSO when a filter was asked for. The buffers were gated on a SINK
     * alone, and no control ever supplied one - so `fIndex` was always null and the
     * filter branch below could never be reached even once it existed.
     *
     * Two missing links, not one: the dispatch, and the allocation the dispatch
     * reads. Wiring the first and measuring found the second.
     */
    const wantBuffers = (sink != null || filter != null) && paletteFor.length <= 255;
    const fIndex = wantBuffers ? new Uint8Array(w * h).fill(FILTER_INDEX_EMPTY) : null;
    const fScalar = wantBuffers ? new Float32Array(w * h).fill(Number.NaN) : null;

    let painted = 0;
    let atFail = 0;
    for (let i = 0; i < total.length; i++) {
        const n = total[i];
        // NOT COVERED BY A MUTATION, deliberately: removing this guard changes no
        // OUTPUT. `bySeverity[0]` is 0 and `ramp[Math.round(NaN)]` is undefined,
        // which a Uint32Array stores as 0 — both transparent, which is what an
        // empty bucket must be anyway. It is kept because relying on that
        // coincidence to express "no substrate here" would be unreadable, and
        // because 0/0 reaching Math.round is not a thing to leave in a hot loop.
        if (n === 0) { continue; }
        painted++;
        // A value field has no failures to saturate on, so it reports none and the
        // feed-forward rule leaves the reducer where it is.
        if (isValue ? false : (isMax ? acc[i] >= SEVERITY_FAIL : acc[i] > 0)) { atFail++; }
        // The index is computed once and used twice - to pick the color and to
        // fill the buffer - so the two cannot disagree, as a property of this
        // being one variable rather than two expressions.
        let index: number;
        if (isValue) {
            index = acc[i];
            buf[i] = agg.valueColors![index] ?? 0;
        } else if (isMax) {
            // Ranks above SEVERITY_FAIL come from a priority list and share the
            // fail swatch, so the table is four entries whatever the author lists.
            index = acc[i] >= SEVERITY_FAIL ? SEVERITY_FAIL : acc[i];
            buf[i] = bySeverity[index];
        } else {
            index = Math.round((acc[i] / n) * lastStep);
            buf[i] = ramp[index];
        }
        if (fIndex !== null) {
            fIndex[i] = index;
            // Normalized to [0,1] so `Box` and `Gauss` mean the same thing whichever
            // reducer ran: a fail FRACTION already is one, a severity rank divides by
            // the fail level, a value index by its table.
            fScalar![i] = isValue
                ? (paletteFor.length > 1 ? index / (paletteFor.length - 1) : 0)
                : (isMax ? index / SEVERITY_FAIL : acc[i] / n);
        }
        /*
         * The decoration mark: the same color at a lower alpha, so the substrate
         * body shows faintly through. `packRgba` already handles byte order, so the
         * alpha lives in the top byte on a little-endian host and the bottom on a
         * big-endian one — and the mask has to follow it, or the mark would set a
         * color channel instead.
         */
        if (deco !== null && deco[i] !== 0) {
            buf[i] = LITTLE_ENDIAN
                ? ((buf[i] & 0x00ffffff) | (DECORATED_ALPHA << 24)) >>> 0
                : ((buf[i] & 0xffffff00) | DECORATED_ALPHA) >>> 0;
        }
    }
    /*
     * ---- THE FILTER RUNS HERE, AND NOWHERE ELSE ----
     *
     * Between the reduce loop that filled the bitmap and the composite that puts
     * it on the canvas. This is the only point where both things exist: the
     * buffers the filter reads, and the bitmap it repaints.
     *
     * A kernel tested against a `FilterBuffers` literal proves the maths, not the
     * wiring: without this call a bound `SpatialFilter` changes no pixel.
     *
     * BEFORE the composite, so a filtered frame composites once rather than
     * painting and then correcting. The caller's cache key already varies with the
     * filter, so a cached tile holds FILTERED pixels and a pan costs
     * nothing.
     */
    if (filter !== null && filter.kind !== 'None' && filter.radius > 0 && fIndex !== null) {
        /*
         * ---- ORIGIN 0,0, BECAUSE THE BITMAP IS THE BOX'S OWN ----
         *
         * `FilterBuffers.x`/`y` are the box's offset WITHIN THE CANVAS, for a
         * consumer holding the whole canvas. `buf` here is the box-sized
         * `ImageData` the bucket pass allocated, so its own origin is already the
         * box - and passing `box.x0`/`box.y0` made `repaintFromIndex` add the
         * offset a SECOND time.
         *
         * Every write landed displaced by one box origin: the wafer grew into the
         * corners of its bounding rectangle and lost its round shape, and an
         * edge-located cluster appeared twice - once where it belonged and once
         * shifted. 734 pixels were painted outside the wafer and not one was taken
         * away, which is the signature of a translation rather than a bad kernel.
         *
         * The sink's copy below keeps the real origin, because its consumer holds
         * the canvas. **`x`/`y` are relative to the bitmap passed alongside them**,
         * and the two callers pass different bitmaps.
         */
        applySpatialFilter({
            x: 0, y: 0, width: w, height: h,
            index: fIndex, palette: paletteFor,
            scalar: fScalar as Float32Array,
            rankByIndex: rankTableFor(mode, paletteFor.length),
            reducer: mode,
        }, filter, buf, w);
    }

    if (owns) {
        ctx.putImageData(img, box.x0, box.y0);
    } else {
        compositeOver(ctx, img, box.x0, box.y0);
    }

    if (sink != null) {
        // Set even when the buffers were declined, so a caller can tell "this frame
        // did not bucket" from "this frame bucketed and the palette was too large".
        sink.buffers = fIndex === null ? null : {
            x: box.x0,
            y: box.y0,
            width: w,
            height: h,
            index: fIndex,
            palette: paletteFor,
            scalar: fScalar as Float32Array,
            rankByIndex: rankTableFor(mode, paletteFor.length),
            reducer: mode,
        };
    }
    return painted === 0 ? null : atFail / painted;
}

/**
 * Draws `src` over the destination rect with source-over, in straight alpha.
 *
 * `putImageData` cannot composite and `drawImage` cannot take an `ImageData`, and
 * the bridge between them - `createImageBitmap` - is a Promise, which a
 * synchronous render pass cannot await. So the destination is read back, blended
 * and written to the SAME rect: everything outside it is untouched, and no
 * scratch surface is needed. That last point is the one that matters, because a
 * scratch surface would mean `OffscreenCanvas` or a `document`, and needing
 * either is how the bucket pass came to depend on the layer cache in the first
 * place.
 *
 * The blend is the Porter-Duff over operator on straight (non-premultiplied)
 * alpha, which is what `ImageData` carries:
 *
 *     aOut = aSrc + aDst * (1 - aSrc)
 *     cOut = (cSrc * aSrc + cDst * aDst * (1 - aSrc)) / aOut
 *
 * Two shortcuts, both exact rather than approximate: a fully transparent source
 * pixel leaves the destination alone, and a fully opaque one replaces it. Between
 * them lies only the decoration mark, which is the single partially transparent
 * thing this pass emits.
 * @param ctx Destination context.
 * @param src The buckets.
 * @param x0  Destination x in device pixels.
 * @param y0  Destination y in device pixels.
 * @returns Nothing.
 */
function compositeOver(ctx: Context2D, src: ImageData, x0: number, y0: number): void {
    const dst = ctx.getImageData(x0, y0, src.width, src.height);
    const s = src.data;
    const d = dst.data;
    for (let i = 0; i < s.length; i += 4) {
        const sa = s[i + 3];
        if (sa === 0) { continue; }                      // nothing here: keep the body
        if (sa === 255) {                                // opaque: replace, no arithmetic
            d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = 255;
            continue;
        }
        const as = sa / 255;
        const ad = d[i + 3] / 255;
        const ao = as + ad * (1 - as);
        if (ao <= 0) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0; continue; }
        for (let k = 0; k < 3; k++) {
            d[i + k] = Math.round((s[i + k] * as + d[i + k] * ad * (1 - as)) / ao);
        }
        d[i + 3] = Math.round(ao * 255);
    }
    ctx.putImageData(dst, x0, y0);
}

/**
 * Device-pixel bounding box of the drawn lattice, clamped to the bitmap, or
 * `null` when the grid falls entirely outside it. Used by the ImageData strategy
 * to size and place its buffer so the per-pixel loop visits only pixels the grid
 * can actually reach.
 * @param grid  The grid.
 * @param lat   The lattice->device matrix (`Sc(dpr) * W * lattice`).
 * @param halfA Column half-extent in lattice units.
 * @param halfB Row half-extent in lattice units.
 * @param bw    Bitmap width in device pixels.
 * @param bh    Bitmap height in device pixels.
 * @returns The clamped integer box, or `null` when empty.
 */
function gridDeviceBox(
    grid: GridModel,
    lat: DOMMatrix,
    halfA: number,
    halfB: number,
    bw: number,
    bh: number,
): { x0: number; y0: number; w: number; h: number } | null {
    const a0 = 0.5 - halfA;
    const a1 = grid.cols - 0.5 + halfA;
    const b0 = 0.5 - halfB;
    const b1 = grid.rows - 0.5 + halfB;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < 4; i++) {
        const a = (i === 1 || i === 2) ? a1 : a0;
        const b = (i >= 2) ? b1 : b0;
        const x = lat.a * a + lat.c * b + lat.e;
        const y = lat.b * a + lat.d * b + lat.f;
        if (x < minX) { minX = x; }
        if (x > maxX) { maxX = x; }
        if (y < minY) { minY = y; }
        if (y > maxY) { maxY = y; }
    }
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(bw, Math.ceil(maxX));
    const y1 = Math.min(bh, Math.ceil(maxY));
    // `!(x1 > x0)` rather than `x1 <= x0` so a NaN extent rejects rather than passes.
    return (!(x1 > x0) || !(y1 > y0)) ? null : { x0, y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * RUN STRATEGY (>= {@link GRID_RUN_STRATEGY_PX} device pixels per cell): pushes
 * the lattice basis onto the CTM once and fills batched same-color row runs with
 * `fillRect`.
 *
 * Under `Sc(dpr) * W * lattice` a drawn cell is the axis-aligned lattice box of
 * the section header, so ONE `setTransform` buys the rotation, the axis flip and
 * every AxisDirection sign combination, and `fillRect` needs no `Path2D`. Per
 * row, maximal spans of one color group are found and the `fillStyle` is set once
 * per span. A street-free lattice (`cellWmm === |colStep|`) additionally collapses
 * the whole span into a SINGLE `fillRect`; with a street the span still costs one
 * `fillRect` per cell, because the gaps must stay unpainted, but only one
 * `fillStyle` assignment. No per-cell object, no per-cell `Path2D`, no per-cell
 * `save`/`restore`.
 *
 * Cell edges are left to canvas antialiasing rather than snapped to device
 * pixels: snapping would displace the painted cell from the mathematical one by
 * up to half a pixel and break the "hit region == painted shape" invariant, and
 * with a street - the normal die-map case - adjacent cells do not touch, so there
 * is nothing to seam.
 * @param ctx   Target context (layer bitmap, or the canvas itself when uncached).
 * @param grid  The grid.
 * @param lat   The lattice->device matrix.
 * @param paint The resolved paint.
 * @param halfA Column half-extent in lattice units.
 * @param halfB Row half-extent in lattice units.
 */
function renderGridRuns(
    ctx: Context2D,
    grid: GridModel,
    lat: DOMMatrix,
    paint: GridPaint,
    halfA: number,
    halfB: number,
): void {
    // The FILL comes from a value overlay when one is bound; the grid still says
    // where there is substrate. `mask` is null on the ordinary path, where the
    // extra test is one comparison against a constant.
    const cells = paint.fillCells ?? grid.cells;
    const mask = paint.fillCells === null ? null : grid.cells;
    const cols = grid.cols;
    const rows = grid.rows;
    const groups = paint.groups;
    const colorsByGroup = paint.colors;
    const w = 2 * halfA;
    const h = 2 * halfB;
    const merge = w >= 1 - GRID_MERGE_EPS;        // street-free along the column axis
    const dx = 0.5 - halfA;
    const dy = 0.5 - halfB;
    ctx.save();
    ctx.setTransform(lat.a, lat.b, lat.c, lat.d, lat.e, lat.f);
    for (let r = 0; r < rows; r++) {
        const base = r * cols;
        const y = r + dy;
        let c = 0;
        while (c < cols) {
            // A value field owns the color; the base still owns the substrate, so
            // a cell is painted only when BOTH say something. `mask` is null on the
            // ordinary path, where this is one comparison against a constant.
            const g = mask !== null && mask[base + c] === 0 ? 0 : groups[cells[base + c]];
            if (g === 0) {                        // null bin: never painted
                c++;
                continue;
            }
            let end = c + 1;
            while (end < cols
                && (mask !== null && mask[base + end] === 0 ? 0 : groups[cells[base + end]]) === g) {
                end++;
            }
            ctx.fillStyle = colorsByGroup[g];     // once per run
            if (merge) {
                ctx.fillRect(c + dx, y, (end - c - 1) + w, h);
            } else {
                for (let k = c; k < end; k++) {
                    ctx.fillRect(k + dx, y, w, h);
                }
            }
            c = end;
        }
    }
    ctx.restore();
}

/**
 * IMAGEDATA STRATEGY (< {@link GRID_RUN_STRATEGY_PX} device pixels per cell):
 * writes the layer pixel by pixel through the INVERSE of the lattice matrix.
 *
 * Below the switch point many cells collapse onto one pixel, so per-cell work is
 * wasted; walking the pixels instead bounds the cost by the SCREEN. Each pixel
 * center is mapped back to lattice coordinates - the same inversion
 * {@link getCellAtPos} performs, so a pixel is colored exactly when a click on it
 * would hit that cell - and the bin's packed color is stored with one word write.
 * The inverse is applied incrementally (a constant delta per pixel and per row),
 * so the inner loop is two adds, two `Math.floor`s, four compares and one store.
 *
 * REPLACES rather than composites: `putImageData` ignores the CTM and the
 * compositing state, so this strategy is only valid on a bitmap the grid owns
 * exclusively - i.e. the layer cache. The uncached path must use
 * {@link renderGridRuns} or it would erase the substrate body underneath; the
 * `allowImageData` gate in {@link renderGridLayer} enforces that.
 * @param ctx   Target context - MUST own the destination rect exclusively.
 * @param grid  The grid.
 * @param lat   The lattice->device matrix.
 * @param rgba  Packed color per group (from {@link GridPaint.rgba}).
 * @param paint The resolved paint.
 * @param halfA Column half-extent in lattice units.
 * @param halfB Row half-extent in lattice units.
 * @param bw    Bitmap width in device pixels.
 * @param bh    Bitmap height in device pixels.
 */
function renderGridImageData(
    ctx: Context2D,
    grid: GridModel,
    lat: DOMMatrix,
    rgba: Uint32Array,
    paint: GridPaint,
    halfA: number,
    halfB: number,
    bw: number,
    bh: number,
): void {
    const det = lat.a * lat.d - lat.b * lat.c;
    if (!(Math.abs(det) > 0)) {
        return;
    }
    const box = gridDeviceBox(grid, lat, halfA, halfB, bw, bh);
    if (!box) {
        return;
    }
    const img = ctx.createImageData(box.w, box.h);
    const buf = new Uint32Array(img.data.buffer);
    // Inverse of `lat` as per-pixel / per-row deltas: a(x,y) and b(x,y) are affine,
    // so stepping one device pixel adds a constant.
    const dadx = lat.d / det;
    const dbdx = -lat.b / det;
    const dady = -lat.c / det;
    const dbdy = lat.a / det;
    const px0 = box.x0 + 0.5 - lat.e;             // first pixel CENTER, lattice-relative
    const py0 = box.y0 + 0.5 - lat.f;
    let aRow = dadx * px0 + dady * py0;
    let bRow = dbdx * px0 + dbdy * py0;
    const groups = paint.groups;
    // The FILL comes from a value overlay when one is bound; the grid still says
    // where there is substrate. `mask` is null on the ordinary path, where the
    // extra test is one comparison against a constant.
    const cells = paint.fillCells ?? grid.cells;
    const mask = paint.fillCells === null ? null : grid.cells;
    const cols = grid.cols;
    const rows = grid.rows;
    let o = 0;
    for (let yy = 0; yy < box.h; yy++) {
        let a = aRow;
        let b = bRow;
        for (let xx = 0; xx < box.w; xx++, o++) {
            // `c >= 0 && c < cols` (not `c < 0 || c >= cols`) so a NaN rejects.
            const c = Math.floor(a);
            if (c >= 0 && c < cols) {
                const r = Math.floor(b);
                if (r >= 0 && r < rows) {
                    const fa = a - c - 0.5;       // street test: identical to getCellAtPos
                    if (fa >= -halfA && fa <= halfA) {
                        const fb = b - r - 0.5;
                        if (fb >= -halfB && fb <= halfB) {
                            const at = r * cols + c;
                            const g = mask !== null && mask[at] === 0
                                ? 0 : groups[cells[at]];
                            if (g !== 0) {        // null bin: left transparent
                                buf[o] = rgba[g];
                            }
                        }
                    }
                }
            }
            a += dadx;
            b += dbdx;
        }
        aRow += dady;
        bRow += dbdy;
    }
    ctx.putImageData(img, box.x0, box.y0);
}

/**
 * Draws the decoration marks for every composed layer, over the finished grid.
 *
 * A MARK, NEVER A FILL. Each decoration puts a small right-triangle wedge in one
 * corner of every cell it names, in the layer's color - so a cell carrying three
 * judgements shows three wedges in three corners and the BASE fill underneath is
 * never obscured. Painting the cell instead would destroy the base's color,
 * which is the one thing `StatusColorMapping` is authoritative about.
 *
 * CORNER PER LAYER, color per layer. Layer 0 takes the top-left, 1 the
 * top-right, 2 the bottom-right, 3 the bottom-left; beyond four the corners
 * repeat at a smaller inset. Position is what distinguishes layers at a glance;
 * color is redundant reinforcement, which matters because a viewer with a
 * color-vision deficiency still sees four distinct corners.
 *
 * NULL CELLS ARE SKIPPED. Bin index 0 is the reserved null bin - "this overlay
 * says nothing about this cell" - and a mark there would assert coverage the
 * document never claimed.
 *
 * NOTHING HAPPENS WITHOUT LAYERS. The whole pass is behind one `undefined`
 * check, so a single-overlay map is rendered by exactly the code a map without
 * layers needs, with no extra state touched.
 *
 * @param ctx    2D context, already under the grid's matrix.
 * @param grid   The model; `grid.layers` drives the pass.
 * @param colors Resolved colors; `colors.decoration` is the layer palette.
 */
export function renderGridDecorations(
    ctx: Context2D,
    grid: GridModel,
    colors: SubstrateMapColors,
    scale = 0,
): void {
    const layers = grid.layers;
    if (layers === undefined || layers.length === 0) { return; }
    const palette = (colors.decoration && colors.decoration.length > 0)
        ? colors.decoration
        : ['rgb(0, 90, 200)'];
    const cols = grid.cols;
    const rows = grid.rows;
    const pl = grid.placement;
    /*
     * Wedge size: HALF the cell, with a screen-constant floor.
     *
     * The first version used a third and nothing else. Measured in a live view
     * on a 4-inch wafer that came out at ~13 CSS px on an 80 px cell - about 3%
     * of the cell area, which reads as a speck rather than as data. Half is the
     * largest a corner wedge can be before two adjacent corners meet.
     *
     * The floor is the `EDGE_PX / s` idiom the origin marker already uses: at a
     * zoom where a cell is only a few pixels the fraction alone would vanish.
     * `scale` is CSS px per mm; 0 (the default) disables the floor, so a caller
     * that does not pass it behaves exactly as before.
     */
    const FRAC = 1 / 2;
    const floor = scale > 0 ? DECORATION_MIN_PX / scale : 0;
    const w = Math.max(pl.cellWmm * FRAC, Math.min(floor, pl.cellWmm));
    const h = Math.max(pl.cellLmm * FRAC, Math.min(floor, pl.cellLmm));

    for (let li = 0; li < layers.length; li++) {
        const layer = layers[li];
        const cells = layer.cells;
        ctx.fillStyle = palette[li % palette.length];
        const corner = li % 4;
        // Beyond four layers the corners repeat, inset so the second ring is
        // still distinguishable from the first.
        const inset = Math.floor(li / 4) * Math.min(w, h);
        for (let r = 0; r < rows; r++) {
            for (let col = 0; col < cols; col++) {
                if (cells[r * cols + col] === 0) { continue; }
                // Cell center in the substrate frame, exactly as the grid renderer
                // computes it - so a wedge cannot drift from its cell.
                const cx = pl.originXmm + (col + 0.5) * pl.colStepXmm + (r + 0.5) * pl.rowStepXmm;
                const cy = pl.originYmm + (col + 0.5) * pl.colStepYmm + (r + 0.5) * pl.rowStepYmm;
                const x0 = cx - pl.cellWmm / 2;
                const y0 = cy - pl.cellLmm / 2;
                const x1 = cx + pl.cellWmm / 2;
                const y1 = cy + pl.cellLmm / 2;
                ctx.beginPath();
                if (corner === 0) {
                    ctx.moveTo(x0 + inset, y0 + inset);
                    ctx.lineTo(x0 + inset + w, y0 + inset);
                    ctx.lineTo(x0 + inset, y0 + inset + h);
                } else if (corner === 1) {
                    ctx.moveTo(x1 - inset, y0 + inset);
                    ctx.lineTo(x1 - inset - w, y0 + inset);
                    ctx.lineTo(x1 - inset, y0 + inset + h);
                } else if (corner === 2) {
                    ctx.moveTo(x1 - inset, y1 - inset);
                    ctx.lineTo(x1 - inset - w, y1 - inset);
                    ctx.lineTo(x1 - inset, y1 - inset - h);
                } else {
                    ctx.moveTo(x0 + inset, y1 - inset);
                    ctx.lineTo(x0 + inset + w, y1 - inset);
                    ctx.lineTo(x0 + inset, y1 - inset - h);
                }
                ctx.closePath();
                ctx.fill();
            }
        }
    }
}

/**
 * Renders the grid layer with the strategy the current zoom calls for. The
 * public entry point of the two strategies; called by {@link drawSubstrateMap}
 * through the layer cache (and directly, on the uncached fallback path).
 *
 * STRATEGY SWITCH: the drawn cell's smaller device extent decides. At or above
 * {@link GRID_RUN_STRATEGY_PX} device pixels per cell the batched-`fillRect`
 * {@link renderGridRuns} wins; below it the per-pixel {@link renderGridImageData}
 * does - see {@link GRID_RUN_STRATEGY_PX} for where the number comes from. The
 * per-pixel path additionally requires numerically resolved colors
 * ({@link GridPaint.rgba}) and a bitmap the grid owns exclusively
 * (`allowImageData`); when either is missing the run strategy is used at any zoom,
 * which is slower but always correct.
 * @param ctx             Target context (layer bitmap, or the canvas when uncached).
 * @param grid            The grid.
 * @param dev             The device matrix `Sc(dpr) * W` (frame S -> device pixels).
 * @param paint           The resolved paint.
 * @param bitmapWidth     Target bitmap width in device pixels.
 * @param bitmapHeight    Target bitmap height in device pixels.
 * @param allowImageData  Whether the target rect is exclusively the grid's. The
 *                        gather strategy needs it, because `putImageData`
 *                        replaces; the BUCKET pass no longer does, because it
 *                        composites when the rect is shared.
 */
export function renderGridLayer(
    ctx: Context2D,
    grid: GridModel,
    dev: DOMMatrix,
    paint: GridPaint,
    bitmapWidth: number,
    bitmapHeight: number,
    allowImageData: boolean,
    reducer: GridReducer = 'MaxSeverity',
    sink?: FilterBufferSink | null,
    forceAggregate: boolean = false,
    filter?: SpatialFilterRequest | null,
): number | null {
    const p = grid.placement;
    const halfA = gridHalfA(p);
    const halfB = gridHalfB(p);
    if (!(halfA > 0) || !(halfB > 0)) {
        return null;                               // degenerate cells: nothing to paint
    }
    const lat = dev.multiply(latticeMatrix(p));    // (a, b) -> device px
    // Uniform scale of the device chain = its a-vector length (as getItemAtPos
    // computes it), so this stays right once rotations are in the chain.
    const pxPerCell = Math.min(p.cellWmm, p.cellLmm) * Math.hypot(dev.a, dev.b);
    /*
     * THE BUCKET PASS RUNS WHETHER OR NOT THE RECT IS OURS. It composites
     * when it is not, so the substrate body survives under it - which is what used
     * to force it behind `allowImageData` and what stopped an uncached control
     * from ever aggregating. The condition below is a strict subset of
     * the one that follows, since `GRID_RUN_STRATEGY_PX` is 3, so hoisting it out
     * changes the owned path not at all.
     */
    /*
     * `forceAggregate` is `FieldView = FailDensity` asking for a density map at any
     * zoom - the one case where a CHANNEL choice overrides the rule that only a
 * frame below one device pixel per cell buckets,
     * and it is explicit: the operator asked for it. Without it the condition is
     * exactly what it was.
     */
    if (paint.aggregate && (pxPerCell < 1 || forceAggregate)) {
        // The only branch that measures anything: the other two do not bucket,
        // so there is no saturation to report and `null` says so.
        return renderGridAggregate(ctx, grid, lat, paint.aggregate, reducer,
            bitmapWidth, bitmapHeight, allowImageData, sink ?? null, filter ?? null);
    }
    if (allowImageData && pxPerCell < GRID_RUN_STRATEGY_PX) {
        /*
         * Below the threshold a cell is smaller than a device pixel, so SOMETHING
         * has to be lost. Aggregating loses the least: every cell reaches a bucket
         * and the bucket is reduced. Point sampling is the fallback for a paint
         * that could not build an aggregate palette - one unparsable theme color
         * disables it, as it disables `rgba` - and it is strictly worse, which is
         * why it is second and not first.
         */
        // ONLY BELOW ONE DEVICE PIXEL PER CELL, which is handled above. The
        // scatter paints one pixel per CELL, so where a cell is larger than a
        // pixel it paints a sparse dotted pattern and leaves the rest of the cell
        // blank. Between 1 and GRID_RUN_STRATEGY_PX the gather is exact - each
        // pixel maps to one cell and no cell can be lost, because cells are bigger
        // than pixels - so it keeps that band. Aggregation is the answer to cells
        // being too SMALL.
        if (paint.rgba) {
            renderGridImageData(ctx, grid, lat, paint.rgba, paint, halfA, halfB, bitmapWidth, bitmapHeight);
            return null;
        }
        renderGridRuns(ctx, grid, lat, paint, halfA, halfB);
        return null;
    }
    renderGridRuns(ctx, grid, lat, paint, halfA, halfB);
    return null;
}

/**
 * The grid layer's offscreen bitmap cache: one bitmap per owning control, reused
 * across redraws and re-rendered only when its key changes.
 *
 * WHY: a 750k-cell layer costs a rasterization the control must not repeat when
 * something ELSE on the canvas changes (an item is selected, a label moves, the
 * origin marker toggles). The cache turns those redraws into a 1:1 `drawImage`.
 *
 * KEY: not just scale, rotation, selection version and data version; this
 * implementation keys on the exact generalization of the first two plus the terms
 * this design actually needs -
 *  - the six components of the device matrix `Sc(dpr) * W`, which subsume scale,
 *    rotation, the axis flip, the device-pixel ratio AND the canvas center (a
 *    resize can move the center while leaving the scale untouched, and the bitmap
 *    is canvas-sized, so the center must invalidate it);
 *  - the bitmap size;
 *  - the caller's DATA VERSION (a new lattice / new cells);
 *  - the paint signature ({@link GridPaint.signature}), so a theme switch or a
 *    StatusColorMapping edit invalidates the bitmap even though the data did not
 *    change - the stated key has no term for that and would go stale.
 * The SELECTION version is deliberately absent: selection rings are drawn live on
 * top of the blit, never baked in (see {@link drawSubstrateMap}), so a click must
 * not - and does not - cost a re-render of the layer.
 *
 * The bitmap is canvas-sized and rendered with the FULL device transform, so the
 * blit is `drawImage(bitmap, 0, 0)` under an identity CTM: integer-aligned, 1:1,
 * no resampling and bit-identical to an uncached render, which is what keeps the
 * blitted pixels and the hit region exact inverses. Sizing the bitmap to the
 * layer's own device extent instead would save memory but would put a fractional
 * translation between the two, at which point the blit either resamples or shifts.
 *
 * Requires `OffscreenCanvas`; where it is missing {@link acquire} returns `null`
 * and the caller renders live. Using `OffscreenCanvas` rather than a detached
 * `<canvas>` keeps the engine's "no DOM" contract literal: it allocates a bitmap
 * and touches no `document`, no layout, no attribute and no theme.
 */
export class GridLayerCache {
    /** The layer bitmap, or `null` before the first {@link acquire} / after {@link dispose}. */
    private __canvas: OffscreenCanvas | null = null;

    /** 2D context of {@link __canvas}; lifetime identical to the bitmap. */
    private __ctx: OffscreenCanvasRenderingContext2D | null = null;

    /** Key the current bitmap contents were rendered for, or `null` when unrendered. */
    private __key: string | null = null;

    /**
     * Whether this platform can back the cache at all. `false` disables caching
     * (every draw renders live) but never disables the grid.
     * @returns Whether `OffscreenCanvas` exists.
     */
    public static isSupported(): boolean {
        return typeof OffscreenCanvas !== 'undefined';
    }

    /**
     * Returns the layer bitmap for `key`, rendering it through `render` on a miss
     * and returning the untouched bitmap on a hit.
     * @param width  Required bitmap width in device pixels.
     * @param height Required bitmap height in device pixels.
     * @param key    The cache key (see the class doc).
     * @param render Renders the layer into the cleared bitmap; called only on a miss.
     * @returns The bitmap to blit, or `null` when the cache is unavailable.
     */
    public acquire(width: number, height: number, key: string, render: (ctx: Context2D) => void): OffscreenCanvas | null {
        if (!(width > 0) || !(height > 0) || typeof OffscreenCanvas === 'undefined') {
            return null;
        }
        let canvas = this.__canvas;
        if (!canvas) {
            canvas = new OffscreenCanvas(width, height);
            this.__canvas = canvas;
            this.__ctx = canvas.getContext('2d');
            this.__key = null;
        }
        const ctx = this.__ctx;
        if (!ctx) {
            this.dispose();
            return null;
        }
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;                  // resizing also clears the bitmap
            canvas.height = height;
            this.__key = null;
        }
        if (this.__key === key) {
            return canvas;
        }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, width, height);
        render(ctx);
        this.__key = key;
        return canvas;
    }

    /** Drops the rendered contents, forcing the next {@link acquire} to re-render. */
    public invalidate(): void {
        this.__key = null;
    }

    /** Releases the bitmap. Called from the owning control's `__detach`. */
    public dispose(): void {
        if (this.__canvas) {
            this.__canvas.width = 1;               // release the backing store eagerly
            this.__canvas.height = 1;
        }
        this.__canvas = null;
        this.__ctx = null;
        this.__key = null;
    }
}

/**
 * The grid layer as handed to {@link drawSubstrateMap}: the model, the current
 * cell selection, the caller's data version and the caller-owned cache. Bundled
 * (like {@link MapConfig} / {@link MapMatrices} / {@link SubstrateMapColors})
 * rather than spread over four more positional parameters, because the four are
 * one cohesive thing and are always supplied together.
 */
/**
 * The buffers a spatial filter reads, written while the aggregate pass paints.
 *
 * ---- WHY THEY FALL OUT OF THE RENDER RATHER THAN BEING COMPUTED ----
 *
 * The bucket pass already knows the palette index of every pixel - it is what
 * chooses the color - and `FailFraction` already computes the scalar. Deriving
 * either afterwards would mean a second pass that could disagree with the first,
 * and a filter that disagrees with the picture is worse than no filter.
 *
 * ---- `palette` IS PART OF THE ANSWER, NOT DECORATION ----
 *
 * `index` alone cannot be checked against anything. With the palette beside it,
 * `palette[index[i]]` is exactly the word the pass wrote to the bitmap, so
 * "the index buffer agrees with the color actually present" is a comparison
 * rather than a belief.
 */
/**
 * The {@link FilterBuffers.index} value for a pixel nothing painted.
 *
 * 255 and not 0: 0 is a real index in every palette here, so an unpainted pixel
 * and the first ramp step would be indistinguishable, and a median over a partly
 * empty neighborhood would count empty space as a bin. That is the exact defect
 * `bucketIsPainted` exists to prevent one layer down.
 */
export const FILTER_INDEX_EMPTY = 255;

/**
 * Severity rank per palette index, for the morphological operations.
 *
 * `Min` and `Max` are erosion and dilation over SEVERITY, which is a property of
 * the bin rather than of the color. The table differs by reducer:
 *
 *   - `MaxSeverity` — the index already IS the severity level, so this is the
 *     identity. Built anyway so the filter never has to know which reducer ran.
 *   - `FailFraction` — a ramp step has no bin behind it, so there is no bin
 *     severity to look up. The step itself orders the same way a rank does: a
 *     higher step is a worse bucket, which is what erosion and dilation need.
 *   - `ValueField` — a relevance map has no severity at all. The table
 *     is the index, and a caller applying `Min`/`Max` to it is ordering by value,
 *     which is a coherent thing to want and is not severity.
 *
 * Built here rather than in the filter so the two cannot drift apart.
 * @param mode The reducer that ran.
 * @param size The palette length.
 * @returns The table.
 */
function rankTableFor(mode: GridReducer, size: number): Uint8Array {
    const table = new Uint8Array(size);
    if (mode === 'MaxSeverity') {
        /*
         * The index IS the severity level here - `bySeverity` is indexed by level,
         * not by rank - so the table is the ladder from `BinSeverity.ts` and stops
         * at `SEVERITY_FAIL`. Written out against the named constants rather than
         * as `i`, so that a change to the ladder reaches this table instead of
         * silently agreeing with it by coincidence.
         */
        for (let i = 0; i < size; i++) {
            table[i] = i >= SEVERITY_FAIL ? SEVERITY_FAIL
                : i === SEVERITY_UNKNOWN ? SEVERITY_UNKNOWN
                    : i === SEVERITY_PASS ? SEVERITY_PASS : SEVERITY_NULL;
        }
        return table;
    }
    /*
     * `FailFraction` and `ValueField` have no bin behind an index - a ramp step and
     * a value-table entry are not bins - so there is no severity to look up. The
     * index orders the same way a rank does, which is what erosion and dilation
     * need, and saying so here is better than pretending the ladder applies.
     */
    for (let i = 0; i < size; i++) { table[i] = i > 255 ? 255 : i; }
    return table;
}

export interface FilterBuffers {
    /**
     * Left edge of the covered rectangle within the bitmap, in device pixels.
     *
     * THE BUFFERS COVER THE MAP'S BOX, NOT THE WHOLE BITMAP. The bucket pass
     * allocates an `ImageData` the size of the map's device box and blits it at an
     * offset, so a buffer indexed like the bitmap would be mostly empty and a
     * consumer indexing it like the box would read the wrong pixels. Carrying the
     * origin is cheaper than either, and it is the first thing a filter needs.
     *
     * Found by an assertion that indexed the canvas while the buffers indexed the
     * box: 589 of 900 pixels "disagreed", and the buffers were right.
     */
    readonly x: number;
    /** Top edge of the covered rectangle. */
    readonly y: number;
    /** Width of the covered rectangle in device pixels. */
    readonly width: number;
    /** Height of the covered rectangle. */
    readonly height: number;
    /**
     * Palette index per pixel, or 255 where nothing was painted.
     *
     * 255 rather than 0, because 0 is a real index in every palette here - the
     * unpainted-pixel color and the first ramp step would otherwise be the same
     * value, and a median over a partly empty neighborhood would count empty
     * space as a bin.
     */
    readonly index: Uint8Array;
    /** Packed color per index. `palette[index[i]]` is what the pass painted. */
    readonly palette: Uint32Array;
    /** The reduced value per pixel in `[0, 1]`, or `NaN` where nothing was painted. */
    readonly scalar: Float32Array;
    /**
     * Severity rank per palette INDEX, for the morphological operations.
     *
     * `Min` and `Max` are erosion and dilation over severity, and severity is a
     * property of the bin rather than of the color. Under `MaxSeverity` the index
     * IS the rank, so this is the identity; under `FailFraction` a ramp step has no
     * bin behind it and the rank is the step itself, which orders the same way.
     * Built here rather than by the filter so the two cannot drift.
     */
    readonly rankByIndex: Uint8Array;
    /** Which reducer produced these, because the palettes differ by reducer. */
    readonly reducer: GridReducer;
}

/**
 * Where {@link FilterBuffers} are deposited, when a caller wants them.
 *
 * A sink rather than a return value: `renderGridLayer` already returns the
 * measured saturation, and the buffers are wanted by ONE caller in one mode.
 * Putting them on {@link GridLayer} - which the base already builds per frame and
 * already uses to carry the cache - threads them through two signatures instead
 * of four.
 *
 * **Absent means not wanted, and nothing is allocated.** That is a property of
 * the sink being optional rather than of a flag being
 * checked in three places.
 */
export interface FilterBufferSink {
    /** Filled by the aggregate pass; `null` until then, and after a frame that did not bucket. */
    buffers: FilterBuffers | null;
}

export interface GridLayer {
    /** The render-ready grid. */
    model: GridModel;
    /** Selected cells as row-major linear indices, or `null` when nothing is selected. */
    selected: ReadonlySet<number> | null;
    /**
     * Monotonic version of {@link model}'s DATA, bumped by the shell whenever it
     * pushes a different grid. It is what tells the cache that the cells or the
     * placement changed; identity of the model object is not used, so a caller that
     * rebuilds a model with identical contents can keep the cached bitmap.
     */
    dataVersion: number;
    /** The caller-owned layer cache, or `null` to render live every draw. */
    cache: GridLayerCache | null;
    /**
     * Where to deposit {@link FilterBuffers}, or absent when no filter is active.
     *
     * Only the BUCKET pass fills it. The other two strategies draw one pixel per
     * cell or one rect per run, so there is no per-pixel palette index to record -
     * and a filter at those zooms would be filtering a picture the operator can
     * already read cell by cell.
     */
    filterSink?: FilterBufferSink;
    /**
     * Everything about the filter surface that changes the image, as one string.
     *
     * Joins the cache key. Assembled by the CONTROL, because the engine has no
     * idea what a filter surface looks like and should not learn - the same
     * division that keeps the aggregate palette outside `Engine.ts`.
     */
    filterKey?: string;
    /**
     * The spatial filter to run on the aggregated frame, or absent for none.
     *
     * Set by the control from its own attributes. The RAMP is not here - it
     * belongs to the paint, which the layer does not own - so `filterRequest`
     * assembles the two at the call site.
     */
    spatialFilter?: { kind: string; radius: number; gamma: number };
    /**
     * Bucket at ANY zoom, not only below one device pixel per cell.
     *
     * `FieldView = FailDensity` asking for a density map whatever the zoom - the
     * one place a channel choice overrides the below-one-pixel bucketing rule, and it is
     * explicit rather than inferred. Absent behaves exactly as before.
     */
    forceAggregate?: boolean;
}

/**
 * Builds the layer cache key. See {@link GridLayerCache} for why each term is
 * there - and why the selection version is not.
 * @param dev         The device matrix `Sc(dpr) * W`.
 * @param bw          Bitmap width in device pixels.
 * @param bh          Bitmap height in device pixels.
 * @param dataVersion The shell's grid data version.
 * @param paint       The resolved paint (contributes its signature).
 * @returns The cache key.
 */
function gridCacheKey(
    dev: DOMMatrix, bw: number, bh: number, dataVersion: number, paint: GridPaint,
    reducer: GridReducer, filter: string,
): string {
    /*
     * The REDUCER is part of the key, and the priority list and gamma ride in
     * on `paint.signature`. Two renders that differ only in which reduction they
     * used produce different pixels from identical inputs, so a key that omitted it
     * would serve a MaxSeverity bitmap to a FailFraction render - and the bug would
     * look like the reducer not working rather than the cache being wrong.
     *
     * The aggregation factor needs no separate entry: it is a function of `dev` and
     * the placement, and `dev` is already six components of this key.
     */
    return dev.a + ',' + dev.b + ',' + dev.c + ',' + dev.d + ',' + dev.e + ',' + dev.f +
        '|' + bw + 'x' + bh + '|' + dataVersion + '|' + reducer
        + '|' + (paint.aggregate ? 'agg' : 'pt') + '|' + paint.signature
        /*
         * THE FILTER TERM. Everything that changes the filtered image has to
         * be in the key, or a filter change serves the bitmap from before it - the
         * same reason the reducer is in it. The caller assembles it,
         * because the engine has no idea what a filter surface looks like and
         * should not learn.
         */
        + '|' + filter;
}

/**
 * Strokes the selection rings of the selected cells: ONE {@link Path2D} holding
 * every selected cell's drawn quad, stroked once under `W` with a
 * screen-constant width - the exact treatment {@link drawSubstrateMap} gives
 * selected items ({@link SEL_PX} / s millimeters), and for the same reasons.
 *
 * Under `W` (uniform scale, the one axis flip) the ring width is honest; the
 * lattice CTM the cells are FILLED under is deliberately not reused here, because
 * its column and row axes have different lengths and would stroke a ring thicker
 * on one axis than the other. The quads are therefore built in substrate-frame
 * millimeters straight from the step vectors.
 *
 * The per-cell ban does not apply here: this walks the SELECTION (typically one
 * cell), not the lattice.
 * @param ctx      2D context (its CTM is overwritten).
 * @param grid     The grid.
 * @param selected Selected cells as row-major linear indices.
 * @param matrices The transform chain that drove the draw.
 * @param colors   Resolved colors (supplies the selection color).
 */
function drawCellSelection(
    ctx: Context2D,
    grid: GridModel,
    selected: ReadonlySet<number>,
    matrices: MapMatrices,
    colors: SubstrateMapColors,
): void {
    const p = grid.placement;
    const halfA = gridHalfA(p);
    const halfB = gridHalfB(p);
    if (!(halfA > 0) || !(halfB > 0)) {
        return;
    }
    const cols = grid.cols;
    const n = cols * grid.rows;
    const ring = new Path2D();
    let any = false;
    for (const index of selected) {
        if (!(index >= 0 && index < n)) {
            continue;                              // stale index: ignore rather than throw
        }
        const col = index % cols;
        const row = (index - col) / cols;
        const a0 = col + 0.5 - halfA;
        const a1 = col + 0.5 + halfA;
        const b0 = row + 0.5 - halfB;
        const b1 = row + 0.5 + halfB;
        // The drawn quad's four corners through the step basis (frame S, mm).
        for (let i = 0; i < 4; i++) {
            const a = (i === 1 || i === 2) ? a1 : a0;
            const b = (i >= 2) ? b1 : b0;
            const x = p.originXmm + a * p.colStepXmm + b * p.rowStepXmm;
            const y = p.originYmm + a * p.colStepYmm + b * p.rowStepYmm;
            if (i === 0) { ring.moveTo(x, y); } else { ring.lineTo(x, y); }
        }
        ring.closePath();
        any = true;
    }
    if (!any) {
        return;
    }
    applyMatrix(ctx, matrices.dprBase, matrices.world);
    ctx.strokeStyle = colors.selection;
    ctx.lineWidth = SEL_PX / screenScale(matrices); // screen-constant under W, transform included
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(ring);
}

/**
 * Assembles the filter request from what the layer asked for and what the paint
 * can supply.
 *
 * The layer carries the KIND, the RADIUS and the GAMMA, because those are the
 * author's attributes. The RAMP belongs to the aggregate paint, which is built
 * from the grid and the theme. Neither owns both, so they meet here rather than
 * one reaching into the other.
 * @param layer The layer. @param paint Its paint.
 * @returns The request, or `null` when nothing was asked for.
 */
function filterRequest(layer: GridLayer, paint: GridPaint): SpatialFilterRequest | null {
    const f = layer.spatialFilter;
    if (f === undefined || f.kind === 'None' || !(f.radius > 0)) { return null; }
    const ramp = paint.aggregate?.ramp;
    if (ramp === undefined) { return null; }
    return {
        kind: f.kind as SpatialFilterRequest['kind'],
        radius: f.radius,
        gamma: f.gamma,
        ramp,
    };
}

/**
 * Draws the grid layer: the cached (or live) cell raster, then the live selection
 * rings. Called by {@link drawSubstrateMap} between the substrate body and the
 * items.
 * @param ctx      2D context (its CTM is overwritten).
 * @param cfg      Drawing configuration in CSS pixels.
 * @param layer    The grid layer.
 * @param colors   Resolved colors.
 * @param mapping  Status/code -> CSS color map, or `null`.
 * @param matrices The resolved transform chain.
 */
function drawGridLayer(
    ctx: CanvasRenderingContext2D,
    cfg: MapConfig,
    layer: GridLayer,
    colors: SubstrateMapColors,
    mapping: Record<string, string> | null,
    matrices: MapMatrices,
    binQualityAliases: Record<string, string> | null,
    valueFill: { cells: Uint32Array; colors: readonly string[] } | null,
    aggregate: AggregateOptions | null,
    categorical: readonly (string | null)[] | null,
    highlight: readonly (string | null)[] | null,
): number | null {
    const reducer = aggregate?.reducer ?? 'MaxSeverity';
    const grid = layer.model;
    const p = grid.placement;
    const dev = deviceMatrix(matrices.dprBase, matrices.world);   // frame S -> device px
    // Decide the strategy BEFORE resolving colors numerically: the color packing
    // is only needed by the ImageData path, so the run path never pays for it.
    const wantImageData = Math.min(p.cellWmm, p.cellLmm) * Math.hypot(dev.a, dev.b) < GRID_RUN_STRATEGY_PX;
    const paint = buildGridPaint(grid, mapping, colors, wantImageData ? ctx : null,
        binQualityAliases, aggregate?.priority ?? null, aggregate?.gamma, valueFill, categorical,
        highlight);
    // The aggregate palette is built OUTSIDE the engine (it needs `Oklch`) and
    // handed in, so the render path only ever reads typed arrays.
    if (wantImageData && aggregate) { paint.aggregate = aggregate.paint; }
    const bw = Math.max(1, Math.round(cfg.width * matrices.dprBase));
    const bh = Math.max(1, Math.round(cfg.height * matrices.dprBase));
    const cache = layer.cache;
    /*
     * The saturation of the frame just drawn, or `null` when nothing bucketed.
     *
     * Captured by closure because `acquire` returns the BITMAP, and on a cache HIT
     * the callback does not run at all - which is the right answer: nothing was
     * re-rendered, so nothing changed, and the previous reducer choice still
     * describes what is on screen.
     */
    let measured: number | null = null;
    /*
     * ON A CACHE HIT NOTHING IS RE-RENDERED, so the sink is not refilled and the
     * buffers from the frame that DID render still describe what is on screen -
     * the same reasoning that keeps the previous saturation. The
     * cache key already covers everything that would change them, because it
     * covers everything that would change the pixels, and the buffers are a
     * by-product of exactly those pixels.
     */
    const bitmap = cache
        ? cache.acquire(
            bw, bh,
            gridCacheKey(dev, bw, bh, layer.dataVersion, paint, reducer, layer.filterKey ?? ''),
            (lctx) => {
                measured = renderGridLayer(lctx, grid, dev, paint, bw, bh, true, reducer,
                    layer.filterSink, layer.forceAggregate ?? false,
                    filterRequest(layer, paint));
            },
        )
        : null;
    if (bitmap) {
        // 1:1 device-pixel blit: identity CTM, integer offset, no resampling.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(bitmap, 0, 0);
    } else {
        /*
         * Uncached, and it AGGREGATES now. The bucket pass composites over
         * whatever is already on the canvas instead of replacing it, so the
         * substrate body survives and the pass no longer needs a bitmap of its own.
         * The gather strategy still does, and still sits behind the flag.
         *
         * `reducer` and `measured` are passed and captured here for the first time.
         * They were omitted while this branch could not bucket, and leaving them
         * omitted would have made an uncached control silently render every frame
         * with the DEFAULT reducer while the feed-forward rule ran on a saturation
         * nobody reported.
         */
        measured = renderGridLayer(ctx, grid, dev, paint, bw, bh, false, reducer, layer.filterSink,
            layer.forceAggregate ?? false, filterRequest(layer, paint));
    }
    /*
     * Decorations run AFTER BOTH BRANCHES, not inside the uncached one.
     *
     * The cached branch blits a bitmap under an identity CTM; putting the pass
     * in the `else` would have drawn marks only when the cache missed - a bug
     * that would look like flicker and be blamed on the cache. They are also
     * deliberately NOT baked into the cached bitmap: the cache key is
     * (matrix, size, dataVersion, paint), and the layer list is in none of
     * those, so a decoration change would not invalidate it.
     *
     * The transform is re-established the same way `drawCellSelection` does,
     * immediately below - both draw in the substrate frame after a branch that
     * may have left an identity CTM.
     *
     * Skipped entirely when there are no layers, which is what keeps
     * single-overlay output byte-identical to a map without layers.
     */
    if (grid.layers !== undefined && grid.layers.length > 0) {
        applyMatrix(ctx, matrices.dprBase, matrices.world);
        // Uniform CSS px per mm - the same term EDGE_PX and the origin marker use.
        renderGridDecorations(ctx, grid, colors, Math.hypot(dev.a, dev.b) / matrices.dprBase);
    }
    if (layer.selected && layer.selected.size > 0) {
        drawCellSelection(ctx, grid, layer.selected, matrices, colors);
    }

    // Fed forward: this selects the reducer for the NEXT frame, never this one.
    return measured;
}

/**
 * Hit-tests a CSS-pixel pointer against the cell grid, returning the cell under
 * it or `null`. The grid's counterpart to {@link getItemAtPos}, and like it, it
 * consumes the SAME `matrices` object the draw consumed.
 *
 * O(1) and allocation-free on the hot path: two 2x2 inversions and a typed-array
 * read, with no {@link DOMMatrix} / {@link DOMPoint} temporaries (both inverses
 * are done in scalars). The only allocation is the returned {@link CellHit}, once
 * per pointer event.
 *
 * HOW IT STAYS AN EXACT INVERSE OF THE DRAW. The pointer is un-transformed CSS
 * pixels; the chain is inverted analytically instead:
 *  1. `W^-1` maps it to substrate-frame millimeters. `W` is taken verbatim from
 *     `matrices`, and `W` carries no device-pixel factor by construction (that
 *     enters only in {@link applyMatrix} / {@link deviceMatrix}), so this is the
 *     draw CTM minus the dpr base - the hit-test invariant, reached by inverting
 *     rather than by rebuilding.
 *  2. The 2x2 inverse of the step basis maps that to lattice coordinates (a, b) -
 *     the same coordinates the renderer PUSHES ONTO THE CTM to paint in, so the
 *     painted cell and the tested cell are the same set by construction, under
 *     MapRotation, under any AxisDirection sign combination and under an
 *     out-of-contract skewed basis alike.
 *  3. `floor` selects the pitch cell and the {@link gridHalfA} / {@link gridHalfB}
 *     band selects the DRAWN cell inside it - so a click on a street misses,
 *     exactly as a street is unpainted.
 *
 * A null cell ({@link GridModel.binTable} index 0) is never painted and is
 * therefore never hit.
 * @param p        Pointer position in canvas CSS pixels.
 * @param matrices The transform chain that drove the draw; `world` is inverted,
 *                 `fitBox`/`scale` gate the test, `dprBase` is irrelevant.
 * @param grid     The grid, or `null`.
 * @returns The hit cell, or `null` when the pointer is on a street, outside the
 *          lattice, on a null cell, or when nothing is drawable.
 */
export function getCellAtPos(p: Point, matrices: MapMatrices, grid: GridModel | null): CellHit | null {
    // Nothing fitted / a degenerate scale => nothing painted => nothing hittable
    // (mirrors the draw guard in drawSubstrateMap and getItemAtPos).
    if (!grid || !matrices.fitBox || matrices.scale <= 0) {
        return null;
    }
    const w = matrices.world;
    const detW = w.a * w.d - w.b * w.c;
    if (!(Math.abs(detW) > 0)) {
        return null;
    }
    // W^-1: CSS px -> frame S millimeters (W is affine 2D; solved by Cramer).
    const wx = p.x - w.e;
    const wy = p.y - w.f;
    const sx = (w.d * wx - w.c * wy) / detW;
    const sy = (w.a * wy - w.b * wx) / detW;

    // Step basis^-1: frame S -> lattice coordinates (a, b).
    const pl = grid.placement;
    const ex = sx - pl.originXmm;
    const ey = sy - pl.originYmm;
    const detL = pl.colStepXmm * pl.rowStepYmm - pl.colStepYmm * pl.rowStepXmm;
    if (!(Math.abs(detL) > 0)) {
        return null;
    }
    const a = (pl.rowStepYmm * ex - pl.rowStepXmm * ey) / detL;
    const b = (pl.colStepXmm * ey - pl.colStepYmm * ex) / detL;

    // `col >= 0 && col < cols` (not the negation) so a NaN rejects rather than passes.
    const col = Math.floor(a);
    if (!(col >= 0 && col < grid.cols)) {
        return null;
    }
    const row = Math.floor(b);
    if (!(row >= 0 && row < grid.rows)) {
        return null;
    }
    // Inside the PITCH cell, but is it inside the DRAWN cell? A street click misses.
    if (Math.abs(a - col - 0.5) > gridHalfA(pl) || Math.abs(b - row - 0.5) > gridHalfB(pl)) {
        return null;
    }
    const index = row * grid.cols + col;
    if (grid.cells[index] === 0) {
        return null;                               // null bin: never painted, never hit
    }
    return { col, row, index };
}

/**
 * Draws the whole substrate map in one pass, in z-order: background, the
 * substrate body (filled and edged Outline, when bound), the CELL GRID (the die
 * layer, with its own selection rings), every item (grouped, colored, rotated,
 * z-ordered), the item selection rings, the upright labels and the origin
 * marker. The transform chain (W, D2S and the per-item matrix) is applied via
 * {@link applyMatrix}, so the device-pixel-ratio factor enters exactly once, as
 * the leftmost factor.
 *
 * The grid sits below the items because it is the SUBSTRATE's own subdivision -
 * items are placed on top of dies, never under them - and it is drawn under `W`
 * alone (frame S, like the outline), whereas items ride `W * D2S`.
 *
 * Fit / body fallback (the fit precedence): `matrices.fitBox` is the outline
 * bbox when an outline is bound, else the grid's extent, else the default
 * substrate extent ({@link fitBBox}). When no outline is bound, NO body is drawn;
 * a `null` box or a degenerate scale only clears the canvas.
 *
 * A filled item geometry is filled only (no per-geometry edge stroke): the edge
 * color is reserved for the substrate outline, and an item is filled or stroked
 * with its status color.
 * @param ctx           2D context (its CTM is overwritten per stage).
 * @param cfg           Drawing configuration in CSS pixels.
 * @param outlineModel  The substrate outline, or `null` (no body; items-fit fallback).
 * @param grid          The cell grid layer, or `null` (no grid). Positioned right
 *                      after the outline to mirror the z-order; a caller that has
 *                      not been updated fails to compile rather than silently
 *                      binding its items to it.
 * @param items         The render-ready items (may be empty).
 * @param colors        Resolved colors and label font.
 * @param resolveStatus Effective-status resolver for an item.
 * @param mapping       Status -> CSS color map, or `null`.
 * @param selectedItems The selected items, each marked with its own ring; empty
 *                      when nothing is selected. Every selected element is marked,
 *                      not just the last interacted one.
 * @param labels        Render-ready labels.
 * @param showLabels    Whether labels are drawn.
 * @param showOriginMarker Whether the origin marker (data-origin crosshair + axis stubs) is drawn on top.
 * @param matrices      The resolved transform chain and scalars (see {@link MapMatrices}).
 */
export function drawSubstrateMap(
    ctx: CanvasRenderingContext2D,
    cfg: MapConfig,
    outlineModel: OutlineModel | null,
    grid: GridLayer | null,
    items: ItemModel[],
    colors: SubstrateMapColors,
    resolveStatus: (item: ItemModel) => ItemStatus | null,
    mapping: Record<string, string> | null,
    selectedItems: ItemModel[],
    labels: LabelModel[],
    showLabels: boolean,
    showOriginMarker: boolean,
    matrices: MapMatrices,
    binQualityAliases?: Record<string, string> | null,
    valueFill?: { cells: Uint32Array; colors: readonly string[] } | null,
    aggregate?: AggregateOptions | null,
    categorical?: readonly (string | null)[] | null,
    highlight?: readonly (string | null)[] | null,
): number | null {
    /** What the grid layer measured, or `null` when it did not bucket. */
    let measuredSaturation: number | null = null;
    // Background / clear in CSS-pixel space (dpr base). clearRect(0,0,w,h) under
    // the dpr base clears the whole bitmap; an empty background leaves it clear.
    ctx.setTransform(matrices.dprBase, 0, 0, matrices.dprBase, 0, 0);
    ctx.clearRect(0, 0, cfg.width, cfg.height);
    if (colors.bg !== '') {
        ctx.fillStyle = colors.bg;
        ctx.fillRect(0, 0, cfg.width, cfg.height);
    }

    // No fit box or a degenerate scale:
    // the canvas is cleared and nothing else is drawn.
    if (!matrices.fitBox || matrices.scale <= 0) {
        return null;                               // nothing drawn, nothing measured
    }
    const s = matrices.scale;
    // Screen-constant widths divide by the scale W APPLIES, which includes the
    // author's ViewTransform; `s` above is the fit scale and does not.
    const sPx = screenScale(matrices);

    // Substrate body: the Outline path under W, filled with the body color and
    // stroked with a screen-constant edge. Skipped entirely in the items-fit
    // fallback (no outline bound), which draws no body.
    if (outlineModel) {
        applyMatrix(ctx, matrices.dprBase, matrices.world);
        ctx.fillStyle = colors.body;
        ctx.fill(outlineModel.path);
        ctx.strokeStyle = colors.edge;
        ctx.lineWidth = EDGE_PX / sPx;            // screen-constant under W
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.stroke(outlineModel.path);
    }

    // The cell grid (the die layer) directly above the substrate body and below
    // the items: it is authored in frame S like the outline, so it rides W ALONE -
    // the Origin* attributes place the ITEM data frame and must not move it. Its
    // own selection rings are drawn inside, keeping the layer one z-band.
    if (grid) {
        measuredSaturation = drawGridLayer(ctx, cfg, grid, colors, mapping, matrices,
            binQualityAliases ?? null, valueFill ?? null, aggregate ?? null, categorical ?? null,
            highlight ?? null);
    }

    // Items in z-order, each under W * D2S * T(c) R(theta) T(-c). One status color
    // per item; paint mode is per geometry. A geometry's own stroke_width is a
    // real length authored in mm, so it is set directly (it scales with the CTM);
    // no EDGE_PX/s here.
    const wd = matrices.world.multiply(matrices.data);       // W * D2S (CSS px)
    if (items.length > 0) {
        const order = computeDrawOrder(items);
        for (const it of order) {
            const fill = resolveStatusColor(resolveStatus(it), mapping, colors.unknown);
            applyMatrix(ctx, matrices.dprBase, wd.multiply(itemMatrix(it)));
            for (const g of it.geometries) {
                /*
                 * FILL FIRST, THEN THE EDGE. A closed geometry is
                 * filled whether or not it carries a `stroke_width`; the stroke is
                 * an edge ON the die, not a replacement for it. Only an open
                 * geometry - a polyline, or a path that never closes - is a line
                 * and nothing else.
                 *
                 * This used to be either/or, so giving a die an outline made it
                 * hollow in the paint and, because the hit test follows the paint,
                 * untappable except along its border.
                 */
                if (!g.open) {
                    ctx.fillStyle = fill;
                    ctx.fill(g.path);
                }
                if (g.hasStroke) {
                    ctx.strokeStyle = fill;
                    ctx.lineWidth = g.strokeWidthMm;
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    ctx.stroke(g.path);
                }
            }
        }
        // Selection rings above every item: for EACH selected item union its
        // geometries and stroke once under that item's own CTM, screen-constant
        // (rotation- and group-aware for free). Marking every selected element
        // (not just the last interacted one) is what a multi-selection needs.
        for (const selItem of selectedItems) {
            applyMatrix(ctx, matrices.dprBase, wd.multiply(itemMatrix(selItem)));
            const ring = new Path2D();
            for (const g of selItem.geometries) {
                ring.addPath(g.path);
            }
            ctx.strokeStyle = colors.selection;
            ctx.lineWidth = SEL_PX / sPx;         // screen-constant under the item CTM
            ctx.lineJoin = 'round';
            ctx.lineCap = 'round';
            ctx.stroke(ring);
        }
    }

    // Upright labels above the items, positioned under W * D2S.
    if (showLabels) {
        for (const lm of labels) {
            drawLabel(ctx, lm, wd, matrices.dprBase, s, colors);
        }
    }

    // Origin marker on top of everything, under W * D2S (`wd`): a crosshair marking
    // the data origin plus +x/+y data-axis stubs with arrowheads (x single head, y
    // double). Screen-constant in size and width. Riding the full data matrix, it
    // shows the origin's position, OriginRotation and YAxisDirection ('down' flips
    // the +y stub) for free. Not hit-tested (never added to the hit index).
    if (showOriginMarker) {
        // The flag is read off the placement, not passed down separately: it
        // describes those vectors, so it cannot drift from the lattice it
        // belongs to. No grid means no mirrored lattice to describe.
        drawOriginMarker(
            ctx, wd, matrices.dprBase, s, colors.selection,
            grid !== null && grid.model.placement.sideMirror,
        );
    }

    // Fed forward: the caller applies this to the NEXT frame.
    return measuredSaturation;
}

/**
 * Hit-tests a CSS-pixel pointer against the items (topmost first) using the SAME
 * transform chain that drew them. The draw order is walked in REVERSE (see
 * {@link computeDrawOrder}) so the topmost item wins where geometries overlap;
 * the first item with any geometry under the pointer is returned.
 *
 * Hit CTM (the hit-test invariant, "hit CTM = draw CTM minus dpr"): the pointer stays in
 * CSS pixels and is NOT transformed - the geometry {@link Path2D} is, via the
 * per-item CTM `W * D2S * item`. That product is built from the SAME `matrices`
 * object handed to {@link drawSubstrateMap} (its `world` and `data` matrices are
 * multiplied verbatim, exactly as the draw does) but applied on a UNIT base
 * ({@link applyMatrix} with `dprBase = 1`). The hit CTM is therefore the draw CTM
 * with only the device-pixel-ratio factor removed, so the hit region and the
 * painted shape coincide to the pixel. Filled geometries test with
 * `isPointInPath`; stroked ones with `isPointInStroke`, so the hit follows the
 * painted stroke and never fires through a hollow interior.
 *
 * Thin-stroke tolerance: a stroked geometry is hit with
 * `lineWidth = max(strokeWidthMm, HIT_MIN_PX / s')`, where `s'` is the uniform
 * scale of that hit CTM. Because the chain carries only scaling, flips and
 * rotations, that scale is the length of the CTM's a-vector, `hypot(a, b)`,
 * COMPUTED from the matrix rather than assumed equal to {@link MapMatrices.scale}
 * - so it stays correct once the MapRotation / Origin seams add rotations and a
 * y-flip to the chain. Both `strokeWidthMm` and `HIT_MIN_PX / s'` are in
 * millimeters (the CTM's user space).
 *
 * @param p        Pointer position in canvas CSS pixels.
 * @param items    The active render-ready items (the exact list that was drawn).
 * @param matrices The transform chain that drove the draw; its `world` and `data`
 *                 matrices are reused verbatim and `scale`/`fitBox` gate the test.
 *                 `dprBase` is ignored - the hit CTM forces a unit base.
 * @param ctx      2D context used for `isPointInPath` / `isPointInStroke`; its
 *                 transform is overwritten per item and restored on return.
 * @returns The topmost hit item, or `null` if none was hit.
 */
export function getItemAtPos(
    p: Point,
    items: ItemModel[],
    matrices: MapMatrices,
    ctx: CanvasRenderingContext2D,
): ItemModel | null {
    // Nothing fitted / a degenerate scale => nothing painted => nothing hittable
    // (mirrors the draw guard in drawSubstrateMap).
    if (!matrices.fitBox || matrices.scale <= 0) {
        return null;
    }
    // SAME product the draw builds: W * D2S from the exact matrix objects in
    // `matrices`, then * item per item below.
    const wd = matrices.world.multiply(matrices.data);
    const order = computeDrawOrder(items);
    ctx.save();
    try {
        // Topmost first: draw order reversed.
        for (let i = order.length - 1; i >= 0; i--) {
            const it = order[i];
            // Per-item hit CTM = W * D2S * item on a UNIT base (no dpr): the pointer
            // is in CSS px and is not transformed, the path is.
            const m = wd.multiply(itemMatrix(it));
            applyMatrix(ctx, 1, m);
            // Uniform scale of THIS hit CTM = its a-vector length (see the doc
            // comment); > 0 given the fitBox/scale guard above.
            const sPrime = Math.hypot(m.a, m.b);
            for (const g of it.geometries) {
                /*
                 * HIT FOLLOWS PAINT, and paint is fill THEN edge.
                 *
                 * So a closed geometry is hit anywhere in its interior, and also on
                 * the half of its stroke band that lies outside the fill - because
                 * that band is painted too, and the field rule is that everything
                 * colored with the item is part of the hit area.
                 *
                 * The screen-constant minimum band still matters, and only here: it
                 * is what makes a hairline or zero-width shape tappable at all. On a
                 * closed shape it now only ADDS a forgiving skirt outside the fill,
                 * where before it WAS the whole hit area.
                 */
                let hit = !g.open && ctx.isPointInPath(g.path, p.x, p.y);
                if (!hit && g.hasStroke) {
                    ctx.lineWidth = Math.max(g.strokeWidthMm, HIT_MIN_PX / sPrime);
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    hit = ctx.isPointInStroke(g.path, p.x, p.y);
                }
                if (hit) {
                    return it;
                }
            }
        }
        return null;
    } finally {
        ctx.restore();
    }
}

/* ------------------------------------------------------------------------ *
 * Global namespace bridge (classic consumers)
 *
 * Mirrors the compatibility pattern of the attached package
 * (Helpers/TcHmiValueBuffer/TcHmiValueBuffer.d.ts declares the very same
 * `declare global { namespace ... }` block; ValueBuffer.js performs the
 * runtime assignment). Classic namespace controls consume the engine as
 * TcHmi.Controls.CNM_UIControls.SEMI.Engine after listing
 * Engine.js as an EsModule dependency file.
 * ------------------------------------------------------------------------ */


declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI.Engine {
            /** Instance type of the global alias. */
        /** Global alias of the module-evaluation counter. */
        let MODULE_EVALUATIONS: number;
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

// Idempotent registration guard: `??=` keeps the first definition if this
// file is ever evaluated twice (cannot happen through the module cache, but
// required for the classic fallback variant and free of cost here).
const engineNamespace = ensureNamespace(TcHmi.Controls, 'CNM_UIControls', 'SEMI', 'Engine');
/*
 * THE BRIDGE CARRIES THE REAL API.
 *
 * A classic consumer reaching `TcHmi.Controls.CNM_UIControls.SEMI.Engine` finds
 * the same functions the module graph offers, as `E142.ts` and `E142Xml.ts` do
 * for their own surfaces.
 *
 * WHAT IS PUBLISHED: the pure functions a consumer outside the module system would
 * need to build or interrogate a map, and the constants those functions are governed
 * by. NOT the drawing entry points - they take a `CanvasRenderingContext2D`, a
 * `MapConfig` and a `MapMatrices`, so a caller able to assemble those is a caller
 * already inside the module graph.
 */
engineNamespace['MODULE_EVALUATIONS'] = MODULE_EVALUATIONS;
for (const [name, value] of [
    // Geometry and fit - what a consumer needs to place a map at all.
    ['fitBBox', fitBBox], ['makeConfig', makeConfig], ['computeScale', computeScale],
    ['rotatedExtent', rotatedExtent], ['unionBoxes', unionBoxes],
    ['DEFAULT_SUBSTRATE_EXTENT_MM', DEFAULT_SUBSTRATE_EXTENT_MM],
    ['DEFAULT_SUBSTRATE_BBOX', DEFAULT_SUBSTRATE_BBOX],
    // Grouping - the tiling an author needs to resolve a group id from an event.
    ['groupTiling', groupTiling], ['groupTileAt', groupTileAt], ['groupTileRect', groupTileRect],
    ['groupTileSpans', groupTileSpans], ['groupSizeInCells', groupSizeInCells],
    ['cellsInGroup', cellsInGroup],
    // Hit testing and color - the two things a host most often needs to mirror.
    ['getCellAtPos', getCellAtPos], ['getItemAtPos', getItemAtPos],
    ['normalizeColor', normalizeColor], ['packColor', packColor],
    ['HIT_MIN_PX', HIT_MIN_PX],
] as ReadonlyArray<readonly [string, unknown]>) {
    engineNamespace[name] ??= value;
}
