/*
 * attach-harness.mjs - drive the REAL SubstrateMap control under node.
 *
 * WHY THIS EXISTS. JSON spec Task 2 says "load the reference page or an
 * equivalent harness". There is no browser in the build sandbox, so this is the
 * equivalent harness: it instantiates `Controls/SubstrateMap/SubstrateMap.js` -
 * the shipped file, not a copy and not a mock - and replays a `Desktop.view`
 * panel's `data-tchmi-*` attributes through its real setters, then calls
 * `__attach()`.
 *
 * WHAT IS FAKED, AND WHAT IS NOT. Nothing on `SubstrateMap.prototype` or
 * `SubstrateMapBase.prototype` is patched. Not one method. The fakes are all
 * BELOW the product:
 *
 *   TcHmi.Controls.System.TcHmiControl   the framework base class the control
 *                                        extends; a no-op class is enough
 *   TcHmi.{EventProvider,Log,ValueConverter,Controls.registerEx}
 *                                        EventProvider RECORDS rather than
 *                                        discarding - see `drainEvents` (W-3)
 *   tchmi_equal                          a GLOBAL, not a TcHmi member
 *   window, Path2D, DOMMatrix, DOMParser the DOM surface the base and the
 *                                        engine actually touch. Path2D is the
 *                                        shared shim from W-3a, not a stub
 *
 * The base's own `__attach` runs unpatched and is harmless, because it guards
 * on `if (!root || this.__canvas) { return; }` and `__elementTemplateRoot` is
 * never installed here. That guard is load-bearing for this harness; if it is
 * ever removed, the base will reach for `document.createElement` and this file
 * needs a stub again.
 *
 * FIDELITY LIMITS - read before trusting a number out of this.
 *  1. SETTER ORDER is the view's DOCUMENT order. The framework's real order at
 *     attach is not known here and is not documented in the stub. Any
 *     measurement that depends on order must say so.
 *  2. `ValueConverter` is a reimplementation, not the framework's. It coerces
 *     the four types the control asks for and returns null where the real one
 *     might not. A value the framework would have rejected may get through.
 *  3. `DOMMatrix`, `DOMPoint` and `Path2D` are the shared shim from
 *     `Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs` - the same one the
 *     engine's own suites use, mutation-tested at LOD-1. `Path2D` records
 *     flattened polylines and the context answers `isPointInPath` and
 *     `isPointInStroke` against them (W-3a); this file carried a seven-method
 *     no-op stub until then. A `d` string still THROWS - that is W-3b - so the
 *     demo's bezier dies are not hit-testable here yet.
 *  4. No ResizeObserver and no theme CSS, so every colour falls back to its
 *     hard-coded default. `renderOnce` DOES drive a real frame through
 *     `__render` on a recording context, so the draw path is reachable.
 *     `tapAt` drives `__handlePointerUp` on the canvas `renderOnce` installed,
 *     so the HIT path is reachable too (W-3). Item hits joined it at W-3a for
 *     every geometry the shim can flatten - rectangle, circle, ellipse,
 *     polygon, polyline. A `type: 'path'` geometry throws instead, which is
 *     `buildDemo`'s bezier die, so demo-mode item hits wait for W-3b.
 *
 * Run:  node tools/attach-harness.mjs            # self-check + per-panel table
 *       node tools/attach-harness.mjs --json     # machine-readable
 *
 * Import: `drivePanel`, `readPanels`, `selfCheck` for a caller that wants the
 * per-setter counter deltas (JSON spec Task 2c); `tapAt` and `drainEvents` for
 * a caller that wants to drive the hit path and read what came out of it.
 *
 * NOT REMOVABLE, and no longer a measurement tool only. `e142-representations`
 * imports `bindAndFingerprint` from here and `tools-smoke` asserts this file's
 * own behaviour, so it is load-bearing in a gate - D-071 superseded D-013's
 * "disposable instrument" framing, and this header said otherwise until LOD-16's
 * preparation.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { requireInput } from './external-inputs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Resolved lazily and through `requireInput`, so an absent `Desktop.view`
 * raises MissingExternalInput at the read rather than ENOENT. Every consumer -
 * the eight sections that drive panels, and `selfCheck` - inherits the skip
 * without declaring anything (F-2, D-221).
 */
