/*
 * check-readme.mjs — every declared attribute has a README table row.
 *
 * WHY THIS EXISTS. `check-descriptors.mjs` keeps `Description.json` and the
 * implementation in step, and `check-manifest.mjs` keeps `Manifest.json` and the
 * schema files in step. Nothing checked the README, and it drifted nineteen
 * attributes deep before anyone counted — six of them documented in no form at
 * all, having shipped two phases earlier.
 *
 * A gap nobody measures is a gap nobody closes. This makes the count a gate.
 *
 * WHAT IT CHECKS
 *   1. Every `propertyName` in Description.json has a row in a README attribute
 *      table, i.e. a line beginning `| \`Name\` |`.
 *   2. Every such README row names an attribute that actually exists. A row for
 *      a removed or renamed attribute is as misleading as a missing one, and
 *      only the second direction catches it.
 *   3. No blank line sits inside an attribute table. To a markdown renderer a
 *      blank line ENDS a table, so the rows after it render as a second table
 *      and look fine; to this tool they were simply out of scope, and every
 *      attribute below the blank counted as undocumented. Two such lines took
 *      the count to 52 of 60 while the rows they hid were sitting right there,
 *      correctly written. The tool swallowed the defect it exists to find:
 *      it reported the symptom (eight missing attributes) and gave no hint
 *      that the cause was two blank lines. It now names them.
 *
 * Rows are taken only from tables headed `| Attribute | ... |`, so the
 * conformance matrix - keyed by E142 object rather than by attribute - is not
 * mistaken for one.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Not the type column, not the default, not
 * the prose. A tool that compared those would fail on every legitimate
 * difference between a descriptor type (`tchmi:general#/definitions/String`) and
 * the README's reader-facing one (`string | null`), and the noise would get it
 * switched off. Coverage is the thing that silently rots; wording is what review
 * catches.
 *
 * Exit 0 when both directions are clean, 1 otherwise.
 *
 * Run: node tools/check-readme.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import Ajv from 'ajv-draft-04';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { headings } from './lib/headings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/*
 * BOTH descriptors, not just the concrete's (W-15).
 *
 * Every attribute lived on `SubstrateMap` until `W-15` put three on the BASE,
 * where `heritable: true` makes them reachable from every control that extends
 * it. This tool read one file, so those three were documented or not with no
 * gate either way - and an author meets an inherited attribute in exactly the
 * same place as an own one, with nothing in the engineering tool to say which is
 * which.
 */
/*
 * DISCOVERED, not listed (W-25a). A list cannot catch its own omission: removing
 * a control's line here stops it being checked and leaves every gate green.
 * Measured, before this changed: four registrations removed one at a time, and
 * four times nothing went red.
 */
const DESCRIPTORS = readdirSync(join(ROOT, 'Controls'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(ROOT, 'Controls', e.name, 'Description.json'))
    .filter((p) => existsSync(p))
    .sort();
const README = join(ROOT, 'README.md');

/**
 * Rows are read ONLY from tables headed `| Attribute | ... |`.
 *
 * The README has other tables whose first cell is also a backticked name - the
 * conformance matrix is keyed by E142 OBJECT (`MapData`, `Substrate`,
 * `SubstrateMap`), and others by error code. A first pass scanned every table
 * and reported those three objects as stale attribute rows, which is exactly the
 * kind of false positive that gets a check tool switched off.
 */
function attributeRows(readme) {
    const out = new Set();
    const blanks = [];
    const lines = readme.split('\n');
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\|\s*Attribute\s*\|/.test(line)) { inTable = true; continue; }
        if (!inTable) { continue; }

        if (line.startsWith('|')) {
            const m = /^\|\s*`([A-Za-z0-9_]+)`\s*\|/.exec(line);
            if (m) { out.add(m[1]); }
            continue;
        }

        // A blank line is where a table legitimately ends AND where the defect
        // looks identical. The two are told apart by what follows: if the next
        // non-blank line is another table row, the table did not end and the
        // blank is a typo inside it. Scanning stops at the blank either way,
        // which is why the rows below one were invisible.
        if (line.trim() === '') {
            let j = i + 1;
            while (j < lines.length && lines[j].trim() === '') { j++; }
            if (j < lines.length && lines[j].startsWith('|')) {
                blanks.push(i + 1);   // 1-based, to match an editor
                i = j - 1;            // resume inside the same table
                continue;
            }
        }
        inTable = false;
    }
    return { rows: out, blanks };
}

function main() {
    const desc = { attributes: DESCRIPTORS.flatMap((p) => JSON.parse(readFileSync(p, 'utf8')).attributes ?? []) };
    const readme = readFileSync(README, 'utf8').replace(/\r/g, '');

    const declared = desc.attributes.map((a) => a.propertyName);
    const { rows: documented, blanks } = attributeRows(readme);

    // Direction 1: declared but undocumented.
    const undocumented = declared.filter((n) => !documented.has(n));

    // Direction 2: a row naming something that is not an attribute. Only names
    // that LOOK like attributes are considered - the README's other tables have
    // rows keyed by XSD type, error code and object name, and those are not
    // supposed to be attributes.
    const declaredSet = new Set(declared);
    const stale = [...documented].filter((n) => !declaredSet.has(n));

    console.log('=============================');
    console.log('  README attribute coverage');
    console.log('=============================');
    console.log(`  declared in Description.json : ${declared.length}`);
    console.log(`  with a README table row      : ${declared.length - undocumented.length}`);

    if (undocumented.length > 0) {
        console.log(`\n  MISSING from the README (${undocumented.length}):`);
        for (const n of undocumented) { console.log(`    [no-readme-row] ${n}`); }
    }
    if (stale.length > 0) {
        console.log(`\n  README rows naming no such attribute (${stale.length}):`);
        for (const n of stale) { console.log(`    [stale-readme-row] ${n}`); }
    }
    if (blanks.length > 0) {
        console.log(`\n  BLANK LINES inside an attribute table (${blanks.length}):`);
        for (const n of blanks) {
            console.log(`    [blank-line-in-table] README.md:${n} — a renderer ends the table here`);
        }
    }

    const bad = undocumented.length + stale.length + blanks.length;
    console.log('=============================');
    console.log(bad === 0
        ? '  OK — every attribute is documented, every row is real, no table is broken'
        : `  ${bad} finding${bad === 1 ? '' : 's'}`);
    return bad === 0 ? 0 : 1;
}


