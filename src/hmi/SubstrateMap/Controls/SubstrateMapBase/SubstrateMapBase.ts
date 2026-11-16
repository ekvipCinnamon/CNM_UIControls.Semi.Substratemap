/**
 * @fileoverview
 * SubstrateMapBase - abstract, non-placeable shell control of the SubstrateMap
 * package.
 *
 * Three-layer split (SubstrateMapEngine / SubstrateMapBase / concrete controls):
 *  - SubstrateMapEngine: a framework-free ES module owning the model builders,
 *    the transform chain, the render strategies and the hit-test index; colors
 *    and fonts reach it as a resolved parameter object, never as DOM/theme reads.
 *  - SubstrateMapBase (this file): the stable shell - template root, identity
 *    <div>, <canvas>, devicePixelRatio bitmap sizing, ResizeObserver, theme
 *    reading (--substratemap-*), pointer wiring, one engine instance and a
 *    protected scene API - declaring no public attributes and no events, with
 *    two abstract hooks the concrete control fills (__composeIdentity /
 *    __raiseSelected).
 *  - Concrete controls (SubstrateMap, SubstrateMapWidget, SubstrateMapBinChart)
 *    extend this base
 *    only and own the attributes, schemas, events, demo data and the mapping of
 *    their data model onto the engine's scene calls.
 *
 * MODULE MECHANISM: base and engine are ES modules; the base
 * imports the engine with a .js specifier through the module graph - exactly the
 * pattern dist/TcHmiToggleSwitch imports dist/TcHmiCheckbox in the attached
 * Beckhoff.TwinCAT.HMI.Controls package - so base-before-derived and
 * single-evaluation are language guarantees, and registerEx is called with
 * { injectInGlobalObject: true } (through one documented cast, since the class
 * is abstract) to expose the classic namespace name.
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
    // The demo builder's share of the engine surface.
    BBox,
    ItemList,
    PathCommand,
    buildOutlineModel,
    generatePresetOutline,
    itemsToModels,
    ItemModel,
    ItemStatus,
    LabelModel,
    OutlineModel,
    DeviceRect,
    GroupTiling,
    MapConfig,
    MapMatrices,
    OriginAnchor,
    YAxisDirection,
    SubstrateMapColors,
    Point,
    makeConfig,
    computeScale,
    rotatedExtent,
    fitBBox,
    getCellAtPos,
    GridLayer,
    GridReducer,
    SubstrateMapGroupSelection,
    GridLayerCache,
    GridModel,
    CellHit,
    makeWorldMatrix,
    makeDataMatrix,
    TOUCH_TARGET_DEFAULT_PX,
    aggregationFactor,
    cellsInGroup,
    describeGroup,
    groupTileRect,
    groupTiling,
    groupSizeInCells,
    groupTileAt,
    selectReducer,
    deviceMatrix,
    drawSubstrateMap,
    getItemAtPos,
} from '../../Helpers/SubstrateMapEngine/Engine.js';
import { buildAggregatePaint } from '../../Helpers/SubstrateMapEngine/GridAggregate.js';
// the dark no-data variant is chosen by the MEASURED lightness of the
// background rather than by a theme name — see `__noDataSource`.
import { parseRgb, rgbToOklch } from '../../Helpers/SubstrateMapEngine/Oklch.js';

// {@link MapConfig}, {@link SubstrateMapColors} and {@link Point} are owned by
// the engine (it consumes them in `drawSubstrateMap`; the base cannot own them
// without an import cycle). They are re-exported here so downstream consumers
// keep importing them from the shell.
export type { MapConfig, SubstrateMapColors, Point };

/* ------------------------------------------------------------------------ *
 *  AGE, AND WHICH CLOCK IT CAME FROM
 *
 *  In the base because every control shares the clock. Owned by one concrete
 *  control, it would make the others import a sibling just to tell the time.
 *
 *  Two copies of a clock is two clocks. One base, one set of rules: which
 *  formats parse, which source is named, that a missing timestamp falls back to
 *  the receive time.
 * ------------------------------------------------------------------------ */

/** Where the age shown on a control came from. */
export type AgeSource = 'map' | 'received';

/** What {@link formatAge} produces. */
export interface AgeText {
    /** The line to draw. */
    readonly text: string;
    /** Which clock it came from. */
    readonly source: AgeSource;
    /** Seconds since that instant. */
    readonly seconds: number;
}

/**
 * Parses a bound map timestamp.
 *
 * ---- TWO FORMATS, BECAUSE THE STANDARD GIVES ONE AND THE WORLD GIVES ANOTHER ----
 *
 * `YYYYMMDDhhmmsscc` is the format the SEMI reference gives for `ITEMVERSION`
 * (chapter 13, Stream 21) - sixteen digits ending in hundredths. ISO 8601 is
 * what an OPC UA or MQTT source will hand an author. Both are accepted because
 * refusing the second would mean an author formatting a date to please a
 * control.
 *
 * Interpreted as LOCAL time when it carries no zone, which the E142 form never
 * does. That is the honest reading: a tester writes the time on its own clock,
 * and assuming UTC would silently shift every timestamp by the panel's offset.
 * @param raw The bound value.
 * @returns The instant, or `null` when it does not parse.
 */
export function parseMapTimestamp(raw: string | number | null): Date | null {
    if (raw === null || raw === undefined || raw === '') { return null; }
    const text = String(raw).trim();
    const semi = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(text);
    if (semi !== null) {
        const [, y, mo, d, h, mi, sec, cs] = semi;
        const t = new Date(Number(y), Number(mo) - 1, Number(d),
            Number(h), Number(mi), Number(sec), Number(cs) * 10);
        return Number.isNaN(t.getTime()) ? null : t;
    }
    const iso = new Date(text);
    return Number.isNaN(iso.getTime()) ? null : iso;
}

/**
 * The age line: a local time, its zone, and WHICH CLOCK it came from.
 *
 * ---- THE LABEL IS THE POINT ----
 *
 * A dashboard exists so nobody has to look, and a tile showing six-hour-old data
 * without saying so is worse than an empty one. But `received` and `measured`
 * are different facts: a map that arrived a second ago may describe a wafer
 * tested this morning. Showing a time without saying which one it is invites
 * exactly the wrong conclusion, so the source is named every time and never
 * abbreviated away.
 *
 * ---- LOCAL, WITH THE ABBREVIATION ----
 *
 * An operator does not convert UTC in his head. The zone travels with the time
 * because a panel in one plant may display a map from another, and `14:32`
 * without a zone is a guess.
 * @param mapTime  The document's own instant, or `null`.
 * @param received When the payload arrived.
 * @param now      The current instant.
 * @returns The line, its source and its age in seconds.
 */
export function formatAge(mapTime: Date | null, received: Date, now: Date): AgeText {
    const at = mapTime ?? received;
    const source: AgeSource = mapTime === null ? 'received' : 'map';
    const clock = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short', hour12: false,
    }).format(at);
    return {
        text: `${source === 'map' ? 'measured' : 'received'} ${clock}`,
        source,
        seconds: Math.max(0, (now.getTime() - at.getTime()) / 1000),
    };
}

/**
 * Whether an age is past the threshold.
 * @param seconds The age. @param staleAfter The threshold, or `null`.
 * @returns Whether to mark the tile.
 */
export function isStale(seconds: number, staleAfter: number | null): boolean {
    return staleAfter !== null && staleAfter > 0 && seconds > staleAfter;
}

/**
 * Payload of the concrete control's selection hook {@link
 * SubstrateMapBase.__raiseSelected} and of its `.onItemSelected` event. Because
 * grid cell indices and item ids can collide numerically, every selection entry
 * is typed with its `kind`; `userData` is `null` for grid cells.
 */
export interface SelectedPayload {
    /** Id of the last interacted element, or `null` after a clear. */
    itemId: number | null;
    /** Effective status of the last interacted element, or `null`. */
    status: string | null;
    /** Name of the last interacted element, or `null`. */
    name: string | null;
    /** Opaque user data of the last interacted item, or `null` (always `null` for cells). */
    userData: string | number | null;
    /** Kind of the last interacted element. */
    kind: 'item' | 'cell';
    /**
     * Full current selection as typed entries. Grouped by kind - items in
     * selection order, then cells in selection order - because the two kinds live
     * in kind-specific collections (which is what keeps ring-marking membership
     * O(1) for a large cell selection); order WITHIN a kind is selection order.
     */
    selection: Array<{ kind: 'item' | 'cell'; itemId: number }>;
    /**
     * Column of the last interacted CELL, in Row/Column SERIALIZATION indices (see
     * {@link reportedCellCoords} for the assumption that makes those the right
     * numbers to report, and for where to change it). Absent (`undefined`) for item
     * selections and after a clear - the four cell fields below are optional exactly
     * so that an item payload carries no meaningless cell coordinates, and so that
     * adding them broke no existing consumer.
     */
    column?: number;
    /** Row of the last interacted cell, in serialization indices; absent for item selections. */
    row?: number;
    /**
     * Canonical bin code of the last interacted cell; absent for item selections.
     * Equal to the payload's `status` for a cell (the bin code IS a cell's status),
     * repeated under its own name so a consumer need not know that.
     */
    binCode?: string;
    /**
     * Bin quality of the last interacted cell as the source declared it (a FREE
     * string, not an enumeration), `null` when the source declared none. Absent for
     * item selections.
     */
    binQuality?: string | null;
}

/**
 * Maps a hit cell's LATTICE coordinates onto the `column` / `row` reported in a
 * {@link SelectedPayload}. Currently the identity - and deliberately a named
 * function anyway, because it is the ONE place that decides what those two
 * numbers mean.
 *
 * WHAT IS ASSUMED. A map's Row/Column SERIALIZATION indices - the order cells
 * appear in on the wire, which is what this control's lattice indices are - are
 * not necessarily the LOGICAL map coordinates a `<BinCode>`'s X / Y attributes
 * are authored in.
 *
 * The conversion therefore happens in the domain module at merge time: the
 * decoding caller converts logical start coordinates to serialization indices,
 * and everything downstream of the decode, this package included, works in
 * serialization indices only. This control reports the lattice index pair
 * unchanged, which is correct exactly as long as that separation holds.
 *
 * WHY THIS IS AN ASSUMPTION AND NOT A RULE. No clause of E142 ties serialization
 * order to logical coordinates. The schemas give `<BinCode>` optional X and Y
 * attributes and no length attribute, and state no mapping between the two, so
 * the conversion's existence is inferred from the shape of the schema rather than
 * read off the standard. It is well supported by that shape, but it is not
 * derivable from the text, and it remains to be checked against E142-0225
 * Figure A1-1a.
 *
 * WHAT CHANGES IF IT IS WRONG: only this function. If the verification shows the
 * reported pair must be logical coordinates (an axis flip, an origin offset, or a
 * transposition away), it is applied here - the engine stays format-neutral, the
 * hit-test keeps returning lattice indices, `SelectedPayload.itemId` keeps being
 * the row-major linear index, and no caller changes. This is why the identity
 * lives behind a seam rather than inline in the payload literal.
 * @param cell The hit cell as returned by the engine's `getCellAtPos`.
 * @returns The `column` / `row` pair to report.
 */
function reportedCellCoords(cell: CellHit): { column: number; row: number } {
    return { column: cell.col, row: cell.row };
}

// ===================================================================
//  Demo data (design-time showcase)
//  Module-private and pure (no `this`). The demo is a 300 mm notch wafer (the
//  shared 'si-12in' preset) tiled with dies shaped as the ekvip sweep and
//  binned into five status classes colored from the corporate palette (CI
//  manual 08/2025). It is authored as a schema ItemList + preset Outline and
//  run through the SAME engine builders as bound data (`generatePresetOutline`
//  / `buildOutlineModel` / `itemsToModels`), so it exercises the real
//  pipeline: identical Path2D authoring, `user_data` pass-through and per-die
//  hit-testing/selection. Consumed only by {@link SubstrateMap.__rebuildDemo}.
// ===================================================================

/**
 * Demo palette per the ekvip Corporate Design Manual (08/2025), "Colors": both
 * primaries, both secondaries and the accent. The manual prescribes gradations
 * of the primary and secondary colors for diagram-like visualizations and
 * reserves the accent for sparse eye-catchers - here the reject bin. Keys are
 * the statuses the demo items embed (best bin first).
 */
const DEMO_STATUS_COLORS: Record<string, string> = {
    BIN_1: '#225F79',   // primary azure blue - pass
    BIN_2: '#548299',   // secondary dove blue
    BIN_3: '#D6A35F',   // primary caramel
    BIN_4: '#103640',   // secondary dark blue
    BIN_5: '#AB411F',   // accent rust red - reject (kept sparse, ~5 %)
};

/**
 * The ekvip sweep as an engine path, converted 1:1 (no redraw - the CI manual
 * forbids recreating logo elements) from the sweep path of the official asset
 * `ekvip_Logo-Standard_schwarz.svg`: SVG y-down flipped into the +y-up data
 * frame, bbox-centered at the origin and normalized to height 1 (bbox
 * width/height = {@link SWEEP_ASPECT}); {@link placeCommand} scales and
 * translates it per die. The CI manual mandates the sweep as the stand-alone
 * mark wherever the space is below the 20 mm cut-out-logo minimum - which
 * every demo die is - so the sweep, not the full logo, is the CI-correct
 * shape at die scale (sweep minimum 4.2 mm; the demo renders ~7.2 mm wide).
 */
