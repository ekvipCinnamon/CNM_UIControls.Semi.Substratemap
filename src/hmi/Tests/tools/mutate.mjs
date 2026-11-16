/*
 * mutate.mjs - run mutation experiments, and refuse to report one that did not
 * actually run.
 *
 * WHY THIS EXISTS. Every mutation run in this workspace up to Task 16 was done by
 * hand, in this shape:
 *
 *     npx tsc -p ... >/dev/null 2>&1      # exit code discarded
 *     node <suite>                        # runs against whatever .js exists
 *
 * If the mutated TypeScript does not compile, `tsc` emits nothing, the PREVIOUS
 * `.js` stays on disk, and the suite runs unmutated code - reporting a clean pass.
 * On a console that is indistinguishable from "the mutation ran and no assertion
 * caught it", which is the single most misleading outcome the technique has: a
 * broken edit and a missing test produce the same green result.
 *
 * The exposure is ASYMMETRIC, which is worth stating because it bounds the damage.
 * A mutation reported as CAUGHT is trustworthy - a non-compiling mutation yields
 * zero failures, so any reported failure proves the code compiled and ran. Only a
 * SURVIVED report is suspect, and only for a `.ts` mutation; a fixture mutation has
 * no compile step to fail.
 *
 * So this tool distinguishes four outcomes and never collapses them:
 *
 *   ANCHOR   the text to replace is not in the file, or is not unique. The
 *            experiment never happened. Loud, because a mutation catalogue rots as
 *            the code moves and a silently skipped entry is a test that stopped
 *            existing without anyone noticing.
 *   COMPILE  the mutation did not typecheck. The experiment never happened either,
 *            and this is the case the hand-rolled loop reported as a pass.
 *   CAUGHT   the suite ran mutated code and failed. The assertion exists.
 *   SURVIVED the suite ran mutated code and passed. Either an assertion is missing
 *            or the code is unreachable - and the second answer argues for deleting
 *            code rather than adding a test (D-046).
 *
 * The working tree is restored and re-emitted after every experiment, including
 * after a failure, so a crashed run cannot leave mutated source behind.
 *
 * ---- WHY IT RUNS IN BATCHES (W-7, observation 106) ----
 *
 * 167 experiments, 152 of them needing a `tsc`, at about ten seconds each: close
 * to half an hour, which is longer than a single sitting here allows. A run that
 * is killed part-way used to leave a live mutation in the tree; the module-level
 * `pending` set closed that, but the run still could not FINISH, so the catalogue
 * had quietly stopped being something anyone ran whole.
 *
 * `--batch` fixes the second half. Whole tasks are taken until an experiment
 * budget is reached, the verdicts are appended to a progress file, and the next
 * invocation continues where the last stopped. Tasks rather than a flat count so
 * one task's results are never split across two reports; a budget rather than a
 * fixed number of tasks because they range from one experiment to eight.
 *
 * Run: node tools/mutate.mjs [catalogue.mjs] [options]
 *
 *   --filter LOD-6     exactly the task `LOD-6`. NOT a substring: `--filter LOD-1`
 *                      used to match LOD-10 through LOD-19 as well (observation
 *                      141, the same lesson as `check-hmiextproj`'s path prefixes).
 *   --filter 'LOD-*'   every task whose id starts `LOD-`.
 *   --grep text        substring, over task AND label. The old `--filter`, under a
 *                      name that says it is loose.
 *   --batch [n]        run the next unfinished tasks, up to n experiments
 *                      (default 20, about three minutes), and record progress.
 *   --plan             print the batches and their costs; run nothing.
 *   --reset            forget the recorded progress.
 *
 * Exit: 0 if every experiment reached CAUGHT or an expected SURVIVED; 1 otherwise.
 *       A `--batch` invocation exits 0 while work remains, and reports what is
 *       left; the tally is only complete when the last batch has run.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUFFIX = '.mutate-backup';

/**
 * Files currently mutated, with the backup that restores them.
 *
 * A `try/finally` restores on a throw and NOT on a kill, and this tool is slow
 * enough to be killed by a timeout - which happened, and left a mutation in the
 * working tree where a later run mistook it for real source. So the pending set is
 * module-level and every exit route drains it.
 */
