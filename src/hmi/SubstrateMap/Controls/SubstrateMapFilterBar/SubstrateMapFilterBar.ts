/*
 * SubstrateMapFilterBar - a bar of selectors that DRIVES a map's filters.
 *
 * ---- IT RENDERS NO MAP, AND IT IS NOT A SubstrateMapBase ----
 *
 * No canvas, no aggregation, no `ResizeObserver`. Extending `SubstrateMapBase`
 * would inherit canvas sizing and a resize observer for a handful of buttons -
 * machinery it would pay for on every frame and never use. So it extends
 * `TcHmiControl` directly, which is the smallest thing the framework will place.
 *
 * ---- AND IT IS SEPARATE FROM THE MAP ON PURPOSE ----
 *
 * A control holding both a map and its controls means every `SubstrateMap` on a
 * page needs its own bar or gets none. Separated, one bar drives TWO maps
 * through the same binding - unfiltered on the left, filtered on the right - and
 * that comparison is what makes a filter worth having in the first place.
 *
 * ---- HOW IT REACHES THE MAPS ----
 *
 * It does not touch them. It owns its own copy of the filter attributes, and the
 * author binds each of them - and the matching attribute on each map - to one
 * symbol. Changing a selector sets the bar's attribute and raises
 * `onPropertyChanged`, which is what every setter in this package already does
 * and what the framework's two-way binding machinery listens for. One symbol,
 * two maps, no coupling between the controls at all.
 *
 * For that to work the bar's attribute must be INDISTINGUISHABLE from the map's:
 * same name, same type, same schema. A symbol cannot bind to two attributes that
 * disagree about their type. That is asserted rather than assumed.
 *
 * ---- THE OFFERED STATE IS A PURE FUNCTION ----
 *
 * {@link barOptions} decides what the bar offers and what is grayed out;
 * {@link applyBarChange} decides what a click does. Neither touches the DOM, so
 * both can be asserted directly - the same shape as `emptyState`,
 * `filterApplies` and `containRect`. The rendering is a loop
 * over the offered state and holds no decisions of its own.
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

/*
 * THE PAIRING RULE COMES FROM THE MAP, and is not restated here.
 *
 * `filterApplies` belongs to the map, and a second copy of it in the bar is exactly how
 * a UI comes to offer something the control then refuses. The bar imports the
 * map's module for one pure function and two types - no instance, no canvas,
 * no coupling at runtime.
 */
import { filterApplies, type FieldView, type SpatialFilter } from '../SubstrateMap/SubstrateMap.js';

/*
 * Resolved through the map's EMITTED `.d.ts`, not its source. Listing
 * `../SubstrateMap/SubstrateMap.ts` in this project's `files` array compiles
 * fine and puts the same source in two `files` arrays - a duplication the
 * project check rejects. The map is
 * built before the bar in every gate order, so the declarations are always
 * there.
 */

/** The filter surface a bar holds and a map consumes. */
export interface BarSurface {
    /** `SpatialFilter`. */
    filter: SpatialFilter;
    /** `SpatialFilterRadius`, 0..8 device px. */
    radius: number;
    /** `FieldView`. */
    view: FieldView;
    /** `HighlightFromSeverity`, or `null`. */
    highlight: number | null;
}

/** One offered choice. */
export interface BarChoice {
    /** The value written when it is chosen. */
    value: string;
    /** Whether it is offered but not selectable. */
    disabled: boolean;
    /** Why it is disabled, for a title attribute; `null` when it is not. */
    reason: string | null;
}

/** What the bar offers, given what it currently holds. */
export interface BarOffer {
    /** The spatial filters, with the illegal ones disabled. */
    filters: BarChoice[];
    /** The channels. Never disabled: a channel is a thing to look at, not a kernel. */
    views: BarChoice[];
    /** The severity thresholds, plus `''` for none. */
    highlights: BarChoice[];
}

/** The severity ranks a threshold may take, with the fallback ladder's meaning. */
export const HIGHLIGHT_RANKS: readonly { value: string; label: string }[] = [
    { value: '', label: 'bar.highlight.none' },
    { value: '1', label: 'bar.highlight.1' },
    { value: '2', label: 'bar.highlight.2' },
    { value: '3', label: 'bar.highlight.3' },
];

