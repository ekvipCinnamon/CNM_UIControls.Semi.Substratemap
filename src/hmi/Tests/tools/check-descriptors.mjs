#!/usr/bin/env node
/*
 * check-descriptors.mjs - cross-check Description.json against the TypeScript.
 *
 * A TwinCAT HMI control has two parallel declarations of its own API:
 *
 *   Description.json   what the engineering tool shows, what is bindable from
 *                      a .view, and what getAttributeDefaultValueInternal()
 *                      can answer for
 *   the .ts class      what actually exists at runtime
 *
 * Nothing enforces that these agree. They drift silently and in both
 * directions, and each direction fails differently:
 *
 * THIRD DIRECTION, ADDED AT W-8c. Both of the above compare the descriptor with
 * OUR code. Neither asks whether the descriptor is a legal descriptor at all —
 * that is the framework's `Schema/ControlDescription.Schema.json`, and nothing
 * here had ever read it.
 *
 * It cost a broken live view to notice. `Framework.14.4.5` shipped NO schemas in
 * its NuGet package; `14.5.1` ships nine, and its control-description schema is
 * stricter: `attributeCategories` requires `displayPriority` and forbids
 * `displayName`, a function's parameter list is `params` and not `parameters`,
 * an event's payload list is `arguments` and not `params`, and both functions and
 * events require `heritable`. Our descriptor broke four of those and no gate
 * could see it, because the only thing that reads that schema is the TwinCAT
 * build — on a machine this workspace does not have.
 *
 * The schema is read from `Packages/`, which is supplied per session like `pdf/`
 * and `ref/`. When it is absent the check is reported as skipped rather than
 * passed, for the same reason `check-state` names the archive it could not find.
 *
 *   implemented, not declared   the member works if you call it from code, but
 *                               it is invisible in the engineering tool, not
 *                               bindable, and its default is undefined
 *   declared, not implemented   the engineering tool offers a binding that
 *                               throws or silently does nothing at runtime
 *
 * The second is louder, the first is more insidious. This tool reports both.
 *
 * Usage:  node tools/check-descriptors.mjs [--json]
 * Exit:   0 clean, 1 mismatches found, 2 the tool could not run
 */

import Ajv from 'ajv-draft-04';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/*
 * The controls to check: DISCOVERED, not listed (W-25a).
 *
 * A hard-coded list cannot catch its own omission. `W-25`'s second Done-when
 * asks that removing a registration turn a gate red; with a list, removing this
 * tool's entry for a control simply stops it being checked, and every gate stays
 * green. Measured before the change: four registrations removed one at a time,
 * four times nothing went red.
 *
 * `check-hmiextproj` already discovers its project list and says so in its
 * header. The pattern was there; it had not been applied here.
 */
const CONTROLS = readdirSync(join(ROOT, 'Controls'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: `Controls/${e.name}`, ts: `${e.name}.ts` }))
    .filter((c) => existsSync(join(ROOT, c.dir, 'Description.json')))
    .sort((x, y) => x.dir.localeCompare(y.dir));

/*
 * Public members that are framework lifecycle, not control API. These are
 * never declared in `functions` and must not be reported as undeclared.
 *
 *   __previnit / __init / __attach / __detach   TcHmiControl lifecycle hooks;
 *                                               the `__` prefix is the
 *                                               framework's own convention
 *   destroy                                     TcHmiControl teardown
 *   constructor                                 not a method
 *
 * The rule applied below is: skip `constructor`, and skip anything starting
 * with `__`. `destroy` is listed explicitly because it carries no prefix.
 */
const LIFECYCLE = new Set(['constructor', 'destroy']);

/* ---------------------------------------------------------------------- *
 * Source scanning
 * ---------------------------------------------------------------------- */

/**
 * Strip comments before scanning for members.
 *
 * This codebase is densely JSDoc'd and the docs quote member signatures
 * ("see public setGridData()"). Without this, a documented member counts as an
 * implemented one and the tool reports phantoms. String literals are left
 * alone: a `public setFoo(` inside a string is not a realistic hazard here,
 * and stripping strings correctly needs a real lexer.
 *
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Collect the public surface of a control class.
 *
 * @param {string} src raw TypeScript
 * @returns {{setters: Set<string>, getters: Set<string>, methods: Set<string>}}
 */
