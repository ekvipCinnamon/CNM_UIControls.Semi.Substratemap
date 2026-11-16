#!/usr/bin/env node
// check-as-shipped.mjs — run the gates in the tree a consumer actually receives.
//
// Why this exists (F-0). W-44 closed a blocker that had survived 1849 assertions,
// fourteen gates and 230 mutations. It survived because every check in this
// package runs in a tree that was never assembled the way it ships: the
// development workspace has files the archives do not carry, so a check that
// passes here is a check about here.
//
// This is a tool, not a test. It takes the delivered archives (or directories),
// merges them into one root the way a consumer would, and runs the fourteen
// gates there.
//
// The distinction it exists to draw (F-0's second Done-when): a gate that fails
// because the PRODUCT is wrong and a gate that fails because the TREE IS
// INCOMPLETE are different findings, and counting them together is how the
// delivery came to be red out of the box without anyone noticing. So the
// prerequisites are derived from the tree itself before any gate runs, and a
// gate whose inputs are absent is reported BLOCKED and named — never counted as
// a failure. Only a RED gate means the product is broken; only RED sets the
// exit code. `--strict` collapses that distinction for the repository's own use,
// which is the pattern F-2 adopts for the suites.
//
// Provenance: every claim below is about this package's delivery rather than
// about the standard, so it cites the task that made it so — D-200.
//
// Usage:
//   node tools/check-as-shipped.mjs <input...> [--keep] [--strict] [--no-gates]
//     <input>      .tar.gz / .tgz / .tar / directory. Applied in the order given.
//     --keep       leave the assembled tree on disk and print its path
//     --strict     BLOCKED counts as RED (exit 1)
//     --no-gates   assemble and check prerequisites only

import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';

const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter((a) => a.startsWith('--')));
const INPUTS = argv.filter((a) => !a.startsWith('--'));
const STRICT = FLAGS.has('--strict');
const line = '='.repeat(72);

if (INPUTS.length === 0) {
  console.error('usage: node tools/check-as-shipped.mjs <archive-or-dir>... [--keep] [--strict] [--no-gates]');
  process.exit(2);
}

// ------------------------------------------------------------------ assemble

const ROOT = mkdtempSync(join(tmpdir(), 'as-shipped-'));
/** path -> the input that last wrote it, so "ships in neither archive" is answerable */
const provenance = new Map();

