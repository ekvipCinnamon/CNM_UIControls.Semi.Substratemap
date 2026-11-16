#!/usr/bin/env node
/*
 * diagnostic-register.mjs - the register of diagnostic codes, from the sources.
 *
 * ---- WHY (F-15, D-243) ----
 *
 * The controls log 29 `E142_*` codes. A consumer meets one in a TwinCAT log and
 * has nowhere to look it up: the README mentions eight of them in prose, scattered
 * through 1 700 lines, and there is no register at all. A code that cannot be
 * looked up is a code that gets ignored.
 *
 * The register is GENERATED, because the alternative is a hand-kept table and this
 * repository has spent a whole feature spec finding out what those become: the
 * tsconfig files arrays (`W-2`), the framework path (`F-1`), the gate list
 * (`D-214`), the test README (`F-16`), the toolbox category (`D-240`). A second
 * copy is not a check.
 *
 * ---- WHAT IS A DIAGNOSTIC ----
 *
 * A code at the HEAD of a logged message: `` `E142_FOO: something happened` ``.
 * Matching `E142_[A-Z_]+` alone also caught `E142_BIN_TYPES`, `E142_MAP_TYPES`,
 * `E142_DEFAULT_MAP_TYPE` and `E142_KNOWN_SCHEMA_VERSIONS` - constants that merely
 * have a `: ` after them in a type annotation. The quote is what makes it a
 * message rather than an identifier.
 *
 * ---- USAGE ----
 *
 *   node tools/diagnostic-register.mjs           rewrite the block in README.md
 *   node tools/diagnostic-register.mjs --check   exit 1 if the block is stale
 *
 * `--check` is what `check-readme` runs. The rewrite is a repository-side task and
 * the README does not tell a consumer to run it - `F-8` removed four such
 * instructions and this must not add a fifth.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

const BEGIN = '<!-- DIAGNOSTICS:BEGIN -->';
const END = '<!-- DIAGNOSTICS:END -->';

/** The source files a diagnostic can be emitted from. */
function sources() {
    const out = [];
    for (const d of ['Controls/SubstrateMap', 'Controls/SubstrateMapBase',
        'Controls/SubstrateMapWidget', 'Controls/SubstrateMapFilterBar',
        'Controls/SubstrateMapBinChart', 'Helpers/SubstrateMapEngine']) {
        for (const f of readdirSync(join(ROOT, d))) {
            if (f.endsWith('.ts') && !f.endsWith('.d.ts')) { out.push(`${d}/${f}`); }
        }
    }
    return out;
}

/**
 * Every diagnostic code, with the file that emits it.
 * @returns `Map<code, file>` in code order.
 */
