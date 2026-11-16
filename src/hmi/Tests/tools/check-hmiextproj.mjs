/*
 * check-hmiextproj.mjs - the explicit enumerations are complete.
 *
 * This tree has TWO kinds of file that list their inputs by hand instead of
 * globbing, and both fail the same way: silently, with every other gate green.
 *
 *   - `SubstrateMap.hmiextproj`, the Visual Studio project - sections 1 to 3.
 *   - every `tsconfig.json` `files` array - section 4, added by W-2.
 *   - the framework path in every `tsconfig.json` - section 5, added by F-1.
 *   - the line endings of every shell script - section 6, added by F-3.
 *   - doc blocks attached to what they document - section 7, added by F-10.
 *   - the tsconfigs sharing one base - section 8, added by F-19.
 *
 * Section 5 is the same defect one level up. `files` names the sources; `include`
 * names the Beckhoff `TcHmi.d.ts` the whole package compiles against, and its
 * version is written into the path by hand in seven files. Nothing compared that
 * path with the version `packages.config` and the nuspec declare, and nothing
 * checked the directory was there: the delivery shipped with all seven pointing
 * at 14.5.1 and the stub carrying 14.4.5, so every `tsc` step failed for a reason
 * that named jQuery rather than the version (review M2/T1, `D-215`).
 *
 * WHY THIS EXISTS. `SubstrateMap.hmiextproj` enumerates its content files
 * explicitly - it does not glob - and nothing else in the gate list looks at it.
 * A new `.ts` can typecheck, pass every test, be packed by the nuspec's
 * `**` + `/*.ts` glob and still be absent from the project, at which point Visual
 * Studio does not build it and the failure surfaces on someone else's machine.
 *
 * That is not hypothetical. The remediation logged it as "a dependency that was
 * nearly missed", and JSON spec Task 7 hit it for real: `E142Json.ts`'s project
 * registration failed silently on an anchor mismatch and all seven gates stayed
 * green. This closes it.
 *
 * WHAT IS CHECKED, and in which direction:
 *
 *   1. MISSING - a shippable file under a governed directory that no <Content>
 *      or <HmiManifest> element names. This is the failure above and it is an
 *      error.
 *   2. STALE - an entry naming a file that does not exist. Reported as a WARNING,
 *      never an error: the project file inherits ~31 entries for HMI scaffolding
 *      (Server/, Themes/, Properties/, Fonts/, Images/) that a full TwinCAT
 *      project has and this source package does not. Failing on those would make
 *      the gate red on a correct tree, which is worse than not having it.
 *   3. CASE - an entry whose path differs from the file's only in case. Windows
 *      does not care; a Linux build agent does. Same reasoning as
 *      check-manifest.mjs, and the same treatment: an error.
 *
 *   5. LINE ENDINGS - a tracked text file with BOTH CRLF and LF lines. Rule 19
 *      says the producer decides and a patch must match what it finds; nothing
 *      enforced it, and W-6 put 47 LF lines into a CRLF suite without anyone
 *      noticing until W-7 tried to anchor a patch in it. A file that is
 *      consistently either is fine - the tree is deliberately mixed BETWEEN
 *      files. It is mixing WITHIN one that means a patch script guessed.
 *
 *   4. TSCONFIG - a `.ts` under a governed directory that no tsconfig `files`
 *      array names, or that two of them name, or an entry naming a file that is
 *      not there, or a `tsconfig.json` and its `tsconfig.tpl.json` disagreeing.
 *      All errors.
 *
 *      This is the same defect one level down, and it was live: the engine
 *      tsconfig named six of eleven files. The other five still compiled and
 *      still emitted, because the CONTROL projects import them and tsc emits
 *      every file in the program rather than only the roots. So the gap showed
 *      up as nothing at all - until a file has no importer, at which point it is
 *      never type-checked, never emitted, and nothing says so.
 *
 *      `tsconfig.tpl.json` is the checked-in source; `tsconfig.json` is what the
 *      TwinCAT build writes from it with the framework path resolved. Fixing
 *      only the second is undone by the next regeneration, which is why the two
 *      are compared rather than only the one tsc reads.
 *
 *      The project list is DISCOVERED, not hard-coded: every `tsconfig.json`
 *      below a governed directory that has a `files` array counts. A control
 *      added later is covered without editing this tool - which is the point,
 *      since a hand-maintained list is the defect this section is about.
 *
 * WHAT IS DELIBERATELY NOT CHECKED. Only the three directories this package owns
 * are governed - `Controls/`, `Helpers/`, `Schema/` - plus the handful of
 * root-level files the project already lists. Everything else on disk is either
 * inherited scaffolding or not shipped:
 *
 *   - tests (`tests/`) and `tools/` never ship. The nuspec has no
 *     `*.mjs` rule at all, and Task 9's licence audit turned on exactly that
 *     fact.
 *   - `.js`, `.js.map` and `.d.ts` are emit products of the `.ts` files that ARE
 *     listed. The project file lists none of them and should not: they are
 *     regenerated by a build, and `.d.ts` and `.js.map` are gitignored.
 *   - `node_modules/`, `Packages/`, `pdf/`, `ref/` are session inputs, gitignored.
 *
 * Run: node tools/check-hmiextproj.mjs
 * Exit: 0 when every governed file is listed, 1 otherwise.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, resolve } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'SubstrateMap.hmiextproj';

/**
 * Directories whose shippable contents must all be listed. Anything outside
 * these is inherited scaffolding or is not part of this package.
 */
