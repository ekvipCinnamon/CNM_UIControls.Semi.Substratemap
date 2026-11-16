#!/usr/bin/env node
/*
 * check-spelling.mjs - the shipped surface is written in US English.
 *
 * ---- WHY A CHECK AND NOT A ONE-OFF EDIT ----
 *
 * External review found British spelling throughout the package. A single pass
 * would fix today's and say nothing about tomorrow's, and the words arrive one at
 * a time in ordinary prose, which is exactly the kind of drift nobody reviews for.
 *
 * ---- THE THREE THINGS THAT MAKE THIS SAFE ----
 *
 * 1. **No identifier is touched.** Measured before the first edit: of 1 397
 *    occurrences in the shipped surface, ZERO appear in a symbol name. Every one is
 *    prose. So this is word-for-word substitution with no grammar surgery - unlike
 *    the citation removal at `G-3`, where three mechanical attempts each produced
 *    worse text than they removed.
 *
 * 2. **`en-UK.localization` is exempt, and the check asserts that it stays that
 *    way.** It is the one file where British spelling is correct: the whole point
 *    of an en-UK locale is `coloured`. A blanket replace corrupts it, so the
 *    allowlist is enforced in BOTH directions - no British spelling outside it, and
 *    `coloured` still present inside.
 *
 * 3. **`mutations.catalogue.mjs` is a filename**, not prose. `npm run mutate`
 *    passes that path, so the word is guarded where it forms part of it.
 *
 * ---- WHAT IS DELIBERATELY NOT FIXED ----
 *
 * `STATE.md` and the spec documents are a historical record and **quote the user
 * verbatim**. Rewriting a quotation to correct its spelling falsifies it. They do
 * not ship, so they are out of scope, and the check does not look at them.
 *
 * ---- THE COMPOUND TRAP ----
 *
 * The first inventory used `\bmetre\b` and reported 907 occurrences. It missed
 * `millimetre` 99 times, because a word boundary does not fall inside a compound.
 * The true figure was 1 397 - **54% higher than the number that went into the
 * spec**. Every metric compound is listed below for that reason.
 *
 *   node tools/check-spelling.mjs           report, exit 1 if any remain
 *   node tools/check-spelling.mjs --fix     rewrite them
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = process.argv.includes('--fix');

/** British (and the four German tags) -> US. Every inflection is listed; a stem rule would hit identifiers. */
const MAP = {
    colour: 'color', colours: 'colors', coloured: 'colored', colouring: 'coloring',
    colourless: 'colorless', discolour: 'discolor', colourful: 'colorful',
    centre: 'center', centres: 'centers', centred: 'centered', centring: 'centering',
    honour: 'honor', honours: 'honors', honoured: 'honored', honouring: 'honoring',
    neighbour: 'neighbor', neighbours: 'neighbors', neighbouring: 'neighboring', neighbourhood: 'neighborhood',
    quantise: 'quantize', quantised: 'quantized', quantising: 'quantizing', quantisation: 'quantization',
    canonicalise: 'canonicalize', canonicalised: 'canonicalized', canonicalising: 'canonicalizing',
    factorisation: 'factorization', parametrisation: 'parametrization', pluralises: 'pluralizes',
    rasterisation: 'rasterization', rasteriser: 'rasterizer', stylised: 'stylized', itemised: 'itemized',
    behaviour: 'behavior', behaviours: 'behaviors', behavioural: 'behavioral',
    grey: 'gray', greys: 'grays', greyed: 'grayed', greyscale: 'grayscale',
    greyish: 'grayish',
    /* metric compounds: `\bmetre\b` does not fall inside `millimetre` */
    metre: 'meter', metres: 'meters',
    millimetre: 'millimeter', millimetres: 'millimeters',
    micrometre: 'micrometer', micrometres: 'micrometers',
    nanometre: 'nanometer', nanometres: 'nanometers',
    centimetre: 'centimeter', centimetres: 'centimeters',
    kilometre: 'kilometer', kilometres: 'kilometers',
    normalise: 'normalize', normalised: 'normalized', normalises: 'normalizes',
    normalising: 'normalizing', normalisation: 'normalization',
    serialise: 'serialize', serialised: 'serialized', serialises: 'serializes',
    serialising: 'serializing', serialisation: 'serialization',
    recognise: 'recognize', recognised: 'recognized', recognises: 'recognizes',
    recognising: 'recognizing',
    organise: 'organize', organised: 'organized', organises: 'organizes',
    initialise: 'initialize', initialised: 'initialized', initialises: 'initializes',
    initialising: 'initializing', initialisation: 'initialization',
    analyse: 'analyze', analysed: 'analyzed', analysing: 'analyzing',
    labelled: 'labeled', labelling: 'labeling',
    modelled: 'modeled', modelling: 'modeling',
    cancelled: 'canceled', cancelling: 'canceling',
    travelled: 'traveled', travelling: 'traveling',
    signalled: 'signaled', signalling: 'signaling',
    catalogue: 'catalog', catalogues: 'catalogs',
    licence: 'license', defence: 'defense', offence: 'offense',
    favour: 'favor', favours: 'favors', favoured: 'favored', favourite: 'favorite',
    fulfil: 'fulfill', enrol: 'enroll',
    programme: 'program', programmes: 'programs',
    artefact: 'artifact', artefacts: 'artifacts',
    /*
     * PREFIXED AND SUFFIXED FORMS - the compound trap again, one level down. A word
     * boundary does not fall inside `unrecognised`, `recolour` or `normaliser`
     * either, and the first version of this map missed 60 of them for exactly the
     * reason it had earlier missed `millimetre`.
     */
    unrecognised: 'unrecognized', recognisable: 'recognizable',
    unrecognisable: 'unrecognizable',
    recolour: 'recolor', recolours: 'recolors', recoloured: 'recolored',
    recolouring: 'recoloring',
    unlabelled: 'unlabeled', relabelled: 'relabeled', relabelling: 'relabeling',
    normaliser: 'normalizer', normalisers: 'normalizers',
    renormalise: 'renormalize', renormalised: 'renormalized',
    renormalises: 'renormalizes', renormalising: 'renormalizing',
    renormalisation: 'renormalization',
    serialiser: 'serializer', serialisers: 'serializers',
    serialisations: 'serializations', deserialise: 'deserialize',
    deserialised: 'deserialized',
    greying: 'graying',
    flavour: 'flavor', flavours: 'flavors', flavoured: 'flavored',
    localise: 'localize', localised: 'localized', localises: 'localizes',
    localising: 'localizing', localisation: 'localization',
    localisations: 'localizations',
    optimise: 'optimize', optimised: 'optimized', optimises: 'optimizes',
    optimising: 'optimizing', optimisation: 'optimization',
    optimisations: 'optimizations',
    summarise: 'summarize', summarised: 'summarized', summarises: 'summarizes',
    summarising: 'summarizing',
    standardise: 'standardize', standardised: 'standardized',
    standardises: 'standardizes', standardising: 'standardizing',
    standardisation: 'standardization',
    realise: 'realize', realised: 'realized', realises: 'realizes',
    realising: 'realizing',
    materialise: 'materialize', materialised: 'materialized',
    materialises: 'materializes', materialising: 'materializing',
    editorialise: 'editorialize',
    tokenise: 'tokenize', tokenised: 'tokenized', tokenises: 'tokenizes',
    tokenising: 'tokenizing', tokeniser: 'tokenizer',
    americanised: 'americanized', capitalisation: 'capitalization',
    /*
     * THE PROVENANCE TAGS, which were German. The README defines them for the
     * reader and the source files use them, so they are shipped text like any
     * other. Each key ends where the German word ends: `\bxsd-normativ\b` cannot
     * match inside `XSD-normative`, so the replacement is not re-flagged.
     */
    'xsd-normativ': 'XSD-normative', 'primaerquellen-zitat': 'Primary source',
    'sekundaerquelle': 'Secondary source', inferenz: 'Inference',
};