/**
 * What the bar offers, and what it grays out.
 *
 * ---- GRAYED OUT, NOT REJECTED ----
 *
 * The map reports an illegal filter/channel pair and declines to filter. That is
 * right for an attribute an author binds, and wrong for a button an operator
 * clicks: being allowed to choose something and then told it did not work is a
 * worse experience than seeing it unavailable, and it puts a diagnostic in the
 * log for a mistake the UI invited.
 *
 * So the bar disables what `filterApplies` would refuse, and says WHY - the
 * reason travels with the choice, because a grayed-out control with no
 * explanation is its own kind of dead end.
 *
 * Channels are never disabled. A channel is a thing to look at; a kernel is a
 * thing to do to it. Disabling the view to protect the filter would be the tail
 * wagging the dog - and {@link applyBarChange} handles that direction instead.
 * @param s What the bar holds.
 * @returns The offered state.
 */
export function barOptions(s: BarSurface): BarOffer {
    const filters: BarChoice[] = (['None', 'Median', 'Min', 'Max', 'Box', 'Gauss'] as SpatialFilter[])
        .map((f) => {
            const ok = filterApplies(f, s.view);
            return {
                value: f,
                disabled: !ok,
                reason: ok ? null
                    : f === 'Box' || f === 'Gauss'
                        // WRITTEN FOR THE OPERATOR. Reviewed on the
                        // sheet: "it reads only for someone who knows; operators are
                        // normally low-skilled workers." So the ACTION leads, naming the
                        // control and the value - both on this same bar - and `bin code`
                        // stays because it is theirs; `palette index` was ours. The
                        // engineer's version keeps its register in the
                        // E142_FILTER_NOT_APPLICABLE diagnostic, read in a log.
                        ? `Set Channel to FailDensity or ValueField to use ${f}. `
                            + `${f} averages neighboring cells, and bin codes cannot be averaged.`
                        : `Set Channel to Bins to use ${f}. `
                            + `${f} picks one of the neighboring cells, which needs bin codes.`,
            };
        });
    const views: BarChoice[] = (['Bins', 'FailDensity', 'ValueField'] as FieldView[])
        .map((v) => ({ value: v, disabled: false, reason: null }));
    const highlights: BarChoice[] = HIGHLIGHT_RANKS
        .map((r) => ({ value: r.value, disabled: false, reason: null }));
    return { filters, views, highlights };
}

/**
 * What a click does, including what it has to correct.
 *
 * ---- CHANGING THE CHANNEL CAN STRAND THE FILTER ----
 *
 * An operator looking at `Bins` with `Median` running switches to `FailDensity`.
 * The channel is what they asked for; the kernel is what no longer applies. So
 * the filter falls back to `None` rather than the channel being refused, and the
 * bar never holds a pair the map would report.
 *
 * The alternative - refusing the channel change until the filter is cleared -
 * makes the operator undo something to do something, which is the interaction
 * that teaches people to distrust a control.
 * @param s    What the bar holds.
 * @param what Which selector changed.
 * @param raw  The new value, as the DOM gives it.
 * @returns The corrected surface.
 */
export function applyBarChange(s: BarSurface, what: 'filter' | 'radius' | 'view' | 'highlight',
    raw: string): BarSurface {
    const next: BarSurface = { ...s };
    if (what === 'filter') {
        const f = raw as SpatialFilter;
        // A disabled option cannot be chosen through the UI, but a bound symbol
        // can still carry one - so the guard is here and not only in the markup.
        if (filterApplies(f, s.view)) { next.filter = f; }
    } else if (what === 'view') {
        next.view = raw as FieldView;
        if (!filterApplies(next.filter, next.view)) { next.filter = 'None'; }
    } else if (what === 'radius') {
        const n = Number(raw);
        next.radius = Number.isFinite(n) ? Math.max(0, Math.min(8, n)) : s.radius;
    } else {
        next.highlight = raw === '' ? null : Number(raw);
    }
    return next;
}