const GOVERNED = ['Controls', 'Helpers', 'Schema'];

/** Extensions that ship, and therefore have to be in the project. */
// `.localization` joined at F-22: the nuspec has always shipped `**/*.localization`,
// and this list did not know the extension - so the five German files could have been
// delivered without ever being declared in the project. A shipping pattern and a
// completeness check that disagree about what counts leave a gap the shape of the
// difference (D-252).
const SHIPPABLE = ['.ts', '.html', '.css', '.json', '.xsd', '.theme', '.png', '.svg', '.woff',
    '.localization'];

/**
 * Paths excluded from the MISSING check. Substring match on a `/`-normalised
 * path, so `/tests/` catches the whole tree beneath it.
 */
const NOT_SHIPPED = ['/tests/', '/node_modules/', '/Packages/'];

/** Emit products: derived from a listed `.ts`, never listed themselves. */
const EMIT_SUFFIXES = ['.d.ts', '.js.map', '.js'];

/** Indent for the continuation line of a two-line finding. */
const PAD = '\n         ';

/* ------------------------------------------------------------------ read */

const projectPath = join(ROOT, PROJECT);
if (!existsSync(projectPath)) {
    console.error(`FAIL: ${PROJECT} not found at ${projectPath}`);
    process.exit(1);
}
const xml = readFileSync(projectPath, 'utf8');

/**
 * Every path the project names, `/`-normalised. `Folder` items are excluded:
 * they declare directories, not content, and carry a trailing separator.
 */
const listed = new Map();
for (const m of xml.matchAll(/<(Content|HmiManifest|None|TypeScriptCompile)\s+Include="([^"]+)"/g)) {
    const raw = m[2];
    if (raw.endsWith('\\') || raw.endsWith('/')) { continue; }
    listed.set(raw.replace(/\\/g, '/'), m[1]);
}

/* ------------------------------------------------------------------ walk */

/**
 * Every file below `dir`, relative to ROOT and `/`-normalised.
 * @param dir A path relative to ROOT.
 * @returns The file paths.
 */
function walk(dir) {
    const out = [];
    const abs = join(ROOT, dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) { return out; }
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) { continue; }
            out.push(...walk(rel));
        } else {
            out.push(rel);
        }
    }
    return out;
}

const onDisk = GOVERNED.flatMap(walk);

/* ---------------------------------------------------------------- check */

const missing = [];
const wrongCase = [];

/** Lower-cased index of the listing, for the case check. */
const listedLower = new Map();
for (const p of listed.keys()) { listedLower.set(p.toLowerCase(), p); }

for (const path of onDisk) {
    if (NOT_SHIPPED.some((frag) => path.includes(frag))) { continue; }
    if (EMIT_SUFFIXES.some((s) => path.endsWith(s))) { continue; }
    if (!SHIPPABLE.some((e) => path.endsWith(e))) { continue; }
    if (listed.has(path)) { continue; }

    const near = listedLower.get(path.toLowerCase());
    if (near !== undefined) {
        wrongCase.push({ path, near });
    } else {
        missing.push(path);
    }
}