/* ------------------------------------------------------------------------ *
 *  DIRECTION 2 - every JSON example validates against a shipped schema
 *
 *  This tool checked that every bindable attribute is DOCUMENTED and never that
 *  the examples were RIGHT. Three of six were wrong when a user looked: item
 *  geometries written `x`/`y`/`height` where the schema says
 *  `center_position_x`/`center_position_y`/`length`; polygon points as `[x, y]`
 *  pairs where the schema says `{ x, y }` objects; and a label list written as
 *  an object with a `labels` array where both the schema and the setter want a
 *  bare array.
 *
 *  All three would have thrown or silently drawn nothing for anyone who copied
 *  them - which is what an example is FOR. **Documenting that a thing exists is
 *  not documenting it correctly**, and this tool only did the first.
 *
 *  An example that matches NO shipped schema is the failure. Which one it
 *  matches is not asserted here: several examples legitimately fit more than one
 *  definition, and naming the intended one in the README would be a second place
 *  to keep in step.
 * ------------------------------------------------------------------------ */

const exampleFindings = [];
{
    const defs = new Map();
    for (const dir of readdirSync(join(ROOT, 'Controls'))) {
        const td = join(ROOT, 'Controls', dir, 'Schema', 'TypeDefinitions');
        if (!existsSync(td)) { continue; }
        for (const f of readdirSync(td)) {
            const j = JSON.parse(readFileSync(join(td, f), 'utf8'));
            for (const name of Object.keys(j.definitions ?? {})) {
                defs.set(name, j.definitions);
            }
        }
    }
    const ajv = new Ajv({ allErrors: true, strict: false });
    /*
     * THREE DOCUMENTS, NOT ONE (F-24). `W-45` taught this check to read the README
     * after a user found five wrong examples in it. Neither the nuspec's
     * `<releaseNotes>` nor `CHANGELOG.md` was covered, and both are read
     * by a consumer before anything else.
     *
     * MEASURED FIRST, and the task's premise does not hold today: the nuspec's
     * 27 000 characters of release notes contain **no** JSON and **no**
     * `data-tchmi` attribute - its eight entity references are E142 element NAMES in
     * prose, `&lt;Layout&gt;` and the like - and the release-notes file has no
     * braces and no fenced blocks at all. There is nothing to validate in either.
     *
     * The check covers them anyway, because "there are no examples yet" is a fact
     * about today and not a property of the documents. It costs the same to cover
     * them now as to discover later that the one example somebody added was wrong.
     */
    const nuspecText = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
    const notesMatch = /<releaseNotes>([\s\S]*?)<\/releaseNotes>/.exec(nuspecText);
    /*
     * The nuspec's notes are XML TEXT, so an example pasted in there arrives
     * escaped: `data-tchmi-x=&apos;{...}&apos;` rather than the markup a reader
     * copies. That is a failure mode the README does not have, and unescaping
     * before parsing is the whole of handling it - a fragment broken by escaping
     * and a fragment broken by drift both have to be findable.
     */
    const unescapeXml = (t) => t
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, '&');

    const SOURCES = [
        ['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')],
        ['nuspec releaseNotes', notesMatch === null ? '' : unescapeXml(notesMatch[1])],
        ['CHANGELOG.md',
            existsSync(join(ROOT, 'CHANGELOG.md'))
                ? readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8') : ''],
    ];
    /*
         * BOTH POPULATIONS. Fenced ```json blocks, AND the `data-tchmi-x='...'`
         * values inside markup snippets - which is the form a reader is most
         * likely to copy, and which the first version of this check could not see
         * at all. Two of the six inline examples were wrong while all six fenced
         * ones had just been fixed.
         */
    const blocks = [];
    for (const [where, text] of SOURCES) {
        for (const m of text.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
            blocks.push([where, m[1]]);
        }
        for (const m of text.matchAll(/data-tchmi-[a-z0-9-]+='([\s\S]*?)'(?=[\s>])/g)) {
            if (/^\s*[[{]/.test(m[1])) { blocks.push([where, m[1]]); }
        }
    }
    const perSource = new Map(SOURCES.map(([w]) => [w, 0]));
    let checked = 0;
    for (const [i, m] of blocks.entries()) {
        perSource.set(m[0], (perSource.get(m[0]) ?? 0) + 1);
        let parsed;
        try { parsed = JSON.parse(m[1]); }
        catch (e) {
            exampleFindings.push(`${m[0]} json block ${i}: not valid JSON — ${e.message}`);
            continue;
        }
        checked++;
        let fits = false;
        for (const [name, definitions] of defs) {
            let validate;
            try { validate = ajv.compile({ $ref: `#/definitions/${name}`, definitions }); }
            catch { continue; }
            if (validate(parsed)) { fits = true; break; }
        }
        if (!fits) {
            const head = JSON.stringify(parsed).slice(0, 90);
            exampleFindings.push(`${m[0]} json block ${i} matches no shipped schema — ${head}`);
        }
    }
    console.log(`\njson examples        : ${checked} block(s) against ${defs.size} definitions`);
    for (const [w, n] of perSource) { console.log(`  ${String(n).padStart(3)} in ${w}`); }
    for (const f of exampleFindings) { console.log(`  [example] ${f}`); }
    if (exampleFindings.length === 0) { console.log('  every example validates'); }
}

/* ------- every path the shipped docs name is IN the shipped package (F-8) ---- */

/**
 * The nuspec `<files>` patterns, as predicates over repository-relative paths.
 *
 * WHY THE NUSPEC AND NOT THE DISK (F-8, `D-234`). "Does this file exist" is the
 * wrong question: `tools/bench-parse.mjs` exists here and a NuGet consumer will
 * never see it, because no `<file src>` pattern matches `.mjs`. The README told
 * that consumer to run it, four times. The question is whether the path is in the
 * package, and the nuspec is the only thing that answers it.
 */
function shippedMatchers() {
    const nuspec = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
    const srcs = [...nuspec.matchAll(/<file\s+src="([^"]+)"/g)].map((m) => m[1].replace(/\\/g, '/'));
    return srcs.map((src) => {
        // `**/` = any directory depth; `*` = any run of non-separator characters.
        const rx = '^' + src
            .replace(/[.+^${}()|[\]]/g, '\\$&')
            .replace(/\*\*\//g, '\u0000')
            .replace(/\*/g, '[^/]*')
            .replace(/\u0000/g, '(?:.*/)?') + '$';
        return new RegExp(rx);
    });
}

const SHIPPED_DOCS = ['README.md'];
/**
 * File extensions this repository actually uses. A path is recognised by ENDING
 * in one of these, which is what separates `tools/bench-parse.mjs` from
 * `glass-gen2.5` and `E142.1` - both of which the first version of this check
 * reported, because "has a dot" is not "is a file" (observation 377).
 */
const PATH_EXT = 'mjs|js|ts|md|json|xsd|sh|html|css|txt|view|nuspec|hmiextproj'
    + '|config|png|svg|jpg|ico|map|theme|content|localization|usercontrol';
/**
 * A path-like token, matched INSIDE a backtick span rather than as the whole of
 * one. The four `node tools/bench-parse.mjs` instructions all sit inside a longer
 * span, so anchoring to the span's edges missed every one of them.
 */
const RE_PATHISH = new RegExp(`[A-Za-z0-9_][A-Za-z0-9_./-]*\\.(?:${PATH_EXT})\\b`, 'g');
/** Backtick spans: the difference between naming a file and discussing a topic. */
const RE_TICKED = /`([^`\n]+)`/g;

const docFindings = [];
{
    const matchers = shippedMatchers();
    const ships = (p) => matchers.some((rx) => rx.test(p));
    let checked = 0;
    for (const doc of SHIPPED_DOCS) {
        const text = readFileSync(join(ROOT, doc), 'utf8');
        const seen = new Set();
        for (const span of text.matchAll(RE_TICKED)) {
            for (const m of span[1].matchAll(RE_PATHISH)) {
            const p = m[0].replace(/\\/g, '/');
            if (seen.has(p)) { continue; }
            seen.add(p);
            checked++;
            if (ships(p)) { continue; }
            docFindings.push(`${doc} names \u2018${p}\u2019, which no <file src> pattern ships`
                + (existsSync(join(ROOT, p)) ? ' (it exists here, which is exactly the trap)' : ' (it does not exist at all)'));
            }
        }
    }
    console.log(`\nshipped-doc paths    : ${checked} distinct token(s) in ${SHIPPED_DOCS.join(', ')}`);
    for (const f of docFindings) { console.log(`  [shipped] ${f}`); }
    if (docFindings.length === 0) { console.log('  every path named in a shipped document is in the package'); }
}

/* --------- the diagnostic register is in step with the sources (F-15) ------- */

/*
 * Delegated to `diagnostic-register.mjs --check` rather than reimplemented here:
 * the generator and the checker MUST agree about what a diagnostic is, and two
 * implementations of that rule would be the second copy this register exists to
 * avoid (`D-243`).
 */
const registerFindings = [];
{
    const r = spawnSync(process.execPath, [join(ROOT, 'tools/diagnostic-register.mjs'), '--check'],
        { encoding: 'utf8' });
    if (r.status !== 0) {
        registerFindings.push(String(r.stderr || r.stdout).trim().split('\n')
            .map((l) => l.trim()).filter(Boolean).join(' | '));
    } else {
        console.log(String(r.stdout).trimEnd());
    }
    for (const f of registerFindings) { console.log(`  [register] ${f}`); }
}


/* --------- the TEST readme is held to the same rule (F-16, D-244) ----------- */

/*
 * THE SHARP EDGE the task names: this repository built a checker for the product
 * README and had nothing for its own. **A rule enforced on everyone else and not
 * on oneself is a rule with a hole in the shape of oneself.**
 *
 * What is checked here is what is cheap and exact - the roster and the fixture
 * counts, which are directory listings, and which are what actually drifted: the
 * table listed 9 of 21 suites and claimed 43 XML + 20 JSON against 58 + 77. The
 * per-suite assertion counts need the suites RUN, so they are GENERATED by
 * `tools/tests-readme.mjs` rather than gated here; `npm run gate` runs them all
 * anyway, one line further down.
 */
const testsReadmeFindings = [];
{
    const TDIR = 'Helpers/SubstrateMapEngine/tests';
    const doc = readFileSync(join(ROOT, TDIR, 'README.md'), 'utf8');
    const listed = new Set([...doc.matchAll(/\|\s*`([a-z0-9-]+\.test\.mjs)`/g)].map((m) => m[1]));
    const onDiskSuites = readdirSync(join(ROOT, TDIR)).filter((f) => f.endsWith('.test.mjs'));
    for (const f of onDiskSuites) {
        if (!listed.has(f)) { testsReadmeFindings.push(`${f} is a suite and has no row`); }
    }
    for (const f of listed) {
        if (!onDiskSuites.includes(f)) { testsReadmeFindings.push(`${f} has a row and is not a suite`); }
    }
    const xml = readdirSync(join(ROOT, TDIR, 'fixtures/xml')).filter((f) => f.endsWith('.xml')).length;
    const json = readdirSync(join(ROOT, TDIR, 'fixtures/json')).filter((f) => f.endsWith('.json')).length;
    // Every count the document claims about the corpus, against the corpus.
    for (const [label, want, re] of [
        ['XML', xml, /(\d+)\s+\.xml/g],
        ['JSON', json, /(\d+)\s+\.json/g],
        ['total', xml + json, /Full corpus: (\d+) fixtures/g],
    ]) {
        for (const m of doc.matchAll(re)) {
            if (Number(m[1]) !== want) {
                testsReadmeFindings.push(`the ${label} fixture count says ${m[1]}, disk says ${want}`);
            }
        }
    }
    if (!new RegExp(`\\*\\*${onDiskSuites.length} suites\\.\\*\\*`).test(doc)) {
        testsReadmeFindings.push(`the document does not say there are ${onDiskSuites.length} suites`);
    }
    /*
     * The coverage thresholds, against `package.json` (F-17). The document states
     * the baseline and the gate enforces it; if the two are allowed to drift, the
     * stated number becomes decoration. Comparing against a real coverage RUN would
     * be the same measurement twice at ten times the cost - `npm run coverage` is
     * the run, this is the agreement.
     */
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const cov = String(pkg.scripts?.coverage ?? '');
    for (const [label, flag] of [['line', 'lines'], ['branch', 'branches'], ['function', 'functions']]) {
        const m = new RegExp(`--test-coverage-${flag}=([0-9.]+)`).exec(cov);
        if (m === null) {
            testsReadmeFindings.push(`package.json has no --test-coverage-${flag} threshold`);
            continue;
        }
        const inDoc = new RegExp(`\\| \\*\\*threshold\\*\\*[^|]*\\|([^|]*)\\|([^|]*)\\|([^|]*)\\|`).exec(doc);
        const col = { line: 1, branch: 2, function: 3 }[label];
        const stated = inDoc === null ? null : inDoc[col].replace(/[*\s%]/g, '');
        if (stated !== m[1]) {
            testsReadmeFindings.push(`the ${label} coverage threshold is ${m[1]} in package.json `
                + `and ${stated ?? 'absent'} in the test README`);
        }
    }

    console.log(`\ntest README          : ${onDiskSuites.length} suites, ${xml} XML + ${json} JSON fixtures`);
    for (const f of testsReadmeFindings) { console.log(`  [tests-readme] ${f}`); }
    if (testsReadmeFindings.length === 0) { console.log('  every countable claim matches the tests'); }
}


/* --------- no internal reference reaches a customer (G-3, H-2) ------------- */

/*
 * The design history is not distributed: task ids like `W-30`, decision records
 * like `D-180`, the work protocol's rules and evidence grades, the review ids, the
 * unshipped briefs (`CONTEXT`, the spec's `Annex A`) and the sibling proof-of-concept
 * controls that the substrate map replaced. **An identifier pointing at a document
 * the reader does not have is a dead reference, not a provenance.** The reasoning
 * ships; the citation does not. A comment saying why a constant exists is worth
 * shipping; one saying "see D-255" is worth nothing outside this repository.
 *
 * A PLAIN ASSERTION, NOT A RATCHET. This used to be a shrinking baseline over the
 * history ids alone, because the mechanical deletions were done and the rest was
 * prose with the id as its subject. That prose has been rewritten by hand, the
 * vocabulary below is the whole of what the inventory found, and the count is
 * zero - so any hit is a regression.
 *
 * EVERY VOCABULARY HAS A TRAP, and the patterns are shaped around each one:
 *  - `UTF-8`, `UTF-16`, `ISO-8859` end in text a naive `[FWMS]-\d+` reads as
 *    `F-8` - hence no letter or digit before the id.
 *  - `R-1` is a row count in E142.ts (`0..R-1`, `(R-1)//2`), so the review id `R-n`
 *    only counts in backticks.
 *  - `1e-9` is a number, so `E-9` needs no letter, digit or dot in front of it.
 *  - `"A1"` and `Die A1` are device names in examples, and `A1-1a` is a SEMI
 *    figure; the assumption labels `A3` / `A2/A4` stand alone.
 *  - `context` is an ordinary word; only the upper-case brief name `CONTEXT` counts.
 *  - E142Bins.ts numbers its own Row/Column run rules and cites them as
 *    "Run rule 2"; only a capitalized `Rule N` is the work protocol's.
 */
