/*
 * filterbar-dom.test.mjs - the FilterBar's RENDERED behaviour (F-9).
 *
 * ---- WHY THIS SUITE EXISTS ----
 *
 * The review put the bar at 41% of lines, and the missing 59% is one shape: the
 * DOM. `barOptions` and `applyBarChange` are pure and already asserted elsewhere -
 * the control's own comment says "the DOM holds no decisions" and that is true -
 * but the loop that WRITES those decisions onto elements had never been executed.
 * The README documents grey-out, a tooltip reason and a kernel reset, and nothing
 * checked that any of the three reaches an element.
 *
 * `installDomShims()` provides no `document`, so this needs `element-stub.mjs`
 * (`D-235`). That stub is opt-in for exactly this reason: handing a `document` to
 * all twenty suites would change what `__attach` does everywhere.
 *
 * ---- WHAT IS ASSERTED, AND WHAT IS NOT ----
 *
 * Asserted: that the control creates the elements it says it does, writes
 * `disabled` and `title` from the offer, rebuilds rather than patches, wires one
 * listener per control, and raises `onPropertyChanged` once per attribute that
 * actually moved - including the second write when the channel drags the filter.
 *
 * Not asserted: anything a browser computes. There is no layout here and no
 * cascade, so "is it visibly grey" is not a question this file can answer. That
 * is what the review sheet is for, and why F-9 ends with a person looking at it.
 */

import { installDomShims } from './lib/dom-shims.mjs';

installDomShims();
await import('../../../tools/attach-harness.mjs');

const { installDocumentStub, installLocalizationStub } = await import('./lib/element-stub.mjs');
const { makeHarness } = await import('./lib/harness.mjs');
const FB = await import('../../../Controls/SubstrateMapFilterBar/SubstrateMapFilterBar.js');

const { section, attempt, ok, eq, deep, finish } = makeHarness();

/** Events raised since the last drain. */
const raised = [];
const priorRaise = globalThis.TcHmi?.EventProvider?.raise;
globalThis.TcHmi.EventProvider.raise = (name, payload) => {
    raised.push({ name, payload });
    return priorRaise?.(name, payload);
};
const drain = () => raised.splice(0, raised.length);

/**
 * A bar attached to a stub root, built and refreshed.
 * @param surface Optional starting surface.
 * @returns `{ bar, root }`.
 */
const built = (surface) => {
    const root = installDocumentStub();
    const bar = installLocalizationStub(new FB.SubstrateMapFilterBar(null, null, {}));
    bar.__root = root;
    if (surface !== undefined) {
        if (surface.view !== undefined) { bar.setFieldView(surface.view); }
        if (surface.filter !== undefined) { bar.setSpatialFilter(surface.filter); }
        if (surface.radius !== undefined) { bar.setSpatialFilterRadius(surface.radius); }
        if (surface.highlight !== undefined) { bar.setHighlightFromSeverity(surface.highlight); }
    }
    bar.__build();
    bar.__refresh();
    drain();
    return { bar, root };
};
const sel = (root, key) => root.byClass(`substratemap-filterbar-${key}`)[0];

