/*
 * harness.mjs - counters, assertions and the crash guard, in one place.
 *
 * WHY THIS EXISTS. Two suites grew a local `attempt(label, fn)` helper to stop a
 * thrown TypeError killing the run. It works, and it failed twice anyway, because
 * it is opt-in PER CALL SITE: the author has to predict which assertion might
 * throw and wrap that one. Task 7 discovered the need through a mutation run;
 * Task 10 rediscovered it in a second file, for the same reason, three tasks
 * later. Nine of the eleven suites still had no guard at all.
 *
 * A guard you have to remember is a guard that is not there. So protection is
 * now automatic and layered, and `attempt` is demoted to an optimisation:
 *
 *   1. SECTION. `section(title, fn)` runs one family. A throw inside it is
 *      recorded as a named failure and the NEXT section still runs. Forgetting a
 *      finer guard now costs the rest of that family, not the whole run.
 *   2. FINISH. `finish()` is called at the end and prints the summary. Because
 *      each section already caught, a suite cannot exit on a stack trace with no
 *      counts - which is the outcome that made the original failures hard to
 *      read, since a crash discards the pass count and every later failure too.
 *   3. ATTEMPT. Still available for the case sections cannot cover: a loop where
 *      one bad iteration must not skip the others. Not required anywhere.
 *
 * WHY THE ASSERTIONS MOVED HERE TOO. They were copied into both suites and had
 * already drifted - one used `function ok`, the other a const arrow, and only one
 * formatted the expected/actual pair. Two copies of a counter is how a suite ends
 * up reporting a different total from its neighbour.
 */

/**
 * A fresh set of counters, assertions and guards for one suite.
 * @returns `{ ok, eq, deep, section, attempt, finish, counts }`.
 */
import { MissingExternalInput, isStrict } from '../../../../tools/external-inputs.mjs';