function inventory(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...inventory(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

for (const [i, input] of INPUTS.entries()) {
  const src = resolve(input);
  if (!existsSync(src)) {
    console.error(`  input not found: ${input}`);
    process.exit(2);
  }
  if (statSync(src).isDirectory()) execFileSync('cp', ['-a', src + '/.', ROOT]);
  else {
    // `-z` is not assumed. F-0 was specified against "the two tarballs", and the
    // ones that arrived are uncompressed `.tar` — hardcoding -xzf turned that into
    // an execFileSync stack trace with the real message ("not in gzip format")
    // buried in a Buffer. A tool whose job is to report clearly must first parse
    // its own inputs clearly.
    const gz = readFileSync(src, { length: 2 }).length === 2
      && readFileSync(src).subarray(0, 2).toString('hex') === '1f8b';
    try {
      execFileSync('tar', [gz ? '-xzf' : '-xf', src, '-C', ROOT], { stdio: 'pipe' });
    } catch (e) {
      console.error(`\n  cannot unpack ${input}\n    ${String(e.stderr ?? e.message).trim().split('\n')[0]}`);
      process.exit(2);
    }
  }
  for (const f of inventory(ROOT)) if (!provenance.has(f)) provenance.set(f, input);

  // The protocol's order is load-bearing and says so: the stub's contents move to
  // the root immediately after the FIRST archive, so that the real README.md,
  // package.json and typecheck.sh extracted afterwards overwrite the stub's.
  // Doing it at the end instead reproduces the exact documented failure — a
  // 2 997-byte stub README replacing the real one and taking check-readme to
  // 0 of 60 — and then reports it as a product defect. Measured, on the first
  // run against real archives.
  const stub = join(ROOT, 'FrameworkStub');
  if (i === 0 && existsSync(stub)) {
    for (const e of readdirSync(stub)) {
      // A nested FrameworkStub.tar ships inside FrameworkStub/. Unpack it rather
      // than depositing a tarball at the root, where nothing would read it.
      if (e === 'FrameworkStub.tar') {
        try { execFileSync('tar', ['-xf', join(stub, e), '-C', ROOT], { stdio: 'pipe' }); } catch { /* keep going */ }
        continue;
      }
      rmSync(join(ROOT, e), { recursive: true, force: true });
      renameSync(join(stub, e), join(ROOT, e));
    }
    rmSync(stub, { recursive: true, force: true });
  }
}

const has = (p) => existsSync(join(ROOT, p));
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/^\uFEFF/, '');

// -------------------------------------------------------------- prerequisites
//
// Derived from the tree, not from a list kept here. A list kept here would drift
// from the tsconfigs exactly the way tests/README.md drifted from the fixtures.

/** {need, why, gates[]} for everything the tree says it needs and does not have */
const missing = [];
const need = (ok, path, why, gates) => { if (!ok) missing.push({ path, why, gates }); };

/**
 * The projects to type-check, read out of the ASSEMBLED tree's `package.json`
 * gate script rather than written here.
 *
 * This was a hardcoded list of six until F-3, which is the same defect F-3 exists
 * to fix one file over: `typecheck.sh` carried a second copy and it named three
 * controls that had not existed since the rename. A third copy in the tool that
 * checks the delivery would have gone stale the same way, and worse — it would
 * have reported a project the delivery no longer has as BLOCKED, or missed one it
 * gained entirely. Reading the tree being measured also means the tool describes
 * that tree rather than this workspace (D-223).
 */
const TSCONFIGS = (() => {
  const gate = has('package.json')
    ? String(JSON.parse(read('package.json')).scripts?.gate ?? '') : '';
  const dirs = [...new Set([...gate.matchAll(/tsc -p ([^ ]+)\/tsconfig\.json/g)].map((m) => m[1]))];
  // Labelled by directory. An earlier version shortened the leaf and stripped the
  // `SubstrateMap` prefix, which left `Controls/SubstrateMap` with an empty name
  // and a `tsc:root` fallback that pointed at nothing. A name derived by trimming
  // is a name that can collide or vanish; the directory cannot.
  return dirs.map((d) => [d, `tsc ${d}`]);
})();

// 1. Every file a tsconfig names must be present, or that project cannot be built
//    at all — a different thing from a project that builds and has type errors.
for (const [dir, gate] of TSCONFIGS) {
  const cfg = `${dir}/tsconfig.json`;
  if (!has(cfg)) { need(false, cfg, 'tsconfig absent; the project cannot be built', [gate]); continue; }
  let parsed;
  try { parsed = JSON.parse(read(cfg)); } catch (e) {
    need(false, cfg, `tsconfig is not parseable: ${e.message}`, [gate]);
    continue;
  }
  for (const f of [...(parsed.files ?? []), ...(parsed.include ?? [])]) {
    const rel = join(dir, f.trim());
    need(has(rel), rel, `named in ${cfg} ${parsed.files?.includes(f) ? 'files[]' : 'include[]'}`, [gate]);
  }
}

// 2. The framework path, read out of the root tsconfig rather than hardcoded, so
//    a version bump is visible here as a missing directory and not as a silent
//    pass. This is F-1's guard in its read-only form.
if (has('tsconfig.json')) {
  const rootCfg = JSON.parse(read('tsconfig.json'));
  for (const cands of Object.values(rootCfg.compilerOptions?.paths ?? {})) {
    for (const c of cands) {
      const dir = c.replace(/^\.\//, '').replace(/\/\*$/, '').replace(/\/[^/]*\.d\.ts$/, '');
      need(has(dir), dir, 'framework path named in tsconfig.json compilerOptions.paths',
        TSCONFIGS.map(([, g]) => g));
    }
  }
}

// 3. Every relative import in a suite or a tool must resolve. This is what the
//    delta archives fail on first, and it fails at load time, so it costs the
//    whole suite rather than one assertion.
const RE_IMPORT = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g;
for (const [subdir, gate] of [['Helpers/SubstrateMapEngine/tests', 'node --test'], ['tools', 'tools']]) {
  if (!has(subdir)) continue;
  for (const f of readdirSync(join(ROOT, subdir)).filter((n) => n.endsWith('.mjs'))) {
    const src = read(`${subdir}/${f}`);
    for (const [, spec] of src.matchAll(RE_IMPORT)) {
      const target = relative(ROOT, resolve(join(ROOT, subdir), spec));
      need(has(target), target, `imported by ${subdir}/${f}`, [gate]);
    }
  }
}

// 4. The fixture corpus. Present-but-empty is the same finding as absent: the
//    assertions that read it cannot run either way.
for (const d of ['Helpers/SubstrateMapEngine/tests/fixtures/xml', 'Helpers/SubstrateMapEngine/tests/fixtures/json']) {
  need(has(d) && readdirSync(join(ROOT, d)).length > 0, d, 'fixture corpus read by the E142 suites', ['node --test']);
}

// 5. Files the repository has and no archive ships. Which gates each one blocks
//    is DERIVED by scanning the tools for the literal filename, not asserted
//    here: the hardcoded guess had `SubstrateMap-Working-Protocol.md` blocking
//    the suite when it actually crashes `check-manifest`, so the tool reported a
//    missing input as a product defect. A list kept here drifts from the tools
//    exactly the way every other hand-maintained list in this tree has.
const CHECKERS = has('tools')
  ? readdirSync(join(ROOT, 'tools')).filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
    .map((f) => f.replace(/\.mjs$/, ''))
  : [];

for (const f of ['Desktop.view', 'SubstrateMap-Working-Protocol.md', 'STATE.md']) {
  if (has(f)) continue;
  const blocks = CHECKERS.filter((c) => read(`tools/${c}.mjs`).includes(f));
  for (const [subdir, gate] of [['Helpers/SubstrateMapEngine/tests', 'node --test']]) {
    if (has(subdir) && readdirSync(join(ROOT, subdir))
      .some((t) => t.endsWith('.mjs') && read(`${subdir}/${t}`).includes(f))) blocks.push(gate);
  }
  need(false, f, blocks.length
    ? `required by ${blocks.join(', ')} and shipped in no archive (F-2)`
    : 'named by nothing that runs — shipped in no archive, and apparently unread (F-2)', blocks);
}

// 6. Dependencies. Installing them is what a consumer does, so the tool does it
//    too rather than reporting the absence as though it were a defect. What IS a
//    finding is that no lockfile ships: `npm ci` is impossible for a consumer,
//    so the install is unpinned and the tree is not the one that was tested.
if (has('package.json') && !has('node_modules') && !FLAGS.has('--no-install')) {
  // Gates nothing: the install still succeeds. It is named because the versions
  // that get installed are not the versions that were tested, which is a finding
  // about the delivery and not about any one gate.
  need(has('package-lock.json'), 'package-lock.json',
    'ships in no archive, so a consumer cannot npm ci and installs unpinned versions', []);
  try {
    execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: ROOT, stdio: 'pipe', timeout: 600_000 });
  } catch (e) {
    need(false, 'node_modules', `npm install failed in the assembled tree: ${String(e.message).split('\n')[0]}`, ['*']);
  }
}
need(has('node_modules') || !has('package.json'), 'node_modules',
  'dependencies are not installed and could not be', ['*']);