section('1. the bar builds the four controls it documents', () => {
    const { root } = built();
    attempt('one of each, and exactly one', () => {
        for (const [key, tag] of [['filter', 'SELECT'], ['view', 'SELECT'],
            ['highlight', 'SELECT'], ['radius', 'INPUT']]) {
            const found = root.byClass(`substratemap-filterbar-${key}`);
            eq(found.length, 1, `exactly one ${key} control`);
            eq(found[0].tagName, tag, `  and it is a <${tag.toLowerCase()}>`);
        }
    });

    attempt('each sits in a labelled field', () => {
        const fields = root.byClass('substratemap-filterbar-field');
        eq(fields.length, 4, 'four labelled fields');
        const labels = fields.map((f) => f.children[0]?.textContent).sort();
        deep(labels, ['bar.channel', 'bar.filter', 'bar.highlight', 'bar.radius'],
            'labelled through the dictionary, not hard-coded');
    });

    attempt('the radius is a bounded range, and zero is reachable', () => {
        const r = sel(root, 'radius');
        eq(r.type, 'range', 'a range input');
        eq(r.min, '0', "min 0 — zero is how a filter is turned off, so it must be reachable");
        eq(r.max, '8', 'max 8');
        eq(r.step, '1', 'integral steps');
    });

    attempt('the radius says what it is set to, and says "off" at zero (F-9b)', () => {
        /*
         * Reviewed on the sheet and asked for: the slider carried a caption and no
         * number, so nothing on screen said what the current radius WAS - least of
         * all that 0 turns the filter off, which is the one value the operator most
         * needs to recognise.
         *
         * `off` is a word rather than a `0` for the same reason the tooltips lead
         * with an action (D-238): the reader is not going to infer it.
         */
        const { bar, root } = built();
        const out = root.byClass('substratemap-filterbar-radius-value')[0];
        ok(out !== undefined, 'the radius field carries a value readout');
        eq(out.tagName, 'SPAN', '  as a span, not a second control');

        bar.setSpatialFilterRadius(0);
        eq(out.textContent, 'bar.radius.off', 'zero reads a KEY, not a hard-coded "off"');
        bar.setSpatialFilterRadius(1);
        eq(out.textContent, 'bar.radius.one', 'one reads singular');
        for (const r of [2, 5, 8]) {
            bar.setSpatialFilterRadius(r);
            /* The stub returns the key, so the COUNT is substituted into it - which
             * is the thing worth asserting: the plural form is the translator's and
             * the number is ours. */
            eq(out.textContent, `bar.radius.many`,
                `${r} takes the plural key, not a hard-coded unit`);
        }

        const wrap = root.byClass('substratemap-filterbar-field')
            .find((f) => f.children.some((c) => c.className === 'substratemap-filterbar-radius'));
        eq(wrap.children.length, 3, 'caption, slider, readout - one field, three parts');
        eq(wrap.children[2].className, 'substratemap-filterbar-radius-value',
            '  and the readout follows the slider it describes');
    });


    attempt('building twice does not duplicate anything', () => {
        const { bar, root: r2 } = built();
        bar.__build();
        eq(r2.byClass('substratemap-filterbar-field').length, 4,
            'the guard on __selects means a second __build is a no-op');
    });
});

section('2. grey-out and the tooltip reason reach the elements', () => {
    /*
     * The README's claim. `filterApplies` decides it and is asserted elsewhere;
     * what had never been checked is that the decision is WRITTEN - that `disabled`
     * lands on the option and the reason lands on its `title`.
     */
    attempt('on Bins, the averaging filters are disabled and say why', () => {
        const { root } = built({ view: 'Bins' });
        const opts = sel(root, 'filter').children;
        deep(opts.map((o) => o.value), ['None', 'Median', 'Min', 'Max', 'Box', 'Gauss'],
            'all six filters are offered — a disabled option is still visible');
        for (const [v, want] of [['None', false], ['Median', false], ['Min', false],
            ['Max', false], ['Box', true], ['Gauss', true]]) {
            const o = opts.find((x) => x.value === v);
            eq(o.disabled, want, `${v} disabled=${want} on Bins`);
        }
        for (const v of ['Box', 'Gauss']) {
            const o = opts.find((x) => x.value === v);
            ok(o.title.includes('average'), `${v} explains itself: “${o.title.slice(0, 48)}…”`);
            ok(o.title.includes('FailDensity') || o.title.includes('ValueField'),
                `  and names what would make it legal`);
        }
        for (const v of ['None', 'Median', 'Min', 'Max']) {
            eq(opts.find((x) => x.value === v).title, '',
                `${v} carries no tooltip — a reason is only written when there is one`);
        }
    });

    attempt('on FailDensity, the ordering filters are the disabled ones', () => {
        const { root } = built({ view: 'FailDensity' });
        const opts = sel(root, 'filter').children;
        for (const [v, want] of [['None', false], ['Box', false], ['Gauss', false],
            ['Median', true], ['Min', true], ['Max', true]]) {
            eq(opts.find((x) => x.value === v).disabled, want,
                `${v} disabled=${want} on FailDensity`);
        }
        const median = opts.find((x) => x.value === 'Median');
        ok(median.title.startsWith('Set Channel to Bins'),
            'and Median leads with what to do, not with why the maths fails (F-9a)');
        ok(!/palette index|bin index/i.test(median.title),
            '  in the operator\u2019s vocabulary: palette/bin INDEX was ours, not theirs');
    });

    attempt('every legal and illegal pairing is covered, not sampled', () => {
        const views = ['Bins', 'FailDensity', 'ValueField'];
        const filters = ['None', 'Median', 'Min', 'Max', 'Box', 'Gauss'];
        let pairs = 0;
        let disabled = 0;
        const unexplained = [];
        for (const view of views) {
            const { root } = built({ view });
            for (const o of sel(root, 'filter').children) {
                pairs++;
                if (!o.disabled) {
                    if (o.title !== '') { unexplained.push(`${view}/${o.value} is legal but has a tooltip`); }
                    continue;
                }
                disabled++;
                if (o.title === '') { unexplained.push(`${view}/${o.value} is disabled with no reason`); }
            }
        }
        eq(pairs, views.length * filters.length, 'all eighteen channel/filter pairings');
        eq(unexplained.length, 0,
            `every disabled option has a reason and no legal one has${unexplained.length ? ` (${unexplained[0]})` : ''}`);
        ok(disabled > 0 && disabled < pairs,
            `and the sweep saw both states: ${disabled} disabled of ${pairs}`);
    });
});

