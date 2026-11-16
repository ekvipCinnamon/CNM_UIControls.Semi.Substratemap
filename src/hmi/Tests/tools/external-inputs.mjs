/**
 * external-inputs.mjs — the difference between "not run" and "failed".
 *
 * WHY THIS EXISTS (F-2, review M3/T3). Three files that the suites and the
 * checkers read ship in neither archive: `Desktop.view`, which is the reference
 * view eight sections drive; `SubstrateMap-Working-Protocol.md`, which three
 * assertions and `check-manifest` quote; and `STATE.md`, which `check-state` is
 * entirely about. Out of the box a consumer therefore gets 16 red assertions and
 * two dead checkers, and nothing in the output distinguishes a product defect
 * from a file that was never delivered. Sixteen reds that mean "we did not send
 * you a file" train a reader to ignore reds.
 *
 * THE RULE. **Not run is not failed.** A section whose declared input is absent
 * is SKIPPED: the file is named, the section is named, the count is a third
 * column, and the exit code stays 0. Under `--strict` the same absence is a
 * FAILURE — because inside this repository the files ARE present, so an absence
 * means something broke rather than something was not shipped. The repository's
 * own gate runs strict.
 *
 * WHY THE GUARD SITS AT THE READ. The obvious design annotates each section with
 * what it needs. Eight sections drive `Desktop.view` today; a ninth added next
 * task would silently go red again. So the throw is raised where the file is
 * opened — `requireInput` — and `section()`/`attempt()` in the harness turn it
 * into a skip wherever it surfaces. A list that has to be maintained by hand
 * drifts from the thing it describes; this one cannot (observation 347).
 *
 * Provenance: `D-221`. `[Inference]` `[A]`.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Repository root, resolved from this file rather than from `cwd`. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Raised by `requireInput` when a declared external input is not on disk.
 *
 * Carries the file name so the reporter can group sections by the file that
 * gated them, rather than printing the same path once per section.
 */
export class MissingExternalInput extends Error {
    /** @param file Repository-relative path of the absent input. */
    constructor(file) {
        super(`external input not present: ${file}`);
        this.name = 'MissingExternalInput';
        this.code = 'MISSING_EXTERNAL_INPUT';
        this.file = file;
    }
}

/**
 * True when absence should be a failure rather than a skip.
 *
 * Two channels because there are two kinds of caller. A checker is invoked
 * directly and can take `--strict` on the command line; a suite is invoked as
 * `node --test <files>`, where trailing arguments belong to node and never reach
 * the suite, so it reads the environment instead.
 */
export const isStrict = () => process.argv.includes('--strict')
    || process.env.SUBSTRATEMAP_STRICT === '1';

/** Every input asked for so far, present or not — for the reporter. */
const declared = new Map();

/**
 * Declares a file this code cannot run without.
 *
 * @param file Repository-relative path, e.g. `Desktop.view`.
 * @returns The absolute path, when the file is there.
 * @throws {MissingExternalInput} when it is not.
 */
export function requireInput(file) {
    const abs = join(ROOT, file);
    const present = existsSync(abs);
    declared.set(file, present);
    if (!present) { throw new MissingExternalInput(file); }
    return abs;
}

/** @returns `[file, present]` for everything `requireInput` has been asked for. */
export const declaredInputs = () => [...declared.entries()];

/**
 * The skip path for a checker, which has no harness to catch the throw.
 *
 * Prints the banner, names the file and what it gated, and returns the exit code
 * the caller should use: 0 for a skip, 1 under `--strict`. The caller exits, so
 * that a checker with other work left can carry on.
 *
 * @param file  Repository-relative path of the absent input.
 * @param gates One line per thing that did not run.
 * @returns The exit code.
 */
export function reportSkippedTool(file, gates) {
    const strict = isStrict();
    const rule = strict ? 'REQUIRED INPUT ABSENT' : 'SKIPPED';
    console.log('\n========================================================');
    console.log(`  ${rule} - ${file} is not present`);
    console.log('========================================================');
    console.log(`  missing input     : ${file}`);
    for (const g of gates) { console.log(`  not checked       : ${g}`); }
    console.log(`  ships in          : neither archive (F-2)`);
    if (strict) {
        console.log('  --strict is on, so this is a failure: inside this repository');
        console.log('  the file is present, and its absence means something broke.');
    } else {
        console.log('  Nothing was checked here. This is a skip, not a failure -');
        console.log('  supply the file, or run with --strict to make it one.');
    }
    console.log('========================================================');
    return strict ? 1 : 0;
}
