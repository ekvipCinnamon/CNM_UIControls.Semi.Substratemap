/**
 * @fileoverview
 * SubstrateMapBase - abstract, non-placeable shell control of the WaferMap
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
 *  - Concrete controls (SubstrateMap and the legacy facades) extend this base
 *    only and own the attributes, schemas, events, demo data and the mapping of
 *    their data model onto the engine's scene calls.
 *
 * S1 mechanism (frozen by spike S1): base and engine are ES modules; the base
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
import { EngineHello, makeConfig, computeScale, rotatedExtent, fitBBox, getCellAtPos, GridLayerCache, makeWorldMatrix, makeDataMatrix, drawSubstrateMap, getItemAtPos, } from '../../Helpers/SubstrateMapEngine/Engine.js';
/**
 * Maps a hit cell's LATTICE coordinates onto the `column` / `row` reported in a
 * {@link SelectedPayload}. Currently the identity - and deliberately a named
 * function anyway, because it is the ONE place that decides what those two
 * numbers mean.
 *
 * WHAT IS ASSUMED (ASSUME-A A5, confidence grade C+): a map's Row/Column
 * SERIALIZATION indices - the order cells appear in on the wire, which is what
 * this control's lattice indices are - are not necessarily the LOGICAL map
 * coordinates a `<BinCode>`'s X / Y attributes are authored in. A5 resolves that
 * by putting the conversion in the DOMAIN module at merge time: the decoding
 * caller converts logical start coordinates to serialization indices, and
 * everything downstream of the decode - this package included - works in
 * serialization indices only. This control therefore reports the lattice index
 * pair unchanged, which is correct exactly as long as A5 holds.
 *
 * WHY IT IS ONLY C+: A5 is an assumption recorded for this project, not a quoted
 * normative rule. The reference pack contains no clause that ties serialization
 * order to logical coordinates - the E142 schemas give `<BinCode>` optional X / Y
 * attributes and no Length attribute, and nothing in them states the mapping -
 * so the conversion's existence is inferred from the schema shape rather than
 * read off the standard. It is pending verification against the specification PDF
 * (F1-V, Figure A1-1a), which is not part of the reference pack.
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
function reportedCellCoords(cell) {
    return { column: cell.col, row: cell.row };
}
/**
 * Abstract shell owning the stable plumbing shared by every substrate-map
 * control: template root, identity label, canvas, devicePixelRatio bitmap
 * sizing, ResizeObserver, theme reading, pointer wiring, one engine instance and
 * a protected scene API. Concrete subclasses own attributes, events, schemas,
 * demo data and the mapping of their data model onto the engine; they fill the
 * two abstract hooks {@link __composeIdentity} and {@link __raiseSelected}.
 */
