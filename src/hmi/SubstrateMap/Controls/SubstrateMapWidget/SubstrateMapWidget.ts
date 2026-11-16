/*
 * SubstrateMapWidget - a dashboard tile showing one substrate map.
 *
 * ---- IT EXTENDS THE BASE, IT DOES NOT WRAP THE MAP ----
 *
 * A tile is a map with a smaller attribute surface and a different idea of what
 * to do when there is nothing to show. It is not a container holding one.
 *
 * Wrapping `SubstrateMap` would mean forwarding every attribute it has, and
 * keeping the two lists in step forever - and the first attribute anyone forgot
 * would be silently missing rather than a compile error. Extending
 * `SubstrateMapBase` gives the canvas, the device-pixel sizing, the theme read,
 * the `ResizeObserver`, the engine, the scene API, the empty state, the demo
 * marking and the no-data image, and costs nothing that a tile does not use.
 *
 * ---- THE ATTRIBUTE SURFACE, AND WHAT IS NOT ON IT ----
 *
 * Three map inputs and four tile flags, plus `MapTimestamp` and the read-only
 * `E142LastError`. Every name is a contract an author binds to, and that is
 * **hard to reverse**: adding an attribute later is easy, removing one is not.
 *
 * The three inputs are `SubstrateMap`'s own, copied in type, schema and meaning,
 * because a tile and a map bound to one symbol must agree about what it carries.
 * `E142TransferData` is left out: a transfer map is a multi-substrate document
 * and a tile shows one substrate, so binding it would raise the question of
 * which - and the answer would be another attribute.
 *
 * ---- ABSENT ON PURPOSE ----
 *
 * No rotation, no origin marker, no overlay selection, no selection mode. A tile
 * that needs those wants the full control, and every attribute here is one an
 * author has to read past.
 *
 * No `ShowDemoItems` either, and that one is a JUDGEMENT rather than an
 * omission. `buildDemo` lives in the base so every control could reach it, and
 * this control cannot: `__syncScene` never sets the demo flag, so
 * a tile with nothing bound always answers `'nodata'` and draws the no-data
 * image. That is defensible - a dashboard tile explaining itself is better than
 * one showing a plausible sample - and it is the CONSERVATIVE choice, because
 * adding an attribute later is easy and removing one is not.
 *
 * ---- IT STILL DRAWS SOMETHING ----
 *
 * With nothing bound the base draws the no-data image. A tile showing a blank
 * rectangle is exactly the failure that image exists to prevent, so
 * the empty state is inherited rather than reinvented, and needs no attribute
 * here.
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
    SubstrateMapBase, formatAge, isStale, parseMapTimestamp, type AgeText, type SelectedPayload,
} from '../SubstrateMapBase/SubstrateMapBase.js';
import { type GridData, normalizeGridData } from '../../Helpers/SubstrateMapEngine/E142Grid.js';
import {
    binStatistics, buildGridModel, type BinStatistics, type GridModel, type MapMatrices,
    type SubstrateMapColors,
} from '../../Helpers/SubstrateMapEngine/Engine.js';
import {
    computeGridPlacement, selectMapAndOverlay, resolveLayoutSpecifier, dimsFromPayload, E142Error,
    type E142Document,
} from '../../Helpers/SubstrateMapEngine/E142.js';
import { parseE142Xml } from '../../Helpers/SubstrateMapEngine/E142Xml.js';
import { parseE142Json } from '../../Helpers/SubstrateMapEngine/E142Json.js';

/**
 * How many characters of a substrate id fit a tile.
 *
 * Measured, not guessed: the default label font is 14 px and its average glyph
 * is close to 7 px wide, so a 200 px tile with 8 px of padding either side holds
 * about 26. `MaterialIdType` permits 32, so an id at the limit loses six
 * characters from its middle and keeps both ends.
 *
 * A character budget rather than a measured width because the identity is an
 * HTML label with no canvas context to measure against - see `__composeIdentity`.
 */
const TILE_ID_CHARS = 26;

/** Padding between the yield line and the tile's edge, in CSS pixels. */
const TILE_YIELD_PAD = 6;

/** Border width of the stale marking, in CSS pixels. */
const TILE_STALE_BORDER = 3;

/** Dash pattern of the stale marking, in CSS pixels. */
const TILE_STALE_DASH: readonly number[] = [6, 4];

/*
 * The E142 -> engine bin-definition rename, from the MAP rather than copied. It
 * is a pure field rename and a second copy is a second place for the names to
 * drift; the engine deliberately leaves this mapping to the layer that owns the
 * render types, which is a control.
 */
import { toEngineBinDefinition } from '../SubstrateMap/SubstrateMap.js';

/**
 * Shortens a substrate id to fit, with an ellipsis in the MIDDLE.
 *
 * ---- MIDDLE, NOT END ----
 *
 * `MaterialIdType` permits 32 characters and a tile is narrow, so something has
 * to go. What must not go is either END: a substrate id is a lot prefix followed
 * by a serial, and both halves identify. Truncating the tail leaves twenty
 * wafers from one lot looking identical; truncating the head loses the lot.
 * Taking it out of the middle keeps the two things a person reads.
 *
 * `…` is one character and one glyph, so the budget arithmetic is exact - unlike
 * three dots, which are three characters that look like one.
 * @param id      The full id.
 * @param maxChars The budget, in characters.
 * @returns The id, elided if it had to be.
 */
