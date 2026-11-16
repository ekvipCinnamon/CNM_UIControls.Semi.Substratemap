#!/usr/bin/env node
/*
 * check-templates.mjs - every subclass template carries its base's root class.
 *
 * ---- THE DEFECT THIS EXISTS FOR ----
 *
 * `SubstrateMapBase.__previnit()` locates the template root by the BASE class
 * name and throws when it is absent. `SubstrateMapWidget` and
 * `SubstrateMapBinChart` shipped carrying only their own class, so both threw
 * the moment they were placed in a view: two of five controls uninstantiable.
 *
 * It escaped 1849 assertions because the attach harness never installs a
 * template root - a limitation its own header declares. **A declared limitation
 * is still a hole**, and the only thing that closes this one is reading the
 * template files.
 *
 * The rule was written down before it was broken: the docstring on `__previnit`
 * states it, citing TcHmiToggleSwitch, whose root carries TcHmiCheckbox's class.
 * Documentation of a rule is not enforcement of it.
 *
 * ---- IT FOLLOWS THE BASE CHAIN, IT DOES NOT ASSUME ONE ----
 *
 * A control declares its base in `Description.json`. This walks that chain
 * through the local descriptors, so a control three deep is checked against the
 * root of the chain rather than against a name written here. A list of "controls
 * that extend the base" is the thing that falls behind - `D-173`, four times.
 *
 * Run:  node tools/check-templates.mjs
 * Exit: 0 clean, 1 violations, 2 the tree is not what it expects.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROLS = join(ROOT, 'Controls');

if (!existsSync(CONTROLS)) {
    console.error('check-templates: no Controls/ directory at ' + ROOT);
    process.exit(2);
}

/* Discovered, never listed. */
const dirs = readdirSync(CONTROLS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(CONTROLS, n, 'Description.json')))
    .sort();

/** Full name -> { dir, base } for every control in this package. */
const byName = new Map();
for (const dir of dirs) {
    const d = JSON.parse(readFileSync(join(CONTROLS, dir, 'Description.json'), 'utf8'));
    const full = `${d.namespace}.${d.name}`;
    byName.set(full, { dir, base: d.base ?? null, name: d.name, namespace: d.namespace });
}

/**
 * The template root class a control must carry.
 *
 * The class of the FURTHEST ancestor still inside this package - which is what
 * `__previnit` searches for, because the search lives on that ancestor and every
 * subclass inherits it verbatim.
 * @param full The control's fully qualified name.
 * @returns The required class, or `null` when the control has no local base.
 */
function requiredRootClass(full) {
    let cur = byName.get(full);
    if (cur === undefined || cur.base === null) { return null; }
    let ancestor = null;
    let guard = 0;
    let at = cur.base;
    while (byName.has(at) && guard++ < 16) {
        ancestor = at;
        at = byName.get(at).base ?? '';
    }
    if (ancestor === null) { return null; }
    const a = byName.get(ancestor);
    return `${a.namespace}.${a.name}-Template`.replace(/\./g, '_');
}

const findings = [];
let checked = 0;

for (const [full, c] of [...byName].sort()) {
    const need = requiredRootClass(full);
    if (need === null) { continue; }          // extends something outside this package
    const file = join(CONTROLS, c.dir, 'Template.html');
    if (!existsSync(file)) {
        findings.push(`Controls/${c.dir}: no Template.html, but it extends ${c.base}`);
        continue;
    }
    const html = readFileSync(file, 'utf8');
    const m = /<[a-zA-Z][^>]*\sclass="([^"]*)"/.exec(html);
    if (m === null) {
        findings.push(`Controls/${c.dir}/Template.html: the root element carries no class attribute`);
        continue;
    }
    const classes = m[1].split(/\s+/).filter(Boolean);
    checked++;
    if (!classes.includes(need)) {
        findings.push(
            `Controls/${c.dir}/Template.html: root needs "${need}" (its base's class, which `
            + `__previnit searches for) but carries [${classes.join(', ')}] — the control throws `
            + 'the moment it is placed in a view');
    }
}

console.log('template roots       : ' + checked + ' control(s) with a base inside this package');
for (const f of findings) { console.log('  [template] ' + f); }
if (findings.length === 0) {
    console.log('OK — every subclass template carries its base\'s root class');
}
process.exit(findings.length > 0 ? 1 : 0);
