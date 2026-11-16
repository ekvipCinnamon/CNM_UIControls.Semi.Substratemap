/*
 * tools-smoke.test.mjs - the instruments in `tools/` are covered by something.
 *
 * WHY. `attach-harness.mjs`, `bench-parse.mjs`, `mutate.mjs` and its catalogue are
 * run by hand, and a defect in any of them produces a **wrong measurement** rather
 * than a red gate. That is not hypothetical: `mutate.mjs` discarded `tsc`'s exit
 * code for fifteen tasks, so a mutation that failed to compile reported a clean
 * pass and looked exactly like one that survived (observation 47, D-052). Nothing
 * would ever have gone red.
 *
 * `attach-harness.mjs` is past being an instrument at all:
 * `e142-representations.test.mjs` imports `bindAndFingerprint` from it, so it is
 * already load-bearing in a gate.
 *
 * ---- WHAT THIS SUITE WILL NOT DO ----
 *
 * It does not run the instruments at their working sizes. Measured, on this
 * machine:
 *
 *   bench-parse.mjs --quick                11.2 s
 *   mutate.mjs, one experiment WITH tsc    13.5 s
 *   the whole of node --test today          5.2 s
 *
 * Either would multiply the cost of every gate run, and a gate people avoid
 * running is worse than no gate. So `bench-parse` gets a `--smoke` size (one 50x50
 * lattice, 1.2 s) that exercises the same code paths, and `mutate` is driven
 * against a SYNTHETIC catalogue pointing at scratch files with no TypeScript
 * project - 93 ms, and it exercises the real anchor matching, the real verdict
 * classification and the real restore.
 *
 * That is the difference between covering a tool and re-running it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { makeHarness, onCrash } from './lib/harness.mjs';
import { requireInput } from '../../../tools/external-inputs.mjs';
import { MUTATIONS } from '../../../tools/mutations.catalogue.mjs';
import * as Oklch from '../Oklch.js';
import * as Recolor from '../../../tools/recolor-svg.mjs';
import { planBatches, selectMutations } from '../../../tools/mutate.mjs';
import {
    SubstrateMap, bindAndFingerprint, gridFingerprint, renderOnce, selfCheck,
} from '../../../tools/attach-harness.mjs';

const { ok, eq, deep, section, attempt, finish, counts } = makeHarness();
onCrash(counts);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const XML = join(ROOT, 'Helpers/SubstrateMapEngine/tests/fixtures/xml');

/**
 * Runs a command, returning its exit code and combined output rather than throwing.
 * @param args Arguments to `node`.
 * @returns `{ code, out }`.
 */