export function elideId(id: string, maxChars: number): string {
    if (maxChars <= 0) { return ''; }
    if (id.length <= maxChars) { return id; }
    if (maxChars === 1) { return '…'; }
    // The head gets the odd character: a lot prefix is usually the longer half
    // and the more distinctive one.
    const head = Math.ceil((maxChars - 1) / 2);
    const tail = maxChars - 1 - head;
    return id.slice(0, head) + '…' + (tail > 0 ? id.slice(id.length - tail) : '');
}

/** What {@link formatYield} produces. */
export interface YieldText {
    /** The line to draw, or `null` when there is nothing to say. */
    readonly text: string | null;
    /** The fraction, or `null`. Exposed so a caller can color by it. */
    readonly fraction: number | null;
}

/**
 * The yield line: good devices, absolute and percent.
 *
 * ---- ZERO IS A READING; ABSENT IS NOT ----
 *
 * `GoodDevices = 0` is legal and it is the most important number a wafer can
 * carry. It renders as `0 (0.0 %)`. `GoodDevices` absent renders as NOTHING -
 * not `0`, not `—`, not `n/a`. A tile that showed `0` for a map that never
 * declared a count would be reporting a total loss that nobody measured, which
 * is the same failure as an unprocessed band reading as a defect: an
 * absence of measurement presented as a measurement.
 *
 * ---- THE DENOMINATOR IS THE NON-NULL CELL COUNT ----
 *
 * The same population the bucket pass paints, so the percentage on the tile and
 * the picture under it are about the same wafer. A die in progress carries its
 * own bin code and is therefore counted; only a NULL cell - no die placed, or
 * outside the substrate - is left out.
 * @param goodDevices The declared count, or `null`.
 * @param nonNullCells The denominator.
 * @returns The line and the fraction.
 */
export function formatYield(goodDevices: number | null, nonNullCells: number): YieldText {
    if (goodDevices === null || !Number.isFinite(goodDevices)) {
        return { text: null, fraction: null };
    }
    if (nonNullCells <= 0) {
        // A count with nothing to divide by. The count is still a fact and is
        // shown; inventing a percentage from a zero denominator would not be.
        return { text: String(goodDevices), fraction: null };
    }
    const fraction = goodDevices / nonNullCells;
    return { text: `${goodDevices} (${(fraction * 100).toFixed(1)} %)`, fraction };
}

/**
 * A dashboard tile showing one substrate map.
 *
 * Concrete and placeable, so `registerEx` needs no cast - unlike
 * `SubstrateMapBase`, whose abstractness forces one at its own call site.
 */
export class SubstrateMapWidget extends SubstrateMapBase {
    /**
     * @param element   The control's element.
     * @param pcElement The parent container element.
     * @param attrs     The attribute list from the markup.
     */
    public constructor(element: JQuery, pcElement: JQuery, attrs: TcHmi.Controls.ControlAttributeList) {
        super(element, pcElement, attrs);
    }

    /**
     * The stale marking's color from the theme, or `null` when unthemed.
     *
     * Read per frame rather than cached, like every other color the base reads:
     * a theme can change at runtime and a cached color would outlive it.
     * @returns The CSS color, or `null`.
     */
    protected __readStaleColor(): string | null {
        const el = this.__element as unknown as { 0?: Element } | undefined;
        if (el === undefined || el[0] === undefined) { return null; }
        const v = window.getComputedStyle(el[0])
            .getPropertyValue('--substratemap-tile-stale-color').trim();
        return v !== '' ? v : null;
    }

    /** The tile's own click handler, kept so `__detach` can remove exactly it. */
    protected __tileClick: ((ev: Event) => void) | null = null;

    /**
     * Installs the tile's click target.
     *
     * ---- THE TILE IS ONE TARGET, SO IT LISTENS FOR ITSELF ----
     *
     * The base's pointer path hit-tests items and cells and RETURNS ON A MISS. A
     * tile has neither, so that path never reaches a raise. Leaning on it to fall
     * through would be an accident rather than a design, and it would break the
     * moment the base gained a fallback.
     *
     * On the ROOT, not the canvas: the identity label and the yield line are part
     * of the tile, and a click on the substrate id that did nothing would be the
     * kind of dead spot nobody can explain.
     * @returns Nothing.
     */
    public __attach(): void {
        super.__attach();
        const root = this.__elementTemplateRoot;
        if (root !== null && this.__tileClick === null) {
            this.__tileClick = (): void => { this.__raiseSubstrateSelected(); };
            root.addEventListener('click', this.__tileClick);
        }
    }

    /**
     * Removes the click target.
     *
     * The reference is cleared whether or not the root survived, so a re-attach
     * installs one handler rather than finding a stale reference and installing
     * none - the same accumulation the `ResizeObserver` has to avoid.
     * @returns Nothing.
     */
    public __detach(): void {
        const root = this.__elementTemplateRoot;
        if (root !== null && this.__tileClick !== null) {
            root.removeEventListener('click', this.__tileClick);
        }
        this.__tileClick = null;
        super.__detach();
    }

