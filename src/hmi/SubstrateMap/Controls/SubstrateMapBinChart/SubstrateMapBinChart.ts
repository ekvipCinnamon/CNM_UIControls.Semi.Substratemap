/*
 * SubstrateMapBinChart - a bin chart for a substrate map, in either of two
 * presentations.
 *
 * ---- ONE CONTROL FOR BOTH ----
 *
 * `ChartStyle: Bars | Share`. The two styles consume identical data, share
 * palette resolution, the empty state, the remainder bucket and the sort order,
 * and differ only in geometry - `fillRect` against `arc`. Two controls would be
 * two copies of everything except the drawing call.
 *
 * The choice is not free, because the asymmetry is real: splitting
 * later is a migration, since every view carrying `ChartStyle="Share"` has to be
 * re-authored, and merging later is not. Beckhoff's own `TcHmiBarChart` /
 * `TcHmiPieChart` split is not a precedent - those share no data model.
 *
 * ---- IT TAKES A MAP, NOT A SIBLING'S ID ----
 *
 * The same map attributes `SubstrateMap` takes, bound by the author. NOT a
 * reference to a sibling control by id: an id coupling points silently at
 * nothing the moment someone moves the map to another page, and the failure
 * looks like "the chart is empty" rather than like a broken reference. A binding
 * of its own DEGRADES - the document is parsed twice - rather than corrupting.
 *
 * ---- WHAT IT DOES NOT INHERIT THE USE OF ----
 *
 * `extends SubstrateMapBase` for the canvas, the device-pixel sizing, the
 * `ResizeObserver`, the theme read and the teardown. It never pushes a grid, so
 * there is no lattice, no aggregation and no cell hit test: a chart counts bins,
 * it does not draw a wafer. The base's grid machinery costs nothing when nothing
 * is pushed to it.
 *
 * ---- WHAT IT DRAWS ----
 *
 * The bars or the share, over the base's frame. With nothing bound the BASE
 * draws, as it does for the tile: the no-data image. A chart showing a blank
 * rectangle is exactly the failure that image exists to prevent.
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
 */

import {
    SubstrateMapBase, type SelectedPayload,
    /*
     * The BASE's age helpers, shared with the tile. A chart and a tile showing the
     * same wafer must agree about how old it is, and two copies of a clock is two
     * clocks. The rules - which format parses, which source is named, that a missing
     * timestamp falls back to the receive time - live in one place, and none of that
     * is worth deciding twice.
     */
    formatAge, parseMapTimestamp, type AgeText,
} from '../SubstrateMapBase/SubstrateMapBase.js';
import { CATEGORICAL_OTHER } from '../../Helpers/SubstrateMapEngine/Oklch.js';
import {
    binStatistics, buildGridModel, type BinStatistics, type GridModel, type SubstrateMapColors,
} from '../../Helpers/SubstrateMapEngine/Engine.js';
import {
    computeGridPlacement, selectMapAndOverlay, resolveLayoutSpecifier, dimsFromPayload, E142Error,
    type E142Document,
} from '../../Helpers/SubstrateMapEngine/E142.js';
import { parseE142Xml } from '../../Helpers/SubstrateMapEngine/E142Xml.js';
import { parseE142Json } from '../../Helpers/SubstrateMapEngine/E142Json.js';
import { normalizeGridData, type GridData } from '../../Helpers/SubstrateMapEngine/E142Grid.js';
import { toEngineBinDefinition } from '../SubstrateMap/SubstrateMap.js';
import { categoricalBinFallback } from '../../Helpers/SubstrateMapEngine/BinPalette.js';

/** Which presentation the chart draws. */
export type ChartStyle = 'Bars' | 'Share';

/** How the categories are ordered. */
export type ChartSort = 'CountDescending' | 'Code';

/** How many categories are drawn before the rest become `Other`. */
export const CHART_CATEGORY_CAP = 10;

/** The label a truncated remainder carries. */
/*
 * The KEY for the remainder bucket, not the text. The chart resolves it through
 * `this.__localization.getText` when it draws, so the label follows the operator's
 * locale; the constant stays exported because the categories carry it as an
 * identifier and callers compare against it.
 */
export const CHART_OTHER_LABEL = 'chart.other';

/** Padding around the plot, in CSS pixels. */
const CHART_PAD = 10;

/** Width of the separator between two wedges, in CSS pixels. */
const CHART_WEDGE_EDGE = 1.5;

/** Height of the header band carrying the substrate id and the age. */
const CHART_HEADER = 15;

/** Space reserved above for the counts and below for the codes. */
const CHART_LABEL_BAND = 16;

/** Gap between adjacent bars. */
const CHART_BAR_GAP = 6;

/** Gap between a bar and its number. */
const CHART_NUMBER_GAP = 3;

/** Width reserved for the share legend, in CSS pixels. */
const CHART_LEGEND_WIDTH = 120;

/** Vertical step between legend entries. */
const CHART_LEGEND_STEP = 16;