export class SubstrateMapBase extends TcHmi.Controls.System.TcHmiControl {
    /** Root element of the control template (`*-SubstrateMapBase-Template`). Set in __previnit, cleared in destroy. */
    __elementTemplateRoot = null;
    /** Identity label element, or `null` while detached. */
    __identityEl = null;
    /** Backing canvas, or `null` while detached. Created in __attach, removed and nulled in __detach. */
    __canvas = null;
    /** 2D context of {@link __canvas}. Lifetime identical to the canvas. */
    __canvasContext = null;
    /** Observer keeping the canvas bitmap in sync with its CSS size (and identity toggles). */
    __resizeObserver = null;
    /** Bound `pointerup` handler kept for later removal. */
    __onPointerUp = null;
    /** Pending requestAnimationFrame handle for coalesced rendering, or `null` when idle. */
    __rafHandle = null;
    /**
     * Engine instance owned by this control. Rendering now goes through the
     * engine MODULE's {@link drawSubstrateMap} (a pure function over the pushed
     * scene), so this S1 probe is no longer painted; the instance is retained as
     * the lifecycle-owned engine handle (created in {@link __attach}, disposed in
     * {@link __detach}) pending its consolidation into the stateful engine object.
     */
    __engine = null;
    /** Identity label placement: `'above'`, `'below'` or `'none'`. Shell state; the concrete attribute maps onto it. */
    __identityPosition = 'below';
    // ---- engine scene (pushed by the concrete via the scene API, drawn by {@link __render}) ----
    /** Current substrate outline model, or `null` (no body; items-fit fallback). */
    __sceneOutline = null;
    /** Current render-ready items (empty when none are bound). */
    __sceneItems = [];
    /** Current effective-status resolver, or `null` (everything resolves to the unknown color). */
    __sceneResolve = null;
    /** Current status -> CSS color mapping, or `null` (theme fallback only). */
    __sceneMapping = null;
    /** Current render-ready labels (empty when none are bound). */
    __sceneLabels = [];
    /** Current cell grid model, or `null` (no grid). Pushed via {@link __updateGrid}. */
    __sceneGrid = null;
    /**
     * Monotonic version of {@link __sceneGrid}'s DATA, bumped by {@link __updateGrid}.
     * It is the layer cache's data term (see {@link GridLayerCache}); a version rather
     * than object identity, so the cache survives a concrete that hands back an
     * equal-but-new model object only when it really is the same push.
     */
    __sceneGridVersion = 0;
    /**
     * Offscreen cache backing the grid layer, or `null` while detached / where
     * `OffscreenCanvas` is unavailable. Owned by the control (created in
     * {@link __attach}, disposed in {@link __detach}) rather than by the engine
     * module, because its bitmap is per-canvas and must die with the canvas.
     */
    __gridCache = null;
    /** Whether labels are drawn (mirrors the concrete's `ShowLabels`, carried in with the labels). */
    __sceneShowLabels = true;
    /** Whether the origin marker is drawn (mirrors the concrete's `ShowOriginMarker`, pushed via {@link __updateShowOriginMarker}). */
    __sceneShowOriginMarker = false;
    // ---- data-frame placement (resolved numbers pushed by the concrete via {@link __updatePlacement}) ----
    // The concrete owns the Origin attributes; it resolves them to these engine-ready
    // scalars (prefix -> millimeters, degrees -> radians) and pushes them here. The
    // engine's D2S ({@link makeDataMatrix}) never sees attribute state. The defaults
    // match the concrete's Origin attribute defaults, so the first render before any
    // push (and every default configuration) yields the identity D2S.
    /** Anchor of the data origin on the fit box (default `'center'`). */
    __placementLocation = 'center';
    /** Data-origin X offset along S +x, in millimeters (default 0). */
    __placementOffsetXmm = 0;
    /** Data-origin Y offset along S +y, in millimeters (default 0). */
    __placementOffsetYmm = 0;
    /** Data-axes rotation about the origin, radians, CCW-positive in S (default 0). */
    __placementRotationRad = 0;
    /** Data Y-axis direction; `'down'` mirrors the D y axis (default `'up'`). */
    __placementYDir = 'up';
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
    __viewRotationRad = 0;
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
    __lastInteracted = null;
    /**
     * Full current selection as render models, in selection order. Drives the
     * selection rings - every entry is marked, not just {@link __selected} - and
     * the `selection` array of the payload. Membership is by OBJECT IDENTITY: it is
     * stable while the scene is unchanged and correctly distinguishes id-less items
     * (which an id-keyed set could not); a scene rebuild clears it. ITEM selections
     * only - cells are indices, not objects, and live in {@link __selectedCells}.
     */
    __selection = [];
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
    __selectedCells = new Set();
    /**
     * Selection behavior driving {@link __handlePointerUp}: `'single'` (a hit
     * REPLACES the selection, a miss changes nothing - ComponentMap sibling parity)
     * or `'multi'` (a hit TOGGLES membership, a click on empty space CLEARS). Shell
     * state owned by the base, like {@link __identityPosition}; the concrete's
     * `SelectionMode` attribute maps onto it via {@link __setSelectionMode}, so the
     * base needs no third abstract hook to read the mode.
     */
    __selectionMode = 'single';
    /**
     * Constructor of the control.
     * @param element Element of the control as delivered by the framework.
     * @param pcElement Precompiled element of the control.
     * @param attrs Attributes of the element as delivered by the framework.
     */
    constructor(element, pcElement, attrs) {
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
    __previnit() {
        const root = this.__element.find('.TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Template')[0];
        if (!root) {
            throw new Error('Invalid Template.html of "' + this.getId() +
                '": root element with class "TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Template" not found.');
        }
        this.__elementTemplateRoot = root;
        super.__previnit();
    }
    /** Initializes the control after the template is available. */
    __init() {
        super.__init();
    }
    /**
     * Attaches the control to the page: creates the identity label and canvas,
     * applies the initial identity, starts the ResizeObserver, wires the pointer
     * handler, creates the engine instance and requests the first render.
     */
    __attach() {
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
        this.__engine = new EngineHello();
        // Per-canvas offscreen bitmap for the grid layer. Allocated lazily by the
        // cache itself, so an unsupported platform (or a control that never gets a
        // grid) costs nothing beyond this object.
        this.__gridCache = GridLayerCache.isSupported() ? new GridLayerCache() : null;
        this.__updateIdentity();
        // Observe the canvas box (changes on external resize AND when the identity
        // label toggles), then request a coalesced re-render.
        this.__resizeObserver = new ResizeObserver(() => this.__requestRender());
        this.__resizeObserver.observe(canvas);
        this.__onPointerUp = (ev) => this.__handlePointerUp(ev);
        canvas.addEventListener('pointerup', this.__onPointerUp);
        this.__requestRender();
    }
    /**
     * Detaches the control and tears everything down: cancels a pending render,
     * disconnects the observer, removes the pointer handler, disposes the engine
     * and the grid layer cache, and removes the canvas and identity label. All fields are nulled so a
     * re-attach starts from a clean state.
     */
    __detach() {
        super.__detach();
        if (this.__rafHandle !== null) {
            window.cancelAnimationFrame(this.__rafHandle);
            this.__rafHandle = null;
        }
        if (this.__resizeObserver) {
            this.__resizeObserver.disconnect();
            this.__resizeObserver = null;
        }
        if (this.__canvas && this.__onPointerUp) {
            this.__canvas.removeEventListener('pointerup', this.__onPointerUp);
        }
        this.__onPointerUp = null;
        if (this.__engine) {
            this.__engine.dispose();
            this.__engine = null;
        }
        if (this.__gridCache) {
            this.__gridCache.dispose(); // release the layer bitmap with the canvas
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
    destroy() {
        if (this.__keepAlive) {
            return;
        }
        super.destroy();
        this.__elementTemplateRoot = null;
    }
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
    __setIdentity(position) {
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
    __updateIdentity() {
        const el = this.__identityEl;
        if (!el) {
            return;
        }
        const text = this.__composeIdentity();
        if (this.__identityPosition === 'none' || text === '') {
            el.style.display = 'none';
        }
        else {
            el.style.display = 'block';
            el.textContent = text;
            el.style.order = this.__identityPosition === 'above' ? '-1' : '1';
        }
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
    __setSelectionMode(mode) {
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
    __clearSelectionState() {
        this.__selection = [];
        this.__selectedCells = new Set();
        this.__lastInteracted = null;
    }
    // ---------------------------------------------------------------
    //  Scene API (protected seam for subclasses)
    //  Stubs in this milestone: the engine model types and storage arrive with
    //  the real engine (M1+); the current probe ignores scene data. The concrete
    //  control calls these once it has items / an outline / labels to push.
    // ---------------------------------------------------------------
    /**
     * Stores the substrate outline model for the next render. `null` means no
     * outline is bound: the map fits the items instead and draws no body.
     * @param outline The built outline model, or `null`.
     */
    __updateOutline(outline) {
        this.__sceneOutline = outline;
    }
    /**
     * Stores the render-ready items for the next render. `null` is normalized to
     * an empty list.
     * @param items The render-ready items, or `null`.
     */
    __updateItems(items) {
        this.__sceneItems = items ?? [];
    }
    /**
     * Stores the effective-status resolver the engine calls to color items.
     * `null` colors every item with the unknown fallback.
     * @param resolve Resolver from an item model to its effective status, or `null`.
     */
    __updateStatusResolver(resolve) {
        this.__sceneResolve = resolve;
    }
    /**
     * Stores the status -> CSS color mapping the engine resolves at draw time.
     * @param mapping Status -> color map, or `null` to use the theme fallback.
     */
    __updateColorMapping(mapping) {
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
    __updateLabels(labels, showLabels) {
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
    __updateGrid(grid) {
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
    __updateShowOriginMarker(show) {
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
    __updatePlacement(location, offsetXmm, offsetYmm, rotationRad, ydir) {
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
    __updateViewRotation(rad) {
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
    __readColors() {
        const cs = window.getComputedStyle(this.__element[0]);
        const read = (name, fallback) => {
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
            labelFont: weight + ' ' + size + ' ' + family,
            labelColor: read('--substratemap-label-font-color', cs.color || 'rgb(40, 40, 40)'),
        };
    }
    /**
     * Builds the drawing config from the canvas' current client size.
     * @returns A {@link MapConfig}, or `null` if the canvas is missing or has
     *          zero size.
     */
    __makeConfig() {
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
     * it here - the CONTEXT invariant that the hit CTM equals the draw CTM minus
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
    __computeMatrices(cfg, dpr) {
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
            world: makeWorldMatrix(cfg, scale, rot), // W = T(center) Sc(s,-s) R(mapRotation)
            // D2S from the resolved Origin placement; anchored on the SAME fit box
            // the scale/W use (outline BBOX_S, or the items' bbox in the fallback).
            data: makeDataMatrix(fitBox, this.__placementLocation, this.__placementOffsetXmm, this.__placementOffsetYmm, this.__placementRotationRad, this.__placementYDir),
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
    __requestRender() {
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
    __render() {
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
        const grid = gridModel
            ? {
                model: gridModel,
                selected: this.__selectedCells.size > 0 ? this.__selectedCells : null,
                dataVersion: this.__sceneGridVersion,
                cache: this.__gridCache,
            }
            : null;
        drawSubstrateMap(ctx, cfg, this.__sceneOutline, grid, this.__sceneItems, colors, this.__sceneResolve ?? (() => null), this.__sceneMapping, this.__selection, this.__sceneLabels, this.__sceneShowLabels, this.__sceneShowOriginMarker, matrices);
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
     * Mode semantics (decision 29): `'single'` - a hit REPLACES the selection, a
     * miss changes nothing (exact ComponentMap sibling parity, and no event on a
     * miss); `'multi'` - a hit TOGGLES the item's membership, a click on empty space
     * CLEARS. The shift+drag rubber band is a separate task (it needs the engine's
     * rect query) and is deliberately not stubbed here.
     *
     * Payload: the single-value fields describe the last interacted item, its status
     * resolved through the pushed resolver so it honours the assignment overrides
     * (matching the painted colour); the `selection` array is the full set as typed
     * `{ kind, itemId }` entries. Id-less items are marked with a ring but carry no
     * addressable id, so they are omitted from that array. `kind` is `'item'`
     * throughout this milestone - grid cells join at the grid task.
     * @param ev The pointer event.
     */
    __handlePointerUp(ev) {
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
        const p = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const hit = getItemAtPos(p, this.__sceneItems, matrices, ctx);
        // ITEM WINS: an item is drawn ON TOP of the grid, so the topmost thing under
        // the pointer is what gets selected - the same rule that makes the topmost
        // item win among items. Short-circuited, so an item hit never pays for the
        // cell test.
        const cellHit = hit ? null : getCellAtPos(p, matrices, this.__sceneGrid);
        // Selection mutation per mode, IDENTICAL for both kinds: 'single' replaces,
        // 'multi' toggles, a miss on empty space clears in 'multi' only. The early
        // returns gate the raise + render so an inert click (single miss, or an empty
        // click when already empty) does nothing - matching ComponentMap, which
        // returns on a miss.
        if (hit) {
            if (this.__selectionMode === 'single') {
                this.__selection = [hit]; // replace (re-click re-fires: sibling parity)
                this.__selectedCells = new Set(); // 'single' replaces the WHOLE selection
            }
            else {
                const idx = this.__selection.indexOf(hit); // identity membership
                this.__selection = idx >= 0
                    ? this.__selection.slice(0, idx).concat(this.__selection.slice(idx + 1))
                    : this.__selection.concat([hit]);
            }
            this.__lastInteracted = { kind: 'item', item: hit }; // also on a toggle-off
        }
        else if (cellHit) {
            if (this.__selectionMode === 'single') {
                this.__selection = [];
                this.__selectedCells = new Set([cellHit.index]);
            }
            else if (this.__selectedCells.has(cellHit.index)) {
                this.__selectedCells.delete(cellHit.index);
            }
            else {
                this.__selectedCells.add(cellHit.index);
            }
            this.__lastInteracted = { kind: 'cell', cell: cellHit };
        }
        else if (this.__selectionMode === 'single') {
            return; // miss changes nothing (sibling parity)
        }
        else if (this.__selection.length === 0 && this.__selectedCells.size === 0 && this.__lastInteracted === null) {
            return; // multi: empty click while already empty is inert
        }
        else {
            this.__clearSelectionState(); // multi: empty click clears
        }
        // Full set as typed entries, items then cells (see SelectedPayload). Id-less
        // items have no addressable id and are omitted (they are still ring-marked
        // via __selection above); a cell's id is its row-major linear index, which
        // every cell has, so none is ever omitted.
        const selection = [];
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
    __composeSelectedPayload(selection) {
        const last = this.__lastInteracted;
        if (last && last.kind === 'cell') {
            const grid = this.__sceneGrid;
            // buildGridModel guarantees every cell index addresses binTable, and
            // getCellAtPos only returns cells of THIS grid, so the row exists - but the
            // grid could have been swapped between the hit and here, so it is checked.
            const bin = grid ? grid.binTable[grid.cells[last.cell.index]] : undefined;
            const coords = reportedCellCoords(last.cell); // ASSUME-A A5 seam
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
TcHmi.Controls.registerEx('SubstrateMapBase', 'TcHmi.Controls.CNM_UIControls.SEMI', SubstrateMapBase, { injectInGlobalObject: true });
//# sourceMappingURL=SubstrateMapBase.js.map