    /**
     * The tile's bin summary, in the shape the full control returns.
     *
     * Through the engine's `binStatistics`, not a count of its own: a handler that
     * already knows how to read one of these does not learn a second format, and
     * the numbers cannot drift from the map's.
     *
     * The tile binds no color mapping, severity priority, aliases, categorical
     * fallback or highlight, so those are `null` - it has no attribute for any of
     * them, which is why a tile is small.
     * @returns The counts, never `null`.
     */
    public readBinStatistics(): BinStatistics {
        const grid = this.__sceneGrid;
        if (grid === null) { return { totalCells: 0, nullCount: 0, bins: [] }; }
        return binStatistics(grid, null, this.__readColors(), null, null, null, null);
    }

    /**
     * Raises `onSubstrateSelected` for the substrate this tile is showing.
     *
     * ---- A TILE SHOWING NOTHING RAISES NOTHING ----
     *
     * Without a map there is no substrate to select. An event carrying nulls would
     * make every handler check what the control already knows, and a dashboard
     * that opened a full view on nothing would be a worse dead end than the one
     * this event exists to remove.
     *
     * A STALE tile DOES raise: the operator is looking at a wafer and wants to
     * open it, and `state` tells the handler what they were looking at.
     * @returns Nothing.
     */
    protected __raiseSubstrateSelected(): void {
        const state = this.readEmptyState();
        if (state !== 'data' && state !== 'stale') { return; }
        const age = this.readAge();
        TcHmi.EventProvider.raise(this.__id + '.onSubstrateSelected', {
            substrateId: this.__substrateId,
            lotId: this.__lotId,
            state,
            ageSeconds: age.seconds,
            ageSource: age.source,
            goodDevices: this.__goodDevices,
            summary: this.readBinStatistics(),
        });
    }

    /**
     * Draws the yield line over the finished frame.
     *
     * Bottom-left, in the label font, over the map. Not in the identity label:
     * that is one line at the top and the substrate id owns it, and a tile has no
     * room for a second band.
     *
     * Nothing is drawn when the map declares no count. A tile that showed `0` for
     * a map that never declared one would report a total loss nobody measured.
     * @param ctx    The canvas context.
     * @param width  Drawing area width in CSS pixels.
     * @param height Drawing area height in CSS pixels.
     * @param colors The resolved theme colors.
     * @returns Nothing.
     */
    protected __drawOverlay(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors, matrices: MapMatrices): void {
        /*
         * THE AGE IS NOT OPTIONAL. Every other readout on this tile is behind a
         * flag; this one is not, because the reason the tile exists is that nobody
         * has to look at it - and a tile that can silently show six-hour-old data
         * is worse than an empty one. An author who does not want to know how old
         * the data is has asked for the wrong control.
         */
        this.__drawAge(ctx, width, height, colors, matrices);
        if (!this.__showYield) { return; }
        const line = formatYield(this.__goodDevices, this.__nonNullCells);
        if (line.text === null) { return; }
        ctx.save();
        ctx.font = colors.labelFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        // Stroked in the background then filled, the same treatment the demo
        // marking uses: readable over whatever the map drew, without a panel
        // behind it hiding the data it is describing.
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors.bg !== '' ? colors.bg : colors.body;
        ctx.strokeText(line.text, TILE_YIELD_PAD, height - TILE_YIELD_PAD);
        ctx.fillStyle = colors.labelColor;
        ctx.fillText(line.text, TILE_YIELD_PAD, height - TILE_YIELD_PAD);
        ctx.restore();
        void width;
    }