const VIEW = () => requireInput('Desktop.view');
const DESCRIPTOR = join(ROOT, 'Controls/SubstrateMap/Description.json');
const CONTROL_TYPE = 'TcHmi.Controls.CNM_UIControls.SEMI.SubstrateMap';

/* ---------------------------------------------------------------- descriptor */

const DESC = JSON.parse(readFileSync(DESCRIPTOR, 'utf8'));
/** `data-tchmi-*` attribute name -> descriptor `propertyName`. Authoritative: no kebab-to-Pascal guessing. */
const PROPERTY_OF = Object.create(null);
/** `propertyName` -> the descriptor's `defaultValueInternal`, for `getAttributeDefaultValueInternal`. */
const DEFAULT_OF = Object.create(null);
for (const a of DESC.attributes) {
    PROPERTY_OF[a.name] = a.propertyName;
    DEFAULT_OF[a.propertyName] = a.defaultValueInternal ?? null;
}

/* ------------------------------------------------------------- the fake host */

/** Log lines captured during one drive, newest last. Cleared per control. */
let logSink = [];

/** The framework base class. The control only needs it to exist and to no-op. */
class FakeTcHmiControl {
    /**
     * @param element   Ignored.
     * @param pcElement Ignored.
     * @param attrs     The framework's `__attrs` - "list of attributes defined in
     *                  html". Real, not ignored: the control reads it to tell an
     *                  authored attribute from one sitting at its default.
     */
    constructor(element, pcElement, attrs) { this.__id = 'harness'; this.__attrs = attrs ?? {}; }
    __previnit() { }
    __init() { }
    __attach() { }
    __detach() { }
    destroy() { }
    getId() { return this.__id; }
    /**
     * @param name The descriptor `propertyName`.
     * @returns The descriptor's declared default.
     */
    getAttributeDefaultValueInternal(name) { return DEFAULT_OF[name]; }
}

/*
 * Filled in MEMBER BY MEMBER, not with `globalThis.TcHmi ??= {...}`.
 *
 * Several suites declare `globalThis.TcHmi ??= { Controls: {} }` before importing
 * an engine module, because the engine's namespace bridge reads it. A whole-object
 * `??=` here then does nothing at all - `TcHmi` already exists - and the control
 * class fails to load on `Controls.System.TcHmiControl`. Each member is therefore
 * defaulted on its own, so this harness composes with a suite that has already
 * stubbed part of the framework.
 */
globalThis.TcHmi ??= {};
TcHmi.Controls ??= {};
TcHmi.Controls.System ??= {};
TcHmi.Controls.System.TcHmiControl ??= FakeTcHmiControl;
TcHmi.Controls.registerEx ??= function registerEx() { };
/*
 * THE EVENT BUS RECORDS. It used to be `{ raise() { } }`, so no test in this
 * repository had ever seen an event: `describeGroup` was validated against its
 * schema at the point it was BUILT, while `__raiseGroupSelected` copies it field
 * by field into a fresh object, and a field dropped in that copy would have kept
 * every assertion green. The payload was checked at its source and never at its
 * exit (W-3).
 *
 * ASSIGNED, not `??=`, and this is the one member that breaks the composition
 * rule above. A suite that stubbed `EventProvider` first would otherwise leave
 * this file's recorder uninstalled and `drainEvents()` returning an empty list
 * for ever - which reads exactly like "no event was raised" and is the failure
 * this recorder exists to end. Any previous implementation is CHAINED, so a
 * caller that installed one still gets its calls.
 */