/* Stale entries are informational - see the header. */
const stale = [...listed.keys()].filter((p) => !existsSync(join(ROOT, p)));

/* ------------------------------------------------- 4. tsconfig enumeration */

/** Every `tsconfig.json` under a governed directory that enumerates `files`. */
const tsProjects = [];
for (const path of onDisk) {
    if (!path.endsWith('/tsconfig.json')) { continue; }
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
    } catch (err) {
        tsProjects.push({ path, dir: dirname(path), files: null, error: String(err.message) });
        continue;
    }
    if (!Array.isArray(parsed.files)) { continue; }
    tsProjects.push({ path, dir: dirname(path), files: parsed.files, error: null });
}

const tsBad = [];

/** Which projects name a given source, keyed by ROOT-relative path. */
const claimedBy = new Map();

for (const proj of tsProjects) {
    if (proj.error) {
        tsBad.push(`PARSE  ${proj.path}${PAD}${proj.error}`);
        continue;
    }
    for (const entry of proj.files) {
        // A `files` entry is relative to its own tsconfig and may climb out of
        // it, so it has to be NORMALISED before it can be compared with the
        // walk's paths. Without this, `Controls/X/../../Helpers/Y/Oklch.ts` and
        // `Helpers/Y/Oklch.ts` are two different keys and the duplicate check
        // silently passes on exactly the case it exists to catch.
        const rel = normalize(`${proj.dir}/${entry}`).replace(/\\/g, '/');
        if (!existsSync(join(ROOT, rel))) {
            tsBad.push(`TSGONE ${proj.path}${PAD}names "${entry}", which is not on disk`);
            continue;
        }
        if (!claimedBy.has(rel)) { claimedBy.set(rel, []); }
        claimedBy.get(rel).push(proj.path);
    }

    /* The template is the checked-in source; tsconfig.json is generated from it. */
    const tplPath = `${proj.dir}/tsconfig.tpl.json`;
    if (!existsSync(join(ROOT, tplPath))) {
        tsBad.push(`TSTPL  ${proj.path}${PAD}has no tsconfig.tpl.json beside it, `
            + 'and the build regenerates the .json from that file');
        continue;
    }
    let tpl;
    try {
        tpl = JSON.parse(readFileSync(join(ROOT, tplPath), 'utf8'));
    } catch (err) {
        tsBad.push(`PARSE  ${tplPath}${PAD}${String(err.message)}`);
        continue;
    }
    const inJson = new Set(proj.files);
    const inTpl = new Set(Array.isArray(tpl.files) ? tpl.files : []);
    const onlyJson = [...inJson].filter((n) => !inTpl.has(n));
    const onlyTpl = [...inTpl].filter((n) => !inJson.has(n));
    if (onlyJson.length > 0 || onlyTpl.length > 0) {
        tsBad.push(`TSTPL  ${proj.dir}${PAD}tsconfig.json and tsconfig.tpl.json disagree - `
            + `only in .json [${onlyJson.join(', ')}], only in .tpl.json [${onlyTpl.join(', ')}]`
            + `${PAD}the template is the source, so a fix in the .json alone is undone by the next build`);
    }
}

/* ------------------------------------------------- 5. line endings, per file */

/** Tracked text files carrying both endings; Rule 19 says that means a guess. */
const mixedEndings = [];
for (const path of onDisk) {
    if (!/\.(ts|mjs|js|json|md|xml|xsd|view|html|nuspec|hmiextproj|config|txt)$/i.test(path)) { continue; }
    const raw = readFileSync(join(ROOT, path));
    const crlf = raw.toString('latin1').split('\r\n').length - 1;
    const lf = (raw.toString('latin1').split('\n').length - 1) - crlf;
    if (crlf > 0 && lf > 0) {
        tsBad.push(`ENDING ${path}${PAD}${crlf} CRLF lines and ${lf} LF lines. Rule 19: a file has `
            + 'one producer and one ending; both means a patch script assumed rather than measured');
        mixedEndings.push(path);
    }
}

/** Every source that should be claimed by exactly one project. */
const tsSources = onDisk.filter((p) => p.endsWith('.ts')
    && !p.endsWith('.d.ts')
    && !NOT_SHIPPED.some((frag) => p.includes(frag)));

