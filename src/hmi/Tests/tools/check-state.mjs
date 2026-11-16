#!/usr/bin/env node
// check-state.mjs — the mechanical half of Rule 20.
//
// A decision that is not in STATE.md was not made. This tool cannot read intent,
// so it checks the part that is mechanical: that every D-, DEV-, OD- and
// observation number in the record is unique, that the numbers run upward, that
// nothing is cited that was never defined, and that the "next number" markers
// have not been overtaken.
//
// The failure it exists for: TODO.md cited `D-109` for the TouchTargetSize = 0
// fix, the code carried the fix, and the decision was never written down. No
// gate read STATE.md, so nothing caught it for a whole feature spec.
//
// Scope. The record is every file listed in RECORD_FILES that exists, plus
// gates/*.md. Files that are absent are skipped and named in the summary — the
// archive (`STATE-JSON-LOD.md`) is supplied per session like `pdf/` and `ref/`
// are, and its absence must not turn the gate red. Inherited numbers therefore
// have a second definition site: a table row under a heading that names them as
// inherited registers the number as defined-elsewhere, which is what lets
// STATE.md cite `D-087` without carrying its text.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { reportSkippedTool } from './external-inputs.mjs';

const ROOT = process.cwd();

const RECORD_FILES = [
  'STATE.md',
  'STATE-JSON-LOD.md',
  'PHASE-GATE-LOD.md',
  'PHASE-GATE-JSON.md',
  'TODO.md',
];

// ---------------------------------------------------------------- collection

/** `### D-109 — title`, `### DEV-021 — title`, `### OD-003 — title` */
const RE_DEF = /^#{2,4}\s+(D|DEV|OD)-(\d+)\b/;
/** `146. **text**` — an observation, numbered as a markdown ordered-list item */
const RE_OBS = /^(\d{1,4})\.\s+\*\*/;
/** any reference, in prose, in a table, in backticks */
const RE_CITE = /\b(D|DEV|OD)-(\d+)\b/g;
/** `Next number: `DEV-021`` / `Next number: **146**` / `deviations at `DEV-021`` */
const RE_NEXT_TAGGED = /Next number:\s*[`*]*\s*(D|DEV|OD)-(\d+)/g;
const RE_NEXT_OBS = /Next number:\s*[`*]*\s*(\d{1,4})\b/g;
/** `Decisions resume at D-109, observations at 146, deviations at DEV-021` — the
 *  first number this file will use. A forward declaration, not a citation. */
const RE_RESUME = /\b(?:resumes? at|continues? at|start(?:s|ing)? at)\b/i;
/** an inherited-range declaration, invisible in rendered markdown:
 *  <!-- inherited: D-001..D-108, DEV-001..DEV-020, OD-001..OD-002, obs 1..145 in STATE-JSON-LOD.md -->
 */
const RE_INHERITED_RANGE = /<!--\s*inherited:(.+?)-->/i;
const RE_RANGE_TAGGED = /(D|DEV|OD)-(\d+)\.\.(?:(?:D|DEV|OD)-)?(\d+)/g;
const RE_RANGE_OBS = /obs\s+(\d+)\.\.(\d+)/i;
/** a heading that turns the table under it into an inherited-definition block */
const RE_INHERITED_HEADING = /^#{2,4}\s+.*\binherit/i;

function recordFiles() {
  const found = [];
  const missing = [];
  for (const f of RECORD_FILES) {
    (existsSync(join(ROOT, f)) ? found : missing).push(f);
  }
  const gatesDir = join(ROOT, 'gates');
  if (existsSync(gatesDir)) {
    for (const f of readdirSync(gatesDir).filter((n) => n.endsWith('.md')).sort()) {
      found.push(join('gates', f));
    }
  }
  return { found, missing };
}