/** The one file where British spelling is the point. */
const EXEMPT = /en-UK\.localization$/;

/*
 * AND THE LINE THAT PRODUCES IT. `tools/localization.mjs` holds the en-UK text in a
 * table, so exempting only the generated file is not enough: the first run of this
 * tool Americanised the generator's `'en-UK': …` entry, the next regeneration wrote
 * `colored` into the file, and the two-directional guard caught it. **Exempting an
 * output without exempting its source is not an exemption.**
 */
const EXEMPT_LINE = /^\s*'en-UK':/;

/** `mutations.catalogue.mjs` is a path `npm run mutate` passes. */
const GUARD = /mutations\.catalogue/;

const WORD = new RegExp(`\\b(${Object.keys(MAP).join('|')})\\b`, 'gi');

/**
 * Applies the source word's capitalisation to the replacement.
 * @param src The word as written.
 * @param out Its US form, lower case.
 * @returns The replacement, cased like `src`.
 */
function matchCase(src, out) {
    if (src === src.toUpperCase()) { return out.toUpperCase(); }
    if (src[0] === src[0].toUpperCase()) { return out[0].toUpperCase() + out.slice(1); }
    return out;
}

/** @returns Every file of the shipped surface, plus the generators that write into it. */
function surface() {
    const out = [];
    const walk = (d) => {
        if (!existsSync(d)) { return; }
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) {
                if (e.name !== 'tests' && e.name !== 'node_modules') { walk(p); }
                continue;
            }
            if (/\.(ts|js|json|md|localization|svg|html|view)$/.test(e.name)) { out.push(p); }
        }
    };
    walk(join(ROOT, 'Controls'));
    walk(join(ROOT, 'Helpers'));
    walk(join(ROOT, 'Schema'));
    for (const f of ['README.md', 'ARCHITECTURE.md', 'API.md', 'CONTRIBUTING.md',
        'CHANGELOG.md', 'repository-root/README.md']) {
        if (existsSync(join(ROOT, f))) { out.push(join(ROOT, f)); }
    }
    /* The release notes are what NuGet shows a consumer before anything else. */
    if (existsSync(join(ROOT, 'SubstrateMap.nuspec'))) { out.push(join(ROOT, 'SubstrateMap.nuspec')); }
    /*
     * The generators that WRITE shipped text. Fixing their output alone would be
     * undone by the next `--check` run, which rewrites it from these tables.
     */
    for (const t of ['localization.mjs', 'diagnostic-register.mjs', 'api-sequences.mjs',
        'architecture.mjs']) {
        if (existsSync(join(ROOT, 'tools', t))) { out.push(join(ROOT, 'tools', t)); }
    }
    return out;
}