for (const src of tsSources) {
    const owners = claimedBy.get(src) ?? [];
    if (owners.length === 0) {
        tsBad.push(`TSMISS ${src}${PAD}no tsconfig \`files\` array names it, so it is never `
            + 'type-checked on its own and is emitted only if something else imports it');
    } else if (owners.length > 1) {
        tsBad.push(`TSDUP  ${src}${PAD}named by ${owners.length} projects `
            + `(${owners.join(', ')}) - two projects emitting one file race on the output`);
    }
}

/* ------------- 5. the framework path: declared, resolved, and present ------- */

/**
 * The version this package targets, taken from the two files a consumer's NuGet
 * restore actually reads. They are the contract; a tsconfig path is a resolution
 * of it, which is why a disagreement is reported against them and not the other
 * way round.
 */
function declaredFrameworkVersion() {
    for (const file of ['packages.config', 'SubstrateMap.nuspec']) {
        const p = join(ROOT, file);
        if (!existsSync(p)) { continue; }
        const m = readFileSync(p, 'utf8')
            .match(/id="Beckhoff\.TwinCAT\.HMI\.Framework"\s+version="([^"]+)"/);
        if (m) { return { version: m[1], from: file }; }
    }
    return null;
}

/** The seven: the root tsconfig plus one per project. The root has no `files`
 *  array, so `tsProjects` above does not carry it - and the root is the one the
 *  task names, because it holds `compilerOptions.paths`. */
const FRAMEWORK_TSCONFIGS = ['tsconfig.json',
    ...tsProjects.map((p) => p.path)].filter((p) => existsSync(join(ROOT, p)));

const declared = declaredFrameworkVersion();
const RE_FRAMEWORK = /Beckhoff\.TwinCAT\.HMI\.Framework\.([0-9][0-9.]*)/;
/** version -> the tsconfigs naming it, so a split is reported once and in full */
const seenVersions = new Map();
/** `${tsconfig}|${version}` already reported as absent */
const reported = new Set();

for (const cfgRel of FRAMEWORK_TSCONFIGS) {
    let cfg;
    try { cfg = JSON.parse(readFileSync(join(ROOT, cfgRel), 'utf8').replace(/^\uFEFF/, '')); }
    catch { continue; }

    const refs = [
        ...(cfg.include ?? []),
        ...Object.values(cfg.compilerOptions?.paths ?? {}).flat(),
    ].filter((r) => typeof r === 'string' && RE_FRAMEWORK.test(r));

    for (const ref of refs) {
        const version = ref.match(RE_FRAMEWORK)[1];
        if (!seenVersions.has(version)) { seenVersions.set(version, new Set()); }
        seenVersions.get(version).add(cfgRel);

        // Resolve as tsc would, then require the framework directory itself to be
        // present. A wildcard tail is not a file, so the check stops at the
        // version segment, which is the thing that is actually wrong when it is.
        const abs = resolve(join(ROOT, dirname(cfgRel)), ref.replace(/\/\*$/, ''));
        const marker = `Framework.${version}`;
        const upto = abs.slice(0, abs.indexOf(marker) + marker.length);
        if (existsSync(upto)) { continue; }
        // One finding per tsconfig per version: the root names the framework three
        // times (an include and two `paths` candidates) and they fail together.
        if (reported.has(`${cfgRel}|${version}`)) { continue; }
        reported.add(`${cfgRel}|${version}`);

        const parent = dirname(upto);
        const found = existsSync(parent)
            ? readdirSync(parent).filter((d) => RE_FRAMEWORK.test(d))
            : [];
        tsBad.push(`FWMISS ${cfgRel}${PAD}expects Beckhoff.TwinCAT.HMI.Framework.${version}, `
            + (found.length ? `found ${found.join(', ')}` : 'and Packages/ holds no framework at all')
            + ' - rename the payload to the expected version or supply it. Do NOT symlink: a symlink '
            + 'leaves the next fresh extraction failing the same way (D-215)');
    }
}