/** Side of a legend color swatch. */
const CHART_SWATCH = 10;

/** One category as the chart will draw it. */
export interface ChartCategory {
    /** The bin code, or {@link CHART_OTHER_LABEL} for the remainder. */
    readonly code: string;
    /** Cells in this category. For the remainder, the SUM of what it absorbed. */
    readonly count: number;
    /** The color. */
    readonly color: string;
    /** How many codes this entry covers: `1`, or the number absorbed. */
    readonly covers: number;
}

/**
 * Turns bin statistics into the categories a chart draws.
 *
 * ---- DESCENDING BY COUNT, NOT BY CODE ----
 *
 * A chart exists to put the biggest thing first. Ordering by code is ordering by
 * an accident of the sort program's numbering, which is information about the
 * tester rather than about the wafer. `Code` remains available by attribute for
 * the case where an operator is comparing two charts and needs the bars to line
 * up.
 *
 * ---- A CATEGORY WITH COUNT 0 DOES NOT APPEAR ----
 *
 * A zero-height bar is a line nobody can read, and a legend entry for something
 * that did not happen is a category an operator will look for on the wafer and
 * not find. `binStatistics` already omits codes that occur nowhere; this drops
 * any that survive with a count of zero.
 *
 * ---- PAST THE CAP, THE REMAINDER ----
 *
 * Nine largest plus `Other`, colored `CATEGORICAL_OTHER` - the same truncation
 * the group descriptor uses and for the same reason: a legend longer than a
 * dozen entries is a table, and a table is a different control.
 *
 * The remainder is computed from what it ABSORBS, never from a subtraction
 * against the total. A subtraction would hide an inconsistency in the input by
 * silently balancing it, and the bars must sum exactly.
 * @param stats  What `readBinStatistics` returned.
 * @param sort   The order.
 * @param cap    How many categories before the remainder; `CHART_CATEGORY_CAP` by default.
 * @returns The categories, in draw order.
 */
export function chartCategories(stats: { bins: readonly { code: string; count: number; color: string }[] },
    sort: ChartSort = 'CountDescending', cap: number = CHART_CATEGORY_CAP): ChartCategory[] {
    const present = stats.bins.filter((b) => b.count > 0);
    /*
     * Sorted by count, then by CODE as the tie-break, so two readings of the same
     * map produce the same picture. Without the second key a chart's bars would
     * reorder themselves between frames whenever two categories drew level.
     */
    const byCount = [...present].sort((a, b) =>
        b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));

    let chosen: typeof byCount;
    let remainder: typeof byCount;
    if (byCount.length <= cap) {
        chosen = byCount;
        remainder = [];
    } else {
        // cap - 1, because the remainder itself occupies one slot.
        chosen = byCount.slice(0, cap - 1);
        remainder = byCount.slice(cap - 1);
    }

    const ordered = sort === 'Code'
        ? [...chosen].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
        : chosen;

    const out: ChartCategory[] = ordered.map((b) => ({
        code: b.code, count: b.count, color: b.color, covers: 1,
    }));
    if (remainder.length > 0) {
        /*
         * ALWAYS LAST, whichever sort is in force. `Other` is not a category with a
         * code; it is what is left, and putting it in alphabetical position among
         * real codes would suggest it is one of them.
         */
        out.push({
            code: CHART_OTHER_LABEL,
            count: remainder.reduce((n, b) => n + b.count, 0),
            color: CATEGORICAL_OTHER,
            covers: remainder.length,
        });
    }
    return out;
}

/** Below this percentage a segment is labeled in the legend instead of in itself. */
export const CHART_SLIVER_PERCENT = 1;

/** One category as a share of the whole. */
export interface ChartShare {
    /** The bin code, or {@link CHART_OTHER_LABEL}. */
    readonly code: string;
    /** Cells in this category. */
    readonly count: number;
    /** The color. */
    readonly color: string;
    /** The share, to one decimal, ADJUSTED so the set sums to exactly 100.0. */
    readonly percent: number;
    /** Whether the label fits inside the segment. */
    readonly inSegment: boolean;
}

/**
 * Turns categories into shares that sum to exactly 100.0.
 *
 * ---- THE ROUNDING REMAINDER GOES SOMEWHERE VISIBLE ----
 *
 * Ten categories rounded to one decimal need not sum to 100.0 - they routinely
 * land on 99.9 or 100.1. Leaving that is a chart whose numbers do not add up,
 * and an operator who adds them will find it.
 *
 * The remainder goes to the LARGEST segment, where a tenth of a percent is the
 * smallest relative change it could make. Spreading it across several would
 * corrupt several readings to hide one; giving it to the smallest would move the
 * number that has the least room to absorb it - a 0.2 % segment becoming 0.3 %
 * is a 50 % error in that reading.
 *
 * ---- A SLIVER IS LABELED IN THE LEGEND ----
 *
 * Below one percent a segment is a few pixels of arc: a label drawn in it
 * overlaps its neighbors and points at nothing. `inSegment` says where the
 * label goes; it does not change the geometry, because the segment is still
 * drawn at its true size.
 * @param categories What the chart is showing.
 * @returns The shares, in the same order.
 */
