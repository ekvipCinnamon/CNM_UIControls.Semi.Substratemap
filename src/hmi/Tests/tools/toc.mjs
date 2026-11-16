#!/usr/bin/env node
/*
 * toc.mjs - the table of contents in each of the five documents, generated from
 * their headings.
 *
 * ---- WHY GENERATED ----
 *
 * The README has over a hundred headings. A contents list written by hand is right
 * on the day it is written and wrong from the first renamed heading on, and a wrong
 * one is worse than none: the reader clicks, lands nowhere, and stops trusting the
 * rest of the list. So it is read out of the headings, with the anchors GitLab
 * gives them (`lib/headings.mjs`), and `--check` fails a commit that would leave
 * it behind - the same contract as every other derived block in this repository.
 *
 * ---- WHERE IT GOES ----
 *
 * Between `<!-- TOC:BEGIN -->` and `<!-- TOC:END -->`. The first run places the
 * block before the document's first `##` - after the introduction, and before the
 * `---` that separates the introduction from the sections when there is one - and
 * every later run rewrites only what is between the markers. Everything outside
 * them is written by hand.
 *
 * "Contents" is a bold line, not a heading. A heading would list itself, and it
 * would shift every duplicate-numbered anchor below it.
 *
 * ---- HOW DEEP ----
 *
 * Two levels, `##` and `###`, unless a document says otherwise:
 *  - CHANGELOG.md goes to `####`, because its numbered breaking changes - the part
 *    an upgrading reader is looking for - are fourth-level headings.
 *  - API.md stops at `##`. Each generated sequence repeats its section's title as a
 *    `###` directly beneath it, so a second level would list every symptom twice.
 *
 *   node tools/toc.mjs           write the blocks
 *   node tools/toc.mjs --check   exit 1 if a block is missing or stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { headings } from './lib/headings.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const MARKS = ['<!-- TOC:BEGIN -->', '<!-- TOC:END -->'];

/** Document -> deepest heading level listed. */
const DOCS = {
    'README.md': 3,
    'CHANGELOG.md': 4,
    'CONTRIBUTING.md': 3,
    'ARCHITECTURE.md': 3,
    'API.md': 2,
};

/**
 * The block for one document, markers included.
 * @param md    The document.
 * @param depth The deepest level listed.
 * @returns The block's lines.
 */
function block(md, depth) {
    const lines = [MARKS[0], '**Contents**', ''];
    for (const h of headings(md, MARKS)) {
        if (h.level < 2 || h.level > depth) { continue; }
        lines.push(`${'  '.repeat(h.level - 2)}- [${h.label}](#${h.anchor})`);
    }
    lines.push(MARKS[1]);
    return lines;
}

let stale = 0;
let entries = 0;
for (const [doc, depth] of Object.entries(DOCS)) {
    const path = join(ROOT, doc);
    const md = readFileSync(path, 'utf8');
    const eol = (md.match(/\r\n/g) ?? []).length * 2 > (md.match(/\n/g) ?? []).length ? '\r\n' : '\n';
    const lines = md.split(/\r?\n/);
    const want = block(md, depth);
    entries += want.length - 4;
    const b = lines.findIndex((l) => l.trim() === MARKS[0]);
    const e = lines.findIndex((l) => l.trim() === MARKS[1]);
    let next;
    if (b !== -1 && e > b) {
        if (lines.slice(b, e + 1).join('\n') === want.join('\n')) { continue; }
        next = [...lines.slice(0, b), ...want, ...lines.slice(e + 1)];
    } else {
        /* First run: before the first section, and before its `---` if it has one. */
        const first = headings(md).find((h) => h.level === 2);
        if (first === undefined) { console.error(`  ${doc}: no ## heading to place a table of contents before`); stale++; continue; }
        let at = first.line;
        let k = at - 1;
        while (k >= 0 && lines[k].trim() === '') { k--; }
        if (k >= 0 && lines[k].trim() === '---') { at = k; }
        next = [...lines.slice(0, at), ...want, '', ...lines.slice(at)];
    }
    stale++;
    if (CHECK) {
        console.error(`  ${doc}: the table of contents is ${b === -1 ? 'missing' : 'out of step with the headings'}.`
            + ' Run: node tools/toc.mjs');
    } else {
        writeFileSync(path, next.join(eol), 'utf8');
        console.log(`  ${doc}: table of contents written`);
    }
}

if (CHECK) {
    if (stale === 0) {
        console.log(`  tables of contents    : ${Object.keys(DOCS).length} documents, ${entries} entries, in step`);
    }
    process.exit(stale === 0 ? 0 : 1);
}
console.log(`  ${stale} of ${Object.keys(DOCS).length} document(s) rewritten, ${entries} entries`);
