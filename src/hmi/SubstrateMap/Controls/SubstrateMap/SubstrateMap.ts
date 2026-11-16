/**
 * @fileoverview
 * SubstrateMap - the flagship substrate control of this package.
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
 * MODULE MECHANISM: this control is an ES module that imports
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

import {
    SubstrateMapBase, SelectedPayload, formatAge, parseMapTimestamp, type AgeText, buildDemo,
} from '../SubstrateMapBase/SubstrateMapBase.js';
import {
    ItemList,
    ItemStatus,
    binSeverityTable,
    resolveBinColor,
    ItemModel,
    ItemStatusAssignmentList,
    SubstrateMapLabelList,
    Outline,
    OutlineModel,
    PathCommand,
    SecDir,
    PresetKey,
    MetricPrefix,
    OriginAnchor,
    YAxisDirection,
    PRESET_KEYS,
    PREFIXES,
    normStatus,
    toMillimeters,
    itemsToModels,
    binStatistics,
    buildStatusMap,
    labelsToModels,
    buildOutlineModel,
    generatePresetOutline,
    DecodedBinPayload,
    BinDefinition,
    buildGridModel,
    buildBinTable,
    GridModel,
    GridBinLayer,
    BinTableEntry,
    GridLayerError,
    type BinStatistics,
    resolveBinQuality,
    TOUCH_TARGET_DEFAULT_PX,
    TOUCH_TARGET_MIN_PX,
    cellsInGroup,
    deviceMatrix,
    groupTileRect,
    type SubstrateMapGroupSelection,
} from '../../Helpers/SubstrateMapEngine/Engine.js';
import { categoricalBinFallback, desaturate } from '../../Helpers/SubstrateMapEngine/BinPalette.js';
import { AGGREGATE_MIN_DELTA_E } from '../../Helpers/SubstrateMapEngine/GridAggregate.js';
import {
    E142Document,
    E142SubstrateMapHeader,
    E142SubstrateSide,
    E142AliasId,
    E142TransferMap,
    E142DeviceDataMap,
    E142Layout,
    E142Overlay,
    E142Substrate,
    E142BinDefinition,
    E142BinType,
    E142DeviceIdEntry,
    E142ReferenceDevice,
    E142OriginLocation,
    E142AxisDirection,
    ResolvedLayout,
    resolveLayoutSpecifier,
    selectMapAndOverlay,
    dimsFromPayload,
    computeGridPlacement,
    fitPlacementToBox,
    registerPlacementToReferenceDevices,
    indexToMapCoord,
    mapCoordToIndex,
    E142Error,
} from '../../Helpers/SubstrateMapEngine/E142.js';
import { pvToDisplayString, PvValue } from '../../Helpers/SubstrateMapEngine/E138Pv.js';
import { parseE142Xml, E142ParseError, gridToE142Xml } from '../../Helpers/SubstrateMapEngine/E142Xml.js';
import { normalizeGridData, E142GridError, GridData, NormalizedGridData, gridToGridData } from '../../Helpers/SubstrateMapEngine/E142Grid.js';
import { decodeItemText, E142ItemError } from '../../Helpers/SubstrateMapEngine/E142Item.js';
import { valueRampColors } from '../../Helpers/SubstrateMapEngine/Oklch.js';
import { parseE142Json } from '../../Helpers/SubstrateMapEngine/E142Json.js';

/** Fallback values for the input attributes (mirror `Description.json` defaultValueInternal). */
/**
 * The `data-tchmi-*` name of `ShowDemoItems`, as `Description.json` declares it.
 *
 * Needed because a setter has to tell an explicit write from the field default;
 * own `__attrs` whether the author wrote the attribute, and `__attrs` is keyed by
 * the markup name rather than the property name. A test asserts this string
 * against the descriptor, so a rename cannot leave it stale.
 */
const SHOW_DEMO_ITEMS_ATTRIBUTE = 'data-tchmi-show-demo-items';

/**
 * Which bound attribute the map is currently built from.
 *
 * A named alias rather than the literal union repeated at four signatures: adding
 * an input means every one of them has to change together, and a union spelled
 * out in five places is four chances to add the member to some of them only.
 */
type E142ActiveInput = 'xml' | 'json' | 'transfer' | 'grid' | null;

/** The spatial filters. `None` is the default and changes nothing. */
export type SpatialFilter = 'None' | 'Median' | 'Min' | 'Max' | 'Box' | 'Gauss';
/** Which channel the tile shows, and therefore what a filter would operate on. */
export type FieldView = 'Bins' | 'FailDensity' | 'ValueField';
/** How a reference map is compared against the bound one. */
export type ReferenceMode = 'Off' | 'Difference' | 'NewOnly';

/** The largest `SpatialFilterRadius`; beyond this a filter costs more than it tells. */
const FILTER_RADIUS_MAX = 8;

/**
 * Whether a filter and a channel may be used together.
 *
 * ---- THE PAIRING IS THE WHOLE POINT OF PHASE 3'S PREAMBLE ----
 *
 * `Median`, `Min` and `Max` are CATEGORICAL: they pick or order existing palette
 * indices, and the answer is always a real bin color. They need `Bins`.
 *
 * `Box` and `Gauss` AVERAGE, and an average of two bin indices is not a bin -
 * the mean of green and red is brown, and brown is not a category. They need a
 * scalar field, which is `FailDensity` or `ValueField`.
 *
 * A pure function so every pairing can be asserted without rendering, and so the
 * render path and the diagnostic cannot disagree about which are legal.
 * @param filter The filter.
 * @param view   The channel.
 * @returns Whether the pair is legal.
 */
export function filterApplies(filter: SpatialFilter, view: FieldView): boolean {
    if (filter === 'None') { return true; }
    if (filter === 'Box' || filter === 'Gauss') { return view !== 'Bins'; }
    return view === 'Bins';
}

const DEFAULTS = {
    substrateId: null as string | null,
    identityPosition: 'below',
    showDemoItems: true,
    showLabels: true,
    selectionMode: 'single' as 'single' | 'multi',
    outlinePreset: 'none' as PresetKey,
    secDir: 'cw' as SecDir,
    notchExaggeration: 12,
    originLocation: 'center' as OriginAnchor,
    originOffsetX: 0,
    originOffsetY: 0,
    originOffsetPrefix: 'milli' as MetricPrefix,
    originRotation: 0,
    yAxisDirection: 'up' as YAxisDirection,
    showOriginMarker: false,
    mapRotation: 0,
    e142OrientationOffset: 0,
};

/** Valid values for the substrate identity position attribute. */
const POSITIONS: string[] = ['above', 'below', 'none'];

/** Valid values for the selection-mode attribute. */
const SELECTION_MODES: string[] = ['single', 'multi'];

/** Valid values for the `OriginLocation` attribute (anchor on the fit box). */
const ORIGIN_LOCATIONS: string[] = ['center', 'top-left', 'bottom-left', 'top-right', 'bottom-right'];

/** Valid values for the `YAxisDirection` attribute. */
const Y_AXIS_DIRECTIONS: string[] = ['up', 'down'];

/**
 * A tiny, self-contained {@link GridData} document for smoke-testing the E142
 * grid path. Exported but NOT auto-bound: bind it to the
 * `GridData` attribute - e.g. from an internal symbol seeded with this value, or
 * `SubstrateMap.setGridData(DEMO_GRID_DATA)` from a code-behind - to render a
 * 4x3 bin grid through the SAME pipeline as a real map. It is layout-full (2 mm
 * pitch), so it renders at PHYSICAL size; bins `1`/`0` map to pass/fail via
 * `binDefinitions`, and `.` is the null cell. The identity fields feed the
 * MapSubstrateId / MapLotId / MapGoodDevices outputs.
 */
