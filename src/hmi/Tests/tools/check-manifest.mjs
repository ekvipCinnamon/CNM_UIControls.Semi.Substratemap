#!/usr/bin/env node
/*
 * check-manifest.mjs - verify every dataTypes[].schema path in Manifest.json
 * resolves to a file that is actually there, matching case exactly.
 *
 * Why not just fs.existsSync()
 * ---------------------------
 * Because it would not have caught this. The package is developed on Windows,
 * whose filesystem is case-insensitive: existsSync('…/ItemList.schema.json')
 * returns true even though the file is named ItemList.Schema.json. Every
 * developer machine says the manifest is fine. The mismatch only surfaces
 * where lookups are case-sensitive - a Linux build agent, or a web server
 * resolving the path literally when the HMI asks for the type definition - at
 * which point the data type silently fails to register and a bound attribute
 * loses its schema with no obvious cause.
 *
 * So this tool does not ask the filesystem whether a path exists. It walks the
 * path one segment at a time, lists each directory, and requires an exact
 * string match. That behaves identically on Windows, macOS and Linux, which is
 * the entire point: the check has to fail on the machine where the code is
 * written, not only on the one where it is deployed.
 *
 * When a segment does not match exactly but does match case-insensitively, the
 * report names the real spelling, so fixing the manifest is mechanical.
 *
 * Usage:  node tools/check-manifest.mjs [--json]
 * Exit:   0 all paths hit, 1 one or more misses, 2 the tool could not run
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import Ajv from 'ajv-draft-04';
import { requireInput, reportSkippedTool } from './external-inputs.mjs';

/** Non-zero when --strict turned an absent protocol into a failure. */
let PROTOCOL_SKIPPED = 0;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MANIFEST = join(ROOT, 'Manifest.json');
const PROJ = join(ROOT, 'SubstrateMap.hmiextproj');

/**
 * Case-sensitive existence check, performed segment by segment.
 *
 * @param {string} relPath  path relative to the repo root, POSIX or Windows separators
 * @returns {{ok: true} | {ok: false, failedAt: string, expected: string, actual: string|null}}
 */
function caseSensitiveExists(relPath) {
    const segments = relPath.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
    let dir = ROOT;

    for (let i = 0; i < segments.length; i++) {
        const want = segments[i];
        let entries;
        try {
            entries = readdirSync(dir);
        } catch {
            return {
                ok: false,
                failedAt: segments.slice(0, i).join('/') || '.',
                expected: want,
                actual: null,
            };
        }

        if (entries.includes(want)) {
            dir = join(dir, want);
            continue;
        }

        // No exact match. Is there one that differs only in case? That is the
        // interesting failure, and the one worth naming precisely.
        const lower = want.toLowerCase();
        const near = entries.find((e) => e.toLowerCase() === lower) ?? null;
        return {
            ok: false,
            failedAt: segments.slice(0, i).join('/') || '.',
            expected: want,
            actual: near,
        };
    }

    // Every segment matched. Require the leaf to be a file, not a directory.
    try {
        if (!statSync(dir).isFile()) {
            return { ok: false, kind: 'not-a-file', failedAt: relPath };
        }
    } catch {
        return { ok: false, kind: 'unreadable', failedAt: relPath };
    }
    return { ok: true };
}

/* ---------------------------------------------------------------------- */

const asJson = process.argv.includes('--json');

if (!existsSync(MANIFEST)) {
    console.error(`cannot read ${MANIFEST}`);
    process.exit(2);
}

let manifest;
try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
} catch (e) {
    console.error(`Manifest.json is not valid JSON: ${e.message}`);
    process.exit(2);
}

const dataTypes = manifest.dataTypes ?? [];
const results = [];

for (const entry of dataTypes) {
    const p = entry?.schema;
    if (typeof p !== 'string' || p === '') {
        results.push({ path: String(p), hit: false, reason: 'dataTypes entry has no schema path' });
        continue;
    }
    const r = caseSensitiveExists(p);
    if (r.ok) {
        results.push({ path: p, hit: true });
    } else if (r.kind === 'not-a-file') {
        results.push({ path: p, hit: false, reason: `resolves to a directory, not a file` });
    } else if (r.kind === 'unreadable') {
        results.push({ path: p, hit: false, reason: `resolved but could not be read` });
    } else if (r.actual && r.actual !== r.expected) {
        results.push({
            path: p,
            hit: false,
            reason: `case mismatch in "${r.failedAt}": manifest says "${r.expected}", on disk it is "${r.actual}"`,
            suggestion: r.actual,
        });
    } else {
        results.push({
            path: p,
            hit: false,
            reason: `not found: no "${r.expected}" under "${r.failedAt}"`,
        });
    }
}

