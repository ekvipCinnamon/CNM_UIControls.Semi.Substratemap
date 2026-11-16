#!/usr/bin/env node
/*
 * check-negatives.mjs - every gate assertion, proved to fire.
 *
 * WHY THIS EXISTS. A gate that returns green is evidence of nothing until
 * someone has seen it return red for the reason it claims. That is not a
 * theoretical worry here; it went wrong twice in three tasks:
 *
 *   W-1  the negative test's exit code was read through a pipe, so `$?` was
 *        `tail`'s status and a finding was reported as rc=0. The tool was
 *        right and the measurement was wrong.
 *   W-2  `check-hmiextproj`'s new duplicate check did not fire on a `files`
 *        entry that climbed out of its own directory - the path was never
 *        normalised, so the two spellings were two keys. It passed on exactly
 *        the case it exists to catch, and a different finding in the same run
 *        made rc=1 look like success.
 *
 * Both were caught by hand, in the session, by someone who happened to read
 * the output rather than the exit code. Neither would have been caught the
 * next time. This file is the next time.
 *
 * WHAT IT DOES. For each case: apply one defect to the tree, run the gate
 * command, require a non-zero exit AND the finding tag that names the defect,
 * then revert with `git checkout --`. A case that exits non-zero for the WRONG
 * reason counts as missed, which is the W-2 failure exactly.
 *
 * NOT IN THE GATE LIST, deliberately. It mutates tracked files, so it must not
 * run inside `node --test` alongside suites that read them, and a killed run
 * has to be recoverable. Two guards: it refuses to start unless `git status`
 * is clean, and it verifies the tree is clean again before it reports. Run it
 * when a gate assertion is added or changed - Rule 22.
 *
 * Run:  node tools/check-negatives.mjs [--fast | --slow]
 *       --fast  only the cases that run a checker: 21 of them, under a minute.
 *       --slow  only the cases that run a full test suite, some with a tsc emit
 *               first. Together with --fast they are the whole file, and splitting
 *               the run is how it fits in one sitting.
 *       --only S  only cases whose gate or description contains S. The slow half
 *               outgrew a sitting once W-10 added four more; this is how it is cut
 *               smaller without inventing a second batching scheme.
 *
 * IF A RUN IS KILLED. This file mutates tracked files and restores them in a
 * `finally`, which does not run when the process is killed - and the sitting's
 * time limit killed it twice while W-7 was being written, each time leaving a
 * mutation behind. `git checkout --` on the named file is the whole recovery, and
 * the marker written below names it: the next run refuses to start and says which
 * case was interrupted, instead of reporting a generic dirty tree.
 * Exit: 0 every mutation caught and the tree clean, 1 otherwise, 2 refused.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FAST = process.argv.includes('--fast');
const SLOW = process.argv.includes('--slow');
const ONLY = (() => {
    const i = process.argv.indexOf('--only');
    return i === -1 ? null : process.argv[i + 1] ?? null;
})();

/** Names the case currently mutated, so a killed run leaves a diagnosis. */
const MARKER = join(ROOT, 'tools/.check-negatives-active');

/*
 * Every TypeScript project, DISCOVERED (W-25b).
 *
 * This was three hard-coded paths. `W-25a` added a fourth control and the list
 * did not know: mutating `SubstrateMapFilterBar.ts` never re-emitted its `.js`,
 * the suite ran against stale output, and four cases in a row reported MISSED
 * for a mutation that had never reached the code.
 *
 * That is `D-173`'s finding again in a third place - a list cannot catch its own
 * omission - and the fix is the same one: read the filesystem. Ordered so a base
 * emits before anything that imports it, which `Helpers` before `Controls` gives
 * for free here.
 */
const TS_PROJECTS = [
    ...readdirSync(join(ROOT, 'Helpers'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'Helpers', e.name, 'tsconfig.json')))
        .map((e) => `Helpers/${e.name}`),
    ...readdirSync(join(ROOT, 'Controls'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(ROOT, 'Controls', e.name, 'tsconfig.json')))
        .map((e) => `Controls/${e.name}`),
].sort((a, b) => (a.startsWith('Helpers') === b.startsWith('Helpers') ? a.localeCompare(b)
    : a.startsWith('Helpers') ? -1 : 1));

/*
 * A record number that will never exist, for mutations that must create a
 * DANGLING reference. THREE cases have rotted by naming a plausible number that a
 * later task then defined for real — `D-140` at W-9a, `D-141` at W-12 — at which
 * point the mutation stopped being a dangling reference and the case reported
 * itself MISSED, correctly and uselessly.
 *
 * Fixed here rather than case by case, which is what observation 178 got wrong:
 * the first instance was repaired where it broke, so the same shape broke twice
 * more. Nothing will reach nine hundred.
 */
const NEVER = 'D-900';

/** @returns The porcelain status, empty when clean. */
const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();

if (existsSync(MARKER)) {
    const left = readFileSync(MARKER, 'utf8');
    console.error('check-negatives: a previous run was KILLED while a mutation was applied.');
    console.error(left.split('\n').map((l) => '  ' + l).join('\n'));
    console.error('\n  Restore with:  git checkout -- <the files above>');
    console.error(`  Then delete:   ${MARKER}`);
    process.exit(2);
}
if (status() !== '') {
    console.error('check-negatives: the tree is dirty. This tool edits tracked files and restores');
    console.error('them with `git checkout --`, which would discard your work. Commit or stash first.');
    process.exit(2);
}

/**
 * Replaces `old` with `next` in a tracked file, in the file's OWN line ending.
 * Rule 19: a literal written with `\n` matches nothing in a CRLF file, and the
 * mutation would then silently not happen - which reads as "the gate missed it".
 * @param rel  Path relative to the repository root.
 * @param old  The literal to replace, written with `\n`.
 * @param next What to put there, written with `\n`.
 */
function edit(rel, old, next, all = false) {
    const p = join(ROOT, rel);
    const s = readFileSync(p, 'utf8');
    const eol = s.includes('\r\n') ? '\r\n' : '\n';
    const from = old.split('\n').join(eol);
    const to = next.split('\n').join(eol);
    if (!s.includes(from)) {
        throw new Error(`mutation target not found in ${rel}: ${JSON.stringify(from.slice(0, 60))}`);
    }
    // `all` for a colour that appears dozens of times: replacing the FIRST
    // occurrence of `fill:#83d3d7` left forty-six behind, the assertion still saw
    // colour, and the case reported itself MISSED (W-16a).
    writeFileSync(p, all ? s.split(from).join(to) : s.replace(from, to));
}

/** @param rels Paths to restore. */
const restore = (rels) => {
    if (rels.length > 0) { execFileSync('git', ['checkout', '--', ...rels], { cwd: ROOT }); }
};

/**
 * Deletes files a case CREATED. `git checkout --` restores tracked files and does
 * nothing about untracked ones, so a case that writes a fixture has to say so or
 * it leaves the tree dirty and the next run refuses to start.
 * @param rels Paths to remove.
 */
const cleanup = (rels) => {
    for (const rel of rels ?? []) { rmSync(join(ROOT, rel), { force: true }); }
};

/**
 * @param cmd A command line.
 * @returns `{ rc, out }` - stdout and stderr together, and the REAL exit code.
 *          Not through a pipe, which is what went wrong at W-1.
 */