export const DEMO_GRID_DATA: GridData = {
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

/**
 * One entry of the read-only {@link SubstrateMap.getSelectedItems} output.
 * Mirrors the `SubstrateMapSelectionList` item schema. Because grid cell
 * indices and item ids can collide numerically, every entry carries its
 * `kind`; `user_data` is `null` for grid cells.
 */
export interface SelectionEntry {
    /** Discriminates the selected element: an item geometry or a grid cell. */
    kind: 'item' | 'cell';
    /** Id of the selected element: the `item_id` for items, the cell index for grid cells. */
    item_id: number;
    /** Resolved status / bin of the selected element, or `null`. */
    status: string | null;
    /** Name of the selected element, or `null`. */
    name: string | null;
    /** Opaque `user_data` of the selected item, passed through unchanged; `null` for grid cells. */
    user_data: string | number | null;
    /**
     * Bin quality of a selected CELL as the source declared it (a free string),
     * `null` when the source declared none. Absent for item entries. Present only
     * on `kind: 'cell'` rows.
     */
    binQuality?: string | null;
    /**
     * Signed logical E142 map X of a selected CELL, via the domain module's
     * `indexToMapCoord`. Absent for item entries and when no map frame is known.
     */
    mapX?: number;
    /** Signed logical E142 map Y of a selected CELL (see {@link mapX}). */
    mapY?: number;
    /**
     * Device id of a selected CELL, looked up from a `DeviceIdMap` overlay by the
     * cell's logical coordinate. `null` when the map carries no
     * DeviceIdMap or that cell has no `<Id>` entry. Absent for item entries.
     */
    deviceId?: string | null;
    /**
     * Location identifier of a selected CELL, from `BinCode/@LID`. `null` when
     * the map names no location for that cell. Absent for item entries.
     *
     * NOT the same thing as {@link deviceId}, and the difference is normative.
     * E142-0225 13.4: "A location identifier is distinct from the DeviceId
     * (identifier on the device) that might be placed in that position. The
     * location identifier is still present when the device is removed."
     * `lid` names the socket; `deviceId` names whatever is
     * currently sitting in it. A view that shows one where it means the other
     * will be right until the first time a device is moved.
     *
     * Opaque - never trimmed, never case-folded, because it is a join key. An
     * EMPTY STRING is a legal zero-length LID and is not `null`.
     */
    lid?: string | null;
    /**
     * `SubstrateType` of the substrate this cell's device came FROM. `null` when
     * the map carries no transfer covering this cell. Absent for item entries.
     *
     * Reported alongside {@link fromSubstrateId} because an id alone is HALF A
     * KEY: `SubstrateMapKey` is an `xs:key` over (`@SubstrateType`,
     * `@SubstrateId`, `@LayoutSpecifier`), so nothing stops one
     * document carrying a `Wafer` and a `TnR` with the same id. The pair is what
     * a view should display; the third field is a within-substrate path and is
     * available on the model for a caller that needs the full key.
     */
    fromSubstrateType?: string | null;
    /**
     * `SubstrateId` of the substrate this cell's device came from - the R2-3
     * traceability path. `null` when no transfer covers this cell.
     *
     * This and the three fields below come from a `TransferMap` overlay: E142
     * §13.9 and R2-3 make `TransferMap` the substrate-to-substrate traceability
     * mechanism, and R2-3.2.2 describes the wafer -> tape -> target chain it
     * records. The source is named once per MAP; the per-device end is
     * {@link fromX} / {@link fromY} or {@link fromLid}.
     */
    fromSubstrateId?: string | null;
    /**
     * Logical X on the SOURCE substrate (`T/@FX`). `null` when no transfer covers
     * this cell, or when that transfer addressed its source end by name rather
     * than by coordinate - each END of a transfer is addressed independently.
     */
    fromX?: number | null;
    /** Logical Y on the source substrate (`T/@FY`). See {@link fromX}. */
    fromY?: number | null;
    /**
     * Location identifier on the SOURCE substrate (`T/@FID`) - a tape pocket, in
     * the R2-3.2.2 case. `null` when no transfer covers this cell, or when that
     * transfer addressed its source end by coordinate. Exactly one of
     * `fromX`/`fromY` and `fromLid` is non-null for a covered cell.
     */
    fromLid?: string | null;
    /**
     * Parameter readings for a selected CELL, from a `DeviceDataMap` overlay.
     * `null` when the map carries none, or none covers this cell. Absent for
     * item entries.
     *
     * Each entry carries the rendered `value` AND the `raw` {@link PvValue}. The
     * event payload carries only the rendered form - a display string is what a
     * view binds to - but a programmatic consumer needs the tree: an `Arr` of
     * `Su` reads as `[(23, 57), (25, 63)]`, which is legible and useless to code.
     */
    deviceData?: DeviceReading[] | null;
    /**
     * Every composed overlay's bin for this CELL, base first, in the
     * `E142Overlays` order. Absent for item entries; absent, not empty, when the
     * map is not composed.
     *
     * THE BASE IS INCLUDED, deliberately. A consumer listing "all judgements
     * about this die" wants all of them, and should not have to special-case the
     * one that happens to be rendering. `binCode` on this same entry remains the
     * BASE's, unchanged - see `ws/notes/DECISION-overlay-composition.md` 4 on why
     * that field could not become an array.
     *
     * A layer that says nothing about this cell is LISTED with
     * `binCode: null`. Omitting it would be ambiguous with "there is no such
     * overlay", the same distinction the E138 value model draws between
     * `xsi:nil`, `NoValue` and absence.
     */
    overlays?: Array<{ mapName: string; mapVersion: string; binCode: string | null; binQuality: string | null }> | null;
}

/**
 * Renames an E142 bin definition ({@link E142BinDefinition}: `binCode` /
 * `binQuality`) into the engine's {@link BinDefinition} (`code` / `quality` /
 * `pick`) for {@link buildGridModel}. A pure FIELD RENAME between two engine
 * types - the one mapping the GridData/XML result contracts leave to the layer
 * that owns the engine's render types (see E142Grid's NormalizedGridData note).
 *
 * EXPORTED because the tile needs the same rename and a second copy
 * of a field rename is a second place for the field names to drift apart. It
 * lives here rather than in the engine for the reason the doc above gives: the
 * engine's contracts deliberately leave this mapping to the layer that owns the
 * render types.
 * @param d The E142 bin definition.
 * @returns The engine bin definition.
 */
export function toEngineBinDefinition(d: E142BinDefinition): BinDefinition {
    return { code: d.binCode, quality: d.binQuality, pick: d.pick };
}

/**
 * Which face the operator wants to look at.
 *
 * `follow-map` renders the map as seen from the face it describes - today's
 * behavior, now nameable. The two side values ask for a specific face, and a
 * mirror is applied only when the map describes the OTHER one.
 */
type ViewSubstrateSide = 'follow-map' | E142SubstrateSide;

/**
 * One entry of the `E142Overlays` list: an overlay to compose, and its part.
 *
 * Mirrors `SubstrateMapOverlayList` in
 * `Schema/TypeDefinitions/E142OverlayList.Schema.json`.
 */
interface OverlaySpec {
    /** `Overlay/@MapName`. Required - half of `OverlayKey`, and there is no default. */
    name: string;
    /**
     * `Overlay/@MapVersion`, or absent to match any.
     *
     * ABSENT AND `''` ARE DIFFERENT, the same distinction
     * {@link setE142OverlayVersion} draws: `MapVersion` has an XSD default of `''`, so
     * `version: ''` selects overlays that state no version, while an absent key
     * does not filter on version at all.
     */
    version?: string;
    /**
     * `'base'` owns the geometry, the selection and the bin codes a tap reports;
     * `'decoration'` contributes per-cell marks only; `'valueField'` replaces the
     * fill with a ramp over that overlay's own bin table.
     */
    role?: 'base' | 'decoration' | 'valueField';
}

/**
 * One parameter reading for a cell: the name from the `DeviceDataMap`'s
 * `Parameter` list, the value from the `DeviceData` at the same INDEX.
 *
 * Table 19 makes that index the whole binding: "The order of values shall match
 * the order of parameters listed in the DeviceDataMap's Parameter attribute."
 * The values carry no names of their own, so this join is positional and nothing
 * else could make it.
 */
interface DeviceReading {
    /** `Parameter/@Name`. Empty when the document gave none - see prose/schema #6. */
    name: string;
    /** The value rendered for a human by `pvToDisplayString`. */
    value: string;
    /** The value itself, for a consumer that needs the tree rather than the text. */
    raw: PvValue;
}

/**
 * Where the device now in a cell came FROM, assembled from the map's
 * `TransferMap` overlays.
 *
 * The three `from*` fields are the source substrate, copied from the
 * `TransferMap` that carried this move - the source is named per MAP, not per
 * `<T>`, so every transfer in one map shares them. `fx` / `fy` / `fid` are the
 * source END of the move, and only one form is present: each end of a transfer
 * is addressed independently, by a coordinate pair OR by an identifier
 * (E142-0225 Figure R2-22).
 */
interface TransferOrigin {
    /** `TransferMap/@FromSubstrateType`. */
    fromSubstrateType: string;
    /** `TransferMap/@FromSubstrateId`. */
    fromSubstrateId: string;
    /** `TransferMap/@FromSubstrateLayoutSpecifier`. */
    fromLayoutSpecifier: string;
    /** `T/@FX` - source logical X, when the source end is addressed by coordinate. */
    fx?: number;
    /** `T/@FY` - source logical Y. */
    fy?: number;
    /** `T/@FID` - source location identifier, when the source end is addressed by name. */
    fid?: string;
}

/**
 * The `Substrate` record facts a built map carries, as one value.
 *
 * One record rather than positional parameters on {@link SubstrateMap.__commitGrid}:
 * five adjacent `string | null` arguments is a
 * transposition waiting to happen - swapping `lotId` and `supplierName` compiles
 * cleanly and mislabels data all the way into an exported document - so they are
 * one object instead. The XML path fills it from the matched `Substrate`
 * (`SubstrateKey` = SubstrateType + SubstrateId); the GridData path fills what
 * its own contract carries and leaves the rest `null`.
 */
interface SubstrateMapIdentity {
    /** `Substrate/@SubstrateId`. */
    substrateId: string | null;
    /** `Substrate/LotId` (`LotIdType`, maxLength 80). */
    lotId: string | null;
    /** `Substrate/GoodDevices` (`xs:nonNegativeInteger`). */
    goodDevices: number | null;
    /** `Substrate/SupplierName`. GridData has no counterpart - always `null` there. */
    supplierName: string | null;
    /** `Substrate/Status`. GridData has no counterpart - always `null` there. */
    status: string | null;
    /** `Substrate/AliasIds`. XML only. */
    aliasIds: readonly E142AliasId[] | null;
    /** `Substrate/CarrierType`. XML only. */
    carrierType: string | null;
    /** `Substrate/CarrierId`. XML only. */
    carrierId: string | null;
    /** `Substrate/SlotNumber`. XML only. */
    slotNumber: number | null;
    /** `Substrate/SubstrateNumber`. XML only. */
    substrateNumber: number | null;
    /**
     * `SubstrateMap/@SubstrateSide` of the built map.
     *
     * A header field rather than a `Substrate` child, carried here so it clears
     * with the rest of the identity on an error instead of surviving as a stale
     * claim about a map that is no longer shown.
     */
    substrateSide: E142SubstrateSide | null;
}

/**
 * The identity of "no map": every output `null`.
 *
 * One frozen value rather than a literal at each reset site, so a field added to
 * {@link SubstrateMapIdentity} cannot be forgotten in one of them - the compiler
 * reports it here once instead of leaving a stale output behind after an error.
 */
const NO_IDENTITY: SubstrateMapIdentity = Object.freeze({
    substrateId: null,
    lotId: null,
    goodDevices: null,
    supplierName: null,
    status: null,
    aliasIds: null,
    carrierType: null,
    carrierId: null,
    slotNumber: null,
    substrateNumber: null,
    substrateSide: null,
});

/**
 * The layout the `LayoutSpecifier` path ends at, or `null` when it names none.
 *
 * {@link resolveLayoutSpecifier} returns the RESOLVED geometry - dims, pitch,
 * cell, accumulated anchor - which is what placement needs and is deliberately
 * not the layout node. Serializing the layout's own children (`LowerLeft`, `Z`,
 * `TopImage`, `BottomImage`, `ProductId`, `Package`) needs the node itself, so
 * the last path segment is looked up directly. Same walk, different question.
 *
 * @param doc    The parsed document.
 * @param header The chosen map's header, carrying the specifier.
 * @returns The deepest layout on the path, or `null`.
 */
function sourceLayoutOf(doc: E142Document, header: E142SubstrateMapHeader): E142Layout | null {
    const segments = header.layoutSpecifier.split('/').map((x) => x.trim()).filter((x) => x !== '');
    if (segments.length === 0) { return null; }
    const leafId = segments[segments.length - 1];
    return doc.layouts.find((l) => l.layoutId === leafId) ?? null;
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
    protected __substrateId: string | null = DEFAULTS.substrateId;
    /** Whether to show the demo items when no real items are bound. */
    protected __showDemoItems: boolean = DEFAULTS.showDemoItems;
    /** Whether the labels are enabled. */
    protected __showLabels: boolean = DEFAULTS.showLabels;
    /** Bound item layout (authored in the data frame D), or `null`. */
    protected __items: ItemList | null = null;
    /** Bound per-item status overrides, or `null`. */
    protected __itemStatusAssignments: ItemStatusAssignmentList | null = null;
    /** Bound status -> CSS color map, or `null`. */
    protected __statusColorMapping: Record<string, string> | null = null;
    /**
     * Author `BinQuality` token -> `pass` / `fail`, or `null`.
     *
     * E142-0225 reserves exactly two values and says *"Other values defined by an
     * application"*, so a document may legally carry any token at all. This is where
     * an author declares what theirs mean.
     */
    protected __binQualityAliases: Record<string, string> | null = null;
    /**
     * Tokens already reported by {@link __warnUnmappedBinQualities}, so a rebuild
     * that changes nothing relevant does not repeat itself.
     *
     * Cleared whenever the aliases change: the same token becomes newsworthy again
     * if the map that failed to cover it has been edited.
     */
    protected __binQualityWarned: Set<string> = new Set();
    /**
     * Bin codes in severity order, **most severe first**, or `null`.
     *
     * Consumed by `binSeverity` when aggregation reduces a tile, so it decides
     * which code an aggregated tile shows.
     */
    protected __binSeverityPriority: readonly string[] | null = null;
    // ---- the filter surface ----

    /** `SpatialFilter`. */
    protected __spatialFilter: SpatialFilter = 'None';
    /** `SpatialFilterRadius`, clamped to 0..8 device px. */
    protected __spatialFilterRadius: number = 1;
    /** `FieldView`. */
    protected __fieldView: FieldView = 'Bins';
    /** `FieldGamma`. */
    protected __fieldGamma: number = 0.4;
    /** `HighlightFromSeverity`, or `null` for no highlight. */
    protected __highlightFromSeverity: number | null = null;
    /** `ReferenceGridData`, or `null`. */
    protected __referenceGridData: GridData | null = null;
    /** `ReferenceMode`. */
    protected __referenceMode: ReferenceMode = 'Off';
    /**
     * Bumped whenever `ReferenceGridData` is replaced.
     *
     * The cache key needs a term that changes when the reference does, and the
     * reference is an arbitrarily large object - hashing it every frame would cost
     * more than the render it is protecting. A counter is exact for the only way
     * the value ever changes, which is wholesale replacement by a binding.
     */
    protected __referenceVersion: number = 0;
    /** The last reference diagnostic, so a rebuild does not repeat it. */
    protected __referenceWarned: string | null = null;
    /** Pairings already reported, so a rebuild does not repeat the diagnostic. */
    protected __filterPairWarned: Set<string> = new Set();

    /** Priority-list complaints already made, so a rebuild does not repeat them. */
    protected __binPriorityWarned: Set<string> = new Set();
    /**
     * The categorical-palette message already reported, so a rebuild that changes
     * nothing relevant does not repeat it.
     */
    protected __categoricalWarned: string | null = null;
    /** Cells per device pixel by AREA in the frame last drawn, or `null`. */
    protected __aggregationFactor: number | null = null;
    /** Which reduction the frame last drawn used, or `null`. */
    protected __aggregationMode: string | null = null;
    /** `'Auto'`, `'MaxSeverity'` or `'FailFraction'`. */
    protected __aggregationReducer: string = 'Auto';
    /** The reducer already reported as ignored, so the pair is not repeated. */
    protected __reducerIgnoredWarned: string | null = null;
    /** The six components as bound, or `null`. Kept so the getter round-trips. */
    protected __viewTransform: readonly number[] | null = null;
    /** CSS px per millimeter in the frame last drawn, or `null`. */
    protected __mapScale: number | null = null;
    /** The touch target in CSS px, never below `TOUCH_TARGET_MIN_PX`. */
    protected __touchTargetSize: number = TOUCH_TARGET_DEFAULT_PX;
    /** Values already complained about, so a re-set of the same one stays quiet. */
    protected __touchTargetWarned: Set<number> = new Set();
    /** Bound labels (authored in the data frame D), or `null`. */
    protected __labels: SubstrateMapLabelList | null = null;
    /** Bound substrate outline (authored in the substrate frame S), or `null`. */
    protected __outline: Outline | null = null;
    /** Selected built-in outline preset key; `'none'` selects no preset. */
    protected __outlinePreset: PresetKey = DEFAULTS.outlinePreset;
    /** Secondary-flat direction for disc-flats presets (`'cw'` | `'ccw'`). */
    protected __secDir: SecDir = DEFAULTS.secDir;
    /** Visual magnification of the notch depth for disc-notch presets (`>= 1`). */
    protected __notchScale: number = DEFAULTS.notchExaggeration;

    // ---- Origin: raw attribute state placing the data frame D (resolved and pushed
    //      to the base by {@link __syncPlacement}; the outline stays in frame S). ----

    /** Anchor of the data origin on the fit box. */
    protected __originLocation: OriginAnchor = DEFAULTS.originLocation;
    /** Data-origin X offset along the S +x axis, in `__originOffsetPrefix` meters. */
    protected __originOffsetX: number = DEFAULTS.originOffsetX;
    /** Data-origin Y offset along the S +y axis, in `__originOffsetPrefix` meters. */
    protected __originOffsetY: number = DEFAULTS.originOffsetY;
    /** Metric prefix scaling the (meter-based) origin offsets. */
    protected __originOffsetPrefix: MetricPrefix = DEFAULTS.originOffsetPrefix;
    /** Data-axes rotation about the data origin, in degrees, CCW-positive in S. */
    protected __originRotation: number = DEFAULTS.originRotation;
    /** Data Y-axis direction; `'down'` mirrors D's y axis for y-down vision frames. */
    protected __yAxisDirection: YAxisDirection = DEFAULTS.yAxisDirection;
    /** Whether the origin marker (data-origin crosshair + axis stubs) is drawn. */
    protected __showOriginMarker: boolean = DEFAULTS.showOriginMarker;
    // Selection mode is shell state owned by the base ({@link SubstrateMapBase.__selectionMode});
    // this control's `SelectionMode` attribute maps onto it via __setSelectionMode.

    // ---- View: raw attribute state rotating the whole construct on screen
    //      (resolved to radians and pushed to the base by {@link __syncViewRotation}). ----

    /** View rotation of the whole construct about the substrate frame origin, in degrees, CCW-positive on screen. */
    protected __mapRotation: number = DEFAULTS.mapRotation;

    // ---- output attributes (read-only; updated on selection) ----

    /** `item_id` of the last interacted item, or `null`. */
    protected __selItemId: number | null = null;
    /** Effective status of the last interacted element, or `null`. */
    protected __selItemStatus: ItemStatus | null = null;
    /** Name of the last interacted element, or `null`. */
    protected __selItemName: string | null = null;
    /** Opaque user data of the last interacted item, or `null` (always `null` for cells). */
    protected __selItemUserData: string | number | null = null;
    /** Full current selection as typed entries, or `null` when nothing is selected. */
    protected __selItems: SelectionEntry[] | null = null;

    // ---- derived state ----

    /**
     * `item_id -> status` override map built from {@link __itemStatusAssignments}
     * by {@link __rebuildStatusMap}. Read by {@link __effectiveStatus} (and thus
     * by the status resolver pushed to the engine), so a later rebuild is
     * reflected without re-pushing the resolver.
     */
    protected __statusMap: Map<number, ItemStatus> = new Map();

    /**
     * Cached render-ready items built from {@link __items} by
     * {@link __rebuildItems}. Rebuilt only when the bound layout changes (not on
     * every status/mapping update); {@link __activeModel} selects it (over the demo) without rebuilding.
     */
    protected __itemModels: ItemModel[] = [];

    /**
     * Cached render-ready outline built from {@link __outline} by
     * {@link __rebuildOutline}, or `null` when unset / invalid. Rebuilt only when
     * the bound outline changes; selected by {@link __activeModel}.
     */
    protected __outlineModel: OutlineModel | null = null;

    /**
     * Cached render-ready PRESET outline built from {@link __outlinePreset}
     * (steered by {@link __secDir} / {@link __notchScale}) by
     * {@link __rebuildPreset}, or `null` when the preset is `'none'` / degenerate.
     * Ranks below a bound {@link __outline} but above the demo (see
     * {@link __activeModel}).
     */
    protected __presetOutlineModel: OutlineModel | null = null;

    /**
     * Cached demo bundle (outline model + item models + demo status -> color
     * mapping) built by {@link __rebuildDemo}, or `null` when the demo is
     * disabled. Selected by {@link __activeModel} only when no real outline and no
     * real items (and no preset) are bound and {@link __showDemoItems} is true.
     */
    protected __demo: { outlineModel: OutlineModel | null; items: ItemModel[]; mapping: Record<string, string> } | null = null;


    /**
     * True from construction until {@link __attach} has run once.
     *
     * The framework writes every `data-tchmi-*` attribute through its own setter
     * BEFORE attach, and six of those setters plus
     * {@link __refitAfterOutlineChange} each rebuild the whole map. Measured on
     * the reference page: five to six placement builds per
     * control where one would do, every one of them but the last discarded, and
     * three or four `E142_NO_PHYSICAL_SCALE` warnings drawn from map state that
     * had not finished arriving.
     *
     * While this is set, {@link __rebuildMap} records that a rebuild is owed and
     * returns. Attach performs exactly one. AFTER attach the flag is false
     * forever and every setter rebuilds immediately, exactly as before.
     */
    protected __attachPending: boolean = true;

    /**
     * Set by {@link setShowDemoItems} on a write that carried a value.
     *
     * Deliberately NOT set for a `null` write: `null` means "use the declared
     * default", which is what the framework passes when it is defaulting rather
     * than relaying an author's choice.
     */
    protected __showDemoItemsWritten: boolean = false;

    /** Set when {@link __rebuildMap} was suppressed during the attach batch. */
    protected __mapRebuildOwed: boolean = false;

    // ---- SEMI E142 input attributes (tasks O6 / O7) ----
    //  Three mutually-exclusive bindable map inputs. The most recent non-null
    //  write wins; a fixed precedence (see __INPUT_PRECEDENCE) only breaks the tie
    //  when the active input is unbound while others remain bound.

    /** Bound E142.1 MapData XML document, or `null`. Parsed and rendered as a cell grid. Mutually exclusive with {@link __e142TransferData} and {@link __gridData} (the most recent non-null write wins). */
    protected __e142MapData: string | null = null;
    /** Bound compact GridData v1 document, or `null`. Normalized and rendered as a cell grid. Mutually exclusive with {@link __e142MapData} and {@link __e142TransferData}. */
    protected __gridData: GridData | null = null;
    /**
     * Bound E142.1 MapData document in its JSON representation, or `null`.
     *
     * The SAME document as {@link __e142MapData} in a different encoding, not a
     * different contract - both parse to one `E142Document` through one
     * implementation of every rule. Held as `object | string` because the point of
     * the feature is that a binding arrives as a typed HMI symbol rather than an
     * opaque string; `parseE142Json` accepts either.
     */
    protected __e142MapDataJson: object | string | null = null;
    /**
     * Bound E142.4 (Stream-21) reassembled item content, or `null`: a base64
     * `string` or a `number[]` of byte values. Decoded to text
     * (encoding sniff) and then run through the SAME XML pipeline as
     * {@link __e142MapData}. Mutually exclusive with the other two inputs.
     */
    protected __e142TransferData: string | number[] | null = null;
    /**
     * `SubstrateMap` to render, by `@SubstrateId`; `null` does not filter.
     * Ignored by the GridData path.
     */
    protected __e142SubstrateId: string | null = null;
    /**
     * `SubstrateMap` to render, by `@LayoutSpecifier`; `null` does not filter.
     * Ignored by the GridData path.
     */
    protected __e142LayoutSpecifier: string | null = null;
    /** Overlay to render from the E142 document (by MapName); `null` selects the first renderable BinCodeMap overlay. Ignored by the GridData path. */
    protected __e142OverlayName: string | null = null;
    /**
     * Overlay version to render (by `Overlay/@MapVersion`); `null` does not
     * filter by version. Ignored by the GridData path.
     */
    protected __e142OverlayVersion: string | null = null;
    /** Fallback column pitch in millimeters for layoutless maps, or `null` when unset. Applied only when BOTH X and Y are set. */
    protected __e142FallbackStepX: number | null = null;
    /** Fallback row pitch in millimeters for layoutless maps, or `null` when unset. */
    protected __e142FallbackStepY: number | null = null;
    /** Degrees added to the map's Orientation before placement, a CW-positive source angle; default 0. */
    protected __e142OrientationOffset: number = DEFAULTS.e142OrientationOffset;

    // ---- SEMI E142 read-only outputs ----

    /** Last map-ingestion error message, or `null` when the active map (if any) rendered cleanly. */
    protected __e142LastError: string | null = null;
    /** Substrate id of the active map (XML: the map header's; GridData: the identity pass-through), or `null`. */
    protected __mapSubstrateId: string | null = null;
    /** Lot id of the active map's substrate, or `null` when the source carried none. */
    protected __mapLotId: string | null = null;

    /** `MapCarrierType` output: the active map's `Substrate/CarrierType`. */
    protected __mapCarrierType: string | null = null;

    /** `MapCarrierId` output: the active map's `Substrate/CarrierId`. */
    protected __mapCarrierId: string | null = null;

    /** `MapSlotNumber` output: the active map's `Substrate/SlotNumber`. */
    protected __mapSlotNumber: number | null = null;

    /** `MapSubstrateNumber` output: the active map's `Substrate/SubstrateNumber`. */
    protected __mapSubstrateNumber: number | null = null;

    /** `MapAliasIds` output: the active map's `Substrate/AliasIds`, or `null`. */
    protected __mapAliasIds: readonly E142AliasId[] | null = null;

    /** `MapSubstrateSide` output: the built map's `SubstrateSide`, or `null`. */
    protected __mapSubstrateSide: E142SubstrateSide | null = null;

    /**
     * `ViewSubstrateSide`: which face to render from. `follow-map` (the default)
     * applies no mirror and reproduces the behavior that existed before this
     * attribute.
     */
    protected __viewSubstrateSide: ViewSubstrateSide = 'follow-map';

    /**
     * `MapSubstrateCount` output: how many `SubstrateMap` elements the bound
     * document contains, or `null` when none is bound.
     *
     * A DOCUMENT fact, not a substrate fact - deliberately outside the identity
     * reset unit. After a selection failure the identity outputs clear but the
     * count stays, because "your filter matched none of 3" is exactly what the
     * operator needs to see.
     */
    protected __mapSubstrateCount: number | null = null;
    /** Good-device count of the active map's substrate, or `null` when the source carried none. */
    protected __mapGoodDevices: number | null = null;

    // ---- SEMI E142 derived state ----

    /** Which mutually-exclusive map input is currently active, or `null` (no map bound). */
    protected __activeInput: E142ActiveInput = null;
    /**
     * Cached parse of {@link __e142MapData}, so an {@link setE142OverlayName},
     * fallback or offset change re-resolves WITHOUT re-parsing.
     * Nulled by {@link setE142MapData} on a new/removed XML string, forcing a
     * fresh parse on the next {@link __rebuildMap}.
     */
    protected __e142Doc: E142Document | null = null;
    /**
     * The active map's logical frame (OriginLocation / AxisDirection), or `null`
     * when no grid is bound. Read by {@link __raiseSelected} to convert a hit
     * cell's serialization indices to signed logical map coordinates via
     * {@link indexToMapCoord}; C / R come from the live grid model.
     */
    protected __mapFrame: { origin: E142OriginLocation; dir: E142AxisDirection } | null = null;

    /**
     * The non-geometric facts of the last successfully built grid (the geometry
     * lives in the base's `__sceneGrid.placement`), retained so {@link toGridData}
     * / {@link toE142Xml} can re-serialize the current map (the export
     * path). `null` when no grid is bound. Set in {@link __commitGrid}.
     */
    protected __lastBuilt: {
        substrateType: string;
        orientation: number;
        origin: E142OriginLocation;
        dir: E142AxisDirection;
        binType: E142BinType;
        binDefs: E142BinDefinition[] | null;
        substrateId: string | null;
        /** `SubstrateMap/@SubstrateSide` of the source map. */
        substrateSide: E142SubstrateSide;
        /** `Overlay/@MapVersion` of the chosen overlay; `null` on the GridData path. */
        mapVersion: string | null;
        /** `Substrate/LotId` of the matched substrate record. */
        lotId: string | null;
        /** `Substrate/GoodDevices`. */
        goodDevices: number | null;
        /** `Substrate/SupplierName`. */
        supplierName: string | null;
        /** `Substrate/Status`. */
        status: string | null;
        /** `Substrate/AliasIds`. */
        aliasIds: readonly E142AliasId[] | null;
        /** `Substrate/CarrierType`. */
        carrierType: string | null;
        /** `Substrate/CarrierId`. */
        carrierId: string | null;
        /** `Substrate/SlotNumber`. */
        slotNumber: number | null;
        /** `Substrate/SubstrateNumber`. */
        substrateNumber: number | null;
        /**
         * The source document's DEVICE layout, when the map came from XML.
         * Carries the placement-irrelevant children a {@link GridPlacement}
         * cannot: `LowerLeft`, `Z`, the image URIs, `ProductId`, `Package`.
         * `null` on the GridData path, whose contract has no layout tree.
         */
        sourceLayout: E142Layout | null;
        /**
         * The source map's `TransferMap` records, flattened across its transfer
         * overlays. `null` on the GridData path, which has no transfers.
         */
        transferMaps: readonly E142TransferMap[] | null;
    } | null = null;

    /**
     * Cell (serialization linear index) -> device id, built from a `DeviceIdMap`
     * overlay in the rendered map's SubstrateMap. `null` when no
     * grid is bound or the document carried no DeviceIdMap. Read on selection.
     */
    protected __deviceIdIndex: Map<number, string> | null = null;

    /**
     * Cell -> where the device in it came from, from the map's `TransferMap`
     * overlays. `null` when the map carries none, or none resolved to a cell.
     * Rebuilt with the grid and cleared by the same paths as
     * {@link __deviceIdIndex}.
     */
    protected __transferIndex: Map<number, TransferOrigin> | null = null;

    /** Cell -> its parameter readings, from the chosen `DeviceDataMap` overlay. `null` when there are none. */
    protected __deviceDataIndex: Map<number, DeviceReading[]> | null = null;

    /**
     * `E142DeviceDataOverlayName`: which `DeviceDataMap` overlay to join.
     * `null` selects the first one that carries device data.
     */
    protected __e142DeviceDataOverlayName: string | null = null;

    /**
     * `E142Overlays`: the ordered composition list, or `null` for today's
     * single-overlay behavior via `E142OverlayName` / `E142OverlayVersion`.
     */
    protected __e142Overlays: OverlaySpec[] | null = null;

    /**
     * `E142AlignToReferenceDevices`: opt-in reference-device registration
     * (the reference-device compute path). OFF by default, so placement is unchanged
     * unless explicitly enabled. Applied in {@link __commitGrid} (XML path only;
     * GridData carries no reference devices).
     */
    protected __alignToReferenceDevices: boolean = false;

    /**
     * Constructor of the control.
     * @param element Element of the control as delivered by the framework.
     * @param pcElement Precompiled element of the control.
     * @param attrs Attributes of the element as delivered by the framework.
     */
    public constructor(element: JQuery, pcElement: JQuery, attrs: TcHmi.Controls.ControlAttributeList) {
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
    public __attach(): void {
        super.__attach();
        // The attribute batch has settled. Clear the gate FIRST, then pay the
        // single owed rebuild, before the three syncs below - the same order as if
        // each setter had built the map on the way in and attach only synced
        // afterwards.
        this.__attachPending = false;
        if (this.__mapRebuildOwed) {
            this.__mapRebuildOwed = false;
            this.__rebuildMap();
        }
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
    /** `MapTimestamp` as bound, before parsing. */
    protected __mapTimestamp: string | null = null;
    /** When the current payload arrived, for the `received` clock. */
    protected __receivedAt: Date = new Date();

    /**
     * Records that a map payload has just arrived, and refreshes the identity line
     * that displays it.
     *
     * WHY THIS EXISTS. `__receivedAt` was initialized once at construction
     * and **never reassigned**, so `readAge()` reported the moment the control was
     * created for the rest of its life: bind new data, and the line kept showing the
     * old clock. Reported from the field as "it was strange when I wrote new data,
     * it was not updating the timestamp".
     *
     * Both sibling controls already did this - `SubstrateMapBinChart.setGridData`
     * inline, `SubstrateMapWidget.__stampReceived` as a helper - and this control,
     * the one the other two exist to accompany, was the only one that did not. The
     * helper form is taken from the Widget so the three read the same way.
     *
     * `__updateIdentity` is called here rather than left to the caller because a
     * stamp nobody displays is not a fix; every payload setter would otherwise have
     * to remember two calls instead of one.
     */
    protected __stampReceived(): void {
        this.__receivedAt = new Date();
        this.__updateIdentity();
    }

    /**
     * Sets when the map was measured.
     *
     * The tile's and the chart's attribute, verbatim, so ONE SYMBOL drives all
     * three. It exists because an E142 document carries no timestamp of its own: the
     * `ITEMVERSION` the standard defines belongs to the Stream 21 message that
     * transports the item, so this is bound rather than parsed.
     * @param valueNew The instant, or `null` to fall back to the receive time.
     */
    public setMapTimestamp(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapTimestamp)) { return; }
        this.__mapTimestamp = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapTimestamp' });
        this.__updateIdentity();
    }
    /** @returns The bound instant, or `null`. */
    public getMapTimestamp(): string | null { return this.__mapTimestamp; }

    /**
     * The age line the map is showing.
     * @returns The line, its source and its age in seconds.
     */
    public readAge(): AgeText {
        return formatAge(parseMapTimestamp(this.__mapTimestamp), this.__receivedAt, new Date());
    }

    /**
     * The identity band: the substrate id, then how old the data is.
     *
     * ---- IN THE BAND, NOT ON THE CANVAS ----
     *
     * The tile and the chart paint the age on their canvas because neither has a
     * text band. The map HAS one, already holding the substrate id, so the age
     * goes beside it - selectable, copyable, and not painted over the wafer that
     * is the point of the control.
     *
     * The same words as the other two: `measured 09:15:00 CEST` or
     * `received 11:59:30 CEST`. Someone moving between a dashboard tile and the
     * full view should not have to learn a second vocabulary.
     * @returns The identity text.
     */
    protected __composeIdentity(): string {
        const id = this.__identityText();
        const age = this.readAge().text;
        return id === '' ? age : `${id}  \u00b7  ${age}`;
    }

    /**
     * The substrate id for the identity band, or `''` when there is none.
     * @returns The id.
     */
    protected __identityText(): string {
        // Explicit SubstrateId wins; when it is unset and a map is bound, show the
        // map's substrate id; otherwise there is no id.
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
     * Every concrete control implements THIS SAME hook independently, with its own
     * event and output names: there is deliberately no super-chaining and no shared
     * concrete raise path, so no control inherits SubstrateMap's `.onItemSelected`
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
    protected __raiseSelected(payload: SelectedPayload): void {
        // Base event payload; a CELL interaction additionally carries the
        // grid coordinates - column/row (serialization indices, from the base),
        // binCode/binQuality, and mapX/mapY (signed logical coordinates via the
        // domain module). Item interactions
        // carry none of these.
        const eventData: Record<string, unknown> = {
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
            // Device id from a DeviceIdMap overlay, by the cell's serial index.
            const g = this.__sceneGrid;
            eventData.deviceId = (this.__deviceIdIndex && g)
                ? (this.__deviceIdIndex.get(payload.row * g.cols + payload.column) ?? null)
                : null;
            // Location identifier from the payload's per-cell map,
            // keyed by the SAME row-major linear index the grid model uses.
            // Distinct from deviceId: the LID names the socket, not its occupant.
            eventData.lid = (g && g.lids)
                ? (g.lids.get(payload.row * g.cols + payload.column) ?? null)
                : null;
            // Where this cell's device came from (R2-3 traceability, via a
            // TransferMap overlay). All five are null together when no transfer
            // covers the cell - a view can test any one of them.
            const org = (this.__transferIndex && g)
                ? (this.__transferIndex.get(payload.row * g.cols + payload.column) ?? null)
                : null;
            eventData.fromSubstrateType = org ? org.fromSubstrateType : null;
            eventData.fromSubstrateId = org ? org.fromSubstrateId : null;
            eventData.fromX = org && org.fx !== undefined ? org.fx : null;
            eventData.fromY = org && org.fy !== undefined ? org.fy : null;
            eventData.fromLid = org && org.fid !== undefined ? org.fid : null;
            // Parameter readings. The EVENT carries the rendered form only - a
            // view binds to a string; SelectedItems carries `raw` beside it for
            // a consumer that needs the value tree.
            const dd = (this.__deviceDataIndex && g)
                ? (this.__deviceDataIndex.get(payload.row * g.cols + payload.column) ?? null)
                : null;
            eventData.deviceData = dd === null
                ? null
                : dd.map((r) => ({ name: r.name, value: r.value }));
            eventData.overlays = g === null
                ? null
                : this.__overlayBinsAt(g, payload.row * g.cols + payload.column);
        }
        /*
         * ---- THE EVENT IS RAISED LAST, AFTER EVERY ATTRIBUTE IT DESCRIBES ----
         *
         * It used to be raised HERE, before `__setSelectedOutputs` and
         * `setSelectedItems`. A `.view` action reading `SelectedItemId` or
         * `SelectedItems` in response to the event therefore read the PREVIOUS
         * selection - and on the first click of a session there was no previous
         * selection, so it read null. The user's report: *"onItemSelected raises
         * without a payload on the first click."*
         *
         * Measured before the fix, three taps: payload 9 with SelectedItemId null,
         * payload 22 with SelectedItemId 9, payload 9 with SelectedItemId 22. Every
         * click one selection behind, and the first one empty.
         *
         * The symptom looked intermittent because re-clicking the SAME cell leaves
         * the attributes unchanged, so `tchmi_equal` short-circuits the property
         * events and only the first click of a new cell shows it.
         */
        this.__setSelectedOutputs(payload);

        if (payload.selection.length === 0) {
            this.setSelectedItems(null);
            TcHmi.EventProvider.raise(this.__id + '.onItemSelected', eventData);
            return;
        }
        const byId = new Map<number, ItemModel>();
        for (const model of this.__sceneItems) {
            if (model.id !== null) {
                byId.set(model.id, model);
            }
        }
        const grid = this.__sceneGrid;
        const entries: SelectionEntry[] = payload.selection.map((sel): SelectionEntry => {
            if (sel.kind === 'cell') {
                // A cell's status IS its bin code (the status resolver is an item
                // concern); it carries no name and no user data.
                const bin = grid && sel.itemId >= 0 && sel.itemId < grid.cells.length
                    ? grid.binTable[grid.cells[sel.itemId]]
                    : undefined;
                const entry: SelectionEntry = {
                    kind: 'cell', item_id: sel.itemId, status: bin ? bin.code : null,
                    name: null, user_data: null, binQuality: bin ? bin.quality : null,
                };
                if (grid) {
                    const mc = this.__cellMapCoord(sel.itemId % grid.cols, Math.floor(sel.itemId / grid.cols));
                    if (mc) { entry.mapX = mc.mapX; entry.mapY = mc.mapY; }
                }
                if (this.__deviceIdIndex) {
                    entry.deviceId = this.__deviceIdIndex.get(sel.itemId) ?? null;
                }
                if (grid && grid.lids) {
                    // sel.itemId IS the row-major linear cell index, which is what
                    // grid.lids is keyed by - no re-derivation needed.
                    entry.lid = grid.lids.get(sel.itemId) ?? null;
                }
                if (this.__deviceDataIndex) {
                    entry.deviceData = this.__deviceDataIndex.get(sel.itemId) ?? null;
                }
                if (grid) { entry.overlays = this.__overlayBinsAt(grid, sel.itemId); }
                if (this.__transferIndex) {
                    const org = this.__transferIndex.get(sel.itemId) ?? null;
                    entry.fromSubstrateType = org ? org.fromSubstrateType : null;
                    entry.fromSubstrateId = org ? org.fromSubstrateId : null;
                    entry.fromX = org && org.fx !== undefined ? org.fx : null;
                    entry.fromY = org && org.fy !== undefined ? org.fy : null;
                    entry.fromLid = org && org.fid !== undefined ? org.fid : null;
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

        /*
         * LAST. Both exits raise, and both raise after their writes - an early
         * `return` that skipped the event would be a selection that changed the
         * attributes and told nobody.
         */
        TcHmi.EventProvider.raise(this.__id + '.onItemSelected', eventData);
    }

    // ---------------------------------------------------------------
    //  Input attributes
    // ---------------------------------------------------------------

    /**
     * Sets the substrate id shown in the identity area. `null` hides the identity
     * area. Updates the identity label and raises `onPropertyChanged` on change.
     * @param valueNew New substrate id, or `null`.
     */
    public setSubstrateId(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__substrateId)) { return; }
        this.__substrateId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SubstrateId' });
        this.__updateIdentity();
    }
    /** @returns The current substrate id, or `null`. */
    public getSubstrateId(): string | null { return this.__substrateId; }

    /**
     * Sets the substrate-identity label position. Values other than `'above'` /
     * `'below'` / `'none'` fall back to the attribute default. Updates the
     * identity label and raises `onPropertyChanged` on change.
     * @param valueNew New position, or `null` to use the default.
     */
    public setSubstrateIdentityPosition(valueNew: string | null): void {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || POSITIONS.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('SubstrateIdentityPosition') as string;
        }
        if (tchmi_equal(v, this.__identityPosition)) { return; }
        this.__setIdentity(v);
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SubstrateIdentityPosition' });
    }
    /** @returns The current substrate-identity label position. */
    public getSubstrateIdentityPosition(): string { return this.__identityPosition; }

    /**
     * Toggles the demo items (shown only when no explicit outline, no
     * {@link setOutlinePreset} and no real items are bound). Rebuilds the demo
     * bundle and re-renders on change; raises `onPropertyChanged`. Enabling it
     * against a bound outline now DRAWS INTO it, so there is nothing to warn
     * about; the flag is still recorded, so an explicit write can be told from
     * the default.
     * @param valueNew New flag, or `null` to use the default.
     */
    public setShowDemoItems(valueNew: boolean | null): void {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowDemoItems') as boolean;
        }
        // BEFORE the no-op guard, on purpose. `ShowDemoItems` defaults to true, so
        // an explicit show-demo-items="true" equals the current value and returns
        // below - and a choice that never reaches the body is a choice this control
        // would otherwise never learn about.
        if (valueNew !== null && valueNew !== undefined) { this.__showDemoItemsWritten = true; }
        if (tchmi_equal(b, this.__showDemoItems)) { return; }
        this.__showDemoItems = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowDemoItems' });
        // Rebuild the demo bundle for the new flag (generating or clearing it) and
        // re-sync; the demo only paints when no real outline / items are bound.
        this.__rebuildDemo();
    }
    /** @returns Whether the demo items are enabled. */
    public getShowDemoItems(): boolean { return this.__showDemoItems; }

    /**
     * Toggles the labels. Requests a re-render and raises `onPropertyChanged` on
     * change.
     * @param valueNew New flag, or `null` to use the default.
     */
    public setShowLabels(valueNew: boolean | null): void {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowLabels') as boolean;
        }
        if (tchmi_equal(b, this.__showLabels)) { return; }
        this.__showLabels = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowLabels' });
        this.__rebuildLabels();
        this.__requestRender();
    }
    /** @returns Whether the labels are enabled. */
    public getShowLabels(): boolean { return this.__showLabels; }

    /**
     * Sets the item layout. A non-array (or `null`) clears it. Rebuilds the
     * derived items, drops any selection and re-renders on change.
     * @param valueNew New {@link ItemList}, or `null` to clear.
     */
    public setItems(valueNew: ItemList | null): void {
        let v = TcHmi.ValueConverter.toObject<ItemList>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Items') as ItemList | null;
        }
        if (tchmi_equal(v, this.__items)) { return; }
        this.__items = Array.isArray(v) ? v : null;
        this.__stampReceived();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Items' });
        this.__rebuildItems();
        this.__requestRender();
    }
    /** @returns The current item layout, or `null`. */
    public getItems(): ItemList | null { return this.__items; }

    /**
     * Sets the per-item status overrides. A non-array (or `null`) clears them.
     * Rebuilds the status map and re-renders on change.
     * @param valueNew New {@link ItemStatusAssignmentList}, or `null` to clear.
     */
    public setItemStatusAssignments(valueNew: ItemStatusAssignmentList | null): void {
        let v = TcHmi.ValueConverter.toObject<ItemStatusAssignmentList>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('ItemStatusAssignments') as ItemStatusAssignmentList | null;
        }
        if (tchmi_equal(v, this.__itemStatusAssignments)) { return; }
        this.__itemStatusAssignments = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ItemStatusAssignments' });
        this.__rebuildStatusMap();
        this.__requestRender();
    }
    /** @returns The current status overrides, or `null`. */
    public getItemStatusAssignments(): ItemStatusAssignmentList | null { return this.__itemStatusAssignments; }

    /**
     * Sets the status -> color mapping. A non-object (or `null`) clears it.
     * Colors are resolved at draw time, so this only re-renders (no rebuild).
     * @param valueNew New status -> CSS color map, or `null` to clear.
     */
    public setStatusColorMapping(valueNew: Record<string, string> | null): void {
        let v = TcHmi.ValueConverter.toObject<Record<string, string>>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('StatusColorMapping') as Record<string, string> | null;
        }
        if (tchmi_equal(v, this.__statusColorMapping)) { return; }
        this.__statusColorMapping = (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'StatusColorMapping' });
        this.__syncScene();
    }
    /** @returns The current status -> color mapping, or `null`. */
    public getStatusColorMapping(): Record<string, string> | null { return this.__statusColorMapping; }

    /**
     * Binds the author's `BinQuality` vocabulary.
     *
     * SEMI E142-0225 reserves exactly **two** `BinQuality` values — *"'Pass' -
     * Indicates a quality that has commercial value; 'Fail' - ... does not"* — and
     * then says *"Other values defined by an application."* A document reading
     * `Reject`, `Schlecht`, `Good`, or the `A` / `B` / `C` / `D` of the standard's
     * own pick-and-place example is therefore perfectly legal, and this control
     * cannot know what any of them mean.
     *
     * Bind `{ "Reject": "fail", "Good": "pass" }` and it does. Keys and values are
     * matched case-insensitively and trimmed; a value that is not `pass` or `fail`
     * is ignored, because aliasing onto a third token would invent a severity
     * nothing can render.
     *
     * Unset (`null`) leaves only the two reserved values recognized, which is the
     * behavior before this attribute existed.
     * @param valueNew The alias map, or `null`.
     */
    public setBinQualityAliases(valueNew: Record<string, string> | null): void {
        let v = TcHmi.ValueConverter.toObject<Record<string, string>>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('BinQualityAliases') as Record<string, string> | null;
        }
        if (tchmi_equal(v, this.__binQualityAliases)) { return; }
        this.__binQualityAliases = (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
        this.__sceneBinQualityAliases = this.__binQualityAliases;
        // A token that could not be mapped before may be mappable now, and one that
        // could may not be: the whole diagnosis is stale.
        this.__binQualityWarned.clear();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'BinQualityAliases' });
        this.__warnUnmappedBinQualities();
        // An alias can turn a listed code into a pass, which changes rung 1.
        this.__binPriorityWarned.clear();
        this.__warnBinSeverityPriority();
        this.__syncScene();
    }
    /** @returns The current BinQuality alias map, or `null`. */
    public getBinQualityAliases(): Record<string, string> | null { return this.__binQualityAliases; }

    /**
     * Binds the author's severity ordering: bin codes, **most severe first**.
     *
     * The severity ladder knows `pass`, `fail` and `unknown` and nothing finer —
     * bin codes are nominal, so it cannot know that `Scrap` is worse than
     * `Chipping`. This is where an author says so.
     *
     * **A code the document calls `pass` is never promoted by it**, and the control
     * warns. The list is most-severe-first, so writing a whole vocabulary out —
     * `["Pass", "Fail", "Scrap"]`, meaning *"here is my ordering"* rather than
     * *"here is what wins"* — would otherwise put the passing code at the top of
     * the scale, and under "worst wins" a tile holding one passing and one failing
     * die would reduce to the passing bin. The failure would vanish. So the list
     * orders the bins that are **not known to be good**: a view setting does not
     * silently overrule a document that says a die is saleable.
     *
     * A code that is not in the bound map is reported and otherwise ignored — it is
     * usually a typo, or a list carried over from another product.
     *
     * Unset (`null`) leaves the ladder alone.
     * @param valueNew The ordered code list, or `null`.
     */
    public setBinSeverityPriority(valueNew: string[] | null): void {
        let v = TcHmi.ValueConverter.toObject<string[]>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('BinSeverityPriority') as string[] | null;
        }
        const next = Array.isArray(v) ? v.filter((c) => typeof c === 'string') : null;
        if (tchmi_equal(next, this.__binSeverityPriority)) { return; }
        this.__binSeverityPriority = next;
        // The list reaches the renderer through the scene, not only the warnings.
        this.__sceneBinSeverityPriority = next;
        this.__binPriorityWarned.clear();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'BinSeverityPriority' });
        this.__warnBinSeverityPriority();
        this.__syncScene();
    }
    /** @returns The current severity priority list, or `null`. */
    public getBinSeverityPriority(): string[] | null {
        return this.__binSeverityPriority === null ? null : [...this.__binSeverityPriority];
    }

    /**
     * Publishes what the frame just drawn did, so a legend can be honest.
     *
     * Called from the render loop on every frame, which is how both outputs follow
     * a **resize** without anything re-parsing: the observer requests a render, the
     * matrices are recomputed from the new size, and the factor falls out of them
     * (read from the composed matrix, never from control width over column
     * count). The setters drop an unchanged value, so a frame that changes nothing
     * raises nothing.
     * @param factor Cells per device pixel by area, or `null` when no grid is bound.
     * @returns Nothing.
     */
    /**
     * Publishes the fit scale so an author can convert pixels to millimeters.
     * @param scale CSS px per millimeter, or `null`.
     * @returns Nothing.
     */
    protected override __publishMapScale(scale: number | null): void {
        this.setMapScale(scale);
    }

    protected override __publishAggregation(
        factor: number | null,
        reducer: string | null,
    ): void {
        this.setAggregationFactor(factor);
        /*
         * `reducer` is non-null exactly when the frame bucketed, so it is the
         * truthful answer whenever there is one. Otherwise the mode is derived from
         * the factor: at or below one cell per pixel every cell is drawn in its own
         * right; above it the gather is still picking one cell per pixel and
         * `PointSample` says so.
         */
        this.setAggregationMode(
            factor === null ? null
                : reducer !== null ? reducer
                    : (factor <= 1 ? 'None' : 'PointSample'));
    }

    /**
     * Forces a reducer, or `'Auto'` to let the map decide.
     *
     * **`'Auto'` measures rather than guesses.** The question is not how much the
     * map is minified but whether worst-wins has stopped saying anything, and those
     * come apart: at one aggregation factor the chance a pixel holds a failing die
     * runs from 0.5 % to 100 % depending on the defect rate. So each aggregated
     * frame measures its own saturation — for free, since the reducer that ran
     * already accumulated it — and that selects the reducer for the next frame.
     *
     * Force a value when the view must not change under the operator: a screenshot
     * for a report, or a panel where one map is always read the same way.
     * `'MaxSeverity'` never hides a lone defect; `'FailFraction'` never floods a
     * noisy wafer. `'Auto'` picks between them and is the default.
     * @param valueNew `'Auto'`, `'MaxSeverity'` or `'FailFraction'`.
     * @returns Nothing.
     */
    public setAggregationReducer(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        const next = v === 'MaxSeverity' || v === 'FailFraction' ? v : 'Auto';
        if (tchmi_equal(next, this.__aggregationReducer)) { return; }
        this.__aggregationReducer = next;
        this.__reducerOverride = next;
        this.__warnReducerIgnored();
        // An override applies to the NEXT frame like everything else, but the
        // scene's current choice is corrected now so a forced value takes effect on
        // the very first frame after it is set rather than the one after that.
        if (next !== 'Auto') { this.__sceneReducer = next; }
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'AggregationReducer' });
        this.__syncScene();
    }
    /** @returns `'Auto'`, `'MaxSeverity'` or `'FailFraction'`. */
    public getAggregationReducer(): string { return this.__aggregationReducer; }

    /**
     * Says once that a forced reducer is being ignored under a value field.
     *
     * Both settings are reasonable on their own and the combination is not, so the
     * author hears about it rather than watching one silently lose. Latched on the
     * PAIR, so releasing either and re-making the same mistake is reported again.
     * @returns Nothing.
     */
    protected __warnReducerIgnored(): void {
        if (this.__sceneValueFill === null || this.__aggregationReducer === 'Auto') { return; }
        const key = this.__aggregationReducer;
        if (this.__reducerIgnoredWarned === key) { return; }
        this.__reducerIgnoredWarned = key;
        this.__logWarnings([
            `E142_AGGREGATION_REDUCER_IGNORED: AggregationReducer is "${key}", but a valueField `
            + 'overlay owns the fill. MaxSeverity and FailFraction both reduce by BinQuality, and a '
            + 'value field has none — it reduces by its own table index instead, so the setting is '
            + 'ignored while the field is bound. Drop the valueField role to get it back.',
        ]);
    }

    /**
     * The smallest area a tap should be able to select, in CSS pixels.
     *
     * When dies are drawn smaller than this, taps select a GROUP of them rather
     * than one. **Painting is unaffected** — the map still draws at one device
     * pixel per bucket, and this changes only how much of it one tap picks up.
     *
     * ---- THE UNIT, HONESTLY ----
     *
     * A CSS pixel is a REFERENCE unit, not a physical one. `devicePixelRatio`
     * accounts for display density, and it is taken into account here — but two
     * industrial panels of very different physical size both report a ratio near 1,
     * and the platform exposes no reliable physical size. So a 40 CSS px target is
     * 40 px on both, which is a comfortable finger on one and a small one on the
     * other. **The author overrides per panel**; the control cannot know.
     *
     * **`0` turns grouping off entirely**, and is the only value that does — every
     * tap then selects one die and raises `onItemSelected`, as it did before
     * grouping existed. A negative number is not the opt-out: that is a target
     * which is too small, and it clamps.
     *
     * Other values below `TOUCH_TARGET_MIN_PX` (24) are clamped and reported.
     * That number is WCAG 2.2's Target Size (Minimum), SC 2.5.8 — a floor, where
     * the enhanced criterion is 44 and the phone guidelines 44–48.
     * @param valueNew The target in CSS pixels.
     * @returns Nothing.
     */
    public setTouchTargetSize(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const asked = raw === null || !Number.isFinite(raw)
            ? TOUCH_TARGET_DEFAULT_PX
            : raw;
        // ZERO is the opt-out and skips the floor entirely: "no target" is not a
        // small target, and the floor exists to stop a target being too small
        // rather than to force one to exist.
        const clamped = asked === 0 ? 0 : Math.max(TOUCH_TARGET_MIN_PX, asked);
        if (clamped !== asked && !this.__touchTargetWarned.has(asked)) {
            this.__touchTargetWarned.add(asked);
            this.__logWarnings([
                `E142_TOUCH_TARGET_CLAMPED: TouchTargetSize ${asked} is below the ${TOUCH_TARGET_MIN_PX} `
                + 'CSS px floor and has been clamped to it. That floor is WCAG 2.2 SC 2.5.8, Target Size '
                + '(Minimum); the enhanced criterion is 44 and the phone guidelines 44 to 48, so 24 is '
                + 'already the smallest defensible target and not a starting point. If dies must be '
                + 'individually selectable at this size, zoom in rather than shrinking the target — '
                + 'grouping engages only when a die is smaller than the target anyway.',
            ]);
        }
        if (tchmi_equal(clamped, this.__touchTargetSize)) { return; }
        this.__touchTargetSize = clamped;
        this.__sceneTouchTargetCssPx = clamped;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'TouchTargetSize' });
        this.__syncScene();
    }
    /** @returns The touch target in CSS px, never below the floor. */
    public getTouchTargetSize(): number { return this.__touchTargetSize; }

    /**
     * An affine transform composed into the view, as `[a, b, c, d, e, f]`.
     *
     * ---- GEOMETRY ONLY ----
     *
     * It moves, scales, rotates, shears or mirrors what is drawn. It **cannot**
     * express a per-cell value: a relevance map, a thermal field or a probe result
     * is one number per die and no affine matrix has anywhere to hold it. Carry
     * those as an E142 overlay with the `valueField` role instead — that is the
     * other half of this phase, and the half most future requirements land in.
     *
     * ---- THE UNITS, WHICH THE MULTIPLICATION ORDER DECIDES ----
     *
     * Post-multiplied onto the world matrix, so the transform acts in the
     * **substrate frame**: `e` and `f` are **millimeters**, and scaling is anchored
     * where the S-frame origin lands, which is the canvas center. Pre-multiplication
     * would give pixels and a top-left anchor. Post was chosen because an author can
     * convert units — `millimeters = pixels / MapScale` — and cannot conjure an
     * anchor.
     *
     * A transform whose determinant is zero collapses the map to a line or a point.
     * It is refused with a warning and identity is used, because rendering nothing
     * looks like a data fault rather than like a bad matrix.
     * @param valueNew Six numbers, or `null` for identity.
     * @returns Nothing.
     */
    public setViewTransform(valueNew: number[] | null): void {
        const v = Array.isArray(valueNew) ? valueNew.map((x) => TcHmi.ValueConverter.toNumber(x)) : null;
        let next: readonly number[] | null = null;
        if (v !== null) {
            if (v.length !== 6 || v.some((x) => x === null || !Number.isFinite(x))) {
                this.__logWarnings([
                    'E142_VIEW_TRANSFORM_INVALID: ViewTransform must be six finite numbers '
                    + '[a, b, c, d, e, f]. Identity is used instead.',
                ]);
            } else if (Math.abs(v[0]! * v[3]! - v[1]! * v[2]!) === 0) {
                this.__logWarnings([
                    'E142_VIEW_TRANSFORM_DEGENERATE: ViewTransform has a zero determinant, which '
                    + 'collapses the map to a line or a point. Identity is used instead — a blank '
                    + 'canvas would look like a data fault rather than like a bad matrix.',
                ]);
            } else {
                next = v as number[];
            }
        }
        if (tchmi_equal(next, this.__viewTransform)) { return; }
        this.__viewTransform = next;
        this.__sceneViewTransform = next === null ? null
            : new DOMMatrix([next[0], next[1], next[2], next[3], next[4], next[5]]);
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ViewTransform' });
        this.__syncScene();
    }
    /** @returns The six components as bound, or `null`. */
    public getViewTransform(): number[] | null {
        return this.__viewTransform === null ? null : [...this.__viewTransform];
    }

    /**
     * Read-only output: CSS pixels per millimeter in the frame last drawn.
     *
     * The number an author needs to use {@link setViewTransform}, whose translation
     * is in millimeters: `millimeters = pixels / MapScale`. Without it a pointer
     * delta cannot be turned into a transform, because the fit scale is chosen by
     * the control and depends on the substrate's extent and the control's size.
     *
     * It is the fit scale and **excludes** the author's own transform, so it does
     * not move as they zoom — otherwise converting a delta would need the answer it
     * is being used to compute.
     * @param valueNew The scale.
     * @returns Nothing.
     */
    public setMapScale(valueNew: number | null): void {
        const v = TcHmi.ValueConverter.toNumber(valueNew);
        const clean = v === null || !Number.isFinite(v) || v <= 0 ? null : v;
        if (tchmi_equal(clean, this.__mapScale)) { return; }
        this.__mapScale = clean;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapScale' });
    }
    /** @returns CSS px per mm, or `null` when nothing is drawn. */
    public getMapScale(): number | null { return this.__mapScale; }

    /**
     * Raises `.onGroupSelected` with the descriptor.
     *
     * ---- WHAT IS AND IS NOT IN THE PAYLOAD ----
     *
     * The group descriptor and nothing else: counts, a truncated histogram, a
     * severity, the quad's lattice corners, the decoration flag. **Not the member
     * cells** — a 12 900-cell group as a list of objects is about 1.5 MB built and
     * serialized on every tap. `readGroupMembers(id)` is the escape hatch
     * for the tap that needs them.
     *
     * `onItemSelected` is NOT raised alongside it. A group is not an item and has no
     * item id, status or user data, so filling those fields would mean inventing
     * them; and a handler bound to `onItemSelected` expecting one die would receive
     * a summary of thousands. The two events are disjoint by design, and which one
     * fires is decided by whether a die is big enough to tap on its own.
     * @param group The descriptor.
     * @returns Nothing.
     * @fires onGroupSelected
     */
    protected override __raiseGroupSelected(group: SubstrateMapGroupSelection): void {
        TcHmi.EventProvider.raise(this.__id + '.onGroupSelected', {
            id: group.id,
            corners: group.corners,
            cellCount: group.cellCount,
            severity: group.severity,
            bins: group.bins.map((b) => ({ code: b.code, count: b.count })),
            otherCount: group.otherCount,
            otherBins: group.otherBins,
            decorated: group.decorated,
        });
    }

    /**
     * The whole bound lattice counted by bin code.
     *
     * ```
     * { totalCells, nullCount, bins: [ { code, count, quality, severity, color } ] }
     * ```
     *
     * ---- WHY THIS IS A FUNCTION AND NOT AN ATTRIBUTE ----
     *
     * Nothing binds it. Anyone who needs these numbers in a back end has an MES
     * that already has them; this is a front end, and a bindable output would
     * recompute the whole lattice on every scene change to feed a symbol nobody
     * reads. Asked for explicitly, computed once, thrown away.
     *
     * ---- UNTRUNCATED, UNLIKE A GROUP ----
     *
     * `onGroupSelected`'s histogram is capped at ten because an event payload is
     * O(K) in something the DOCUMENT controls and is rebuilt on every tap. Neither
     * holds here, and a bar chart that hides the eleventh-largest code is worthless.
     *
     * ---- `color` IS THE RENDERED COLOR ----
     *
     * Resolved through the same `resolveBinColor` the render path uses, with the
     * same `StatusColorMapping` and `BinQualityAliases` the scene is holding — not
     * the raw mapping value. A chart built from the raw mapping shows one color
     * where the map shows another for every code the mapping does not name, and two
     * palettes disagreeing is the one failure this function could introduce that
     * nothing else in the tree would catch.
     *
     * NEVER `null`. With nothing bound the answer is `totalCells: 0` and an empty
     * list, which is a chart that draws its empty state; `null` is a thing every
     * caller has to branch on before it can draw anything at all.
     * @returns The counts. Never null.
     */
    public readBinStatistics(): BinStatistics {
        const grid = this.__sceneGrid;
        if (grid === null) { return { totalCells: 0, nullCount: 0, bins: [] }; }
        /*
         * The SCENE's mapping and aliases, not the attributes'. `__syncScene`
         * resolves the demo's own palette into `__sceneMapping`, so reading
         * `__statusColorMapping` here would color a demo chart differently from the
         * demo map beside it.
         */
        return binStatistics(grid, this.__sceneMapping, this.__readColors(),
            this.__sceneBinSeverityPriority, this.__sceneBinQualityAliases,
            this.__sceneCategorical, this.__sceneHighlight);
    }

    /**
     * The cells a group holds, computed on demand.
     *
     * ---- THE ESCAPE HATCH ----
     *
     * `onGroupSelected` hands the author a SUMMARY — counts, a truncated histogram,
     * a severity — because a 12 900-cell group as a list of objects is about 1.5 MB
     * built and serialized on every tap. Most taps need the summary and
     * nothing else. This is for the tap that does: the drill-down popup, the
     * "export these dies" button, the follow-up query.
     *
     * **Cheap by default, complete when asked.** Nothing is retained between calls
     * and nothing is precomputed; the group is re-enumerated from its id against the
     * matrices of the moment.
     *
     * **A `Uint32Array`, deliberately.** Row-major cell indices and not item
     * objects: the whole point is that asking for the members does not allocate the
     * thing the descriptor exists to avoid. 12 900 indices is 52 KB.
     *
     * The id is one `onGroupSelected` produced **in the current view**. After a pan
     * or a resize the group it named no longer exists, and the result is empty
     * rather than wrong.
     * Named `read…` and not `get…`: `getX` is the attribute-getter convention in
     * this control, and `check-descriptors.mjs` reads it that way — a function
     * called `getGroupMembers` would be reported as an undeclared attribute. The
     * sibling functions are `toGridData` and `toE142Xml`, so the prefix carries
     * meaning here rather than being style.
     * @param groupId A group id from a `SubstrateMapGroupSelection`.
     * @returns The member cell indices, ascending. Empty when the id is unknown,
     *          unparseable, or no map is bound.
     */
    public readGroupMembers(groupId: string): Uint32Array {
        const grid = this.__sceneGrid;
        const cfg = grid === null ? null : this.__makeConfig();
        if (grid === null || cfg === null) { return new Uint32Array(0); }
        // Recomputed rather than cached, exactly as the hit path does: the matrices
        // are a pure function of the config and the scene, and one way of getting
        // them is one thing that can be wrong.
        const dpr = window.devicePixelRatio || 1;
        const matrices = this.__computeMatrices(cfg, dpr);
        if (!matrices.fitBox || matrices.scale <= 0) { return new Uint32Array(0); }
        // The SAME derivation the hit path uses. The id round-trips
        // only if both sides build an identical tiling, and the base owns that
        // derivation precisely so this cannot drift from it. `__groupTilePx` is
        // left in place: it is protected, and a constant tile side is no longer
        // what the tiling is made of, so removing it belongs with the next task
        // that touches this class rather than in the middle of a signature change.
        const rect = groupTileRect(TcHmi.ValueConverter.toString(groupId) ?? '',
            this.__groupTiling(matrices, dpr));
        if (rect === null) { return new Uint32Array(0); }
        return cellsInGroup(rect, grid, deviceMatrix(matrices.dprBase, matrices.world));
    }

    /**
     * The group tile's side in device pixels.
     *
     * `TouchTargetSize` is CSS pixels and the group grid lives in device pixels, so
     * the ratio is applied here.
     * @param dpr Device pixels per CSS pixel.
     * @returns The side in device px.
     */
    protected __groupTilePx(dpr: number): number {
        return this.__touchTargetSize * (dpr > 0 ? dpr : 1);
    }

    /**
     * Read-only output: cells per device pixel, by **area**.
     *
     * The number a legend needs for *"1 px = 6 dies"*, so it is the area count and
     * not the linear one. The two differ by a square and both get said — 6 dies
     * per pixel is 2.4 dies across. `null` when no map is
     * bound.
     * @param valueNew The factor.
     * @returns Nothing.
     */
    public setAggregationFactor(valueNew: number | null): void {
        const v = TcHmi.ValueConverter.toNumber(valueNew);
        // Infinity is what a degenerate lattice reports; it is not a number a
        // binding can render, and "every cell in one pixel" is better said with
        // nothing than with a word the HMI will print raw.
        //
        // NOT COVERED BY A MUTATION, deliberately. The test harness's
        // `ValueConverter.toNumber` rejects Infinity and its `tchmi_equal` is
        // JSON-based, where Infinity serializes to `null` - so both doubles already
        // do what this line does and removing it changes nothing a test can see.
        // TwinCAT's own converter and comparator promise neither, so the line stays.
        const clean = v === null || !Number.isFinite(v) ? null : v;
        if (tchmi_equal(clean, this.__aggregationFactor)) { return; }
        this.__aggregationFactor = clean;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'AggregationFactor' });
    }
    /** @returns Cells per device pixel by area, or `null` when no map is bound. */
    public getAggregationFactor(): number | null { return this.__aggregationFactor; }

    /**
     * Read-only output: which reduction produced the frame just drawn.
     *
     * `'None'` when a cell covers at least one device pixel and every cell is drawn
     * in its own right, `'PointSample'` when cells are smaller than a pixel and the
     * renderer is still picking one cell per pixel.
     *
     * **`'PointSample'` is a defect being reported, not a feature.** Below one cell
     * per pixel the current renderer maps each pixel back to exactly one cell and
     * paints that; every other cell in the pixel is invisible, and which one
     * survives is decided by subpixel phase
     * (`tests/grid-aliasing.test.mjs` measures a failing die vanishing at all eight
     * phases by factor 20). Saying so is the honest thing an operator can act on,
     * and a frame that aggregates reports its reducer by name instead.
     * @param valueNew The mode.
     * @returns Nothing.
     */
    public setAggregationMode(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__aggregationMode)) { return; }
        this.__aggregationMode = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'AggregationMode' });
    }
    /** @returns The reduction in use, or `null` when no map is bound. */
    public getAggregationMode(): string | null { return this.__aggregationMode; }

    /**
     * Reports the two ways a severity priority list can be wrong, once each.
     *
     * Both are warnings and not errors: the map still renders, and both are things
     * a reasonable author does while learning the attribute.
     * @returns Nothing.
     */
    protected __warnBinSeverityPriority(): void {
        const priority = this.__binSeverityPriority;
        const grid = this.__sceneGrid;
        if (priority === null || priority.length === 0 || grid === null) { return; }

        const byCode = new Map(grid.binTable.map((e) => [e.code, e]));
        for (const code of priority) {
            const entry = byCode.get(code);

            // 1. Listed, but the map has no such bin. Usually a typo, or a list
            //    carried over from another product.
            if (entry === undefined) {
                this.__warnOncePriority('unused\u0001' + code,
                    `E142_BIN_SEVERITY_PRIORITY_UNUSED: BinSeverityPriority lists "${code}", which the `
                    + 'bound map has no bin for. The entry is ignored and nothing else changes — check '
                    + "it against the document's BinDefinitions.");
                continue;
            }

            // 2. Listed, but the document says the bin passes. The list is ignored
            //    for it, because promoting it could hide a real failure.
            if (resolveBinQuality(entry.quality, this.__binQualityAliases) === 'pass') {
                this.__warnOncePriority('pass\u0001' + code,
                    `E142_BIN_SEVERITY_PRIORITY_IGNORED: BinSeverityPriority lists "${code}", but the `
                    + 'document gives it a BinQuality that resolves to pass. The list is IGNORED for '
                    + 'that bin and its severity stays pass. Promoting it would let a tile holding one '
                    + 'passing and one failing die reduce to the passing bin, hiding the failure. If '
                    + `"${code}" is not a good bin, correct its BinQuality or map it with `
                    + 'BinQualityAliases.');
            }
        }
    }

    /**
     * Logs a priority-list warning unless it has already been made.
     * @param key     The dedup key.
     * @param message The warning.
     * @returns Nothing.
     */
    protected __warnOncePriority(key: string, message: string): void {
        if (this.__binPriorityWarned.has(key)) { return; }
        this.__binPriorityWarned.add(key);
        this.__logWarnings([message]);
    }

    /**
     * Reports every declared `BinQuality` this control cannot place on a severity
     * scale, once each.
     *
     * Raised HERE and not in `resolveBinColor`, which runs on every frame: a
     * per-frame warning is noise, and the moment an author can act on this is when
     * the document arrives or the alias map changes.
     *
     * An absent or empty token is never reported — E142-0225: *"If not present then
     * BinQuality is undefined"* — and neither is an unmapped one that has already
     * been named since the aliases last changed.
     * @returns Nothing.
     */
    protected __warnUnmappedBinQualities(): void {
        const grid = this.__sceneGrid;
        if (grid === null) { return; }
        for (const entry of grid.binTable) {
            if (resolveBinQuality(entry.quality, this.__binQualityAliases) !== 'unmapped') { continue; }
            const token = String(entry.quality).trim();
            const key = entry.code + '\u0001' + token;
            if (this.__binQualityWarned.has(key)) { continue; }
            this.__binQualityWarned.add(key);
            this.__logWarnings([
                `E142_BIN_QUALITY_UNMAPPED: BinCode "${entry.code}" declares BinQuality "${token}", `
                + 'which is neither of the two values E142 reserves (Pass, Fail) and has no '
                + 'BinQualityAliases entry. The document is legal — the standard allows '
                + 'application-defined values — but this control cannot place the token on a severity '
                + 'scale, so the bin is drawn in the unknown color. Map it with BinQualityAliases, '
                + `e.g. { "${token}": "fail" }.`,
            ]);
        }
    }

    /**
     * Sets the label list. A non-array (or `null`) clears it. Rebuilds the
     * derived labels and re-renders on change.
     * @param valueNew New {@link SubstrateMapLabelList}, or `null` to clear.
     */
    public setLabels(valueNew: SubstrateMapLabelList | null): void {
        let v = TcHmi.ValueConverter.toObject<SubstrateMapLabelList>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Labels') as SubstrateMapLabelList | null;
        }
        if (tchmi_equal(v, this.__labels)) { return; }
        this.__labels = Array.isArray(v) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Labels' });
        this.__rebuildLabels();
        this.__requestRender();
    }
    /** @returns The current label list, or `null`. */
    public getLabels(): SubstrateMapLabelList | null { return this.__labels; }

    /**
     * Sets the substrate outline. A non-object (or `null`) clears it. Rebuilds
     * the derived outline and re-renders on change.
     * @param valueNew New {@link Outline}, or `null` to clear.
     */
    public setOutline(valueNew: Outline | null): void {
        let v = TcHmi.ValueConverter.toObject<Outline>(valueNew);
        if (v === null) {
            v = this.getAttributeDefaultValueInternal('Outline') as Outline | null;
        }
        if (tchmi_equal(v, this.__outline)) { return; }
        this.__outline = (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'Outline' });
        this.__rebuildOutline();
        this.__requestRender();
    }
    /** @returns The current substrate outline, or `null`. */
    public getOutline(): Outline | null { return this.__outline; }

    /**
     * Sets the built-in outline preset by key. Values outside {@link PRESET_KEYS}
     * (every preset-table key plus `'none'`) fall back to the attribute default. No-ops
     * if unchanged; otherwise raises `onPropertyChanged`, regenerates the preset
     * model and re-renders. A bound {@link setOutline} still wins over the preset.
     * @param valueNew New preset key, or `null` to use the default.
     */
    public setOutlinePreset(valueNew: string | null): void {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || PRESET_KEYS.indexOf(v as PresetKey) === -1) {
            v = this.getAttributeDefaultValueInternal('OutlinePreset') as string;
        }
        if (tchmi_equal(v, this.__outlinePreset)) { return; }
        this.__outlinePreset = v as PresetKey;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OutlinePreset' });
        this.__rebuildPreset();
    }
    /** @returns The current outline preset key (`'none'` when no preset is selected). */
    public getOutlinePreset(): PresetKey { return this.__outlinePreset; }

    /**
     * Sets the secondary-flat direction for disc-flats presets. Values other than
     * `'cw'` / `'ccw'` fall back to the attribute default. No-ops if unchanged;
     * otherwise raises `onPropertyChanged`, regenerates the (disc-flats) preset
     * model and re-renders.
     * @param valueNew New direction, or `null` to use the default.
     */
    public setSecondaryFlatDirection(valueNew: string | null): void {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v !== 'cw' && v !== 'ccw') {
            v = this.getAttributeDefaultValueInternal('SecondaryFlatDirection') as string;
        }
        if (tchmi_equal(v, this.__secDir)) { return; }
        this.__secDir = v as SecDir;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SecondaryFlatDirection' });
        this.__rebuildPreset();
    }
    /** @returns The current secondary-flat direction. */
    public getSecondaryFlatDirection(): SecDir { return this.__secDir; }

    /**
     * Sets the visual notch magnification for disc-notch presets, clamped to
     * `>= 1`. No-ops if unchanged; otherwise raises `onPropertyChanged`,
     * regenerates the preset model and re-renders. Affects disc-notch presets
     * only - a bound {@link setOutline} is never scaled.
     * @param valueNew New magnification, or `null` to use the default.
     */
    public setNotchExaggeration(valueNew: number | null): void {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) {
            n = this.getAttributeDefaultValueInternal('NotchExaggeration') as number;
        }
        if (n < 1) { n = 1; }
        if (tchmi_equal(n, this.__notchScale)) { return; }
        this.__notchScale = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'NotchExaggeration' });
        this.__rebuildPreset();
    }
    /** @returns The current notch magnification. */
    public getNotchExaggeration(): number { return this.__notchScale; }

    // ---------------------------------------------------------------
    //  Origin (data-frame placement)
    //  These six attributes place the DATA frame D (Items and Labels only); the
    //  Outline is authored in the substrate frame S and never moves. Each setter
    //  validates (invalid input keeps the old value), and on a real change raises
    //  onPropertyChanged, re-resolves the placement to the engine via
    //  {@link __syncPlacement} and re-renders.
    // ---------------------------------------------------------------

    /**
     * Sets the anchor of the data origin on the fit box (the outline bounding box;
     * without an outline, the grid's extent or the default substrate): one of `'center'`,
     * `'top-left'`, `'bottom-left'`, `'top-right'`, `'bottom-right'` (`'top'` = +y
     * edge, `'left'` = -x edge of the box, in S). An unrecognized value keeps the
     * current anchor. No-ops if unchanged.
     * @param valueNew New anchor, or `null` (ignored -> keep current).
     */
    public setOriginLocation(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || ORIGIN_LOCATIONS.indexOf(v) === -1) { return; }   // invalid -> keep old value
        if (tchmi_equal(v, this.__originLocation)) { return; }
        this.__originLocation = v as OriginAnchor;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginLocation' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-origin anchor. */
    public getOriginLocation(): OriginAnchor { return this.__originLocation; }

    /**
     * Sets the data-origin X offset, added to the anchor along the SUBSTRATE +x
     * axis (independent of `YAxisDirection`). Base unit meter, scaled by
     * {@link setOriginOffsetPrefix}. A non-finite value keeps the current offset.
     * No-ops if unchanged.
     * @param valueNew New X offset, or `null` (ignored -> keep current).
     */
    public setOriginOffsetX(valueNew: number | null): void {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) { return; }   // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__originOffsetX)) { return; }
        this.__originOffsetX = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginOffsetX' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-origin X offset (in `OriginOffsetPrefix` meters). */
    public getOriginOffsetX(): number { return this.__originOffsetX; }

    /**
     * Sets the data-origin Y offset, added to the anchor along the SUBSTRATE +y
     * axis (up, independent of `YAxisDirection`). Base unit meter, scaled by
     * {@link setOriginOffsetPrefix}. A non-finite value keeps the current offset.
     * No-ops if unchanged.
     * @param valueNew New Y offset, or `null` (ignored -> keep current).
     */
    public setOriginOffsetY(valueNew: number | null): void {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) { return; }   // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__originOffsetY)) { return; }
        this.__originOffsetY = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginOffsetY' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-origin Y offset (in `OriginOffsetPrefix` meters). */
    public getOriginOffsetY(): number { return this.__originOffsetY; }

    /**
     * Sets the metric prefix scaling the (meter-based) origin offsets, one of the
     * standard prefixes `yocto`..`none`. An unrecognized value keeps the current
     * prefix. No-ops if unchanged.
     * @param valueNew New prefix, or `null` (ignored -> keep current).
     */
    public setOriginOffsetPrefix(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || PREFIXES.indexOf(v) === -1) { return; }   // invalid -> keep old value
        if (tchmi_equal(v, this.__originOffsetPrefix)) { return; }
        this.__originOffsetPrefix = v as MetricPrefix;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginOffsetPrefix' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current origin-offset metric prefix. */
    public getOriginOffsetPrefix(): MetricPrefix { return this.__originOffsetPrefix; }

    /**
     * Sets the data-axes rotation about the data origin, in degrees,
     * counter-clockwise-positive as seen in S (and CCW on screen). Rotates the
     * Item/Label ensemble about the anchor, NOT about the substrate center. A
     * non-finite value keeps the current rotation. No-ops if unchanged.
     * @param valueNew New rotation in degrees, or `null` (ignored -> keep current).
     */
    public setOriginRotation(valueNew: number | null): void {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) { return; }   // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__originRotation)) { return; }
        this.__originRotation = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'OriginRotation' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data-axes rotation in degrees. */
    public getOriginRotation(): number { return this.__originRotation; }

    /**
     * Sets the data Y-axis direction: `'up'` (default) or `'down'`. `'down'`
     * mirrors D's y axis for vision systems whose +y grows downward; a
     * CCW-positive Item orientation authored in that y-down frame then renders
     * clockwise on screen (the correct physical behavior). Does not move the
     * outline. An unrecognized value keeps the current direction. No-ops if
     * unchanged.
     * @param valueNew New direction, or `null` (ignored -> keep current).
     */
    public setYAxisDirection(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || Y_AXIS_DIRECTIONS.indexOf(v) === -1) { return; }   // invalid -> keep old value
        if (tchmi_equal(v, this.__yAxisDirection)) { return; }
        this.__yAxisDirection = v as YAxisDirection;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'YAxisDirection' });
        this.__syncPlacement();
        this.__requestRender();
    }
    /** @returns The current data Y-axis direction. */
    public getYAxisDirection(): YAxisDirection { return this.__yAxisDirection; }

    /**
     * Toggles the origin marker: a diagnostic crosshair on the data origin plus a
     * +x and a +y data-axis stub with arrowheads (the +y head doubled, so the two
     * axes are told apart by shape, not color). Off by default. Drawn under the
     * full data matrix, so it shows the data origin's position, `OriginRotation`
     * and `YAxisDirection` at once - `'down'` flips the +y stub to point downward on
     * screen. Screen-constant in size; purely visual and never selectable. No-ops
     * if unchanged.
     * @param valueNew New flag, or `null` to use the default.
     */
    public setShowOriginMarker(valueNew: boolean | null): void {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) {
            b = this.getAttributeDefaultValueInternal('ShowOriginMarker') as boolean;
        }
        if (tchmi_equal(b, this.__showOriginMarker)) { return; }
        this.__showOriginMarker = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowOriginMarker' });
        this.__updateShowOriginMarker(b);
        this.__requestRender();
    }
    /** @returns Whether the origin marker is enabled. */
    public getShowOriginMarker(): boolean { return this.__showOriginMarker; }

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
    public setMapRotation(valueNew: number | null): void {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null || !Number.isFinite(n)) { return; }   // invalid / non-finite -> keep old value
        if (tchmi_equal(n, this.__mapRotation)) { return; }
        this.__mapRotation = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapRotation' });
        this.__syncViewRotation();
        this.__requestRender();
    }
    /** @returns The current view rotation in degrees. */
    public getMapRotation(): number { return this.__mapRotation; }

    /**
     * Sets the selection mode. Values other than `'single'` / `'multi'` fall
     * back to the attribute default. Switching mode clears the current selection
     * (single and multi semantics differ) and re-renders on change.
     * @param valueNew New selection mode, or `null` to use the default.
     */
    public setSelectionMode(valueNew: string | null): void {
        let v = TcHmi.ValueConverter.toString(valueNew);
        if (v === null || SELECTION_MODES.indexOf(v) === -1) {
            v = this.getAttributeDefaultValueInternal('SelectionMode') as string;
        }
        if (tchmi_equal(v, this.__selectionMode)) { return; }
        // The base owns the mode (shell state) and drops the base-side selection
        // state on the switch; this setter then clears the concrete read-only
        // outputs and re-renders so any stale rings are gone.
        this.__setSelectionMode(v as 'single' | 'multi');
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectionMode' });
        this.__setSelectedOutputs(null);
        this.setSelectedItems(null);
        this.__requestRender();
    }
    /**
     * @returns The current selection mode.
     *
     * Narrowed deliberately. The base's field includes `'none'` for controls
     * that do not select at all, but this control always does - its whole
     * selection surface exists - and `'none'` is not one of the values its
     * `SelectionMode` attribute accepts. Widening this signature would advertise a
     * mode an author cannot set.
     */
    public getSelectionMode(): 'single' | 'multi' {
        return this.__selectionMode as 'single' | 'multi';
    }

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
     * Sets the E142.1 MapData XML document. Parses it, resolves
     * the overlay (see {@link setE142OverlayName}), resolves the layout, computes
     * the grid placement and pushes the built grid to the shell. On any failure
     * the framework logger is called, {@link getE142LastError} is set and the grid
     * is cleared. A non-null value makes XML the active input (mutually exclusive
     * with {@link setE142TransferData} and {@link setGridData} - a warning is
     * logged when more than one is bound). No-ops if unchanged.
     * @param valueNew New XML document, or `null` to unbind.
     */
    public setE142MapData(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142MapData)) { return; }
        this.__e142MapData = v;
        this.__stampReceived();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142MapData' });
        if (v !== null) {
            const previous = this.__activeInput;
            this.__activeInput = 'xml';
            this.__warnIfMultipleInputs(previous, 'xml');
        } else if (this.__activeInput === 'xml') {
            this.__activeInput = this.__fallbackActiveInput();
        }
        this.__e142Doc = null;   // the XML changed: force a fresh parse
        this.__rebuildMap();
    }
    /** @returns The bound E142 MapData XML, or `null`. */
    public getE142MapData(): string | null { return this.__e142MapData; }

    /**
     * Binds a SEMI E142.1 MapData document in its JSON representation.
     *
     * The same document `E142MapData` carries, in a different encoding: both parse
     * to one `E142Document` through one implementation of every rule, so a map
     * bound here renders identically to the same map bound as XML. Mutually
     * exclusive with the other inputs on the usual terms - the most recent non-null
     * write wins - and defaults to `null`, so no existing binding changes meaning.
     *
     * Accepts an OBJECT as well as a string. That is the point of the feature: an
     * `E142MapDataJson` binding arrives as a typed HMI symbol, and forcing it
     * through `JSON.stringify` so the parser can immediately parse it back would
     * undo the reason for having it.
     * @param valueNew The document, as a parsed object or as text; `null` unbinds.
     */
    public setE142MapDataJson(valueNew: object | string | null): void {
        // NOT ValueConverter.toString: that would flatten an object binding to
        // "[object Object]" and lose the document entirely. An object is taken as
        // it is; a string is left a string; anything else is not a document.
        const v: object | string | null = (valueNew === undefined || valueNew === null)
            ? null
            : valueNew;
        if (tchmi_equal(v, this.__e142MapDataJson)) { return; }
        this.__e142MapDataJson = v;
        this.__stampReceived();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142MapDataJson' });
        if (v !== null) {
            const previous = this.__activeInput;
            this.__activeInput = 'json';
            this.__warnIfMultipleInputs(previous, 'json');
        } else if (this.__activeInput === 'json') {
            this.__activeInput = this.__fallbackActiveInput();
        }
        this.__e142Doc = null;   // the document changed: force a fresh parse
        this.__rebuildMap();
    }
    /** @returns The bound E142 MapData JSON document, or `null`. */
    public getE142MapDataJson(): object | string | null { return this.__e142MapDataJson; }


    /**
     * Sets the compact GridData v1 document. Normalizes it and
     * runs the SAME downstream chain and error handling as {@link setE142MapData}.
     * A non-null value makes GridData the active input (mutually exclusive with
     * E142MapData). No-ops if unchanged.
     * @param valueNew New GridData document, or `null` to unbind.
     */
    public setGridData(valueNew: GridData | null): void {
        const o = TcHmi.ValueConverter.toObject<GridData>(valueNew);
        const v = (o !== null && typeof o === 'object') ? o : null;
        if (tchmi_equal(v, this.__gridData)) { return; }
        this.__gridData = v;
        this.__stampReceived();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'GridData' });
        if (v !== null) {
            const previous = this.__activeInput;
            this.__activeInput = 'grid';
            this.__warnIfMultipleInputs(previous, 'grid');
        } else if (this.__activeInput === 'grid') {
            this.__activeInput = this.__fallbackActiveInput();
        }
        this.__rebuildMap();
    }
    /** @returns The bound GridData document, or `null`. */
    public getGridData(): GridData | null { return this.__gridData; }

    /**
     * Sets the E142.4 (Stream-21) reassembled item content: a
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
     * `ITEMTYPE` string is inspected or hard-coded here. The value is normatively
     * fixed - `[E142.04-RQ-00006-00]` gives `SEMI:SUBSTRATEMAPDATA:<SubstrateType>`
     * and `[E142.04-RQ-00007-00]` requires `S21F9` for discovering the values an
     * equipment supports - but by the time item content reaches this setter it is
     * a value on a bound symbol, and the item type was consumed upstream. Filtering
     * by item type belongs in the host stack.
     * @param valueNew New item content (base64 string or byte-value array), or
     *                 `null` to unbind.
     */
    public setE142TransferData(valueNew: string | number[] | null): void {
        const v = SubstrateMap.__normalizeTransferInput(valueNew);
        if (tchmi_equal(v, this.__e142TransferData)) { return; }
        this.__e142TransferData = v;
        this.__stampReceived();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142TransferData' });
        if (v !== null) {
            const previous = this.__activeInput;
            this.__activeInput = 'transfer';
            this.__warnIfMultipleInputs(previous, 'transfer');
        } else if (this.__activeInput === 'transfer') {
            this.__activeInput = this.__fallbackActiveInput();
        }
        this.__e142Doc = null;   // new/removed item bytes: force a fresh decode + parse
        this.__rebuildMap();
    }
    /** @returns The bound transfer item content (base64 string or byte-value array), or `null`. */
    public getE142TransferData(): string | number[] | null { return this.__e142TransferData; }

    /**
     * Sets which `SubstrateMap` to render, by its `@SubstrateId`.
     *
     * Together with {@link setE142LayoutSpecifier} this is a COMPLETE selector,
     * which is worth stating because the overlay case is not.
     * `SubstrateMapKey` is an `xs:key` over (`@SubstrateType`, `@SubstrateId`,
     * `@LayoutSpecifier`), so in any schema-valid document those
     * three are unique and there is nothing to disambiguate positionally.
     *
     * E142-0225 12.1.2 reads as though they were not: "If there are more than
     * one SubstrateMap assigned to a Substrate and Layout combination they
     * should differ in either their Orientation, OriginLocation or both. For
     * example, there may be a map for the top side and one for the bottom side
     * of a Layout." That example is SCHEMA-IMPOSSIBLE as
     * written - neither `Orientation` nor `OriginLocation` is in the key, so the
     * two maps collide on `['Wafer', 'W1', 'L']` and `xmllint` rejects the
     * document. Verified against the vendored XSD. A conforming document
     * expresses the same intent by giving the two sides different
     * `LayoutSpecifier`s, which is why this attribute has a partner.
     *
     * Applied by map selection ({@link selectMapAndOverlay}); stored, published
     * and re-resolved like {@link setE142OverlayName}.
     *
     * @param valueNew New substrate id, or `null` for no filter.
     */
    public setE142SubstrateId(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142SubstrateId)) { return; }
        this.__e142SubstrateId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142SubstrateId' });
        if (this.__activeInputIsE142Document()) {
            this.__rebuildMap();   // reuses __e142Doc: no re-parse
        }
    }
    /** @returns The bound substrate id filter, or `null`. */
    public getE142SubstrateId(): string | null { return this.__e142SubstrateId; }

    /**
     * Sets which `SubstrateMap` to render, by its `@LayoutSpecifier` - the third
     * field of `SubstrateMapKey`. See {@link setE142SubstrateId} for why the two
     * together are a complete selector.
     *
     * The value is the specifier as written in the document, including any path
     * separators: a two-level tree is selected as `"Top/Devices"`, not as
     * `"Devices"`. Matching a suffix would be guessing at which of several
     * paths ending in the same leaf was meant.
     *
     * Applied by map selection ({@link selectMapAndOverlay}).
     *
     * @param valueNew New layout specifier, or `null` for no filter.
     */
    public setE142LayoutSpecifier(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142LayoutSpecifier)) { return; }
        this.__e142LayoutSpecifier = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142LayoutSpecifier' });
        if (this.__activeInputIsE142Document()) {
            this.__rebuildMap();   // reuses __e142Doc: no re-parse
        }
    }
    /** @returns The bound layout specifier filter, or `null`. */
    public getE142LayoutSpecifier(): string | null { return this.__e142LayoutSpecifier; }

    /**
     * Sets the overlay to render from the E142 document, by MapName; `null`
     * selects the first renderable BinCodeMap overlay in document order.
     * Re-resolves against the CACHED parse without re-parsing, for either
     * XML-document input (E142MapData or the E142.4 transfer path).
     * Inert while the GridData path is active (GridData has no overlays). No-ops
     * if unchanged.
     * @param valueNew New overlay name, or `null` for the first renderable overlay.
     */
    public setE142OverlayName(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142OverlayName)) { return; }
        this.__e142OverlayName = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142OverlayName' });
        if (this.__activeInputIsE142Document()) {
            this.__rebuildMap();   // reuses __e142Doc: no re-parse
        }
    }
    /** @returns The bound overlay name, or `null`. */
    public getE142OverlayName(): string | null { return this.__e142OverlayName; }

    /**
     * Sets the overlay version to render, by `Overlay/@MapVersion`.
     *
     * `MapName` alone does not identify an overlay. The XSD keys `Overlay` on
     * (`@MapName`, `@MapVersion`) - the `OverlayKey` - so one `SubstrateMap` may
     * legitimately carry `Sort`/`1` and `Sort`/`2`, and a name-only selector has
     * to pick one of them by position. This attribute is the second half of that
     * key.
     *
     * NULL AND `""` ARE DIFFERENT and both are meaningful:
     *   `null` - do not filter by version; behave exactly as today
     *   `""`   - select the overlay whose `MapVersion` is empty, which is a REAL
     *            addressable overlay: `@MapVersion` defaults to `""`, so an
     *            overlay that omits the attribute has `""` as its key value
     *            (see {@link gridToE142Xml}'s MapVersion note)
     * Collapsing the two would make the commonest overlay - the one with no
     * version attribute at all - the one that cannot be named.
     *
     * Applied by overlay selection ({@link selectMapAndOverlay}) together with
     * {@link setE142OverlayName}; stored, published and re-resolved like it.
     *
     * @param valueNew New overlay version, or `null` for no version filter.
     */
    public setE142OverlayVersion(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142OverlayVersion)) { return; }
        this.__e142OverlayVersion = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142OverlayVersion' });
        if (this.__activeInputIsE142Document()) {
            this.__rebuildMap();   // reuses __e142Doc: no re-parse
        }
    }
    /** @returns The bound overlay version, or `null`. */
    public getE142OverlayVersion(): string | null { return this.__e142OverlayVersion; }

    /**
     * Sets the fallback column pitch in millimeters for layoutless maps. Used only
     * when BOTH X and Y are set; exactly one set logs a
     * warning and falls through to the fit heuristic. `null` unsets it. Re-renders
     * the active map on change (reusing the cached parse). No-ops if unchanged.
     * @param valueNew New pitch in millimeters, or `null`.
     */
    public setE142FallbackStepSizeX(valueNew: number | null): void {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(n, this.__e142FallbackStepX)) { return; }
        this.__e142FallbackStepX = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142FallbackStepSizeX' });
        if (this.__activeInput !== null) { this.__rebuildMap(); }
    }
    /** @returns The fallback column pitch in millimeters, or `null`. */
    public getE142FallbackStepSizeX(): number | null { return this.__e142FallbackStepX; }

    /**
     * Sets the fallback row pitch in millimeters for layoutless maps (the
     * stage 2); see {@link setE142FallbackStepSizeX}. `null` unsets it. No-ops if
     * unchanged.
     * @param valueNew New pitch in millimeters, or `null`.
     */
    public setE142FallbackStepSizeY(valueNew: number | null): void {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(n, this.__e142FallbackStepY)) { return; }
        this.__e142FallbackStepY = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142FallbackStepSizeY' });
        if (this.__activeInput !== null) { this.__rebuildMap(); }
    }
    /** @returns The fallback row pitch in millimeters, or `null`. */
    public getE142FallbackStepSizeY(): number | null { return this.__e142FallbackStepY; }

    /**
     * Sets the degrees added to the map's Orientation before placement - an escape
     * hatch for a source with another zero reference. A CW-positive source angle; the zero reference is a notch
     * at 6 o'clock at Orientation=0 (see the README). Re-renders the active map on
     * change (reusing the cached parse). No-ops if unchanged.
     * @param valueNew New offset in degrees, or `null` to use the default (0).
     */
    public setE142OrientationOffset(valueNew: number | null): void {
        let n = TcHmi.ValueConverter.toNumber(valueNew);
        if (n === null) { n = this.getAttributeDefaultValueInternal('E142OrientationOffset') as number; }
        if (tchmi_equal(n, this.__e142OrientationOffset)) { return; }
        this.__e142OrientationOffset = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142OrientationOffset' });
        if (this.__activeInput !== null) { this.__rebuildMap(); }
    }
    /** @returns The orientation offset in degrees. */
    public getE142OrientationOffset(): number { return this.__e142OrientationOffset; }

    /**
     * `E142AlignToReferenceDevices`: enable opt-in reference-device registration
     * (the reference-device compute path). When on and the active map (XML only) carries
     * reference devices with Positions, the placement is translated so their model
     * cell-centers meet those Positions; when off (the default), placement is
     * unchanged. A change re-commits the current map.
     * @param valueNew New flag, or `null` to fall back to the attribute default.
     */
    public setE142AlignToReferenceDevices(valueNew: boolean | null): void {
        let b = TcHmi.ValueConverter.toBoolean(valueNew);
        if (b === null) { b = this.getAttributeDefaultValueInternal('E142AlignToReferenceDevices') as boolean; }
        if (tchmi_equal(b, this.__alignToReferenceDevices)) { return; }
        this.__alignToReferenceDevices = b;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142AlignToReferenceDevices' });
        if (this.__activeInput !== null) { this.__rebuildMap(); }
    }
    /** @returns Whether reference-device registration is enabled. */
    public getE142AlignToReferenceDevices(): boolean { return this.__alignToReferenceDevices; }

    // ---------------------------------------------------------------
    //  SEMI E142 export. null means "no active map".
    // ---------------------------------------------------------------

    /**
     * Serializes the CURRENTLY BOUND map back to a canonical {@link GridData}
     * document, or returns `null` when no map is bound. Round-trips: binding the
     * result to {@link setGridData} reproduces the same grid. Pitch is the drawn
     * placement's (physical when the source had scale, nominal otherwise), in mm;
     * `orientation` is the source map's, not the display {@link setE142OrientationOffset}.
     * @returns The GridData, or `null` if no grid is bound.
     */
    public toGridData(): GridData | null {
        const grid = this.__sceneGrid;
        const lb = this.__lastBuilt;
        if (grid === null || lb === null) { return null; }
        return gridToGridData(grid, {
            orientation: lb.orientation,
            originLocation: lb.origin,
            axisDirection: lb.dir,
            binType: lb.binType,
            substrateId: lb.substrateId,
            // The two identity fields the GridData contract declares. It has no
            // SupplierName, Status, SubstrateSide or MapVersion counterpart, so
            // those four are XML-only and are not silently dropped here - there
            // is nowhere in the contract to put them.
            lotId: lb.lotId ?? undefined,
            goodDevices: lb.goodDevices ?? undefined,
            binDefinitions: lb.binDefs,
        });
    }

    /**
     * Serializes the CURRENTLY BOUND map back to an E142 `MapData` XML string, or
     * returns `null` when no map is bound. Round-trips through {@link setE142MapData}.
     * Same pitch / orientation semantics as {@link toGridData}.
     * @returns The E142 XML, or `null` if no grid is bound.
     */
    public toE142Xml(): string | null {
        const grid = this.__sceneGrid;
        const lb = this.__lastBuilt;
        if (grid === null || lb === null) { return null; }
        return gridToE142Xml(grid, {
            substrateType: lb.substrateType,
            substrateId: lb.substrateId,
            orientation: lb.orientation,
            originLocation: lb.origin,
            axisDirection: lb.dir,
            // Everything the source map said about itself that a GridModel does
            // not carry. `substrateSide` in particular is not optional detail:
            // the attribute defaults to TopSide, so omitting it would assert the
            // opposite face for a BottomSide map.
            substrateSide: lb.substrateSide,
            mapVersion: lb.mapVersion ?? undefined,
            lotId: lb.lotId ?? undefined,
            goodDevices: lb.goodDevices ?? undefined,
            supplierName: lb.supplierName ?? undefined,
            status: lb.status ?? undefined,
            aliasIds: lb.aliasIds ?? undefined,
            carrierType: lb.carrierType ?? undefined,
            carrierId: lb.carrierId ?? undefined,
            slotNumber: lb.slotNumber ?? undefined,
            substrateNumber: lb.substrateNumber ?? undefined,
            sourceLayout: lb.sourceLayout ?? undefined,
            transferMaps: lb.transferMaps ?? undefined,
            onWarning: (code, message) => { this.__logWarnings([code + ': ' + message]); },
            binType: lb.binType,
            binDefinitions: lb.binDefs,
        });
    }

    // ---------------------------------------------------------------
    //  SEMI E142 read-only outputs. null means "no active map".
    // ---------------------------------------------------------------

    /**
     * Updates the last-error output. Intended for internal use on map ingestion;
     * raises `onPropertyChanged` on change.
     * @param valueNew New error message, or `null` when the map is clean.
     */
    public setE142LastError(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142LastError)) { return; }
        this.__e142LastError = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142LastError' });
    }
    /** @returns The last map-ingestion error, or `null`. */
    public getE142LastError(): string | null { return this.__e142LastError; }

    /**
     * Updates the map substrate-id output. Intended for internal use on map
     * ingestion; raises `onPropertyChanged` on change.
     * @param valueNew New substrate id, or `null`.
     */
    public setMapSubstrateId(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapSubstrateId)) { return; }
        this.__mapSubstrateId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapSubstrateId' });
    }
    /** @returns The active map's substrate id, or `null`. */
    public getMapSubstrateId(): string | null { return this.__mapSubstrateId; }

    /**
     * Updates the map lot-id output. Intended for internal use on map ingestion;
     * raises `onPropertyChanged` on change.
     * @param valueNew New lot id, or `null`.
     */
    public setMapLotId(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapLotId)) { return; }
        this.__mapLotId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapLotId' });
    }
    /** @returns The active map's lot id, or `null`. */
    public getMapLotId(): string | null { return this.__mapLotId; }

    /**
     * Updates the carrier-type output. Read-only to a view: pushed by
     * {@link __setMapIdentity} on a successful commit and reset by
     * {@link __applyMapError}, never set from a binding.
     * @param valueNew The active map's `Substrate/CarrierType`, or `null`.
     */
    public setMapCarrierType(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapCarrierType)) { return; }
        this.__mapCarrierType = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapCarrierType' });
    }
    /** @returns The active map's carrier type, or `null`. */
    public getMapCarrierType(): string | null { return this.__mapCarrierType; }

    /**
     * Updates the carrier-id output. See {@link setMapCarrierType}.
     * @param valueNew The active map's `Substrate/CarrierId`, or `null`.
     */
    public setMapCarrierId(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapCarrierId)) { return; }
        this.__mapCarrierId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapCarrierId' });
    }
    /** @returns The active map's carrier id, or `null`. */
    public getMapCarrierId(): string | null { return this.__mapCarrierId; }

    /**
     * Updates the slot-number output. See {@link setMapCarrierType}.
     *
     * ZERO IS A VALUE. `SlotNumber` is `xs:nonNegativeInteger`, so slot 0 is a
     * real slot and must not be conflated with "no slot" - which is `null`. A
     * binding testing truthiness rather than `!== null` will read slot 0 as
     * absent; that is the consumer's bug, and this output does not paper over it
     * by shifting the value.
     * @param valueNew The active map's `Substrate/SlotNumber`, or `null`.
     */
    public setMapSlotNumber(valueNew: number | null): void {
        const v = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(v, this.__mapSlotNumber)) { return; }
        this.__mapSlotNumber = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapSlotNumber' });
    }
    /** @returns The active map's slot number, or `null`. */
    public getMapSlotNumber(): number | null { return this.__mapSlotNumber; }

    /**
     * Updates the substrate-number output. See {@link setMapCarrierType} and the
     * zero note on {@link setMapSlotNumber}.
     * @param valueNew The active map's `Substrate/SubstrateNumber`, or `null`.
     */
    public setMapSubstrateNumber(valueNew: number | null): void {
        const v = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(v, this.__mapSubstrateNumber)) { return; }
        this.__mapSubstrateNumber = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapSubstrateNumber' });
    }
    /** @returns The active map's substrate number, or `null`. */
    public getMapSubstrateNumber(): number | null { return this.__mapSubstrateNumber; }

    /**
     * Updates the alias-ids output. See {@link setMapCarrierType}.
     *
     * NULL, NOT AN EMPTY ARRAY, when the source stated no aliases. The two are
     * different claims and E142 can only make the first: `AliasIdsType` requires
     * at least one `AliasId`, so an empty `<AliasIds/>` is schema-invalid and a
     * document cannot say "the alias list is empty". Publishing `[]` would
     * invent that statement, and a view iterating the value sees no difference
     * while one testing `=== null` sees the truth.
     *
     * @param valueNew The active map's aliases, or `null` when none were stated.
     */
    public setMapAliasIds(valueNew: readonly E142AliasId[] | null): void {
        const v = valueNew === null || valueNew === undefined ? null : valueNew;
        if (tchmi_equal(v, this.__mapAliasIds)) { return; }
        this.__mapAliasIds = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapAliasIds' });
    }
    /** @returns The active map's aliases, or `null`. */
    public getMapAliasIds(): readonly E142AliasId[] | null { return this.__mapAliasIds; }

    /**
     * Updates the substrate-count output. Read-only to a view.
     * @param valueNew Number of `SubstrateMap` elements, or `null` when unbound.
     */
    public setMapSubstrateCount(valueNew: number | null): void {
        const v = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(v, this.__mapSubstrateCount)) { return; }
        this.__mapSubstrateCount = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapSubstrateCount' });
    }
    /** @returns How many SubstrateMaps the bound document has, or `null`. */
    public getMapSubstrateCount(): number | null { return this.__mapSubstrateCount; }

    /**
     * Updates the map-side output. Read-only to a view.
     * @param valueNew The built map's `SubstrateSide`, or `null`.
     */
    public setMapSubstrateSide(valueNew: E142SubstrateSide | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew) as E142SubstrateSide | null;
        if (tchmi_equal(v, this.__mapSubstrateSide)) { return; }
        this.__mapSubstrateSide = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapSubstrateSide' });
    }
    /** @returns The built map's SubstrateSide, or `null` when none is bound. */
    public getMapSubstrateSide(): E142SubstrateSide | null { return this.__mapSubstrateSide; }

    /**
     * Sets which face of the substrate to render from.
     *
     * A VIEW transform, not a correction. The control already draws this
     * distinction: {@link setE142OrientationOffset} reconciles a SOURCE-side
     * convention and belongs to the document, while {@link setMapRotation} is a
     * viewer preference that changes nothing about what the document means. Side
     * belongs with the second group, and this attribute is where it lives.
     *
     * `SubstrateSide` in the document is DESCRIPTIVE and never triggers a mirror
     * by itself. The coordinate consequences of a face are already carried by
     * `OriginLocation` and `AxisDirection`, so mirroring on the document's side
     * field would double-flip a conforming map - see
     * `ws/notes/DECISION-substrate-side.md` for the reading of Figure R2-17 and
     * the axis, and its grade.
     *
     * | value | behavior |
     * | --- | --- |
     * | `follow-map` (default) | no mirror; drawn as seen from the face the map describes |
     * | `TopSide` | mirror when the map's `SubstrateSide` is `BottomSide` |
     * | `BottomSide` | mirror when the map's `SubstrateSide` is `TopSide` |
     *
     * An unrecognized value warns and falls back to `follow-map` rather than
     * throwing: a bad binding should not blank the map.
     *
     * @param valueNew `follow-map`, `TopSide` or `BottomSide`; `null` restores the default.
     */
    public setViewSubstrateSide(valueNew: string | null): void {
        const raw = TcHmi.ValueConverter.toString(valueNew);
        let v: ViewSubstrateSide;
        if (raw === null || raw === '' || raw === 'follow-map') {
            v = 'follow-map';
        } else if (raw === 'TopSide' || raw === 'BottomSide') {
            v = raw;
        } else {
            this.__logWarnings([
                `ViewSubstrateSide '${raw}' is not one of follow-map, TopSide, BottomSide; `
                + 'falling back to follow-map (no mirror).',
            ]);
            v = 'follow-map';
        }
        if (tchmi_equal(v, this.__viewSubstrateSide)) { return; }
        this.__viewSubstrateSide = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ViewSubstrateSide' });
        this.__rebuildMap();
    }
    /** @returns The requested view side. */
    public getViewSubstrateSide(): ViewSubstrateSide { return this.__viewSubstrateSide; }

    /**
     * Selects which `DeviceDataMap` overlay supplies the per-cell readings.
     *
     * Mirrors {@link setE142OverlayName}, which picks the RENDERABLE overlay. The
     * two are separate because `OverlayType` is an `xs:choice`: an overlay
     * carries a `BinCodeMap` OR device data, never both, so a document showing
     * bin codes and reporting parameters is using two overlays and needs two
     * selectors.
     *
     * `null` takes the first overlay that carries device data. A name that
     * matches none reports an error and supplies no readings.
     *
     * @param valueNew The `MapName` to join, or `null` for the first.
     */
    public setE142DeviceDataOverlayName(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142DeviceDataOverlayName)) { return; }
        this.__e142DeviceDataOverlayName = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142DeviceDataOverlayName' });
        this.__rebuildMap();
    }
    /** @returns The requested DeviceDataMap overlay name, or `null`. */
    public getE142DeviceDataOverlayName(): string | null { return this.__e142DeviceDataOverlayName; }

    /**
     * Sets the ordered list of overlays to compose: one base plus decorations.
     *
     * `null` - the default - keeps the single-overlay behavior driven by
     * {@link setE142OverlayName} / {@link setE142OverlayVersion}, so an existing
     * view is unaffected by this attribute existing.
     *
     * MUTUALLY EXCLUSIVE WITH THOSE TWO, and the list wins. A document cannot
     * have two answers to "which overlay renders", and silently preferring one
     * would make the other look broken; binding both is reported once and the
     * list is used. The list is the more specific instruction, and it is the one
     * a caller had to write deliberately.
     *
     * ORDER IS THE CALLER'S. `OverlayKey` is (`MapName`, `MapVersion`) - an
     * `xs:key`, a SET - so E142 declares no z-order and one must not be inferred
     * from element order in the file.
     *
     * ROLES. Exactly one entry may be `'base'`. If no entry states a role the
     * FIRST is the base and the rest are decorations, which is the common case
     * written the short way. Two bases is a contradiction, not a preference, so
     * it is reported and the first is used.
     *
     * @param valueNew The list, or `null` to fall back to the single-overlay attributes.
     */
    public setE142Overlays(valueNew: OverlaySpec[] | null): void {
        let v: OverlaySpec[] | null = null;
        if (Array.isArray(valueNew) && valueNew.length > 0) {
            const cleaned: OverlaySpec[] = [];
            for (let i = 0; i < valueNew.length; i++) {
                const raw = valueNew[i];
                if (raw === null || typeof raw !== 'object' || typeof raw.name !== 'string' || raw.name === '') {
                    this.__logWarnings([
                        `E142_OVERLAYS_ENTRY_INVALID: E142Overlays[${i}] has no usable @MapName and was `
                        + 'dropped. Every entry needs a name: it is half of OverlayKey and there is no default.',
                    ]);
                    continue;
                }
                const spec: OverlaySpec = { name: raw.name };
                // `in`, not a truthiness test: '' is a real MapVersion (the XSD
                // default) and must survive, while an absent key means "any".
                if ('version' in raw && typeof raw.version === 'string') { spec.version = raw.version; }
                if (raw.role === 'base' || raw.role === 'decoration' || raw.role === 'valueField') {
                    spec.role = raw.role;
                }
                cleaned.push(spec);
            }
            v = cleaned.length > 0 ? cleaned : null;
            if (v !== null) {
                const bases = v.filter((o) => o.role === 'base');
                if (bases.length > 1) {
                    this.__logWarnings([
                        `E142_OVERLAYS_MULTIPLE_BASE: ${bases.length} entries claim role "base" `
                        + `(${bases.map((o) => JSON.stringify(o.name)).join(', ')}). One overlay owns the fill `
                        + 'and the geometry, so this is a contradiction rather than a preference; the FIRST is '
                        + 'used and the rest are treated as decorations.',
                    ]);
                }
                /*
                 * The short form: no entry states a role, so the first is the base
                 * and the rest are decorations. Not a warning - it is the documented
                 * default.
                 *
                 * It applies only when NOTHING was stated. The first version keyed
                 * on "no BASE was stated", which silently overwrote an explicit
                 * `valueField` with `decoration` — a list of roles the author had
                 * spelled out, rewritten because one of them was not `base`.
                 */
                if (v.every((o) => o.role === undefined)) {
                    v[0].role = 'base';
                    for (let i = 1; i < v.length; i++) { v[i].role = 'decoration'; }
                } else if (bases.length === 0) {
                    // Roles WERE stated and none is the base. The first entry that
                    // is not a value field takes it, so a list of value fields alone
                    // still has geometry to draw on.
                    const b = v.find((o) => o.role !== 'valueField');
                    if (b !== undefined) { b.role = 'base'; }
                }
            }
        }
        if (tchmi_equal(v, this.__e142Overlays)) { return; }
        this.__e142Overlays = v;
        if (v !== null && (this.__e142OverlayName !== null || this.__e142OverlayVersion !== null)) {
            this.__logWarnings([
                'E142_OVERLAYS_OVERRIDES_SINGLE: E142Overlays is bound AND E142OverlayName / '
                + 'E142OverlayVersion are set. A map has one renderable overlay, so the two cannot both '
                + 'decide it; the LIST is used and the single-overlay attributes are ignored. Clear the '
                + 'list to go back to them.',
            ]);
        }
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142Overlays' });
        this.__rebuildMap();
    }
    /** @returns The composition list, or `null`. */
    public getE142Overlays(): OverlaySpec[] | null { return this.__e142Overlays; }

    /**
     * Updates the map good-device-count output. Intended for internal use on map
     * ingestion; raises `onPropertyChanged` on change.
     * @param valueNew New good-device count, or `null`.
     */
    public setMapGoodDevices(valueNew: number | null): void {
        const v = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(v, this.__mapGoodDevices)) { return; }
        this.__mapGoodDevices = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapGoodDevices' });
    }
    /** @returns The active map's good-device count, or `null`. */
    public getMapGoodDevices(): number | null { return this.__mapGoodDevices; }

    // ---------------------------------------------------------------
    //  Output attributes (read-only). null means "no selection".
    // ---------------------------------------------------------------

    /**
     * Updates the selected item id output. Intended for internal use on
     * selection changes; raises `onPropertyChanged` on change.
     * @param valueNew New `item_id`, or `null`.
     */
    public setSelectedItemId(valueNew: number | null): void {
        const n = TcHmi.ValueConverter.toNumber(valueNew);
        if (tchmi_equal(n, this.__selItemId)) { return; }
        this.__selItemId = n;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemId' });
    }
    /** @returns The last interacted item's `item_id`, or `null`. */
    public getSelectedItemId(): number | null { return this.__selItemId; }

    /**
     * Updates the selected item status output. Non-status values are normalized
     * to `null`. Raises `onPropertyChanged` on change.
     * @param valueNew New status, or `null`.
     */
    public setSelectedItemStatus(valueNew: string | null): void {
        const v = normStatus(valueNew);
        if (tchmi_equal(v, this.__selItemStatus)) { return; }
        this.__selItemStatus = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemStatus' });
    }
    /** @returns The last interacted element's effective status, or `null`. */
    public getSelectedItemStatus(): ItemStatus | null { return this.__selItemStatus; }

    /**
     * Updates the selected item name output. Raises `onPropertyChanged` on
     * change.
     * @param valueNew New name, or `null`.
     */
    public setSelectedItemName(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__selItemName)) { return; }
        this.__selItemName = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemName' });
    }
    /** @returns The last interacted element's name, or `null`. */
    public getSelectedItemName(): string | null { return this.__selItemName; }

    /**
     * Updates the selected item user-data output. Values other than a string or
     * number are normalized to `null` (grid cells always report `null`). Raises
     * `onPropertyChanged` on change.
     * @param valueNew New user data, or `null`.
     */
    public setSelectedItemUserData(valueNew: string | number | null): void {
        const v: string | number | null =
            (typeof valueNew === 'string' || typeof valueNew === 'number') ? valueNew : null;
        if (tchmi_equal(v, this.__selItemUserData)) { return; }
        this.__selItemUserData = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItemUserData' });
    }
    /** @returns The last interacted item's user data, or `null`. */
    public getSelectedItemUserData(): string | number | null { return this.__selItemUserData; }

    /**
     * Updates the full-selection output. A non-array (or `null`) clears it.
     * Raises `onPropertyChanged` on change.
     * @param valueNew New selection entries, or `null` to clear.
     */
    public setSelectedItems(valueNew: SelectionEntry[] | null): void {
        const v = TcHmi.ValueConverter.toObject<SelectionEntry[]>(valueNew);
        const arr = Array.isArray(v) ? v : null;
        if (tchmi_equal(arr, this.__selItems)) { return; }
        this.__selItems = arr;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SelectedItems' });
    }
    /** @returns The full current selection, or `null` when nothing is selected. */
    public getSelectedItems(): SelectionEntry[] | null { return this.__selItems; }

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
     * bbox, and the orientation carried through without a sign factor) - then
     * re-syncs the scene; a null/empty layout caches an empty list. The two-tier
     * z-order is applied by the engine at draw time, not here. A new layout
     * invalidates the previous selection, so the selection outputs are cleared.
     */
    protected __rebuildItems(): void {
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
    protected __rebuildStatusMap(): void {
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
    protected __rebuildLabels(): void {
        this.__updateLabels(labelsToModels(this.__labels), this.__showLabels);
    }

    /**
     * Resolves the six Origin attributes into the engine-ready placement scalars
     * and pushes them to the base: the meter-based offsets are converted to
     * millimeters through the current prefix (via the engine's `toMillimeters`) and
     * the rotation from degrees to radians; the anchor and Y-axis direction pass
     * through as their validated enums. The base stores these for
     * {@link SubstrateMapBase.__computeMatrices}, so the engine's D2S sees numbers
     * only - never attribute state. Like {@link __rebuildLabels} this only pushes;
     * the callers (the Origin setters and {@link __attach}) request the render.
     */
    protected __syncPlacement(): void {
        this.__updatePlacement(
            this.__originLocation,
            toMillimeters(this.__originOffsetX, this.__originOffsetPrefix),
            toMillimeters(this.__originOffsetY, this.__originOffsetPrefix),
            this.__originRotation * Math.PI / 180,
            this.__yAxisDirection,
        );
    }

    /**
     * Resolves the `MapRotation` attribute (degrees) to the engine-ready view
     * rotation (radians, CCW-positive on screen) and pushes it to the base, which
     * stores it for {@link SubstrateMapBase.__computeMatrices} - so the engine's `W`
     * sees a number only, never attribute state. Like {@link __syncPlacement} this
     * only pushes; the callers (the {@link setMapRotation} setter and
     * {@link __attach}) request the render.
     */
    protected __syncViewRotation(): void {
        this.__updateViewRotation(this.__mapRotation * Math.PI / 180);
    }

    /**
     * Rebuilds the cached render-ready outline from the bound outline via the
     * engine's `buildOutlineModel` - a closed `Path2D` in the substrate frame S
     * plus the bbox that defines the fit box and the origin anchors - then
     * re-syncs the scene. An unset, invalid or degenerate outline caches `null`.
     */
    protected __rebuildOutline(): void {
        this.__outlineModel = buildOutlineModel(this.__outline);
        this.__refitAfterOutlineChange();
    }

    /**
     * A change to the fit box - the bound {@link setOutline} or the
     * {@link setOutlinePreset} model - moves where an UNSCALED grid must be fit
     * (the fit box is `__outlineModel ?? __presetOutlineModel`, and
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
    protected __refitAfterOutlineChange(): void {
        /*
         * The demo is scaled into the ACTIVE outline, so an outline change
         * invalidates it. One rebuild here covers both callers - `__rebuildOutline`
         * and `__rebuildPreset` - rather than two copies of the same line.
         *
         * Guarded on `__demo` so this costs nothing when the demo is off, which is
         * every view that binds real data.
         */
        if (this.__demo !== null) {
            const box = this.__outlineModel ?? this.__presetOutlineModel;
            this.__demo = buildDemo(box ? box.bbox : null);
        }
        if (this.__activeInput !== null) {
            this.__rebuildMap();
        } else {
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
    protected __rebuildPreset(): void {
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
     * so this is safe to call whether or not real data is present.
     */
    protected __rebuildDemo(): void {
        /*
         * The BOX is the active outline's bbox, or none. With an
         * outline bound the demo is scaled into it and its own 300 mm preset is
         * dropped; with nothing bound it is byte-identical to what it always was.
         *
         * Rebuilt here rather than at selection time because an outline change
         * already calls this - `__rebuildOutline` and `__rebuildPreset` both end in
         * `__refitAfterOutlineChange`, and both now re-run the demo. Deriving it in
         * `__activeModel` would rebuild 180 dies on every scene sync.
         */
        const box = this.__outlineModel ?? this.__presetOutlineModel;
        this.__demo = this.__showDemoItems ? buildDemo(box ? box.bbox : null) : null;
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
     * Precedence (explicit Outline > OutlinePreset > demo > nothing):
     *  - Real branch when an explicit outline, a preset outline OR real items are
     *    bound. The active substrate body is the explicit outline when bound, else
     *    the preset outline (`__outlineModel ?? __presetOutlineModel`); real items,
     *    when bound, draw over whichever is active. When only items are bound (no
     *    outline, no preset) the outline model is `null`; the engine then fits the
     *    canvas to the grid's extent or the default substrate, and draws no
     *    substrate body. Status is
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
    protected __activeModel(): {
        outlineModel: OutlineModel | null;
        items: ItemModel[];
        resolve: (item: ItemModel) => ItemStatus | null;
        mapping: Record<string, string> | null;
    } | null {
        // Precedence: explicit Outline > OutlinePreset > demo > nothing.
        // The active substrate body is the explicit outline when bound, else the
        // preset outline; real items (when bound) draw over whichever is active.
        const outlineModel = this.__outlineModel ?? this.__presetOutlineModel;
        if (outlineModel !== null || this.__itemModels.length > 0) {
            /*
             * ---- OUTLINE BOUND, NO REAL ITEMS, DEMO ASKED FOR ----
             *
             * The demo draws INTO the outline instead of being suppressed. That is
             * the behavior change: a view binding both an outline and a demo
             * clearly wanted both, and what it used to get was an empty substrate
             * plus a warning telling it to remove one of the two things it asked
             * for.
             *
             * WHAT SUPPRESSES THE DEMO IS SOMETHING REAL TO DRAW, and a GRID is
             * that as much as an item is. `__itemModels.length === 0` alone is not
             * enough: a document producing nothing is not data, but a grid does not
             * arrive as items at all. It goes to `__sceneGrid` on the base through a
             * different path, so a panel that binds a map and an outline would draw
             * 180 demo dies over its own wafer. `__hasRenderableGrid()` covers it.
             *
             * The demo keeps `__demo.outlineModel` out of it: with a box that is
             * `null` by construction, and the substrate here is the
             * caller's outline.
             */
            if (this.__itemModels.length === 0 && !this.__hasRenderableGrid()
                && this.__showDemoItems && this.__demo !== null) {
                return {
                    outlineModel,
                    items: this.__demo.items,
                    resolve: (item: ItemModel): ItemStatus | null => item.status,
                    mapping: this.__demo.mapping,
                };
            }
            return {
                outlineModel,
                items: this.__itemModels,
                resolve: (item: ItemModel): ItemStatus | null => this.__effectiveStatus(item),
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
                resolve: (item: ItemModel): ItemStatus | null => item.status,
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
    protected __syncScene(): void {
        const model = this.__activeModel();
        this.__updateOutline(model ? model.outlineModel : null);
        this.__updateItems(model ? model.items : []);
        /*
         * Whether this scene is the DEMO, for the base. The base cannot tell
         * a demo item from a real one - both come through `itemsToModels`, which is
         * the point of authoring the demo as a schema `ItemList` - so the concrete,
         * which made the choice, reports it. `__activeModel` takes the demo branch
         * in exactly two places and both hand back `this.__demo.mapping`, so that
         * identity IS the answer, and it cannot drift from the branch that set it.
         */
        this.__updateSceneIsDemo(model !== null && this.__demo !== null
            && model.mapping === this.__demo.mapping);
        this.__updateStatusResolver(model ? model.resolve : null);
        // Color mapping: the DEMO carries its own palette (its `mapping` is a
        // distinct object); every other configuration - real items and/or a bound
        // grid - colors items AND grid cells through the bound StatusColorMapping
        // (the engine's resolveStatusColor and resolveBinColor share one map). So a
        // grid bound without any items still gets StatusColorMapping[binCode]
        // - which `model ? model.mapping : null` would have dropped.
        const mapping = (model !== null && model.mapping !== this.__statusColorMapping)
            ? model.mapping
            : this.__statusColorMapping;
        this.__updateColorMapping(mapping);
        this.__updateCategoricalFallback(mapping);
        this.__requestRender();
    }

    // ---------------------------------------------------------------
    //  The filter surface
    //
    //  These names are the contract.
    // ---------------------------------------------------------------

    /**
     * Sets the spatial filter. See {@link filterApplies} for the legal pairings.
     * @param valueNew The filter, or `null` for `None`.
     */
    public setSpatialFilter(valueNew: SpatialFilter | null): void {
        const v = (TcHmi.ValueConverter.toString(valueNew) ?? 'None') as SpatialFilter;
        if (tchmi_equal(v, this.__spatialFilter)) { return; }
        this.__spatialFilter = v;
        this.__filterPairWarned.clear();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SpatialFilter' });
        this.__requestRender();
    }
    /** @returns The spatial filter. */
    public getSpatialFilter(): SpatialFilter { return this.__spatialFilter; }

    /**
     * Sets the filter radius in DEVICE pixels.
     *
     * Clamped to 0..{@link FILTER_RADIUS_MAX} rather than rejected: a slider bound
     * to this should not be able to put the control in an error state, and a
     * radius of 40 is not a request anyone means.
     * @param valueNew The radius, or `null` for the default.
     */
    public setSpatialFilterRadius(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const v = raw === null || !Number.isFinite(raw)
            ? 1 : Math.max(0, Math.min(FILTER_RADIUS_MAX, raw));
        if (tchmi_equal(v, this.__spatialFilterRadius)) { return; }
        this.__spatialFilterRadius = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'SpatialFilterRadius' });
        this.__requestRender();
    }
    /** @returns The radius in device pixels. */
    public getSpatialFilterRadius(): number { return this.__spatialFilterRadius; }

    /**
     * Sets which channel the tile shows.
     * @param valueNew The channel, or `null` for `Bins`.
     */
    public setFieldView(valueNew: FieldView | null): void {
        const v = (TcHmi.ValueConverter.toString(valueNew) ?? 'Bins') as FieldView;
        if (tchmi_equal(v, this.__fieldView)) { return; }
        this.__fieldView = v;
        this.__filterPairWarned.clear();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'FieldView' });
        this.__requestRender();
    }
    /** @returns The channel. */
    public getFieldView(): FieldView { return this.__fieldView; }

    /**
     * Sets the gamma applied to a scalar field before it is colored.
     * @param valueNew The gamma, or `null` for the default.
     */
    public setFieldGamma(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const v = raw === null || !Number.isFinite(raw) || raw <= 0 ? 0.4 : raw;
        if (tchmi_equal(v, this.__fieldGamma)) { return; }
        this.__fieldGamma = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'FieldGamma' });
        this.__requestRender();
    }
    /** @returns The gamma. */
    public getFieldGamma(): number { return this.__fieldGamma; }

    /**
     * Sets the severity rank at or above which a bin keeps its color.
     * @param valueNew The rank, or `null` to highlight nothing.
     */
    public setHighlightFromSeverity(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const v = raw === null || !Number.isFinite(raw) ? null : raw;
        if (tchmi_equal(v, this.__highlightFromSeverity)) { return; }
        this.__highlightFromSeverity = v;
        // The muted palette is derived from the threshold, so a change to one has
        // to rebuild the other - and `__syncScene` is what recomputes both palettes
        // together, which is the point of them being computed in one place.
        this.__syncScene();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'HighlightFromSeverity' });
        this.__requestRender();
    }
    /** @returns The threshold, or `null`. */
    public getHighlightFromSeverity(): number | null { return this.__highlightFromSeverity; }

    /**
     * Sets the reference map. An ordinary `SubstrateMapGridData`.
     * @param valueNew The reference, or `null`.
     */
    public setReferenceGridData(valueNew: GridData | null): void {
        const v = TcHmi.ValueConverter.toObject<GridData>(valueNew);
        if (tchmi_equal(v, this.__referenceGridData)) { return; }
        this.__referenceGridData = v;
        this.__referenceVersion++;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ReferenceGridData' });
        this.__requestRender();
    }
    /** @returns The reference map, or `null`. */
    public getReferenceGridData(): GridData | null { return this.__referenceGridData; }

    /**
     * Sets how the reference is compared against the bound map.
     * @param valueNew The mode, or `null` for `Off`.
     */
    public setReferenceMode(valueNew: ReferenceMode | null): void {
        const v = (TcHmi.ValueConverter.toString(valueNew) ?? 'Off') as ReferenceMode;
        if (tchmi_equal(v, this.__referenceMode)) { return; }
        this.__referenceMode = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ReferenceMode' });
        this.__requestRender();
    }
    /** @returns The reference mode. */
    public getReferenceMode(): ReferenceMode { return this.__referenceMode; }

    /**
     * The filter that will actually run, after the legality check.
     *
     * ---- AN ILLEGAL PAIRING DOES NOT FILTER, AND SAYS SO ----
     *
     * Failure-tolerant: better to show nothing than to show something
     * wrong. A `Box` over bin indices would produce colors that are not bins, and
     * an operator reading a brown die off a wafer map has been actively misled.
     *
     * Reported once per pairing rather than per frame, and the latch is cleared
     * whenever either half changes, so correcting one and breaking it again is
     * reported again.
     * @returns The filter to run, `'None'` when the pairing is illegal.
     */
    protected __effectiveFilter(): SpatialFilter {
        const f = this.__spatialFilter;
        if (f === 'None' || this.__spatialFilterRadius <= 0) { return 'None'; }
        if (filterApplies(f, this.__fieldView)) { return f; }
        const key = `${f}/${this.__fieldView}`;
        if (!this.__filterPairWarned.has(key)) {
            this.__filterPairWarned.add(key);
            this.__logWarnings([
                `E142_FILTER_NOT_APPLICABLE: SpatialFilter "${f}" cannot run on FieldView `
                + `"${this.__fieldView}". ${f === 'Box' || f === 'Gauss'
                    ? 'Box and Gauss average, and an average of two bin indices is not a bin; they need '
                        + 'FailDensity or ValueField.'
                    : 'Median, Min and Max order or pick palette indices; they need Bins.'} `
                + 'The image is left unfiltered.',
            ]);
        }
        return 'None';
    }

    /**
     * The seven filter attributes as one cache-key term.
     *
     * ALL SEVEN, because a filter change that did not reach the key would serve a
     * stale bitmap. The
     * reference map contributes its identity rather than its contents: it is
     * replaced wholesale by a binding, never mutated in place.
     * @returns The term.
     */
    /**
     * The filter this control is asking the engine to run.
     *
     * `__effectiveFilter()` has already resolved an illegal pairing to `'None'`
     * and reported it, so what leaves here is always legal. The radius is
     * the attribute's, already clamped by its setter, and the gamma is
     * `FieldGamma` - which the scalar filters apply on the way to a color and
     * never to the stored value.
     * @returns The request, or `undefined` when nothing is asked for.
     */
    protected override __spatialFilterRequest():
    { kind: string; radius: number; gamma: number } | undefined {
        const kind = this.__effectiveFilter();
        if (kind === 'None' || !(this.__spatialFilterRadius > 0)) { return undefined; }
        return { kind, radius: this.__spatialFilterRadius, gamma: this.__fieldGamma };
    }

    protected override __filterKey(): string {
        return [
            this.__effectiveFilter(),
            this.__spatialFilterRadius,
            this.__fieldView,
            this.__fieldGamma,
            this.__highlightFromSeverity ?? '-',
            this.__referenceMode,
            this.__referenceMode === 'Off' ? '-' : this.__referenceVersion,
        ].join('\u0001');
    }

    /**
     * Recomputes the categorical fallback for the current grid.
     *
     * A bin code with neither a `StatusColorMapping` entry nor a `BinQuality` used
     * to paint the unknown gray, so a map with eight sort grades drew the same gray
     * eight times. It now takes a color from `categoricalPalette` by position in
     * the bin table.
     *
     * ---- ONCE, HERE, FOR BOTH READERS ----
     *
     * The render path and `readBinStatistics` both need it and must agree. Computed
     * here on a scene change and stored, rather than derived in each — two
     * derivations is exactly how a chart and a map come to show different colors
     * for one code.
     *
     * Uses the SCENE's mapping, the argument, and not `__statusColorMapping`: the
     * demo carries its own palette, and the two differ there.
     * @param mapping The effective color mapping for this scene.
     * @returns Nothing.
     */
    /**
     * Recomputes the muted palette for `HighlightFromSeverity`.
     *
     * ---- THE THRESHOLD IS ON THE SEVERITY RANK ----
     *
     * A bin at or above it keeps its color EXACTLY - the same string the render
     * would have used, byte for byte, because the highlight entry is `null` and
     * nothing is substituted. A bin below it drops to the lightness of its own
     * color at chroma 0.
     *
     * Ranks come from `BinSeverityPriority` when one is bound; without it the
     * ladder is the three-rank fallback - 1 pass, 2 unknown, 3 fail - so 3 is the
     * common value and means *show me the failures*.
     *
     * ---- THE NULL BIN IS NEVER MUTED, AND NEVER NEEDS TO BE ----
     *
     * Index 0 is the reserved null bin and no cell holding it is painted at all,
     * in either strategy. It is left out of the table rather than given a gray,
     * because giving it one would suggest there is a color to compare against.
     * @param mapping The effective color mapping for this scene.
     * @returns Nothing.
     */
    /**
     * Applies `ReferenceMode` by rewriting the per-cell fill.
     *
     * ---- A REFERENCE IS A MAP, AND THE LOOP CLOSES WITH NO NEW FORMAT ----
     *
     * `ReferenceGridData` is an ordinary `SubstrateMapGridData`. An author runs
     * `toGridData()` on a good wafer and binds the result straight back. Inventing
     * a second schema for it would have meant a second parser to keep in step,
     * for a thing that is a map.
     *
     * ---- EXPRESSED AS A FILL, NOT AS A NEW RENDER PATH ----
     *
     * `paint.fillCells` is already a per-cell color index honored by all three
     * strategies - point, run and bucket. So the comparison builds one: a color
     * list of every bin's color followed by every bin's MUTED color, and a
     * per-cell index choosing between them. No hot loop changes and no fourth
     * strategy.
     *
     * The muting is the engine's `desaturate`, with the same separation clamp: a cell
     * that matches the reference must still be distinguishable from a cell that
     * was never placed.
     *
     * ---- WHAT IS NOT DONE ----
     *
     * A reference of a different lattice is an OPERATOR ERROR, not a scaling
     * problem. Nothing is interpolated, nothing is guessed: the comparison
     * switches off and `E142_REFERENCE_GEOMETRY_MISMATCH` names both dimensions.
     * A golden map that does not fit is the wrong file, and quietly stretching it
     * would produce a difference view that is confidently wrong everywhere.
     * @param mapping The effective color mapping for this scene.
     * @returns Nothing.
     */
    protected __updateReference(mapping: Record<string, string> | null): void {
        const grid = this.__sceneGrid;
        const ref = this.__referenceGridData;
        const mode = this.__referenceMode;
        if (grid === null || ref === null || mode === 'Off') { return; }

        /*
         * A bound value field already owns the per-cell fill, and two things cannot
         * color the same cell. Reported rather than silently resolved, the same
         * rule `filterApplies` follows: better to show nothing than something wrong.
         */
        if (this.__sceneValueFill !== null) {
            this.__warnOnce('E142_REFERENCE_NOT_APPLICABLE: ReferenceMode "' + mode
                + '" cannot run while a value field is bound — both color the cell, and only one '
                + 'can. The reference is ignored.');
            return;
        }

        const refGrid = this.__parseReference(ref);
        if (refGrid === null) { return; }
        if (refGrid.cols !== grid.cols || refGrid.rows !== grid.rows) {
            this.__warnOnce('E142_REFERENCE_GEOMETRY_MISMATCH: the reference is '
                + `${refGrid.cols}x${refGrid.rows} and the map is ${grid.cols}x${grid.rows}. `
                + 'Nothing is interpolated; the comparison is off.');
            return;
        }

        const themeColors = this.__readColors();
        const n = grid.binTable.length;
        const colors: string[] = new Array<string>(n * 2);
        for (let i = 0; i < n; i++) {
            const lit = resolveBinColor(grid.binTable[i], mapping, themeColors,
                this.__binQualityAliases, this.__sceneCategorical ? this.__sceneCategorical[i] : null,
                this.__sceneHighlight ? this.__sceneHighlight[i] : null);
            colors[i] = lit;
            colors[n + i] = desaturate(lit, themeColors.body, AGGREGATE_MIN_DELTA_E);
        }

        const severity = binSeverityTable(grid.binTable, this.__sceneBinSeverityPriority ?? null);
        const refSeverity = binSeverityTable(refGrid.binTable, this.__sceneBinSeverityPriority ?? null);
        const cells = new Uint32Array(grid.cells.length);
        for (let i = 0; i < cells.length; i++) {
            const bin = grid.cells[i];
            const refBin = refGrid.cells[i];
            // A null cell stays null: it is not a difference, it is an absence, and
            // the fill index for it is never read because it is never painted.
            if (bin === 0) { cells[i] = 0; continue; }
            const keep = mode === 'Difference'
                // Compared by CODE, not by table index: the two maps have their own
                // bin tables and index 3 in one is not index 3 in the other.
                ? grid.binTable[bin].code !== (refGrid.binTable[refBin]?.code ?? null)
                // NewOnly: worse here than there. Not merely "differs" - a cell that
                // improved is not something newly broken, and showing it would bury
                // the answer in noise after a rework step.
                : severity[bin] > (refBin === 0 ? 0 : refSeverity[refBin]);
            cells[i] = keep ? bin : n + bin;
        }
        this.__sceneValueFill = { cells, colors };
    }

    /**
     * Builds a grid model from a bound reference, or `null` when it will not parse.
     * @param ref The reference map.
     * @returns The model, or `null`.
     */
    protected __parseReference(ref: GridData): GridModel | null {
        try {
            /*
             * The SAME normalizer and builder the bound map goes through, with no
             * decorations and no placement registration - a reference contributes
             * only its lattice and its bins. Reusing them is the point: a second
             * path would be a second set of rules about what a map is.
             */
            const n = normalizeGridData(ref);
            /*
             * A UNIT PLACEMENT, deliberately. The reference contributes its lattice
             * and its bins and nothing else: it is never drawn, only compared
             * cell-for-cell, so its step sizes and origin are irrelevant and reading
             * them would invite the belief that a reference could be registered
             * against the map geometrically. It cannot; the dimensions must match
             * exactly or the comparison is off.
             */
            return buildGridModel(
                { originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0,
                    rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false },
                n.payload, n.binDefs ? n.binDefs.map(toEngineBinDefinition) : null,
            );
        } catch (e) {
            this.__warnOnce('E142_REFERENCE_NOT_APPLICABLE: the reference map could not be read: '
                + String(e instanceof Error ? e.message : e));
            return null;
        }
    }

    /**
     * Reports a diagnostic once per distinct message.
     *
     * The scene is rebuilt on any attribute change, so a per-rebuild warning is
     * noise - the same rule every other diagnostic here follows.
     * @param message The message.
     * @returns Nothing.
     */
    protected __warnOnce(message: string): void {
        if (this.__referenceWarned === message) { return; }
        this.__referenceWarned = message;
        this.__logWarnings([message]);
    }

    protected __updateHighlight(mapping: Record<string, string> | null): void {
        const grid = this.__sceneGrid;
        const from = this.__highlightFromSeverity;
        if (grid === null || from === null) {
            this.__sceneHighlight = null;
            return;
        }
        const severity = binSeverityTable(grid.binTable, this.__sceneBinSeverityPriority ?? null);
        const out: (string | null)[] = new Array<string | null>(grid.binTable.length).fill(null);
        for (let i = 1; i < grid.binTable.length; i++) {
            if (severity[i] >= from) { continue; }
            /*
             * Resolved through the SAME `resolveBinColor` the render uses, with the
             * same mapping, aliases and categorical fallback - then desaturated. A
             * second resolution here would be a second chance to disagree with the
             * picture.
             */
            const themeColors = this.__readColors();
            out[i] = desaturate(
                resolveBinColor(grid.binTable[i], mapping, themeColors, this.__binQualityAliases,
                    this.__sceneCategorical ? this.__sceneCategorical[i] : null),
                // What shows where nothing is painted: the substrate body. A muted
                // cell has to stay separable from an EMPTY one, which is the whole
                // reason it is grayed instead of hidden.
                themeColors.body, AGGREGATE_MIN_DELTA_E);
        }
        this.__sceneHighlight = out.some((v) => v !== null) ? out : null;
    }

    protected __updateCategoricalFallback(mapping: Record<string, string> | null): void {
        const grid = this.__sceneGrid;
        if (grid === null) {
            this.__sceneCategorical = null;
            return;
        }
        const fallback = categoricalBinFallback(grid.binTable, mapping, this.__binQualityAliases);
        this.__sceneCategorical = fallback.requested > 0 ? fallback.colors : null;
        this.__updateHighlight(mapping);
        this.__updateReference(mapping);
        // Once per distinct message, like every other diagnostic here: the scene is
        // rebuilt on any attribute change and a per-rebuild warning is noise.
        if (fallback.warning !== null && fallback.warning !== this.__categoricalWarned) {
            this.__categoricalWarned = fallback.warning;
            TcHmi.Log.warn(`SUBSTRATEMAP_CATEGORICAL_PALETTE_CAPPED: ${fallback.warning}`);
        } else if (fallback.warning === null) {
            this.__categoricalWarned = null;
        }
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
    protected __effectiveStatus(item: ItemModel): ItemStatus | null {
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
     * assignment override), so the reported status matches the painted color. The
     * membership array {@link getSelectedItems} is maintained separately (see
     * {@link __raiseSelected}). `null` clears all four outputs; the item id and
     * user data are `null` for an id-less item.
     * @param payload The selection payload, or `null` to clear the outputs.
     */
    protected __setSelectedOutputs(payload: SelectedPayload | null): void {
        this.setSelectedItemId(payload ? payload.itemId : null);
        this.setSelectedItemStatus(payload ? payload.status : null);
        this.setSelectedItemName(payload ? payload.name : null);
        this.setSelectedItemUserData(payload ? payload.userData : null);
    }

    // ---------------------------------------------------------------
    //  SEMI E142 ingestion
    //  Grid placement comes exclusively from the map data; the manual
    //  Origin*/YAxisDirection attributes keep governing Items and Labels only, and
    //  Outline / OutlinePreset are unchanged - the grid renders with or without an
    //  outline. A bound map counts as bound content and therefore suppresses the
    //  demo. All errors are non-fatal: they set E142LastError, are logged
    //  to the framework logger, and clear the grid.
    // ---------------------------------------------------------------

    /**
     * Whether a bound map produced a grid with cells to draw.
     *
     * Distinct from {@link __mapBound}, which asks whether a document was BOUND.
     * This asks whether it yielded anything — the question the demo branch and
     * the empty state both need, and the one that is answered wrongly by
     * reading `__itemModels` alone, because a grid never becomes items.
     * @returns Whether there is a grid with at least one cell.
     */
    protected __hasRenderableGrid(): boolean {
        // Read from the SCENE, where the grid actually lands: the concrete builds
        // it and hands it straight to `__updateGrid`, keeping no field of its own.
        return this.__sceneGrid !== null && this.__sceneGrid.cols * this.__sceneGrid.rows > 0;
    }

    /** Whether any map input (E142MapData / E142TransferData / GridData) is bound (independently of whether it rendered). Suppresses the demo. */
    protected __mapBound(): boolean {
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
    private static readonly __INPUT_PRECEDENCE = ['xml', 'json', 'transfer', 'grid'] as const;

    /**
     * Whether the named input slot currently holds a non-null value.
     * @param which The input slot.
     * @returns `true` when that slot is bound.
     */
    /**
     * Whether the active input is an E142 DOCUMENT rather than a GridData one.
     *
     * Extracted from four setters that each spelled out
     * `=== 'xml' || === 'transfer'`. Those four decide whether an attribute that
     * selects INSIDE a document - the substrate id, the layout specifier, the
     * overlay name and version - forces a rebuild, and every one of them would
     * have silently ignored a JSON-bound map had the literal been extended in
     * three places instead of four.
     * @returns Whether the current input is a parsed E142 document.
     */
    protected __activeInputIsE142Document(): boolean {
        return this.__activeInput === 'xml'
            || this.__activeInput === 'json'
            || this.__activeInput === 'transfer';
    }

    protected __inputBound(which: NonNullable<E142ActiveInput>): boolean {
        switch (which) {
            case 'xml': return this.__e142MapData !== null;
            case 'json': return this.__e142MapDataJson !== null;
            case 'transfer': return this.__e142TransferData !== null;
            case 'grid': return this.__gridData !== null;
            default: {
                const _never: never = which;
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
    protected __fallbackActiveInput(): E142ActiveInput {
        for (const k of SubstrateMap.__INPUT_PRECEDENCE) {
            if (this.__inputBound(k)) { return k; }
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
    protected __warnIfMultipleInputs(
        previous: E142ActiveInput,
        active: NonNullable<E142ActiveInput>,
    ): void {
        /*
         * `previous` is null or BOUND, never neither: the only assignments to
         * __activeInput are a setter writing its own key with a non-null value,
         * and __fallbackActiveInput(), which returns a key only when
         * __inputBound(key). A `!__inputBound(previous)` guard was written here
         * and removed - it could not fire, and a mutation deleting it survived
         * the whole suite, which is what unreachable code looks like from the
         * outside.
         */
        if (previous === null || previous === active) { return; }

        const others: string[] = [];
        for (const k of SubstrateMap.__INPUT_PRECEDENCE) {
            if (k !== previous && k !== active && this.__inputBound(k)) {
                others.push(SubstrateMap.__inputDisplayName(k));
            }
        }
        this.__logWarnings([
            'E142_MAP_INPUT_OVERRIDDEN: ' + SubstrateMap.__inputDisplayName(active) + ' was written '
            + 'while ' + SubstrateMap.__inputDisplayName(previous) + ' was still bound. A map has one '
            + 'source, so the two cannot both decide it; the MOST RECENT write is used and '
            + SubstrateMap.__inputDisplayName(previous) + ' is ignored. Clear it to make the '
            + 'precedence explicit'
            + (others.length > 0
                ? ' - and note ' + others.join(', ') + ' ' + (others.length === 1 ? 'is' : 'are')
                  + ' bound too.'
                : '.'),
        ]);
    }

    /**
     * The attribute display name of an input slot, for log messages.
     * @param which The input slot.
     * @returns The attribute name.
     */
    private static __inputDisplayName(which: NonNullable<E142ActiveInput>): string {
        switch (which) {
            case 'xml': return 'E142MapData';
            case 'json': return 'E142MapDataJson';
            case 'transfer': return 'E142TransferData';
            case 'grid': return 'GridData';
            default: {
                const _never: never = which;
                return _never;
            }
        }
    }

    /**
     * Normalizes a raw {@link setE142TransferData} value to the stored form:
     * a base64 `string`, a `number[]` of byte values (defensively copied), or
     * `null`. Byte-range and base64 validity are NOT checked here - they surface
     * as {@link getE142LastError} when the bytes are decoded, mirroring how
     * {@link setE142MapData} defers XML validity to the parse.
     * @param value The raw attribute value.
     * @returns The normalized transfer input.
     */
    private static __normalizeTransferInput(value: string | number[] | null): string | number[] | null {
        if (value === null || value === undefined) { return null; }
        if (typeof value === 'string') { return value; }
        if (Array.isArray(value)) { return value.slice(); }
        return null;
    }

    /**
     * The fallback pitch, or `undefined` when it does not apply (both X and Y must
     * be set); warns when exactly one is set, in which case the fit heuristic is
     * used instead.
     * @returns The fallback pitch in millimeters, or `undefined`.
     */
    protected __fallbackStep(): { xMm: number; yMm: number } | undefined {
        const x = this.__e142FallbackStepX;
        const y = this.__e142FallbackStepY;
        if (x !== null && y !== null) { return { xMm: x, yMm: y }; }
        if (x !== null || y !== null) {
            TcHmi.Log.warn(this.__id + ': only one of E142FallbackStepSizeX/Y is set; both are required to define a physical pitch. Using the fit heuristic (nominal, not physical, sizes).');
        }
        return undefined;
    }

    /**
     * Rebuilds the map from the active input - or, while {@link __attachPending}
     * is set, records that one is owed and returns (the parse is already
     * coalesced by the cache below, so only the placement rebuild is deferred).
     * A document input (XML string or the
     * decoded E142.4 transfer bytes) re-parses only when the cached parse is stale
     * - a fresh XML string, fresh transfer bytes or a new active input null it -
     * so overlay / fallback / offset changes reuse the parse, and
     * an overlay change never re-decodes the transfer bytes. No active input
     * clears the map and restores the demo behavior.
     */
    protected __rebuildMap(): void {
        // Attach-batch coalescing. Not a queue: WHICH rebuild is owed
        // is never recorded, because a rebuild reads the whole attribute state
        // afresh - so the one at attach subsumes every one suppressed here.
        if (this.__attachPending) { this.__mapRebuildOwed = true; return; }
        switch (this.__activeInput) {
            case null:
                this.__clearMap();
                return;
            case 'grid':
                if (this.__gridData === null) { this.__clearMap(); return; }
                this.__buildFromGrid(this.__gridData);
                return;
            case 'xml':
                if (this.__e142Doc === null) {
                    if (this.__e142MapData === null) { this.__clearMap(); return; }
                    try {
                        const res = parseE142Xml(this.__e142MapData);
                        this.__e142Doc = res.doc;
                        this.__logWarnings(res.warnings);
                    } catch (e) {
                        this.__applyMapError(this.__describeError(e));
                        return;
                    }
                }
                this.__buildFromDoc(this.__e142Doc);
                return;
            case 'json':
                if (this.__e142Doc === null) {
                    if (this.__e142MapDataJson === null) { this.__clearMap(); return; }
                    try {
                        // The same cache and the same failure handling as 'xml':
                        // one document type, two encodings, and nothing downstream
                        // of this point can tell which one it came from.
                        const res = parseE142Json(this.__e142MapDataJson);
                        this.__e142Doc = res.doc;
                        this.__logWarnings(res.warnings);
                    } catch (e) {
                        this.__applyMapError(this.__describeError(e));
                        return;
                    }
                }
                this.__buildFromDoc(this.__e142Doc);
                return;
            case 'transfer':
                if (this.__e142Doc === null) {
                    if (this.__e142TransferData === null) { this.__clearMap(); return; }
                    // O7 default path: bytes -> encoding sniff -> string, then the
                    // EXISTING XML pipeline verbatim (parseE142Xml). The two steps
                    // are visible here on purpose; E142Item.decodeE142Item bundles
                    // the same two as the documented non-document-payload seam and
                    // is intentionally not on this path.
                    let xml: string;
                    try {
                        const decoded = decodeItemText(this.__e142TransferData);
                        this.__logWarnings(decoded.warnings);
                        xml = decoded.text;
                    } catch (e) {
                        this.__applyMapError(this.__describeError(e));
                        return;
                    }
                    try {
                        const res = parseE142Xml(xml);
                        this.__e142Doc = res.doc;
                        this.__logWarnings(res.warnings);
                    } catch (e) {
                        this.__applyMapError(this.__describeError(e));
                        return;
                    }
                }
                this.__buildFromDoc(this.__e142Doc);
                return;
            default: {
                const _never: never = this.__activeInput;
                return _never;
            }
        }
    }

    /**
     * Resolves the overlay and layout from a parsed document, then builds the grid
     * and identity.
     *
     * OVERLAY SELECTION IS BY THE PAIR, not by the name. The XSD keys `Overlay`
     * on (`@MapName`, `@MapVersion`) - the `OverlayKey` - so a name alone does
     * not identify an overlay. E142-0225 R2-1.2.1 describes precisely the case
     * a name-only selector breaks: a map is downloaded to the equipment at
     * `MapVersion=1`, the equipment processes it and "uploads the results in an
     * updated map (MapVersion=2)", in E142-0225's own words. Both live under the
     * same `MapName`, and picking by name alone silently renders whichever
     * happens to come first in document order - the stale one, in a document
     * that appends.
     *
     * The four combinations:
     *
     *   name null, version null  first renderable overlay in document order
     *                            - unchanged behavior
     *   name set,  version null  first renderable with that name. If MORE THAN
     *                            ONE overlay carries the name, a warning lists
     *                            every version present and which was chosen:
     *                            the choice is positional, so it is a guess and
     *                            says so rather than looking deliberate
     *   name null, version set   ERROR. A version is not an identity - it is
     *                            half a key - and every document with two names
     *                            at that version would be a coin toss. Refused
     *                            rather than guessed
     *   both set                 exact pair match, no fallback
     *
     * `E142OverlayVersion = ""` is NOT "don't care": it selects overlays whose
     * `MapVersion` is empty, which is a real addressable overlay because the
     * attribute defaults to `""`. `null` is "don't care". See
     * {@link setE142OverlayVersion}.
     *
     * A named overlay that exists but is not a BinCodeMap, and a missing name,
     * are reported errors. A dangling / absent LayoutSpecifier is NOT an error
     * (the official SEMI example is layoutless): the layout then comes from the
     * payload dimensions.
     * @param doc The parsed E142 document.
     */
    protected __buildFromDoc(doc: E142Document): void {
        this.__publishSubstrateCount();

        // Selection is pure and lives in the engine ({@link selectMapAndOverlay}),
        // so it can be tested directly instead of transcribed into a test. The
        // control's job here is only to map its four attributes onto the filters
        // and the result onto the error / warning channels.
        const picked = selectMapAndOverlay(doc, {
            substrateId: this.__e142SubstrateId,
            layoutSpecifier: this.__e142LayoutSpecifier,
            overlayName: this.__e142OverlayName,
            overlayVersion: this.__e142OverlayVersion,
        });
        if (picked.warnings.length > 0) { this.__logWarnings(picked.warnings); }
        if (picked.error !== null || picked.header === null || picked.overlay === null) {
            this.__applyMapError(picked.error ?? 'no renderable BinCodeMap overlay in the E142 document');
            return;
        }
        const header = picked.header;
        const overlay = picked.overlay;
        // selectMapAndOverlay only ever returns a RENDERABLE overlay, but the
        // payload's optionality is not expressible in its return type without a
        // second interface. One narrowing here is cheaper than that.
        const payload = overlay.payload;
        if (payload === undefined) {
            this.__applyMapError('no renderable BinCodeMap overlay in the E142 document');
            return;
        }
        const chosenSm = doc.substrateMaps.find((sm) => sm.header === header) ?? null;

        const resolved = resolveLayoutSpecifier(doc, header.layoutSpecifier);
        if (resolved instanceof E142Error) {
            this.__applyMapError(this.__describeError(resolved));
            return;
        }
        const layout: ResolvedLayout = resolved !== null ? resolved : dimsFromPayload(payload);
        const sub = this.__matchSubstrate(doc, header);
        this.__commitGrid(
            header,
            layout,
            payload,
            overlay.binDefinitions ?? null,
            overlay.binCodeMapMeta?.binType ?? 'Ascii',
            overlay.referenceDevices,
            {
                substrateId: header.substrateId,
                lotId: sub?.lotId ?? null,
                goodDevices: sub?.goodDevices ?? null,
                supplierName: sub?.supplierName ?? null,
                status: sub?.status ?? null,
                aliasIds: sub?.aliasIds ?? null,
                carrierType: sub?.carrierType ?? null,
                carrierId: sub?.carrierId ?? null,
                slotNumber: sub?.slotNumber ?? null,
                substrateNumber: sub?.substrateNumber ?? null,
                substrateSide: header.substrateSide,
            },
            overlay.mapVersion,
            // The DEEPEST layout on the LayoutSpecifier path is the device
            // layout, and the one whose children describe the emitted grid.
            // A dangling/absent specifier leaves no layout to carry.
            resolved instanceof E142Error || resolved === null ? null : sourceLayoutOf(doc, header),
            // Flattened across every transfer overlay: the serializer emits them
            // into one overlay, which the xs:choice permits.
            (() => {
                const all: E142TransferMap[] = [];
                for (const ov of chosenSm?.overlays ?? []) {
                    if (ov.transferMaps !== undefined) { all.push(...ov.transferMaps); }
                }
                return all.length > 0 ? all : null;
            })(),
            // Decoration layers, when E142Overlays names any. Null - the default
            // - is today's single-overlay path, untouched.
            this.__e142Overlays !== null
                ? this.__buildDecorationLayers(chosenSm?.overlays ?? [], this.__e142Overlays)
                : null,
        );
        // A value field replaces the fill, so it is resolved after the grid exists
        // and against the same overlay set the decorations came from.
        this.__sceneValueFill = this.__e142Overlays === null ? null
            : this.__buildValueFill(chosenSm?.overlays ?? [], this.__e142Overlays);
        this.__warnReducerIgnored();
        // DeviceIdMap -> cell index: after a successful commit,
        // index a DeviceIdMap overlay from the SAME SubstrateMap (shared frame).
        if (this.__sceneGrid !== null && chosenSm !== null) {
            this.__deviceIdIndex = this.__buildDeviceIdIndex(chosenSm.overlays, header);
            this.__transferIndex = this.__buildTransferIndex(chosenSm.overlays, header);
            this.__deviceDataIndex = this.__buildDeviceDataIndex(chosenSm.overlays, header);
        }
    }

    /**
     * Builds the cell (serialization linear index) -> device-id map from the
     * FIRST `DeviceIdMap` overlay among `overlays`. Each `<Id>`
     * entry is placed by ADDRESS, and the two addressing forms 13.3 permits are
     * tried in the order `ws/notes/DECISION-lid.md` records:
     *
     * 1. **By `LID`**, when the entry carries one and the rendered map names that
     *    location. This is the join E142-0225 R2-3.2.2 describes, and it is tried
     *    first because it is an EXPLICIT correspondence: both documents name the
     *    same socket. Matching on X/Y instead assumes the two maps share a frame,
     *    which nothing checks.
     * 2. **By logical `X`/`Y`**, through the same frame the grid uses
     *    ({@link mapCoordToIndex}).
     *
     * An entry carrying BOTH whose LID and coordinate disagree is a
     * self-inconsistent document: the LID wins (rule 1) and one warning names
     * both cells, because only the author can say which was meant.
     *
     * Entries that resolve by neither, or whose coordinate lands off this grid,
     * are counted into one aggregated warning. Returns `null` when no DeviceIdMap
     * overlay is present or it yields no placeable id.
     * @param overlays The chosen SubstrateMap's overlays.
     * @param header   The map header (frame).
     * @returns The cell -> id map, or `null`.
     */
    /**
     * Resolves one address - a LID and/or a logical X/Y - to a cell of the
     * rendered grid.
     *
     * ONE RULE, ONE PLACE. Both {@link __buildDeviceIdIndex} and
     * {@link __buildTransferIndex} join foreign records onto cells, and they must
     * agree about how: **name first, coordinate second**. A LID is an EXPLICIT
     * correspondence - both documents name the same socket - whereas matching on
     * X/Y assumes the two share a frame, and nothing checks that.
     *
     * A record carrying both whose LID and coordinate name DIFFERENT cells is
     * self-inconsistent; the caller is told so it can warn once for the batch
     * rather than once per record.
     *
     * @param lid    The record's location identifier, or `undefined`.
     * @param x      The record's logical X, or `undefined`.
     * @param y      The record's logical Y, or `undefined`.
     * @param header The map header (the frame X/Y is read in).
     * @param grid   The rendered grid.
     * @param byLid  LID -> cell, inverted from the grid, or `null` when it names none.
     * @returns The cell and whether the two forms disagreed; `cell` is `null` when
     *          neither form resolves.
     */
    protected __resolveAddressToCell(
        lid: string | undefined,
        x: number | undefined,
        y: number | undefined,
        header: E142SubstrateMapHeader,
        grid: GridModel,
        byLid: Map<string, number> | null,
    ): { cell: number | null; disagreed: boolean } {
        let byCoord: number | null = null;
        if (x !== undefined && y !== undefined) {
            const { serCol, serRow } = mapCoordToIndex(
                x, y, header.originLocation, header.axisDirection, grid.cols, grid.rows,
            );
            byCoord = (serCol >= 0 && serCol < grid.cols && serRow >= 0 && serRow < grid.rows)
                ? serRow * grid.cols + serCol
                : null;
        }
        const byName = (lid !== undefined && byLid !== null) ? byLid.get(lid) ?? null : null;
        return {
            cell: byName ?? byCoord,
            disagreed: byName !== null && byCoord !== null && byName !== byCoord,
        };
    }

    /**
     * Inverts the grid's per-cell LIDs into a LID -> cell lookup.
     *
     * LIDs are NOT unique by declaration - E142 puts no `xs:key` on them anywhere
     * - so a repeat is legal. The FIRST cell wins and the count is returned, so
     * the caller can say so; taking the last would lose data silently.
     *
     * @param grid The rendered grid.
     * @returns The lookup (or `null` when no cell is named) and the repeat count.
     */
    protected __invertLids(grid: GridModel): { byLid: Map<string, number> | null; duplicates: number } {
        if (grid.lids === undefined) { return { byLid: null, duplicates: 0 }; }
        const byLid = new Map<string, number>();
        let duplicates = 0;
        for (const [cell, lid] of grid.lids) {
            if (byLid.has(lid)) { duplicates++; continue; }
            byLid.set(lid, cell);
        }
        return { byLid, duplicates };
    }

    /**
     * Builds the cell -> {@link TransferOrigin} lookup from the chosen
     * `SubstrateMap`'s transfer overlays.
     *
     * ACROSS ALL OF THEM, not the first. An overlay may carry several
     * `TransferMap` elements (`maxOccurs="unbounded"`) and a `SubstrateMap` may
     * carry several overlays that do - which it MUST whenever the substrate was
     * fed from more than one source, since the source is named per map. Taking
     * only the first would silently drop half a consolidated substrate's
     * provenance.
     *
     * The TARGET end of each `<T>` is resolved by {@link __resolveAddressToCell}:
     * `TID` first, then `TX`/`TY`. Entries whose target resolves to nothing - no
     * `TID` this map names and no on-grid `TX`/`TY` - are counted into one
     * aggregated warning rather than dropped silently, and so are collisions,
     * where two transfers claim the same cell.
     *
     * @param overlays The chosen SubstrateMap's overlays.
     * @param header   The map header (frame).
     * @returns The cell -> origin map, or `null` when there is nothing to index.
     */
    protected __buildTransferIndex(
        overlays: readonly E142Overlay[],
        header: E142SubstrateMapHeader,
    ): Map<number, TransferOrigin> | null {
        const grid = this.__sceneGrid;
        if (grid === null) { return null; }
        const maps: E142TransferMap[] = [];
        for (const ov of overlays) {
            if (ov.transferMaps !== undefined) { maps.push(...ov.transferMaps); }
        }
        if (maps.length === 0) { return null; }

        const { byLid, duplicates } = this.__invertLids(grid);
        const index = new Map<number, TransferOrigin>();
        let unplaceable = 0;
        let disagreed = 0;
        let collided = 0;
        for (const tm of maps) {
            for (const t of tm.transfers) {
                const r = this.__resolveAddressToCell(t.tid, t.tx, t.ty, header, grid, byLid);
                if (r.disagreed) { disagreed++; }
                if (r.cell === null) { unplaceable++; continue; }
                if (index.has(r.cell)) { collided++; continue; }
                const origin: TransferOrigin = {
                    fromSubstrateType: tm.fromSubstrateType,
                    fromSubstrateId: tm.fromSubstrateId,
                    fromLayoutSpecifier: tm.fromLayoutSpecifier,
                };
                if (t.fx !== undefined) { origin.fx = t.fx; }
                if (t.fy !== undefined) { origin.fy = t.fy; }
                if (t.fid !== undefined) { origin.fid = t.fid; }
                index.set(r.cell, origin);
            }
        }
        if (duplicates > 0) {
            this.__logWarnings([
                `E142_LID_DUPLICATE: the rendered map names ${duplicates} location`
                + `${duplicates === 1 ? '' : 's'} more than once; the FIRST cell carrying each repeated LID `
                + 'was used for the TransferMap join.',
            ]);
        }
        if (disagreed > 0) {
            this.__logWarnings([
                `E142_TRANSFER_ADDRESS_CONFLICT: ${disagreed} <T> element`
                + `${disagreed === 1 ? '' : 's'} carr${disagreed === 1 ? 'ies' : 'y'} a TID and a TX/TY that `
                + 'name DIFFERENT cells. The TID was used; only the document author can say which was meant.',
            ]);
        }
        if (collided > 0) {
            this.__logWarnings([
                `E142_TRANSFER_TARGET_COLLISION: ${collided} <T> element`
                + `${collided === 1 ? '' : 's'} target${collided === 1 ? 's' : ''} a cell an earlier transfer `
                + 'already claimed. One position holds one device, so this document records two arrivals at the '
                + 'same place; the FIRST was kept.',
            ]);
        }
        if (unplaceable > 0) {
            this.__logWarnings([
                `E142_TRANSFER_UNPLACEABLE: ${unplaceable} <T> element`
                + `${unplaceable === 1 ? '' : 's'} resolved to no cell of this grid - no TID the map names, and `
                + `no on-grid TX/TY - and ${unplaceable === 1 ? 'was' : 'were'} not indexed. An off-grid `
                + 'target usually means the transfer describes a different substrate than the one rendered.',
            ]);
        }
        return index.size > 0 ? index : null;
    }

    /**
     * Builds the cell -> readings lookup from a `DeviceDataMap` overlay.
     *
     * WHICH OVERLAY. `E142DeviceDataOverlayName` picks one by `MapName`, exactly
     * as `E142OverlayName` picks the renderable one; `null` takes the first that
     * carries device data. A named overlay that is not found is an ERROR-level
     * report rather than a silent fallback - a view asking for `"Metrology"` and
     * being shown `"Assembly"` is worse than being shown nothing.
     *
     * WHY THE PARAMETER LIST IS READ PER MAP. `DeviceDataMapType` pairs one
     * `Parameter` list with its own `DeviceData` records, and an overlay may
     * carry several maps (`maxOccurs="unbounded"`). Joining a value to a name
     * from a DIFFERENT map would be silently wrong, so each map's readings are
     * built against its own list.
     *
     * The cell is resolved by {@link __resolveAddressToCell} - LID first, then
     * X/Y - the same rule the device-id and transfer joins use.
     *
     * @param overlays The chosen SubstrateMap's overlays.
     * @param header   The map header (frame).
     * @returns The cell -> readings map, or `null` when there is nothing to index.
     */
    /**
     * Builds the decoration layers named by `E142Overlays`, for
     * {@link buildGridModel}'s optional fourth argument.
     *
     * DECORATIONS ONLY. The `base` entry is what `selectMapAndOverlay` already
     * rendered; this returns the rest, in list order, because the list order IS
     * the z-order - `OverlayKey` is (`MapName`, `MapVersion`), a set, so the
     * document declares none and one must not be inferred from element order.
     *
     * A named overlay that is absent, or that carries no `BinCodeMap`, is
     * reported and skipped rather than silently dropped: a view asking for
     * "DefectCode" and being shown nothing should be told why, and the remaining
     * decorations are still worth drawing.
     *
     * The lattice is NOT checked here - `buildGridModel` owns that, and throws
     * `GridLayerError`. Checking twice would let the two disagree.
     *
     * @param overlays The chosen SubstrateMap's overlays.
     * @param specs    The `E142Overlays` list.
     * @returns The decoration layers, or `null` when there are none to draw.
     */
    /**
     * Every composed overlay's bin at one cell: the base first, then each
     * decoration in list order.
     *
     * Returns `null` when the map is not composed, so a single-overlay view sees
     * the field absent rather than a one-element array it did not ask for.
     *
     * @param grid The rendered model.
     * @param cell Row-major linear cell index.
     * @returns The per-overlay bins, or `null`.
     */
    protected __overlayBinsAt(
        grid: GridModel,
        cell: number,
    ): Array<{ mapName: string; mapVersion: string; binCode: string | null; binQuality: string | null }> | null {
        if (grid.layers === undefined || grid.layers.length === 0) { return null; }
        const at = (cells: Uint32Array, table: BinTableEntry[]):
            { binCode: string | null; binQuality: string | null } => {
            if (cell < 0 || cell >= cells.length) { return { binCode: null, binQuality: null }; }
            const idx = cells[cell];
            // Index 0 is the reserved NULL bin: this overlay says nothing here.
            // Reported as null rather than as the null bin's code, which would
            // read like a real judgement.
            if (idx === 0) { return { binCode: null, binQuality: null }; }
            const b = table[idx];
            return { binCode: b ? b.code : null, binQuality: b ? b.quality : null };
        };
        const base = this.__e142Overlays?.find((o) => o.role === 'base');
        const out = [{
            mapName: base?.name ?? (this.__e142OverlayName ?? ''),
            mapVersion: base?.version ?? '',
            ...at(grid.cells, grid.binTable),
        }];
        for (const layer of grid.layers) {
            out.push({ mapName: layer.mapName, mapVersion: layer.mapVersion, ...at(layer.cells, layer.binTable) });
        }
        return out;
    }

    /**
     * Resolves the `valueField` overlay into a fill, or `null` when none is named.
     *
     * The ramp is built over the overlay's OWN bin table, in `BinDefinitions` order.
     * The control does not sort, rank or interpolate: a quantized field's levels are
     * already ordered by whoever quantized them, and inferring an order from bin
     * codes would be inventing meaning the document did not state.
     * @param overlays The document's overlays.
     * @param specs    The bound `E142Overlays` list.
     * @returns `{ cells, colors }`, or `null`.
     */
    protected __buildValueFill(
        overlays: readonly E142Overlay[],
        specs: readonly OverlaySpec[],
    ): { cells: Uint32Array; colors: readonly string[] } | null {
        const wanted = specs.filter((s) => s.role === 'valueField');
        if (wanted.length === 0) { return null; }
        if (wanted.length > 1) {
            this.__logWarnings([
                `E142_OVERLAYS_MULTIPLE_VALUE_FIELD: ${wanted.length} entries claim role `
                + '"valueField". A value field owns the fill, and a fill has one meaning — the first '
                + 'is used and the rest are ignored. Show the others as decorations, or bind them one '
                + 'at a time.',
            ]);
        }
        const spec = wanted[0];
        const found = overlays.find((ov) => ov.mapName === spec.name
            && (spec.version === undefined || ov.mapVersion === spec.version));
        if (found === undefined || found.payload === undefined) {
            this.__logWarnings([
                `E142_OVERLAYS_VALUE_FIELD_NOT_FOUND: ${JSON.stringify(spec.name)} is named as a `
                + 'valueField but is not a renderable BinCodeMap overlay of this SubstrateMap. The '
                + 'base fill is used instead.',
            ]);
            return null;
        }
        // codes[0] is the null bin — the overlay saying nothing about a cell — and
        // takes no color, so the ramp spans the remaining levels.
        return {
            cells: found.payload.cells,
            colors: ['', ...valueRampColors(Math.max(0, found.payload.codes.length - 1))],
        };
    }

    protected __buildDecorationLayers(
        overlays: readonly E142Overlay[],
        specs: readonly OverlaySpec[],
    ): GridBinLayer[] | null {
        const out: GridBinLayer[] = [];
        const missing: string[] = [];
        for (const spec of specs) {
            // A value field is not a decoration: it owns the fill rather than
            // contributing a mark, and is resolved separately.
            if (spec.role === 'base' || spec.role === 'valueField') { continue; }
            const found = overlays.find((ov) => ov.mapName === spec.name
                && (spec.version === undefined || ov.mapVersion === spec.version));
            if (found === undefined || found.payload === undefined) {
                missing.push(JSON.stringify(spec.name)
                    + (spec.version === undefined ? '' : ` @${JSON.stringify(spec.version)}`));
                continue;
            }
            out.push({
                mapName: found.mapName,
                mapVersion: found.mapVersion,
                cells: found.payload.cells,
                // The SAME construction the base uses, so a decoration's
                // quality and pick can never disagree with the identical bin
                // on the base layer.
                binTable: buildBinTable(found.payload.codes, null),
            });
        }
        if (missing.length > 0) {
            this.__logWarnings([
                `E142_OVERLAYS_DECORATION_NOT_FOUND: ${missing.join(', ')} named by E142Overlays `
                + `${missing.length === 1 ? 'is' : 'are'} not a renderable BinCodeMap overlay of this `
                + `SubstrateMap. Available: `
                + `${overlays.filter((o) => o.payload !== undefined).map((o) => JSON.stringify(o.mapName)).join(', ')}. `
                + 'The remaining decorations are still drawn.',
            ]);
        }
        return out.length > 0 ? out : null;
    }

    protected __buildDeviceDataIndex(
        overlays: readonly E142Overlay[],
        header: E142SubstrateMapHeader,
    ): Map<number, DeviceReading[]> | null {
        const grid = this.__sceneGrid;
        if (grid === null) { return null; }
        const withData = overlays.filter((ov) => ov.deviceDataMaps !== undefined && ov.deviceDataMaps.length > 0);
        if (withData.length === 0) { return null; }

        const wanted = this.__e142DeviceDataOverlayName;
        let chosen = withData[0];
        if (wanted !== null) {
            const match = withData.find((ov) => ov.mapName === wanted);
            if (match === undefined) {
                this.__logWarnings([
                    `E142_DEVICEDATA_OVERLAY_NOT_FOUND: no DeviceDataMap overlay is named `
                    + `${JSON.stringify(wanted)}. Available: `
                    + `${withData.map((ov) => JSON.stringify(ov.mapName)).join(', ')}. No device data is `
                    + 'reported - showing a different overlay\'s readings under the requested name would '
                    + 'be worse than showing none.',
                ]);
                return null;
            }
            chosen = match;
        }

        const { byLid, duplicates } = this.__invertLids(grid);
        const index = new Map<number, DeviceReading[]>();
        let unplaceable = 0;
        let disagreed = 0;
        for (const map of chosen.deviceDataMaps ?? []) {
            const names = map.parameters;
            for (const dd of map.deviceData) {
                const r = this.__resolveAddressToCell(dd.lid, dd.x, dd.y, header, grid, byLid);
                if (r.disagreed) { disagreed++; }
                if (r.cell === null) { unplaceable++; continue; }
                const readings: DeviceReading[] = [];
                for (let k = 0; k < dd.values.length; k++) {
                    readings.push({
                        // Past the end of the parameter list the value has no
                        // name. Reported by the parser as a count mismatch; here
                        // it is shown as an empty name rather than dropped, so a
                        // reader sees that there IS an unlabeled reading.
                        name: k < names.length ? names[k].name : '',
                        value: pvToDisplayString(dd.values[k]),
                        raw: dd.values[k],
                    });
                }
                // Several DeviceData for one cell: concatenate rather than
                // overwrite. Two maps in one overlay legitimately describe the
                // same device from two process steps.
                const prior = index.get(r.cell);
                if (prior === undefined) { index.set(r.cell, readings); }
                else { prior.push(...readings); }
            }
        }
        if (duplicates > 0) {
            this.__logWarnings([
                `E142_LID_DUPLICATE: the rendered map names ${duplicates} location`
                + `${duplicates === 1 ? '' : 's'} more than once; the FIRST cell carrying each repeated `
                + 'LID was used for the DeviceDataMap join.',
            ]);
        }
        if (disagreed > 0) {
            this.__logWarnings([
                `E142_DEVICEDATA_ADDRESS_CONFLICT: ${disagreed} <DeviceData> record`
                + `${disagreed === 1 ? '' : 's'} carr${disagreed === 1 ? 'ies' : 'y'} a LID and an X/Y `
                + 'that name DIFFERENT cells. The LID was used; only the document author can say which '
                + 'was meant.',
            ]);
        }
        if (unplaceable > 0) {
            this.__logWarnings([
                `E142_DEVICEDATA_UNPLACEABLE: ${unplaceable} <DeviceData> record`
                + `${unplaceable === 1 ? '' : 's'} resolved to no cell of this grid - no LID the map `
                + `names, and no on-grid X/Y - and ${unplaceable === 1 ? 'was' : 'were'} not indexed.`,
            ]);
        }
        return index.size > 0 ? index : null;
    }

    protected __buildDeviceIdIndex(
        overlays: readonly E142Overlay[],
        header: E142SubstrateMapHeader,
    ): Map<number, string> | null {
        const grid = this.__sceneGrid;
        if (grid === null) { return null; }
        const src = overlays.find((ov) => ov.deviceIdEntries !== undefined && ov.deviceIdEntries.length > 0);
        if (src === undefined || src.deviceIdEntries === undefined) { return null; }
        // Same address rule as the transfer index, in one place.
        const { byLid, duplicates: duplicateLids } = this.__invertLids(grid);
        const index = new Map<number, string>();
        let unplaceable = 0;
        let disagreed = 0;
        for (const e of src.deviceIdEntries) {
            const r = this.__resolveAddressToCell(e.lid, e.x, e.y, header, grid, byLid);
            if (r.disagreed) { disagreed++; }
            if (r.cell === null) { unplaceable++; continue; }
            index.set(r.cell, e.deviceId);
        }
        if (duplicateLids > 0) {
            this.__logWarnings([
                `E142_LID_DUPLICATE: the rendered map names ${duplicateLids} location`
                + `${duplicateLids === 1 ? '' : 's'} more than once. E142 declares no uniqueness constraint on `
                + 'LID, so this is a valid document; the FIRST cell carrying each repeated LID was used for the '
                + 'DeviceIdMap join.',
            ]);
        }
        if (disagreed > 0) {
            this.__logWarnings([
                `E142_DEVICEID_ADDRESS_CONFLICT: ${disagreed} DeviceIdMap <Id> entr`
                + `${disagreed === 1 ? 'y carries' : 'ies carry'} a LID and an X/Y that name DIFFERENT cells. `
                + 'The LID was used (it is an explicit correspondence; matching X/Y assumes both maps share a '
                + 'frame). Only the document author can say which was meant.',
            ]);
        }
        if (unplaceable > 0) {
            this.__logWarnings([
                `E142_DEVICEID_UNPLACEABLE: ${unplaceable} DeviceIdMap <Id> entr${unplaceable === 1 ? 'y' : 'ies'} `
                + `resolved to no cell of this grid - no LID the map names, and no on-grid X/Y - and `
                + `${unplaceable === 1 ? 'was' : 'were'} not indexed.`,
            ]);
        }
        return index.size > 0 ? index : null;
    }

    /**
     * Normalizes a GridData document, then builds the grid and identity from the
     * identity pass-through.
     * @param gd The GridData document.
     */
    protected __buildFromGrid(gd: GridData): void {
        let n: NormalizedGridData;
        try {
            n = normalizeGridData(gd);
        } catch (e) {
            this.__applyMapError(this.__describeError(e));
            return;
        }
        this.__logWarnings(n.warnings);
        this.__commitGrid(
            n.header,
            n.resolvedLayout,
            n.payload,
            n.binDefs,
            gd.binType,
            [], // GridData carries no ReferenceDevices; registration is XML-only
            {
                substrateId: n.identity.substrateId ?? null,
                lotId: n.identity.lotId ?? null,
                goodDevices: n.identity.goodDevices ?? null,
                // GridData declares none of these, so there is nothing to carry.
                supplierName: null,
                status: null,
                aliasIds: null,
                carrierType: null,
                carrierId: null,
                slotNumber: null,
                substrateNumber: null,
                // GridData has NO side field. normalizeGridData supplies the XSD
                // default TopSide, which is what this reports - not an invented
                // value, and not null: the contract's silence means TopSide.
                substrateSide: n.header.substrateSide,
            },
            //... nor a MapVersion. Absent is the same OverlayKey value as "",
            // so an XML export from a GridData source correctly omits it.
            null,
            //... nor a layout tree.
            null,
            //... nor any transfers.
            null,
            //... and GridData has no overlays at all, so no decorations.
            null,
        );
    }

    /**
     * Shared tail for both input paths: computes the placement (with the
     * orientation offset and the fallback pitch), fits it to the outline box when
     * the map carries no physical scale (without an outline the lattice keeps
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
    protected __commitGrid(
        header: E142SubstrateMapHeader,
        layout: ResolvedLayout,
        payload: DecodedBinPayload,
        binDefs: E142BinDefinition[] | null,
        binType: E142BinType,
        referenceDevices: readonly E142ReferenceDevice[],
        identity: SubstrateMapIdentity,
        mapVersion: string | null,
        sourceLayout: E142Layout | null,
        transferMaps: readonly E142TransferMap[] | null,
        decorations: readonly GridBinLayer[] | null,
    ): void {
        // A new build supersedes any prior DeviceIdMap index; __buildFromDoc
        // rebuilds it after a successful XML commit, the GridData path leaves it null.
        this.__deviceIdIndex = null;
        this.__transferIndex = null;
        this.__deviceDataIndex = null;

        /*
         * The side mirror is a VIEW transform and is decided HERE, from the
         * viewer's ViewSubstrateSide against the map's own SubstrateSide - never
         * from the map's side alone. `follow-map` mirrors nothing, which is what
         * makes the default byte-for-byte the unmirrored rendering.
         *
         *   follow-map                     -> false
         *   TopSide    + map BottomSide    -> true
         *   BottomSide + map TopSide       -> true
         *   asked-for side == map's side   -> false (already looking at it)
         */
        const sideMirror = this.__viewSubstrateSide !== 'follow-map'
            && this.__viewSubstrateSide !== header.substrateSide;
        if (sideMirror) {
            // One informational line per commit, not per frame: a mirrored view
            // is a deliberate choice, and silently rendering a mirrored map is
            // how a reader ends up reading a wafer backwards.
            TcHmi.Log.info(
                this.__id + ': rendering mirrored - the map describes '
                + header.substrateSide + ' and ViewSubstrateSide asks for '
                + this.__viewSubstrateSide + '.',
            );
        }
        const result = computeGridPlacement(
            header, layout, this.__e142OrientationOffset, this.__fallbackStep(), sideMirror,
        );
        this.__logWarnings(result.warnings.map((w) => w.code + ': ' + w.message));
        let placement = result.placement;
        if (!result.scaled) {
            // No physical pitch. With an outline (explicit or preset), fit the
            // lattice to its bounding box (square cells, centered). Without one, keep
            // the unit-pitch placement and let the shell's fitBBox letterbox the grid
            // on its own. Either way the sizes are NOMINAL, not physical.
            const box = (this.__outlineModel ?? this.__presetOutlineModel)?.bbox;
            if (box) {
                placement = fitPlacementToBox(placement, payload.cols, payload.rows, box);
            }
        }
        // Reference-device registration (opt-in): translate the placement so reference-device
        // model cell-centers meet their stated Positions. Off unless enabled.
        if (this.__alignToReferenceDevices && referenceDevices.length > 0) {
            const reg = registerPlacementToReferenceDevices(
                placement, referenceDevices, header.originLocation, header.axisDirection,
                payload.cols, payload.rows, layout.unitsToMm,
            );
            this.__logWarnings(reg.warnings.map((w) => w.code + ': ' + w.message));
            placement = reg.placement;
        }
        let grid: GridModel | null;
        try {
            grid = buildGridModel(
                placement, payload, binDefs ? binDefs.map(toEngineBinDefinition) : null,
                decorations ?? undefined,
            );
        } catch (e) {
            // A decoration that disagrees with the base lattice. The BASE is fine,
            // so the map is drawn without decorations rather than blanked - the
            // asymmetry DECISION-overlay-composition.md 6 sets out: a wrong
            // decoration is invisible, a dropped one is reported and absent.
            if (e instanceof GridLayerError) {
                this.__logWarnings([`${e.code}: ${e.message}`]);
                grid = buildGridModel(placement, payload, binDefs ? binDefs.map(toEngineBinDefinition) : null);
            } else {
                throw e;
            }
        }
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
            substrateId: identity.substrateId,
            substrateSide: header.substrateSide,
            mapVersion,
            lotId: identity.lotId,
            goodDevices: identity.goodDevices,
            supplierName: identity.supplierName,
            status: identity.status,
            aliasIds: identity.aliasIds,
            carrierType: identity.carrierType,
            carrierId: identity.carrierId,
            slotNumber: identity.slotNumber,
            substrateNumber: identity.substrateNumber,
            sourceLayout,
            transferMaps,
        };
        this.setE142LastError(null);
        this.__setMapIdentity(identity);
        this.__updateGrid(grid);
        // A new document brings new bin definitions, so a token that was never
        // reported may now be present. The latch is per (bin code, token) and
        // survives a rebuild that changes neither.
        this.__warnUnmappedBinQualities();
        this.__warnBinSeverityPriority();
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
    protected __matchSubstrate(doc: E142Document, header: E142SubstrateMapHeader): E142Substrate | null {
        for (const sub of doc.substrates) {
            if (sub.substrateType === header.substrateType && sub.substrateId === header.substrateId) {
                return sub;
            }
        }
        return null;
    }

    /**
     * Pushes the map identity outputs and refreshes the identity label, which
     * shows {@link getMapSubstrateId} when the explicit SubstrateId is unset and
     * a map is bound.
     *
     * Takes the whole {@link SubstrateMapIdentity} rather than one parameter per
     * output. There are seven and more may follow, and a
     * run of same-typed positional arguments is a transposition that compiles.
     * Passing the record also makes the RESET a single well-formed value instead
     * of a row of `null`s whose count has to match.
     *
     * @param identity The active map's substrate record, or {@link NO_IDENTITY}.
     */
    protected __setMapIdentity(identity: SubstrateMapIdentity): void {
        this.setMapSubstrateId(identity.substrateId);
        this.setMapLotId(identity.lotId);
        this.setMapGoodDevices(identity.goodDevices);
        this.setMapCarrierType(identity.carrierType);
        this.setMapCarrierId(identity.carrierId);
        this.setMapSlotNumber(identity.slotNumber);
        this.setMapSubstrateNumber(identity.substrateNumber);
        this.setMapAliasIds(identity.aliasIds);
        this.setMapSubstrateSide(identity.substrateSide);
        this.__updateIdentity();
    }

    /**
     * Publishes {@link getMapSubstrateCount} from the cached parse.
     *
     * DERIVED, never assigned by hand. `__e142Doc` is written in five places and
     * a count maintained alongside them would go stale in one of them sooner or
     * later; reading it at the three moments the answer can change - a document
     * was built from, an error was reported, the map was unbound - cannot.
     *
     * The cache is nulled before every re-parse, so on a PARSE failure the doc
     * is already `null` here and the count clears. On a SELECTION failure the
     * doc survives and the count stays, which is the point.
     */
    protected __publishSubstrateCount(): void {
        this.setMapSubstrateCount(this.__e142Doc === null ? null : this.__e142Doc.substrateMaps.length);
    }

    /**
     * Reports a map-ingestion failure: sets {@link getE142LastError}, logs to the
     * framework logger, and clears the grid, the logical frame and the identity
     * outputs. The demo stays suppressed while a map is bound, so the canvas shows
     * only the outline / preset (if any).
     * @param message The error message.
     */
    protected __applyMapError(message: string): void {
        this.__publishSubstrateCount();
        this.setE142LastError(message);
        TcHmi.Log.error(this.__id + ': ' + message);
        this.__mapFrame = null;
        this.__setMapIdentity(NO_IDENTITY);
        this.__updateGrid(null);
        this.__syncScene();
    }

    /**
     * Clears all map state on unbind: drops the cached parse, the grid, the
     * logical frame, the identity outputs and the error. With no map bound the
     * demo behavior is restored.
     */
    protected __clearMap(): void {
        this.__e142Doc = null;
        this.__publishSubstrateCount();
        this.__mapFrame = null;
        this.__lastBuilt = null;
        this.__deviceIdIndex = null;
        this.__transferIndex = null;
        this.__deviceDataIndex = null;
        this.setE142LastError(null);
        this.__setMapIdentity(NO_IDENTITY);
        this.__updateGrid(null);
        this.__syncScene();
    }

    /**
     * Surfaces engine / domain warnings to the framework logger, one line each,
     * prefixed with the control id.
     * @param messages Human-readable warning lines.
     */
    protected __logWarnings(messages: string[]): void {
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
    protected __describeError(e: unknown): string {
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
    protected __cellMapCoord(col: number, row: number): { mapX: number; mapY: number } | null {
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
TcHmi.Controls.registerEx(
    'SubstrateMap',
    'TcHmi.Controls.CNM_UIControls.SEMI',
    SubstrateMap,
    { injectInGlobalObject: true }
);