if (seenVersions.size > 1) {
    const split = [...seenVersions.entries()]
        .map(([v, files]) => `${v} in ${[...files].join(', ')}`).join('; ');
    tsBad.push(`FWSPLIT tsconfig framework version${PAD}${split}`
        + ' - one package cannot compile against two framework versions');
} else if (declared && seenVersions.size === 1) {
    const [only] = [...seenVersions.keys()];
    if (only !== declared.version) {
        tsBad.push(`FWDECL ${declared.from}${PAD}declares Framework ${declared.version} but every `
            + `tsconfig resolves ${only} - the file a consumer's NuGet restore reads and the file `
            + 'tsc reads disagree, so the build works here and nowhere else');
    }
}

/* ------------------ 6. shell scripts are LF, without exception -------------- */

/*
 * Rule 19 says a file has one producer and one ending, and .gitattributes lets
 * each producer keep its own. A shell script is the exception, because its
 * "producer" is not the author: the kernel reads the shebang byte for byte, so
 * `#!/usr/bin/env bash\r` sends it looking for an interpreter called `bash\r`
 * and `set -u\r` is an invalid option. typecheck.sh shipped that way and could
 * not run on the Linux sandbox it targets (review S12/T2).
 *
 * Section 5 would not have caught it: it looks for MIXED endings, and this file
 * was uniformly CRLF - internally consistent and completely broken. So this is a
 * separate assertion with an absolute rule rather than a consistency rule, and it
 * scans the whole tree rather than the governed directories, because a script can
 * live anywhere.
 */
const shellScripts = [];
(function scanForShell(dir) {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'Packages' || e.name === '.git'
            || e.name === 'pdf' || e.name === 'ref') { continue; }
        const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
        if (e.isDirectory()) { scanForShell(rel); } else if (/\.(sh|bash)$/i.test(e.name)) {
            shellScripts.push(rel);
        }
    }
}('.'));

for (const rel of shellScripts) {
    const raw = readFileSync(join(ROOT, rel));
    const cr = raw.toString('latin1').split('\r').length - 1;
    if (cr === 0) { continue; }
    const shebang = raw.toString('latin1').split('\n')[0].endsWith('\r');
    tsBad.push(`SHCRLF ${rel}${PAD}${cr} carriage return(s)`
        + (shebang ? ' - including the shebang, so the kernel looks for an interpreter '
            + 'whose name ends in CR and the script cannot run at all'
            : ' - a CR in a shell script is consumed as part of the token before it')
        + '. A .sh has one legitimate ending and the interpreter chooses it (D-224)');
}

/* --------- 8. the tsconfigs share one base (F-19) --------------------------- */

/*
 * All six projects had the SAME seventeen compiler options written out in full,
 * twice each - once in `tsconfig.tpl.json` and once in the generated
 * `tsconfig.json`. 102 settings where 17 would do, kept in step by hand.
 *
 * They now `extends` `tsconfig.base.json`. This asserts that they still do, and
 * that none of them has quietly re-declared an option the base already sets -
 * which is how a consolidation comes undone: not by deleting the base, but by one
 * project overriding it and the others silently diverging from that project.
 *
 * `include` is deliberately NOT in the base: it carries
 * `$(Beckhoff.TwinCAT.HMI.Framework).InstallPath`, a TwinCAT build variable the
 * engineering tooling substitutes per project when it generates the .json from the
 * .tpl.json. A file the generator does not process would keep the variable
 * unsubstituted (D-248).
 */
