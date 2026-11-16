#!/usr/bin/env node
/*
 * architecture.mjs - the diagrams in ARCHITECTURE.md, generated from the sources.
 *
 * ---- WHY GENERATED ----
 *
 * An architecture diagram drawn by hand is a drawing of what somebody believed the
 * architecture was on the day they drew it. This one is read out of the code: the
 * `extends` clauses, the imports between engine modules, and the imports from each
 * control into the engine. When a control stops using a module the arrow goes away
 * by itself, and `--check` fails a commit that would have left it behind.
 *
 * ---- WHAT IS NOT GENERATED ----
 *
 * The prose. A generated graph says WHAT depends on what and can never say why, and
 * the why is the only part worth a reader's time - which is the lesson `G-5` learnt
 * about the diagnostic register, whose 29 correct rows answered a question nobody
 * asks. Everything outside the marked blocks is written by hand.
 *
 *   node tools/architecture.mjs           rewrite the blocks in ARCHITECTURE.md
 *   node tools/architecture.mjs --check   exit 1 if a block is stale
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const DOC = join(ROOT, 'ARCHITECTURE.md');

/** @param a Marker name. @returns The begin/end pair. */
const marks = (a) => [`<!-- ${a}:BEGIN -->`, `<!-- ${a}:END -->`];

/* ------------------------------------------------------------------ reading */

/** @returns `{ name -> { extends, file } }` for every control class. */
function controls() {
    const out = new Map();
    for (const dir of readdirSync(join(ROOT, 'Controls'))) {
        const p = join(ROOT, 'Controls', dir, `${dir}.ts`);
        if (!existsSync(p)) { continue; }
        const src = readFileSync(p, 'utf8');
        const m = /^export (?:abstract )?class (\w+)(?: extends ([\w.]+))?/m.exec(src);
        if (m === null) { continue; }
        out.set(m[1], {
            base: m[2] ?? null,
            abstract: /^export abstract class/m.test(src),
            uses: [...new Set([...src.matchAll(/SubstrateMapEngine\/(\w+)\.js/g)].map((x) => x[1]))]
                .sort(),
        });
    }
    return out;
}

/** @returns `{ module -> string[] }` of engine-internal imports. */
function engine() {
    const out = new Map();
    const dir = join(ROOT, 'Helpers', 'SubstrateMapEngine');
    for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ts') || f.endsWith('.d.ts')) { continue; }
        const src = readFileSync(join(dir, f), 'utf8');
        out.set(f.replace(/\.ts$/, ''),
            [...new Set([...src.matchAll(/from '\.\/(\w+)\.js'/g)].map((m) => m[1]))].sort());
    }
    return out;
}

/*
 * THE GLOBAL BRIDGES (H-8).
 *
 * No engine module imports `TcHmi`, and that sentence used to stand in this
 * document as "framework-free". It is true of `import` statements and misleading
 * about loading: a module that ends in a global bridge - `declare global { namespace
 * TcHmi... }` plus statements that hang its functions on `TcHmi.Controls` - reads
 * that global while it is evaluated, and so does everything that imports it at
 * VALUE level. Type-only imports are erased and carry nothing.
 *
 * So per module: does it carry a bridge, and does loading it require the global -
 * itself, or through which value import. Counted here so the number in the document
 * is generated, and an eighth bridge cannot arrive unnoticed.
 *
 * @param e The engine map, for the module list.
 * @returns `{ module -> { bridge, needs, via } }`.
 */
function bridges(e) {
    const dir = join(ROOT, 'Helpers', 'SubstrateMapEngine');
    const value = new Map();
    const own = new Map();
    for (const m of e.keys()) {
        const src = readFileSync(join(dir, `${m}.ts`), 'utf8');
        own.set(m, /declare global\s*\{\s*namespace TcHmi\b/.test(src));
        const deps = new Set();
        for (const x of src.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:\{([^}]*)\}|\*[^;]*?)\s*from\s*'\.\/(\w+)\.js'/gm)) {
            if (x[1]) { continue; }
            const names = x[2] === undefined ? [] : x[2].split(',').map((t) => t.trim()).filter(Boolean);
            if (names.length > 0 && names.every((n) => n.startsWith('type '))) { continue; }
            deps.add(x[3]);
        }
        for (const x of src.matchAll(/^\s*import\s+'\.\/(\w+)\.js'/gm)) { deps.add(x[1]); }
        value.set(m, [...deps].sort());
    }
    const reaches = (m, seen = new Set()) => {
        if (seen.has(m)) { return false; }
        seen.add(m);
        return own.get(m) === true || (value.get(m) ?? []).some((d) => reaches(d, seen));
    };
    const out = new Map();
    for (const m of [...e.keys()].sort()) {
        const via = own.get(m) ? null : (value.get(m) ?? []).find((d) => reaches(d)) ?? null;
        out.set(m, { bridge: own.get(m) === true, needs: own.get(m) === true || via !== null, via });
    }
    return out;
}