const SWEEP_UNIT: PathCommand[] = [
    { type: 'move_to_absolute', x: 0.10883, y: -0.16667 },
    { type: 'line_to_absolute', x: -0.01129, y: -0.0002 },
    { type: 'line_to_absolute', x: -0.11528, y: 0.1445 },
    { type: 'cubic_bezier_absolute', control_1_x: -0.11931, control_1_y: 0.15216, control_2_x: -0.12092, control_2_y: 0.16022, x: -0.12132, y: 0.16667 },
    { type: 'cubic_bezier_absolute', control_1_x: -0.12173, control_1_y: 0.17594, control_2_x: -0.12011, control_2_y: 0.18279, x: -0.12011, y: 0.18279 },
    { type: 'cubic_bezier_absolute', control_1_x: -0.11528, control_1_y: 0.20496, control_2_x: -0.06247, control_2_y: 0.23478, x: -0.06247, y: 0.23478 },
    { type: 'line_to_absolute', x: 0.11326, y: 0.33233 },
    { type: 'line_to_absolute', x: 0.11326, y: 0.33394 },
    { type: 'line_to_absolute', x: 0.11326, y: 0.5 },
    { type: 'line_to_absolute', x: -0.08706, y: 0.40206 },
    { type: 'cubic_bezier_absolute', control_1_x: -0.1181, control_1_y: 0.38674, control_2_x: -0.13664, control_2_y: 0.36014, x: -0.14752, y: 0.33313 },
    { type: 'cubic_bezier_absolute', control_1_x: -0.16405, control_1_y: 0.29283, control_2_x: -0.16405, control_2_y: 0.25292, x: -0.16405, y: 0.25292 },
    { type: 'line_to_absolute', x: -0.16364, y: 0.16667 },
    { type: 'line_to_absolute', x: -0.16324, y: 0.02721 },
    { type: 'cubic_bezier_absolute', control_1_x: -0.16324, control_1_y: 0.01753, control_2_x: -0.16284, control_2_y: 0.00867, x: -0.16163, y: -0.0002 },
    { type: 'cubic_bezier_absolute', control_1_x: -0.15518, control_1_y: -0.05341, control_2_x: -0.12938, control_2_y: -0.0917, x: -0.12938, y: -0.0917 },
    { type: 'line_to_absolute', x: -0.07537, y: -0.16667 },
    { type: 'line_to_absolute', x: 0.04434, y: -0.33353 },
    { type: 'line_to_absolute', x: 0.16405, y: -0.5 },
    { type: 'line_to_absolute', x: 0.16405, y: -0.33353 },
    { type: 'line_to_absolute', x: 0.16405, y: -0.24365 },
    { type: 'line_to_absolute', x: 0.10883, y: -0.16667 },
    { type: 'close_path' },
];

/** Bbox width / height of {@link SWEEP_UNIT} (the sweep's aspect ratio). */
const SWEEP_ASPECT = 0.32809;

/** Demo die sizing and placement, all frame-D millimeters on the 300 mm substrate. */
const DEMO_LAYOUT = {
    /** Substrate radius: si-12in dia / 2 (see `OUTLINE_SPECS`). Drives the yield-ring thresholds; edgeRadius and the notch keep-out below are hand-derived from it. */
    substrateRadius: 150,
    /** Sweep height per die; width follows as height * {@link SWEEP_ASPECT} (~7.2 mm). */
    sweepHeight: 22,
    /** Grid pitch in x; the half-cell offset in {@link buildDemo} centers the pattern. */
    pitchX: 12,
    /** Grid pitch in y. */
    pitchY: 26,
    /** A die is kept only when its sweep bbox lies fully inside this radius (7 mm edge margin on the 150 mm substrate radius). */
    edgeRadius: 143,
    /** Notch keep-out half-width: with the exaggerated si-12in notch (depth 1.125 mm * 12 = 13.5 mm, mouth half-width ~13.5 mm), drop dies whose bbox reaches `|x| <= notchKeepOutX` AND `y <= notchKeepOutY`. */
    notchKeepOutX: 16,
    /** Notch keep-out y threshold (see {@link DEMO_LAYOUT.notchKeepOutX}). */
    notchKeepOutY: -131,
} as const;

/**
 * Places one template {@link PathCommand} into the data frame: uniform scale
 * by `s` about the origin, then translation by (`dx`, `dy`). Absolute
 * coordinates scale and translate; relative coordinates only scale (their
 * reference point already carries the translation); arc radii scale while the
 * arc rotation and flags are invariant under uniform scaling. Pure; returns a
 * new command. Total over the union even though {@link SWEEP_UNIT} only uses
 * absolute move/line/cubic/close.
 * @param cmd The template command (authored at unit scale about the origin).
 * @param s   Uniform scale factor (the die's sweep height in millimeters).
 * @param dx  Translation x in frame-D millimeters (the die center).
 * @param dy  Translation y in frame-D millimeters (the die center).
 * @returns The placed command.
 */
function placeCommand(cmd: PathCommand, s: number, dx: number, dy: number): PathCommand {
    switch (cmd.type) {
        case 'move_to_absolute':
        case 'line_to_absolute':
        case 'smooth_quadratic_bezier_absolute':
            return { type: cmd.type, x: cmd.x * s + dx, y: cmd.y * s + dy };
        case 'move_to_relative':
        case 'line_to_relative':
        case 'smooth_quadratic_bezier_relative':
            return { type: cmd.type, x: cmd.x * s, y: cmd.y * s };
        case 'horizontal_line_to_absolute':
            return { type: cmd.type, x: cmd.x * s + dx };
        case 'horizontal_line_to_relative':
            return { type: cmd.type, x: cmd.x * s };
        case 'vertical_line_to_absolute':
            return { type: cmd.type, y: cmd.y * s + dy };
        case 'vertical_line_to_relative':
            return { type: cmd.type, y: cmd.y * s };
        case 'quadratic_bezier_absolute':
            return { type: cmd.type, control_x: cmd.control_x * s + dx, control_y: cmd.control_y * s + dy, x: cmd.x * s + dx, y: cmd.y * s + dy };
        case 'quadratic_bezier_relative':
            return { type: cmd.type, control_x: cmd.control_x * s, control_y: cmd.control_y * s, x: cmd.x * s, y: cmd.y * s };
        case 'smooth_cubic_bezier_absolute':
            return { type: cmd.type, control_2_x: cmd.control_2_x * s + dx, control_2_y: cmd.control_2_y * s + dy, x: cmd.x * s + dx, y: cmd.y * s + dy };
        case 'smooth_cubic_bezier_relative':
            return { type: cmd.type, control_2_x: cmd.control_2_x * s, control_2_y: cmd.control_2_y * s, x: cmd.x * s, y: cmd.y * s };
        case 'cubic_bezier_absolute':
            return { type: cmd.type, control_1_x: cmd.control_1_x * s + dx, control_1_y: cmd.control_1_y * s + dy, control_2_x: cmd.control_2_x * s + dx, control_2_y: cmd.control_2_y * s + dy, x: cmd.x * s + dx, y: cmd.y * s + dy };
        case 'cubic_bezier_relative':
            return { type: cmd.type, control_1_x: cmd.control_1_x * s, control_1_y: cmd.control_1_y * s, control_2_x: cmd.control_2_x * s, control_2_y: cmd.control_2_y * s, x: cmd.x * s, y: cmd.y * s };
        case 'elliptical_arc_absolute':
            return { type: cmd.type, rx: cmd.rx * s, ry: cmd.ry * s, x_axis_rotation: cmd.x_axis_rotation, large_arc: cmd.large_arc, sweep: cmd.sweep, x: cmd.x * s + dx, y: cmd.y * s + dy };
        case 'elliptical_arc_relative':
            return { type: cmd.type, rx: cmd.rx * s, ry: cmd.ry * s, x_axis_rotation: cmd.x_axis_rotation, large_arc: cmd.large_arc, sweep: cmd.sweep, x: cmd.x * s, y: cmd.y * s };
        case 'close_path':
            return { type: 'close_path' };
        default: { const _never: never = cmd; return _never; }
    }
}

/*
 * The concrete's `DEFAULTS.notchExaggeration`, by value rather than by import.
 * `DEFAULTS` is module-private in `SubstrateMap.ts`, and exporting it to reach one
 * number would hand the base the concrete's whole attribute-default table - the
 * wrong direction for a base to depend in. The demo's outline is its own fixed
 * geometry; that it equals the attribute default is a coincidence of taste rather
 * than a constraint, and `demo-geometry` asserts the two agree so the copy cannot
 * drift silently.
 */
const DEMO_NOTCH_EXAGGERATION = 12;

// ===================================================================
//  The empty state
//
//  What a control shows when it has nothing to show. Four states, and which one
//  applies is decided by {@link emptyState} - a pure function of the scene, so
//  it can be asserted row by row without drawing anything.
// ===================================================================

/**
 * The shipped no-data image, relative to the control folder.
 *
 * `Base` is the framework's own theme name, which is why the file is called what
 * it is: the pair is `Base` and `Base-Dark`, and a reader looking for the image a
 * theme uses should not have to learn a second naming.
 */
/*
 * The name the framework knows this package by - the NuGet `<id>`, which is what
 * `getPackageBasePath` takes. It is a copy of a fact that lives in the nuspec, so
 * `check-manifest` requires the two to agree: a package rename that missed this
 * line would silently return the no-data image to its 404.
 */
export const PACKAGE_NAME = 'Ekvip.Cinnamon.Semi.SubstrateMap';

export const NO_DATA_IMAGE_DEFAULT = 'NoDataBase.svg';

// ---- the demo marking ----

/** The word stamped across demo content. Not localized: a marking, not a message. */
const DEMO_LABEL = 'DEMO';
/** Device pixels between hatch lines. */
const DEMO_HATCH_PITCH = 14;
/** Hatch line width in device pixels. */
const DEMO_HATCH_WIDTH = 2;
/** Hatch opacity: visible over any fill, without hiding what is under it. */
const DEMO_HATCH_ALPHA = 0.22;
/** The word's size as a fraction of the shorter side. */
const DEMO_LABEL_FRACTION = 0.16;
/** Below this the word stops shrinking, so the smallest control still reads it. */
const DEMO_LABEL_MIN_PX = 11;
/** The word's font family. A system stack: the marking must not wait on a webfont. */
const DEMO_LABEL_FAMILY = 'system-ui, sans-serif';

/**
 * The shipped image for the dark theme.
 *
 * **A SEPARATE DRAWING, not a recolor**. It was first generated from the light
 * one and has since been replaced by a designer's own illustration: 65 paths against the light
 * one's 47, and a cyan accent at chroma 0.079 that appears nowhere in the light
 * variant, whose maximum chroma is 0.0031.
 *
 * `tools/recolor-svg.mjs` still exists and still works. It is the fallback for a
 * project with no designer, not the producer of this file.
 */
export const NO_DATA_IMAGE_DARK_DEFAULT = 'NoDataBaseDark.svg';

/**
 * Which of the four empty states applies, or `'data'` when there is real data.
 *
 * ---- THE PRECEDENCE, IN ONE PLACE ----
 *
 * The state table, and the reason it is a function rather than four `if`s
 * scattered through a render: it is the thing most likely to be got wrong, and a
 * decision that is spread out cannot be asserted row by row.
 *
 *   1. `'data'`    real data is bound -> the map
 *   2. `'stale'`   no real data, but a LAST KNOWN STATE -> that, plus an age
 *                  label. Only a control that retains its last map (the tile)
 *                  ever reaches this row.
 *   3. `'demo'`    no data, no last known state, `ShowDemoItems` -> the demo,
 *                  marked as a demo.
 *   4. `'nodata'`  otherwise -> the no-data image.
 *
 * REAL DATA means something to draw: a bound document that produced no items is not data. A grid
 * with cells counts and items count; an OUTLINE ALONE does not, because an empty
 * substrate body is a frame around nothing and is exactly the case the no-data
 * image exists for.
 * @param scene What the control is holding.
 * @returns The state.
 */
export function emptyState(scene: {
    hasGrid: boolean;
    itemCount: number;
    isDemo: boolean;
    hasLastKnown: boolean;
    showDemoItems: boolean;
}): 'data' | 'stale' | 'demo' | 'nodata' {
    // The demo IS items, so it has to be excluded before `itemCount` is read, or
    // every demo would report itself as data.
    if (!scene.isDemo && (scene.hasGrid || scene.itemCount > 0)) { return 'data'; }
    if (scene.hasLastKnown) { return 'stale'; }
    if (scene.showDemoItems && scene.isDemo) { return 'demo'; }
    return 'nodata';
}

/**
 * Where a no-data image lands inside the drawing area: `contain`, centered.
 *
 * Pure, because it is the one piece of the empty state that has arithmetic in
 * it, and a function can be asserted at a ratio without a canvas.
 *
 * CONTAIN, NOT COVER AND NOT STRETCH. A stretched 4:1 logo is a distortion an
 * operator reads as a rendering fault; a cover-cropped one loses the part that
 * carried the meaning. Letterboxing is the only option that leaves the image
 * saying what it was drawn to say, and the empty area around it costs nothing
 * because there is by definition nothing else to show.
 * @param areaW  Drawing area width.
 * @param areaH  Drawing area height.
 * @param imageW Image natural width.
 * @param imageH Image natural height.
 * @returns The destination rect, or `null` when anything is degenerate.
 */
export function containRect(areaW: number, areaH: number, imageW: number, imageH: number):
{ x: number; y: number; w: number; h: number } | null {
    if (!(areaW > 0 && areaH > 0 && imageW > 0 && imageH > 0)) { return null; }
    const scale = Math.min(areaW / imageW, areaH / imageH);
    const w = imageW * scale;
    const h = imageH * scale;
    return { x: (areaW - w) / 2, y: (areaH - h) / 2, w, h };
}

/** What {@link buildDemo} returns. */
export interface DemoScene {
    /** The 300 mm preset outline, or `null` when a box was supplied - see below. */
    outlineModel: OutlineModel | null;
    /** The dies. */
    items: ItemModel[];
    /** Status to color, the demo's own palette. */
    mapping: Record<string, string>;
}

/**
 * Generates the design-time demo: the 300 mm notch wafer ('si-12in', built at
 * the notch-exaggeration default so the demo matches what the OutlinePreset
 * attribute would draw) tiled with ~180 dies, each die the ekvip sweep
 * ({@link SWEEP_UNIT}) at 22 mm height on a 12 x 26 mm half-offset grid. A die
 * is kept only when its sweep bbox lies fully inside
 * {@link DEMO_LAYOUT}.edgeRadius and clear of the notch keep-out. Statuses form
 * radial yield rings - `BIN_1` (pass) in the center degrading to `BIN_4` at the
 * edge - with a random sprinkle per rebuild: 5 % `BIN_5` rejects, 10 % one-bin
 * jitter; the mapping colors `BIN_1..BIN_5` from the corporate palette
 * ({@link DEMO_STATUS_COLORS}). Every die carries an `item_id`, a grid `name`
 * (`R<row>C<col>`) and an opaque `user_data`, so selection reports real values
 * (SelectedItemId / Name / Status / UserData and the `.onItemSelected`
 * payload). Both the outline and the items go through the engine's real
 * builders ({@link generatePresetOutline} / {@link buildOutlineModel} /
 * {@link itemsToModels}), so the demo exercises the code a real binding does.
 * No demo label is emitted
 * (optional per spec).
 * @returns The demo bundle: the built outline model (or `null` if degenerate),
 *          the built item models, and the demo status -> color mapping.
 */