/**
 * A bar of selectors driving a `SubstrateMap`'s filter attributes.
 *
 * Placeable: unlike `SubstrateMapBase` this control is concrete and `visible` in
 * its descriptor, so `registerEx` needs no cast.
 */
export class SubstrateMapFilterBar extends TcHmi.Controls.System.TcHmiControl {
    /**
     * The bar's own root, resolved at attach.
     *
     * `null` until then. Held rather than looked up per event, because a bar
     * redraws on every attribute write and a query per write is a cost with no
     * reason.
     */
    protected __root: HTMLElement | null = null;

    /**
     * What the bar holds, and what it writes back through its bindings.
     *
     * The defaults are the map's defaults, so a bar dropped onto a page and bound
     * changes nothing until someone touches it.
     */
    protected __surface: BarSurface = { filter: 'None', radius: 1, view: 'Bins', highlight: null };

    /** The four selectors, once built. */
    protected __selects: Partial<Record<'filter' | 'radius' | 'view' | 'highlight', HTMLSelectElement | HTMLInputElement>> = {};

    /** The radius' value readout, or `null` before {@link __build} has run. */
    protected __radiusValue: HTMLElement | null = null;

    /**
     * @param element   The control's element.
     * @param pcElement The parent container element.
     * @param attrs     The attribute list from the markup.
     */
    public constructor(element: JQuery, pcElement: JQuery, attrs: TcHmi.Controls.ControlAttributeList) {
        super(element, pcElement, attrs);
    }

    /** @returns Nothing. */
    public __previnit(): void {
        super.__previnit();
        const found = this.__element.find('.TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapFilterBar-Template');
        this.__root = found.length > 0 ? (found[0] as HTMLElement) : null;
    }

    /** @returns Nothing. */
    public __init(): void {
        super.__init();
    }

    /** @returns Nothing. */
    public __attach(): void {
        super.__attach();
        this.__build();
        this.__refresh();
    }

    // ---------------------------------------------------------------
    //  The four attributes
    //
    //  Each is the map's, verbatim in name, type and schema, because one symbol
    //  cannot bind to two attributes that disagree about their type. A setter
    //  here is written to by the BINDING, so it must not raise
    //  `onPropertyChanged` in turn - that is `__changed`'s job, for a value the
    //  user produced. A setter that raised would echo the binding back at
    //  itself.
    // ---------------------------------------------------------------

    /** @param valueNew The filter, or `null` for `None`. */
    public setSpatialFilter(valueNew: SpatialFilter | null): void {
        const v = (TcHmi.ValueConverter.toString(valueNew) ?? 'None') as SpatialFilter;
        if (v === this.__surface.filter) { return; }
        this.__surface = applyBarChange(this.__surface, 'filter', v);
        this.__refresh();
    }
    /** @returns The filter. */
    public getSpatialFilter(): SpatialFilter { return this.__surface.filter; }

    /** @param valueNew The radius in device pixels, or `null` for the default. */
    public setSpatialFilterRadius(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const v = raw === null || !Number.isFinite(raw) ? 1 : raw;
        if (v === this.__surface.radius) { return; }
        this.__surface = applyBarChange(this.__surface, 'radius', String(v));
        this.__refresh();
    }
    /** @returns The radius. */
    public getSpatialFilterRadius(): number { return this.__surface.radius; }

    /** @param valueNew The channel, or `null` for `Bins`. */
    public setFieldView(valueNew: FieldView | null): void {
        const v = (TcHmi.ValueConverter.toString(valueNew) ?? 'Bins') as FieldView;
        if (v === this.__surface.view) { return; }
        this.__surface = applyBarChange(this.__surface, 'view', v);
        this.__refresh();
    }
    /** @returns The channel. */
    public getFieldView(): FieldView { return this.__surface.view; }

    /** @param valueNew The threshold, or `null` to highlight nothing. */
    public setHighlightFromSeverity(valueNew: number | null): void {
        const raw = TcHmi.ValueConverter.toNumber(valueNew);
        const v = raw === null || !Number.isFinite(raw) ? null : raw;
        if (v === this.__surface.highlight) { return; }
        this.__surface = applyBarChange(this.__surface, 'highlight', v === null ? '' : String(v));
        this.__refresh();
    }
    /** @returns The threshold, or `null`. */
    public getHighlightFromSeverity(): number | null { return this.__surface.highlight; }