const REF_VOCABULARIES = {
    'history id': /(?<![A-Za-z0-9])(?:[FWMSGH]-\d+[a-z]?|OD-\d{3}|D-\d{3})(?![0-9A-Za-z])|`R-\d+[a-z]?`/,
    'engineering id': /(?<![A-Za-z0-9.])(?:E|DEV|LOD)-\d+[a-z]?(?![0-9A-Za-z])|\bTask-\d+|\btask [A-Z]\d+-[A-Z]+\b|PDF-VERIFY|\bA\d+ grade\b|\bgrades? [A-C]\+?(?![A-Za-z])/,
    'sibling control': /\b(?:WaferMap|ComponentMap|DieMap|EngineHello|ORIENT_SIGN)\b|\blegacy facades?\b|\bspike S\d|\bS\d mechanism/,
    'task number': /\bTask \d+[a-z]?\b|\btasks? M\d|\bS\d render probe|\bM\d\+/i,
    'protocol rule': /\bRule \d+\b/,
    'observation': /\bobservations? \d{2,3}\b/i,
    'phase': /\bPhase \d\b/,
    'review id': /\breview [A-Z]\d\b|\bA\d\/A\d\b|\(A\d\)|\breview `[A-Z]\d/,
    'assumption label': /(?<![A-Za-z0-9"'-])(?<!Die )A\d(?:\/A\d)?(?![0-9A-Za-z-])/,
    'work order': /\b(?:the|this|that|a later|a separate) task(?:'s)?\b|\btask-mandated\b|\btask table\b|\btask O\d|\bO\d+ open question|\bdecision \d+\b|\bsibling parity\b|\bDone-when\b/i,
    'unshipped brief': /\bCONTEXT\b|\bAnnex [A-Z]\b/,
    'evidence grade': /\]\s*`?\s*`?\[[A-C]\]/,
    'process file': /\b(?:TODO|STATE|PHASE-GATE-LOD)\.md\b/,
};
const refFindings = [];
{
    const shipped = [];
    const walk = (d) => {
        if (!existsSync(d)) { return; }
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') { walk(p); } continue; }
            if (/\.(ts|js|json|html|localization|md|view)$/.test(e.name)) { shipped.push(p); }
        }
    };
    walk(join(ROOT, 'Controls'));
    walk(join(ROOT, 'Helpers'));
    walk(join(ROOT, 'Schema'));
    /*
     * The shipped MARKDOWN is scanned too, not only the sources. `CHANGELOG.md`
     * describes changes a consumer can see, and it is the document most likely to
     * reach for a task id while being written from the commit log.
     */
    /* The repository's front page is not shipped, but it is the first thing a reviewer reads. */
    for (const doc of ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md', 'API.md',
        'repository-root/README.md', 'SubstrateMap.nuspec']) {
        if (existsSync(join(ROOT, doc))) { shipped.push(join(ROOT, doc)); }
    }
    for (const p of shipped) {
        const rel = p.slice(ROOT.length + 1).replace(/\\/g, '/');
        readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
            for (const [kind, rx] of Object.entries(REF_VOCABULARIES)) {
                const m = rx.exec(line);
                if (m !== null) {
                    refFindings.push(`${rel}:${i + 1} cites "${m[0]}" (${kind}) - it points at a `
                        + 'document the reader does not have. State the reasoning instead.');
                    break;
                }
            }
        });
    }
    console.log(`\ninternal references  : ${refFindings.length} in ${shipped.length} shipped file(s), `
        + `${Object.keys(REF_VOCABULARIES).length} vocabularies`);
    for (const f of refFindings.slice(0, 12)) { console.log(`  [internal-ref] ${f}`); }
    if (refFindings.length > 12) { console.log(`  [internal-ref] ... and ${refFindings.length - 12} more`); }
    if (refFindings.length === 0) { console.log('  none - the design history stays in the repository'); }
}

/* --------- every user-visible string goes through the dictionary (G-4c) ----- */

/*
 * `getText` returns the KEY when a locale has no text, so a localised string is
 * always distinguishable from a hard-coded one - and a literal handed to
 * `fillText` or assigned to `textContent` is a string no translator can reach.
 *
 * The baseline is ZERO. It was written as a ratchet expecting stragglers and the
 * first run found none, so it is a plain assertion: no control may draw a literal.
 */
const L10N_BASELINE = 0;
const l10nFindings = [];
{
    const seen = [];
    for (const c of ['SubstrateMap', 'SubstrateMapBase', 'SubstrateMapWidget',
        'SubstrateMapFilterBar', 'SubstrateMapBinChart']) {
        const p = join(ROOT, 'Controls', c, `${c}.ts`);
        if (!existsSync(p)) { continue; }
        /*
         * THE STATEMENT, NOT THE LINE. The first version tested only the line
         * containing `textContent =` and missed the FilterBar's radius readout
         * entirely, because that assignment spans four lines and the literal is on
         * the second. A checker that reads one line of a multi-line expression
         * cannot see the thing it was written for - proved by reverting the fix and
         * watching it stay green.
         */
        const lines = readFileSync(p, 'utf8').split(/\r?\n/);
        lines.forEach((line, i) => {
            if (/^\s*(\*|\/\/)/.test(line)) { return; }
            if (!/(fillText\(|textContent\s*=)/.test(line)) { return; }
            let stmt = '';
            for (let k = i; k < Math.min(i + 8, lines.length); k++) {
                if (/^\s*(\*|\/\/)/.test(lines[k])) { continue; }
                stmt += lines[k];
                if (/;\s*$/.test(lines[k])) { break; }
            }
            /*
             * A KEY IS NOT A LITERAL. Every string in the statement is examined and
             * the ones passed to `getText` are struck out first, so what remains is
             * text no translator can reach. Without this the fixed code reports
             * itself, because `getText('bar.radius.off')` contains a quoted string.
             */
            const bare = stmt.replace(/getText\(\s*'[^']*'\s*\)/g, 'X')
                .replace(/getText\(\s*[A-Z_]+\s*\)/g, 'X')
                /* `{0}` is the schema's placeholder token, substituted INTO a localised
                 * string. It is punctuation, not text. */
                .replace(/'\{\d+\}'/g, 'X');
            const m = /'([^']{2,})'|`([^`$]{2,})`/.exec(bare);
            if (m !== null) { seen.push(`${c}.ts:${i + 1} draws the literal ${m[0]}`); }
        });
    }
    l10nFindings.push(...seen);
    console.log(`\nlocalised strings    : ${seen.length} hard-coded literal(s) still drawn, `
        + `baseline ${L10N_BASELINE}`);
    for (const f of seen.slice(0, 4)) { console.log(`  [l10n] ${f}`); }
}