export function buildDemo(bbox?: BBox | null): DemoScene {
    const mapping: Record<string, string> = { ...DEMO_STATUS_COLORS };

    /*
     * ---- THE BOX, AND WHY IT SCALES RATHER THAN CROPS ----
     *
     * With no box the geometry is the 300 mm wafer this has always drawn, to the
     * byte - asserted rather than asserted about.
     *
     * With one, the whole pattern is scaled to fit and centered: the die COUNT is
     * preserved and the dies get smaller. Cropping was the alternative and it is
     * wrong for what this is. A demo is a showcase of the CONTROL, not a smaller
     * wafer - a cropped demo in a 40 mm box shows a corner with the notch
     * off-screen, which reads as a rendering fault rather than as a sample.
     * Scaling keeps the thing recognizable at any size, which is the property
     * that matters here.
     */
    // The engine's own `BBox` — min/max rather than x/y/width/height. The only
    // caller passes an `OutlineModel.bbox`, so a second box type would be a
    // conversion nobody needs.
    const fit = bbox
        ? Math.min((bbox.maxX - bbox.minX) / (DEMO_LAYOUT.substrateRadius * 2),
            (bbox.maxY - bbox.minY) / (DEMO_LAYOUT.substrateRadius * 2))
        : 1;
    const ox = bbox ? (bbox.minX + bbox.maxX) / 2 : 0;
    const oy = bbox ? (bbox.minY + bbox.maxY) / 2 : 0;

    const halfW = (DEMO_LAYOUT.sweepHeight * SWEEP_ASPECT) / 2;
    const halfH = DEMO_LAYOUT.sweepHeight / 2;
    const nx = Math.floor(DEMO_LAYOUT.edgeRadius / DEMO_LAYOUT.pitchX) + 1;
    const ny = Math.floor(DEMO_LAYOUT.edgeRadius / DEMO_LAYOUT.pitchY) + 1;

    /** Whether (`qx`, `qy`) lies on the usable substrate: inside the edge radius and clear of the notch keep-out. */
    const usable = (qx: number, qy: number): boolean =>
        Math.hypot(qx, qy) <= DEMO_LAYOUT.edgeRadius
        && !(qy <= DEMO_LAYOUT.notchKeepOutY && Math.abs(qx) <= DEMO_LAYOUT.notchKeepOutX);

    // All coordinates are data-frame millimeters (+y up). The data->substrate
    // matrix is neutral (identity) at the attribute defaults, so demo dies
    // authored in D land directly in S. prefix 'milli' makes the engine's unit
    // conversion 1:1, so the literals below are already millimeters.
    const items: ItemList = [];
    let id = 1;
    for (let iy = -ny; iy < ny; iy++) {
        for (let ix = -nx; ix < nx; ix++) {
            const cx = (ix + 0.5) * DEMO_LAYOUT.pitchX;
            const cy = (iy + 0.5) * DEMO_LAYOUT.pitchY;
            if (!usable(cx - halfW, cy - halfH) || !usable(cx + halfW, cy - halfH)
                || !usable(cx - halfW, cy + halfH) || !usable(cx + halfW, cy + halfH)) {
                continue;
            }
            // Radial yield rings (pass in the center, degrading outward) with a
            // random sprinkle: 5 % rejects, 10 % one-bin jitter (clamped to 1..4).
            const rn = Math.hypot(cx, cy) / DEMO_LAYOUT.substrateRadius;
            let bin = rn < 0.45 ? 1 : rn < 0.68 ? 2 : rn < 0.85 ? 3 : 4;
            const roll = Math.random();
            if (roll < 0.05) {
                bin = 5;
            } else if (roll < 0.15) {
                bin = Math.min(4, Math.max(1, bin + (Math.random() < 0.5 ? 1 : -1)));
            }
            const name = 'R' + (ny - iy) + 'C' + (ix + nx + 1);
            items.push({
                item_id: id, name, user_data: 'lot-A/' + name, unit: 'meter', prefix: 'milli', status: 'BIN_' + bin,
                geometries: [{
                    type: 'path',
                    commands: SWEEP_UNIT.map((c) => placeCommand(c,
                        DEMO_LAYOUT.sweepHeight * fit, ox + cx * fit, oy + cy * fit)),
                }],
            });
            id++;
        }
    }

    // The demo substrate is the shared 'si-12in' preset (300 mm disc, 1.125 mm
    // notch at 6 o'clock), built through the SAME generator + buildOutlineModel
    // that the real OutlinePreset uses, at the notch-exaggeration default.
    /*
     * The outline is the shared 'si-12in' preset, built through the SAME generator
     * and builder the real `OutlinePreset` uses. With a box it is DROPPED rather
     * than scaled: `generatePresetOutline` emits millimeters for a real 300 mm
     * substrate, and a caller that supplied a box has its own idea of what the
     * substrate is. Returning a 300 mm disc there
     * would draw a second, wrong substrate over the caller's.
     */
    return {
        outlineModel: bbox
            ? null
            : buildOutlineModel(generatePresetOutline('si-12in', 'cw', DEMO_NOTCH_EXAGGERATION)),
        items: itemsToModels(items),
        mapping,
    };
}

/**
 * Abstract shell owning the stable plumbing shared by every substrate-map
 * control: template root, identity label, canvas, devicePixelRatio bitmap
 * sizing, ResizeObserver, theme reading, pointer wiring, one engine instance and
 * a protected scene API. Concrete subclasses own attributes, events, schemas,
 * demo data and the mapping of their data model onto the engine; they fill the
 * two abstract hooks {@link __composeIdentity} and {@link __raiseSelected}.
 */
export abstract class SubstrateMapBase extends TcHmi.Controls.System.TcHmiControl {
    /** Root element of the control template (`*-SubstrateMapBase-Template`). Set in __previnit, cleared in destroy. */
    protected __elementTemplateRoot: HTMLElement | null = null;

    /** Identity label element, or `null` while detached. */
    protected __identityEl: HTMLDivElement | null = null;

    /** Backing canvas, or `null` while detached. Created in __attach, removed and nulled in __detach. */
    protected __canvas: HTMLCanvasElement | null = null;

    /** 2D context of {@link __canvas}. Lifetime identical to the canvas. */
    protected __canvasContext: CanvasRenderingContext2D | null = null;

    /** Observer keeping the canvas bitmap in sync with its CSS size (and identity toggles). */
    protected __resizeObserver: ResizeObserver | null = null;
    /**
     * The staleness heartbeat, or `null` when nothing asked for one.
     *
     * ---- THE ONE THING THAT CANNOT BE OBSERVED ----
     *
     * Every other update here is a reaction to an event: data arrives by binding,
     * size by `ResizeObserver`, theme by the framework. **Staleness is the absence
     * of an event**, and you cannot observe something not happening - so the only
     * thing that could trigger the warning is the data that stopped arriving.
     *
     * Without it the stale border would be drawn only during a render, a render
     * happens on new data, and a dead feed produces none: the warning that a feed
     * is dead could only appear while the feed was alive.
     */
    protected __staleTimer: ReturnType<typeof setInterval> | null = null;
    /** How many renders have been requested, for the heartbeat assertion. */
    protected __renderRequests: number = 0;

    /**
     * How far a pointer may travel between press and release and still count as a
     * click, in CSS pixels.
     *
     * Five, because a finger on glass moves two or three pixels while pressing and
     * a mouse moves one or none; a pan is tens. Forgiving enough that a deliberate
     * tap is never eaten, small enough that a drag is never mistaken for one
     *.
     */
    protected static readonly DRAG_SLOP_PX = 5;

    /**
     * Where the current press started, in CSS pixels relative to the canvas, or
     * `null` when no press is in flight.
     *
     * The control listened to `pointerup` ALONE, so a drag that began on one die
     * and released over another selected the second - and any gesture that happened
     * to end over the map selected whatever lay beneath the release.
     */
    protected __pressAt: { x: number; y: number; id: number } | null = null;

    /** Bound `pointerdown` handler kept for later removal. */
    protected __onPointerDown: ((ev: PointerEvent) => void) | null = null;

    /** Bound `pointerup` handler kept for later removal. */
    protected __onPointerUp: ((ev: PointerEvent) => void) | null = null;

    /** Pending requestAnimationFrame handle for coalesced rendering, or `null` when idle. */
    protected __rafHandle: number | null = null;


    /** Identity label placement: `'above'`, `'below'` or `'none'`. Shell state; the concrete attribute maps onto it. */
    protected __identityPosition: string = 'below';

    // ---- engine scene (pushed by the concrete via the scene API, drawn by {@link __render}) ----

    /** Current substrate outline model, or `null` (no body; items-fit fallback). */
    protected __sceneOutline: OutlineModel | null = null;
    /** Current render-ready items (empty when none are bound). */
    protected __sceneItems: ItemModel[] = [];
    /** Current effective-status resolver, or `null` (everything resolves to the unknown color). */
    protected __sceneResolve: ((item: ItemModel) => ItemStatus | null) | null = null;
    /** Current status -> CSS color mapping, or `null` (theme fallback only). */
    protected __sceneMapping: Record<string, string> | null = null;

    /**
     * Author `BinQuality` token -> `pass` / `fail`, or `null`.
     *
     * Set by the derived control alongside {@link __sceneMapping}, and passed to
     * `drawSubstrateMap` for color resolution only. The DIAGNOSIS for an unmapped
     * token is the derived control's, raised once when the model is built rather
     * than on every frame.
     */
    protected __sceneBinQualityAliases: Record<string, string> | null = null;
    /** `BinSeverityPriority` for the scene, or `null`. Set by the derived control. */
    protected __sceneBinSeverityPriority: readonly string[] | null = null;
    /** `TouchTargetSize` for the scene, in CSS px. Set by the derived control. */
    protected __sceneTouchTargetCssPx: number = TOUCH_TARGET_DEFAULT_PX;
    /**
     * The `valueField` overlay's per-cell indices and its ramp, or `null`.
     *
     * Set by the derived control when `E142Overlays` names one. Replaces the fill;
     * the base still owns the geometry, the selection and the bin codes reported on
     * a tap.
     */
    protected __sceneValueFill: { cells: Uint32Array; colors: readonly string[] } | null = null;

    /**
     * The categorical fallback color per bin-table index, or `null`.
     *
     * Computed ONCE by the concrete when the scene changes, and read by both the
     * render and `readBinStatistics`. One computation with two readers is what
     * keeps the chart and the map agreeing; two computations is how they diverge.
     */
    protected __sceneCategorical: readonly (string | null)[] | null = null;
    /**
     * Muted colors by bin-table index for `HighlightFromSeverity`, or `null`.
     *
     * Alongside the categorical fallback and for the same reason: the
     * render path and `readBinStatistics` both need it and must AGREE, so it is
     * computed once on a scene change rather than derived in each. A chart that
     * showed a bin's true color while the map showed it grayed would be
     * describing a different picture.
     */
    protected __sceneHighlight: readonly (string | null)[] | null = null;

    // ---- the empty state ----

    /** `NoDataImage`, or `null` for the shipped default. */
    protected __noDataImage: string | null = null;
    /** `NoDataImageDark`, or `null` for the shipped default. */
    protected __noDataImageDark: string | null = null;
    /** `NoDataText`, or `null` for no line under the image. */
    protected __noDataText: string | null = null;
    /**
     * Whether the scene the concrete pushed is the DEMO.
     *
     * The base cannot tell a demo item from a real one - both are `ItemModel`s
     * through the same builder, which is the point of authoring the demo as a
     * schema `ItemList`. So the concrete says, and the demo marking reads the
     * same flag.
     */
    protected __sceneIsDemo: boolean = false;
    /**
     * The no-data image being loaded or drawn: `{ src, image, failed }`.
     *
     * One slot, not a cache. Only ever one image is wanted at a time, and a map
     * that changes its no-data image on every frame is not a case worth carrying
     * a cache for.
     */
    protected __noDataLoaded: { src: string; image: HTMLImageElement; failed: boolean } | null = null;
    /** Sources already reported as unavailable, so the warning is once per URL. */
    protected __noDataWarned: Set<string> = new Set();
    /** The author's view transform, or `null` for identity. Set by the derived control. */
    protected __sceneViewTransform: DOMMatrix | null = null;
    /** The fail-fraction transfer exponent for the scene. */
    protected __sceneAggregationGamma: number = 0.4;
    /**
     * Which reduction an aggregated tile uses.
     *
     * Starts at `MaxSeverity`; each aggregated frame then takes the measured
     * choice, or the override below when one is set. The render path and the
     * cache key both carry it.
     */
    protected __sceneReducer: GridReducer = 'MaxSeverity';
    /**
     * `'Auto'` to let the measurement choose, or a reducer to force it.
     *
     * Set by the derived control's `AggregationReducer` attribute.
     */
    protected __reducerOverride: GridReducer | 'Auto' = 'Auto';
    /** What the last aggregated frame measured, or `null`. Read-only diagnostics. */
    protected __lastSaturation: number | null = null;
    /** Current render-ready labels (empty when none are bound). */
    protected __sceneLabels: LabelModel[] = [];
    /** Current cell grid model, or `null` (no grid). Pushed via {@link __updateGrid}. */
    protected __sceneGrid: GridModel | null = null;
    /**
     * Monotonic version of {@link __sceneGrid}'s DATA, bumped by {@link __updateGrid}.
     * It is the layer cache's data term (see {@link GridLayerCache}); a version rather
     * than object identity, so the cache survives a concrete that hands back an
     * equal-but-new model object only when it really is the same push.
     */
    protected __sceneGridVersion: number = 0;
    /**
     * Offscreen cache backing the grid layer, or `null` while detached / where
     * `OffscreenCanvas` is unavailable. Owned by the control (created in
     * {@link __attach}, disposed in {@link __detach}) rather than by the engine
     * module, because its bitmap is per-canvas and must die with the canvas.
     */
    protected __gridCache: GridLayerCache | null = null;
    /** Whether labels are drawn (mirrors the concrete's `ShowLabels`, carried in with the labels). */
    protected __sceneShowLabels: boolean = true;
    /** Whether the origin marker is drawn (mirrors the concrete's `ShowOriginMarker`, pushed via {@link __updateShowOriginMarker}). */
    protected __sceneShowOriginMarker: boolean = false;

    // ---- data-frame placement (resolved numbers pushed by the concrete via {@link __updatePlacement}) ----
    // The concrete owns the Origin attributes; it resolves them to these engine-ready
    // scalars (prefix -> millimeters, degrees -> radians) and pushes them here. The
    // engine's D2S ({@link makeDataMatrix}) never sees attribute state. The defaults
    // match the concrete's Origin attribute defaults, so the first render before any
    // push (and every default configuration) yields the identity D2S.