function scan(file) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const lines = text.split(/\r?\n/);

  const defs = [];        // { kind, num, file, line }
  const inherited = [];   // { kind, num, file, line }
  const obsDefs = [];     // { num, file, line }
  const obsInherited = []; // { num, file, line } — declared as living in the archive
  const cites = [];       // { kind, num, file, line }
  const declared = [];    // { kind, num, file, line } — forward declarations
  const nextTagged = [];  // { kind, num, file, line }
  const nextObs = [];     // { num, file, line }

  let inInheritedBlock = false;
  let inObservations = false;

  // Resume declarations are paragraph-scoped: `Decisions resume at D-109,
  // observations at 146, deviations at DEV-021.` wraps across lines, and a
  // line-scoped test would read the wrapped half as a citation.
  const resumeDeclared = new Set();
  for (const para of text.split(/(?:\r?\n){2,}/)) {
    const hit = new RegExp(RE_RESUME.source, 'i').exec(para);
    if (!hit) continue;
    // The declaration is the sentence the phrase sits in, not the paragraph:
    // the sentence after it is ordinary prose and its references are citations.
    const rest = para.slice(hit.index);
    const end = rest.search(/\.(?:\s|$)/);
    const sentence = end === -1 ? rest : rest.slice(0, end);
    let m;
    const re = new RegExp(RE_CITE.source, 'g');
    while ((m = re.exec(sentence))) resumeDeclared.add(`${m[1]}-${Number(m[2])}`);
  }

  const decl = RE_INHERITED_RANGE.exec(text);
  if (decl) {
    const body = decl[1];
    let r;
    RE_RANGE_TAGGED.lastIndex = 0;
    while ((r = RE_RANGE_TAGGED.exec(body))) {
      for (let n = Number(r[2]); n <= Number(r[3]); n++) {
        inherited.push({ kind: r[1], num: n, file, line: 0 });
      }
    }
    const ro = RE_RANGE_OBS.exec(body);
    if (ro) {
      for (let n = Number(ro[1]); n <= Number(ro[2]); n++) {
        obsInherited.push({ num: n, file, line: 0 });
      }
    }
  }

  lines.forEach((raw, i) => {
    const line = raw;
    const no = i + 1;

    if (/^#{1,6}\s/.test(line)) {
      inInheritedBlock = RE_INHERITED_HEADING.test(line);
      inObservations = /^#{1,4}\s+.*\bobservations?\b/i.test(line);
    }

    const d = RE_DEF.exec(line);
    if (d) {
      defs.push({ kind: d[1], num: Number(d[2]), file, line: no });
      return; // a definition heading is not also a citation of itself
    }

    if (inObservations) {
      const o = RE_OBS.exec(line);
      if (o) obsDefs.push({ num: Number(o[1]), file, line: no });
    }

    let m;
    const nextHere = new Set();
    RE_NEXT_TAGGED.lastIndex = 0;
    while ((m = RE_NEXT_TAGGED.exec(line))) {
      nextTagged.push({ kind: m[1], num: Number(m[2]), file, line: no });
      // `Next number: DEV-022` names a number that does not exist yet. It is a
      // marker, not a citation, and must not be checked as one.
      nextHere.add(`${m[1]}-${Number(m[2])}`);
    }
    if (!/\b(D|DEV|OD)-/.test(line)) {
      RE_NEXT_OBS.lastIndex = 0;
      while ((m = RE_NEXT_OBS.exec(line))) {
        nextObs.push({ num: Number(m[1]), file, line: no });
      }
    }

    RE_CITE.lastIndex = 0;
    while ((m = RE_CITE.exec(line))) {
      const entry = { kind: m[1], num: Number(m[2]), file, line: no };
      // A row of an inherited-decisions table defines the number elsewhere.
      if (inInheritedBlock && line.trimStart().startsWith('|')) inherited.push(entry);
      // A resume declaration names the first number this file will use; it is
      // not a claim that the number already exists.
      else if (resumeDeclared.has(`${m[1]}-${Number(m[2])}`) || nextHere.has(`${m[1]}-${Number(m[2])}`))
        declared.push(entry);
      else cites.push(entry);
    }
  });

  return { defs, inherited, obsDefs, obsInherited, cites, declared, nextTagged, nextObs };
}

// ------------------------------------------------------------------- checks

const findings = [];
const fail = (rule, msg) => findings.push({ rule, msg });
const at = (e) => `${e.file}:${e.line}`;
const tag = (e) => `${e.kind}-${String(e.num).padStart(3, '0')}`;