/* --------- the architecture diagrams are in step (G-6, D-270) --------------- */

/*
 * Delegated to the generator's own `--check`, not reimplemented: the rule for what
 * counts as a dependency edge exists once, in the tool that draws it. The same
 * reasoning as the diagnostic register and the desktop grid.
 */
const archFindings = [];
{
    const r = spawnSync(process.execPath, [join(ROOT, 'tools/architecture.mjs'), '--check'],
        { encoding: 'utf8' });
    if (r.status !== 0) {
        archFindings.push(String(r.stderr || r.stdout).trim().split('\n')
            .map((l) => l.trim()).filter(Boolean).join(' | '));
        for (const f of archFindings) { console.log(`  [architecture] ${f}`); }
    } else {
        console.log(String(r.stdout).trimEnd());
    }
}


/* --------- the API sequences are in step (G-7, D-271) ----------------------- */

const seqFindings = [];
{
    const r = spawnSync(process.execPath, [join(ROOT, 'tools/api-sequences.mjs'), '--check'],
        { encoding: 'utf8' });
    if (r.status !== 0) {
        seqFindings.push(String(r.stderr || r.stdout).trim().split('\n')
            .map((l) => l.trim()).filter(Boolean).join(' | '));
        for (const f of seqFindings) { console.log(`  [sequences] ${f}`); }
    } else {
        console.log(String(r.stdout).trimEnd());
    }
}