    /** Anchor of the data origin on the fit box (default `'center'`). */
    protected __placementLocation: OriginAnchor = 'center';
    /** Data-origin X offset along S +x, in millimeters (default 0). */
    protected __placementOffsetXmm: number = 0;
    /** Data-origin Y offset along S +y, in millimeters (default 0). */
    protected __placementOffsetYmm: number = 0;
    /** Data-axes rotation about the origin, radians, CCW-positive in S (default 0). */
    protected __placementRotationRad: number = 0;
    /** Data Y-axis direction; `'down'` mirrors the D y axis (default `'up'`). */
    protected __placementYDir: YAxisDirection = 'up';

    // ---- view (the resolved MapRotation pushed by the concrete via {@link __updateViewRotation}) ----

    /**
     * View rotation of the whole construct about the substrate frame origin, in
     * radians, CCW-positive on screen (default 0 = unrotated). Fed to
     * {@link makeWorldMatrix} as VIEW and to {@link rotatedExtent} so the letterbox
     * fit grows with the rotation and nothing is clipped (both in
     * {@link __computeMatrices}). The default matches the concrete's `MapRotation`
     * default, so the first render before any push - and every neutral
     * configuration - yields the unrotated view. Display-only: it never moves Item
     * coordinates or changes the hit result, because the hit path consumes the SAME
     * `W` built here.
     */
    protected __viewRotationRad: number = 0;

    /**
     * Last interacted element, or `null` (after a clear). Fills the single-value
     * fields of the selection payload; the full sets are {@link __selection} and
     * {@link __selectedCells}. On a `'multi'` toggle-OFF this still points at the
     * toggled element (the last INTERACTED one), which is why it is distinct from
     * set membership. The concrete's read-only selection outputs are filled from
     * the payload, separately.
     *
     * Discriminated rather than two fields with an "at most one is non-null"
     * invariant: item ids and cell indices collide numerically, so the kind has to
     * be carried anyway, and one field makes the invariant unrepresentable instead
     * of merely documented.
     */
    protected __lastInteracted:
        | { kind: 'item'; item: ItemModel }
        | { kind: 'cell'; cell: CellHit }
        | null = null;

    /**
     * Full current selection as render models, in selection order. Drives the
     * selection rings - every entry is marked, not just {@link __selected} - and
     * the `selection` array of the payload. Membership is by OBJECT IDENTITY: it is
     * stable while the scene is unchanged and correctly distinguishes id-less items
     * (which an id-keyed set could not); a scene rebuild clears it. ITEM selections
     * only - cells are indices, not objects, and live in {@link __selectedCells}.
     */
    protected __selection: ItemModel[] = [];

    /**
     * Full current CELL selection as row-major linear indices, in selection order
     * (`Set` preserves insertion order). Drives the cell selection rings and the
     * `'cell'` entries of the payload.
     *
     * A `Set` rather than an array because cell selections can grow large (a future
     * rubber-band selects tens of thousands) and both the toggle and the per-render
     * ring pass need O(1) membership. Note the contrast with {@link __selection}:
     * cell identity is POSITIONAL (index 5 exists in every grid), not referential,
     * which is why {@link __updateGrid} must clear this on a lattice swap while
     * item identity survives on its own.
     */
    protected __selectedCells: Set<number> = new Set();

    /**
     * Selection behavior driving {@link __handlePointerUp}: `'single'` (a hit
     * REPLACES the selection, a miss changes nothing)
     * or `'multi'` (a hit TOGGLES membership, a click on empty space CLEARS). Shell
     * state owned by the base, like {@link __identityPosition}; the concrete's
     * `SelectionMode` attribute maps onto it via {@link __setSelectionMode}, so the
     * base needs no third abstract hook to read the mode.
     *
     * `'none'` means the control does not select AT ALL: the
     * pointer path does no hit testing, stores nothing and draws no ring. A tile
     * whose header says "no overlay selection, no selection mode" said so about its
     * ATTRIBUTES and inherited the behavior anyway - a click set four cells and
     * painted a ring while `__raiseSelected` discarded the payload, so the operator
     * got feedback nobody could act on. A declaration about a control's surface has
     * to be a declaration about its behavior, or it is decoration.
     *
     * `'none'` is not exposed on `SubstrateMap`'s `SelectionMode` attribute. It is a
     * shell-level fact a subclass asserts about itself, not a mode an author picks -
     * an author who wants an inert map wants a picture.
     */
    protected __selectionMode: 'single' | 'multi' | 'none' = 'single';

    /**
     * Constructor of the control.
     * @param element Element of the control as delivered by the framework.
     * @param pcElement Precompiled element of the control.
     * @param attrs Attributes of the element as delivered by the framework.
     */
    public constructor(element: JQuery, pcElement: JQuery, attrs: TcHmi.Controls.ControlAttributeList) {
        super(element, pcElement, attrs);
    }

    /**
     * Locates the template root and raises if it is missing. The root is
     * searched by the BASE template class name, so every subclass template
     * reuses `TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Template` on
     * its root element - the same pattern the attached package uses for
     * TcHmiToggleSwitch, whose Template.html root carries the class of its base
     * control TcHmiCheckbox.
     * @throws {Error} If the template root element is missing.
     */
    public __previnit(): void {
        const root = this.__element.find('.TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Template')[0];
        if (!root) {
            throw new Error(
                'Invalid Template.html of "' + this.getId() +
                '": root element with class "TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Template" not found.'
            );
        }
        this.__elementTemplateRoot = root;
        super.__previnit();
    }

    /** Initializes the control after the template is available. */
    public __init(): void {
        super.__init();
    }

    /**
     * Attaches the control to the page: creates the identity label and canvas,
     * applies the initial identity, starts the ResizeObserver, wires the pointer
     * handler, creates the engine instance and requests the first render.
     */
    public __attach(): void {
        super.__attach();
        const root = this.__elementTemplateRoot;
        if (!root || this.__canvas) {
            return;
        }

        // Structural layout is set inline so the shell functions regardless of
        // base-chain stylesheet loading (honoring the S1 inline-sizing choice): a
        // vertical flexbox where the canvas fills the remaining space and the
        // identity label is ordered above/below via its `order`. The identity
        // font/padding is themeable via the base Style.css (--substratemap-*).
        root.style.width = '100%';
        root.style.height = '100%';
        root.style.display = 'flex';
        root.style.flexDirection = 'column';
        root.style.position = 'relative';

        const identity = document.createElement('div');
        identity.className = 'TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Identity';
        identity.style.flex = '0 0 auto';
        /*
         * THE BAND IS RESERVED, NOT GROWN.
         *
         * This element is a flex sibling of the canvas, so its height comes out of
         * the canvas' height, which is what `__makeConfig` measures and what the
         * letterbox scale divides. It used to be `display: none` whenever the text
         * was empty - and the text is empty until data arrives. So binding data
         * made the band appear, took ~18 px off the canvas, and shrank the wafer by
         * about 5%: reported from the field as "the text claims space and the wafer
         * shrink... it looks really weird".
         *
         * Reserving one line whether or not there is text makes the canvas' height
         * independent of content - the rule the fit box already follows, applied to
         * layout.
         *
         * Set INLINE, next to `flex`, for the reason the block above gives: the
         * shell must lay out correctly whether or not the base stylesheet has
         * loaded (the S1 inline-sizing choice). A reservation that lives only in
         * Style.css is a reservation that is absent exactly when the stylesheet is,
         * and then the wafer resizes again.
         *
         * `lineHeight` is pinned with the height on purpose. Without it an empty
         * band is one height and a filled one is one `normal` line tall, which are
         * close but not equal - and "close" is a wafer that moves by a pixel or two
         * on every bind. `content-box` keeps Style.css' 2px padding outside the
         * reservation, so both states carry the same padding on the same content
         * height.
         *
         * `height`, NOT `min-height`. A minimum is a floor, and a floor only
         * fixes empty-versus-one-line. A long identity string that wraps to two
         * lines grows straight through it and shrinks the wafer again - which is
         * what the reporter guessed was happening, using items AND grid mapping to
         * get a longer id. `white-space: nowrap` would prevent the wrap, but it
         * lives only in Style.css, so it is absent in exactly the situation this
         * block exists to survive. Fixed height plus inline nowrap, overflow and
         * ellipsis means NO content of any length can change the band's height.
         */
        identity.style.boxSizing = 'content-box';
        identity.style.lineHeight = '1.2';
        identity.style.height = '1.2em';
        identity.style.overflow = 'hidden';
        identity.style.whiteSpace = 'nowrap';
        identity.style.textOverflow = 'ellipsis';
        root.appendChild(identity);
        this.__identityEl = identity;

        const canvas = document.createElement('canvas');
        canvas.className = 'TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Canvas';
        canvas.style.flex = '1 1 auto';
        canvas.style.minHeight = '0';
        canvas.style.width = '100%';
        canvas.style.display = 'block';
        root.appendChild(canvas);
        this.__canvas = canvas;
        this.__canvasContext = canvas.getContext('2d');
        // Per-canvas offscreen bitmap for the grid layer. Allocated lazily by the
        // cache itself, so an unsupported platform (or a control that never gets a
        // grid) costs nothing beyond this object.
        this.__gridCache = GridLayerCache.isSupported() ? new GridLayerCache() : null;

        this.__updateIdentity();

        // Observe the canvas box (changes on external resize AND when the identity
        // label toggles), then request a coalesced re-render.
        this.__resizeObserver = new ResizeObserver(() => this.__requestRender());
        this.__resizeObserver.observe(canvas);
        // The canvas exists now, so a heartbeat can be started if one is wanted.
        this.__syncStaleTimer();

        this.__onPointerUp = (ev: PointerEvent) => this.__handlePointerUp(ev);
        canvas.addEventListener('pointerup', this.__onPointerUp);
        // The press position, so a release can tell a tap from the end of a drag.
        this.__onPointerDown = (ev: PointerEvent) => {
            const r = canvas.getBoundingClientRect();
            this.__pressAt = { x: ev.clientX - r.left, y: ev.clientY - r.top, id: ev.pointerId };
        };
        canvas.addEventListener('pointerdown', this.__onPointerDown);

        this.__requestRender();
    }

    /**
     * Detaches the control and tears everything down: cancels a pending render,
     * disconnects the observer, removes the pointer handler, disposes the engine
     * and the grid layer cache, and removes the canvas and identity label. All fields are nulled so a
     * re-attach starts from a clean state.
     */
    public __detach(): void {
        super.__detach();
        if (this.__rafHandle !== null) {
            window.cancelAnimationFrame(this.__rafHandle);
            this.__rafHandle = null;
        }
        if (this.__staleTimer !== null) {
            clearInterval(this.__staleTimer);
            this.__staleTimer = null;
        }
        if (this.__resizeObserver) {
            this.__resizeObserver.disconnect();
            this.__resizeObserver = null;
        }
        if (this.__canvas && this.__onPointerUp) {
            this.__canvas.removeEventListener('pointerup', this.__onPointerUp);
        }
        this.__onPointerUp = null;
        if (this.__canvas && this.__onPointerDown) {
            this.__canvas.removeEventListener('pointerdown', this.__onPointerDown);
        }
        this.__onPointerDown = null;
        this.__pressAt = null;
        if (this.__gridCache) {
            this.__gridCache.dispose();     // release the layer bitmap with the canvas
            this.__gridCache = null;
        }
        if (this.__canvas) {
            this.__canvas.remove();
            this.__canvas = null;
            this.__canvasContext = null;
        }
        if (this.__identityEl) {
            this.__identityEl.remove();
            this.__identityEl = null;
        }
    }

    /** Destroys the control unless the framework asked to keep it alive. */
    public destroy(): void {
        if (this.__keepAlive) {
            return;
        }
        super.destroy();
        this.__elementTemplateRoot = null;
    }

    // ---------------------------------------------------------------
    //  The empty state
    //
    //  THE FIRST ATTRIBUTES THE BASE HAS EVER DECLARED. Every attribute until
    //  now lived on the concrete; these are on the base because all four
    //  controls need the same empty state, and `heritable` makes them reachable
    //  from each child.
    // ---------------------------------------------------------------

