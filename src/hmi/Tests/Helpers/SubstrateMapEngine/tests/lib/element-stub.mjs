/*
 * element-stub.mjs - the smallest `document` that lets a control build its DOM.
 *
 * ---- WHY THIS IS SEPARATE FROM dom-shims.mjs (F-9, D-235) ----
 *
 * `dom-shims.mjs` shims the CANVAS: a 2D context, DOMMatrix, ImageData, enough
 * for the engine's geometry. It provides no `document` at all, and
 * `attach-harness.mjs` documents the consequence in its fidelity limits - it
 * never runs `__attach`, because `__elementTemplateRoot` is never installed. That
 * is why the FilterBar sits at 41% of lines with its whole DOM loop unexecuted,
 * and it is the same blind spot that let `F-4a`'s first assertions pass against
 * unfixed code.
 *
 * Installing a `document` inside `dom-shims` would hand one to all twenty suites
 * at once and change what `__attach` does everywhere. So this is opt-in: a suite
 * that wants a DOM imports it and says so. Blast radius is the file that asks.
 *
 * ---- WHAT IT IS NOT ----
 *
 * Not a DOM implementation. There is no layout, no cascade, no event bubbling and
 * no `getBoundingClientRect` - anything that needs those needs a browser, and
 * pretending otherwise is how a test comes to assert its own stub (observation
 * 362). It models exactly what the FilterBar's `__build` and `__refresh` touch:
 * element creation, parent/child, class and text, the form-control properties
 * (`value`, `disabled`, `title`, `type`, `min`, `max`, `step`) and one listener
 * per node with a `dispatch` to fire it.
 *
 * Every property is a plain field, so an assertion reads what the control wrote
 * rather than what a browser would have computed from it. That is the whole point:
 * the question is "did the bar set `disabled` and `title` on the right option",
 * not "how does Chrome render a disabled option".
 */

/** One element. A bag of properties with children and listeners. */
class StubElement {
    /** @param tag The tag name, lower-case. */
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.className = '';
        this.style = {};
        this.listeners = new Map();
        /* Form-control surface. Present on every element rather than only the ones
         * that would really have it: a stub that throws on an unexpected property
         * teaches the test to avoid it, which is the opposite of coverage. */
        this.value = '';
        this.disabled = false;
        this.title = '';
        this.type = '';
        this.min = '';
        this.max = '';
        this.step = '';
        this.__text = '';
    }

    /**
     * The element's text. Assigning `''` clears the children, which is exactly
     * what `__refresh` relies on to rebuild a select from scratch.
     */
    get textContent() { return this.__text; }

    set textContent(v) {
        this.__text = String(v);
        if (this.__text === '') {
            for (const c of this.children) { c.parentNode = null; }
            this.children = [];
        }
    }

    /** @param child The node to append. @returns The child, as the DOM does. */
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    /** @param type Event name. @param fn Handler. @returns Nothing. */
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) { this.listeners.set(type, []); }
        this.listeners.get(type).push(fn);
    }

    /**
     * Fires the handlers registered for `type`. No bubbling, no Event object:
     * the FilterBar's handlers take no argument and read the element instead.
     * @param type Event name.
     * @returns How many handlers ran, so a test can prove one was attached.
     */
    dispatch(type) {
        const fns = this.listeners.get(type) ?? [];
        for (const fn of fns) { fn(); }
        return fns.length;
    }

    /** @returns Every descendant, depth-first, including this node. */
    walk() {
        return [this, ...this.children.flatMap((c) => c.walk())];
    }

    /**
     * @param cls A class name.
     * @returns Descendants carrying it. Substring-free: `className` is compared
     *          token by token, so `-filter` never matches `-filter-radius`.
     */
    byClass(cls) {
        return this.walk().filter((e) => String(e.className).split(/\s+/).includes(cls));
    }
}

/**
 * Installs a minimal `globalThis.document` and returns a fresh root element.
 *
 * Idempotent: calling it again replaces the root but keeps the same `document`,
 * so a suite can build several bars without leaking children between them.
 * @returns A detached root the control can be attached to.
 */
export function installDocumentStub() {
    globalThis.document = globalThis.document ?? {};
    globalThis.document.createElement = (tag) => new StubElement(tag);
    return new StubElement('div');
}

/**
 * A `__localization` matching the framework's documented contract.
 *
 * `getText` "returns the text for a specific localization key or THE KEY if no text
 * is available", and this one never has a text - so a localised string renders as
 * its key, which is exactly what makes it distinguishable from a hard-coded literal
 * in an assertion.
 * @param control The control to equip.
 * @returns The same control.
 */
export function installLocalizationStub(control) {
    control.__localization = {
        getText: (key) => String(key),
        watch: () => () => {},
        watchText: () => () => {},
    };
    control.__destroyOnDetach = control.__destroyOnDetach ?? [];
    control.__destroyOnDestroy = control.__destroyOnDestroy ?? [];
    return control;
}

export { StubElement };