const BASE_REL = 'tsconfig.base.json';
if (!existsSync(join(ROOT, BASE_REL))) {
    tsBad.push(`TSBASE ${BASE_REL}${PAD}is missing, and six tsconfigs extend it`);
} else {
    const baseCfg = JSON.parse(readFileSync(join(ROOT, BASE_REL), 'utf8'));
    /*
     * `strict` stays ON (F-20a, D-250). It cost two type annotations, because
     * `strictNullChecks` - the flag that dominates most strict migrations - had
     * already been true throughout. Turning it off again would be one word in one
     * file, and nothing else in this repository would notice.
     *
     * The seven individual strict-family flags must NOT come back: `strict: true`
     * plus `"noImplicitAny": false` is a config that reads as strict and is not,
     * which is worse than not being strict at all.
     */
    if (baseCfg.compilerOptions?.strict !== true) {
        tsBad.push(`TSBASE ${BASE_REL}${PAD}does not set "strict": true (F-20a)`);
    }
    for (const k of ['alwaysStrict', 'noImplicitAny', 'strictFunctionTypes',
        'strictPropertyInitialization', 'strictNullChecks', 'strictBindCallApply',
        'noImplicitThis', 'useUnknownInCatchVariables']) {
        if (k in (baseCfg.compilerOptions ?? {})) {
            tsBad.push(`TSBASE ${BASE_REL}${PAD}re-declares "${k}" beside "strict": true - a config `
                + 'that reads as strict while switching part of it off is worse than not being strict');
        }
    }

    const baseOpts = new Set(Object.keys(
        JSON.parse(readFileSync(join(ROOT, BASE_REL), 'utf8')).compilerOptions ?? {}));
    for (const proj of tsProjects) {
        for (const name of ['tsconfig.json', 'tsconfig.tpl.json']) {
            const rel = `${proj.dir}/${name}`;
            if (!existsSync(join(ROOT, rel))) { continue; }
            let cfg;
            try { cfg = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')); } catch { continue; }
            if (typeof cfg.extends !== 'string' || !cfg.extends.endsWith(BASE_REL)) {
                tsBad.push(`TSBASE ${rel}${PAD}does not extend ${BASE_REL}; it would carry its own `
                    + 'copy of seventeen options that nothing keeps in step');
                continue;
            }
            for (const k of Object.keys(cfg.compilerOptions ?? {})) {
                if (baseOpts.has(k)) {
                    tsBad.push(`TSBASE ${rel}${PAD}re-declares "${k}", which ${BASE_REL} already `
                        + 'sets - one project overriding the base is how the six diverge again');
                }
            }
            if (!Array.isArray(cfg.include) || !cfg.include.some((p) => String(p).includes('TcHmi.d.ts'))) {
                tsBad.push(`TSBASE ${rel}${PAD}has no framework include of its own; it must keep it, `
                    + 'because the build variable in it is substituted per project');
            }
        }
    }
}


/* --------- 7. a doc block documents the thing beneath it (F-10) ------------- */

/*
 * A `/**` block whose `*​/` is followed immediately by another `/**` documents a
 * COMMENT, not a member. It happens when doc blocks and members drift into
 * different orders: the last block in the run lands on a member and every earlier
 * one is stranded, describing something the reader has to hunt for.
 *
 * `SubstrateMapWidget` had four. The worst was `__drawOverlay`'s own doc - its
 * `@param` list matches the signature exactly - sitting 120 lines up the file
 * while `__drawOverlay` itself carried no doc at all (review S9, F-10).
 *
 * ---- WHY A BASELINE AND NOT ZERO ----
 *
 * Seventeen remain in five other files. Failing on all of them would mean this
 * check could not ship until every one was fixed, and a check that cannot ship
 * prevents nothing. So each file carries the count it had when the check was
 * written, the count may only ever FALL, and a file not listed must have none.
 * Every number here is a defect, not an allowance.
 */
const STRANDED_BASELINE = new Map([
    ['Controls/SubstrateMap/SubstrateMap.ts', 8],
    ['Controls/SubstrateMapBase/SubstrateMapBase.ts', 2],
    ['Helpers/SubstrateMapEngine/E142.ts', 2],
    ['Helpers/SubstrateMapEngine/E142Xml.ts', 2],
    ['Helpers/SubstrateMapEngine/Engine.ts', 2],
]);

const stranded = new Map();
for (const rel of onDisk.filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))) {
    const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
    let n = 0;
    for (let i = 0; i < lines.length - 1; i++) {
        if (/^\s*\*\/\s*$/.test(lines[i]) && /^\s*\/\*\*\s*$/.test(lines[i + 1])) { n++; }
    }
    if (n > 0) { stranded.set(rel, n); }
}
for (const [rel, n] of stranded) {
    const allowed = STRANDED_BASELINE.get(rel) ?? 0;
    if (n > allowed) {
        tsBad.push(`STRANDED ${rel}${PAD}${n} doc block(s) followed by another doc block`
            + (allowed === 0
                ? ' - a block that documents a comment. Move it above the member it describes'
                : ` where ${allowed} were known. The baseline may fall, never rise (F-10)`));
    }
}
for (const [rel, allowed] of STRANDED_BASELINE) {
    const n = stranded.get(rel) ?? 0;
    if (n < allowed) {
        tsBad.push(`STRANDED ${rel}${PAD}${n} left of ${allowed} known - good, now lower the`
            + ' baseline in check-hmiextproj so it cannot climb back');
    }
}