let changed = 0;
let found = 0;
const byWord = {};
const offenders = [];

for (const p of surface()) {
    const rel = relative(ROOT, p).replace(/\\/g, '/');
    const before = readFileSync(p, 'utf8');
    if (EXEMPT.test(rel)) { continue; }
    let hits = 0;
    const after = before.replace(WORD, (m, _w, off, str) => {
        /* a guarded path, not prose */
        if (GUARD.test(str.slice(Math.max(0, off - 11), off + m.length + 5))) { return m; }
        /* an en-UK value in a generator table */
        const lineStart = str.lastIndexOf('\n', off) + 1;
        if (EXEMPT_LINE.test(str.slice(lineStart, off))) { return m; }
        hits++;
        byWord[m.toLowerCase()] = (byWord[m.toLowerCase()] ?? 0) + 1;
        return matchCase(m, MAP[m.toLowerCase()]);
    });
    if (hits === 0) { continue; }
    found += hits;
    offenders.push(`${rel} (${hits})`);
    if (FIX) { writeFileSync(p, after, 'utf8'); changed++; }
}

/* The exemption is enforced in both directions: it must still be British. */
const uk = join(ROOT, 'Controls', 'SubstrateMap', 'en-UK.localization');
let ukBad = null;
if (existsSync(uk)) {
    if (!/coloured/.test(readFileSync(uk, 'utf8'))) {
        ukBad = 'en-UK.localization no longer contains "coloured" - the one file where '
            + 'British spelling is correct has been Americanised';
    }
} 

if (FIX) {
    console.log(`  spelling: ${found} replacement(s) in ${changed} file(s)`);
    const top = Object.entries(byWord).sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`  ${top.map(([k, v]) => `${k}(${v})`).join(' ')}`);
    process.exit(0);
}

console.log(`\nUS spelling          : ${surface().length} file(s) of the shipped surface`);
if (ukBad !== null) { console.log(`  [spelling] ${ukBad}`); }
for (const o of offenders.slice(0, 8)) { console.log(`  [spelling] ${o}`); }
if (offenders.length > 8) { console.log(`  ... and ${offenders.length - 8} more file(s)`); }
if (found > 0) {
    console.log(`  ${found} British spelling(s) remain. Run: node tools/check-spelling.mjs --fix`);
} else if (ukBad === null) {
    console.log('  none outside en-UK.localization, which still reads "coloured"');
}
process.exit(found > 0 || ukBad !== null ? 1 : 0);