function run(cmd, env) {
    const [bin, ...args] = cmd.split(' ');
    // `env` because a suite cannot be put in strict mode from the command line:
    // `node --test <file>` re-spawns the file and trailing arguments never reach
    // it, so SUBSTRATEMAP_STRICT is the only channel (F-2).
    const r = spawnSync(bin, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        env: env ? { ...process.env, ...env } : process.env });
    return { rc: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

const STATE = 'STATE.md';
const TODO = 'TODO.md';
const GATES1 = 'gates/W-1.md';
const README = 'README.md';
const UKLOC = 'Controls/SubstrateMap/en-UK.localization';
const CONTRIB = 'CONTRIBUTING.md';
const ENGINE_TS = 'Helpers/SubstrateMapEngine/Engine.ts';
const RELNOTES = 'CHANGELOG.md';
const DESC_MAP = 'Controls/SubstrateMap/Description.json';
const CHECKSTATE = 'tools/check-state.mjs';
const TSBASE = 'tsconfig.base.json';
const TSBASE_PROJ = 'Controls/SubstrateMapBase/tsconfig.json';
const TESTSDOC = 'Helpers/SubstrateMapEngine/tests/README.md';
const TSJ = 'Helpers/SubstrateMapEngine/tsconfig.json';
const TST = 'Helpers/SubstrateMapEngine/tsconfig.tpl.json';
const BASEJ = 'Controls/SubstrateMapBase/tsconfig.json';
const PROJ = 'SubstrateMap.hmiextproj';
const DESC = 'Controls/SubstrateMap/Description.json';
const MANI = 'Manifest.json';
const TYPECHECK = 'typecheck.sh';
const PKGCFG = 'packages.config';
/**
 * True when `Packages/` carries a framework ControlDescription schema. The
 * third direction of check-descriptors (W-8c) validates against it, and
 * Framework 14.4.5 ships no schemas at all - so on a 14.4.5 payload the two
 * schema mutations have nothing to hit and would score MISSED for the absence
 * of an input rather than a hole in the gate (D-217).
 */
const hasFrameworkSchema = () => existsSync(join(ROOT, 'Packages'))
    && readdirSync(join(ROOT, 'Packages')).some((v) => existsSync(
        join(ROOT, 'Packages', v, 'runtimes/native1.12-tchmi/Schema/ControlDescription.Schema.json')));
const BINCHARTJ = 'Controls/SubstrateMapBinChart/tsconfig.json';
const HARNESS = 'tools/attach-harness.mjs';
const ITEMSEL = 'Controls/SubstrateMap/Schema/TypeDefinitions/ItemSelection.Schema.json';
const ENGINE = 'Helpers/SubstrateMapEngine/Engine.ts';
const BINSEV = 'Helpers/SubstrateMapEngine/BinSeverity.ts';
const MUTATE = 'tools/mutate.mjs';
const VIEW = 'Desktop.view';
const SM = 'Controls/SubstrateMap/SubstrateMap.ts';
const SPATIAL = 'Helpers/SubstrateMapEngine/SpatialFilter.ts';
const PATTERNS = 'node --test Helpers/SubstrateMapEngine/tests/patterns.test.mjs';
const MANIFEST = 'Manifest.json';
const PKG = 'package.json';
const PROTO = 'SubstrateMap-Working-Protocol.md';
const SMBASE2 = 'Controls/SubstrateMapBase/SubstrateMapBase.ts';
const WIDGET = 'Controls/SubstrateMapWidget/SubstrateMapWidget.ts';
const CHART = 'Controls/SubstrateMapBinChart/SubstrateMapBinChart.ts';
const CHARTDESC = 'Controls/SubstrateMapBinChart/Description.json';
const FILTER = 'Helpers/SubstrateMapEngine/SpatialFilter.ts';
const WTPL = 'Controls/SubstrateMapWidget/Template.html';
const CTPL = 'Controls/SubstrateMapBinChart/Template.html';
const NUSPEC = 'SubstrateMap.nuspec';
const ROOTREADME = 'repository-root/README.md';
const ARCHDOC = 'ARCHITECTURE.md';
const PATTERN = 'WIDGET-PATTERN.md';
const NOTES = 'CHANGELOG.md';
const FSHEET = 'tools/filter-sheet.mjs';
const SHEET = 'tools/chart-sheet.mjs';
const CHARTTHEMEDARK = 'Controls/SubstrateMapBinChart/Themes/Base-Dark/Style.css';
const CHARTTHEME = 'Controls/SubstrateMapBinChart/Themes/Base/Style.css';
const WTHEME = 'Controls/SubstrateMapWidget/Themes/Base/Style.css';
const WTHEMEDARK = 'Controls/SubstrateMapWidget/Themes/Base-Dark/Style.css';
const WDESC = 'Controls/SubstrateMapWidget/Description.json';
const FBAR = 'Controls/SubstrateMapFilterBar/SubstrateMapFilterBar.ts';
const FBDESC = 'Controls/SubstrateMapFilterBar/Description.json';
const RECOLOR = 'tools/recolor-svg.mjs';
const DARKSVG = 'Controls/SubstrateMapBase/NoDataBaseDark.svg';
const SMBASE = 'Controls/SubstrateMapBase/SubstrateMapBase.ts';
const OKLCH = 'Helpers/SubstrateMapEngine/Oklch.ts';
const GRIDAGG = 'Helpers/SubstrateMapEngine/GridAggregate.ts';
const MODELAPI = 'Helpers/SubstrateMapEngine/MODEL-API.md';
const BINPAL = 'Helpers/SubstrateMapEngine/BinPalette.ts';
const BINSTAT = 'Controls/SubstrateMap/Schema/TypeDefinitions/BinStatistics.Schema.json';
const SMOKE = 'node --test Helpers/SubstrateMapEngine/tests/tools-smoke.test.mjs';
const AGGSUITE = 'node --test Helpers/SubstrateMapEngine/tests/grid-aggregate.test.mjs';
const GRID_SUITE = 'node --test Helpers/SubstrateMapEngine/tests/grid-render.test.mjs';
const SHIMS = 'Helpers/SubstrateMapEngine/tests/lib/dom-shims.mjs';
const JQLINK = 'Packages/Beckhoff.TwinCAT.HMI.Framework.14.5.1/runtimes/native1.12-tchmi/Lib/JQuery';
/** True when `rel` is a symbolic link - lstat, because stat follows it. */
function isLink(rel) {
    try { return lstatSync(join(ROOT, rel)).isSymbolicLink(); } catch { return false; }
}

const CHECK_STATE = 'node tools/check-state.mjs';
const CHECK_README = 'node tools/check-readme.mjs';
const CHECK_PROJ = 'node tools/check-hmiextproj.mjs';
const CHECK_DESC = 'node tools/check-descriptors.mjs';
const CHECK_MANI = 'node tools/check-manifest.mjs';
const SUITE = 'node --test Helpers/SubstrateMapEngine/tests/e142-representations.test.mjs';

/**
 * `{ gate, what, files, apply, cmd, tag, slow }`. `tag` is the finding the
 * output must contain - a non-zero exit alone is not a pass, because a tool
 * can fail for a reason unrelated to the defect and look correct doing it.
 */
const CASES = [
    /* ---------------------------------------------------------- check-state */
    /* --------------------- 6. external inputs: skip vs fail (F-2, D-221) ---- */
    // The mechanism's whole claim is that an absent declared input SKIPS and exits
    // 0, and FAILS under --strict. A skip that exits 0 is indistinguishable from a
    // check that ran and passed unless something proves the strict half fires, so
    // these mutate by moving the file aside — it is tracked, but `git checkout --`
    // restores a deletion, so `files` alone would be enough; `undo` is kept so an
    // interrupted run leaves nothing renamed.
    { gate: 'check-state', what: 'STATE.md absent, under --strict', files: [], tag: 'REQUIRED INPUT ABSENT',
        cmd: CHECK_STATE + ' --strict',
        needs: () => existsSync(join(ROOT, 'STATE.md')),
        apply: () => renameSync(join(ROOT, 'STATE.md'), join(ROOT, 'STATE.md.negatives-hold')),
        undo: () => renameSync(join(ROOT, 'STATE.md.negatives-hold'), join(ROOT, 'STATE.md')) },
    { gate: 'check-manifest', what: 'the Working Protocol absent, under --strict', files: [],
        tag: 'REQUIRED INPUT ABSENT', cmd: CHECK_MANI + ' --strict',
        needs: () => existsSync(join(ROOT, 'SubstrateMap-Working-Protocol.md')),
        apply: () => renameSync(join(ROOT, 'SubstrateMap-Working-Protocol.md'),
            join(ROOT, 'SubstrateMap-Working-Protocol.md.negatives-hold')),
        undo: () => renameSync(join(ROOT, 'SubstrateMap-Working-Protocol.md.negatives-hold'),
            join(ROOT, 'SubstrateMap-Working-Protocol.md')) },
    { gate: 'node --test', what: 'Desktop.view absent, under SUBSTRATEMAP_STRICT', files: [],
        tag: 'REQUIRED INPUT ABSENT',
        cmd: 'node --test Helpers/SubstrateMapEngine/tests/tools-smoke.test.mjs',
        env: { SUBSTRATEMAP_STRICT: '1' },
        needs: () => existsSync(join(ROOT, 'Desktop.view')),
        apply: () => renameSync(join(ROOT, 'Desktop.view'), join(ROOT, 'Desktop.view.negatives-hold')),
        undo: () => renameSync(join(ROOT, 'Desktop.view.negatives-hold'), join(ROOT, 'Desktop.view')) },
    { gate: 'check-state', what: 'a decision number defined twice', files: [STATE], tag: '[unique]',
        cmd: CHECK_STATE, apply: () => edit(STATE, '### D-117 —', '### D-116 —') },
    { gate: 'check-state', what: 'an observation number defined twice', files: [STATE], tag: '[unique]',
        cmd: CHECK_STATE, apply: () => edit(STATE, '161. **The suite reports', '160. **The suite reports') },
    { gate: 'check-state', what: 'decisions out of order', files: [STATE], tag: '[monotonic]',
        // D-999 rather than a real neighbour: renumbering onto a number that later
        // gets defined for real would fire [unique] instead and the case would pass
        // for the wrong reason. Nothing will ever be D-999.
        cmd: CHECK_STATE, apply: () => edit(STATE, '### D-113 —', `### ${NEVER} —`) },
    {
        gate: 'check-state', what: 'a D- cited in STATE.md, defined nowhere', files: [STATE],
        tag: '[undefined]', cmd: CHECK_STATE,
        // D-999, for the same reason the monotonic case uses it: this cited `D-140`
        // until W-9a defined D-140 for real, at which point the mutation stopped
        // creating an undefined citation and the case reported itself MISSED. Second
        // time a case has rotted by naming a number that later became true
        // (observation 178, and now this).
        apply: () => edit(STATE, 'Easy to reverse under Rule 14: it is one tool',
            `Superseded in part by \`${NEVER}\`. Easy to reverse under Rule 14: it is one tool`),
    },
    { gate: 'check-state', what: 'a D- cited in TODO.md, defined nowhere — the D-109 failure exactly',
        files: [TODO], tag: '[undefined]', cmd: CHECK_STATE,
        apply: () => edit(TODO, 'See `D-109` in `STATE.md`.', `See \`${NEVER}\` in \`STATE.md\`.`) },
    { gate: 'check-state', what: 'a D- cited in a gates/ record, defined nowhere', files: [GATES1],
        tag: '[undefined]', cmd: CHECK_STATE,
        apply: () => edit(GATES1, '# Gate results — W-1', `# Gate results — W-1 (see \`${NEVER}\`)`) },
    {
        gate: 'check-state', what: 'a next-number marker that has been overtaken', files: [STATE],
        tag: '[next]', cmd: CHECK_STATE,
        // COMPUTED, not written down. A literal `DEV-022` went stale the moment
        // DEV-022 was recorded and the case reported itself as MISSED - correctly,
        // but for a reason that had nothing to do with check-state. Rolling the
        // marker back by one always names a number that is already defined.
        apply: () => {
            const src = readFileSync(join(ROOT, STATE), 'utf8');
            const m = /Next number: `DEV-(\d+)`\./.exec(src);
            if (m === null) { throw new Error('no DEV next-number marker in STATE.md'); }
            const back = String(Number(m[1]) - 1).padStart(3, '0');
            edit(STATE, `Next number: \`DEV-${m[1]}\`.`, `Next number: \`DEV-${back}\`.`);
        },
    },
    { gate: 'check-state', what: 'the inherited-range declaration removed', files: [STATE], tag: '[undefined]',
        cmd: CHECK_STATE, apply: () => edit(STATE, '<!-- inherited: D-001..D-108', '<!-- removed: D-001..D-108') },

    /* --------------------------------------------------------- check-readme */
    { gate: 'check-readme', what: 'a blank line inside the attribute table', files: [README],
        tag: '[blank-line-in-table]', cmd: CHECK_README,
        apply: () => edit(README, '| `BinQualityAliases` |', '\n| `BinQualityAliases` |') },
    { gate: 'check-readme', what: 'an attribute row that no longer names its attribute', files: [README],
        tag: '[no-readme-row]', cmd: CHECK_README,
        apply: () => edit(README, '| `BinSeverityPriority` |', '| `xBinSeverityPriority` |') },
    { gate: 'check-readme', what: 'a row naming an attribute that does not exist', files: [README],
        tag: '[stale-readme-row]', cmd: CHECK_README,
        apply: () => edit(README, '| `SelectionMode` | `data-tchmi-selection-mode` | string | `single` |',
            '| `NotAnAttribute` | `data-tchmi-not-an-attribute` | string | `x` | invented |\n'
            + '| `SelectionMode` | `data-tchmi-selection-mode` | string | `single` |') },
    { gate: 'check-readme', what: 'a propertyName renamed in the descriptor — the case check-descriptors misses',
        files: [DESC], tag: '[no-readme-row]', cmd: CHECK_README,
        apply: () => edit(DESC, '"propertyName": "SelectionMode"', '"propertyName": "SelectionModeX"') },

    /* ----------------------------------------------------- check-hmiextproj */
    { gate: 'check-hmiextproj', what: 'a .ts in no tsconfig files array', files: [TSJ, TST], tag: 'TSMISS',
        cmd: CHECK_PROJ, apply: () => { edit(TSJ, ',\n    "Oklch.ts"', ''); edit(TST, ',\n    "Oklch.ts"', ''); } },
    { gate: 'check-hmiextproj', what: 'the template drifting from the generated file', files: [TST], tag: 'TSTPL',
        cmd: CHECK_PROJ, apply: () => edit(TST, '    "BinCodec.ts",\n', '') },
    { gate: 'check-hmiextproj', what: 'one .ts claimed by two projects, spelled with ..', files: [BASEJ],
        tag: 'TSDUP', cmd: CHECK_PROJ,
        apply: () => edit(BASEJ, '"SubstrateMapBase.ts"',
            '"SubstrateMapBase.ts",\n    "../../Helpers/SubstrateMapEngine/Oklch.ts"') },
    { gate: 'check-hmiextproj', what: 'a files entry naming a file that is not there', files: [TSJ, TST],
        tag: 'TSGONE', cmd: CHECK_PROJ,
        apply: () => { edit(TSJ, '"Oklch.ts"', '"Oklch.ts",\n    "Ghost.ts"'); edit(TST, '"Oklch.ts"', '"Oklch.ts",\n    "Ghost.ts"'); } },
    { gate: 'check-hmiextproj', what: 'a shippable file missing from the Visual Studio project', files: [PROJ],
        tag: 'MISS', cmd: CHECK_PROJ,
        apply: () => edit(PROJ, 'Include="Helpers\\SubstrateMapEngine\\Oklch.ts"',
            'Include="Helpers\\SubstrateMapEngine\\OklchZZZ.ts"') },
    { gate: 'check-hmiextproj', what: 'a project entry differing only in case', files: [PROJ], tag: 'CASE',
        cmd: CHECK_PROJ, apply: () => edit(PROJ, 'Include="Helpers\\SubstrateMapEngine\\Oklch.ts"',
            'Include="Helpers\\SubstrateMapEngine\\oklch.ts"') },

    /* --------------------------- 5. the framework path (F-1, D-215) --------- */
    // These four are why section 5 exists. The delivery shipped with every
    // tsconfig naming 14.5.1 and the payload carrying 14.4.5, and the symptom was
    // `TS2304: Cannot find name 'JQuery'` in every control - a message that names
    // the wrong thing entirely. FWMISS names the true one.
    //
    // The first two cannot be produced by editing a tracked file: the defect is a
    // directory name under `Packages/`, which is gitignored and supplied per
    // session. They use `needs`/`undo` rather than `files`, and skip themselves
    // when the payload is absent instead of scoring a false catch.
    { gate: 'check-hmiextproj', what: 'the payload carries a version no tsconfig names',
        tag: 'FWMISS', cmd: CHECK_PROJ, files: [],
        needs: () => existsSync(join(ROOT, 'Packages/Beckhoff.TwinCAT.HMI.Framework.14.5.1')),
        apply: () => renameSync(join(ROOT, 'Packages/Beckhoff.TwinCAT.HMI.Framework.14.5.1'), join(ROOT, 'Packages/Beckhoff.TwinCAT.HMI.Framework.14.4.5')),
        undo: () => renameSync(join(ROOT, 'Packages/Beckhoff.TwinCAT.HMI.Framework.14.4.5'), join(ROOT, 'Packages/Beckhoff.TwinCAT.HMI.Framework.14.5.1')) },
    { gate: 'check-hmiextproj', what: 'no framework payload at all', tag: 'FWMISS', cmd: CHECK_PROJ,
        files: [],
        needs: () => existsSync(join(ROOT, 'Packages')),
        apply: () => renameSync(join(ROOT, 'Packages'), join(ROOT, 'Packages.negatives-hold')),
        undo: () => renameSync(join(ROOT, 'Packages.negatives-hold'), join(ROOT, 'Packages')) },
    { gate: 'check-hmiextproj', what: 'packages.config declares a version no tsconfig resolves',
        files: [PKGCFG], tag: 'FWDECL', cmd: CHECK_PROJ,
        apply: () => edit(PKGCFG, 'id="Beckhoff.TwinCAT.HMI.Framework" version="14.5.1"',
            'id="Beckhoff.TwinCAT.HMI.Framework" version="14.6.0"') },
    { gate: 'check-hmiextproj', what: 'one tsconfig left behind on an older framework',
        files: [BINCHARTJ], tag: 'FWSPLIT', cmd: CHECK_PROJ,
        apply: () => edit(BINCHARTJ, 'Framework.14.5.1', 'Framework.14.4.5') },

    /* --------------- the case link the restore makes (H-9, D-299) ---------- */
    // The same `Cannot find name 'JQuery'` from a second cause: the package's own
    // `Lib/jquery.d.ts` names `JQuery/`, it ships `jQuery/`, and on Linux those
    // differ. `npm run tsconfig` links the wanted name to the shipped directory.
    // Removing the link is exactly a fresh restore; both tools must name it. On a
    // case-insensitive filesystem there is no link to remove and the cases skip.
    { gate: 'doctor', what: 'the restored framework without its case link', files: [],
        tag: 'case mismatch', cmd: 'node tools/check-framework.mjs',
        needs: () => isLink(JQLINK), apply: () => unlinkSync(join(ROOT, JQLINK)),
        undo: () => symlinkSync('jQuery', join(ROOT, JQLINK), 'dir') },
    { gate: 'tsconfig --check', what: 'the restore skipped, so the case link is due', files: [],
        tag: 'needs a case link', cmd: 'node tools/tsconfig-from-templates.mjs --check',
        needs: () => isLink(JQLINK), apply: () => unlinkSync(join(ROOT, JQLINK)),
        undo: () => symlinkSync('jQuery', join(ROOT, JQLINK), 'dir') },

    /* ------------------------------------------- the two inherited checkers */
    { gate: 'check-descriptors', what: 'an event carries the 14.4.5-era params key', files: [DESC],
        tag: '[not-a-legal-descriptor]', cmd: CHECK_DESC,
        needs: hasFrameworkSchema,
        // The exact defect that broke the live view after the framework update:
        // 14.5.1's ControlDescription schema forbids `params` on an event and wants
        // `arguments`. Nothing here read that schema until W-8c.
        apply: () => edit(DESC, '"name": "onItemSelected",', '"name": "onItemSelected",\n      "params": null,') },
    { gate: 'check-descriptors', what: 'an attributeCategory loses its displayPriority', files: [DESC],
        tag: '[not-a-legal-descriptor]', cmd: CHECK_DESC,
        needs: hasFrameworkSchema,
        // RENAMED rather than deleted: deleting the last key of an object leaves a
        // trailing comma, the tool dies on JSON.parse, and the case scores as missed
        // for a reason that has nothing to do with the schema. Measured.
        apply: () => edit(DESC, '"displayPriority": 500', '"displayPriorityX": 500') },
    { gate: 'check-descriptors', what: 'a declared setter the implementation does not have', files: [DESC],
        tag: '[attribute-setter-missing]', cmd: CHECK_DESC,
        apply: () => edit(DESC, '"propertySetterName": "setSelectionMode"', '"propertySetterName": "setSelectionModeX"') },
    { gate: 'check-manifest', what: 'a schema file dropped from the manifest', files: [MANI], tag: 'MISS',
        cmd: CHECK_MANI, apply: () => edit(MANI, 'GroupSelection.Schema.json', 'GroupSelectionX.Schema.json') },

    /* --------------------------------------- the recorder and the tap (W-3) */
    { gate: 'section 21', what: 'the event recorder regressed to a no-op', files: [HARNESS], slow: true,
        tag: 'FAILURES', cmd: SUITE,
        apply: () => edit(HARNESS, '    eventSink.push({ name: String(name), data });', '') },
    { gate: 'section 21', what: 'tapAt stops driving the handler', files: [HARNESS], slow: true,
        tag: 'FAILURES', cmd: SUITE,
        apply: () => edit(HARNESS, '    control.__handlePointerUp({ clientX: x, clientY: y, pointerId: 1, button: 0 });', '') },
    { gate: 'section 21', what: 'drainEvents stops draining', files: [HARNESS], slow: true,
        tag: 'FAILURES', cmd: SUITE,
        apply: () => edit(HARNESS, '    const out = eventSink.slice();\n    eventSink = [];', '    const out = eventSink.slice();') },

    /* ------------------------------------------ the generated dark SVG, W-16 */
    { gate: 'tools-smoke', what: 'the mirror drops the floor, collapsing light greys to black',
        files: [RECOLOR], slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(RECOLOR, 'export const FLOOR = 0.08;', 'export const FLOOR = 0.0;') },
    { gate: 'tools-smoke', what: 'the mirror rotates hue, which is what a CSS filter would do',
        files: [RECOLOR], slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(RECOLOR, 'C: c.C, h: c.h });', 'C: c.C, h: (c.h + 30) % 360 });') },
    { gate: 'tools-smoke', what: 'the two variants stop sharing a viewBox', files: [DARKSVG],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        // Replaces `W-16`'s regenerate-and-compare, which died with the generated
        // file. This guards what still has to hold across the pair: a different
        // aspect ratio would letterbox differently and the illustration would jump
        // when the theme changed.
        apply: () => edit(DARKSVG, 'viewBox="0 0 252 213.3"', 'viewBox="0 0 252 300"') },
    { gate: 'tools-smoke', what: 'the dark variant loses its colour, so it is just the light one',
        files: [DARKSVG], slow: true, tag: 'FAILURES', cmd: SMOKE,
        // BOTH accents. The dark drawing has two - #83d3d7 forty-seven times and
        // #d1eff1 nine - and neutralising only the first left the second above the
        // chroma threshold, so the case reported itself MISSED.
        apply: () => {
            edit(DARKSVG, 'fill:#83d3d7', 'fill:#838383', true);
            edit(DARKSVG, 'fill:#d1eff1', 'fill:#efefef', true);
        } },

    /* ------------------------------------------ Box and Gauss, W-22 */
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'mass that falls off the edge is dropped instead of folded back',
        apply: () => edit(SPATIAL, '                    if (target < 0 || target >= inner) { kept += weights[k + r]; continue; }',
            '                    if (target < 0 || target >= inner) { continue; }') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'mass scattered onto an empty pixel is dropped instead of folded back',
        apply: () => edit(SPATIAL, '                    if (Number.isNaN(read[to])) { kept += weights[k + r]; continue; }',
            '                    if (Number.isNaN(read[to])) { continue; }') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'the blur writes into empty pixels, spreading the map into space',
        apply: () => edit(SPATIAL, '                write[i] = Number.isNaN(read[i]) ? Number.NaN : acc[i];',
            '                write[i] = acc[i];') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'the Gauss kernel is not renormalised after truncation',
        apply: () => edit(SPATIAL, '    for (let i = 0; i < weights.length; i++) { weights[i] /= total; }', '') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'gamma is applied to the stored value rather than on the way to a colour',
        apply: () => edit(SPATIAL, '            const curved = gamma === 1 ? v : Math.pow(Math.max(0, Math.min(1, v)), gamma);',
            '            const curved = v;') },

    /* ------------------------------------------ Min and Max, W-21 */
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'Max and Min are swapped, so closing erodes and opening dilates',
        apply: () => edit(SPATIAL, 'return slide(src, radius, (counts) => extreme(counts, rank, true));',
            'return slide(src, radius, (counts) => extreme(counts, rank, false));') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'the morphology orders by INDEX instead of by severity rank',
        apply: () => edit(SPATIAL, '        const rk = i < rank.length ? rank[i] : i;', '        const rk = i;') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'an absent index still competes, so erosion answers with a bin that is not there',
        apply: () => edit(SPATIAL, '        if (counts[i] === 0) { continue; }', '') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'Min is no longer the identity at radius 0',
        apply: () => edit(SPATIAL, '    const r = Math.max(0, Math.floor(radius));\n    if (r === 0 || w === 0 || h === 0) {',
            '    const r = Math.max(1, Math.floor(radius));\n    if (w === 0 || h === 0) {') },

    /* ------------------------------------------ the median, W-20 */
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'empty pixels vote, so the space around the wafer outvotes its edge',
        // Counted AS INDEX 0 rather than merely un-skipped. Removing the `continue`
        // alone is a no-op: `counts` has 255 slots and the marker is 255, so the
        // increment writes past the end of a typed array and does nothing. That is
        // recorded in SpatialFilter.ts; this mutation models the regression the
        // guard actually protects against.
        apply: () => {
            edit(SPATIAL, '                if (v === FILTER_INDEX_EMPTY) { continue; }\n                counts[v]++;',
                '                counts[v === FILTER_INDEX_EMPTY ? 0 : v]++;');
            edit(SPATIAL, '                    if (v !== FILTER_INDEX_EMPTY) { counts[v]++; inWindow++; }',
                '                    counts[v === FILTER_INDEX_EMPTY ? 0 : v]++; inWindow++;');
        } },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'an empty pixel is filled in, extending the map into space',
        apply: () => edit(SPATIAL, '            if (index[at] === FILTER_INDEX_EMPTY) {', '            if (false) {') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'ties go to the HIGHER index, turning a 50/50 neighbourhood into a failure',
        // Re-anchored at W-21: the winner loop moved out of `slide` into `majority`
        // when Min and Max joined and the three filters started sharing the window.
        apply: () => edit(SPATIAL, '        if (counts[i] > bestCount) { bestCount = counts[i]; best = i; }',
            '        if (counts[i] >= bestCount) { bestCount = counts[i]; best = i; }') },
    { gate: 'patterns', slow: true, tag: 'FAILURES', cmd: PATTERNS, files: [SPATIAL],
        what: 'the window wraps instead of clamping, and a wafer becomes a torus',
        // `add % w`, which is what wrapping IS. `if (true)` reads the next row of a
        // flat array rather than the opposite edge, so it bleeds instead of wrapping
        // and mostly reads out of bounds - it does not model the defect.
        apply: () => edit(SPATIAL, '                if (add < w) {\n                    const v = index[base + add];',
            '                if (true) {\n                    const v = index[base + (add % w)];') },

    /* --------------------------- share, W-36 */
    { gate: 'section 46', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the rounding remainder vanishes, so the percentages do not sum to 100',
        apply: () => edit(CHART, '    if (remainder !== 0) {', '    if (false) {') },
    { gate: 'section 46', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the remainder goes to the SMALLEST segment, where a tenth is a huge relative error',
        apply: () => edit(CHART, '            if (raw[i].c.count > raw[biggest].c.count) { biggest = i; }',
            '            if (raw[i].c.count < raw[biggest].c.count) { biggest = i; }') },
    { gate: 'section 46', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the pie starts at three o\'clock instead of twelve',
        apply: () => edit(CHART, '        let angle = -Math.PI / 2;', '        let angle = 0;') },
    { gate: 'section 46', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'a sliver is labelled in its own segment, where the label overlaps its neighbours',
        apply: () => edit(CHART, '        inSegment: rounded[i] >= CHART_SLIVER_PERCENT,', '        inSegment: true,') },
    { gate: 'section 46', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the share draws its own order, so switching style rearranges the picture',
        apply: () => edit(CHART, '        const shares = chartShares(categories);',
            '        const shares = chartShares([...categories].reverse());') },
    { gate: 'section 46', slow: true, tag: 'FAILURES', cmd: SUITE, files: [README],
        what: 'the README drops the honest warning about angles',
        apply: () => edit(README, 'People compare lengths well and angles badly', 'People read pie charts') },

    /* --------------------------- the filter contact sheet, W-41 */
    { gate: 'section 1c', slow: true, tag: 'FAILURES', cmd: 'node --test Helpers/SubstrateMapEngine/tests/tools-smoke.test.mjs',
        files: [FSHEET], what: 'the sheet stops printing its numeric claims, so the evidence dies with the review',
        apply: () => edit(FSHEET, "    console.log(`  claim ${c.name}: ${c.base} -> ${c.after} fail pixels`);", '') },
    { gate: 'section 1c', slow: true, tag: 'FAILURES', cmd: 'node --test Helpers/SubstrateMapEngine/tests/tools-smoke.test.mjs',
        files: [FSHEET], what: 'the sheet loses the walled-in column, so it only shows the feature working',
        apply: () => edit(FSHEET, "    { label: 'MAX r2', filter: 'Max', radius: 2 },", '') },
    { gate: 'section 1c', slow: true, tag: 'FAILURES', cmd: 'node --test Helpers/SubstrateMapEngine/tests/tools-smoke.test.mjs',
        files: [FSHEET], what: 'the reducer goes back to Auto, so the bins rows show a density ramp',
        apply: () => edit(FSHEET, "    m.setAggregationReducer(cfg.reducer ?? 'MaxSeverity');", '') },
    { gate: 'section 1c', slow: true, tag: 'FAILURES', cmd: 'node --test Helpers/SubstrateMapEngine/tests/tools-smoke.test.mjs',
        files: [FSHEET], what: 'fail is identified by frequency again, so the claims come out backwards',
        apply: () => edit(FSHEET, '                return r > g;', '                return r < g;') },

    /* --------------------------- README examples, W-45 */
    { gate: 'check-readme', what: 'a README example drifts from its schema, so copying it fails',
        files: [README], tag: '[example]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, '"center_position_x": -30,', '"x": -30,') },
    { gate: 'check-readme', what: 'a polygon example uses [x, y] pairs instead of {x, y} objects',
        files: [README], tag: '[example]', cmd: 'node tools/check-readme.mjs',
        // The INLINE example, which the checker could not see until W-45 taught it
        // to read `data-tchmi-x='...'` values as well as fenced blocks.
        apply: () => edit(README, '"points": [{"x":100,"y":0}', '"points": [[100,0]') },
    { gate: 'check-readme', what: 'an example stops being valid JSON at all',
        files: [README], tag: '[example]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, '      "type": "polygon",', '      "type": polygon,') },

    /* --------------------------- the template root, W-44 */
    { gate: 'check-templates', what: 'a subclass template loses its base root class, so the control cannot be placed',
        files: [WTPL], tag: '[template]', cmd: 'node tools/check-templates.mjs',
        apply: () => edit(WTPL, 'TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Template ', '') },
    { gate: 'previnit', slow: true, tag: 'FAILURES', files: [CTPL],
        cmd: 'node --test Helpers/SubstrateMapEngine/tests/previnit.test.mjs',
        what: 'the chart template loses its base root class, and __previnit throws',
        apply: () => edit(CTPL, 'TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapBase-Template ', '') },

    /* --------------------------- the event fires last, W-43 */
    { gate: 'section 55', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'the event is raised before the attributes again, so a handler reads the previous selection',
        apply: () => edit(SM, "        this.__setSelectedOutputs(payload);",
            "        TcHmi.EventProvider.raise(this.__id + '.onItemSelected', eventData);\n        this.__setSelectedOutputs(payload);") },
    { gate: 'section 55', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'the empty-selection exit stops raising, so a cleared selection tells nobody',
        apply: () => edit(SM, "            this.setSelectedItems(null);\n            TcHmi.EventProvider.raise(this.__id + '.onItemSelected', eventData);\n            return;",
            "            this.setSelectedItems(null);\n            return;") },
    { gate: 'section 55', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'SelectedItems is written after the raise, so only the list is stale',
        apply: () => edit(SM, "        this.setSelectedItems(entries);\n", "") },

    /* --------------------------- one version everywhere, W-42a */
    { gate: 'check-manifest', what: 'a control drifts from the package version',
        files: [WDESC], tag: '[version]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(WDESC, '"full": "5.0.0.0"', '"full": "0.0.1.0"') },
    { gate: 'check-manifest', what: 'the release notes go stale against the version being shipped',
        files: [NUSPEC], tag: '[version]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(NUSPEC, '      5.0.0.0 - Localization', '      4.9.0.0 - Localization') },
    { gate: 'section 54', slow: true, tag: 'FAILURES', cmd: SUITE, files: [NUSPEC],
        what: 'a breaking change in the nuspec loses its "what to do"',
        apply: () => edit(NUSPEC, '         WHAT TO DO: if such a panel is meant to be empty', '         If such a panel is meant to be empty') },
    /* -------------- the release notes are shipped text too (5.0.0.0) ------- */
    { gate: 'section 54', slow: true, tag: 'FAILURES', cmd: SUITE, files: [NUSPEC],
        what: 'the 5.0.0.0 package-id change loses its "what to do"',
        apply: () => edit(NUSPEC, '         WHAT TO DO: replace the package reference', '         Replace the package reference') },
    { gate: 'check-spelling', what: 'a British spelling in the release notes', files: [NUSPEC],
        tag: '[spelling] SubstrateMap.nuspec', cmd: 'node tools/check-spelling.mjs',
        apply: () => edit(NUSPEC, 'strings the controls draw follow the locale', 'strings the controls draw honour the locale') },
    { gate: 'check-readme', what: 'the release notes cite a design record the reader does not have',
        files: [NUSPEC], tag: '[internal-ref] SubstrateMap.nuspec', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(NUSPEC, 'See README.md for the features and the reasoning', 'See PHASE-GATE-LOD.md for the features and the reasoning') },

    /* ------------- the identity band is reserved, not grown, F-4a / D-227 --- */
    // The reporter came back after F-4: the fit box was fixed and the wafer still
    // shrank, because the identity label is a flex SIBLING of the canvas and its
    // height comes out of the canvas'. Two mutations: put the collapse back, and
    // take the reservation away. Either one resizes the substrate when data lands.
    { gate: 'section 57', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the band collapses again when there is no text, so data arriving shrinks the wafer',
        apply: () => edit(SMBASE, "        if (this.__identityPosition === 'none') {",
            "        if (this.__identityPosition === 'none' || this.__composeIdentity() === '') {") },
    { gate: 'section 57', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the reserved line height goes away, so an empty band is zero tall again',
        apply: () => edit(SMBASE, "        identity.style.height = '1.2em';",
            "        identity.style.height = '0';") },
    { gate: 'section 57', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the fixed height weakens to a minimum, so a wrapped id grows through it',
        apply: () => edit(SMBASE, "        identity.style.height = '1.2em';",
            "        identity.style.minHeight = '1.2em';") },
    { gate: 'section 57', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'nowrap goes back to living only in Style.css, where it is absent when it matters',
        apply: () => edit(SMBASE, "        identity.style.whiteSpace = 'nowrap';", '') },
    /* ------------- a new payload restamps the clock, F-4b / D-228 ----------- */
    // __receivedAt was set once at construction and never again, so the age line
    // showed the control's birth time forever. Both siblings already stamped.
    { gate: 'section 58', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'setItems stops restamping, so new data keeps the old clock',
        apply: () => edit(SM, '        this.__items = Array.isArray(v) ? v : null;\n        this.__stampReceived();',
            '        this.__items = Array.isArray(v) ? v : null;') },
    { gate: 'section 58', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'setGridData stops restamping',
        apply: () => edit(SM, '        this.__gridData = v;\n        this.__stampReceived();',
            '        this.__gridData = v;') },

    /* ------------- group tiles of near-equal size, F-5 / D-229 -------------- */
    // The task said ceil; ceil puts 96% of the range below the minimum. These are
    // the two ways to get that back, plus dumping the remainder on the last tile
    // instead of spreading it, which is what the fixed-tile code did.
    { gate: 'grid-render', slow: true, tag: 'FAILURES', cmd: GRID_SUITE, files: [ENGINE],
        what: "the count ceils again, so tiles fall below the minimum",
        apply: () => edit(ENGINE, '    const n = Math.max(1, Math.floor(total / minTile));',
            '    const n = Math.max(1, Math.ceil(total / minTile));') },
    { gate: 'grid-render', slow: true, tag: 'FAILURES', cmd: GRID_SUITE, files: [ENGINE],
        what: 'the remainder is dumped on the last tile instead of spread, so two tiles differ by more than one',
        apply: () => edit(ENGINE, '    return Array.from({ length: n }, (_, k) => base + (k < rem ? 1 : 0));',
            '    return Array.from({ length: n }, (_, k) => (k === n - 1 ? base + rem : base));') },

    /* ------------- a release that travelled is not a click, F-14 / D-242 ---- */
    { gate: 'section 59', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the drag guard goes away, so a release selects whatever it landed on',
        apply: () => edit(SMBASE, '        if (press !== null && press.id === ev.pointerId',
            '        if (false && press !== null && press.id === ev.pointerId') },
    { gate: 'section 59', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the slop shrinks to zero, so a two-pixel tap stops selecting',
        apply: () => edit(SMBASE, '    protected static readonly DRAG_SLOP_PX = 5;',
            '    protected static readonly DRAG_SLOP_PX = 0;') },
    /* ------------- the nuspec may only name paths that exist, G-1 / D-261 --- */
    // The state the package shipped in: <icon> named a file nobody had ever put
    // there, and nothing compared the manifest with the disk.
    { gate: 'check-manifest', what: 'the nuspec names an icon that is not on disk',
        files: [NUSPEC], tag: '[nuspec]', cmd: CHECK_MANI,
        apply: () => edit(NUSPEC, '<icon>images/logo.png</icon>',
            '<icon>images/nothing-here.png</icon>') },

    /* ------------- the guide's commands are real, G-9 / D-279 --------------- */
    // A contributor guide is followed literally — the reader pastes the command.
    { gate: 'check-readme', what: 'CONTRIBUTING names a command that does not exist',
        files: [CONTRIB], tag: '[identity]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(CONTRIB, '`npm run gate`', '`npm run gateway`') },

    /* ------------- the package name follows the id, G-13a / D-283 ---------- */
    // A rename that misses PACKAGE_NAME returns the no-data image to its 404.
    { gate: 'check-manifest', what: 'the package is renamed and PACKAGE_NAME is not',
        files: [NUSPEC], tag: '[package-name]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(NUSPEC, '<id>Ekvip.Cinnamon.Semi.SubstrateMap</id>',
            '<id>Ekvip.Cinnamon.Semi.Renamed</id>') },

    /* ------------- a linked document must ship too, G-13 / D-282 ------------ */
    { gate: 'check-readme', what: 'the README links a document the package does not ship',
        files: [NUSPEC], tag: '[identity]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(NUSPEC, '<file src="CHANGELOG.md"', '<file src="CHANGELOG.old"') },

    /* ------------- every README image exists and ships, G-8 / D-278 --------- */
    { gate: 'check-readme', what: 'the README shows an image that is not there',
        files: [README], tag: '[identity]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, 'images/dashboard.png', 'images/gone.png') },

    /* ------------- the shipped surface is US English, H-1 / D-290 ---------- */
    { gate: 'check-spelling', what: 'a British spelling returns to the shipped surface',
        files: [README], tag: '[spelling]', cmd: 'node tools/check-spelling.mjs',
        apply: () => edit(README, 'dies colored by status', 'dies coloured by status') },
    // The exemption is enforced BOTH ways: en-UK must stay British.
    { gate: 'check-spelling', what: 'en-UK.localization is Americanised',
        files: [UKLOC], tag: '[spelling]', cmd: 'node tools/check-spelling.mjs',
        apply: () => edit(UKLOC, 'coloured', 'colored') },
    // The provenance tags were German in a US-English document; they must stay translated.
    { gate: 'check-spelling', what: 'a German provenance tag returns to the README',
        files: [README], tag: '[spelling]', cmd: 'node tools/check-spelling.mjs',
        apply: () => edit(README, 'was made** **[Inference]**', 'was made** **[Inferenz]**') },
    // A word boundary does not fall inside a prefixed form - the gap H-2 found.
    { gate: 'check-spelling', what: 'a prefixed British form returns (`unrecognised`)',
        files: [README], tag: '[spelling]', cmd: 'node tools/check-spelling.mjs',
        apply: () => edit(README, 'unrecognized', 'unrecognised') },

    /* ------------- the global bridges are counted and proven, H-8 / D-298 ---- */
    // An eighth bridge arrives: the table no longer matches the sources, and the
    // module the table still calls standalone does not load as the sources now say.
    { gate: 'check-readme', what: 'an engine module gains a global bridge the document does not count',
        files: [OKLCH], tag: '[architecture]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(OKLCH, '\nexport function ',
            '\ndeclare global { namespace TcHmi.Controls.CNM_UIControls.SEMI.Engine.Oklch { let x: number; } }'
            + '\nexport function ') },
    // The generated table edited by hand.
    { gate: 'check-readme', what: 'the bridge table is edited by hand',
        files: [ARCHDOC], tag: '[architecture]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(ARCHDOC, '| `Oklch` | — | — |', '| `Oklch` | yes | yes |') },

    /* ------------- one import statement per module, H-7 / D-297 ------------ */
    // The accretion that H-7 removed: a second statement for a module already imported.
    { gate: 'check-hmiextproj', what: 'a .ts source imports one module in two statements',
        files: [SPATIAL], tag: 'DUPIMPORT', cmd: CHECK_PROJ,
        apply: () => edit(SPATIAL, '\nimport ', "\nimport type { GridModel } from './Engine.js';\nimport ") },
    // The same rule over the .mjs tools and suites, through ESLint.
    { gate: 'lint', what: 'a tool imports one module in two statements',
        files: [MUTATE], tag: 'no-duplicate-imports', cmd: 'npx eslint .',
        apply: () => edit(MUTATE, "import { copyFileSync", "import { statSync as _s } from 'node:fs';\nimport { copyFileSync") },

    /* ------------- every row shows its HTML name, derived, H-6 / D-296 ------ */
    // The column copied by hand and mistyped: the rule, not the descriptor, catches it.
    { gate: 'check-readme', what: 'an attribute row shows the wrong HTML name',
        files: [README], tag: '[html-name]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, '| `ShowOriginMarker` | `data-tchmi-show-origin-marker` |',
            '| `ShowOriginMarker` | `data-tchmi-show-origin-mark` |') },
    // A descriptor that breaks the rule would make the README's rule sentence false.
    { gate: 'check-readme', what: 'a descriptor names an attribute against the stated rule',
        files: [DESC], tag: '[html-name]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(DESC, '"name": "data-tchmi-selection-mode"', '"name": "data-tchmi-selectionmode"') },

    /* ------------- every attribute is reachable from one section, H-5 / D-295 */
    // The scatter growing back: an attribute table placed outside the reference.
    { gate: 'check-readme', what: 'an attribute table appears outside the Attribute reference',
        files: [README], tag: '[attr-ref]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, '\n## Theming\n', '\n## Theming\n\n| Attribute | HTML attribute | Type | Default | Meaning |\n'
            + '| --- | --- | --- | --- | --- |\n| `MapRotation` | `data-tchmi-map-rotation` | number | `0` | Rotation. |\n') },
    // Per control, not per name: the bar's subsection stops naming one of its own.
    { gate: 'check-readme', what: 'a control\'s subsection stops naming an attribute it declares',
        files: [README], tag: '[attr-ref]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, '`HighlightFromSeverity` — with the same names, types and schemas, so',
            'the highlight threshold — with the same names, types and schemas, so') },

    /* ------------- every table of contents matches its headings, H-4 / D-294 */
    // A hand-edit inside the generated block: the anchor no longer names a heading.
    { gate: 'check-readme', what: 'a table-of-contents entry is edited by hand',
        files: [README], tag: '[toc]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, '- [Getting started](#getting-started)', '- [Getting started](#start)') },
    // The other direction: the heading moves and the contents do not follow.
    { gate: 'check-readme', what: 'a heading is renamed and the table of contents is not regenerated',
        files: [ARCHDOC], tag: '[toc]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(ARCHDOC, '\n## The controls', '\n## The four controls') },

    /* ------------- the repository front page leads somewhere, H-3 / D-293 ---- */
    // A document renamed or dropped: the first link a cloning reader follows is dead.
    { gate: 'check-readme', what: 'the repository-root README links a document that is gone',
        files: [ROOTREADME], tag: '[root-readme]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(ROOTREADME, '(src/hmi/SubstrateMap/API.md)', '(src/hmi/SubstrateMap/CALL-PATHS.md)') },
    // Resolves in the assembled tree and not in the repository: the side is checked too.
    { gate: 'check-readme', what: 'the repository-root README puts a harness file under the package',
        files: [ROOTREADME], tag: '[root-readme]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(ROOTREADME, '(src/hmi/Tests/Helpers/SubstrateMapEngine/tests/README.md)',
            '(src/hmi/SubstrateMap/Helpers/SubstrateMapEngine/tests/README.md)') },
    // An anchor is a link too: CONTRIBUTING renames the heading the front page points at.
    { gate: 'check-readme', what: 'the heading the repository-root README links to is renamed',
        files: [CONTRIB], tag: '[root-readme]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(CONTRIB, '## The tree you develop in is assembled', '## Assembling the tree') },

    /* ------------- no internal reference reaches a customer, H-2 / D-291 ---- */
    // A history id as the subject of a sentence: the shape the hand rewrite removed.
    { gate: 'check-readme', what: 'a task id returns to an engine comment',
        files: [SPATIAL], tag: '[internal-ref]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(SPATIAL, "over the aggregation pass's", "over the buffers `W-18` records, the aggregation pass's") },
    // The proof-of-concept controls are gone; naming one in a descriptor reaches the IDE.
    { gate: 'check-readme', what: 'a sibling control is named in a shipped descriptor',
        files: [CHARTDESC], tag: '[internal-ref]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(CHARTDESC, 'Splitting later is a migration', 'As in ComponentMap, splitting later is a migration') },
    // The unshipped brief, cited by name.
    { gate: 'check-readme', what: 'the CONTEXT brief is cited in the engine',
        files: [ENGINE_TS], tag: '[internal-ref]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(ENGINE_TS, 'passed unchanged to the rotation matrices and still render CCW on screen (see\n * the angle sign rule).', 'passed unchanged to the rotation matrices and still render CCW on screen (see\n * the CONTEXT angle sign rule).') },

    /* ------------- the README names the real package, G-8 / D-272 ----------- */
    // The state G-1 and G-2 left it in: a documented package id that does not exist.
    { gate: 'check-readme', what: 'the README names a package id that does not exist',
        files: [NUSPEC], tag: '[identity]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(NUSPEC, '<id>Ekvip.Cinnamon.Semi.SubstrateMap</id>',
            '<id>Ekvip.Cinnamon.Semi.Renamed</id>') },
    { gate: 'check-readme', what: 'an example uses a control type nothing declares',
        files: [README], tag: '[identity]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, 'SEMI.SubstrateMapBinChart"', 'SEMI.SubstrateMapPieChart"') },

    /* ------------- the sequence line numbers are true, G-7 / D-271 ---------- */
    // One line inserted at the top of Engine.ts shifts every definition below it.
    // A diagram that still points at the old lines is worse than no diagram: the
    // reader trusts it because it looks specific.
    { gate: 'check-readme', what: 'a sequence diagram points at lines that have moved',
        files: [ENGINE_TS], tag: '[sequences]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(ENGINE_TS, '/*', '// shifted\n/*') },

    /* ------------- the diagrams follow the code, G-6 / D-270 ---------------- */
    // A new import that the diagram does not show. This is the drift a hand-drawn
    // architecture picture accumulates silently.
    { gate: 'check-readme', what: 'a control gains an import the diagram does not show',
        files: [FBAR], tag: '[architecture]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(FBAR, 'import { filterApplies',
            "import type { GridModel } from '../../Helpers/SubstrateMapEngine/Engine.js';\nimport { filterApplies") },

    /* ------------- every code carries advice, G-5 / D-269 ------------------- */
    // A new code with no cause/fix. The register is the support surface, and half
    // of one is worse than none.
    { gate: 'check-readme', what: 'a diagnostic code ships with no cause or remedy',
        files: [ENGINE_TS], tag: '[register]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(ENGINE_TS, 'export function packColor',
            "const _probe = 'E142_BRAND_NEW_CODE: something happened';\nexport function packColor") },

    /* ------------- every drawn string is localised, G-4c / D-268 ------------ */
    // A literal put back where a getText call was. The first detector read only the
    // line containing `textContent =` and missed this entirely, because the
    // assignment spans four lines (observation 427).
    { gate: 'check-readme', what: 'a control draws a hard-coded string again',
        files: [FBAR], tag: '[l10n]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(FBAR, "? this.__localization.getText('bar.radius.off')", "? 'off'") },

    /* ------------- the widget family reads its E142 inputs, F-30 / D-260 ---- */
    // The exact defect: the E142 branch removed, so the attribute is stored and
    // ignored again. Compiles, unlike the first F-28 attempt (observation 414).
    { gate: 'section 62', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the tile stops reading the E142 inputs it declares',
        apply: () => edit(WIDGET, '            const doc = this.__readE142Doc();',
            '            const doc = null;') },

    /* ------------- the overlay sets its own space, F-28b / D-276 ------------ */
    // The state a browser leaves the context in. Invisible at ratio 1, which is why
    // two earlier fixes shipped without touching the real cause.
    { gate: 'section 63', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the tile overlay stops setting its own transform',
        apply: () => edit(WIDGET,
            '        ctx.setTransform(matrices.dprBase, 0, 0, matrices.dprBase, 0, 0);\n', '') },

    /* ------------- the stale border frames the map, F-28 / D-257 ------------ */
    // The exact regression, in a form that COMPILES. A first attempt used
    // `const rect = null`, which is a type error - so noEmitOnError kept the fixed
    // .js and the suite passed against code that was never built (observation 414).
    { gate: 'section 41', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the stale border frames the canvas again instead of the map',
        apply: () => edit(WIDGET,
            '            ctx.strokeRect(rect.x0 - g, rect.y0 - g,\n                (rect.x1 - rect.x0) + 2 * g, (rect.y1 - rect.y0) + 2 * g);',
            '            ctx.strokeRect(half, half, width - TILE_STALE_BORDER, height - TILE_STALE_BORDER);') },

    /* ------------- a tile does not select, F-27 / D-256 --------------------- */
    // Both halves. The tile forgetting to say 'none', and the base forgetting to
    // honour it - the second is the one that would silently return the ring to
    // every future control that declares itself inert.
    { gate: 'section 61', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the tile selects again, so a click marks cells nobody is told about',
        apply: () => edit(WIDGET, "protected override __selectionMode: 'single' | 'multi' | 'none' = 'none';",
            "protected override __selectionMode: 'single' | 'multi' | 'none' = 'single';") },
    { gate: 'section 61', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: "the base stops honouring 'none' and hit-tests anyway",
        apply: () => edit(SMBASE, "        if (this.__selectionMode === 'none') { return; }\n", '') },

    /* ------------- the header's two halves do not collide, F-26a / D-277 ---- */
    // The identity drawn at full length again. A band assertion cannot see this:
    // both halves are supposed to be in the band.
    { gate: 'section 64', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'a long substrate id runs through the chart timestamp',
        apply: () => edit(CHART, 'ctx.fillText(this.__fitText(ctx, id, room), CHART_PAD, CHART_PAD - 4);',
            'ctx.fillText(id, CHART_PAD, CHART_PAD - 4);') },

    /* ------------- the chart reserves its header band, F-26 / D-255 --------- */
    // The exact regression: Share measuring from CHART_PAD instead of plotTop, which
    // is what put the age text on top of the legend in a live view.
    { gate: 'section 60', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the Share style stops reserving the header band',
        apply: () => edit(CHART, '        const plotTop = CHART_PAD + CHART_HEADER;',
            '        const plotTop = CHART_PAD;') },

    /* ------------- the other two documents are covered too, F-24 / D-253 ---- */
    // Both new sources, and the nuspec one ESCAPED - the failure mode the README
    // does not have. Neither document has an example today, so without these two
    // the coverage would be a claim rather than a demonstration.
    { gate: 'check-readme', what: 'a wrong example in the release notes is not caught',
        files: [RELNOTES], tag: '[example]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(RELNOTES, '# ', '```json\n{ "notAnE142Thing": 1 }\n```\n\n# ') },
    { gate: 'check-readme', what: 'an ESCAPED wrong example in the nuspec is not caught',
        files: [NUSPEC], tag: '[example]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(NUSPEC, '</releaseNotes>',
            '&lt;div data-tchmi-items=&apos;[{"bogus":true}]&apos;&gt;&lt;/div&gt;</releaseNotes>') },

    /* ------------- the German stays in step, F-22 / D-252 ------------------- */
    // The way a translation rots: not by being deleted, but by the English gaining
    // a category nobody translates. The generator makes that a hard error.
    { gate: 'check-descriptors', what: 'a descriptor gains a category with no German',
        files: [DESC_MAP], tag: '[localization]', cmd: 'node tools/check-descriptors.mjs',
        apply: () => edit(DESC_MAP, '"attributeCategories": [',
            '"attributeCategories": [\n    { "name": "Neu", "description": "Untranslated", "displayPriority": 10 },') },

    /* ------------- lint sees the untyped tooling, F-21 / D-251 -------------- */
    // The class that cost three round trips this session: a name that does not
    // resolve, in a tool nothing type-checks. The tool still exits 0, because the
    // line is never reached - which is precisely why a linter and not a test run.
    { gate: 'lint', what: 'an undefined name in a tool is no longer caught',
        files: [CHECKSTATE], tag: 'no-undef', cmd: 'npx eslint .',
        apply: () => edit(CHECKSTATE, "const ROOT = ", "void NOT_A_REAL_NAME;\nconst ROOT = ") },

    /* ------------- strict stays on, F-20a / D-250 --------------------------- */
    // One word in one file turns it off, and nothing else would notice. And the
    // subtler undo: strict: true beside "noImplicitAny": false reads as strict and
    // is not, which is worse than not being strict at all.
    { gate: 'check-hmiextproj', what: 'strict is turned off in the shared base',
        files: [TSBASE], tag: 'TSBASE', cmd: CHECK_PROJ,
        apply: () => edit(TSBASE, '"strict": true', '"strict": false') },
    { gate: 'check-hmiextproj', what: 'a strict-family flag is switched off beside strict: true',
        files: [TSBASE], tag: 'TSBASE', cmd: CHECK_PROJ,
        apply: () => edit(TSBASE, '"strict": true,',
            '"strict": true,\n    "noImplicitAny": false,') },

    /* ------------- the tsconfigs share one base, F-19 / D-248 -------------- */
    // The two ways a consolidation comes undone: a project stops extending, or one
    // project overrides the base and the others silently diverge from THAT project.
    { gate: 'check-hmiextproj', what: 'a project stops extending the shared tsconfig base',
        files: [TSBASE_PROJ], tag: 'TSBASE', cmd: CHECK_PROJ,
        apply: () => edit(TSBASE_PROJ, '"extends": "../../tsconfig.base.json",', '') },
    { gate: 'check-hmiextproj', what: 'a project re-declares an option the base already sets',
        files: [TSBASE_PROJ], tag: 'TSBASE', cmd: CHECK_PROJ,
        apply: () => edit(TSBASE_PROJ, '"compileOnSave": true,',
            '"compileOnSave": true,\n  "compilerOptions": { "strictNullChecks": false },') },

    /* ------------- the coverage baseline cannot drift, F-17 / D-245 -------- */
    // Either side: the document restating a stale number, or the threshold being
    // quietly lowered. The second is the one that matters - a threshold nobody
    // notices dropping is not a threshold.
    { gate: 'check-readme', what: 'the test README restates the stale review coverage number',
        files: [TESTSDOC], tag: '[tests-readme]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(TESTSDOC, '| **threshold** | **93.03 %**', '| **threshold** | **89.98 %**') },
    { gate: 'check-readme', what: 'a coverage threshold is quietly lowered in package.json',
        files: [PKG], tag: '[tests-readme]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(PKG, '--test-coverage-branches=82.20', '--test-coverage-branches=70') },

    /* ------------- the test README is held to its own rule, F-16 / D-244 ---- */
    // Both halves: a suite with no row, and a fixture count that no longer matches
    // disk. The second is the task's own Done-when, worded as a mutation.
    { gate: 'check-readme', what: 'a suite is added and the test README does not list it',
        files: [TESTSDOC], tag: '[tests-readme]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(TESTSDOC, '| `tools-smoke.test.mjs` |', '| `tools-smoke-renamed.test.mjs` |') },
    { gate: 'check-readme', what: 'a fixture count in the test README stops matching disk',
        files: [TESTSDOC], tag: '[tests-readme]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(TESTSDOC, '77 .json', '20 .json') },

    /* ------------- the diagnostic register, F-15 / D-243 -------------------- */
    { gate: 'check-readme', what: 'a diagnostic is emitted and never registered',
        files: [SM], tag: '[register]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(SM, '`E142_FILTER_NOT_APPLICABLE: SpatialFilter',
            '`E142_FILTER_UNAVAILABLE: SpatialFilter') },

    /* ------------- every visible control has a toolbox category, F-13 ------- */
    { gate: 'check-manifest', what: 'a visible control loses its toolbox category',
        files: [MANI], tag: '[toolbox]', cmd: CHECK_MANI,
        apply: () => edit(MANI, '"basePath": "./Controls/SubstrateMap",\n      "descriptionFile": "Description.json",\n      "toolboxCategory": "210"',
            '"basePath": "./Controls/SubstrateMap",\n      "descriptionFile": "Description.json",\n      "toolboxCategory": ""') },
    { gate: 'check-manifest', what: 'a control names a toolbox category nothing declares',
        files: [MANI], tag: '[toolbox]', cmd: CHECK_MANI,
        apply: () => edit(MANI, '"toolboxCategory": "210"', '"toolboxCategory": "999"') },

    /* ------------- the radius says what it is set to, F-9b / D-239 ---------- */
    // Reviewed and asked for. Both halves: the readout must be PLACED, and zero
    // must read as a word - a "0" beside a slider is the state it was in before.
    { gate: 'filterbar-dom', slow: true, tag: 'FAILURES', files: [FBAR],
        cmd: 'node --test Helpers/SubstrateMapEngine/tests/filterbar-dom.test.mjs',
        what: 'the radius readout is built but never placed in the field',
        apply: () => edit(FBAR, "        field('Radius', radius, radiusValue);",
            "        field('Radius', radius);") },
    { gate: 'filterbar-dom', slow: true, tag: 'FAILURES', files: [FBAR],
        cmd: 'node --test Helpers/SubstrateMapEngine/tests/filterbar-dom.test.mjs',
        what: 'zero reads as a number again instead of as "off"',
        apply: () => edit(FBAR, "                ? 'off'", "                ? '0'") },

    /* ------------- the classic bridge carries the real API, F-11 / D-237 ---- */
    { gate: 'check-manifest', what: 'the classic bridge drops one of the real exports',
        files: [ENGINE], tag: '[bridge]', cmd: CHECK_MANI,
        apply: () => edit(ENGINE, "['getCellAtPos', getCellAtPos], ['getItemAtPos', getItemAtPos],",
            "['getCellAtPos', getCellAtPos],") },
    { gate: 'check-manifest', what: 'the EngineHello probe is re-introduced',
        files: [ENGINE], tag: '[bridge]', cmd: CHECK_MANI,
        apply: () => edit(ENGINE, 'const engineNamespace = ensureNamespace',
            'export class EngineHello {}\nconst engineNamespace = ensureNamespace') },
    /* ------------- doc blocks document members, F-10 / D-236 ---------------- */
    // Both directions: a NEW stranded block anywhere, and a baseline left too high
    // after one is fixed. The second is what stops the list becoming an allowance.
    { gate: 'check-hmiextproj', what: 'a doc block is stranded above another doc block',
        files: [WIDGET], tag: 'STRANDED', cmd: CHECK_PROJ,
        apply: () => edit(WIDGET, '     * Whether a last known state is being shown.',
            '     * Whether a last known state is being shown.\n     */\n    /**\n     * A second block, which strands the first.') },
    { gate: 'check-hmiextproj', what: 'a known stranded block is fixed and the baseline not lowered',
        files: [ENGINE], tag: 'STRANDED', cmd: CHECK_PROJ,
        apply: () => edit(ENGINE, ' * one cohesive thing and are always supplied together.\n */\n/**',
            ' * one cohesive thing and are always supplied together.\n */\nexport interface Placeholder { x: number }\n/**') },
    /* ------------- shipped docs name only shipped paths, F-8 / D-234 -------- */
    // The README told a NuGet consumer to run `node tools/bench-parse.mjs` four
    // times. The tool exists HERE, which is why "does the file exist" would have
    // passed - the question is whether the nuspec ships it.
    { gate: 'check-readme', what: 'the README instructs a tool that is not in the package',
        files: [README], tag: '[shipped]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, 'The figures below were taken 2026-08',
            'Regenerate with `node tools/bench-parse.mjs --write-readme`. Taken 2026-08') },
    { gate: 'check-readme', what: 'the README points at a document the package does not carry',
        files: [README], tag: '[shipped]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(README, 'held with the package\'s design records rather than in this file',
            'in `notes/DECISION-substrate-side.md`') },
    { gate: 'check-readme', what: 'the JSON envelope contract stops shipping',
        files: [NUSPEC], tag: '[shipped]', cmd: 'node tools/check-readme.mjs',
        apply: () => edit(NUSPEC, '    <file src="Schema\\E142\\JSON-FORMAT.md" target="runtimes\\native1.12-tchmi\\Schema\\E142\\" exclude=".hmipkgs\\**;.hmiframework\\**;bin\\**;Packages\\**" />\n', '') },
    /* ------------- packColor refuses what it cannot parse, F-7 / D-233 ------ */
    // Both branches were prefix tests. These put each one back.
    { gate: 'packColor', slow: true, tag: 'FAILURES', cmd: GRID_SUITE, files: [ENGINE],
        what: 'the hex branch goes back to a prefix test, so #12345g prefix-parses',
        apply: () => edit(ENGINE, '    if (RE_HEX6.test(s)) {',
            '    if (s.charCodeAt(0) === 35 && s.length === 7) {') },
    { gate: 'packColor', slow: true, tag: 'FAILURES', cmd: GRID_SUITE, files: [ENGINE],
        what: 'the numeric components stop being validated, so rgb(0x10,2,3) parses',
        apply: () => edit(ENGINE, '        if (!parts.every((t) => RE_NUM.test(t))) { return null; }', '') },
    { gate: 'packColor', slow: true, tag: 'FAILURES', cmd: GRID_SUITE, files: [ENGINE],
        what: 'the component count stops being exact, so rgb(1,2,3,4,5) parses',
        apply: () => edit(ENGINE, "        if (parts.length !== (m[1] === 'rgba' ? 4 : 3)) { return null; }",
            '        if (parts.length < 3) { return null; }') },
    /* ------------- painted area is hit area, F-6a / D-232 ------------------- */
    // The field rule: everything coloured with the item is hittable. Three ways to
    // break it - stop filling a closed shape, stop hitting its interior, or call a
    // closed shape open again, which is the exact predicate that caused the defect.
    { gate: 'section FRAME', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'a closed geometry with a stroke_width stops being filled',
        apply: () => edit(ENGINE, '                if (!g.open) {\n                    ctx.fillStyle = fill;',
            '                if (g.open) {\n                    ctx.fillStyle = fill;') },
    { gate: 'section FRAME', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the hit test stops looking inside a closed geometry',
        apply: () => edit(ENGINE, '                let hit = !g.open && ctx.isPointInPath(g.path, p.x, p.y);',
            '                let hit = false;') },
    { gate: 'section FRAME', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'a stroke_width makes a closed geometry open again, as it used to',
        apply: () => edit(ENGINE, "    if (geom.type === 'polyline') {\n        return true;\n    }",
            "    if (geom.type === 'polyline' || typeof geom.stroke_width === 'number') {\n        return true;\n    }") },
    /* ------------- the tiling is anchored to the map, F-5a / D-231 ---------- */
    // Zeroing the origin left the first version of these assertions entirely green,
    // because comparing tile WIDTHS across offsets cannot see the origin. This is
    // the case that would have caught it (observation 369).
    { gate: 'grid-render', slow: true, tag: 'FAILURES', cmd: GRID_SUITE, files: [ENGINE],
        what: 'the tiling anchors at device zero again instead of at the map',
        apply: () => edit(ENGINE, '    return { x0: Math.floor(rect.x0), y0: Math.floor(rect.y0), xs, ys };',
            '    return { x0: 0, y0: 0, xs, ys };') },
    { gate: 'grid-render', slow: true, tag: 'FAILURES', cmd: GRID_SUITE, files: [ENGINE],
        what: 'rows reuse the column division, so a wide short map tiles wrongly',
        apply: () => edit(ENGINE, '    const ys = groupTileSpans(rect.y1 - rect.y0, minTile);',
            '    const ys = xs;') },
    /* ------------- the substrate does not resize with content, F-4 / D-225 -- */
    // Section 56 is the field complaint. The mutation is the code that WAS there
    // before F-4 — items unioned into the fit box — so if the section can be
    // satisfied by anything short of the fix, this catches it.
    { gate: 'section 56', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'items are unioned back into the fit box, so every added item re-fits the wafer',
        apply: () => edit(ENGINE, '    void items;\n    const g = gridBBox(grid);\n    if (g) {',
            '    const g = unionBoxes([...items.map((it) => it.bbox), gridBBox(grid)]);\n    if (g) {') },
    { gate: 'section 56', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the documented fallback becomes content-derived again when nothing is bound',
        apply: () => edit(ENGINE, '    return DEFAULT_SUBSTRATE_BBOX;',
            '    return unionBoxes(items.map((it) => it.bbox)) ?? DEFAULT_SUBSTRATE_BBOX;') },
    { gate: 'section 56', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the fallback extent drifts off its documented 200 mm',
        apply: () => edit(ENGINE, 'export const DEFAULT_SUBSTRATE_EXTENT_MM = 200;',
            'export const DEFAULT_SUBSTRATE_EXTENT_MM = 150;') },

    /* --------------------------- the shape invariant, W-41a */
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the box origin is counted twice, so the wafer loses its shape and clusters double',
        apply: () => edit(ENGINE, '            x: 0, y: 0, width: w, height: h,',
            '            x: box.x0, y: box.y0, width: w, height: h,') },

    /* --------------------------- the filters are wired, W-40a */
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the dispatch does nothing, so a bound filter changes no pixel again',
        // In the DISPATCHER's body: guarding the engine's call site with `false`
        // breaks TypeScript's narrowing of `filter` and `box`, so the mutation
        // would fail to compile rather than change behaviour.
        apply: () => edit(FILTER, '    const r = Math.max(0, Math.floor(request.radius));',
            '    const r = 0;') },
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the buffers go back to needing a sink, so the dispatch cannot reach them',
        apply: () => edit(ENGINE, 'const wantBuffers = (sink != null || filter != null) && paletteFor.length <= 255;',
            'const wantBuffers = sink != null && paletteFor.length <= 255;') },
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'the layer stops carrying the request, so the engine never sees one',
        apply: () => edit(SMBASE2, '                spatialFilter: this.__spatialFilterRequest(),', '') },
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'the control assembles a request that ignores the effective filter',
        apply: () => edit(SM, '        const kind = this.__effectiveFilter();', "        const kind = 'None';") },
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FILTER],
        what: 'the chooser goes back to scanning all 255 slots, at 16x the cost',
        apply: () => edit(FILTER, '    for (let k = 0; k < n; k++) {\n        const i = active[k];\n        /*\n         * Ties go to the LOWER INDEX.',
            '    for (let i = 0; i < FILTER_HISTOGRAM_SLOTS; i++) {\n        void active; void n;\n        /*\n         * Ties go to the LOWER INDEX.') },
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FILTER],
        what: 'the tie-break is dropped, so a filtered cell reports the wrong bin',
        apply: () => edit(FILTER, '        if (counts[i] > bestCount || (counts[i] === bestCount && i < best)) {',
            '        if (counts[i] > bestCount) {') },
    { gate: 'section 53', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FILTER],
        what: 'every kernel name dispatches to the median, so three names are one filter',
        apply: () => edit(FILTER, "        case 'Max':\n            return repaintFromIndex(src, maxIndex(src, r), bitmap, stride);",
            "        case 'Max':\n            return repaintFromIndex(src, medianIndex(src, r), bitmap, stride);") },

    /* --------------------------- WIDGET-PATTERN.md, W-40 */
    { gate: 'section 52', slow: true, tag: 'FAILURES', cmd: SUITE, files: [PATTERN],
        what: 'the pattern document drifts from the attribute counts it argues from',
        apply: () => edit(PATTERN, '| `SubstrateMapWidget` — the tile | **9** |',
            '| `SubstrateMapWidget` — the tile | **14** |') },
    { gate: 'section 52', slow: true, tag: 'FAILURES', cmd: SUITE, files: [PATTERN],
        what: 'a registration site is dropped from the six',
        apply: () => edit(PATTERN, "5. the README gate's descriptor list\n", '') },
    { gate: 'section 52', slow: true, tag: 'FAILURES', cmd: SUITE, files: [PATTERN],
        what: 'the mistakes are removed, so the pattern reads as though it arrived correct',
        apply: () => edit(PATTERN, 'eight identical greys', 'the same colours') },
    { gate: 'section 52', slow: true, tag: 'FAILURES', cmd: SUITE, files: [PATTERN],
        what: 'the staleness formula is dropped, leaving the rule unimplementable',
        apply: () => edit(PATTERN, 'interval = clamp(threshold / 10, 1 s, 60 s)',
            'interval = something sensible') },
    { gate: 'section 52', slow: true, tag: 'FAILURES', cmd: SUITE, files: [PATTERN],
        what: 'the checklist is gutted, so there is nothing to work from',
        apply: () => edit(PATTERN, '- [ ] Fewer than ten attributes, and each one earns its place\n', '', true) },

    /* --------------------------- README and release notes, W-39 */
    { gate: 'section 51', slow: true, tag: 'FAILURES', cmd: SUITE, files: [README],
        what: 'the filter table disagrees with filterApplies, so the docs lie about a pairing',
        apply: () => edit(README, '| `Median`     | ✓ | — | — |', '| `Median`     | ✓ | ✓ | — |') },
    { gate: 'section 51', slow: true, tag: 'FAILURES', cmd: SUITE, files: [README],
        what: 'the empty-state table loses its precedence order',
        apply: () => edit(README, '| 2 | `stale` |', '| 9 | `zzz-stale` |') },
    { gate: 'section 51', slow: true, tag: 'FAILURES', cmd: SUITE, files: [README],
        what: 'the image-size recommendation loses its numbers',
        apply: () => edit(README, 'at least 512 px on the long edge for a full view, 256 px for a tile',
            'large enough for the biggest box') },
    { gate: 'section 51', slow: true, tag: 'FAILURES', cmd: SUITE, files: [NOTES],
        what: 'a breaking change loses its "what to do"',
        apply: () => edit(NOTES, '**What to do:** if you were relying on the demo appearing in a running view', 'If you were relying on the demo appearing in a running view') },
    { gate: 'section 51', slow: true, tag: 'FAILURES', cmd: SUITE, files: [NOTES],
        what: 'the notes drop the reassurance that qualified maps are unchanged',
        apply: () => edit(NOTES, '**A map whose codes all carry `BinQuality` renders byte-identically to before.**', '') },

    /* --------------------------- the staleness heartbeat, W-38b */
    { gate: 'section 50', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'no heartbeat, so an idle tile never crosses its own threshold',
        apply: () => edit(SMBASE2, '        this.__staleTimer = setInterval(() => { this.__requestRender(); }, ms);', '') },
    { gate: 'section 50', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'the interval is a constant, so a 15-minute takt polls every second',
        apply: () => edit(SMBASE2, '        return Math.min(60_000, Math.max(1_000, (staleAfterSeconds * 1000) / 10));',
            '        return 1_000;') },
    { gate: 'section 50', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'the heartbeat runs even with no threshold, waking every idle control',
        apply: () => edit(SMBASE2, '        if (staleAfterSeconds === null || !(staleAfterSeconds > 0)) { return null; }',
            '        if (staleAfterSeconds === null) { return 1_000; }') },
    { gate: 'section 50', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'teardown leaves the heartbeat running',
        apply: () => edit(SMBASE2, '        if (this.__staleTimer !== null) {\n            clearInterval(this.__staleTimer);\n            this.__staleTimer = null;\n        }\n        if (this.__resizeObserver) {',
            '        if (this.__resizeObserver) {') },
    { gate: 'section 50', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'the map stops showing how old its data is',
        apply: () => edit(SM, '        return id === \'\' ? age : `${id}  \\u00b7  ${age}`;', '        return id;') },

    /* --------------------------- the review changes, W-38a */
    { gate: 'section 49', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the in-wedge percentages come back, crowding a 200 px pie',
        // Re-anchored: the legend's alignment sits above a `const x = ...`, not
        // directly above the loop.
        apply: () => edit(CHART, "        ctx.textAlign = 'left';\n        const x = width - legendWidth + CHART_PAD;",
            "        ctx.textAlign = 'center';\n        const x = width - legendWidth + CHART_PAD;") },
    { gate: 'section 49', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'a wedge loses its outline, so two adjacent colours read as one segment',
        apply: () => edit(CHART, '            ctx.stroke();\n            angle += sweep;', '            angle += sweep;') },
    { gate: 'section 49', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the header stops naming the wafer',
        apply: () => edit(CHART, '            ctx.fillText(id, CHART_PAD, CHART_PAD - 4);', '') },
    { gate: 'section 49', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the header stops saying how old the data is',
        apply: () => edit(CHART, '        ctx.fillText(this.readAge().text, width - CHART_PAD, CHART_PAD - 4);', '') },
    { gate: 'section 49', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SHEET],
        what: 'the sheet goes back to one-sample wedges, and looks 8-bit again',
        apply: () => edit(SHEET, '        const SS = 4;', '        const SS = 1;') },

    /* --------------------------- the chart contact sheet, W-38 */
    { gate: 'section 48', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the chart drops the categorical fallback, so graded bins go grey',
        apply: () => edit(CHART, '        return binStatistics(grid, null, this.__readColors(), null, null,\n            this.__chartCategorical, null);',
            '        return binStatistics(grid, null, this.__readColors(), null, null, null, null);') },
    { gate: 'section 48', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the fallback is computed but never issued, so requested>0 is ignored',
        apply: () => edit(CHART, '            this.__chartCategorical = fallback.requested > 0 ? fallback.colors : null;',
            '            this.__chartCategorical = null;') },
    { gate: 'section 48', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SHEET],
        what: 'the sheet renders the map itself instead of driving the control',
        apply: () => edit(SHEET, '        const m = new Harness.SubstrateMap(null, null, {});', '        const m = Engine.buildGridPaint && new Harness.SubstrateMapBase(null, null, {});') },
    { gate: 'section 48', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SHEET],
        what: 'the sheet loses a row, so a combination is never shown',
        apply: () => edit(SHEET, "    { label: '300 CODES', codes: 300 },", '') },

    /* --------------------------- the chart's empty state, W-37 */
    { gate: 'section 47', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the chart reports nodata with bars on screen, so the base draws over them',
        apply: () => edit(CHART, '        return this.__chartGrid !== null;\n    }\n\n    /**\n     * The concrete\'s scene hook.',
            '        return false;\n    }\n\n    /**\n     * The concrete\'s scene hook.') },
    { gate: 'section 47', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'an all-null map falls back to the no-data image, hiding that one arrived',
        apply: () => edit(CHART, '            this.__drawNoBins(ctx, width, height, colors);\n            return;',
            '            return;') },
    { gate: 'section 47', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the all-null line drops the count, so it says nothing an operator can act on',
        apply: () => edit(CHART, '        return `${stats.totalCells} cells, none carries a bin`;',
            "        return 'none carries a bin';") },
    { gate: 'section 47', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'the base stops asking __hasContent, so a chart is nodata again',
        apply: () => edit(SMBASE2, '            hasGrid: this.__hasContent() && !this.__hasLastKnown(),',
            '            hasGrid: this.__sceneGrid !== null && !this.__hasLastKnown(),') },
    { gate: 'section 47', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHARTTHEMEDARK],
        what: 'a chart theme drops a variable, so a bar falls back instead of taking the theme',
        apply: () => edit(CHARTTHEMEDARK, '--substratemap-bin-fail: rgb(240, 120, 30);', '') },

    /* --------------------------- bars, W-35 */
    { gate: 'section 45', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the remainder is a subtraction, so an inconsistent input balances silently',
        apply: () => edit(CHART, '            count: remainder.reduce((n, b) => n + b.count, 0),',
            '            count: Math.max(0, present.reduce((n, b) => n + b.count, 0) - chosen.reduce((n, b) => n + b.count, 0) - 1),') },
    { gate: 'section 45', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'a zero-count category is drawn as a bar nobody can read',
        apply: () => edit(CHART, '    const present = stats.bins.filter((b) => b.count > 0);',
            '    const present = stats.bins.filter(() => true);') },
    { gate: 'section 45', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the sort loses its tie-break, so equal bars reorder between frames',
        apply: () => edit(CHART, '        b.count - a.count || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));',
            '        b.count - a.count);') },
    { gate: 'section 45', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the axis is truncated, so a small loss looks like a catastrophe',
        apply: () => edit(CHART, '            const h = (c.count / max) * plotHeight;',
            '            const min = categories.reduce((m, x) => Math.min(m, x.count), max);\n            const h = ((c.count - min * 0.9) / (max - min * 0.9)) * plotHeight;') },
    { gate: 'section 45', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'Other is sorted among the real codes instead of staying last',
        apply: () => edit(CHART, "    const ordered = sort === 'Code'", "    const ordered = false") },

    /* --------------------------- the bin chart scaffold, W-34 */
    { gate: 'section 44', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHART],
        what: 'the chart pushes a grid, so it draws a wafer under its own bars',
        apply: () => edit(CHART, '    protected __syncScene(): void {',
            '    protected __syncScene(): void {\n        this.__updateGrid(null);') },
    { gate: 'section 44', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHARTDESC],
        what: 'the descriptor stops citing the question it answers',
        apply: () => edit(CHARTDESC, 'answered as OD-003 option A', 'answered') },
    { gate: 'section 44', slow: true, tag: 'FAILURES', cmd: SUITE, files: [CHARTTHEME],
        what: 'a bar colour drifts from the cells it counts',
        apply: () => edit(CHARTTHEME, '--substratemap-bin-fail: rgb(213, 94, 0);',
            '--substratemap-bin-fail: rgb(220, 80, 20);') },
    { gate: 'section 44', slow: true, tag: 'FAILURES', cmd: SUITE, files: [PROTO],
        what: 'the gate list loses the chart, so it is never typechecked per task',
        apply: () => edit(PROTO, 'npx tsc -p Controls/SubstrateMapBinChart/tsconfig.json --noEmit\n', '') },
    { gate: 'check-manifest', what: 'the chart is missing from Manifest.json modules',
        files: [MANIFEST], tag: '[unregistered]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(MANIFEST, './Controls/SubstrateMapBinChart', './Controls/NotAControl') },

    /* --------------------------- the tile's themes, W-33 */
    { gate: 'section 43', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WTHEME],
        what: 'a shared colour drifts from the map, so a wafer changes colour between views',
        apply: () => edit(WTHEME, '--substratemap-bin-pass: rgb(0, 158, 115);',
            '--substratemap-bin-pass: rgb(0, 200, 100);') },
    { gate: 'section 43', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WTHEME],
        what: 'the light theme loses a variable the dark one still sets',
        apply: () => edit(WTHEME, '--substratemap-selection-color: rgb(0, 90, 200);', '') },
    { gate: 'section 43', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the stale border goes back to sharing the wafer outline colour',
        apply: () => edit(WIDGET, '        ctx.strokeStyle = this.__readStaleColor() ?? colors.edge;',
            '        ctx.strokeStyle = colors.edge;') },
    { gate: 'section 43', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'a colour literal creeps back into the tile',
        apply: () => edit(WIDGET, '        ctx.fillStyle = colors.labelColor;',
            "        ctx.fillStyle = '#333333';") },
    { gate: 'check-descriptors', what: 'a themeable control ships no dark theme',
        files: [WTHEMEDARK], tag: '[theme]', cmd: 'node tools/check-descriptors.mjs',
        apply: () => edit(WTHEMEDARK, '.TcHmi_Controls_CNM_UIControls_SEMI_SubstrateMapWidget {', 'IGNORED {'),
        // The file has to stop being a theme rather than stop existing: the tool
        // reads the directory, and `edit` restores a file it did not delete.
        skipIf: () => false },

    /* --------------------------- onSubstrateSelected, W-32 */
    { gate: 'section 42', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'a no-data tile raises anyway, with nulls for a substrate nobody selected',
        apply: () => edit(WIDGET, "        if (state !== 'data' && state !== 'stale') { return; }", '') },
    { gate: 'section 42', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the stale tile raises a null substrate id, the dead end the event removes',
        apply: () => edit(WIDGET, '            substrateId: this.__substrateId,\n            lotId: this.__lotId,',
            '            substrateId: this.__gridData?.substrateId ?? null,\n            lotId: this.__gridData?.lotId ?? null,') },
    { gate: 'section 42', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the payload gains a field the schema does not allow',
        apply: () => edit(WIDGET, '            goodDevices: this.__goodDevices,',
            '            goodDevices: this.__goodDevices,\n            cellRow: 0,') },
    { gate: 'section 42', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the click target is never removed, so a detached tile still raises',
        apply: () => edit(WIDGET, '            root.removeEventListener(\'click\', this.__tileClick);', '') },
    { gate: 'section 42', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 're-attaching installs a second handler, so one click raises twice',
        apply: () => edit(WIDGET, '        if (root !== null && this.__tileClick === null) {', '        if (root !== null) {') },

    /* --------------------------- last known state, W-31 */
    { gate: 'section 41', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'nothing is retained, so an unbind blanks the tile',
        apply: () => edit(WIDGET, '        } else if (this.__lastKnownGrid !== null) {', '        } else if (false) {') },
    { gate: 'section 41', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the retained age restarts at the unbind, so old data looks fresh',
        apply: () => edit(WIDGET, '            this.__receivedAt = this.__lastKnownAt ?? this.__receivedAt;',
            '            this.__receivedAt = new Date();') },
    { gate: 'section 41', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'a parse failure is logged but never published',
        apply: () => edit(WIDGET, '            this.setE142LastError(message);', '') },
    { gate: 'section 41', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the error is never cleared, so a recovered feed still reads as broken',
        apply: () => edit(WIDGET, '            this.setE142LastError(null);', '') },
    { gate: 'section 41', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'a live tile reports stale, because it is retaining its own current map',
        apply: () => edit(WIDGET, '            this.__showingLastKnown = false;\n            this.__updateGrid(grid);',
            '            this.__showingLastKnown = true;\n            this.__updateGrid(grid);') },
    { gate: 'section 41', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'a retained grid counts as current, so a stale tile reports data',
        apply: () => edit(SMBASE2, '            hasGrid: this.__sceneGrid !== null && !this.__hasLastKnown(),',
            '            hasGrid: this.__sceneGrid !== null,') },

    /* --------------------------- age and staleness, W-30 */
    { gate: 'section 40', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the age label does not say which clock it came from',
        apply: () => edit(WIDGET, "        text: `${source === 'map' ? 'measured' : 'received'} ${clock}`,",
            '        text: clock,') },
    { gate: 'section 40', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'a bound timestamp is ignored, so every tile reads as freshly received',
        // Only the `at`, not the source line too: dropping both leaves `mapTime`
        // unread and tsc refuses an unused parameter under this project's settings.
        apply: () => edit(WIDGET, '    const at = mapTime ?? received;', '    const at = received;') },
    { gate: 'section 40', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the stale marking tints the map instead of drawing a border',
        apply: () => edit(WIDGET, '        ctx.strokeRect(half, half, width - TILE_STALE_BORDER, height - TILE_STALE_BORDER);',
            "        ctx.fillStyle = 'rgba(255,200,0,0.25)';\n        ctx.fillRect(0, 0, width, height);") },
    { gate: 'section 40', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the receive clock is stamped on every render, so old data looks new',
        apply: () => edit(WIDGET, '    public readAge(): AgeText {\n        return formatAge(parseMapTimestamp(this.__mapTimestamp), this.__receivedAt, new Date());',
            '    public readAge(): AgeText {\n        this.__receivedAt = new Date();\n        return formatAge(parseMapTimestamp(this.__mapTimestamp), this.__receivedAt, new Date());') },
    { gate: 'section 40', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the border is solid, so it reads as a frame rather than a warning',
        apply: () => edit(WIDGET, '        ctx.setLineDash([...TILE_STALE_DASH]);', '        ctx.setLineDash([]);') },

    /* --------------------------- identity and yield, W-29 */
    { gate: 'section 39', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the id is clipped at the tail, losing the serial',
        apply: () => edit(WIDGET, "    return id.slice(0, head) + '…' + (tail > 0 ? id.slice(id.length - tail) : '');",
            "    return id.slice(0, maxChars - 1) + '…';") },
    { gate: 'section 39', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'an absent GoodDevices renders as zero',
        apply: () => edit(WIDGET, '    if (goodDevices === null || !Number.isFinite(goodDevices)) {\n        return { text: null, fraction: null };\n    }',
            '    if (goodDevices === null || !Number.isFinite(goodDevices)) {\n        return formatYield(0, nonNullCells);\n    }') },
    { gate: 'section 39', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the denominator counts every cell, including the null ones',
        apply: () => edit(WIDGET, '            : grid.cells.reduce((n, v) => n + (v === 0 ? 0 : 1), 0);',
            '            : grid.cells.length;') },
    { gate: 'section 39', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'GoodDevices is recounted from the bins instead of read from the header',
        apply: () => edit(WIDGET, '            this.__goodDevices = n.identity.goodDevices ?? null;',
            '            this.__goodDevices = n.payload.cells.reduce((a, v) => a + (v === 1 ? 1 : 0), 0);') },
    { gate: 'section 39', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'the base stops calling the concrete overlay hook',
        apply: () => edit(SMBASE2, '        this.__drawOverlay(ctx, cfg.width, cfg.height, colors);', '') },

    /* --------------------------- aggregate render at tile scale, W-28 */
    { gate: 'section 38', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the tile invents a unit placement, drawing the wafer flipped',
        apply: () => edit(WIDGET, '            const placed = computeGridPlacement(n.header, n.resolvedLayout, 0, undefined, false);',
            '            const placed = { placement: { originXmm: 0, originYmm: 0, colStepXmm: 1, colStepYmm: 0, rowStepXmm: 0, rowStepYmm: 1, cellWmm: 1, cellLmm: 1, sideMirror: false } };') },
    { gate: 'section 38', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the tile forces its own reducer instead of letting the measurement choose',
        apply: () => edit(WIDGET, '        const grid = this.__buildGrid();',
            "        const grid = this.__buildGrid();\n        this.__reducerOverride = 'MaxSeverity';") },
    { gate: 'section 38', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'an unreadable map throws instead of falling back to the no-data state',
        apply: () => edit(WIDGET, '        } catch (e) {', '        } catch (e) {\n            throw e;') },
    { gate: 'section 38', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the scene is never pushed, so a bound map draws nothing',
        apply: () => edit(WIDGET, '        this.__updateGrid(grid);', '        this.__updateGrid(null);') },

    /* --------------------------- the tile's attribute surface, W-27 */
    { gate: 'section 37', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WDESC],
        what: 'a shared input drifts from the map, so one symbol cannot feed both',
        apply: () => edit(WDESC, '"type": "tchmi:framework#/definitions/SubstrateMapGridData"',
            '"type": "tchmi:general#/definitions/Any"') },
    { gate: 'section 37', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WDESC],
        what: 'a default stops reproducing an empty tile',
        apply: () => edit(WDESC, '"propertyName": "ShowYield",\n      "propertySetterName": "setShowYield",\n      "propertyGetterName": "getShowYield",\n      "displayName": "Show Yield",\n      "visible": true,\n      "themeable": "None",\n      "displayPriority": 201,\n      "type": "tchmi:general#/definitions/Boolean",\n      "category": "Tile",\n      "readOnly": false,\n      "bindable": true,\n      "heritable": false,\n      "defaultValue": false',
            '"propertyName": "ShowYield",\n      "propertySetterName": "setShowYield",\n      "propertyGetterName": "getShowYield",\n      "displayName": "Show Yield",\n      "visible": true,\n      "themeable": "None",\n      "displayPriority": 201,\n      "type": "tchmi:general#/definitions/Boolean",\n      "category": "Tile",\n      "readOnly": false,\n      "bindable": true,\n      "heritable": false,\n      "defaultValue": true') },
    { gate: 'section 37', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the identity shows even with ShowSubstrateId off',
        apply: () => edit(WIDGET, "        if (!this.__showSubstrateId) { return ''; }", '') },
    { gate: 'section 37', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'a stale threshold of zero is stored instead of meaning never',
        apply: () => edit(WIDGET, '        const v = raw === null || !Number.isFinite(raw) || raw <= 0 ? null : raw;',
            '        const v = raw === null || !Number.isFinite(raw) ? null : raw;') },

    /* ------------------------------------------ the dashboard tile, W-26 */
    { gate: 'section 36', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE2],
        what: 'teardown leaves the ResizeObserver attached',
        apply: () => edit(SMBASE2, '        if (this.__resizeObserver) {\n            this.__resizeObserver.disconnect();',
            '        if (this.__resizeObserver) {\n            this.__resizeObserver.unobserve;') },
    { gate: 'section 36', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WIDGET],
        what: 'the tile overrides readEmptyState instead of inheriting it',
        // Not "stops extending the base": a cast that keeps the same prototype
        // chain leaves `instanceof` true and every inherited member in place, so
        // the mutation was a no-op. What the assertion is really about is that the
        // tile adds NOTHING of its own where the base already answers - so the
        // mutation adds something.
        apply: () => edit(WIDGET, '    protected __composeIdentity(): string {',
            "    public readEmptyState(): 'data' | 'stale' | 'demo' | 'nodata' { return 'data'; }\n\n    protected __composeIdentity(): string {") },
    { gate: 'section 36', slow: true, tag: 'FAILURES', cmd: SUITE, files: [WDESC],
        what: 'the tile no longer ships the base it extends',
        apply: () => edit(WDESC, '"name": "../SubstrateMapBase/SubstrateMapBase.js"', '"name": "../SubstrateMapBase/NotThere.js"') },
    { gate: 'check-manifest', what: 'the tile is missing from Manifest.json modules',
        files: [MANIFEST], tag: '[unregistered]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(MANIFEST, './Controls/SubstrateMapWidget', './Controls/NotAControl') },

    /* ------------------------------------------ the filter bar, W-25b */
    { gate: 'section 35', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FBAR],
        what: 'the bar offers a kernel the map would refuse',
        apply: () => edit(FBAR, '            const ok = filterApplies(f, s.view);', '            const ok = true;') },
    { gate: 'section 35', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FBAR],
        what: 'a greyed-out kernel gives no reason',
        // The GUARD, not the expression: an excess property is a type error and a
        // half-ternary is a syntax one. Making the reason unreachable by making
        // every choice legal would also disable the wrong assertion, so the reason
        // is emptied at its source instead.
        apply: () => edit(FBAR, "                        ? `Set Channel to FailDensity or ValueField to use ${f}. `\n                            + `${f} averages neighbouring cells, and bin codes cannot be averaged.`\n                        : `Set Channel to Bins to use ${f}. `\n                            + `${f} picks one of the neighbouring cells, which needs bin codes.`,",
            "                        ? '' : '',") },
    { gate: 'section 35', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FBAR],
        what: 'a channel change leaves the kernel stranded and illegal',
        apply: () => edit(FBAR, "        if (!filterApplies(next.filter, next.view)) { next.filter = 'None'; }", '') },
    { gate: 'section 35', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FBAR],
        what: 'a kernel arriving from a bound symbol is stored unchecked',
        apply: () => edit(FBAR, '        if (filterApplies(f, s.view)) { next.filter = f; }', '        next.filter = f;') },
    { gate: 'section 35', slow: true, tag: 'FAILURES', cmd: SUITE, files: [FBDESC],
        what: 'a bar attribute drifts from the map\'s type, so one symbol cannot bind both',
        apply: () => edit(FBDESC, '"type": "tchmi:framework#/definitions/SubstrateMapFieldView"',
            '"type": "tchmi:general#/definitions/String"') },

    /* --------------------------- a control is registered everywhere, W-25a */
    { gate: 'check-manifest', what: 'a control is missing from Manifest.json modules',
        files: [MANIFEST], tag: '[unregistered]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(MANIFEST, './Controls/SubstrateMapFilterBar', './Controls/NotAControl') },
    { gate: 'check-manifest', what: 'a control has no tsc line in the gate script',
        files: [PKG], tag: '[unregistered]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(PKG, ' && npx tsc -p Controls/SubstrateMapFilterBar/tsconfig.json --noEmit', '') },
    { gate: 'check-manifest', what: 'a control is absent from the Working Protocol gate block',
        files: [PROTO], tag: '[unregistered]', cmd: 'node tools/check-manifest.mjs',
        apply: () => edit(PROTO, 'npx tsc -p Controls/SubstrateMapFilterBar/tsconfig.json --noEmit\n', '') },
    { gate: 'check-descriptors', what: 'a discovered control loses a required descriptor field',
        files: [FBDESC], tag: 'finding', cmd: 'node tools/check-descriptors.mjs',
        // `displayName` is required by the framework's ControlDescription schema, not by
        // anything here, so this case needs the schema like the other two (D-217).
        needs: hasFrameworkSchema,
        apply: () => edit(FBDESC, '"displayName": "Substrate map filter bar",', '') },

    /* ------------------------------------------ the golden map, W-24 */
    { gate: 'section 34', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'a mismatched geometry is scaled instead of refused',
        // A comparison that is never true rather than a literal `false`: the branch
        // returns, so tsc narrows `refGrid` afterwards and a literal makes the
        // narrowing unreachable-code error. Third time (obs. 212).
        apply: () => edit(SM, '        if (refGrid.cols !== grid.cols || refGrid.rows !== grid.rows) {',
            '        if (refGrid.cols !== refGrid.cols) {') },
    { gate: 'section 34', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'bins are compared by table INDEX, so a reordered definition list differs everywhere',
        apply: () => edit(SM, '                ? grid.binTable[bin].code !== (refGrid.binTable[refBin]?.code ?? null)',
            '                ? bin !== refBin') },
    { gate: 'section 34', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'NewOnly shows any difference, so a repaired cell reads as newly broken',
        apply: () => edit(SM, '                : severity[bin] > (refBin === 0 ? 0 : refSeverity[refBin]);',
            '                : severity[bin] !== (refBin === 0 ? 0 : refSeverity[refBin]);') },
    { gate: 'section 34', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'a matching cell is hidden rather than muted',
        apply: () => edit(SM, '            cells[i] = keep ? bin : n + bin;', '            cells[i] = keep ? bin : 0;') },
    { gate: 'section 34', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'Off no longer switches the comparison off',
        apply: () => edit(SM, "        if (grid === null || ref === null || mode === 'Off') { return; }",
            '        if (grid === null || ref === null) { return; }') },

    /* ------------------------------------------ HighlightFromSeverity, W-23 */
    { gate: 'section 33', slow: true, tag: 'FAILURES', cmd: SUITE, files: [BINPAL],
        what: 'the muted colour keeps its chroma, so nothing is actually muted',
        apply: () => edit(BINPAL, '    const out = oklchToRgb({ L, C: 0, h: c.h });',
            '    const out = oklchToRgb({ L, C: c.C, h: c.h });') },
    { gate: 'section 33', slow: true, tag: 'FAILURES', cmd: SUITE, files: [BINPAL],
        what: 'the muted colour loses its lightness too, flattening the map to one grey',
        apply: () => edit(BINPAL, '    const out = oklchToRgb({ L, C: 0, h: c.h });',
            '    const out = oklchToRgb({ L: 0.5, C: 0, h: c.h });') },
    { gate: 'section 33', slow: true, tag: 'FAILURES', cmd: SUITE, files: [BINPAL],
        what: 'the separation clamp is dropped, so a pale bin vanishes into the substrate',
        apply: () => edit(BINPAL, '            if (Math.abs(L - bl) < minDeltaE) {', '            if (false) {') },
    { gate: 'section 33', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'a bin AT the threshold is muted, so the highlighted severity greys itself',
        apply: () => edit(SM, '            if (severity[i] >= from) { continue; }',
            '            if (severity[i] > from) { continue; }') },
    { gate: 'section 33', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'the chart is not given the muted palette, so it disagrees with the map',
        apply: () => edit(SM, '            this.__sceneCategorical, this.__sceneHighlight);',
            '            this.__sceneCategorical, null);') },

    /* ------------------------------------------ the filter surface, W-19 */
    { gate: 'section 32', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'Box is allowed over bin indices, so an average becomes a bin colour',
        apply: () => edit(SM, "    if (filter === 'Box' || filter === 'Gauss') { return view !== 'Bins'; }",
            "    if (filter === 'Box' || filter === 'Gauss') { return true; }") },
    { gate: 'section 32', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'an illegal pairing filters anyway, silently',
        apply: () => edit(SM, '        if (filterApplies(f, this.__fieldView)) { return f; }',
            '        return f;\n        if (filterApplies(f, this.__fieldView)) { return f; }') },
    { gate: 'section 32', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'the diagnostic stops naming the channel it could not run on',
        apply: () => edit(SM, '`E142_FILTER_NOT_APPLICABLE: SpatialFilter "${f}" cannot run on FieldView `\n                + `"${this.__fieldView}".',
            '`E142_FILTER_NOT_APPLICABLE: SpatialFilter "${f}" cannot run here.`\n                + `') },
    { gate: 'section 32', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'one of the seven drops out of the cache key',
        apply: () => edit(SM, '            this.__fieldGamma,', '') },
    { gate: 'section 32', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'a radius of zero no longer disables the filter',
        apply: () => edit(SM, "        if (f === 'None' || this.__spatialFilterRadius <= 0) { return 'None'; }",
            "        if (f === 'None') { return 'None'; }") },
    { gate: 'section 32', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the engine drops the filter term from the cache key',
        apply: () => edit(ENGINE, "            gridCacheKey(dev, bw, bh, layer.dataVersion, paint, reducer, layer.filterKey ?? ''),",
            '            gridCacheKey(dev, bw, bh, layer.dataVersion, paint, reducer, \'\'),') },

    /* --------------------------- FailDensity at any zoom, W-22a */
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the override is ignored, so a 4-pixel die never buckets',
        apply: () => edit(ENGINE, '    if (paint.aggregate && (pxPerCell < 1 || forceAggregate)) {',
            '    if (paint.aggregate && pxPerCell < 1) {') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'a forced tile scatters points, so 15 of every 16 pixels stay blank',
        apply: () => edit(ENGINE, '    const wantFootprint = footprintW > 1 || footprintH > 1;',
            '    const wantFootprint = false;') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the footprint is a pixel too small, so the area stops scaling',
        apply: () => edit(ENGINE, '            const x1 = Math.min(w - 1, Math.floor(qx + footprintW / 2 - 1e-9));',
            '            const x1 = Math.min(w - 1, Math.floor(qx + footprintW / 2 - 1.5));') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the footprint path is taken below one pixel per cell too, disturbing the hot path',
        apply: () => edit(ENGINE, '    const wantFootprint = footprintW > 1 || footprintH > 1;',
            '    const wantFootprint = true;') },

    /* ------------------------------------------ the filter buffers, W-18 */
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the index buffer records something other than the painted colour',
        apply: () => edit(ENGINE, '            fIndex[i] = index;', '            fIndex[i] = index === 0 ? 0 : index - 1;') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'an unpainted pixel is marked 0, which is a real palette index',
        apply: () => edit(ENGINE, 'export const FILTER_INDEX_EMPTY = 255;', 'export const FILTER_INDEX_EMPTY = 0;') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the buffers forget where they sit in the bitmap',
        apply: () => edit(ENGINE, '            x: box.x0,\n            y: box.y0,', '            x: 0,\n            y: 0,') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the buffers are allocated whether or not a filter wants them',
        apply: () => edit(ENGINE, '    const wantBuffers = sink != null && paletteFor.length <= 255;',
            '    const wantBuffers = paletteFor.length <= 255;') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the rank table stops clamping at the fail level',
        apply: () => edit(ENGINE, '            table[i] = i >= SEVERITY_FAIL ? SEVERITY_FAIL', '            table[i] = i >= 99 ? SEVERITY_FAIL') },

    /* ------------------------------------------ the demo marking, W-17 */
    { gate: 'section 31', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'demo content is drawn without the marking',
        // `__sceneShowLabels`, which the BASE has - the first draft used
        // `__showLabels`, which is the concrete's, and the W-15b compile guard
        // caught it as SETUP FAILED rather than letting the suite run against
        // stale .js. The guard doing its job on its second outing.
        apply: () => edit(SMBASE, '        if (this.__sceneIsDemo) {\n            this.__drawDemoMarking(',
            '        if (this.__sceneIsDemo && this.__sceneShowLabels && !this.__sceneShowLabels) {\n            this.__drawDemoMarking(') },
    { gate: 'section 31', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the marking is a corner badge instead of a hatch across the area',
        apply: () => edit(SMBASE, '        ctx.strokeText(DEMO_LABEL, width / 2, height / 2);\n        ctx.fillStyle = colors.edge;\n        ctx.fillText(DEMO_LABEL, width / 2, height / 2);',
            '        ctx.strokeText(DEMO_LABEL, 30, 12);\n        ctx.fillStyle = colors.edge;\n        ctx.fillText(DEMO_LABEL, 30, 12);') },
    { gate: 'section 31', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the word shrinks past legibility on a small control',
        apply: () => edit(SMBASE, '        const size = Math.max(DEMO_LABEL_MIN_PX, Math.min(width, height) * DEMO_LABEL_FRACTION);',
            '        const size = Math.min(width, height) * DEMO_LABEL_FRACTION;') },
    { gate: 'section 31', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the marking ink is hard-coded instead of taken from the theme',
        apply: () => edit(SMBASE, '        ctx.fillStyle = colors.edge;\n        ctx.fillText(DEMO_LABEL',
            "        ctx.fillStyle = '#808080';\n        ctx.fillText(DEMO_LABEL") },
    { gate: 'section 31', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'real data gets marked too, which would teach an operator to ignore the hatch',
        apply: () => edit(SMBASE, '        if (this.__sceneIsDemo) {\n            this.__drawDemoMarking(',
            '        if (true) {\n            this.__drawDemoMarking(') },

    /* ------------------------------------------ the empty state draw, W-15b */
    { gate: 'section 30', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the image is stretched to fill instead of contained',
        apply: () => edit(SMBASE, '    const scale = Math.min(areaW / imageW, areaH / imageH);\n    const w = imageW * scale;\n    const h = imageH * scale;',
            '    const w = areaW;\n    const h = areaH;') },
    { gate: 'section 30', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'contain becomes cover, so the image overflows',
        apply: () => edit(SMBASE, '    const scale = Math.min(areaW / imageW, areaH / imageH);',
            '    const scale = Math.max(areaW / imageW, areaH / imageH);') },
    { gate: 'section 30', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'an unloadable image draws nothing instead of falling back',
        // `=== ` rather than a literal `false`: the branch reassigns `slot`, and a
        // literal-false condition makes tsc narrow it back to the nullable declared
        // type and refuse the assignment. The flipped comparison is never true for
        // a failed CUSTOM image, which is the case this guards.
        apply: () => edit(SMBASE, '        if (slot.failed && slot.src !== NO_DATA_IMAGE_DEFAULT) {',
            '        if (slot.failed && slot.src === NO_DATA_IMAGE_DEFAULT) {') },
    { gate: 'section 30', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the fallback happens silently, with no warning',
        apply: () => edit(SMBASE, '                if (!this.__noDataWarned.has(wanted)) {',
            '                if (false && !this.__noDataWarned.has(wanted)) {') },
    { gate: 'section 30', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the dark theme is never chosen',
        apply: () => edit(SMBASE, '        const dark = bg !== null && rgbToOklch(bg).L < 0.5;',
            '        const dark = false;') },
    { gate: 'section 30', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the text band is not reserved, so the line sits over the image',
        apply: () => edit(SMBASE, '            : containRect(width, height - band, slot.image.naturalWidth, slot.image.naturalHeight);',
            '            : containRect(width, height, slot.image.naturalWidth, slot.image.naturalHeight);') },

    /* ------------------------------------------ the empty state, W-15a */
    { gate: 'section 29', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'a last known state stops outranking the demo',
        apply: () => edit(SMBASE, "    if (scene.hasLastKnown) { return 'stale'; }\n    if (scene.showDemoItems && scene.isDemo) { return 'demo'; }",
            "    if (scene.showDemoItems && scene.isDemo) { return 'demo'; }\n    if (scene.hasLastKnown) { return 'stale'; }") },
    { gate: 'section 29', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the demo counts as data, by its own items',
        apply: () => edit(SMBASE, "    if (!scene.isDemo && (scene.hasGrid || scene.itemCount > 0)) { return 'data'; }",
            "    if (scene.hasGrid || scene.itemCount > 0) { return 'data'; }") },
    { gate: 'section 29', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'an outline alone counts as data',
        apply: () => edit(SMBASE, "        hasGrid: this.__sceneGrid !== null,",
            "        hasGrid: this.__sceneGrid !== null || this.__sceneOutline !== null,") },
    { gate: 'section 29', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SM],
        what: 'the demo draws over a bound grid again — the W-14 defect',
        apply: () => edit(SM, "            if (this.__itemModels.length === 0 && !this.__hasRenderableGrid()\n                && this.__showDemoItems && this.__demo !== null) {",
            "            if (this.__itemModels.length === 0\n                && this.__showDemoItems && this.__demo !== null) {") },

    /* ------------------------------------------ buildDemo takes a box, W-13 */
    { gate: 'section 28', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the box is ignored, so the demo does not scale',
        apply: () => edit(SMBASE, '        ? Math.min(bbox.width / (DEMO_LAYOUT.substrateRadius * 2),\n            bbox.height / (DEMO_LAYOUT.substrateRadius * 2))\n        : 1;',
            '        ? 1\n        : 1;') },
    { gate: 'section 28', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the box CROPS instead of scaling, losing dies',
        apply: () => edit(SMBASE, '            if (!usable(cx - halfW, cy - halfH) || !usable(cx + halfW, cy - halfH)',
            '            if ((bbox && Math.abs(cx) > bbox.width / 2) || !usable(cx - halfW, cy - halfH) || !usable(cx + halfW, cy - halfH)') },
    { gate: 'section 28', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'a box still returns the 300 mm outline over the caller\'s substrate',
        apply: () => edit(SMBASE, "        outlineModel: bbox\n            ? null\n            : buildOutlineModel(",
            "        outlineModel: (false)\n            ? null\n            : buildOutlineModel(") },
    { gate: 'section 28', slow: true, tag: 'FAILURES', cmd: SUITE, files: [SMBASE],
        what: 'the demo notch exaggeration drifts from the attribute default',
        apply: () => edit(SMBASE, 'const DEMO_NOTCH_EXAGGERATION = 12;', 'const DEMO_NOTCH_EXAGGERATION = 8;') },

    /* --------------------------------- the measuring surface is named, W-12 */
    { gate: 'tools-smoke', what: 'a measuring-surface export loses its marker', files: [OKLCH],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(OKLCH, ' * **MEASURING SURFACE FOR TESTS. No render path calls this**', ' * No render path calls this') },
    { gate: 'tools-smoke', what: 'a measuring-surface export gains a runtime caller and the doc is stale',
        files: [GRIDAGG], slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(GRIDAGG, 'export function bucketIsPainted(',
            'export function __usesBucketIsPainted(b, x, y) { return bucketIsPainted(b, x, y); }\nexport function bucketIsPainted(') },
    { gate: 'tools-smoke', what: 'MODEL-API.md drops one of the six', files: [MODELAPI],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(MODELAPI, '| `maxSeverity` | `GridAggregate.ts` |', '| `maxSeverityX` | `GridAggregate.ts` |') },

    /* ------------------------------------------ the categorical fallback, W-11 */
    { gate: 'section 27', slow: true, tag: 'FAILURES', cmd: SUITE, files: [BINPAL],
        what: 'a qualified code takes a categorical colour too',
        apply: () => edit(BINPAL, "        if (resolved === 'pass' || resolved === 'fail') { continue; }", '') },
    { gate: 'section 27', slow: true, tag: 'FAILURES', cmd: SUITE, files: [BINPAL],
        what: 'a mapped code takes a categorical colour too',
        apply: () => edit(BINPAL, "        if (typeof mapped === 'string' && mapped.trim() !== '') { continue; }", '') },
    { gate: 'section 27', slow: true, tag: 'FAILURES', cmd: SUITE, files: [BINPAL],
        what: 'past the cap, the extra codes reuse a palette colour instead of other',
        apply: () => edit(BINPAL, 'colors[takers[k]] = k < palette.colors.length ? palette.colors[k] : CATEGORICAL_OTHER;',
            'colors[takers[k]] = palette.colors[k % Math.max(1, palette.colors.length)];') },
    { gate: 'section 27', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the fallback outranks an explicit StatusColorMapping entry',
        apply: () => edit(ENGINE, "    const mapped = mapping ? mapping[entry.code] : undefined;\n    if (typeof mapped === 'string' && mapped.trim() !== '') {\n        return mapped;\n    }\n    const resolved = resolveBinQuality(entry.quality, aliases ?? null);",
            "    if (typeof categorical === 'string' && categorical !== '') { return categorical; }\n    const mapped = mapping ? mapping[entry.code] : undefined;\n    if (typeof mapped === 'string' && mapped.trim() !== '') {\n        return mapped;\n    }\n    const resolved = resolveBinQuality(entry.quality, aliases ?? null);") },

    /* ------------------------------------------ readBinStatistics, W-10 */
    { gate: 'section 26', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the histogram is truncated like a group descriptor',
        apply: () => edit(ENGINE, '    for (let b = 1; b < counts.length; b++) {\n        if (counts[b] === 0) { continue; }',
            '    for (let b = 1; b < counts.length && bins.length < 10; b++) {\n        if (counts[b] === 0) { continue; }') },
    { gate: 'section 26', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'the null bin is counted as a code, breaking the invariant',
        apply: () => edit(ENGINE, '    for (let b = 1; b < counts.length; b++) {',
            '    for (let b = 0; b < counts.length; b++) {') },
    { gate: 'section 26', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ENGINE],
        what: 'color is read from StatusColorMapping instead of the render path',
        apply: () => edit(ENGINE, '            color: resolveBinColor(entry, mapping, colors, aliases ?? null),',
            "            color: (mapping ? mapping[entry.code] : undefined) ?? colors.unknown,") },
    { gate: 'section 26', slow: true, tag: 'FAILURES', cmd: SUITE, files: [BINSTAT],
        what: 'the schema stops requiring color',
        apply: () => edit(BINSTAT, '"code",\n              "count",\n              "quality",\n              "severity",\n              "color"',
            '"code",\n              "count",\n              "quality",\n              "severity"') },

    /* ------------------------------------------ the event readout, W-9 */
    { gate: 'tools-smoke', what: 'a wired panel is renamed out from under the log', files: [VIEW],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(VIEW, "{ control: 'SubstrateMap_GridData', event: 'onGroupSelected'",
            "{ control: 'SubstrateMap_GridDataX', event: 'onGroupSelected'") },
    { gate: 'tools-smoke', what: 'the log binds an event the control never raises', files: [VIEW],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(VIEW, "event: 'onItemSelected', label: 'ITEM '",
            "event: 'onItemPicked', label: 'ITEM '") },
    { gate: 'tools-smoke', what: 'a grid panel is wired to onItemSelected, which it cannot raise (W-9a)',
        files: [VIEW], slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(VIEW, "{ control: 'SubstrateMap_GridData', event: 'onGroupSelected', label: 'GROUP' }",
            "{ control: 'SubstrateMap_GridData', event: 'onItemSelected', label: 'GROUP' }") },
    { gate: 'tools-smoke', what: 'the script moves back outside the view root (W-9a)', files: [VIEW],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => {
            // Moves the view root's closing tag to BEFORE the script - which is exactly
            // where W-9 left it, and where a host that inserts the root element's markup
            // never sees the script at all.
            const p = join(ROOT, VIEW);
            const raw = readFileSync(p, 'utf8');
            const close = raw.lastIndexOf('</div>');
            const script = raw.indexOf('<script>');
            if (close < script) { throw new Error('the script is already outside the view root'); }
            const without = raw.slice(0, close) + raw.slice(close + '</div>'.length);
            writeFileSync(p, without.slice(0, script) + '</div>\r\n\r\n' + without.slice(script));
        } },
    { gate: 'tools-smoke', what: 'panel 6 goes back to claiming a warning that is gone', files: [VIEW],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        // W-9's version of this case asserted that panel 6 named the task that would
        // FIX it. W-14 was that task, so the anchor went with the repair - the case
        // reported itself MISSED. It now guards the state after the fix: the page
        // must not claim a warning the control no longer raises.
        apply: () => edit(VIEW, 'suppressed the demo and the control reported SUBSTRATEMAP_DEMO_SUPPRESSED_BY_OUTLINE,',
            'suppresses the demo and the control reports SUBSTRATEMAP_DEMO_SUPPRESSED_BY_OUTLINE,') },

    /* -------------------------------- line endings and the mutation runner, W-7 */
    { gate: 'check-hmiextproj', what: 'a file gains one line ending of the wrong kind', files: [BINSEV],
        tag: 'ENDING', cmd: CHECK_PROJ,
        apply: () => {
            // Byte-level, because `edit` matches in the file's OWN ending and could
            // not express "the wrong one" if it wanted to.
            const p = join(ROOT, BINSEV);
            const raw = readFileSync(p);
            const at = raw.indexOf('\r\n', 4000);
            if (at === -1) { throw new Error('no CRLF to flip in ' + BINSEV); }
            writeFileSync(p, Buffer.concat([raw.subarray(0, at), Buffer.from('\n'), raw.subarray(at + 2)]));
        } },
    /* ------------------- 7. shell scripts are LF (F-3, D-224) --------------- */
    // Section 5 catches MIXED endings and would not have caught this: typecheck.sh
    // was uniformly CRLF - internally consistent, and unrunnable, because the
    // kernel reads the shebang byte for byte. Two cases, because the two branches
    // of the message say different things and only one of them is fatal.
    { gate: 'check-hmiextproj', what: 'a shell script gains a CRLF shebang', files: [TYPECHECK],
        tag: 'SHCRLF', cmd: CHECK_PROJ,
        apply: () => {
            // Byte-level for the same reason as the case above: `edit` matches in
            // the file's own ending, so it cannot express the wrong one.
            const p = join(ROOT, TYPECHECK);
            const raw = readFileSync(p);
            const at = raw.indexOf('\n');
            if (at === -1) { throw new Error('no line to flip in ' + TYPECHECK); }
            writeFileSync(p, Buffer.concat([raw.subarray(0, at), Buffer.from('\r\n'), raw.subarray(at + 1)]));
        } },
    { gate: 'check-hmiextproj', what: 'a shell script gains one CR below the shebang',
        files: [TYPECHECK], tag: 'SHCRLF', cmd: CHECK_PROJ,
        apply: () => edit(TYPECHECK, 'FAIL=0\n', 'FAIL=0\r\n') },
    { gate: 'tools-smoke', what: '--reset falls through into a full run again', files: [MUTATE],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(MUTATE, "    console.log('\\n  progress forgotten\\n');\n    process.exit(0);",
            "    console.log('\\n  progress forgotten\\n');") },
    { gate: 'tools-smoke', what: '--filter goes back to substring matching', files: [MUTATE], slow: true,
        tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(MUTATE, "            : out.filter((m) => m.task === filter);",
            "            : out.filter((m) => m.task.includes(filter));") },
    { gate: 'tools-smoke', what: 'batches group by adjacency again, splitting a task', files: [MUTATE],
        slow: true, tag: 'FAILURES', cmd: SMOKE,
        apply: () => edit(MUTATE, "        if (!groups.has(m.task)) { groups.set(m.task, []); }",
            "        if (!groups.has(m.task) || groups.get(m.task).at(-1) !== list[list.indexOf(m) - 1]) { groups.set(m.task, []); }") },

    /* ------------------------------------------ the module graph, W-6 */
    { gate: 'tools-smoke', slow: true, tag: 'FAILURES', cmd: SMOKE, files: [BINSEV],
        what: 'the leaf stops being a leaf',
        apply: () => edit(BINSEV, '/**\n * One row of a {@link GridModel.binTable}',
            "import { packColor } from './Engine.js';\nvoid packColor;\n\n/**\n * One row of a {@link GridModel.binTable}") },

    /* ---------------------------------------- the compositing bucket pass, W-5 */
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the bucket pass goes back to replacing on a shared canvas',
        apply: () => edit(ENGINE, '        compositeOver(ctx, img, box.x0, box.y0);',
            '        ctx.putImageData(img, box.x0, box.y0);') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the bucket pass goes back behind allowImageData',
        apply: () => edit(ENGINE, '    if (paint.aggregate && pxPerCell < 1) {',
            '    if (paint.aggregate && pxPerCell < 1 && allowImageData) {') },
    { gate: 'grid-aggregate', slow: true, tag: 'FAILURES', cmd: AGGSUITE, files: [ENGINE],
        what: 'the composite drops a transparent source instead of keeping the body',
        apply: () => edit(ENGINE, '        if (sa === 0) { continue; }',
            '        if (sa === 0) { d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0; continue; }') },

    /* ------------------------------------------ the event schema, W-4 */
    { gate: 'section 25', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ITEMSEL],
        what: 'the event schema stops admitting a clear',
        apply: () => edit(ITEMSEL, '"itemId": {\n          "type": [\n            "integer",\n            "null"\n          ]',
            '"itemId": {\n          "type": [\n            "integer"\n          ]') },
    { gate: 'section 25', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ITEMSEL],
        what: 'the event schema regenerated from SelectionList — item_id, not itemId',
        apply: () => edit(ITEMSEL, '"itemId": {', '"item_id": {') },
    { gate: 'section 25', slow: true, tag: 'FAILURES', cmd: SUITE, files: [ITEMSEL],
        what: 'raw quietly added to the event reading',
        apply: () => edit(ITEMSEL, '"required": [\n              "name",\n              "value"\n            ],\n            "additionalProperties": false',
            '"required": [\n              "name",\n              "value"\n            ],\n            "additionalProperties": true') },

    /* ---------------------------------------- the browser oracle path (W-3b) */
    {
        gate: 'section 24', slow: true, tag: 'FAILURES', cmd: SUITE,
        // The fixture is TRACKED once a capture has been checked in, so it is
        // restored rather than deleted. Deleting it - which this case did while it
        // was untracked - removes the user's capture and leaves the tree dirty.
        files: ['Helpers/SubstrateMapEngine/tests/fixtures/hit-oracle.json'],
        what: 'a captured answer the shim disagrees with',
        apply: () => {
            /*
             * A three-case oracle written BY HAND from the geometry, not generated
             * by the shim - a shim-generated fixture would agree with itself and
             * prove nothing. `rect-14x10` is rect(-7, -5, 14, 10) under the identity
             * transform, so: the origin is inside the fill and 5 mm from the nearest
             * edge; (6.9, 0) is inside and 0.1 mm from the right edge, which a 1 mm
             * stroke covers and a 0 mm one does not; (10, 0) is outside and 3 mm
             * clear, which not even the 3 mm stroke reaches.
             *
             * The LAST of the three is then flipped. If the comparison in section 24
             * works, the suite goes red naming it; if it silently does not compare,
             * this mutation goes undetected and the whole oracle path is decoration.
             */
            const cases = [
                { shape: 'rect-14x10', transform: 'identity', user: [0, 0], canvas: [0, 0],
                    inPath: true, inStroke: { 0: false, 1: false, 3: false } },
                { shape: 'rect-14x10', transform: 'identity', user: [6.9, 0], canvas: [6.9, 0],
                    inPath: true, inStroke: { 0: false, 1: true, 3: true } },
                { shape: 'rect-14x10', transform: 'identity', user: [10, 0], canvas: [10, 0],
                    inPath: true, inStroke: { 0: false, 1: false, 3: false } },
            ];
            const plan = JSON.parse(
                execFileSync('node', ['tools/hit-oracle.mjs', '--print'], { cwd: ROOT, encoding: 'utf8' })
                    .slice(execFileSync('node', ['tools/hit-oracle.mjs', '--print'],
                        { cwd: ROOT, encoding: 'utf8' }).indexOf('{')));
            writeFileSync(
                join(ROOT, 'Helpers/SubstrateMapEngine/tests/fixtures/hit-oracle.json'),
                JSON.stringify({ capturedBy: 'hand-written negative case', capturedAt: '1970-01-01',
                    plan, cases }, null, 1));
        },
    },

    /* ------------------------------------- the hit shim and section 22 (W-3a) */
    { gate: 'section 22', what: 'isPointInPath regressed to answering false', files: [SHIMS], slow: true,
        tag: 'FAILURES', cmd: SUITE,
        apply: () => edit(SHIMS, '        for (const sp of path.subpaths) {\n            if (windingNumber(ux, uy, sp.points) !== 0) { return true; }\n        }\n        return false;',
            '        return false;') },
    { gate: 'section 22', what: 'isPointInStroke answering like a fill — the hollow FRAME', files: [SHIMS],
        slow: true, tag: 'FAILURES', cmd: SUITE,
        apply: () => edit(SHIMS, '        const half = this.lineWidth / 2;',
            '        const half = this.lineWidth / 2;\n        for (const sp of path.subpaths) { if (windingNumber(ux, uy, sp.points) !== 0) { return true; } }') },
    { gate: 'section 22', what: 'the CTM inverse dropped, so the pointer is tested untransformed',
        files: [SHIMS], slow: true, tag: 'FAILURES', cmd: SUITE,
        apply: () => edit(SHIMS, '        const inv = this.transform.inverse();',
            '        const inv = new DOMMatrix();') },
    { gate: 'section 22', what: 'an unparsed d string answers instead of refusing', files: [SHIMS],
        slow: true, tag: 'FAILURES', cmd: SUITE,
        apply: () => edit(SHIMS, '        if (path.unparsed !== null) {', '        if (false) {') },
];