const pending = new Map();

/** Restores every mutated file. Safe to call twice. */
function restoreAll() {
    for (const [path, backup] of pending) {
        try {
            if (existsSync(backup)) { copyFileSync(backup, path); unlinkSync(backup); }
        } catch { /* best effort: a partial restore still beats none */ }
    }
    pending.clear();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => { restoreAll(); process.exit(130); });
}
process.on('exit', restoreAll);
process.on('uncaughtException', (e) => { restoreAll(); console.error(e); process.exit(1); });

/*
 * A backup left behind means a previous run died before restoring, so the working
 * tree holds a mutation that looks like source. Refuse to start: running on top of
 * it would produce results about code nobody wrote.
 */
{
    const stale = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name.startsWith('.')) { continue; }
                walk(join(dir, e.name));
            } else if (e.name.endsWith(SUFFIX)) { stale.push(join(dir, e.name)); }
        }
    };
    walk(ROOT);
    if (stale.length > 0) {
        console.error('\nREFUSING TO RUN: a previous run left these backups behind, so the working');
        console.error('tree holds a mutation, not source. Restore each and delete the backup:\n');
        for (const f of stale) { console.error('   ' + f.slice(ROOT.length + 1)); }
        console.error('');
        process.exit(2);
    }
}

/**
 * Runs a command, returning its exit code and output instead of throwing.
 * @param cmd  The executable.
 * @param args Its arguments.
 * @returns `{ code, out }`.
 */