/* --------- every attribute is reachable from one section (H-5) ------------- */

/*
 * A reviewer reported `OriginLocation` as missing. It was documented - in the
 * Origin section, under a heading nobody looking for an attribute would open -
 * and the general table above it sat under "Substrate identity and display",
 * holding `Outline`, `Items` and `SelectionMode`. The coverage check above was
 * green throughout: it asks whether a row EXISTS, not whether a reader can find it.
 *
 * So two more questions:
 *  - Is every attribute table inside `## Attribute reference`? One outside it is
 *    the old scatter growing back.
 *  - Does every control have its own `###` there, and does that subsection list or
 *    name every attribute the control declares? Per control, not per name: the set
 *    above is satisfied by ANY control's row, which is how `SubstrateMap`'s own
 *    `MapTimestamp` went undocumented behind the tile's row of the same name.
 *    A subsection may name an attribute in prose and link to where it is described
 *    - the filter bar's four are the map's - but it must name it.
 */
const refSectionFindings = [];
{
    const lines = readFileSync(README, 'utf8').replace(/\r/g, '').split('\n');
    const hs = headings(lines.join('\n'), ['<!-- TOC:BEGIN -->', '<!-- TOC:END -->']);
    const top = hs.find((h) => h.level === 2 && h.text === 'Attribute reference');
    const controls = new Map(DESCRIPTORS.map((p) => [p.split(/[\\/]/).slice(-2)[0],
        (JSON.parse(readFileSync(p, 'utf8')).attributes ?? []).map((a) => a.propertyName)]));
    if (top === undefined) {
        refSectionFindings.push('README.md has no "## Attribute reference" section');
    } else {
        const end = hs.find((h) => h.level <= 2 && h.line > top.line)?.line ?? lines.length;
        lines.forEach((l, i) => {
            if (/^\|\s*Attribute\s*\|/.test(l) && (i < top.line || i >= end)) {
                refSectionFindings.push(`README.md:${i + 1} - an attribute table outside the Attribute reference`);
            }
        });
        const subs = hs.filter((h) => h.level === 3 && h.line > top.line && h.line < end);
        const seen = new Set();
        subs.forEach((h, k) => {
            const name = h.text.split(/[\s,]/)[0];
            if (!controls.has(name)) {
                refSectionFindings.push(`"### ${h.text}" names no control in Controls/`);
                return;
            }
            seen.add(name);
            const body = lines.slice(h.line, k + 1 < subs.length ? subs[k + 1].line : end).join('\n');
            for (const a of controls.get(name)) {
                if (!body.includes('`' + a + '`')) {
                    refSectionFindings.push(`${name} declares ${a}, and its section neither lists nor names it`);
                }
            }
        });
        for (const c of controls.keys()) {
            if (!seen.has(c) && controls.get(c).length > 0) {
                refSectionFindings.push(`${c} declares attributes and has no section in the Attribute reference`);
            }
        }
    }
    console.log(`\nattribute reference  : ${controls.size} controls, one section`);
    for (const f of refSectionFindings) { console.log(`  [attr-ref] ${f}`); }
    if (refSectionFindings.length === 0) {
        console.log('  every table is in it, and every control lists or names each attribute it declares');
    }
}