function runNode(args) {
    try {
        return { code: 0, out: execFileSync('node', args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
}

section('1. attach-harness — the one that is already in a gate', () => {
    /* Its own self-check first: it asserts the nine-panel placements the harness
     * exists to measure, and if it is broken nothing below means anything. */
    attempt('selfCheck passes', () => {
        const r = selfCheck();
        // `{ pass, fail, failures }` — not `passed`/`failed`. Getting this wrong
        // gave `undefined === 0` → false, which failed loudly; had it been
        // `undefined !== 0` it would have passed while checking nothing.
        eq(r.fail, 0, `the harness self-check is green (${r.pass} passed, ${r.fail} failed)`
            + (r.failures?.length ? `: ${r.failures[0]}` : ''));
        ok(r.pass > 40, `  and it asserts something — ${r.pass} assertions`);
    });

    /*
     * gridFingerprint is what `e142-representations.test.mjs` section 6 compares
     * 44 maps with. A fingerprint that returned a constant would make all 44 of
     * those assertions pass while comparing nothing, which is the failure mode
     * worth pinning: it must SEPARATE as well as match.
     */
    attempt('gridFingerprint separates and matches', () => {
        const a = readFileSync(join(XML, 'v0211-hexadecimal-nullbin-round.xml'), 'utf8');
        const b = readFileSync(join(XML, 'v0211-decimal-bintype.xml'), 'utf8');

        const fa1 = bindAndFingerprint('setE142MapData', a);
        const fa2 = bindAndFingerprint('setE142MapData', a);
        const fb = bindAndFingerprint('setE142MapData', b);

        ok(fa1 !== 'NO GRID', 'a bound map produces a fingerprint');
        eq(fa1, fa2, 'the SAME document twice gives the same fingerprint');
        ok(fa1 !== fb, 'and two DIFFERENT documents give different ones — a constant would pass '
            + 'every equivalence assertion in the representation suite while comparing nothing');
    });

    attempt('an unbound control fingerprints as NO GRID', () => {
        const c = new SubstrateMap(null, null, {});
        c.__attach();
        eq(gridFingerprint(c), 'NO GRID', 'nothing bound, nothing drawn');
    });

    /*
     * The fingerprint must be sensitive to the CELLS, and this is the assertion
     * that proves it rather than appearing to.
     *
     * The first version moved a cell in row 0 — and passed for the WRONG reason.
     * The code table is ordered by FIRST APPEARANCE, so turning `11119` into
     * `91111` reorders it from `.19` to `.91`, and the fingerprints differed
     * through the table rather than through the cells. With the cell hash forced
     * constant it still passed. Observation 60's shape exactly: an assertion that
     * cannot fail reads as coverage.
     *
     * The edit below moves a cell in the LAST row, leaving the first `9` where it
     * was, so lattice and code table are both unchanged and only the cells differ.
     */
    attempt('the fingerprint covers cell values, not just the shape', () => {
        const one = readFileSync(join(XML, 'v0211-orientation-90.xml'), 'utf8');
        const moved = one.replace('<BinCode>11191</BinCode>', '<BinCode>11911</BinCode>');
        ok(moved !== one, 'the fixture really was edited');

        const fa = bindAndFingerprint('setE142MapData', one);
        const fb = bindAndFingerprint('setE142MapData', moved);
        const shapeAndTable = (f) => f.split(':')[0] + ':' + f.split(':')[2];
        eq(shapeAndTable(fa), shapeAndTable(fb),
            'the edit leaves the lattice and the code table identical');
        ok(fa !== fb,
            '  and the fingerprints still differ — so the difference is in the CELL HASH, '
            + 'which is the part a constant would silence');
    });

    /*
     * `renderOnce` is the harness's newest capability and the one the aggregation
     * outputs depend on. If it silently stopped driving a frame, every assertion
     * built on it would pass by asserting nothing about rendering at all — so this
     * checks the frame really happens.
     */
    attempt('renderOnce drives a real frame', () => {
        const c = new SubstrateMap(null, null, {});
        c.setE142MapData(readFileSync(join(XML, 'v0211-decimal-bintype.xml'), 'utf8'));
        c.__attach();
        const ctx = renderOnce(c, 300);
        ok(ctx.fills.length > 0 || ctx.puts.length > 0,
            `the canvas received work — ${ctx.fills.length} fills, ${ctx.puts.length} blits`);
        eq(ctx.width, 300, 'on a context of the size asked for');
        ok(ctx.clears.length > 0, '  and the frame cleared before drawing, as a real one does');
    });
});

section('1b. filterbar-sheet — the review artefact for the bar (F-9)', () => {
    /*
     * `F-9`'s gate line. The bar is the only control that had no visual review at
     * all, which is how it reached 41% of lines with its whole DOM loop unexecuted.
     *
     * Both claims are about the FAILURE MODE. A sheet that drew nothing would still
     * truthfully report "0 disabled options", so what is checked is that the
     * illegal combinations ARE offered-and-greyed, and that every one of them
     * carries a reason. Those are the two things the README promises and the two
     * that a picture of an empty bar would silently lose.
     */
    const r = runNode(['tools/filterbar-sheet.mjs']);
    const claim = (name) => {
        const m = new RegExp(`claim ${name}: (\\d+) of (\\d+)`).exec(String(r.out));
        return m === null ? null : { n: Number(m[1]), of: Number(m[2]) };
    };

    attempt('the sheet renders and says what it wrote', () => {
        eq(r.code, 0, 'tools/filterbar-sheet.mjs exits 0');
        ok(/filterbar-review-sheet\.png\s+\d+x\d+/.test(r.out), 'and reports the file it wrote');
    });

    attempt('illegal combinations are shown, not hidden', () => {
        const c = claim('disabled-options');
        ok(c !== null, `the sheet reports the claim  ${String(r.out).slice(0, 200)}`);
        ok(c.n > 0, `${c.n} options are greyed — an illegal filter stays visible and explains itself`);
        ok(c.n < c.of, `and ${c.of - c.n} of ${c.of} are legal — the bar is not greyed out wholesale`);
    });

    attempt('every greyed option carries a reason', () => {
        const c = claim('reasons-given');
        ok(c !== null, 'the sheet reports the claim');
        eq(c.n, c.of, `${c.n} of ${c.of} — a disabled control with no explanation reads as broken`);
    });
});

section('1c. filter-sheet — the review artefact, and its evidence', () => {
    /*
     * `W-41`'s gate line, and observation 145's precedent: the sheet is a Tier-3
     * artefact and nothing forces it to be regenerated, so the CLAIMS PRINTED ON
     * IT are asserted here. If the filters regressed, the next person to look at
     * the sheet would be reading a picture of something that no longer happens.
     *
     * Two claims, both about the FAILURE MODE rather than the success - a sheet
     * that only shows a feature working is a screenshot.
     */
    const r = runNode(['tools/filter-sheet.mjs']);

    attempt('it runs and writes a PNG', () => {
        eq(r.code, 0, `exit 0  ${String(r.out).slice(0, 200)}`);
        ok(/filter-review-sheet\.png\s+\d+x\d+/.test(r.out), 'and reports the file it wrote');
    });

    const claim = (name) => {
        const m = new RegExp(`claim ${name}: (\\d+) -> (\\d+) fail pixels`).exec(String(r.out));
        return m === null ? null : { before: Number(m[1]), after: Number(m[2]) };
    };

    attempt('Max at radius 2 WALLS THE WAFER IN on Random', () => {
        /*
         * The case the task names. Scattered single-cell failures dilate until they
         * merge, and a wafer that was 2 % bad reads as almost entirely bad. It is on
         * the sheet at full size and labelled, not cropped and not apologised for.
         */
        const c = claim('random-max-r2-walls-in');
        ok(c !== null, `the sheet reports the claim  ${String(r.out).slice(0, 200)}`);
        ok(c.after > c.before * 1.5,
            `fail pixels grow from ${c.before} to ${c.after} — the wafer walls in`);
    });

    attempt('Min at radius 2 ERASES it instead', () => {
        /* The opposite failure, and the reason both are on the sheet: a reviewer
         * who sees only one might read it as the filter being aggressive rather
         * than as erosion and dilation being two directions of one operation. */
        const c = claim('random-min-r2-erases');
        ok(c !== null, 'the sheet reports the claim');
        ok(c.after < c.before / 4,
            `fail pixels fall from ${c.before} to ${c.after} — scattered failures vanish`);
    });

    attempt('and the two are opposite, which is the whole point', () => {
        const walled = claim('random-max-r2-walls-in');
        const erased = claim('random-min-r2-erases');
        eq(walled.before, erased.before, 'both start from the same unfiltered frame');
        ok(walled.after > erased.after * 10,
            `${walled.after} against ${erased.after}: one dilates, one erodes`);
    });
});

section('1b. contact-sheet — the review artefact, and its evidence', () => {
    /*
     * The sheet is a Tier-3 review artefact, not a gate, so nothing forces it to
     * keep working — and its two measurable Done-whens are the EVIDENCE the review
     * rested on. If aggregation regressed, the next person to regenerate the sheet
     * would find out by looking at it, which is the slowest possible way.
     *
     * Two seconds for 56 renders of a 512-square wafer. Worth it to keep a claim
     * checkable without a human.
     */
    const r = runNode(['tools/contact-sheet.mjs']);
    attempt('it runs and writes a PNG', () => {
        eq(r.code, 0, `exit 0  ${String(r.out).slice(0, 160)}`);
        ok(/wrote .*\.png\s+\d+ x \d+/.test(r.out), 'and reports the file it wrote');
    });

    attempt('Scratch survives MaxSeverity at every factor', () => {
        const lines = String(r.out).split('\n').filter((l) => /^\s+factor\s+\d+:.*fail pixels/.test(l));
        eq(lines.length, 4, 'four factors reported');
        const lost = lines.filter((l) => l.includes('LOST'));
        eq(lost.length, 0, `none loses the scratch  ${lost[0] ?? ''}`);
        const at50 = lines.find((l) => /factor\s+50:/.test(l));
        const n = Number(/(\d+) fail pixels/.exec(at50)?.[1] ?? 0);
        ok(n > 0, `and at factor 50 it is still ${n} pixels — the case FailFraction would tint away`);
    });

    attempt('Random under MaxSeverity is visibly saturated at factor 50', () => {
        const line = String(r.out).split('\n')
            .filter((l) => /% of the wafer/.test(l)).find((l) => /factor\s+50:/.test(l));
        ok(line !== undefined, 'the sheet reports it');
        const pct = Number(/([\d.]+) %/.exec(line)?.[1] ?? 0);
        ok(pct > 50,
            `${pct} % of the wafer is the fail swatch — the failure mode Task 17 exists to avoid, `
            + 'shown rather than cropped out');
    });

    attempt('every combination is present', () => {
        ok(/every combination present: 56 = 7 patterns x 4 factors x 2 reducers/.test(r.out),
            '56 cells, and the arithmetic is printed rather than asserted from the same numbers');
    });
});

section('2. bench-parse — it still produces a table', () => {
    /*
     * `--smoke`, not `--quick`: see the file header. This asserts the instrument
     * RUNS and reports, not that any number is right — a 50x50 lattice is far too
     * small for the envelope not to dominate, and quoting it would be the mistake
     * Task 17's first draft made with the corpus.
     */
    const r = runNode(['tools/bench-parse.mjs', '--smoke']);
    eq(r.code, 0, 'bench-parse.mjs --smoke exits 0');
    ok(!r.out.includes('NaN'), 'and reports no NaN — a broken timer or a divide by zero shows up here');

    const rows = r.out.split('\n').filter((l) => /^\s+50\s+(Ascii|Decimal|HexaDecimal|Integer2)\b/.test(l));
    ok(rows.length >= 8, `it emits a row per BinType in both tables (${rows.length} rows)`);
    for (const t of ['Ascii', 'Decimal', 'HexaDecimal', 'Integer2']) {
        ok(r.out.includes(t), `  including ${t}`);
    }
    ok(/READ THIS BEFORE QUOTING ANY NUMBER/.test(r.out),
        'and the caveat block is still printed — the numbers are useless without it');

    attempt('the three-way block is present and consistent', () => {
        ok(/three representations of ONE document/.test(r.out), 'the like-for-like block ran');
        ok(/LARGER|smaller/.test(r.out), '  and reached a verdict on the binary form');
    });
});

section('3. mutate — the classifier, on a synthetic catalogue', () => {
    /*
     * A scratch subject and a scratch suite, with `project: null` so no TypeScript
     * is involved. 93 ms against 13.5 s for one real experiment, and it exercises
     * exactly the parts that can be wrong: anchor matching, verdict
     * classification, and the restore.
     */
    /* Inside the repo, because `mutate.mjs` resolves catalogue paths against ROOT
     * by contract — and now refuses an absolute one rather than mangling it. */
    const rel = 'tools/.smoke-scratch';
    const dir = join(ROOT, rel);
    mkdirSync(dir, { recursive: true });
    const subject = join(dir, 'subject.mjs');
    const suite = join(dir, 'suite.mjs');
    const cat = join(dir, 'catalogue.mjs');
    try {
        writeFileSync(subject, 'export const VALUE = 1;\n');
        writeFileSync(suite,
            `import { VALUE } from ${JSON.stringify(subject)};\n`
            + 'const bad = VALUE === 1 ? 0 : 1;\n'
            + 'console.log(`  RESULT: ${1 - bad} passed, ${bad} failed`);\n');
        writeFileSync(cat,
            'export const MUTATIONS = [\n'
            + `  { task: 'Smoke', label: 'value changed', file: '${rel}/subject.mjs',`
            + ` project: null, suite: '${rel}/suite.mjs',`
            + " from: 'export const VALUE = 1;', to: 'export const VALUE = 2;' },\n"
            + `  { task: 'Smoke', label: 'anchor absent', file: '${rel}/subject.mjs',`
            + ` project: null, suite: '${rel}/suite.mjs',`
            + " from: 'NOT PRESENT ANYWHERE', to: 'x' },\n"
            + '];\n');

        const r = runNode(['tools/mutate.mjs', cat]);
        ok(/CAUGHT\s+1/.test(r.out), 'a mutation the suite notices is CAUGHT');
        ok(/ANCHOR-MISSING\s+1/.test(r.out),
            'and an anchor that is not in the file is ANCHOR-MISSING, not silently skipped');
        eq(r.code, 1, '  the run exits non-zero, because ANCHOR is not an expected outcome');

        eq(readFileSync(subject, 'utf8'), 'export const VALUE = 1;\n',
            'the subject file is RESTORED — a harness that leaves a mutation behind is worse than none');
        ok(!existsSync(subject + '.mutate-backup'), '  and its backup is cleaned up');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

section('4. mutate — it refuses to start on a stale backup', () => {
    /*
     * The guard that exists because a timeout killed a run mid-experiment and left
     * a mutation in the working tree, where the next run read it as source. It
     * costs nothing to test: the refusal happens before any work.
     */
    const stray = join(ROOT, 'tools', 'zz-smoke-probe.mjs.mutate-backup');
    try {
        writeFileSync(stray, '// left behind by a killed run\n');
        const r = runNode(['tools/mutate.mjs', './mutations.catalogue.mjs', '--filter', 'Smoke']);
        eq(r.code, 2, 'a stale .mutate-backup makes the tool exit 2 without running anything');
        ok(/REFUSING TO RUN/.test(r.out), '  and say so');
        ok(r.out.includes('zz-smoke-probe'), '  naming the file it found');
        ok(!/experiments/.test(r.out), '  before any experiment starts');
    } finally {
        rmSync(stray, { force: true });
    }

    attempt('and runs normally once it is gone', () => {
        const r = runNode(['tools/mutate.mjs', './mutations.catalogue.mjs', '--filter', 'no-such-task']);
        ok(!/REFUSING TO RUN/.test(r.out), 'with no stale backup the tool starts');
        /*
         * CHANGED AT W-7, and the change is the point. A filter that matches nothing
         * used to exit 0 - this assertion was written to show the tool STARTS, and
         * an empty filter was the cheapest way to do that without running 167
         * experiments. But a mistyped task id that quietly does nothing and reports
         * success is the exact failure this workspace keeps finding, and `--filter`
         * is now an EXACT task id, which makes a typo far likelier than it was under
         * substring matching. It exits 1 and says what the syntax is (D-129).
         */
        eq(r.code, 1, '  and a filter matching nothing is a failure, not a silent no-op');
        ok(/EXACT task id/.test(r.out), '  saying what --filter takes');
    });
});

section('5. the catalogue is a real index, not a stale list', () => {
    /*
     * Every anchor is an exact source string, so the catalogue rots as the code
     * moves. `mutate.mjs` reports that as ANCHOR-MISSING when run — but it is only
     * run by hand. This checks the anchors WITHOUT running the experiments, which
     * is cheap enough to gate.
     */
    // Imported at module scope: `section` takes a synchronous callback and top-level
    // await is where an ESM import goes (the LOD-1 lesson).
    ok(MUTATIONS.length > 20, `the catalogue holds ${MUTATIONS.length} experiments`);
    const stale = [];
    for (const m of MUTATIONS) {
        const path = join(ROOT, m.file);
        if (!existsSync(path)) { stale.push(`${m.label}: file ${m.file} is gone`); continue; }
        const src = readFileSync(path, 'utf8');
        const hits = src.split(m.from).length - 1;
        if (hits !== 1) { stale.push(`${m.label}: anchor matches ${hits} times in ${m.file}`); }
        if (!existsSync(join(ROOT, m.suite))) { stale.push(`${m.label}: suite ${m.suite} is gone`); }
    }
    eq(stale.length, 0,
        `every catalogue anchor still matches exactly once  ${stale[0] ?? ''}`);
});

section('the engine module graph is a tree with a leaf that imports nothing (W-6)', () => {
    /*
     * `D-091` recorded that `Engine.ts` had ZERO top-level imports, and that the
     * graph must stay a tree — building the aggregate palette needs `Oklch`, and
     * `Engine.ts` importing it would have made two modules need each other.
     *
     * `W-6` moved the severity ladder to `BinSeverity.ts` and `Engine.ts` now
     * imports it, so the ROOT moved rather than the invariant breaking (`DEV-022`).
     * The invariant that actually matters is asserted here rather than left as a
     * comment: there is a leaf that depends on nothing, and it is reachable from
     * everything else.
     *
     * The EMITTED `.js` is what is read, not the `.ts`. A `import type` is erased,
     * and it is the runtime graph the framework loads.
     */
    const MODULES = ['BinSeverity', 'BinPalette', 'Engine', 'GridAggregate', 'Oklch'];
    const imports = new Map(MODULES.map((m) => {
        const src = readFileSync(join(ROOT, `Helpers/SubstrateMapEngine/${m}.js`), 'utf8');
        return [m, [...src.matchAll(/^import[^;]*from\s*'\.\/(\w+)\.js'/gm)].map((x) => x[1])];
    }));

    attempt('BinSeverity is the leaf: it imports nothing at all', () => {
        deep(imports.get('BinSeverity'), [],
            `BinSeverity.js imports ${JSON.stringify(imports.get('BinSeverity'))}`);
    });

    attempt('Engine depends on it, and on nothing else', () => {
        /*
         * TWO EDGES SINCE `W-40a`. `SpatialFilter` joined the graph when the filters
         * were finally wired into the render - the engine dispatches, and a runtime
         * import is what makes that possible.
         *
         * The rule this assertion protects is unchanged and worth restating: `Oklch`
         * must stay OUT. It is the colour-space maths, needed to BUILD a palette and
         * never to paint one, and letting the render path reach it would put a
         * cbrt-per-pixel temptation one autocomplete away.
         *
         * `SpatialFilter` is a different kind of dependency: it is a render-path
         * operation over the render path's own buffers, and the engine is where it
         * belongs. Added deliberately, not absorbed.
         */
        deep(imports.get('Engine'), ['SpatialFilter', 'BinSeverity'],
            'Engine.js imports the severity ladder and the filters — Oklch must stay out');
    });

    attempt('BinPalette is where palette construction went, and Engine still does not import it', () => {
        /*
         * `W-11` needed `categoricalPalette` — which lives in `Oklch` — inside the
         * bin-colour decision. `Oklch` imports nothing, so `Engine` COULD have
         * imported it without a cycle; `D-091`'s reason is about what belongs in the
         * hot module, not about acyclicity, so the construction went to a new node
         * and the result is handed in as an argument.
         */
        deep(imports.get('BinPalette').sort(), ['BinSeverity', 'Oklch'],
            `BinPalette.js imports ${JSON.stringify(imports.get('BinPalette'))}`);
        ok(!imports.get('Engine').includes('BinPalette'),
            '  and Engine.js does not import it back');
    });

    attempt('there is no cycle', () => {
        const cycles = [];
        for (const start of MODULES) {
            const seen = new Set();
            const walk = (m, path) => {
                if (path.includes(m)) { cycles.push([...path, m].join(' -> ')); return; }
                if (seen.has(m)) { return; }
                seen.add(m);
                for (const next of imports.get(m) ?? []) { walk(next, [...path, m]); }
            };
            walk(start, []);
        }
        eq(cycles.length, 0, `no module reaches itself  ${cycles[0] ?? ''}`);
    });
});

section('the mutation runner selects and batches what it says it does (W-7)', () => {
    /*
     * Observation 141's lesson, one tool along. `--filter` was a SUBSTRING over
     * task and label, so `--filter LOD-1` quietly ran LOD-10 through LOD-19 as
     * well - eight times the work, reported as though it were the one task asked
     * for. Asserted here rather than described, because a CLI nobody imports is a
     * CLI nobody tests.
     *
     * Importing `mutate.mjs` at all is only safe because W-7 put its CLI behind a
     * main guard. Before that this import would have started a 167-experiment run,
     * which is not a hypothetical: it happened, the sitting's limit killed it
     * part-way through a `.ts` mutation, and a live mutation was left in the tree
     * (observation 179).
     */
    const FAKE = [
        { task: 'W-1', label: 'a', project: 'p' }, { task: 'W-1', label: 'b', project: 'p' },
        { task: 'W-10', label: 'c', project: 'p' }, { task: 'W-2', label: 'd' },
        { task: 'W-10', label: 'e', project: 'p' },
    ];

    attempt('--filter is exact: W-1 does not match W-10', () => {
        deep(selectMutations(FAKE, { filter: 'W-1' }).map((m) => m.label), ['a', 'b'],
            'only the two W-1 experiments');
        eq(selectMutations(FAKE, { filter: 'W-10' }).length, 2, 'and W-10 selects its own two');
        eq(selectMutations(FAKE, { filter: 'W-3' }).length, 0, 'and an unknown task selects nothing');
    });

    attempt('a trailing * is the prefix form, and it is the only one', () => {
        eq(selectMutations(FAKE, { filter: 'W-1*' }).length, 4, 'W-1* takes W-1 and W-10');
        eq(selectMutations(FAKE, { filter: 'W-*' }).length, 5, 'and W-* takes them all');
    });

    attempt('--grep is the loose search, under a name that admits it', () => {
        eq(selectMutations(FAKE, { grep: 'W-1' }).length, 4, 'grep still matches by substring');
        eq(selectMutations(FAKE, { grep: 'd' }).length, 1, 'and it reaches the label as well as the task');
    });

    attempt('a batch takes whole tasks, wherever they sit in the catalogue', () => {
        /*
         * W-10 is at index 2 and index 4 with W-2 between them. Grouping by
         * ADJACENCY split it across two batches - which would have recorded the
         * task as done after the first half and never run the second. The plan view
         * showed it before any batch had run; `LOD-15` was the real instance.
         */
        const batches = planBatches(FAKE, 2);
        const where = new Map();
        batches.forEach((b, i) => {
            for (const t of new Set(b.map((m) => m.task))) { where.set(t, (where.get(t) ?? []).concat(i)); }
        });
        deep([...where].filter(([, at]) => at.length > 1), [], 'no task appears in two batches');
        eq(batches.flat().length, FAKE.length, 'and every experiment is in exactly one');
    });

    attempt('--reset stops, it does not reset and then run everything', () => {
        /*
         * The third kill of this task, and the only one the TOOL caused rather than
         * the way it was called: `--reset` forgot the progress file and fell through
         * into a full 167-experiment run, because neither --batch nor --plan was
         * set. A flag that means "undo something" must never also mean "and now do
         * everything".
         *
         * AGAINST A ONE-ENTRY THROWAWAY CATALOGUE, not the real one. The obvious
         * version pointed at `mutations.catalogue.mjs`, so proving the defect meant
         * REPRODUCING the half-hour run every time the assertion's own mutation ran
         * — which is what happened, and killed a `check-negatives` pass. A test of a
         * runaway must not be able to run away.
         */
        const dir = join(ROOT, 'tools/.reset-scratch');
        mkdirSync(dir, { recursive: true });
        try {
            const cat = join(dir, 'catalogue.mjs');
            writeFileSync(join(dir, 'subject.mjs'), 'export const V = 1;\n');
            writeFileSync(join(dir, 'suite.mjs'), 'console.log("  RESULT: 1 passed, 0 failed");\n');
            writeFileSync(cat, 'export const MUTATIONS = ['
                + "{ task: 'Reset', label: 'x', file: 'tools/.reset-scratch/subject.mjs', project: null,"
                + " suite: 'tools/.reset-scratch/suite.mjs',"
                + " from: 'export const V = 1;', to: 'export const V = 2;' }];\n");
            const r = runNode(['tools/mutate.mjs', cat, '--reset']);
            eq(r.code, 0, '--reset exits 0');
            ok(/progress forgotten/.test(r.out), '  saying what it did');
            ok(!/experiments/.test(r.out), '  and no run was started');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    attempt('the real catalogue batches cleanly at the default budget', () => {
        const batches = planBatches(MUTATIONS, 20);
        eq(batches.flat().length, MUTATIONS.length,
            `all ${MUTATIONS.length} experiments are covered by ${batches.length} batches`);
        const where = new Map();
        batches.forEach((b, i) => {
            for (const t of new Set(b.map((m) => m.task))) { where.set(t, (where.get(t) ?? []).concat(i)); }
        });
        deep([...where].filter(([, at]) => at.length > 1), [], 'and no real task is split either');
    });
});

section('Desktop.view\'s six-column grid is generated, not hand-edited (F-29)', () => {
    /*
     * Columns 1-3 are the maps, 4-6 their companions, each handed the SAME data
     * attribute its map carries. `tools/relayout-desktop.mjs --check` owns the rule
     * for which attribute a companion may take, and this delegates rather than
     * restating it - two implementations of that rule would be the second copy the
     * generator exists to avoid (`D-258`).
     *
     * HERE AND NOT IN `check-hmiextproj`, which is where `F-29` first put it.
     * `check-as-shipped` attributes a missing input to a tool by TEXTUAL MENTION, so
     * naming `Desktop.view` anywhere inside a checker blocks the whole checker in the
     * delivered tree - eight working sections lost to gate one new one. This suite is
     * already gated on that input, so the check costs nothing that was not already
     * spent (`D-259`).
     */
    /*
     * THE GUARD IS AT THE READ AND BEFORE THE ATTEMPTS (`D-221`). `Desktop.view` is
     * repository-internal and ships in no archive, so in the delivered tree this
     * whole section must SKIP. Calling `requireInput` first lets `section` catch
     * `MissingExternalInput` and gate it; running the generator first instead made
     * it die on ENOENT and report a failure, which is a missing input dressed up as
     * a defect.
     */
    const view = readFileSync(requireInput('Desktop.view'), 'utf8');
    const r = runNode(['tools/relayout-desktop.mjs', '--check']);

    attempt('the grid matches what the generator would write', () => {
        eq(r.code, 0, `relayout-desktop --check exits 0  ${String(r.out).slice(0, 200)}`);
        ok(/\d+ maps and their companions, in step/.test(r.out),
            'and reports the count it checked, so an empty grid cannot pass quietly');
    });

    attempt('every companion carries its map\'s own binding', () => {
        /*
         * The property the generator exists for, asserted against the file rather
         * than against the generator: a companion showing a different lot from the
         * map beside it is the one failure a reader would not spot.
         */
        const tags = [];
        const re = /<div\s+id="([A-Za-z0-9_]+)"\s+data-tchmi-type="([^"]+)"/g;
        let m;
        while ((m = re.exec(view)) !== null) {
            let i = re.lastIndex;
            let q = null;
            for (; i < view.length; i++) {
                const ch = view[i];
                if (q !== null) { if (ch === q) { q = null; } continue; }
                if (ch === '"' || ch === "'") { q = ch; continue; }
                if (ch === '>') { break; }
            }
            tags.push({ id: m[1], attrs: Object.fromEntries(
                [...view.slice(m.index, i).matchAll(/data-tchmi-([a-z0-9-]+)="([^"]*)"/g)]
                    .map((x) => [x[1], x[2]])) });
        }
        const by = new Map(tags.map((t) => [t.id, t]));
        const sides = tags.filter((t) => t.id.startsWith('Side_'));
        ok(sides.length > 0, `the grid has companions to check (${sides.length})`);
        let bound = 0;
        const wrong = [];
        for (const side of sides) {
            const map = by.get(`SubstrateMap_${side.id.slice(5)}`);
            ok(map !== undefined, `${side.id} names a map that is on the page`);
            if (!('grid-data' in map.attrs)) { continue; }
            bound++;
            if (side.attrs['grid-data'] !== map.attrs['grid-data']) {
                wrong.push(side.id);
            }
        }
        eq(wrong.length, 0,
            `every bound companion shows its map's data${wrong.length ? ` (${wrong[0]})` : ''}`);
        ok(bound > 0, `and some are bound: ${bound} of ${sides.length}`);
    });
});

section('Desktop.view binds the events it claims to (W-9)', () => {
    /*
     * Observation 150: the reference page demonstrated RENDERING and bound no events at
     * all, which is why the event surface was the one nobody had ever run. W-9 wires
     * two of them. Whether a click produces output is a LIVE-VIEW question and only the
     * user can answer it; what is checkable here is that the wiring names things that
     * exist, and that is exactly the half that rots when a panel or an event is renamed.
     */
    const view = readFileSync(requireInput('Desktop.view'), 'utf8');
    const control = readFileSync(join(ROOT, 'Controls/SubstrateMap/SubstrateMap.ts'), 'utf8');
    const wiring = [...view.matchAll(/\{ control: '([^']+)', event: '([^']+)', label: '([^']*)' \}/g)]
        .map((m) => ({ control: m[1], event: m[2], label: m[3] }));

    attempt('both events are wired', () => {
        eq(wiring.length, 2, 'two entries in the event log wiring');
        deep(wiring.map((w) => w.event).sort(), ['onGroupSelected', 'onItemSelected'],
            'and they are the two the control raises');
    });

    attempt('each panel is wired to an event it can actually raise (W-9a)', () => {
        /*
         * THE ASSERTION W-9 NEEDED AND DID NOT HAVE. It wired
         * SubstrateMap_GridData to onItemSelected on the claim that its dies were big
         * enough for a single-die hit. Measured from the view itself: 13 x 11 cells
         * of 4.2 mm inside a si-4in-p111 outline in 440 x 400 px is about 4 px/mm, so
         * a die is roughly 17 CSS px against a default TouchTargetSize of 40. A tap
         * there can only GROUP, and the live view said so on the first click.
         *
         * The rule this checks is the one the arithmetic gives: a panel whose dies
         * fall under the touch target can only raise onGroupSelected, and an ITEM hit
         * needs a panel that has items.
         */
        for (const w of wiring) {
            const div = new RegExp(`<div\\s+id="${w.control}"[\\s\\S]*?>`).exec(view);
            ok(div !== null, `${w.control} is on the page`);
            const attrs = Object.fromEntries(
                [...div[0].matchAll(/data-tchmi-([a-z0-9-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
            const hasItems = 'items' in attrs;
            const hasGrid = 'grid-data' in attrs || 'e142-map-data' in attrs;
            if (w.event === 'onItemSelected') {
                ok(hasItems, `${w.control} binds items, so it can raise onItemSelected`);
            } else {
                ok(hasGrid, `${w.control} binds a grid, so it can raise onGroupSelected`);
            }
        }
    });

    attempt('the script is INSIDE the view root', () => {
        /*
         * The other half of what W-9 got wrong: the script sat after the closing
         * </div> of #Desktop, where a host that inserts a view by taking the root
         * element's markup never sees it. It never ran once, and the placeholder that
         * was supposed to say so could not, because it was positioned past the view's
         * computed content height and was not visible either.
         */
        const script = view.indexOf('<script>');
        const rootClose = view.lastIndexOf('</div>');
        ok(script !== -1, 'the view carries a script');
        ok(script < rootClose,
            `the script at ${script} comes before the view root's closing tag at ${rootClose}`);
    });

    attempt('every wired panel is on the page and every event is really raised', () => {
        for (const w of wiring) {
            ok(new RegExp(`<div\\s+id="${w.control}"`).test(view),
                `${w.control} is a panel on the page`);
            ok(control.includes(`this.__id + '.${w.event}'`),
                `  and SubstrateMap.ts raises .${w.event} under the control id`);
            ok(w.label.trim().length > 0, `  and ${w.control} logs under a label`);
        }
    });

    attempt('the log announces itself, and says so when it cannot arm', () => {
        /*
         * W-9 had an on-page readout. It was a positioned <div> past the last panel,
         * and #Desktop is a TcHmiView with height-mode Content that sizes itself from
         * the CONTROLS it manages — so a plain div there is outside the box and was
         * never visible. The console is what worked in the live run, and it is what
         * the page uses now. Both branches must say something: silence at either end
         * is indistinguishable from "no click yet".
         */
        ok(/event log armed/.test(view), 'it announces itself when it arms');
        ok(/never appeared; nothing is armed/.test(view), '  and warns when TcHmi never turns up');
        ok(!/EventReadout/.test(view), 'and the readout that could not be seen is gone');
    });

    attempt('panel 6 draws, and the page says what changed (W-14)', () => {
        /*
         * W-9 marked this panel as a DEFECT: it bound an outline and the demo, and
         * drew nothing. W-14 made the demo draw into the outline, so the marking is
         * now a description of history rather than of a fault. What is asserted is
         * that the page explains the behaviour and no longer promises a fix that
         * has happened.
         */
        const at = view.indexOf('PANEL 6 - the demo drawing INTO a bound outline');
        ok(at !== -1, 'panel 6 explains that the demo draws into the outline');
        ok(!/PANEL 6 - DEFECT/.test(view), '  and is no longer marked as a defect');
        ok(!/reports SUBSTRATEMAP_DEMO_SUPPRESSED_BY_OUTLINE/.test(view),
            '  and does not claim a warning the control no longer raises');
    });
});

section('every engine export with no runtime consumer says so (W-12)', () => {
    /*
     * `TODO.md` B0b: the shipped engine carries functions the control never calls.
     * That is defensible — this project decides palettes by measurement, and a
     * measurement a suite performs for itself is one nobody can check — but an
     * export with no runtime consumer reads as a promise to whoever finds it in the
     * module surface, and the name cannot tell you which it is.
     *
     * ---- COMPUTED, NOT LISTED ----
     *
     * The set is derived from the sources every time: exported functions in the
     * engine, minus every name any NON-TEST source mentions. A list written down
     * would go stale exactly as `TODO.md` B0b's did — `categoricalPalette` and
     * `minPairwiseDeltaE` were on it until W-11 wired them, and nothing noticed.
     * This fails in BOTH directions: a new unconsumed export that carries no marker,
     * and a marked export that has since gained a caller.
     */
    const ENGINE = 'Helpers/SubstrateMapEngine';
    const MARK = 'MEASURING SURFACE FOR TESTS';
    const modules = readdirSync(join(ROOT, ENGINE))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

    /** Exported function names, and the source they came from. */
    const exported = new Map();
    for (const m of modules) {
        const src = readFileSync(join(ROOT, ENGINE, m), 'utf8');
        for (const x of src.matchAll(/^export function (\w+)/gm)) { exported.set(x[1], m); }
    }

    /* Every non-test source that could call one: the engine itself and the two controls. */
    const callers = [
        ...modules.map((m) => [`${ENGINE}/${m}`, readFileSync(join(ROOT, ENGINE, m), 'utf8')]),
        ['Controls/SubstrateMapBase/SubstrateMapBase.ts',
            readFileSync(join(ROOT, 'Controls/SubstrateMapBase/SubstrateMapBase.ts'), 'utf8')],
        ['Controls/SubstrateMap/SubstrateMap.ts',
            readFileSync(join(ROOT, 'Controls/SubstrateMap/SubstrateMap.ts'), 'utf8')],
    ];

    /** @param name An export. @returns Whether a non-test source CALLS it. */
    const hasRuntimeCaller = (name) => callers.some(([path, src]) => {
        // Its own definition and its own doc comment do not count as a caller.
        const body = path.endsWith(`/${exported.get(name)}`)
            ? src.replace(new RegExp(`export function ${name}\\b`), '')
            : src;
        const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
        return new RegExp(`\\b${name}\\s*\\(`).test(stripped);
    });

    /*
     * THE SIX, and not the computed set. Sixteen engine exports have no caller
     * inside this package; ten of them are a different question — the model API in
     * MODEL-API.md §2 and §6 exists for a consumer OUTSIDE the package, and the
     * engine counters and `gridCacheKeyForTest` are instrumentation. Sorting those
     * two groups out is not this task (observation 203). What is asserted here is
     * the property that matters for these six: each has no runtime caller AND says
     * so, and the assertion fails if either half moves.
     */
    const MEASURING = ['accumulateBuckets', 'aggregateClosestApproach', 'aggregationFactorLinear',
        'bucketIsPainted', 'deltaECss', 'maxSeverity'];
    const unconsumed = MEASURING.filter((n) => !hasRuntimeCaller(n)).sort();
    const marked = [...exported.entries()].filter(([n]) => MEASURING.includes(n))
        .filter(([n, m]) => {
            const src = readFileSync(join(ROOT, ENGINE, m), 'utf8');
            const at = src.indexOf(`export function ${n}`);
            return at !== -1 && src.lastIndexOf(MARK, at) > src.lastIndexOf('*/', src.lastIndexOf('/**', at));
        })
        .map(([n]) => n).sort();

    attempt('none of the six has gained a runtime caller', () => {
        deep(unconsumed, MEASURING,
            `all six still have no runtime caller: ${JSON.stringify(unconsumed)}`);
    });

    attempt('each of them says so in its own documentation', () => {
        deep(marked, unconsumed,
            `marked ${JSON.stringify(marked)} vs unconsumed ${JSON.stringify(unconsumed)}`);
    });

    attempt('and MODEL-API.md names the same six', () => {
        const doc = readFileSync(join(ROOT, ENGINE, 'MODEL-API.md'), 'utf8');
        /*
         * A TABLE ROW, not a mention. The first form of this asked whether the name
         * appeared anywhere in the document, and the `check-negatives` case that
         * removes a row went UNCAUGHT — the same name is also in the prose two
         * paragraphs below, so deleting its row changed nothing the test could see.
         */
        const listed = unconsumed.filter((n) => new RegExp(`^\\| \`${n}\`\\s*\\|`, 'm').test(doc));
        deep(listed, unconsumed, 'every unconsumed export has its own row in section 8');
        ok(/`categoricalPalette` and `minPairwiseDeltaE` did when/.test(doc) && !/W-11/.test(doc),
            '  and the two that left the list are accounted for, by what happened rather than a task id');
    });
});

section('the two no-data images, and the tool that can make a dark one (W-16a)', () => {
    /*
     * `W-16` GENERATED the dark variant with `tools/recolor-svg.mjs`, and said in
     * as many words that a designer could replace it. One has. `NoDataBaseDark.svg`
     * is now a separate drawing: 65 paths against the light one's 47, colour laid
     * on as 61 inline `style="fill:"` attributes the tool's regex never touches,
     * and a cyan accent at chroma 0.079 that appears nowhere in the light variant,
     * whose maximum chroma is 0.0031.
     *
     * ---- WHAT WAS DELETED, AND WHY DELETED RATHER THAN RELAXED ----
     *
     * `W-16` asserted that the checked-in dark file was byte-identical to a fresh
     * `recolorSvg(light)`, and that both files had the same path count. Both are
     * now false, and both were RIGHT to become false. The tool's own header said
     * what to do about it before it happened: *"A designer's hand-painted
     * replacement fails it, which is correct: the file is theirs at that point and
     * the tool should not be claiming to have produced it. Delete the check from
     * the gate, do not weaken it."*
     *
     * A relaxed version - "byte-identical OR hand-edited" - would assert nothing at
     * all, and would go on implying the shipped file came from the tool.
     */
    const light = readFileSync(join(ROOT, 'Controls/SubstrateMapBase/NoDataBase.svg'), 'utf8');
    const dark = readFileSync(join(ROOT, 'Controls/SubstrateMapBase/NoDataBaseDark.svg'), 'utf8');
    const lch = (c) => Oklch.rgbToOklch(Oklch.parseRgb(c));
    const fillsIn = (svg) => [...new Set(
        [...svg.matchAll(/fill:\s*(#[0-9a-fA-F]{3,8})/g)].map((m) => m[1].toLowerCase()))];

    attempt('both ship, and the control asks for exactly these two', () => {
        const proj = readFileSync(join(ROOT, 'SubstrateMap.hmiextproj'), 'utf8');
        ok(proj.includes('NoDataBase.svg'), 'NoDataBase.svg is in the project');
        ok(proj.includes('NoDataBaseDark.svg'), '  and NoDataBaseDark.svg is too');
        const base = readFileSync(join(ROOT, 'Controls/SubstrateMapBase/SubstrateMapBase.js'), 'utf8');
        ok(base.includes("'NoDataBase.svg'") && base.includes("'NoDataBaseDark.svg'"),
            '  and the base names both as its defaults');
    });

    attempt('SAME VIEWBOX — the one thing that must hold across the pair', () => {
        /*
         * The invariant that survives the designer, and the only one that has to.
         * `containRect` scales by natural size, so two variants with different
         * aspect ratios would letterbox differently and the illustration would jump
         * when the theme changed. Everything else about the two files is the
         * designer's business.
         */
        const box = (svg) => /viewBox="([^"]+)"/.exec(svg)?.[1];
        eq(box(dark), box(light), `both are ${box(light)}`);
        ok((light.match(/<path/g) ?? []).length > 0, 'and both have paths');
        ok((dark.match(/<path/g) ?? []).length > 0, '  in each file');
    });

    attempt('they are genuinely different drawings, and that is recorded not assumed', () => {
        ok(light !== dark, 'the two files differ');
        const maxC = (svg) => Math.max(...fillsIn(svg).map((c) => lch(c).C));
        ok(maxC(light) < 0.005, `the light one is monochrome: max chroma ${maxC(light).toFixed(4)}`);
        ok(maxC(dark) > 0.02, `the dark one has colour: max chroma ${maxC(dark).toFixed(4)}`);
        ok(Recolor.recolorSvg(light).text !== dark,
            'and the dark one is NOT what the tool would produce — it is the designer\'s');
    });

    attempt('the tool still works, asserted on a fixture rather than on the shipped pair', () => {
        /*
         * `recolor-svg.mjs` is kept: it is the fallback for a project with no
         * designer, and `W-16`'s reasoning for it stands — `filter: invert()`
         * rotates hue and turns a blue accent orange.
         *
         * Tested against a FIXTURE from here on. Testing it against the shipped
         * files is what made the gate a hostage to whether a designer had touched
         * them.
         */
        const fixture = '<svg viewBox="0 0 10 10"><style>'
            + '.st0 { fill: #ffffff; } .st1 { fill: #1b6ec2; } .st2 { fill: #101010; }'
            + '</style><path class="st0" d="M0 0"/></svg>';
        const { text, changed, unparseable } = Recolor.recolorSvg(fixture);
        eq(changed, 3, 'three fills rewritten');
        eq(unparseable.length, 0, 'and all three parsed');
        const out = [...text.matchAll(/fill:\s*(#[0-9a-fA-F]{6})/g)].map((m) => m[1].toLowerCase());
        ok(lch(out[0]).L < 0.2, `white becomes dark (${out[0]})`);
        ok(lch(out[2]).L > 0.8, `and near-black becomes light (${out[2]})`);
        const drift = Math.abs((((lch('#1b6ec2').h - lch(out[1]).h) + 540) % 360) - 180);
        ok(drift <= 2, `the blue keeps its hue: ${drift.toFixed(2)} deg — which invert() would not`);
    });

    attempt('the FLOOR is where 8-bit sRGB stops resolving, not a taste', () => {
        /* Kept from `W-16`: rgb(1,1,1) is the first grey that is not black, so a
         * mirror that goes below its L has nowhere to land. `D-150`. */
        const firstNonBlack = lch('#010101').L;
        ok(Recolor.FLOOR > firstNonBlack,
            `FLOOR ${Recolor.FLOOR} sits above L(rgb 1,1,1) = ${firstNonBlack.toFixed(4)}`);
        ok(Recolor.FLOOR < 0.15, '  and low enough that the darkest output is still dark');
        ok(lch(Recolor.mirrorColor('#ffffff')).L >= Recolor.FLOOR - 0.01,
            '  so pure white lands at the floor rather than on black');
    });

    attempt('the arithmetic the involution Done-when was a proxy for (D-151)', () => {
        /* Unchanged by the designer's file: this is about `Oklch`, not about the
         * SVG. No OKLCH round trip through 8-bit hex can be an involution, so what
         * is asserted is that the conversion pair are inverses to within a step. */
        let worst = 0;
        for (const c of fillsIn(light)) {
            const rgb = Oklch.parseRgb(c);
            const back = Oklch.oklchToRgb(Oklch.rgbToOklch(rgb));
            worst = Math.max(worst,
                Math.abs(back.r - rgb.r), Math.abs(back.g - rgb.g), Math.abs(back.b - rgb.b));
        }
        ok(worst <= 1, `rgb -> oklch -> rgb is exact to ${worst.toFixed(3)} of 255`);
    });
});

finish();