/* --------- 8. one import statement per module (H-7) ----------------------- */

/*
 * `SubstrateMap.ts` imported `Engine.js` five times - three value imports and two
 * type imports, added one feature at a time. Each was harmless; together they made
 * the import block the last place to look for what a file depends on, and twelve
 * files had the same accretion.
 *
 * One statement per specifier, with `type` on the names that are only types:
 * `import { a, type B } from './X.js'`. The value/type split is not kept as two
 * statements, because the inline modifier says the same thing in one place.
 *
 * ESLint's `no-duplicate-imports` holds the `.mjs` tools and suites to this; it does
 * not parse TypeScript, so the `.ts` sources are checked here.
 */
const dupImports = [];
for (const rel of onDisk.filter((p) => p.endsWith('.ts') && !p.endsWith('.d.ts'))) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    const count = new Map();
    for (const m of src.matchAll(/^\s*import\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm)) {
        count.set(m[1], (count.get(m[1]) ?? 0) + 1);
    }
    for (const [spec, n] of count) {
        if (n > 1) {
            dupImports.push(rel);
            tsBad.push(`DUPIMPORT ${rel}${PAD}imports '${spec}' in ${n} statements - merge them into one, `
                + 'with `type` on the names that are only types');
        }
    }
}

/* --------------------------------------------------------------- report */

console.log('\n=================================');
console.log('  .hmiextproj content coverage');
console.log('=================================');
console.log(`  governed directories : ${GOVERNED.join(', ')}`);
console.log(`  entries in project   : ${listed.size}`);
console.log(`  tsconfig projects    : ${tsProjects.length}`);
console.log(`  .ts sources governed : ${tsSources.length}`);
console.log(`  mixed line endings   : ${mixedEndings.length}`);
console.log(`  shell scripts, LF    : ${shellScripts.length} scanned`);
console.log(`  stranded doc blocks  : ${[...stranded.values()].reduce((a, b) => a + b, 0)} in ${stranded.size} file(s), all known`);
console.log(`  repeated imports     : ${dupImports.length} file(s)`);
console.log(`  framework version    : ${[...seenVersions.keys()].join(', ') || 'none named'}` + (declared ? ` (declared ${declared.version} in ${declared.from})` : ''));
console.log(`  shippable on disk    : ${onDisk.filter((p) => !NOT_SHIPPED.some((f) => p.includes(f))
    && !EMIT_SUFFIXES.some((s) => p.endsWith(s)) && SHIPPABLE.some((e) => p.endsWith(e))).length}`);
console.log('=================================\n');

for (const { path, near } of wrongCase) {
    console.log(`  CASE   ${path}`);
    console.log(`         listed as "${near}" - Windows does not care, a Linux build agent does`);
}
for (const path of missing) {
    console.log(`  MISS   ${path}`);
    console.log('         no <Content Include> names it; Visual Studio will not build it');
}

for (const line of tsBad) { console.log(`  ${line}`); }
if (tsBad.length > 0) { console.log(''); }

if (stale.length > 0) {
    console.log(`  (${stale.length} entries name files not present here - inherited HMI project`);
    console.log('   scaffolding: Server/, Themes/, Properties/, Fonts/, Images/. Not an error.)\n');
}

const projectBad = missing.length + wrongCase.length;
const bad = projectBad + tsBad.length;
if (bad === 0) {
    console.log(`  OK - every shippable file under ${GOVERNED.join(', ')} is in the project,`);
    console.log('       and every .ts is in exactly one tsconfig files array\n');
    process.exit(0);
}
if (projectBad > 0) {
    console.log(`\n  ${projectBad} file${projectBad === 1 ? '' : 's'} not correctly listed in the project. Add `
        + `<Content Include="..."><SubType>Content</SubType></Content> for each.`);
}
if (tsBad.length > 0) {
    console.log(`  ${tsBad.length} tsconfig finding${tsBad.length === 1 ? '' : 's'}. `
        + 'Fix tsconfig.tpl.json and tsconfig.json together.');
}
console.log('');
process.exit(1);