/* --------- every row shows its HTML name, derived not copied (H-6) ---------- */

/*
 * The tables named `ShowOriginMarker`; every example wrote
 * `data-tchmi-show-origin-marker`. A reviewer could not tell that the two were one
 * attribute. So every row carries both, and the README states the rule once.
 *
 * DERIVED, NOT COPIED. Copying `name` from the descriptor into the README would keep
 * the column right and say nothing about the rule sentence, which a reader applies
 * to names they meet elsewhere. So the rule is implemented here, and three things are
 * held to it: the README's column, every descriptor's own `name`, and the worked
 * examples in the rule sentence itself. A descriptor that ever breaks the rule fails
 * here, because the sentence would then be false.
 */
const htmlFindings = [];
{
    const kebab = (n) => 'data-tchmi-' + n
        .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
        .replace(/([0-9])([A-Z])/g, '$1-$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
        .toLowerCase();
    let rows = 0;
    for (const p of DESCRIPTORS) {
        for (const a of JSON.parse(readFileSync(p, 'utf8')).attributes ?? []) {
            if (a.name !== kebab(a.propertyName)) {
                htmlFindings.push(`${p.split(/[\\/]/).slice(-2)[0]}: ${a.propertyName} is "${a.name}" in the `
                    + `descriptor, but the README's rule gives "${kebab(a.propertyName)}"`);
            }
        }
    }
    const lines = readFileSync(README, 'utf8').replace(/\r/g, '').split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!/^\|\s*Attribute\s*\|/.test(lines[i])) { continue; }
        const head = lines[i].split('|').map((c) => c.trim());
        if (head[2] !== 'HTML attribute') {
            htmlFindings.push(`README.md:${i + 1} - an attribute table without the "HTML attribute" column`);
        }
        for (let j = i + 2; j < lines.length && lines[j].startsWith('|'); j++) {
            const cell = lines[j].split(/(?<!\\)\|/).map((c) => c.trim());
            const name = (/^`([A-Za-z0-9_]+)`$/.exec(cell[1]) ?? [])[1];
            if (name === undefined) { continue; }
            rows++;
            if (cell[2] !== '`' + kebab(name) + '`') {
                htmlFindings.push(`README.md:${j + 1} - ${name}'s HTML name reads ${cell[2] || '(nothing)'}, `
                    + `the rule gives \`${kebab(name)}\``);
            }
        }
    }
    const text = lines.join('\n');
    const examples = [...text.matchAll(/`([A-Z][A-Za-z0-9]+)` is\s+`(data-tchmi-[a-z0-9-]+)`/g)];
    for (const [, n, h] of examples) {
        if (kebab(n) !== h) { htmlFindings.push(`the rule sentence says ${n} is ${h}; the rule gives ${kebab(n)}`); }
    }
    console.log(`\nHTML names           : ${rows} row(s), ${examples.length} worked example(s), every descriptor`);
    for (const f of htmlFindings) { console.log(`  [html-name] ${f}`); }
    if (htmlFindings.length === 0) { console.log('  every row and every descriptor follows the rule the README states'); }
}


/* --------- every table of contents matches its headings (H-4) -------------- */

