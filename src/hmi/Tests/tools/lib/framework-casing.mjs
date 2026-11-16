/*
 * framework-casing.mjs - repair the case mismatches in the restored framework.
 *
 * ---- THE DEFECT ----
 *
 * Beckhoff's `Lib/jquery.d.ts` starts with
 *
 *     /// <reference path="JQuery/JQueryStatic.d.ts" />
 *
 * and the package ships the directory as `Lib/jQuery`. On Windows and on a default
 * macOS volume those are one directory. **On Linux they are two, and the second
 * does not exist**, so the JQuery declarations never load and every control fails
 * with `Cannot find name 'JQuery'`. The GitLab runner is Linux. The defect is in the
 * package, not in this repository, and it deserves a ticket with Beckhoff; until it
 * is fixed there, it is repaired here, after every restore.
 *
 * ---- THE REPAIR ----
 *
 * Follow the `/// <reference path>` chain from each runtime's `TcHmi.d.ts`, exactly as
 * the compiler does. For a link that does not resolve, resolve it again one path
 * segment at a time, ignoring case. If that succeeds, the link is a CASE mismatch:
 * a symbolic link with the referenced spelling is created beside the real entry -
 * `Lib/JQuery -> jQuery` - and the walk continues through it. If it fails, the file
 * is genuinely missing, and that is reported, not repaired.
 *
 * A symbolic link and not a rename, because the package's own runtime loads
 * `Lib/jQuery/...` by the spelling it ships, and both must keep working. On a
 * case-insensitive filesystem every link resolves on the first try and this does
 * nothing at all, which is the point: one restore step for every machine.
 *
 * Generic on purpose. It knows nothing about jQuery; the next casing slip in a future
 * framework version is repaired by the same walk.
 */

import { existsSync, readdirSync, readFileSync, symlinkSync, lstatSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';

/**
 * Resolves `rel` from `base` one segment at a time, ignoring case where the exact
 * spelling is absent.
 * @param base An absolute directory.
 * @param rel  A relative path, `/`-separated.
 * @returns `{ fixes, path }` - the case mismatches met on the way and the real path
 *          they lead to - or `null` if some segment does not exist in any case.
 */
function caseInsensitive(base, rel) {
    const fixes = [];
    let at = base;
    for (const seg of rel.split('/')) {
        if (seg === '' || seg === '.') { continue; }
        if (seg === '..') { at = dirname(at); continue; }
        const exact = join(at, seg);
        if (existsSync(exact)) { at = exact; continue; }
        if (!existsSync(at)) { return null; }
        const hit = readdirSync(at).find((e) => e.toLowerCase() === seg.toLowerCase());
        if (hit === undefined) { return null; }
        fixes.push({ dir: at, wanted: seg, actual: hit });
        at = join(at, hit);
    }
    return { fixes, path: at };
}

/**
 * Walks every framework runtime under `packagesDir` and, unless `dryRun`, links each
 * case mismatch into existence.
 * @param packagesDir The restored `Packages/` directory.
 * @param root        Paths in the result are relative to this.
 * @param dryRun      Report without creating anything.
 * @returns `{ repaired, missing, reached }` - `repaired` as `dir/wanted -> actual`,
 *          each link created now (or, in a dry run, one that would be).
 */
export function repairFrameworkCasing(packagesDir, root, dryRun = false) {
    const repaired = [];
    const missing = [];
    const seen = new Set();
    const rel = (p) => relative(root, p).split(sep).join('/');
    const follow = (file) => {
        if (seen.has(file) || !existsSync(file)) { return; }
        seen.add(file);
        for (const m of readFileSync(file, 'utf8').matchAll(/\/\/\/\s*<reference\s+path=["']([^"']+)["']/g)) {
            const target = resolve(dirname(file), m[1]);
            if (existsSync(target)) { follow(target); continue; }
            const found = caseInsensitive(dirname(file), m[1].replace(/\\/g, '/'));
            if (found === null) {
                missing.push(`${rel(file)} references "${m[1]}", which is not there in any case`);
                continue;
            }
            for (const f of found.fixes) {
                const link = join(f.dir, f.wanted);
                let present = false;
                try { lstatSync(link); present = true; } catch { /* not there yet */ }
                if (present) { continue; }
                if (!dryRun) {
                    symlinkSync(f.actual, link, statSync(join(f.dir, f.actual)).isDirectory() ? 'dir' : 'file');
                }
                const line = `${rel(link)} -> ${f.actual}`;
                if (!repaired.includes(line)) { repaired.push(line); }
            }
            follow(dryRun ? found.path : target);
        }
    };
    if (existsSync(packagesDir)) {
        for (const v of readdirSync(packagesDir).filter((d) => d.startsWith('Beckhoff.TwinCAT.HMI.Framework.'))) {
            const rt = join(packagesDir, v, 'runtimes');
            if (!existsSync(rt)) { continue; }
            for (const r of readdirSync(rt)) { follow(join(rt, r, 'TcHmi.d.ts')); }
        }
    }
    return { repaired, missing, reached: seen.size };
}