let eventSink = [];
const priorRaise = globalThis.TcHmi?.EventProvider?.raise;
TcHmi.EventProvider ??= {};
TcHmi.EventProvider.raise = function raise(name, data) {
    eventSink.push({ name: String(name), data });
    if (typeof priorRaise === 'function') { return priorRaise.call(this, name, data); }
    return undefined;
};
TcHmi.Log ??= {
    warn: (m) => logSink.push({ level: 'warn', message: String(m) }),
    error: (m) => logSink.push({ level: 'error', message: String(m) }),
    info: (m) => logSink.push({ level: 'info', message: String(m) }),
};
TcHmi.ValueConverter ??= {
    toBoolean: (v) => (v === null || v === undefined) ? null
        : (v === 'true' ? true : v === 'false' ? false : Boolean(v)),
    toString: (v) => (v === null || v === undefined) ? null : String(v),
    toNumber: (v) => {
        if (v === null || v === undefined || v === '') { return null; }
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    },
    // Null on malformed input rather than a throw: the failure-tolerant reading of
    // Rule 9, and the framework does not throw out of a setter.
    toObject: (v) => {
        if (v === null || v === undefined) { return null; }
        if (typeof v !== 'string') { return v; }
        try { return JSON.parse(v); } catch { return null; }
    },
};
globalThis.tchmi_equal ??= (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `file://` URL for a path, needed before the product import defines its own. */
const asUrlEarly = (p) => 'file://' + p;

/*
 * DOMMatrix and DOMPoint come from `tests/lib/dom-shims.mjs`, not from a stub
 * here.
 *
 * This file carried its own for a long time, documented as "a correct 2D affine
 * implementation of the two members the engine uses". That stopped being enough
 * at LOD-15, when the base class began composing a device matrix to publish
 * `AggregationFactor` and needed `translateSelf`, `scaleSelf` and `rotateSelf`
 * as well. The failure mode was quiet and confusing: a suite that imports this
 * harness gets the stub, static imports are HOISTED above any later
 * `installDomShims()`, so a test that asked for the full shim got the partial one
 * and a method-missing error from inside the engine.
 *
 * One DOM surface, in one place. `dom-shims.mjs` imports nothing, so there is no
 * cycle, and it is the implementation LOD-1 mutation-tested and LOD-2 extended.
 */
const { installDomShims, makeContext2D } = await import(
    asUrlEarly(join(ROOT, 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs')));
installDomShims();

globalThis.window ??= {
    devicePixelRatio: 1,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => { },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
};

const { DOMParser } = await import('@xmldom/xmldom');
globalThis.DOMParser ??= DOMParser;

/* ------------------------------------------------- the product, unmodified */

const asUrl = (p) => 'file://' + p;
const { SubstrateMap } = await import(asUrl(join(ROOT, 'Controls/SubstrateMap/SubstrateMap.js')));
export { SubstrateMap };

/**
 * Drives ONE real frame through the base's `__render`, on a recording context.
 *
 * ---- WHY THIS EXISTS ----
 *
 * `__attach` is stubbed to a no-op here, so nothing in this harness has ever
 * driven the canvas path: every assertion about rendering stopped at "the setter
 * stored the value". That left the call sites in `__render` covered by reading -
 * most sharply `__publishAggregation`, which is the only thing that makes
 * `AggregationFactor` and `AggregationMode` true and was untested at LOD-15.
 *
 * `__render` guards on `__canvas` and `__canvasContext` and takes its size from
 * `canvas.clientWidth/Height`, so a plain object and LOD-2's `RecordingContext2D`
 * are the whole of what it needs. Everything downstream - `__makeConfig`,
 * `__readColors`, `__computeMatrices`, `drawSubstrateMap` and the hook - is the
 * real code.
 *
 * The returned context is the one that was drawn to, so a caller can read
 * `fills`, `puts` and `pixels` to check the frame actually happened rather than
 * being dropped at a guard.
 * @param control A SubstrateMap.
 * @param px      CSS side length of the square canvas.
 * @returns The recording context the frame was drawn on.
 */
/*
 * `h` was added at `F-28`. Until then this rendered SQUARES ONLY and silently
 * ignored a third argument - which `F-26`'s "four heights" sweep passed, so it
 * measured one geometry four times and reported a pass (observation 413). A
 * helper that accepts an argument it does not use is worse than one that refuses
 * it: the caller believes the sweep happened.
 */
/*
 * `dpr` was added at `F-28a`. Until then this rendered at ratio 1 ONLY - the canvas
 * bitmap was the same size as its CSS box - so CSS pixels and device pixels
 * coincided and no assertion in the corpus could tell them apart. A control that
 * drew its overlay in the wrong one of the two passed every test and was wrong on
 * every high-DPI display, which is exactly what happened.
 */
export function renderOnce(control, px, h = px, dpr = undefined) {
    /*
     * `dpr` DEFAULTS TO WHATEVER THE CALLER HAS SET, not to 1. An older test raises
     * `window.devicePixelRatio` itself and asserts that the aggregation factor
     * follows; forcing the ratio here would silently undo it, and it did - the
     * assertion started reporting the same number twice.
     */
    const ratio = dpr ?? (typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1);
    const ctx = makeContext2D(px * ratio, h * ratio);
    if (dpr !== undefined && typeof window !== 'undefined') { window.devicePixelRatio = dpr; }
    // `__readColors` reads `this.__element[0]`; the stubbed `window.getComputedStyle`
    // returns empty strings, so every colour falls back to its hard-coded default.
    /*
     * `__localization` is supplied by TcHmiControl in the product. The stub matches
     * the documented contract exactly: `getText` "returns the text for a specific
     * localization key or THE KEY if no text is available", and this one never has
     * a text - so every localised string renders as its key. That makes an
     * un-localised literal and a localised one visibly different in a recorder
     * dump, which is what the assertions need.
     */
    control.__localization ??= {
        getText: (key) => String(key),
        watch: () => () => {},
        watchText: () => () => {},
    };
    control.__destroyOnDetach ??= [];
    control.__destroyOnDestroy ??= [];
    control.__element ??= [{}];
    control.__canvas = {
        clientWidth: px, clientHeight: h, width: px * ratio, height: h * ratio,
        getContext: () => ctx,
        /*
         * ANCHORED AT THE ORIGIN so a client point and a canvas point are the
         * same number, which is what lets `tapAt(c, 96, 118)` mean the same
         * point as the `{ x: 96, y: 118 }` the engine-level assertions use.
         * `__handlePointerUp` subtracts left/top from clientX/clientY and does
         * nothing else with this.
         */
        getBoundingClientRect: () => ({
            left: 0, top: 0, right: px, bottom: h, x: 0, y: 0, width: px, height: h,
        }),
    };
    control.__canvasContext = ctx;
    control.__render();
    return ctx;
}

/**
 * The framework log lines captured since the last control was constructed, and
 * clears the sink.
 *
 * Reading DRAINS on purpose: a test asserting "this write logged nothing" wants
 * the lines since ITS write, not every line since the module loaded, and a sink
 * that only accumulates makes the second such assertion in a file impossible.
 * @returns The captured lines.
 */
export function logLines() {
    const out = logSink.slice();
    logSink = [];
    return out;
}

/**
 * Every event raised since the last read, and clears the list.
 *
 * DRAINS on purpose, for the same reason `logLines` does: an assertion about
 * "this tap" wants the events since ITS tap, and a list that only accumulates
 * makes the second such assertion in a file impossible. A test that forgets to
 * drain first sees the previous test's events, which fails loudly - the opposite
 * of the silence this replaced.
 *
 * Named `drainEvents` rather than `drain`: this module also drains a log sink,
 * and a bare `drain()` beside `logLines()` does not say which.
 * @returns `[{ name, data }]` in the order they were raised, oldest first.
 */
export function drainEvents() {
    const out = eventSink.slice();
    eventSink = [];
    return out;
}

/**
 * Taps the canvas at a CSS-pixel point, through the control's real handler.
 *
 * ---- WHAT IS REAL HERE ----
 *
 * `__handlePointerUp` is the shipped method, unpatched; so is everything it
 * calls - `__makeConfig`, `__computeMatrices`, `getItemAtPos`,
 * `__groupSelectionAt`, `getCellAtPos`, the selection mutation and the raise.
 * The only fabrications are the two numbers on the event object and the canvas
 * rectangle, which `renderOnce` anchors at the origin so a client point and a
 * canvas point are the same number.
 *
 * `renderOnce` must have run: the handler returns immediately when `__canvas` is
 * null, and a tap that silently does nothing is indistinguishable from a tap
 * that hit nothing. That is why this throws rather than returning.
 * @param control A SubstrateMap that `renderOnce` has drawn.
 * @param x CSS pixels from the canvas's left edge.
 * @param y CSS pixels from its top edge.
 * @returns Nothing. Read the result with `drainEvents()`.
 */
export function tapAt(control, x, y) {
    if (!control.__canvas || !control.__canvasContext) {
        throw new Error('tapAt: no canvas - call renderOnce(control, px) first, or the tap is a no-op');
    }
    if (typeof control.__canvas.getBoundingClientRect !== 'function') {
        throw new Error('tapAt: the canvas has no getBoundingClientRect - renderOnce installs one');
    }
    control.__handlePointerUp({ clientX: x, clientY: y, pointerId: 1, button: 0 });
}

/**
 * Presses at a point without releasing, so a test can express a DRAG: press
 * here, release there (`F-14`). `tapAt` alone cannot - it calls the release
 * handler directly and records no press, which is exactly the state a real
 * `pointerdown` outside the canvas leaves behind.
 * @param control The control.
 * @param x       Client x.
 * @param y       Client y.
 * @param id      Pointer id; the release must carry the same one.
 * @returns Nothing.
 */
export function pressAt(control, x, y, id = 1) {
    /*
     * The harness never runs the real `__attach` (see the fidelity limits at the
     * top of this file), so the control has no bound `pointerdown` handler. The
     * press is recorded the way the real handler records it, against the canvas
     * `renderOnce` installed - which is the same rect the release measures from.
     */
    if (!control.__canvas || typeof control.__canvas.getBoundingClientRect !== 'function') {
        throw new Error('pressAt: no canvas - call renderOnce(control, px) first');
    }
    const r = control.__canvas.getBoundingClientRect();
    control.__pressAt = { x: x - r.left, y: y - r.top, id };
}

/**
 * Releases at a point with an explicit pointer id.
 * @param control The control. @param x Client x. @param y Client y. @param id Pointer id.
 * @returns Nothing.
 */
export function releaseAt(control, x, y, id = 1) {
    control.__handlePointerUp({ clientX: x, clientY: y, pointerId: id, button: 0 });
}
const E142 = await import(asUrl(join(ROOT, 'Helpers/SubstrateMapEngine/E142.js')));
const E142Xml = await import(asUrl(join(ROOT, 'Helpers/SubstrateMapEngine/E142Xml.js')));

/* ------------------------------------------------------------ the view file */

/** The five XML entities a `.view` attribute value can carry. `&amp;` LAST or it double-decodes. */
function decodeEntities(s) {
    return s
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * Every SubstrateMap panel in a `.view` file, with its bindable attributes in
 * DOCUMENT order. Attributes the descriptor does not declare - the framework's
 * own `left`/`top`/`width`/`height` and `type` - are dropped.
 * @param viewPath Path to the `.view` file; defaults to `Desktop.view`, which is
 *                resolved through `requireInput` and so raises
 *                MissingExternalInput rather than ENOENT when absent.
 * @returns One entry per panel: `{ id, attributes: [{ attribute, property, value }] }`.
 */
export function readPanels(viewPath = null) {
    const text = readFileSync(viewPath ?? VIEW(), 'utf8');
    const out = [];
    for (const m of text.matchAll(/<div\s+id="([^"]+)"([\s\S]*?)>/g)) {
        const [, id, body] = m;
        if (!body.includes(`data-tchmi-type="${CONTROL_TYPE}"`)) { continue; }
        const attributes = [];
        for (const a of body.matchAll(/data-tchmi-([a-z0-9-]+)="([^"]*)"/g)) {
            const attribute = 'data-tchmi-' + a[1];
            const property = PROPERTY_OF[attribute];
            if (property === undefined) { continue; }
            attributes.push({ attribute, property, value: decodeEntities(a[2]) });
        }
        out.push({ id, attributes });
    }
    return out;
}

/* --------------------------------------------------------------- the driver */

/**
 * The framework's `__attrs` shape for a panel: a dictionary keyed by the markup
 * attribute name. Only the keys matter to this control.
 * @param panel One entry from {@link readPanels}.
 * @returns The attribute dictionary.
 */
function attrsOf(panel) {
    const out = Object.create(null);
    for (const a of panel.attributes) { out[a.attribute] = { value: a.value }; }
    return out;
}

/**
 * Constructs a control and replays one panel's attributes in document order,
 * counting engine work per setter.
 *
 * ATTRIBUTION IS BY DIFF (STATE.md D-009): the engine counters carry no labels,
 * so this reads them either side of each setter call. A setter that triggers two
 * rebuilds internally reports 2 and cannot be decomposed further.
 *
 * @param panel One entry from {@link readPanels}.
 * @returns `{ id, steps, totals, mapSubstrateCount, lastError, log, control }`. `control` is the
 *          live instance, so a caller can fingerprint its built grid and published outputs.
 */
export function drivePanel(panel) {
    const wasEnabled = E142.engineCountersEnabled();
    logSink = [];
    E142.setEngineCountersEnabled(true);
    E142.resetEngineCounters();

    const control = new SubstrateMap(null, null, attrsOf(panel));
    const steps = [];
    let before = E142.readEngineCounters();
    for (const { attribute, property, value } of panel.attributes) {
        const setter = 'set' + property;
        let threw = null;
        if (typeof control[setter] !== 'function') {
            steps.push({ attribute, setter, parses: 0, placements: 0, threw: 'no such setter' });
            continue;
        }
        try { control[setter](value); } catch (e) { threw = `${e.name}: ${e.message}`; }
        const after = E142.readEngineCounters();
        steps.push({
            attribute, setter,
            parses: after.parses - before.parses,
            placements: after.placements - before.placements,
            threw,
        });
        before = after;
    }

    let attachThrew = null;
    try { control.__attach(); } catch (e) { attachThrew = `${e.name}: ${e.message}`; }
    const after = E142.readEngineCounters();
    steps.push({
        attribute: '(__attach)', setter: '__attach',
        parses: after.parses - before.parses,
        placements: after.placements - before.placements,
        threw: attachThrew,
    });

    const totals = E142.readEngineCounters();
    E142.setEngineCountersEnabled(wasEnabled);
    return {
        id: panel.id,
        steps,
        totals,
        mapSubstrateCount: control.getMapSubstrateCount(),
        lastError: control.getE142LastError(),
        log: logSink.slice(),
        control,
    };
}

/**
 * A stable fingerprint of a control's built grid: its lattice, a hash of the cell
 * array, and the bin table in order.
 *
 * Cell PATTERN, not appearance. Two controls agree here only if every cell index
 * and every bin code matches, which is the comparison Task 18's Done-when asks
 * for - "not by eye" - and one no rendering harness is needed for.
 * @param control A control that has been attached.
 * @returns The fingerprint, or `'NO GRID'`.
 */
export function gridFingerprint(control) {
    const g = control.__sceneGrid;
    if (!g) { return 'NO GRID'; }
    const bytes = Buffer.from(g.cells.buffer, g.cells.byteOffset, g.cells.byteLength);
    return `${g.cols}x${g.rows}:${createHash('sha256').update(bytes).digest('hex').slice(0, 20)}`
        + `:${(g.binTable ?? []).map((b) => b.code).join('')}`;
}

/**
 * Binds one document through the real control and returns its grid fingerprint.
 * @param setter The setter name, e.g. `setE142MapData`.
 * @param value  The document.
 * @returns The fingerprint.
 */
export function bindAndFingerprint(setter, value) {
    const control = new SubstrateMap(null, null, {});
    control[setter](value);
    control.__attach();
    return gridFingerprint(control);
}

/* ------------------------------------------------------------- self-check */

/** Corpus fixtures used to cross-check the control against the engine's own parse. */
const CROSS_CHECK = [
    'v0125-all-header-facts.xml', 'v0125-three-substrates.xml',
    'v0211-multi-overlay.xml', 'v1005-wafer-2darray-ascii.xml',
];

/**
 * The Done-when of Task 2b, executed.
 *  1. every panel drives to completion with nothing thrown;
 *  2. for each cross-check fixture the control's published `MapSubstrateCount`
 *     equals the substrate-map count of the engine's own parse of the same
 *     bytes - so the harness is driving the real pipeline, not a stub of it;
 *  3. Task 3's coalescing holds: no panel costs more than one parse and one
 *     placement build, and whatever work a panel does is done by `__attach`
 *     rather than by a setter.
 * @returns `{ pass, fail, failures }`.
 */
export function selfCheck() {
    const failures = [];
    let pass = 0;
    const check = (cond, label) => { if (cond) { pass++; } else { failures.push(label); } };

    const panels = readPanels();
    check(panels.length > 0, 'Desktop.view yields at least one SubstrateMap panel');
    for (const panel of panels) {
        const r = drivePanel(panel);
        const bad = r.steps.filter((s) => s.threw !== null && s.threw !== undefined);
        check(bad.length === 0,
            `${panel.id}: drives without throwing (${bad.map((b) => b.setter + ' ' + b.threw).join('; ')})`);
        // Task 3: one attach, at most one of each.
        check(r.totals.parses <= 1, `${panel.id}: at most one parse per attach (got ${r.totals.parses})`);
        check(r.totals.placements <= 1,
            `${panel.id}: at most one placement build per attach (got ${r.totals.placements})`);
        const bySetter = r.steps.filter((s) => s.setter !== '__attach' && (s.parses > 0 || s.placements > 0));
        check(bySetter.length === 0,
            `${panel.id}: no setter does map work before attach (${bySetter.map((s) => s.setter).join(', ')})`);
        /*
         * W-14 replaced the demo-suppressed DIAGNOSTIC with a behaviour: the demo
         * draws into a bound outline instead of being suppressed. What used to be
         * checked here - a warning iff the markup asked for the demo - describes
         * nothing that happens now.
         *
         * The invariant that replaces it is the one W-14 could get wrong: real
         * items still beat the demo. A panel that binds items must draw ITS items,
         * whatever it says about the demo.
         */
        const bindsItems = panel.attributes.some((a) => a.attribute === 'data-tchmi-items');
        if (bindsItems) {
            const demoNames = (r.control.__sceneItems ?? []).filter((it) => /^R\d+C\d+$/.test(it.name ?? ''));
            check(demoNames.length === 0,
                `${panel.id}: binds items, so no demo die is drawn (found ${demoNames.length})`);
        }
        check(!r.log.some((l) => l.message.includes('SUBSTRATEMAP_DEMO_SUPPRESSED_BY_OUTLINE')),
            `${panel.id}: the demo-suppressed warning is gone (W-14)`);
    }

    const dir = join(ROOT, 'Helpers/SubstrateMapEngine/tests/fixtures/xml');
    for (const name of CROSS_CHECK) {
        const xml = readFileSync(join(dir, name), 'utf8');
        const expected = E142Xml.parseE142Xml(xml).doc.substrateMaps.length;
        const control = new SubstrateMap(null, null, []);
        control.setE142MapData(xml);
        control.__attach();
        const got = control.getMapSubstrateCount();
        check(got === expected, `${name}: control reports ${got} substrate maps, engine parses ${expected}`);
    }

    check(E142.engineCountersEnabled() === false, 'the harness leaves the counters as it found them');
    return { pass, fail: failures.length, failures };
}

/* -------------------------------------------------------------------- CLI */

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const panels = readPanels();
    const results = panels.map(drivePanel);
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ results, selfCheck: selfCheck() }, null, 2));
    } else {
        console.log('attach harness - setter order is the view\'s DOCUMENT order (see FIDELITY LIMITS)\n');
        for (const r of results) {
            console.log(`${r.id}   parses=${r.totals.parses}  placements=${r.totals.placements}`
                + `  MapSubstrateCount=${r.mapSubstrateCount}`);
            for (const s of r.steps) {
                if (s.parses === 0 && s.placements === 0 && !s.threw) { continue; }
                console.log(`    ${s.setter.padEnd(32)} parses=${s.parses} placements=${s.placements}`
                    + (s.threw ? `  THREW ${s.threw}` : ''));
            }
            const warns = r.log.filter((l) => l.level !== 'info').length;
            if (warns > 0) { console.log(`    (${warns} warning/error log lines)`); }
        }
        const sc = selfCheck();
        console.log(`\nself-check: ${sc.pass} passed, ${sc.fail} failed`);
        for (const f of sc.failures) { console.log('  - ' + f); }
        process.exit(sc.fail > 0 ? 1 : 0);
    }
}