/*
 * THE TABLE IS PROVEN, not only derived. Reading imports is an argument about what
 * happens at load; loading is the fact. Each emitted module is imported in a fresh
 * Node process with no `TcHmi` global, and it must fail exactly when the table says
 * it needs one. A missed `export ... from`, or a value import mistaken for a type
 * import, shows up here as a module that "loads without it" and does not.
 *
 * @param b The bridge map.
 * @returns Disagreements, or `null` when nothing is emitted to load.
 */
function proveBridges(b) {
    const dir = join(ROOT, 'Helpers', 'SubstrateMapEngine');
    if (![...b.keys()].every((m) => existsSync(join(dir, `${m}.js`)))) { return null; }
    const wrong = [];
    for (const [m, v] of b) {
        const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e',
            `import(${JSON.stringify('./' + m + '.js')}).then(() => process.exit(0), (e) => `
            + `process.exit(/TcHmi is not defined/.test(String(e)) ? 3 : 4))`], { cwd: dir, encoding: 'utf8' });
        const needs = r.status === 3;
        if (r.status !== 0 && r.status !== 3) { wrong.push(`${m}: failed to load for another reason`); continue; }
        if (needs !== v.needs) {
            wrong.push(`${m}: the table says it ${v.needs ? 'needs' : 'does not need'} TcHmi to load, and it `
                + (needs ? 'does' : 'does not'));
        }
    }
    return wrong;
}

/** @param b The bridge map. @returns The generated summary and table. */
function bridgeTable(b) {
    const all = [...b.values()];
    const own = all.filter((v) => v.bridge).length;
    const via = all.filter((v) => !v.bridge && v.needs).length;
    const L = [`**${own} of ${b.size} modules carry a bridge; ${via} more need \`TcHmi\` through a value import; `
        + `${b.size - own - via} load without it.**`, '',
        '| module | carries a bridge | needs `TcHmi.Controls` to load |', '|---|---|---|'];
    for (const [m, v] of b) {
        L.push(`| \`${m}\` | ${v.bridge ? 'yes' : '—'} | `
            + (v.bridge ? 'yes' : v.via ? `yes, through \`${v.via}\`` : '—') + ' |');
    }
    return L.join('\n');
}

/* ------------------------------------------------------------------ drawing */

/** @param c The control map. @returns A mermaid classDiagram of the controls. */
function classDiagram(c) {
    const L = ['```mermaid', 'classDiagram', '    direction TB'];
    /*
     * The framework base is drawn but marked external, because "extends something
     * we did not write" is the single most useful fact about a control here - it is
     * what decides which lifecycle hooks exist.
     */
    L.push('    class TcHmiControl["TcHmi.Controls.System.TcHmiControl"] {', '        <<framework>>',
        '    }');
    for (const [name, v] of [...c].sort()) {
        L.push(`    class ${name} {`);
        if (v.abstract) { L.push('        <<abstract>>'); }
        L.push(`        ${v.uses.length} engine module(s)`);
        L.push('    }');
    }
    for (const [name, v] of [...c].sort()) {
        if (v.base === null) { continue; }
        L.push(`    ${v.base.split('.').pop()} <|-- ${name}`);
    }
    L.push('```');
    return L.join('\n');
}

/**
 * @param e The engine map.
 * @param b The bridge map: a module with its own bridge gets a thick border, one
 *          that needs the global through an import a dashed one.
 * @returns A mermaid graph of the engine's modules.
 */
function engineDiagram(e, b) {
    const L = ['```mermaid', 'graph LR'];
    const cycles = [];
    for (const [m, deps] of [...e].sort()) {
        for (const d of deps) {
            if (!e.has(d)) { continue; }
            if ((e.get(d) ?? []).includes(m) && m < d) { cycles.push([m, d]); }
            const both = (e.get(d) ?? []).includes(m);
            L.push(`    ${m} ${both ? '<-->' : '-->'} ${d}`);
        }
    }
    /* A cycle is drawn once, as a double arrow, and named in the prose below. */
    const seen = new Set();
    const lines = L.filter((l) => {
        if (!l.includes('<-->')) { return true; }
        const k = l.trim().split(' <--> ').sort().join('|');
        if (seen.has(k)) { return false; }
        seen.add(k);
        return true;
    });
    const own = [...b].filter(([, v]) => v.bridge).map(([m]) => m);
    const via = [...b].filter(([, v]) => !v.bridge && v.needs).map(([m]) => m);
    if (own.length > 0) { lines.push(`    class ${own.join(',')} bridge`); }
    if (via.length > 0) { lines.push(`    class ${via.join(',')} viabridge`); }
    lines.push('    classDef bridge stroke-width:3px', '    classDef viabridge stroke-dasharray: 4 3');
    lines.push('```');
    return { text: lines.join('\n'), cycles };
}

/** @param c The control map. @returns A mermaid graph of control -> engine use. */
function usageDiagram(c) {
    const L = ['```mermaid', 'graph LR'];
    for (const [name, v] of [...c].sort()) {
        if (v.uses.length === 0) {
            L.push(`    ${name}:::nomodule`);
            continue;
        }
        for (const u of v.uses) { L.push(`    ${name} --> ${u}`); }
    }
    L.push('    classDef nomodule stroke-dasharray: 4 3');
    L.push('```');
    return L.join('\n');
}