function scanSource(src) {
    const clean = stripComments(src);
    const setters = new Set();
    const getters = new Set();
    const methods = new Set();

    const re = /(?:^|\n)\s*public\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/g;
    let m;
    while ((m = re.exec(clean)) !== null) {
        const name = m[1];
        if (LIFECYCLE.has(name) || name.startsWith('__')) { continue; }
        if (/^set[A-Z]/.test(name)) { setters.add(name); }
        else if (/^get[A-Z]/.test(name)) { getters.add(name); }
        else { methods.add(name); }
    }
    return { setters, getters, methods };
}

/* ---------------------------------------------------------------------- *
 * Descriptor reading
 * ---------------------------------------------------------------------- */

/**
 * @param {string} file
 * @returns {{
 *   id: string, base: string|null,
 *   attributes: Array<{propertyName: string, setter: string, getter: string}>,
 *   functions: string[]
 * }}
 */
function readDescriptor(file) {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const attributes = (j.attributes ?? []).map((a) => ({
        propertyName: a.propertyName,
        // Prefer the declared names. A descriptor may legitimately point at a
        // setter whose name is not set+PropertyName, and comparing against the
        // convention instead of the declaration would invent a mismatch.
        setter: a.propertySetterName ?? `set${a.propertyName}`,
        getter: a.propertyGetterName ?? `get${a.propertyName}`,
    }));
    return {
        id: `${j.namespace}.${j.name}`,
        base: typeof j.base === 'string' ? j.base : null,
        attributes,
        functions: (j.functions ?? []).map((f) => f.name),
    };
}

/* ---------------------------------------------------------------------- *
 * Main
 * ---------------------------------------------------------------------- */

const asJson = process.argv.includes('--json');
const report = [];
let problems = 0;

/** id -> descriptor, so a base descriptor's declarations count for its subclass. */
const byId = new Map();
const loaded = [];

for (const c of CONTROLS) {
    const descPath = join(ROOT, c.dir, 'Description.json');
    const tsPath = join(ROOT, c.dir, c.ts);
    if (!existsSync(descPath)) { console.error(`cannot read ${descPath}`); process.exit(2); }
    if (!existsSync(tsPath)) { console.error(`cannot read ${tsPath}`); process.exit(2); }

    const desc = readDescriptor(descPath);
    const src = scanSource(readFileSync(tsPath, 'utf8'));
    byId.set(desc.id, desc);
    loaded.push({ ...c, desc, src });
}

/**
 * Everything declared by a control or by any ancestor descriptor inside this
 * package. A subclass may implement a setter for an attribute its base
 * declares; without walking the chain that reads as undeclared.
 *
 * @param {string} id
 * @returns {{setters: Set<string>, getters: Set<string>, functions: Set<string>, props: Set<string>}}
 */
function declaredWithInherited(id) {
    const setters = new Set(), getters = new Set(), functions = new Set(), props = new Set();
    let cur = byId.get(id);
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        for (const a of cur.attributes) {
            setters.add(a.setter); getters.add(a.getter); props.add(a.propertyName);
        }
        for (const f of cur.functions) { functions.add(f); }
        cur = cur.base ? byId.get(cur.base) : null;
    }
    return { setters, getters, functions, props };
}