const hits = results.filter((r) => r.hit).length;
const misses = results.length - hits;

if (asJson) {
    console.log(JSON.stringify({ ok: misses === 0, hits, misses, results }, null, 2));
    process.exit(misses > 0 ? 1 : 0);
}


/* ------------------------------------------------------------------------ *
 *  DIRECTION 2 - every control is REGISTERED, everywhere it has to be (W-25a)
 *
 *  A control needs six things to exist, and until `W-25a` only two of them were
 *  checked. Measured by removing each in turn: Manifest `modules`,
 *  `check-descriptors`, `check-readme` and the gate script were all invisible -
 *  four registrations removed, four times nothing went red.
 *
 *  The first two are fixed at their source: those tools DISCOVER controls now
 *  rather than listing them, so they cannot omit one. The other two are checked
 *  here, because nothing else reads them.
 *
 *  Why it matters: a control absent from `modules` does not appear in the
 *  engineering tool at all, and one absent from the gate script is never
 *  typechecked. Both fail silently and both fail on someone else's machine -
 *  which is the "nearly missed dependency" the protocol records.
 * ------------------------------------------------------------------------ */

const controls = readdirSync(join(ROOT, 'Controls'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((n) => existsSync(join(ROOT, 'Controls', n, 'Description.json')))
    .sort();

const modulePaths = new Set((manifest.modules ?? [])
    .filter((m) => m.type === 'Control')
    .map((m) => String(m.basePath ?? '').replace(/^\.\//, '').replace(/\/$/, '')));

const gateScript = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts?.gate ?? '');
/*
 * The protocol ships in neither archive (F-2). Its absence must not crash a
 * checker whose other two directions are perfectly checkable: it gates the
 * gate-list assertion and nothing else, so that one direction skips and the
 * rest of the file runs. Under --strict the absence is a failure.
 */
let protocol = null;
try {
    protocol = readFileSync(requireInput('SubstrateMap-Working-Protocol.md'), 'utf8');
} catch (e) {
    if (e.code !== 'MISSING_EXTERNAL_INPUT') { throw e; }
    PROTOCOL_SKIPPED = reportSkippedTool(e.file,
        ['the gate list in package.json matches the one the protocol prints']);
}

const registration = [];
for (const name of controls) {
    const dir = `Controls/${name}`;
    if (!modulePaths.has(dir)) {
        registration.push(`${name}: no Control entry in Manifest.json modules — it will not appear in the engineering tool`);
    }
    const tsc = `tsc -p ${dir}/tsconfig.json`;
    if (!gateScript.includes(tsc)) {
        registration.push(`${name}: no "${tsc}" in the package.json gate script — it is never typechecked`);
    }
    // Skipped, not assumed true, when the protocol is absent (F-2).
    if (protocol !== null && !protocol.includes(tsc)) {
        registration.push(`${name}: no "${tsc}" in the Working Protocol gate block — the per-task list is short`);
    }
}

console.log('');
console.log(`control registration: ${controls.length} control(s) discovered`);
console.log('-'.repeat(60));
for (const name of controls) { console.log(`  ${name}`); }
if (registration.length > 0) {
    console.log('');
    for (const r of registration) { console.log(`  [unregistered] ${r}`); }
}

console.log('manifest dataTypes path check');
console.log('=============================');
console.log(`(case-sensitive on every platform — not fs.existsSync)\n`);
for (const r of results) {
    if (r.hit) {
        console.log(`  HIT   ${r.path}`);
    } else {
        console.log(`  MISS  ${r.path}`);
        console.log(`        ${r.reason}`);
    }
}
/*
 * THE OTHER DIRECTION, which the first version did not check.
 *
 * Every path in the manifest resolving to a file says nothing about a schema that
 * SHIPS and is not listed - and five of them did exactly that, registered in
 * SubstrateMap.hmiextproj and invisible here, until the user noticed while merging
 * a Manifest by hand. A control whose type is not in `dataTypes` gets no editor
 * support and no validation, and nothing said so.
 *
 * `.hmiextproj` is the reference for "ships", because `check-hmiextproj.mjs`
 * already holds it to the filesystem in both directions.
 */
const norm = (p) => String(p).split('\\').join('/');
const listed = new Set(dataTypes.map((e) => norm(e.schema)));
const orphans = [];
const projText = existsSync(PROJ) ? readFileSync(PROJ, 'utf8') : '';
for (const m of projText.matchAll(/Include="([^"]*?\.Schema\.json)"/g)) {
    const p = norm(m[1]);
    // Only a CONTROL's type definitions belong in `dataTypes`. `Properties/` holds
    // the framework's own config schema, which is not a bindable type.
    if (!p.startsWith('Controls/')) { continue; }
    if (!listed.has(p)) { orphans.push(p); }
}

console.log('\n=============================');
console.log(`${hits} hit${hits === 1 ? '' : 's'}, ${misses} miss${misses === 1 ? '' : 'es'}`);
if (orphans.length > 0) {
    console.log(`\n${orphans.length} schema${orphans.length === 1 ? '' : 's'} SHIP but are not in dataTypes:`);
    for (const p of orphans) { console.log(`  ORPHAN  ${p}`); }
    console.log('        A type absent from dataTypes gets no editor support and no validation.');
}
/* ------------------------------------------------------------------------ *
 *  DIRECTION 3 - one version, in every place that states one
 *
 *  The 2.0 release notes recorded fixing exactly this: `Description.json` said
 *  0.1.0.0 and the nuspec said 1.0.0.0. It came back - and worse, the 4.0.0.0
 *  notes CLAIMED a gate prevented it while no such gate existed. A claim in
 *  shipped documentation about a check that is not there is worse than the drift
 *  it describes, because it tells a reader not to look.
 *
 *  Three things must agree: the nuspec's <version>, every control's
 *  Description.json, and the version the release notes LEAD with - stale notes
 *  on a fresh package are how a consumer reads last release's breaking changes
 *  and misses this one's.
 * ------------------------------------------------------------------------ */

const versionFindings = [];
{
    const nuspec = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
    const declared = /<version>([^<]+)<\/version>/.exec(nuspec)?.[1]?.trim() ?? null;
    if (declared === null) {
        versionFindings.push('SubstrateMap.nuspec declares no <version>');
    } else {
        for (const c of controls) {
            const d = JSON.parse(readFileSync(join(ROOT, 'Controls', c, 'Description.json'), 'utf8'));
            const full = d.version?.full ?? '(none)';
            if (full !== declared) {
                versionFindings.push(`Controls/${c}: Description.json says ${full}, `
                    + `the nuspec says ${declared}`);
            }
        }
        const notes = /<releaseNotes>([\s\S]*?)<\/releaseNotes>/.exec(nuspec)?.[1] ?? '';
        const leads = /(\d+\.\d+\.\d+\.\d+)/.exec(notes)?.[1] ?? '(none)';
        if (leads !== declared) {
            versionFindings.push(`the release notes lead with ${leads}, but the package is `
                + `${declared} — the notes are stale`);
        }
    }
}
console.log('\n----------------------');
console.log('version consistency   : the nuspec, every descriptor, and the release notes');
for (const f of versionFindings) { console.log(`  [version] ${f}`); }
if (versionFindings.length === 0) { console.log('  all agree'); }

/* --------- every visible control has a toolbox category (F-13, D-240) ------ */

/*
 * `toolboxCategory` is a MANIFEST field, not a descriptor one. The review named it
 * and the task repeated the name; the framework's ControlDescription schema has no
 * such property and sets `additionalProperties: false`, so putting it there would
 * have turned check-descriptors red rather than placing a control in the toolbox.
 *
 * All five module entries carried `""`. Meanwhile `provideMetadata.toolbox` already
 * DECLARED the category - `SubstrateMap` - and nothing referenced it. Two halves of
 * one declaration, and nothing compared them.
 *
 * A control that is `visible: false` is never in the toolbox, so it must NOT carry
 * one; that is why this reads the descriptor rather than assuming.
 */
const toolboxFindings = [];
{
    const manifest = JSON.parse(readFileSync(join(ROOT, 'Manifest.json'), 'utf8'));
    /*
     * A CATEGORY IS A NUMBER, NOT A GROUP NAME (`G-2`, `D-263`).
     *
     * `provideMetadata.toolbox` is `{ group: { "<number>": name } }` - the schema
     * says "Dictionary of category groups" then "Dictionary of category names. Key
     * has to be a number." The group is a namespace for DEFINING numbers; a control
     * selects one by its number, which is the only reading under which a control can
     * pick 210 rather than 200 when a group declares several.
     *
     * `F-13` compared against the GROUP names, because the manifest then had one
     * group declaring one category and both were called `SubstrateMap` - a case where
     * the right answer and the wrong answer are the same string. The check caught
     * this task's own change, which is the first evidence it was ever discriminating.
     */
    const toolbox = manifest.provideMetadata?.toolbox ?? {};
    const declared = Object.values(toolbox).flatMap((g) => Object.keys(g ?? {}));
    for (const mod of manifest.modules ?? []) {
        if (mod.type !== 'Control') { continue; }
        const name = String(mod.basePath).split('/').pop();
        const descPath = join(ROOT, 'Controls', name, mod.descriptionFile ?? 'Description.json');
        if (!existsSync(descPath)) { continue; }
        const visible = JSON.parse(readFileSync(descPath, 'utf8')).visible === true;
        const cat = mod.toolboxCategory ?? '';
        if (visible && cat === '') {
            toolboxFindings.push(`${name} is visible and has no toolboxCategory - it lands in the `
                + 'designer toolbox with no home');
        }
        if (!visible && cat !== '') {
            toolboxFindings.push(`${name} is visible: false and carries a toolboxCategory `
                + `"${cat}" - it is never in the toolbox`);
        }
        if (cat !== '' && !declared.includes(cat)) {
            toolboxFindings.push(`${name} names toolbox category "${cat}", which no group in `
                + `provideMetadata.toolbox declares (declared: ${declared.join(', ') || 'none'})`);
        }
    }
    /*
     * The name is reported alongside the number, because "210" alone tells a reader
     * nothing about what they are shipping into.
     */
    const label = (n) => {
        for (const g of Object.values(toolbox)) {
            const v = g?.[n];
            if (typeof v === 'string') { return v; }
            if (v !== null && typeof v === 'object') { return v.default ?? '(no default)'; }
        }
        return '?';
    };
    console.log(`\ntoolbox categories   : ${declared.map((n) => `${n} ${label(n)}`).join(', ') || 'none declared'}`);
    for (const f of toolboxFindings) { console.log(`  [toolbox] ${f}`); }
    if (toolboxFindings.length === 0) { console.log('  every visible control has a declared category'); }
}


/* --------- every path the nuspec names exists (G-1, D-261) ------------------ */

/*
 * The nuspec has declared `<icon>images/logo.png</icon>` and listed it in `<files>`
 * since the package was written, and **the file did not exist**. `nuget pack` fails
 * on a missing icon, so the package could not be built - a shipping blocker sitting
 * in plain sight, in a manifest nothing validated against the disk.
 *
 * `F-8` taught `check-readme` that a document may only name paths the package
 * carries. This is the same rule pointed the other way: the packaging manifest may
 * only name paths that EXIST. A `<file src>` glob is allowed to match nothing - a
 * pattern is a filter, not a promise - but a literal path is a promise.
 */
/* --------- Manifest.json against the framework's own schema (D-288) --------- */

/*
 * `G-9a` removed two properties by name because the engineering tool rejected them.
 * The framework ships a schema that says so itself, and this checker was not using
 * it - so the rule was two hand-written strings where a specification exists.
 *
 * The two are real properties, in the wrong FILE. `TchmiConfig.Schema.json` allows a
 * theme `resources`, `replacesThemeForControls` and `replacesThemeForPackageComponents`;
 * `Manifest.Schema.json` allows a theme **`resources` and nothing else**, with
 * `additionalProperties: false`. Something in the build writes the config's shape into
 * the manifest, and the manifest is where it is illegal.
 *
 * Validating against the shipped schema catches that and whatever else arrives with
 * it, which two names never could.
 */
const schemaFindings = [];
{
    const dir = join(ROOT, 'Packages');
    const fw = existsSync(dir)
        ? readdirSync(dir).filter((d) => d.startsWith('Beckhoff.TwinCAT.HMI.Framework.')).sort().pop()
        : undefined;
    const sp = fw === undefined ? null
        : join(dir, fw, 'runtimes', 'native1.12-tchmi', 'Schema', 'Manifest.Schema.json');
    if (sp === null || !existsSync(sp)) {
        console.log('\nmanifest schema      : the framework schema is not restored - not checked');
    } else {
        const schema = JSON.parse(readFileSync(sp, 'utf8'));
        delete schema.$schema;
        const validate = new Ajv({ strict: false, allErrors: true }).compile(schema);
        if (!validate(manifest)) {
            for (const e of validate.errors ?? []) {
                schemaFindings.push(`Manifest.json${e.instancePath} ${e.message}`);
            }
        }
        console.log(`\nmanifest schema      : validated against ${fw}`);
        for (const f of [...new Set(schemaFindings)].slice(0, 6)) {
            console.log(`  [manifest-schema] ${f}`);
        }
        if (schemaFindings.length === 0) { console.log("  it satisfies the framework's own schema"); }
    }
}

/* --------- an empty optional array is worse than none (G-9a, D-275) --------- */

/*
 * `replacesThemeForControls: []` and `replacesThemeForPackageComponents: []` were
 * written into both theme entries, and the TwinCAT engineering tool rejects them.
 * The user deleted them by hand TWICE - once per archive - because every rebuild
 * put them back.
 *
 * An empty array here is not "no replacements"; it is a declaration that the theme
 * replaces something, followed by nothing. Omitting the member says the same thing
 * and is accepted. The rule is general enough to be worth stating: an OPTIONAL
 * member whose value carries no information should be absent.
 */
const emptyArrayFindings = [];
for (const [name, theme] of Object.entries(manifest.themes ?? {})) {
    for (const k of ['replacesThemeForControls', 'replacesThemeForPackageComponents']) {
        if (Array.isArray(theme?.[k]) && theme[k].length === 0) {
            emptyArrayFindings.push(`themes.${name}.${k} is an empty array - the engineering `
                + 'tool rejects it. Omit the member instead.');
        }
    }
}
console.log(`\nempty optional arrays : ${Object.keys(manifest.themes ?? {}).length} theme(s) checked`);
for (const f of emptyArrayFindings) { console.log(`  [manifest] ${f}`); }
if (emptyArrayFindings.length === 0) { console.log('  none declared and left empty'); }

/* --------- the source's PACKAGE_NAME is the nuspec's id (G-13a, D-283) ------ */

/*
 * `getPackageBasePath` takes the package's NuGet id, so the id is a fact the source
 * has to carry a copy of. `G-1` renamed the package once; a second rename that
 * missed that line would return the no-data image to the 404 it just came back from,
 * silently, because the control falls back to a built-in drawing and only warns.
 */
const packageNameFindings = [];
{
    const base = readFileSync(join(ROOT, 'Controls/SubstrateMapBase/SubstrateMapBase.ts'), 'utf8');
    const m = /export const PACKAGE_NAME = '([^']+)'/.exec(base);
    const nu = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
    const id = (/<id>([^<]+)<\/id>/.exec(nu) ?? [])[1];
    if (m === null) {
        packageNameFindings.push('SubstrateMapBase.ts declares no PACKAGE_NAME');
    } else if (m[1] !== id) {
        packageNameFindings.push(`PACKAGE_NAME is "${m[1]}" and the nuspec id is "${id}". `
            + 'getPackageBasePath would return null and the no-data image would 404.');
    }
    console.log(`\npackage name         : source and nuspec compared`);
    for (const f of packageNameFindings) { console.log(`  [package-name] ${f}`); }
    if (packageNameFindings.length === 0) { console.log(`  both say "${id}"`); }
}

const nuspecPathFindings = [];
{
    const nu = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
    const literal = (p) => !p.includes('*');
    const claims = [];
    for (const tag of ['icon', 'readme', 'license']) {
        const m = new RegExp(`<${tag}[^>]*>([^<]+)</${tag}>`).exec(nu);
        if (m !== null) { claims.push([tag, m[1].trim()]); }
    }
    for (const m of nu.matchAll(/<file\s+src="([^"]+)"/g)) {
        if (literal(m[1])) { claims.push(['file src', m[1]]); }
    }
    for (const [what, p] of claims) {
        const rel = p.replace(/\\/g, '/');
        if (!existsSync(join(ROOT, rel))) {
            nuspecPathFindings.push(`<${what}> names "${rel}", which is not on disk - `
                + 'nuget pack fails on a literal path that does not exist');
        }
    }
    console.log(`\nnuspec paths         : ${claims.length} literal path(s) named`);
    for (const f of nuspecPathFindings) { console.log(`  [nuspec] ${f}`); }
    if (nuspecPathFindings.length === 0) { console.log('  every one of them exists'); }
}


