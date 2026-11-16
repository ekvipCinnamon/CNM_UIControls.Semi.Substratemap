/**
 * @fileoverview
 * SubstrateMap - the flagship substrate control of the WaferMap package.
 *
 * Renders a single substrate: an outline (from an explicit binding, a built-in
 * outline preset, or demo data) with items and labels overlaid in the data
 * frame and colored by status. The data frame is placed relative to the
 * substrate frame by origin anchor, offset, rotation and y-axis direction, and
 * the whole construct is view-rotated (MapRotation). Clicking an element raises
 * `.onItemSelected` and mirrors the selection into the read-only `Selected*`
 * outputs.
 *
 * Three-layer split (SubstrateMapEngine / SubstrateMapBase / concrete controls):
 *  - SubstrateMapEngine: a framework-free ES module owning the model builders,
 *    the transform chain, the render strategies and the hit-test index; colors
 *    and fonts reach it as a resolved parameter object.
 *  - SubstrateMapBase: the abstract, non-placeable shell owning template root,
 *    identity label, canvas, devicePixelRatio bitmap sizing, ResizeObserver,
 *    theme reading, pointer wiring, one engine instance and the scene API.
 *  - SubstrateMap (this file): a concrete, placeable control that extends the
 *    base only and owns the attributes, their schemas, the events and the demo
 *    data, mapping its data model onto the base's scene API and identity hooks.
 *
 * S1 mechanism (frozen by spike S1): this control is an ES module that imports
 * the base with a .js specifier through the module graph - the pattern
 * dist/TcHmiToggleSwitch imports dist/TcHmiCheckbox in the attached
 * Beckhoff.TwinCAT.HMI.Controls package - so engine->base->control evaluation
 * order and single-evaluation are language guarantees; registerEx is called with
 * { injectInGlobalObject: true } to expose the classic namespace name.
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
import { SubstrateMapBase } from '../SubstrateMapBase/SubstrateMapBase.js';
import { PRESET_KEYS, PREFIXES, normStatus, toMillimeters, itemsToModels, buildStatusMap, labelsToModels, buildOutlineModel, generatePresetOutline, buildGridModel, } from '../../Helpers/SubstrateMapEngine/Engine.js';
import { resolveLayoutSpecifier, dimsFromPayload, computeGridPlacement, fitPlacementToBox, registerPlacementToReferenceDevices, indexToMapCoord, mapCoordToIndex, E142Error, } from '../../Helpers/SubstrateMapEngine/E142.js';
import { parseE142Xml, E142ParseError, gridToE142Xml } from '../../Helpers/SubstrateMapEngine/E142Xml.js';
import { normalizeGridData, E142GridError, gridToGridData } from '../../Helpers/SubstrateMapEngine/E142Grid.js';
import { decodeItemText, E142ItemError } from '../../Helpers/SubstrateMapEngine/E142Item.js';
/** Fallback values for the input attributes (mirror `Description.json` defaultValueInternal). */
const DEFAULTS = {
    substrateId: null,
    identityPosition: 'below',
    showDemoItems: true,
    showLabels: true,
    selectionMode: 'single',
    outlinePreset: 'none',
    secDir: 'cw',
    notchExaggeration: 12,
    originLocation: 'center',
    originOffsetX: 0,
    originOffsetY: 0,
    originOffsetPrefix: 'milli',
    originRotation: 0,
    yAxisDirection: 'up',
    showOriginMarker: false,
    mapRotation: 0,
    e142OrientationOffset: 0,
};
/** Valid values for the substrate identity position attribute. */
const POSITIONS = ['above', 'below', 'none'];
/** Valid values for the selection-mode attribute. */
const SELECTION_MODES = ['single', 'multi'];
/** Valid values for the `OriginLocation` attribute (anchor on the fit box). */
const ORIGIN_LOCATIONS = ['center', 'top-left', 'bottom-left', 'top-right', 'bottom-right'];
/** Valid values for the `YAxisDirection` attribute. */
const Y_AXIS_DIRECTIONS = ['up', 'down'];
/**
 * A tiny, self-contained {@link GridData} document for smoke-testing the E142
 * grid path (task O6 item 10). Exported but NOT auto-bound: bind it to the
 * `GridData` attribute - e.g. from an internal symbol seeded with this value, or
 * `SubstrateMap.setGridData(DEMO_GRID_DATA)` from a code-behind - to render a
 * 4x3 bin grid through the SAME pipeline as a real map. It is layout-full (2 mm
 * pitch), so it renders at PHYSICAL size; bins `1`/`0` map to pass/fail via
 * `binDefinitions`, and `.` is the null cell. The identity fields feed the
 * MapSubstrateId / MapLotId / MapGoodDevices outputs.
 */
export const DEMO_GRID_DATA = {
    dimension: { x: 4, y: 3 },
    units: 'mm',
    stepSize: { x: 2, y: 2 },
    orientation: 0,
    originLocation: 'LowerLeft',
    axisDirection: 'UpRight',
    binType: 'Ascii',
    nullBin: '.',
    mapType: '2DArray',
    binDefinitions: [
        { binCode: '1', binQuality: 'pass', binDescription: 'Pass' },
        { binCode: '0', binQuality: 'fail', binDescription: 'Fail' },
    ],
    bins: ['1101', '1.01', '0110'],
    substrateId: 'DEMO-GRID-01',
    lotId: 'LOT-DEMO',
    goodDevices: 7,
};
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
const DEMO_STATUS_COLORS = {
    BIN_1: '#225F79', // primary azure blue - pass
    BIN_2: '#548299', // secondary dove blue
    BIN_3: '#D6A35F', // primary caramel
    BIN_4: '#103640', // secondary dark blue
    BIN_5: '#AB411F', // accent rust red - reject (kept sparse, ~5 %)
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
const SWEEP_UNIT = [
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
    /** Substrate radius: si-12in dia / 2 (Annex A). Drives the yield-ring thresholds; edgeRadius and the notch keep-out below are hand-derived from it. */
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
};
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
function placeCommand(cmd, s, dx, dy) {
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
        default: {
            const _never = cmd;
            return _never;
        }
    }
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
 * {@link itemsToModels}), matching ComponentMap's demo, which runs its
 * structures through the real `structuresToModels`. No demo label is emitted
 * (optional per spec).
 * @returns The demo bundle: the built outline model (or `null` if degenerate),
 *          the built item models, and the demo status -> color mapping.
 */
function buildDemo() {
    const mapping = { ...DEMO_STATUS_COLORS };
    const halfW = (DEMO_LAYOUT.sweepHeight * SWEEP_ASPECT) / 2;
    const halfH = DEMO_LAYOUT.sweepHeight / 2;
    const nx = Math.floor(DEMO_LAYOUT.edgeRadius / DEMO_LAYOUT.pitchX) + 1;
    const ny = Math.floor(DEMO_LAYOUT.edgeRadius / DEMO_LAYOUT.pitchY) + 1;
    /** Whether (`qx`, `qy`) lies on the usable substrate: inside the edge radius and clear of the notch keep-out. */
    const usable = (qx, qy) => Math.hypot(qx, qy) <= DEMO_LAYOUT.edgeRadius
        && !(qy <= DEMO_LAYOUT.notchKeepOutY && Math.abs(qx) <= DEMO_LAYOUT.notchKeepOutX);
    // All coordinates are data-frame millimeters (+y up). The data->substrate
    // matrix is neutral (identity) at the attribute defaults, so demo dies
    // authored in D land directly in S. prefix 'milli' makes the engine's unit
    // conversion 1:1, so the literals below are already millimeters.
    const items = [];
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
            }
            else if (roll < 0.15) {
                bin = Math.min(4, Math.max(1, bin + (Math.random() < 0.5 ? 1 : -1)));
            }
            const name = 'R' + (ny - iy) + 'C' + (ix + nx + 1);
            items.push({
                item_id: id, name, user_data: 'lot-A/' + name, unit: 'meter', prefix: 'milli', status: 'BIN_' + bin,
                geometries: [{ type: 'path', commands: SWEEP_UNIT.map((c) => placeCommand(c, DEMO_LAYOUT.sweepHeight, cx, cy)) }],
            });
            id++;
        }
    }
    // The demo substrate is the shared 'si-12in' preset (300 mm disc, 1.125 mm
    // notch at 6 o'clock), built through the SAME generator + buildOutlineModel
    // that the real OutlinePreset uses, at the notch-exaggeration default.
    return {
        outlineModel: buildOutlineModel(generatePresetOutline('si-12in', 'cw', DEFAULTS.notchExaggeration)),
        items: itemsToModels(items),
        mapping,
    };
}
/**
 * Renames an E142 bin definition ({@link E142BinDefinition}: `binCode` /
 * `binQuality`) into the engine's {@link BinDefinition} (`code` / `quality` /
 * `pick`) for {@link buildGridModel}. A pure FIELD RENAME between two engine
 * types - the one mapping the GridData/XML result contracts leave to the layer
 * that owns the engine's render types (see E142Grid's NormalizedGridData note).
 * @param d The E142 bin definition.
 * @returns The engine bin definition.
 */
function toEngineBinDefinition(d) {
    return { code: d.binCode, quality: d.binQuality, pick: d.pick };
}
/**
 * Concrete, placeable substrate control. It owns the substrate identity/demo/
 * label switches, the bindable data model (items, per-item status assignments,
 * the status -> color mapping, labels and the substrate outline), the selection
 * mode and the read-only selection outputs, and it fills the base's two abstract
 * hooks. Canvas, sizing, engine, theme reading and teardown are inherited from
 * {@link SubstrateMapBase}. Each bound attribute maps its data model into engine
 * models through the base's protected scene API; the model build, transform
 * chain and hit-testing live in the shared engine, and the base's pointer path
 * drives {@link __raiseSelected}.
 */