function run(cmd, args) {
    try {
        return { code: 0, out: execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
        return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
}

/**
 * Compiles one project, reporting whether the emit actually happened.
 *
 * `--noEmitOnError` is the whole point: `tsc` writes output even when it reports
 * errors unless told not to, so without it a broken mutation would still land a
 * half-emitted `.js` and the experiment would test something nobody wrote. With
 * it, a non-zero exit means NOTHING was written - and the caller can say so
 * instead of running the suite against stale output.
 *
 * One invocation rather than a `--noEmit` check followed by an emit, because two
 * runs of `tsc` per experiment is most of this tool's wall time.
 * @param project The tsconfig path, relative to the repo root.
 * @returns `{ ok, out }`.
 */
function build(project) {
    const r = run('npx', ['tsc', '-p', project, '--noEmitOnError']);
    return { ok: r.code === 0, out: r.out };
}

/**
 * Applies one mutation, runs its suite, and restores the tree.
 * @param m       The experiment.
 * @param project The tsconfig to rebuild, or null for a non-source mutation.
 * @returns `{ verdict, detail }`.
 */
function experiment(m, project) {
    // Repo-relative by contract. `join(ROOT, '/tmp/x')` silently yields
    // `<ROOT>/tmp/x` rather than failing, so an absolute entry would be reported
    // as ANCHOR-MISSING for a file that exists - a wrong diagnosis, which is the
    // class of thing this tool exists to avoid producing.
    if (isAbsolute(m.file)) {
        return { verdict: 'ANCHOR', detail: `file must be repo-relative, got the absolute ${m.file}` };
    }
    const path = join(ROOT, m.file);
    const backup = path + '.mutate-backup';
    const source = readFileSync(path, 'utf8');

    const hits = source.split(m.from).length - 1;
    if (hits !== 1) {
        return { verdict: 'ANCHOR', detail: `matched ${hits} times, expected exactly 1` };
    }

    copyFileSync(path, backup);
    pending.set(path, backup);
    try {
        writeFileSync(path, source.replace(m.from, m.to));
        if (project !== null) {
            const built = build(project);
            if (!built.ok) {
                // THE CASE THE HAND-ROLLED LOOP REPORTED AS A PASS.
                return {
                    verdict: 'COMPILE',
                    detail: (built.out.split('\n').find((l) => l.includes('error')) ?? '').trim().slice(0, 96),
                };
            }
        }
        const suite = run('node', [m.suite]);
        const result = (suite.out.split('\n').find((l) => l.includes('RESULT:')) ?? '').trim();
        const failed = /(\d+) failed/.exec(result);
        const n = failed === null ? 0 : Number(failed[1]);
        return n > 0
            ? { verdict: 'CAUGHT', detail: `${n} assertion${n === 1 ? '' : 's'} — ${firstFailure(suite.out)}` }
            : { verdict: 'SURVIVED', detail: result };
    } finally {
        // Restore the SOURCE here; the emitted output is rebuilt once at the end of
        // the run rather than after every experiment. Each experiment rebuilds
        // before its own suite, so a stale `.js` cannot leak from one into the next.
        copyFileSync(backup, path);
        unlinkSync(backup);
        pending.delete(path);
    }
}

/**
 * @param out A suite's output.
 * @returns The first reported failure, trimmed.
 */
function firstFailure(out) {
    const line = out.split('\n').find((l) => l.trimStart().startsWith('- '));
    return line === undefined ? '' : line.trim().slice(2, 96);
}

/* ------------------------------------------------------------- selection */

/**
 * The experiments a set of options names.
 *
 * `filter` matches the TASK and matches it EXACTLY, or as a prefix when it ends
 * in `*`. It used to be a substring over task and label together, which made
 * `--filter LOD-1` silently include LOD-10 through LOD-19 — eight times the
 * intended work, reported as though it were the one task asked for. Substring
 * search still exists as `grep`, under a name that admits what it does.
 * @param list    The catalogue.
 * @param options `{ filter, grep }`, either or both null.
 * @returns The chosen experiments, in catalogue order.
 */
export function selectMutations(list, { filter = null, grep = null } = {}) {
    let out = list;
    if (filter !== null) {
        out = filter.endsWith('*')
            ? out.filter((m) => m.task.startsWith(filter.slice(0, -1)))
            : out.filter((m) => m.task === filter);
    }
    if (grep !== null) {
        out = out.filter((m) => m.task.includes(grep) || m.label.includes(grep));
    }
    return out;
}

/**
 * Groups experiments into batches of whole tasks, each under an experiment budget.
 *
 * WHOLE TASKS, so one task's verdicts are never split across two reports and a
 * reader never has to join them up. A budget rather than a fixed number of tasks
 * because tasks range from one experiment to eight, and a batch of eight tasks
 * would be anything from eight to fifty. A single task larger than the budget
 * still gets its own batch rather than being split — the alternative is a batch
 * that cannot be run at all.
 * @param list   The chosen experiments, in catalogue order.
 * @param budget Experiments per batch.
 * @returns An array of batches, each an array of experiments.
 */
export function planBatches(list, budget) {
    /*
     * Grouped by TASK ID across the whole catalogue, not by adjacency. The
     * catalogue is not sorted: `LOD-15` has entries in two places, and an
     * adjacency grouping put them in batch 2 and batch 6 — which would have
     * recorded the task as done after the first half and never run the second.
     * The plan view is what showed it, before any batch had run.
     */
    const groups = new Map();
    for (const m of list) {
        if (!groups.has(m.task)) { groups.set(m.task, []); }
        groups.get(m.task).push(m);
    }
    const byTask = [...groups.values()];
    const batches = [];
    let current = [];
    for (const task of byTask) {
        if (current.length > 0 && current.length + task.length > budget) {
            batches.push(current);
            current = [];
        }
        current.push(...task);
    }
    if (current.length > 0) { batches.push(current); }
    return batches;
}

/* -------------------------------------------------------------------- CLI */

/*
 * EVERYTHING BELOW IS BEHIND A MAIN GUARD, and it was not until W-7 wanted to
 * unit-test the selection.
 *
 * `selectMutations` and `planBatches` are exported so `tools-smoke` can assert
 * them without running anything. Importing this file used to START A FULL RUN -
 * 167 experiments, half an hour - because the CLI was top level. That is exactly
 * what happened the first time the plan was tested from an import: the run was
 * killed by the sitting's time limit part-way through a `.ts` mutation, and the
 * module-level `pending` drain does NOT survive a kill, so a live mutation was
 * left in `SubstrateMapBase.ts`. The `.mutate-backup` beside it is what made the
 * recovery mechanical rather than a hunt (observation 179).
 */
if (process.argv[1] === undefined || import.meta.url !== pathToFileURL(process.argv[1]).href) {
    // Imported, not run. Nothing else in this file executes.
} else {
    await main();
}

/**
 * The command line.
 * @returns Nothing; exits the process.
 */
async function main() {

/** Where a batched run remembers what it has already done. Not tracked by git. */
const PROGRESS = join(ROOT, 'tools/.mutate-progress.json');

/** @returns The recorded progress, or an empty record. */
function readProgress() {
    if (!existsSync(PROGRESS)) { return { catalogue: null, done: {} }; }
    try {
        return JSON.parse(readFileSync(PROGRESS, 'utf8'));
    } catch {
        return { catalogue: null, done: {} };
    }
}

const argv = process.argv.slice(2);
const flagAt = (name) => argv.indexOf(name);
const valueOf = (name, fallback = null) => {
    const i = flagAt(name);
    if (i === -1) { return fallback; }
    const next = argv[i + 1];
    return next === undefined || next.startsWith('--') ? fallback : next;
};

const cataloguePath = (argv[0] !== undefined && !argv[0].startsWith('--'))
    ? argv[0] : './mutations.catalogue.mjs';
const filter = valueOf('--filter');
const grep = valueOf('--grep');
const wantPlan = flagAt('--plan') !== -1;
const wantBatch = flagAt('--batch') !== -1;
const budget = Number(valueOf('--batch', '20')) || 20;

if (flagAt('--reset') !== -1) {
    /*
     * RESET AND STOP. The first version forgot the progress file and then fell
     * through into a full 167-experiment run, because neither --batch nor --plan
     * was set. The sitting's limit killed it and it left a live mutation - the
     * third time in this task, and the only one caused by the tool rather than by
     * how it was called. A flag that means "undo something" must never also mean
     * "and now do everything".
     */
    if (existsSync(PROGRESS)) { unlinkSync(PROGRESS); }
    console.log('\n  progress forgotten\n');
    process.exit(0);
}

const { MUTATIONS } = await import(cataloguePath.startsWith('.')
    ? new URL(cataloguePath, import.meta.url).href
    : cataloguePath);

const selected = selectMutations(MUTATIONS, { filter, grep });
if (selected.length === 0) {
    console.log(`\n  nothing matched${filter === null ? '' : ` --filter ${filter}`}`
        + `${grep === null ? '' : ` --grep ${grep}`}. `
        + `--filter is an EXACT task id, or a prefix ending in *.\n`);
    process.exit(1);
}

const progress = readProgress();
const doneTasks = new Set(Object.keys(progress.done ?? {}));
const remaining = wantBatch ? selected.filter((m) => !doneTasks.has(m.task)) : selected;
const batches = planBatches(remaining, budget);

if (wantPlan) {
    console.log(`\n  ${selected.length} experiments in ${new Set(selected.map((m) => m.task)).size} tasks`);
    if (doneTasks.size > 0) { console.log(`  ${doneTasks.size} tasks already recorded as done`); }
    console.log(`  ${batches.length} batches at a budget of ${budget}:\n`);
    batches.forEach((b, i) => {
        const tasks = [...new Set(b.map((m) => m.task))];
        // Measured, not guessed: a `.ts` experiment is a tsc plus a suite, about
        // ten seconds; a fixture experiment is the suite alone, about one.
        const secs = b.filter((m) => m.project).length * 10 + b.filter((m) => !m.project).length;
        console.log(`   ${String(i + 1).padStart(3)}.  ${String(b.length).padStart(2)} experiments  `
            + `~${String(Math.ceil(secs / 60)).padStart(2)} min   ${tasks.join(', ')}`);
    });
    console.log('');
    process.exit(0);
}

const chosen = wantBatch ? (batches[0] ?? []) : selected;
if (wantBatch && chosen.length === 0) {
    console.log(`\n  every selected task is already recorded. --reset to start again.\n`);
    process.exit(0);
}

console.log('\n=================================================');
console.log(`  mutation harness — ${chosen.length} experiments`
    + `${wantBatch ? ` (batch 1 of ${batches.length}, ${remaining.length} left before it)` : ''}`);
console.log('=================================================\n');

const tally = { CAUGHT: 0, SURVIVED: 0, COMPILE: 0, ANCHOR: 0 };
const unexpected = [];
for (const m of chosen) {
    const { verdict, detail } = experiment(m, m.project ?? null);
    tally[verdict]++;
    const flag = verdict === 'CAUGHT' ? ' '
        : verdict === 'SURVIVED' && m.expect === 'SURVIVED' ? ' '
            : '!';
    if (flag === '!') { unexpected.push(`${m.task} ${m.label}: ${verdict} — ${detail}`); }
    console.log(`${flag} ${m.task.padEnd(9)} ${verdict.padEnd(9)} ${m.label}`);
    if (detail !== '') { console.log(`             ${detail}`); }
}

/* The tree was restored after every experiment but not re-emitted; do it once. */
for (const project of new Set(chosen.map((m) => m.project).filter((p) => p != null))) {
    const rebuilt = build(project);
    if (!rebuilt.ok) {
        console.log(`\n!! the final rebuild of ${project} FAILED — the tree may be inconsistent`);
        unexpected.push(`final rebuild of ${project}`);
    }
}

console.log('\n=================================================');
console.log(`  CAUGHT ${tally.CAUGHT}   SURVIVED ${tally.SURVIVED}   `
    + `COMPILE-FAIL ${tally.COMPILE}   ANCHOR-MISSING ${tally.ANCHOR}`);
if (unexpected.length > 0) {
    console.log('  NOT AS EXPECTED:');
    for (const u of unexpected) { console.log('   - ' + u); }
}

if (wantBatch) {
    /*
     * Recorded per TASK, not per experiment: a task is the unit a batch takes, so
     * a half-finished task cannot be recorded as done. The file is written AFTER
     * the final rebuild above, so a resume always starts from a rebuilt tree.
     */
    for (const task of new Set(chosen.map((m) => m.task))) {
        const own = chosen.filter((m) => m.task === task);
        progress.done[task] = {
            experiments: own.length,
            unexpected: unexpected.filter((u) => u.startsWith(`${task} `)).length,
            at: new Date().toISOString(),
        };
    }
    progress.catalogue = cataloguePath;
    writeFileSync(PROGRESS, JSON.stringify(progress, null, 1));
    const left = batches.length - 1;
    const totals = Object.values(progress.done);
    console.log(`  recorded: ${Object.keys(progress.done).length} tasks, `
        + `${totals.reduce((n, t) => n + t.experiments, 0)} experiments, `
        + `${totals.reduce((n, t) => n + t.unexpected, 0)} not as expected`);
    console.log(left > 0
        ? `  ${left} batch${left === 1 ? '' : 'es'} left — run the same command again`
        : '  the catalogue has been run whole');
}
console.log('=================================================\n');
/*
 * A batch with work left exits 0 even so: it did what it was asked, and a
 * non-zero exit would make a shell loop stop on the FIRST batch rather than the
 * first failure. Unexpected verdicts within the batch still fail it.
 */
process.exit(unexpected.length > 0 ? 1 : 0);
}
