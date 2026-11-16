#!/usr/bin/env node
/*
 * api-sequences.mjs - the sequence diagrams in API.md, traced from the sources.
 *
 * ---- WHAT THESE DIAGRAMS ARE FOR ----
 *
 * Not to describe the API. To tell somebody debugging **where to put the
 * breakpoint**.
 *
 * The complaint they answer, in a PLC developer's words: *"debugging starts at the
 * top and I often do not know how it should work"*. So every arrow in every diagram
 * carries a real file, a real method and a real LINE NUMBER, and each diagram is
 * headed by the symptom that sends you to it. Reading one should replace stepping
 * through a setter to find out which of four parsers ran.
 *
 * ---- WHY TRACED AND NOT DRAWN ----
 *
 * A hand-drawn sequence diagram is a drawing of what somebody believed the call
 * chain was. A line number in a hand-drawn one is worse than none: it sends a
 * reader to a line that moved three commits ago, and they trust it because it looks
 * specific. These are produced by walking the call graph from a named entry point,
 * so a method that stops being called leaves the diagram by itself.
 *
 * ---- WHAT IS APPROXIMATE, AND SAID SO ----
 *
 * The trace is STATIC and by name. It follows `this.__foo(` and bare `foo(` where
 * `foo` is a definition this package owns. It therefore:
 *   - shows branches that a given run may not take - a document is XML or JSON,
 *     never both, and both arrows are drawn;
 *   - cannot follow a call through a value, an event or the framework;
 *   - stops at a fixed depth, because the interesting part of a chain is the top.
 * Each of those is a reason the diagram is a MAP and not a recording, and the
 * document says so where a reader will see it.
 *
 *   node tools/api-sequences.mjs           rewrite the blocks in API.md
 *   node tools/api-sequences.mjs --check   exit 1 if a block is stale
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const DOC = join(ROOT, 'API.md');

/* ------------------------------------------------------------------ the index */

/**
 * `file::name -> { file, short, line, body }` for every definition this package
 * owns. Keyed by FILE AND NAME, not name alone: `setE142MapData` exists on three
 * controls, and a first prototype traced the widget's when asked for the map's.
 */
const KEYWORD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof',
    'do', 'else', 'try', 'throw', 'await', 'void', 'delete', 'in', 'of', 'case']);