export function makeHarness() {
    let pass = 0;
    let fail = 0;
    const failures = [];
    /** file -> the sections it gated. A third column: not run is not failed (F-2). */
    const skips = new Map();

    /**
     * Turns a missing declared input into a skip, or into a failure under
     * `--strict`. Returns false when `e` is not one, so the caller rethrows or
     * records a real failure instead.
     * @param e     The caught value.
     * @param where The section or step it escaped from.
     * @returns Whether it was handled here.
     */
    const asSkip = (e, where) => {
        if (!(e instanceof MissingExternalInput)) { return false; }
        if (isStrict()) {
            fail++;
            failures.push(`${where}: REQUIRED INPUT ABSENT — ${e.file} (--strict)`);
            return true;
        }
        if (!skips.has(e.file)) { skips.set(e.file, []); }
        skips.get(e.file).push(where);
        console.log(`  SKIPPED — needs ${e.file}, which ships in neither archive (F-2)`);
        return true;
    };

    /**
     * @param cond  The condition.
     * @param label What is being asserted, phrased so a failure reads as a defect.
     */
    const ok = (cond, label) => {
        if (cond) { pass++; } else { fail++; failures.push(label); }
    };

    /**
     * @param actual   The value.
     * @param expected What it should be.
     * @param label    What is being asserted.
     */
    const eq = (actual, expected, label) => ok(Object.is(actual, expected),
        `${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

    /**
     * @param actual   The value.
     * @param expected What it should be, compared by JSON shape.
     * @param label    What is being asserted.
     */
    const deep = (actual, expected, label) => ok(
        JSON.stringify(actual) === JSON.stringify(expected),
        `${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);

    /**
     * Runs one family of assertions under a heading.
     *
     * The automatic layer: an escaping throw becomes a named failure and the next
     * section still runs. Nothing has to be anticipated for this to hold.
     * @param title The heading.
     * @param fn    The family.
     */
    const section = (title, fn) => {
        console.log(`\n=== ${title} ===`);
        try {
            fn();
        } catch (e) {
            if (asSkip(e, title)) { return; }
            fail++;
            failures.push(`${title}: SECTION ABORTED — ${e.code ?? e.name}: `
                + `${String(e.message).split('\n')[0].slice(0, 90)}`);
        }
    };

    /**
     * Runs one step inside a section, so a throw skips the step rather than the
     * rest of the family. For loops where later iterations still carry meaning.
     * @param label What the step is.
     * @param fn    The step; its return value is passed through.
     * @returns `fn()`'s value, or `null` if it threw.
     */
    const attempt = (label, fn) => {
        try {
            return fn();
        } catch (e) {
            if (asSkip(e, label)) { return null; }
            fail++;
            failures.push(`${label}  (threw ${e.code ?? e.name}: `
                + `${String(e.message).split('\n')[0].slice(0, 70)})`);
            return null;
        }
    };

    /**
     * Prints the summary and exits non-zero if anything FAILED.
     *
     * A skip does not colour the exit code. That is the whole point: a file
     * that was never delivered is not a defect in what was (F-2). It is loud
     * in the output and it is counted, so it cannot grow quietly.
     */
    const finish = () => {
        const skipped = [...skips.values()].reduce((n, v) => n + v.length, 0);
        console.log('\n========================================================');
        console.log(`  RESULT: ${pass} passed, ${fail} failed`
            + `${skipped > 0 ? `, ${skipped} skipped` : ''}`);
        if (fail > 0) {
            console.log('  FAILURES:');
            for (const f of failures) { console.log('   - ' + f); }
        }
        if (skipped > 0) {
            console.log('  SKIPPED — an input that ships in neither archive (F-2):');
            for (const [file, where] of skips) {
                console.log(`   - ${file}  gates ${where.length}:`);
                for (const w of where) { console.log(`       ${w}`); }
            }
            console.log('  Not run is not failed. Supply the file, or run with');
            console.log('  SUBSTRATEMAP_STRICT=1 to make an absence a failure.');
        }
        console.log('========================================================');
        process.exit(fail > 0 ? 1 : 0);
    };

    /** @returns The current counts, for a suite that wants to assert on them. */
    const counts = () => ({ pass, fail, failures: failures.slice(),
        skipped: [...skips.values()].reduce((n, v) => n + v.length, 0) });

    return { ok, eq, deep, section, attempt, finish, counts };
}

/**
 * The last-resort crash guard: no suite may ever exit on a bare stack trace.
 *
 * WHY A SECOND MECHANISM. `section()` catches a throw inside a family, but it can
 * only catch what runs inside it. Every suite also does work at module level -
 * loading fixtures, building shared documents, computing constants - and three
 * suites have families that are loops or bare statement runs rather than `{ }`
 * blocks, which cannot be wrapped without scoping away declarations the later
 * families use. A throw in any of those escapes.
 *
 * When it escapes, the process dies with a stack trace and the run reports
 * NOTHING: not the pass count, not the failures that were already recorded. This
 * handler turns that into a normal summary plus one named `SUITE ABORTED` entry,
 * and exit 1.
 *
 * One line per suite, no restructuring, and it composes with `section()` rather
 * than replacing it: sections let the run CONTINUE past a dead family, this only
 * guarantees the run REPORTS. Every suite should have this; a suite whose
 * families are all `{ }` blocks should have both.
 *
 * @param state A closure returning `{ pass, fail, failures, skipped? }` at the
 *              moment of the crash - a closure rather than the values, because
 *              the counts move as the suite runs.
 */
export function onCrash(state) {
    process.on('uncaughtException', (e) => {
        const { pass = 0, failures = [], skipped } = state() ?? {};
        const all = failures.concat(
            `SUITE ABORTED — ${e.code ?? e.name}: ${String(e.message).split('\n')[0].slice(0, 90)}`);
        console.log('\n========================================================');
        console.log(`  RESULT: ${pass} passed, ${all.length} failed`
            + (skipped === undefined ? '' : `, ${skipped} skipped`));
        console.log('  FAILURES:');
        for (const f of all) { console.log('   - ' + f); }
        console.log('  (the suite stopped here — assertions after this point never ran)');
        console.log('========================================================');
        process.exit(1);
    });
}

/** Documents carry `Uint32Array` and `Map`; render both comparably. */
export const normalize = (doc) => JSON.stringify(doc, (k, v) =>
    (ArrayBuffer.isView(v) ? Array.from(v) : (v instanceof Map ? [...v] : v)));

/**
 * @param fn A call expected to throw.
 * @returns The thrown error's `code` (or `name`), or `null` if it did not throw.
 */
export const threw = (fn) => {
    try { fn(); return null; } catch (e) { return e.code ?? e.name; }
};