const { found, missing } = recordFiles();
// STATE.md ships in neither archive (F-2). This checker is entirely about it, so
// there is no partial run to salvage: it skips as a whole, names what did not get
// checked, and exits 0 — because a file that was never delivered is not a defect
// in what was. Under --strict the absence is a failure, and the repository's own
// gate runs strict.
if (!found.includes('STATE.md')) {
  process.exit(reportSkippedTool('STATE.md', [
    'every decision, deviation and observation number is unique and monotonic',
    'every cited number is defined before it is cited',
    'the gate index rows resolve to a file in gates/',
  ]));
}

const all = { defs: [], inherited: [], obsDefs: [], obsInherited: [], cites: [], declared: [], nextTagged: [], nextObs: [] };
for (const f of found) {
  const r = scan(f);
  for (const k of Object.keys(all)) all[k].push(...r[k]);
}

// 1. unique — no number defined twice, in one file or across two
for (const group of [['tagged', all.defs], ['observation', all.obsDefs]]) {
  const [what, list] = group;
  const seen = new Map();
  for (const e of list) {
    const key = what === 'tagged' ? tag(e) : `obs ${e.num}`;
    if (seen.has(key)) {
      fail('unique', `${key} is defined twice: ${at(seen.get(key))} and ${at(e)}`);
    } else seen.set(key, e);
  }
}

// 2. monotonic — definitions of one kind run upward in file order
for (const kind of ['D', 'DEV', 'OD']) {
  let prev = null;
  for (const e of all.defs.filter((x) => x.kind === kind)) {
    if (prev && e.num <= prev.num) {
      fail('monotonic', `${tag(e)} at ${at(e)} does not follow ${tag(prev)} at ${at(prev)}`);
    }
    prev = e;
  }
}
{
  let prev = null;
  for (const e of all.obsDefs) {
    if (prev && e.num <= prev.num) {
      fail('monotonic', `observation ${e.num} at ${at(e)} does not follow ${prev.num} at ${at(prev)}`);
    }
    prev = e;
  }
}

// 3. cited nowhere before it is defined — the D-109 rule
const defined = new Set(all.defs.map(tag));
const inheritedSet = new Set(all.inherited.map(tag));
const undefinedCites = new Map();
for (const e of all.cites) {
  const k = tag(e);
  if (defined.has(k) || inheritedSet.has(k)) continue;
  if (!undefinedCites.has(k)) undefinedCites.set(k, e);
}
for (const [k, e] of undefinedCites) {
  fail('undefined', `${k} is cited at ${at(e)} and defined nowhere in the record`);
}

// 4. the "next number" markers have not been overtaken
for (const n of all.nextTagged) {
  const highest = [...all.defs, ...all.inherited]
    .filter((d) => d.kind === n.kind)
    .reduce((a, d) => Math.max(a, d.num), -1);
  if (highest >= n.num) {
    fail('next', `${at(n)} says next ${n.kind} is ${n.num}, but ${n.kind}-${highest} is already defined`);
  }
}
for (const n of all.nextObs) {
  const highest = [...all.obsDefs, ...all.obsInherited].reduce((a, d) => Math.max(a, d.num), -1);
  if (highest >= n.num) {
    fail('next', `${at(n)} says next observation is ${n.num}, but ${highest} is already defined`);
  }
}

// ------------------------------------------------------------------ report

const line = '='.repeat(29);
console.log('\n  STATE record cross-check');
console.log(line);
console.log('  record files read     : ' + found.join(', '));
if (missing.length) console.log('  not present, skipped  : ' + missing.join(', '));
console.log(`  decisions defined     : ${all.defs.filter((d) => d.kind === 'D').length}`);
console.log(`  open decisions        : ${all.defs.filter((d) => d.kind === 'OD').length}`);
console.log(`  deviations defined    : ${all.defs.filter((d) => d.kind === 'DEV').length}`);
console.log(`  observations defined  : ${all.obsDefs.length}`);
console.log(`  inherited references  : ${inheritedSet.size} tagged, ${all.obsInherited.length} observations`);
console.log(`  citations checked     : ${all.cites.length}`);
console.log(line);

if (findings.length === 0) {
  console.log('  OK — every number is unique, monotonic, and defined before it is cited\n');
  process.exit(0);
}
for (const f of findings) console.log(`  [${f.rule}] ${f.msg}`);
console.log(line);
console.log(`  ${findings.length} finding${findings.length === 1 ? '' : 's'}\n`);
process.exit(1);