/*
 * Delegated to the generator, like the diagrams and the sequences: the rule for an
 * anchor exists once, in `lib/headings.mjs`, and the rule for what is listed once,
 * in `toc.mjs`.
 */
const tocFindings = [];
{
    const r = spawnSync(process.execPath, [join(ROOT, 'tools/toc.mjs'), '--check'], { encoding: 'utf8' });
    if (r.status !== 0) {
        tocFindings.push(String(r.stderr || r.stdout).trim().split('\n')
            .map((l) => l.trim()).filter(Boolean).join(' | '));
        for (const f of tocFindings) { console.log(`  [toc] ${f}`); }
    } else {
        console.log(String(r.stdout).trimEnd());
    }
}


/* --------- the README names the package it actually is (G-8, D-272) --------- */

/*
 * `G-1` renamed the package and `G-2` renamed the toolbox category, and the README
 * went on telling a reader to look for **WaferMap** in the Toolbox - a package id
 * that does not exist and a category nobody will find. Two commits, both gated,
 * neither able to notice that the sentence describing them had not moved.
 *
 * So the two facts are read from the manifest and the nuspec and required to appear.
 * A README that names a package id is making a checkable claim.
 */
const idFindings = [];
{
    const nu = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
    const id = (/<id>([^<]+)<\/id>/.exec(nu) ?? [])[1];
    const mani = JSON.parse(readFileSync(join(ROOT, 'Manifest.json'), 'utf8'));
    const cats = Object.values(mani.provideMetadata?.toolbox ?? {})
        .flatMap((g) => Object.values(g ?? {}))
        .map((v) => (typeof v === 'string' ? v : v?.default))
        .filter((v) => typeof v === 'string');
    const text = readFileSync(join(ROOT, 'README.md'), 'utf8');
    if (id !== undefined && !text.includes(id)) {
        idFindings.push(`the package id "${id}" appears nowhere in README.md - a reader `
            + 'cannot find the package they are told to install');
    }
    for (const c of cats) {
        if (!text.includes(c)) {
            idFindings.push(`the toolbox category "${c}" appears nowhere in README.md`);
        }
    }
    /*
     * AND EVERY CONTROL TYPE IN AN EXAMPLE EXISTS. A `data-tchmi-type` is the one
     * string a reader copies verbatim, and a wrong one fails at view-load time with
     * a message about an unknown control rather than anything about the README.
     */
    const declared = new Set();
    for (const mod of mani.modules ?? []) {
        if (mod.type !== 'Control') { continue; }
        const dp = join(ROOT, mod.basePath.replace(/^\.\//, ''), 'Description.json');
        if (!existsSync(dp)) { continue; }
        const d = JSON.parse(readFileSync(dp, 'utf8'));
        const t = d.type ?? (d.namespace ? `${d.namespace}.${d.name}` : d.name);
        if (typeof t === 'string') { declared.add(t); }
    }
    for (const m of new Set([...text.matchAll(/data-tchmi-type="([^"]+)"/g)].map((x) => x[1]))) {
        if (!declared.has(m)) {
            idFindings.push(`an example uses control type "${m}", which no descriptor declares`);
        }
    }
    /*
     * EVERY IMAGE THE README SHOWS MUST EXIST AND MUST SHIP.
     *
     * `F-8` removed three references to documents the package does not carry; an
     * image is the same defect with a broken-picture icon instead of a dead link,
     * and it is the one thing in a README that nine other rules do not check. A
     * capture also ages against the code - the first set offered for this section
     * predated five fixes and showed four of them unfixed - so alt text is required
     * too: it is the only description of a picture that a reviewer can diff.
     */
    const shipsFile = (rel) => {
        const nu2 = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
        return [...nu2.matchAll(/<file\s+src="([^"]+)"/g)]
            .map((x) => x[1].replace(/\\/g, '/'))
            .some((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]]/g, '\\$&')
                .replace(/\*\*\//g, '\u0000').replace(/\*/g, '[^/]*')
                .replace(/\u0000/g, '(?:.*/)?')}$`).test(rel));
    };
    /*
     * A LINK TO A DOCUMENT IS THE SAME PROMISE AS AN IMAGE. `F-8` removed three
     * references to files the package does not carry; the image rule was written
     * for pictures and left ordinary links alone, so a shipped `.md` could stop
     * shipping and the README would go on offering it. Both are checked here, and
     * the failure is the same one: the reader follows it and gets nothing.
     */
    for (const m of text.matchAll(/(?<!!)\[[^\]]*\]\((?!https?:|#)([^)]+)\)/g)) {
        const rel = m[1].split('#')[0];
        if (rel === '' || !/\.md$/i.test(rel)) { continue; }
        if (!existsSync(join(ROOT, rel))) {
            idFindings.push(`README links "${rel}", which is not on disk`);
        } else if (!shipsFile(rel)) {
            idFindings.push(`README links "${rel}", which the nuspec does not ship - `
                + 'the reader follows it and gets nothing');
        }
    }
    for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
        const [, alt, rel] = m;
        if (/^https?:/.test(rel)) { continue; }
        if (!existsSync(join(ROOT, rel))) {
            idFindings.push(`README shows "${rel}", which is not on disk`);
            continue;
        }
        if (!shipsFile(rel)) {
            idFindings.push(`README shows "${rel}", which the nuspec does not ship - `
                + 'the reader gets a broken picture');
        }
        if (alt.trim().length < 20) {
            idFindings.push(`the image "${rel}" has no useful alt text`);
        }
    }
    /*
     * CONTRIBUTING NAMES COMMANDS AND TOOLS; BOTH MUST EXIST.
     *
     * A contributor guide is the one document a reader follows LITERALLY - they
     * paste the command. `D-272` caught the README naming a package id that did not
     * exist; the same class of defect in a guide costs somebody their first hour.
     *
     * `npm install`, `npm test` and `npm ci` are npm's own verbs and are not
     * expected in `scripts`.
     */
    const NPM_BUILTIN = new Set(['install', 'ci', 'test', 'start', 'publish', 'pack']);
    const guide = join(ROOT, 'CONTRIBUTING.md');
    if (existsSync(guide)) {
        const g = readFileSync(guide, 'utf8');
        const scripts = new Set(Object.keys(
            JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}));
        for (const m of new Set([...g.matchAll(/`npm run ([a-z:]+)`/g)].map((x) => x[1]))) {
            if (!scripts.has(m)) {
                idFindings.push(`CONTRIBUTING.md says \`npm run ${m}\`, which package.json `
                    + 'does not define');
            }
        }
        for (const m of new Set([...g.matchAll(/`npm ([a-z]+)`/g)].map((x) => x[1]))) {
            if (!NPM_BUILTIN.has(m) && !scripts.has(m)) {
                idFindings.push(`CONTRIBUTING.md says \`npm ${m}\`, which is neither an npm `
                    + 'verb nor a script');
            }
        }
        for (const m of new Set([...g.matchAll(/`(tools\/[\w-]+\.mjs)`/g)].map((x) => x[1]))) {
            if (!existsSync(join(ROOT, m))) {
                idFindings.push(`CONTRIBUTING.md names ${m}, which does not exist`);
            }
        }
        console.log(`\ncontributor guide    : commands and tools checked against the repository`);
    }
    console.log(`\npackage identity     : id and ${cats.length} category name(s) checked`);
    for (const f of idFindings) { console.log(`  [identity] ${f}`); }
    if (idFindings.length === 0) { console.log('  the README names both'); }
}