for (const { dir, ts, desc, src } of loaded) {
    const inherited = declaredWithInherited(desc.id);
    const entry = { control: desc.id, dir, ts, findings: [] };

    // --- direction 1: declared, not implemented -------------------------
    for (const a of desc.attributes) {
        if (!src.setters.has(a.setter)) {
            entry.findings.push({
                kind: 'attribute-setter-missing',
                name: a.propertyName,
                detail: `Description.json declares propertySetterName "${a.setter}", not found as "public ${a.setter}(" in ${ts}`,
            });
        }
        if (!src.getters.has(a.getter)) {
            entry.findings.push({
                kind: 'attribute-getter-missing',
                name: a.propertyName,
                detail: `Description.json declares propertyGetterName "${a.getter}", not found as "public ${a.getter}(" in ${ts}`,
            });
        }
    }
    for (const f of desc.functions) {
        if (!src.methods.has(f)) {
            entry.findings.push({
                kind: 'function-not-implemented',
                name: f,
                detail: `Description.json functions[] declares "${f}", not found as a public method in ${ts}`,
            });
        }
    }

    // --- direction 2: implemented, not declared -------------------------
    for (const s of [...src.setters].sort()) {
        if (inherited.setters.has(s)) { continue; }
        entry.findings.push({
            kind: 'attribute-not-declared',
            name: s.replace(/^set/, ''),
            detail: `${ts} implements "public ${s}(" but no attribute in Description.json declares it — not bindable, and getAttributeDefaultValueInternal returns undefined`,
        });
    }
    for (const g of [...src.getters].sort()) {
        if (inherited.getters.has(g)) { continue; }
        entry.findings.push({
            kind: 'attribute-getter-not-declared',
            name: g.replace(/^get/, ''),
            detail: `${ts} implements "public ${g}(" but no attribute in Description.json declares it`,
        });
    }
    for (const m of [...src.methods].sort()) {
        if (inherited.functions.has(m)) { continue; }
        entry.findings.push({
            kind: 'function-not-declared',
            name: m,
            detail: `${ts} implements "public ${m}(" but Description.json functions[] does not declare it — not callable from a .view action`,
        });
    }

    problems += entry.findings.length;
    report.push(entry);
}

if (asJson) {
    console.log(JSON.stringify({ ok: problems === 0, problems, report }, null, 2));
    process.exit(problems > 0 ? 1 : 0);
}

/* ------------------------------- the framework's own schema (W-8c) -------- */

/** @returns The newest `ControlDescription.Schema.json` under `Packages/`, or null. */
function frameworkSchemaPath() {
    const pkgRoot = join(ROOT, 'Packages');
    if (!existsSync(pkgRoot)) { return null; }
    const versions = readdirSync(pkgRoot)
        .filter((d) => d.startsWith('Beckhoff.TwinCAT.HMI.Framework.'))
        .sort();
    for (const v of versions.reverse()) {
        const p = join(pkgRoot, v, 'runtimes/native1.12-tchmi/Schema/ControlDescription.Schema.json');
        if (existsSync(p)) { return p; }
    }
    return null;
}

const schemaPath = frameworkSchemaPath();
const schemaFindings = [];
let schemaChecked = 0;
if (schemaPath !== null) {
    const ajv = new Ajv({ allErrors: true, strict: false, validateSchema: false });
    const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
    for (const c of CONTROLS) {
        const p = join(ROOT, c.dir, 'Description.json');
        if (!existsSync(p)) { continue; }
        schemaChecked++;
        if (validate(JSON.parse(readFileSync(p, 'utf8')))) { continue; }
        const seen = new Set();
        for (const e of validate.errors) {
            const where = `${e.instancePath || '/'} ${e.keyword}: ${e.message}`;
            if (seen.has(where)) { continue; }
            seen.add(where);
            schemaFindings.push(`${c.dir}  ${where}`
                + (e.params && Object.keys(e.params).length ? `  ${JSON.stringify(e.params)}` : ''));
        }
    }
}

console.log('descriptor cross-check');
console.log('======================');
for (const e of report) {
    const counts = `${e.findings.length} finding${e.findings.length === 1 ? '' : 's'}`;
    console.log(`\n${e.control}  (${e.dir})  — ${counts}`);
    if (e.findings.length === 0) { console.log('  clean'); continue; }
    for (const f of e.findings) {
        console.log(`  [${f.kind}] ${f.name}`);
        console.log(`      ${f.detail}`);
    }
}
/* ------------------------------------------------------------------------ *
 *  DIRECTION 3 - themes, and no hard-coded colour outside them (W-33)
 *
 *  Folded in here rather than made a thirteenth gate: a theme is part of a
 *  control's DECLARATION, this tool already discovers controls, and the gate
 *  count is a number the protocol states per task.
 *
 *  Three things:
 *    1. every themeable control ships Base and Base-Dark;
 *    2. a variable two controls both set has the SAME value in the same theme -
 *       a wafer that changed colour between a dashboard and a full view would be
 *       the one thing a colour-coded map must never do;
 *    3. no colour literal in control source outside a Themes/ folder, EXCEPT as
 *       the documented fallback of a `read('--var', 'fallback')` call. A control
 *       renders before a stylesheet arrives and the fallback is what it renders
 *       with; a colour anywhere else is a colour no theme can reach.
 * ------------------------------------------------------------------------ */