// 7. The emit. Neither archive ships a single `.js`, and the suites import `.js`
//    because that is what the HMI runtime loads. The stub README tells a consumer
//    to run `typecheck.sh --emit`, so the tool runs it too — reporting 48
//    unresolved imports would be measuring a step the consumer is told to take.
//    What IS a finding is that nothing enforces the order, so it is named.
if (has('node_modules') && !FLAGS.has('--no-emit')) {
  const emitted = [];
  for (const [dir] of TSCONFIGS) {
    if (!has(`${dir}/tsconfig.json`)) continue;
    try {
      execFileSync('npx', ['tsc', '-p', `${dir}/tsconfig.json`], { cwd: ROOT, stdio: 'pipe', timeout: 300_000 });
      emitted.push(dir);
    } catch { /* a project that cannot emit is already reported by its tsc gate */ }
  }
  if (emitted.length === 0) {
    need(false, '*.js', 'no archive ships emitted JavaScript and no project could emit any, '
      + 'so every suite fails at import before its first assertion', ['node --test']);
  }
}

// Provisioning — `npm install` and the emit — can satisfy inputs that were absent
// when the prerequisites above were computed, because those run first. Re-check
// rather than reporting a list that was true a moment ago: an emitted `.js` that
// is now on disk must not block the suite that imports it.
for (let i = missing.length - 1; i >= 0; i--) {
  if (missing[i].path !== '*.js' && has(missing[i].path)) missing.splice(i, 1);
}