/* --------- the classic bridge carries the real API (F-11, D-237) ------------ */

/*
 * Every engine module registers into `TcHmi.Controls.CNM_UIControls.SEMI.Engine`
 * for consumers outside the module system. `E142.ts` and `E142Xml.ts` always
 * carried their real surface; `Engine.ts` carried `EngineHello` - a render probe
 * whose own doc called it a stand-in for the real engine - and a counter.
 *
 * The probe is gone. This asserts the bridge does not drift back to publishing
 * nothing usable, and that no file re-introduces the probe by name.
 */
const bridgeFindings = [];
{
    const engineSrc = readFileSync(join(ROOT, 'Helpers/SubstrateMapEngine/Engine.ts'), 'utf8');
    // Several pairs share a line, so the scan runs over the registration block
    // rather than being line-anchored - the line-anchored first version counted
    // 10 of the 17 names and reported two real exports as missing.
    // Bounded by the loop that consumes it, not by a character window: a window
    // measured backwards from the anchor slides when a name is removed, which is
    // exactly the change this check exists to catch, and it silently passed.
    const open = engineSrc.indexOf('for (const [name, value] of [');
    const close = engineSrc.indexOf('] as ReadonlyArray', open);
    const blockSrc = (open === -1 || close === -1) ? '' : engineSrc.slice(open, close);
    const names = [...blockSrc.matchAll(/\['(\w+)',\s*[A-Za-z_]/g)].map((m) => m[1]);
    if (names.length < 10) {
        bridgeFindings.push(`the classic bridge publishes ${names.length} names; it published `
            + 'a render probe and a counter before F-11, and a bridge that carries nothing usable '
            + 'is a bridge to nowhere');
    }
    for (const must of ['fitBBox', 'getCellAtPos', 'getItemAtPos', 'groupTileRect', 'normalizeColor']) {
        if (!names.includes(must)) {
            bridgeFindings.push(`the classic bridge no longer publishes ${must}`);
        }
    }
    for (const rel of ['Helpers/SubstrateMapEngine/Engine.ts',
        'Controls/SubstrateMapBase/SubstrateMapBase.ts']) {
        const text = readFileSync(join(ROOT, rel), 'utf8');
        if (/\bclass EngineHello\b|new EngineHello\(/.test(text)) {
            bridgeFindings.push(`${rel} re-introduces EngineHello, the probe F-11 removed`);
        }
    }
    console.log(`\nclassic bridge       : ${names.length} names published`);
    for (const f of bridgeFindings) { console.log(`  [bridge] ${f}`); }
    if (bridgeFindings.length === 0) { console.log('  the real API is reachable without a module loader'); }
}

if (protocol === null) {
    console.log(`\n  one direction was SKIPPED — see the banner above (F-2)`);
}
process.exit(misses > 0 || orphans.length > 0 || registration.length > 0
    || versionFindings.length > 0 || PROTOCOL_SKIPPED > 0
    || bridgeFindings.length > 0 || toolboxFindings.length > 0
    || nuspecPathFindings.length > 0 || emptyArrayFindings.length > 0 || packageNameFindings.length > 0
    || schemaFindings.length > 0 ? 1 : 0);