const themeFindings = [];
const varsByTheme = new Map();          // theme -> Map(varName -> [control, value])

/*
 * The ONE exemption, named rather than pattern-matched so adding another is a
 * visible edit to this file.
 *
 * `DEMO_STATUS_COLORS` is the ekvip Corporate Design Manual palette. Brand
 * colours are not theme colours: a dark theme restyling a corporate palette
 * would be a licensing question, not a styling one, and the manual prescribes
 * these exact values. The demo is design-time placeholder content and the
 * colours belong to the company, not to the panel.
 */
const COLOUR_EXEMPT = [
    { file: 'Controls/SubstrateMapBase/SubstrateMapBase.ts', constant: 'DEMO_STATUS_COLORS' },
];

/**
 * Whether a value names a colour, as opposed to a size or a font.
 *
 * Only COLOURS must agree between controls. A tile deliberately sets a smaller
 * label than a full view - that is a layout decision and the tile is 200 px
 * wide. A wafer that changed COLOUR between a dashboard and a full view would be
 * a lie about the data, which is a different kind of thing entirely.
 * @param value A CSS declaration value.
 * @returns Whether it is a colour.
 */
const isColour = (value) => /^#[0-9a-fA-F]{3,8}$|^rgba?\(|^hsla?\(|^transparent$|^currentColor$/i
    .test(value.trim());

for (const c of CONTROLS) {
    const desc = JSON.parse(readFileSync(join(ROOT, c.dir, 'Description.json'), 'utf8'));
    const themeable = String(desc.themeable ?? 'None');
    const dir = join(ROOT, c.dir, 'Themes');
    const present = existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
        : [];
    if (themeable !== 'None') {
        /*
         * The file has to NAME THE CONTROL, not merely exist. A `Style.css` under
         * the right folder that sets no rule for the control's own class does
         * nothing at all, and an existence check reports it as a theme - which is
         * how a control comes to ship two empty stylesheets and look themed.
         *
         * Found by a mutation that renamed the selector and was MISSED.
         */
        const selector = '.TcHmi_Controls_' + String(desc.namespace ?? '').replace(/\./g, '_')
            .replace(/^TcHmi_Controls_/, '') + '_' + String(desc.name ?? '');
        for (const want of ['Base', 'Base-Dark']) {
            const file = join(dir, want, 'Style.css');
            if (!present.includes(want) || !existsSync(file)) {
                themeFindings.push(`${c.dir}: themeable "${themeable}" but no Themes/${want}/Style.css`);
                continue;
            }
            if (!readFileSync(file, 'utf8').includes(selector)) {
                themeFindings.push(`${c.dir}: Themes/${want}/Style.css sets no rule for `
                    + `${selector} — it is a file, not a theme`);
            }
        }
    }
    for (const theme of present) {
        const file = join(dir, theme, 'Style.css');
        if (!existsSync(file)) { continue; }
        const css = readFileSync(file, 'utf8');
        const seen = varsByTheme.get(theme) ?? new Map();
        varsByTheme.set(theme, seen);
        for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
            const name = m[1];
            const value = m[2].trim();
            const prior = seen.get(name);
            if (prior === undefined) { seen.set(name, [c.dir, value]); continue; }
            if (prior[1] !== value && isColour(value) && isColour(prior[1])) {
                themeFindings.push(`${theme}: ${name} is "${prior[1]}" in ${prior[0]} `
                    + `and "${value}" in ${c.dir} — a shared COLOUR must not drift`);
            }
        }
    }

    /* ---- the grep Done-when 2 asks for ---- */
    for (const f of readdirSync(join(ROOT, c.dir))) {
        if (!f.endsWith('.ts') && !f.endsWith('.css')) { continue; }
        const rel = `${c.dir}/${f}`;
        const exempt = COLOUR_EXEMPT.filter((x) => x.file === rel).map((x) => x.constant);
        const src = readFileSync(join(ROOT, c.dir, f), 'utf8');
        const lines = src.split(/\r?\n/);
        let inBlockComment = false;
        let inExempt = null;
        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            // Comments are prose and may name a colour while explaining one.
            if (inBlockComment) {
                if (line.includes('*/')) { inBlockComment = false; line = line.slice(line.indexOf('*/') + 2); }
                else { continue; }
            }
            if (line.includes('/*')) {
                if (!line.includes('*/')) { inBlockComment = true; }
                line = line.slice(0, line.indexOf('/*'));
            }
            line = line.replace(/\/\/.*/, '');
            // An exempt constant runs from its declaration to the closing brace.
            if (inExempt !== null) {
                if (/^\s*\};/.test(line)) { inExempt = null; }
                continue;
            }
            const opens = exempt.find((name) => new RegExp(`\\b${name}\\b`).test(line)
                && /[:=]\s*\{\s*$/.test(line));
            if (opens !== undefined) { inExempt = opens; continue; }
            if (!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) { continue; }
            // A documented theme fallback: `read('--var', 'colour')`.
            if (/read\(\s*'--[a-z0-9-]+'\s*,/.test(line)) { continue; }
            themeFindings.push(`${c.dir}/${f}:${i + 1}: colour outside a theme file — `
                + `${line.trim().slice(0, 60)}`);
        }
    }
}