// 8. Build artefacts. `build.log` - 54 kB of MSBuild output - shipped inside
//    SubstrateMap.tar while `.gitignore` excluded it and the nuspec never named
//    it: the archive is assembled from the working directory, which honours
//    neither. This is the only place that fact is observable, because the
//    builder is not in this repository (F-12, D-241).
{
  const junk = [];
  const scan = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'Packages') { continue; }
      const rel = dir === '.' ? e.name : `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === 'bin' || e.name === 'obj') { junk.push(`${rel}/`); continue; }
        scan(rel);
      } else if (/\.log$/i.test(e.name)) { junk.push(rel); }
    }
  };
  scan('.');
  for (const p of junk) {
    need(false, p, 'a build artefact in the delivered tree - excluded by .gitignore and .tfignore '
      + 'and named by no <file src>, so the archive was assembled from the working directory (F-12)', []);
  }
}


// --------------------------------------------------------------------- gates
//
// The fourteen. The protocol's block lists thirteen and its prose says ten;
// check-templates joined at W-44 and the block was never updated (D-214).

const GATES = [
  ...TSCONFIGS.map(([dir, id]) => ({ id, cmd: ['npx', 'tsc', '-p', `${dir}/tsconfig.json`, '--noEmit'] })),
  // The protocol's block passes an expanded glob, not a directory. Node treats the
  // two differently, so the tool expands it here rather than measuring something
  // the repository never runs.
  {
    id: 'node --test',
    cmd: ['node', '--test', ...(has('Helpers/SubstrateMapEngine/tests')
      ? readdirSync(join(ROOT, 'Helpers/SubstrateMapEngine/tests'))
        .filter((n) => n.endsWith('.test.mjs')).sort()
        .map((n) => `Helpers/SubstrateMapEngine/tests/${n}`)
      : [])],
    baseline: true,
  },
  ...['check-templates', 'check-descriptors', 'check-manifest', 'check-readme',
    'check-hmiextproj', 'check-schema-cardinality', 'check-state']
    .map((t) => ({ id: t, cmd: ['node', `tools/${t}.mjs`] })),
];

const blockedBy = (id) => missing.filter((m) => m.gates.includes(id) || m.gates.includes('*'));

const results = [];
let baseline = null;

if (!FLAGS.has('--no-gates')) {
  for (const g of GATES) {
    const blockers = blockedBy(g.id);
    let out = '', code = 0;
    try {
      out = execFileSync(g.cmd[0], g.cmd.slice(1), { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 900_000 });
    } catch (e) {
      code = e.status ?? 1;
      out = (e.stdout ?? '') + (e.stderr ?? '');
    }
    if (g.baseline) {
      const passed = [...out.matchAll(/^#\s+pass\s+(\d+)$/gm)].reduce((a, m) => a + +m[1], 0);
      const failed = [...out.matchAll(/^#\s+fail\s+(\d+)$/gm)].reduce((a, m) => a + +m[1], 0);
      const assertions = [...out.matchAll(/RESULT:\s+(\d+) passed,\s+(\d+) failed/g)]
        .reduce((a, m) => ({ pass: a.pass + +m[1], fail: a.fail + +m[2] }), { pass: 0, fail: 0 });
      baseline = {
        suites: { passed, failed },
        assertions,
        enoent: (out.match(/ENOENT/g) ?? []).length,
        unresolved: (out.match(/ERR_MODULE_NOT_FOUND/g) ?? []).length,
      };
    }
    // A non-zero exit with a named missing input is the environment, not the product.
    const verdict = code === 0 ? 'GREEN' : blockers.length ? 'BLOCKED' : 'RED';
    results.push({ ...g, code, verdict, blockers, tail: out.trim().split('\n').slice(-3).join('\n') });
  }
}

// -------------------------------------------------------------------- report

const count = (v) => results.filter((r) => r.verdict === v).length;

console.log(`\n  as-shipped gate run — ${INPUTS.length} input${INPUTS.length === 1 ? '' : 's'}`);
console.log(line);
for (const i of INPUTS) console.log(`  input                 : ${i}`);
console.log(`  assembled files       : ${provenance.size}`);
console.log(`  assembled at          : ${FLAGS.has('--keep') ? ROOT : '(temporary)'}`);
console.log(line);

if (missing.length) {
  console.log(`\n  ENVIRONMENT INCOMPLETE — ${missing.length} declared input${missing.length === 1 ? '' : 's'} absent`);
  console.log('  Each is named because the tree asks for it, not because this tool expects it.\n');
  for (const m of missing.slice(0, 40)) console.log(`    ${m.path}\n        ${m.why}`);
  if (missing.length > 40) console.log(`    … and ${missing.length - 40} more`);
} else {
  console.log('\n  environment complete — every input the tree declares is present');
}

if (!FLAGS.has('--no-gates')) {
  console.log(`\n  GATES — ${results.length} of the fourteen attempted`);
  console.log(line);
  for (const r of results) {
    const note = r.verdict === 'BLOCKED'
      ? `blocked by ${r.blockers.length} missing input${r.blockers.length === 1 ? '' : 's'}, first: ${r.blockers[0].path}`
      : r.verdict === 'RED' ? `exit ${r.code} with every declared input present — PRODUCT` : '';
    console.log(`  ${r.verdict.padEnd(8)} ${r.id.padEnd(30)} ${note}`);
  }
  console.log(line);
  console.log(`  green ${count('GREEN')}   blocked ${count('BLOCKED')}   red ${count('RED')}`);

  if (baseline) {
    console.log('\n  BASELINE (F-0)');
    console.log(`    suites      : ${baseline.suites.passed} passed, ${baseline.suites.failed} failed`);
    console.log(`    assertions  : ${baseline.assertions.pass} passed, ${baseline.assertions.fail} failed`);
    console.log(`    ENOENT      : ${baseline.enoent}`);
    console.log(`    unresolved  : ${baseline.unresolved} import${baseline.unresolved === 1 ? '' : 's'}`);
    if (baseline.unresolved > 0) {
      console.log('    NOTE: an unresolved import costs its whole suite before any assertion runs,');
      console.log('          so the assertion count is a floor and not a measurement.');
    }
  }
}

if (!FLAGS.has('--keep')) rmSync(ROOT, { recursive: true, force: true });
else console.log(`\n  tree kept at ${ROOT}`);

const red = count('RED') + (STRICT ? count('BLOCKED') : 0);
console.log(line);
if (red === 0 && missing.length === 0) console.log('  OK — the delivery runs its own gates as shipped\n');
else if (red === 0) console.log(`  NOT PROVEN — no gate blames the product, but ${missing.length} inputs are absent\n`);
else console.log(`  ${red} gate${red === 1 ? '' : 's'} ${STRICT ? 'red or blocked' : 'red'}\n`);
process.exit(red === 0 ? 0 : 1);