export function chartShares(categories: readonly ChartCategory[]): ChartShare[] {
    const total = categories.reduce((n, c) => n + c.count, 0);
    if (total <= 0) { return []; }
    const raw = categories.map((c) => ({
        c, exact: (c.count / total) * 100,
    }));
    const rounded = raw.map((r) => Math.round(r.exact * 10) / 10);
    const sum = rounded.reduce((n, v) => n + v, 0);
    // Rounded to a tenth before comparing: the sum of ten one-decimal numbers
    // carries binary float error of its own, and 100.00000000000001 is not a
    // remainder anyone needs to redistribute.
    const remainder = Math.round((100 - sum) * 10) / 10;
    if (remainder !== 0) {
        let biggest = 0;
        for (let i = 1; i < raw.length; i++) {
            if (raw[i].c.count > raw[biggest].c.count) { biggest = i; }
        }
        rounded[biggest] = Math.round((rounded[biggest] + remainder) * 10) / 10;
    }
    return categories.map((c, i) => ({
        code: c.code, count: c.count, color: c.color,
        percent: rounded[i],
        inSegment: rounded[i] >= CHART_SLIVER_PERCENT,
    }));
}

/**
 * The tooltip for a category.
 *
 * Only the remainder gets one, and it says how many codes it covers - a bar
 * labeled `Other` with no way to learn what is in it is a dead end.
 * @param category The category.
 * @returns The text, or `null` when there is nothing to add.
 */
export function chartTooltip(category: ChartCategory): string | null {
    if (category.covers <= 1) { return null; }
    return `${CHART_OTHER_LABEL}: ${category.covers} further bin codes, `
        + `${category.count} cells in total`;
}

/**
 * A bin chart for a substrate map.
 *
 * Concrete and placeable, so `registerEx` needs no cast.
 */
export class SubstrateMapBinChart extends SubstrateMapBase {
    /**
     * @param element   The control's element.
     * @param pcElement The parent container element.
     * @param attrs     The attribute list from the markup.
     */
    public constructor(element: JQuery, pcElement: JQuery, attrs: TcHmi.Controls.ControlAttributeList) {
        super(element, pcElement, attrs);
    }

    // ---------------------------------------------------------------
    //  The attribute surface
    // ---------------------------------------------------------------

    /** `GridData`, or `null`. */
    protected __gridData: GridData | null = null;
    /** `E142MapData`, the XML string, or `null`. */
    protected __e142MapData: string | null = null;
    /** `E142MapDataJson`, or `null`. */
    protected __e142MapDataJson: object | null = null;
    /** `ChartStyle`. */
    protected __chartStyle: ChartStyle = 'Bars';
    /** `ChartSort`. */
    protected __chartSort: ChartSort = 'CountDescending';
    /** `CategoryCap`. */
    protected __categoryCap: number = CHART_CATEGORY_CAP;
    /** `MapTimestamp` as bound, before parsing. */
    protected __mapTimestamp: string | null = null;
    /** When the current payload arrived, for the `received` clock. */
    protected __receivedAt: Date = new Date();
    /** The substrate id of the map on screen, or `null`. */
    protected __substrateId: string | null = null;
    /** The parsed map, or `null`. A chart holds a model it never pushes as a grid. */
    protected __chartGrid: GridModel | null = null;
    /** The last unreadable-map complaint, so a rebind does not repeat it. */
    protected __mapErrorWarned: string | null = null;
    /**
     * The categorical fallback by bin-table index, or `null`.
     *
     * ---- WHY THE CHART HOLDS IT TOO ----
     *
     * A code with no mapping and no usable quality takes a color from the
     * categorical palette. The MAP applies it; a chart that did not would draw a
     * map whose bin definitions declare no quality as eight distinct colors on
     * the wafer and eight identical grays in the bars.
     *
     * A test whose fixture declares `Pass` and `Fail` cannot see that, because
     * quality coloring wins whenever a quality is there - both sides agree by
     * taking the same shortcut. A person looking at eight gray bars beside an
     * eight-colored wafer sees it immediately.
     */
    protected __chartCategorical: readonly (string | null)[] | null = null;