/* ------------------------------------------------------------------- write */

const c = controls();
const e = engine();
const br = bridges(e);
const eng = engineDiagram(e, br);

const blocks = {
    CLASSES: classDiagram(c),
    ENGINE: eng.text,
    BRIDGES: bridgeTable(br),
    USAGE: usageDiagram(c),
};
const bridged = [...br.values()].filter((v) => v.bridge).length;
const proof = proveBridges(br);
if (proof !== null && proof.length > 0) {
    console.error('\n  The bridge table disagrees with what Node does when it loads the modules:');
    for (const w of proof) { console.error(`    ${w}`); }
    process.exit(1);
}
const proved = proof === null ? ', bridges not loaded (nothing emitted)' : ', bridges proven by loading';

if (!existsSync(DOC)) {
    console.error(`architecture: ${DOC} does not exist`);
    process.exit(2);
}
const before = readFileSync(DOC, 'utf8');
const eol = before.includes('\r\n') ? '\r\n' : '\n';
let out = before;
for (const [name, body] of Object.entries(blocks)) {
    const [b, en] = marks(name);
    const i = out.indexOf(b);
    const j = out.indexOf(en);
    if (i === -1 || j === -1) {
        console.error(`architecture: no ${b} … ${en} block in ARCHITECTURE.md`);
        process.exit(2);
    }
    out = out.slice(0, i + b.length) + eol + body.replace(/\n/g, eol) + eol + out.slice(j);
}

/*
 * THE DIAGRAMS ARE PARSED, when a parser is present.
 *
 * `mermaid` is not a dependency of this package - it is a documentation renderer,
 * and adding it to `devDependencies` would make `npm install` pull a browser
 * toolchain to build a control library. So the parse is OPPORTUNISTIC: if `mermaid`
 * and `jsdom` resolve, every block is parsed and a syntax error fails; if they do
 * not, that is reported rather than passed over in silence.
 *
 * `mmdc`, the official renderer, needs headless Chrome and cannot run here at all.
 * Rendering belongs in CI where a browser exists; parsing is what this can do, and
 * it catches the failure that matters - a diagram nobody can display.
 */
async function parseBlocks(text) {
    let JSDOM;
    let mermaid;
    /*
     * ORDER MATTERS. The globals must exist BEFORE `mermaid` is imported: it reaches
     * for `DOMPurify` at module-evaluation time, and importing it first fails with
     * `DOMPurify.addHook is not a function` - which reads like a broken diagram and
     * is a missing DOM.
     */
    try {
        ({ JSDOM } = await import('jsdom'));
    } catch {
        return { available: false, ok: 0, total: 0, errors: [] };
    }
    const dom = new JSDOM('<!doctype html><body></body>');
    for (const k of ['window', 'document', 'navigator', 'Element', 'SVGElement', 'Node',
        'DocumentFragment', 'HTMLElement', 'NodeFilter', 'getComputedStyle', 'DOMParser']) {
        if (globalThis[k] === undefined && dom.window[k] !== undefined) {
            globalThis[k] = dom.window[k];
        }
    }
    try {
        mermaid = (await import('mermaid')).default;
    } catch {
        return { available: false, ok: 0, total: 0, errors: [] };
    }
    const found = [...text.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)]
        .map((m) => m[1].replace(/\r/g, ''));
    const errors = [];
    let ok = 0;
    for (const [i, b] of found.entries()) {
        try {
            await mermaid.parse(b);
            ok++;
        } catch (e) {
            errors.push(`block ${i + 1}: ${String(e?.message ?? e).split('\n')[0].slice(0, 140)}`);
        }
    }
    return { available: true, ok, total: found.length, errors };
}

const parsed = await parseBlocks(out);
if (parsed.available) {
    if (parsed.errors.length > 0) {
        console.error('\n  A diagram does not parse:');
        for (const e of parsed.errors) { console.error(`    ${e}`); }
        process.exit(1);
    }
} else {
    console.log('  (mermaid not installed - diagrams written but not parsed)');
}

if (!CHECK) {
    writeFileSync(DOC, out, 'utf8');
    console.log(`  ARCHITECTURE.md: ${c.size} controls, ${e.size} engine modules, `
        + `${eng.cycles.length} cycle(s), ${bridged} bridge(s)${proved}`
        + (parsed.available ? `, ${parsed.ok} diagram(s) parsed` : ''));
    process.exit(0);
}
if (out === before) {
    console.log(`  architecture diagrams : ${c.size} controls, ${e.size} modules, ${bridged} bridges, in step${proved}`
        + (parsed.available ? `, ${parsed.ok} parsed` : ', not parsed'));
    process.exit(0);
}
console.error('\n  ARCHITECTURE.md is out of step with the sources.');
console.error('  Run: node tools/architecture.mjs\n');
process.exit(1);