console.log('\n----------------------');
console.log(`themes                : ${[...varsByTheme.keys()].sort().join(', ') || 'none'}`);
for (const [theme, seen] of [...varsByTheme].sort()) {
    const colours = [...seen.values()].filter(([, v]) => isColour(v)).length;
    console.log(`  ${theme}: ${seen.size} variables, ${colours} of them colours`);
}
console.log(`  colour literals outside a theme: ${COLOUR_EXEMPT.length} exempt `
    + `(${COLOUR_EXEMPT.map((x) => x.constant).join(', ')}), the rest forbidden`);
for (const f of themeFindings) { console.log(`  [theme] ${f}`); }

console.log('\n----------------------');
if (schemaPath === null) {
    console.log('framework schema      : NOT PRESENT — Packages/ carries no');
    console.log('  ControlDescription.Schema.json, so nothing checked whether these are legal');
    console.log('  descriptors at all. Framework 14.4.5 shipped none; 14.5.1 does.');
} else {
    console.log(`framework schema      : ${schemaPath.split('Packages/')[1]}`);
    console.log(`  descriptors validated: ${schemaChecked}`);
    for (const f of schemaFindings) { console.log(`  [not-a-legal-descriptor] ${f}`); }
}

const total = problems + schemaFindings.length + themeFindings.length;
console.log('\n======================');
if (total === 0) {
    console.log('OK — descriptors and implementations agree, and the framework accepts them');
} else {
    console.log(`${problems} mismatch${problems === 1 ? '' : 'es'}`
        + `, ${schemaFindings.length} schema violation${schemaFindings.length === 1 ? '' : 's'}`);
}
/* --------- the German localisation is in step (F-22, D-252) ----------------- */

/*
 * Delegated to `tools/localization.mjs --check` rather than reimplemented: the
 * generator and the checker must agree about which descriptor strings are
 * localisable, and two implementations of that rule would be the second copy the
 * generator exists to avoid - the same reasoning as `D-243`.
 */
const localizationFindings = [];
{
    const r = spawnSync(process.execPath, [join(ROOT, 'tools/localization.mjs'), '--check'],
        { encoding: 'utf8' });
    if (r.status !== 0) {
        localizationFindings.push(String(r.stderr || r.stdout).trim().split('\n')
            .map((l) => l.trim()).filter(Boolean).join(' | '));
        for (const f of localizationFindings) { console.log(`  [localization] ${f}`); }
    } else {
        console.log(String(r.stdout).trimEnd());
    }
}

process.exit(total + localizationFindings.length > 0 ? 1 : 0);