function index() {
    const out = new Map();
    const files = execSync(
        'find Controls Helpers/SubstrateMapEngine -maxdepth 2 -name "*.ts" -not -name "*.d.ts"',
        { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
    for (const rel of files) {
        const lines = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/);
        const short = rel.split('/').pop().replace(/\.ts$/, '');
        lines.forEach((l, i) => {
            const m = /^\s{0,8}(?:public |protected |private |export |static |abstract )*(?:async )?(?:function )?(__?[A-Za-z]\w*|[a-z]\w*)\s*(?:<[^>]*>)?\(/.exec(l);
            if (m === null) { return; }
            /*
             * KEYWORDS ARE NOT DEFINITIONS. A first version tested the whole trimmed
             * line and let `switch (kind) {` through, which then appeared in a
             * diagram as a call to `switch()`. Test the captured NAME.
             */
            if (KEYWORD.has(m[1])) { return; }
            const indent = l.match(/^\s*/)[0].length;
            let body = '';
            for (let k = i; k < Math.min(i + 140, lines.length); k++) {
                body += `${lines[k]}\n`;
                if (k > i && lines[k].match(/^\s*/)[0].length === indent && /^\s*\}/.test(lines[k])) {
                    break;
                }
            }
            const key = `${short}::${m[1]}`;
            if (!out.has(key)) { out.set(key, { rel, short, line: i + 1, body, name: m[1] }); }
        });
    }
    return out;
}

const DEFS = index();

/** @param short A file's short name. @param name A method. @returns The def or null. */
function find(short, name) {
    if (DEFS.has(`${short}::${name}`)) { return DEFS.get(`${short}::${name}`); }
    /* fall back to any file that defines it - engine helpers are called across files */
    for (const [k, v] of DEFS) { if (k.endsWith(`::${name}`)) { return v; } }
    return null;
}

/**
 * How many messages a diagram may carry.
 *
 * A first run produced 210 for one scenario - a full call tree at depth four. That
 * is not a debugging aid, it is the thing a debugging aid replaces. The useful
 * shape is a SPINE: the direct calls of the entry point, plus the jumps that cross
 * a file, because a jump into another file is exactly where a reader loses the
 * thread and reaches for the debugger.
 */
const MAX_MESSAGES = 16;

/**
 * Walks the call graph from one definition.
 * @param start The starting def.
 * @param maxDepth How far to follow.
 * @returns Edges `{ from, to, name, line, depth }` in call order.
 */
function trace(start, maxDepth) {
    const edges = [];
    const seen = new Set();
    const walk = (def, depth) => {
        if (def === null || depth === 0) { return; }
        const key = `${def.short}::${def.name}`;
        if (seen.has(key)) { return; }
        seen.add(key);
        const names = [...def.body.matchAll(/(?:this\.)?(__[A-Za-z]\w*|[a-z]\w{3,})\s*\(/g)]
            .map((m) => m[1]);
        for (const n of [...new Set(names)]) {
            if (n === def.name) { continue; }
            const next = find(def.short, n);
            if (next === null) { continue; }
            edges.push({ from: def.short, to: next.short, name: n, line: next.line,
                rel: next.rel, depth: maxDepth - depth });
            walk(next, depth - 1);
        }
    };
    walk(start, maxDepth);
    /*
     * Keep a direct call of the entry, or a call that crosses a file. Drop the rest:
     * a private helper calling two more private helpers in the same file is a
     * detail the reader can see once they are in that file.
     */
    const keep = edges.filter((e) => e.depth === 0 || e.from !== e.to);
    const seenEdge = new Set();
    const unique = keep.filter((e) => {
        const k = `${e.from}>${e.to}.${e.name}`;
        if (seenEdge.has(k)) { return false; }
        seenEdge.add(k);
        return true;
    });
    return unique.slice(0, MAX_MESSAGES);
}

/* ------------------------------------------------------------------ scenarios */

/**
 * One entry per thing that goes wrong. `symptom` is what sends a reader here;
 * `entry` is where the trace starts; `depth` is how far it is worth following.
 */
const SCENARIOS = [
    { id: 'BIND', title: 'A document is bound and nothing appears',
        symptom: 'You wrote `E142MapData` and the map is empty, or shows the previous lot.',
        file: 'SubstrateMap', method: 'setE142MapData', depth: 4 },
    { id: 'TILE', title: 'A tile says "no data" while holding a document',
        symptom: 'The tile is bound and still shows its empty state.',
        file: 'SubstrateMapWidget', method: 'setE142MapData', depth: 4 },
    { id: 'CLICK', title: 'A click selects nothing',
        symptom: 'The map draws, the pointer is over a die, and no event arrives.',
        file: 'SubstrateMapBase', method: '__handlePointerUp', depth: 3 },
    { id: 'FILTER', title: 'A filter changes nothing',
        symptom: 'The bar moves, the map does not.',
        file: 'SubstrateMap', method: 'setSpatialFilter', depth: 3 },
    { id: 'RENDER', title: 'A frame is drawn',
        symptom: 'Wrong size, wrong colors, or nothing at all after a resize.',
        file: 'SubstrateMapBase', method: '__render', depth: 3 },
];

/** @param s A scenario. @returns Its markdown, diagram included. */
function render(s) {
    const start = find(s.file, s.method);
    if (start === null) { return { text: `_(${s.file}.${s.method} no longer exists)_`, missing: true }; }
    const edges = trace(start, s.depth);
    const L = ['```mermaid', 'sequenceDiagram', '    autonumber'];
    const parts = [...new Set([s.file, ...edges.map((e) => e.to)])];
    for (const p of parts) { L.push(`    participant ${p}`); }
    L.push(`    Note over ${s.file}: ${s.file}.ts:${start.line}  ${s.method}()`);
    for (const e of edges) {
        L.push(`    ${e.from}->>${e.to}: ${e.name}()  :${e.line}`);
    }
    L.push('```');
    return {
        text: [`### ${s.title}`, '', `**Symptom.** ${s.symptom}`, '',
            `**Start here:** \`${start.rel}:${start.line}\` — \`${s.method}()\``, '',
            L.join('\n'), ''].join('\n'),
        missing: false,
    };
}

/* --------------------------------------------------------------------- write */

if (!existsSync(DOC)) {
    console.error(`api-sequences: ${DOC} does not exist`);
    process.exit(2);
}
const before = readFileSync(DOC, 'utf8');
const eol = before.includes('\r\n') ? '\r\n' : '\n';
let out = before;
let missing = 0;
for (const s of SCENARIOS) {
    const b = `<!-- SEQ:${s.id}:BEGIN -->`;
    const e = `<!-- SEQ:${s.id}:END -->`;
    const i = out.indexOf(b);
    const j = out.indexOf(e);
    if (i === -1 || j === -1) {
        console.error(`api-sequences: no ${b} … ${e} block in API.md`);
        process.exit(2);
    }
    const r = render(s);
    if (r.missing) { missing++; }
    out = out.slice(0, i + b.length) + eol + r.text.replace(/\n/g, eol) + out.slice(j);
}
if (missing > 0) {
    console.error(`\n  ${missing} scenario(s) name a method that no longer exists.`);
    console.error('  Fix SCENARIOS in tools/api-sequences.mjs.\n');
    process.exit(1);
}

/*
 * EVERY LINE REFERENCE IS VERIFIED, and this is the assertion the document lives
 * or dies by. A sequence diagram that sends a reader to the wrong line is worse
 * than no diagram: they trust it because it looks specific, and they lose the time
 * the diagram was supposed to save.
 *
 * So each `Participant.method() :N` is checked by opening that file at line N and
 * confirming the method is defined there.
 */
function verifyLines(text) {
    const wrong = [];
    const short = new Map();
    for (const v of DEFS.values()) { short.set(v.short, v.rel); }
    let n = 0;
    for (const m of text.matchAll(/(\w+)->>(\w+): (\w+)\(\)  :(\d+)/g)) {
        const rel = short.get(m[2]);
        if (rel === undefined) { wrong.push(`no file for participant ${m[2]}`); continue; }
        const line = readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)[Number(m[4]) - 1] ?? '';
        n++;
        if (!line.includes(`${m[3]}(`)) {
            wrong.push(`${m[2]}.ts:${m[4]} does not define ${m[3]}`);
        }
    }
    return { checked: n, wrong };
}

const lines = verifyLines(out);
if (lines.wrong.length > 0) {
    console.error('\n  A diagram points at the wrong line:');
    for (const w of lines.wrong.slice(0, 6)) { console.error(`    ${w}`); }
    process.exit(1);
}

/* The same opportunistic parse the architecture diagrams get. */
async function parseBlocks(text) {
    let JSDOM;
    try { ({ JSDOM } = await import('jsdom')); } catch { return { available: false, ok: 0 }; }
    const dom = new JSDOM('<!doctype html><body></body>');
    for (const k of ['window', 'document', 'navigator', 'Element', 'SVGElement', 'Node',
        'DocumentFragment', 'HTMLElement', 'NodeFilter', 'getComputedStyle', 'DOMParser']) {
        if (globalThis[k] === undefined && dom.window[k] !== undefined) {
            globalThis[k] = dom.window[k];
        }
    }
    let mermaid;
    try { mermaid = (await import('mermaid')).default; } catch { return { available: false, ok: 0 }; }
    const found = [...text.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)]
        .map((m) => m[1].replace(/\r/g, ''));
    const errors = [];
    let ok = 0;
    for (const [i, b] of found.entries()) {
        try { await mermaid.parse(b); ok++; }
        catch (e) { errors.push(`block ${i + 1}: ${String(e?.message ?? e).split('\n')[0].slice(0, 130)}`); }
    }
    return { available: true, ok, errors };
}
const parsed = await parseBlocks(out);
if (parsed.available && parsed.errors.length > 0) {
    console.error('\n  A diagram does not parse:');
    for (const e of parsed.errors) { console.error(`    ${e}`); }
    process.exit(1);
}

if (!CHECK) {
    writeFileSync(DOC, out, 'utf8');
    console.log(`  API.md: ${SCENARIOS.length} scenario(s), ${lines.checked} line `
        + `reference(s) verified`
        + (parsed.available ? `, ${parsed.ok} diagram(s) parsed` : ''));
    process.exit(0);
}
if (out === before) {
    console.log(`  api sequences         : ${SCENARIOS.length} scenarios, `
        + `${lines.checked} line reference(s) verified, in step`);
    process.exit(0);
}
console.error('\n  API.md is out of step with the sources.');
console.error('  Run: node tools/api-sequences.mjs\n');
process.exit(1);
