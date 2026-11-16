#!/usr/bin/env node
/*
 * check-framework.mjs - is the framework this project compiles against intact?
 *
 * ---- THE FAILURE THIS DIAGNOSES ----
 *
 * A build that reports two hundred errors of these shapes:
 *
 *     Cannot find name 'JQuery'
 *     Cannot find name 'tchmi_equal'
 *     Property 'ValueConverter' does not exist on type 'typeof TcHmi'
 *     Namespace 'global.TcHmi.Controls' has no exported member 'ControlAttributeList'
 *     Property 'System' does not exist on type 'typeof Controls'
 *
 * **Those are one failure, not two hundred.** Every name in that list is declared in
 * the framework package, and none of them is reached directly: `TcHmi.d.ts` is a
 * single line holding a `/// <reference path>`, and the whole surface arrives through
 * a chain of such references. If one link is missing, TypeScript carries on with
 * whatever it did resolve - so `TcHmi` exists, `TcHmi.ValueConverter` does not, and
 * the compiler complains about the members rather than about the file.
 *
 * The word `global.` in `global.TcHmi.Controls` is the tell: the surface is declared
 * inside a `declare global` block, so a partial resolution still yields a `TcHmi` to
 * report members missing from.
 *
 * ---- WHAT IT CHECKS ----
 *
 *   1. which framework versions are actually present under `Packages/`;
 *   2. that each generated `tsconfig.json` includes a `TcHmi.d.ts` THAT EXISTS -
 *      an `include` pattern matching nothing is silently fine to TypeScript;
 *   3. that every `/// <reference path>` in the chain resolves, reporting the first
 *      broken link rather than its consequences.
 *
 *   node tools/check-framework.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';
import { repairFrameworkCasing } from './lib/framework-casing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const findings = [];

/* -------------------------------------------------- 1. what is installed */

const pkgs = join(ROOT, 'Packages');
const versions = existsSync(pkgs)
    ? readdirSync(pkgs).filter((d) => d.startsWith('Beckhoff.TwinCAT.HMI.Framework.'))
    : [];
console.log(`\nframework            : ${versions.length} version(s) under Packages/`);
for (const v of versions) { console.log(`  ${v}`); }
if (versions.length === 0) {
    findings.push('no framework package is restored - run the NuGet restore, then reload the project');
}
if (versions.length > 1) {
    findings.push(`${versions.length} framework versions are present; the generated tsconfig names one `
        + 'of them and the engineering tool may pick another');
}

/* ------------------------------------- 2. the include points at a real file */

/** @param dir Directory to walk. @returns Every generated tsconfig.json. */
function configs(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'Packages' || e.name.startsWith('.')) {
            continue;
        }
        const p = join(dir, e.name);
        if (e.isDirectory()) { configs(p, out); }
        else if (e.name === 'tsconfig.json') { out.push(p); }
    }
    return out;
}

const found = configs(ROOT);
console.log(`\ntsconfig includes    : ${found.length} generated config(s)`);
for (const c of found) {
    const rel = relative(ROOT, c).replace(/\\/g, '/');
    let json;
    try { json = JSON.parse(readFileSync(c, 'utf8')); }
    catch (e) { findings.push(`${rel} is not valid JSON: ${String(e.message).slice(0, 60)}`); continue; }
    for (const inc of json.include ?? []) {
        if (!/TcHmi\.d\.ts$/.test(inc)) { continue; }
        const target = resolve(dirname(c), inc);
        if (!existsSync(target)) {
            findings.push(`${rel} includes "${inc}", which does not exist. **TypeScript treats an `
                + 'include that matches nothing as success**, so the build proceeds without the '
                + 'framework declarations and every TcHmi member is reported missing.');
        }
    }
}
if (findings.length === 0) { console.log('  every TcHmi.d.ts named by an include exists'); }

/* --------------------------------------- 3. the reference chain resolves */

/*
 * The same walk the restore step repairs with (`lib/framework-casing.mjs`), run dry:
 * a link that resolves only when letter case is ignored is NAMED as such, with the
 * command that mends it, because "references JQuery/..., which is not there" sends a
 * reader looking for a missing file that is sitting right beside it.
 */
const walk = repairFrameworkCasing(pkgs, ROOT, true);
const broken = [
    ...walk.repaired.map((r) => `case mismatch: ${r} is needed and absent - on a case-sensitive `
        + 'filesystem the package\'s reference chain breaks here. Run: npm run tsconfig'),
    ...walk.missing,
];
console.log(`\ndeclaration chain    : ${walk.reached} file(s) reached, ${broken.length} broken link(s)`);
/* Printed once, with every other finding, in the verdict below. */
findings.push(...broken);

/* --------------------------------------------------------------- verdict */

for (const f of findings) { console.log(`  [framework] ${f}`); }
if (findings.length === 0) {
    console.log('\n  The framework this project compiles against is intact.');
    console.log('  If the build still fails on TcHmi members, compare this output between the');
    console.log('  machine that builds and the one that does not: the version, the include path');
    console.log('  and the file count are the three things that can differ.\n');
}
process.exit(findings.length > 0 ? 1 : 0);