/* --------------------------------------------------------------- run them */

const selected = CASES.filter((c) => (FAST ? !c.slow : true) && (SLOW ? c.slow === true : true)
    && (ONLY === null || c.gate.includes(ONLY) || c.what.includes(ONLY)));
const missed = [];

console.log('\n  gate assertions, proved to fire');
console.log('='.repeat(96));
const precondSkipped = [];
for (const c of selected) {
    // A case whose subject is not in this workspace is SKIPPED, never MISSED.
    // `Packages/` is gitignored and supplied per session, so a cold tree would
    // otherwise report the framework guard as broken (F-1).
    if (c.needs && !c.needs()) {
        precondSkipped.push(c);
        console.log(`  ${c.gate.padEnd(18)}${c.what.padEnd(62).slice(0, 62)}  rc= -  SKIPPED - precondition absent`);
        continue;
    }
    let rc = null;
    let out = '';
    let error = null;
    try {
        // Written BEFORE the mutation and removed after the restore, so a kill in
        // between leaves a note naming the case and the files to check out.
        writeFileSync(MARKER, `case: ${c.gate} — ${c.what}\nfiles: ${c.files.join(', ')}`);
        c.apply();
        // A mutation to a .ts file only reaches the suites through an emit, and a
        // suite run against stale .js would score the mutation as MISSED for a
        // reason that has nothing to do with the assertion.
        if (c.files.some((f) => f.endsWith('.ts'))) {
            /*
             * A FAILED EMIT IS A FAILED CASE, not a silent pass (W-15b).
             *
             * The emit result used to be discarded. When a mutation did not
             * compile, the suite then ran against the STALE `.js` - unmutated - and
             * every assertion passed, so the case reported itself MISSED with no
             * hint that nothing had been mutated at all. Measured: `W-15b`'s
             * fallback mutation narrowed a type and tsc refused it, and
             * `check-negatives` said the gate had missed a defect that was never
             * applied.
             *
             * `mutate.mjs` has reported COMPILE-FAIL since the LOD spec. This tool
             * did not, and the fix belongs here rather than in the one case that
             * exposed it.
             */
            let compiled = true;
            for (const proj of TS_PROJECTS) {
                const emit = run(`npx tsc -p ${proj}/tsconfig.json`);
                if (emit.rc !== 0) {
                    compiled = false;
                    error = `COMPILE — the mutation does not typecheck, so the suite would have run `
                        + `against stale .js:\n${emit.out.split('\n').slice(0, 3).join('\n')}`;
                    break;
                }
            }
            if (!compiled) { throw new Error(error); }
        }
        ({ rc, out } = run(c.cmd, c.env));
    } catch (err) {
        error = err.message;
    } finally {
        // Untracked or gitignored state first: `git checkout --` cannot see it.
        if (c.undo) { try { c.undo(); } catch { /* apply may not have run */ } }
        restore(c.files);
        if (c.files.some((f) => f.endsWith('.ts'))) {
            for (const proj of TS_PROJECTS) {
                run(`npx tsc -p ${proj}/tsconfig.json`);
            }
        }
        cleanup(c.cleanup);
        rmSync(MARKER, { force: true });
    }
    const caught = error === null && rc !== 0 && out.includes(c.tag);
    if (!caught) { missed.push({ ...c, rc, error, tail: out.slice(-500) }); }
    const verdict = error !== null ? `SETUP FAILED: ${error}` : caught ? 'caught' : '*** MISSED ***';
    console.log(`  ${c.gate.padEnd(18)}${c.what.padEnd(62).slice(0, 62)}  rc=${String(rc).padStart(2)}  ${verdict}`);
}
console.log('='.repeat(96));

