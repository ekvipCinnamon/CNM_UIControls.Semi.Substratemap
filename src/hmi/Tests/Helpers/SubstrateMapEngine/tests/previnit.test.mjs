/*
 * previnit.test.mjs - every control survives the lifecycle step the harness skips.
 *
 * ---- THE HOLE THIS FILLS ----
 *
 * `tools/attach-harness.mjs` never installs a template root. Its header says so,
 * and that was a reasonable simplification: the harness exists to drive
 * rendering, and rendering does not care where the root came from.
 *
 * But `__previnit` is the step that FINDS the root, and it throws when the
 * template does not carry the base class. `SubstrateMapWidget` and
 * `SubstrateMapBinChart` shipped without it and threw the moment they were
 * placed in a view - through 1849 assertions, thirteen gates and 228 mutations,
 * because every one of them started after the step that would have failed.
 *
 * **A declared limitation is still a hole.** This suite drives the real
 * `__previnit` against the real `Template.html`, which is the only thing that
 * could have caught it.
 *
 * ---- THE STUB IS A jQuery `find`, AND NOTHING MORE ----
 *
 * `__previnit` uses exactly one DOM operation: `this.__element.find('.cls')[0]`.
 * Reproducing that against the real template text needs a class-attribute match
 * over the elements in the file - no parser, no jsdom, no dependency. Anything
 * more would be this file guessing at the framework instead of exercising the
 * control.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDomShims } from './lib/dom-shims.mjs';
import { makeHarness } from './lib/harness.mjs';
/*
 * The harness's TcHmi fakes, imported for their SIDE EFFECT. A control module
 * calls `TcHmi.Controls.registerEx` at import time, so `TcHmi` must exist before
 * the first import - and building a second set here would be a second framework
 * to keep in step.
 */
import '../../../tools/attach-harness.mjs';

const { ok, eq, section, attempt, finish } = makeHarness();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

installDomShims();

/**
 * A jQuery-ish `find` over a template's text.
 *
 * Returns element stand-ins for every element carrying the class, in document
 * order, which is what `find('.cls')[0]` needs and all it needs.
 * @param html The template text.
 * @returns An object with `find`.
 */
function elementFor(html) {
    return {
        find(selector) {
            const cls = String(selector).replace(/^\./, '');
            const out = [];
            for (const m of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
                const attrs = m[2];
                const c = /\sclass="([^"]*)"/.exec(attrs);
                if (c === null) { continue; }
                if (c[1].split(/\s+/).includes(cls)) {
                    out.push({ tagName: m[1], className: c[1], style: {},
                        appendChild() {}, remove() {}, addEventListener() {},
                        removeEventListener() {}, setAttribute() {},
                        querySelector: () => null, getBoundingClientRect: () => ({ width: 0, height: 0 }) });
                }
            }
            return out;
        },
    };
}

const CONTROLS = join(ROOT, 'Controls');
const dirs = readdirSync(CONTROLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(CONTROLS, n, 'Description.json')))
    .sort();

/*
 * ---- IMPORTED UP FRONT, BECAUSE `attempt` IS SYNCHRONOUS ----
 *
 * The first version made each `attempt` callback `async` and awaited the import
 * inside it. `attempt` does not await, so everything after the first `await`
 * fell outside its accounting: five controls produced one assertion each and the
 * suite was green having tested nothing. **An assertion that is never reached
 * counts as neither pass nor fail**, which looks exactly like a pass in a total.
 */
const modules = new Map();
for (const dir of dirs) {
    modules.set(dir, await import(
        new URL(`../../../Controls/${dir}/${dir}.js`, import.meta.url).href));
}

section('1. __previnit against the real templates', () => {
    /*
     * DISCOVERED, not listed. A control added later is checked without anyone
     * remembering to add it here - the rule `D-173` cost four silent misses.
     */
    attempt('every control in the package is exercised', () => {
        ok(dirs.length >= 5, `${dirs.length} controls discovered: ${dirs.join(', ')}`);
        eq(modules.size, dirs.length, '  and every one of them imports');
    });

    for (const dir of dirs) {
        const desc = JSON.parse(readFileSync(join(CONTROLS, dir, 'Description.json'), 'utf8'));
        const tpl = join(CONTROLS, dir, desc.template ?? 'Template.html');

        attempt(`${dir}: __previnit finds its template root`, () => {
            ok(existsSync(tpl), `${desc.template ?? 'Template.html'} exists`);
            const html = readFileSync(tpl, 'utf8');
            const Ctor = modules.get(dir)[dir];
            eq(typeof Ctor, 'function', `${dir}.js exports its class`);

            const c = new Ctor(null, null, {});
            c.__element = elementFor(html);
            c.__id = `test.${dir}`;

            let threw = null;
            try { c.__previnit(); } catch (e) { threw = e; }

            eq(threw, null, threw === null
                ? 'it does not throw'
                : `IT THROWS — the control cannot be placed: ${String(threw.message).slice(0, 130)}`);

            /*
             * THE ROOT IS A CONTRACT OF THE LOCAL BASE, NOT OF EVERY CONTROL.
             *
             * `SubstrateMapFilterBar` extends `TcHmiControl` and renders no canvas,
             * so it has no `__elementTemplateRoot` and asserting one would be this
             * suite inventing a requirement. The first version asserted it for
             * everything and went red on the one control that was correct.
             *
             * Every control must not THROW. Only the ones deriving from
             * `SubstrateMapBase` must end up with a root.
             */
            const localBase = typeof desc.base === 'string'
                && dirs.some((d) => desc.base.endsWith(`.${d}`));
            if (localBase) {
                ok(c.__elementTemplateRoot !== null && c.__elementTemplateRoot !== undefined,
                    '  and the template root is set, because its base requires one');
            }
            /*
             * NOTHING is asserted about a non-derived control's root. The first
             * version required it to be null, which is an invention: the framework
             * base may set one and that is its business. **Not throwing is the
             * contract every control has; the root is the contract only this
             * package's base imposes.**
             */
        });
    }
});

finish();
