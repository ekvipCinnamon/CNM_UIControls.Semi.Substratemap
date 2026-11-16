#!/usr/bin/env node
/*
 * tests-readme.mjs - the test README's countable claims, from the tests.
 *
 * ---- WHY (F-16, D-244) ----
 *
 * The review's `S8`/`T4`. Measured: the suite table listed **9 of 21** suites, and
 * 3 of the 9 quoted `RESULT:` counts were stale. The fixture inventory claimed
 * *43 XML + 20 JSON* against **59 + 77** on disk.
 *
 * The sharp edge the task names is the real finding: this repository built
 * `check-readme` for the product README and had nothing for its own. **A rule
 * enforced on everyone else and not on oneself is a rule with a hole in the shape
 * of oneself.**
 *
 * ---- WHAT IS GENERATED AND WHAT IS GATED ----
 *
 * GENERATED here: the suite roster with each suite's assertion count, which needs
 * the suites to be RUN and so cannot live in a gate that must stay fast.
 *
 * GATED in `check-readme`: the roster itself and the fixture counts. Both are a
 * directory listing, both are exact, and both are what actually drifted. "Changing
 * a fixture count turns it red" is that half.
 *
 * The descriptions are NOT generated. A sentence saying what a suite covers is a
 * judgement, and a tool that invented one would fill the column with something
 * that reads like prose and means nothing. Existing descriptions are carried
 * across by suite name; a new suite arrives with `—` and a person writes it.
 *
 * ---- USAGE ----
 *
 *   node tools/tests-readme.mjs           rewrite the blocks (runs every suite)
 *   node tools/tests-readme.mjs --check   exit 1 if a block is stale
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = 'Helpers/SubstrateMapEngine/tests';
const DOC = join(ROOT, TESTS, 'README.md');
const CHECK = process.argv.includes('--check');

const SUITES_BEGIN = '<!-- SUITES:BEGIN -->';
const SUITES_END = '<!-- SUITES:END -->';
const FIXTURES_BEGIN = '<!-- FIXTURES:BEGIN -->';
const FIXTURES_END = '<!-- FIXTURES:END -->';

/** @returns Every suite file name, sorted. */
export const suiteFiles = () =>
    readdirSync(join(ROOT, TESTS)).filter((f) => f.endsWith('.test.mjs')).sort();

/** @returns `{ xml, json }` fixture counts. */
export const fixtureCounts = () => ({
    xml: readdirSync(join(ROOT, TESTS, 'fixtures/xml')).filter((f) => f.endsWith('.xml')).length,
    json: readdirSync(join(ROOT, TESTS, 'fixtures/json')).filter((f) => f.endsWith('.json')).length,
});

/**
 * Descriptions already in the document, by suite file.
 *
 * Carried across rather than regenerated, because a description is the one column
 * a tool has no business writing.
 * @param doc The current document.
 * @returns `Map<file, { covers, fixtures }>`.
 */
function existingRows(doc) {
    const rows = new Map();
    for (const m of doc.matchAll(/\|\s*`([a-z0-9-]+\.test\.mjs)`\s*\|([^|]*)\|([^|]*)\|/g)) {
        rows.set(m[1], { covers: m[2].trim(), fixtures: m[3].trim() });
    }
    return rows;
}

/** @param file A suite file. @returns Its passing-assertion count, or `null`. */
function assertionCount(file) {
    const r = spawnSync(process.execPath, ['--test', `${TESTS}/${file}`],
        { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const nums = [...String(r.stdout ?? '').matchAll(/RESULT: (\d+) passed/g)].map((m) => Number(m[1]));
    return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}

const doc0 = readFileSync(DOC, 'utf8');
const eol = doc0.includes('\r\n') ? '\r\n' : '\n';
for (const [b, e] of [[SUITES_BEGIN, SUITES_END], [FIXTURES_BEGIN, FIXTURES_END]]) {
    if (doc0.indexOf(b) === -1 || doc0.indexOf(e) === -1) {
        console.error(`tests-readme: no ${b} … ${e} block in ${TESTS}/README.md`);
        process.exit(2);
    }
}

const carried = existingRows(doc0);
const files = suiteFiles();
const fx = fixtureCounts();

const suiteRows = files.map((f) => {
    const prev = carried.get(f);
    const n = CHECK ? null : assertionCount(f);
    const covers = prev?.covers && prev.covers !== '—' ? prev.covers : '—';
    const fixtures = prev?.fixtures ?? 'no';
    const expected = n === null ? (prev ? '—' : '—') : `\`${n} passed\``;
    return `| \`${f}\` | ${covers} | ${fixtures} | ${expected} |`;
});

const suitesBody = [
    '',
    `**${files.length} suites.** Rows are generated from \`${TESTS}/\`; the *Covers* column is written by`,
    'hand and carried across, because a description is a judgement and a generated one would read like',
    'prose and mean nothing. A new suite arrives with `—` until someone writes it.',
    '',
    '| Suite | Covers | Needs fixtures | Expected |',
    '|---|---|---|---|',
    ...suiteRows,
    '',
].join('\n');

const fixturesBody = [
    '',
    '```',
    `tests/fixtures/xml/               ${fx.xml} .xml (+ official-E142-1-V0211-Schema-Extension-Example.xsd,`,
    '                                  shipped with the corpus, not read by any card)',
    `tests/fixtures/json/              ${fx.json} .json`,
    "tests/fixtures/EXPECTATIONS.md    the expectation cards the suite's XML_CARDS / JSON_CARDS",
    '                                  arrays were transcribed from — reference only, never read',
    '                                  at run time',
    '```',
    '',
    `**Full corpus: ${fx.xml + fx.json} fixtures (${fx.xml} XML + ${fx.json} JSON).** Counted from disk.`,
    '',
].join('\n');

/**
 * @param doc  The document.
 * @param b    Begin marker. @param e End marker. @param body Replacement body.
 * @returns The document with the block replaced.
 */
const splice = (doc, b, e, body) =>
    doc.slice(0, doc.indexOf(b) + b.length) + body.split('\n').join(eol) + doc.slice(doc.indexOf(e));

let wanted = splice(doc0, FIXTURES_BEGIN, FIXTURES_END, fixturesBody);
if (!CHECK) { wanted = splice(wanted, SUITES_BEGIN, SUITES_END, suitesBody); }

if (!CHECK) {
    writeFileSync(DOC, wanted, 'utf8');
    console.log(`  tests/README.md: ${files.length} suites, ${fx.xml} XML + ${fx.json} JSON fixtures`);
    process.exit(0);
}
if (wanted === doc0) {
    console.log(`  test README fixtures  : ${fx.xml} XML + ${fx.json} JSON, in step with disk`);
    process.exit(0);
}
console.error('\n  the test README fixture inventory is out of step with disk.');
console.error(`    disk: ${fx.xml} XML + ${fx.json} JSON`);
console.error('  Run: node tools/tests-readme.mjs\n');
process.exit(1);
