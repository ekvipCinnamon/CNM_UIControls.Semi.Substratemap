#!/usr/bin/env node
/*
 * tsconfig-from-templates.mjs - write the `tsconfig.json` files from their templates.
 *
 * ---- WHAT THE THREE FILES ARE ----
 *
 *   tsconfig.tpl.json   TRACKED. The source of truth. Version-agnostic: it refers to
 *                       the framework as `$(Beckhoff.TwinCAT.HMI.Framework).InstallPath`.
 *   tsconfig.json       GENERATED, and not tracked. The same file with that token
 *                       replaced by the real, VERSIONED path of the restored package -
 *                       `Packages/Beckhoff.TwinCAT.HMI.Framework.14.5.1/runtimes/…`.
 *   tsconfig.base.json  TRACKED. The compiler options every project shares, so
 *                       `strict` and the module settings are stated once. Every
 *                       template `extends` it. It is NOT part of the Beckhoff layout;
 *                       it was added here, and it must be committed or nothing builds.
 *
 * ---- WHY GENERATING IT IS NOT ENOUGH ON ITS OWN ----
 *
 * The TwinCAT build performs that substitution, so `tsconfig.json` is correctly
 * treated as build output and correctly ignored. But **the TwinCAT build is not the
 * only thing that reads it**: `typecheck.sh` and every `tsc -p …/tsconfig.json` in
 * `npm run gate` read the generated file and none of them writes it. On a fresh
 * clone with the file ignored, the engineering tool can build and the test gate
 * cannot, which is exactly the state a colleague ends up in.
 *
 * So this exists: the same substitution, without XAE, before the gate runs.
 *
 *   node tools/tsconfig-from-templates.mjs
 *   node tools/tsconfig-from-templates.mjs --check    exit 1 if any is missing or stale
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { repairFrameworkCasing } from './lib/framework-casing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const TOKEN = '$(Beckhoff.TwinCAT.HMI.Framework).InstallPath';

/**
 * The restored framework, found rather than assumed - the version is part of the
 * directory name and changes with every upgrade, which is the whole reason the
 * template carries a token instead of a path.
 * @returns The path from the repository root, or null.
 */
function frameworkPath() {
    const pkgs = join(ROOT, 'Packages');
    if (!existsSync(pkgs)) { return null; }
    const dir = readdirSync(pkgs)
        .filter((d) => d.startsWith('Beckhoff.TwinCAT.HMI.Framework.'))
        .sort()
        .pop();
    if (dir === undefined) { return null; }
    const runtimes = join(pkgs, dir, 'runtimes');
    if (!existsSync(runtimes)) { return null; }
    const rt = readdirSync(runtimes).sort().pop();
    return rt === undefined ? null : `Packages/${dir}/runtimes/${rt}`;
}

/** @param dir Absolute directory. @returns Every `tsconfig.tpl.json` beneath ROOT. */
function templates(dir, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'Packages' || e.name.startsWith('.')) {
            continue;
        }
        const p = join(dir, e.name);
        if (e.isDirectory()) { templates(p, out); }
        else if (e.name === 'tsconfig.tpl.json') { out.push(p); }
    }
    return out;
}

const fw = frameworkPath();
if (fw === null) {
    console.error('\n  No Beckhoff.TwinCAT.HMI.Framework.* under Packages/.');
    console.error('  Restore the package, or extract FrameworkStub.tar, before building.\n');
    process.exit(2);
}

/*
 * THE CASE REPAIR (H-9) runs first, because the tsconfig it writes is only as good as
 * the framework it points at. On Linux the restored package has a reference chain
 * that breaks on letter case (`lib/framework-casing.mjs`); this is the restore step
 * that mends it, so no machine needs a step of its own. With `--check` it repairs
 * nothing and fails if a repair is due.
 */
const casing = repairFrameworkCasing(join(ROOT, 'Packages'), ROOT, CHECK);

const stale = [];
let written = 0;
if (CHECK) {
    for (const r of casing.repaired) { stale.push(`the framework needs a case link: ${r}`); }
} else if (casing.repaired.length > 0) {
    console.log(`  linked ${casing.repaired.length} case mismatch(es) in the restored framework:`);
    for (const r of casing.repaired) { console.log(`    ${r}`); }
}
for (const m of casing.missing) { console.log(`  [framework] ${m}`); }
for (const tpl of templates(ROOT)) {
    const out = tpl.replace(/tsconfig\.tpl\.json$/, 'tsconfig.json');
    /*
     * The token stands where a path relative to THIS project must go, so the depth
     * of the project decides how many `../` the substitution needs.
     */
    const depth = relative(dirname(tpl), ROOT).split(sep).filter((s) => s === '..').length;
    /*
     * At the root the substitution is the bare path: the template already writes
     * `"./$(…)"` where it wants a leading `./`, so adding another produced `././`.
     * The engineering tool's own output was the reference - the control projects
     * come out byte-identical, and this is what made the root match too.
     */
    const prefix = '../'.repeat(depth);
    const body = readFileSync(tpl, 'utf8').split(TOKEN).join(`${prefix}${fw}`);
    if (CHECK) {
        if (!existsSync(out)) {
            stale.push(`${relative(ROOT, out).replace(/\\/g, '/')} is missing`);
        } else if (readFileSync(out, 'utf8') !== body) {
            stale.push(`${relative(ROOT, out).replace(/\\/g, '/')} does not match its template`);
        }
        continue;
    }
    writeFileSync(out, body, 'utf8');
    written++;
}

if (CHECK) {
    if (stale.length > 0) {
        console.error('\n  the restore is incomplete - tsconfig.json files missing or stale, or a case link due:');
        for (const s of stale) { console.error(`    ${s}`); }
        console.error('  Run: node tools/tsconfig-from-templates.mjs\n');
        process.exit(1);
    }
    console.log(`  tsconfig files        : generated from templates, in step (${fw})`);
    process.exit(0);
}
console.log(`  wrote ${written} tsconfig.json from templates, against ${fw}`);
process.exit(0);