    /**
     * What the bar currently holds, for assertions and for a host that wants it.
     * @returns A copy of the surface.
     */
    public readSurface(): BarSurface { return { ...this.__surface }; }

    /**
     * Builds the four selectors, once.
     *
     * ---- THE DOM HOLDS NO DECISIONS ----
     *
     * Every choice about what exists and what is grayed out comes from
     * {@link barOptions}, and every choice about what a click does comes from
     * {@link applyBarChange}. This method is a loop and an event handler, so the
     * part that can be got wrong is the part that can be asserted without a
     * browser.
     * @returns Nothing.
     */
    protected __build(): void {
        const root = this.__root;
        if (root === null || Object.keys(this.__selects).length > 0) { return; }

        /** @param label The visible label. @param el The control. @returns Nothing. */
        /**
         * @param label The visible caption.
         * @param el    The control.
         * @param after An optional node placed after the control - the radius'
         *              value readout, which is the only field that has one.
         * @returns Nothing.
         */
        const field = (label: string, el: HTMLElement, after?: HTMLElement): void => {
            const wrap = document.createElement('label');
            wrap.className = 'substratemap-filterbar-field';
            const text = document.createElement('span');
            text.textContent = label;
            wrap.appendChild(text);
            wrap.appendChild(el);
            if (after !== undefined) { wrap.appendChild(after); }
            root.appendChild(wrap);
        };

        for (const key of ['filter', 'view', 'highlight'] as const) {
            const sel = document.createElement('select');
            sel.className = `substratemap-filterbar-${key}`;
            sel.addEventListener('change', () => { this.__changed(key, sel.value); });
            this.__selects[key] = sel;
            field(this.__localization.getText(
                { filter: 'bar.filter', view: 'bar.channel', highlight: 'bar.highlight' }[key]
                    ?? 'bar.filter'), sel);
        }

        // A NUMBER INPUT, not a select: the radius is continuous in the operator's
        // head even though it is integral, and zero has to be reachable in one
        // gesture because zero is how a filter is turned off.
        const radius = document.createElement('input');
        radius.type = 'range';
        radius.min = '0';
        radius.max = '8';
        radius.step = '1';
        radius.className = 'substratemap-filterbar-radius';
        radius.addEventListener('input', () => { this.__changed('radius', radius.value); });
        this.__selects.radius = radius;
        /*
         * A VALUE READOUT. A slider with a caption and no number leaves nothing on
         * screen saying what the current radius is - and least of all that 0 means
         * the filter is off, which is the one value
         * the operator most needs to recognize. `off` is a word rather than a `0`
         * for the same reason the tooltips lead with an action: the
         * reader is not going to infer it.
         */
        const radiusValue = document.createElement('span');
        radiusValue.className = 'substratemap-filterbar-radius-value';
        this.__radiusValue = radiusValue;
        field(this.__localization.getText('bar.radius'), radius, radiusValue);
    }

    /**
     * Handles one selector change: decide, store, tell the binding, redraw.
     * @param what Which selector. @param value Its new value.
     * @returns Nothing.
     */
    protected __changed(what: 'filter' | 'radius' | 'view' | 'highlight', value: string): void {
        const before = this.__surface;
        const after = applyBarChange(before, what, value);
        this.__surface = after;
        /*
         * One `onPropertyChanged` per attribute that actually moved. The framework's
         * two-way binding writes each back to its symbol, and the maps bound to the
         * same symbols follow. A change to the CHANNEL can move the filter too - see
         * `applyBarChange` - and that second write is why this compares rather than
         * raising for the one the user touched.
         */
        if (after.filter !== before.filter) { this.__raise('SpatialFilter'); }
        if (after.radius !== before.radius) { this.__raise('SpatialFilterRadius'); }
        if (after.view !== before.view) { this.__raise('FieldView'); }
        if (after.highlight !== before.highlight) { this.__raise('HighlightFromSeverity'); }
        this.__refresh();
    }