    /**
     * Draws the age line and, past the threshold, the stale border.
     *
     * ---- A BORDER, NOT A COLOR CHANGE ----
     *
     * Every color on this tile is DATA: a bin, a severity, a density. Tinting
     * the map to say "old" would put a non-data meaning into the one channel the
     * whole control has taught an operator to read as data - and at a glance a
     * yellowed wafer reads as a yield problem, not a freshness one.
     *
     * A dashed border is outside the map entirely. It costs no aggregate pixel,
     * which the tests assert by comparing frames.
     * @param ctx    The canvas context.
     * @param width  Drawing area width in CSS pixels.
     * @param height Drawing area height in CSS pixels.
     * @param colors The resolved theme colors.
     * @returns Nothing.
     */
    protected __drawAge(ctx: CanvasRenderingContext2D, width: number, height: number,
        colors: SubstrateMapColors, matrices: MapMatrices): void {
        const age = this.readAge();
        /*
         * THE OVERLAY SETS ITS OWN COORDINATE SPACE, HERE, NOT AT THE CALL SITE.
         *
         * `width` and `height` are CSS pixels and every coordinate below is a CSS
         * pixel, but the context arrives with whatever transform the draw left on
         * it - measured from a running control at ratio 3.125, that is IDENTITY.
         * A 179-unit border then covers 179 DEVICE pixels, which is 57 CSS pixels,
         * 27 % of a 210-wide tile; at 1.25 it is 68 %. Both match the reported
         * pictures exactly, and the age text shrinks by the same factor.
         *
         * A previous attempt set the transform at the call site in the base. That is
         * the tidier place and it did not hold: whatever this method receives is
         * what it must correct, so it corrects it itself. `save`/`restore` around
         * each block means the caller gets its context back unchanged.
         */
        ctx.save();
        ctx.setTransform(matrices.dprBase, 0, 0, matrices.dprBase, 0, 0);
        ctx.font = colors.labelFont;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'alphabetic';
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors.bg !== '' ? colors.bg : colors.body;
        ctx.strokeText(age.text, width - TILE_YIELD_PAD, height - TILE_YIELD_PAD);
        ctx.fillStyle = colors.labelColor;
        ctx.fillText(age.text, width - TILE_YIELD_PAD, height - TILE_YIELD_PAD);
        ctx.restore();

        if (!isStale(age.seconds, this.__staleAfterSeconds)) { return; }
        ctx.save();
        ctx.setTransform(matrices.dprBase, 0, 0, matrices.dprBase, 0, 0);
        // Inset by half the width so the stroke lands inside the tile rather than
        // straddling its edge, where a container would clip half of it away.
        const half = TILE_STALE_BORDER / 2;
        ctx.lineWidth = TILE_STALE_BORDER;
        ctx.setLineDash([...TILE_STALE_DASH]);
        /*
         * ITS OWN VARIABLE, not `colors.edge`. The marking is a STATUS
         * signal - the data has stopped arriving, a fact about the feed rather than
         * about the wafer - and sharing the outline's color meant re-theming the
         * wafer silently re-themed the warning. Someone choosing a subtle edge for a
         * dense map would have made the warning disappear.
         *
         * Falls back to `colors.edge` when no theme is loaded, which is the base's
         * own rule for every other read: a control renders before a stylesheet
         * arrives, and the fallback is what it renders with.
         */
        ctx.strokeStyle = this.__readStaleColor() ?? colors.edge;
        /*
         * AROUND THE MAP, NOT AROUND THE CANVAS.
         *
         * This framed the whole drawing area, and the map is letterboxed inside it:
         * on a 300 x 150 tile the wafer sits at x 83..217 while the border ran from
         * 1.5 to 298.5, so the warning was **82 px away from the thing it warns
         * about** and read as chrome. Reported from a live view as stray dashes
         * rather than a frame.
         *
         * `__mapRect` is the same rectangle `__groupTiling` uses, in CSS pixels
         * because this overlay draws in CSS pixels. It is grown by the stroke width
         * so the dashes sit just OUTSIDE the substrate outline rather than on it -
         * a warning drawn on top of the edge it is warning about is a warning that
         * looks like a rendering fault.
         *
         * When there is nothing placed - no map, so no rectangle - the tile frame is
         * the honest fallback: the feed is stale and there is no wafer to point at.
         */
        const rect = this.__mapRect(matrices, 1);
        if (rect === null) {
            ctx.strokeRect(half, half, width - TILE_STALE_BORDER, height - TILE_STALE_BORDER);
        } else {
            const g = TILE_STALE_BORDER;
            ctx.strokeRect(rect.x0 - g, rect.y0 - g,
                (rect.x1 - rect.x0) + 2 * g, (rect.y1 - rect.y0) + 2 * g);
        }
        ctx.restore();
    }

    /**
     * The tile's staleness threshold, for the base's heartbeat.
     *
     * Without this the base cannot know a tile wants waking, and the stale border
     * would go on never appearing on an idle dashboard.
     * @returns The threshold in seconds, or `null`.
     */
    protected __staleAfterSecondsForTimer(): number | null {
        return this.__staleAfterSeconds;
    }

    /**
     * A tile does not select. Asserted here rather than assumed from the absence of
     * a `SelectionMode` attribute.
     *
     * The header of this file has always said "no overlay selection, no selection
     * mode", and that was true of the ATTRIBUTES and false of the behavior: the
     * base's pointer path filled `__selectedCells` with a group's members and drew a
     * ring, while `__raiseSelected` below discarded the payload. An operator saw the
     * tile respond to a click and no author could act on it.
     *
     * `'none'` turns the whole path off - no hit test, no stored selection, no ring.
     * What a click on a tile means is `onSubstrateSelected`, raised by
     * `__tileClick`, and that is the only thing it should mean.
     */
    protected override __selectionMode: 'single' | 'multi' | 'none' = 'none';

    /**
     * Whether a last known state is being shown.
     *
     * TRUE ONLY WHEN IT IS ACTUALLY THE ONE ON SCREEN. A tile with live data holds
     * a retained grid too - the live one, saved for next time - and reporting
     * `stale` then would label a fresh tile as old.
     * @returns Whether the retained state is what is drawn.
     */
    protected __hasLastKnown(): boolean {
        return this.__showingLastKnown;
    }