    /**
     * Sets the image shown when there is nothing to show.
     *
     * Any format the browser renders. `null` restores the shipped `NoData.svg`.
     * The image is scaled `contain` into the drawing area and centered, never
     * stretched - an image whose aspect ratio differs from the area's is
     * letterboxed.
     * @param valueNew A URL, or `null` for the shipped image.
     */
    public setNoDataImage(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__noDataImage)) { return; }
        this.__noDataImage = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NoDataImage' });
        this.__requestRender();
    }
    /** @returns The configured no-data image, or `null` for the shipped one. */
    public getNoDataImage(): string | null { return this.__noDataImage; }

    /**
     * Sets the no-data image for the dark theme.
     *
     * A separate file rather than a filter: mirroring lightness in OKLCH keeps a
     * blue accent blue, where `filter: invert()` rotates hue and turns it orange.
     * The shipped dark variant is a drawing of its own, and a designer can
     * replace it.
     * @param valueNew A URL, or `null` for the shipped dark image.
     */
    public setNoDataImageDark(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__noDataImageDark)) { return; }
        this.__noDataImageDark = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NoDataImageDark' });
        this.__requestRender();
    }
    /** @returns The configured dark no-data image, or `null` for the shipped one. */
    public getNoDataImageDark(): string | null { return this.__noDataImageDark; }

    /**
     * Sets one line of text under the no-data image.
     *
     * `null` draws no line at all rather than an empty one, so a control that
     * says nothing occupies no vertical space for it.
     * @param valueNew The line, or `null`.
     */
    public setNoDataText(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__noDataText)) { return; }
        this.__noDataText = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NoDataText' });
        this.__requestRender();
    }
    /** @returns The configured line, or `null`. */
    public getNoDataText(): string | null { return this.__noDataText; }

    /**
     * Which empty state this control is in, from the scene it is holding.
     *
     * A thin read over {@link emptyState}, which is where the precedence lives.
     * The demo flag is read from the SCENE rather than from an attribute: the
     * concrete has already decided whether the demo won, and asking the attribute
     * again would let the two disagree.
     *
     * `hasLastKnown` comes from {@link __hasLastKnown}, which a concrete overrides
     * when it retains one. The default is `false`, so a control that
     * retains nothing falls through to the demo or the no-data image exactly as
     * before.
     * @returns The state.
     */
    public readEmptyState(): 'data' | 'stale' | 'demo' | 'nodata' {
        /*
         * `hasGrid` means a CURRENT grid, not merely one on screen.
         *
         * The retained model goes through the same path as a live one - that is the
         * point, so it resizes and re-themes - and `emptyState`'s first row would
         * then answer `'data'` before the `'stale'` row was ever reached: an unbound
         * tile would report `data` with a retained wafer visible, which is precisely
         * the lie the stale state exists to prevent.
         */
        return emptyState({
            hasGrid: this.__hasContent() && !this.__hasLastKnown(),
            itemCount: this.__sceneItems.length,
            isDemo: this.__sceneIsDemo,
            hasLastKnown: this.__hasLastKnown(),
            showDemoItems: this.__sceneIsDemo,
        });
    }

    /**
     * How often to wake and re-check staleness, in milliseconds.
     *
     * ---- DERIVED FROM THE THRESHOLD, BECAUSE THE THRESHOLD IS THE PROCESS ----
     *
     * A takt time of fifteen minutes per substrate and a printer at 1.2 seconds
     * are three orders of magnitude apart, and a fixed interval is wrong for both:
     * polling every second is waste on the first and polling every minute is
     * useless on the second.
     *
     * The author has already told us the timescale by setting `StaleAfterSeconds`,
     * so the interval is a tenth of it - the lateness is proportional, which is the
     * right shape for an error. A floor of one second stops a threshold of two
     * producing a 200 ms heartbeat; a ceiling of a minute stops a threshold of a
     * day checking twice an hour.
     * @param staleAfterSeconds The threshold, or `null`.
     * @returns The interval in ms, or `null` for no timer at all.
     */
    protected __staleTickMs(staleAfterSeconds: number | null): number | null {
        if (staleAfterSeconds === null || !(staleAfterSeconds > 0)) { return null; }
        return Math.min(60_000, Math.max(1_000, (staleAfterSeconds * 1000) / 10));
    }

    /**
     * Starts, restarts or stops the heartbeat to match the current threshold.
     *
     * Called whenever the threshold changes and on attach. NOTHING RUNS when no
     * threshold is set, so the cost lands only on authors who asked for the
     * feature - which is the answer to "is it useless to poll every second".
     * @returns Nothing.
     */
    protected __syncStaleTimer(): void {
        const ms = this.__staleTickMs(this.__staleAfterSecondsForTimer());
        if (this.__staleTimer !== null) {
            clearInterval(this.__staleTimer);
            this.__staleTimer = null;
        }
        if (ms === null || this.__canvas === null) { return; }
        this.__staleTimer = setInterval(() => { this.__requestRender(); }, ms);
    }

    /**
     * The staleness threshold this control holds, or `null`.
     *
     * A default of `null` on the base: three of the four controls have no such
     * attribute, and a hook is a default, not abstract, when omission is the
     * common case.
     * @returns The threshold in seconds, or `null`.
     */
    protected __staleAfterSecondsForTimer(): number | null {
        return null;
    }

    /**
     * Whether this control is holding something to show.
     *
     * Defaults to "a grid is pushed", which is what it means for the map and the
     * tile. A control that HOLDS data without pushing it as a scene grid overrides
     * this - `SubstrateMapBinChart` counts a lattice it never draws, and without
     * the hook it reported `'nodata'` with a chart full of bars on screen, so the
     * base drew the no-data image underneath them.
     *
     * A default rather than an abstract hook: abstract when omission is a bug,
     * default when omission is the common case. Three of
     * the four concrete controls want exactly this answer.
     * @returns Whether there is content.
     */
    protected __hasContent(): boolean {
        return this.__sceneGrid !== null;
    }

    /**
     * Whether this control is holding a last known state to fall back on.
     *
     * A DEFAULT of `false`, not an abstract hook: three of the four controls
     * retain nothing - abstract when omission is a bug, default when omission is
     * the common case.
     * @returns Whether a last known state exists.
     */
    protected __hasLastKnown(): boolean {
        return false;
    }

    /**
     * Draws the demo marking: a diagonal hatch across the whole drawing area, and
     * the word `DEMO`.
     *
     * ---- THERE IS NO ATTRIBUTE FOR THIS ----
     *
     * An author cannot switch it off, and that is the feature. A plausible-looking
     * gray wafer on a dashboard is worse than an empty tile, because it will be
     * BELIEVED - someone will read a yield off sample data. The marking is the
     * point and the picture is decoration, so the marking is not negotiable.
     *
     * ---- HATCH ACROSS EVERYTHING, NEVER A CORNER BADGE ----
     *
     * A badge sits in one corner and is missed, cropped by a tile, or covered by a
     * surrounding layout, and a screenshot of the middle of the map carries no
     * trace of it. A hatch crosses every part of the drawn area, so no crop of it
     * is unmarked. It is drawn over the finished frame in CSS pixels rather than in
     * map space: at 0.3 device pixels per cell the map is a smear of color, and a
     * hatch that scaled with the map would be a smear too.
     *
     * ---- LEGIBILITY ----
     *
     * Both colors come from the theme through {@link SubstrateMapColors}, so a
     * dark theme gets a light hatch without this code knowing which theme it is in.
     * The stripe pitch is fixed for the same reason the hatch is not in map space.
     * The word scales with the shorter side and stops at a floor, so it stays a
     * word rather than a mark at 60 px.
     * @param ctx    The canvas context.
     * @param width  Drawing area width in CSS pixels.
     * @param height Drawing area height in CSS pixels.
     * @param colors The resolved theme colors.
     * @returns Nothing.
     */
    protected __drawDemoMarking(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors): void {
        if (!(width > 0 && height > 0)) { return; }
        ctx.save();

        /*
         * The hatch. Lines at 45 degrees, `DEMO_HATCH_PITCH` apart, starting at
         * `-height` so the corners are struck too. `globalAlpha` rather than an
         * rgba string, because the theme color arrives as an opaque token and
         * adding an alpha to it would mean a second color parser here.
         */
        ctx.globalAlpha = DEMO_HATCH_ALPHA;
        ctx.strokeStyle = colors.edge;
        ctx.lineWidth = DEMO_HATCH_WIDTH;
        ctx.beginPath();
        for (let x = -height; x < width + height; x += DEMO_HATCH_PITCH) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x + height, height);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        /*
         * The word, centered, sized from the SHORTER side so a wide flat panel gets
         * a word that fits its height. Stroked in the background color and then
         * filled: it stays readable over whatever the map drew underneath, without
         * a panel behind it that would hide the very data being warned about.
         */
        const size = Math.max(DEMO_LABEL_MIN_PX, Math.min(width, height) * DEMO_LABEL_FRACTION);
        ctx.font = `700 ${size.toFixed(0)}px ${DEMO_LABEL_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(2, size * 0.12);
        ctx.strokeStyle = colors.bg !== '' ? colors.bg : colors.body;
        ctx.strokeText(DEMO_LABEL, width / 2, height / 2);
        ctx.fillStyle = colors.edge;
        ctx.fillText(DEMO_LABEL, width / 2, height / 2);

        ctx.restore();
    }

    /**
     * Which no-data image this control should show, resolved for the theme.
     *
     * ---- THE THEME IS MEASURED, NOT ASKED FOR ----
     *
     * The dark variant is chosen by the LIGHTNESS of the resolved background,
     * through `Oklch`, rather than by a theme name. Three reasons, and the third
     * is the one that decided it:
     *
     *   - the framework's theme name is not readable from anything in this
     *     repository, so a name test would be written from memory;
     *   - a custom theme that is dark but is not called Base-Dark gets the right
     *     image for free;
     *   - this project decides color by measurement, and `rgbToOklch` is already
     *     checked against published values. It is that rule again.
     *
     * A background that does not parse falls to the light variant, because the
     * light one is the shipped default and an unreadable theme is not a reason to
     * invert.
     * @returns The URL to load.
     */
    protected __noDataSource(): string {
        const bg = parseRgb(this.__readColors().bg ?? '');
        const dark = bg !== null && rgbToOklch(bg).L < 0.5;
        const authored = dark ? this.__noDataImageDark : this.__noDataImage;
        /*
         * AN AUTHOR'S PATH IS THEIRS; OURS HAS TO BE RESOLVED.
         *
         * The defaults are file names sitting next to this source, and a bare name
         * given to `Image.src` is resolved by the BROWSER against the view's URL -
         * not against the package. So a view at `/Desktop.view` asked the server for
         * `/NoDataBase.svg`, got a 404, and the control fell back to its built-in
         * drawing while reporting `SUBSTRATEMAP_NODATA_IMAGE_UNAVAILABLE`. The file
         * was in the package the whole time and correctly listed in the nuspec: the
         * request simply went to the wrong place.
         *
         * `getPackageBasePath` is how the framework answers "where was I installed",
         * and it is the only thing that knows, because the answer depends on the
         * publish layout rather than on anything in this repository.
         */
        if (authored !== null && authored !== undefined) { return authored; }
        const file = dark ? NO_DATA_IMAGE_DARK_DEFAULT : NO_DATA_IMAGE_DEFAULT;
        const base = TcHmi.Environment?.getPackageBasePath?.(PACKAGE_NAME) ?? null;
        if (base === null || base === '') { return file; }
        return `${base.replace(/\/+$/, '')}/Controls/SubstrateMapBase/${file}`;
    }

    /**
     * Draws the no-data image and its text line, `contain` and centered.
     *
     * ---- THE FALLBACK ----
     *
     * An image that will not load falls back to the SHIPPED one and reports
     * `SUBSTRATEMAP_NODATA_IMAGE_UNAVAILABLE`, once per URL. Drawing an empty area
     * would be the worst of the three options available: the control would look
     * broken in exactly the situation where it is supposed to explain itself, and
     * nothing would say why. Falling back silently is the second worst, because
     * the author's own image is gone and they are not told.
     *
     * The shipped image failing is not handled specially: it fails, nothing is
     * drawn, and the warning names it. A control that cannot load a file from its
     * own folder has a deployment fault that a second fallback would hide.
     * @param ctx    The canvas context.
     * @param width  Drawing area width in CSS pixels.
     * @param height Drawing area height in CSS pixels.
     * @returns Nothing.
     */
    protected __drawNoData(ctx: CanvasRenderingContext2D, width: number, height: number): void {
        const wanted = this.__noDataSource();
        if (this.__noDataLoaded === null || this.__noDataLoaded.src !== wanted) {
            this.__noDataLoaded = { src: wanted, image: new Image(), failed: false };
            const slot = this.__noDataLoaded;
            slot.image.onload = (): void => { this.__requestRender(); };
            slot.image.onerror = (): void => {
                slot.failed = true;
                if (!this.__noDataWarned.has(wanted)) {
                    this.__noDataWarned.add(wanted);
                    // TcHmi.Log directly: `__logWarnings` is the concrete's, and the
                    // base has no diagnostics channel of its own. Nothing here needs
                    // the concrete's latching, because the Set above already does it.
                    TcHmi.Log.warn(
                        `SUBSTRATEMAP_NODATA_IMAGE_UNAVAILABLE: "${wanted}" could not be loaded; `
                        + 'falling back to the shipped image.');
                }
                this.__requestRender();
            };
            slot.image.src = wanted;
        }

        let slot = this.__noDataLoaded;
        if (slot.failed && slot.src !== NO_DATA_IMAGE_DEFAULT) {
            // The fallback is a load like any other, so a failing shipped image
            // reports itself too rather than recursing.
            this.__noDataLoaded = { src: NO_DATA_IMAGE_DEFAULT, image: new Image(), failed: false };
            slot = this.__noDataLoaded;
            slot.image.onerror = (): void => { slot.failed = true; };
            slot.image.src = NO_DATA_IMAGE_DEFAULT;
        }

        const colors = this.__readColors();
        const text = this.__noDataText;
        // The text line reserves its own band, so the image is centered in what is
        // LEFT rather than under the whole area with the line overlapping it.
        const band = text === null || text === '' ? 0 : Math.min(28, height * 0.18);
        const rect = slot.failed
            ? null
            : containRect(width, height - band, slot.image.naturalWidth, slot.image.naturalHeight);
        if (rect !== null) {
            ctx.drawImage(slot.image, rect.x, rect.y, rect.w, rect.h);
        }
        if (band > 0) {
            ctx.save();
            ctx.fillStyle = colors.labelColor;
            ctx.font = colors.labelFont;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text as string, width / 2, height - band / 2);
            ctx.restore();
        }
    }

    /**
     * Everything about the concrete's filter surface that changes the image.
     *
     * Joins the grid cache key. The base has no filter surface of its own and does
     * not want one: `SubstrateMapBase` draws, and what may be filtered is the
     * concrete's business. Empty by default, so a control with no filters adds
     * nothing to the key.
     * @returns The term, or `''`.
     */
    protected __filterKey(): string { return ''; }

    /**
     * The spatial filter to run, or `undefined` for none.
     *
     * A DEFAULT of `undefined`: three of the four controls have no filter surface,
     * so it is a default, not abstract. The concrete that has one overrides this, and the
     * base stays ignorant of what a filter looks like - exactly as it does for
     * {@link __filterKey}, which is the same decision one layer along.
     * @returns The request, or `undefined`.
     */
    protected __spatialFilterRequest(): { kind: string; radius: number; gamma: number } | undefined {
        return undefined;
    }

    /**
     * The concrete's chance to draw over the finished frame.
     *
     * Not abstract: three of the four controls want nothing here, and an abstract
     * hook would make each of them write an empty method to say so. A default
     * that does nothing is the honest shape when doing nothing is the common
     * case - unlike `__composeIdentity` and `__raiseSelected`, where every
     * control has an answer and forgetting to give one is a defect.
     * @param ctx    The canvas context.
     * @param width  Drawing area width in CSS pixels.
     * @param height Drawing area height in CSS pixels.
     * @param colors The resolved theme colors.
     * @returns Nothing.
     */
    protected __drawOverlay(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors, matrices: MapMatrices): void {
        void ctx;
        void matrices;
        void width;
        void height;
        void colors;
    }

    // ---------------------------------------------------------------
    //  Abstract hooks (filled by the concrete control)
    // ---------------------------------------------------------------

    /**
     * Composes the identity text shown in the identity label. An empty string
     * hides the identity area.
     * @returns The identity text.
     */
    protected abstract __composeIdentity(): string;

    /**
     * Raises the concrete control's selection event with the full v4 payload.
     * Called by the base's pointer/hit-test path once selection lands (M-tasks);
     * the base itself declares no events, so the concrete owns the raise.
     * @param payload The selection payload (last interacted element + full selection).
     */
    protected abstract __raiseSelected(payload: SelectedPayload): void;

    // ---------------------------------------------------------------
    //  Identity placement plumbing
    // ---------------------------------------------------------------

    /**
     * Records the identity placement (`'above'`, `'below'` or `'none'`) and
     * reapplies it. Any value other than `'above'`/`'none'` is treated as
     * `'below'` by {@link __updateIdentity}; the concrete attribute setter is
     * expected to have validated already.
     * @param position New placement.
     */
    protected __setIdentity(position: string): void {
        if (this.__identityPosition === position) {
            return;
        }
        this.__identityPosition = position;
        this.__updateIdentity();
    }

    /**
     * Reapplies the identity label from the current {@link __composeIdentity}
     * text and placement: hides it when the placement is `'none'` or the text is
     * empty, otherwise shows the text and orders it above or below the canvas via
     * the flexbox `order`. Called on attach and whenever the identity text or
     * placement changes.
     */
    protected __updateIdentity(): void {
        const el = this.__identityEl;
        if (!el) {
            return;
        }
        /*
         * Three states, not two. The band's PRESENCE follows the
         * author's `SubstrateIdentityPosition`; only its CONTENT follows the data.
         *
         * `'none'` is the one case that collapses it, and that is deliberate: it is
         * the author saying they do not want the line, which is configuration. The
         * attribute is `bindable`, so an author may flip it at runtime and the
         * substrate will resize - that is as legitimate as resizing the control,
         * and it is categorically different from a resize caused by data arriving.
         */
        if (this.__identityPosition === 'none') {
            el.style.display = 'none';
            el.textContent = '';
            return;
        }
        // Reserved whether or not there is anything to put in it. An empty band is
        // one line of nothing; a full one is one line of text. Same height.
        el.style.display = 'block';
        el.textContent = this.__composeIdentity();
        el.style.order = this.__identityPosition === 'above' ? '-1' : '1';
    }

    // ---------------------------------------------------------------
    //  Selection state (shell)
    // ---------------------------------------------------------------

    /**
     * Records the selection mode (`'single'` / `'multi'`) and, on a real change,
     * drops the base-owned selection STATE - the two modes' invariants differ, so a
     * stale multi-selection must not linger into single mode. Only the base state
     * is reset here; the concrete's read-only outputs are cleared by the concrete's
     * own `SelectionMode` setter, and rendering is left to that caller.
     * @param mode The new selection mode.
     */
    protected __setSelectionMode(mode: 'single' | 'multi' | 'none'): void {
        if (this.__selectionMode === mode) {
            return;
        }
        this.__selectionMode = mode;
        this.__clearSelectionState();
    }

    /**
     * Clears ALL base-owned selection state: the full sets {@link __selection} and
     * {@link __selectedCells}, and the last-interacted element
     * {@link __lastInteracted}. Used by {@link __setSelectionMode},
     * {@link __updateGrid} and a `'multi'` empty-space click. Touches neither the concrete's outputs
     * (the concrete owns those) nor the canvas (the caller renders).
     */
    protected __clearSelectionState(): void {
        this.__selection = [];
        this.__selectedCells = new Set();
        this.__lastInteracted = null;
    }

    // ---------------------------------------------------------------
    //  Scene API (protected seam for subclasses)
    //  The concrete control calls these once it has items / an outline / labels
    //  / a grid to push.
    // ---------------------------------------------------------------

    /**
     * Stores the substrate outline model for the next render. `null` means no
     * outline is bound: the map falls back to the grid's extent or a default
     * substrate ({@link fitBBox}) and draws no body.
     * @param outline The built outline model, or `null`.
     */
    protected __updateOutline(outline: OutlineModel | null): void {
        this.__sceneOutline = outline;
    }

    /**
     * Stores the render-ready items for the next render. `null` is normalized to
     * an empty list.
     * @param items The render-ready items, or `null`.
     */
    protected __updateItems(items: ItemModel[] | null): void {
        this.__sceneItems = items ?? [];
    }

    /**
     * Records whether the scene just pushed is the DEMO rather than real data.
     *
     * The base cannot tell one from the other: both are `ItemModel`s through the
     * same builder, which is the point of authoring the demo as a schema
     * `ItemList`. So the concrete says, on every scene sync, and
     * {@link readEmptyState} and the demo marking both read it.
     * @param isDemo Whether these items are the demo.
     */
    protected __updateSceneIsDemo(isDemo: boolean): void {
        this.__sceneIsDemo = isDemo;
    }

    /**
     * Stores the effective-status resolver the engine calls to color items.
     * `null` colors every item with the unknown fallback.
     * @param resolve Resolver from an item model to its effective status, or `null`.
     */
    protected __updateStatusResolver(resolve: ((item: ItemModel) => ItemStatus | null) | null): void {
        this.__sceneResolve = resolve;
    }

    /**
     * Stores the status -> CSS color mapping the engine resolves at draw time.
     * @param mapping Status -> color map, or `null` to use the theme fallback.
     */
    protected __updateColorMapping(mapping: Record<string, string> | null): void {
        this.__sceneMapping = mapping;
    }

    /**
     * Stores the render-ready labels and their visibility for the next render.
     * The visibility rides in here (rather than a separate setter) so the concrete
     * pushes labels and its `ShowLabels` state through one call. `null` labels are
     * normalized to an empty list.
     * @param labels     The render-ready labels, or `null`.
     * @param showLabels Whether labels are drawn.
     */
    protected __updateLabels(labels: LabelModel[] | null, showLabels: boolean): void {
        this.__sceneLabels = labels ?? [];
        this.__sceneShowLabels = showLabels;
    }

    /**
     * Pushes the cell grid to draw and hit-test, or `null` for none, and re-renders
     * when it actually changed.
     *
     * Unlike the store-only scene setters this one RENDERS, because it is also the
     * only place that can bump the layer cache's data version - leaving the render
     * to the concrete would let a caller push a new lattice and blit the old
     * bitmap. A push of the identical model object is a no-op, so an idle
     * re-sync costs nothing.
     *
     * IT ALSO CLEARS THE CELL SELECTION, which {@link __updateItems} deliberately
     * does not do for items: an item selection is held by OBJECT IDENTITY, so a new
     * scene simply contains none of the old models, whereas a cell selection is held
     * by row-major INDEX, and index 5 exists in the new lattice too - keeping it
     * would silently re-target the selection at a different cell. Like
     * {@link __setSelectionMode}, only the BASE state is reset here; the concrete
     * clears its own read-only outputs when it swaps the grid.
     * @param grid The render-ready grid model, or `null`.
     */
    protected __updateGrid(grid: GridModel | null): void {
        if (this.__sceneGrid === grid) {
            return;
        }
        this.__sceneGrid = grid;
        this.__sceneGridVersion++;
        this.__selectedCells = new Set();
        if (this.__lastInteracted && this.__lastInteracted.kind === 'cell') {
            this.__lastInteracted = null;
        }
        this.__requestRender();
    }

    /**
     * Stores whether the origin marker is drawn for the next render. Store-only,
     * like the other scene setters; the concrete requests the render. The default
     * (`false`) matches the concrete's `ShowOriginMarker` default, so a scene left
     * at the default draws no marker even without an explicit first push.
     * @param show Whether to draw the origin marker.
     */
    protected __updateShowOriginMarker(show: boolean): void {
        this.__sceneShowOriginMarker = show;
    }

    /**
     * Stores the RESOLVED data-frame placement for the next render: the anchor on
     * the fit box, the offset in millimeters (already along the S axes, +y up), the
     * data-axes rotation in radians (CCW-positive in S) and the Y-axis direction.
     * The concrete converts its Origin attributes (metric prefix -> millimeters,
     * degrees -> radians, enum validation) before calling this, so the engine's
     * D2S ({@link makeDataMatrix}, built in {@link __computeMatrices}) is fed
     * numbers only and never touches attribute state. Like the other scene setters
     * this only stores; the concrete requests the render.
     * @param location    Anchor of the data origin on the fit box.
     * @param offsetXmm   Data-origin X offset along S +x, in millimeters.
     * @param offsetYmm   Data-origin Y offset along S +y, in millimeters.
     * @param rotationRad Data-axes rotation about the origin, radians, CCW-positive in S.
     * @param ydir        Data Y-axis direction (`'down'` mirrors the D y axis).
     */
    protected __updatePlacement(
        location: OriginAnchor,
        offsetXmm: number,
        offsetYmm: number,
        rotationRad: number,
        ydir: YAxisDirection,
    ): void {
        this.__placementLocation = location;
        this.__placementOffsetXmm = offsetXmm;
        this.__placementOffsetYmm = offsetYmm;
        this.__placementRotationRad = rotationRad;
        this.__placementYDir = ydir;
    }

    /**
     * Stores the RESOLVED view rotation (radians, CCW-positive on screen) for the
     * next render. The concrete owns the `MapRotation` attribute and converts
     * degrees to radians before calling this, so the engine's `W`
     * ({@link makeWorldMatrix}, built in {@link __computeMatrices}) is fed a number
     * only and never touches attribute state - the same discipline as
     * {@link __updatePlacement}. Store-only, like the other scene setters; the
     * concrete requests the render. VIEW rotates the WHOLE construct - outline,
     * items, labels and origin marker - about the substrate frame origin, and is
     * display-only: it does not move Item coordinates or change the hit result (the
     * hit path reuses this same `W`).
     * @param rad View rotation in radians, CCW-positive on screen (0 = unrotated).
     */
    protected __updateViewRotation(rad: number): void {
        this.__viewRotationRad = rad;
    }

    // ---------------------------------------------------------------
    //  Theme reading / render config
    // ---------------------------------------------------------------

    /**
     * Reads the resolved {@link SubstrateMapColors} from the control's computed
     * style, falling back to hard-coded defaults when a CSS custom property is
     * unset. The label font is composed into a canvas shorthand; an unset /
     * `inherit` family resolves to the computed font family (canvas `font` does
     * not accept `inherit`). This is the resolved parameter object the engine
     * consumes: reading the theme is the SHELL's job, and the engine only ever sees
     * resolved strings.
     * @returns The resolved colors and label font.
     */
    protected __readColors(): SubstrateMapColors {
        /*
         * BEFORE THE ELEMENT EXISTS, an empty style, which makes every `read` below
         * take its documented fallback. A scene sync can run during `__attach`
         * before the element is in the DOM - the muted palette wants colors at
         * SCENE time rather than at render time.
         *
         * An empty stub rather than a second table of defaults: one table cannot
         * drift from itself, and a control that refused to attach because a
         * stylesheet was not ready would be worse in every case. The next render
         * after attach reads the real values.
         */
        const el = this.__element as unknown as { 0?: Element } | undefined;
        const cs = el !== undefined && el[0] !== undefined
            ? window.getComputedStyle(el[0])
            : ({ getPropertyValue: () => '', fontFamily: '' } as unknown as CSSStyleDeclaration);
        const read = (name: string, fallback: string): string => {
            const value = cs.getPropertyValue(name).trim();
            return value !== '' ? value : fallback;
        };

        let family = read('--substratemap-label-font-family', '');
        if (family === '' || family === 'inherit') {
            family = cs.fontFamily || 'sans-serif';
        }
        let size = read('--substratemap-label-font-size', '14px');
        if (/^[0-9.]+$/.test(size)) {
            size += 'px';
        }
        const weight = read('--substratemap-label-font-weight', '600');

        return {
            bg: read('--substratemap-background', ''),
            body: read('--substratemap-body-color', 'rgb(220, 220, 220)'),
            edge: read('--substratemap-edge-color', 'rgb(110, 110, 110)'),
            selection: read('--substratemap-selection-color', 'rgb(0, 90, 200)'),
            unknown: read('--substratemap-status-unknown', 'rgb(110, 110, 110)'),
            // Bin defaults for the conventional `pass` / `fail` qualities. The
            // fallbacks are the Okabe-Ito bluish-green / vermillion pair rather than
            // pure green/red: they read as pass/fail to a normally-sighted user AND
            // stay distinguishable under deuteranopia and protanopia, which a
            // green/red pair does not - and a die map is a field where the whole
            // point is telling good from bad at a glance.
            binPass: read('--substratemap-bin-pass', 'rgb(0, 158, 115)'),
            binFail: read('--substratemap-bin-fail', 'rgb(213, 94, 0)'),
            /*
             * Decoration marks for composed overlays, one color per layer.
             *
             * A FOUR-COLOR PALETTE, not a bin palette. A decoration says "this
             * cell is named by that overlay too"; it never restates the other
             * overlay's bin as a fill, because blending two bin colors yields a
             * color that maps back to no bin code at all (see
             * ws/notes/DECISION-overlay-composition.md). So these are about
             * LAYERS, and the layer's corner position - not its color - is what
             * primarily distinguishes it, which is why four is enough.
             *
             * Okabe-Ito hues, chosen for the same reason --substratemap-bin-pass
             * and -fail were: the set stays distinguishable under deuteranopia
             * and protanopia. Each has the hard-coded fallback every other
             * variable here has, so a missing theme degrades to a working
             * default rather than to `transparent`.
             */
            decoration: [
                // VERMILLION FIRST, deliberately. The first version led with
                // Okabe-Ito blue (0, 114, 178), which sits right next to the
                // origin marker's rgb(0, 90, 200) - in a live view the marks
                // read as part of the marker rather than as data. The blue is
                // kept but fourth, by which point a map already carries three
                // other decorations and the marker is not what it could be
                // confused with.
                read('--substratemap-decoration-1', 'rgb(213, 94, 0)'),
                read('--substratemap-decoration-2', 'rgb(204, 121, 167)'),
                read('--substratemap-decoration-3', 'rgb(240, 228, 66)'),
                read('--substratemap-decoration-4', 'rgb(0, 114, 178)'),
            ],
            labelFont: weight + ' ' + size + ' ' + family,
            labelColor: read('--substratemap-label-font-color', cs.color || 'rgb(40, 40, 40)'),
        };
    }

    /**
     * Builds the drawing config from the canvas' current client size.
     * @returns A {@link MapConfig}, or `null` if the canvas is missing or has
     *          zero size.
     */
    protected __makeConfig(): MapConfig | null {
        if (!this.__canvas) {
            return null;
        }
        const w = this.__canvas.clientWidth;
        const h = this.__canvas.clientHeight;
        if (w <= 0 || h <= 0) {
            return null;
        }
        return makeConfig(w, h);
    }

    /**
     * Builds the transform chain for the CURRENT scene and canvas config: the
     * uniform letterbox scale over the fit box, the world matrix `W` and the
     * data->substrate matrix `D2S`. Deterministic over `(cfg, dpr, scene)`, so
     * {@link __render} (draw) and {@link __handlePointerUp} (hit-test) both obtain
     * it here - the hit-test invariant that the hit CTM equals the draw CTM minus
     * the dpr base then reduces to "both went through this one builder", with no
     * chance of the two chains drifting once the MapRotation seam is filled: the
     * view rotation enters `W` only, so the hit path picks it up for free.
     * Only `dprBase` depends on `dpr`; the geometry of `W`/`D2S` does not. `D2S`
     * carries the resolved Origin placement (anchor/offset/rotation/y-direction)
     * from {@link __updatePlacement}; `W` carries the resolved view rotation
     * ({@link __viewRotationRad}, from {@link __updateViewRotation}) as VIEW, and
     * the fit is taken over the {@link rotatedExtent} of the fit box so that
     * rotation never clips (at rotation 0 that extent is the box's own size, so the
     * unrotated fit is unchanged).
     * @param cfg The drawing configuration.
     * @param dpr The device pixel ratio (carried only in the `dprBase` field).
     * @returns The resolved transform chain and scalars.
     */
    /**
     * Reports the aggregation factor of the frame just drawn.
     *
     * A no-op here: the base owns the canvas, the matrices and the render loop, and
     * knows nothing about E142 attributes. The derived control overrides this to
     * publish `AggregationFactor` and `AggregationMode`.
     * @param factor Cells per device pixel by AREA, or `null` when no grid is bound.
     * @returns Nothing.
     */
    /**
     * The group under a pointer, or `null` when grouping is not active.
     *
     * Grouping engages only when a die is smaller than the touch target — one cell
     * per group means there is nothing to group, and the ordinary cell path runs.
     * @param p        The pointer, in CSS pixels.
     * @param matrices The frame's matrices.
     * @param dpr      Device pixels per CSS pixel.
     * @returns The descriptor, or `null`.
     */
    protected __groupSelectionAt(
        p: Point, matrices: MapMatrices, dpr: number,
    ): SubstrateMapGroupSelection | null {
        const grid = this.__sceneGrid;
        if (grid === null || !matrices.fitBox || matrices.scale <= 0) { return null; }
        const dev = deviceMatrix(matrices.dprBase, matrices.world);
        const pl = grid.placement;
        // The DRAWN extent, matching `renderGridLayer`'s own strategy test — the
        // question is whether a die is too small to tap, which is about what is on
        // screen rather than about the pitch.
        const cellDevicePx = Math.min(pl.cellWmm, pl.cellLmm) * Math.hypot(dev.a, dev.b);
        const n = groupSizeInCells(this.__sceneTouchTargetCssPx, cellDevicePx, dpr);
        if (n <= 1) { return null; }

        const tile = groupTileAt(p.x * dpr, p.y * dpr, this.__groupTiling(matrices, dpr));
        if (tile === null) { return null; }
        return describeGroup(tile.rect, grid, dev,
            this.__sceneBinSeverityPriority, this.__sceneBinQualityAliases, tile.id);
    }

    /**
     * Raises the concrete group-selection event.
     *
     * A no-op here for the same reason `__publishAggregation` is: the base owns the
     * pointer and the matrices and knows nothing about this control's events.
     * @param group The descriptor.
     * @returns Nothing.
     */
    protected __raiseGroupSelected(group: SubstrateMapGroupSelection): void {
        void group;
    }

    /**
     * The group tile's side in DEVICE pixels.
     *
     * `TouchTargetSize` is CSS pixels and the tile grid lives in device pixels, so
     * the ratio is applied once, here.
     * @param dpr Device pixels per CSS pixel.
     * @returns The side in device px.
     */
    protected __groupTileDevicePx(dpr: number): number {
        return this.__sceneTouchTargetCssPx * (dpr > 0 ? dpr : 1);
    }

    /**
     * Where the map actually is, in the coordinate space `scale` is expressed in.
     *
     * The fit box's four corners through the matrix, as an axis-aligned bounding
     * box - under rotation the image is a parallelogram and this is the smallest
     * upright rectangle containing it.
     *
     * ONE FUNCTION, TWO CALLERS: `__groupTiling` and the tile's stale border. A
     * border framing the CANVAS instead would sit 82 px away from the wafer it
     * marks on a 300 x 150 tile, and two callers computing one rectangle twice is
     * how they come to disagree.
     * @param matrices The frame's matrices.
     * @param dprBase  `matrices.dprBase` for device space, or 1 for CSS space.
     * @returns The rectangle, or `null` when there is nothing placed.
     */
    protected __mapRect(matrices: MapMatrices, dprBase: number): DeviceRect | null {
        const box = matrices.fitBox;
        if (!box || matrices.scale <= 0) { return null; }
        const dev = deviceMatrix(dprBase, matrices.world);
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const [mx, my] of [
            [box.minX, box.minY], [box.maxX, box.minY],
            [box.minX, box.maxY], [box.maxX, box.maxY],
        ] as ReadonlyArray<readonly [number, number]>) {
            const x = dev.a * mx + dev.c * my + dev.e;
            const y = dev.b * mx + dev.d * my + dev.f;
            if (x < minX) { minX = x; }
            if (x > maxX) { maxX = x; }
            if (y < minY) { minY = y; }
            if (y > maxY) { maxY = y; }
        }
        if (!Number.isFinite(minX) || !Number.isFinite(minY)) { return null; }
        return { x0: minX, y0: minY, x1: maxX, y1: maxY };
    }

    /**
     * The group tiling for this frame: the map's own device-space box, divided.
     *
     * ONE DERIVATION, THREE CALLERS. The hit path, the member lookup
     * behind `readGroupMembers`, and the selection ring all have to agree, and the
     * only way an id round-trips is if all three build the SAME tiling. Deriving it
     * here rather than at each call site is what makes that structural instead of
     * three places remembering to match.
     *
     * The region is the fit box's image in device space, taken as an axis-aligned
     * bounding box: under rotation the image is a parallelogram, and the tiling is
     * axis-aligned in device space because a touch target is. Anchoring to the map
     * rather than to device zero is the whole of the fix - it is what stops the
     * tiles depending on where the map happens to sit.
     * @param matrices The frame's matrices.
     * @param dpr      Device pixels per CSS pixel.
     * @returns The tiling, or `null` when there is nothing to tile.
     */

    protected __groupTiling(matrices: MapMatrices, dpr: number): GroupTiling | null {
        const rect = this.__mapRect(matrices, matrices.dprBase);
        if (rect === null) { return null; }
        return groupTiling(rect, this.__groupTileDevicePx(dpr));
    }

    protected __publishAggregation(factor: number | null, reducer: GridReducer | null): void {
        void factor;
        void reducer;
    }

    /**
     * Reports the fit scale of the frame just drawn.
     *
     * A no-op here for the same reason {@link __publishAggregation} is.
     * @param scale CSS px per millimeter, or `null` when nothing was drawn.
     * @returns Nothing.
     */
    protected __publishMapScale(scale: number | null): void {
        void scale;
    }

    protected __computeMatrices(cfg: MapConfig, dpr: number): MapMatrices {
        const fitBox = fitBBox(this.__sceneOutline, this.__sceneItems, this.__sceneGrid);
        const rot = this.__viewRotationRad;
        // Fit the VIEW-rotated box, not the upright one, so a non-zero MapRotation
        // cannot push the turned construct past the margin: rotatedExtent turns the
        // fit box by the same view rotation W applies (conservative - see its doc).
        // At rotation 0 it returns the box's own width/height, so the unrotated fit
        // is identical to before this seam was filled.
        const ext = fitBox ? rotatedExtent(fitBox, rot) : null;
        const scale = ext ? computeScale(cfg, ext.w, ext.h) : 0;
        return {
            dprBase: dpr,
            /*
             * W = T(center) Sc(s,-s) R(mapRotation) V, where V is the author's
             * transform or identity.
             *
             * POST-multiplied, so V acts in the SUBSTRATE frame: its translation is
             * in millimeters and its scaling is anchored where the S-frame origin
             * lands, which is the canvas center. Pre-multiplication would put the
             * translation in CSS pixels and anchor at the canvas top-left — measured
             * both ways before choosing. The center anchor is worth more
             * than pixel units, because an author can convert units with `MapScale`
             * and cannot conjure an anchor.
             *
             * Composing HERE rather than at draw time is what makes everything
             * downstream track it for free: the hit test inverts this same matrix,
             * `aggregationFactor` reads it, and the layer cache key already carries
             * its six components.
             */
            world: this.__sceneViewTransform === null
                ? makeWorldMatrix(cfg, scale, rot)
                : makeWorldMatrix(cfg, scale, rot).multiply(this.__sceneViewTransform),
            // D2S from the resolved Origin placement; anchored on the SAME fit box
            // the scale/W use (outline BBOX_S, else the grid's extent, else the default).
            data: makeDataMatrix(
                fitBox,
                this.__placementLocation,
                this.__placementOffsetXmm,
                this.__placementOffsetYmm,
                this.__placementRotationRad,
                this.__placementYDir,
            ),
            scale,
            fitBox,
        };
    }

    // ---------------------------------------------------------------
    //  Rendering / pointer
    // ---------------------------------------------------------------

    /**
     * Requests a render, coalescing multiple requests within one animation frame
     * into a single paint. This replaces the spike's synchronous render behind
     * the unchanged protected API, so subclasses are coded against the final
     * surface.
     */
    protected __requestRender(): void {
        /*
         * COUNTED, because the staleness heartbeat is otherwise unobservable from
         * a test: it wakes, asks for a frame, and the frame may be coalesced away.
         * What the assertion needs to know is that something ASKED while nothing
         * else was happening.
         */
        this.__renderRequests++;
        if (this.__rafHandle !== null) {
            return;
        }
        this.__rafHandle = window.requestAnimationFrame(() => {
            this.__rafHandle = null;
            this.__render();
        });
    }

    /**
     * Renders the control. Sizes the canvas bitmap to the device pixel ratio for
     * crisp output, reads the theme colors, resolves the fit box and the transform
     * chain from the current scene and delegates the drawing to the engine's
     * {@link drawSubstrateMap}. The stored scene is whatever the concrete last
     * pushed through the scene API; this method holds no knowledge of the concrete
     * data model, attributes, events or the real/demo choice.
     *
     * The fit box is the outline bbox when an outline is bound, else the combined
     * bbox of the items and the grid, else `null`; a `null` fit box (or a degenerate
     * scale) still clears the canvas but draws nothing further. The data matrix from
     * {@link makeDataMatrix} carries the resolved Origin placement, and `W` the
     * resolved view rotation (both built by {@link __computeMatrices}).
     */
    protected __render(): void {
        const canvas = this.__canvas;
        const ctx = this.__canvasContext;
        if (!canvas || !ctx) {
            return;
        }
        const cfg = this.__makeConfig();
        if (!cfg) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const bitmapWidth = Math.max(1, Math.round(cfg.width * dpr));
        const bitmapHeight = Math.max(1, Math.round(cfg.height * dpr));
        // Only the bitmap resolution is set here; the CSS layout size is driven by
        // flexbox, so this does not feed back into the ResizeObserver.
        if (canvas.width !== bitmapWidth || canvas.height !== bitmapHeight) {
            canvas.width = bitmapWidth;
            canvas.height = bitmapHeight;
        }

        const colors = this.__readColors();

        // Transform chain for the current scene, from the shared builder the hit
        // path also uses. A `null` fit box / zero scale still clears the canvas but
        // draws nothing further (drawSubstrateMap guards on it).
        const matrices = this.__computeMatrices(cfg, dpr);

        // The grid layer bundles the model with the live cell selection, the cache
        // data version and the control-owned cache. Rebuilt per frame (one small
        // object; nothing per cell) so the engine stays a pure function of what it
        // is handed.
        const gridModel = this.__sceneGrid;
        const grid: GridLayer | null = gridModel
            ? {
                model: gridModel,
                selected: this.__selectedCells.size > 0 ? this.__selectedCells : null,
                dataVersion: this.__sceneGridVersion,
                cache: this.__gridCache,
                // Assembled by the CONCRETE, which owns the filter surface. The base
                // and the engine both stay ignorant of what a filter looks like, and
                // the key still changes when one does.
                filterKey: this.__filterKey(),
                // Also assembled by the CONCRETE. The key above told the
                // cache that a filter changed; this is what actually runs one, and
                // for five tasks the second half did not exist.
                spatialFilter: this.__spatialFilterRequest(),
            }
            : null;

        const measured = drawSubstrateMap(
            ctx,
            cfg,
            this.__sceneOutline,
            grid,
            this.__sceneItems,
            colors,
            this.__sceneResolve ?? ((): ItemStatus | null => null),
            this.__sceneMapping,
            this.__selection,
            this.__sceneLabels,
            this.__sceneShowLabels,
            this.__sceneShowOriginMarker,
            matrices,
            this.__sceneBinQualityAliases,
            this.__sceneValueFill,
            gridModel === null ? null : {
                // Built per frame, over the BIN TABLE — a few entries where the map
                // has millions of cells — and only when there is a grid to paint.
                paint: buildAggregatePaint(gridModel, colors,
                    this.__sceneBinSeverityPriority, this.__sceneBinQualityAliases,
                    this.__sceneAggregationGamma),
                reducer: this.__sceneReducer,
                priority: this.__sceneBinSeverityPriority,
                gamma: this.__sceneAggregationGamma,
            },
            this.__sceneCategorical,
            this.__sceneHighlight,
        );

        /*
         * FED FORWARD. The frame just drawn measured its own saturation for
         * free — the reducer that ran had already accumulated the predicate — and
         * that selects the reducer for the NEXT frame. `null` means nothing
         * bucketed, and the previous choice stands, which is right: nothing
         * re-rendered, so nothing changed.
         */
        /*
         * A value field forces the reducer rather than choosing one: `MaxSeverity`
         * and `FailFraction` both ask about bin quality, and a relevance map has
         * none. Set BEFORE `selectReducer`, which then keeps it — and
         * released the moment the fill goes away, so the measurement resumes.
         */
        if (this.__sceneValueFill !== null) { this.__sceneReducer = 'ValueField'; }
        else if (this.__sceneReducer === 'ValueField') { this.__sceneReducer = 'MaxSeverity'; }
        this.__sceneReducer = selectReducer(this.__sceneReducer, measured, this.__reducerOverride);
        this.__lastSaturation = measured;

        // AFTER the draw, so what is published describes the frame that was just
        // painted rather than the one about to be. Called on every frame — a resize
        // reaches here through the ResizeObserver without anything re-parsing —
        // and the derived control drops the call when nothing changed.
        // The FIT scale, deliberately excluding the author's own transform: an
        // author converting a pointer delta into millimeters would otherwise need
        // the answer they are computing.
        /*
         * The empty state, AFTER the draw. `drawSubstrateMap` clears the canvas and
         * paints the background, so calling it first keeps the clear and the
         * background identical to every other frame; the image goes on top of an
         * area that is by definition otherwise empty.
         */
        if (this.readEmptyState() === 'nodata') {
            this.__drawNoData(ctx, cfg.width, cfg.height);
        }

        /*
         * THE DEMO MARKING, last, over everything. In the same frame as the
         * content it marks and from the same flag that put the content there, so
         * there is no path that draws one without the other - a property of this
         * being one statement rather than a pair to keep in step.
         */
        if (this.__sceneIsDemo) {
            this.__drawDemoMarking(ctx, cfg.width, cfg.height, colors);
        }

        /*
         * THE CONCRETE'S OVERLAY, after the marking and before the publishes.
         *
         * For the tile's yield readout. After the marking because
         * a demo tile's yield is demo yield and must not sit on top of the thing
         * saying so; before the publishes because those describe the frame and the
         * frame is not finished until this has run.
         *
         * Empty here. A base that drew a concrete's decoration would be guessing
         * what the concrete wants, and every control that wanted none would pay
         * for it.
         */
        /*
         * THE OVERLAY DRAWS IN CSS PIXELS, AND THIS IS WHAT MAKES THAT TRUE.
         *
         * `__drawOverlay` is documented to receive CSS-pixel width and height, and
         * every implementation uses them that way - the tile's age text sits at
         * `width - pad`, its stale border frames `__mapRect(matrices, 1)`. But
         * `drawSubstrateMap` does not restore the dpr base before it returns: it
         * sets a lattice or an identity transform along the way and leaves whichever
         * was last. On a display with `devicePixelRatio` 1 those are the same matrix
         * and nothing shows. On a 3.125 display the whole overlay is drawn at
         * **1/3.125 of its intended size, anchored at the origin** - which is the
         * stale border appearing as a small box near the top-left corner, and the
         * age text with it.
         *
         * Reported twice from live views. An earlier fix moved the border from the canvas to
         * the map and both were wrong by the same factor, so the change looked like
         * a fix and was not - and no test could see it, because the harness renders
         * only at ratio 1, where CSS and device pixels coincide.
         */
        ctx.setTransform(matrices.dprBase, 0, 0, matrices.dprBase, 0, 0);
        this.__drawOverlay(ctx, cfg.width, cfg.height, colors, matrices);

        this.__publishMapScale(matrices.scale > 0 ? matrices.scale : null);
        this.__publishAggregation(
            gridModel === null ? null
                : aggregationFactor(deviceMatrix(matrices.dprBase, matrices.world), gridModel.placement),
            measured === null ? null : this.__sceneReducer);
    }

    /**
     * Handles a `pointerup` on the canvas: rebuilds the CURRENT transform chain
     * (via {@link __computeMatrices}, so the hit CTM matches the paint), hit-tests
     * the CSS-pixel pointer against the active items with {@link getItemAtPos} and
     * - only if no item was hit - against the cell grid with {@link getCellAtPos},
     * mutates the selection per {@link __selectionMode}, and - only when something
     * changed - builds the {@link SelectedPayload}, hands it to the concrete's
     * {@link __raiseSelected} hook and re-renders so every selected item is marked.
     *
     * Mode semantics: `'single'` - a hit REPLACES the selection, a miss changes
     * nothing (and raises no event); `'multi'` - a hit TOGGLES the item's
     * membership, a click on empty space CLEARS. A shift+drag rubber band is not
     * implemented - it needs the engine's rect query - and nothing here stubs it.
     *
     * Payload: the single-value fields describe the last interacted item, its status
     * resolved through the pushed resolver so it honors the assignment overrides
     * (matching the painted color); the `selection` array is the full set as typed
     * `{ kind, itemId }` entries. Id-less items are marked with a ring but carry no
     * addressable id, so they are omitted from that array. `kind` is `'item'` or
     * `'cell'`: an item hit wins, and a grid cell is tested only when no item was hit.
     * @param ev The pointer event.
     */
    protected __handlePointerUp(ev: PointerEvent): void {
        const canvas = this.__canvas;
        const ctx = this.__canvasContext;
        if (!canvas || !ctx) {
            return;
        }
        const cfg = this.__makeConfig();
        if (!cfg) {
            return;
        }
        const dpr = window.devicePixelRatio || 1;
        const matrices = this.__computeMatrices(cfg, dpr);
        // Nothing fitted / degenerate scale => nothing painted => nothing hittable.
        if (!matrices.fitBox || matrices.scale <= 0) {
            return;
        }

        // Canvas rect -> CSS-pixel pointer (the space getItemAtPos tests in). The
        // SAME `matrices` (built by the shared builder) drives draw and hit, so the
        // hit region coincides with the painted pixels.
        const rect = canvas.getBoundingClientRect();
        const p: Point = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };

        /*
         * A RELEASE IS ONLY A CLICK IF IT DID NOT TRAVEL.
         *
         * Only `pointerup` was bound, so the control could not tell a tap from the
         * end of a drag: press on one die, release over another, and the second was
         * selected. Any pan or gesture ending over the map selected whatever lay
         * under the release point.
         *
         * The press is consumed either way - a drag must not leave its origin
         * behind for the NEXT release to measure against - and a release with no
         * recorded press still selects, because `pointerdown` may have landed
         * outside the canvas or before the listener was attached, and refusing
         * those would lose real clicks to protect against a drag that never began.
         */
        const press = this.__pressAt;
        this.__pressAt = null;
        if (press !== null && press.id === ev.pointerId
            && Math.hypot(p.x - press.x, p.y - press.y)
                > (this.constructor as typeof SubstrateMapBase).DRAG_SLOP_PX) {
            return;
        }
        /*
         * A CONTROL THAT DOES NOT SELECT DOES NOT HIT-TEST.
         *
         * Placed before the hit test rather than before the render, because the
         * problem was never only the ring. The base computed a group, filled
         * `__selectedCells` with its members and raised - and the tile overrode the
         * raise to `void payload`, so the work was done, the pixels were drawn, and
         * nobody was told. Suppressing the drawing alone would leave a control
         * quietly maintaining a selection it never reports.
         *
         * The tile's own click still means something: `__tileClick` raises
         * `onSubstrateSelected` for the whole tile. That is ONE reading of the
         * gesture; the base's per-die selection was a second, and two readings of one
         * click is one too many.
         */
        if (this.__selectionMode === 'none') { return; }
        const hit = getItemAtPos(p, this.__sceneItems, matrices, ctx);
        // ITEM WINS: an item is drawn ON TOP of the grid, so the topmost thing under
        // the pointer is what gets selected - the same rule that makes the topmost
        // item win among items. Short-circuited, so an item hit never pays for the
        // cell test.
        /*
         * GROUPING WINS OVER THE CELL TEST, and only over the cell test.
         *
         * An item is drawn on top of the grid and still wins outright — grouping is
         * about dies being too small to tap individually, and an item is not a die.
         * So this sits BETWEEN the two, and when grouping is inactive the cell path
         * below is byte-for-byte what it was.
         */
        if (!hit && this.__sceneGrid !== null) {
            const group = this.__groupSelectionAt(p, matrices, dpr);
            if (group !== null) {
                /*
                 * A SELECTED GROUP MUST BE VISIBLE. Raising the event and drawing
                 * nothing is what made the selection ring disappear: every panel on
                 * the reference page groups at the default target, so a tap
                 * produced an event nobody could see and no mark on the map
                 *.
                 *
                 * The group's member cells go into the ordinary cell selection, so
                 * `drawCellSelection` rings them with the same 2 px stroke a single
                 * die gets. One selection concept, one appearance.
                 */
                this.__selectedCells = new Set(
                    cellsInGroup(groupTileRect(group.id, this.__groupTiling(matrices, dpr)) ?? {
                        x0: 0, y0: 0, x1: 0, y1: 0,
                    }, this.__sceneGrid, deviceMatrix(matrices.dprBase, matrices.world)),
                );
                this.__raiseGroupSelected(group);
                this.__requestRender();
                return;
            }
        }
        const cellHit = hit ? null : getCellAtPos(p, matrices, this.__sceneGrid);

        // Selection mutation per mode, IDENTICAL for both kinds: 'single' replaces,
        // 'multi' toggles, a miss on empty space clears in 'multi' only. The early
        // returns gate the raise + render so an inert click (single miss, or an empty
        // click when already empty) does nothing.
        if (hit) {
            if (this.__selectionMode === 'single') {
                this.__selection = [hit];   // replace (a re-click re-fires)
                this.__selectedCells = new Set();   // 'single' replaces the WHOLE selection
            } else {
                const idx = this.__selection.indexOf(hit);   // identity membership
                this.__selection = idx >= 0
                    ? this.__selection.slice(0, idx).concat(this.__selection.slice(idx + 1))
                    : this.__selection.concat([hit]);
            }
            this.__lastInteracted = { kind: 'item', item: hit };   // also on a toggle-off
        } else if (cellHit) {
            if (this.__selectionMode === 'single') {
                this.__selection = [];
                this.__selectedCells = new Set([cellHit.index]);
            } else if (this.__selectedCells.has(cellHit.index)) {
                this.__selectedCells.delete(cellHit.index);
            } else {
                this.__selectedCells.add(cellHit.index);
            }
            this.__lastInteracted = { kind: 'cell', cell: cellHit };
        } else if (this.__selectionMode === 'single') {
            return;                         // a miss changes nothing
        } else if (this.__selection.length === 0 && this.__selectedCells.size === 0 && this.__lastInteracted === null) {
            return;                         // multi: empty click while already empty is inert
        } else {
            this.__clearSelectionState();   // multi: empty click clears
        }

        // Full set as typed entries, items then cells (see SelectedPayload). Id-less
        // items have no addressable id and are omitted (they are still ring-marked
        // via __selection above); a cell's id is its row-major linear index, which
        // every cell has, so none is ever omitted.
        const selection: Array<{ kind: 'item' | 'cell'; itemId: number }> = [];
        for (const it of this.__selection) {
            if (it.id !== null) {
                selection.push({ kind: 'item', itemId: it.id });
            }
        }
        for (const index of this.__selectedCells) {
            selection.push({ kind: 'cell', itemId: index });
        }

        this.__raiseSelected(this.__composeSelectedPayload(selection));
        this.__requestRender();
    }

    /**
     * Builds the {@link SelectedPayload} for the current
     * {@link __lastInteracted} element and the given full selection.
     *
     * The single-value fields describe the LAST INTERACTED element and are typed by
     * its `kind`; the four cell fields are present for a cell and absent for an item
     * (and for a clear), which is what keeps an item payload free of meaningless
     * cell coordinates. A cell's `status` is its canonical BIN CODE - the status
     * resolver is an item concern and is deliberately not consulted for cells, whose
     * bin already IS their status - and its `userData` and `name` are `null`: a
     * lattice cell carries no name and no user data.
     * @param selection The full current selection as typed entries.
     * @returns The payload to hand to the concrete.
     */
    private __composeSelectedPayload(selection: Array<{ kind: 'item' | 'cell'; itemId: number }>): SelectedPayload {
        const last = this.__lastInteracted;
        if (last && last.kind === 'cell') {
            const grid = this.__sceneGrid;
            // buildGridModel guarantees every cell index addresses binTable, and
            // getCellAtPos only returns cells of THIS grid, so the row exists - but the
            // grid could have been swapped between the hit and here, so it is checked.
            const bin = grid ? grid.binTable[grid.cells[last.cell.index]] : undefined;
            // The one seam where serialization indices could become logical
            // coordinates, if the assumption documented on reportedCellCoords
            // ever turns out to be wrong.
            const coords = reportedCellCoords(last.cell);
            return {
                itemId: last.cell.index,
                status: bin ? bin.code : null,
                name: null,
                userData: null,
                kind: 'cell',
                selection,
                column: coords.column,
                row: coords.row,
                binCode: bin ? bin.code : undefined,
                binQuality: bin ? bin.quality : undefined,
            };
        }
        const item = last ? last.item : null;
        const resolve = this.__sceneResolve;
        return {
            itemId: item ? item.id : null,
            status: item ? (resolve ? resolve(item) : item.status) : null,
            name: item ? item.name : null,
            userData: item ? item.userData : null,
            kind: 'item',
            selection,
        };
    }
}

/*
 * Registration. registerEx expects a concrete constructor; this class is
 * intentionally abstract and is never placed (Description.json visible:false,
 * and the framework only instantiates types that occur in content), so the cast
 * is confined to this single call site.
 * `injectInGlobalObject` mirrors the shipped controls, e.g.
 * dist/TcHmiButton/TcHmiButton.esm.js:
 * `registerEx("TcHmiButton","TcHmi.Controls.Beckhoff",TcHmiButton,{injectInGlobalObject:!0})`.
 */
TcHmi.Controls.registerEx(
    'SubstrateMapBase',
    'TcHmi.Controls.CNM_UIControls.SEMI',
    SubstrateMapBase as unknown as new (
        element: JQuery,
        pcElement: JQuery,
        attrs: TcHmi.Controls.ControlAttributeList
    ) => TcHmi.Controls.System.TcHmiControl,
    { injectInGlobalObject: true }
);

/* ------------------------------------------------------------------------ *
 * Global namespace types (classic consumers). The runtime binding is created
 * by registerEx({ injectInGlobalObject: true }); this block only teaches the
 * classic type system about it, following the compatibility-d.ts pattern of the
 * attached package (Helpers/TcHmiValueBuffer/TcHmiValueBuffer.d.ts).
 * ------------------------------------------------------------------------ */

declare const _SubstrateMapBaseAlias: typeof SubstrateMapBase;
type _SubstrateMapBaseInstance = SubstrateMapBase;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI {
        /** Global alias of the module export {@link SubstrateMapBase}. */
        let SubstrateMapBase: typeof _SubstrateMapBaseAlias;
        /** Instance type of the global alias. */
        type SubstrateMapBase = _SubstrateMapBaseInstance;
    }
}