    /** @param valueNew The grid, or `null`. */
    public setGridData(valueNew: GridData | null): void {
        const v = TcHmi.ValueConverter.toObject<GridData>(valueNew);
        if (tchmi_equal(v, this.__gridData)) { return; }
        this.__gridData = v;
        this.__receivedAt = new Date();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'GridData' });
        this.__syncScene();
    }
    /** @returns The grid, or `null`. */
    public getGridData(): GridData | null { return this.__gridData; }

    /** @param valueNew The E142 XML, or `null`. */
    public setE142MapData(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142MapData)) { return; }
        this.__e142MapData = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142MapData' });
        this.__syncScene();
    }
    /** @returns The E142 XML, or `null`. */
    public getE142MapData(): string | null { return this.__e142MapData; }

    /** @param valueNew The E142 JSON document, or `null`. */
    public setE142MapDataJson(valueNew: object | null): void {
        const v = TcHmi.ValueConverter.toObject<object>(valueNew);
        if (tchmi_equal(v, this.__e142MapDataJson)) { return; }
        this.__e142MapDataJson = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'E142MapDataJson' });
        this.__syncScene();
    }
    /** @returns The E142 JSON document, or `null`. */
    public getE142MapDataJson(): object | null { return this.__e142MapDataJson; }

    /** @param valueNew The presentation, or `null` for `Bars`. */
    public setChartStyle(valueNew: ChartStyle | null): void {
        const v = (TcHmi.ValueConverter.toString(valueNew) ?? 'Bars') as ChartStyle;
        if (v === this.__chartStyle) { return; }
        this.__chartStyle = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ChartStyle' });
        this.__requestRender();
    }
    /** @returns The presentation. */
    public getChartStyle(): ChartStyle { return this.__chartStyle; }

    /** @param valueNew The order, or `null` for `CountDescending`. */
    public setChartSort(valueNew: ChartSort | null): void {
        const v = (TcHmi.ValueConverter.toString(valueNew) ?? 'CountDescending') as ChartSort;
        if (v === this.__chartSort) { return; }
        this.__chartSort = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ChartSort' });
        this.__requestRender();
    }
    /** @returns The order. */
    public getChartSort(): ChartSort { return this.__chartSort; }

    /**
     * @param valueNew How many categories before the remainder, or `null` for the
     *        default. Below two there is no room for both a category and a
     *        remainder, so two is the floor.
     */
    public setCategoryCap(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const v = raw === null || !Number.isFinite(raw)
            ? CHART_CATEGORY_CAP : Math.max(2, Math.floor(raw));
        if (v === this.__categoryCap) { return; }
        this.__categoryCap = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'CategoryCap' });
        this.__requestRender();
    }
    /** @returns The cap. */
    public getCategoryCap(): number { return this.__categoryCap; }

    /**
     * Sets when the map was measured.
     *
     * The tile's attribute, verbatim, so one symbol drives both. It exists because
     * an E142 document carries no timestamp: the `ITEMVERSION` the standard
     * defines belongs to the Stream 21 message that transports the item.
     * @param valueNew The instant, or `null` to fall back to the receive time.
     */
    public setMapTimestamp(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__mapTimestamp)) { return; }
        this.__mapTimestamp = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'MapTimestamp' });
        this.__requestRender();
    }
    /** @returns The bound instant, or `null`. */
    public getMapTimestamp(): string | null { return this.__mapTimestamp; }

    /**
     * The age line the chart would draw right now.
     * @returns The line, its source and its age in seconds.
     */
    public readAge(): AgeText {
        return formatAge(parseMapTimestamp(this.__mapTimestamp), this.__receivedAt, new Date());
    }

    /**
     * The chart's bin summary, in the shape the full control returns.
     *
     * Through the engine's `binStatistics`, so the color on a bar is the color
     * the render path paints for that code - its `color` field - and the chart
     * needs no palette of its own.
     * @returns The counts, never `null`.
     */
    public readBinStatistics(): BinStatistics {
        const grid = this.__chartGrid;
        if (grid === null) { return { totalCells: 0, nullCount: 0, bins: [] }; }
        return binStatistics(grid, null, this.__readColors(), null, null,
            this.__chartCategorical, null);
    }

    /**
     * The categories this chart is drawing.
     *
     * Public so a view action can read what is on screen, and so the layout can be
     * asserted without a canvas.
     * @returns The categories, in draw order.
     */
    public readCategories(): ChartCategory[] {
        return chartCategories(this.readBinStatistics(), this.__chartSort, this.__categoryCap);
    }

    /**
     * Whether the chart is holding a map.
     *
     * The chart counts a lattice it NEVER PUSHES, so the base's default - "a scene
     * grid exists" - is false here even with a full chart on screen. Without this
     * override every chart reported `'nodata'` and the base drew the no-data image
     * underneath the bars: a picture saying *there is nothing here* behind a
     * picture of the something.
     * @returns Whether a map parsed.
     */
    protected __hasContent(): boolean {
        return this.__chartGrid !== null;
    }

    /**
     * The concrete's scene hook.
     *
     * Nearly empty, and it stays that way: a chart never pushes a grid. What it
     * does here is the statistics read, not a lattice - the base's
     * `__sceneGrid` is the map's business and a chart that pushed one would draw a
     * wafer underneath its own bars.
     * @returns Nothing.
     */
    protected __syncScene(): void {
        /*
         * NO `__updateGrid`. A chart holds a model and counts it; pushing it would
         * make the base draw a wafer underneath the bars. That is the one thing
         * this control must not inherit the use of, and it is asserted on the
         * source as well as at runtime.
         */
        this.__chartGrid = this.__buildGrid();
        /*
         * The SAME fallback the map computes, from the same function, so the two
         * cannot issue different colors for the same code. The chart binds no
         * `StatusColorMapping` and no quality aliases, which is why both arguments
         * are `null` - it has no attribute for either.
         */
        const grid = this.__chartGrid;
        if (grid === null) {
            this.__chartCategorical = null;
        } else {
            const fallback = categoricalBinFallback(grid.binTable, null, null);
            this.__chartCategorical = fallback.requested > 0 ? fallback.colors : null;
        }
        this.__requestRender();
    }

    /**
     * The bound map as a `GridModel`, or `null`.
     *
     * The same normalizer, builder and placement the map uses - an invented
     * placement would be a second one, free to differ. A chart never draws the lattice, but
     * `binStatistics` walks it and a model built differently would count
     * differently.
     * @returns The model, or `null` when nothing parses.
     */
    protected __buildGrid(): GridModel | null {
        const gd = this.__gridData;
        this.__substrateId = null;
        /*
         * THE E142 INPUTS ARE READ. Same defect and same fix as the
         * tile: this control declared `E142MapData` and `E142MapDataJson`, stored
         * them and never looked at them, so a chart bound to an E142 document
         * counted nothing.
         *
         * A chart needs less than a tile - it counts bins and draws no wafer - so it
         * takes the payload and the bin definitions and nothing else. Everything
         * after the parse is the GridData path already below, so the two inputs
         * cannot produce different counts.
         */
        if (gd === null) {
            /* Annotated rather than inferred: `= null` alone relies on the evolving
             * implicit `any`, which only narrows while `noImplicitAny` is on. */
            let doc: E142Document | null = null;
            try {
                if (this.__e142MapData !== null) { doc = parseE142Xml(this.__e142MapData).doc; }
                else if (this.__e142MapDataJson !== null) {
                    doc = parseE142Json(this.__e142MapDataJson).doc;
                }
            } catch (e) { this.__reportUnreadable(e); return null; }
            if (doc === null) { return null; }
            const picked = selectMapAndOverlay(doc, {
                substrateId: null, layoutSpecifier: null, overlayName: null, overlayVersion: null,
            });
            const header = picked.header;
            const overlay = picked.overlay;
            if (picked.error !== null || header === null || overlay?.payload === undefined) {
                this.__reportUnreadable(
                    picked.error ?? 'no renderable BinCodeMap overlay in the E142 document');
                return null;
            }
            const resolved = resolveLayoutSpecifier(doc, header.layoutSpecifier);
            if (resolved instanceof E142Error) { this.__reportUnreadable(resolved); return null; }
            const layout = resolved !== null ? resolved : dimsFromPayload(overlay.payload);
            this.__substrateId = header.substrateId ?? null;
            try {
                const placed = computeGridPlacement(header, layout, 0, undefined, false);
                return buildGridModel(placed.placement, overlay.payload,
                    overlay.binDefinitions ? overlay.binDefinitions.map(toEngineBinDefinition) : null);
            } catch (e) { this.__reportUnreadable(e); return null; }
        }
        try {
            const n = normalizeGridData(gd);
            this.__substrateId = n.identity.substrateId ?? null;
            const placed = computeGridPlacement(n.header, n.resolvedLayout, 0, undefined, false);
            return buildGridModel(placed.placement, n.payload,
                n.binDefs ? n.binDefs.map(toEngineBinDefinition) : null);
        } catch (e) {
            const message = 'SUBSTRATEMAP_CHART_MAP_UNREADABLE: '
                + String(e instanceof Error ? e.message : e);
            if (this.__mapErrorWarned !== message) {
                this.__mapErrorWarned = message;
                TcHmi.Log.warn(message);
            }
            return null;
        }
    }

    /**
     * The text to draw for a category code.
     *
     * A bin code is the document's own - `P`, `F`, `0042` - and is NOT localized:
     * it is data, and translating it would make the chart disagree with the map
     * beside it. Only the remainder bucket is a word this package chose, so only
     * that one goes through the dictionary.
     * @param code A category code.
     * @returns The text.
     */
    protected __categoryLabel(code: string): string {
        return code === CHART_OTHER_LABEL ? this.__localization.getText(CHART_OTHER_LABEL) : code;
    }

    /**
     * Records a map this chart could not read, logged once per distinct message.
     * @param e The error or message.
     * @returns Nothing.
     */
    protected __reportUnreadable(e: unknown): void {
        const message = 'SUBSTRATEMAP_CHART_MAP_UNREADABLE: '
            + String(e instanceof Error ? e.message : e);
        if (this.__mapErrorWarned !== message) {
            this.__mapErrorWarned = message;
            TcHmi.Log.warn(message);
        }
    }

    /**
     * Draws the chart over the base's frame.
     *
     * `Bars` and `Share` are two branches of this method rather than two
     * siblings - the two differ in geometry and in nothing else.
     * @param ctx    The canvas context.
     * @param width  Drawing area width in CSS pixels.
     * @param height Drawing area height in CSS pixels.
     * @param colors The resolved theme colors.
     * @returns Nothing.
     */
    protected __drawOverlay(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors): void {
        if (this.__chartGrid === null) { return; }
        this.__drawHeader(ctx, width, colors);
        const categories = this.readCategories();
        if (categories.length === 0) {
            /*
             * ---- A MAP OF ONLY NULL CELLS IS NOT "NO DATA" ----
             *
             * Something was bound and it parsed; every cell simply carries the null
             * bin. An empty coordinate system would say "zero failures", which is a
             * claim nobody made - and falling back to the no-data image would say
             * "nothing was bound", which is false and hides an operator's real
             * problem: a map arrived and it is empty.
             *
             * So the chart says what it found. The COUNT is the point: `1600 cells,
             * none carries a bin` is a different sentence from `no map bound`, and
             * an operator can act on the first.
             */
            this.__drawNoBins(ctx, width, height, colors);
            return;
        }
        if (this.__chartStyle === 'Bars') {
            this.__drawBars(ctx, width, height, colors, categories);
        } else {
            this.__drawShare(ctx, width, height, colors, categories);
        }
    }

    /**
     * The same categories as proportions of a circle.
     *
     * ---- CLOCKWISE FROM TWELVE, IN THE SAME ORDER AS THE BARS ----
     *
     * Canvas `arc` measures from three o'clock, so the sweep starts at `-PI/2`.
     * Clockwise because that is how a person reads a dial, and in the SAME order
     * the bars use so that switching `ChartStyle` re-draws one picture rather than
     * presenting a second, differently-arranged one.
     *
     * A sliver's label goes in the legend, not in the segment - below one percent
     * a segment is a few pixels of arc and a label drawn in it overlaps its
     * neighbors and points at nothing. The GEOMETRY is unchanged: the segment is
     * still drawn at its true size, however small.
     * @param ctx        The canvas context.
     * @param width      Drawing area width. @param height Drawing area height.
     * @param colors     The resolved theme colors.
     * @param categories What to draw.
     * @returns Nothing.
     */
    protected __drawShare(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors, categories: readonly ChartCategory[]): void {
        const shares = chartShares(categories);
        if (shares.length === 0) { return; }
        const legendWidth = Math.min(CHART_LEGEND_WIDTH, width * 0.45);
        const plotWidth = width - legendWidth - 2 * CHART_PAD;
        /*
         * BELOW THE HEADER. `CHART_HEADER` exists to reserve the band
         * `__drawHeader` writes into, and until now only `__drawBars` added it: this
         * style centered the pie on `height / 2` and started the legend at
         * `CHART_PAD`, both computed as though the header were not there. On a short
         * chart the first legend row landed underneath the age text - reported from
         * a live view, where `received 15:40:47 GMT+2` sat on top of `P 80.8 %`.
         *
         * One constant, two styles, and only one of them read it. Both now measure
         * from the same `plotTop`, so the header cannot be overdrawn by either.
         */
        const plotTop = CHART_PAD + CHART_HEADER;
        const plotHeight = height - plotTop - CHART_PAD;
        const radius = Math.max(1,
            Math.min(plotWidth, plotHeight) / 2 - CHART_PAD);
        const cx = CHART_PAD + plotWidth / 2;
        const cy = plotTop + plotHeight / 2;

        ctx.save();
        let angle = -Math.PI / 2;
        for (const sh of shares) {
            const sweep = (sh.percent / 100) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, radius, angle, angle + sweep);
            ctx.closePath();
            ctx.fillStyle = sh.color;
            ctx.fill();
            /*
             * AN OUTLINE PER WEDGE, in the background color.
             *
             * Two adjacent categories can be close in the categorical palette, and
             * two flat fills meeting with no edge read as one wedge. The separator
             * is the BACKGROUND rather than a border color, so it looks like the
             * wedges are cut apart rather than framed - a dark line round every
             * segment turns a pie into a stained-glass window and competes with the
             * data for attention.
             */
            ctx.lineWidth = CHART_WEDGE_EDGE;
            ctx.strokeStyle = colors.bg !== '' && colors.bg !== 'transparent'
                ? colors.bg : colors.body;
            ctx.stroke();
            angle += sweep;
        }

        /*
         * ---- NO PERCENTAGES INSIDE THE WEDGES ----
         *
         * Not even in a segment wide enough to hold one. At 200 px a
         * 12 % segment is wide enough by arithmetic and not by eye: eight of them
         * put eight numbers in a circle 120 px across and they collide.
         *
         * The legend carries every figure already, for every category, so the
         * in-wedge copy would be a second rendering of the same fact in the place
         * where there is least room for it. `sh.inSegment` stays because the rule
         * that a sliver is not labeled in its own segment still holds -
         * nothing is - and because the legend's completeness is what makes dropping
         * these safe.
         */

        /*
         * THE LEGEND, always, for every category. A legend that listed only the
         * slivers would make an operator look in two places for one thing, and the
         * swatch is what ties a color to a code when the segment is too small to
         * carry a label.
         */
        ctx.textAlign = 'left';
        const x = width - legendWidth + CHART_PAD;
        const step = Math.min(CHART_LEGEND_STEP,
            (height - plotTop - CHART_PAD) / Math.max(1, shares.length));
        let y = plotTop + step / 2;
        for (const sh of shares) {
            ctx.fillStyle = sh.color;
            ctx.fillRect(x, y - CHART_SWATCH / 2, CHART_SWATCH, CHART_SWATCH);
            ctx.fillStyle = colors.labelColor;
            ctx.fillText(`${this.__categoryLabel(sh.code)}  ${sh.percent.toFixed(1)} %`,
                x + CHART_SWATCH + CHART_NUMBER_GAP, y);
            y += step;
        }
        ctx.restore();
    }

    /**
     * The substrate id on the left, the age on the right, across the top.
     *
     * ---- WHICH WAFER, AND HOW OLD ----
     *
     * A chart beside a map is unambiguous; a chart on its own is not, and a chart
     * in a screenshot pasted into an email is a set of numbers about an unnamed
     * wafer at an unknown time. Both facts are cheap to carry and neither can be
     * recovered afterwards.
     *
     * Unconditional, like the tile's age and for the same reason: the
     * failure this prevents is silent, so an attribute to switch it off would only
     * ever be used by someone who did not know what they were switching off.
     * @param ctx    The canvas context.
     * @param width  Drawing area width. @param colors The theme colors.
     * @returns Nothing.
     */
    protected __drawHeader(ctx: CanvasRenderingContext2D, width: number,
        colors: SubstrateMapColors): void {
        ctx.save();
        ctx.font = colors.labelFont;
        ctx.textBaseline = 'top';
        ctx.fillStyle = colors.labelColor;
        /*
         * THE TWO HALVES OF THE HEADER ARE MEASURED AGAINST EACH OTHER.
         *
         * The identity is drawn from the left and the age from the right, and
         * nothing checked that they fit. A short id leaves a gap; `W-SORT 256x256`
         * on a 250-wide chart runs straight through the timestamp and the reader
         * gets `W-SORT  256x25ceived 14:05:26 GMT+2`. Reported from a live view.
         *
         * The AGE IS NEVER TRUNCATED and the identity is. A clipped timestamp is
         * unreadable - half a clock time is not a time - while a clipped identity
         * still identifies: an operator with two lots on screen tells `W-SORT 2…`
         * from `W-FIELD` without difficulty, and the full value is in the tooltip
         * and the attribute.
         *
         * An earlier fix corrected the VERTICAL collision between this header and the legend
         * below it. This is the horizontal one between its own two halves - a
         * different pair, and the reason the first fix did not find it.
         */
        const age = this.readAge().text;
        const ageWidth = ctx.measureText(age).width;
        const id = this.__substrateId;
        if (id !== null && id !== '') {
            ctx.textAlign = 'left';
            /* one space of clearance, so the two never touch even at the limit */
            const room = width - 2 * CHART_PAD - ageWidth - ctx.measureText('  ').width;
            ctx.fillText(this.__fitText(ctx, id, room), CHART_PAD, CHART_PAD - 4);
        }
        ctx.textAlign = 'right';
        ctx.fillText(age, width - CHART_PAD, CHART_PAD - 4);
        ctx.restore();
    }

    /**
     * Shortens text with an ellipsis until it fits, or returns nothing at all.
     *
     * An ellipsis on its own tells the reader there was a value and they cannot
     * see it, which is worth the two pixels. Below that there is no room for even
     * that, and drawing anything would overlap.
     * @param ctx  The canvas context, with the font already set.
     * @param text The text to fit.
     * @param room The width available, in the same units as `measureText`.
     * @returns The text, a truncation of it, or an empty string.
     */
    protected __fitText(ctx: CanvasRenderingContext2D, text: string, room: number): string {
        if (room <= 0) { return ''; }
        if (ctx.measureText(text).width <= room) { return text; }
        for (let n = text.length - 1; n > 0; n--) {
            const cut = `${text.slice(0, n)}\u2026`;
            if (ctx.measureText(cut).width <= room) { return cut; }
        }
        return ctx.measureText('\u2026').width <= room ? '\u2026' : '';
    }

    /**
     * Says that a map arrived and holds nothing to count.
     *
     * Centered, in the label font, over an otherwise empty plot. No axis is drawn:
     * an empty coordinate system is a picture of a measurement, and there was no
     * measurement.
     * @param ctx    The canvas context.
     * @param width  Drawing area width. @param height Drawing area height.
     * @param colors The resolved theme colors.
     * @returns Nothing.
     */
    protected __drawNoBins(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors): void {
        const stats = this.readBinStatistics();
        ctx.save();
        ctx.font = colors.labelFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = colors.labelColor;
        ctx.fillText(this.readNoBinsText(), width / 2, height / 2);
        void stats;
        ctx.restore();
    }

    /**
     * The line drawn when a map parsed and holds nothing to count.
     *
     * Public and separate from the drawing so it can be asserted without a canvas,
     * and so a view action can show the same sentence somewhere else.
     * @returns The line.
     */
    public readNoBinsText(): string {
        const stats = this.readBinStatistics();
        return `${stats.totalCells} cells, none carries a bin`;
    }

    /**
     * One bar per category, with the absolute number above it.
     *
     * ---- LINEAR, FROM ZERO ----
     *
     * No truncated origin. With yield data the DISTANCE TO ZERO is the
     * information: a chart whose axis starts at 940 makes a 4 % loss look like a
     * catastrophe and a 0.4 % loss look identical to it. The scale is the largest
     * count, so the tallest bar fills the plot and every other bar is read
     * against it.
     * @param ctx        The canvas context.
     * @param width      Drawing area width. @param height Drawing area height.
     * @param colors     The resolved theme colors.
     * @param categories What to draw.
     * @returns Nothing.
     */
    protected __drawBars(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors, categories: readonly ChartCategory[]): void {
        const max = categories.reduce((m, c) => Math.max(m, c.count), 0);
        if (max <= 0) { return; }
        // The header owns the top band, so the plot starts below it.
        const plotTop = CHART_PAD + CHART_HEADER + CHART_LABEL_BAND;
        const plotBottom = height - CHART_PAD - CHART_LABEL_BAND;
        const plotHeight = plotBottom - plotTop;
        if (plotHeight <= 0) { return; }
        const slot = (width - 2 * CHART_PAD) / categories.length;

        ctx.save();
        ctx.font = colors.labelFont;
        ctx.textAlign = 'center';
        for (let i = 0; i < categories.length; i++) {
            const c = categories[i];
            const x = CHART_PAD + i * slot;
            const w = Math.max(1, slot - CHART_BAR_GAP);
            const h = (c.count / max) * plotHeight;
            ctx.fillStyle = c.color;
            ctx.fillRect(x + CHART_BAR_GAP / 2, plotBottom - h, w, h);

            ctx.fillStyle = colors.labelColor;
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(String(c.count), x + slot / 2, plotBottom - h - CHART_NUMBER_GAP);
            ctx.textBaseline = 'top';
            ctx.fillText(this.__categoryLabel(c.code), x + slot / 2, plotBottom + CHART_NUMBER_GAP);
        }
        // The zero line, drawn last so a bar cannot sit on top of it. It is the
        // baseline every bar is measured from and the axis has no other marks.
        ctx.strokeStyle = colors.edge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(CHART_PAD, plotBottom + 0.5);
        ctx.lineTo(width - CHART_PAD, plotBottom + 0.5);
        ctx.stroke();
        ctx.restore();
    }

    /**
     * The chart's identity line.
     *
     * Empty, and likely to stay so. A chart sits beside a map that already names
     * the substrate, and `''` HIDES the identity area rather than reserving an
     * empty strip - the base's own contract. A second label naming the same wafer
     * would be noise.
     * @returns The identity text.
     */
    protected __composeIdentity(): string {
        return '';
    }

    /**
     * Raises the chart's selection event.
     *
     * Silent, and NOT the same as unimplemented. The base's pointer path calls
     * this when a selection lands; a chart declares no events, so raising one
     * would announce a name the engineering tool has never heard of. A bar that
     * becomes clickable needs its event declared first.
     * @param payload The selection payload.
     */
    protected __raiseSelected(payload: SelectedPayload): void {
        void payload;
    }
}

/*
 * Registration. No cast: this class is concrete and placeable.
 */
TcHmi.Controls.registerEx(
    'SubstrateMapBinChart',
    'TcHmi.Controls.CNM_UIControls.SEMI',
    SubstrateMapBinChart,
    { injectInGlobalObject: true }
);

/* ------------------------------------------------------------------------ *
 * Global namespace types (classic consumers), the same compatibility block the
 * other controls carry: the runtime binding comes from
 * registerEx({ injectInGlobalObject: true }) and this only teaches the classic
 * type system about it.
 * ------------------------------------------------------------------------ */

declare const _SubstrateMapBinChartAlias: typeof SubstrateMapBinChart;
type _SubstrateMapBinChartInstance = SubstrateMapBinChart;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI {
        /** Global alias of the module export {@link SubstrateMapBinChart}. */
        let SubstrateMapBinChart: typeof _SubstrateMapBinChartAlias;
        /** Instance type of the global alias. */
        type SubstrateMapBinChart = _SubstrateMapBinChartInstance;
    }
}