    /**
     * Builds the scene from whichever input is bound, and pushes it to the base.
     *
     * ---- NO NEW REDUCTION CODE, AND NO NEW RENDER CODE ----
     *
     * The tile does not aggregate, choose a reducer, or paint. It hands the base a
     * `GridModel` and the base does what it does for every control: measures the
     * saturation of the frame it drew, feeds it forward, and lets `selectReducer`
     * choose. A tile at 200 px lands on `FailFraction` because the MEASUREMENT
     * says so, not because it is a tile - and a widget-specific override would be
     * the one thing guaranteed to make it disagree with the full control.
     *
     * ---- PRECEDENCE ----
     *
     * `GridData` first, then `E142MapData`, then `E142MapDataJson`. Fixed rather
     * than "most recently written", because a dashboard rebinds on every update
     * and a precedence that depends on arrival order would flicker between two
     * bound inputs. The order is the map's own: the flat projection is the cheap
     * one and the one a tile is most likely to be given.
     *
     * All three are read (see {@link __buildGrid}). One that cannot be read
     * shows the no-data image rather than a wrong picture.
     * @returns Nothing.
     */
    protected __syncScene(): void {
        const grid = this.__buildGrid();
        if (grid !== null) {
            /*
             * RETAINED ON SUCCESS, so the thing kept is a map that actually rendered
             * rather than one that merely parsed. Its receive time is kept with it:
             * the age has to go on running from when the data arrived, not restart
             * when the feed drops.
             */
            this.__lastKnownGrid = grid;
            this.__lastKnownAt = this.__receivedAt;
            this.__lastKnownGood = this.__goodDevices;
            this.__lastKnownSubstrateId = this.__substrateId;
            this.__lastKnownLotId = this.__lotId;
            this.__lastKnownCells = grid.cells.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);
            // Cleared on a map that reads: the attribute reports the CURRENT state
            // of the feed, not the worst thing that ever happened to it.
            this.setE142LastError(null);
            this.__showingLastKnown = false;
            this.__updateGrid(grid);
        } else if (this.__lastKnownGrid !== null) {
            /*
             * PRECEDENCE LEVEL 2. The map went away - unbound, or it stopped
             * parsing - and the last one that worked stays on screen with its age
             * still running. An operator seeing a wafer and a growing age knows more
             * than one seeing an empty tile, and the age is what stops the first
             * from being a lie.
             *
             * No flash of empty canvas: the retained grid is pushed in the SAME call
             * that discovered the failure, so no frame is drawn between.
             */
            this.__showingLastKnown = true;
            this.__updateGrid(this.__lastKnownGrid);
            this.__receivedAt = this.__lastKnownAt ?? this.__receivedAt;
            this.__goodDevices = this.__lastKnownGood;
            this.__substrateId = this.__lastKnownSubstrateId;
            this.__lotId = this.__lastKnownLotId;
            this.__nonNullCells = this.__lastKnownCells;
            this.__updateIdentity();
            this.__requestRender();
            return;
        } else {
            this.__showingLastKnown = false;
            this.__updateGrid(null);
        }
        /*
         * The yield's two numbers, taken from the SAME parse that produced the
         * grid. Counting the cells here rather than in `__drawOverlay` because a
         * frame must not walk the lattice - a 1024-cell map is a million cells and
         * the tile redraws on every resize tick.
         */
        this.__nonNullCells = this.__lastKnownCells;
        /*
         * The identity area follows the data, not just the flag: a tile whose map
         * is replaced has a new substrate id, and nothing else would redraw it.
         */
        this.__updateIdentity();
        this.__requestRender();
    }

    /**
     * The bound map as a `GridModel`, or `null`.
     *
     * ---- THE PLACEMENT COMES FROM THE DATA, THROUGH THE ENGINE ----
     *
     * `computeGridPlacement` is the map's own, and using anything else is how the
     * two controls come to disagree.
     *
     * The first version of this passed a unit placement, reasoning that a tile
     * shows one substrate filling its box and has nothing for a placement to
     * express. **That was wrong, and plausibly wrong**: a placement is not about
     * FIT - the base fits the model to the box either way - it is about which way
     * is up and where the origin sits. The map's comes out
     * `originYmm: 256, rowStepYmm: -1` for this data, so the tile was drawing the
     * wafer flipped and offset. 27 885 of 33 655 pixels differed under an
     * identical matrix, and the cells and the bin table were byte-identical:
     * everything about the DATA agreed and the geometry did not.
     * @returns The model, or `null` when nothing parses.
     */
    protected __buildGrid(): GridModel | null {
        const gd = this.__gridData;
        this.__goodDevices = null;
        this.__substrateId = null;
        this.__lotId = null;
        /*
         * THE E142 INPUTS ARE READ, not merely stored. A tile whose setters kept an
         * E142 document and whose build looked only at `__gridData` would show
         * "no data" while holding one.
         *
         * The path is the map's, in engine functions rather than copied logic:
         * `parseE142Xml` / `parseE142Json` for the document, `selectMapAndOverlay`
         * for the map and overlay inside it, and `resolveLayoutSpecifier` (falling
         * back to `dimsFromPayload`) for the dimensions. From there it joins the
         * GridData path already below - the same `computeGridPlacement` and
         * `buildGridModel` - so the two inputs cannot render differently.
         *
         * What is NOT taken from the map: outline matching, overlay selection by
         * name and version, and the substrate-count publish. A tile has no outline
         * and no attributes to choose an overlay with, so it takes the document's
         * first renderable map, which is what a tile showing "the lot" means.
         */
        if (gd === null) {
            const doc = this.__readE142Doc();
            if (doc === null) { return null; }
            try {
                return this.__gridFromDoc(doc);
            } catch (e) {
                this.__reportUnreadable(e);
                return null;
            }
        }
        try {
            const n = normalizeGridData(gd);
            /*
             * DECLARED, not counted. `GoodDevices` is a header field: it is what the
             * tester reported, and recomputing it from the bin table would produce a
             * number that disagrees with the MES whenever the two disagree - which
             * is exactly when someone is looking. The tile reports what the map
             * says.
             */
            this.__goodDevices = n.identity.goodDevices ?? null;
            this.__substrateId = n.identity.substrateId ?? null;
            this.__lotId = n.identity.lotId ?? null;
            const placed = computeGridPlacement(n.header, n.resolvedLayout, 0, undefined, false);
            return buildGridModel(
                placed.placement, n.payload,
                n.binDefs ? n.binDefs.map(toEngineBinDefinition) : null,
            );
        } catch (e) {
            /*
             * Once per distinct message. A tile that cannot read its map shows the
             * no-data image, which is the right answer:
             * an empty tile that explains itself beats a broken-looking one.
             */
            const message = 'SUBSTRATEMAP_TILE_MAP_UNREADABLE: '
                + String(e instanceof Error ? e.message : e);
            /*
             * PUBLISHED, not only logged. The tile goes on showing the last map that
             * rendered, so this attribute is the only signal that the feed has gone
             * bad - a tile silently keeping an old picture with no way to know why is
             * the failure this phase exists to prevent.
             */
            this.setE142LastError(message);
            if (this.__mapErrorWarned !== message) {
                this.__mapErrorWarned = message;
                TcHmi.Log.warn(message);
            }
            return null;
        }
    }

    /**
     * Parses whichever E142 input is bound, or `null` when neither is.
     *
     * XML first, then JSON, matching the map's precedence. Both go through the same
     * parser the map uses, so a document this tile refuses is one the map refuses
     * too - and a document the map accepts renders here.
     * @returns The document, or `null`.
     */
    protected __readE142Doc(): E142Document | null {
        try {
            if (this.__e142MapData !== null) { return parseE142Xml(this.__e142MapData).doc; }
            if (this.__e142MapDataJson !== null) { return parseE142Json(this.__e142MapDataJson).doc; }
        } catch (e) {
            this.__reportUnreadable(e);
        }
        return null;
    }

    /**
     * The grid inside an E142 document, by the map's route through engine functions.
     * @param doc A parsed E142 document.
     * @returns The grid model, or `null` when the document holds no renderable map.
     */
    protected __gridFromDoc(doc: E142Document): GridModel | null {
        /*
         * NO FILTERS. The map takes a substrate id, a layout specifier and an
         * overlay name and version from its attributes; a tile has none of those, so
         * it asks for the document's first renderable map - which is what a tile
         * showing "the lot" means. The four are required by the type, so saying
         * `null` four times is how a tile says it has no opinion.
         */
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
        /*
         * The identity the tile shows. `selectMapAndOverlay` has already chosen which
         * substrate map this is, so these come from its header rather than from a
         * second search - the caption and the picture cannot disagree.
         */
        this.__substrateId = header.substrateId ?? null;
        /*
         * A lot id is NOT on the header - E142 carries it on the substrate, which
         * the map finds through `__matchSubstrate` and a tile has no outline to
         * match against. Left null rather than guessed: a caption that invents a
         * lot is worse than one that omits it.
         */
        this.__lotId = null;
        const placed = computeGridPlacement(header, layout, 0, undefined, false);
        return buildGridModel(placed.placement, overlay.payload,
            overlay.binDefinitions ? overlay.binDefinitions.map(toEngineBinDefinition) : null);
    }

    /**
     * Records a map this tile could not read: published, and logged once per message.
     * @param e The error or message.
     * @returns Nothing.
     */
    protected __reportUnreadable(e: unknown): void {
        const message = 'SUBSTRATEMAP_TILE_MAP_UNREADABLE: '
            + String(e instanceof Error ? e.message : e);
        this.setE142LastError(message);
        if (this.__mapErrorWarned !== message) {
            this.__mapErrorWarned = message;
            TcHmi.Log.warn(message);
        }
    }

    // ---------------------------------------------------------------
    //  The attribute surface. These names are the contract.
    // ---------------------------------------------------------------

    /** `GridData`, or `null`. */
    protected __gridData: GridData | null = null;
    /** `E142MapData`, the XML string, or `null`. */
    protected __e142MapData: string | null = null;
    /** `E142MapDataJson`, or `null`. */
    protected __e142MapDataJson: object | null = null;
    /** `ShowSubstrateId`. */
    protected __showSubstrateId: boolean = false;
    /** `ShowYield`. */
    protected __showYield: boolean = false;
    /** `StaleAfterSeconds`, or `null` to never mark. */
    protected __staleAfterSeconds: number | null = null;
    /** `ShowBinHistogram`. */
    protected __showBinHistogram: boolean = false;
    /** The last unreadable-map complaint, so a rebind does not repeat it. */
    protected __mapErrorWarned: string | null = null;
    /** The declared good-device count from the bound map, or `null`. */
    protected __goodDevices: number | null = null;
    /**
     * The identity of the map ON SCREEN, which is not always the one bound.
     *
     * Read from the payload while it is live and RETAINED with the last known
     * state, because a stale tile is showing a wafer and has to be able to say
     * which. Reading `__gridData` directly was wrong in two places at once: a
     * stale tile raised an event with a null substrate id - the dead end the event
     * exists to remove - and its identity label went blank while its picture
     * stayed.
     */
    protected __substrateId: string | null = null;
    /** The lot of the map on screen, retained with it for the same reason. */
    protected __lotId: string | null = null;
    /** Cells with a bin - the yield denominator and the bucket pass's population. */
    protected __nonNullCells: number = 0;
    /** `MapTimestamp` as bound, before parsing. */
    protected __mapTimestamp: string | null = null;
    /** When the current payload arrived, for the `received` clock. */
    protected __receivedAt: Date = new Date();
    /**
     * The last grid that rendered, kept after an unbind or a parse failure.
     *
     * ---- IN MEMORY ONLY ----
     *
     * A page reload loses it. That is acceptable for a dashboard tile - the point
     * of retaining is to survive a momentary gap in a feed, not a restart - and it
     * is in the README rather than quietly assumed. Persisting would mean deciding
     * how stale is too stale to restore, which is a question nobody has asked.
     *
     * The MODEL, not the pixels. Re-rendering from it goes through the same
     * pipeline as a live map, so a retained tile responds to a resize and to a
     * theme change instead of holding a stretched screenshot.
     */
    protected __lastKnownGrid: GridModel | null = null;
    /** When the retained grid was received, so its age keeps running. */
    protected __lastKnownAt: Date | null = null;
    /** `GoodDevices` that went with the retained grid. */
    protected __lastKnownGood: number | null = null;
    /** The retained grid's substrate id. */
    protected __lastKnownSubstrateId: string | null = null;
    /** The retained grid's lot id. */
    protected __lastKnownLotId: string | null = null;
    /** The retained grid's non-null cell count. */
    protected __lastKnownCells: number = 0;
    /** `E142LastError`. */
    protected __e142LastError: string | null = null;
    /**
     * Whether what is on screen is the RETAINED grid rather than a live one.
     *
     * A flag set where the decision is made, not a condition reconstructed
     * afterwards. The first version asked `__gridData === null`, which is true on
     * an unbind and FALSE on a parse failure - so a tile showing a retained wafer
     * because its feed had gone bad reported itself as `data`. The two paths that
     * reach the retained grid are different; what they have in common is this
     * assignment.
     */
    protected __showingLastKnown: boolean = false;

    /**
     * Stamps the receive clock, on any of the three inputs.
     *
     * ---- WHERE THE PAYLOAD ARRIVES, NOT WHERE THE FRAME LANDS ----
     *
     * A rebuild from a resize must not make old data look new, which is why this
     * is in the setters and not in `__render` or `readAge`.
     *
     * ---- AND ON ALL THREE, NOT JUST THE ONE THAT PARSES ----
     *
     * Stamping only where a payload parses would freeze the receive time of a tile
     * whose input cannot be read. The clock is about ARRIVAL, and a payload
     * arrives whether or not it can be read.
     *
     * Nothing here touches the bound value. The data model is the author's; the
     * control reads it and holds a reference, and the receive time lives beside
     * it rather than in it.
     * @returns Nothing.
     */
    protected __stampReceived(): void {
        this.__receivedAt = new Date();
    }

    /**
     * Sets the last map-ingestion error.
     *
     * Writable as well as readable, matching the full control: an author can clear
     * it from a view action after acknowledging one.
     * @param valueNew The message, or `null`.
     */
    public setE142LastError(valueNew: string | null): void {
        const v = TcHmi.ValueConverter.toString(valueNew);
        if (tchmi_equal(v, this.__e142LastError)) { return; }
        this.__e142LastError = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142LastError' });
    }
    /** @returns The last map-ingestion error, or `null`. */
    public getE142LastError(): string | null { return this.__e142LastError; }

    /** @param valueNew The grid, or `null`. */
    public setGridData(valueNew: GridData | null): void {
        const v = TcHmi.ValueConverter.toObject<GridData>(valueNew);
        if (tchmi_equal(v, this.__gridData)) { return; }
        this.__gridData = v;
        this.__stampReceived();
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
        this.__stampReceived();
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
        this.__stampReceived();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'E142MapDataJson' });
        this.__syncScene();
    }
    /** @returns The E142 JSON document, or `null`. */
    public getE142MapDataJson(): object | null { return this.__e142MapDataJson; }

    /** @param valueNew Whether to show the substrate id. */
    public setShowSubstrateId(valueNew: boolean | null): void {
        const v = TcHmi.ValueConverter.toBoolean(valueNew) ?? false;
        if (v === this.__showSubstrateId) { return; }
        this.__showSubstrateId = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowSubstrateId' });
        // The identity area is the base's, and it only redraws when told.
        this.__updateIdentity();
    }
    /** @returns Whether the substrate id is shown. */
    public getShowSubstrateId(): boolean { return this.__showSubstrateId; }

    /** @param valueNew Whether to show the pass fraction. */
    public setShowYield(valueNew: boolean | null): void {
        const v = TcHmi.ValueConverter.toBoolean(valueNew) ?? false;
        if (v === this.__showYield) { return; }
        this.__showYield = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName: 'ShowYield' });
        this.__requestRender();
    }
    /** @returns Whether the pass fraction is shown. */
    public getShowYield(): boolean { return this.__showYield; }

    /**
     * Sets how long a map may go without an update before the tile marks it stale.
     *
     * ---- THE NAME AND THE UNIT ARE THE CONTRACT ----
     *
     * Past the threshold the tile keeps drawing the last map that rendered, with
     * its age and the stale border. The name and the unit are what an author
     * binds, so they are the part that cannot change.
     *
     * Seconds, not milliseconds: a staleness threshold an operator sets is in the
     * units an operator thinks in, and nobody means 30000.
     * @param valueNew The threshold in seconds, or `null` to never mark.
     */
    public setStaleAfterSeconds(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const v = raw === null || !Number.isFinite(raw) || raw <= 0 ? null : raw;
        if (v === this.__staleAfterSeconds) { return; }
        this.__staleAfterSeconds = v;
        // The heartbeat's RATE derives from this value, so changing it restarts the
        // timer rather than merely changing what the next frame decides.
        this.__syncStaleTimer();
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'StaleAfterSeconds' });
        this.__requestRender();
    }
    /** @returns The threshold in seconds, or `null`. */
    public getStaleAfterSeconds(): number | null { return this.__staleAfterSeconds; }

    /**
     * Sets when the map was measured.
     *
     * See the descriptor for why this is bound rather than parsed: an E142
     * document carries no timestamp, and the `ITEMVERSION` the standard defines
     * belongs to the Stream 21 message that transports the item.
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
     * The age line the tile would draw right now.
     *
     * Public so a view action can read it, and so the age can be asserted without
     * a canvas - the same shape every decision in this package takes.
     * @returns The line, its source and its age in seconds.
     */
    public readAge(): AgeText {
        return formatAge(parseMapTimestamp(this.__mapTimestamp), this.__receivedAt, new Date());
    }

    /** @param valueNew Whether to show the bin histogram. */
    public setShowBinHistogram(valueNew: boolean | null): void {
        const v = TcHmi.ValueConverter.toBoolean(valueNew) ?? false;
        if (v === this.__showBinHistogram) { return; }
        this.__showBinHistogram = v;
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged',
            { propertyName: 'ShowBinHistogram' });
        this.__requestRender();
    }
    /** @returns Whether the bin histogram is shown. */
    public getShowBinHistogram(): boolean { return this.__showBinHistogram; }

    /**
     * The tile's identity line: the substrate id, or nothing.
     *
     * `''` HIDES the identity area rather than reserving an empty strip - the
     * base's own contract. A tile is small and a blank band across the top of it
     * is worse than no band at all, which is why `ShowSubstrateId` defaults off:
     * a dashboard usually labels its own tiles, and two labels is one too many.
     * @returns The identity text.
     */
    protected __composeIdentity(): string {
        if (!this.__showSubstrateId) { return ''; }
        // From the map ON SCREEN, not the one bound: a stale tile is showing a
        // wafer and its label has to name it.
        const id = this.__substrateId ?? '';
        /*
         * ELIDED TO A CHARACTER BUDGET, not to a measured width.
         *
         * The identity is an HTML label, not canvas text, so there is no context to
         * measure against - and CSS `text-overflow: ellipsis` would clip the TAIL,
         * which is the half that distinguishes twenty wafers from one lot. A
         * budget elides in the middle and does it the same way on every browser.
         *
         * `TILE_ID_CHARS` is what fits a 200 px tile at the default label size,
         * measured rather than guessed - see the constant.
         */
        return elideId(id, TILE_ID_CHARS);
    }

    /**
     * Raises the tile's selection event.
     *
     * ---- SILENT, ON PURPOSE ----
     *
     * The base's pointer path calls this once a selection lands, and the base
     * declares no events of its own - a concrete control owns its raise, because
     * an event has to be in ITS descriptor for a view to bind a handler to it.
     * A tile selects a whole substrate, not a die: its one event,
     * `onSubstrateSelected`, is raised by {@link __raiseSubstrateSelected}. So
     * this raises nothing, and the parameter is consumed explicitly rather than
     * left unused, so the signature is honest about receiving a payload it does
     * nothing with.
     * @param payload The selection payload.
     */
    protected __raiseSelected(payload: SelectedPayload): void {
        /*
         * The BASE's item/cell selection, which a tile does not have. It reaches
         * here only if the base ever gains a path that raises on a miss; the tile's
         * own event comes from `__raiseSubstrateSelected` and carries a substrate,
         * not a die.
         */
        void payload;
    }
}

/*
 * Registration. No cast: this class is concrete and placeable.
 */
TcHmi.Controls.registerEx(
    'SubstrateMapWidget',
    'TcHmi.Controls.CNM_UIControls.SEMI',
    SubstrateMapWidget,
    { injectInGlobalObject: true }
);

/* ------------------------------------------------------------------------ *
 * Global namespace types (classic consumers), the same compatibility block the
 * other two controls carry: the runtime binding comes from
 * registerEx({ injectInGlobalObject: true }) and this only teaches the classic
 * type system about it.
 * ------------------------------------------------------------------------ */

declare const _SubstrateMapWidgetAlias: typeof SubstrateMapWidget;
type _SubstrateMapWidgetInstance = SubstrateMapWidget;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI {
        /** Global alias of the module export {@link SubstrateMapWidget}. */
        let SubstrateMapWidget: typeof _SubstrateMapWidgetAlias;
        /** Instance type of the global alias. */
        type SubstrateMapWidget = _SubstrateMapWidgetInstance;
    }
}