export class SubstrateMap extends SubstrateMapBase {
    // ---- input attributes (defaults mirror Description.json) ----
    /** Substrate id shown in the identity area, or `null` when unset. */
    __substrateId = DEFAULTS.substrateId;
    /** Whether to show the demo items when no real items are bound. */
    __showDemoItems = DEFAULTS.showDemoItems;
    /** Whether the labels are enabled. */
    __showLabels = DEFAULTS.showLabels;
    /** Bound item layout (authored in the data frame D), or `null`. */
    __items = null;
    /** Bound per-item status overrides, or `null`. */
    __itemStatusAssignments = null;
    /** Bound status -> CSS color map, or `null`. */
    __statusColorMapping = null;
    /** Bound labels (authored in the data frame D), or `null`. */
    __labels = null;
    /** Bound substrate outline (authored in the substrate frame S), or `null`. */
    __outline = null;
    /** Selected built-in outline preset key; `'none'` selects no preset. */
    __outlinePreset = DEFAULTS.outlinePreset;
    /** Secondary-flat direction for disc-flats presets (`'cw'` | `'ccw'`). */
    __secDir = DEFAULTS.secDir;
    /** Visual magnification of the notch depth for disc-notch presets (`>= 1`). */
    __notchScale = DEFAULTS.notchExaggeration;
    // ---- Origin: raw attribute state placing the data frame D (resolved and pushed
    //      to the base by {@link __syncPlacement}; the outline stays in frame S). ----
    /** Anchor of the data origin on the fit box. */
    __originLocation = DEFAULTS.originLocation;
    /** Data-origin X offset along the S +x axis, in `__originOffsetPrefix` metres. */
    __originOffsetX = DEFAULTS.originOffsetX;
    /** Data-origin Y offset along the S +y axis, in `__originOffsetPrefix` metres. */
    __originOffsetY = DEFAULTS.originOffsetY;
    /** Metric prefix scaling the (metre-based) origin offsets. */
    __originOffsetPrefix = DEFAULTS.originOffsetPrefix;
    /** Data-axes rotation about the data origin, in degrees, CCW-positive in S. */
    __originRotation = DEFAULTS.originRotation;
    /** Data Y-axis direction; `'down'` mirrors D's y axis for y-down vision frames. */
    __yAxisDirection = DEFAULTS.yAxisDirection;
    /** Whether the origin marker (data-origin crosshair + axis stubs) is drawn. */
    __showOriginMarker = DEFAULTS.showOriginMarker;
    // Selection mode is shell state owned by the base ({@link SubstrateMapBase.__selectionMode});
    // this control's `SelectionMode` attribute maps onto it via __setSelectionMode.
    // ---- View: raw attribute state rotating the whole construct on screen
    //      (resolved to radians and pushed to the base by {@link __syncViewRotation}). ----
    /** View rotation of the whole construct about the substrate frame origin, in degrees, CCW-positive on screen. */
    __mapRotation = DEFAULTS.mapRotation;
    // ---- output attributes (read-only; updated on selection) ----
    /** `item_id` of the last interacted item, or `null`. */
    __selItemId = null;
    /** Effective status of the last interacted element, or `null`. */
    __selItemStatus = null;
    /** Name of the last interacted element, or `null`. */
    __selItemName = null;
    /** Opaque user data of the last interacted item, or `null` (always `null` for cells). */
    __selItemUserData = null;
    /** Full current selection as typed entries, or `null` when nothing is selected. */
    __selItems = null;
    // ---- derived state ----
    /**
     * `item_id -> status` override map built from {@link __itemStatusAssignments}
     * by {@link __rebuildStatusMap}. Read by {@link __effectiveStatus} (and thus
     * by the status resolver pushed to the engine), so a later rebuild is
     * reflected without re-pushing the resolver.
     */
    __statusMap = new Map();
    /**
     * Cached render-ready items built from {@link __items} by
     * {@link __rebuildItems}. Rebuilt only when the bound layout changes (not on
     * every status/mapping update), mirroring ComponentMap's `__realStructures`
     * cache; {@link __activeModel} selects it (over the demo) without rebuilding.
     */
    __itemModels = [];
    /**
     * Cached render-ready outline built from {@link __outline} by
     * {@link __rebuildOutline}, or `null` when unset / invalid. Rebuilt only when
     * the bound outline changes; selected by {@link __activeModel}.
     */
    __outlineModel = null;
    /**
     * Cached render-ready PRESET outline built from {@link __outlinePreset}
     * (steered by {@link __secDir} / {@link __notchScale}) by
     * {@link __rebuildPreset}, or `null` when the preset is `'none'` / degenerate.
     * Ranks below a bound {@link __outline} but above the demo (see
     * {@link __activeModel}).
     */
    __presetOutlineModel = null;
    /**
     * Cached demo bundle (outline model + item models + demo status -> color
     * mapping) built by {@link __rebuildDemo}, or `null` when the demo is
     * disabled. Selected by {@link __activeModel} only when no real outline and no
     * real items (and no preset) are bound and {@link __showDemoItems} is true.
     * Mirrors ComponentMap's cached `__demo`.
     */
    __demo = null;
    // ---- SEMI E142 input attributes (tasks O6 / O7) ----
    //  Three mutually-exclusive bindable map inputs. The most recent non-null
    //  write wins; a fixed precedence (see __INPUT_PRECEDENCE) only breaks the tie
    //  when the active input is unbound while others remain bound.
    /** Bound E142.1 MapData XML document, or `null`. Parsed and rendered as a cell grid. Mutually exclusive with {@link __e142TransferData} and {@link __gridData} (the most recent non-null write wins). */
    __e142MapData = null;
    /** Bound compact GridData v1 document, or `null`. Normalized and rendered as a cell grid. Mutually exclusive with {@link __e142MapData} and {@link __e142TransferData}. */
    __gridData = null;
    /**
     * Bound E142.4 (Stream-21) reassembled item content, or `null`: a base64
     * `string` or a `number[]` of byte values (task O7). Decoded to text
     * (encoding sniff) and then run through the SAME XML pipeline as
     * {@link __e142MapData}. Mutually exclusive with the other two inputs.
     */
    __e142TransferData = null;
    /** Overlay to render from the E142 document (by MapName); `null` selects the first renderable BinCodeMap overlay (decision E-5). Ignored by the GridData path. */
    __e142OverlayName = null;
    /** Fallback column pitch in millimetres for layoutless maps (E-9 stage 2), or `null` when unset. Applied only when BOTH X and Y are set. */
    __e142FallbackStepX = null;
    /** Fallback row pitch in millimetres for layoutless maps (E-9 stage 2), or `null` when unset. */
    __e142FallbackStepY = null;
    /** Degrees added to the map's Orientation before placement (decision E-8 escape hatch), a CW-positive source angle; default 0. */
    __e142OrientationOffset = DEFAULTS.e142OrientationOffset;
    // ---- SEMI E142 read-only outputs (task O6) ----
    /** Last map-ingestion error message, or `null` when the active map (if any) rendered cleanly. */
    __e142LastError = null;
    /** Substrate id of the active map (XML: the map header's; GridData: the identity pass-through), or `null`. */
    __mapSubstrateId = null;
    /** Lot id of the active map's substrate, or `null` when the source carried none. */
    __mapLotId = null;
    /** Good-device count of the active map's substrate, or `null` when the source carried none. */
    __mapGoodDevices = null;
    // ---- SEMI E142 derived state (task O6) ----
    /** Which mutually-exclusive map input is currently active, or `null` (no map bound). */
    __activeInput = null;
    /**
     * Cached parse of {@link __e142MapData}, so an {@link setE142OverlayName},
     * fallback or offset change re-resolves WITHOUT re-parsing (task O6 item 3).
     * Nulled by {@link setE142MapData} on a new/removed XML string, forcing a
     * fresh parse on the next {@link __rebuildMap}.
     */
    __e142Doc = null;
    /**
     * The active map's logical frame (OriginLocation / AxisDirection), or `null`
     * when no grid is bound. Read by {@link __raiseSelected} to convert a hit
     * cell's serialization indices to signed logical map coordinates via
     * {@link indexToMapCoord}; C / R come from the live grid model.
     */
    __mapFrame = null;
    /**
     * The non-geometric facts of the last successfully built grid (the geometry
     * lives in the base's `__sceneGrid.placement`), retained so {@link toGridData}
     * / {@link toE142Xml} can re-serialise the current map (decision E-4 export
     * path). `null` when no grid is bound. Set in {@link __commitGrid}.
     */
    __lastBuilt = null;
    /**
     * Cell (serialization linear index) -> device id, built from a `DeviceIdMap`
     * overlay in the rendered map's SubstrateMap (decision E-6b). `null` when no
     * grid is bound or the document carried no DeviceIdMap. Read on selection.
     */
    __deviceIdIndex = null;
    /**
     * `E142AlignToReferenceDevices`: opt-in reference-device registration
     * (decision E-7 compute path). OFF by default, so placement is unchanged
     * unless explicitly enabled. Applied in {@link __commitGrid} (XML path only;
     * GridData carries no reference devices).
     */
    __alignToReferenceDevices = false;
    /**
     * Constructor of the control.
     * @param element Element of the control as delivered by the framework.
     * @param pcElement Precompiled element of the control.
     * @param attrs Attributes of the element as delivered by the framework.
     */
    constructor(element, pcElement, attrs) {
        super(element, pcElement, attrs);
    }
    // ---------------------------------------------------------------
    //  Lifecycle
    // ---------------------------------------------------------------
    /**
     * Attaches the control: runs the base shell attach (template root, canvas,
     * device-pixel-ratio sizing, ResizeObserver, pointer handler, engine, first
     * render), then builds the initial demo so it shows at design time when no
     * data is bound. The bound-data models (items / outline / status / labels) are
     * built by their attribute setters; only the demo needs an explicit initial
     * build here, because `ShowDemoItems` defaults to the field default, so the
     * setter's no-op guard would never trigger a first build on its own. Building
     * the demo while real data is present is harmless - {@link __activeModel} still
     * selects the real models over it.
     */
    __attach() {
        super.__attach();
        // Push the resolved Origin placement and view rotation once here, for the same
        // reason the demo is built explicitly: these attributes default to their field
        // defaults, so each setter's no-op guard would suppress a first push, and the
        // base would otherwise render with its own defaults. Idempotent with the setters.
        this.__syncPlacement();
        this.__syncViewRotation();
        this.__rebuildDemo();
    }
    // ---------------------------------------------------------------
    //  Abstract hooks
    // ---------------------------------------------------------------
    /**
     * Composes the substrate-identity text: the substrate id, or an empty string
     * (which hides the identity area) when unset.
     * @returns The identity text.
     */
    __composeIdentity() {
        // Explicit SubstrateId wins; when it is unset and a map is bound, show the
        // map's substrate id (task O6 item 7); otherwise hide the identity area.
        if (this.__substrateId !== null) {
            return this.__substrateId;
        }
        if (this.__mapBound() && this.__mapSubstrateId !== null) {
            return this.__mapSubstrateId;
        }
        return '';
    }
    /**
     * Concrete selection hook: raises this control's `.onItemSelected` event with
     * the base-built {@link SelectedPayload} and mirrors it into the read-only
     * outputs - the single-value `Selected*` describe the last interacted element,
     * and `SelectedItems` carries the full selection as rich {@link SelectionEntry}
     * rows (kind + id + resolved status / name / user_data).
     *
     * Each legacy facade implements THIS SAME hook independently, with its own event
     * and output names: there is deliberately no super-chaining and no shared
     * concrete raise path, so a facade never inherits SubstrateMap's `.onItemSelected`
     * or its outputs. The base's pointer/hit-test path is the only caller.
     *
     * The rich rows are rebuilt from the payload's `{ kind, itemId }` entries by
     * looking each id up in the ACTIVE render models ({@link SubstrateMapBase.__sceneItems},
     * which also holds the demo items when the demo is active) and re-resolving
     * the effective status via {@link __effectiveStatus}. Id-less selected items
     * carry no addressable id, so they are already absent from `payload.selection`
     * and thus from `SelectedItems` (they remain ring-marked). Cells carry no model
     * and report `null` spatial fields.
     * @param payload The selection payload from the base (last element + full selection).
     * @fires onItemSelected
     */
    __raiseSelected(payload) {
        // Base event payload (CONTEXT); a CELL interaction additionally carries the
        // grid coordinates - column/row (serialization indices, from the base),
        // binCode/binQuality, and mapX/mapY (signed logical coordinates via the
        // domain module, task O6 item 8 + additional behavior). Item interactions
        // carry none of these.
        const eventData = {
            itemId: payload.itemId,
            status: payload.status,
            name: payload.name,
            userData: payload.userData,
            kind: payload.kind,
            selection: payload.selection,
        };
        if (payload.kind === 'cell' && payload.column !== undefined && payload.row !== undefined) {
            eventData.column = payload.column;
            eventData.row = payload.row;
            eventData.binCode = payload.binCode ?? null;
            eventData.binQuality = payload.binQuality ?? null;
            const mc = this.__cellMapCoord(payload.column, payload.row);
            eventData.mapX = mc ? mc.mapX : null;
            eventData.mapY = mc ? mc.mapY : null;
            // Device id from a DeviceIdMap overlay, by the cell's serial index (E-6b).
            const g = this.__sceneGrid;
            eventData.deviceId = (this.__deviceIdIndex && g)
                ? (this.__deviceIdIndex.get(payload.row * g.cols + payload.column) ?? null)
                : null;
        }
        TcHmi.EventProvider.raise(this.__id + '.onItemSelected', eventData);
        this.__setSelectedOutputs(payload);
        if (payload.selection.length === 0) {
            this.setSelectedItems(null);
            return;
        }
        const byId = new Map();
        for (const model of this.__sceneItems) {
            if (model.id !== null) {
                byId.set(model.id, model);
            }
        }
        const grid = this.__sceneGrid;
        const entries = payload.selection.map((sel) => {
            if (sel.kind === 'cell') {
                // A cell's status IS its bin code (the status resolver is an item
                // concern); it carries no name and no user data.
                const bin = grid && sel.itemId >= 0 && sel.itemId < grid.cells.length
                    ? grid.binTable[grid.cells[sel.itemId]]
                    : undefined;
                const entry = {
                    kind: 'cell', item_id: sel.itemId, status: bin ? bin.code : null,
                    name: null, user_data: null, binQuality: bin ? bin.quality : null,
                };
                if (grid) {
                    const mc = this.__cellMapCoord(sel.itemId % grid.cols, Math.floor(sel.itemId / grid.cols));
                    if (mc) {
                        entry.mapX = mc.mapX;
                        entry.mapY = mc.mapY;
                    }
                }
                if (this.__deviceIdIndex) {
                    entry.deviceId = this.__deviceIdIndex.get(sel.itemId) ?? null;
                }
                return entry;
            }
            const model = byId.get(sel.itemId);
            return {
                kind: 'item',
                item_id: sel.itemId,
                status: model ? this.__effectiveStatus(model) : null,
                name: model ? model.name : null,
                user_data: model ? model.userData : null,
            };
        });
        this.setSelectedItems(entries);
    }
    // ---------------------------------------------------------------
    //  Input attributes
    // ---------------------------------------------------------------
    /**
     * Sets the substrate id shown in the identity area. `null` hides the identity
     * area. Updates the identity label and raises `onPropertyChanged` on change.
     * @param valueNew New substrate id, or `null`.
     */
    setSubstrateId(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__substrateId)) {
            return;
        }
        this.__substrateId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SubstrateId' });
        this.__updateIdentity();
    }
    /** @returns The current substrate id, or `null`. */
    getSubstrateId() { return this.__substrateId; }
    /**
     * Sets the substrate-identity label position. Values other than `'above'` /
     * `'below'` / `'none'` fall back to the attribute default. Updates the
     * identity label and raises `onPropertyChanged` on change.
     * @param valueNew New position, or `null` to use the default.
     */
    setSubstrateIdentityPosition(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || POSITIONS.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('SubstrateIdentityPosition');
        }
        if (tchmi_equal(v, this.__identityPosition)) {
            return;
        }
        this.__setIdentity(v);
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SubstrateIdentityPosition' });
    }
    /** @returns The current substrate-identity label position. */
    getSubstrateIdentityPosition() { return this.__identityPosition; }
    /**
     * Toggles the demo items (shown only when no real outline and no real items
     * are bound). Rebuilds the demo bundle and re-renders on change; raises
     * `onPropertyChanged`.
     * @param valueNew New flag, or `null` to use the default.
     */
    setShowDemoItems(valueNew) {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowDemoItems');
        }
        if (tchmi_equal(b, this.__showDemoItems)) {
            return;
        }
        this.__showDemoItems = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowDemoItems' });
        // Rebuild the demo bundle for the new flag (generating or clearing it) and
        // re-sync; the demo only paints when no real outline / items are bound.
        this.__rebuildDemo();
    }
    /** @returns Whether the demo items are enabled. */
    getShowDemoItems() { return this.__showDemoItems; }
    /**
     * Toggles the labels. Requests a re-render and raises `onPropertyChanged` on
     * change.
     * @param valueNew New flag, or `null` to use the default.
     */
    setShowLabels(valueNew) {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowLabels');
        }
        if (tchmi_equal(b, this.__showLabels)) {
            return;
        }
        this.__showLabels = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowLabels' });
        this.__rebuildLabels();
        this.__requestRender();
    }
    /** @returns Whether the labels are enabled. */
    getShowLabels() { return this.__showLabels; }
    /**
     * Sets the item layout. A non-array (or `null`) clears it. Rebuilds the
     * derived items, drops any selection and re-renders on change.
     * @param valueNew New {@link ItemList}, or `null` to clear.
     */
    setItems(valueNew) {
        let v = TcHmi.ValueConverter.toObject(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Items');
        }
        if (tchmi_equal(v, this.__items)) {
            return;
        }
        this.__items = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Items' });
        this.__rebuildItems();
        this.__requestRender();
    }
    /** @returns The current item layout, or `null`. */
    getItems() { return this.__items; }
    /**
     * Sets the per-item status overrides. A non-array (or `null`) clears them.
     * Rebuilds the status map and re-renders on change.
     * @param valueNew New {@link ItemStatusAssignmentList}, or `null` to clear.
     */
    setItemStatusAssignments(valueNew) {
        let v = TcHmi.ValueConverter.toObject(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('ItemStatusAssignments');
        }
        if (tchmi_equal(v, this.__itemStatusAssignments)) {
            return;
        }
        this.__itemStatusAssignments = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ItemStatusAssignments' });
        this.__rebuildStatusMap();
        this.__requestRender();
    }
    /** @returns The current status overrides, or `null`. */
    getItemStatusAssignments() { return this.__itemStatusAssignments; }
    /**
     * Sets the status -> color mapping. A non-object (or `null`) clears it.
     * Colors are resolved at draw time, so this only re-renders (no rebuild).
     * @param valueNew New status -> CSS color map, or `null` to clear.
     */
    setStatusColorMapping(valueNew) {
        let v = TcHmi.ValueConverter.toObject(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('StatusColorMapping');
        }
        if (tchmi_equal(v, this.__statusColorMapping)) {
            return;
        }
        this.__statusColorMapping = (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'StatusColorMapping' });
        this.__syncScene();
    }
    /** @returns The current status -> color mapping, or `null`. */
    getStatusColorMapping() { return this.__statusColorMapping; }
    /**
     * Sets the label list. A non-array (or `null`) clears it. Rebuilds the
     * derived labels and re-renders on change.
     * @param valueNew New {@link SubstrateMapLabelList}, or `null` to clear.
     */
    setLabels(valueNew) {
        let v = TcHmi.ValueConverter.toObject(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Labels');
        }
        if (tchmi_equal(v, this.__labels)) {
            return;
        }
        this.__labels = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Labels' });
        this.__rebuildLabels();
        this.__requestRender();
    }
    /** @returns The current label list, or `null`. */
    getLabels() { return this.__labels; }
    /**
     * Sets the substrate outline. A non-object (or `null`) clears it. Rebuilds
     * the derived outline and re-renders on change.
     * @param valueNew New {@link Outline}, or `null` to clear.
     */
    setOutline(valueNew) {
        let v = TcHmi.ValueConverter.toObject(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Outline');
        }
        if (tchmi_equal(v, this.__outline)) {
            return;
        }
        this.__outline = (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Outline' });
        this.__rebuildOutline();
        this.__requestRender();
    }
    /** @returns The current substrate outline, or `null`. */
    getOutline() { return this.__outline; }
    /**
     * Sets the built-in outline preset by key. Values outside {@link PRESET_KEYS}
     * (all Annex A keys plus `'none'`) fall back to the attribute default. No-ops
     * if unchanged; otherwise raises `onPropertyChanged`, regenerates the preset
     * model and re-renders. A bound {@link setOutline} still wins over the preset.
     * @param valueNew New preset key, or `null` to use the default.
     */
    setOutlinePreset(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || PRESET_KEYS.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('OutlinePreset');
        }
        if (tchmi_equal(v, this.__outlinePreset)) {
            return;
        }
        this.__outlinePreset = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OutlinePreset' });
        this.__rebuildPreset();
    }
    /** @returns The current outline preset key (`'none'` when no preset is selected). */
    getOutlinePreset() { return this.__outlinePreset; }
    /**
     * Sets the secondary-flat direction for disc-flats presets. Values other than
     * `'cw'` / `'ccw'` fall back to the attribute default. No-ops if unchanged;
     * otherwise raises `onPropertyChanged`, regenerates the (disc-flats) preset
     * model and re-renders. Mirrors WaferMap's setter semantics.
     * @param valueNew New direction, or `null` to use the default.
     */
    setSecondaryFlatDirection(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v !== 'cw' && v !== 'ccw') {
            v = this.getAttributeDefaultValueInternal('SecondaryFlatDirection');
        }
        if (tchmi_equal(v, this.__secDir)) {
            return;
        }
        this.__secDir = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SecondaryFlatDirection' });
        this.__rebuildPreset();
    }
    /** @returns The current secondary-flat direction. */
    getSecondaryFlatDirection() { return this.__secDir; }
    /**
     * Sets the visual notch magnification for disc-notch presets, clamped to
     * `>= 1`. No-ops if unchanged; otherwise raises `onPropertyChanged`,
     * regenerates the preset model and re-renders. Affects disc-notch presets
     * only - a bound {@link setOutline} is never scaled. Mirrors WaferMap's
     * setter semantics.
     * @param valueNew New magnification, or `null` to use the default.
     */
    setNotchExaggeration(valueNew) {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('NotchExaggeration');
        }
        if (n < 1) {
            n = 1;
        }
        if (tchmi_equal(n, this.__notchScale)) {
            return;
        }
        this.__notchScale = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NotchExaggeration' });
        this.__rebuildPreset();
    }
    /** @returns The current notch magnification. */
    getNotchExaggeration() { return this.__notchScale; }
    // ---------------------------------------------------------------
    //  Origin (data-frame placement)
    //  These six attributes place the DATA frame D (Items and Labels only); the
    //  Outline is authored in the substrate frame S and never moves. Each setter
    //  validates (invalid input keeps the old value), and on a real change raises
    //  onPropertyChanged, re-resolves the placement to the engine via
    //  {@link __syncPlacement} and re-renders.
    // ---------------------------------------------------------------
    /**
     * Sets the anchor of the data origin on the fit box (the outline bounding box,
     * or the items' combined bbox when no outline is bound): one of `'center'`,
     * `'top-left'`, `'bottom-left'`, `'top-right'`, `'bottom-right'` (`'top'` = +y
     * edge, `'left'` = -x edge of the box, in S). An unrecognized value keeps the
     * current anchor. No-ops if unchanged.
     * @param valueNew New anchor, or `null` (ignored -> keep current).
     */
    setOriginLocation(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || ORIGIN_LOCATIONS.indexOf(v) === -1) {
            return;
        } // invalid -> keep old value
        if (tchmi_equal(v, this.__originLocation)) {
            return;
        }
        this.__originLocation = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginLocation' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-origin anchor. */
    getOriginLocation() { return this.__originLocation; }
    /**
     * Sets the data-origin X offset, added to the anchor along the SUBSTRATE +x
     * axis (independent of `YAxisDirection`). Base unit metre, scaled by
     * {@link setOriginOffsetPrefix}. A non-finite value keeps the current offset.
     * No-ops if unchanged.
     * @param valueNew New X offset, or `null` (ignored -> keep current).
     */
    setOriginOffsetX(valueNew) {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) {
            return;
        } // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__originOffsetX)) {
            return;
        }
        this.__originOffsetX = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginOffsetX' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-origin X offset (in `OriginOffsetPrefix` metres). */
    getOriginOffsetX() { return this.__originOffsetX; }
    /**
     * Sets the data-origin Y offset, added to the anchor along the SUBSTRATE +y
     * axis (up, independent of `YAxisDirection`). Base unit metre, scaled by
     * {@link setOriginOffsetPrefix}. A non-finite value keeps the current offset.
     * No-ops if unchanged.
     * @param valueNew New Y offset, or `null` (ignored -> keep current).
     */
    setOriginOffsetY(valueNew) {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) {
            return;
        } // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__originOffsetY)) {
            return;
        }
        this.__originOffsetY = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginOffsetY' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-origin Y offset (in `OriginOffsetPrefix` metres). */
    getOriginOffsetY() { return this.__originOffsetY; }
    /**
     * Sets the metric prefix scaling the (metre-based) origin offsets, one of the
     * standard prefixes `yocto`..`none`. An unrecognized value keeps the current
     * prefix. No-ops if unchanged.
     * @param valueNew New prefix, or `null` (ignored -> keep current).
     */
    setOriginOffsetPrefix(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || PREFIXES.indexOf(v) === -1) {
            return;
        } // invalid -> keep old value
        if (tchmi_equal(v, this.__originOffsetPrefix)) {
            return;
        }
        this.__originOffsetPrefix = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginOffsetPrefix' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current origin-offset metric prefix. */
    getOriginOffsetPrefix() { return this.__originOffsetPrefix; }
    /**
     * Sets the data-axes rotation about the data origin, in degrees,
     * counter-clockwise-positive as seen in S (and CCW on screen). Rotates the
     * Item/Label ensemble about the anchor, NOT about the substrate centre. A
     * non-finite value keeps the current rotation. No-ops if unchanged.
     * @param valueNew New rotation in degrees, or `null` (ignored -> keep current).
     */
    setOriginRotation(valueNew) {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) {
            return;
        } // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__originRotation)) {
            return;
        }
        this.__originRotation = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginRotation' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-axes rotation in degrees. */
    getOriginRotation() { return this.__originRotation; }
    /**
     * Sets the data Y-axis direction: `'up'` (default) or `'down'`. `'down'`
     * mirrors D's y axis for vision systems whose +y grows downward; a
     * CCW-positive Item orientation authored in that y-down frame then renders
     * clockwise on screen (the correct physical behaviour). Does not move the
     * outline. An unrecognized value keeps the current direction. No-ops if
     * unchanged.
     * @param valueNew New direction, or `null` (ignored -> keep current).
     */
    setYAxisDirection(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || Y_AXIS_DIRECTIONS.indexOf(v) === -1) {
            return;
        } // invalid -> keep old value
        if (tchmi_equal(v, this.__yAxisDirection)) {
            return;
        }
        this.__yAxisDirection = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'YAxisDirection' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data Y-axis direction. */
    getYAxisDirection() { return this.__yAxisDirection; }
    /**
     * Toggles the origin marker: a diagnostic crosshair on the data origin plus a
     * +x and a +y data-axis stub with arrowheads (the +y head doubled, so the two
     * axes are told apart by shape, not colour). Off by default. Drawn under the
     * full data matrix, so it shows the data origin's position, `OriginRotation`
     * and `YAxisDirection` at once - `'down'` flips the +y stub to point downward on
     * screen. Screen-constant in size; purely visual and never selectable. No-ops
     * if unchanged.
     * @param valueNew New flag, or `null` to use the default.
     */
    setShowOriginMarker(valueNew) {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowOriginMarker');
        }
        if (tchmi_equal(b, this.__showOriginMarker)) {
            return;
        }
        this.__showOriginMarker = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowOriginMarker' });
        this.__updateShowOriginMarker(b);
        this.__requestRender();
    }
    /** @returns Whether the origin marker is enabled. */
    getShowOriginMarker() { return this.__showOriginMarker; }
    /**
     * Sets the view rotation of the whole construct - outline, Items, Labels and
     * the origin marker - about the substrate frame origin, in degrees,
     * counter-clockwise-positive on screen. The drawing is re-fitted so the turned
     * construct is never clipped (conservatively: a 45deg-rotated square gets
     * ~sqrt(2) more margin). Display-only - it does NOT change Item coordinates, the
     * hit result or the `Selected*` outputs; a click hits the same Item at any
     * rotation. A non-finite value keeps the current rotation. No-ops if unchanged.
     * @param valueNew New view rotation in degrees, or `null` (ignored -> keep current).
     */
    setMapRotation(valueNew) {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) {
            return;
        } // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__mapRotation)) {
            return;
        }
        this.__mapRotation = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapRotation' });
        this.__syncViewRotation();
        this.__requestRender();
    }
    /** @returns The current view rotation in degrees. */
    getMapRotation() { return this.__mapRotation; }
    /**
     * Sets the selection mode. Values other than `'single'` / `'multi'` fall
     * back to the attribute default. Switching mode clears the current selection
     * (single and multi semantics differ) and re-renders on change.
     * @param valueNew New selection mode, or `null` to use the default.
     */
    setSelectionMode(valueNew) {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || SELECTION_MODES.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('SelectionMode');
        }
        if (tchmi_equal(v, this.__selectionMode)) {
            return;
        }
        // The base owns the mode (shell state) and drops the base-side selection
        // state on the switch; this setter then clears the concrete read-only
        // outputs and re-renders so any stale rings are gone.
        this.__setSelectionMode(v);
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectionMode' });
        this.__setSelectedOutputs(null);
        this.setSelectedItems(null);
        this.__requestRender();
    }
    /** @returns The current selection mode. */
    getSelectionMode() { return this.__selectionMode; }
    // ---------------------------------------------------------------
    //  SEMI E142 input attributes (tasks O6 / O7)
    //  Three mutually-exclusive bindable inputs (E142MapData / E142TransferData /
    //  GridData) plus their modifiers. Each maps its data model onto the same
    //  engine grid pipeline; the most recently written non-null input wins, and a
    //  warning is logged when more than one is bound. Grid PLACEMENT comes
    //  exclusively from the map data - the Origin*/YAxisDirection attributes keep
    //  governing Items and Labels only.
    // ---------------------------------------------------------------
    /**
     * Sets the E142.1 MapData XML document (task O6 item 1). Parses it, resolves
     * the overlay (see {@link setE142OverlayName}), resolves the layout, computes
     * the grid placement and pushes the built grid to the shell. On any failure
     * the framework logger is called, {@link getE142LastError} is set and the grid
     * is cleared. A non-null value makes XML the active input (mutually exclusive
     * with {@link setE142TransferData} and {@link setGridData} - a warning is
     * logged when more than one is bound). No-ops if unchanged.
     * @param valueNew New XML document, or `null` to unbind.
     */
    setE142MapData(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142MapData)) {
            return;
        }
        this.__e142MapData = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142MapData' });
        if (v !== null) {
            this.__activeInput = 'xml';
            this.__warnIfMultipleInputs('xml');
        }
        else if (this.__activeInput === 'xml') {
            this.__activeInput = this.__fallbackActiveInput();
        }
        this.__e142Doc = null; // the XML changed: force a fresh parse
        this.__rebuildMap();
    }
    /** @returns The bound E142 MapData XML, or `null`. */
    getE142MapData() { return this.__e142MapData; }
    /**
     * Sets the compact GridData v1 document (task O6 item 2). Normalizes it and
     * runs the SAME downstream chain and error handling as {@link setE142MapData}.
     * A non-null value makes GridData the active input (mutually exclusive with
     * E142MapData). No-ops if unchanged.
     * @param valueNew New GridData document, or `null` to unbind.
     */
    setGridData(valueNew) {
        const o = TcHmi.ValueConverter.toObject(valueNew);
        const v = (o !== null && typeof o === 'object') ? o : null;
        if (tchmi_equal(v, this.__gridData)) {
            return;
        }
        this.__gridData = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'GridData' });
        if (v !== null) {
            this.__activeInput = 'grid';
            this.__warnIfMultipleInputs('grid');
        }
        else if (this.__activeInput === 'grid') {
            this.__activeInput = this.__fallbackActiveInput();
        }
        this.__rebuildMap();
    }
    /** @returns The bound GridData document, or `null`. */
    getGridData() { return this.__gridData; }
    /**
     * Sets the E142.4 (Stream-21) reassembled item content (task O7 item 1): a
     * base64 `string` (primary form) or a `number[]` of byte values (secondary,
     * PLC-array-friendly form). The bytes are decoded to text via the encoding
     * sniff (BOM / XML declaration; UTF-8 default) and then run through the SAME
     * XML pipeline as {@link setE142MapData}, reusing the cached parse for later
     * overlay / fallback / offset changes. On any decode or parse failure the
     * framework logger is called, {@link getE142LastError} is set and the grid is
     * cleared. A non-null value makes the transfer input active (mutually
     * exclusive with {@link setE142MapData} and {@link setGridData} - a warning is
     * logged when more than one is bound). No-ops if unchanged.
     *
     * SECS communication is host-side: Stream-21 REASSEMBLY (ITEMPART chunking,
     * ordering, acknowledgement) belongs to the host SECS/GEM stack; this setter
     * consumes the finished item bytes it writes to the bound symbol. No
     * `ITEMTYPE` string is inspected or hard-coded - filtering is exclusively the
     * host stack's configuration concern (the well-known-names ballot was still
     * unsubmitted as of winter 2026).
     * @param valueNew New item content (base64 string or byte-value array), or
     *                 `null` to unbind.
     */
    setE142TransferData(valueNew) {
        const v = SubstrateMap.__normalizeTransferInput(valueNew);
        if (tchmi_equal(v, this.__e142TransferData)) {
            return;
        }
        this.__e142TransferData = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142TransferData' });
        if (v !== null) {
            this.__activeInput = 'transfer';
            this.__warnIfMultipleInputs('transfer');
        }
        else if (this.__activeInput === 'transfer') {
            this.__activeInput = this.__fallbackActiveInput();
        }
        this.__e142Doc = null; // new/removed item bytes: force a fresh decode + parse
        this.__rebuildMap();
    }
    /** @returns The bound transfer item content (base64 string or byte-value array), or `null`. */
    getE142TransferData() { return this.__e142TransferData; }
    /**
     * Sets the overlay to render from the E142 document, by MapName; `null`
     * selects the first renderable BinCodeMap overlay in document order (decision
     * E-5). Re-resolves against the CACHED parse without re-parsing (task O6 item
     * 3), for either XML-document input (E142MapData or the E142.4 transfer path).
     * Inert while the GridData path is active (GridData has no overlays). No-ops
     * if unchanged.
     * @param valueNew New overlay name, or `null` for the first renderable overlay.
     */
    setE142OverlayName(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142OverlayName)) {
            return;
        }
        this.__e142OverlayName = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142OverlayName' });
        if (this.__activeInput === 'xml' || this.__activeInput === 'transfer') {
            this.__rebuildMap(); // reuses __e142Doc: no re-parse
        }
    }
    /** @returns The bound overlay name, or `null`. */
    getE142OverlayName() { return this.__e142OverlayName; }
    /**
     * Sets the fallback column pitch in millimetres for layoutless maps (decision
     * E-9 stage 2). Used only when BOTH X and Y are set; exactly one set logs a
     * warning and falls through to the fit heuristic. `null` unsets it. Re-renders
     * the active map on change (reusing the cached parse). No-ops if unchanged.
     * @param valueNew New pitch in millimetres, or `null`.
     */
    setE142FallbackStepSizeX(valueNew) {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(n, this.__e142FallbackStepX)) {
            return;
        }
        this.__e142FallbackStepX = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142FallbackStepSizeX' });
        if (this.__activeInput !== null) {
            this.__rebuildMap();
        }
    }
    /** @returns The fallback column pitch in millimetres, or `null`. */
    getE142FallbackStepSizeX() { return this.__e142FallbackStepX; }
    /**
     * Sets the fallback row pitch in millimetres for layoutless maps (decision E-9
     * stage 2); see {@link setE142FallbackStepSizeX}. `null` unsets it. No-ops if
     * unchanged.
     * @param valueNew New pitch in millimetres, or `null`.
     */
    setE142FallbackStepSizeY(valueNew) {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(n, this.__e142FallbackStepY)) {
            return;
        }
        this.__e142FallbackStepY = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142FallbackStepSizeY' });
        if (this.__activeInput !== null) {
            this.__rebuildMap();
        }
    }
    /** @returns The fallback row pitch in millimetres, or `null`. */
    getE142FallbackStepSizeY() { return this.__e142FallbackStepY; }
    /**
     * Sets the degrees added to the map's Orientation before placement (decision
     * E-8 escape hatch). A CW-positive source angle; the zero reference is a notch
     * at 6 o'clock at Orientation=0 (see the README). Re-renders the active map on
     * change (reusing the cached parse). No-ops if unchanged.
     * @param valueNew New offset in degrees, or `null` to use the default (0).
     */
    setE142OrientationOffset(valueNew) {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('E142OrientationOffset');
        }
        if (tchmi_equal(n, this.__e142OrientationOffset)) {
            return;
        }
        this.__e142OrientationOffset = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142OrientationOffset' });
        if (this.__activeInput !== null) {
            this.__rebuildMap();
        }
    }
    /** @returns The orientation offset in degrees. */
    getE142OrientationOffset() { return this.__e142OrientationOffset; }
    /**
     * `E142AlignToReferenceDevices`: enable opt-in reference-device registration
     * (decision E-7 compute path). When on and the active map (XML only) carries
     * reference devices with Positions, the placement is translated so their model
     * cell-centres meet those Positions; when off (the default), placement is
     * unchanged. A change re-commits the current map.
     * @param valueNew New flag, or `null` to fall back to the attribute default.
     */
    setE142AlignToReferenceDevices(valueNew) {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('E142AlignToReferenceDevices');
        }
        if (tchmi_equal(b, this.__alignToReferenceDevices)) {
            return;
        }
        this.__alignToReferenceDevices = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142AlignToReferenceDevices' });
        if (this.__activeInput !== null) {
            this.__rebuildMap();
        }
    }
    /** @returns Whether reference-device registration is enabled. */
    getE142AlignToReferenceDevices() { return this.__alignToReferenceDevices; }
    // ---------------------------------------------------------------
    //  SEMI E142 export (decision E-4 export path). null means "no active map".
    // ---------------------------------------------------------------
    /**
     * Serialises the CURRENTLY BOUND map back to a canonical {@link GridData}
     * document, or returns `null` when no map is bound. Round-trips: binding the
     * result to {@link setGridData} reproduces the same grid. Pitch is the drawn
     * placement's (physical when the source had scale, nominal otherwise), in mm;
     * `orientation` is the source map's, not the display {@link setE142OrientationOffset}.
     * @returns The GridData, or `null` if no grid is bound.
     */
    toGridData() {
        const grid = this.__sceneGrid;
        const lb = this.__lastBuilt;
        if (grid === null || lb === null) {
            return null;
        }
        return gridToGridData(grid, {
            orientation: lb.orientation,
            originLocation: lb.origin,
            axisDirection: lb.dir,
            binType: lb.binType,
            substrateId: lb.substrateId,
            binDefinitions: lb.binDefs,
        });
    }
    /**
     * Serialises the CURRENTLY BOUND map back to an E142 `MapData` XML string, or
     * returns `null` when no map is bound. Round-trips through {@link setE142MapData}.
     * Same pitch / orientation semantics as {@link toGridData}.
     * @returns The E142 XML, or `null` if no grid is bound.
     */
    toE142Xml() {
        const grid = this.__sceneGrid;
        const lb = this.__lastBuilt;
        if (grid === null || lb === null) {
            return null;
        }
        return gridToE142Xml(grid, {
            substrateType: lb.substrateType,
            substrateId: lb.substrateId,
            orientation: lb.orientation,
            originLocation: lb.origin,
            axisDirection: lb.dir,
            binType: lb.binType,
            binDefinitions: lb.binDefs,
        });
    }
    // ---------------------------------------------------------------
    //  SEMI E142 read-only outputs (task O6 item 4). null means "no active map".
    // ---------------------------------------------------------------
    /**
     * Updates the last-error output. Intended for internal use on map ingestion;
     * raises `onPropertyChanged` on change.
     * @param valueNew New error message, or `null` when the map is clean.
     */
    setE142LastError(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142LastError)) {
            return;
        }
        this.__e142LastError = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142LastError' });
    }
    /** @returns The last map-ingestion error, or `null`. */
    getE142LastError() { return this.__e142LastError; }
    /**
     * Updates the map substrate-id output. Intended for internal use on map
     * ingestion; raises `onPropertyChanged` on change.
     * @param valueNew New substrate id, or `null`.
     */
    setMapSubstrateId(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapSubstrateId)) {
            return;
        }
        this.__mapSubstrateId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapSubstrateId' });
    }
    /** @returns The active map's substrate id, or `null`. */
    getMapSubstrateId() { return this.__mapSubstrateId; }
    /**
     * Updates the map lot-id output. Intended for internal use on map ingestion;
     * raises `onPropertyChanged` on change.
     * @param valueNew New lot id, or `null`.
     */
    setMapLotId(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapLotId)) {
            return;
        }
        this.__mapLotId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapLotId' });
    }
    /** @returns The active map's lot id, or `null`. */
    getMapLotId() { return this.__mapLotId; }
    /**
     * Updates the map good-device-count output. Intended for internal use on map
     * ingestion; raises `onPropertyChanged` on change.
     * @param valueNew New good-device count, or `null`.
     */
    setMapGoodDevices(valueNew) {
        const v = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(v, this.__mapGoodDevices)) {
            return;
        }
        this.__mapGoodDevices = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapGoodDevices' });
    }
    /** @returns The active map's good-device count, or `null`. */
    getMapGoodDevices() { return this.__mapGoodDevices; }
    // ---------------------------------------------------------------
    //  Output attributes (read-only). null means "no selection".
    // ---------------------------------------------------------------
    /**
     * Updates the selected item id output. Intended for internal use on
     * selection changes; raises `onPropertyChanged` on change.
     * @param valueNew New `item_id`, or `null`.
     */
    setSelectedItemId(valueNew) {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(n, this.__selItemId)) {
            return;
        }
        this.__selItemId = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemId' });
    }
    /** @returns The last interacted item's `item_id`, or `null`. */
    getSelectedItemId() { return this.__selItemId; }
    /**
     * Updates the selected item status output. Non-status values are normalized
     * to `null`. Raises `onPropertyChanged` on change.
     * @param valueNew New status, or `null`.
     */
    setSelectedItemStatus(valueNew) {
        const v = normStatus(valueNew);
        if (tchmi_equal(v, this.__selItemStatus)) {
            return;
        }
        this.__selItemStatus = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemStatus' });
    }
    /** @returns The last interacted element's effective status, or `null`. */
    getSelectedItemStatus() { return this.__selItemStatus; }
    /**
     * Updates the selected item name output. Raises `onPropertyChanged` on
     * change.
     * @param valueNew New name, or `null`.
     */
    setSelectedItemName(valueNew) {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__selItemName)) {
            return;
        }
        this.__selItemName = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemName' });
    }
    /** @returns The last interacted element's name, or `null`. */
    getSelectedItemName() { return this.__selItemName; }
    /**
     * Updates the selected item user-data output. Values other than a string or
     * number are normalized to `null` (grid cells always report `null`). Raises
     * `onPropertyChanged` on change.
     * @param valueNew New user data, or `null`.
     */
    setSelectedItemUserData(valueNew) {
        const v = (typeof valueNew === 'string' || typeof valueNew === 'number') ? valueNew : null;
        if (tchmi_equal(v, this.__selItemUserData)) {
            return;
        }
        this.__selItemUserData = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemUserData' });
    }
    /** @returns The last interacted item's user data, or `null`. */
    getSelectedItemUserData() { return this.__selItemUserData; }
    /**
     * Updates the full-selection output. A non-array (or `null`) clears it.
     * Raises `onPropertyChanged` on change.
     * @param valueNew New selection entries, or `null` to clear.
     */
    setSelectedItems(valueNew) {
        const v = TcHmi.ValueConverter.toObject(valueNew);
        const arr = Array.isArray(v) ? v : null;
        if (tchmi_equal(arr, this.__selItems)) {
            return;
        }
        this.__selItems = arr;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItems' });
    }
    /** @returns The full current selection, or `null` when nothing is selected. */
    getSelectedItems() { return this.__selItems; }
    // ---------------------------------------------------------------
    //  Derived-state rebuilds
    //  Each rebuild maps this control's bound data model into engine models and
    //  pushes them through the base's protected scene API; the model building
    //  itself is pure and lives in the engine, which also owns the canvas draw
    //  and hit-test that consume these models.
    // ---------------------------------------------------------------
    /**
     * Rebuilds the cached render-ready items from the bound layout - schema
     * {@link Item}[] -> engine {@link ItemModel}[] via `itemsToModels` (the
     * per-geometry `Path2D` authoring, the combined-geometry rotation centers and
     * bbox, and the orientation carried through without `ORIENT_SIGN`) - then
     * re-syncs the scene; a null/empty layout caches an empty list. The two-tier
     * z-order is applied by the engine at draw time, not here. A new layout
     * invalidates the previous selection, so the selection outputs are cleared.
     */
    __rebuildItems() {
        this.__itemModels = this.__items ? itemsToModels(this.__items) : [];
        this.__setSelectedOutputs(null);
        this.setSelectedItems(null);
        this.__syncScene();
    }
    /**
     * Rebuilds the `item_id -> status` override map from the assignment list and
     * re-syncs the scene. The pushed status resolver (see {@link __syncScene})
     * reads the live {@link __statusMap}, and the item models are cached, so a
     * status update re-colors without rebuilding any geometry. The single-value
     * selection outputs are not re-derived here, so reassigning the status of an
     * already-selected item does not retroactively change its reported status.
     */
    __rebuildStatusMap() {
        this.__statusMap = buildStatusMap(this.__itemStatusAssignments);
        this.__syncScene();
    }
    /**
     * Rebuilds the render-ready labels from the bound label list (each box ->
     * data-frame millimeters via the engine's `labelsToModels`) and pushes them
     * to the engine scene together with the current `ShowLabels` state. Labels are
     * independent of the item/outline real-vs-demo choice, so this pushes them
     * directly rather than through {@link __syncScene} (a status update must not
     * rebuild labels, and a label edit must not rebuild items).
     */
    __rebuildLabels() {
        this.__updateLabels(labelsToModels(this.__labels), this.__showLabels);
    }
    /**
     * Resolves the six Origin attributes into the engine-ready placement scalars
     * and pushes them to the base: the metre-based offsets are converted to
     * millimetres through the current prefix (via the engine's `toMillimeters`) and
     * the rotation from degrees to radians; the anchor and Y-axis direction pass
     * through as their validated enums. The base stores these for
     * {@link SubstrateMapBase.__computeMatrices}, so the engine's D2S sees numbers
     * only - never attribute state. Like {@link __rebuildLabels} this only pushes;
     * the callers (the Origin setters and {@link __attach}) request the render.
     */
    __syncPlacement() {
        this.__updatePlacement(this.__originLocation, toMillimeters(this.__originOffsetX, this.__originOffsetPrefix), toMillimeters(this.__originOffsetY, this.__originOffsetPrefix), this.__originRotation * Math.PI / 180, this.__yAxisDirection);
    }
    /**
     * Resolves the `MapRotation` attribute (degrees) to the engine-ready view
     * rotation (radians, CCW-positive on screen) and pushes it to the base, which
     * stores it for {@link SubstrateMapBase.__computeMatrices} - so the engine's `W`
     * sees a number only, never attribute state. Like {@link __syncPlacement} this
     * only pushes; the callers (the {@link setMapRotation} setter and
     * {@link __attach}) request the render.
     */
    __syncViewRotation() {
        this.__updateViewRotation(this.__mapRotation * Math.PI / 180);
    }
    /**
     * Rebuilds the cached render-ready outline from the bound outline via the
     * engine's `buildOutlineModel` - a closed `Path2D` in the substrate frame S
     * plus the bbox that defines the fit box and the origin anchors - then
     * re-syncs the scene. An unset, invalid or degenerate outline caches `null`.
     */
    __rebuildOutline() {
        this.__outlineModel = buildOutlineModel(this.__outline);
        this.__refitAfterOutlineChange();
    }
    /**
     * A change to the fit box - the bound {@link setOutline} or the
     * {@link setOutlinePreset} model - moves where an UNSCALED grid must be fit
     * (decision E-9a; the fit box is `__outlineModel ?? __presetOutlineModel`, and
     * {@link __commitGrid} bakes the fit into the placement at COMMIT time). If the
     * outline is set AFTER the map was committed - which attribute order in a .view
     * makes routine - the grid would otherwise keep the placement it was committed
     * with (nominal unit pitch, letterboxed to the panel) and never pick up the
     * outline, so it renders far too large. Re-committing the bound map recomputes
     * that fit; the parsed document / grid input is retained (the E142 doc is
     * cached), so this only re-runs placement + fit, not parsing. A SCALED grid
     * re-commits to the same physical placement, so this is a no-op for it beyond a
     * repaint. With nothing bound, just re-sync the scene.
     */
    __refitAfterOutlineChange() {
        if (this.__activeInput !== null) {
            this.__rebuildMap();
        }
        else {
            this.__syncScene();
        }
    }
    /**
     * Regenerates (or clears) the cached preset outline model from
     * {@link __outlinePreset}, {@link __secDir} and {@link __notchScale} via the
     * engine's {@link generatePresetOutline} + {@link buildOutlineModel}, then
     * re-syncs the scene. A `'none'` preset caches `null`. Called whenever the
     * preset key or either of its two modifier attributes changes; safe to call
     * with a bound outline present, since {@link __activeModel} still prefers the
     * explicit outline.
     */
    __rebuildPreset() {
        this.__presetOutlineModel = this.__outlinePreset === 'none'
            ? null
            : buildOutlineModel(generatePresetOutline(this.__outlinePreset, this.__secDir, this.__notchScale));
        this.__refitAfterOutlineChange();
    }
    /**
     * Regenerates (or clears) the cached demo bundle from {@link __showDemoItems}
     * and re-syncs the scene. When enabled, {@link buildDemo} produces the demo
     * outline + items + mapping through the engine's real builders; when disabled,
     * the bundle is `null`. {@link __syncScene} then selects the demo (via
     * {@link __activeModel}) only when no real outline and no real items are bound,
     * so this is safe to call whether or not real data is present. Mirrors
     * ComponentMap's `__rebuildDemo`.
     */
    __rebuildDemo() {
        this.__demo = this.__showDemoItems ? buildDemo() : null;
        this.__syncScene();
    }
    // ---------------------------------------------------------------
    //  Active model + scene sync
    // ---------------------------------------------------------------
    /**
     * Selects the active render model over the CACHED built models (no rebuild):
     * the real items and outline when EITHER is bound, otherwise the demo bundle
     * when {@link __showDemoItems} is enabled, otherwise nothing.
     *
     * Precedence (CONTEXT: explicit Outline > OutlinePreset > demo > nothing):
     *  - Real branch when an explicit outline, a preset outline OR real items are
     *    bound. The active substrate body is the explicit outline when bound, else
     *    the preset outline (`__outlineModel ?? __presetOutlineModel`); real items,
     *    when bound, draw over whichever is active. When only items are bound (no
     *    outline, no preset) the outline model is `null`; the engine then fits the
     *    canvas to the items' combined bbox and draws no substrate body. Status is
     *    resolved through {@link __effectiveStatus} (assignment override over
     *    embedded) against the bound {@link __statusColorMapping}.
     *  - Demo branch when neither a real outline, a preset outline, nor real items
     *    are bound and the demo is enabled: the cached demo outline + items, colored
     *    by each item's embedded status against the DEMO mapping. The demo is
     *    self-contained (real assignments do not recolor it, and its statuses are
     *    the `BIN_*` keys the demo mapping defines); its items carry ids, so the
     *    base's hit-test path selects them and reports real values.
     * @returns The active model bundle, or `null` when there is nothing to draw.
     */
    __activeModel() {
        // Precedence (CONTEXT): explicit Outline > OutlinePreset > demo > nothing.
        // The active substrate body is the explicit outline when bound, else the
        // preset outline; real items (when bound) draw over whichever is active.
        const outlineModel = this.__outlineModel ?? this.__presetOutlineModel;
        if (outlineModel !== null || this.__itemModels.length > 0) {
            return {
                outlineModel,
                items: this.__itemModels,
                resolve: (item) => this.__effectiveStatus(item),
                mapping: this.__statusColorMapping,
            };
        }
        // Demo branch: only when neither a real outline, a preset outline, nor
        // real items are bound and the demo is enabled.
        if (this.__showDemoItems && this.__demo && !this.__mapBound()) {
            return {
                outlineModel: this.__demo.outlineModel,
                items: this.__demo.items,
                // Demo statuses are embedded BIN_* keys; resolve them directly (not
                // via assignment overrides) so the paint matches the demo mapping.
                resolve: (item) => item.status,
                mapping: this.__demo.mapping,
            };
        }
        return null;
    }
    /**
     * Pushes the {@link __activeModel} bundle (outline, items, status resolver and
     * color mapping) to the base scene and requests a render. Cheap: it selects
     * cached models and forwards references, so it is safe to call on every
     * status / mapping / demo-flag change. Labels are pushed separately by
     * {@link __rebuildLabels}.
     */
    __syncScene() {
        const model = this.__activeModel();
        this.__updateOutline(model ? model.outlineModel : null);
        this.__updateItems(model ? model.items : []);
        this.__updateStatusResolver(model ? model.resolve : null);
        // Color mapping: the DEMO carries its own palette (its `mapping` is a
        // distinct object); every other configuration - real items and/or a bound
        // grid - colors items AND grid cells through the bound StatusColorMapping
        // (the engine's resolveStatusColor and resolveBinColor share one map). So a
        // grid bound without any items still gets StatusColorMapping[binCode]
        // (task O6 item 9), which `model ? model.mapping : null` would have dropped.
        const mapping = (model !== null && model.mapping !== this.__statusColorMapping)
            ? model.mapping
            : this.__statusColorMapping;
        this.__updateColorMapping(mapping);
        this.__requestRender();
    }
    // ---------------------------------------------------------------
    //  Selection
    // ---------------------------------------------------------------
    /**
     * Resolves the effective status of an item model: a matching status
     * assignment (by `item_id`) wins over the status embedded in the item
     * layout. An id-less item can only use its embedded status. Closed over by
     * the status resolver pushed to the engine in {@link __rebuildStatusMap}.
     * @param item The item model to resolve.
     * @returns The effective status, or `null` if unknown.
     */
    __effectiveStatus(item) {
        if (item.id !== null) {
            const s = this.__statusMap.get(item.id);
            if (s !== undefined) {
                return s;
            }
        }
        return item.status;
    }
    /**
     * Pushes a selection (or its cleared state) to the read-only single-value
     * `Selected*` outputs (id / status / name / user data) that describe the last
     * interacted element. Driven from the base's {@link SelectedPayload}, whose
     * `status` is ALREADY the effective status (the pushed resolver applied any
     * assignment override), so the reported status matches the painted colour. The
     * membership array {@link getSelectedItems} is maintained separately (see
     * {@link __raiseSelected}). `null` clears all four outputs; the item id and
     * user data are `null` for an id-less item.
     * @param payload The selection payload, or `null` to clear the outputs.
     */
    __setSelectedOutputs(payload) {
        this.setSelectedItemId(payload ? payload.itemId : null);
        this.setSelectedItemStatus(payload ? payload.status : null);
        this.setSelectedItemName(payload ? payload.name : null);
        this.setSelectedItemUserData(payload ? payload.userData : null);
    }
    // ---------------------------------------------------------------
    //  SEMI E142 ingestion (task O6)
    //  Grid placement comes exclusively from the map data; the manual
    //  Origin*/YAxisDirection attributes keep governing Items and Labels only, and
    //  Outline / OutlinePreset are unchanged - the grid renders with or without an
    //  outline. A bound map counts as bound content and therefore suppresses the
    //  demo (item 6). All errors are non-fatal: they set E142LastError, are logged
    //  to the framework logger, and clear the grid.
    // ---------------------------------------------------------------
    /** Whether any map input (E142MapData / E142TransferData / GridData) is bound (independently of whether it rendered). Suppresses the demo (task O6 item 6). */
    __mapBound() {
        return this.__e142MapData !== null || this.__e142TransferData !== null || this.__gridData !== null;
    }
    /**
     * Fixed precedence used ONLY to break the tie when the active input is
     * unbound while others remain bound (see {@link __fallbackActiveInput}). It is
     * not a general priority: a non-null write always makes THAT input active
     * (most-recently-written-wins). E142MapData is the primary, most-explicit
     * document binding; the E142.4 transfer path is the same document over a
     * different transport; GridData is the compact alternative.
     */
    static __INPUT_PRECEDENCE = ['xml', 'transfer', 'grid'];
    /**
     * Whether the named input slot currently holds a non-null value.
     * @param which The input slot.
     * @returns `true` when that slot is bound.
     */
    __inputBound(which) {
        switch (which) {
            case 'xml': return this.__e142MapData !== null;
            case 'transfer': return this.__e142TransferData !== null;
            case 'grid': return this.__gridData !== null;
            default: {
                const _never = which;
                return _never;
            }
        }
    }
    /**
     * The highest-precedence still-bound input (see {@link __INPUT_PRECEDENCE}),
     * or `null` when nothing is bound. Called after the active input has been set
     * to `null`, so it naturally excludes it.
     * @returns The fallback active input, or `null`.
     */
    __fallbackActiveInput() {
        for (const k of SubstrateMap.__INPUT_PRECEDENCE) {
            if (this.__inputBound(k)) {
                return k;
            }
        }
        return null;
    }
    /**
     * Logs a warning when more than one map input is bound, naming all bound
     * inputs and which one is being rendered (the just-written, active one). The
     * inputs are mutually exclusive; binding more than one at a time is a wiring
     * mistake, not a supported mode.
     * @param active The input that was just made active.
     */
    __warnIfMultipleInputs(active) {
        const bound = [];
        if (this.__inputBound('xml')) {
            bound.push('E142MapData');
        }
        if (this.__inputBound('transfer')) {
            bound.push('E142TransferData');
        }
        if (this.__inputBound('grid')) {
            bound.push('GridData');
        }
        if (bound.length > 1) {
            TcHmi.Log.warn(this.__id + ': multiple map inputs are bound (' + bound.join(', ') +
                '); they are mutually exclusive. Rendering ' + SubstrateMap.__inputDisplayName(active) +
                ' (most recently written).');
        }
    }
    /**
     * The attribute display name of an input slot, for log messages.
     * @param which The input slot.
     * @returns The attribute name.
     */
    static __inputDisplayName(which) {
        switch (which) {
            case 'xml': return 'E142MapData';
            case 'transfer': return 'E142TransferData';
            case 'grid': return 'GridData';
            default: {
                const _never = which;
                return _never;
            }
        }
    }
    /**
     * Normalises a raw {@link setE142TransferData} value to the stored form:
     * a base64 `string`, a `number[]` of byte values (defensively copied), or
     * `null`. Byte-range and base64 validity are NOT checked here - they surface
     * as {@link getE142LastError} when the bytes are decoded, mirroring how
     * {@link setE142MapData} defers XML validity to the parse.
     * @param value The raw attribute value.
     * @returns The normalised transfer input.
     */
    static __normalizeTransferInput(value) {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value === 'string') {
            return value;
        }
        if (Array.isArray(value)) {
            return value.slice();
        }
        return null;
    }
    /**
     * The E-9 stage-2 fallback pitch, or `undefined` when it does not apply (both
     * X and Y must be set); warns when exactly one is set, in which case the fit
     * heuristic (stage 3) is used instead.
     * @returns The fallback pitch in millimetres, or `undefined`.
     */
    __fallbackStep() {
        const x = this.__e142FallbackStepX;
        const y = this.__e142FallbackStepY;
        if (x !== null && y !== null) {
            return { xMm: x, yMm: y };
        }
        if (x !== null || y !== null) {
            TcHmi.Log.warn(this.__id + ': only one of E142FallbackStepSizeX/Y is set; both are required to define a physical pitch. Using the fit heuristic (nominal, not physical, sizes).');
        }
        return undefined;
    }
    /**
     * Rebuilds the map from the active input. A document input (XML string or the
     * decoded E142.4 transfer bytes) re-parses only when the cached parse is stale
     * - a fresh XML string, fresh transfer bytes or a new active input null it -
     * so overlay / fallback / offset changes reuse the parse (task O6 item 3), and
     * an overlay change never re-decodes the transfer bytes. No active input
     * clears the map and restores the demo behaviour.
     */
    __rebuildMap() {
        switch (this.__activeInput) {
            case null:
                this.__clearMap();
                return;
            case 'grid':
                if (this.__gridData === null) {
                    this.__clearMap();
                    return;
                }
                this.__buildFromGrid(this.__gridData);
                return;
            case 'xml':
                if (this.__e142Doc === null) {
                    if (this.__e142MapData === null) {
                        this.__clearMap();
                        return;
                    }
                    try {
                        const res = parseE142Xml(this.__e142MapData);
                        this.__e142Doc = res.doc;
                        this.__logWarnings(res.warnings);
                    }
                    catch (e) {
                        this.__applyMapError(this.__describeError(e));
                        return;
                    }
                }
                this.__buildFromDoc(this.__e142Doc);
                return;
            case 'transfer':
                if (this.__e142Doc === null) {
                    if (this.__e142TransferData === null) {
                        this.__clearMap();
                        return;
                    }
                    // O7 default path: bytes -> encoding sniff -> string, then the
                    // EXISTING XML pipeline verbatim (parseE142Xml). The two steps
                    // are visible here on purpose; E142Item.decodeE142Item bundles
                    // the same two as the documented non-document-payload seam and
                    // is intentionally not on this path.
                    let xml;
                    try {
                        const decoded = decodeItemText(this.__e142TransferData);
                        this.__logWarnings(decoded.warnings);
                        xml = decoded.text;
                    }
                    catch (e) {
                        this.__applyMapError(this.__describeError(e));
                        return;
                    }
                    try {
                        const res = parseE142Xml(xml);
                        this.__e142Doc = res.doc;
                        this.__logWarnings(res.warnings);
                    }
                    catch (e) {
                        this.__applyMapError(this.__describeError(e));
                        return;
                    }
                }
                this.__buildFromDoc(this.__e142Doc);
                return;
            default: {
                const _never = this.__activeInput;
                return _never;
            }
        }
    }
    /**
     * Resolves the overlay and layout from a parsed document, then builds the grid
     * and identity. Overlay selection: the first renderable BinCodeMap overlay
     * across the document's SubstrateMaps in document order (decision E-5, null
     * name), or the first renderable one whose MapName matches
     * {@link getE142OverlayName}. A named overlay that exists but is not a
     * BinCodeMap, and a missing name, are reported errors. A dangling / absent
     * LayoutSpecifier is NOT an error (the official SEMI example is layoutless):
     * the layout then comes from the payload dimensions.
     * @param doc The parsed E142 document.
     */
    __buildFromDoc(doc) {
        const want = this.__e142OverlayName;
        let header = null;
        let overlay = null;
        let chosenSm = null;
        let sawName = false;
        for (const sm of doc.substrateMaps) {
            for (const ov of sm.overlays) {
                const renderable = ov.payload !== undefined;
                if (want === null) {
                    if (renderable) {
                        header = sm.header;
                        overlay = ov;
                        chosenSm = sm;
                        break;
                    }
                }
                else if (ov.mapName === want) {
                    sawName = true;
                    if (renderable) {
                        header = sm.header;
                        overlay = ov;
                        chosenSm = sm;
                        break;
                    }
                }
            }
            if (overlay !== null) {
                break;
            }
        }
        if (header === null || overlay === null || overlay.payload === undefined) {
            this.__applyMapError(want === null
                ? 'no renderable BinCodeMap overlay in the E142 document'
                : sawName
                    ? "overlay '" + want + "' is not a BinCodeMap (nothing to render)"
                    : "no overlay named '" + want + "' in the E142 document");
            return;
        }
        const resolved = resolveLayoutSpecifier(doc, header.layoutSpecifier);
        if (resolved instanceof E142Error) {
            this.__applyMapError(this.__describeError(resolved));
            return;
        }
        const layout = resolved !== null ? resolved : dimsFromPayload(overlay.payload);
        const sub = this.__matchSubstrate(doc, header);
        this.__commitGrid(header, layout, overlay.payload, overlay.binDefinitions ?? null, overlay.binCodeMapMeta?.binType ?? 'Ascii', overlay.referenceDevices, header.substrateId, sub ? sub.lotId ?? null : null, sub ? sub.goodDevices ?? null : null);
        // DeviceIdMap -> cell index (decision E-6b): after a successful commit,
        // index a DeviceIdMap overlay from the SAME SubstrateMap (shared frame).
        if (this.__sceneGrid !== null && chosenSm !== null) {
            this.__deviceIdIndex = this.__buildDeviceIdIndex(chosenSm.overlays, header);
        }
    }
    /**
     * Builds the cell (serialization linear index) -> device-id map from the
     * FIRST `DeviceIdMap` overlay among `overlays` (decision E-6b). Each `<Id>`
     * entry's logical `X`/`Y` is mapped to a serial cell through the same frame
     * the grid uses ({@link mapCoordToIndex}); entries that carry no `X`/`Y`
     * (LID-only or address-less, A6.3 [C]) or whose coordinate lands off this
     * grid cannot be placed and are counted into one aggregated warning. Returns
     * `null` when no DeviceIdMap overlay is present or it yields no placeable id.
     * @param overlays The chosen SubstrateMap's overlays.
     * @param header   The map header (frame).
     * @returns The cell -> id map, or `null`.
     */
    __buildDeviceIdIndex(overlays, header) {
        const grid = this.__sceneGrid;
        if (grid === null) {
            return null;
        }
        const src = overlays.find((ov) => ov.deviceIdEntries !== undefined && ov.deviceIdEntries.length > 0);
        if (src === undefined || src.deviceIdEntries === undefined) {
            return null;
        }
        const index = new Map();
        let unplaceable = 0;
        for (const e of src.deviceIdEntries) {
            if (e.x === undefined || e.y === undefined) {
                unplaceable++;
                continue;
            }
            const { serCol, serRow } = mapCoordToIndex(e.x, e.y, header.originLocation, header.axisDirection, grid.cols, grid.rows);
            if (!(serCol >= 0 && serCol < grid.cols && serRow >= 0 && serRow < grid.rows)) {
                unplaceable++;
                continue;
            }
            index.set(serRow * grid.cols + serCol, e.deviceId);
        }
        if (unplaceable > 0) {
            this.__logWarnings([
                `E142_DEVICEID_UNPLACEABLE: ${unplaceable} DeviceIdMap <Id> entr${unplaceable === 1 ? 'y' : 'ies'} `
                    + `carried no on-grid X/Y (LID-only or off-grid) and ${unplaceable === 1 ? 'was' : 'were'} not indexed.`,
            ]);
        }
        return index.size > 0 ? index : null;
    }
    /**
     * Normalizes a GridData document, then builds the grid and identity from the
     * identity pass-through (task O6 items 2, 4).
     * @param gd The GridData document.
     */
    __buildFromGrid(gd) {
        let n;
        try {
            n = normalizeGridData(gd);
        }
        catch (e) {
            this.__applyMapError(this.__describeError(e));
            return;
        }
        this.__logWarnings(n.warnings);
        this.__commitGrid(n.header, n.resolvedLayout, n.payload, n.binDefs, gd.binType, [], // GridData carries no ReferenceDevices; registration is XML-only
        n.identity.substrateId ?? null, n.identity.lotId ?? null, n.identity.goodDevices ?? null);
    }
    /**
     * Shared tail for both input paths: computes the placement (with the E-8
     * offset and the E-9 fallback), fits it to the outline box when the map
     * carries no physical scale (E-9 stage 3; without an outline the lattice keeps
     * unit pitch and the shell self-fits it), builds the grid model and - on
     * success - pushes it, records the logical frame for selection, sets the
     * identity outputs and clears the error. A non-drawable payload is a reported
     * error that clears the grid.
     * @param header  The map header (orientation, origin, axes).
     * @param layout  The resolved (or layoutless) layout.
     * @param payload The decoded bin payload.
     * @param binDefs The bin definitions in E142 form, or `null`.
     * @param subId   Substrate id for the identity output, or `null`.
     * @param lotId   Lot id for the identity output, or `null`.
     * @param good    Good-device count for the identity output, or `null`.
     */
    __commitGrid(header, layout, payload, binDefs, binType, referenceDevices, subId, lotId, good) {
        // A new build supersedes any prior DeviceIdMap index; __buildFromDoc
        // rebuilds it after a successful XML commit, the GridData path leaves it null.
        this.__deviceIdIndex = null;
        const result = computeGridPlacement(header, layout, this.__e142OrientationOffset, this.__fallbackStep());
        this.__logWarnings(result.warnings.map((w) => w.code + ': ' + w.message));
        let placement = result.placement;
        if (!result.scaled) {
            // E-9a: no physical pitch. With an outline (explicit or preset), fit the
            // lattice to its bounding box (square cells, centered). Without one, keep
            // the unit-pitch placement and let the shell's fitBBox letterbox the grid
            // on its own. Either way the sizes are NOMINAL, not physical.
            const box = (this.__outlineModel ?? this.__presetOutlineModel)?.bbox;
            if (box) {
                placement = fitPlacementToBox(placement, payload.cols, payload.rows, box);
            }
        }
        // E-7 compute path (opt-in): translate the placement so reference-device
        // model cell-centres meet their stated Positions. Off unless enabled.
        if (this.__alignToReferenceDevices && referenceDevices.length > 0) {
            const reg = registerPlacementToReferenceDevices(placement, referenceDevices, header.originLocation, header.axisDirection, payload.cols, payload.rows, layout.unitsToMm);
            this.__logWarnings(reg.warnings.map((w) => w.code + ': ' + w.message));
            placement = reg.placement;
        }
        const grid = buildGridModel(placement, payload, binDefs ? binDefs.map(toEngineBinDefinition) : null);
        if (grid === null) {
            this.__applyMapError('the map payload does not describe a drawable lattice');
            return;
        }
        this.__mapFrame = { origin: header.originLocation, dir: header.axisDirection };
        this.__lastBuilt = {
            substrateType: String(header.substrateType),
            orientation: header.orientation,
            origin: header.originLocation,
            dir: header.axisDirection,
            binType,
            binDefs,
            substrateId: subId,
        };
        this.setE142LastError(null);
        this.__setMapIdentity(subId, lotId, good);
        this.__updateGrid(grid);
        // Re-evaluate the outline / items / demo choice around the new grid (the
        // demo is now suppressed because a map is bound).
        this.__syncScene();
    }
    /**
     * Finds the Substrate record matching a map header by the E142 SubstrateKey
     * (SubstrateType + SubstrateId), for the lot-id and good-device outputs, or
     * `null` when the document carries no matching Substrate.
     * @param doc    The parsed document.
     * @param header The chosen map header.
     * @returns The matching substrate, or `null`.
     */
    __matchSubstrate(doc, header) {
        for (const sub of doc.substrates) {
            if (sub.substrateType === header.substrateType && sub.substrateId === header.substrateId) {
                return sub;
            }
        }
        return null;
    }
    /**
     * Pushes the three map identity outputs and refreshes the identity label,
     * which shows {@link getMapSubstrateId} when the explicit SubstrateId is unset
     * and a map is bound (task O6 item 7).
     * @param subId Substrate id, or `null`.
     * @param lotId Lot id, or `null`.
     * @param good  Good-device count, or `null`.
     */
    __setMapIdentity(subId, lotId, good) {
        this.setMapSubstrateId(subId);
        this.setMapLotId(lotId);
        this.setMapGoodDevices(good);
        this.__updateIdentity();
    }
    /**
     * Reports a map-ingestion failure: sets {@link getE142LastError}, logs to the
     * framework logger, and clears the grid, the logical frame and the identity
     * outputs. The demo stays suppressed while a map is bound, so the canvas shows
     * only the outline / preset (if any).
     * @param message The error message.
     */
    __applyMapError(message) {
        this.setE142LastError(message);
        TcHmi.Log.error(this.__id + ': ' + message);
        this.__mapFrame = null;
        this.__setMapIdentity(null, null, null);
        this.__updateGrid(null);
        this.__syncScene();
    }
    /**
     * Clears all map state on unbind: drops the cached parse, the grid, the
     * logical frame, the identity outputs and the error. With no map bound the
     * demo behaviour is restored (task O6 verification).
     */
    __clearMap() {
        this.__e142Doc = null;
        this.__mapFrame = null;
        this.__lastBuilt = null;
        this.__deviceIdIndex = null;
        this.setE142LastError(null);
        this.__setMapIdentity(null, null, null);
        this.__updateGrid(null);
        this.__syncScene();
    }
    /**
     * Surfaces engine / domain warnings to the framework logger, one line each,
     * prefixed with the control id.
     * @param messages Human-readable warning lines.
     */
    __logWarnings(messages) {
        for (const m of messages) {
            TcHmi.Log.warn(this.__id + ': ' + m);
        }
    }
    /**
     * Renders a caught value into a stable one-line message for
     * {@link getE142LastError}: the machine code plus the message for the typed
     * domain errors, the message for a plain `Error`, else the stringified value.
     * @param e The caught value.
     * @returns The message.
     */
    __describeError(e) {
        if (e instanceof E142ParseError || e instanceof E142GridError || e instanceof E142Error || e instanceof E142ItemError) {
            return e.code + ': ' + e.message;
        }
        if (e instanceof Error) {
            return e.message;
        }
        return String(e);
    }
    /**
     * Converts a hit cell's SERIALIZATION indices to signed logical E142 map
     * coordinates via the domain module's {@link indexToMapCoord}, using the
     * active map's frame and the live grid dimensions, or `null` when no
     * E142 / GridData map is active.
     * @param col Serialization column (lattice column).
     * @param row Serialization row (lattice row).
     * @returns The signed logical (mapX, mapY), or `null`.
     */
    __cellMapCoord(col, row) {
        const grid = this.__sceneGrid;
        const frame = this.__mapFrame;
        if (grid === null || frame === null) {
            return null;
        }
        const m = indexToMapCoord(col, row, frame.origin, frame.dir, grid.cols, grid.rows);
        return { mapX: m.x, mapY: m.y };
    }
}
/*
 * Register Control class object for control.
 * `injectInGlobalObject` mirrors the shipped controls and exposes the class as
 * TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMap at runtime.
 */
TcHmi.Controls.registerEx('SubstrateMap', 'TcHmi.Controls.CNM_UIControls.SEMI', SubstrateMap, { injectInGlobalObject: true });
//# sourceMappingURL=SubstrateMap.js.map