section('3. refresh rebuilds rather than patches', () => {
    attempt('a stale disabled cannot survive a channel change', () => {
        const { bar, root } = built({ view: 'Bins' });
        const before = sel(root, 'filter').children.map((o) => `${o.value}:${o.disabled}`);
        bar.setFieldView('FailDensity');
        const after = sel(root, 'filter').children.map((o) => `${o.value}:${o.disabled}`);
        eq(after.length, 6, 'still six options — the list was rebuilt, not appended to');
        ok(before.join() !== after.join(), 'and every disabled flag was rewritten');
        eq(after.filter((s) => s.endsWith(':true')).length, 3,
            'three disabled on FailDensity, where Bins had two');
    });

    attempt('the selected value follows the surface', () => {
        const { bar, root } = built({ view: 'Bins', filter: 'Median' });
        eq(sel(root, 'filter').value, 'Median', 'the filter select shows the bound filter');
        eq(sel(root, 'view').value, 'Bins', 'the channel select shows the bound channel');
        bar.setSpatialFilterRadius(4);
        eq(sel(root, 'radius').value, '4', 'and the radius input follows too');
    });

    attempt('a null highlight is the empty option, not the string "null"', () => {
        const { root } = built({ view: 'Bins' });
        eq(sel(root, 'highlight').value, '',
            'no threshold reads as empty — "null" in a select would be a value the user could pick');
    });
});

section('4. a change raises once per attribute that actually moved', () => {
    const moved = () => drain().filter((e) => e.name.endsWith('.onPropertyChanged'))
        .map((e) => e.payload.propertyName).sort();

    attempt('touching the filter raises for the filter alone', () => {
        const { root } = built({ view: 'Bins', filter: 'None' });
        const f = sel(root, 'filter');
        f.value = 'Median';
        eq(f.dispatch('change'), 1, 'the select has exactly one change listener');
        deep(moved(), ['SpatialFilter'], 'one raise, for SpatialFilter');
    });

    attempt('re-selecting the same value raises nothing', () => {
        const { root } = built({ view: 'Bins', filter: 'Median' });
        const f = sel(root, 'filter');
        f.value = 'Median';
        f.dispatch('change');
        deep(moved(), [], 'nothing moved, so nothing is written back');
    });

    attempt('a channel change that drags the filter raises for BOTH', () => {
        /*
         * The case the control's own comment calls out: `applyBarChange` may move
         * the filter when the channel moves, and the handler compares rather than
         * raising for the one the user touched. On Bins with Median selected,
         * switching to FailDensity makes Median illegal.
         */
        const { root } = built({ view: 'Bins', filter: 'Median' });
        const v = sel(root, 'view');
        v.value = 'FailDensity';
        v.dispatch('change');
        deep(moved(), ['FieldView', 'SpatialFilter'],
            'two raises — the channel the user touched, and the filter it invalidated');
    });

    attempt('the radius fires on input, not on change', () => {
        const { root } = built();
        const r = sel(root, 'radius');
        r.value = '3';
        eq(r.dispatch('change'), 0, 'no change listener on a range');
        eq(r.dispatch('input'), 1, 'one input listener — a slider must report while dragging');
        deep(moved(), ['SpatialFilterRadius'], 'and it raises for the radius');
    });

    attempt('setting the radius to zero is one gesture and it raises', () => {
        const { root } = built({ radius: 5 });
        const r = sel(root, 'radius');
        r.value = '0';
        r.dispatch('input');
        deep(moved(), ['SpatialFilterRadius'], 'zero is a value like any other');
        eq(sel(root, 'radius').value, '0', 'and it sticks');
    });
});

finish();