/* --------- the repository has a front page, and it leads somewhere (H-3) ---- */

/*
 * A reader cloning the repository lands on `src/` and nothing else. The root README
 * says which directory is which and links the documents - so every link is a claim
 * a reader acts on, and a broken one is the first thing they meet.
 *
 * ---- TWO TREES, ONE FILE ----
 *
 * In the repository the file is `README.md` at the root, and links resolve from
 * there literally. This workspace is the ASSEMBLED tree - product and harness
 * overlaid - so it carries the file as `repository-root/README.md` and maps the two
 * overlaid prefixes onto itself. The mapping keeps each side honest: a link to
 * `src/hmi/SubstrateMap/package.json` would resolve here and not in the repository,
 * so the side a path belongs to is checked as well as its existence.
 *
 * Links into `src/hmi/Host/` or `src/doc/` cannot be verified from the assembled
 * tree, so the README names those directories in prose and links nothing there.
 * A link that tries is a finding, not a skip.
 */
const rootFindings = [];
{
    /* ROOT is src/hmi/Tests in the repository, so the repository is two levels up. */
    const hmi = join(ROOT, '..');
    const repo = join(hmi, '..', '..');
    const inRepository = /[\\/]Tests$/.test(ROOT.replace(/[\\/]+$/, ''))
        && existsSync(join(hmi, 'SubstrateMap', 'SubstrateMap.nuspec'));
    const file = inRepository ? join(repo, 'README.md') : join(ROOT, 'repository-root', 'README.md');
    const HARNESS = /^(?:tools\/|FrameworkStub\/|Helpers\/SubstrateMapEngine\/tests\/|package(?:-lock)?\.json$|typecheck\.sh$)/;
    const resolve = (target) => {
        if (inRepository) { return join(repo, target); }
        for (const [prefix, harness] of [['src/hmi/SubstrateMap/', false], ['src/hmi/Tests/', true]]) {
            if (target.startsWith(prefix)) {
                const rest = target.slice(prefix.length);
                if (HARNESS.test(rest) !== harness) {
                    return { wrongSide: harness ? 'src/hmi/SubstrateMap/' : 'src/hmi/Tests/' };
                }
                return join(ROOT, rest);
            }
        }
        return null;
    };
    let links = 0;
    if (!existsSync(file)) {
        rootFindings.push('no repository-root README ('
            + (inRepository ? 'README.md above src/' : 'repository-root/README.md') + ')');
    } else {
        const md = readFileSync(file, 'utf8');
        for (const m of md.matchAll(/(?<!!)\[[^\]]*\]\((?!https?:)([^)\s]+)\)/g)) {
            links++;
            const [target, anchor] = m[1].split('#');
            const at = resolve(target);
            if (at === null) {
                rootFindings.push(`"${m[1]}" points outside src/hmi/SubstrateMap/ and src/hmi/Tests/ - `
                    + 'name such a directory in prose; it cannot be verified');
                continue;
            }
            if (typeof at === 'object') {
                rootFindings.push(`"${target}" is on the wrong side - it lives under ${at.wrongSide}`);
                continue;
            }
            if (!existsSync(at)) {
                rootFindings.push(`"${target}" does not exist`);
                continue;
            }
            if (anchor !== undefined) {
                /* GitLab's anchors, from the same module the tables of contents use. */
                if (!headings(readFileSync(at, 'utf8')).some((h) => h.anchor === anchor)) {
                    rootFindings.push(`"${m[1]}" names a heading ${target} does not have`);
                }
            }
        }
        /* The facts it states are the nuspec's, and must stay so. */
        const nu = readFileSync(join(ROOT, 'SubstrateMap.nuspec'), 'utf8');
        for (const tag of ['id', 'version']) {
            const v = (new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(nu) ?? [])[1];
            if (v !== undefined && !md.includes(v)) {
                rootFindings.push(`the nuspec's <${tag}> "${v}" appears nowhere in the root README`);
            }
        }
    }
    console.log(`\nrepository front page: ${links} link(s), `
        + (inRepository ? 'resolved in the repository' : 'resolved through the assembled tree'));
    for (const f of rootFindings) { console.log(`  [root-readme] ${f}`); }
    if (rootFindings.length === 0) { console.log('  every link resolves, and the package facts match the nuspec'); }
}

process.exit(main() + exampleFindings.length + docFindings.length + registerFindings.length
    + testsReadmeFindings.length + refFindings.length
    + (l10nFindings.length > L10N_BASELINE ? 1 : 0) + archFindings.length + seqFindings.length + idFindings.length
    + rootFindings.length + tocFindings.length + refSectionFindings.length + htmlFindings.length);