const dirty = status();
if (dirty !== '') {
    console.log('\n  THE TREE IS DIRTY after the run - a mutation was not restored:');
    console.log(dirty.split('\n').map((l) => `    ${l}`).join('\n'));
}

if (missed.length === 0 && dirty === '') {
    const notSelected = CASES.length - selected.length;
    const ran = selected.length - precondSkipped.length;
    console.log(`\n  OK - ${ran} mutations, every one caught by the gate that claims it`
        + `${precondSkipped.length > 0 ? `; ${precondSkipped.length} skipped for an absent precondition` : ''}`
        + `${notSelected > 0 ? ` (${notSelected} not selected; run the other half)` : ''}\n`);
    for (const c of precondSkipped) {
        console.log(`  SKIPPED ${c.gate}: ${c.what} - its subject is not in this workspace`);
    }
    if (precondSkipped.length > 0) { console.log(''); }
    process.exit(0);
}
for (const m of missed) {
    console.log(`\n  MISSED  ${m.gate}: ${m.what}`);
    console.log(`          expected a non-zero exit containing ${JSON.stringify(m.tag)}, got rc=${m.rc}`);
    console.log(m.tail.split('\n').map((l) => `          | ${l}`).join('\n'));
}
console.log(`\n  ${missed.length} missed${dirty ? ', and the tree is dirty' : ''}\n`);
process.exit(1);