    /** @param propertyName The attribute that moved. @returns Nothing. */
    protected __raise(propertyName: string): void {
        TcHmi.EventProvider.raise(this.__id + '.onPropertyChanged', { propertyName });
    }

    /**
     * Writes the offered state onto the selectors.
     *
     * Rebuilt in full rather than patched: four selects with six options between
     * them is not a list worth diffing, and a redraw that recreates everything
     * cannot leave a stale `disabled` behind.
     * @returns Nothing.
     */
    protected __refresh(): void {
        const offer = barOptions(this.__surface);
        const fill = (el: HTMLSelectElement | undefined, choices: BarChoice[],
            selected: string, label: (v: string) => string): void => {
            if (el === undefined) { return; }
            el.textContent = '';
            for (const c of choices) {
                const opt = document.createElement('option');
                opt.value = c.value;
                opt.textContent = label(c.value);
                opt.disabled = c.disabled;
                if (c.reason !== null) { opt.title = c.reason; }
                el.appendChild(opt);
            }
            el.value = selected;
        };
        const s = this.__surface;
        fill(this.__selects.filter as HTMLSelectElement | undefined, offer.filters, s.filter, (v) => v);
        fill(this.__selects.view as HTMLSelectElement | undefined, offer.views, s.view, (v) => v);
        fill(this.__selects.highlight as HTMLSelectElement | undefined, offer.highlights,
            s.highlight === null ? '' : String(s.highlight),
            /*
             * `label` is now a KEY, so it is resolved here rather than shown raw.
             * `getText` returns the key when a locale has no text for it, which is
             * why a missing translation reads `bar.highlight.2` and not blank.
             */
            (v) => {
                const k = HIGHLIGHT_RANKS.find((r) => r.value === v)?.label;
                return k === undefined ? v : this.__localization.getText(k);
            });
        const radius = this.__selects.radius as HTMLInputElement | undefined;
        if (radius !== undefined) { radius.value = String(s.radius); }
        if (this.__radiusValue !== null) {
            /*
             * Three keys, not one with a suffix. English pluralizes by adding `s`
             * and German does not - `1 Zelle` / `2 Zellen` - so the plural form is
             * the translator's business, and `{0}` is the placeholder the schema
             * documents.
             */
            this.__radiusValue.textContent = s.radius === 0
                ? this.__localization.getText('bar.radius.off')
                : s.radius === 1
                    ? this.__localization.getText('bar.radius.one')
                    : this.__localization.getText('bar.radius.many')
                        .replace('{0}', String(s.radius));
        }
    }

    /** @returns Nothing. */
    public __detach(): void {
        super.__detach();
    }

    /**
     * Releases the root reference.
     *
     * `destroy` runs once and the base's own teardown must run last, which is why
     * the guard is on `__keepAlive` exactly as the framework's own controls do it.
     * @returns Nothing.
     */
    public destroy(): void {
        if (this.__keepAlive) { return; }
        this.__root = null;
        super.destroy();
    }
}

/*
 * Registration. No cast here: this class is concrete and placeable, unlike
 * `SubstrateMapBase`, whose abstractness forces one at its own call site.
 */
TcHmi.Controls.registerEx(
    'SubstrateMapFilterBar',
    'TcHmi.Controls.CNM_UIControls.SEMI',
    SubstrateMapFilterBar,
    { injectInGlobalObject: true }
);

/* ------------------------------------------------------------------------ *
 * Global namespace types (classic consumers), the same compatibility block
 * `SubstrateMapBase` carries and for the same reason: the runtime binding comes
 * from registerEx({ injectInGlobalObject: true }) and this only teaches the
 * classic type system about it.
 * ------------------------------------------------------------------------ */

declare const _SubstrateMapFilterBarAlias: typeof SubstrateMapFilterBar;
type _SubstrateMapFilterBarInstance = SubstrateMapFilterBar;

declare global {
    namespace TcHmi.Controls.CNM_UIControls.SEMI {
        /** Global alias of the module export {@link SubstrateMapFilterBar}. */
        let SubstrateMapFilterBar: typeof _SubstrateMapFilterBarAlias;
        /** Instance type of the global alias. */
        type SubstrateMapFilterBar = _SubstrateMapFilterBarInstance;
    }
}