export function collect() {
    const found = new Map();
    for (const rel of sources()) {
        const text = readFileSync(join(ROOT, rel), 'utf8');
        // The code at the head of a quoted message. The quote is the whole test.
        for (const m of text.matchAll(/[`'"](E142_[A-Z0-9_]+): /g)) {
            if (!found.has(m[1])) { found.set(m[1], rel); }
        }
    }
    return new Map([...found].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * cause -> what to do, per code.
 *
 * WRITTEN FROM THE MESSAGES, not invented: every entry was drafted with the
 * message the code actually logs in front of it, so the advice cannot contradict
 * the text a reader is holding. Where the map already recovers - a clamp, an
 * ignored entry, a fallback to identity - the fix says so, because 'nothing is
 * broken' is the most useful thing a diagnostic can tell someone at 3 a.m.
 *
 * A code with no entry is a hard error in the generator. The register is the
 * package's support surface, and half of it would be worse than none.
 */
const ADVICE = {
    'E142_AGGREGATION_REDUCER_IGNORED': {
        cause: 'A valueField overlay owns the fill, and `AggregationReducer` reduces bin severity — two rules for one color.',
        fix: 'Drop the valueField role, or accept that the reducer does nothing while it is bound. Both are legitimate; the map will not guess.',
    },
    'E142_BIN_QUALITY_UNMAPPED': {
        cause: 'A `BinCode` declares a `BinQuality` that is neither `Pass` nor `Fail`, the only two E142 reserves.',
        fix: 'Fix the producing system. The cell is drawn as unknown, so a map full of unknowns with this warning means a whole vocabulary is wrong, not one bin.',
    },
    'E142_BIN_SEVERITY_PRIORITY_IGNORED': {
        cause: 'A code in the priority list has a `BinQuality` that resolves to pass, and a pass cannot outrank a fail.',
        fix: 'Either correct the document\'s `BinQuality`, or remove the code from the list. The list is ignored entirely while this holds — not just that entry.',
    },
    'E142_BIN_SEVERITY_PRIORITY_UNUSED': {
        cause: '`BinSeverityPriority` names a bin code the bound document does not contain.',
        fix: 'Harmless if the list is shared across recipes. If it is not, the code is a typo or the wrong document is bound.',
    },
    'E142_DEVICEDATA_ADDRESS_CONFLICT': {
        cause: 'A `<DeviceData>` record carries a LID and an X/Y that name different cells.',
        fix: 'Fix the producer. As with transfers, the map places neither: a record that contradicts itself has no position.',
    },
    'E142_DEVICEDATA_OVERLAY_NOT_FOUND': {
        cause: 'No `DeviceDataMap` overlay carries the requested name. The message lists the ones that do.',
        fix: 'Take a name from that list, or leave the attribute unset to use the first available.',
    },
    'E142_DEVICEDATA_UNPLACEABLE': {
        cause: 'A `<DeviceData>` record resolved to no cell of this grid.',
        fix: 'Usually the wrong document pair. Check the substrate id and the layout match the map\'s.',
    },
    'E142_DEVICEID_ADDRESS_CONFLICT': {
        cause: 'A `DeviceIdMap` `<Id>` entry carries a LID and an X/Y that name different cells.',
        fix: 'Fix the producer. The entry is dropped rather than guessed at.',
    },
    'E142_DEVICEID_UNPLACEABLE': {
        cause: 'A `DeviceIdMap` `<Id>` entry resolved to no cell of this grid.',
        fix: 'Check the id map is the one for this substrate. Device ids are per-layout and do not transfer between them.',
    },
    'E142_FILTER_NOT_APPLICABLE': {
        cause: 'The chosen `SpatialFilter` has no meaning on the chosen `FieldView` — averaging filters need a scalar field, ordering filters need ranked bins.',
        fix: 'Change one of the two. The filter bar grays the illegal pairs and says why in its tooltip; this warning is what a direct attribute write gets instead.',
    },
    'E142_JSON_BINARY_VERSION_TOO_OLD': {
        cause: 'The document uses the binary payload form but declares a `$version` from before it existed.',
        fix: 'Raise `$version` in the producer. The payload is parsed anyway; the declaration is what is wrong.',
    },
    'E142_JSON_UNKNOWN_MEMBER': {
        cause: 'The document contains member names this format does not define. They are listed in the message.',
        fix: 'Usually a typo — a misspelled member is silently ignored rather than applied, so a setting that seems not to work will appear here.',
    },
    'E142_JSON_VERSION_AHEAD': {
        cause: 'The document declares a `$version` newer than this engine implements.',
        fix: 'Parsed anyway — a later envelope adds members and unknown ones are ignored. Update the package if the document relies on something new.',
    },
    'E142_LID_DUPLICATE': {
        cause: 'The document names a location more than once. The first cell carrying each repeated LID is kept.',
        fix: 'Check the producing system\'s addressing. A duplicate LID usually means two records were merged without re-keying.',
    },
    'E142_MAP_INPUT_OVERRIDDEN': {
        cause: 'Two of the three map inputs were written; the most recent wins and the other is now dead.',
        fix: 'Bind one. If both are bound deliberately — a live feed and a fallback — clear the one you are not using to `null` rather than leaving it stale.',
    },
    'E142_OVERLAYS_DECORATION_NOT_FOUND': {
        cause: 'An overlay named as decoration is not in the document.',
        fix: 'Check the spelling, or remove the entry. Decorations are optional by design, so a missing one is a configuration error rather than a data error.',
    },
    'E142_OVERLAYS_ENTRY_INVALID': {
        cause: 'An `E142Overlays` entry has no usable `@MapName`, which is half of the key that finds an overlay.',
        fix: 'Give every entry a name. An entry without one cannot be matched to anything and is dropped.',
    },
    'E142_OVERLAYS_MULTIPLE_BASE': {
        cause: 'More than one overlay claims role `base`, and one overlay owns the cell fill.',
        fix: 'Choose one. The others are probably `decoration` — that role draws over the base instead of replacing it.',
    },
    'E142_OVERLAYS_MULTIPLE_VALUE_FIELD': {
        cause: 'More than one overlay claims role `valueField`, and a fill has one meaning.',
        fix: 'Choose one. A second measurement wants a second map beside the first, not a second fill in the same cells.',
    },
    'E142_OVERLAYS_OVERRIDES_SINGLE': {
        cause: '`E142Overlays` and `E142OverlayName`/`E142OverlayVersion` are both bound — two ways of selecting one overlay.',
        fix: 'Use one. `E142Overlays` is the richer form; the name/version pair is the shorthand for a single overlay.',
    },
    'E142_OVERLAYS_VALUE_FIELD_NOT_FOUND': {
        cause: 'The overlay named as the value field is not a renderable `BinCodeMap` in this substrate map.',
        fix: 'Check the name and version against the document. An overlay with no `BinCodeMap` carries no values to color by.',
    },
    'E142_REFERENCE_GEOMETRY_MISMATCH': {
        cause: 'The reference map and the bound map are different sizes, so no cell corresponds to another.',
        fix: 'Bind a reference from the same layout. Comparing a 5-inch to a 6-inch map is not a resolution problem, it is a different substrate.',
    },
    'E142_REFERENCE_NOT_APPLICABLE': {
        cause: '`ReferenceMode` and a value field both color the cell, and only one can.',
        fix: 'Unbind the value field, or set `ReferenceMode` to `None`. Which one depends on whether you are comparing lots or reading a measurement.',
    },
    'E142_TOUCH_TARGET_CLAMPED': {
        cause: '`TouchTargetSize` was set below the WCAG 2.2 floor for a touch target.',
        fix: 'Raise the value, or leave it: the map has already clamped it and is drawing at the floor. Only silence the warning by asking for a legal size.',
    },
    'E142_TRANSFER_ADDRESS_CONFLICT': {
        cause: 'A `<T>` element carries a TID and a TX/TY that name different cells — the document disagrees with itself.',
        fix: 'Fix the producer. The map trusts neither: an element that cannot say where it is does not get placed.',
    },
    'E142_TRANSFER_TARGET_COLLISION': {
        cause: 'Two transfers target the same cell.',
        fix: 'Later transfers to a cell are dropped. If they are meant to be a sequence, the map shows a snapshot and needs one document per state.',
    },
    'E142_TRANSFER_UNPLACEABLE': {
        cause: 'A `<T>` element resolved to no cell — its TID is not one the map names, and its TX/TY is outside the grid.',
        fix: 'Check that the transfer document and the map document describe the same substrate. This is the usual symptom of a mismatched pair.',
    },
    'E142_VIEW_TRANSFORM_DEGENERATE': {
        cause: 'The matrix has a zero determinant, so it collapses the map to a line or a point.',
        fix: 'Check `a*d - b*c`. A zero row or column, or a scale of 0, is the usual cause — often a rotation built with `sin`/`cos` in degrees where radians were meant.',
    },
    'E142_VIEW_TRANSFORM_INVALID': {
        cause: '`ViewTransform` is not six finite numbers — usually a short array, a string, or a `NaN` from an unbound symbol.',
        fix: 'Bind six numbers `[a, b, c, d, e, f]`. If the source is a PLC symbol, check it is initialized: an unwritten REAL arrives as `NaN`.',
    },
};

/** @param codes The map from {@link collect}. @returns The markdown block body. */
function render(codes) {
    const missing = [...codes].map(([c]) => c).filter((c) => ADVICE[c] === undefined);
    if (missing.length > 0) {
        console.error(`\n  No cause/fix for: ${missing.join(', ')}`);
        console.error('  Add them to ADVICE in tools/diagnostic-register.mjs.\n');
        process.exit(1);
    }
    const rows = [...codes].map(([code, rel]) => {
        const where = rel.startsWith('Controls/')
            ? rel.split('/')[1]
            : rel.split('/').pop().replace(/\.ts$/, '');
        const a = ADVICE[code];
        return `| \`${code}\` | ${where} | ${a.cause} | ${a.fix} |`;
    });
    return [
        '',
        `**${codes.size} codes.** Generated from the sources; every one is emitted at the head of a`,
        'log message, so searching a TwinCAT log for the code finds the line that raised it.',
        'The message itself names the attribute, value or element involved; the two columns',
        'below say what usually causes it and what to do about it.',
        '',
        '| Code | Raised by | Likely cause | What to do |',
        '|---|---|---|---|',
        ...rows,
        '',
    ].join('\n');
}

const readmePath = join(ROOT, 'README.md');
const readme = readFileSync(readmePath, 'utf8');
const eol = readme.includes('\r\n') ? '\r\n' : '\n';
const i = readme.indexOf(BEGIN);
const j = readme.indexOf(END);
if (i === -1 || j === -1 || j < i) {
    console.error(`diagnostic-register: no ${BEGIN} … ${END} block in README.md`);
    process.exit(2);
}

const codes = collect();
const body = render(codes).split('\n').join(eol);
const wanted = readme.slice(0, i + BEGIN.length) + body + readme.slice(j);

if (!CHECK) {
    writeFileSync(readmePath, wanted, 'utf8');
    console.log(`  README.md diagnostics register: ${codes.size} codes`);
    process.exit(0);
}

if (wanted === readme) {
    console.log(`  diagnostics register  : ${codes.size} codes, in step with the sources`);
    process.exit(0);
}
/*
 * A diff of code NAMES, not of markdown. "the block is stale" is useless; which
 * code appeared or vanished is the thing the reader has to act on.
 */
const inDoc = new Set([...readme.slice(i, j).matchAll(/`(E142_[A-Z0-9_]+)`/g)].map((m) => m[1]));
const missing = [...codes.keys()].filter((c) => !inDoc.has(c));
const extra = [...inDoc].filter((c) => !codes.has(c));
console.error('\n  diagnostics register is out of step with the sources:');
for (const c of missing) { console.error(`    + ${c} is emitted and not registered`); }
for (const c of extra) { console.error(`    - ${c} is registered and emitted nowhere`); }
if (missing.length === 0 && extra.length === 0) {
    console.error('    the codes agree; the rendering differs. Re-run without --check.');
}
console.error('  Run: node tools/diagnostic-register.mjs\n');
process.exit(1);
